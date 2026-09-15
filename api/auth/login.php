<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/_bootstrap.php';

api_run(static function (): void {
    api_require_post();
    auth_require_csrf();
    $data = api_json_body();
    api_reject_unknown_fields($data, ['email', 'password', 'remember', 'next']);
    $email = api_required_string($data, 'email', 254);
    $password = api_required_string($data, 'password', 128);
    $remember = isset($data['remember']) && $data['remember'] === true;
    $next = isset($data['next']) && is_string($data['next']) ? auth_safe_path($data['next']) : '/';

    $normalized = R3B\Auth\AuthService::normalizeEmail($email);
    api_enforce_rate_limit('login_ip', auth_client_ip(), 20, 900);
    api_enforce_rate_limit('login_identity', auth_client_ip() . '|' . $normalized, 10, 900);
    $user = auth_service()->login($normalized, $password);
    auth_rate_limiter()->clear('login_identity', auth_client_ip() . '|' . $normalized);
    auth_login_user($user, $remember);

    api_json([
        'success' => true,
        'user' => ['id' => $user['id'], 'name' => $user['name'], 'email' => $user['email']],
        'csrf_token' => auth_csrf_token(),
        'redirect' => $next,
    ]);
});
