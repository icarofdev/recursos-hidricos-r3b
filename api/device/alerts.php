<?php

declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';

api_run(static function (): void {
    api_require_get();

    $id = api_id();
    $repository = api_repository();
    $device = $repository->status($id);
    if ($id !== null && $device === null) {
        throw new R3B\Http\HttpException(404, 'DEVICE_NOT_FOUND', 'Dispositivo nao encontrado.');
    }
    $alerts = [];

    if ($device !== null && $device['status'] === 'offline') {
        $alerts[] = [
            'type' => 'critical',
            'message' => 'Dispositivo sem comunicacao dentro do limite configurado.',
            'timestamp' => $device['last_seen'],
            'id' => $device['id'],
        ];
    }

    api_json([
        'success' => true,
        'count' => count($alerts),
        'data' => $alerts,
    ]);
});
