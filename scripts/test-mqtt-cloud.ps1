param(
    [string]$HostName
)

$ErrorActionPreference = 'Stop'
$envPath = Join-Path $PSScriptRoot '..\.env'

if ([string]::IsNullOrWhiteSpace($HostName) -and (Test-Path -LiteralPath $envPath)) {
    $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^\s*MQTT_HOST\s*=' } | Select-Object -First 1
    if ($null -ne $line) {
        $HostName = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
    }
}

if ([string]::IsNullOrWhiteSpace($HostName)) {
    $HostName = 'r10116ac.ala.us-east-1.emqxsl.com'
}

try {
    Resolve-DnsName -Name $HostName -ErrorAction Stop | Out-Null
    Write-Output 'DNS OK'
} catch {
    Write-Output 'DNS FAILED'
    exit 1
}

$tcpOk = Test-NetConnection -ComputerName $HostName -Port 8883 -InformationLevel Quiet
if ($tcpOk) {
    Write-Output 'TCP 8883 OK'
    exit 0
}

Write-Output 'TCP 8883 BLOCKED'
exit 2
