<#
.SYNOPSIS
  Pushes today's SAP exports to Google Sheets.
.DESCRIPTION
  Stock -> the Stock tab is cleared and rewritten with the whole file (header + rows).
  Sales -> only lines not yet in the Sales tab are appended under the last row. The file is
           month-to-date (renewed every month); a RowKey column at the right end remembers which lines
           are already there, so running it several times a day never duplicates lines.
.EXAMPLE
  .\Upload-SapToGoogleSheets.ps1 -Report Sales
#>
param([ValidateSet('All', 'Stock', 'Sales')] [string]$Report = 'All', [string]$ConfigPath)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'SapSync.psm1') -Force
$cfg = Initialize-SapSync $ConfigPath
$failed = 0

if ($Report -ne 'Sales') {
    try {
        $file = Get-SapCsvFile $cfg $cfg.StockPrefix
        Write-SyncLog INFO "Sheets Stock <- $($file.Name)"
        $n = Update-StockSheet -Config $cfg -File $file
        Write-SyncLog SUCCESS "Sheets Stock: tab '$($cfg.GoogleSheets.Stock.Sheet)' replaced with $n rows"
    }
    catch { $failed++; Write-SyncLog ERROR "Sheets Stock: $($_.Exception.Message)" }
}
if ($Report -ne 'Stock') {
    try {
        $file = Get-SapCsvFile $cfg $cfg.SalesPrefix
        Write-SyncLog INFO "Sheets Sales <- $($file.Name)"
        $r = Add-SalesToSheet -Config $cfg -File $file
        Write-SyncLog SUCCESS "Sheets Sales: tab '$($r.Tab)' +$($r.Appended) new of $($r.FileRows) lines in the file"
    }
    catch { $failed++; Write-SyncLog ERROR "Sheets Sales: $($_.Exception.Message)" }
}
exit [int]($failed -gt 0)
