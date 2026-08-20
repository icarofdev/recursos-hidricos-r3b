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
$id = 1;

if ($config['allowed_devices'] !== [] && !in_array((string) $id, $config['allowed_devices'], true)) {
    fwrite(STDERR, "O id 1 nao esta autorizado em MQTT_ALLOWED_DEVICE_IDS." . PHP_EOL);
    exit(1);
}

$topic = preg_replace('/\+/', (string) $id, $config['data_topic'], 1, $replacementCount);
if (!is_string($topic) || $replacementCount !== 1 || str_contains($topic, '+') || str_contains($topic, '#')) {
    fwrite(STDERR, "MQTT_TOPIC deve conter exatamente um curinga +." . PHP_EOL);
    exit(1);
}

$payload = json_encode([
    'id' => $id,
    'ppl' => 2.0,
    'vazao' => 7.5,
    'consumo' => 1300,
    'rssi_wifi' => -48,
], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);

try {
    $clientId = 'smwa-test-' . bin2hex(random_bytes(5));
    $connection = ClientFactory::create($config, $clientId);
    $client = $connection['client'];
    $client->connect($connection['settings'], true);
    $client->publish($topic, $payload, $config['qos'], false);

    if ($config['qos'] > 0) {
        $client->loop(true, true, 5);
    }

    $client->disconnect();
    fwrite(STDOUT, sprintf(
        "Mensagem SM-WA publicada em %s: %s%s",
        $topic,
        $payload,
        PHP_EOL
    ));
} catch (Throwable $exception) {
    fwrite(STDERR, sprintf("Falha ao publicar: %s%s", $exception->getMessage(), PHP_EOL));
    exit(1);
}
