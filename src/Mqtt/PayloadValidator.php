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

    /** @return array{device_id:string,nivel_cm:float,capacidade_cm:float,percentual:float,volume_litros:float} */
    public function validateData(string $topic, string $payload, string $topicFilter): array
    {
        $data = $this->decodeObject($payload);
        $topicDeviceId = TopicMatcher::deviceId($topic, $topicFilter);
        if ($topicDeviceId === null) {
            throw new ValidationException('Topico de dados nao corresponde ao filtro configurado.');
        }

        $deviceId = $this->validateDeviceId($data['device_id'] ?? null);
        if (!hash_equals($topicDeviceId, $deviceId)) {
            throw new ValidationException('device_id nao corresponde ao identificador do topico.');
        }

        $nivel = $this->requiredNumber($data, 'nivel_cm');
        $capacidade = $this->requiredNumber($data, 'capacidade_cm');
        $percentual = $this->requiredNumber($data, 'percentual');
        $volume = $this->requiredNumber($data, 'volume_litros');

        if ($capacidade <= 0 || $capacidade > 100000) {
            throw new ValidationException('capacidade_cm esta fora da faixa permitida.');
        }
        if ($nivel < 0 || $nivel > $capacidade) {
            throw new ValidationException('nivel_cm deve estar entre zero e capacidade_cm.');
        }
        if ($percentual < 0 || $percentual > 100) {
            throw new ValidationException('percentual deve estar entre zero e 100.');
        }
        $expectedPercentage = ($nivel / $capacidade) * 100;
        if (abs($percentual - $expectedPercentage) > 1.01) {
            throw new ValidationException('percentual nao corresponde a nivel_cm e capacidade_cm.');
        }
        if ($volume < 0 || $volume > 1000000000) {
            throw new ValidationException('volume_litros esta fora da faixa permitida.');
        }

        return [
            'device_id' => $deviceId,
            'nivel_cm' => $nivel,
            'capacidade_cm' => $capacidade,
            'percentual' => $percentual,
            'volume_litros' => $volume,
        ];
    }

    /** @return array{device_id:string,status:string} */
    public function validateStatus(string $topic, string $payload, string $topicFilter): array
    {
        $data = $this->decodeObject($payload);
        $topicDeviceId = TopicMatcher::deviceId($topic, $topicFilter);
        if ($topicDeviceId === null) {
            throw new ValidationException('Topico de status nao corresponde ao filtro configurado.');
        }

        $deviceId = $this->validateDeviceId($data['device_id'] ?? null);
        if (!hash_equals($topicDeviceId, $deviceId)) {
            throw new ValidationException('device_id nao corresponde ao identificador do topico.');
        }

        $status = $data['status'] ?? null;
        if (!is_string($status) || !in_array($status, ['online', 'offline'], true)) {
            throw new ValidationException('status deve ser online ou offline.');
        }

        return ['device_id' => $deviceId, 'status' => $status];
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

    private function validateDeviceId(mixed $value): string
    {
        if (!is_string($value) || !preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/', $value)) {
            throw new ValidationException('device_id possui formato invalido.');
        }
        if ($this->allowedDeviceIds !== [] && !in_array($value, $this->allowedDeviceIds, true)) {
            throw new ValidationException('device_id nao esta autorizado.');
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
}
