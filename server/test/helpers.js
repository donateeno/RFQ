'use strict';
/**
 * Test harness: a fresh schema in TEST_DATABASE_URL per test file, the real Express app on a
 * random port, and a tiny cookie-keeping client. Fixtures are synthetic (no real cost data).
 */
const { createPool, migrate } = require('../src/db');
const { seed } = require('../src/seed');
const { createApp } = require('../src/app');
const { load } = require('../src/config');
const { importData } = require('../src/rfq/importers');

const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://rfq@localhost:54329/rfq_test';

async function startApp() {
  const db = createPool(DB_URL);
  await db.query('drop schema if exists public cascade; create schema public;');
  await migrate(db);
  const cfg = load({
    NODE_ENV: 'test', DEV_LOGIN: '1', DATABASE_URL: DB_URL, GOOGLE_CLIENT_ID: 'test-client', INTEGRATION_TOKEN: 'test-token',
    BOOTSTRAP_ADMINS: 'akrawat@eve.co.th, admin2@eve.co.th', BOOTSTRAP_SUPERVISORS: 'pak.m@eve.co.th', COST_VIEWERS: 'akrawat@eve.co.th', APP_BASE_URL: 'https://rfq.example.com'
  });
  await seed(db, cfg);
  const mail = [];
  const googleTokens = {};
  const app = createApp({
    db, cfg, notify: (m) => { if (m) mail.push(m); },
    logger: { info() {}, error: (e) => console.error(e) },
    verifyGoogleToken: async (t) => { if (!googleTokens[t]) throw new Error('bad token'); return googleTokens[t]; }
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    db, cfg, mail, base, googleTokens,
    client: (email) => new Client(base, email),
    seedFixtures: () => seedFixtures(db),
    close: async () => { await new Promise((r) => server.close(r)); await db.end(); }
  };
}

class Client {
  constructor(base, email) { this.base = base; this.email = email; this.cookie = ''; }
  async login() {
    const r = await fetch(this.base + '/auth/dev?email=' + encodeURIComponent(this.email), { redirect: 'manual' });
    this.cookie = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
    if (!this.cookie) throw new Error('login failed for ' + this.email);
    return this;
  }
  async raw(fn, args, headers) {
    const r = await fetch(this.base + '/api/rpc/' + fn, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-RFQ': '1', Cookie: this.cookie }, headers || {}),
      body: JSON.stringify({ args: args || [] })
    });
    return { status: r.status, body: await r.json() };
  }
  /** Calls an RPC function; throws Error(message) on failure like the browser does. */
  async call(fn, ...args) {
    const { status, body } = await this.raw(fn, args);
    if (!body.ok) { const e = new Error(body.error); e.status = status; throw e; }
    return body.data;
  }
}

// --------------------------------------------------------------- fixtures (shaped like the real tabs)

const COST_PRICE = [
  ["EVE's Model", 'ราคาต้นทุนนำเข้า/หน่วย', 'Promotion Price', '', 'MODEL NAME', 'COST', 'GT HOTPRICE', '', 'REF. CODE', 'MODEL DESCRIPTION', 'SMGCOST', 'Retail Price'],
  ['HC-DEMO-90', '7,000.00', '19,990', '', 'HC-DEMO-90', '7100', '18,990.00', '', '1144061', 'S1000 SINK 440x500 1RH/B', '3300', '7590'],
  ['SINK-DEMO 760/510', '3000', '7990', '', 'SET-A + SET-B', '5200', '8990', '', '2451090', 'GHOST HOOD 90 cm', '60000', '147,590'],
  ['FAUCET-DEMO', '1500', '3990', '', '#N/A', '', '', '', '1129000', 'S1000 SINK 290x500', '2700', '6390'],
  ['NOCOST-ITEM', '', '2990', '', '', '', '', '', '', '', '', '']
];
const CAL_DUMMY = [
  ['DUMMY SET NAME', 'SKUs1', 'COST1', 'SKUs2', 'COST2', 'SKUs3', 'COST3', 'SKUs4', 'COST4', 'SKUs5', 'COST5', 'Total Cost', '', 'PRICE1', 'PRICE2', 'PRICE3', 'PRICE4', 'PRICE5', 'TOTAL PRICE'],
  ['HC-DEMO-90 + FAUCET-DEMO', 'HC-DEMO-90', '7000', 'FAUCET-DEMO', '1500', 'NON', '0', 'NON', '0', 'NON', '0', '8,500.00', '', '19990', '3990', '', '', '', '23,980']
];
const PROJECT_COSTS = [
  ['project_key', 'customer', 'description', 'cost'],
  ['3FO3QG6B0RQ1_01', 'คุณดิว', 'Kitchen', '177265.35'],
  ['WKTP-ANDY', 'คุณ Andy', 'หิน', '50000']
];
const MANUAL_CAL = [
  ['Joseph Space cost & price calculation for oversea product', '', '', 'USD:THB', '32.0762'],
  ['Ref. ItmCode', 'Ref. Factory', 'ItmDescrption', 'CBM/TON', 'FactoryUSD', 'FactoryRMB', 'Incoterm', 'ExCh. Rate', 'FactoryTHB', 'BP Disc.', 'THB Net Price', '', 'Freight Charge', 'Freight Exp.', 'Import Tax', 'Tax or VAT AMT', '% Mark up', 'Mark up Amount', 'Misc. Charge'],
  ['JS00032', '', 'HENZELL KITCHEN, JAPANDI', '', '', '61,296.88', 'FOB', '5.2', '318,743.78', '44%', '178,496.51', '', '5.49%', '', '0%', '', '12%', '', '0.00']
];

async function seedFixtures(db) {
  const today = isoDay(0);
  await importData(db, { type: 'cost_price_sheet', values: COST_PRICE, today, priceList: { name: 'APR26', effectiveFrom: isoDay(-60) } });
  await importData(db, { type: 'cal_dummy_sheet', values: CAL_DUMMY, today });
  await importData(db, { type: 'project_costs', values: PROJECT_COSTS, group: 'JS', today });
  await importData(db, { type: 'landed_items', values: MANUAL_CAL, group: 'JS_OVS', today });
}

function isoDay(offset) {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
/** dd/mm/yy (the 2-digit-year format used in the old sheets) */
function ddmmyy(offset) {
  const [y, m, d] = isoDay(offset).split('-');
  return `${d}/${m}/${y.slice(2)}`;
}
/** m/d/yyyy (the 4-digit-year format used in the old sheets) */
function mdyyyy(offset) {
  const [y, m, d] = isoDay(offset).split('-');
  return `${Number(m)}/${Number(d)}/${y}`;
}

module.exports = { startApp, isoDay, ddmmyy, mdyyyy, COST_PRICE };
