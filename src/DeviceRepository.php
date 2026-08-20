<?php

declare(strict_types=1);

namespace R3B;

use DateTimeImmutable;
use DateTimeZone;
use PDO;
use PDOException;
use Throwable;

final class DeviceRepository
{
    private DateTimeZone $utc;

    public function __construct(
        private readonly PDO $database,
        private readonly int $offlineAfterSeconds,
        private readonly DateTimeZone $displayTimezone
    ) {
        $this->utc = new DateTimeZone('UTC');
    }

    /** @param array{device_id:string,nivel_cm:float,capacidade_cm:float,percentual:float,volume_litros:float} $reading */
    public function storeReading(array $reading, DateTimeImmutable $receivedAt): void
    {
        $receivedAt = $receivedAt->setTimezone($this->utc);
        $timestamp = $this->databaseTimestamp($receivedAt);

        $this->database->beginTransaction();
        try {
            $this->touchDevice($reading['device_id'], 'online', $timestamp);

            $statement = $this->database->prepare(
                'INSERT INTO sensor_readings
                    (device_id, nivel_cm, capacidade_cm, percentual, volume_litros, created_at)
                 VALUES
                    (:device_id, :nivel_cm, :capacidade_cm, :percentual, :volume_litros, :created_at)'
            );
            $statement->execute([
                'device_id' => $reading['device_id'],
                'nivel_cm' => $reading['nivel_cm'],
                'capacidade_cm' => $reading['capacidade_cm'],
                'percentual' => $reading['percentual'],
                'volume_litros' => $reading['volume_litros'],
                'created_at' => $timestamp,
            ]);

            $this->database->commit();
        } catch (Throwable $exception) {
            if ($this->database->inTransaction()) {
                $this->database->rollBack();
            }
            throw $exception;
        }
    }

    public function storeStatus(string $deviceId, string $status, DateTimeImmutable $receivedAt): void
    {
        $timestamp = $this->databaseTimestamp($receivedAt->setTimezone($this->utc));

        $this->database->beginTransaction();
        try {
            $this->touchDevice($deviceId, $status, $timestamp);
            $this->database->commit();
        } catch (Throwable $exception) {
            if ($this->database->inTransaction()) {
                $this->database->rollBack();
            }
            throw $exception;
        }
    }

    public function storeRetainedStatus(string $deviceId, string $status, DateTimeImmutable $receivedAt): bool
    {
        $timestamp = $this->databaseTimestamp($receivedAt->setTimezone($this->utc));
        $statement = $this->database->prepare(
            'UPDATE devices
             SET reported_status = :status, updated_at = :updated_at
             WHERE device_id = :device_id'
        );
        $statement->execute([
            'status' => $status,
            'updated_at' => $timestamp,
            'device_id' => $deviceId,
        ]);

        return $statement->rowCount() > 0;
    }

    /** @return array{device:array{id:string,status:string,last_seen:string,offline_after_seconds:int},data:array{nivel_cm:float,capacidade_cm:float,percentual:float,volume_litros:float,timestamp:string}}|null */
    public function current(?string $deviceId = null, ?DateTimeImmutable $now = null): ?array
    {
        $deviceId ??= $this->latestDeviceId();
        if ($deviceId === null) {
            return null;
        }

        $statement = $this->database->prepare(
            "SELECT d.device_id, d.reported_status, d.last_seen,
                    r.nivel_cm, r.capacidade_cm, r.percentual, r.volume_litros,
                    r.created_at AS reading_timestamp
             FROM sensor_readings r
             INNER JOIN devices d ON d.device_id = r.device_id
             WHERE r.device_id = :device_id
             ORDER BY r.created_at DESC, r.id DESC
             LIMIT 1"
        );
        $statement->execute(['device_id' => $deviceId]);
        $row = $statement->fetch();

        if (!is_array($row)) {
            return null;
        }

        return [
            'device' => $this->deviceFromRow($row, $now),
            'data' => [
                'nivel_cm' => (float) $row['nivel_cm'],
                'capacidade_cm' => (float) $row['capacidade_cm'],
                'percentual' => (float) $row['percentual'],
                'volume_litros' => (float) $row['volume_litros'],
                'timestamp' => $this->apiTimestamp((string) $row['reading_timestamp']),
            ],
        ];
    }

    /** @return array{id:string,status:string,last_seen:string,offline_after_seconds:int}|null */
    public function status(?string $deviceId = null, ?DateTimeImmutable $now = null): ?array
    {
        if ($deviceId === null) {
            $statement = $this->database->query(
                'SELECT device_id, reported_status, last_seen
                 FROM devices
                 ORDER BY last_seen DESC, id DESC
                 LIMIT 1'
            );
        } else {
            $statement = $this->database->prepare(
                'SELECT device_id, reported_status, last_seen
                 FROM devices
                 WHERE device_id = :device_id
                 LIMIT 1'
            );
            $statement->execute(['device_id' => $deviceId]);
        }

        $row = $statement->fetch();
        return is_array($row) ? $this->deviceFromRow($row, $now) : null;
    }

    /** @return array{device_id:?string,data:list<array{device_id:string,nivel_cm:float,capacidade_cm:float,percentual:float,volume_litros:float,timestamp:string}>} */
    public function history(
        ?string $deviceId,
        DateTimeImmutable $since,
        int $limit
    ): array {
        $deviceId ??= $this->latestDeviceId();

        if ($deviceId === null) {
            return ['device_id' => null, 'data' => []];
        }

        $statement = $this->database->prepare(
            'SELECT device_id, nivel_cm, capacidade_cm, percentual, volume_litros, created_at
             FROM sensor_readings
             WHERE device_id = :device_id AND created_at >= :since
             ORDER BY created_at DESC, id DESC
             LIMIT :limit'
        );
        $statement->bindValue(':device_id', $deviceId, PDO::PARAM_STR);
        $statement->bindValue(':since', $this->databaseTimestamp($since->setTimezone($this->utc)), PDO::PARAM_STR);
        $statement->bindValue(':limit', $limit, PDO::PARAM_INT);
        $statement->execute();

        $data = [];
        while ($row = $statement->fetch()) {
            $data[] = [
                'device_id' => (string) $row['device_id'],
                'nivel_cm' => (float) $row['nivel_cm'],
                'capacidade_cm' => (float) $row['capacidade_cm'],
                'percentual' => (float) $row['percentual'],
                'volume_litros' => (float) $row['volume_litros'],
                'timestamp' => $this->apiTimestamp((string) $row['created_at']),
            ];
        }

        return ['device_id' => $deviceId, 'data' => $data];
    }

    private function latestDeviceId(): ?string
    {
        $row = $this->database->query(
            'SELECT device_id FROM devices ORDER BY last_seen DESC, id DESC LIMIT 1'
        )->fetch();

        return is_array($row) ? (string) $row['device_id'] : null;
    }

    private function touchDevice(string $deviceId, string $status, string $timestamp): void
    {
        $update = $this->database->prepare(
            'UPDATE devices
             SET reported_status = :status, last_seen = :last_seen, updated_at = :updated_at
             WHERE device_id = :device_id'
        );
        $parameters = [
            'status' => $status,
            'last_seen' => $timestamp,
            'updated_at' => $timestamp,
            'device_id' => $deviceId,
        ];
        $update->execute($parameters);

        if ($update->rowCount() > 0) {
            return;
        }

        try {
            $insert = $this->database->prepare(
                'INSERT INTO devices
                    (device_id, reported_status, last_seen, created_at, updated_at)
                 VALUES
                    (:device_id, :status, :last_seen, :created_at, :updated_at)'
            );
            $insert->execute([
                'device_id' => $deviceId,
                'status' => $status,
                'last_seen' => $timestamp,
                'created_at' => $timestamp,
                'updated_at' => $timestamp,
            ]);
        } catch (PDOException $exception) {
            if ((string) $exception->getCode() !== '23000') {
                throw $exception;
            }
            $update->execute($parameters);
        }
    }

    /** @param array<string, mixed> $row
     *  @return array{id:string,status:string,last_seen:string,offline_after_seconds:int}
     */
    private function deviceFromRow(array $row, ?DateTimeImmutable $now): array
    {
        $lastSeen = $this->parseDatabaseTimestamp((string) $row['last_seen']);
        $now = ($now ?? new DateTimeImmutable('now', $this->utc))->setTimezone($this->utc);
        $ageSeconds = max(0, $now->getTimestamp() - $lastSeen->getTimestamp());
        $reportedStatus = (string) $row['reported_status'];
        $status = $reportedStatus === 'offline' || $ageSeconds >= $this->offlineAfterSeconds
            ? 'offline'
            : 'online';

        return [
            'id' => (string) $row['device_id'],
            'status' => $status,
            'last_seen' => $lastSeen->setTimezone($this->displayTimezone)->format('Y-m-d\\TH:i:sP'),
            'offline_after_seconds' => $this->offlineAfterSeconds,
        ];
    }

    private function databaseTimestamp(DateTimeImmutable $timestamp): string
    {
        return $timestamp->setTimezone($this->utc)->format('Y-m-d H:i:s.u');
    }

    private function parseDatabaseTimestamp(string $timestamp): DateTimeImmutable
    {
        return new DateTimeImmutable($timestamp, $this->utc);
    }

    private function apiTimestamp(string $timestamp): string
    {
        return $this->parseDatabaseTimestamp($timestamp)
            ->setTimezone($this->displayTimezone)
            ->format('Y-m-d\\TH:i:sP');
    }
}
