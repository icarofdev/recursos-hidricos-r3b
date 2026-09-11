<?php

declare(strict_types=1);

/** @return list<string> */
function telemetry_allowed_device_ids(): array
{
    $rawIds = env_value('DEVICE_ALLOWED_IDS', env_value('ALLOWED_DEVICE_IDS', env_value('MQTT_ALLOWED_DEVICE_IDS', ''))) ?? '';
    $allowedDevices = array_values(array_unique(array_filter(
        array_map(
            static fn (string $deviceId): string => trim($deviceId),
            explode(',', $rawIds)
        ),
        static fn (string $deviceId): bool => $deviceId !== ''
    )));

    foreach ($allowedDevices as $deviceId) {
        if (
            !preg_match('/^[1-9][0-9]*$/', $deviceId)
            || filter_var($deviceId, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) === false
        ) {
            throw new RuntimeException('Configuracao de dispositivos autorizados contem um identificador invalido.');
        }
    }

    return $allowedDevices;
}

function telemetry_max_payload_bytes(): int
{
    return env_int('MQTT_MAX_PAYLOAD_BYTES', 4096, 128, 1048576);
}

function telemetry_device_token_for(?int $deviceId = null): ?string
{
    if ($deviceId !== null) {
        $deviceTokensRaw = env_value('DEVICE_TOKENS', '') ?? '';
        if ($deviceTokensRaw !== '') {
            foreach (explode(',', $deviceTokensRaw) as $pair) {
                $parts = explode(':', trim($pair), 2);
                if (count($parts) === 2 && (int) trim($parts[0]) === $deviceId) {
                    $token = trim($parts[1]);
                    if ($token !== '') {
                        return $token;
                    }
                }
            }
        }
    }

    $globalToken = env_value('DEVICE_TOKEN_SECRET', env_value('SMWU_DEVICE_TOKEN', env_value('SMWA_DEVICE_TOKEN', '')));
    $globalToken = is_string($globalToken) ? trim($globalToken) : '';

    return $globalToken !== '' ? $globalToken : null;
}

function telemetry_verify_token(string $providedToken, ?int $deviceId = null): bool
{
    $providedToken = trim($providedToken);
    if ($providedToken === '') {
        return false;
    }

    if ($deviceId !== null) {
        $expected = telemetry_device_token_for($deviceId);
        if ($expected !== null && hash_equals($expected, $providedToken)) {
            return true;
        }
        return false;
    }

    $globalToken = telemetry_device_token_for(null);
    if ($globalToken !== null && hash_equals($globalToken, $providedToken)) {
        return true;
    }

    $deviceTokensRaw = env_value('DEVICE_TOKENS', '') ?? '';
    if ($deviceTokensRaw !== '') {
        foreach (explode(',', $deviceTokensRaw) as $pair) {
            $parts = explode(':', trim($pair), 2);
            if (count($parts) === 2 && hash_equals(trim($parts[1]), $providedToken)) {
                return true;
            }
        }
    }

    return false;
}

function telemetry_allow_http_ingest(): bool
{
    return env_bool('ALLOW_HTTP_INGEST', true);
}

function telemetry_min_interval_seconds(): int
{
    return env_int('TELEMETRY_MIN_INTERVAL_SECONDS', 3, 0, 3600);
}
