'use strict';
/**
 * Local preview with synthetic data. RESETS the database in PREVIEW_DATABASE_URL.
 *   PREVIEW_DATABASE_URL=postgres://rfq@localhost:5432/rfq_preview node scripts/preview.js
 * then open http://localhost:3000/login and use "Dev login".
 */
const { createPool, migrate } = require('../src/db');
const { seed } = require('../src/seed');
const { createApp } = require('../src/app');
const { load } = require('../src/config');
const { importData } = require('../src/rfq/importers');
const service = require('../src/rfq/service');
const { COST_PRICE } = require('../test/helpers');

const url = process.env.PREVIEW_DATABASE_URL;
if (!url) { console.error('Set PREVIEW_DATABASE_URL (this database will be wiped).'); process.exit(1); }

function day(n) {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

(async () => {
  const cfg = load({ NODE_ENV: 'development', DEV_LOGIN: '1', DATABASE_URL: url, PORT: process.env.PORT || '3000',
    BOOTSTRAP_ADMINS: 'akrawat@eve.co.th', BOOTSTRAP_SUPERVISORS: 'pak.m@eve.co.th', GOOGLE_CLIENT_ID: 'preview' });
  const db = createPool(url);
  await db.query('drop schema if exists public cascade; create schema public;');
  await migrate(db);
  await seed(db, cfg);
  const today = day(0);
  await importData(db, { type: 'cost_price_sheet', values: COST_PRICE, today });
  await importData(db, { type: 'project_costs', group: 'JS', today, values: [['project_key', 'customer', 'description', 'cost'], ['3FO3QG6B0RQ1_01', 'คุณดิว', 'Kitchen + Island', '177265.35'], ['JS-NING-WKTP', 'คุณนิ้ง', 'Worktop', '52000']] });
  await importData(db, { type: 'landed_items', group: 'JS_OVS', today, values: [['item_code', 'description', 'factory_rmb', 'exch_rate', 'bp_disc'], ['JS00032', 'HENZELL KITCHEN, JAPANDI', '61296.88', '5.2', '0.44'], ['JS00027', 'HENZELL KITCHEN, RETRO', '59706.94', '5.2', '0.44']] });

  const as = async (email) => ({ db, cfg, notify: () => {}, user: (await db.query('insert into users (email, name) values ($1, $2) on conflict (email) do update set email = excluded.email returning *', [email, email.split('@')[0]])).rows[0] });
  const submit = async (email, channelId, customer, project, lines, end) => service.rpc.submitRequest(await as(email), {
    channelId, customer, project, note: '', startDate: today, endDate: end || day(30),
    lines: lines.map(([k, q, p, d]) => ({ productKey: k, qty: q, specialPrice: p, discounts: d }))
  });
  await submit('sales1@eve.co.th', 'GT_EVE', 'ร้านวัสดุดีมาก', 'คอนโด A', [['HC-DEMO-90', 20, 15990, [0.18, 0.05, 0]], ['FAUCET-DEMO', 20, 2300, [0.18, 0, 0]]]);
  await submit('sales2@eve.co.th', 'OFFI_SHOPEE', 'Shopee Mall', 'แคมเปญ 11.11', [['HC-DEMO-90', 30, 17990, [0.37]]]);
  await submit('sales2@eve.co.th', 'BT_FOSTER', 'บุญถาวร พระราม 2', 'Flash sale', [['2451090', 1, 125000, []]]);
  await submit('designer@eve.co.th', 'JS_TH', 'คุณดิว', 'บ้านเดี่ยว', [['3FO3QG6B0RQ1_01', 1, 242389, [0]]]);
  await submit('designer@eve.co.th', 'JS_OVS', 'คุณเอ', 'Japandi kitchen', [['JS00032', 1, 742990, [0.3]]]);
  const done = await submit('sales1@eve.co.th', 'GT_EVE', 'ร้านทดสอบอนุมัติแล้ว', '', [['SET-A + SET-B', 2, 7490, [0.15, 0, 0]]], day(5));
  await service.rpc.decideRequests(await as('pak.m@eve.co.th').then((c) => Object.assign(c, { user: Object.assign(c.user, { role: 'SUPERVISOR' }) })),
    { ids: done.lines.map((l) => l.id), decision: 'Approved', comment: 'ok' });

  createApp({ db, cfg, notify: (m) => m && console.log('[notify]', m.event, m.to.join(', ')) })
    .listen(cfg.port, () => console.log(`Preview on http://localhost:${cfg.port}/login`));
})().catch((e) => { console.error(e); process.exit(1); });
