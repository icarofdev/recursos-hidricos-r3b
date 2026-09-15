<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/_bootstrap.php';

api_run(static function (): void {
    api_require_post();
    auth_require_csrf();
    $data = api_json_body();
    api_reject_unknown_fields($data, ['email']);
    $email = api_required_string($data, 'email', 254);
    $normalized = R3B\Auth\AuthService::normalizeEmail($email);

    api_enforce_rate_limit('password_reset_ip', auth_client_ip(), 8, 900);
    api_enforce_rate_limit('password_reset_email', $normalized, 3, 900);
    try {
        auth_password_reset_service()->request($normalized);
    } catch (Throwable $exception) {
        // A resposta permanece indistinguível para impedir enumeração. O detalhe
        // técnico, sem token nem credencial, fica somente no log do servidor.
        error_log('[Password reset] Falha no envio: ' . api_sanitize_log($exception->getMessage()));
    }

    api_json([
        'success' => true,
        'message' => 'Se existir uma conta com este e-mail, enviaremos as instruções para redefinir sua senha.',
    ]);
});
