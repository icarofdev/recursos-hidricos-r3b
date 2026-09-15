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

    /** @param array{id:int,distancia:float,nivel:float,volume:float,rssi_wifi:float} $reading */
    public function storeReading(array $reading, DateTimeImmutable $receivedAt, int $dedupWindowSeconds = 0): bool
    {
        $timestamp = $this->databaseTimestamp($receivedAt->setTimezone($this->utc));

        $this->database->beginTransaction();
        try {
            $this->touchDevice($reading['id'], 'online', $timestamp);

            if ($dedupWindowSeconds > 0) {
                $check = $this->database->prepare(
                    'SELECT distancia, nivel, volume, rssi_wifi, created_at
                     FROM smwu_readings
                     WHERE id = :id
                     ORDER BY created_at DESC, reading_id DESC
                     LIMIT 1'
                );
                $check->execute(['id' => $reading['id']]);
                $last = $check->fetch();
                if (is_array($last)) {
                    $lastTimestamp = (new DateTimeImmutable((string) $last['created_at'], $this->utc))->getTimestamp();
                    $thisTimestamp = $receivedAt->getTimestamp();
                    if (abs($thisTimestamp - $lastTimestamp) <= $dedupWindowSeconds
                        && abs((float) $last['distancia'] - (float) $reading['distancia']) < 0.0001
                        && abs((float) $last['nivel'] - (float) $reading['nivel']) < 0.0001
                        && abs((float) $last['volume'] - (float) $reading['volume']) < 0.0001
                    ) {
                        $this->database->commit();
                        return false;
                    }
                }
            }

            $statement = $this->database->prepare(
                'INSERT INTO smwu_readings
                    (id, reservoir_id, distancia, nivel, volume, rssi_wifi, created_at)
                 VALUES
                    (:id, :reservoir_id, :distancia, :nivel, :volume, :rssi_wifi, :created_at)'
            );
            $statement->execute([
                'id' => $reading['id'],
                'reservoir_id' => $this->activeReservoirId($reading['id']),
                'distancia' => $reading['distancia'],
                'nivel' => $reading['nivel'],
                'volume' => $reading['volume'],
                'rssi_wifi' => $reading['rssi_wifi'],
                'created_at' => $timestamp,
            ]);

            $this->database->commit();
            return true;
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

    /** @return array{device:array{id:int,status:string,last_seen:string,offline_after_seconds:int},data:array{id:int,distancia:float,nivel:float,volume:float,rssi_wifi:float,timestamp:string}}|null */
    public function current(?int $id = null, ?DateTimeImmutable $now = null): ?array
    {
        $id ??= $this->latestDeviceId();
        if ($id === null) {
            return null;
        }

        $statement = $this->database->prepare(
            'SELECT d.id, d.reported_status, d.last_seen,
                    r.distancia, r.nivel, r.volume, r.rssi_wifi,
                    r.created_at AS reading_timestamp
             FROM smwu_readings r
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
                'distancia' => (float) $row['distancia'],
                'nivel' => (float) $row['nivel'],
                'volume' => (float) $row['volume'],
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

    /** @return array{id:?int,data:list<array{id:int,distancia:float,nivel:float,volume:float,rssi_wifi:float,timestamp:string}>} */
    public function history(?int $id, DateTimeImmutable $since, int $limit): array
    {
        $id ??= $this->latestDeviceId();

        if ($id === null) {
            return ['id' => null, 'data' => []];
        }

        $statement = $this->database->prepare(
            'SELECT id, distancia, nivel, volume, rssi_wifi, created_at
             FROM smwu_readings
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
                'distancia' => (float) $row['distancia'],
                'nivel' => (float) $row['nivel'],
                'volume' => (float) $row['volume'],
                'rssi_wifi' => (float) $row['rssi_wifi'],
                'timestamp' => $this->apiTimestamp((string) $row['created_at']),
            ];
        }

        return ['id' => $id, 'data' => $data];
    }

    /**
     * Consulta privada com autorização aplicada na própria query. O identificador
     * recebido é o reservatório, nunca o proprietário enviado pelo navegador.
     *
     * @return array{device:array{id:int,status:string,last_seen:string,offline_after_seconds:int},data:array{id:int,distancia:float,nivel:float,volume:float,rssi_wifi:float,timestamp:string}}|null
     */
    public function currentForReservoir(int $reservoirId, int $userId, ?DateTimeImmutable $now = null): ?array
    {
        $statement = $this->database->prepare(
            'SELECT d.id, d.reported_status, d.last_seen,
                    m.distancia, m.nivel, m.volume, m.rssi_wifi,
                    m.created_at AS reading_timestamp
             FROM reservoirs r
             INNER JOIN devices d ON d.id = r.device_id AND d.owner_user_id = r.user_id
             INNER JOIN smwu_readings m ON m.reservoir_id = r.id AND m.id = d.id
             WHERE r.id = :reservoir_id AND r.user_id = :user_id AND r.unlinked_at IS NULL
             ORDER BY m.created_at DESC, m.reading_id DESC
             LIMIT 1'
        );
        $statement->execute(['reservoir_id' => $reservoirId, 'user_id' => $userId]);
        $row = $statement->fetch();
        if (!is_array($row)) {
            return null;
        }
        return [
            'device' => $this->deviceFromRow($row, $now),
            'data' => [
                'id' => (int) $row['id'],
                'distancia' => (float) $row['distancia'],
                'nivel' => (float) $row['nivel'],
                'volume' => (float) $row['volume'],
                'rssi_wifi' => (float) $row['rssi_wifi'],
                'timestamp' => $this->apiTimestamp((string) $row['reading_timestamp']),
            ],
        ];
    }

    /** @return array{id:int,status:string,last_seen:string,offline_after_seconds:int}|null */
    public function statusForReservoir(int $reservoirId, int $userId, ?DateTimeImmutable $now = null): ?array
    {
        $statement = $this->database->prepare(
            'SELECT d.id, d.reported_status, d.last_seen
             FROM reservoirs r
             INNER JOIN devices d ON d.id = r.device_id AND d.owner_user_id = r.user_id
             WHERE r.id = :reservoir_id AND r.user_id = :user_id AND r.unlinked_at IS NULL
             LIMIT 1'
        );
        $statement->execute(['reservoir_id' => $reservoirId, 'user_id' => $userId]);
        $row = $statement->fetch();
        return is_array($row) ? $this->deviceFromRow($row, $now) : null;
    }

    /** @return array{id:int,data:list<array{id:int,distancia:float,nivel:float,volume:float,rssi_wifi:float,timestamp:string}>} */
    public function historyForReservoir(
        int $reservoirId,
        int $userId,
        DateTimeImmutable $since,
        int $limit
    ): array {
        $device = $this->statusForReservoir($reservoirId, $userId);
        if ($device === null) {
            throw new \R3B\Http\HttpException(404, 'RESERVOIR_NOT_FOUND', 'Reservatório não encontrado.');
        }
        $statement = $this->database->prepare(
            'SELECT m.id, m.distancia, m.nivel, m.volume, m.rssi_wifi, m.created_at
             FROM smwu_readings m
             INNER JOIN reservoirs r ON r.id = m.reservoir_id
             WHERE r.id = :reservoir_id AND r.user_id = :user_id AND r.unlinked_at IS NULL
               AND m.created_at >= :since
             ORDER BY m.created_at DESC, m.reading_id DESC
             LIMIT :limit'
        );
        $statement->bindValue(':reservoir_id', $reservoirId, PDO::PARAM_INT);
        $statement->bindValue(':user_id', $userId, PDO::PARAM_INT);
        $statement->bindValue(':since', $this->databaseTimestamp($since->setTimezone($this->utc)), PDO::PARAM_STR);
        $statement->bindValue(':limit', $limit, PDO::PARAM_INT);
        $statement->execute();

        $data = [];
        while ($row = $statement->fetch()) {
            $data[] = [
                'id' => (int) $row['id'],
                'distancia' => (float) $row['distancia'],
                'nivel' => (float) $row['nivel'],
                'volume' => (float) $row['volume'],
                'rssi_wifi' => (float) $row['rssi_wifi'],
                'timestamp' => $this->apiTimestamp((string) $row['created_at']),
            ];
        }
        return ['id' => $device['id'], 'data' => $data];
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
                    (id, device_code, reported_status, last_seen, created_at, updated_at)
                 VALUES
                    (:id, :device_code, :status, :last_seen, :created_at, :updated_at)'
            );
            $insert->execute([
                'id' => $id,
                'device_code' => ReservoirRepository::deviceCode($id),
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

    private function activeReservoirId(int $deviceId): ?int
    {
        $statement = $this->database->prepare(
            'SELECT r.id
             FROM reservoirs r
             INNER JOIN devices d ON d.id = r.device_id
             WHERE r.device_id = :device_id AND r.unlinked_at IS NULL
               AND d.owner_user_id = r.user_id
             ORDER BY r.id DESC LIMIT 1'
        );
        $statement->execute(['device_id' => $deviceId]);
        $id = $statement->fetchColumn();
        return $id === false ? null : (int) $id;
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
