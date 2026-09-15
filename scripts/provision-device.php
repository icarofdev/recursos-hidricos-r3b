<?php

declare(strict_types=1);

require dirname(__DIR__) . '/config/bootstrap.php';
require dirname(__DIR__) . '/config/database.php';

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$deviceId = filter_var($argv[1] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
$ttlMinutes = filter_var($argv[2] ?? '1440', FILTER_VALIDATE_INT, ['options' => ['min_range' => 15, 'max_range' => 10080]]);
if ($deviceId === false || $ttlMinutes === false) {
    fwrite(STDERR, "Uso: php scripts/provision-device.php <device-id> [validade-minutos: 15..10080]" . PHP_EOL);
    exit(1);
}

$database = database_connection();
$migrator = new R3B\Database\SchemaMigrator($database);
$migrator->migrate();
$repository = new R3B\ReservoirRepository(
    $database,
    env_int('DEVICE_OFFLINE_AFTER_SECONDS', 90, 5, 86400),
    new DateTimeZone(env_value('APP_TIMEZONE', 'America/Sao_Paulo') ?: 'America/Sao_Paulo')
);

try {
    $code = $repository->provisionPairingCode((int) $deviceId, (int) $ttlMinutes);
    fwrite(STDOUT, "Código de pareamento (exibido uma única vez): {$code}" . PHP_EOL);
    fwrite(STDOUT, "Entregue-o ao proprietário por um canal seguro. Validade: {$ttlMinutes} minutos." . PHP_EOL);
} catch (R3B\Http\HttpException $exception) {
    fwrite(STDERR, $exception->getMessage() . PHP_EOL);
    exit(1);
}
