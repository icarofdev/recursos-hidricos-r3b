<?php

declare(strict_types=1);

require_once __DIR__ . '/config/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if ($path !== '/smwu') {
    http_response_code(404);
    echo json_encode(['success' => false, 'error' => ['code' => 'NOT_FOUND']], JSON_UNESCAPED_SLASHES);
    exit;
}

if (strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    header('Allow: POST');
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => ['code' => 'METHOD_NOT_ALLOWED']], JSON_UNESCAPED_SLASHES);
    exit;
}

$allowedAddresses = array_values(array_filter(array_map(
    'trim',
    explode(',', env_value('SMWU_LOCAL_DEVICE_IPS', '') ?? '')
)));
$remoteAddress = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
if ($allowedAddresses === [] || !in_array($remoteAddress, $allowedAddresses, true)) {
    http_response_code(403);
    echo json_encode(['success' => false, 'error' => ['code' => 'SOURCE_NOT_ALLOWED']], JSON_UNESCAPED_SLASHES);
    exit;
}

$forwardUrl = trim(env_value('SMWU_FORWARD_URL', '') ?? '');
$deviceToken = trim(env_value('SMWU_DEVICE_TOKEN', '') ?? '');
if (!str_starts_with($forwardUrl, 'https://') || $deviceToken === '') {
    http_response_code(503);
    echo json_encode(['success' => false, 'error' => ['code' => 'GATEWAY_NOT_CONFIGURED']], JSON_UNESCAPED_SLASHES);
    exit;
}

$payload = file_get_contents('php://input');
if (!is_string($payload) || $payload === '' || strlen($payload) > 4096) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => ['code' => 'INVALID_PAYLOAD']], JSON_UNESCAPED_SLASHES);
    exit;
}

$request = curl_init($forwardUrl);
if ($request === false) {
    http_response_code(502);
    echo json_encode(['success' => false, 'error' => ['code' => 'FORWARD_INIT_FAILED']], JSON_UNESCAPED_SLASHES);
    exit;
}

curl_setopt_array($request, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_HTTPHEADER => [
        'Authorization: Bearer ' . $deviceToken,
        'Content-Type: application/json',
        'Accept: application/json',
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT => 20,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
]);

$responseBody = curl_exec($request);
$responseCode = (int) curl_getinfo($request, CURLINFO_RESPONSE_CODE);
$curlError = curl_error($request);
curl_close($request);

if (!is_string($responseBody) || $responseCode === 0) {
    error_log('[SMWU Gateway] HTTPS forwarding failed: ' . $curlError);
    http_response_code(502);
    echo json_encode(['success' => false, 'error' => ['code' => 'FORWARD_FAILED']], JSON_UNESCAPED_SLASHES);
    exit;
}

if ($responseCode >= 400) {
    $decodedPayload = json_decode($payload, true);
    $payloadFields = is_array($decodedPayload) && !array_is_list($decodedPayload)
        ? implode(',', array_keys($decodedPayload))
        : 'payload-nao-json';
    error_log(sprintf(
        '[SMWU Gateway] Upstream rejected HTTP %d; fields=%s; response=%s',
        $responseCode,
        $payloadFields,
        substr($responseBody, 0, 500)
    ));
}

http_response_code($responseCode);
echo $responseBody;
