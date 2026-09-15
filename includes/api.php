<?php

declare(strict_types=1);

use R3B\DeviceRepository;
use R3B\Http\HttpException;
use R3B\Mqtt\ValidationException;

function api_json(array $payload, int $statusCode = 200): never
{
    http_response_code($statusCode);
    echo json_encode(
        $payload,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION
    );
    exit;
}

function api_error(int $statusCode, string $code, string $message): never
{
    api_json([
        'success' => false,
        'error' => [
            'code' => $code,
            'message' => $message,
        ],
    ], $statusCode);
}

function api_sanitize_log(string $message): string
{
    $redacted = preg_replace('/(token=)[^\s&]+/i', '$1[REDACTED]', $message) ?? $message;
    return preg_replace('/(Bearer\s+)[^\s"\']+/i', '$1[REDACTED]', $redacted) ?? $redacted;
}

function api_run(callable $callback): never
{
    try {
        $callback();
        throw new LogicException('O endpoint nao produziu uma resposta.');
    } catch (HttpException $exception) {
        api_error($exception->statusCode, $exception->errorCode, $exception->getMessage());
    } catch (ValidationException $exception) {
        api_error(422, 'INVALID_TELEMETRY', $exception->getMessage());
    } catch (PDOException $exception) {
        error_log(sprintf('[API] Database error: %s', api_sanitize_log($exception->getMessage())));
        api_error(503, 'DATABASE_UNAVAILABLE', 'Banco de dados temporariamente indisponivel.');
    } catch (Throwable $exception) {
        $errorId = bin2hex(random_bytes(6));
        error_log(sprintf('[API] Unexpected error %s: %s', $errorId, api_sanitize_log((string) $exception)));
        api_error(500, 'INTERNAL_ERROR', sprintf('Erro interno. Referencia: %s.', $errorId));
    }
}

function api_require_get(): void
{
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    if ($method !== 'GET') {
        header('Allow: GET');
        throw new HttpException(405, 'METHOD_NOT_ALLOWED', 'Este endpoint aceita somente GET.');
    }
}

function api_require_post(): void
{
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    if ($method !== 'POST') {
        header('Allow: POST');
        throw new HttpException(405, 'METHOD_NOT_ALLOWED', 'Este endpoint aceita somente POST.');
    }
}

/** @return array<string,mixed> */
function api_json_body(int $maximumBytes = 16384): array
{
    $contentType = strtolower(trim(explode(';', (string) ($_SERVER['CONTENT_TYPE'] ?? ''))[0]));
    if ($contentType !== 'application/json') {
        throw new HttpException(415, 'UNSUPPORTED_MEDIA_TYPE', 'Envie os dados como application/json.');
    }
    $contentLength = $_SERVER['CONTENT_LENGTH'] ?? null;
    if (is_string($contentLength) && ctype_digit($contentLength) && (int) $contentLength > $maximumBytes) {
        throw new HttpException(413, 'PAYLOAD_TOO_LARGE', 'Conteúdo maior que o limite permitido.');
    }
    $raw = file_get_contents('php://input', false, null, 0, $maximumBytes + 1);
    if ($raw === false || strlen($raw) > $maximumBytes) {
        throw new HttpException(413, 'PAYLOAD_TOO_LARGE', 'Conteúdo maior que o limite permitido.');
    }
    try {
        $decoded = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
    } catch (JsonException) {
        throw new HttpException(400, 'INVALID_JSON', 'O corpo da solicitação não contém JSON válido.');
    }
    if (!is_array($decoded) || array_is_list($decoded)) {
        throw new HttpException(400, 'INVALID_JSON', 'O corpo JSON deve ser um objeto.');
    }
    return $decoded;
}

/** @param array<string,mixed> $data */
function api_reject_unknown_fields(array $data, array $allowed): void
{
    $unknown = array_diff(array_keys($data), $allowed);
    if ($unknown !== []) {
        throw new HttpException(422, 'UNKNOWN_FIELD', 'A solicitação contém campos não reconhecidos.');
    }
}

function api_required_string(array $data, string $field, int $maximum): string
{
    $value = $data[$field] ?? null;
    if (!is_string($value) || strlen($value) > $maximum) {
        throw new HttpException(422, 'INVALID_FIELD', sprintf('O campo %s é inválido.', $field));
    }
    return $value;
}

function api_request_uses_https(): bool
{
    if (function_exists('request_is_https')) {
        return request_is_https();
    }
    $https = strtolower(trim((string) ($_SERVER['HTTPS'] ?? '')));
    if ($https === 'on' || $https === '1') {
        return true;
    }

    $port = (int) ($_SERVER['SERVER_PORT'] ?? 0);
    if ($port === 443) {
        return true;
    }

    $remoteAddress = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    if ($remoteAddress === '' || in_array($remoteAddress, ['127.0.0.1', '::1'], true)) {
        $forwardedProto = strtolower(trim(explode(',', (string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));
        if ($forwardedProto === 'https') {
            return true;
        }
    }

    return false;
}

function api_reservoir_id(): int
{
    $value = $_GET['reservoir_id'] ?? null;
    if (!is_string($value) || !preg_match('/^[1-9][0-9]*$/', $value)) {
        throw new HttpException(422, 'INVALID_RESERVOIR_ID', 'reservoir_id deve ser um inteiro positivo.');
    }
    $id = filter_var($value, FILTER_VALIDATE_INT);
    if ($id === false || $id <= 0) {
        throw new HttpException(422, 'INVALID_RESERVOIR_ID', 'reservoir_id deve ser um inteiro positivo.');
    }
    return (int) $id;
}

function api_enforce_rate_limit(string $scope, string $identifier, int $limit, int $windowSeconds): void
{
    $retryAfter = auth_rate_limiter()->consume($scope, $identifier, $limit, $windowSeconds);
    if ($retryAfter > 0) {
        header('Retry-After: ' . $retryAfter);
        throw new HttpException(429, 'RATE_LIMIT_EXCEEDED', 'Muitas tentativas. Aguarde e tente novamente.');
    }
}

function api_extract_device_token(): ?string
{
    $authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (is_string($authorization) && preg_match('/^Bearer\s+(.+)$/i', trim($authorization), $matches)) {
        return trim($matches[1]);
    }

    if (isset($_SERVER['HTTP_X_DEVICE_TOKEN']) && is_string($_SERVER['HTTP_X_DEVICE_TOKEN'])) {
        $token = trim($_SERVER['HTTP_X_DEVICE_TOKEN']);
        if ($token !== '') {
            return $token;
        }
    }

    $allowHttpToken = function_exists('telemetry_allow_http_ingest')
        ? telemetry_allow_http_ingest()
        : env_bool('ALLOW_HTTP_INGEST', true);

    if (isset($_GET['token']) && is_string($_GET['token']) && (api_request_uses_https() || $allowHttpToken)) {
        $token = trim($_GET['token']);
        if ($token !== '') {
            return $token;
        }
    }

    return null;
}

function api_require_device_token(?int $deviceId = null): string
{
    $hasConfiguredToken = function_exists('telemetry_device_token_for')
        ? (telemetry_device_token_for($deviceId) !== null || telemetry_device_token_for(null) !== null)
        : (trim(env_value('DEVICE_TOKEN_SECRET', env_value('SMWU_DEVICE_TOKEN', env_value('SMWA_DEVICE_TOKEN', ''))) ?? '') !== '');

    if (!$hasConfiguredToken) {
        throw new HttpException(
            503,
            'INGEST_NOT_CONFIGURED',
            'O endpoint de ingestao ainda nao foi configurado.'
        );
    }

    $provided = api_extract_device_token();
    if ($provided === null || $provided === '') {
        throw new HttpException(401, 'INVALID_DEVICE_TOKEN', 'Token de dispositivo invalido.');
    }

    $isValid = function_exists('telemetry_verify_token')
        ? telemetry_verify_token($provided, $deviceId)
        : hash_equals(trim(env_value('DEVICE_TOKEN_SECRET', env_value('SMWU_DEVICE_TOKEN', env_value('SMWA_DEVICE_TOKEN', ''))) ?? ''), $provided);

    if (!$isValid) {
        throw new HttpException(401, 'INVALID_DEVICE_TOKEN', 'Token de dispositivo invalido.');
    }

    return $provided;
}

function api_id(): ?int
{
    if (!isset($_GET['id']) || $_GET['id'] === '') {
        return null;
    }

    if (!is_string($_GET['id']) || !preg_match('/^[1-9][0-9]*$/', $_GET['id'])) {
        throw new HttpException(422, 'INVALID_ID', 'id deve ser um inteiro positivo.');
    }

    $id = filter_var($_GET['id'], FILTER_VALIDATE_INT);
    if ($id === false || $id <= 0) {
        throw new HttpException(422, 'INVALID_ID', 'id deve ser um inteiro positivo.');
    }

    return (int) $id;
}

function api_integer_query(string $name, int $default, int $minimum, int $maximum): int
{
    if (!isset($_GET[$name]) || $_GET[$name] === '') {
        return $default;
    }

    $value = filter_var($_GET[$name], FILTER_VALIDATE_INT);
    if ($value === false || $value < $minimum || $value > $maximum) {
        throw new HttpException(
            422,
            'INVALID_QUERY',
            sprintf('%s deve ser um inteiro entre %d e %d.', $name, $minimum, $maximum)
        );
    }

    return (int) $value;
}

function api_repository(): DeviceRepository
{
    static $repository = null;
    if ($repository instanceof DeviceRepository) {
        return $repository;
    }

    $timezoneName = env_value('APP_TIMEZONE', 'America/Sao_Paulo') ?: 'America/Sao_Paulo';
    $repository = new DeviceRepository(
        database_connection(),
        env_int('DEVICE_OFFLINE_AFTER_SECONDS', 90, 5, 86400),
        new DateTimeZone($timezoneName)
    );

    return $repository;
}

function api_check_rate_limit(string $key, int $limit = 30, int $window = 10): void
{
    $tempDir = sys_get_temp_dir();
    $file = $tempDir . DIRECTORY_SEPARATOR . 'r3b_rate_' . md5($key) . '.json';
    $now = time();
    $data = ['count' => 0, 'reset_at' => $now + $window];

    if (is_file($file)) {
        $content = @file_get_contents($file);
        if ($content !== false) {
            $parsed = json_decode($content, true);
            if (is_array($parsed) && isset($parsed['reset_at']) && $parsed['reset_at'] > $now) {
                $data = $parsed;
            }
        }
    }

    $data['count']++;
    @file_put_contents($file, json_encode($data), LOCK_EX);

    if ($data['count'] > $limit) {
        header('Retry-After: ' . max(1, $data['reset_at'] - $now));
        throw new HttpException(429, 'RATE_LIMIT_EXCEEDED', 'Muitas requisicoes. Aguarde antes de enviar novamente.');
    }
}
