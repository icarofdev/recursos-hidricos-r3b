<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');

try {
    require_once dirname(__DIR__, 2) . '/config/bootstrap.php';
    require_once APP_ROOT . '/config/database.php';
    require_once APP_ROOT . '/includes/api.php';
} catch (Throwable $exception) {
    error_log(sprintf('[API] Bootstrap error: %s', $exception));
    http_response_code(503);
    echo json_encode([
        'success' => false,
        'error' => [
            'code' => 'APPLICATION_UNAVAILABLE',
            'message' => 'Aplicacao nao configurada. Verifique as dependencias e o ambiente.',
        ],
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

