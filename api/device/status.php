<?php

declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';

api_run(static function (): void {
    api_require_get();

    $device = api_repository()->status(api_device_id());
    if ($device === null) {
        throw new R3B\Http\HttpException(
            404,
            'DEVICE_NOT_FOUND',
            'Nenhuma comunicacao MQTT foi registrada para o dispositivo.'
        );
    }

    api_json([
        'success' => true,
        'device' => $device,
    ]);
});

