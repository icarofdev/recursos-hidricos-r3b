<?php

declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';

api_run(static function (): void {
    api_require_get();
    $user = auth_require_user();
    $reservoirId = api_reservoir_id();
    $device = api_repository()->statusForReservoir($reservoirId, $user['id']);
    if ($device === null) {
        throw new R3B\Http\HttpException(
            404,
            'RESERVOIR_NOT_FOUND',
            'Reservatório não encontrado.'
        );
    }

    api_json([
        'success' => true,
        'reservoir_id' => $reservoirId,
        'device' => $device,
    ]);
});

