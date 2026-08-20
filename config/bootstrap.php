<?php

declare(strict_types=1);

use Dotenv\Dotenv;

if (!defined('APP_ROOT')) {
    define('APP_ROOT', dirname(__DIR__));
}

$autoload = APP_ROOT . DIRECTORY_SEPARATOR . 'vendor' . DIRECTORY_SEPARATOR . 'autoload.php';
if (!is_file($autoload)) {
    throw new RuntimeException('Dependencias ausentes. Execute "composer install" na raiz do projeto.');
}

require_once $autoload;

Dotenv::createImmutable(APP_ROOT)->safeLoad();

function env_value(string $key, ?string $default = null): ?string
{
    $value = $_ENV[$key] ?? $_SERVER[$key] ?? getenv($key);

    if ($value === false || $value === null) {
        return $default;
    }

    return (string) $value;
}

function env_bool(string $key, bool $default = false): bool
{
    $value = env_value($key);
    if ($value === null || $value === '') {
        return $default;
    }

    $parsed = filter_var(trim($value), FILTER_VALIDATE_BOOL, FILTER_NULL_ON_FAILURE);
    if ($parsed === null) {
        throw new RuntimeException(sprintf('A variavel %s deve ser booleana.', $key));
    }

    return $parsed;
}

function env_int(string $key, int $default, int $minimum, int $maximum): int
{
    $value = env_value($key, (string) $default);
    if ($value === null || filter_var(trim($value), FILTER_VALIDATE_INT) === false) {
        throw new RuntimeException(sprintf('A variavel %s deve ser um numero inteiro.', $key));
    }

    $integer = (int) trim($value);
    if ($integer < $minimum || $integer > $maximum) {
        throw new RuntimeException(sprintf(
            'A variavel %s deve estar entre %d e %d.',
            $key,
            $minimum,
            $maximum
        ));
    }

    return $integer;
}

$timezoneName = trim(env_value('APP_TIMEZONE', 'America/Sao_Paulo') ?: 'America/Sao_Paulo');
try {
    new DateTimeZone($timezoneName);
} catch (Throwable $exception) {
    throw new RuntimeException('APP_TIMEZONE possui um fuso horario invalido.', 0, $exception);
}

date_default_timezone_set($timezoneName);
ini_set('display_errors', '0');
ini_set('display_startup_errors', '0');
ini_set('log_errors', '1');
