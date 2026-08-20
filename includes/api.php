<?php

declare(strict_types=1);

use R3B\DeviceRepository;
use R3B\Http\HttpException;

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

function api_run(callable $callback): never
{
    try {
        $callback();
        throw new LogicException('O endpoint nao produziu uma resposta.');
    } catch (HttpException $exception) {
        api_error($exception->statusCode, $exception->errorCode, $exception->getMessage());
    } catch (PDOException $exception) {
        error_log(sprintf('[API] Database error: %s', $exception->getMessage()));
        api_error(503, 'DATABASE_UNAVAILABLE', 'Banco de dados temporariamente indisponivel.');
    } catch (Throwable $exception) {
        $errorId = bin2hex(random_bytes(6));
        error_log(sprintf('[API] Unexpected error %s: %s', $errorId, $exception));
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

