<?php

declare(strict_types=1);

require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/database.php';

$retentionDays = env_int('TELEMETRY_RETENTION_DAYS', 90, 1, 3650);

echo sprintf("[%s] Iniciando limpeza de telemetria com mais de %d dias...\n", date('Y-m-d H:i:s'), $retentionDays);

try {
    $db = database_connection();
    $cutoff = (new DateTimeImmutable('now', new DateTimeZone('UTC')))
        ->sub(new DateInterval(sprintf('P%dD', $retentionDays)))
        ->format('Y-m-d H:i:s');

    $totalDeleted = 0;
    $batchSize = 5000;

    $statement = $db->prepare('DELETE FROM smwu_readings WHERE created_at < :cutoff LIMIT :limit');

    do {
        $statement->bindValue(':cutoff', $cutoff, PDO::PARAM_STR);
        $statement->bindValue(':limit', $batchSize, PDO::PARAM_INT);
        $statement->execute();
        $deleted = $statement->rowCount();
        $totalDeleted += $deleted;
        if ($deleted > 0) {
            echo sprintf("  - Removidos %d registros no lote (total acumulado: %d)...\n", $deleted, $totalDeleted);
            usleep(100000); // 100ms pause to yield DB locks
        }
    } while ($deleted >= $batchSize);

    echo sprintf("[%s] Limpeza concluída. Total de leituras antigas removidas: %d.\n", date('Y-m-d H:i:s'), $totalDeleted);
} catch (Throwable $exception) {
    fwrite(STDERR, sprintf("[%s] ERRO na limpeza de retenção: %s\n", date('Y-m-d H:i:s'), $exception->getMessage()));
    exit(1);
}
