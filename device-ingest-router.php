<?php

declare(strict_types=1);

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);

if ($path !== '/api/device/ingest.php') {
    http_response_code(404);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode([
        'success' => false,
        'error' => [
            'code' => 'NOT_FOUND',
            'message' => 'Endpoint nao encontrado.',
        ],
    ], JSON_UNESCAPED_SLASHES);
    exit;
}

require __DIR__ . '/api/device/ingest.php';
