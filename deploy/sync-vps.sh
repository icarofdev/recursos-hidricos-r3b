#!/usr/bin/env bash
# ==============================================================================
# Script de Deploy e Sincronização com VPS — Recursos Hídricos R3B
# Sincroniza o projeto para o servidor remoto sem hardcode de credenciais.
# Usuário padrão: deploy (não-root). Suporta Snapshots Timestamped, Rollback e Dry-Run.
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
VPS_USER="${VPS_USER:-deploy}"
VPS_PORT="${VPS_PORT:-22}"
VPS_SSH_KEY="${VPS_SSH_KEY:-}"
VPS_REMOTE_DIR="${VPS_REMOTE_DIR:-/var/www/recursos-hidricos-r3b}"
VPS_SNAPSHOT_DIR="${VPS_SNAPSHOT_DIR:-/var/www/recursos-hidricos-snapshots}"
VPS_KEEP_SNAPSHOTS="${VPS_KEEP_SNAPSHOTS:-3}"
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
  -k <key_file>    Caminho para chave privada SSH (recomendado)
  -d <remote_dir>  Diretório remoto (padrão: ${VPS_REMOTE_DIR})
  --dry-run        Simula o deploy sem transferir nem alterar arquivos remotos
  --rollback       Restaura o snapshot anterior de código sem alterar o banco
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

# Verificação de dependências essenciais locais
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
    SSH_OPTS+=(-i "${VPS_SSH_KEY}" -o BatchMode=yes)
fi

# MODO ROLLBACK: Restaura o snapshot mais recente de código sem tocar no banco
if [[ "${ROLLBACK}" == "true" ]]; then
    echo "===================================================================="
    echo " MODO ROLLBACK: Restaurando snapshot anterior de código na VPS"
    echo " Destino: ${VPS_USER}@${VPS_HOST}:${VPS_PORT} -> ${VPS_REMOTE_DIR}"
    echo "===================================================================="

    ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" bash -s <<ROLLBACK_CMD
        set -euo pipefail
        SUDO_CMD=""
        if [ "\$(id -u)" -ne 0 ]; then SUDO_CMD="sudo"; fi

        if [ ! -d '${VPS_SNAPSHOT_DIR}' ]; then
            echo 'ERRO: Diretório de snapshots não existe em ${VPS_SNAPSHOT_DIR}' >&2
            exit 1
        fi

        LATEST_SNAPSHOT=\$(ls -1dt '${VPS_SNAPSHOT_DIR}'/snapshot_* 2>/dev/null | head -n1 || echo "")
        if [ -z "\${LATEST_SNAPSHOT}" ] || [ ! -d "\${LATEST_SNAPSHOT}" ]; then
            echo 'ERRO: Nenhum snapshot timestamped encontrado em ${VPS_SNAPSHOT_DIR}' >&2
            exit 1
        fi

        echo "Restaurando código a partir do snapshot: \${LATEST_SNAPSHOT}..."
        # Copia mantendo arquivos de produção que não façam parte do snapshot (.env, backups)
        cp -a "\${LATEST_SNAPSHOT}/." '${VPS_REMOTE_DIR}/'

        \${SUDO_CMD} chown -R ${WEB_USER}:${WEB_GROUP} '${VPS_REMOTE_DIR}'
        find '${VPS_REMOTE_DIR}' -type d -exec chmod 755 {} +
        find '${VPS_REMOTE_DIR}' -type f -exec chmod 644 {} +
        if [ -f '${VPS_REMOTE_DIR}/.env' ]; then
            chmod 600 '${VPS_REMOTE_DIR}/.env'
        fi
        chmod +x '${VPS_REMOTE_DIR}'/scripts/*.sh 2>/dev/null || true

        # Teste de sintaxe e reload
        \${SUDO_CMD} nginx -t
        ACTIVE_PHP=\$(systemctl list-units --type=service --state=running 2>/dev/null | grep -oE 'php[0-9.]*-fpm' | head -n1 || echo "${REMOTE_PHP_FPM_SERVICE}")
        if [ -n "\${ACTIVE_PHP}" ]; then
            \${SUDO_CMD} systemctl reload "\${ACTIVE_PHP}" || \${SUDO_CMD} systemctl restart "\${ACTIVE_PHP}"
        fi
        \${SUDO_CMD} systemctl reload nginx

        echo "[ROLLBACK CONCLUÍDO] Versão restaurada para \${LATEST_SNAPSHOT}."
        echo "INFO: O banco de dados NÃO foi alterado (dados de telemetria preservados)."
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

# Metadados de versão / commit local
CURRENT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "sem-git")
COMMIT_MSG=$(git log -1 --pretty=%B 2>/dev/null | head -n 1 | tr -d '"' || echo "Deploy manual")
DEPLOY_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# MODO DRY-RUN: Simulação sem alterar nada
if [[ "${DRY_RUN}" == "true" ]]; then
    echo "===================================================================="
    echo " MODO DRY-RUN (SIMULAÇÃO): Nenhum arquivo remoto será modificado"
    echo " Destino: ${VPS_USER}@${VPS_HOST}:${VPS_PORT} -> ${VPS_REMOTE_DIR}"
    echo " Versão a enviar: Commit ${CURRENT_COMMIT} (${COMMIT_MSG})"
    echo "===================================================================="

    echo ""
    echo "Arquivos protegidos que NUNCA são transferidos:"
    echo " - .env, .env.* (credenciais de produção locais e remotas)"
    echo " - .git/ (histórico Git do repositório)"
    echo " - logs/, *.log, *.db* (arquivos temporários e logs locais)"
    echo " - deploy/vps.env* (credenciais de conexão SSH)"

    echo ""
    echo "Validações que serão executadas na VPS:"
    echo " 1. Checagem de espaço em disco (mínimo 150MB livres)"
    echo " 2. Criação de snapshot timestamped em ${VPS_SNAPSHOT_DIR}/snapshot_YYYYMMDD_HHMMSS"
    echo " 3. Rotação mantendo os últimos ${VPS_KEEP_SNAPSHOTS} snapshots"
    echo " 4. Extração protegendo .env existente (--exclude='.env')"
    echo " 5. Permissões de menor privilégio (pastas 755, arquivos 644, .env 600, scripts +x)"
    echo " 6. Teste de sintaxe Nginx (nginx -t) com FAIL-FAST"
    echo " 7. Reload dos serviços com sudo mínimo"
    echo " 8. Healthcheck local em http://127.0.0.1/health.php"
    echo ""
    echo "Simulação concluída com sucesso."
    exit 0
fi

echo "===================================================================="
echo " Início do Deploy: Recursos Hídricos R3B"
echo " Destino: ${VPS_USER}@${VPS_HOST}:${VPS_PORT} -> ${VPS_REMOTE_DIR}"
echo " Versão: Commit ${CURRENT_COMMIT} em ${DEPLOY_TIMESTAMP}"
echo "===================================================================="

# 1. Validar espaço em disco e preparar estrutura remota
echo "[1/6] Verificando espaço em disco e diretórios na VPS..."
ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" bash -s <<PRE_CHECK
    set -euo pipefail
    SUDO_CMD=""
    if [ "\$(id -u)" -ne 0 ]; then SUDO_CMD="sudo"; fi

    \${SUDO_CMD} mkdir -p '${VPS_REMOTE_DIR}' '${VPS_SNAPSHOT_DIR}'
    \${SUDO_CMD} chown -R ${VPS_USER}:${WEB_GROUP} '${VPS_REMOTE_DIR}' '${VPS_SNAPSHOT_DIR}'

    # Checagem de espaço em disco na partição de destino (mínimo 150MB)
    AVAILABLE_MB=\$(df -m '${VPS_REMOTE_DIR%/*}' | awk 'NR==2 {print \$4}')
    if [ "\${AVAILABLE_MB}" -lt 150 ]; then
        echo "ERRO: Espaço insuficiente na VPS (\${AVAILABLE_MB}MB livres). Mínimo exigido: 150MB." >&2
        exit 1
    fi
    echo "Espaço em disco validado: \${AVAILABLE_MB}MB livres."
PRE_CHECK

# 2. Gerar snapshot timestamped da versão anterior (mantém últimos N)
echo "[2/6] Gerando snapshot da versão atual..."
ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" bash -s <<CREATE_SNAPSHOT
    set -euo pipefail
    if [ -d '${VPS_REMOTE_DIR}/src' ]; then
        SNAPSHOT_NAME="snapshot_\$(date +'%Y%m%d_%H%M%S')"
        TARGET_SNAP='${VPS_SNAPSHOT_DIR}'/"\${SNAPSHOT_NAME}"
        echo "Criando snapshot em \${TARGET_SNAP}..."
        cp -a '${VPS_REMOTE_DIR}' "\${TARGET_SNAP}"
        rm -f "\${TARGET_SNAP}/.env" "\${TARGET_SNAP}/.env.*"

        # Rotação: manter os últimos ${VPS_KEEP_SNAPSHOTS} snapshots
        cd '${VPS_SNAPSHOT_DIR}'
        TOTAL_SNAPS=\$(ls -1dt snapshot_* 2>/dev/null | wc -l)
        if [ "\${TOTAL_SNAPS}" -gt "${VPS_KEEP_SNAPSHOTS}" ]; then
            ls -1dt snapshot_* | tail -n +"\$(( ${VPS_KEEP_SNAPSHOTS} + 1 ))" | xargs rm -rf 2>/dev/null || true
        fi
    fi
CREATE_SNAPSHOT

# 3. Gerar arquivo version.json e empacotar arquivos localmente
echo "[3/6] Empacotando arquivos do projeto (Commit ${CURRENT_COMMIT})..."
RAND_ID=$(head -c 8 /dev/urandom 2>/dev/null | xxd -p 2>/dev/null || echo "$$")
TEMP_ARCHIVE="${APP_DIR}/deploy-package-${RAND_ID}.tar.gz"
REMOTE_ARCHIVE="/tmp/r3b-deploy-${RAND_ID}.tar.gz"

trap 'rm -f "${TEMP_ARCHIVE}" "${APP_DIR}/version.json"' EXIT INT TERM

cat > "${APP_DIR}/version.json" <<VERSION_META
{
  "commit": "${CURRENT_COMMIT}",
  "message": "${COMMIT_MSG}",
  "deployed_at": "${DEPLOY_TIMESTAMP}",
  "deployed_by": "${USER:-deploy}"
}
VERSION_META

tar "${TAR_EXCLUDES[@]}" -czf "${TEMP_ARCHIVE}" -C "${APP_DIR}" .

# 4. Transferência via SCP com Fail-Fast
echo "[4/6] Enviando pacote para a VPS via SCP..."
SCP_OPTS=(-P "${VPS_PORT}" -o StrictHostKeyChecking=accept-new)
if [[ -n "${VPS_SSH_KEY}" ]]; then
    SCP_OPTS+=(-i "${VPS_SSH_KEY}" -o BatchMode=yes)
fi

scp "${SCP_OPTS[@]}" "${TEMP_ARCHIVE}" "${VPS_USER}@${VPS_HOST}:${REMOTE_ARCHIVE}"
rm -f "${TEMP_ARCHIVE}" "${APP_DIR}/version.json"

# 5. Extração com Fail-Fast e ajuste de permissões com privilégio mínimo
echo "[5/6] Extraindo atualização e ajustando permissões..."
ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" bash -s <<REMOTE_UNTAR
    set -euo pipefail
    SUDO_CMD=""
    if [ "\$(id -u)" -ne 0 ]; then SUDO_CMD="sudo"; fi

    tar -xzf '${REMOTE_ARCHIVE}' -C '${VPS_REMOTE_DIR}' --exclude='.env' --exclude='.env.*'
    rm -f '${REMOTE_ARCHIVE}'

    \${SUDO_CMD} chown -R ${WEB_USER}:${WEB_GROUP} '${VPS_REMOTE_DIR}'
    find '${VPS_REMOTE_DIR}' -type d -exec chmod 755 {} +
    find '${VPS_REMOTE_DIR}' -type f -exec chmod 644 {} +
    if [ -f '${VPS_REMOTE_DIR}/.env' ]; then
        chmod 600 '${VPS_REMOTE_DIR}/.env'
    fi
    chmod +x '${VPS_REMOTE_DIR}'/scripts/*.sh 2>/dev/null || true

    # Registro de auditoria no servidor
    echo "[${DEPLOY_TIMESTAMP}] Deploy executado com sucesso. Commit: ${CURRENT_COMMIT}" >> '${VPS_REMOTE_DIR}/deploy.log'
REMOTE_UNTAR

# 6. Validação Nginx (Fail-Fast) e Reload dos Serviços via sudo mínimo
echo "[6/6] Validando sintaxe e recarregando serviços..."
ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" bash -s <<RELOAD_SERVICES
    set -euo pipefail
    SUDO_CMD=""
    if [ "\$(id -u)" -ne 0 ]; then SUDO_CMD="sudo"; fi

    # FAIL-FAST: Testa sintaxe Nginx antes de aplicar
    if command -v nginx >/dev/null 2>&1; then
        echo "Validando sintaxe do Nginx (nginx -t)..."
        \${SUDO_CMD} nginx -t
    fi

    ACTIVE_PHP=\$(systemctl list-units --type=service --state=running 2>/dev/null | grep -oE 'php[0-9.]*-fpm' | head -n1 || echo "${REMOTE_PHP_FPM_SERVICE}")
    if [ -n "\${ACTIVE_PHP}" ]; then
        echo "Recarregando \${ACTIVE_PHP}..."
        \${SUDO_CMD} systemctl reload "\${ACTIVE_PHP}" || \${SUDO_CMD} systemctl restart "\${ACTIVE_PHP}"
    fi

    # Garante compatibilidade de socket se /run/php/php-fpm.sock genérico for usado
    if [ ! -e /run/php/php-fpm.sock ] && ls -1 /run/php/php*-fpm.sock >/dev/null 2>&1; then
        DETECTED_SOCK=\$(ls -1 /run/php/php*-fpm.sock | head -n1)
        \${SUDO_CMD} ln -sf "\${DETECTED_SOCK}" /run/php/php-fpm.sock 2>/dev/null || true
    fi

    if command -v nginx >/dev/null 2>&1; then
        echo "Recarregando Nginx..."
        \${SUDO_CMD} systemctl reload nginx
    fi
RELOAD_SERVICES

# Validação da aplicação e roteamento HTTP porta 80
echo "Validando integridade da aplicação e roteamento..."
DB_CHECK=$(ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" "php '${VPS_REMOTE_DIR}/health.php' 2>/dev/null || true")
INGEST_HTTP_CODE=$(ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/api/device/ingest.php 2>/dev/null || true")
REDIRECT_CODE=$(ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/ 2>/dev/null || true")

if [[ "${INGEST_HTTP_CODE}" != "301" && ("${INGEST_HTTP_CODE}" == "401" || "${INGEST_HTTP_CODE}" == "405" || "${INGEST_HTTP_CODE}" == "200") ]]; then
    echo "  [OK] Ingestão HTTP na porta 80 ativa para o SM-WU (HTTP ${INGEST_HTTP_CODE} via FastCGI)."
else
    echo "  [AVISO] Ingestão na porta 80 retornou HTTP ${INGEST_HTTP_CODE} (verifique se o Nginx está redirecionando)."
fi

if [[ "${REDIRECT_CODE}" == "301" ]]; then
    echo "  [OK] Redirecionamento obrigatório para HTTPS ativo na raiz (HTTP 301)."
fi

if echo "${DB_CHECK}" | grep -q '"status":"ok"'; then
    echo "SUCESSO: Deploy concluído e Banco MariaDB conectado com sucesso."
elif echo "${DB_CHECK}" | grep -q '"status":"degraded"'; then
    echo "AVISO: Código atualizado com sucesso, mas o banco retornou 503 (verifique se o MariaDB está iniciado e com schema importado)."
else
    echo "INFO: Deploy finalizado."
fi

echo "Deploy do commit ${CURRENT_COMMIT} finalizado com sucesso em $(date '+%Y-%m-%d %H:%M:%S')."
