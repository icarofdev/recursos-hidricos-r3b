<?php

declare(strict_types=1);

namespace R3B\Auth;

use PDOException;
use R3B\Http\HttpException;

final class AuthService
{
    public const MAX_NAME_LENGTH = 120;
    public const MAX_EMAIL_LENGTH = 254;
    public const MIN_PASSWORD_LENGTH = 10;
    public const MAX_PASSWORD_LENGTH = 128;

    public function __construct(private readonly UserRepository $users)
    {
    }

    /** @return array{id:int,name:string,email:string,session_version:int} */
    public function register(string $name, string $email, string $password, string $confirmation): array
    {
        $name = self::normalizeName($name);
        $email = self::normalizeEmail($email);
        self::validateName($name);
        self::validateEmail($email);
        self::validatePassword($password);
        if (!hash_equals($password, $confirmation)) {
            throw new HttpException(422, 'PASSWORD_MISMATCH', 'A confirmação da senha não corresponde.');
        }
        if ($this->users->findByEmail($email) !== null) {
            throw new HttpException(409, 'EMAIL_IN_USE', 'Já existe uma conta com este e-mail.');
        }

        try {
            $id = $this->users->create($name, $email, password_hash($password, PASSWORD_DEFAULT));
        } catch (PDOException $exception) {
            if ((string) $exception->getCode() === '23000' || str_contains(strtolower($exception->getMessage()), 'unique')) {
                throw new HttpException(409, 'EMAIL_IN_USE', 'Já existe uma conta com este e-mail.');
            }
            throw $exception;
        }

        return ['id' => $id, 'name' => $name, 'email' => $email, 'session_version' => 1];
    }

    /** @return array{id:int,name:string,email:string,session_version:int} */
    public function login(string $email, string $password): array
    {
        $email = self::normalizeEmail($email);
        if (strlen($email) > self::MAX_EMAIL_LENGTH || strlen($password) > self::MAX_PASSWORD_LENGTH) {
            throw new HttpException(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
        }

        $user = $this->users->findByEmail($email);
        if ($user === null || !password_verify($password, $user['password_hash'])) {
            // Reduz diferenças de tempo para e-mails inexistentes.
            if ($user === null) {
                password_verify($password, '$2y$10$5OaRTkUUUsRaKZ4Qj2f4v.6slxIspDEzPmP/7wX0bXzEazgqOirpu');
            }
            throw new HttpException(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
        }

        if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
            $this->users->replacePasswordAndRevokeSessions($user['id'], password_hash($password, PASSWORD_DEFAULT));
            $user = $this->users->findById($user['id']) ?? $user;
        }
        $this->users->recordLogin($user['id']);
        return $this->publicUser($user);
    }

    public static function normalizeEmail(string $email): string
    {
        return strtolower(trim($email));
    }

    public static function normalizeName(string $name): string
    {
        return trim((string) preg_replace('/\s+/u', ' ', $name));
    }

    public static function validatePassword(string $password): void
    {
        $length = strlen($password);
        if ($length < self::MIN_PASSWORD_LENGTH || $length > self::MAX_PASSWORD_LENGTH) {
            throw new HttpException(
                422,
                'WEAK_PASSWORD',
                'Use uma senha de 10 a 128 caracteres, com letras e números.'
            );
        }
        if (!preg_match('/[A-Za-z]/', $password) || !preg_match('/[0-9]/', $password)) {
            throw new HttpException(422, 'WEAK_PASSWORD', 'Use uma senha com letras e números.');
        }
    }

    private static function validateName(string $name): void
    {
        $length = function_exists('mb_strlen') ? mb_strlen($name) : strlen($name);
        if ($length < 2 || $length > self::MAX_NAME_LENGTH) {
            throw new HttpException(422, 'INVALID_NAME', 'Informe um nome entre 2 e 120 caracteres.');
        }
    }

    private static function validateEmail(string $email): void
    {
        if (strlen($email) > self::MAX_EMAIL_LENGTH || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            throw new HttpException(422, 'INVALID_EMAIL', 'Informe um e-mail válido.');
        }
    }

    /** @param array{id:int,name:string,email:string,session_version:int,password_hash?:string} $user
     *  @return array{id:int,name:string,email:string,session_version:int}
     */
    private function publicUser(array $user): array
    {
        return [
            'id' => $user['id'],
            'name' => $user['name'],
            'email' => $user['email'],
            'session_version' => $user['session_version'],
        ];
    }
}
