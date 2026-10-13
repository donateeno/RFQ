'use strict';
/** H1: price list names and dates on import. M4: price-check rate limit / audit against cost guessing. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, isoDay, COST_PRICE } = require('./helpers');

let env, owner, admin2, sup, sales, sales2;

test.before(async () => {
  env = await startApp();
  await env.seedFixtures(); // price list APR26, effective 60 days ago
  owner = await env.client('akrawat@eve.co.th').login();
  admin2 = await env.client('admin2@eve.co.th').login();
  sup = await env.client('pak.m@eve.co.th').login();
  sales = await env.client('sales1@eve.co.th').login();
  sales2 = await env.client('sales2@eve.co.th').login();
});
test.after(() => env.close());

const csvList = (rows) => ["EVE's Model,ราคาต้นทุนนำเข้า/หน่วย,Promotion Price"].concat(rows).join('\n');
const n8nImport = (query) => fetch(env.base + '/api/integrations/import/cost_price_sheet?' + new URLSearchParams(query), {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' }, body: JSON.stringify({ values: COST_PRICE })
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const check = (c, key, price) => c.call('priceCheck', { channelId: 'GT_EVE', productKey: key, specialPrice: price, discounts: [0.18, 0, 0] });
const listNames = async () => (await owner.call('getAdminInfo')).priceLists.map((l) => l.name);

// ---------------------------------------------------------------- H1

test('price list names match case-insensitively; a new list always needs a date', async () => {
  const r = await owner.call('importCsv', { type: 'cost_price_sheet', priceList: { name: ' apr26 ' }, csv: csvList(['HC-DEMO-90,7100,18990']) });
  assert.equal(r.priceList, 'APR26');
  assert.equal(r.newPriceList, false);
  assert.equal(r.effectiveFrom, isoDay(-60));

  await assert.rejects(owner.call('importCsv', { type: 'cost_price_sheet', priceList: { name: 'AUG26' }, csv: csvList(['HC-DEMO-90,7500,20990']) }),
    /ต้องระบุวันที่มีผล/);
  assert.ok(!(await listNames()).includes('AUG26'), 'nothing created');
  await assert.rejects(env.db.query(`insert into price_lists (name, effective_from) values ('Apr26', current_date)`), /price_lists_name_norm_idx/);
});

test('n8n import never creates a list that starts today; it fills lists an admin created', async () => {
  let r = await n8nImport({ priceList: 'NOV26' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /ยังไม่มีในระบบ/);
  r = await n8nImport({ priceList: 'NOV26', effectiveFrom: isoDay(0) });
  assert.equal(r.status, 409, 'today is refused too');
  assert.ok(!(await listNames()).includes('NOV26'));
  assert.equal((await check(sales, 'HC-DEMO-90', 16990)).priceList.name, 'APR26', 'prices did not switch');

  r = await n8nImport({ priceList: 'apr26' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.priceList, 'APR26');

  r = await n8nImport({ priceList: 'FEB27', effectiveFrom: isoDay(30) });
  assert.equal(r.status, 200, 'a future start date may be created by n8n');
  assert.equal(r.body.data.newPriceList, true);

  await assert.rejects(sup.call('createPriceList', { name: 'DEC26', effectiveFrom: isoDay(40) }), /ไม่มีสิทธิ์/);
  await assert.rejects(owner.call('createPriceList', { name: 'DEC26', effectiveFrom: 'soon' }), /วันที่มีผล/);
  const info = await owner.call('createPriceList', { name: 'DEC26', effectiveFrom: isoDay(40) });
  assert.deepEqual(info.priceLists.find((l) => l.name === 'DEC26').brands, []);
  await assert.rejects(owner.call('createPriceList', { name: 'dec26', effectiveFrom: isoDay(41) }), /มีรอบราคาชื่อนี้แล้ว/);
  r = await n8nImport({ priceList: 'Dec26' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.priceList, 'DEC26');
  assert.equal(r.body.data.newPriceList, false);
  assert.equal((await check(sales, 'HC-DEMO-90', 16990)).upcoming.name, 'FEB27', 'nearest upcoming list');
});

// ---------------------------------------------------------------- M3

test('one cost per product in every price group; bundles sum the same costs; sheet cost conflicts are reported', async () => {
  const csv = COST_PRICE.map((r) => r.map((v) => '"' + v + '"').join(',')).join('\n');
  const r = await owner.call('importCsv', { type: 'cost_price_sheet', priceList: { name: 'APR26' }, csv });
  assert.deepEqual(r.costConflicts, ['HC-DEMO-90'], 'A:C 7,000 vs E:G 7,100 in the fixture');
  assert.equal(r.costConflictCount, 1);

  const at = (c, channelId, key, discounts) => c.call('priceCheck', { channelId, productKey: key, specialPrice: 16990, discounts });
  const costs = [];
  for (const [ch, d] of [['GT_EVE', [0.18, 0, 0]], ['BT_EVE', []], ['OFFI_SHOWROOM', [0.27]]]) {
    costs.push((await at(owner, ch, 'HC-DEMO-90', d)).cost);
    costs.push((await at(owner, ch, 'HC-DEMO-90 + FAUCET-DEMO', d)).cost);
  }
  assert.deepEqual(costs, [7100, 8600, 7100, 8600, 7100, 8600]);
  const noCost = await at(admin2, 'BT_EVE', 'HC-DEMO-90', []);
  assert.ok(!('cost' in noCost) && !('mu' in noCost) && 'muBand' in noCost, 'an admin who is not a cost viewer gets the band only');
});

// ---------------------------------------------------------------- M4

test('price checks: repeated prices on one item alert the admins, then are refused; cost never leaks', async () => {
  await assert.rejects(owner.call('saveSettings', { PRICE_CHECK_ALERT: 9, PRICE_CHECK_LIMIT: 5 }), /ต้องไม่เกิน/);
  await owner.call('saveSettings', { PRICE_CHECK_ALERT: 3, PRICE_CHECK_LIMIT: 5 });
  env.mail.length = 0;
  await env.db.query('delete from price_checks'); // ignore the checks made by the tests above

  for (const price of [16990, 16500, 16000]) await check(sales, 'HC-DEMO-90', price);
  const alerts = env.mail.filter((m) => m.event === 'security.price_check_alert');
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].to.sort(), ['admin2@eve.co.th', 'akrawat@eve.co.th']);
  assert.match(alerts[0].html, /sales1@eve\.co\.th/);
  assert.doesNotMatch(alerts[0].html, /7,?100|ต้นทุน\s*[\d,]+/, 'no cost in the alert');

  await check(sales, 'HC-DEMO-90', 15500);
  await check(sales, 'hc-demo-90 ', 15000); // same item, other spelling
  assert.equal(env.mail.filter((m) => m.event === 'security.price_check_alert').length, 1, 'alerted once');
  const blocked = await sales.raw('priceCheck', [{ channelId: 'GT_EVE', productKey: 'HC-DEMO-90', specialPrice: 14500, discounts: [0.18, 0, 0] }]);
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /ครบ 5 ราคา/);
  assert.equal((await check(sales, 'HC-DEMO-90', 16000)).indicator !== undefined, true, 'a price already tried still works');
  const viaDiscount = await sales.raw('priceCheck', [{ channelId: 'GT_EVE', productKey: 'HC-DEMO-90', specialPrice: 16000, discounts: [0.18, 0.01, 0] }]);
  assert.equal(viaDiscount.status, 429, 'a new net price through discounts counts too');
  const viaChannel = await sales.raw('priceCheck', [{ channelId: 'OFFI_SHOWROOM', productKey: 'HC-DEMO-90', specialPrice: 16000, discounts: [0.3] }]);
  assert.equal(viaChannel.status, 429, 'and through another channel');
  await check(sales, 'FAUCET-DEMO', 2990);                                          // other items are separate
  await check(sales2, 'HC-DEMO-90', 14500);                                         // other users are separate
  for (const price of [14500, 14000, 13500, 13000, 12500, 12000]) await check(owner, 'HC-DEMO-90', price); // cost viewer: no limit

  const logged = (await env.db.query(`select user_email, count(*)::int as n from price_checks group by 1 order by 1`)).rows;
  assert.deepEqual(logged, [{ user_email: 'sales1@eve.co.th', n: 7 }, { user_email: 'sales2@eve.co.th', n: 1 }], 'cost viewers are not logged');
  const cols = (await env.db.query(`select column_name from information_schema.columns where table_name = 'price_checks'`)).rows.map((r) => r.column_name);
  assert.ok(!cols.some((c) => /cost|gain|mu/.test(c)));

  const info = await admin2.call('getAdminInfo');
  assert.deepEqual(info.priceCheckAlerts.map((x) => [x.user, x.channel, x.key, x.prices]), [['sales1@eve.co.th', 'GT_EVE', 'HC-DEMO-90', 5]]);
  assert.ok(info.recentLog.some((l) => l.action === 'PRICE_CHECK_ALERT'));
  await assert.rejects(sup.call('getAdminInfo'), /ไม่มีสิทธิ์/);
});

test('price checks: hourly cap per user', async () => {
  await owner.call('saveSettings', { PRICE_CHECK_ALERT: 15, PRICE_CHECK_LIMIT: 30, PRICE_CHECK_PER_HOUR: 10 });
  for (let i = 0; i < 9; i++) await check(sup, 'SINK-DEMO 760/510', 7000 + i);
  await check(sup, 'SINK-DEMO 760/510', 7000); // repeats count towards the hourly cap
  await assert.rejects(check(sup, 'FAUCET-DEMO', 2990), /บ่อยเกินไป/);
  await owner.call('saveSettings', { PRICE_CHECK_PER_HOUR: 300 });
  assert.ok(await check(sup, 'FAUCET-DEMO', 2990));
});
