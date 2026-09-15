<?php

declare(strict_types=1);

require dirname(__DIR__) . '/config/bootstrap.php';
require dirname(__DIR__) . '/config/database.php';

$migrator = new R3B\Database\SchemaMigrator(database_connection());
$migrator->migrate();

fwrite(STDOUT, sprintf("Migrações aplicadas. Versão do schema: %d.%s", $migrator::VERSION, PHP_EOL));
