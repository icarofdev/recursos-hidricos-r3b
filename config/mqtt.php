<?php

declare(strict_types=1);

function mqtt_config(): array
{
    $host = trim(env_value('MQTT_HOST') ?? '');
    if ($host === null || $host === '') {
        throw new RuntimeException('MQTT_HOST nao foi configurado.');
    }

    $allowedDevices = array_values(array_unique(array_filter(
        array_map(
            static fn (string $deviceId): string => trim($deviceId),
            explode(',', env_value('MQTT_ALLOWED_DEVICE_IDS', '') ?? '')
        ),
        static fn (string $deviceId): bool => $deviceId !== ''
    )));
    foreach ($allowedDevices as $deviceId) {
        if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/', $deviceId)) {
            throw new RuntimeException('MQTT_ALLOWED_DEVICE_IDS contem um identificador invalido.');
        }
    }

    $clientId = trim(env_value('MQTT_CLIENT_ID', 'sm-wa-php-subscriber') ?: 'sm-wa-php-subscriber');
    if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]{0,22}$/', $clientId)) {
        throw new RuntimeException('MQTT_CLIENT_ID deve ter entre 1 e 23 caracteres portaveis.');
    }

    $dataTopic = trim(env_value('MQTT_TOPIC', 'sm-wa/+/data') ?: 'sm-wa/+/data');
    $statusTopic = trim(env_value('MQTT_STATUS_TOPIC', 'sm-wa/+/status') ?: 'sm-wa/+/status');
    foreach ([$dataTopic, $statusTopic] as $topicFilter) {
        $levels = explode('/', $topicFilter);
        $wildcardLevels = array_filter($levels, static fn (string $level): bool => $level === '+');
        $hasEmbeddedWildcard = array_filter(
            $levels,
            static fn (string $level): bool => $level !== '+' && str_contains($level, '+')
        );
        if (
            count($wildcardLevels) !== 1
            || $hasEmbeddedWildcard !== []
            || in_array('', $levels, true)
            || str_contains($topicFilter, '#')
        ) {
            throw new RuntimeException('Cada filtro MQTT deve conter um unico nivel +, sem # ou niveis vazios.');
        }
    }
    if (hash_equals($dataTopic, $statusTopic)) {
        throw new RuntimeException('MQTT_TOPIC e MQTT_STATUS_TOPIC devem ser diferentes.');
    }

    $reconnectMinimum = env_int('MQTT_RECONNECT_MIN_SECONDS', 1, 1, 60);
    $reconnectMaximum = env_int('MQTT_RECONNECT_MAX_SECONDS', 30, 1, 300);
    if ($reconnectMinimum > $reconnectMaximum) {
        throw new RuntimeException('MQTT_RECONNECT_MIN_SECONDS nao pode exceder o maximo.');
    }

    return [
        'host' => $host,
        'port' => env_int('MQTT_PORT', 1883, 1, 65535),
        'username' => env_value('MQTT_USERNAME'),
        'password' => env_value('MQTT_PASSWORD'),
        'client_id' => $clientId,
        'data_topic' => $dataTopic,
        'status_topic' => $statusTopic,
        'qos' => env_int('MQTT_QOS', 1, 0, 2),
        'keep_alive' => env_int('MQTT_KEEP_ALIVE_SECONDS', 30, 5, 65535),
        'connect_timeout' => env_int('MQTT_CONNECT_TIMEOUT_SECONDS', 10, 1, 300),
        'socket_timeout' => env_int('MQTT_SOCKET_TIMEOUT_SECONDS', 5, 1, 300),
        'max_payload_bytes' => env_int('MQTT_MAX_PAYLOAD_BYTES', 4096, 128, 1048576),
        'reconnect_min' => $reconnectMinimum,
        'reconnect_max' => $reconnectMaximum,
        'reconnect_reset_after' => env_int('MQTT_RECONNECT_RESET_AFTER_SECONDS', 60, 5, 3600),
        'allowed_devices' => $allowedDevices,
        'tls' => env_bool('MQTT_TLS', false),
        'tls_verify_peer' => env_bool('MQTT_TLS_VERIFY_PEER', true),
        'tls_ca_file' => env_value('MQTT_TLS_CA_FILE'),
    ];
}
