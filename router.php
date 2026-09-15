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

$pageRoutes = [
    'login' => 'login.php',
    'login.php' => 'login.php',
    'cadastro' => 'register.php',
    'register.php' => 'register.php',
    'esqueci-senha' => 'forgot-password.php',
    'forgot-password.php' => 'forgot-password.php',
    'redefinir-senha' => 'reset-password.php',
    'reset-password.php' => 'reset-password.php',
];
if (isset($pageRoutes[$relativePath])) {
    require __DIR__ . DIRECTORY_SEPARATOR . $pageRoutes[$relativePath];
    return true;
}

if ($relativePath === 'health.php' || $relativePath === 'api/health.php') {
    require __DIR__ . '/health.php';
    return true;
}

$apiRoutes = [
    'api/device/current.php',
    'api/device/history.php',
    'api/device/status.php',
    'api/device/alerts.php',
    'api/device/ingest.php',
    'api/auth/register.php',
    'api/auth/login.php',
    'api/auth/logout.php',
    'api/auth/me.php',
    'api/auth/forgot-password.php',
    'api/auth/reset-password.php',
    'api/reservoirs/index.php',
    'api/reservoirs/rename.php',
    'api/devices/validate-pairing.php',
    'api/devices/connect.php',
    'api/devices/unlink.php',
];
if (in_array($relativePath, $apiRoutes, true)) {
    require __DIR__ . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativePath);
    return true;
}

$staticRoutes = [
    'static/css/dashboard.css',
    'static/css/auth.css',
    'static/js/dashboard.js',
    'static/js/auth.js',
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
