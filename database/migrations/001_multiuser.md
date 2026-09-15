# Migração 001 — contas, pareamento e isolamento

Esta migração é executada por `php scripts/migrate.php` através de
`R3B\Database\SchemaMigrator`. O migrador detecta MySQL/MariaDB ou SQLite,
consulta colunas e índices existentes e aplica somente adições. Nenhuma leitura,
dispositivo ou tabela legada é removida.

Antes de publicar o código, execute:

```bash
php scripts/migrate.php
```

O registro em `schema_migrations` impede nova execução da mesma versão.
