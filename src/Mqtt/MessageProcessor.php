<?php

declare(strict_types=1);

namespace R3B\Mqtt;

use DateTimeImmutable;
use DateTimeZone;
use R3B\DeviceRepository;

final class MessageProcessor
{
    private DateTimeZone $utc;

    public function __construct(
        private readonly DeviceRepository $repository,
        private readonly PayloadValidator $validator,
        private readonly string $dataTopicFilter,
        private readonly string $statusTopicFilter
    ) {
        $this->utc = new DateTimeZone('UTC');
    }

    /** @return array{kind:string,device_id:string,status?:string,retained?:bool,stored?:bool} */
    public function process(
        string $topic,
        string $payload,
        ?DateTimeImmutable $receivedAt = null,
        bool $retained = false
    ): array
    {
        $receivedAt = ($receivedAt ?? new DateTimeImmutable('now', $this->utc))->setTimezone($this->utc);

        if (TopicMatcher::deviceId($topic, $this->dataTopicFilter) !== null) {
            if ($retained) {
                throw new ValidationException('Leituras retidas nao sao aceitas.');
            }
            $reading = $this->validator->validateData($topic, $payload, $this->dataTopicFilter);
            $this->repository->storeReading($reading, $receivedAt);

            return ['kind' => 'data', 'device_id' => $reading['device_id']];
        }

        if (TopicMatcher::deviceId($topic, $this->statusTopicFilter) !== null) {
            $status = $this->validator->validateStatus($topic, $payload, $this->statusTopicFilter);
            if ($retained) {
                $stored = $this->repository->storeRetainedStatus(
                    $status['device_id'],
                    $status['status'],
                    $receivedAt
                );

                return [
                    'kind' => 'status',
                    'device_id' => $status['device_id'],
                    'status' => $status['status'],
                    'retained' => true,
                    'stored' => $stored,
                ];
            }

            $this->repository->storeStatus($status['device_id'], $status['status'], $receivedAt);

            return [
                'kind' => 'status',
                'device_id' => $status['device_id'],
                'status' => $status['status'],
            ];
        }

        throw new ValidationException('Mensagem recebida em topico nao reconhecido.');
    }
}
