<?php

declare(strict_types=1);

namespace R3B;

use DateTimeImmutable;
use DateTimeZone;
use PDO;
use R3B\Http\HttpException;
use Throwable;

final class ReservoirRepository
{
    private DateTimeZone $utc;

    public function __construct(
        private readonly PDO $database,
        private readonly int $offlineAfterSeconds,
        private readonly DateTimeZone $displayTimezone
    ) {
        $this->utc = new DateTimeZone('UTC');
    }

    /** @return list<array<string,mixed>> */
    public function listForUser(int $userId, ?DateTimeImmutable $now = null): array
    {
        $statement = $this->database->prepare(
            'SELECT r.id, r.name, r.capacity_liters, r.device_id, r.linked_at,
                    d.device_code, d.reported_status, d.last_seen
             FROM reservoirs r
             INNER JOIN devices d ON d.id = r.device_id
             WHERE r.user_id = :user_id AND r.unlinked_at IS NULL AND d.owner_user_id = :owner_user_id
             ORDER BY r.created_at ASC, r.id ASC'
        );
        $statement->execute(['user_id' => $userId, 'owner_user_id' => $userId]);

        $items = [];
        while ($row = $statement->fetch()) {
            $items[] = $this->normalizeReservoir($row, $now);
        }
        return $items;
    }

    /** @return array<string,mixed>|null */
    public function findOwned(int $reservoirId, int $userId, ?DateTimeImmutable $now = null): ?array
    {
        $statement = $this->database->prepare(
            'SELECT r.id, r.name, r.capacity_liters, r.device_id, r.linked_at,
                    d.device_code, d.reported_status, d.last_seen
             FROM reservoirs r
             INNER JOIN devices d ON d.id = r.device_id
             WHERE r.id = :id AND r.user_id = :user_id AND r.unlinked_at IS NULL
               AND d.owner_user_id = :owner_user_id
             LIMIT 1'
        );
        $statement->execute(['id' => $reservoirId, 'user_id' => $userId, 'owner_user_id' => $userId]);
        $row = $statement->fetch();
        return is_array($row) ? $this->normalizeReservoir($row, $now) : null;
    }

    /** @return array{device_code:string,status:string,last_seen:string|null} */
    public function validatePairingCode(string $pairingCode, ?DateTimeImmutable $now = null): array
    {
        $hash = self::pairingCodeHash($pairingCode);
        $statement = $this->database->prepare(
            'SELECT id, device_code, owner_user_id, reported_status, last_seen, pairing_expires_at
             FROM devices WHERE pairing_code_hash = :pairing_code_hash LIMIT 1'
        );
        $statement->execute(['pairing_code_hash' => $hash]);
        $row = $statement->fetch();
        if (!is_array($row)) {
            throw new HttpException(422, 'INVALID_PAIRING_CODE', 'Código de pareamento inválido ou expirado.');
        }
        if ($row['owner_user_id'] !== null) {
            throw new HttpException(409, 'DEVICE_ALREADY_LINKED', 'Este dispositivo já está vinculado a uma conta.');
        }
        $now = ($now ?? new DateTimeImmutable('now', $this->utc))->setTimezone($this->utc);
        if ($row['pairing_expires_at'] === null
            || new DateTimeImmutable((string) $row['pairing_expires_at'], $this->utc) <= $now) {
            throw new HttpException(422, 'INVALID_PAIRING_CODE', 'Código de pareamento inválido ou expirado.');
        }

        return [
            'device_code' => (string) ($row['device_code'] ?: self::deviceCode((int) $row['id'])),
            'status' => $this->calculatedStatus((string) $row['reported_status'], (string) $row['last_seen'], $now),
            'last_seen' => $row['last_seen'] === null ? null : $this->apiTimestamp((string) $row['last_seen']),
        ];
    }

    /** @return array<string,mixed> */
    public function connect(int $userId, string $pairingCode, string $reservoirName, ?DateTimeImmutable $now = null): array
    {
        $reservoirName = self::normalizeName($reservoirName);
        self::validateName($reservoirName);
        $hash = self::pairingCodeHash($pairingCode);
        $now = ($now ?? new DateTimeImmutable('now', $this->utc))->setTimezone($this->utc);
        $timestamp = $this->databaseTimestamp($now);

        $this->database->beginTransaction();
        try {
            $claim = $this->database->prepare(
                'UPDATE devices
                 SET owner_user_id = :user_id, paired_at = :paired_at, updated_at = :updated_at
                 WHERE pairing_code_hash = :pairing_code_hash
                   AND owner_user_id IS NULL
                   AND pairing_expires_at IS NOT NULL
                   AND pairing_expires_at > :expires_after'
            );
            $claim->execute([
                'user_id' => $userId,
                'paired_at' => $timestamp,
                'updated_at' => $timestamp,
                'pairing_code_hash' => $hash,
                'expires_after' => $timestamp,
            ]);
            if ($claim->rowCount() !== 1) {
                $this->database->rollBack();
                // Produz mensagem útil quando o código ainda identifica um dispositivo ocupado.
                $this->validatePairingCode($pairingCode, $now);
                throw new HttpException(409, 'PAIRING_CONFLICT', 'O dispositivo foi vinculado por outra solicitação.');
            }

            $device = $this->database->prepare(
                'SELECT id FROM devices WHERE pairing_code_hash = :pairing_code_hash AND owner_user_id = :user_id LIMIT 1'
            );
            $device->execute(['pairing_code_hash' => $hash, 'user_id' => $userId]);
            $deviceId = $device->fetchColumn();
            if ($deviceId === false) {
                throw new HttpException(409, 'PAIRING_CONFLICT', 'Não foi possível concluir o pareamento.');
            }

            $insert = $this->database->prepare(
                'INSERT INTO reservoirs
                    (user_id, device_id, name, capacity_liters, linked_at, unlinked_at, created_at, updated_at)
                 VALUES (:user_id, :device_id, :name, NULL, :linked_at, NULL, :created_at, :updated_at)'
            );
            $insert->execute([
                'user_id' => $userId,
                'device_id' => (int) $deviceId,
                'name' => $reservoirName,
                'linked_at' => $timestamp,
                'created_at' => $timestamp,
                'updated_at' => $timestamp,
            ]);
            $reservoirId = (int) $this->database->lastInsertId();

            // Somente leituras ainda sem associação são atribuídas. Histórico de
            // proprietários anteriores nunca muda de dono.
            $backfill = $this->database->prepare(
                'UPDATE smwu_readings SET reservoir_id = :reservoir_id
                 WHERE id = :device_id AND reservoir_id IS NULL'
            );
            $backfill->execute(['reservoir_id' => $reservoirId, 'device_id' => (int) $deviceId]);

            $this->database->commit();
            return $this->findOwned($reservoirId, $userId, $now)
                ?? throw new HttpException(500, 'PAIRING_FAILED', 'Não foi possível carregar o reservatório conectado.');
        } catch (Throwable $exception) {
            if ($this->database->inTransaction()) {
                $this->database->rollBack();
            }
            throw $exception;
        }
    }

    /** @return array<string,mixed> */
    public function rename(int $reservoirId, int $userId, string $name): array
    {
        $name = self::normalizeName($name);
        self::validateName($name);
        $statement = $this->database->prepare(
            'UPDATE reservoirs SET name = :name, updated_at = :updated_at
             WHERE id = :id AND user_id = :user_id AND unlinked_at IS NULL'
        );
        $statement->execute([
            'name' => $name,
            'updated_at' => $this->databaseTimestamp(new DateTimeImmutable('now', $this->utc)),
            'id' => $reservoirId,
            'user_id' => $userId,
        ]);
        $reservoir = $this->findOwned($reservoirId, $userId);
        if ($reservoir === null) {
            throw new HttpException(404, 'RESERVOIR_NOT_FOUND', 'Reservatório não encontrado.');
        }
        return $reservoir;
    }

    public function unlink(int $reservoirId, int $userId, ?DateTimeImmutable $now = null): void
    {
        $now = ($now ?? new DateTimeImmutable('now', $this->utc))->setTimezone($this->utc);
        $timestamp = $this->databaseTimestamp($now);
        $this->database->beginTransaction();
        try {
            $statement = $this->database->prepare(
                'SELECT device_id FROM reservoirs
                 WHERE id = :id AND user_id = :user_id AND unlinked_at IS NULL LIMIT 1'
                . ((string) $this->database->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? ' FOR UPDATE' : '')
            );
            $statement->execute(['id' => $reservoirId, 'user_id' => $userId]);
            $deviceId = $statement->fetchColumn();
            if ($deviceId === false) {
                throw new HttpException(404, 'RESERVOIR_NOT_FOUND', 'Reservatório não encontrado.');
            }

            $unlink = $this->database->prepare(
                'UPDATE reservoirs SET unlinked_at = :unlinked_at, updated_at = :updated_at
                 WHERE id = :id AND user_id = :user_id AND unlinked_at IS NULL'
            );
            $unlink->execute([
                'unlinked_at' => $timestamp,
                'updated_at' => $timestamp,
                'id' => $reservoirId,
                'user_id' => $userId,
            ]);
            $release = $this->database->prepare(
                'UPDATE devices
                 SET owner_user_id = NULL, pairing_code_hash = NULL, pairing_expires_at = NULL,
                     paired_at = NULL, updated_at = :updated_at
                 WHERE id = :device_id AND owner_user_id = :user_id'
            );
            $release->execute(['updated_at' => $timestamp, 'device_id' => (int) $deviceId, 'user_id' => $userId]);
            $this->database->commit();
        } catch (Throwable $exception) {
            if ($this->database->inTransaction()) {
                $this->database->rollBack();
            }
            throw $exception;
        }
    }

    /** Define um novo segredo de pareamento e retorna o código puro uma única vez. */
    public function provisionPairingCode(int $deviceId, int $ttlMinutes = 1440): string
    {
        $rawCode = self::randomPairingCode();
        $now = new DateTimeImmutable('now', $this->utc);
        $expiresAt = $now->modify('+' . $ttlMinutes . ' minutes');
        $statement = $this->database->prepare(
            'UPDATE devices
             SET device_code = :device_code, pairing_code_hash = :pairing_code_hash,
                 pairing_expires_at = :pairing_expires_at, updated_at = :updated_at
             WHERE id = :id AND owner_user_id IS NULL'
        );
        $statement->execute([
            'device_code' => self::deviceCode($deviceId),
            'pairing_code_hash' => self::pairingCodeHash($rawCode),
            'pairing_expires_at' => $this->databaseTimestamp($expiresAt),
            'updated_at' => $this->databaseTimestamp($now),
            'id' => $deviceId,
        ]);
        if ($statement->rowCount() !== 1) {
            throw new HttpException(409, 'DEVICE_NOT_AVAILABLE', 'Dispositivo inexistente ou já vinculado.');
        }
        return $rawCode;
    }

    public static function randomPairingCode(): string
    {
        $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        $bytes = random_bytes(16);
        $parts = [];
        for ($group = 0; $group < 4; $group++) {
            $part = '';
            for ($index = 0; $index < 4; $index++) {
                $part .= $alphabet[ord($bytes[$group * 4 + $index]) % strlen($alphabet)];
            }
            $parts[] = $part;
        }
        return 'HIDRA-' . implode('-', $parts);
    }

    public static function pairingCodeHash(string $code): string
    {
        return hash('sha256', strtoupper(trim($code)));
    }

    public static function deviceCode(int $id): string
    {
        return 'HIDRA-R3B-' . str_pad((string) $id, 6, '0', STR_PAD_LEFT);
    }

    private static function normalizeName(string $name): string
    {
        return trim((string) preg_replace('/\s+/u', ' ', $name));
    }

    private static function validateName(string $name): void
    {
        $length = function_exists('mb_strlen') ? mb_strlen($name) : strlen($name);
        if ($length < 1 || $length > 60) {
            throw new HttpException(422, 'INVALID_RESERVOIR_NAME', 'Use um nome de 1 a 60 caracteres.');
        }
    }

    /** @param array<string,mixed> $row
     *  @return array<string,mixed>
     */
    private function normalizeReservoir(array $row, ?DateTimeImmutable $now): array
    {
        $now = ($now ?? new DateTimeImmutable('now', $this->utc))->setTimezone($this->utc);
        return [
            'id' => (int) $row['id'],
            'name' => (string) $row['name'],
            'capacity_liters' => $row['capacity_liters'] === null ? null : (float) $row['capacity_liters'],
            'linked_at' => $this->apiTimestamp((string) $row['linked_at']),
            'device' => [
                'id' => (int) $row['device_id'],
                'code' => (string) ($row['device_code'] ?: self::deviceCode((int) $row['device_id'])),
                'status' => $this->calculatedStatus((string) $row['reported_status'], (string) $row['last_seen'], $now),
                'last_seen' => $this->apiTimestamp((string) $row['last_seen']),
                'offline_after_seconds' => $this->offlineAfterSeconds,
            ],
        ];
    }

    private function calculatedStatus(string $reportedStatus, string $lastSeen, DateTimeImmutable $now): string
    {
        $seen = new DateTimeImmutable($lastSeen, $this->utc);
        $age = max(0, $now->getTimestamp() - $seen->getTimestamp());
        return $reportedStatus === 'offline' || $age >= $this->offlineAfterSeconds ? 'offline' : 'online';
    }

    private function databaseTimestamp(DateTimeImmutable $timestamp): string
    {
        return $timestamp->setTimezone($this->utc)->format('Y-m-d H:i:s.u');
    }

    private function apiTimestamp(string $timestamp): string
    {
        return (new DateTimeImmutable($timestamp, $this->utc))
            ->setTimezone($this->displayTimezone)
            ->format('Y-m-d\TH:i:sP');
    }
}
