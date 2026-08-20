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

    /** @param array{id:int,ppl:float,vazao:float,consumo:float,rssi_wifi:float} $reading */
    public function storeReading(array $reading, DateTimeImmutable $receivedAt): void
    {
        $timestamp = $this->databaseTimestamp($receivedAt->setTimezone($this->utc));

        $this->database->beginTransaction();
        try {
            $this->touchDevice($reading['id'], 'online', $timestamp);

            $statement = $this->database->prepare(
                'INSERT INTO sensor_readings
                    (id, ppl, vazao, consumo, rssi_wifi, created_at)
                 VALUES
                    (:id, :ppl, :vazao, :consumo, :rssi_wifi, :created_at)'
            );
            $statement->execute([
                'id' => $reading['id'],
                'ppl' => $reading['ppl'],
                'vazao' => $reading['vazao'],
                'consumo' => $reading['consumo'],
                'rssi_wifi' => $reading['rssi_wifi'],
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

    public function storeStatus(int $id, string $status, DateTimeImmutable $receivedAt): void
    {
        $timestamp = $this->databaseTimestamp($receivedAt->setTimezone($this->utc));

        $this->database->beginTransaction();
        try {
            $this->touchDevice($id, $status, $timestamp);
            $this->database->commit();
        } catch (Throwable $exception) {
            if ($this->database->inTransaction()) {
                $this->database->rollBack();
            }
            throw $exception;
        }
    }

    public function storeRetainedStatus(int $id, string $status, DateTimeImmutable $receivedAt): bool
    {
        $timestamp = $this->databaseTimestamp($receivedAt->setTimezone($this->utc));
        $statement = $this->database->prepare(
            'UPDATE devices
             SET reported_status = :status, updated_at = :updated_at
             WHERE id = :id'
        );
        $statement->execute([
            'status' => $status,
            'updated_at' => $timestamp,
            'id' => $id,
        ]);

        return $statement->rowCount() > 0;
    }

    /** @return array{device:array{id:int,status:string,last_seen:string,offline_after_seconds:int},data:array{id:int,ppl:float,vazao:float,consumo:float,rssi_wifi:float,timestamp:string}}|null */
    public function current(?int $id = null, ?DateTimeImmutable $now = null): ?array
    {
        $id ??= $this->latestDeviceId();
        if ($id === null) {
            return null;
        }

        $statement = $this->database->prepare(
            'SELECT d.id, d.reported_status, d.last_seen,
                    r.ppl, r.vazao, r.consumo, r.rssi_wifi,
                    r.created_at AS reading_timestamp
             FROM sensor_readings r
             INNER JOIN devices d ON d.id = r.id
             WHERE r.id = :id
             ORDER BY r.created_at DESC, r.reading_id DESC
             LIMIT 1'
        );
        $statement->bindValue(':id', $id, PDO::PARAM_INT);
        $statement->execute();
        $row = $statement->fetch();

        if (!is_array($row)) {
            return null;
        }

        return [
            'device' => $this->deviceFromRow($row, $now),
            'data' => [
                'id' => (int) $row['id'],
                'ppl' => (float) $row['ppl'],
                'vazao' => (float) $row['vazao'],
                'consumo' => (float) $row['consumo'],
                'rssi_wifi' => (float) $row['rssi_wifi'],
                'timestamp' => $this->apiTimestamp((string) $row['reading_timestamp']),
            ],
        ];
    }

    /** @return array{id:int,status:string,last_seen:string,offline_after_seconds:int}|null */
    public function status(?int $id = null, ?DateTimeImmutable $now = null): ?array
    {
        if ($id === null) {
            $statement = $this->database->query(
                'SELECT id, reported_status, last_seen
                 FROM devices
                 ORDER BY last_seen DESC, id DESC
                 LIMIT 1'
            );
        } else {
            $statement = $this->database->prepare(
                'SELECT id, reported_status, last_seen
                 FROM devices
                 WHERE id = :id
                 LIMIT 1'
            );
            $statement->bindValue(':id', $id, PDO::PARAM_INT);
            $statement->execute();
        }

        $row = $statement->fetch();
        return is_array($row) ? $this->deviceFromRow($row, $now) : null;
    }

    /** @return array{id:?int,data:list<array{id:int,ppl:float,vazao:float,consumo:float,rssi_wifi:float,timestamp:string}>} */
    public function history(?int $id, DateTimeImmutable $since, int $limit): array
    {
        $id ??= $this->latestDeviceId();

        if ($id === null) {
            return ['id' => null, 'data' => []];
        }

        $statement = $this->database->prepare(
            'SELECT id, ppl, vazao, consumo, rssi_wifi, created_at
             FROM sensor_readings
             WHERE id = :id AND created_at >= :since
             ORDER BY created_at DESC, reading_id DESC
             LIMIT :limit'
        );
        $statement->bindValue(':id', $id, PDO::PARAM_INT);
        $statement->bindValue(':since', $this->databaseTimestamp($since->setTimezone($this->utc)), PDO::PARAM_STR);
        $statement->bindValue(':limit', $limit, PDO::PARAM_INT);
        $statement->execute();

        $data = [];
        while ($row = $statement->fetch()) {
            $data[] = [
                'id' => (int) $row['id'],
                'ppl' => (float) $row['ppl'],
                'vazao' => (float) $row['vazao'],
                'consumo' => (float) $row['consumo'],
                'rssi_wifi' => (float) $row['rssi_wifi'],
                'timestamp' => $this->apiTimestamp((string) $row['created_at']),
            ];
        }

        return ['id' => $id, 'data' => $data];
    }

    private function latestDeviceId(): ?int
    {
        $row = $this->database->query(
            'SELECT id FROM devices ORDER BY last_seen DESC, id DESC LIMIT 1'
        )->fetch();

        return is_array($row) ? (int) $row['id'] : null;
    }

    private function touchDevice(int $id, string $status, string $timestamp): void
    {
        $update = $this->database->prepare(
            'UPDATE devices
             SET reported_status = :status, last_seen = :last_seen, updated_at = :updated_at
             WHERE id = :id'
        );
        $parameters = [
            'status' => $status,
            'last_seen' => $timestamp,
            'updated_at' => $timestamp,
            'id' => $id,
        ];
        $update->execute($parameters);

        if ($update->rowCount() > 0) {
            return;
        }

        try {
            $insert = $this->database->prepare(
                'INSERT INTO devices
                    (id, reported_status, last_seen, created_at, updated_at)
                 VALUES
                    (:id, :status, :last_seen, :created_at, :updated_at)'
            );
            $insert->execute([
                'id' => $id,
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
     *  @return array{id:int,status:string,last_seen:string,offline_after_seconds:int}
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
            'id' => (int) $row['id'],
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
