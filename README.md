# RFQ — ขออนุมัติราคาพิเศษ (Special Price Approval)

Sales staff check a special price and request approval. Supervisors approve requests and monitor discount and margin (%MU) across every price group.

| Who | Can do |
|---|---|
| **Sales** (anyone in `ALLOWED_DOMAIN`: @eve.co.th, @siammanor.com) | Price check with the indicator only · multi-item requests · build & share bundle sets (ชุดเซ็ต) · my requests · approved prices still valid |
| **Supervisor** | Approval inbox with net price, **MU band** (e.g. 20–25%) and history — never cost · bulk approve/reject (not their own) · all requests + CSV · dashboard |
| **Admin** | Settings, price lists, CSV imports, audit log |
| **Owner** (`OWNERS`, default = `COST_VIEWERS`) | Menu เจ้าของระบบ › ผู้ใช้และสิทธิ์: each user's role, whether they see GP % in ราคาตามลูกค้า, and which menus they can open (the server refuses closed menus' functions too) · เจ้าของระบบ › แหล่งข้อมูล: every synced Google Sheet (file link, tab, range, each column read and what for) with the state of its last sync · alerts by email, LINE (`ALERT_LINE_TO`) and an in-app banner when a sync fails, a tab is missing or empty, or nothing synced for `SYNC_STALE_HOURS` |
| **ตาราง GP** (opt-in menu the owner grants per user) | GP tiers with the spread of per-item rates, each customer group's terms and the channel discounts, each with the file / tab / column or row it comes from; GP lookup per item down to the MASTER and WHOLESALE cell. No cost |
| **Cost viewer** (`COST_VIEWERS`, server setting only — currently the owner) | Additionally sees cost, gain and exact %MU everywhere |

ราคาตามลูกค้า shows everyone the net price; the GP % and the amount of each step only to the owner and to users the owner ticks (e.g. pak.m). Nobody gets cost from that tick.

**Price lists:** list prices change every ~4 months. Each import goes into a named list with an effective date (e.g. `AUG26` from 1 Aug), so the next list can be loaded early. Screens show "ราคาใหม่" and "ใหม่" tags until then, and the system switches automatically on the date. Approved special prices stay valid until their own end date. Pending requests are re-priced with the new list and shown that way to the approver. A new list always needs a start date (the n8n sync never creates one that starts today).

**Cost:** one cost per product, used by every price group (GT, BT and OFFI never disagree). Bundles add up the same component costs. **Price checks** by anyone who can't see cost are logged. Checking one item at many prices (a way to guess cost from the indicator) alerts the admins by email, and is refused after a limit (ตั้งค่า: `PRICE_CHECK_ALERT`, `PRICE_CHECK_LIMIT`, `PRICE_CHECK_PER_HOUR`).

**SMG catalogue (EVE / Evercook / Excel):** n8n syncs barcode, model, cost and prices daily from the cost file, the Nationwide pricelist and the SMG MASTER of the current period. Each channel sells at its own price tier: GT, DGT (online) or BT hot price, otherwise the Nationwide promotion price. Discontinued (OR), exclusive (EX), gift (G) and made-to-order (MTO) items carry a warning. Sales can search by model or barcode.

**Customer price lookup (ราคาตามลูกค้า):** sales pick a customer (SAP code or name) or a customer group, plus a product. The app shows the gross price for that group's price tier, then the group's GP tier with each item's own GP % from SMG MASTER (NON PC dealers: the WHOLESALE net price, else T20), then every discount and fee in order (GP, MKT fee, DC fee, platform fees, customer-only terms, per-unit and per-order amounts), the net price with and without VAT, and the total. The data comes from the *Customer Price Mapping* Google Sheet (term library, customer groups, group terms, SAP channel → group, customer overrides, active customers), synced by n8n together with the SMG catalogue. No cost is shown.

**Layout:** a left main menu grouped by module, like the SAP Business One main menu: ราคาและการขาย, คำขออนุมัติราคา, ผู้อนุมัติ and ผู้ดูแลระบบ. On phones it opens as a drawer.

**Bundles:** anyone can combine 2–5 items into a set (like the old DUMMY SET tab). Everyone can use it. Its list price and cost are the sums of its components in the current price list.

## Price groups → channels
Pick a **price group**, then a **channel**. Each channel carries its own formula, discount fields and minimum GP. Each group carries its own cost source and MU thresholds. Everything lives in [`server/config/price-groups.json`](server/config/price-groups.json).

| Group | Channels | Cost from | Net price | MU indicator |
|---|---|---|---|---|
| **GT** ร้านค้า/โครงการ | GT-EVE, GT-FOSTER | product master | special × (1−GP)(1−D2)(1−D3) | <18 ขาดทุน · ≤20 VERY LOW · ≤25 LOW |
| **BT** บุญถาวร | BT-EVE, BT-FOSTER | product master | EVE: normal×(1−27.83%) − (normal−special) · FOSTER: special×(1−27.83%) | same as GT |
| **OFFI** Online/Offline | Shopee, Lazada (GP ≥ 37%), TikTok, HomePro, LINE, Web, Showroom, Outlet (GP ≥ 20%) | product master | special × (1−GP) | same as GT |
| **JS** Joseph Space | TH, Worktop | cost per project ID | special × (1−discount) | <15 ขาดทุน · <18 VERY LOW · <23 LOW |
| **JS_OVS** Joseph Space import | OVS | landed cost from factory RMB (freight, tax, markup, MKT fee, delivery, install, error) | special × (1−discount) | ≤15 ขาดทุน · ≤18 VERY LOW · ≤23 LOW |

`%MU = (net ex VAT − cost) ÷ net ex VAT`. Cost and %MU are saved with each request. Every formula is tested against numbers taken from the source sheets ([`server/test/pricing.test.js`](server/test/pricing.test.js)).

To add a channel or group: edit the JSON in a pull request. The AI reviews it, you merge, and it deploys. No code change is needed.

## Architecture
- **App**: Node.js 22 + Express + PostgreSQL 16, in Docker on the Hostinger VPS. Google sign-in, restricted to the `ALLOWED_DOMAIN` list (eve.co.th, siammanor.com).
- **n8n**: sends the emails, syncs the cost master from Google Sheets daily, and copies all requests into a Google Sheet every 15 minutes for viewing.
- **GitHub**: CI (tests on real PostgreSQL), Claude Code review on every PR, your merge = approval, auto-deploy over SSH.
- Room to grow: static pages go in `server/public/`. Future modules (e.g. document control) go in `server/src/<module>/` with their own migrations, and share the same sign-in, roles and audit log.

Setup guide: **[docs/VPS-SETUP.md](docs/VPS-SETUP.md)** · Rules for AI agents and reviewers: **[CLAUDE.md](CLAUDE.md)**

## Repository
```
server/        production app (src, public, migrations, config, test, Dockerfile)
deploy/        docker-compose (+ traefik | caddy), deploy.sh, backup.sh, .env.example, n8n/
apps-script/   interim Google Apps Script version (frozen; use until the VPS is live)
.github/       CI, Claude review, deploy, CODEOWNERS, PR template
```

## Development
```bash
cd server && npm ci
TEST_DATABASE_URL=postgres://rfq:rfq@localhost:5432/rfq_test npm test
PREVIEW_DATABASE_URL=postgres://rfq:rfq@localhost:5432/rfq_preview node scripts/preview.js   # http://localhost:3000/login → Dev login
```
