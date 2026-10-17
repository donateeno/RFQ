<#
.SYNOPSIS
  Daily job: HANA export (optional) -> RFQ database -> Google Sheets. Exit code 1 if any step failed.
.DESCRIPTION
  Each target runs on its own, so a Google error does not stop the RFQ upload and vice versa.
  Register it with Register-SapSyncTask.ps1.
#>
param([string]$ConfigPath, [switch]$SkipExport)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'SapSync.psm1') -Force
$cfg = Initialize-SapSync $ConfigPath
$failed = 0
Write-SyncLog INFO '=== SAP daily sync start ==='

if ($cfg.ExportScript -and -not $SkipExport) {
    # Separate process: the export script has its own error handling and HANA driver.
    Write-SyncLog INFO "Export: $($cfg.ExportScript)"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cfg.ExportScript | Out-Host
    if ($LASTEXITCODE) { Write-SyncLog WARN "Export exited with $LASTEXITCODE (today's files are checked next)" }
}

$cfgArg = @{}
if ($ConfigPath) { $cfgArg.ConfigPath = $ConfigPath }
if ($cfg.Rfq.Enabled) {
    & (Join-Path $PSScriptRoot 'Upload-SapToRfq.ps1') @cfgArg
    if ($LASTEXITCODE) { $failed++ }
}
if ($cfg.GoogleSheets.Enabled) {
    & (Join-Path $PSScriptRoot 'Upload-SapToGoogleSheets.ps1') @cfgArg
    if ($LASTEXITCODE) { $failed++ }
}

if ($failed) { Write-SyncLog ERROR "=== SAP daily sync finished with $failed failed target(s) ===" }
else { Write-SyncLog SUCCESS '=== SAP daily sync finished ===' }
exit [int]($failed -gt 0)
