# ============================================================
#  SapSync.psm1 - shared functions for the SAP B1 report uploads
#  (Stock_yyMMdd.csv / Sales_yyMMdd.csv written by ExportCSVByQuery_Report*.ps1)
#
#  Targets:  RFQ server  POST /api/integrations/import/sap_stock | sap_sales (text/csv)
#            Google Sheets API v4 with a service account (no extra modules needed)
#
#  Works on Windows PowerShell 5.1 and PowerShell 7 (Windows). Keep this file ASCII:
#  PowerShell 5.1 reads a .psm1 without BOM in the ANSI code page.
# ============================================================
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web
Add-Type -AssemblyName Microsoft.VisualBasic

$script:LogFile = $null
$script:GoogleToken = $null
$script:GoogleTokenExpires = [DateTime]::MinValue
$Invariant = [Globalization.CultureInfo]::InvariantCulture

# ------------------------------------------------------------ config, log, secrets

function Initialize-SapSync {
    param([string]$ConfigPath)
    # Windows PowerShell 5.1 defaults to TLS 1.0; Google and the RFQ proxy need 1.2+.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'sap-sync.config.psd1' }
    if (-not (Test-Path $ConfigPath)) { throw "Config not found: $ConfigPath (copy sap-sync.config.example.psd1)" }
    $cfg = Import-PowerShellDataFile -Path $ConfigPath
    if (-not (Test-Path $cfg.LogDir)) { New-Item -Path $cfg.LogDir -ItemType Directory | Out-Null }
    $script:LogFile = Join-Path $cfg.LogDir ('sap_sync_' + (Get-Date).ToString('yyyyMMdd', $Invariant) + '.txt')
    return $cfg
}

# Same line format as the export scripts' log_yyyyMMdd.txt
function Write-SyncLog {
    param([ValidateSet('INFO', 'SUCCESS', 'WARN', 'ERROR')] [string]$Level, [string]$Message)
    $line = '{0} [{1,-7}] {2}' -f (Get-Date).ToString('yyyyMMdd_HHmmss', $Invariant), $Level, $Message
    $color = @{ INFO = 'Gray'; SUCCESS = 'Green'; WARN = 'Yellow'; ERROR = 'Red' }[$Level]
    Write-Host $line -ForegroundColor $color
    if ($script:LogFile) { Add-Content -Path $script:LogFile -Value $line -Encoding UTF8 }
}

# Secrets are stored with DPAPI (ConvertFrom-SecureString): only the same Windows user on the same
# machine can read them back, so run Set-SapSyncSecret.ps1 as the account the scheduled task uses.
function Read-SapSyncSecret {
    param([string]$Path, [string]$EnvName)
    if ($EnvName) {
        $v = [Environment]::GetEnvironmentVariable($EnvName)
        if ($v) { return $v }
    }
    if (-not (Test-Path $Path)) { throw "Secret file not found: $Path (run Set-SapSyncSecret.ps1 as this user)" }
    $secure = (Get-Content -Path $Path -Raw).Trim() | ConvertTo-SecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# ------------------------------------------------------------ CSV files

# Newest <Prefix>_yyMMdd.csv in CsvDir. The export scripts name files with (Get-Date).ToString("yyMMdd")
# in the machine's culture, so "today" is computed the same way here.
function Get-SapCsvFile {
    param($Config, [string]$Prefix)
    $pattern = '^' + [regex]::Escape($Prefix) + '_\d{6}$'
    $files = @(Get-ChildItem -Path $Config.CsvDir -Filter "$Prefix`_*.csv" -File |
        Where-Object { $_.BaseName -match $pattern } | Sort-Object LastWriteTime -Descending)
    if ($files.Count -eq 0) { throw "No $Prefix`_yyMMdd.csv in $($Config.CsvDir)" }
    $file = $files[0]
    $todayName = $Prefix + '_' + (Get-Date).ToString('yyMMdd') + '.csv'
    if ($Config.RequireTodayFile -and $file.Name -ne $todayName) {
        throw "Today's file $todayName is missing (newest is $($file.Name)). Did the HANA export fail? See its log_yyyyMMdd.txt."
    }
    if ($file.Length -lt 10) { throw "$($file.Name) is empty" }
    return $file
}

# CSV -> List[string[]] (row 0 = header). Handles quotes, commas and line breaks inside fields, UTF-8 BOM.
function Read-SapCsv {
    param([string]$Path)
    $parser = New-Object Microsoft.VisualBasic.FileIO.TextFieldParser($Path, [Text.Encoding]::UTF8)
    $parser.TextFieldType = [Microsoft.VisualBasic.FileIO.FieldType]::Delimited
    $parser.SetDelimiters(',')
    $parser.HasFieldsEnclosedInQuotes = $true
    $parser.TrimWhiteSpace = $false
    $rows = New-Object 'System.Collections.Generic.List[string[]]'
    try { while (-not $parser.EndOfData) { $rows.Add($parser.ReadFields()) } }
    finally { $parser.Close() }
    if ($rows.Count -lt 2) { throw "$Path has no data rows" }
    return , $rows
}

# File date for the server, culture-independent (a th-TH machine writes Buddhist-year file names).
function Get-SapFileDate {
    param([IO.FileInfo]$File)
    return $File.LastWriteTime.ToString('yyyy-MM-dd', $Invariant)
}

# ------------------------------------------------------------ HTTP

# Invoke-WebRequest + UTF-8 decoding of the JSON reply (PS 5.1 otherwise guesses the charset).
# Retries network errors, 429 and 5xx with backoff. Never logs query strings or headers.
function Invoke-SyncHttp {
    param([string]$Method, [string]$Uri, [hashtable]$Headers = @{}, [string]$ContentType, $Body, [int]$TimeoutSec = 300, [int]$Retries = 3)
    for ($attempt = 1; ; $attempt++) {
        try {
            $p = @{ Method = $Method; Uri = $Uri; Headers = $Headers; UseBasicParsing = $true; TimeoutSec = $TimeoutSec }
            if ($null -ne $Body) { $p.Body = $Body; $p.ContentType = $ContentType }
            $r = Invoke-WebRequest @p
            $text = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
            if ($text.Trim()) { return ($text | ConvertFrom-Json) }
            return $null
        }
        catch {
            $status = 0
            $detail = $_.Exception.Message
            $resp = $_.Exception.PSObject.Properties['Response']
            if ($resp -and $resp.Value) { try { $status = [int]$resp.Value.StatusCode } catch { } }
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message }
            $retry = ($status -eq 0 -or $status -eq 429 -or $status -ge 500)
            if (-not $retry -or $attempt -gt $Retries) {
                throw ('{0} {1} failed (HTTP {2}): {3}' -f $Method, ($Uri -replace '\?.*$', ''), $status, $detail)
            }
            Start-Sleep -Seconds ([int][math]::Pow(2, $attempt) * 2)
        }
    }
}

function ConvertTo-Utf8Json {
    param([string]$Json)
    return , [Text.Encoding]::UTF8.GetBytes($Json)   # the comma keeps byte[] from being unrolled
}

# ------------------------------------------------------------ RFQ server

# POST the CSV file as-is. Stock replaces the whole sap_stock table; Sales is upserted by key.
function Send-SapFileToRfq {
    param($Config, [IO.FileInfo]$File, [ValidateSet('sap_stock', 'sap_sales')] [string]$Type)
    $token = Read-SapSyncSecret -Path $Config.Rfq.TokenFile -EnvName 'RFQ_INTEGRATION_TOKEN'
    $query = 'file=' + [uri]::EscapeDataString($File.Name) + '&date=' + (Get-SapFileDate $File)
    if ($Type -eq 'sap_sales' -and $Config.SalesKeyColumns) {
        $query += '&key=' + [uri]::EscapeDataString((@($Config.SalesKeyColumns) -join ','))
    }
    $uri = '{0}/api/integrations/import/{1}?{2}' -f $Config.Rfq.BaseUrl.TrimEnd('/'), $Type, $query
    $resp = Invoke-SyncHttp -Method POST -Uri $uri -Headers @{ Authorization = "Bearer $token" } `
        -ContentType 'text/csv; charset=utf-8' -Body ([IO.File]::ReadAllBytes($File.FullName)) -TimeoutSec 900
    if ($null -eq $resp -or -not $resp.ok) { throw "RFQ import $Type failed: unexpected reply" }
    return $resp.data
}

# ------------------------------------------------------------ Google auth (service account JWT, RS256)

function ConvertTo-Base64Url {
    param([byte[]]$Bytes)
    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-GoogleAccessToken {
    param([string]$KeyFile)
    if ($script:GoogleToken -and $script:GoogleTokenExpires -gt (Get-Date).AddMinutes(5)) { return $script:GoogleToken }
    if (-not (Test-Path $KeyFile)) { throw "Google service account key not found: $KeyFile" }
    $key = [IO.File]::ReadAllText($KeyFile) | ConvertFrom-Json
    $tokenUri = 'https://oauth2.googleapis.com/token'
    if ($key.PSObject.Properties['token_uri'] -and $key.token_uri) { $tokenUri = $key.token_uri }
    $now = [int][math]::Floor(([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalSeconds)
    $claims = '{{"iss":"{0}","scope":"https://www.googleapis.com/auth/spreadsheets","aud":"{1}","iat":{2},"exp":{3}}}' -f $key.client_email, $tokenUri, $now, ($now + 3600)
    $unsigned = (ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes('{"alg":"RS256","typ":"JWT"}'))) + '.' + (ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($claims)))

    # PKCS#8 PEM -> CNG RSA key (available in .NET Framework 4.6+ and .NET on Windows)
    $der = [Convert]::FromBase64String((($key.private_key -replace '-----[A-Z ]+-----', '') -replace '\s', ''))
    $cng = [Security.Cryptography.CngKey]::Import($der, [Security.Cryptography.CngKeyBlobFormat]::Pkcs8PrivateBlob)
    $rsa = New-Object Security.Cryptography.RSACng($cng)
    try {
        $sig = $rsa.SignData([Text.Encoding]::ASCII.GetBytes($unsigned), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    }
    finally { $rsa.Dispose(); $cng.Dispose() }

    $body = 'grant_type=' + [uri]::EscapeDataString('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + $unsigned + '.' + (ConvertTo-Base64Url $sig)
    $r = Invoke-SyncHttp -Method POST -Uri $tokenUri -ContentType 'application/x-www-form-urlencoded' -Body $body
    $script:GoogleToken = $r.access_token
    $script:GoogleTokenExpires = (Get-Date).AddSeconds([int]$r.expires_in)
    return $script:GoogleToken
}

# ------------------------------------------------------------ Google Sheets helpers

$SheetsApi = 'https://sheets.googleapis.com/v4/spreadsheets'

function Invoke-Sheets {
    param($Config, [string]$Method, [string]$Path, [string]$Json)
    $token = Get-GoogleAccessToken -KeyFile $Config.GoogleSheets.ServiceAccountKeyFile
    $body = $null
    if ($Json) { $body = ConvertTo-Utf8Json $Json }
    return Invoke-SyncHttp -Method $Method -Uri ($SheetsApi + '/' + $Path) -Headers @{ Authorization = "Bearer $token" } `
        -ContentType 'application/json; charset=utf-8' -Body $body
}

function Get-QuotedSheet { param([string]$Title) return "'" + $Title.Replace("'", "''") + "'" }
function Get-EncodedRange { param([string]$Range) return [uri]::EscapeDataString($Range) }

function Get-ColumnLetter {
    param([int]$Index) # 1-based
    $s = ''
    while ($Index -gt 0) { $m = ($Index - 1) % 26; $s = [char](65 + $m) + $s; $Index = [int][math]::Floor(($Index - 1) / 26) }
    return $s
}

function ConvertTo-JsonString { param([string]$Value) return [System.Web.HttpUtility]::JavaScriptStringEncode($Value, $true) }

# Rows [Start, Start+Count) of a List[string[]] -> JSON 2-D array text (fast; ConvertTo-Json is slow on big tables)
function ConvertTo-ValuesJson {
    param($Rows, [int]$Start, [int]$Count)
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append('[')
    for ($i = $Start; $i -lt $Start + $Count; $i++) {
        if ($i -gt $Start) { [void]$sb.Append(',') }
        [void]$sb.Append('[')
        $r = $Rows[$i]
        for ($j = 0; $j -lt $r.Length; $j++) {
            if ($j -gt 0) { [void]$sb.Append(',') }
            [void]$sb.Append([System.Web.HttpUtility]::JavaScriptStringEncode([string]$r[$j], $true))
        }
        [void]$sb.Append(']')
    }
    [void]$sb.Append(']')
    return $sb.ToString()
}

# SAP date-times as Export-Csv writes them ("10/16/2024 12:00:00 AM", or invariant "10/16/2024 00:00:00",
# always month first) -> "2024-10-16" (or "2024-10-16 13:05:00"). A Thai-locale sheet would otherwise read
# 10/05/2024 as 10 May; ISO dates are read the same way in every locale.
$SapDateTime = New-Object regex '^(\d{1,2})/(\d{1,2})/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})(?: ([AP]M))?$', 'IgnoreCase'
function ConvertTo-IsoDateTime {
    param([string]$Value)
    $m = $SapDateTime.Match($Value)
    if (-not $m.Success) { return $Value }
    $h = [int]$m.Groups[4].Value
    if ($m.Groups[7].Success) { $h = ($h % 12) + $(if ($m.Groups[7].Value -ieq 'PM') { 12 } else { 0 }) }
    $day = '{0}-{1:D2}-{2:D2}' -f $m.Groups[3].Value, [int]$m.Groups[1].Value, [int]$m.Groups[2].Value
    if ($h -eq 0 -and $m.Groups[5].Value -eq '00' -and $m.Groups[6].Value -eq '00') { return $day }
    return '{0} {1:D2}:{2}:{3}' -f $day, $h, $m.Groups[5].Value, $m.Groups[6].Value
}

# Values are written USER_ENTERED so numbers and dates become real numbers in the sheet. Two exceptions
# get a leading apostrophe (stored as text): the configured TextColumns (item codes, barcodes keep their
# leading zeros / all 13 digits) and anything starting with = + @ (never run SAP text as a formula).
function Format-SheetRow {
    param([string[]]$Row, [bool[]]$IsText)
    $out = New-Object string[] $Row.Length
    for ($j = 0; $j -lt $Row.Length; $j++) {
        $v = ConvertTo-IsoDateTime ([string]$Row[$j])
        if ($v -and (($j -lt $IsText.Length -and $IsText[$j]) -or $v -match '^[=+@]')) { $v = "'" + $v }
        $out[$j] = $v
    }
    return , $out
}

function Get-TextColumnFlags {
    param([string[]]$Header, $TextColumns)
    $names = @(@($TextColumns) | Where-Object { $_ } | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() })
    $flags = New-Object bool[] $Header.Length
    for ($j = 0; $j -lt $Header.Length; $j++) { $flags[$j] = $names -contains $Header[$j].Trim().ToLowerInvariant() }
    return , $flags
}

# Returns the tab's properties, creating the tab when it does not exist.
function Get-OrAddSheet {
    param($Config, [string]$SpreadsheetId, [string]$Title)
    $info = Invoke-Sheets $Config GET ($SpreadsheetId + '?fields=' + [uri]::EscapeDataString('sheets.properties(sheetId,title,gridProperties)'))
    foreach ($s in @($info.sheets)) { if ($s.properties.title -eq $Title) { return $s.properties } }
    $json = '{"requests":[{"addSheet":{"properties":{"title":' + (ConvertTo-JsonString $Title) + '}}}]}'
    $r = Invoke-Sheets $Config POST ($SpreadsheetId + ':batchUpdate') $json
    Write-SyncLog INFO "Created tab '$Title'"
    return $r.replies[0].addSheet.properties
}

# Grow (never shrink) the grid: deleting rows would shift ranges that other tabs' formulas point at.
function Expand-SheetGrid {
    param($Config, [string]$SpreadsheetId, $Props, [int]$Rows, [int]$Columns)
    $g = $Props.gridProperties
    $needRows = [math]::Max([int]$g.rowCount, $Rows)
    $needCols = [math]::Max([int]$g.columnCount, $Columns)
    if ($needRows -eq [int]$g.rowCount -and $needCols -eq [int]$g.columnCount) { return }
    $json = '{"requests":[{"updateSheetProperties":{"properties":{"sheetId":' + $Props.sheetId +
        ',"gridProperties":{"rowCount":' + $needRows + ',"columnCount":' + $needCols + '}},"fields":"gridProperties(rowCount,columnCount)"}}]}'
    Invoke-Sheets $Config POST ($SpreadsheetId + ':batchUpdate') $json | Out-Null
}

# ------------------------------------------------------------ Stock -> Google Sheet (replace the whole tab)

function Update-StockSheet {
    param($Config, [IO.FileInfo]$File)
    $gs = $Config.GoogleSheets
    $rows = Read-SapCsv $File.FullName
    $header = $rows[0]
    $flags = Get-TextColumnFlags $header $gs.TextColumns
    for ($i = 1; $i -lt $rows.Count; $i++) { $rows[$i] = Format-SheetRow $rows[$i] $flags }

    $id = $gs.Stock.SpreadsheetId
    $props = Get-OrAddSheet $Config $id $gs.Stock.Sheet
    $tab = Get-QuotedSheet $gs.Stock.Sheet
    Invoke-Sheets $Config POST ($id + '/values/' + (Get-EncodedRange $tab) + ':clear') '{}' | Out-Null
    Expand-SheetGrid $Config $id $props $rows.Count $header.Length

    $chunk = [int]$gs.ChunkRows
    for ($start = 0; $start -lt $rows.Count; $start += $chunk) {
        $n = [math]::Min($chunk, $rows.Count - $start)
        $range = Get-EncodedRange ($tab + '!A' + ($start + 1))
        $json = '{"values":' + (ConvertTo-ValuesJson $rows $start $n) + '}'
        Invoke-Sheets $Config PUT ($id + '/values/' + $range + '?valueInputOption=USER_ENTERED') $json | Out-Null
    }
    return ($rows.Count - 1)
}

# ------------------------------------------------------------ Sales -> Google Sheet (append new lines only)

# NDBS_ReportSales is a rolling window (about two years) re-exported every day, so most of its lines are
# already in the sheet. Each written row carries a RowKey (last column): the SalesKeyColumns joined with '|',
# or a hash of the whole row when no key columns are configured. The report has no line number, so a key
# repeated within one file (same item twice on a document) gets '#2', '#3'... in file order (the RFQ
# server does the same). Only rows whose key is not in the sheet yet are appended.
function Get-SalesRowKey {
    param([string[]]$Row, [int[]]$KeyIdx, [Security.Cryptography.SHA1]$Sha)
    if ($KeyIdx.Length -gt 0) {
        $parts = New-Object string[] $KeyIdx.Length
        for ($k = 0; $k -lt $KeyIdx.Length; $k++) { $parts[$k] = $Row[$KeyIdx[$k]] }
        return ($parts -join '|')
    }
    $bytes = $Sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($Row -join [char]31)))
    return 'h:' + (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Add-SalesToSheet {
    param($Config, [IO.FileInfo]$File)
    $gs = $Config.GoogleSheets
    $rows = Read-SapCsv $File.FullName
    $header = [string[]]$rows[0]
    # 'Sales {yyyy-MM}' -> one tab per month (named after the file's date)
    $title = [regex]::Replace($gs.Sales.Sheet, '\{([^}]+)\}', { param($m) $File.LastWriteTime.ToString($m.Groups[1].Value, $Invariant) })
    $id = $gs.Sales.SpreadsheetId
    $tab = Get-QuotedSheet $title
    $props = Get-OrAddSheet $Config $id $title

    $keyIdx = @()
    foreach ($k in @($Config.SalesKeyColumns)) {
        if (-not $k) { continue }
        $idx = -1
        for ($j = 0; $j -lt $header.Length; $j++) { if ($header[$j].Trim() -ieq ([string]$k).Trim()) { $idx = $j; break } }
        if ($idx -lt 0) { throw "Key column '$k' is not in $($File.Name). Columns: $($header -join ', ')" }
        $keyIdx += $idx
    }

    # Header check: the tab must hold this file's columns + RowKey (or be empty).
    $expected = @($header) + 'RowKey'
    $top = Invoke-Sheets $Config GET ($id + '/values/' + (Get-EncodedRange ($tab + '!1:1')))
    $existing = @()
    if ($top.PSObject.Properties['values']) { $existing = @($top.values[0]) }
    $keyCol = Get-ColumnLetter $expected.Count
    $known = New-Object 'System.Collections.Generic.HashSet[string]'
    if ($existing.Count -eq 0) {
        Expand-SheetGrid $Config $id $props 2 $expected.Count
        $json = '{"values":[[' + ((@($expected) | ForEach-Object { ConvertTo-JsonString $_ }) -join ',') + ']]}'
        Invoke-Sheets $Config PUT ($id + '/values/' + (Get-EncodedRange ($tab + '!A1')) + '?valueInputOption=RAW') $json | Out-Null
    }
    else {
        if ((@($existing) -join "`t") -ne (@($expected) -join "`t")) {
            throw "Tab '$title' has different columns from $($File.Name). Rename that tab (the script starts a new one) or fix its header row. Sheet: $($existing -join ', ') | File: $($header -join ', ')"
        }
        $col = Invoke-Sheets $Config GET ($id + '/values/' + (Get-EncodedRange ($tab + '!' + $keyCol + '2:' + $keyCol)) + '?majorDimension=COLUMNS')
        if ($col.PSObject.Properties['values']) { foreach ($k in @($col.values[0])) { [void]$known.Add([string]$k) } }
    }

    $sha = [Security.Cryptography.SHA1]::Create()
    $flags = Get-TextColumnFlags $header $gs.TextColumns
    $new = New-Object 'System.Collections.Generic.List[string[]]'
    $seen = New-Object 'System.Collections.Generic.Dictionary[string,int]'
    try {
        for ($i = 1; $i -lt $rows.Count; $i++) {
            $key = Get-SalesRowKey $rows[$i] $keyIdx $sha
            if (-not $key.Replace('|', '')) { Write-SyncLog WARN "Sales row $($i + 1): empty key, skipped"; continue }
            $n = 1
            if ($seen.ContainsKey($key)) { $n = $seen[$key] + 1 }
            $seen[$key] = $n
            if ($n -gt 1) { $key = $key + '#' + $n }
            if (-not $known.Add($key)) { continue }   # already in the sheet
            $out = Format-SheetRow ([string[]](@($rows[$i]) + ("'" + $key))) $flags
            $new.Add($out)
        }
    }
    finally { $sha.Dispose() }

    $chunk = [int]$gs.ChunkRows
    for ($start = 0; $start -lt $new.Count; $start += $chunk) {
        $n = [math]::Min($chunk, $new.Count - $start)
        $json = '{"values":' + (ConvertTo-ValuesJson $new $start $n) + '}'
        Invoke-Sheets $Config POST ($id + '/values/' + (Get-EncodedRange ($tab + '!A1')) + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS') $json | Out-Null
    }
    return [pscustomobject]@{ Tab = $title; FileRows = $rows.Count - 1; Appended = $new.Count }
}

Export-ModuleMember -Function Initialize-SapSync, Write-SyncLog, Read-SapSyncSecret, Get-SapCsvFile, Read-SapCsv, Get-SapFileDate,
    Send-SapFileToRfq, Get-GoogleAccessToken, Update-StockSheet, Add-SalesToSheet
