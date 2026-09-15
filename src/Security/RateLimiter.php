<?php

declare(strict_types=1);

namespace R3B\Security;

use PDO;

final class RateLimiter
{
    public function __construct(private readonly PDO $database, private readonly string $secret)
    {
    }

    /** Retorna os segundos restantes quando bloqueado, ou zero quando permitido. */
    public function consume(string $scope, string $identifier, int $limit, int $windowSeconds, ?int $now = null): int
    {
        $now ??= time();
        $keyHash = hash_hmac('sha256', $scope . "\0" . strtolower(trim($identifier)), $this->secret);
        $driver = (string) $this->database->getAttribute(PDO::ATTR_DRIVER_NAME);
        $sql = $driver === 'sqlite'
            ? 'INSERT INTO rate_limits (key_hash, attempts, window_started_at, updated_at)
               VALUES (:key_hash, 1, :now, :updated_at)
               ON CONFLICT(key_hash) DO UPDATE SET
                   attempts = CASE WHEN :now_check - window_started_at >= :window_seconds THEN 1 ELSE attempts + 1 END,
                   window_started_at = CASE WHEN :now_window - window_started_at >= :window_check THEN :new_window ELSE window_started_at END,
                   updated_at = :new_updated_at'
            : 'INSERT INTO rate_limits (key_hash, attempts, window_started_at, updated_at)
               VALUES (:key_hash, 1, :now, :updated_at)
               ON DUPLICATE KEY UPDATE
                   attempts = IF(:now_check - window_started_at >= :window_seconds, 1, attempts + 1),
                   window_started_at = IF(:now_window - window_started_at >= :window_check, :new_window, window_started_at),
                   updated_at = :new_updated_at';
        $statement = $this->database->prepare($sql);
        $statement->execute([
            'key_hash' => $keyHash,
            'now' => $now,
            'updated_at' => $now,
            'now_check' => $now,
            'window_seconds' => $windowSeconds,
            'now_window' => $now,
            'window_check' => $windowSeconds,
            'new_window' => $now,
            'new_updated_at' => $now,
        ]);

        $read = $this->database->prepare(
            'SELECT attempts, window_started_at FROM rate_limits WHERE key_hash = :key_hash'
        );
        $read->execute(['key_hash' => $keyHash]);
        $row = $read->fetch();
        if (!is_array($row) || (int) $row['attempts'] <= $limit) {
            return 0;
        }
        return max(1, $windowSeconds - ($now - (int) $row['window_started_at']));
    }

    public function clear(string $scope, string $identifier): void
    {
        $keyHash = hash_hmac('sha256', $scope . "\0" . strtolower(trim($identifier)), $this->secret);
        $statement = $this->database->prepare('DELETE FROM rate_limits WHERE key_hash = :key_hash');
        $statement->execute(['key_hash' => $keyHash]);
    }

}
