<#
.SYNOPSIS
  Uploads today's Stock_yyMMdd.csv / Sales_yyMMdd.csv to the RFQ database.
.DESCRIPTION
  Stock -> table sap_stock is replaced by the file.
  Sales -> table sap_sales: lines are upserted by SalesKeyColumns, so the daily month-to-date file only
           adds new lines (and refreshes changed ones). Re-running is safe.
.EXAMPLE
  .\Upload-SapToRfq.ps1                 # both
  .\Upload-SapToRfq.ps1 -Report Stock
#>
param([ValidateSet('All', 'Stock', 'Sales')] [string]$Report = 'All', [string]$ConfigPath)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'SapSync.psm1') -Force
$cfg = Initialize-SapSync $ConfigPath
$failed = 0

$jobs = @()
if ($Report -ne 'Sales') { $jobs += @{ Prefix = $cfg.StockPrefix; Type = 'sap_stock' } }
if ($Report -ne 'Stock') { $jobs += @{ Prefix = $cfg.SalesPrefix; Type = 'sap_sales' } }
foreach ($j in $jobs) {
    try {
        $file = Get-SapCsvFile $cfg $j.Prefix
        Write-SyncLog INFO "RFQ $($j.Type) <- $($file.Name)"
        $r = Send-SapFileToRfq -Config $cfg -File $file -Type $j.Type
        $msg = "RFQ $($j.Type): $($r.imported) rows, file date $($r.fileDate)"
        if ($j.Type -eq 'sap_sales') { $msg += ", new $($r.inserted), changed $($r.updated), unchanged $($r.unchanged), problems $($r.errorCount)" }
        Write-SyncLog SUCCESS $msg
        if ($j.Type -eq 'sap_sales' -and $r.errorCount -gt 0) {
            $first = (@($r.errors) | Select-Object -First 5) -join ' / '
            Write-SyncLog WARN "RFQ sales: $first"
        }
    }
    catch { $failed++; Write-SyncLog ERROR "RFQ $($j.Type): $($_.Exception.Message)" }
}
exit [int]($failed -gt 0)
