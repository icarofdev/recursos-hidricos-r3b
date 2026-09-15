<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/_bootstrap.php';

api_run(static function (): void {
    api_require_post();
    auth_require_user();
    auth_require_csrf();
    api_enforce_rate_limit('pairing_ip', auth_client_ip(), 10, 600);
    $data = api_json_body();
    api_reject_unknown_fields($data, ['pairing_code']);
    $device = auth_reservoir_repository()->validatePairingCode(
        api_required_string($data, 'pairing_code', 96)
    );
    api_json(['success' => true, 'data' => $device]);
});
