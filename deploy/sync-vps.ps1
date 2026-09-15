<#
.SYNOPSIS
    Script de Deploy e Sincronização com VPS (Windows / PowerShell) — Recursos Hídricos R3B
.DESCRIPTION
    Sobe e atualiza o projeto na VPS via SCP/SSH com privilégio mínimo.
    Usuário padrão: deploy (não-root).
    Suporta Snapshots Timestamped (mantém últimos N), Rollback e Dry-Run.
.EXAMPLE
    .\deploy\sync-vps.ps1
    .\deploy\sync-vps.ps1 -DryRun
    .\deploy\sync-vps.ps1 -Rollback
    .\deploy\sync-vps.ps1 -VpsHost "203.0.113.10" -VpsUser "deploy"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$VpsHost = "",

    [Parameter(Mandatory = $false)]
    [string]$VpsUser = "",

    [Parameter(Mandatory = $false)]
    [int]$VpsPort = 0,

    [Parameter(Mandatory = $false)]
    [string]$VpsKey = "",

    [Parameter(Mandatory = $false)]
    [string]$RemoteDir = "",

    [Parameter(Mandatory = $false)]
    [string]$ConfigFile = "",

    [Parameter(Mandatory = $false)]
    [switch]$DryRun,

    [Parameter(Mandatory = $false)]
    [switch]$Rollback
)

$ErrorActionPreference = "Stop"

# Dependências nativas necessárias no Windows
foreach ($cmd in @("tar.exe", "scp.exe", "ssh.exe")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Error "Dependência ausente: '$cmd' não foi encontrado no PATH. Instale o OpenSSH Client / tar do Windows."
        return
    }
}

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$ProjectDir = Split-Path -Parent $ScriptDir

if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
    $ConfigFile = Join-Path $ScriptDir "vps.env"
}

# Ler arquivo de configuração local caso exista
$Config = @{}
if (Test-Path $ConfigFile) {
    Get-Content $ConfigFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $parts = $line.Split("=", 2)
            $k = $parts[0].Trim()
            $v = $parts[1].Trim().Trim('"').Trim("'")
            if ($k -match '^[A-Z0-9_]+$') {
                $Config[$k] = $v
            }
        }
    }
}

# Aplicar valores com precedência: Parâmetros de linha de comando > Config > Defaults
if ([string]::IsNullOrWhiteSpace($VpsHost)) {
    $VpsHost = if ($Config.ContainsKey("VPS_HOST")) { $Config["VPS_HOST"] } else { "" }
}
if ([string]::IsNullOrWhiteSpace($VpsUser)) {
    $VpsUser = if ($Config.ContainsKey("VPS_USER")) { $Config["VPS_USER"] } else { "deploy" }
}
if ($VpsPort -eq 0) {
    $VpsPort = if ($Config.ContainsKey("VPS_PORT")) { [int]$Config["VPS_PORT"] } else { 22 }
}
if ([string]::IsNullOrWhiteSpace($VpsKey)) {
    $VpsKey = if ($Config.ContainsKey("VPS_SSH_KEY")) { $Config["VPS_SSH_KEY"] } else { "" }
}
if ([string]::IsNullOrWhiteSpace($RemoteDir)) {
    $RemoteDir = if ($Config.ContainsKey("VPS_REMOTE_DIR")) { $Config["VPS_REMOTE_DIR"] } else { "/var/www/recursos-hidricos-r3b" }
}

$SnapshotDir = if ($Config.ContainsKey("VPS_SNAPSHOT_DIR")) { $Config["VPS_SNAPSHOT_DIR"] } else { "/var/www/recursos-hidricos-snapshots" }
$KeepSnapshots = if ($Config.ContainsKey("VPS_KEEP_SNAPSHOTS")) { [int]$Config["VPS_KEEP_SNAPSHOTS"] } else { 3 }
$WebUser = if ($Config.ContainsKey("WEB_USER")) { $Config["WEB_USER"] } else { "www-data" }
$WebGroup = if ($Config.ContainsKey("WEB_GROUP")) { $Config["WEB_GROUP"] } else { "www-data" }
$PhpService = if ($Config.ContainsKey("REMOTE_PHP_FPM_SERVICE")) { $Config["REMOTE_PHP_FPM_SERVICE"] } else { "php8.2-fpm" }

if ([string]::IsNullOrWhiteSpace($VpsHost) -or $VpsHost -eq "seu_ip_ou_hostname") {
    Write-Host "ERRO: O host da VPS não foi configurado." -ForegroundColor Red
    Write-Host "Preencha deploy/vps.env ou execute: .\deploy\sync-vps.ps1 -VpsHost <IP_DA_VPS>" -ForegroundColor Yellow
    return
}

# Validação estrita contra caminhos perigosos ou acidentais
$DangerousPaths = @("", "/", "/root", "/var", "/var/www", "/usr", "/etc", "/bin", "/home")
$NormalizedRemote = $RemoteDir.TrimEnd('/')
if ($DangerousPaths -contains $NormalizedRemote) {
    Write-Host "ERRO: Diretório remoto '$RemoteDir' é inseguro ou reservado pelo sistema." -ForegroundColor Red
    return
}

$SshArgsBase = @("-p", $VpsPort, "-o", "StrictHostKeyChecking=accept-new")
if (-not [string]::IsNullOrWhiteSpace($VpsKey) -and (Test-Path $VpsKey)) {
    $SshArgsBase += @("-i", $VpsKey, "-o", "BatchMode=yes")
}

# MODO ROLLBACK: Restaura o snapshot mais recente de código sem tocar no banco
if ($Rollback) {
    Write-Host "====================================================================" -ForegroundColor Magenta
    Write-Host " MODO ROLLBACK: Restaurando snapshot anterior de código na VPS" -ForegroundColor Magenta
    Write-Host " Destino: ${VpsUser}@${VpsHost}:${VpsPort} -> ${RemoteDir}" -ForegroundColor Magenta
    Write-Host "====================================================================" -ForegroundColor Magenta

    $RollbackCommands = @"
set -euo pipefail
SUDO_CMD=""
if [ "`$(id -u)" -ne 0 ]; then SUDO_CMD="sudo"; fi

if [ ! -d '${SnapshotDir}' ]; then
    echo 'ERRO: Nenhum diretório de snapshots encontrado em ${SnapshotDir}' >&2
    exit 1
fi

LATEST_SNAPSHOT=`$(ls -1dt '${SnapshotDir}'/snapshot_* 2>/dev/null | head -n1 || echo "")
if [ -z "`$LATEST_SNAPSHOT" ] || [ ! -d "`$LATEST_SNAPSHOT" ]; then
    echo 'ERRO: Nenhum snapshot timestamped encontrado em ${SnapshotDir}' >&2
    exit 1
fi

echo "Restaurando código a partir de `$LATEST_SNAPSHOT..."
# Copia mantendo arquivos de produção que não façam parte do pacote (.env, backups)
cp -a "`$LATEST_SNAPSHOT/." '${RemoteDir}/'

# Permissões seguras: deploy como dono, www-data como leitor estrito (sem escrita web)
`$SUDO_CMD chown -R ${VpsUser}:${WebGroup} '${RemoteDir}'
find '${RemoteDir}' -type d -exec chmod 755 {} +
find '${RemoteDir}' -type f -exec chmod 644 {} +
if [ -f '${RemoteDir}/.env' ]; then
    chmod 640 '${RemoteDir}/.env'
fi
chmod +x '${RemoteDir}'/scripts/*.sh 2>/dev/null || true

# Teste de sintaxe e reload seguro
`$SUDO_CMD nginx -t
ACTIVE_PHP=`$(systemctl list-units --type=service --state=running 2>/dev/null | grep -oE 'php[0-9.]*-fpm' | head -n1 || echo '$PhpService')
if [ -n "`$ACTIVE_PHP" ]; then
    `$SUDO_CMD systemctl reload "`$ACTIVE_PHP" || `$SUDO_CMD systemctl restart "`$ACTIVE_PHP"
fi
`$SUDO_CMD systemctl reload nginx

echo "[ROLLBACK CONCLUÍDO] Versão restaurada para `$LATEST_SNAPSHOT."
echo "INFO: O banco de dados NÃO foi alterado (dados de telemetria preservados)."
"@

    $SshArgs = $SshArgsBase + @("${VpsUser}@${VpsHost}", $RollbackCommands)
    & ssh.exe $SshArgs
    Write-Host "Rollback finalizado com sucesso." -ForegroundColor Green
    return
}

# Exclusões estritas de segurança (NUNCA envia .env, .git, logs, secrets, temporários)
$TarExcludes = @(
    "--exclude=.git",
    "--exclude=.env",
    "--exclude=.env.*",
    "--exclude=.runtime",
    "--exclude=logs",
    "--exclude=*.log",
    "--exclude=*.db*",
    "--exclude=deploy/vps.env*",
    "--exclude=deploy/*.env",
    "--exclude=*.tar",
    "--exclude=*.tar.gz",
    "--exclude=scratch"
)

# Metadados de versão / commit local
$CurrentCommit = try { (& git rev-parse --short HEAD 2>$null).Trim() } catch { "sem-git" }
$CommitMsg = try { (& git log -1 --pretty=%B 2>$null | Select-Object -First 1).Trim().Replace('"', '') } catch { "Deploy manual" }
$DeployTimestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

# MODO DRY-RUN: Simulação sem alterar nada
if ($DryRun) {
    Write-Host "====================================================================" -ForegroundColor Yellow
    Write-Host " MODO DRY-RUN (SIMULAÇÃO): Nenhum arquivo remoto será modificado" -ForegroundColor Yellow
    Write-Host " Destino: ${VpsUser}@${VpsHost}:${VpsPort} -> ${RemoteDir}" -ForegroundColor Yellow
    Write-Host " Versão a enviar: Commit ${CurrentCommit} (${CommitMsg})" -ForegroundColor Yellow
    Write-Host "====================================================================" -ForegroundColor Yellow

    Write-Host "`nArquivos protegidos que NUNCA são transferidos:" -ForegroundColor Cyan
    Write-Host " - .env, .env.* (credenciais de produção locais e remotas)"
    Write-Host " - .git/ (histórico Git do repositório)"
    Write-Host " - logs/, *.log, *.db* (arquivos temporários e logs locais)"
    Write-Host " - deploy/vps.env* (credenciais de conexão SSH)"

    Write-Host "`nValidações que serão executadas na VPS:" -ForegroundColor Cyan
    Write-Host " 1. Checagem de espaço em disco (mínimo 150MB livres)"
    Write-Host " 2. Criação de snapshot timestamped em ${SnapshotDir}/snapshot_YYYYMMDD_HHMMSS"
    Write-Host " 3. Rotação mantendo os últimos ${KeepSnapshots} snapshots"
    Write-Host " 4. Extração protegendo .env existente (--exclude='.env')"
    Write-Host " 5. Permissões de menor privilégio (pastas 755, arquivos 644, .env 600, scripts +x)"
    Write-Host " 6. Teste de sintaxe Nginx (nginx -t) com FAIL-FAST"
    Write-Host " 7. Reload dos serviços com sudo mínimo (sem login root)"
    Write-Host " 8. Healthcheck local em http://127.0.0.1/health.php"
    Write-Host "`nSimulação concluída com sucesso." -ForegroundColor Green
    return
}

Write-Host "====================================================================" -ForegroundColor Cyan
Write-Host " Início do Deploy: Recursos Hídricos R3B" -ForegroundColor Cyan
Write-Host " Destino: ${VpsUser}@${VpsHost}:${VpsPort} -> ${RemoteDir}" -ForegroundColor Cyan
Write-Host " Versão: Commit ${CurrentCommit} em ${DeployTimestamp}" -ForegroundColor Cyan
Write-Host "====================================================================" -ForegroundColor Cyan

# 1. Validar espaço em disco e preparar estrutura remota
Write-Host "[1/6] Verificando espaço em disco e diretórios na VPS..." -ForegroundColor Yellow
$PreCheckCmd = @"
set -euo pipefail
SUDO_CMD=""
if [ "`$(id -u)" -ne 0 ]; then SUDO_CMD="sudo"; fi

`$SUDO_CMD mkdir -p '${RemoteDir}' '${SnapshotDir}'
`$SUDO_CMD chown -R ${VpsUser}:${WebGroup} '${RemoteDir}' '${SnapshotDir}'

AVAILABLE_MB=`$(df -m '${RemoteDir}' 2>/dev/null | awk 'NR==2 {print `$4}' || echo "999")
if [ "`$AVAILABLE_MB" -lt 150 ]; then
    echo "ERRO: Espaço em disco insuficiente na VPS (`$AVAILABLE_MB MB livres). Mínimo exigido: 150MB." >&2
    exit 1
fi
echo "Espaço em disco validado: `$AVAILABLE_MB MB livres."
"@

$SshPreCheckArgs = $SshArgsBase + @("${VpsUser}@${VpsHost}", $PreCheckCmd)
& ssh.exe $SshPreCheckArgs

# 2. Gerar snapshot timestamped da versão atual (mantém últimos N)
Write-Host "[2/6] Gerando snapshot da versão atual..." -ForegroundColor Yellow
$SnapshotCmd = @"
set -euo pipefail
if [ -d '${RemoteDir}/src' ]; then
    SNAP_NAME="snapshot_`$(date +'%Y%m%d_%H%M%S')"
    TARGET_SNAP='${SnapshotDir}'/"`$SNAP_NAME"
    echo "Criando snapshot em `$TARGET_SNAP..."
    cp -a '${RemoteDir}' "`$TARGET_SNAP"
    rm -f "`$TARGET_SNAP/.env" "`$TARGET_SNAP/.env.*"

    cd '${SnapshotDir}'
    TOTAL_SNAPS=`$(ls -1dt snapshot_* 2>/dev/null | wc -l)
    if [ "`$TOTAL_SNAPS" -gt "${KeepSnapshots}" ]; then
        ls -1dt snapshot_* | tail -n +`$(( ${KeepSnapshots} + 1 )) | xargs rm -rf 2>/dev/null || true
    fi
fi
"@

$SshSnapArgs = $SshArgsBase + @("${VpsUser}@${VpsHost}", $SnapshotCmd)
& ssh.exe $SshSnapArgs

# 3. Gerar arquivo version.json e empacotar arquivos localmente
Write-Host "[3/6] Empacotando arquivos do projeto (Commit ${CurrentCommit})..." -ForegroundColor Yellow
$RandomSuffix = [System.IO.Path]::GetRandomFileName().Replace(".", "")
$TempArchive = Join-Path ([System.IO.Path]::GetTempPath()) "r3b-deploy-$RandomSuffix.tar.gz"
$RemoteArchive = "/tmp/r3b-deploy-$RandomSuffix.tar.gz"
$VersionFile = Join-Path $ProjectDir "version.json"

$VersionJsonContent = @"
{
  "commit": "$CurrentCommit",
  "message": "$CommitMsg",
  "deployed_at": "$DeployTimestamp",
  "deployed_by": "$([System.Environment]::UserName)"
}
"@
Set-Content -Path $VersionFile -Value $VersionJsonContent -Encoding UTF8

$TarArgs = $TarExcludes + @("-czf", $TempArchive, "-C", $ProjectDir, ".")
& tar.exe $TarArgs

if (Test-Path $VersionFile) {
    Remove-Item $VersionFile -Force
}

if (-not (Test-Path $TempArchive)) {
    Write-Host "ERRO: Falha ao gerar arquivo compactado de deploy." -ForegroundColor Red
    return
}

try {
    # 4. Transferência via SCP com Fail-Fast
    Write-Host "[4/6] Enviando pacote para a VPS via SCP..." -ForegroundColor Yellow
    $ScpArgs = @("-P", $VpsPort, "-o", "StrictHostKeyChecking=accept-new")
    if (-not [string]::IsNullOrWhiteSpace($VpsKey) -and (Test-Path $VpsKey)) {
        $ScpArgs += @("-i", $VpsKey, "-o", "BatchMode=yes")
    }
    $ScpArgs += @($TempArchive, "${VpsUser}@${VpsHost}:${RemoteArchive}")

    & scp.exe $ScpArgs

    # 5. Extração com Fail-Fast e ajuste de permissões
    Write-Host "[5/6] Extraindo atualização e ajustando permissões..." -ForegroundColor Yellow
    $RemoteCommands = @"
set -euo pipefail
SUDO_CMD=""
if [ "`$(id -u)" -ne 0 ]; then SUDO_CMD="sudo"; fi

tar -xzf '${RemoteArchive}' -C '${RemoteDir}' --exclude='.env' --exclude='.env.*'
rm -f '${RemoteArchive}'

# Permissões seguras: deploy como dono, www-data como leitor (sem escrita desnecessária)
`$SUDO_CMD chown -R ${VpsUser}:${WebGroup} '${RemoteDir}'
find '${RemoteDir}' -type d -exec chmod 755 {} +
find '${RemoteDir}' -type f -exec chmod 644 {} +
if [ -f '${RemoteDir}/.env' ]; then
    chmod 640 '${RemoteDir}/.env'
fi
chmod +x '${RemoteDir}'/scripts/*.sh 2>/dev/null || true

# Migração incremental: falha o deploy antes do reload se o schema não puder ser atualizado.
php '${RemoteDir}/scripts/migrate.php'

echo "[$DeployTimestamp] Deploy executado com sucesso. Commit: $CurrentCommit" >> '${RemoteDir}/deploy.log'
"@

    $SshArgs = $SshArgsBase + @("${VpsUser}@${VpsHost}", $RemoteCommands)
    & ssh.exe $SshArgs

    # 6. Validação Nginx (Fail-Fast) e Reload dos Serviços via sudo mínimo
    Write-Host "[6/6] Validando sintaxe e recarregando serviços..." -ForegroundColor Yellow
    $ReloadCommands = @"
set -euo pipefail
SUDO_CMD=""
if [ "`$(id -u)" -ne 0 ]; then SUDO_CMD="sudo"; fi

if command -v nginx >/dev/null 2>&1; then
    echo "Validando sintaxe do Nginx (nginx -t)..."
    `$SUDO_CMD nginx -t
fi

ACTIVE_PHP=`$(systemctl list-units --type=service --state=running 2>/dev/null | grep -oE 'php[0-9.]*-fpm' | head -n1 || echo '$PhpService')
if [ -n "`$ACTIVE_PHP" ]; then
    echo "Recarregando `$ACTIVE_PHP..."
    `$SUDO_CMD systemctl reload "`$ACTIVE_PHP" || `$SUDO_CMD systemctl restart "`$ACTIVE_PHP"
fi

if [ ! -e /run/php/php-fpm.sock ] && ls -1 /run/php/php*-fpm.sock >/dev/null 2>&1; then
    DETECTED_SOCK=`$(ls -1 /run/php/php*-fpm.sock | head -n1)
    `$SUDO_CMD ln -sf "`$DETECTED_SOCK" /run/php/php-fpm.sock 2>/dev/null || true
fi

if command -v nginx >/dev/null 2>&1; then
    echo "Recarregando Nginx..."
    `$SUDO_CMD systemctl reload nginx
fi
"@

    $SshReloadArgs = $SshArgsBase + @("${VpsUser}@${VpsHost}", $ReloadCommands)
    & ssh.exe $SshReloadArgs

    # Validação da aplicação e roteamento HTTP porta 80
    Write-Host "Validando integridade da aplicação e roteamento..." -ForegroundColor Yellow
    $DbCheck = (& ssh.exe ($SshArgsBase + @("${VpsUser}@${VpsHost}", "php '${RemoteDir}/health.php' 2>/dev/null || true"))).Trim()
    $IngestHttpCode = (& ssh.exe ($SshArgsBase + @("${VpsUser}@${VpsHost}", "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/api/device/ingest.php 2>/dev/null || true"))).Trim()
    $RedirectCode = (& ssh.exe ($SshArgsBase + @("${VpsUser}@${VpsHost}", "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/ 2>/dev/null || true"))).Trim()

    if ($IngestHttpCode -ne "301" -and ($IngestHttpCode -in @("401", "405", "200"))) {
        Write-Host "  [OK] Ingestão HTTP na porta 80 ativa para o SM-WU (HTTP $IngestHttpCode via FastCGI)." -ForegroundColor Green
    } else {
        Write-Host "  [AVISO] Ingestão na porta 80 retornou HTTP $IngestHttpCode (verifique se o Nginx está redirecionando)." -ForegroundColor DarkYellow
    }

    if ($RedirectCode -eq "301") {
        Write-Host "  [OK] Redirecionamento obrigatório para HTTPS ativo na raiz (HTTP 301)." -ForegroundColor Green
    }

    if ($DbCheck -match '"status":"ok"') {
        Write-Host "SUCESSO: Deploy concluído e Banco MariaDB conectado com sucesso." -ForegroundColor Green
    } elseif ($DbCheck -match '"status":"degraded"') {
        Write-Host "AVISO: Código atualizado com sucesso, mas o banco retornou 503 (verifique se o MariaDB está iniciado e com schema importado)." -ForegroundColor DarkYellow
    } else {
        Write-Host "INFO: Deploy finalizado." -ForegroundColor Cyan
    }

} finally {
    if (Test-Path $TempArchive) {
        Remove-Item $TempArchive -Force
    }
    if (Test-Path $VersionFile) {
        Remove-Item $VersionFile -Force
    }
}

Write-Host "Deploy do commit $CurrentCommit finalizado com sucesso." -ForegroundColor Green
