<?php

declare(strict_types=1);

namespace R3B\Auth;

use DateInterval;
use DateTimeImmutable;
use DateTimeZone;
use PDO;
use R3B\Http\HttpException;
use R3B\Mail\TransactionalMailer;
use Throwable;

final class PasswordResetService
{
    private DateTimeZone $utc;

    public function __construct(
        private readonly PDO $database,
        private readonly UserRepository $users,
        private readonly TransactionalMailer $mailer,
        private readonly string $appUrl,
        private readonly int $ttlMinutes = 20
    ) {
        $this->utc = new DateTimeZone('UTC');
    }

    /** Gera e envia somente quando o e-mail pertence a uma conta. */
    public function request(string $email, ?DateTimeImmutable $now = null): void
    {
        $email = AuthService::normalizeEmail($email);
        if (strlen($email) > AuthService::MAX_EMAIL_LENGTH || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            return;
        }
        $user = $this->users->findByEmail($email);
        if ($user === null) {
            return;
        }

        $now = ($now ?? new DateTimeImmutable('now', $this->utc))->setTimezone($this->utc);
        $rawToken = self::randomToken();
        $tokenHash = self::hashToken($rawToken);
        $expiresAt = $now->add(new DateInterval('PT' . $this->ttlMinutes . 'M'));

        $this->database->beginTransaction();
        try {
            $invalidate = $this->database->prepare(
                'UPDATE password_reset_tokens SET used_at = :used_at
                 WHERE user_id = :user_id AND used_at IS NULL'
            );
            $invalidate->execute([
                'used_at' => $this->databaseTimestamp($now),
                'user_id' => $user['id'],
            ]);
            $insert = $this->database->prepare(
                'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used_at, created_at)
                 VALUES (:user_id, :token_hash, :expires_at, NULL, :created_at)'
            );
            $insert->execute([
                'user_id' => $user['id'],
                'token_hash' => $tokenHash,
                'expires_at' => $this->databaseTimestamp($expiresAt),
                'created_at' => $this->databaseTimestamp($now),
            ]);
            $this->database->commit();
        } catch (Throwable $exception) {
            if ($this->database->inTransaction()) {
                $this->database->rollBack();
            }
            throw $exception;
        }

        $resetUrl = rtrim($this->appUrl, '/') . '/redefinir-senha?token=' . rawurlencode($rawToken);
        try {
            $this->mailer->sendPasswordReset($user['name'], $user['email'], $resetUrl, $this->ttlMinutes);
        } catch (Throwable $exception) {
            $delete = $this->database->prepare('DELETE FROM password_reset_tokens WHERE token_hash = :token_hash');
            $delete->execute(['token_hash' => $tokenHash]);
            throw $exception;
        }
    }

    public function isValid(string $rawToken, ?DateTimeImmutable $now = null): bool
    {
        if (!self::isTokenShapeValid($rawToken)) {
            return false;
        }
        $row = $this->findToken(self::hashToken($rawToken));
        if ($row === null || $row['used_at'] !== null) {
            return false;
        }
        $now = ($now ?? new DateTimeImmutable('now', $this->utc))->setTimezone($this->utc);
        return new DateTimeImmutable((string) $row['expires_at'], $this->utc) > $now;
    }

    public function reset(string $rawToken, string $password, string $confirmation, ?DateTimeImmutable $now = null): void
    {
        AuthService::validatePassword($password);
        if (!hash_equals($password, $confirmation)) {
            throw new HttpException(422, 'PASSWORD_MISMATCH', 'A confirmação da senha não corresponde.');
        }
        if (!self::isTokenShapeValid($rawToken)) {
            throw new HttpException(422, 'INVALID_RESET_TOKEN', 'Este link é inválido ou expirou.');
        }

        $now = ($now ?? new DateTimeImmutable('now', $this->utc))->setTimezone($this->utc);
        $tokenHash = self::hashToken($rawToken);
        $this->database->beginTransaction();
        try {
            $row = $this->findTokenForUpdate($tokenHash);
            if ($row === null
                || $row['used_at'] !== null
                || new DateTimeImmutable((string) $row['expires_at'], $this->utc) <= $now) {
                throw new HttpException(422, 'INVALID_RESET_TOKEN', 'Este link é inválido, expirou ou já foi utilizado.');
            }

            $this->users->replacePasswordAndRevokeSessions(
                (int) $row['user_id'],
                password_hash($password, PASSWORD_DEFAULT)
            );
            $used = $this->database->prepare(
                'UPDATE password_reset_tokens SET used_at = :used_at WHERE id = :id AND used_at IS NULL'
            );
            $used->execute(['used_at' => $this->databaseTimestamp($now), 'id' => $row['id']]);
            if ($used->rowCount() !== 1) {
                throw new HttpException(422, 'INVALID_RESET_TOKEN', 'Este link já foi utilizado.');
            }
            $this->database->commit();
        } catch (Throwable $exception) {
            if ($this->database->inTransaction()) {
                $this->database->rollBack();
            }
            throw $exception;
        }
    }

    public static function randomToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    public static function hashToken(string $token): string
    {
        return hash('sha256', $token);
    }

    private static function isTokenShapeValid(string $token): bool
    {
        return strlen($token) === 43 && preg_match('/^[A-Za-z0-9_-]{43}$/', $token) === 1;
    }

    /** @return array<string,mixed>|null */
    private function findToken(string $tokenHash): ?array
    {
        $statement = $this->database->prepare(
            'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = :token_hash LIMIT 1'
        );
        $statement->execute(['token_hash' => $tokenHash]);
        $row = $statement->fetch();
        return is_array($row) ? $row : null;
    }

    /** @return array<string,mixed>|null */
    private function findTokenForUpdate(string $tokenHash): ?array
    {
        $driver = (string) $this->database->getAttribute(PDO::ATTR_DRIVER_NAME);
        $sql = 'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = :token_hash LIMIT 1';
        if ($driver === 'mysql') {
            $sql .= ' FOR UPDATE';
        }
        $statement = $this->database->prepare($sql);
        $statement->execute(['token_hash' => $tokenHash]);
        $row = $statement->fetch();
        return is_array($row) ? $row : null;
    }

    private function databaseTimestamp(DateTimeImmutable $timestamp): string
    {
        return $timestamp->setTimezone($this->utc)->format('Y-m-d H:i:s.u');
    }
}
