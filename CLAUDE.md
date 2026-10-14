# CLAUDE.md — guidance for AI agents (Claude Code, OpenClaw, the PR reviewer)

EVE special-price (RFQ) request & approval system. Sales staff check a price and request approval;
supervisors approve and monitor margin (%MU). Thai UI, Thai business terms.

## Layout
- `server/` — the production app (Node 22, Express 5, PostgreSQL 16). **All new work goes here.**
  - `config/price-groups.json` — price groups → channels, formulas, discounts (default/min/max), MU indicator rules. Source of truth, synced to the DB on start.
  - `src/pricing.js` — pure pricing maths. `src/rfq/service.js` — business logic; every function in `rpc` is browser-callable.
  - `src/rfq/importers.js` — CSV / n8n imports (cost masters, legacy sheet tabs). `src/rfq/notifications.js` — email payloads for n8n.
  - Price lists: products belong to a `price_lists` period; each brand uses its newest effective list. Pending requests are re-priced on approval; approved prices keep their snapshot until their end date. Price-list names are case-insensitive (`name_norm`); a new list always needs an explicit date.
  - SMG catalogue (`smg_catalog` import, n8n `rfq-smg-sync.json`): products keyed by barcode with `price_gt/price_dgt/price_bt` (`tiered`); channels pick a tier via `priceTier`; the rule is `pricing.resolveTierPrice` (mirrors SMG MASTER H/I/R).
  - Customer price lookup (`customer_pricing` import from the Customer Price Mapping sheet; tables `price_terms`, `customer_groups`, `group_terms`, `sap_channel_groups`, `customers`): customer → group → price tier → ordered terms via `pricing.applyTerms`. RPC `customerPriceCheck` / `searchCustomers`; returns no cost.
  - Bundles (`bundles`, `bundle_items`): user-built sets priced live from the current list.
  - `migrations/*.sql` — append-only. `public/` — static browser app (no build step, ES5-style, no framework).
  - `test/` — `node:test` against a real PostgreSQL (`TEST_DATABASE_URL`).
- `apps-script/` — interim Google Apps Script version. Frozen: bug fixes only.
- `deploy/` — docker compose, proxy, backup, n8n workflows, `sap-b1/` (PowerShell on the SAP Windows server: Stock/Sales CSV → `sap_stock`/`sap_sales` via `/api/integrations/import/sap_*` and → Google Sheets). `.github/workflows/` — CI, Claude review, deploy.

## Commands
```bash
cd server
npm ci
TEST_DATABASE_URL=postgres://rfq:rfq@localhost:5432/rfq_test npm test   # wipes that database's public schema
npm run check-config                                                      # validates price-groups.json
PREVIEW_DATABASE_URL=postgres://...rfq_preview node scripts/preview.js     # sample data + dev login on :3000
```

## Non-negotiable rules
1. **Cost confidentiality.** `cost`, `gain` and exact `mu` reach **only cost viewers** (`users.can_view_cost`, set from the `COST_VIEWERS` env var — never from the app). Supervisors get `netExVat` + `muBand`; sales get the indicator only. Applies to RPC results, bootstrap, emails, exports and dashboard averages. Use `makeView()` / `canSeeCost()`; add a test when touching this. `priceCheck` is logged in `price_checks` (never cost) and rate-limited per user/item to stop cost guessing; keep the guard on any new endpoint that returns an indicator or MU band for a caller-chosen price.
2. **Pricing must match the source sheets.** Any change to formulas or rules needs a test in `test/pricing.test.js` with numbers taken from the sheet it mirrors. Business-rule changes (min GP, thresholds, fixed GP) go in `price-groups.json`, never hard-coded.
3. **Every RPC function checks the role itself** (`approver(ctx)` / `admin(ctx)`). Never trust IDs, prices or discounts from the browser — recompute server-side.
4. **SQL** only with parameters (`$1`), never string-built values. **HTML** in `public/app.js` only through `esc()`.
5. **Migrations** are new numbered files; never edit one that has been merged.
6. Never commit secrets, real cost data or `.env`. Test fixtures are synthetic.
7. Agents work on a branch and open a PR. Never push to `main`, never merge, never run `deploy.sh`.

## Review checklist (used by .github/workflows/claude-review.yml)
- [ ] Confidentiality rule 1 holds for every changed response/email/export.
- [ ] Pricing: formulas/rules changed? Are sheet-derived tests updated? Call out business-rule changes for the owner in plain words.
- [ ] Authorization on new/changed RPC functions; supervisors cannot decide their own requests.
- [ ] Input validation (dates, quantities, discounts within channel min/max), SQL parameters, XSS-safe rendering.
- [ ] Migrations append-only and reversible in practice; no destructive data changes without a backup note.
- [ ] Tests added/updated and meaningful; CI green.
- [ ] Thai UI wording consistent with existing screens.
