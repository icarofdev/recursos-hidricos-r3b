<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/_bootstrap.php';

api_run(static function (): void {
    api_require_post();
    $user = auth_require_user();
    auth_require_csrf();
    $data = api_json_body();
    api_reject_unknown_fields($data, ['reservoir_id', 'name']);
    $id = filter_var($data['reservoir_id'] ?? null, FILTER_VALIDATE_INT);
    if ($id === false || $id <= 0) {
        throw new R3B\Http\HttpException(422, 'INVALID_RESERVOIR_ID', 'Reservatório inválido.');
    }
    $reservoir = auth_reservoir_repository()->rename(
        (int) $id,
        $user['id'],
        api_required_string($data, 'name', 120)
    );
    api_json(['success' => true, 'data' => $reservoir]);
});
