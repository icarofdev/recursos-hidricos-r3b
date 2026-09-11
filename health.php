<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$timestamp = (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\\TH:i:s\\Z');

try {
    require_once __DIR__ . '/config/bootstrap.php';
    require_once __DIR__ . '/config/database.php';

    $db = database_connection();
    $statement = $db->query('SELECT 1');
    $ok = $statement !== false && (int) $statement->fetchColumn() === 1;

    if (!$ok) {
        throw new RuntimeException('Database query failed');
    }

    http_response_code(200);
    echo json_encode([
        'status' => 'ok',
        'timestamp' => $timestamp,
        'database' => 'connected',
    ], JSON_UNESCAPED_SLASHES);
} catch (Throwable $exception) {
    http_response_code(503);
    echo json_encode([
        'status' => 'degraded',
        'timestamp' => $timestamp,
        'database' => 'unavailable',
    ], JSON_UNESCAPED_SLASHES);
}
