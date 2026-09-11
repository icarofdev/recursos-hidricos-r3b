<?php

declare(strict_types=1);

use R3B\Mqtt\ClientFactory;

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once dirname(__DIR__) . '/config/bootstrap.php';
require_once APP_ROOT . '/config/mqtt.php';

$config = mqtt_config();
$deviceId = $argv[1] ?? '1';
if (
    !is_string($deviceId)
    || !preg_match('/^[1-9][0-9]*$/', $deviceId)
    || filter_var($deviceId, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) === false
) {
    fwrite(STDERR, "id invalido." . PHP_EOL);
    exit(1);
}
if ($config['allowed_devices'] !== [] && !in_array($deviceId, $config['allowed_devices'], true)) {
    fwrite(STDERR, "id nao esta em MQTT_ALLOWED_DEVICE_IDS." . PHP_EOL);
    exit(1);
}

$topic = preg_replace('/\+/', $deviceId, $config['data_topic'], 1, $replacementCount);
if (!is_string($topic) || $replacementCount !== 1 || str_contains($topic, '+') || str_contains($topic, '#')) {
    fwrite(STDERR, "MQTT_TOPIC deve conter exatamente um curinga +." . PHP_EOL);
    exit(1);
}

$payload = json_encode([
    'id' => (int) $deviceId,
    'distancia' => 42.5,
    'nivel' => 75.0,
    'volume' => 1253.0,
    'rssi_wifi' => -60.0,
], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);

try {
    $clientId = 'smwa-pub-' . bin2hex(random_bytes(6));
    $connection = ClientFactory::create($config, $clientId);
    $client = $connection['client'];
    $client->connect($connection['settings'], true);
    $client->publish($topic, $payload, $config['qos'], false);
    if ($config['qos'] > 0) {
        $client->loop(true, true, 5);
    }
    $client->disconnect();
    fwrite(STDOUT, sprintf("Mensagem de teste publicada em %s.%s", $topic, PHP_EOL));
} catch (Throwable $exception) {
    fwrite(STDERR, sprintf("Falha ao publicar: %s%s", $exception->getMessage(), PHP_EOL));
    exit(1);
}
