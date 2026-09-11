#!/usr/bin/env bash
# ==============================================================================
# Rotina de backup do banco de dados MariaDB — Recursos Hídricos R3B
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${APP_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
    echo "ERRO: Arquivo .env não encontrado em ${ENV_FILE}" >&2
    exit 1
fi

# Carrega variáveis do .env ignorando comentários
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

BACKUP_DIR="${BACKUP_DIR:-/var/backups/recursos-hidricos}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
FILENAME="db_${DB_NAME}_${TIMESTAMP}.sql.gz"
TARGET="${BACKUP_DIR}/${FILENAME}"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Iniciando backup da base '${DB_NAME}'..."

export MYSQL_PWD="${DB_PASS}"

mysqldump \
    --host="${DB_HOST}" \
    --port="${DB_PORT}" \
    --user="${DB_USER}" \
    --single-transaction \
    --quick \
    --routines \
    --triggers \
    --default-character-set=utf8mb4 \
    "${DB_NAME}" | gzip -9 > "${TARGET}.tmp"

mv "${TARGET}.tmp" "${TARGET}"
chmod 600 "${TARGET}"

SIZE=$(du -h "${TARGET}" | cut -f1)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup concluído: ${TARGET} (${SIZE})"

# Limpeza de backups antigos
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Limpando backups com mais de ${RETENTION_DAYS} dias..."
find "${BACKUP_DIR}" -name "db_${DB_NAME}_*.sql.gz" -type f -mtime +"${RETENTION_DAYS}" -delete

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Rotina finalizada com sucesso."
