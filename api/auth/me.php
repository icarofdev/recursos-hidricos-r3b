<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/_bootstrap.php';

api_run(static function (): void {
    api_require_get();
    $user = auth_require_user();
    api_json([
        'success' => true,
        'user' => ['id' => $user['id'], 'name' => $user['name'], 'email' => $user['email']],
        'csrf_token' => auth_csrf_token(),
    ]);
});
