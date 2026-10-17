<#
.SYNOPSIS
  Stores the RFQ INTEGRATION_TOKEN encrypted with Windows DPAPI.
.DESCRIPTION
  Only the same Windows account on the same machine can decrypt the file, so run this AS THE ACCOUNT
  THAT RUNS THE SCHEDULED TASK (e.g. "runas /user:DOMAIN\svc_sapsync powershell").
  Alternative: set the environment variable RFQ_INTEGRATION_TOKEN for that account.
.EXAMPLE
  .\Set-SapSyncSecret.ps1 -Path D:\NTT_Interface\SapSync\rfq-token.secret
#>
param([Parameter(Mandatory = $true)] [string]$Path)
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $Path
if ($dir -and -not (Test-Path $dir)) { New-Item -Path $dir -ItemType Directory | Out-Null }
$secure = Read-Host -AsSecureString 'RFQ INTEGRATION_TOKEN (from the server .env)'
ConvertFrom-SecureString -SecureString $secure | Set-Content -Path $Path -Encoding ASCII
Write-Host "Saved for $env:USERDOMAIN\$env:USERNAME -> $Path" -ForegroundColor Green
