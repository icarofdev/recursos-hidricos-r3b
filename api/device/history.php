<?php

declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';

api_run(static function (): void {
    api_require_get();

    $deviceId = api_device_id();
    $repository = api_repository();
    if ($deviceId !== null && $repository->status($deviceId) === null) {
        throw new R3B\Http\HttpException(404, 'DEVICE_NOT_FOUND', 'Dispositivo nao encontrado.');
    }
    $hours = api_integer_query('hours', 24, 1, 720);
    $limit = api_integer_query('limit', 500, 1, 2000);
    $since = (new DateTimeImmutable('now', new DateTimeZone('UTC')))
        ->sub(new DateInterval(sprintf('PT%dH', $hours)));
    $history = $repository->history($deviceId, $since, $limit);

    api_json([
        'success' => true,
        'device_id' => $history['device_id'],
        'count' => count($history['data']),
        'data' => $history['data'],
    ]);
});
