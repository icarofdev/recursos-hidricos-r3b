<?php

declare(strict_types=1);

namespace R3B\Mqtt;

use JsonException;

final class PayloadValidator
{
    /** @var list<string> */
    private array $allowedDeviceIds;

    /** @param list<string> $allowedDeviceIds */
    public function __construct(
        private readonly int $maximumPayloadBytes,
        array $allowedDeviceIds = []
    ) {
        $this->allowedDeviceIds = array_values($allowedDeviceIds);
    }

    /** @return array{id:int,ppl:float,vazao:float,consumo:float,rssi_wifi:float} */
    public function validateData(string $topic, string $payload, string $topicFilter): array
    {
        $data = $this->decodeObject($payload);
        $this->rejectUnknownFields($data, ['id', 'ppl', 'vazao', 'consumo', 'rssi_wifi']);
        $topicDeviceId = TopicMatcher::deviceId($topic, $topicFilter);
        if ($topicDeviceId === null) {
            throw new ValidationException('Topico de dados nao corresponde ao filtro configurado.');
        }

        $deviceId = $this->validateDeviceId($data['id'] ?? null);
        if (!hash_equals($topicDeviceId, (string) $deviceId)) {
            throw new ValidationException('id nao corresponde ao identificador do topico.');
        }

        $ppl = $this->requiredNumber($data, 'ppl');
        $vazao = $this->requiredNumber($data, 'vazao');
        $consumo = $this->requiredNumber($data, 'consumo');
        $rssiWifi = $this->requiredNumber($data, 'rssi_wifi');

        $this->validateRange('ppl', $ppl, 0, 1000000000);
        $this->validateRange('vazao', $vazao, 0, 1000000000000);
        $this->validateRange('consumo', $consumo, 0, 1000000000000);
        $this->validateRange('rssi_wifi', $rssiWifi, -200, 0);

        return [
            'id' => $deviceId,
            'ppl' => $ppl,
            'vazao' => $vazao,
            'consumo' => $consumo,
            'rssi_wifi' => $rssiWifi,
        ];
    }

    /** @return array{id:int,status:string} */
    public function validateStatus(string $topic, string $payload, string $topicFilter): array
    {
        $data = $this->decodeObject($payload);
        $this->rejectUnknownFields($data, ['id', 'status']);
        $topicDeviceId = TopicMatcher::deviceId($topic, $topicFilter);
        if ($topicDeviceId === null) {
            throw new ValidationException('Topico de status nao corresponde ao filtro configurado.');
        }

        $deviceId = $this->validateDeviceId($data['id'] ?? null);
        if (!hash_equals($topicDeviceId, (string) $deviceId)) {
            throw new ValidationException('id nao corresponde ao identificador do topico.');
        }

        $status = $data['status'] ?? null;
        if (!is_string($status) || !in_array($status, ['online', 'offline'], true)) {
            throw new ValidationException('status deve ser online ou offline.');
        }

        return ['id' => $deviceId, 'status' => $status];
    }

    /** @return array<string, mixed> */
    private function decodeObject(string $payload): array
    {
        if ($payload === '' || strlen($payload) > $this->maximumPayloadBytes) {
            throw new ValidationException('Payload vazio ou maior que o limite configurado.');
        }

        try {
            $decoded = json_decode($payload, true, 16, JSON_THROW_ON_ERROR);
        } catch (JsonException $exception) {
            throw new ValidationException('Payload nao contem JSON valido.', 0, $exception);
        }

        if (!is_array($decoded) || array_is_list($decoded)) {
            throw new ValidationException('Payload JSON deve ser um objeto.');
        }

        return $decoded;
    }

    private function validateDeviceId(mixed $value): int
    {
        if (!is_int($value) || $value <= 0) {
            throw new ValidationException('id deve ser um inteiro positivo.');
        }
        if ($this->allowedDeviceIds !== [] && !in_array((string) $value, $this->allowedDeviceIds, true)) {
            throw new ValidationException('id nao esta autorizado.');
        }

        return $value;
    }

    /** @param array<string, mixed> $data */
    private function requiredNumber(array $data, string $field): float
    {
        if (!array_key_exists($field, $data) || (!is_int($data[$field]) && !is_float($data[$field]))) {
            throw new ValidationException(sprintf('%s deve ser numerico e obrigatorio.', $field));
        }

        $number = (float) $data[$field];
        if (!is_finite($number)) {
            throw new ValidationException(sprintf('%s deve ser finito.', $field));
        }

        return $number;
    }

    private function validateRange(string $field, float $value, float $minimum, float $maximum): void
    {
        if ($value < $minimum || $value > $maximum) {
            throw new ValidationException(sprintf('%s esta fora da faixa permitida.', $field));
        }
    }

    /** @param array<string, mixed> $data
     *  @param list<string> $allowedFields
     */
    private function rejectUnknownFields(array $data, array $allowedFields): void
    {
        $unknownFields = array_diff(array_keys($data), $allowedFields);
        if ($unknownFields !== []) {
            throw new ValidationException(sprintf(
                'Payload contem campo nao reconhecido: %s.',
                implode(', ', $unknownFields)
            ));
        }
    }
}
