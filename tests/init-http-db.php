<?php

declare(strict_types=1);

$path = $argv[1] ?? '';
if ($path === '' || !str_ends_with($path, '.sqlite')) {
    fwrite(STDERR, 'Caminho SQLite de teste inválido.' . PHP_EOL);
    exit(1);
}
$database = new PDO('sqlite:' . $path);
$database->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$schema = file_get_contents(dirname(__DIR__) . '/database/schema.sqlite.sql');
if ($schema === false) {
    throw new RuntimeException('Schema SQLite não encontrado.');
}
$database->exec($schema);
