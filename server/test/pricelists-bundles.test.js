'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, isoDay } = require('./helpers');

let env, owner, sup, sales, sales2;

test.before(async () => {
  env = await startApp();
  await env.seedFixtures(); // price list APR26, effective 60 days ago
  owner = await env.client('akrawat@eve.co.th').login();
  sup = await env.client('pak.m@eve.co.th').login();
  sales = await env.client('sales1@eve.co.th').login();
  sales2 = await env.client('sales2@eve.co.th').login();
});
test.after(() => env.close());

const csvList = (rows) => ["EVE's Model,ราคาต้นทุนนำเข้า/หน่วย,Promotion Price"].concat(rows).join('\n');
const check = (c, key, price) => c.call('priceCheck', { channelId: 'GT_EVE', productKey: key, specialPrice: price, discounts: [0.18, 0, 0] });

test('upcoming price list: current prices unchanged, new price announced, new items marked', async () => {
  const r = await owner.call('importCsv', {
    type: 'cost_price_sheet', priceList: { name: 'AUG26', effectiveFrom: isoDay(20) },
    csv: csvList(['HC-DEMO-90,7500,20990', 'SINK-DEMO 760/510,3100,8490', 'BRAND-NEW-90,5000,15990'])
  });
  assert.equal(r.newPriceList, true);
  const now = await check(sales, 'HC-DEMO-90', 16990);
  assert.equal(now.priceList.name, 'APR26');
  assert.equal(now.normalPrice, 18990);
  assert.deepEqual(now.upcoming, { name: 'AUG26', effectiveFrom: isoDay(20), normalPrice: 20990, discontinued: false });
  const gone = await check(sales, 'FAUCET-DEMO', 3000);
  assert.equal(gone.upcoming.discontinued, true);
  await assert.rejects(check(sales, 'BRAND-NEW-90', 15000).then((x) => { if (!x.found) throw new Error('not yet'); }), /not yet/);

  const b = await sales.call('getBootstrap');
  assert.equal(b.priceLists.EVE.current.name, 'APR26');
  assert.equal(b.priceLists.EVE.upcoming.name, 'AUG26');
  const hc = b.products.find((p) => p.k === 'HC-DEMO-90');
  assert.equal(hc.up, 20990);
  assert.equal(b.products.find((p) => p.k === 'FAUCET-DEMO').ux, 1);
  assert.equal(b.priceLists.FOSTER.upcoming, null, 'FOSTER keeps its own list');

  const info = await owner.call('getAdminInfo');
  const aug = info.priceLists.find((l) => l.name === 'AUG26');
  assert.deepEqual(aug.brands, [{ brand: 'EVE', products: 3, status: 'upcoming' }]);
});

test('when the new list takes effect: pending requests are re-priced for the approver, approved ones keep their price', async () => {
  const pending = (await sales.call('submitRequest', {
    channelId: 'GT_EVE', customer: 'ร้านก่อนปรับราคา', startDate: isoDay(0), endDate: isoDay(30),
    lines: [{ productKey: 'HC-DEMO-90', qty: 1, specialPrice: 16990, discounts: [0.18, 0, 0] }]
  })).lines[0].id;
  const approved = (await sales.call('submitRequest', {
    channelId: 'GT_EVE', customer: 'ร้านอนุมัติแล้ว', startDate: isoDay(0), endDate: isoDay(30),
    lines: [{ productKey: 'SINK-DEMO 760/510', qty: 1, specialPrice: 6990, discounts: [0.18, 0, 0] }]
  })).lines[0].id;
  await sup.call('decideRequests', { ids: [approved], decision: 'Approved' });

  // AUG26 becomes effective today
  const aug = (await owner.call('getAdminInfo')).priceLists.find((l) => l.name === 'AUG26');
  await owner.call('savePriceList', { id: aug.id, effectiveFrom: isoDay(0), note: 'moved' });
  const now = await check(sales, 'BRAND-NEW-90', 15000);
  assert.equal(now.found, true);
  assert.equal(now.isNew, true);
  assert.equal(now.priceList.name, 'AUG26');

  const inbox = await sup.call('listRequests', { status: 'Pending' });
  const p = inbox.find((r) => r.id === pending);
  assert.equal(p.oldPriceList, true);
  assert.equal(p.priceList, 'APR26');
  assert.equal(p.repriced.priceList, 'AUG26');
  assert.equal(p.repriced.normalPrice, 20990);
  assert.ok(p.repriced.muBand && !('cost' in p.repriced), 'supervisor sees the new band, not cost');
  assert.equal((await owner.call('listRequests', { status: 'Pending' })).find((r) => r.id === pending).repriced.cost, 7500);

  const done = await sup.call('decideRequests', { ids: [pending], decision: 'Approved' });
  assert.equal(done.lines[0].normalPrice, 20990, 'snapshot follows today\'s list on approval');
  assert.equal(done.lines[0].priceList, 'AUG26');
  assert.match(done.lines[0].flags, /คิดใหม่ตามราคารอบ AUG26/);
  const row = (await env.db.query('select cost from requests where id = $1', [pending])).rows[0];
  assert.equal(row.cost, 7500);

  const still = (await sales.call('searchApprovedPrices', { q: 'ร้านอนุมัติแล้ว' }))[0];
  assert.equal(still.id, approved);
  assert.equal(still.displayStatus, 'Approved', 'stays valid until its own end date');
  assert.equal(still.oldPriceList, true);
  assert.equal(still.priceList, 'APR26');
});

test('price list admin: only upcoming, unused lists can be deleted', async () => {
  await owner.call('importCsv', { type: 'cost_price_sheet', priceList: { name: 'DEC26', effectiveFrom: isoDay(60) }, csv: csvList(['HC-DEMO-90,7600,21990']) });
  let lists = (await owner.call('getAdminInfo')).priceLists;
  const apr = lists.find((l) => l.name === 'APR26');
  await assert.rejects(owner.call('deletePriceList', apr.id), /ยังไม่มีผล/);
  await assert.rejects(sup.call('deletePriceList', apr.id), /ไม่มีสิทธิ์/);
  lists = (await owner.call('deletePriceList', lists.find((l) => l.name === 'DEC26').id)).priceLists;
  assert.ok(!lists.some((l) => l.name === 'DEC26'));
});

test('bundles: anyone builds a set from current items, everyone can use it, priced live', async () => {
  await assert.rejects(sales.call('createBundle', { brand: 'EVE', items: [{ productKey: 'HC-DEMO-90' }] }), /2–5/);
  await assert.rejects(sales.call('createBundle', { brand: 'EVE', items: [{ productKey: 'HC-DEMO-90' }, { productKey: 'FAUCET-DEMO' }] }), /ไม่พบสินค้า "FAUCET-DEMO"/,
    'FAUCET-DEMO is not in the current (AUG26) list');
  const b = await sales.call('createBundle', { brand: 'EVE', label: 'โปรครัวครบชุด', items: [{ productKey: 'hc-demo-90' }, { productKey: 'BRAND-NEW-90', qty: 2 }] });
  assert.equal(b.k, 'HC-DEMO-90 + BRAND-NEW-90 ×2');
  assert.equal(b.p, 20990 + 2 * 15990);
  assert.ok(!('cost' in b));
  await assert.rejects(sales2.call('createBundle', { brand: 'EVE', items: [{ productKey: 'HC-DEMO-90' }, { productKey: 'BRAND-NEW-90', qty: 2 }] }), /มีชุดเซ็ตนี้อยู่แล้ว/);

  const other = await sales2.call('priceCheck', { channelId: 'OFFI_SHOPEE', productKey: b.k, specialPrice: 45000, discounts: [0.37] });
  assert.equal(other.found, true);
  assert.equal(other.isBundle, true);
  assert.equal(other.normalPrice, 52970);
  assert.ok(!('cost' in other));
  const own = await owner.call('priceCheck', { channelId: 'GT_EVE', productKey: b.k, specialPrice: 45000, discounts: [0.18, 0, 0] });
  assert.equal(own.cost, 7500 + 2 * 5000);

  const req = await sales2.call('submitRequest', { channelId: 'GT_EVE', customer: 'ร้านเซ็ต', startDate: isoDay(0), endDate: isoDay(10),
    lines: [{ productKey: b.k, qty: 3, specialPrice: 45000, discounts: [0.18, 0, 0] }] });
  assert.equal(req.lines[0].isBundle, true);
  assert.equal(req.lines[0].productName, 'โปรครัวครบชุด (HC-DEMO-90 + BRAND-NEW-90 ×2)');

  await assert.rejects(sales2.call('deleteBundle', b.id), /ลบได้เฉพาะเซ็ตที่คุณสร้าง/);
  await sales.call('deleteBundle', b.id);
  assert.ok(!(await sales.call('getBootstrap')).bundles.some((x) => x.id === b.id));
  assert.equal((await env.db.query('select bundle_id from requests where id = $1', [req.lines[0].id])).rows[0].bundle_id, b.id, 'history keeps the link');
});

test('COST_VIEWERS is the only way to see cost: role changes in the app cannot grant it', async () => {
  await owner.call('saveUser', { email: 'pak.m@eve.co.th', role: 'ADMIN', canViewCost: true, can_view_cost: true });
  const r = await sup.call('priceCheck', { channelId: 'GT_EVE', productKey: 'HC-DEMO-90', specialPrice: 16990, discounts: [0.18, 0, 0] });
  assert.ok(!('cost' in r) && !('mu' in r));
  const users = (await owner.call('getAdminInfo')).users;
  assert.deepEqual(users.filter((u) => u.canViewCost).map((u) => u.email), ['akrawat@eve.co.th']);
  await owner.call('saveUser', { email: 'pak.m@eve.co.th', role: 'SUPERVISOR' });
});
