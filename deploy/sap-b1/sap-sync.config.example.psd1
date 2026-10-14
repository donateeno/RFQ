# Copy to sap-sync.config.psd1 (same folder) and fill in. That copy is git-ignored.
# Keep this file ASCII (Windows PowerShell 5.1 reads it in the ANSI code page).
@{
    # Where ExportCSVByQuery_ReportAll.ps1 / _ReportStock.ps1 / _ReportSales.ps1 write ($CsvDir, $LogDir)
    CsvDir = 'D:\NTT_Interface\NTT_ShellExportCsv\CSV'
    LogDir = 'D:\NTT_Interface\NTT_ShellExportCsv\Logs'     # this sync writes sap_sync_yyyyMMdd.txt next to log_yyyyMMdd.txt
    StockPrefix = 'Stock'                                   # Stock_yyMMdd.csv
    SalesPrefix = 'Sales'                                   # Sales_yyMMdd.csv

    # $true: upload only today's file (stops yesterday's stock from replacing the sheet when the export failed)
    RequireTodayFile = $true

    # Run-SapDailySync.ps1 runs this export first. Set '' if the export already has its own scheduled task
    # (then schedule this sync after it).
    ExportScript = 'D:\NTT_Interface\NTT_ShellExportCsv\ExportCSVByQuery_ReportAll.ps1'

    # Columns that identify one sales line in NDBS_ReportSales (check the CSV header!). Used by the RFQ
    # database and the Google Sheet to add only new lines from the month-to-date file.
    # @() = the whole row is the key (works, but a changed line is then added again as a new line).
    SalesKeyColumns = @('DocEntry', 'LineNum')

    Rfq = @{
        Enabled   = $true
        BaseUrl   = 'https://rfq.example.com'                           # APP_BASE_URL of the RFQ server
        TokenFile = 'D:\NTT_Interface\SapSync\rfq-token.secret'         # written by Set-SapSyncSecret.ps1
    }

    GoogleSheets = @{
        Enabled = $true
        # JSON key of a Google Cloud service account; share the spreadsheet(s) with its client_email as Editor.
        ServiceAccountKeyFile = 'D:\NTT_Interface\SapSync\google-service-account.json'
        Stock = @{ SpreadsheetId = 'PUT_STOCK_SPREADSHEET_ID'; Sheet = 'Stock' }   # tab is cleared and rewritten
        Sales = @{ SpreadsheetId = 'PUT_SALES_SPREADSHEET_ID'; Sheet = 'Sales' }   # new lines appended at the bottom
        # Sheet = 'Sales {yyyy-MM}' instead starts a new tab every month.

        # Written as text so codes keep leading zeros and barcodes keep all digits. Everything else is
        # entered like typing (numbers/dates become numbers/dates).
        TextColumns = @('ItemCode', 'CodeBars', 'BarCode', 'CardCode', 'DocNum')
        ChunkRows = 5000
    }
}
