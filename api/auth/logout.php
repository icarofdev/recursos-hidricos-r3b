<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/_bootstrap.php';

api_run(static function (): void {
    api_require_post();
    auth_require_user();
    auth_require_csrf();
    auth_logout_user();
    api_json(['success' => true, 'redirect' => '/login']);
});
