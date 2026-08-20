<?php

declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';

api_run(static function (): void {
    api_require_get();

    $id = api_id();
    $repository = api_repository();
    $current = $repository->current($id);
    if ($current === null) {
        if ($id !== null && $repository->status($id) === null) {
            throw new R3B\Http\HttpException(
                404,
                'DEVICE_NOT_FOUND',
                'Dispositivo nao encontrado.'
            );
        }
        throw new R3B\Http\HttpException(
            404,
            'NO_DATA',
            'Nenhuma leitura MQTT foi recebida para o dispositivo.'
        );
    }

    api_json([
        'success' => true,
        'device' => $current['device'],
        'data' => $current['data'],
    ]);
});
