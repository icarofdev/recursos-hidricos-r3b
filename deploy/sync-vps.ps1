<#
.SYNOPSIS
    Script de Deploy e Sincronização com VPS (Windows / PowerShell) — Recursos Hídricos R3B
.DESCRIPTION
    Sobe e atualiza o projeto na VPS via SCP/SSH sem expor credenciais.
    Lê automaticamente deploy/vps.env, suporta Rollback e Dry-Run.
.EXAMPLE
    .\deploy\sync-vps.ps1
    .\deploy\sync-vps.ps1 -DryRun
    .\deploy\sync-vps.ps1 -Rollback
    .\deploy\sync-vps.ps1 -VpsHost "203.0.113.10" -VpsUser "root"
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
    $VpsUser = if ($Config.ContainsKey("VPS_USER")) { $Config["VPS_USER"] } else { "root" }
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
    $SshArgsBase += @("-i", $VpsKey)
}

# MODO ROLLBACK: Restaura a versão anterior salva em RemoteDir.bak
if ($Rollback) {
    Write-Host "====================================================================" -ForegroundColor Magenta
    Write-Host " MODO ROLLBACK: Restaurando backup anterior na VPS" -ForegroundColor Magenta
    Write-Host " Destino: ${VpsUser}@${VpsHost}:${VpsPort} -> ${RemoteDir}" -ForegroundColor Magenta
    Write-Host "====================================================================" -ForegroundColor Magenta

    $RollbackCommands = @"
set -e
if [ ! -d '${RemoteDir}.bak' ]; then
    echo 'ERRO: Nenhum backup anterior encontrado em ${RemoteDir}.bak' >&2
    exit 1
fi
echo 'Restaurando arquivos de ${RemoteDir}.bak para ${RemoteDir}...'
cp -a '${RemoteDir}.bak/.' '${RemoteDir}/'
chown -R ${WebUser}:${WebGroup} '${RemoteDir}'
echo 'Rollback concluído com sucesso.'
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

# MODO DRY-RUN: Simulação sem alterar nada
if ($DryRun) {
    Write-Host "====================================================================" -ForegroundColor Yellow
    Write-Host " MODO DRY-RUN (SIMULAÇÃO): Nenhum arquivo remoto será modificado" -ForegroundColor Yellow
    Write-Host " Destino: ${VpsUser}@${VpsHost}:${VpsPort} -> ${RemoteDir}" -ForegroundColor Yellow
    Write-Host "====================================================================" -ForegroundColor Yellow

    Write-Host "`nArquivos protegidos que NÃO seriam enviados:" -ForegroundColor Cyan
    Write-Host " - .env, .env.* (preserva credenciais de produção)"
    Write-Host " - .git/ (não transfere histórico)"
    Write-Host " - logs/, *.log, *.db* (não transfere dados locais)"
    Write-Host " - deploy/vps.env* (não expõe credenciais de conexão)"

    Write-Host "`nArquivos do projeto elegíveis para sincronização:" -ForegroundColor Cyan
    $InspectArchive = Join-Path ([System.IO.Path]::GetTempPath()) "dryrun-test-$([System.Guid]::NewGuid().ToString('N')).tar"
    try {
        & tar.exe ($TarExcludes + @("-cf", $InspectArchive, "-C", $ProjectDir, "."))
        & tar.exe -tf $InspectArchive | Select-Object -First 25 | ForEach-Object { Write-Host "  $_" }
        Write-Host "  ... (total filtrado com sucesso)"
    } finally {
        if (Test-Path $InspectArchive) { Remove-Item $InspectArchive -Force }
    }

    Write-Host "`nComandos que seriam executados na VPS:" -ForegroundColor Cyan
    Write-Host " 1. Criar snapshot de segurança em ${RemoteDir}.bak"
    Write-Host " 2. Extrair pacote ignorando .env existente"
    Write-Host " 3. Ajustar permissões (pastas 755, arquivos 644, scripts +x, .env 600)"
    Write-Host " 4. Recarregar PHP-FPM e Nginx (com teste prévio 'nginx -t')"
    Write-Host " 5. Validar via curl local em http://127.0.0.1/health.php"
    Write-Host "`nSimulação concluída com sucesso." -ForegroundColor Green
    return
}

Write-Host "====================================================================" -ForegroundColor Cyan
Write-Host " Início do Deploy: Recursos Hídricos R3B" -ForegroundColor Cyan
Write-Host " Destino: ${VpsUser}@${VpsHost}:${VpsPort} -> ${RemoteDir}" -ForegroundColor Cyan
Write-Host "====================================================================" -ForegroundColor Cyan

# 1. Empacotar arquivos do projeto de forma segura
$RandomSuffix = [System.IO.Path]::GetRandomFileName().Replace(".", "")
$TempArchive = Join-Path $ProjectDir "deploy-package-$RandomSuffix.tar.gz"
$RemoteArchive = "/tmp/r3b-deploy-$RandomSuffix.tar.gz"

Write-Host "[1/5] Empacotando arquivos do projeto..." -ForegroundColor Yellow
$TarArgs = $TarExcludes + @("-czf", $TempArchive, "-C", $ProjectDir, ".")
& tar.exe $TarArgs

if (-not (Test-Path $TempArchive)) {
    Write-Host "ERRO: Falha ao gerar arquivo compactado de deploy." -ForegroundColor Red
    return
}

try {
    # 2. Criar diretório remoto e transferir pacote
    Write-Host "[2/5] Enviando pacote para a VPS via SCP..." -ForegroundColor Yellow
    $ScpArgs = @("-P", $VpsPort, "-o", "StrictHostKeyChecking=accept-new")
    if (-not [string]::IsNullOrWhiteSpace($VpsKey) -and (Test-Path $VpsKey)) {
        $ScpArgs += @("-i", $VpsKey)
    }
    $ScpArgs += @($TempArchive, "${VpsUser}@${VpsHost}:${RemoteArchive}")

    & scp.exe $ScpArgs

    # 3. Executar descompactação segura com snapshot de rollback
    Write-Host "[3/5] Atualizando código com snapshot de segurança..." -ForegroundColor Yellow
    $RemoteCommands = @"
set -e
if [ -z '${RemoteDir}' ] || [ '${RemoteDir}' = '/' ] || [ '${RemoteDir}' = '/root' ] || [ '${RemoteDir}' = '/var' ] || [ '${RemoteDir}' = '/var/www' ]; then
    echo 'ERRO: Diretório remoto inválido: ${RemoteDir}' >&2
    exit 1
fi

# Snapshot prévio para rollback instantâneo se a aplicação já existir
if [ -d '${RemoteDir}/src' ]; then
    rm -rf '${RemoteDir}.bak'
    cp -a '${RemoteDir}' '${RemoteDir}.bak'
fi

mkdir -p '${RemoteDir}'

# Descompacta garantindo que NENHUM .env seja sobrescrito
tar -xzf '${RemoteArchive}' -C '${RemoteDir}' --exclude='.env' --exclude='.env.*'
rm -f '${RemoteArchive}'

# Permissões rigorosas de menor privilégio
chown -R ${WebUser}:${WebGroup} '${RemoteDir}'
find '${RemoteDir}' -type d -exec chmod 755 {} +
find '${RemoteDir}' -type f -exec chmod 644 {} +
if [ -f '${RemoteDir}/.env' ]; then
    chmod 600 '${RemoteDir}/.env'
fi
chmod +x '${RemoteDir}'/scripts/*.sh 2>/dev/null || true
"@

    $SshArgs = $SshArgsBase + @("${VpsUser}@${VpsHost}", $RemoteCommands)
    & ssh.exe $SshArgs

    # 4. Recarregar serviços com detecção dinâmica e validação de sintaxe
    Write-Host "[4/5] Recarregando serviços na VPS..." -ForegroundColor Yellow
    $ReloadCommands = @"
set -e
ACTIVE_PHP=`$(systemctl list-units --type=service --state=running 2>/dev/null | grep -oE 'php[0-9.]*-fpm' | head -n1)
if [ -z "`$ACTIVE_PHP" ]; then
    ACTIVE_PHP='$PhpService'
fi
if [ -n "`$ACTIVE_PHP" ]; then
    systemctl reload "`$ACTIVE_PHP" 2>/dev/null || systemctl restart "`$ACTIVE_PHP" 2>/dev/null || true
fi

if command -v nginx >/dev/null 2>&1; then
    if nginx -t >/dev/null 2>&1; then
        systemctl reload nginx 2>/dev/null || true
    else
        echo 'AVISO: Falha na sintaxe do Nginx (nginx -t); reload do Nginx ignorado para evitar queda do servidor.' >&2
    fi
fi
"@
    $SshReloadArgs = $SshArgsBase + @("${VpsUser}@${VpsHost}", $ReloadCommands)
    & ssh.exe $SshReloadArgs

    # 5. Validar integridade via Healthcheck
    Write-Host "[5/5] Validando integridade via Healthcheck..." -ForegroundColor Yellow
    $CheckCmd = "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/health.php 2>/dev/null || true"
    $HealthArgs = $SshArgsBase + @("${VpsUser}@${VpsHost}", $CheckCmd)
    $HealthCode = (& ssh.exe $HealthArgs).Trim()

    if ($HealthCode -eq "200") {
        Write-Host "SUCESSO: Deploy concluído e Healthcheck retornou HTTP 200 (OK)." -ForegroundColor Green
    } elseif ($HealthCode -eq "503") {
        Write-Host "AVISO: Código atualizado com sucesso, mas o banco retornou 503 (configure o MariaDB e importe o schema se for o primeiro deploy)." -ForegroundColor DarkYellow
    } else {
        Write-Host "INFO: Deploy finalizado. (Healthcheck HTTP local: $HealthCode)" -ForegroundColor Cyan
    }

} finally {
    if (Test-Path $TempArchive) {
        Remove-Item $TempArchive -Force
    }
}

Write-Host "Deploy finalizado com sucesso." -ForegroundColor Green
