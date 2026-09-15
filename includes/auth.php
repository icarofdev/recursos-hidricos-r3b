<?php

declare(strict_types=1);

use R3B\Auth\AuthService;
use R3B\Auth\PasswordResetService;
use R3B\Auth\UserRepository;
use R3B\Http\HttpException;
use R3B\Mail\BrevoMailer;
use R3B\ReservoirRepository;
use R3B\Security\RateLimiter;

function request_is_https(): bool
{
    $https = strtolower(trim((string) ($_SERVER['HTTPS'] ?? '')));
    if ($https === 'on' || $https === '1' || (int) ($_SERVER['SERVER_PORT'] ?? 0) === 443) {
        return true;
    }

    // X-Forwarded-Proto só é aceito quando a conexão veio do proxy local.
    $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    if (in_array($remote, ['127.0.0.1', '::1'], true)) {
        $forwarded = strtolower(trim(explode(',', (string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));
        return $forwarded === 'https';
    }
    return false;
}

function auth_start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    $secure = request_is_https();
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.cookie_httponly', '1');
    ini_set('session.cookie_samesite', 'Lax');
    ini_set('session.cookie_secure', $secure ? '1' : '0');
    ini_set('session.gc_maxlifetime', (string) (30 * 86400));
    $sessionPath = trim(env_value('SESSION_SAVE_PATH', APP_ROOT . '/.runtime/sessions') ?? '');
    if ($sessionPath === '') {
        throw new RuntimeException('SESSION_SAVE_PATH não pode ser vazio.');
    }
    if (!is_dir($sessionPath) && !mkdir($sessionPath, 0700, true) && !is_dir($sessionPath)) {
        throw new RuntimeException('Não foi possível preparar o diretório seguro de sessões.');
    }
    session_save_path($sessionPath);
    session_name('HIDRAR3BSESSID');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();

    $now = time();
    $_SESSION['csrf_token'] ??= bin2hex(random_bytes(32));
    $_SESSION['created_at'] ??= $now;
    $_SESSION['last_activity_at'] ??= $now;
    $_SESSION['last_regenerated_at'] ??= $now;
}

function auth_user_repository(): UserRepository
{
    static $repository = null;
    return $repository ??= new UserRepository(database_connection());
}

function auth_service(): AuthService
{
    static $service = null;
    return $service ??= new AuthService(auth_user_repository());
}

function auth_rate_limiter(): RateLimiter
{
    static $limiter = null;
    $secret = trim(env_value('APP_KEY', env_value('DEVICE_TOKEN_SECRET', '')) ?? '');
    if (strtolower(trim(env_value('APP_ENV', 'production') ?? 'production')) === 'production'
        && strlen($secret) < 32) {
        throw new RuntimeException('APP_KEY deve ter pelo menos 32 caracteres em produção.');
    }
    if ($secret === '') {
        // Uma chave derivada do caminho não sai do servidor e evita armazenar PII
        // em claro; produção deve sempre configurar APP_KEY.
        $secret = hash('sha256', APP_ROOT . php_uname('n'));
    }
    return $limiter ??= new RateLimiter(database_connection(), $secret);
}

function auth_reservoir_repository(): ReservoirRepository
{
    static $repository = null;
    $timezone = new DateTimeZone(env_value('APP_TIMEZONE', 'America/Sao_Paulo') ?: 'America/Sao_Paulo');
    return $repository ??= new ReservoirRepository(
        database_connection(),
        env_int('DEVICE_OFFLINE_AFTER_SECONDS', 90, 5, 86400),
        $timezone
    );
}

function auth_password_reset_service(): PasswordResetService
{
    static $service = null;
    $mailer = new BrevoMailer(
        trim(env_value('BREVO_API_KEY', '') ?? ''),
        trim(env_value('BREVO_SENDER_EMAIL', '') ?? ''),
        trim(env_value('BREVO_SENDER_NAME', 'Hidra R3B') ?? 'Hidra R3B')
    );
    $appUrl = rtrim(trim(env_value('APP_URL', 'http://127.0.0.1:8080') ?? ''), '/');
    if (filter_var($appUrl, FILTER_VALIDATE_URL) === false
        || !in_array(strtolower((string) parse_url($appUrl, PHP_URL_SCHEME)), ['http', 'https'], true)) {
        throw new RuntimeException('APP_URL deve ser uma URL HTTP ou HTTPS válida.');
    }
    return $service ??= new PasswordResetService(
        database_connection(),
        auth_user_repository(),
        $mailer,
        $appUrl,
        env_int('PASSWORD_RESET_TTL_MINUTES', 20, 15, 30)
    );
}

/** @return array{id:int,name:string,email:string,session_version:int}|null */
function auth_current_user(): ?array
{
    auth_start_session();
    if (!isset($_SESSION['user_id'], $_SESSION['session_version'])) {
        return null;
    }

    $now = time();
    $remember = (bool) ($_SESSION['remember'] ?? false);
    $absoluteLifetime = $remember ? 30 * 86400 : 12 * 3600;
    $idleLifetime = $remember ? 30 * 86400 : 2 * 3600;
    if ($now - (int) ($_SESSION['created_at'] ?? 0) > $absoluteLifetime
        || $now - (int) ($_SESSION['last_activity_at'] ?? 0) > $idleLifetime) {
        auth_logout_user();
        return null;
    }

    $user = auth_user_repository()->findById((int) $_SESSION['user_id']);
    if ($user === null || $user['session_version'] !== (int) $_SESSION['session_version']) {
        auth_logout_user();
        return null;
    }

    $_SESSION['last_activity_at'] = $now;
    if ($now - (int) ($_SESSION['last_regenerated_at'] ?? 0) >= 900) {
        session_regenerate_id(true);
        $_SESSION['last_regenerated_at'] = $now;
    }
    return [
        'id' => $user['id'],
        'name' => $user['name'],
        'email' => $user['email'],
        'session_version' => $user['session_version'],
    ];
}

/** @param array{id:int,name:string,email:string,session_version:int} $user */
function auth_login_user(array $user, bool $remember): void
{
    auth_start_session();
    session_regenerate_id(true);
    $now = time();
    $_SESSION = [
        'user_id' => $user['id'],
        'session_version' => $user['session_version'],
        'remember' => $remember,
        'created_at' => $now,
        'last_activity_at' => $now,
        'last_regenerated_at' => $now,
        'csrf_token' => bin2hex(random_bytes(32)),
    ];

    if ($remember) {
        setcookie(session_name(), session_id(), [
            'expires' => $now + 30 * 86400,
            'path' => '/',
            'secure' => request_is_https(),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }
}

function auth_logout_user(): void
{
    if (session_status() !== PHP_SESSION_ACTIVE) {
        auth_start_session();
    }
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        setcookie(session_name(), '', [
            'expires' => time() - 42000,
            'path' => '/',
            'secure' => request_is_https(),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }
    session_destroy();
}

/** @return array{id:int,name:string,email:string,session_version:int} */
function auth_require_user(): array
{
    $user = auth_current_user();
    if ($user === null) {
        throw new HttpException(401, 'AUTHENTICATION_REQUIRED', 'Sua sessão expirou. Entre novamente.');
    }
    return $user;
}

function auth_require_page(): array
{
    $user = auth_current_user();
    if ($user !== null) {
        return $user;
    }
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    $next = auth_safe_path(is_string($path) ? $path : '/');
    header('Location: /login?next=' . rawurlencode($next), true, 302);
    exit;
}

function auth_csrf_token(): string
{
    auth_start_session();
    return (string) $_SESSION['csrf_token'];
}

function auth_require_csrf(): void
{
    auth_start_session();
    if ((bool) ($_SESSION['dashboard_share_read_only'] ?? false)) {
        throw new HttpException(403, 'READ_ONLY_SESSION', 'Este acesso compartilhado permite apenas visualização.');
    }
    $provided = trim((string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''));
    $expected = (string) ($_SESSION['csrf_token'] ?? '');
    if ($provided === '' || $expected === '' || !hash_equals($expected, $provided)) {
        throw new HttpException(419, 'INVALID_CSRF_TOKEN', 'A página expirou. Atualize e tente novamente.');
    }
}

function auth_safe_path(?string $path): string
{
    $path = trim((string) $path);
    if ($path === '' || !str_starts_with($path, '/') || str_starts_with($path, '//')) {
        return '/';
    }
    if (parse_url($path, PHP_URL_HOST) !== null || str_contains($path, "\0")) {
        return '/';
    }
    $parsed = parse_url($path);
    if (!is_array($parsed) || isset($parsed['scheme'], $parsed['host'])) {
        return '/';
    }
    return $path;
}

function auth_client_ip(): string
{
    return substr((string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown'), 0, 64);
}

function web_security_headers(): void
{
    header('X-Frame-Options: DENY');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    header('Permissions-Policy: camera=(), microphone=(), geolocation=()');
}
