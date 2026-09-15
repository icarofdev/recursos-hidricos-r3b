<?php

declare(strict_types=1);

namespace R3B\Auth;

use PDO;

final class UserRepository
{
    public function __construct(private readonly PDO $database)
    {
    }

    /** @return array{id:int,name:string,email:string,password_hash:string,session_version:int}|null */
    public function findByEmail(string $email): ?array
    {
        $statement = $this->database->prepare(
            'SELECT id, name, email, password_hash, session_version FROM users WHERE email = :email LIMIT 1'
        );
        $statement->execute(['email' => $email]);
        $row = $statement->fetch();
        return is_array($row) ? $this->normalize($row) : null;
    }

    /** @return array{id:int,name:string,email:string,password_hash:string,session_version:int}|null */
    public function findById(int $id): ?array
    {
        $statement = $this->database->prepare(
            'SELECT id, name, email, password_hash, session_version FROM users WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $id]);
        $row = $statement->fetch();
        return is_array($row) ? $this->normalize($row) : null;
    }

    public function create(string $name, string $email, string $passwordHash): int
    {
        $now = gmdate('Y-m-d H:i:s.u');
        $statement = $this->database->prepare(
            'INSERT INTO users (name, email, password_hash, session_version, created_at, updated_at)
             VALUES (:name, :email, :password_hash, 1, :created_at, :updated_at)'
        );
        $statement->execute([
            'name' => $name,
            'email' => $email,
            'password_hash' => $passwordHash,
            'created_at' => $now,
            'updated_at' => $now,
        ]);
        return (int) $this->database->lastInsertId();
    }

    public function recordLogin(int $id): void
    {
        $now = gmdate('Y-m-d H:i:s.u');
        $statement = $this->database->prepare(
            'UPDATE users SET last_login_at = :last_login_at, updated_at = :updated_at WHERE id = :id'
        );
        $statement->execute(['last_login_at' => $now, 'updated_at' => $now, 'id' => $id]);
    }

    public function replacePasswordAndRevokeSessions(int $id, string $passwordHash): void
    {
        $statement = $this->database->prepare(
            'UPDATE users
             SET password_hash = :password_hash,
                 session_version = session_version + 1,
                 updated_at = :updated_at
             WHERE id = :id'
        );
        $statement->execute([
            'password_hash' => $passwordHash,
            'updated_at' => gmdate('Y-m-d H:i:s.u'),
            'id' => $id,
        ]);
    }

    /** @param array<string,mixed> $row
     *  @return array{id:int,name:string,email:string,password_hash:string,session_version:int}
     */
    private function normalize(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'name' => (string) $row['name'],
            'email' => (string) $row['email'],
            'password_hash' => (string) $row['password_hash'],
            'session_version' => (int) $row['session_version'],
        ];
    }
}
