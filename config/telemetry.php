<?php

declare(strict_types=1);

/** @return list<string> */
function telemetry_allowed_device_ids(): array
{
    $allowedDevices = array_values(array_unique(array_filter(
        array_map(
            static fn (string $deviceId): string => trim($deviceId),
            explode(',', env_value('MQTT_ALLOWED_DEVICE_IDS', '') ?? '')
        ),
        static fn (string $deviceId): bool => $deviceId !== ''
    )));

    foreach ($allowedDevices as $deviceId) {
        if (
            !preg_match('/^[1-9][0-9]*$/', $deviceId)
            || filter_var($deviceId, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) === false
        ) {
            throw new RuntimeException('MQTT_ALLOWED_DEVICE_IDS contem um identificador invalido.');
        }
    }

    return $allowedDevices;
}

function telemetry_max_payload_bytes(): int
{
    return env_int('MQTT_MAX_PAYLOAD_BYTES', 4096, 128, 1048576);
}
