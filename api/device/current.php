<?php

declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';

api_run(static function (): void {
    api_require_get();
    $user = auth_require_user();
    $reservoirId = api_reservoir_id();
    $repository = api_repository();
    $reservoir = auth_reservoir_repository()->findOwned($reservoirId, $user['id']);
    if ($reservoir === null) {
        throw new R3B\Http\HttpException(404, 'RESERVOIR_NOT_FOUND', 'Reservatório não encontrado.');
    }
    $current = $repository->currentForReservoir($reservoirId, $user['id']);
    if ($current === null) {
        throw new R3B\Http\HttpException(
            404,
            'NO_DATA',
            'Nenhuma leitura de telemetria foi recebida para este reservatório.'
        );
    }

    api_json([
        'success' => true,
        'reservoir' => $reservoir,
        'device' => $current['device'],
        'data' => $current['data'],
    ]);
});
