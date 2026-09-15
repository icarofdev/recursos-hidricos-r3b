<?php

declare(strict_types=1);

require_once __DIR__ . '/config/bootstrap.php';

$username = trim(env_value('DASHBOARD_SHARE_USERNAME', '') ?? '');
$password = env_value('DASHBOARD_SHARE_PASSWORD', '') ?? '';

if ($username === '' || $password === '') {
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    echo 'Compartilhamento do dashboard nao configurado.';
    exit;
}

$providedUser = $_SERVER['PHP_AUTH_USER'] ?? '';
$providedPassword = $_SERVER['PHP_AUTH_PW'] ?? '';

if (!hash_equals($username, (string) $providedUser)
    || !hash_equals($password, (string) $providedPassword)) {
    http_response_code(401);
    header('WWW-Authenticate: Basic realm="Dashboard SM-WU", charset="UTF-8"');
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo 'Autenticacao necessaria.';
    exit;
}

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
if (!in_array($method, ['GET', 'HEAD'], true)) {
    http_response_code(405);
    header('Allow: GET, HEAD');
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    echo 'Metodo nao permitido.';
    exit;
}

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$path = is_string($path) ? $path : '/';

$dynamicRoutes = [
    '/' => __DIR__ . '/index.php',
    '/index.php' => __DIR__ . '/index.php',
    '/api/reservoirs/index.php' => __DIR__ . '/api/reservoirs/index.php',
    '/api/device/current.php' => __DIR__ . '/api/device/current.php',
    '/api/device/history.php' => __DIR__ . '/api/device/history.php',
    '/api/device/status.php' => __DIR__ . '/api/device/status.php',
    '/api/device/alerts.php' => __DIR__ . '/api/device/alerts.php',
];

if (isset($dynamicRoutes[$path])) {
    require_once APP_ROOT . '/config/database.php';
    require_once APP_ROOT . '/includes/auth.php';

    $shareEmail = strtolower(trim(env_value('DASHBOARD_SHARE_USER_EMAIL', '') ?? ''));
    $shareUser = $shareEmail === '' ? null : auth_user_repository()->findByEmail($shareEmail);
    if ($shareUser === null) {
        http_response_code(503);
        header('Content-Type: text/plain; charset=utf-8');
        header('Cache-Control: no-store');
        echo 'Conta de compartilhamento nao configurada.';
        exit;
    }

    $currentUser = auth_current_user();
    if ($currentUser === null || $currentUser['id'] !== $shareUser['id']) {
        auth_login_user([
            'id' => $shareUser['id'],
            'name' => $shareUser['name'],
            'email' => $shareUser['email'],
            'session_version' => $shareUser['session_version'],
        ], false);
    }
    // A sessão criada por HTTP Basic só pode consultar dados. Mesmo que o
    // cookie seja reutilizado em outro entrypoint no mesmo host, o CSRF
    // rejeitará alterações de estado.
    $_SESSION['dashboard_share_read_only'] = true;

    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
    require $dynamicRoutes[$path];
    exit;
}

$staticPrefixes = [
    '/static/css/',
    '/static/js/',
];

foreach ($staticPrefixes as $prefix) {
    if (str_starts_with($path, $prefix)) {
        $relativePath = ltrim($path, '/');
        $candidate = realpath(__DIR__ . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativePath));
        $staticRoot = realpath(__DIR__ . DIRECTORY_SEPARATOR . 'static');

        if ($candidate !== false
            && $staticRoot !== false
            && str_starts_with($candidate, $staticRoot . DIRECTORY_SEPARATOR)
            && is_file($candidate)) {
            header('X-Content-Type-Options: nosniff');
            header('Referrer-Policy: no-referrer');
            return false;
        }
    }
}

http_response_code(404);
header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');
echo 'Pagina nao encontrada.';

