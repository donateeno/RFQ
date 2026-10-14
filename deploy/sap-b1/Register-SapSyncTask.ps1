<#
.SYNOPSIS
  Creates (or replaces) the Windows scheduled task that runs Run-SapDailySync.ps1 every day.
.DESCRIPTION
  Run in an elevated PowerShell. -User must be the account that ran Set-SapSyncSecret.ps1 and that can
  read the CSV folder and the Google key file. You are asked for its password.
.EXAMPLE
  .\Register-SapSyncTask.ps1 -At 06:30 -User EVE\svc_sapsync
  .\Register-SapSyncTask.ps1 -At 06:30,12:30,17:30 -User EVE\svc_sapsync    # several runs a day
#>
param(
    [string[]]$At = @('06:30'),
    [string]$User = "$env:USERDOMAIN\$env:USERNAME",
    [string]$TaskName = 'RFQ - SAP daily sync',
    [string]$ConfigPath
)
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'Run-SapDailySync.ps1'
$arg = '-NoProfile -ExecutionPolicy Bypass -File "' + $script + '"'
if ($ConfigPath) { $arg += ' -ConfigPath "' + $ConfigPath + '"' }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $PSScriptRoot
$triggers = @($At | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ })
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2) -StartWhenAvailable -MultipleInstances IgnoreNew
$cred = Get-Credential -UserName $User -Message 'Windows account that runs the SAP sync'
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings `
    -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null
Write-Host "Task '$TaskName' registered for $($cred.UserName) at $($At -join ', ')" -ForegroundColor Green
