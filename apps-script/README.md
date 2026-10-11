# Interim version — Google Apps Script

Runs inside the GT spreadsheet until the VPS app (`../server`) is live. **Frozen: bug fixes only.**
It covers GT and BT (4 channels). OFFI and Joseph Space exist only in the VPS app.

Deploy: open the sheet → Extensions → Apps Script → create one file per file in `src/` (same names), paste,
enable *Show appsscript.json* and paste it → run `setupApp` → menu **RFQ App → Import old RFQ tabs** →
Deploy → Web app (Execute as: Me · Access: anyone within eve.co.th).

Tests: `npm test` (runs the real `.gs` files against an in-memory Sheets mock). Preview: `npm run preview`.
