<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/_bootstrap.php';

api_run(static function (): void {
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    api_enforce_rate_limit('password_reset_validation', auth_client_ip(), 20, 900);

    if ($method === 'GET') {
        $token = isset($_GET['token']) && is_string($_GET['token']) ? $_GET['token'] : '';
        api_json(['success' => true, 'valid' => auth_password_reset_service()->isValid($token)]);
    }
    if ($method !== 'POST') {
        header('Allow: GET, POST');
        throw new R3B\Http\HttpException(405, 'METHOD_NOT_ALLOWED', 'Este endpoint aceita GET ou POST.');
    }

    auth_require_csrf();
    $data = api_json_body();
    api_reject_unknown_fields($data, ['token', 'password', 'password_confirmation']);
    auth_password_reset_service()->reset(
        api_required_string($data, 'token', 128),
        api_required_string($data, 'password', 128),
        api_required_string($data, 'password_confirmation', 128)
    );
    if (session_status() === PHP_SESSION_ACTIVE && isset($_SESSION['user_id'])) {
        auth_logout_user();
    }
    api_json([
        'success' => true,
        'message' => 'Senha redefinida com segurança. Entre novamente.',
        'redirect' => '/login?reset=success',
    ]);
});
