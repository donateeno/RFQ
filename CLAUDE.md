# CLAUDE.md — guidance for AI agents (Claude Code, OpenClaw, the PR reviewer)

EVE special-price (RFQ) request & approval system. Sales staff check a price and request approval;
supervisors approve and monitor margin (%MU). Thai UI, Thai business terms.

## Layout
- `server/` — the production app (Node 22, Express 5, PostgreSQL 16). **All new work goes here.**
  - `config/price-groups.json` — price groups → channels, formulas, discounts (default/min/max), MU indicator rules. Source of truth, synced to the DB on start.
  - `src/pricing.js` — pure pricing maths. `src/rfq/service.js` — business logic; every function in `rpc` is browser-callable.
  - `src/rfq/importers.js` — CSV / n8n imports (cost masters, legacy sheet tabs). `src/rfq/notifications.js` — email payloads for n8n.
  - `migrations/*.sql` — append-only. `public/` — static browser app (no build step, ES5-style, no framework).
  - `test/` — `node:test` against a real PostgreSQL (`TEST_DATABASE_URL`).
- `apps-script/` — interim Google Apps Script version. Frozen: bug fixes only.
- `deploy/` — docker compose, proxy, backup, n8n workflows. `.github/workflows/` — CI, Claude review, deploy.

## Commands
```bash
cd server
npm ci
TEST_DATABASE_URL=postgres://rfq:rfq@localhost:5432/rfq_test npm test   # wipes that database's public schema
npm run check-config                                                      # validates price-groups.json
PREVIEW_DATABASE_URL=postgres://...rfq_preview node scripts/preview.js     # sample data + dev login on :3000
```

## Non-negotiable rules
1. **Cost confidentiality.** `cost`, `gain`, `mu`, `net*` must never reach a `SALES` user — not in RPC results, bootstrap, emails to requesters, or exports. Use `toView()` / role checks; add a test when touching this.
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
