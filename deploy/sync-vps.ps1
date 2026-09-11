<#
.SYNOPSIS
    Script de Deploy e Sincronização com VPS (Windows / PowerShell) — Recursos Hídricos R3B
.DESCRIPTION
    Sobe e atualiza o projeto na VPS via SCP/SSH sem hardcode de credenciais.
    Lê automaticamente as configurações de deploy/vps.env se disponível.
.EXAMPLE
    .\deploy\sync-vps.ps1
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
    [string]$ConfigFile = ""
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
    $ConfigFile = Join-Path $ScriptDir "vps.env"
}

# Ler arquivo de configuração caso exista
$Config = @{}
if (Test-Path $ConfigFile) {
    Get-Content $ConfigFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $parts = $line.Split("=", 2)
            $k = $parts[0].Trim()
            $v = $parts[1].Trim().Trim('"').Trim("'")
            $Config[$k] = $v
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
    Write-Error "O host da VPS não foi configurado. Preencha deploy/vps.env ou execute: .\deploy\sync-vps.ps1 -VpsHost <IP_DA_VPS>"
    exit 1
}

Write-Host "====================================================================" -ForegroundColor Cyan
Write-Host " Início do Deploy: Recursos Hídricos R3B" -ForegroundColor Cyan
Write-Host " Destino: ${VpsUser}@${VpsHost}:${VpsPort} -> ${RemoteDir}" -ForegroundColor Cyan
Write-Host "====================================================================" -ForegroundColor Cyan

# 1. Empacotar arquivos do projeto (excluindo .git, .env, temporários)
$TempArchive = Join-Path $ProjectDir "deploy-package.tar.gz"
if (Test-Path $TempArchive) {
    Remove-Item $TempArchive -Force
}

Write-Host "[1/4] Empacotando arquivos do projeto..." -ForegroundColor Yellow
$TarExe = "tar.exe"
$TarArgs = @(
    "--exclude=.git",
    "--exclude=.env",
    "--exclude=.runtime",
    "--exclude=*.log",
    "--exclude=*.db*",
    "--exclude=deploy/vps.env",
    "--exclude=deploy/*.env",
    "--exclude=*.tar.gz",
    "--exclude=scratch",
    "-czf", $TempArchive,
    "-C", $ProjectDir,
    "."
)

& $TarExe $TarArgs
if (-not (Test-Path $TempArchive)) {
    Write-Error "Falha ao gerar arquivo compactado de deploy."
    exit 1
}

try {
    # 2. Criar diretório remoto e transferir pacote
    Write-Host "[2/4] Enviando pacote para a VPS via SCP..." -ForegroundColor Yellow
    $ScpArgs = @("-P", $VpsPort, "-o", "StrictHostKeyChecking=accept-new")
    if (-not [string]::IsNullOrWhiteSpace($VpsKey) -and (Test-Path $VpsKey)) {
        $ScpArgs += @("-i", $VpsKey)
    }
    $ScpArgs += @($TempArchive, "${VpsUser}@${VpsHost}:/tmp/r3b-deploy.tar.gz")

    & scp.exe $ScpArgs

    # 3. Executar descompactação e permissões na VPS
    Write-Host "[3/4] Atualizando arquivos e ajustando permissões remotas..." -ForegroundColor Yellow
    $RemoteCommands = @"
set -e
mkdir -p '${RemoteDir}'
tar -xzf /tmp/r3b-deploy.tar.gz -C '${RemoteDir}' --exclude='.env'
rm -f /tmp/r3b-deploy.tar.gz

chown -R ${WebUser}:${WebGroup} '${RemoteDir}'
chmod -R 755 '${RemoteDir}'
if [ -f '${RemoteDir}/.env' ]; then
    chmod 600 '${RemoteDir}/.env'
fi
chmod +x '${RemoteDir}'/scripts/*.sh 2>/dev/null || true

systemctl reload ${PhpService} 2>/dev/null || systemctl reload php-fpm 2>/dev/null || true
systemctl reload nginx 2>/dev/null || true
"@

    $SshArgs = @("-p", $VpsPort, "-o", "StrictHostKeyChecking=accept-new")
    if (-not [string]::IsNullOrWhiteSpace($VpsKey) -and (Test-Path $VpsKey)) {
        $SshArgs += @("-i", $VpsKey)
    }
    $SshArgs += @("${VpsUser}@${VpsHost}", $RemoteCommands)

    & ssh.exe $SshArgs

    # 4. Validar saúde da aplicação na VPS
    Write-Host "[4/4] Validando aplicação remota..." -ForegroundColor Yellow
    $CheckCmd = "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/health.php 2>/dev/null || true"
    $HealthArgs = @("-p", $VpsPort, "-o", "StrictHostKeyChecking=accept-new")
    if (-not [string]::IsNullOrWhiteSpace($VpsKey) -and (Test-Path $VpsKey)) {
        $HealthArgs += @("-i", $VpsKey)
    }
    $HealthArgs += @("${VpsUser}@${VpsHost}", $CheckCmd)

    $HealthCode = (& ssh.exe $HealthArgs).Trim()

    if ($HealthCode -eq "200") {
        Write-Host "SUCESSO: Deploy concluído e Healthcheck retornou HTTP 200 (OK)." -ForegroundColor Green
    } elseif ($HealthCode -eq "503") {
        Write-Host "AVISO: Código copiado com sucesso, mas o banco de dados retornou 503 (verifique se o MariaDB está rodando e com o schema importado)." -ForegroundColor DarkYellow
    } else {
        Write-Host "INFO: Deploy finalizado. (Healthcheck HTTP local: $HealthCode)" -ForegroundColor Cyan
    }

} finally {
    if (Test-Path $TempArchive) {
        Remove-Item $TempArchive -Force
    }
}

Write-Host "Deploy finalizado com sucesso." -ForegroundColor Green
