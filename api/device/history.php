<?php

declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';

api_run(static function (): void {
    api_require_get();
    $user = auth_require_user();
    $reservoirId = api_reservoir_id();
    $repository = api_repository();
    if (auth_reservoir_repository()->findOwned($reservoirId, $user['id']) === null) {
        throw new R3B\Http\HttpException(404, 'RESERVOIR_NOT_FOUND', 'Reservatório não encontrado.');
    }
    $hours = api_integer_query('hours', 24, 1, 720);
    $limit = api_integer_query('limit', 500, 1, 2000);
    $since = (new DateTimeImmutable('now', new DateTimeZone('UTC')))
        ->sub(new DateInterval(sprintf('PT%dH', $hours)));
    $history = $repository->historyForReservoir($reservoirId, $user['id'], $since, $limit);

    api_json([
        'success' => true,
        'reservoir_id' => $reservoirId,
        'id' => $history['id'],
        'count' => count($history['data']),
        'data' => $history['data'],
    ]);
});
