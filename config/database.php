<?php

declare(strict_types=1);

function database_connection(bool $reset = false): PDO
{
    static $connection = null;

    if ($reset) {
        $connection = null;
    }

    if ($connection instanceof PDO) {
        return $connection;
    }

    $driver = strtolower(trim(env_value('DB_CONNECTION', 'mysql') ?: 'mysql'));
    $options = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_STRINGIFY_FETCHES => false,
    ];

    if ($driver === 'mysql') {
        $host = trim(env_value('DB_HOST', '127.0.0.1') ?: '127.0.0.1');
        $port = env_int('DB_PORT', 3306, 1, 65535);
        $database = trim(env_value('DB_DATABASE', 'recursos_hidricos') ?: 'recursos_hidricos');
        $charset = trim(env_value('DB_CHARSET', 'utf8mb4') ?: 'utf8mb4');

        if (!preg_match('/^[a-zA-Z0-9_]+$/', $database)) {
            throw new RuntimeException('DB_DATABASE contem caracteres invalidos.');
        }
        if (!preg_match('/^[a-zA-Z0-9_]+$/', $charset)) {
            throw new RuntimeException('DB_CHARSET contem caracteres invalidos.');
        }

        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=%s',
            $host,
            $port,
            $database,
            $charset
        );
        $options[PDO::ATTR_EMULATE_PREPARES] = false;
        $connection = new PDO(
            $dsn,
            env_value('DB_USERNAME', '') ?? '',
            env_value('DB_PASSWORD', '') ?? '',
            $options
        );
        $connection->exec("SET time_zone = '+00:00'");

        return $connection;
    }

    if ($driver === 'sqlite') {
        $path = env_value('DB_SQLITE_PATH');
        if ($path === null || $path === '') {
            throw new RuntimeException('DB_SQLITE_PATH e obrigatorio quando DB_CONNECTION=sqlite.');
        }

        $resolvedPath = preg_match('/^(?:[a-zA-Z]:[\\\\\/]|\/)/', $path)
            ? $path
            : APP_ROOT . DIRECTORY_SEPARATOR . $path;
        $connection = new PDO('sqlite:' . $resolvedPath, null, null, $options);
        $connection->exec('PRAGMA foreign_keys = ON');

        return $connection;
    }

    throw new RuntimeException('DB_CONNECTION deve ser mysql ou sqlite.');
}
