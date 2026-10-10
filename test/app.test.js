'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./gas-mock');
const { seed, day } = require('./fixtures');

const ADMIN = 'akrawat@eve.co.th';
const SUP = 'pak.m@eve.co.th';
const SALES = 'sales1@eve.co.th';
const SALES2 = 'sales2@eve.co.th';

function iso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';
function sheetRows(env, name) {
  return env.ctx.readTable_(name).rows;
}

// ---------------- pricing maths ----------------

test('MULTIPLY formula matches the _CalEngine sheet maths', () => {
  const env = createEnv();
  const s = { VAT_RATE: 0.07, MU_LOSS_BELOW: 0.18, MU_VERY_LOW_MAX: 0.2, MU_LOW_MAX: 0.25 };
  const r = env.ctx.calcPricing_({ normalPrice: 19990, specialPrice: 16990, discounts: [0.18, 0, 0], cost: 7000 }, { formula: 'MULTIPLY' }, s);
  // 16990 × 0.82 = 13931.8 ; ÷1.07 = 13020.374 ; gain 6020.374 ; mu 0.46238
  assert.equal(r.netIncVat, 13931.8);
  assert.equal(r.netExVat, 13020.37);
  assert.equal(r.gain, 6020.37);
  assert.equal(r.mu, 0.4624);
  assert.equal(r.indicator, 'OKAY');

  const r2 = env.ctx.calcPricing_({ specialPrice: 5590, discounts: [0.18, 0.03, 0], cost: 3000 }, { formula: 'MULTIPLY' }, s);
  // 5590 × .82 × .97 = 4446.286 ; ÷1.07 = 4155.408 ; mu = 1155.408/4155.408 = .27805 → .2780
  assert.equal(r2.netExVat, 4155.41);
  assert.equal(r2.mu, 0.278);
});

test('GP_ON_NORMAL formula (BT EVE) matches the BT _CalEngine sheet maths', () => {
  const env = createEnv();
  const s = { VAT_RATE: 0.07, MU_LOSS_BELOW: 0.18, MU_VERY_LOW_MAX: 0.2, MU_LOW_MAX: 0.25 };
  const r = env.ctx.calcPricing_({ normalPrice: 19990, specialPrice: 16990, discounts: [0.278304, 0, 0], cost: 7000 }, { formula: 'GP_ON_NORMAL' }, s);
  // 19990 × .721696 = 14426.70 ; − 3000 = 11426.70 ; ÷1.07 = 10679.16 ; mu = 3679.16/10679.16 = .34452
  assert.equal(r.netIncVat, 11426.7);
  assert.equal(r.netExVat, 10679.16);
  assert.equal(r.mu, 0.3445);
});

test('indicator thresholds follow the sheet: <18 loss, ≤20 very low, ≤25 low, else okay', () => {
  const env = createEnv();
  const s = { MU_LOSS_BELOW: 0.18, MU_VERY_LOW_MAX: 0.2, MU_LOW_MAX: 0.25 };
  const f = (m) => env.ctx.indicatorFor_(m, s);
  assert.equal(f(0.1799), 'ขาดทุน');
  assert.equal(f(0.18), 'VERY LOW');
  assert.equal(f(0.2), 'VERY LOW');
  assert.equal(f(0.2001), 'LOW');
  assert.equal(f(0.25), 'LOW');
  assert.equal(f(0.2501), 'OKAY');
  assert.equal(f(-1), 'ขาดทุน');
  assert.equal(f(null), 'NO COST');
});

test('no cost → NO COST indicator', () => {
  const env = createEnv();
  const s = { VAT_RATE: 0.07, MU_LOSS_BELOW: 0.18, MU_VERY_LOW_MAX: 0.2, MU_LOW_MAX: 0.25 };
  const r = env.ctx.calcPricing_({ specialPrice: 1000, discounts: [0.1], cost: null }, { formula: 'MULTIPLY' }, s);
  assert.equal(r.indicator, 'NO COST');
  assert.equal(r.mu, null);
});

// ---------------- setup & products ----------------

test('setupApp creates sheets, seeds config and builds the product master', () => {
  const env = seed(createEnv());
  ['APP_Requests', 'APP_Products', 'APP_Channels', 'APP_Users', 'APP_Settings', 'APP_Log'].forEach((n) => assert.ok(env.active.getSheetByName(n), n));
  const products = sheetRows(env, 'APP_Products');
  const by = (b, k) => products.find((p) => p.Brand === b && p.Key === k);
  // E:G (GT hot price) overrides A:C
  assert.equal(by('EVE', 'HC-DEMO-90').Cost, 7100);
  assert.equal(by('EVE', 'HC-DEMO-90').NormalPrice, 18990);
  assert.equal(by('EVE', 'SINK-DEMO 760/510').NormalPrice, 7990);
  assert.equal(by('EVE', 'SET-A + SET-B').Cost, 5200);
  assert.equal(by('EVE', 'HC-DEMO-90 + FAUCET-DEMO').Cost, 8500);
  assert.equal(by('FOSTER', '2451090').Name, 'GHOST HOOD 90 cm');
  assert.equal(by('FOSTER', '2451090').NormalPrice, 147590);
  assert.ok(!products.some((p) => String(p.Key).startsWith('#')), 'error rows skipped');
  assert.equal(env.triggers.length, 1);
  // re-running setup is safe and only for admins
  env.call(ADMIN, 'setupApp');
  assert.equal(env.triggers.length, 1);
  assert.equal(sheetRows(env, 'APP_Channels').length, 4);
  assert.throws(() => env.call(SALES, 'setupApp'), /ไม่มีสิทธิ์/);
});

test('bootstrap never sends cost to the browser; sales get no approver data', () => {
  const env = seed(createEnv());
  const b = env.call(SALES, 'getBootstrap');
  assert.equal(b.user.role, 'SALES');
  assert.equal(b.pendingCount, undefined);
  assert.equal(b.sheetUrl, undefined);
  assert.ok(b.products.length > 0);
  assert.ok(b.products.every((p) => Object.keys(p).sort().join() === 'b,k,n,p'));
  assert.ok(!JSON.stringify(b).includes('7100'));
  assert.equal(b.channels.length, 4);
  const s = env.call(SUP, 'getBootstrap');
  assert.equal(s.user.role, 'SUPERVISOR');
  assert.equal(s.pendingCount, 0);
});

test('only the company domain can use the app', () => {
  const env = seed(createEnv());
  assert.throws(() => env.call('someone@gmail.com', 'getBootstrap'), /eve\.co\.th/);
  assert.throws(() => env.call('', 'getBootstrap'), /อีเมล/);
});

// ---------------- price check ----------------

test('priceCheck: sales see the indicator only, supervisors see the numbers', () => {
  const env = seed(createEnv());
  const payload = { channelId: 'GT_EVE', productKey: 'hc-demo-90', specialPrice: 16990, discounts: [0.18, 0, 0] };
  const sales = env.call(SALES, 'priceCheck', payload);
  assert.equal(sales.indicator, 'OKAY');
  assert.equal(sales.found, true);
  assert.equal(sales.productKey, 'HC-DEMO-90');
  ['cost', 'gain', 'mu', 'netExVat', 'netIncVat'].forEach((k) => assert.ok(!(k in sales), k + ' leaked'));
  const sup = env.call(SUP, 'priceCheck', payload);
  assert.equal(sup.cost, 7100);
  assert.equal(sup.mu, round4((16990 * 0.82 / 1.07 - 7100) / (16990 * 0.82 / 1.07)));
});

function round4(n) { return Math.round(n * 10000) / 10000; }

test('priceCheck: BT channel forces its fixed GP even if the browser sends another value', () => {
  const env = seed(createEnv());
  const r = env.call(SUP, 'priceCheck', { channelId: 'BT_EVE', productKey: 'HC-DEMO-90', specialPrice: 16990, discounts: [0, 0, 0] });
  assert.deepEqual(r.discounts, [0.278304, 0, 0]);
  const net = (18990 * 0.721696 - (18990 - 16990)) / 1.07;
  assert.equal(r.mu, round4((net - 7100) / net));
});

test('priceCheck rejects bad discounts and flags price above normal', () => {
  const env = seed(createEnv());
  assert.throws(() => env.call(SALES, 'priceCheck', { channelId: 'GT_EVE', productKey: 'HC-DEMO-90', specialPrice: 100, discounts: [8, 0, 0] }), /0% – 99%/);
  assert.throws(() => env.call(SALES, 'priceCheck', { channelId: 'GT_EVE', productKey: 'HC-DEMO-90', specialPrice: 0, discounts: [0, 0, 0] }), /ราคาพิเศษ/);
  const r = env.call(SALES, 'priceCheck', { channelId: 'GT_EVE', productKey: 'HC-DEMO-90', specialPrice: 20990, discounts: [0.18, 0, 0] });
  assert.ok(r.flags.includes('ราคาพิเศษสูงกว่าราคาปกติ'));
  const u = env.call(SALES, 'priceCheck', { channelId: 'GT_EVE', productKey: 'NOT A PRODUCT', specialPrice: 1000, discounts: [0, 0, 0] });
  assert.equal(u.found, false);
  assert.equal(u.indicator, 'NO COST');
});

// ---------------- submit / decide / cancel ----------------

function submit(env, who, extra) {
  return env.call(who, 'submitRequest', Object.assign({
    channelId: 'GT_EVE', customer: 'ร้านทดสอบ', project: 'หน้าร้าน', note: 'ส่งครั้งเดียว',
    startDate: iso(day(0)), endDate: iso(day(30)),
    lines: [
      { productKey: 'HC-DEMO-90', qty: 5, specialPrice: 16990, discounts: [0.18, 0, 0] },
      { productKey: 'FAUCET-DEMO', qty: 10, specialPrice: 2100, discounts: [0.18, 0.05, 0] }
    ]
  }, extra || {}));
}

test('submitRequest stores a snapshot, continues numbering after imported ids and emails approvers', () => {
  const env = seed(createEnv(), { import: true });
  const before = env.mail.length;
  const res = submit(env, SALES);
  assert.deepEqual(res.lines.map((l) => l.id), ['GT.0005', 'GT.0006']);
  assert.ok(!('cost' in res.lines[0]), 'sales response has no cost');
  const rows = sheetRows(env, 'APP_Requests').filter((r) => r.BatchId === res.batchId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Cost, 7100);
  assert.equal(rows[0].Qty, 5);
  assert.equal(rows[0].Status, 'Pending');
  assert.equal(rows[0].Requester, SALES);
  assert.ok(isDate(rows[0].StartDate));
  assert.equal(rows[1].Indicator, env.ctx.indicatorFor_(rows[1].MU, env.ctx.getSettings_()));
  const mails = env.mail.slice(before);
  assert.equal(mails.length, 1);
  assert.match(mails[0].to, /pak\.m@eve\.co\.th/);
  assert.match(mails[0].to, /akrawat@eve\.co\.th/);
  assert.match(mails[0].htmlBody, /GT\.0005/);
  // other channels keep their own counters
  const f = submit(env, SALES, { channelId: 'GT_FOSTER', lines: [{ productKey: '1144061', qty: 1, specialPrice: 7000, discounts: [0.18, 0, 0] }] });
  assert.deepEqual(f.lines.map((l) => l.id), ['GT.FOSTER.0002']);
  const b = submit(env, SALES, { channelId: 'BT_FOSTER', lines: [{ productKey: '1144061', qty: 1, specialPrice: 7000, discounts: [] }] });
  assert.deepEqual(b.lines.map((l) => l.id), ['BTFOSTER.0002']);
});

test('submitRequest validation', () => {
  const env = seed(createEnv());
  assert.throws(() => submit(env, SALES, { customer: ' ' }), /คู่ค้า/);
  assert.throws(() => submit(env, SALES, { lines: [] }), /อย่างน้อย 1/);
  assert.throws(() => submit(env, SALES, { startDate: iso(day(-1)) }), /ย้อนหลัง/);
  assert.throws(() => submit(env, SALES, { endDate: iso(day(-1)), startDate: iso(day(0)) }), /วันสิ้นสุด/);
  assert.throws(() => submit(env, SALES, { endDate: iso(day(120)) }), /ไม่เกิน 90 วัน/);
  assert.throws(() => submit(env, SALES, { lines: [{ productKey: 'HC-DEMO-90', qty: 1.5, specialPrice: 100, discounts: [] }] }), /จำนวน/);
  assert.throws(() => submit(env, SALES, { lines: [{ productKey: '', qty: 1, specialPrice: 100, discounts: [] }] }), /เลือกสินค้า/);
  // default end date = start + 30 when not given
  const r = submit(env, SALES, { startDate: '', endDate: '' });
  assert.equal(r.lines[0].endDate, iso(day(30)));
});

test('approve / reject: role checks, comment required for reject, no double decisions', () => {
  const env = seed(createEnv());
  const res = submit(env, SALES);
  const [a, b] = res.lines.map((l) => l.id);
  assert.throws(() => env.call(SALES, 'decideRequests', { ids: [a], decision: 'Approved' }), /ไม่มีสิทธิ์/);
  assert.throws(() => env.call(SUP, 'decideRequests', { ids: [b], decision: 'Rejected', comment: '' }), /เหตุผล/);
  const mailsBefore = env.mail.length;
  const ok = env.call(SUP, 'decideRequests', { ids: [a], decision: 'Approved', comment: 'ok' });
  assert.deepEqual(ok.updated, [a]);
  const again = env.call(ADMIN, 'decideRequests', { ids: [a, b], decision: 'Rejected', comment: 'ราคาต่ำไป' });
  assert.deepEqual(again.updated, [b]);
  assert.deepEqual(again.skipped, [a]);
  const rows = sheetRows(env, 'APP_Requests');
  assert.equal(rows.find((r) => r.ReqId === a).Status, 'Approved');
  assert.equal(rows.find((r) => r.ReqId === a).DecidedBy, SUP);
  assert.equal(rows.find((r) => r.ReqId === b).Status, 'Rejected');
  assert.equal(rows.find((r) => r.ReqId === b).DecisionComment, 'ราคาต่ำไป');
  const decisionMails = env.mail.slice(mailsBefore);
  assert.equal(decisionMails.length, 2);
  assert.ok(decisionMails.every((m) => m.to === SALES));
  const log = sheetRows(env, 'APP_Log').map((l) => l.Action);
  assert.ok(log.includes('APPROVE') && log.includes('REJECT') && log.includes('SUBMIT'));
});

test('requesters can cancel only their own pending lines', () => {
  const env = seed(createEnv());
  const ids = submit(env, SALES).lines.map((l) => l.id);
  assert.deepEqual(env.call(SALES2, 'cancelMyRequests', ids).updated, []);
  assert.deepEqual(env.call(SALES, 'cancelMyRequests', [ids[0]]).updated, [ids[0]]);
  env.call(SUP, 'decideRequests', { ids: [ids[1]], decision: 'Approved' });
  assert.deepEqual(env.call(SALES, 'cancelMyRequests', [ids[1]]).updated, [], 'approved lines cannot be cancelled');
});

test('lists: my requests are private, approved-price search hides expired ones, supervisor list is role-gated', () => {
  const env = seed(createEnv(), { import: true });
  const mine = submit(env, SALES).lines.map((l) => l.id);
  submit(env, SALES2);
  const list = env.call(SALES, 'listMyRequests', {});
  assert.ok(list.every((r) => r.requester === SALES));
  assert.ok(mine.every((id) => list.some((r) => r.id === id)));
  assert.ok(list.every((r) => !('cost' in r)));

  env.call(SUP, 'decideRequests', { ids: mine, decision: 'Approved' });
  const active = env.call(SALES2, 'searchApprovedPrices', { q: 'hc-demo' });
  assert.ok(active.some((r) => r.id === mine[0]));
  assert.ok(!active.some((r) => r.id === 'GT.0001'), 'expired legacy approval hidden');
  const withExpired = env.call(SALES2, 'searchApprovedPrices', { q: 'hc-demo', includeExpired: true });
  const old = withExpired.find((r) => r.id === 'GT.0001');
  assert.equal(old.displayStatus, 'Expired');

  assert.throws(() => env.call(SALES, 'listRequests', {}), /ไม่มีสิทธิ์/);
  const pending = env.call(SUP, 'listRequests', { status: 'Pending' });
  assert.ok(pending.length >= 2 && pending.every((r) => r.status === 'Pending'));
  assert.ok('mu' in pending[0]);
  const ctx = env.call(SUP, 'getLineContext', mine[0]);
  assert.ok(ctx.sameProduct.some((r) => r.id === 'GT.0001'));
  assert.ok(ctx.sameCustomer.some((r) => r.id === mine[1]));
});

// ---------------- legacy import ----------------

test('importLegacy maps the old tabs and is idempotent', () => {
  const env = seed(createEnv());
  const rep = env.call(ADMIN, 'importLegacy');
  assert.deepEqual(rep.map((r) => [r.sheet, r.imported, r.error]), [
    ['GT.EVE_RFQ', 4, ''], ['GT.FOSTER_RFQ', 1, ''], ['BT.EVE_RFQ', 1, ''], ['BT.FOSTER_RFQ', 1, '']
  ]);
  const rows = sheetRows(env, 'APP_Requests');
  const g = (id) => rows.find((r) => r.ReqId === id);
  assert.equal(g('GT.0001').Status, 'Approved');
  assert.equal(g('GT.0001').DecidedBy, 'pak.m@eve.co.th');
  assert.equal(g('GT.0001').Customer, 'ต.สุขภัณฑ์');
  assert.equal(g('GT.0001').Note, '78 ชุดส่งครั้งเดียว');
  assert.ok(isDate(g('GT.0001').StartDate));
  assert.equal(g('GT.0002').Status, 'Pending');
  assert.equal(g('GT.0002').Disc2, 0.1);
  assert.equal(g('GT.0003').Status, 'Closed');
  assert.equal(g('GT.0003').Disc1, 0.08);
  assert.equal(g('GT.0003').Disc2, 0.03);
  assert.match(g('GT.0003').Flags, /ส่วนลดเดิม 8/);
  assert.equal(g('GT.0003').NormalPrice, 3990, 'missing normal price filled from master');
  assert.equal(g('GT.0004').Indicator, 'NO COST');
  assert.ok(isDate(g('GT.0004').StartDate), 'falls back to request date when start is #VALUE!');
  assert.equal(g('GT.FOSTER.0001').ProductKey, '2451090');
  assert.equal(g('GT.FOSTER.0001').ProductName, 'GHOST HOOD 90 cm');
  assert.equal(g('BT.0001').Disc1, 0.278304);
  assert.equal(g('BT.0001').Customer, 'บุญถาวร รัชดา');
  assert.equal(g('BT.0001').Project, 'Flash sale');
  assert.equal(g('BTFOSTER.0001').Status, 'Pending');
  assert.equal(g('BTFOSTER.0001').Note, 'ลูกค้าเก่า', 'BT FOSTER note comes from #Tag, not the Ref.Code');
  assert.equal(g('GT.FOSTER.0001').Note, '');
  // again: nothing new
  const rep2 = env.call(ADMIN, 'importLegacy');
  assert.ok(rep2.every((r) => r.imported === 0));
  assert.equal(sheetRows(env, 'APP_Requests').length, 7);
  assert.throws(() => env.call(SUP, 'importLegacy'), /ไม่มีสิทธิ์/);
});

// ---------------- dashboard & admin ----------------

test('dashboard aggregates by indicator, requester and month', () => {
  const env = seed(createEnv(), { import: true });
  const ids = submit(env, SALES).lines.map((l) => l.id);
  env.call(SUP, 'decideRequests', { ids, decision: 'Approved' });
  const d = env.call(SUP, 'getDashboard', {});
  assert.equal(d.kpis.total, 2 + 2 + 1 + 1); // GT.0002, GT.FOSTER.0001, BT.0001, BTFOSTER.0001 + 2 new
  assert.ok(d.byIndicator.reduce((a, x) => a + x.total, 0) === d.kpis.total);
  assert.equal(d.byMonth.length, 6);
  assert.ok(d.byRequester.some((x) => x.email === SALES && x.approved === 2));
  assert.ok(d.expiring.length === 0 || d.expiring.every((r) => r.displayStatus === 'Approved'));
  assert.throws(() => env.call(SALES, 'getDashboard', {}), /ไม่มีสิทธิ์/);
});

test('admin settings: thresholds editable, ordering enforced, takes effect', () => {
  const env = seed(createEnv());
  assert.throws(() => env.call(SUP, 'saveSettings', { MU_LOW_MAX: 0.3 }), /ไม่มีสิทธิ์/);
  assert.throws(() => env.call(ADMIN, 'saveSettings', { MU_LOSS_BELOW: 0.3 }), /เรียง/);
  env.call(ADMIN, 'saveSettings', { MU_LOW_MAX: 0.5 });
  const r = env.call(SALES, 'priceCheck', { channelId: 'GT_EVE', productKey: 'HC-DEMO-90', specialPrice: 16990, discounts: [0.18, 0, 0] });
  assert.equal(r.indicator, 'LOW');
  const info = env.call(ADMIN, 'getAdminInfo');
  assert.ok(info.productCount > 0);
  assert.equal(info.productsWithoutCost, 1);
  assert.equal(env.call(ADMIN, 'refreshProducts').count, info.productCount);
  assert.throws(() => env.call(SALES, 'refreshProducts'), /ไม่มีสิทธิ์/);
});

test('users sheet: role upgrade and deactivation', () => {
  const env = seed(createEnv());
  env.ctx.appendObjects_('APP_Users', [{ Email: SALES2, Name: 'S2', Role: 'supervisor', Active: true }, { Email: 'gone@eve.co.th', Name: 'x', Role: 'SALES', Active: false }]);
  assert.equal(env.call(SALES2, 'getBootstrap').user.role, 'SUPERVISOR');
  assert.throws(() => env.call('gone@eve.co.th', 'getBootstrap'), /ปิดการใช้งาน/);
});
