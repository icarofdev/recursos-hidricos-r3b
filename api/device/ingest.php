<?php

declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';
require_once dirname(__DIR__, 2) . '/config/telemetry.php';

api_run(static function (): void {
    api_require_post();

    $remoteAddress = (string) ($_SERVER['REMOTE_ADDR'] ?? '127.0.0.1');
    api_check_rate_limit('ingest_ip_' . $remoteAddress);

    $maximumPayloadBytes = telemetry_max_payload_bytes();
    $contentLength = $_SERVER['CONTENT_LENGTH'] ?? null;
    if (is_string($contentLength) && ctype_digit($contentLength) && (int) $contentLength > $maximumPayloadBytes) {
        throw new R3B\Http\HttpException(413, 'PAYLOAD_TOO_LARGE', 'Payload maior que o limite configurado.');
    }

    $payload = file_get_contents('php://input', false, null, 0, $maximumPayloadBytes + 1);
    if ($payload === false || strlen($payload) > $maximumPayloadBytes) {
        throw new R3B\Http\HttpException(413, 'PAYLOAD_TOO_LARGE', 'Payload maior que o limite configurado.');
    }

    $validator = new R3B\Mqtt\PayloadValidator($maximumPayloadBytes, telemetry_allowed_device_ids());
    $reading = $validator->validateHttpData($payload);
    // A credencial específica é validada antes de qualquer alteração no banco.
    api_require_device_token($reading['id']);
    api_repository()->storeReading(
        $reading,
        new DateTimeImmutable('now', new DateTimeZone('UTC')),
        telemetry_min_interval_seconds()
    );

    api_json([
        'success' => true,
        'data' => ['id' => $reading['id']],
    ]);
});
