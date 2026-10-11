# RFQ — ขออนุมัติราคาพิเศษ (Special Price Approval)

Sales staff check a special price and request approval. Supervisors approve requests and monitor discount and margin (%MU) across every price group.

| Who | Can do |
|---|---|
| **Sales** (anyone @eve.co.th) | Price check with a live indicator only (never cost / %MU) · multi-item requests · my requests · search approved prices that are still valid |
| **Supervisor** | Approval inbox with cost, gain, %MU and history · bulk approve/reject (not their own requests) · all requests + CSV · dashboard |
| **Admin** | Settings, users & roles, CSV imports (cost masters, old sheet tabs), audit log |

## Price groups → channels
Pick a **price group**, then a **channel**. Each channel carries its own formula, discount fields and minimum GP. Each group carries its own cost source and MU thresholds. Everything lives in [`server/config/price-groups.json`](server/config/price-groups.json).

| Group | Channels | Cost from | Net price | MU indicator |
|---|---|---|---|---|
| **GT** ร้านค้า/โครงการ | GT-EVE, GT-FOSTER | product master | special × (1−GP)(1−D2)(1−D3) | <18 ขาดทุน · ≤20 VERY LOW · ≤25 LOW |
| **BT** บุญถาวร | BT-EVE, BT-FOSTER | product master | EVE: normal×(1−27.83%) − (normal−special) · FOSTER: special×(1−27.83%) | same as GT |
| **OFFI** Online/Offline | Shopee, Lazada (GP ≥ 37%), TikTok, HomePro, LINE, Web, Showroom, Outlet (GP ≥ 20%) | product master | special × (1−GP) | same as GT |
| **JS** Joseph Space | TH, Worktop | cost per project ID | special × (1−discount) | <18 VERY LOW · <23 LOW |
| **JS_OVS** Joseph Space import | OVS | landed cost from factory RMB (freight, tax, markup, MKT fee, delivery, install, error) | special × (1−discount) | ≤15 ขาดทุน · ≤18 VERY LOW · ≤23 LOW |

`%MU = (net ex VAT − cost) ÷ net ex VAT`. Cost and %MU are saved with each request. Every formula is tested against numbers taken from the source sheets ([`server/test/pricing.test.js`](server/test/pricing.test.js)).

To add a channel or group: edit the JSON in a pull request. The AI reviews it, you merge, and it deploys. No code change is needed.

## Architecture
- **App**: Node.js 22 + Express + PostgreSQL 16, in Docker on the Hostinger VPS. Google sign-in, restricted to eve.co.th.
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
