# RFQ — ขออนุมัติราคาพิเศษ (Special Price Approval)

A web app for the GT / Boonthavorn special-price (RFQ) process. All data stays in Google Sheets.
Runs as a **Google Apps Script web app** bound to the spreadsheet
*"RFQ MGR GT ไฟล์ขออนุมัติราคาพิเศษหรือโครงการ / Price Group GT"*.

| Who | What they can do |
|---|---|
| **Sales** (anyone @eve.co.th) | ตรวจราคา: live price check that shows the indicator only (OKAY / LOW / VERY LOW / ขาดทุน), never cost or %MU · submit multi-item requests · track their own requests and cancel pending ones · search currently valid approved prices |
| **Supervisor** (`pak.m@`) | Everything above, plus: approval inbox with cost, net, gain, %MU and history for the same product or customer · bulk approve/reject · view and filter all requests, export CSV · dashboard |
| **Admin** (`akrawat@`) | Everything above, plus: thresholds/settings, product refresh, legacy import |

Every request needs a supervisor's decision. Email goes to approvers on submit, and to the requester on decision.

## How the numbers are calculated

The maths is the same as the old `_CalEngine` sheets:

```
Net incl. VAT   GT EVE / GT FOSTER / BT FOSTER : Special × (1−D1) × (1−D2) × (1−D3)
                BT EVE                          : Normal × (1−GP) − (Normal − Special)
Net ex VAT    = Net incl. VAT ÷ 1.07
Gain          = Net ex VAT − Cost
%MU           = Gain ÷ Net ex VAT
Indicator     < 18% ขาดทุน · ≤ 20% VERY LOW · ≤ 25% LOW · > 25% OKAY      (editable in APP_Settings)
```

Cost and %MU are **saved with the request** when it is submitted, so later cost changes don't rewrite history.

## Sheets the app creates

| Sheet | Purpose |
|---|---|
| `APP_Requests` | One row per item. Permanent Req. Id (`GT.0437`, `GT.FOSTER.0083`, `BT.…`, `BTFOSTER.…`), a BatchId per submission, snapshot of cost/MU, status, dates, approver |
| `APP_Products` | Flat product master rebuilt from `_Cost&Price` + `_CalDummy` (daily at 06:00, or from the Admin page) |
| `APP_Channels` | One row per sales channel: brand, ID prefix, formula (`MULTIPLY` / `GP_ON_NORMAL`), up to 3 discount fields with label/default/editable. **Add a row here for a new channel with a different GP method** |
| `APP_Users` | Email → `SALES` / `SUPERVISOR` / `ADMIN`, Active. Anyone not listed is SALES |
| `APP_Settings` | VAT, MU thresholds, validity days, extra notify emails |
| `APP_Log` | Audit trail (submit / approve / reject / cancel / import / settings) |

The old tabs (`GT.EVE_RFQ`, `GT.FOSTER_RFQ`, …) are left untouched and serve as an archive.

## Deploy (one time, about 10 minutes)

1. Open the GT spreadsheet → **Extensions → Apps Script**.
2. If there is old code there, copy it somewhere safe and send it to me so I can carry over anything it does. Then delete the old files.
3. Create one file in the editor for each file in `src/`, using the same name:
   - Script files: `Config`, `Db`, `Pricing`, `Products`, `Auth`, `Requests`, `Notify`, `Dashboard`, `Migrate`, `Setup`, `Code`.
   - HTML files: `Index`, `Styles`, `App`.
   - Paste each file's contents in.
   - Under **Project Settings**, turn on *Show "appsscript.json"*, then paste `src/appsscript.json`.
   - *(Or use [clasp](https://github.com/google/clasp): `clasp clone <scriptId> --rootDir src` then `clasp push`.)*
4. In the editor, select **`setupApp`** → **Run** → allow the permissions. This creates the APP_ sheets and loads products.
5. Reload the spreadsheet. Use the new **RFQ App → Import old RFQ tabs** menu to bring in the existing GT and BT requests (safe to run again).
6. **Deploy → New deployment → Web app**:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone within eve.co.th**
7. Share the web-app URL with the team, and add it as a bookmark or home-screen shortcut on phones.

After any code change: **Deploy → Manage deployments → Edit → Version: New version**. The URL stays the same.

### Notes on the import
- IDs, status, approver and dates are kept.
- Old rows never stored cost, so cost and %MU are calculated from **today's** product master. Each imported row is flagged.
- Undecided old rows whose end date has passed become **Closed**, so they don't flood the approval inbox.
- Discounts typed as whole numbers by mistake (e.g. `8` meaning 800%) are converted to `8%` and flagged.

## Development

```bash
npm test          # runs the real src/*.gs against an in-memory Sheets mock (test/gas-mock.js)
npm run preview   # http://localhost:8080/?as=sales1@eve.co.th  — or ?as=pak.m@eve.co.th / akrawat@eve.co.th
```

Test fixtures are synthetic. No real cost data is stored in the repo.
