<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/_bootstrap.php';

api_run(static function (): void {
    api_require_post();
    auth_require_csrf();
    $data = api_json_body();
    api_reject_unknown_fields($data, ['name', 'email', 'password', 'password_confirmation']);
    $name = api_required_string($data, 'name', 120);
    $email = api_required_string($data, 'email', 254);
    $password = api_required_string($data, 'password', 128);
    $confirmation = api_required_string($data, 'password_confirmation', 128);

    api_enforce_rate_limit('register_ip', auth_client_ip(), 5, 3600);
    api_enforce_rate_limit('register_email', R3B\Auth\AuthService::normalizeEmail($email), 3, 3600);
    $user = auth_service()->register($name, $email, $password, $confirmation);
    auth_login_user($user, false);

    api_json([
        'success' => true,
        'user' => ['id' => $user['id'], 'name' => $user['name'], 'email' => $user['email']],
        'csrf_token' => auth_csrf_token(),
        'redirect' => '/',
    ], 201);
});
