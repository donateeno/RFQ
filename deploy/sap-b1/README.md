# SAP B1 reports → RFQ database + Google Sheets

These scripts run on the **SAP Windows server**, after the HANA export scripts
(`ExportCSVByQuery_ReportAll.ps1`, `_ReportStock.ps1`, `_ReportSales.ps1`).

## Where the export files are

All three export scripts use the same folders (`$CsvDir` / `$LogDir`):

| What | Folder | File name |
|---|---|---|
| Stock (`CALL "SBOSMG"."NDBS_ReportStock"`) | `D:\NTT_Interface\NTT_ShellExportCsv\CSV\` | `Stock_yyMMdd.csv` |
| Sales (`CALL "SBOSMG"."NDBS_ReportSales"`) | `D:\NTT_Interface\NTT_ShellExportCsv\CSV\` | `Sales_yyMMdd.csv` |
| Export log | `D:\NTT_Interface\NTT_ShellExportCsv\Logs\` | `log_yyyyMMdd.txt` |

The scripts only write CSV, not .xlsx. The files are UTF-8 with a BOM and every field is quoted
(`Export-Csv -NoTypeInformation`). Sizes on 16/10/2026: Stock 3,594 rows; Sales 129,925 rows (38 MB) covering
the last two years (16/10/2024 to 16/10/2026), columns
`DocDate, DocNum, CardCode, CardName, Channel, SalesEmployee, Brand, ItemCode, Dscription, Quantity, NetAmount, DocType`
(`DocType` = Invoice / Credit Note). Dates come out US-style (`10/16/2024 12:00:00 AM`); both uploads
convert them to `2024-10-16`.

**Nothing schedules the export.** Until 16/10/2026 the newest files were from a manual test on 20/11/2025.
`Run-SapDailySync.ps1` runs the export itself, so registering it (step 7 below) fixes that. `yyMMdd` follows the machine's culture, so on a Thai-locale server
it uses the Buddhist year (`Stock_691014.csv`). The uploader handles both.

## What it does

```
Run-SapDailySync.ps1
 ├─ ExportCSVByQuery_ReportAll.ps1      (optional, ExportScript in the config)
 ├─ Upload-SapToRfq.ps1                 Stock → sap_stock (table replaced)
 │                                      Sales → sap_sales (upsert by key: new lines added, changed lines refreshed)
 └─ Upload-SapToGoogleSheets.ps1        Stock → "Stock" tab cleared and rewritten
                                        Sales → new lines appended under the last row of the "Sales" tab
```

* It uploads **today's** files only (`RequireTodayFile`). If the export fails, yesterday's stock is never pushed.
* Each target runs separately. The exit code is 1 if any target failed, which shows up in Task Scheduler.
* It writes its log to `sap_sync_yyyyMMdd.txt`, next to the export log.

### Sales: the rolling file is appended without duplicates

`Sales_yyMMdd.csv` holds about the last two years and is re-exported every day, so each file repeats the
lines already sent. Each line gets a key built from `SalesKeyColumns` (default `DocType` + `DocNum` +
`ItemCode`). The report has no line number, so when the same item appears twice on one document the
second line's key gets `#2`, the third `#3`, in file order. Asking whoever maintains `NDBS_ReportSales` to
add `LineNum` would make the key exact; then use `DocType, DocNum, LineNum`.

* **Google Sheet**: the last column, `RowKey`, holds the key. The script only appends lines whose key is
  not in the tab yet, so it is safe to run several times a day. If a line changes in SAP after it was
  appended, the sheet keeps the old version. The RFQ database does update it.
* The first upload writes all ~130,000 lines (about 1.7 million cells); after that only the new day's lines.
  A Google spreadsheet holds at most 10 million cells, which this tab reaches in roughly ten years.
* Lines that drop out of the two-year window stay in the sheet and in the database.
* If the report's columns change, the script stops with a clear error instead of appending misaligned
  rows. Rename the old tab and the script starts a new one.

## One-time setup on the Windows server

1. **Copy** this folder, e.g. to `D:\NTT_Interface\SapSync\`.
2. **Check the CSV header** if the report changes: `Get-Content D:\NTT_Interface\NTT_ShellExportCsv\CSV\Sales_*.csv -TotalCount 1`.
   `SalesKeyColumns` must name columns that exist; `TextColumns` lists the code columns that must keep
   leading zeros (item code, customer code).
3. **Config**: copy `sap-sync.config.example.psd1` to `sap-sync.config.psd1` and fill it in.
4. **RFQ token**: as the account that will run the task, run
   `.\Set-SapSyncSecret.ps1 -Path D:\NTT_Interface\SapSync\rfq-token.secret`
   and paste `INTEGRATION_TOKEN` from the RFQ server's `.env`. The file is DPAPI-encrypted for that user.
5. **Google service account** (Google Cloud console → IAM → Service accounts):
   enable the *Google Sheets API*, create a service account and add a JSON key. Save the key at the path
   in `ServiceAccountKeyFile`, then **share the spreadsheet(s) with the account's `client_email` as Editor**.
   Limit the key file's NTFS permissions to the task account and administrators.
6. **Test** by hand:
   ```powershell
   .\Upload-SapToRfq.ps1 -Report Stock
   .\Upload-SapToGoogleSheets.ps1 -Report Sales
   .\Run-SapDailySync.ps1 -SkipExport
   ```
7. **Schedule** it from an elevated PowerShell:
   `.\Register-SapSyncTask.ps1 -At 06:30 -User EVE\svc_sapsync`
   If the export already has its own scheduled task, set `ExportScript = ''` and schedule this sync after it.

Requirements: Windows PowerShell 5.1 (.NET 4.6+) or PowerShell 7, and outbound HTTPS to the RFQ server,
`oauth2.googleapis.com` and `sheets.googleapis.com`. No extra modules are needed.

## Notes

* **Security**: the export scripts contain the HANA `SYSTEM` password in plain text. Do not commit them.
  Consider a read-only HANA user for the two procedures, and change that password.
* The sales report may hold cost or gross-profit columns. In the RFQ database they stay in
  `sap_sales.data`, and no screen shows them yet. Any screen that does must follow CLAUDE.md rule 1.
  The Google Sheet shows everything the report contains, so share it accordingly.
* Dates are sent as `yyyy-MM-dd`, which Google reads correctly in any spreadsheet locale. Numbers use
  `.` as the decimal point, so keep the spreadsheet locale on one that does too (Thailand or US).
* Lines entered after the day's last export arrive with the next run; schedule it more than once a day
  if the sheet must be fresher.
