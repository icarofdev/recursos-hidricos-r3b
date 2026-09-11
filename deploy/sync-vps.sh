#!/usr/bin/env bash
# ==============================================================================
# Script de Deploy e Sincronização com VPS — Recursos Hídricos R3B
# Sincroniza o projeto para o servidor remoto sem hardcode de credenciais.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/vps.env"

# Carregar arquivo de configuração local se existir
if [[ -f "${CONFIG_FILE}" ]]; then
    # shellcheck disable=SC1090
    source "${CONFIG_FILE}"
fi

# Variáveis com fallback para variáveis de ambiente ou padrões
VPS_HOST="${VPS_HOST:-}"
VPS_USER="${VPS_USER:-root}"
VPS_PORT="${VPS_PORT:-22}"
VPS_SSH_KEY="${VPS_SSH_KEY:-}"
VPS_REMOTE_DIR="${VPS_REMOTE_DIR:-/var/www/recursos-hidricos-r3b}"
WEB_USER="${WEB_USER:-www-data}"
WEB_GROUP="${WEB_GROUP:-www-data}"
REMOTE_RELOAD_SERVICES="${REMOTE_RELOAD_SERVICES:-true}"
REMOTE_PHP_FPM_SERVICE="${REMOTE_PHP_FPM_SERVICE:-php8.2-fpm}"

usage() {
    cat <<EOF
Uso: $0 [opções]

Opções (sobrescrevem deploy/vps.env):
  -h <host>        Host ou IP da VPS (obrigatório se não definido em deploy/vps.env)
  -u <user>        Usuário SSH (padrão: ${VPS_USER})
  -p <port>        Porta SSH (padrão: ${VPS_PORT})
  -k <key_file>    Caminho para chave privada SSH
  -d <remote_dir>  Diretório remoto (padrão: ${VPS_REMOTE_DIR})
  --help           Exibe esta ajuda

EOF
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h) VPS_HOST="$2"; shift 2 ;;
        -u) VPS_USER="$2"; shift 2 ;;
        -p) VPS_PORT="$2"; shift 2 ;;
        -k) VPS_SSH_KEY="$2"; shift 2 ;;
        -d) VPS_REMOTE_DIR="$2"; shift 2 ;;
        --help) usage ;;
        *) echo "Opção desconhecida: $1" >&2; usage ;;
    esac
done

if [[ -z "${VPS_HOST}" || "${VPS_HOST}" == "seu_ip_ou_hostname" ]]; then
    echo "ERRO: O host da VPS não foi configurado." >&2
    echo "Defina VPS_HOST no arquivo deploy/vps.env ou use o parâmetro: $0 -h <IP_DA_VPS>" >&2
    exit 1
fi

SSH_OPTS=(-p "${VPS_PORT}" -o StrictHostKeyChecking=accept-new)
if [[ -n "${VPS_SSH_KEY}" ]]; then
    SSH_OPTS+=(-i "${VPS_SSH_KEY}")
fi

echo "===================================================================="
echo " Início do Deploy: Recursos Hídricos R3B"
echo " Destino: ${VPS_USER}@${VPS_HOST}:${VPS_PORT} -> ${VPS_REMOTE_DIR}"
echo "===================================================================="

# 1. Garantir que o diretório remoto exista
echo "[1/4] Verificando diretório remoto..."
ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" "mkdir -p '${VPS_REMOTE_DIR}'"

# 2. Sincronizar arquivos (Rsync ou Tar/SCP)
echo "[2/4] Sincronizando arquivos..."
if command -v rsync >/dev/null 2>&1; then
    RSYNC_SSH="ssh -p ${VPS_PORT}"
    if [[ -n "${VPS_SSH_KEY}" ]]; then
        RSYNC_SSH="${RSYNC_SSH} -i ${VPS_SSH_KEY}"
    fi

    rsync -avz --delete \
        -e "${RSYNC_SSH}" \
        --filter="P .env" \
        --filter="P /database/backups" \
        --exclude=".git" \
        --exclude=".env" \
        --exclude=".runtime" \
        --exclude="*.log" \
        --exclude="*.db*" \
        --exclude="deploy/vps.env" \
        --exclude="deploy/*.env" \
        --exclude="*.tar.gz" \
        --exclude="scratch" \
        "${APP_DIR}/" \
        "${VPS_USER}@${VPS_HOST}:${VPS_REMOTE_DIR}/"
else
    echo "Rsync não encontrado localmente. Utilizando empacotamento tar + scp..."
    TEMP_ARCHIVE="${APP_DIR}/deploy-package.tar.gz"
    
    tar --exclude='.git' \
        --exclude='.env' \
        --exclude='.runtime' \
        --exclude='*.log' \
        --exclude='*.db*' \
        --exclude='deploy/vps.env' \
        --exclude='deploy/*.env' \
        --exclude='*.tar.gz' \
        --exclude='scratch' \
        -czf "${TEMP_ARCHIVE}" -C "${APP_DIR}" .

    SCP_OPTS=(-P "${VPS_PORT}")
    if [[ -n "${VPS_SSH_KEY}" ]]; then
        SCP_OPTS+=(-i "${VPS_SSH_KEY}")
    fi

    scp "${SCP_OPTS[@]}" "${TEMP_ARCHIVE}" "${VPS_USER}@${VPS_HOST}:/tmp/r3b-deploy.tar.gz"
    rm -f "${TEMP_ARCHIVE}"

    ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" bash -s <<REMOTE_UNTAR
        tar -xzf /tmp/r3b-deploy.tar.gz -C "${VPS_REMOTE_DIR}" --exclude='.env'
        rm -f /tmp/r3b-deploy.tar.gz
REMOTE_UNTAR
fi

# 3. Ajustar permissões e scripts na VPS
echo "[3/4] Ajustando permissões remotas..."
ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" bash -s <<REMOTE_POST
    set -e
    chown -R ${WEB_USER}:${WEB_GROUP} "${VPS_REMOTE_DIR}"
    chmod -R 755 "${VPS_REMOTE_DIR}"
    if [ -f "${VPS_REMOTE_DIR}/.env" ]; then
        chmod 600 "${VPS_REMOTE_DIR}/.env"
    fi
    chmod +x "${VPS_REMOTE_DIR}"/scripts/*.sh 2>/dev/null || true

    if [ "${REMOTE_RELOAD_SERVICES}" = "true" ]; then
        echo "Recarregando serviços (PHP-FPM e Nginx)..."
        systemctl reload ${REMOTE_PHP_FPM_SERVICE} 2>/dev/null || systemctl reload php-fpm 2>/dev/null || true
        systemctl reload nginx 2>/dev/null || true
    fi
REMOTE_POST

# 4. Validar integridade via Healthcheck
echo "[4/4] Validando aplicação..."
HEALTH_CHECK=$(ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/health.php 2>/dev/null || true")

if [[ "${HEALTH_CHECK}" == "200" ]]; then
    echo "SUCESSO: Deploy concluído e Healthcheck retornou HTTP 200 (OK)."
elif [[ "${HEALTH_CHECK}" == "503" ]]; then
    echo "AVISO: Código copiado, mas Healthcheck retornou 503 (Banco de dados pode não estar configurado ou iniciado)."
else
    echo "INFO: Deploy finalizado. (Código HTTP retornado pelo healthcheck local da VPS: ${HEALTH_CHECK:-indisponível})"
fi

echo "Deploy finalizado em $(date '+%Y-%m-%d %H:%M:%S')."
