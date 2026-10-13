'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, isoDay, ddmmyy, mdyyyy } = require('./helpers');
const { parseCsv, parseSheetDate } = require('../src/rfq/importers');

const ADMIN = 'akrawat@eve.co.th';
const SUP = 'pak.m@eve.co.th';
const SALES = 'sales1@eve.co.th';
const SALES2 = 'sales2@eve.co.th';

let env;
let admin, sup, sales, sales2;

test.before(async () => {
  env = await startApp();
  await env.seedFixtures();
  admin = await env.client(ADMIN).login();
  sup = await env.client(SUP).login();
  sales = await env.client(SALES).login();
  sales2 = await env.client(SALES2).login();
});
test.after(() => env.close());

function submit(c, extra) {
  return c.call('submitRequest', Object.assign({
    channelId: 'GT_EVE', customer: 'ร้านทดสอบ', project: 'หน้าร้าน', note: 'ส่งครั้งเดียว', startDate: isoDay(0), endDate: isoDay(30),
    lines: [
      { productKey: 'hc-demo-90', qty: 5, specialPrice: 16990, discounts: [0.18, 0, 0] },
      { productKey: 'FAUCET-DEMO', qty: 10, specialPrice: 2100, discounts: [0.18, 0.05, 0] }
    ]
  }, extra || {}));
}

// ------------------------------------------------------------- security

test('API requires a session and the CSRF header; unknown functions are rejected', async () => {
  const anon = env.client('nobody@eve.co.th');
  assert.equal((await anon.raw('getBootstrap')).status, 401);
  assert.equal((await sales.raw('getBootstrap', [], { 'X-RFQ': '' })).status, 400);
  assert.equal((await sales.raw('constructor')).status, 404);
  assert.equal((await sales.raw('toString')).status, 404);
  const page = await fetch(env.base + '/', { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
});

test('Google sign-in only accepts verified accounts of the company domain', async () => {
  env.googleTokens.good = { email: 'new.person@eve.co.th', email_verified: true, hd: 'eve.co.th', name: 'New Person' };
  env.googleTokens.gmail = { email: 'someone@gmail.com', email_verified: true, name: 'X' };
  env.googleTokens.spoof = { email: 'evil@eve.co.th', email_verified: true, hd: 'other.com' };
  const post = (credential) => fetch(env.base + '/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) });
  assert.equal((await post('gmail')).status, 403);
  assert.equal((await post('spoof')).status, 403);
  assert.equal((await post('nope')).status, 401);
  const ok = await post('good');
  assert.equal(ok.status, 200);
  const u = (await env.db.query('select * from users where email = $1', ['new.person@eve.co.th'])).rows[0];
  assert.equal(u.role, 'SALES');
  assert.equal(u.name, 'New Person');
});

test('sign-in: every domain in ALLOWED_DOMAIN may log in; hd must match the email domain', async () => {
  env.googleTokens.sm = { email: 'Staff@SiamManor.com', email_verified: true, hd: 'siammanor.com', name: 'SM Staff' };
  env.googleTokens.cross = { email: 'evil@siammanor.com', email_verified: true, hd: 'eve.co.th' };
  env.googleTokens.unverified = { email: 'x@siammanor.com', email_verified: false, hd: 'siammanor.com' };
  env.googleTokens.other = { email: 'x@other.co.th', email_verified: true, hd: 'other.co.th' };
  const post = (credential) => fetch(env.base + '/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) });
  assert.equal((await post('cross')).status, 403);
  assert.equal((await post('unverified')).status, 403);
  const refused = await post('other');
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /@eve\.co\.th หรือ @siammanor\.com/);
  assert.equal((await post('sm')).status, 200);
  const u = (await env.db.query('select * from users where email = $1', ['staff@siammanor.com'])).rows[0];
  assert.equal(u.role, 'SALES');
  assert.equal(u.can_view_cost, false);

  const login = await (await fetch(env.base + '/login')).text();
  assert.match(login, /@eve\.co\.th หรือ @siammanor\.com/);
  assert.doesNotMatch(login, /data-hd=/, 'Google takes one hd only, so none is sent with two domains');
});

test('bootstrap: groups/channels for everyone, never cost; approver extras only for approvers', async () => {
  const b = await sales.call('getBootstrap');
  assert.deepEqual(b.groups.map((g) => g.id), ['GT', 'BT', 'OFFI', 'JS', 'JS_OVS']);
  assert.equal(b.groups.find((g) => g.id === 'OFFI').channels.length, 8);
  assert.equal(b.user.role, 'SALES');
  assert.equal(b.pendingCount, undefined);
  assert.equal(b.groups[0].indicatorRules, undefined);
  const json = JSON.stringify(b);
  assert.ok(!json.includes('7100') && !json.includes('177265') && !json.includes('61296'), 'no cost values leak to sales');
  assert.ok(b.products.every((p) => Object.keys(p).every((k) => ['b', 'k', 'n', 'p', 'nw', 'up', 'ux'].includes(k))));
  assert.ok(b.bundles.some((x) => x.k === 'HC-DEMO-90 + FAUCET-DEMO' && x.p === 22980), 'legacy _CalDummy row became a bundle');
  assert.equal(b.user.canSeeCost, false);
  assert.ok(b.projects.some((p) => p.k === '3FO3QG6B0RQ1_01'));
  assert.equal(b.landed[0].p, 742990, 'OVS suggested price is shown like in the sheet');
  const s = await sup.call('getBootstrap');
  assert.equal(s.user.role, 'SUPERVISOR');
  assert.equal(s.user.canSeeCost, false);
  assert.ok(!JSON.stringify(s).includes('7100'));
  assert.equal((await admin.call('getBootstrap')).user.canSeeCost, true);
});

// ------------------------------------------------------------- price check

test('priceCheck: sales = indicator; supervisor = net + MU band, never cost; only the cost viewer sees cost', async () => {
  const p = { channelId: 'GT_EVE', productKey: ' hc-demo-90 ', specialPrice: 16990, discounts: [0.18, 0, 0] };
  const s = await sales.call('priceCheck', p);
  assert.equal(s.indicator, 'OKAY');
  assert.equal(s.productKey, 'HC-DEMO-90');
  assert.equal(s.normalPrice, 18990, 'GT hot price wins over the master price');
  assert.equal(s.priceList.name, 'APR26');
  for (const k of ['cost', 'gain', 'mu', 'muBand', 'netExVat', 'netIncVat']) assert.ok(!(k in s), k + ' leaked');
  const v = await sup.call('priceCheck', p);
  for (const k of ['cost', 'gain', 'mu']) assert.ok(!(k in v), k + ' leaked to supervisor');
  assert.equal(v.muBand, '> 25%');
  assert.equal(v.netExVat, 13020.37);
  const admin2 = await env.client('admin2@eve.co.th').login();
  const v2 = await admin2.call('priceCheck', p);
  assert.ok(!('cost' in v2), 'another ADMIN without COST_VIEWERS does not see cost');
  const a = await admin.call('priceCheck', p);
  assert.equal(a.cost, 7100);
  assert.equal(a.mu, Math.round((16990 * 0.82 / 1.07 - 7100) / (16990 * 0.82 / 1.07) * 10000) / 10000);
});

test('priceCheck covers every cost source: product, dummy set, project, landed', async () => {
  const set = await admin.call('priceCheck', { channelId: 'GT_EVE', productKey: 'HC-DEMO-90 + FAUCET-DEMO', specialPrice: 20000, discounts: [0.18, 0, 0] });
  assert.equal(set.cost, 8600, 'bundle cost = sum of component costs in the current price list');
  assert.equal(set.normalPrice, 22980);
  assert.equal(set.isBundle, true);
  const foster = await admin.call('priceCheck', { channelId: 'BT_FOSTER', productKey: '2451090', specialPrice: 120000, discounts: [] });
  assert.equal(foster.productName, 'GHOST HOOD 90 cm');
  assert.deepEqual(foster.discounts, [0.278304]);
  const proj = await admin.call('priceCheck', { channelId: 'JS_TH', productKey: '3fo3qg6b0rq1_01', specialPrice: 242389, discounts: [0] });
  assert.equal(proj.mu, 0.2175);
  assert.equal(proj.indicator, 'LOW');
  const ovs = await admin.call('priceCheck', { channelId: 'JS_OVS', productKey: 'JS00032', specialPrice: 742990, discounts: [0.3] });
  assert.equal(ovs.normalPrice, 742990);
  assert.equal(ovs.mu, 0.3891);
  assert.equal(ovs.indicator, 'OKAY');
});

test('priceCheck enforces channel rules and flags oddities', async () => {
  await assert.rejects(sales.call('priceCheck', { channelId: 'OFFI_SHOPEE', productKey: 'HC-DEMO-90', specialPrice: 16990, discounts: [0.3] }), /ห้ามต่ำกว่า 37%/);
  await assert.rejects(sales.call('priceCheck', { channelId: 'GT_EVE', productKey: 'HC-DEMO-90', specialPrice: 0, discounts: [] }), /ราคาพิเศษ/);
  await assert.rejects(sales.call('priceCheck', { channelId: 'NOPE', productKey: 'x', specialPrice: 1 }), /ช่องทาง/);
  const hi = await sales.call('priceCheck', { channelId: 'GT_EVE', productKey: 'HC-DEMO-90', specialPrice: 20990, discounts: [0.18, 0, 0] });
  assert.ok(hi.flags.includes('ราคาพิเศษสูงกว่าราคาปกติ'));
  const unknown = await sales.call('priceCheck', { channelId: 'GT_EVE', productKey: 'MYSTERY', specialPrice: 100, discounts: [0.18, 0, 0] });
  assert.equal(unknown.found, false);
  assert.equal(unknown.indicator, 'NO COST');
});

// ------------------------------------------------------------- submit / decide / cancel

test('submit: per-prefix numbering, cost snapshot, notification without leaking cost to the requester', async () => {
  const before = env.mail.length;
  const res = await submit(sales);
  assert.deepEqual(res.lines.map((l) => l.id), ['GT.0001', 'GT.0002']);
  assert.ok(!('cost' in res.lines[0]));
  const row = (await env.db.query('select * from requests where id = $1', ['GT.0001'])).rows[0];
  assert.equal(row.cost, 7100);
  assert.equal(row.qty, 5);
  assert.equal(row.status, 'Pending');
  assert.equal(row.requester, SALES);
  assert.deepEqual(row.discount_labels, ['ส่วนลด GP', 'ส่วนลด 2', 'ส่วนลด 3']);
  const mail = env.mail.slice(before);
  assert.equal(mail.length, 1);
  assert.deepEqual(mail[0].to.sort(), ['admin2@eve.co.th', ADMIN, SUP]);
  assert.match(mail[0].html, /GT\.0001/);
  assert.match(mail[0].html, /ช่วง MU/);
  assert.ok(!/7,100|%MU/.test(mail[0].html), 'approver email has no cost or exact %MU');
  assert.match(mail[0].html, /rfq\.example\.com\/#approvals/);

  // OFFI channels share the OFFI. prefix
  const a = await submit(sales, { channelId: 'OFFI_SHOPEE', lines: [{ productKey: 'HC-DEMO-90', qty: 1, specialPrice: 18990, discounts: [0.37] }] });
  const b = await submit(sales, { channelId: 'OFFI_LAZADA', lines: [{ productKey: 'HC-DEMO-90', qty: 1, specialPrice: 18990, discounts: [0.38] }] });
  assert.deepEqual([a.lines[0].id, b.lines[0].id], ['OFFI.0001', 'OFFI.0002']);
  const j = await submit(sales, { channelId: 'JS_TH', lines: [{ productKey: '3FO3QG6B0RQ1_01', qty: 1, specialPrice: 242389, discounts: [0] }] });
  assert.equal(j.lines[0].id, 'JS.TH.0001');
});

test('submit validation', async () => {
  await assert.rejects(submit(sales, { customer: ' ' }), /คู่ค้า/);
  await assert.rejects(submit(sales, { lines: [] }), /อย่างน้อย 1/);
  await assert.rejects(submit(sales, { startDate: isoDay(-1) }), /ย้อนหลัง/);
  await assert.rejects(submit(sales, { endDate: isoDay(-1) }), /วันสิ้นสุด/);
  await assert.rejects(submit(sales, { endDate: isoDay(120) }), /ไม่เกิน 90 วัน/);
  await assert.rejects(submit(sales, { lines: [{ productKey: 'HC-DEMO-90', qty: 1.5, specialPrice: 100, discounts: [] }] }), /จำนวน/);
  await assert.rejects(submit(sales, { lines: [{ productKey: '', qty: 1, specialPrice: 100, discounts: [] }] }), /กรุณาเลือก/);
  await assert.rejects(submit(sales, { channelId: 'OFFI_TIKTOK', lines: [{ productKey: 'HC-DEMO-90', qty: 1, specialPrice: 100, discounts: [0.1] }] }), /ห้ามต่ำกว่า 20%/);
  const r = await submit(sales, { startDate: '', endDate: '' });
  assert.equal(r.lines[0].endDate, isoDay(30));
});

test('decisions: roles, reject needs a reason, no double decisions, supervisors cannot approve their own', async () => {
  const [x, y] = (await submit(sales2)).lines.map((l) => l.id);
  await assert.rejects(sales.call('decideRequests', { ids: [x], decision: 'Approved' }), /ไม่มีสิทธิ์/);
  await assert.rejects(sup.call('decideRequests', { ids: [y], decision: 'Rejected', comment: '' }), /เหตุผล/);
  const before = env.mail.length;
  const ok = await sup.call('decideRequests', { ids: [x], decision: 'Approved', comment: 'ok' });
  assert.deepEqual(ok.updated, [x]);
  const again = await admin.call('decideRequests', { ids: [x, y], decision: 'Rejected', comment: 'ต่ำไป' });
  assert.deepEqual(again.updated, [y]);
  assert.deepEqual(again.skipped, [x]);
  const decisionMail = env.mail.slice(before);
  assert.equal(decisionMail.length, 2);
  assert.ok(decisionMail.every((m) => m.to[0] === SALES2 && !/%MU/.test(m.html)));

  const own = (await submit(sup)).lines.map((l) => l.id);
  const r = await sup.call('decideRequests', { ids: own, decision: 'Approved' });
  assert.deepEqual(r.updated, [], 'supervisor cannot approve own request');
  const r2 = await admin.call('decideRequests', { ids: own, decision: 'Approved' });
  assert.deepEqual(r2.updated.sort(), own.sort());
  const log = (await env.db.query('select action from audit_log')).rows.map((l) => l.action);
  for (const a of ['SUBMIT', 'APPROVE', 'REJECT']) assert.ok(log.includes(a), a);
});

test('cancel: only own pending lines', async () => {
  const ids = (await submit(sales)).lines.map((l) => l.id);
  assert.deepEqual((await sales2.call('cancelMyRequests', ids)).updated, []);
  assert.deepEqual((await sales.call('cancelMyRequests', [ids[0]])).updated, [ids[0]]);
  await sup.call('decideRequests', { ids: [ids[1]], decision: 'Approved' });
  assert.deepEqual((await sales.call('cancelMyRequests', [ids[1]])).updated, []);
});

test('lists and search', async () => {
  const mine = await sales.call('listMyRequests', {});
  assert.ok(mine.length > 0 && mine.every((r) => r.requester === SALES && !('cost' in r)));
  const pend = await sales.call('listMyRequests', { status: 'Pending' });
  assert.ok(pend.every((r) => r.status === 'Pending'));
  await assert.rejects(sales.call('listRequests', {}), /ไม่มีสิทธิ์/);
  const offi = await sup.call('listRequests', { group: 'OFFI' });
  assert.deepEqual(offi.map((r) => r.id).sort(), ['OFFI.0001', 'OFFI.0002']);
  assert.ok(!('mu' in offi[0]) && !('cost' in offi[0]) && offi[0].muBand, 'supervisor list: band only');
  assert.ok('mu' in (await admin.call('listRequests', { group: 'OFFI' }))[0]);
  const q = await sup.call('listRequests', { q: "hc-demo ร้านทดสอบ" });
  assert.ok(q.length && q.every((r) => r.productKey === 'HC-DEMO-90'));
  const injection = await sup.call('listRequests', { q: "%' or 1=1 --" });
  assert.equal(injection.length, 0);
  const approved = await sales2.call('searchApprovedPrices', { q: 'hc-demo' });
  assert.ok(approved.length && approved.every((r) => r.status === 'Approved'));
  const ctx = await sup.call('getLineContext', 'GT.0001');
  assert.ok(ctx.sameProduct.length > 0);
  assert.equal(ctx.sameCustomer.length, 10, 'newest 10 only');
  assert.ok(ctx.sameCustomer.every((r) => r.customer === 'ร้านทดสอบ' && r.id !== 'GT.0001'));
});

test('dashboard', async () => {
  await assert.rejects(sales.call('getDashboard', {}), /ไม่มีสิทธิ์/);
  const d = await sup.call('getDashboard', {});
  assert.equal(d.showMu, false);
  assert.equal(d.kpis.avgMuApproved, null, 'supervisor dashboard has no average %MU');
  assert.equal((await admin.call('getDashboard', {})).showMu, true);
  assert.equal(d.byIndicator.reduce((a, x) => a + x.total, 0), d.kpis.total);
  assert.equal(d.byMonth.length, 6);
  assert.ok(d.byChannel.some((c) => c.channel === 'OFFI_SHOPEE' && c.group === 'Official Online / Offline'));
  const only = await sup.call('getDashboard', { group: 'JS' });
  assert.equal(only.kpis.total, 1);
});

// ------------------------------------------------------------- admin & imports

test('admin: settings, users, CSV imports are admin-only', async () => {
  await assert.rejects(sup.call('getAdminInfo'), /ไม่มีสิทธิ์/);
  await assert.rejects(admin.call('saveSettings', { DEFAULT_VALIDITY_DAYS: 120 }), /ไม่เกิน MAX/);
  const info = await admin.call('saveSettings', { DEFAULT_VALIDITY_DAYS: 14 });
  assert.equal(info.settings.find((s) => s.key === 'DEFAULT_VALIDITY_DAYS').value, 14);
  assert.equal((await sales.call('getBootstrap')).settings.defaultValidityDays, 14);
  await admin.call('saveSettings', { DEFAULT_VALIDITY_DAYS: 30 });

  await assert.rejects(admin.call('saveUser', { email: 'x@gmail.com', role: 'SUPERVISOR' }), /eve\.co\.th หรือ @siammanor\.com/);
  await admin.call('saveUser', { email: 'sup.sm@siammanor.com', role: 'SUPERVISOR' });
  await assert.rejects(admin.call('saveUser', { email: ADMIN, role: 'SALES' }), /ตัวเอง/);
  await admin.call('saveUser', { email: SALES2, role: 'SUPERVISOR' });
  assert.equal((await sales2.call('getBootstrap')).user.role, 'SUPERVISOR');
  await admin.call('saveUser', { email: SALES2, role: 'SALES', active: false });
  assert.equal((await sales2.raw('getBootstrap')).status, 401, 'deactivated user is logged out');
  await admin.call('saveUser', { email: SALES2, role: 'SALES', active: true });

  await assert.rejects(sup.call('importCsv', { type: 'products', csv: 'brand,key\nEVE,X' }), /ไม่มีสิทธิ์/);
  await assert.rejects(admin.call('importCsv', { type: 'products', brand: 'FOSTER', csv: 'key,cost\nX,1\n' }), /ชื่อรอบราคา/);
  const r = await admin.call('importCsv', { type: 'products', brand: 'FOSTER', priceList: { name: 'APR26' }, csv: 'key,name,cost,normal_price\n"9999,1","Odd, name",100,"1,000.00"\n' });
  assert.equal(r.imported, 1);
  const p = (await env.db.query(`select * from products where brand = 'FOSTER' and key = '9999,1'`)).rows[0];
  assert.equal(p.name, 'Odd, name');
  assert.equal(p.normal_price, 1000);
});

test('legacy import from the old tabs (CSV export format, mixed date formats) is idempotent and moves counters', async () => {
  const header = 'Req. Id.,เริ่มโปรฯ,สิ้นสุดโปร,ชื่อคู่ค้า / ร้านค้า,สาขา / ชื่อโครงการ,หมายเหตุ / #Tag,ชื่อสินค้า,ขายปกติ,ราคาขายพิเศษสุทธิ,ส่วนลด GP,ส่วนลด 2,ส่วนลด 3,%MU Indicator,,STATUS,Decision Date,Approved By,Requester,Request Date';
  const csv = [header,
    `GT.0436,${mdyyyy(-120)},${ddmmyy(-90)},ต.สุขภัณฑ์,หน้าร้าน,78 ชุด,HC-DEMO-90,"18,990.00","16,990.00",18.00%,0.00%,0.00%,OKAY,,Approve,${mdyyyy(-119)},pak.m@eve.co.th,akrawat@eve.co.th,${ddmmyy(-120)}`,
    `GT.0435,${mdyyyy(-3)},${ddmmyy(27)},CSC,หน้าร้าน,,SINK-DEMO 760/510,"7,990.00","6,990.00",20.00%,10.00%,,OKAY,,,,,sales1@eve.co.th,${ddmmyy(-3)}`,
    `GT.0434,${mdyyyy(-120)},${ddmmyy(-90)},ต.สุขภัณฑ์,,,FAUCET-DEMO,,"3,500.00",800.00%,300.00%,0.00%,OKAY,,,,,natthawat@eve.co.th,${ddmmyy(-120)}`,
    `GT.0433,${ddmmyy(-100)},#VALUE!,เลอ,Online,,MYSTERY ITEM,"9,990.00","15,184.00",25.00%,0.00%,0.00%,OKAY,,Approve,${mdyyyy(-100)},pak.m@eve.co.th,akrawat@eve.co.th,${ddmmyy(-101)}`,
    ',,,,,,,,,,,,,,,,,,'
  ].join('\n');
  const r = await admin.call('importCsv', { type: 'GT.EVE_RFQ', csv });
  assert.equal(r.imported, 4);
  assert.deepEqual(r.errors, []);
  const g = async (id) => (await env.db.query('select * from requests where id = $1', [id])).rows[0];
  assert.equal((await g('GT.0436')).status, 'Approved');
  assert.equal((await g('GT.0436')).start_date, isoDay(-120));
  assert.equal((await g('GT.0436')).decided_by, SUP);
  assert.equal((await g('GT.0435')).status, 'Pending');
  assert.deepEqual((await g('GT.0435')).discounts, [0.2, 0.1, 0]);
  const old = await g('GT.0434');
  assert.equal(old.status, 'Closed');
  assert.deepEqual(old.discounts, [0.08, 0.03, 0]);
  assert.ok(old.flags.some((f) => f.includes('800%')));
  assert.equal(old.normal_price, 3990);
  assert.equal((await g('GT.0433')).indicator, 'NO COST');
  assert.equal((await g('GT.0433')).start_date, isoDay(-100));
  assert.equal((await g('GT.0433')).end_date, isoDay(-70), '#VALUE! end date → start + 30 days');

  const again = await admin.call('importCsv', { type: 'GT.EVE_RFQ', csv });
  assert.equal(again.imported, 0);
  assert.equal(again.skipped, 4);
  const next = await submit(sales);
  assert.equal(next.lines[0].id, 'GT.0437', 'new ids continue after imported ones');

  const offi = [
    'pa,เริ่มโปรฯ,สิ้นสุดโปร,ชื่อโปรฯ / Tagline,สาขา,Mark Down,ชื่อสินค้า,ขายปกติ,ราคาขายพิเศษสุทธิ,ส่วนลด GP,Comment,%MU Indicator,,STATUS,Decision Date,Approved By,Requester',
    `OFFI.0050,${mdyyyy(-2)},${mdyyyy(20)},แคมเปญ 5.5,Shopee Mall,,HC-DEMO-90,"19,990.00","16,990.00",37.00%,✔️ CheckGP,OKAY,,Pending,,,akrawat@eve.co.th`,
    `OFFI.0051,${mdyyyy(-2)},${mdyyyy(20)},TEST,รัชดา,,HC-DEMO-90,"19,990.00","16,990.00",27.00%,✔️ CheckGP,OKAY,,Approve,${mdyyyy(-1)},akrawat@eve.co.th,akrawat@eve.co.th`
  ].join('\n');
  const o = await admin.call('importCsv', { type: 'OFFI_RFQ', csv: offi });
  assert.equal(o.imported, 2);
  assert.equal((await g('OFFI.0050')).channel_id, 'OFFI_SHOPEE');
  const guessed = await g('OFFI.0051');
  assert.equal(guessed.channel_id, 'OFFI_SHOWROOM');
  assert.ok(guessed.flags.some((f) => f.includes('รัชดา')));
  const n = await submit(sales, { channelId: 'OFFI_LINE', lines: [{ productKey: 'HC-DEMO-90', qty: 1, specialPrice: 18990, discounts: [0.2] }] });
  assert.equal(n.lines[0].id, 'OFFI.0052');
});

test('n8n integration API: bearer token, import values, export for the Sheets mirror', async () => {
  const unauth = await fetch(env.base + '/api/integrations/requests');
  assert.equal(unauth.status, 401);
  const h = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const imp = await fetch(env.base + '/api/integrations/import/project_costs?group=JS', {
    method: 'POST', headers: h, body: JSON.stringify({ values: [['PROJ. ID', 'ชื่อลูกค้า', 'ต้นทุนขาย (-VAT)'], ['N8N-1', 'คุณ n8n', '1,000']] })
  });
  assert.equal(imp.status, 200);
  assert.equal((await imp.json()).data.imported, 1);
  const exp = await (await fetch(env.base + '/api/integrations/requests', { headers: h })).json();
  assert.equal(exp.values[0][0], 'Req. Id.');
  assert.equal(exp.values.length - 1, Number((await env.db.query('select count(*) from requests')).rows[0].count));
  assert.ok(exp.values.every((r) => r.length === exp.header.length));
});

test('csv parser and sheet date parser', () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""q"""\r\n1,2,3\n'), [['a', 'b,c', 'd "q"'], ['1', '2', '3']]);
  assert.deepEqual(parseCsv('﻿x\n"multi\nline",y'), [['x'], ['multi\nline', 'y']]);
  assert.equal(parseSheetDate('4/24/2026'), '2026-04-24');
  assert.equal(parseSheetDate('24/05/26'), '2026-05-24');
  assert.equal(parseSheetDate('29/01/00'), null, 'the sheet\'s 0+30 artefact is rejected');
  assert.equal(parseSheetDate('#VALUE!'), null);
  assert.equal(parseSheetDate('31/02/26'), null);
  assert.equal(parseSheetDate('2026-10-11'), '2026-10-11');
});

test('static pages and health check', async () => {
  assert.equal((await fetch(env.base + '/healthz')).status, 200);
  const login = await (await fetch(env.base + '/login')).text();
  assert.match(login, /data-client_id="test-client"/);
  assert.match(login, /href="\/privacy"/);
  const privacy = await fetch(env.base + '/privacy', { redirect: 'manual' });
  assert.equal(privacy.status, 200, 'the privacy policy is public (linked from the Google consent screen)');
  assert.match(await privacy.text(), /นโยบายความเป็นส่วนตัว/);
  const csp = (await fetch(env.base + '/login')).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/accounts.google.com\/gsi\/client/);
  const res = await fetch(env.base + '/', { headers: { Cookie: sales.cookie } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /app\.js/);
});
