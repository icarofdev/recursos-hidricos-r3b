#!/usr/bin/env bash
# ==============================================================================
# Script de Deploy e Sincronização com VPS — Recursos Hídricos R3B
# Sincroniza o projeto para o servidor remoto sem hardcode de credenciais.
# Suporta Rollback e Dry-Run.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/vps.env"

# Leitura segura do arquivo de configuração (evita eval/source de código arbitrário)
load_env_safe() {
    local file="$1"
    if [[ -f "${file}" ]]; then
        while IFS='=' read -r key val || [[ -n "${key}" ]]; do
            key=$(echo "${key}" | tr -d ' \t\r\n')
            [[ -z "${key}" || "${key}" =~ ^# ]] && continue
            val=$(echo "${val}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^["'\''\(.*\)["'\'']$/\1/' | tr -d '\r')
            if [[ "${key}" =~ ^[A-Z0-9_]+$ ]]; then
                if [[ -z "${!key:-}" ]]; then
                    export "${key}=${val}"
                fi
            fi
        done < "${file}"
    fi
}

load_env_safe "${CONFIG_FILE}"

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
ENABLE_DELETE=false
DRY_RUN=false
ROLLBACK=false

usage() {
    cat <<EOF
Uso: $0 [opções]

Opções (sobrescrevem deploy/vps.env):
  -h <host>        Host ou IP da VPS (obrigatório se não definido em deploy/vps.env)
  -u <user>        Usuário SSH (padrão: ${VPS_USER})
  -p <port>        Porta SSH (padrão: ${VPS_PORT})
  -k <key_file>    Caminho para chave privada SSH
  -d <remote_dir>  Diretório remoto (padrão: ${VPS_REMOTE_DIR})
  --dry-run        Simula o deploy sem transferir nem alterar arquivos remotos
  --rollback       Restaura a versão anterior salva em ${VPS_REMOTE_DIR}.bak na VPS
  --delete         Ativa remoção de arquivos no destino que não existem localmente
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
        --dry-run) DRY_RUN=true; shift 1 ;;
        --rollback) ROLLBACK=true; shift 1 ;;
        --delete) ENABLE_DELETE=true; shift 1 ;;
        --help) usage ;;
        *) echo "Opção desconhecida: $1" >&2; usage ;;
    esac
done

# Verificação de dependências essenciais
for cmd in ssh scp tar; do
    if ! command -v "${cmd}" >/dev/null 2>&1; then
        echo "ERRO: Ferramenta essencial '${cmd}' não encontrada no ambiente." >&2
        exit 1
    fi
done

if [[ -z "${VPS_HOST}" || "${VPS_HOST}" == "seu_ip_ou_hostname" ]]; then
    echo "ERRO: O host da VPS não foi configurado." >&2
    echo "Defina VPS_HOST no arquivo deploy/vps.env ou use o parâmetro: $0 -h <IP_DA_VPS>" >&2
    exit 1
fi

# Validação estrita contra caminhos perigosos ou acidentais
NORMALIZED_REMOTE="${VPS_REMOTE_DIR%/}"
case "${NORMALIZED_REMOTE}" in
    ""|"/"|"/root"|"/var"|"/var/www"|"/usr"|"/etc"|"/bin"|"/home")
        echo "ERRO: Diretório remoto '${VPS_REMOTE_DIR}' é inválido ou protegido pelo sistema." >&2
        exit 1
        ;;
esac

SSH_OPTS=(-p "${VPS_PORT}" -o StrictHostKeyChecking=accept-new)
if [[ -n "${VPS_SSH_KEY}" ]]; then
    if [[ ! -f "${VPS_SSH_KEY}" ]]; then
        echo "ERRO: Arquivo de chave SSH não encontrado em '${VPS_SSH_KEY}'" >&2
        exit 1
    fi
    SSH_OPTS+=(-i "${VPS_SSH_KEY}")
fi

# MODO ROLLBACK: Restaura versão anterior
if [[ "${ROLLBACK}" == "true" ]]; then
    echo "===================================================================="
    echo " MODO ROLLBACK: Restaurando backup anterior na VPS"
    echo " Destino: ${VPS_USER}@${VPS_HOST}:${VPS_PORT} -> ${VPS_REMOTE_DIR}"
    echo "===================================================================="

    ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" bash -s <<ROLLBACK_CMD
        set -e
        if [ ! -d '${VPS_REMOTE_DIR}.bak' ]; then
            echo 'ERRO: Nenhum snapshot de rollback encontrado em ${VPS_REMOTE_DIR}.bak' >&2
            exit 1
        fi
        echo 'Restaurando arquivos de ${VPS_REMOTE_DIR}.bak para ${VPS_REMOTE_DIR}...'
        cp -a '${VPS_REMOTE_DIR}.bak/.' '${VPS_REMOTE_DIR}/'
        chown -R ${WEB_USER}:${WEB_GROUP} '${VPS_REMOTE_DIR}'
        echo 'Rollback concluído com sucesso.'
ROLLBACK_CMD
    echo "Rollback finalizado com sucesso."
    exit 0
fi

TAR_EXCLUDES=(
    --exclude=.git
    --exclude=.env
    --exclude='.env.*'
    --exclude=.runtime
    --exclude=logs
    --exclude='*.log'
    --exclude='*.db*'
    --exclude='deploy/vps.env*'
    --exclude='deploy/*.env'
    --exclude='*.tar'
    --exclude='*.tar.gz'
    --exclude=scratch
)

# MODO DRY-RUN: Simulação sem alterar nada
if [[ "${DRY_RUN}" == "true" ]]; then
    echo "===================================================================="
    echo " MODO DRY-RUN (SIMULAÇÃO): Nenhum arquivo remoto será modificado"
    echo " Destino: ${VPS_USER}@${VPS_HOST}:${VPS_PORT} -> ${VPS_REMOTE_DIR}"
    echo "===================================================================="

    echo ""
    echo "Arquivos protegidos que NÃO seriam enviados:"
    echo " - .env, .env.* (credenciais remotas preservadas)"
    echo " - .git/ (histórico Git não trafegado)"
    echo " - logs/, *.log, *.db* (dados locais ignorados)"
    echo " - deploy/vps.env* (credenciais de conexão protegidas)"

    echo ""
    echo "Arquivos do projeto elegíveis para transferência:"
    tar "${TAR_EXCLUDES[@]}" -cf - -C "${APP_DIR}" . | tar -tf - | head -n 25
    echo "  ... (total filtrado com sucesso)"

    echo ""
    echo "Comandos que seriam executados remotamente na VPS:"
    echo " 1. Criar snapshot em ${VPS_REMOTE_DIR}.bak"
    echo " 2. Extrair pacote protegendo .env existente (--exclude='.env')"
    echo " 3. Ajustar permissões (pastas 755, arquivos 644, .env 600, scripts +x)"
    echo " 4. Testar sintaxe do Nginx (nginx -t) e recarregar PHP-FPM / Nginx"
    echo " 5. Testar healthcheck em http://127.0.0.1/health.php"
    echo ""
    echo "Simulação concluída com sucesso."
    exit 0
fi

echo "===================================================================="
echo " Início do Deploy: Recursos Hídricos R3B"
echo " Destino: ${VPS_USER}@${VPS_HOST}:${VPS_PORT} -> ${VPS_REMOTE_DIR}"
echo "===================================================================="

# 1. Garantir que o diretório remoto exista
echo "[1/5] Verificando diretório remoto..."
ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" "mkdir -p '${VPS_REMOTE_DIR}'"

# 2. Sincronizar arquivos (Rsync ou Tar/SCP)
echo "[2/5] Sincronizando arquivos..."
if command -v rsync >/dev/null 2>&1; then
    RSYNC_SSH="ssh -p ${VPS_PORT} -o StrictHostKeyChecking=accept-new"
    if [[ -n "${VPS_SSH_KEY}" ]]; then
        RSYNC_SSH="${RSYNC_SSH} -i ${VPS_SSH_KEY}"
    fi

    RSYNC_DELETE_FLAGS=()
    if [[ "${ENABLE_DELETE}" == "true" ]]; then
        RSYNC_DELETE_FLAGS=(--delete)
    fi

    # Snapshot prévio antes de rsync
    ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" bash -s <<PRE_RSYNC
        if [ -d '${VPS_REMOTE_DIR}/src' ]; then
            rm -rf '${VPS_REMOTE_DIR}.bak'
            cp -a '${VPS_REMOTE_DIR}' '${VPS_REMOTE_DIR}.bak'
        fi
PRE_RSYNC

    rsync -avz "${RSYNC_DELETE_FLAGS[@]}" \
        -e "${RSYNC_SSH}" \
        --filter="P .env" \
        --filter="P .env.*" \
        --filter="P /database/backups" \
        --filter="P /logs" \
        --exclude=".git" \
        --exclude=".env" \
        --exclude=".env.*" \
        --exclude=".runtime" \
        --exclude="*.log" \
        --exclude="logs" \
        --exclude="*.db*" \
        --exclude="deploy/vps.env*" \
        --exclude="deploy/*.env" \
        --exclude="*.tar.gz" \
        --exclude="scratch" \
        "${APP_DIR}/" \
        "${VPS_USER}@${VPS_HOST}:${VPS_REMOTE_DIR}/"
else
    RAND_ID=$(head -c 8 /dev/urandom 2>/dev/null | xxd -p 2>/dev/null || echo "$$")
    TEMP_ARCHIVE="${APP_DIR}/deploy-package-${RAND_ID}.tar.gz"
    REMOTE_ARCHIVE="/tmp/r3b-deploy-${RAND_ID}.tar.gz"

    trap 'rm -f "${TEMP_ARCHIVE}"' EXIT INT TERM

    echo "Rsync não disponível; utilizando pacote tar + scp..."
    tar "${TAR_EXCLUDES[@]}" -czf "${TEMP_ARCHIVE}" -C "${APP_DIR}" .

    SCP_OPTS=(-P "${VPS_PORT}" -o StrictHostKeyChecking=accept-new)
    if [[ -n "${VPS_SSH_KEY}" ]]; then
        SCP_OPTS+=(-i "${VPS_SSH_KEY}")
    fi

    scp "${SCP_OPTS[@]}" "${TEMP_ARCHIVE}" "${VPS_USER}@${VPS_HOST}:${REMOTE_ARCHIVE}"
    rm -f "${TEMP_ARCHIVE}"

    ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" bash -s <<REMOTE_UNTAR
        set -e
        # Snapshot de rollback antes de atualizar
        if [ -d '${VPS_REMOTE_DIR}/src' ]; then
            rm -rf '${VPS_REMOTE_DIR}.bak'
            cp -a '${VPS_REMOTE_DIR}' '${VPS_REMOTE_DIR}.bak'
        fi

        tar -xzf '${REMOTE_ARCHIVE}' -C '${VPS_REMOTE_DIR}' --exclude='.env' --exclude='.env.*'
        rm -f '${REMOTE_ARCHIVE}'
REMOTE_UNTAR
fi

# 3. Ajustar permissões com menor privilégio na VPS
echo "[3/5] Ajustando permissões remotas..."
ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" bash -s <<REMOTE_POST
    set -e
    chown -R ${WEB_USER}:${WEB_GROUP} "${VPS_REMOTE_DIR}"
    find "${VPS_REMOTE_DIR}" -type d -exec chmod 755 {} +
    find "${VPS_REMOTE_DIR}" -type f -exec chmod 644 {} +
    if [ -f "${VPS_REMOTE_DIR}/.env" ]; then
        chmod 600 "${VPS_REMOTE_DIR}/.env"
    fi
    chmod +x "${VPS_REMOTE_DIR}"/scripts/*.sh 2>/dev/null || true
REMOTE_POST

# 4. Recarregar serviços com teste de sintaxe
echo "[4/5] Recarregando serviços na VPS..."
ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" bash -s <<RELOAD_SERVICES
    set -e
    ACTIVE_PHP=\$(systemctl list-units --type=service --state=running | grep -oE 'php[0-9.]*-fpm' | head -n1 || echo "${REMOTE_PHP_FPM_SERVICE}")
    if [ -n "\${ACTIVE_PHP}" ]; then
        systemctl reload "\${ACTIVE_PHP}" 2>/dev/null || systemctl restart "\${ACTIVE_PHP}" 2>/dev/null || true
    fi

    if command -v nginx >/dev/null 2>&1; then
        if nginx -t >/dev/null 2>&1; then
            systemctl reload nginx 2>/dev/null || true
        else
            echo "AVISO: Falha na sintaxe do Nginx (nginx -t); reload ignorado." >&2
        fi
    fi
RELOAD_SERVICES

# 5. Validar integridade via Healthcheck
echo "[5/5] Validando integridade via Healthcheck..."
HEALTH_CHECK=$(ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/health.php 2>/dev/null || true")

if [[ "${HEALTH_CHECK}" == "200" ]]; then
    echo "SUCESSO: Deploy concluído e Healthcheck retornou HTTP 200 (OK)."
elif [[ "${HEALTH_CHECK}" == "503" ]]; then
    echo "AVISO: Código copiado, mas Healthcheck retornou 503 (banco de dados pode não estar configurado ou iniciado)."
else
    echo "INFO: Deploy finalizado. (Código HTTP local retornado pelo healthcheck: ${HEALTH_CHECK:-indisponível})"
fi

echo "Deploy finalizado com sucesso em $(date '+%Y-%m-%d %H:%M:%S')."
