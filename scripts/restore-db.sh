#!/usr/bin/env bash
# ==============================================================================
# Restauração de backup MariaDB — Recursos Hídricos R3B
# Uso: ./scripts/restore-db.sh /caminho/para/arquivo.sql.gz
# ==============================================================================

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Uso: $0 <caminho-do-arquivo-backup.sql[.gz]>" >&2
    exit 1
fi

BACKUP_FILE="$1"
if [[ ! -f "${BACKUP_FILE}" ]]; then
    echo "ERRO: Arquivo ${BACKUP_FILE} não encontrado." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${APP_DIR}/.env"

get_env() {
    local key="$1"
    local default="${2:-}"
    local val
    val=$(grep -E "^[[:space:]]*${key}=" "${ENV_FILE}" | tail -n1 | cut -d'=' -f2- | tr -d '"' | sed "s/^[[:space:]]*//;s/[[:space:]]*$//")
    echo "${val:-$default}"
}

DB_HOST=$(get_env "DB_HOST" "127.0.0.1")
DB_PORT=$(get_env "DB_PORT" "3306")
DB_NAME=$(get_env "DB_NAME" "$(get_env "DB_DATABASE" "recursos_hidricos")")
DB_USER=$(get_env "DB_USER" "$(get_env "DB_USERNAME" "root")")
DB_PASS=$(get_env "DB_PASSWORD" "")

read -r -p "ATENÇÃO: Isso irá sobrescrever dados em '${DB_NAME}' com '${BACKUP_FILE}'. Continuar? [s/N] " confirm
if [[ ! "${confirm}" =~ ^[sSyY]$ ]]; then
    echo "Operação cancelada pelo usuário."
    exit 0
fi

echo "Restaurando '${BACKUP_FILE}' no banco '${DB_NAME}'..."
export MYSQL_PWD="${DB_PASS}"

if [[ "${BACKUP_FILE}" == *.gz ]]; then
    gzip -dc "${BACKUP_FILE}" | mysql --host="${DB_HOST}" --port="${DB_PORT}" --user="${DB_USER}" "${DB_NAME}"
else
    mysql --host="${DB_HOST}" --port="${DB_PORT}" --user="${DB_USER}" "${DB_NAME}" < "${BACKUP_FILE}"
fi

echo "Restauração concluída com sucesso."
