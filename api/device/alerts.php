<?php

declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';

api_run(static function (): void {
    api_require_get();
    $user = auth_require_user();
    $reservoirId = api_reservoir_id();
    $repository = api_repository();
    $device = $repository->statusForReservoir($reservoirId, $user['id']);
    if ($device === null) {
        throw new R3B\Http\HttpException(404, 'RESERVOIR_NOT_FOUND', 'Reservatório não encontrado.');
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

    $current = $repository->currentForReservoir($reservoirId, $user['id']);
    if ($current !== null) {
        $level = $current['data']['nivel'];
        if ($level < 20) {
            $alerts[] = [
                'type' => 'critical',
                'message' => sprintf('Nivel critico do reservatorio: %.2f%%.', $level),
                'timestamp' => $current['data']['timestamp'],
                'id' => $current['data']['id'],
            ];
        } elseif ($level < 40) {
            $alerts[] = [
                'type' => 'warning',
                'message' => sprintf('Nivel baixo do reservatorio: %.2f%%.', $level),
                'timestamp' => $current['data']['timestamp'],
                'id' => $current['data']['id'],
            ];
        }
    }

    api_json([
        'success' => true,
        'reservoir_id' => $reservoirId,
        'count' => count($alerts),
        'data' => $alerts,
    ]);
});
