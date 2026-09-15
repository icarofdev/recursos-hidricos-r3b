<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/_bootstrap.php';

api_run(static function (): void {
    api_require_get();
    $user = auth_require_user();
    $items = auth_reservoir_repository()->listForUser($user['id']);
    api_json(['success' => true, 'count' => count($items), 'data' => $items]);
});
