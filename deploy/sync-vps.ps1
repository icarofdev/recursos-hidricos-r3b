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

# Ler arquivo de configuração caso exista
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

# Validação contra caminhos perigosos ou destrutivos
$DangerousPaths = @("/", "/root", "/var", "/var/www", "/usr", "/etc", "/bin", "/home")
$NormalizedRemote = $RemoteDir.TrimEnd('/')
if ([string]::IsNullOrWhiteSpace($NormalizedRemote) -or ($DangerousPaths -contains $NormalizedRemote)) {
    Write-Host "ERRO: Diretório remoto '$RemoteDir' é inseguro ou reservado pelo sistema." -ForegroundColor Red
    return
}

Write-Host "====================================================================" -ForegroundColor Cyan
Write-Host " Início do Deploy: Recursos Hídricos R3B" -ForegroundColor Cyan
Write-Host " Destino: ${VpsUser}@${VpsHost}:${VpsPort} -> ${RemoteDir}" -ForegroundColor Cyan
Write-Host "====================================================================" -ForegroundColor Cyan

# 1. Empacotar arquivos do projeto (excluindo .git, .env, temporários)
$RandomSuffix = [System.IO.Path]::GetRandomFileName().Replace(".", "")
$TempArchive = Join-Path $ProjectDir "deploy-package-$RandomSuffix.tar.gz"
$RemoteArchive = "/tmp/r3b-deploy-$RandomSuffix.tar.gz"

Write-Host "[1/4] Empacotando arquivos do projeto..." -ForegroundColor Yellow
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

& tar.exe $TarArgs
if (-not (Test-Path $TempArchive)) {
    Write-Host "ERRO: Falha ao gerar arquivo compactado de deploy." -ForegroundColor Red
    return
}

try {
    # 2. Criar diretório remoto e transferir pacote
    Write-Host "[2/4] Enviando pacote para a VPS via SCP..." -ForegroundColor Yellow
    $ScpArgs = @("-P", $VpsPort, "-o", "StrictHostKeyChecking=accept-new")
    if (-not [string]::IsNullOrWhiteSpace($VpsKey) -and (Test-Path $VpsKey)) {
        $ScpArgs += @("-i", $VpsKey)
    }
    $ScpArgs += @($TempArchive, "${VpsUser}@${VpsHost}:${RemoteArchive}")

    & scp.exe $ScpArgs

    # 3. Executar descompactação e permissões com menor privilégio na VPS
    Write-Host "[3/4] Atualizando arquivos e ajustando permissões remotas..." -ForegroundColor Yellow
    $RemoteCommands = @"
set -e
if [ -z '${RemoteDir}' ] || [ '${RemoteDir}' = '/' ] || [ '${RemoteDir}' = '/root' ] || [ '${RemoteDir}' = '/var' ] || [ '${RemoteDir}' = '/var/www' ]; then
    echo 'ERRO: Diretório remoto inválido: ${RemoteDir}' >&2
    exit 1
fi

mkdir -p '${RemoteDir}'
tar -xzf '${RemoteArchive}' -C '${RemoteDir}' --exclude='.env'
rm -f '${RemoteArchive}'

chown -R ${WebUser}:${WebGroup} '${RemoteDir}'
find '${RemoteDir}' -type d -exec chmod 755 {} +
find '${RemoteDir}' -type f -exec chmod 644 {} +
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
    Write-Host "[4/4] Validando aplicação remota via Healthcheck..." -ForegroundColor Yellow
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
        Write-Host "AVISO: Código copiado com sucesso, mas o banco retornou 503 (verifique se o MariaDB está rodando e com o schema importado)." -ForegroundColor DarkYellow
    } else {
        Write-Host "INFO: Deploy finalizado. (Healthcheck HTTP local: $HealthCode)" -ForegroundColor Cyan
    }

} finally {
    if (Test-Path $TempArchive) {
        Remove-Item $TempArchive -Force
    }
}

Write-Host "Deploy finalizado com sucesso." -ForegroundColor Green
