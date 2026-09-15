<?php

declare(strict_types=1);

namespace R3B\Database;

use PDO;
use PDOException;
use Throwable;

/**
 * Migração incremental e idempotente para instalações existentes.
 * Nenhuma tabela ou coluna é removida e leituras antigas são preservadas.
 */
final class SchemaMigrator
{
    public const VERSION = 1;

    public function __construct(private readonly PDO $database)
    {
    }

    public function migrate(): void
    {
        $driver = (string) $this->database->getAttribute(PDO::ATTR_DRIVER_NAME);
        if (!in_array($driver, ['mysql', 'sqlite'], true)) {
            throw new \RuntimeException('Driver de banco não suportado pela migração.');
        }

        $this->createMigrationTable($driver);
        if ($this->isApplied(self::VERSION)) {
            return;
        }

        // SQLite permite DDL transacional; MySQL/MariaDB faz commit implícito em
        // ALTER/CREATE, portanto a idempotência é garantida por introspecção.
        if ($driver === 'sqlite') {
            $this->database->beginTransaction();
        }
        try {
            $driver === 'sqlite' ? $this->migrateSqlite() : $this->migrateMysql();
            $statement = $this->database->prepare(
                'INSERT INTO schema_migrations (version, applied_at) VALUES (:version, :applied_at)'
            );
            $statement->execute([
                'version' => self::VERSION,
                'applied_at' => gmdate('Y-m-d H:i:s'),
            ]);
            if ($this->database->inTransaction()) {
                $this->database->commit();
            }
        } catch (Throwable $exception) {
            if ($this->database->inTransaction()) {
                $this->database->rollBack();
            }
            throw $exception;
        }
    }

    private function createMigrationTable(string $driver): void
    {
        $sql = $driver === 'sqlite'
            ? 'CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
              )'
            : 'CREATE TABLE IF NOT EXISTS schema_migrations (
                version INT UNSIGNED NOT NULL PRIMARY KEY,
                applied_at DATETIME NOT NULL
              ) ENGINE=InnoDB';
        $this->database->exec($sql);
    }

    private function isApplied(int $version): bool
    {
        $statement = $this->database->prepare('SELECT 1 FROM schema_migrations WHERE version = :version');
        $statement->execute(['version' => $version]);
        return $statement->fetchColumn() !== false;
    }

    private function migrateSqlite(): void
    {
        $this->database->exec(
            "CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                session_version INTEGER NOT NULL DEFAULT 1,
                last_login_at TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"
        );
        $this->database->exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users (email)');

        $this->ensureSqliteColumn('devices', 'device_code', 'TEXT NULL');
        $this->ensureSqliteColumn('devices', 'owner_user_id', 'INTEGER NULL REFERENCES users(id) ON DELETE SET NULL');
        $this->ensureSqliteColumn('devices', 'pairing_code_hash', 'TEXT NULL');
        $this->ensureSqliteColumn('devices', 'pairing_expires_at', 'TEXT NULL');
        $this->ensureSqliteColumn('devices', 'paired_at', 'TEXT NULL');
        $this->database->exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_device_code ON devices (device_code)');
        $this->database->exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_pairing_hash ON devices (pairing_code_hash)');
        $this->database->exec('CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices (owner_user_id)');

        $this->database->exec(
            "CREATE TABLE IF NOT EXISTS reservoirs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                device_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                capacity_liters REAL NULL CHECK (capacity_liters IS NULL OR capacity_liters > 0),
                linked_at TEXT NOT NULL,
                unlinked_at TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT
            )"
        );
        $this->database->exec('CREATE INDEX IF NOT EXISTS idx_reservoirs_user_active ON reservoirs (user_id, unlinked_at, id)');
        $this->database->exec('CREATE INDEX IF NOT EXISTS idx_reservoirs_device_active ON reservoirs (device_id, unlinked_at, id)');

        $this->ensureSqliteColumn('smwu_readings', 'reservoir_id', 'INTEGER NULL REFERENCES reservoirs(id) ON DELETE SET NULL');
        $this->database->exec('CREATE INDEX IF NOT EXISTS idx_smwu_reservoir_created ON smwu_readings (reservoir_id, created_at, reading_id)');
        if ($this->sqliteTableExists('sensor_readings')) {
            $this->ensureSqliteColumn('sensor_readings', 'reservoir_id', 'INTEGER NULL REFERENCES reservoirs(id) ON DELETE SET NULL');
            $this->database->exec('CREATE INDEX IF NOT EXISTS idx_sensor_reservoir_created ON sensor_readings (reservoir_id, created_at, reading_id)');
        }

        $this->createSqliteSecurityTables();
    }

    private function createSqliteSecurityTables(): void
    {
        $this->database->exec(
            "CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                used_at TEXT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )"
        );
        $this->database->exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_password_reset_hash ON password_reset_tokens (token_hash)');
        $this->database->exec('CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens (user_id, expires_at)');
        $this->database->exec(
            "CREATE TABLE IF NOT EXISTS rate_limits (
                key_hash TEXT PRIMARY KEY,
                attempts INTEGER NOT NULL,
                window_started_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )"
        );
        $this->database->exec('CREATE INDEX IF NOT EXISTS idx_rate_limits_updated ON rate_limits (updated_at)');
    }

    private function migrateMysql(): void
    {
        $this->database->exec(
            "CREATE TABLE IF NOT EXISTS users (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                name VARCHAR(120) NOT NULL,
                email VARCHAR(254) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                session_version INT UNSIGNED NOT NULL DEFAULT 1,
                last_login_at DATETIME(6) NULL,
                created_at DATETIME(6) NOT NULL,
                updated_at DATETIME(6) NOT NULL,
                PRIMARY KEY (id),
                UNIQUE KEY uq_users_email (email)
            ) ENGINE=InnoDB"
        );

        $this->ensureMysqlColumn('devices', 'device_code', 'VARCHAR(64) NULL');
        $this->ensureMysqlColumn('devices', 'owner_user_id', 'BIGINT UNSIGNED NULL');
        $this->ensureMysqlColumn('devices', 'pairing_code_hash', 'CHAR(64) NULL');
        $this->ensureMysqlColumn('devices', 'pairing_expires_at', 'DATETIME(6) NULL');
        $this->ensureMysqlColumn('devices', 'paired_at', 'DATETIME(6) NULL');
        $this->ensureMysqlIndex('devices', 'uq_devices_device_code', 'UNIQUE', 'device_code');
        $this->ensureMysqlIndex('devices', 'uq_devices_pairing_hash', 'UNIQUE', 'pairing_code_hash');
        $this->ensureMysqlIndex('devices', 'idx_devices_owner', '', 'owner_user_id');

        $this->database->exec(
            "CREATE TABLE IF NOT EXISTS reservoirs (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                user_id BIGINT UNSIGNED NOT NULL,
                device_id BIGINT UNSIGNED NOT NULL,
                name VARCHAR(60) NOT NULL,
                capacity_liters DECIMAL(18,4) NULL,
                linked_at DATETIME(6) NOT NULL,
                unlinked_at DATETIME(6) NULL,
                created_at DATETIME(6) NOT NULL,
                updated_at DATETIME(6) NOT NULL,
                PRIMARY KEY (id),
                KEY idx_reservoirs_user_active (user_id, unlinked_at, id),
                KEY idx_reservoirs_device_active (device_id, unlinked_at, id),
                CONSTRAINT fk_reservoirs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                CONSTRAINT fk_reservoirs_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT,
                CONSTRAINT chk_reservoir_capacity CHECK (capacity_liters IS NULL OR capacity_liters > 0)
            ) ENGINE=InnoDB"
        );

        $this->ensureMysqlColumn('smwu_readings', 'reservoir_id', 'BIGINT UNSIGNED NULL');
        $this->ensureMysqlIndex('smwu_readings', 'idx_smwu_reservoir_created', '', 'reservoir_id, created_at, reading_id');
        if ($this->mysqlTableExists('sensor_readings')) {
            $this->ensureMysqlColumn('sensor_readings', 'reservoir_id', 'BIGINT UNSIGNED NULL');
            $this->ensureMysqlIndex('sensor_readings', 'idx_sensor_reservoir_created', '', 'reservoir_id, created_at, reading_id');
        }

        $this->database->exec(
            "CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                user_id BIGINT UNSIGNED NOT NULL,
                token_hash CHAR(64) NOT NULL,
                expires_at DATETIME(6) NOT NULL,
                used_at DATETIME(6) NULL,
                created_at DATETIME(6) NOT NULL,
                PRIMARY KEY (id),
                UNIQUE KEY uq_password_reset_hash (token_hash),
                KEY idx_password_reset_user (user_id, expires_at),
                CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB"
        );
        $this->database->exec(
            "CREATE TABLE IF NOT EXISTS rate_limits (
                key_hash CHAR(64) NOT NULL,
                attempts INT UNSIGNED NOT NULL,
                window_started_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                PRIMARY KEY (key_hash),
                KEY idx_rate_limits_updated (updated_at)
            ) ENGINE=InnoDB"
        );

        $this->tryMysqlForeignKey('devices', 'fk_devices_owner', 'owner_user_id', 'users', 'id', 'SET NULL');
        $this->tryMysqlForeignKey('smwu_readings', 'fk_smwu_reservoir', 'reservoir_id', 'reservoirs', 'id', 'SET NULL');
        if ($this->mysqlTableExists('sensor_readings')) {
            $this->tryMysqlForeignKey('sensor_readings', 'fk_sensor_reservoir', 'reservoir_id', 'reservoirs', 'id', 'SET NULL');
        }
    }

    private function ensureSqliteColumn(string $table, string $column, string $definition): void
    {
        $statement = $this->database->query(sprintf('PRAGMA table_info(%s)', $table));
        foreach ($statement->fetchAll() as $row) {
            if (($row['name'] ?? null) === $column) {
                return;
            }
        }
        $this->database->exec(sprintf('ALTER TABLE %s ADD COLUMN %s %s', $table, $column, $definition));
    }

    private function sqliteTableExists(string $table): bool
    {
        $statement = $this->database->prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = :table"
        );
        $statement->execute(['table' => $table]);
        return $statement->fetchColumn() !== false;
    }

    private function mysqlTableExists(string $table): bool
    {
        $statement = $this->database->prepare(
            'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = :table'
        );
        $statement->execute(['table' => $table]);
        return $statement->fetchColumn() !== false;
    }

    private function ensureMysqlColumn(string $table, string $column, string $definition): void
    {
        $statement = $this->database->prepare(
            'SELECT 1 FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = :table AND column_name = :column'
        );
        $statement->execute(['table' => $table, 'column' => $column]);
        if ($statement->fetchColumn() === false) {
            $this->database->exec(sprintf('ALTER TABLE %s ADD COLUMN %s %s', $table, $column, $definition));
        }
    }

    private function ensureMysqlIndex(string $table, string $name, string $kind, string $columns): void
    {
        $statement = $this->database->prepare(
            'SELECT 1 FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = :table AND index_name = :name'
        );
        $statement->execute(['table' => $table, 'name' => $name]);
        if ($statement->fetchColumn() === false) {
            $this->database->exec(sprintf(
                'CREATE %s INDEX %s ON %s (%s)',
                $kind,
                $name,
                $table,
                $columns
            ));
        }
    }

    private function tryMysqlForeignKey(
        string $table,
        string $name,
        string $column,
        string $referencedTable,
        string $referencedColumn,
        string $onDelete
    ): void {
        $statement = $this->database->prepare(
            'SELECT 1 FROM information_schema.table_constraints
             WHERE constraint_schema = DATABASE() AND table_name = :table AND constraint_name = :name'
        );
        $statement->execute(['table' => $table, 'name' => $name]);
        if ($statement->fetchColumn() !== false) {
            return;
        }
        try {
            $this->database->exec(sprintf(
                'ALTER TABLE %s ADD CONSTRAINT %s FOREIGN KEY (%s) REFERENCES %s (%s) ON DELETE %s',
                $table,
                $name,
                $column,
                $referencedTable,
                $referencedColumn,
                $onDelete
            ));
        } catch (PDOException $exception) {
            // Instalações legadas podem conter linhas órfãs. A coluna e os filtros
            // de autorização continuam ativos; o administrador pode limpar os
            // órfãos e executar novamente uma migração futura para aplicar a FK.
            error_log(sprintf('[Migration] Não foi possível criar %s: %s', $name, $exception->getCode()));
        }
    }
}
