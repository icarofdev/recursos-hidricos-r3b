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

    /** @return array{id:int,distancia:float,nivel:float,volume:float,rssi_wifi:float} */
    public function validateData(string $topic, string $payload, string $topicFilter): array
    {
        $data = $this->decodeObject($payload);
        $topicDeviceId = TopicMatcher::deviceId($topic, $topicFilter);
        if ($topicDeviceId === null) {
            throw new ValidationException('Topico de dados nao corresponde ao filtro configurado.');
        }

        return $this->validateReading($data, $topicDeviceId);
    }

    /** Valida o mesmo contrato de telemetria quando a origem e HTTP. */
    /** @return array{id:int,distancia:float,nivel:float,volume:float,rssi_wifi:float} */
    public function validateHttpData(string $payload): array
    {
        return $this->validateReading($this->normalizeHttpReading($this->decodeObject($payload)));
    }

    /**
     * O firmware HTTP da familia SM serializa numeros como strings JSON.
     * A rota MQTT permanece estrita e nao passa por esta normalizacao.
     *
     * @param array<string, mixed> $data
     * @return array<string, mixed>
     */
    private function normalizeHttpReading(array $data): array
    {
        $aliases = [
            'd' => 'distancia',
            'distance' => 'distancia',
            'level' => 'nivel',
            'volume_litros' => 'volume',
            'volume_liters' => 'volume',
        ];
        $normalized = [];
        foreach ($data as $field => $value) {
            $normalizedField = strtolower(trim((string) $field));
            $normalizedField = $aliases[$normalizedField] ?? $normalizedField;
            if (array_key_exists($normalizedField, $normalized)) {
                throw new ValidationException(sprintf('Payload contem campo duplicado: %s.', $normalizedField));
            }
            $normalized[$normalizedField] = $value;
        }
        $data = $normalized;

        if (isset($data['id']) && is_string($data['id'])) {
            $id = filter_var(trim($data['id']), FILTER_VALIDATE_INT, [
                'options' => ['min_range' => 1],
            ]);
            if ($id !== false) {
                $data['id'] = $id;
            }
        }

        foreach (['distancia', 'nivel', 'volume', 'rssi_wifi'] as $field) {
            if (!isset($data[$field]) || !is_string($data[$field])) {
                continue;
            }

            $value = trim($data[$field]);
            if ($value !== '' && is_numeric($value)) {
                $data[$field] = (float) $value;
            }
        }

        return $data;
    }

    /** @param array<string, mixed> $data */
    private function validateReading(array $data, ?string $topicDeviceId = null): array
    {
        $this->rejectUnknownFields($data, ['id', 'distancia', 'nivel', 'volume', 'rssi_wifi']);
        $deviceId = $this->validateDeviceId($data['id'] ?? null);
        if ($topicDeviceId !== null && !hash_equals($topicDeviceId, (string) $deviceId)) {
            throw new ValidationException('id nao corresponde ao identificador do topico.');
        }

        $distancia = $this->requiredNumber($data, 'distancia');
        $nivel = $this->requiredNumber($data, 'nivel');
        $volume = $this->requiredNumber($data, 'volume');
        $rssiWifi = $this->requiredNumber($data, 'rssi_wifi');

        $this->validateRange('distancia', $distancia, 0, 1000000);
        $this->validateRange('nivel', $nivel, 0, 100);
        $this->validateRange('volume', $volume, 0, 1000000000000);
        $this->validateRange('rssi_wifi', $rssiWifi, -200, 0);

        return [
            'id' => $deviceId,
            'distancia' => $distancia,
            'nivel' => $nivel,
            'volume' => $volume,
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
