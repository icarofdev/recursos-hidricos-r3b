<?php

declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';

api_run(static function (): void {
    api_require_get();

    $deviceId = api_device_id();
    $repository = api_repository();
    $device = $repository->status($deviceId);
    if ($deviceId !== null && $device === null) {
        throw new R3B\Http\HttpException(404, 'DEVICE_NOT_FOUND', 'Dispositivo nao encontrado.');
    }
    $current = $repository->current($deviceId);
    $alerts = [];

    if ($device !== null && $device['status'] === 'offline') {
        $alerts[] = [
            'type' => 'critical',
            'message' => 'Dispositivo sem comunicacao dentro do limite configurado.',
            'timestamp' => $device['last_seen'],
            'device_id' => $device['id'],
        ];
    }

    if ($current !== null) {
        $percentual = (float) $current['data']['percentual'];
        if ($percentual < 20) {
            $alerts[] = [
                'type' => 'critical',
                'message' => 'Nivel de agua criticamente baixo (abaixo de 20%).',
                'timestamp' => $current['data']['timestamp'],
                'device_id' => $current['device']['id'],
            ];
        } elseif ($percentual < 50) {
            $alerts[] = [
                'type' => 'warning',
                'message' => 'Nivel de agua baixo (abaixo de 50%).',
                'timestamp' => $current['data']['timestamp'],
                'device_id' => $current['device']['id'],
            ];
        }
    }

    api_json([
        'success' => true,
        'count' => count($alerts),
        'data' => $alerts,
    ]);
});
