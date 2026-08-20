<?php

declare(strict_types=1);

$requestPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$requestPath = is_string($requestPath) ? rawurldecode($requestPath) : '/';
$relativePath = ltrim(str_replace('\\', '/', $requestPath), '/');

if (str_contains($relativePath, "\0")) {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Requisicao invalida.';
    return true;
}

if ($relativePath === '' || $relativePath === 'index.php') {
    require __DIR__ . '/index.php';
    return true;
}

$apiRoutes = [
    'api/device/current.php',
    'api/device/history.php',
    'api/device/status.php',
    'api/device/alerts.php',
];
if (in_array($relativePath, $apiRoutes, true)) {
    require __DIR__ . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativePath);
    return true;
}

$staticRoutes = [
    'static/css/dashboard.css',
    'static/js/dashboard.js',
    'static/js/vendor/chart.umd.min.js',
];
if (in_array($relativePath, $staticRoutes, true)) {
    $target = __DIR__ . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativePath);
    if (is_file($target)) {
        return false;
    }
}

http_response_code(404);
header('Content-Type: text/plain; charset=utf-8');
header('X-Content-Type-Options: nosniff');
echo 'Recurso nao encontrado.';
return true;
