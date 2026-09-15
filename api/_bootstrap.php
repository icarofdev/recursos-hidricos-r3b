<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: no-referrer');

try {
    require_once dirname(__DIR__) . '/config/bootstrap.php';
    require_once APP_ROOT . '/config/database.php';
    require_once APP_ROOT . '/includes/api.php';
    require_once APP_ROOT . '/includes/auth.php';
} catch (Throwable $exception) {
    $message = function_exists('api_sanitize_log') ? api_sanitize_log((string) $exception) : $exception->getMessage();
    error_log(sprintf('[API] Bootstrap error: %s', $message));
    http_response_code(503);
    echo json_encode([
        'success' => false,
        'error' => [
            'code' => 'APPLICATION_UNAVAILABLE',
            'message' => 'Aplicação temporariamente indisponível.',
        ],
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
