'use strict';
/** Customer price lookup (ราคาตามลูกค้า) loaded from the Customer Price Mapping sheet. Synthetic customers. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

let env, owner, sup, sales;

test.before(async () => {
  env = await startApp();
  await env.seedFixtures(); // price list APR26 (EVE + FOSTER, not tiered)
  // one SMG-synced (tiered) product in the current list
  await env.db.query(`insert into products (price_list_id, brand, key, name, cost, normal_price, source, barcode, status, price_gt, price_dgt, price_bt, tiered)
    select id, 'EVE', 'HOB-TIER', 'HOB TIER 2B', 700, 1990, 'SMG', '2000000000017', 'OR', 1490, 1990, 1590, true from price_lists where name = 'APR26'`);
  owner = await env.client('akrawat@eve.co.th').login();
  sup = await env.client('pak.m@eve.co.th').login();
  sales = await env.client('sales1@eve.co.th').login();
});
test.after(() => env.close());

const row = (n, cells) => { const r = new Array(n).fill(''); Object.entries(cells).forEach(([i, v]) => { r[i] = v; }); return r; };
const TERMS_HEAD = ['รหัสเงื่อนไข (Term code)', 'ชื่อเงื่อนไข', 'Name (EN)', 'หมวด', 'วิธีคำนวณ', 'ฐานที่ใช้คิด', 'ผู้รับภาระ', 'หักในใบกำกับภาษี?', 'นับรวมในราคาสุทธิเพื่อคิด %MU?', 'ค่าอ้างอิงที่พบ', 'ที่มา'];
const term = (code, name, method) => row(11, { 0: code, 1: name, 4: method });
const GROUPS_HEAD = ['รหัสกลุ่ม', 'ชื่อกลุ่มลูกค้า', 'ราคาฐาน (Price tier)', 'เครดิตเทอม (วัน)', 'ส่วนลดรวม (% ลดต่อกัน)', 'จำนวนเงื่อนไข', 'ผู้อนุมัติ', 'หมายเหตุ'];
const GT_HEAD = ['รหัสกลุ่ม หรือรหัสลูกค้า', 'ลำดับการหัก', 'รหัสเงื่อนไข', 'ชื่อเงื่อนไข', 'วิธีคำนวณ', 'ค่า (%)', 'ค่า (บาท)', 'ใช้กับสินค้า (ALL หรือบาร์โค้ด)', 'มีผลตั้งแต่', 'สิ้นสุด', 'หมายเหตุ / ที่มา'];
const gterm = (owner, seq, code, pct, thb, scope, from, to) => [owner, String(seq), code, '', '', pct || '', thb || '', scope || 'ALL', from || '', to || '', ''];
const CUST_HEAD = ['รหัสลูกค้า', 'ชื่อลูกค้า', 'ช่องทาง SAP', 'พนักงานขาย', 'ลำดับเดือนล่าสุด', 'ยอดขายสุทธิในช่วง (บาท)', 'จำนวนบรรทัด', 'ซื้อล่าสุด'];
const cust = (code, name, ch) => [code, name, ch, 'พนักงาน ก', '', '', '', 'Sep 2026'];

function sheets(opts) {
  opts = opts || {};
  return {
    terms: [TERMS_HEAD, term('BT_GP', 'ส่วนลด BT', 'PCT_RUNNING'), term('BT_MKT', 'ค่าการตลาด BT', 'PCT_RUNNING'), term('DC_FEE', 'DC fee', 'PCT_RUNNING'),
      term('GP_T20', 'ดีลเลอร์ T20', 'PCT_RUNNING'), term('CASH_DISC', 'ส่วนลดเงินสด', 'PCT_RUNNING'), term('FREIGHT', 'ค่าขนส่ง', 'THB_ORDER'),
      term('PF_SHOPEE', 'Shopee fee', 'PCT_RUNNING'), term('PROMO', 'โปรโมชั่นรายรุ่น', 'THB_UNIT'), term('BROKEN', 'วิธีผิด', 'PERCENT')],
    groups: [GROUPS_HEAD, ['BT', 'บุญถาวร', 'BT', '60', '', '', '', ''], ['DEALER_PC', 'ร้าน Dealer ที่มี PC', 'GT', '30', '', '', '', ''],
      ['SHOPEE', 'Shopee Mall', 'DGT', '', '', '', '', ''], ['NOTIER', 'ยังไม่กำหนดราคาฐาน', '', '', '', '', '', ''], ['BAD', 'ราคาฐานผิด', 'XYZ', '', '', '', '', '']],
    groupTerms: [GT_HEAD,
      gterm('BT', 1, 'BT_GP', '20.00%'), gterm('BT', 2, 'BT_MKT', '5.00%'), gterm('BT', 3, 'DC_FEE', '5.04%'),
      gterm('DEALER_PC', 1, 'GP_T20', '20.00%'), gterm('DEALER_PC', 5, 'FREIGHT', '', '200.00'),
      gterm('DEALER_PC', 3, 'PROMO', '', '100.00', '2000000000017'),                 // only for that barcode
      gterm('DEALER_PC', 4, 'CASH_DISC', '50.00%', '', 'ALL', '2020-01-01', '2020-12-31'), // expired
      gterm('300200', 10, 'CASH_DISC', '2.00%'),                                   // this customer only
      gterm('SHOPEE', 1, 'PF_SHOPEE', '37.00%'),
      gterm('SHOPEE', 2, 'NOPE', '1%'), gterm('SHOPEE', 3, 'FREIGHT', '')],
    channels: [['ช่องทาง SAP', 'กลุ่มลูกค้าเริ่มต้น', 'ยอดขาย'], ['บุญถาวร', 'BT'], ['ร้าน Dealer ที่มี PC', 'DEALER_PC'], ['clearance sale', ''], ['เลิกใช้', 'GONE']],
    customerMap: opts.customerMap || [['รหัสลูกค้า (SAP)', 'ชื่อลูกค้า', 'ช่องทาง SAP', 'กลุ่มลูกค้า (แทนกลุ่มของช่องทาง)'], ['300300', '', '', 'BT']],
    customers: [CUST_HEAD, cust('300100', 'บจก. บุญถาวร (ทดสอบ)', 'บุญถาวร'), cust('300200', 'ร้านดีจริง', 'ร้าน Dealer ที่มี PC'),
      cust('300300', 'ร้านพิเศษ', 'ร้าน Dealer ที่มี PC'), cust('300400', 'ลูกค้าเคลียร์สต็อก', 'clearance sale')]
  };
}

const sync = (body) => fetch(env.base + '/api/integrations/import/customer_pricing', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' }, body: JSON.stringify({ sheets: body })
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const price = (c, p) => c.call('customerPriceCheck', p);
// Step values (GP %, amounts) need the GP permission; the owner always has it.
const priceGp = (p) => price(owner, p);
const admin2Client = () => env.client('admin2@eve.co.th').login();

test('import the Customer Price Mapping sheet; unusable rows are listed, not loaded', async () => {
  const r = await sync(sheets());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.equal(d.imported, 4);
  assert.equal(d.terms, 8, 'BROKEN has an unknown method');
  assert.equal(d.groups, 4, 'BAD has an unknown price tier');
  assert.equal(d.groupTerms, 9);
  assert.equal(d.errorCount, 5);
  assert.ok(d.errors.some((e) => /BROKEN/.test(e)) && d.errors.some((e) => /NOPE/.test(e)) && d.errors.some((e) => /FREIGHT ต้องมีค่า \(บาท\)/.test(e)));
  assert.ok(d.errors.some((e) => /GONE/.test(e)), 'group used in Channel Map but missing');
  const info = await owner.call('getAdminInfo');
  assert.equal(info.customerPricing.customers, 4);
  assert.equal(info.customerPricing.ungrouped, 1, 'the clearance customer');
});

test('a moved column stops the import and keeps the data', async () => {
  const bad = sheets();
  bad.groupTerms[0] = bad.groupTerms[0].map((h) => (h === 'ค่า (%)' ? 'เปอร์เซ็นต์' : h));
  const r = await sync(bad);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /คอลัมน์ F ต้องเป็น "ค่า \(%\)"/);
  assert.equal((await owner.call('getAdminInfo')).customerPricing.groupTerms, 9);
});

test('sales find customers by code or name, with the group that applies', async () => {
  const found = await sales.call('searchCustomers', 'ร้านดี');
  assert.deepEqual(found, [{ code: '300200', name: 'ร้านดีจริง', channel: 'ร้าน Dealer ที่มี PC', group: 'DEALER_PC' }]);
  assert.equal((await sales.call('searchCustomers', '3003'))[0].group, 'BT', 'Customer Map overrides the channel');
  assert.deepEqual(await sales.call('searchCustomers', '%'), [], 'LIKE wildcards are literal');
  const boot = await sales.call('getBootstrap');
  assert.deepEqual(boot.customerGroups.map((g) => g.code), ['BT', 'DEALER_PC', 'NOTIER', 'SHOPEE']);
});

test('customer → group → tier price → terms in order (BT: 1,590 → 1,147.50, 27.8304%)', async () => {
  const r = await priceGp({ customerCode: '300100', productKey: 'HOB-TIER' });
  assert.equal(r.group.code, 'BT');
  assert.equal(r.customer.groupFrom, 'ช่องทาง SAP (Channel Map)');
  assert.equal(r.gross, 1590, 'BT HOTPRICE of the product');
  assert.deepEqual(r.steps.map((s) => [s.code, s.deduction, s.after]), [['BT_GP', 318, 1272], ['BT_MKT', 63.6, 1208.4], ['DC_FEE', 60.9, 1147.5]]);
  assert.equal(r.net, 1147.5);
  assert.equal(r.netExVat, 1072.43);
  assert.equal(r.totalDiscount, 0.278304);
  assert.ok(r.flags.some((f) => /ยกเลิก \(OR\)/.test(f)));
  assert.ok(!/cost|"mu"|gain/i.test(JSON.stringify(r)), 'never cost');

  const byBarcode = await price(sales, { customerCode: '300100', productKey: '2000000000017' });
  assert.equal(byBarcode.productKey, 'HOB-TIER');
  const shopee = await price(sales, { groupCode: 'shopee', productKey: 'HOB-TIER' });
  assert.equal(shopee.gross, 1990, 'DGT tier');
  assert.equal(shopee.net, 1253.7);
});

test('customer-only terms, product-scoped terms, expired terms and per-order fees', async () => {
  const r = await priceGp({ customerCode: '300200', productKey: 'HOB-TIER', qty: 4 });
  assert.equal(r.gross, 1490, 'GT tier');
  assert.deepEqual(r.steps.map((s) => s.code), ['GP_T20', 'PROMO', 'FREIGHT', 'CASH_DISC'], 'expired 50% left out, ordered by seq');
  assert.deepEqual(r.steps.map((s) => s.after), [1192, 1092, 1042, 1021.16]);
  assert.equal(r.steps[3].forCustomer, true);
  assert.equal(r.total, 4084.64);

  const other = await priceGp({ customerCode: '300200', productKey: 'HC-DEMO-90', qty: 1 });
  assert.equal(other.gross, 18990, 'not tiered: list price');
  assert.deepEqual(other.steps.map((s) => s.code), ['GP_T20', 'FREIGHT', 'CASH_DISC'], 'the barcode promo is not for this product');
  const special = await price(sup, { customerCode: '300300', productKey: 'HOB-TIER' });
  assert.equal(special.group.code, 'BT');
  assert.equal(special.customer.groupFrom, 'ลูกค้า (Customer Map)');
});

test('no price → type the gross price; no group → clear error', async () => {
  await assert.rejects(price(sales, { groupCode: 'BT', productKey: 'UNKNOWN-1' }), /กรอกราคาตั้งเอง/);
  const typed = await price(sales, { groupCode: 'BT', productKey: 'UNKNOWN-1', grossPrice: '10,000' });
  assert.equal(typed.grossSource, 'typed');
  assert.equal(typed.net, 7216.96);
  assert.ok(typed.flags.some((f) => /กรอกเอง/.test(f)));
  await assert.rejects(price(sales, { groupCode: 'NOTIER', productKey: 'HOB-TIER' }), /ยังไม่กำหนดราคาฐาน/);
  await assert.rejects(price(sales, { customerCode: '300400', productKey: 'HOB-TIER' }), /ยังไม่ได้กำหนดกลุ่ม/);
  await assert.rejects(price(sales, { customerCode: '999999', productKey: 'HOB-TIER' }), /ไม่พบรหัสลูกค้า/);
  await assert.rejects(price(sales, { groupCode: 'BT', productKey: 'HOB-TIER', qty: 0 }), /จำนวน/);
});

test('GP tier per group: per-item GP from SMG MASTER, BT compounding, T24 + Exw, NON PC wholesale with T20 fallback', async () => {
  // HOOD HI-HEE89-90 numbers from SMG MASTER OCT26-JAN27 and the partner price sheet; HP30-1BB/MSE from WHOLESALE (590 × 0.85)
  const add = (key, ean, gt, dgt, bt, rates, wholesale) => env.db.query(`insert into products (price_list_id, brand, key, name, cost, normal_price, source, barcode,
      status, price_gt, price_dgt, price_bt, tiered, gp_rates, wholesale)
    select id, 'EVE', $1, $1, 100, $3, 'SMG', $2, 'S', $3, $4, $5, true, $6, $7 from price_lists where name = 'APR26'`,
  [key, ean, gt, dgt, bt, rates && JSON.stringify(rates), wholesale && JSON.stringify(wholesale)]);
  await add('HOOD-GP', '2000000000208', 29990, 34590, 9990, { T15: 0.15, T18: 0.18, T20: 0.2, T24: 0.24, BT_GP: 0.15, BT_MKT: 0.05, BT_DC: 0.0504, DST1: 0.33 });
  await add('HP30-NONPC', '2000000000215', 590, 590, 590, { T20: 0.2 }, { net: 501.5, label: 'ราคาส่ง', options: [{ label: 'ซื้อ 12 ชิ้นขึ้นไป', net: 480 }] });

  const s = sheets();
  s.terms.push(term('EXW', 'ส่วนลด Exw', 'PCT_RUNNING'));
  s.groups = s.groups.map((r, i) => r.concat([i === 0 ? 'GP Tier (GP รายสินค้าจาก SMG MASTER)' : r[0] === 'BT' ? 'BT' : '']));
  s.groups.push(['DEALER_T18', 'ดีลเลอร์ T18', 'GT', '30', '', '', '', '', 'T18'], ['SOUVANNY_T24', 'Souvanny', 'GT', '', '', '', '', '', 't24'],
    ['DEALER_ONLINE', 'ดีลเลอร์ออนไลน์', 'DGT', '', '', '', '', '', 'DST1'], ['DEALER_NOPC', 'ดีลเลอร์ไม่มี PC', 'GT', '', '', '', '', '', 'NONPC'],
    ['BADTIER', 'GP Tier ผิด', 'GT', '', '', '', '', '', 'T99'], ['NOPC_NOTIER', 'Non-PC ไม่มีราคาฐาน', '', '', '', '', '', '', 'NONPC']);
  s.groupTerms.push(gterm('SOUVANNY_T24', 2, 'EXW', '3.00%'), gterm('NOPC_NOTIER', 5, 'CASH_DISC', '2.00%'));
  const r = await sync(s);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.data.errors.some((e) => /BADTIER GP Tier "T99" ไม่ถูกต้อง/.test(e)), r.body.data.errors.join('|'));
  const boot = await sales.call('getBootstrap');
  assert.equal(boot.customerGroups.find((g) => g.code === 'SOUVANNY_T24').gpTier, 'T24');
  assert.equal(boot.customerGroups.find((g) => g.code === 'BADTIER').gpTier, '', 'unknown tier: loaded without one');

  const t18 = await priceGp({ groupCode: 'DEALER_T18', productKey: 'HOOD-GP' });
  assert.deepEqual([t18.gross, t18.net, t18.gpTier.code], [29990, 24591.8, 'T18']);
  assert.deepEqual(t18.steps.map((x) => [x.code, x.pct, x.gpTier, x.defaulted]), [['T18', 0.18, true, false]]);
  const t24 = await priceGp({ groupCode: 'SOUVANNY_T24', productKey: 'HOOD-GP' });
  assert.deepEqual(t24.steps.map((x) => [x.code, x.after]), [['T24', 22792.4], ['EXW', 22108.63]], '24% then Exw 3%');
  const online = await price(sales, { groupCode: 'DEALER_ONLINE', productKey: 'HOOD-GP' });
  assert.deepEqual([online.gross, online.net], [34590, 23175.3]);

  const bt = await priceGp({ groupCode: 'BT', productKey: 'HOOD-GP' });
  assert.deepEqual(bt.steps.map((x) => [x.code, x.after]), [['BT_GP', 8491.5], ['BT_MKT', 8066.93], ['BT_DC', 7660.35]], 'the tier replaces the BT group terms');
  assert.deepEqual([bt.net, bt.netExVat], [7660.35, 7159.21]);
  const btDefault = await priceGp({ groupCode: 'BT', productKey: 'HOB-TIER' });
  assert.equal(btDefault.net, 1147.5, 'no item rates: 20% × 5% × 5.04% as today');
  assert.ok(btDefault.steps.every((x) => x.defaulted) && btDefault.flags.some((f) => /ใช้ค่าเริ่มต้นของ Tier/.test(f)));

  const nonpc = await priceGp({ groupCode: 'DEALER_NOPC', productKey: 'HP30-NONPC', qty: 2 });
  assert.deepEqual(nonpc.steps.map((x) => [x.code, x.deduction, x.after]), [['WHOLESALE', 88.5, 501.5]]);
  assert.deepEqual([nonpc.net, nonpc.total, nonpc.gpTier.used], [501.5, 1003, 'NONPC']);
  assert.deepEqual(nonpc.gpTier.wholesale.options, [{ label: 'ซื้อ 12 ชิ้นขึ้นไป', net: 480 }]);
  const fallback = await priceGp({ groupCode: 'DEALER_NOPC', productKey: 'HOOD-GP' });
  assert.deepEqual([fallback.net, fallback.gpTier.used, fallback.gpTier.fallback], [23992, 'T20', true], 'not in WHOLESALE: T20');
  assert.ok(fallback.flags.some((f) => /ไม่มีในใบราคา Non-PC/.test(f)));
  const noTier = await priceGp({ groupCode: 'NOPC_NOTIER', productKey: 'HP30-NONPC' });
  assert.deepEqual([noTier.gross, noTier.grossSource, noTier.net], [501.5, 'wholesale', 491.47], 'no price tier: the wholesale price is still found');
  assert.deepEqual(noTier.steps.map((x) => [x.code, x.after]), [['CASH_DISC', 491.47]], 'group terms apply after the wholesale net, as after any tier');
  for (const x of [t18, bt, nonpc, fallback]) assert.ok(!/cost|"mu"|gain/i.test(JSON.stringify(x)), 'GP % and net prices, never cost');
});

test('GP % is for the owner and the users the owner grants it to; sales and supervisors see net prices only, never cost', async () => {
  const q = { groupCode: 'DEALER_T18', productKey: 'HOOD-GP' };
  const hidden = (r) => r.gpHidden === true && !('totalDiscount' in r) && r.steps.every((s) => !('pct' in s) && !('deduction' in s) && !('after' in s) && !('thb' in s));
  for (const c of [sales, sup]) {
    const r = await price(c, q);
    assert.equal(r.net, 24591.8, 'net price is shown');
    assert.ok(hidden(r), JSON.stringify(r.steps));
    assert.deepEqual(r.steps.map((s) => s.name), ['ส่วนลดดีลเลอร์ T18'], 'step names only');
  }
  assert.ok(!hidden(await price(owner, q)));

  await assert.rejects(sup.call('listUsers'), /เฉพาะเจ้าของระบบ/);
  await assert.rejects(sup.call('saveUser', { email: 'pak.m@eve.co.th', role: 'SUPERVISOR', canViewGp: true }), /เฉพาะเจ้าของระบบ/);
  const admin2 = await env.client('admin2@eve.co.th').login();
  await assert.rejects(admin2.call('saveUser', { email: 'admin2@eve.co.th', role: 'ADMIN', canViewGp: true }), /เฉพาะเจ้าของระบบ/, 'ADMIN role is not enough');

  await owner.call('saveUser', { email: 'pak.m@eve.co.th', role: 'SUPERVISOR', canViewGp: true });
  const granted = await price(sup, q);
  assert.ok(!hidden(granted));
  assert.equal(granted.steps[0].pct, 0.18);
  assert.ok(!/cost|"mu"|gain/i.test(JSON.stringify(granted)), 'GP permission never brings cost');
  assert.equal((await sup.call('getBootstrap')).user.canSeeGp, true);
  assert.ok(hidden(await price(sales, q)), 'only pak.m was granted');
  await owner.call('saveUser', { email: 'pak.m@eve.co.th', role: 'SUPERVISOR' });
  assert.equal((await price(sup, q)).steps[0].pct, 0.18, 'leaving canViewGp out keeps it');

  const zero = await env.db.query(`update products set gp_rates = gp_rates || '{"T18": 0}' where key = 'HOOD-GP' returning key`);
  assert.equal(zero.rowCount, 1);
  const z = await price(sales, q);
  assert.equal(z.net, 29990);
  assert.ok(z.flags.some((f) => /^SMG MASTER ไม่ให้ส่วนลดสำหรับสินค้านี้ — อาจยกเลิก ไม่มีสต็อก/.test(f)), z.flags.join('|'));
  assert.ok(!z.flags.some((f) => /T18/.test(f)), 'no tier codes for users without GP');
  assert.ok((await price(owner, q)).flags.some((f) => /ไม่ให้ส่วนลดสำหรับสินค้านี้ \(T18\)/.test(f)));
  const noRates = await price(sales, { groupCode: 'BT', productKey: 'HOB-TIER' });
  assert.ok(noRates.flags.some((f) => /^ไม่มี GP รายสินค้าใน SMG MASTER — ใช้ค่าเริ่มต้นของ Tier$/.test(f)) && noRates.steps.every((s) => !('defaulted' in s)),
    'no rate keys or per-step default marks for users without GP');
  await env.db.query(`update products set gp_rates = gp_rates || '{"BT_MKT": 0, "BT_DC": 0}' where key = 'HOOD-GP'`);
  assert.ok(!(await price(owner, { groupCode: 'BT', productKey: 'HOOD-GP' })).flags.some((f) => /ไม่ให้ส่วนลด/.test(f)), '0% fee steps are normal');
});

test('the owner can close menus per user; the server refuses their functions too', async () => {
  await assert.rejects(owner.call('saveUser', { email: 'akrawat@eve.co.th', role: 'SALES' }), /ตัวเอง/);
  await assert.rejects(admin2Client().then((c) => c.call('listUsers')), /เฉพาะเจ้าของระบบ/);
  await owner.call('saveUser', { email: 'pak.m@eve.co.th', role: 'SUPERVISOR', canViewCost: true, can_view_cost: true });
  assert.equal((await env.db.query(`select can_view_cost from users where email = 'pak.m@eve.co.th'`)).rows[0].can_view_cost, false, 'cost is never granted in the app');
  const ownerB = { db: env.db, cfg: Object.assign({}, env.cfg, { owners: ['akrawat@eve.co.th', 'owner.b@eve.co.th'] }), user: { email: 'akrawat@eve.co.th', isOwner: true } };
  await assert.rejects(require('../src/rfq/service').rpc.saveUser(ownerB, { email: 'owner.b@eve.co.th', role: 'SALES' }), /เจ้าของระบบต้องเป็น ADMIN/,
    'one owner cannot demote another');
  await owner.call('saveUser', { email: 'first.time@eve.co.th', role: 'SALES' });
  assert.deepEqual(Object.values((await env.db.query(`select can_view_gp, hidden_menus from users where email = 'first.time@eve.co.th'`)).rows[0]), [false, []]);
  const users = await owner.call('listUsers');
  assert.ok(users.menus.some((m) => m.id === 'custprice'));
  const me = users.users.find((u) => u.email === 'akrawat@eve.co.th');
  assert.deepEqual([me.isOwner, me.canViewCost], [true, true]);
  await owner.call('saveUser', { email: 'sales1@eve.co.th', role: 'SALES', hiddenMenus: ['custprice', 'bundles', 'nope'] });
  const row = (await owner.call('listUsers')).users.find((u) => u.email === 'sales1@eve.co.th');
  assert.deepEqual(row.hiddenMenus.sort(), ['bundles', 'custprice'], 'unknown menu ids dropped');
  assert.deepEqual((await sales.call('getBootstrap')).user.hiddenMenus.sort(), ['bundles', 'custprice']);
  await assert.rejects(price(sales, { groupCode: 'BT', productKey: 'HOB-TIER' }), /เมนูนี้ถูกปิด/);
  await assert.rejects(sales.call('searchCustomers', 'ร้าน'), /เมนูนี้ถูกปิด/);
  await sales.call('priceCheck', { channelId: 'GT_EVE', productKey: 'HC-DEMO-90', specialPrice: 16990, discounts: [0.18, 0, 0] });
  await owner.call('saveUser', { email: 'sales1@eve.co.th', role: 'SALES', hiddenMenus: ['check'] });
  await sales.call('priceCheck', { channelId: 'GT_EVE', productKey: 'HC-DEMO-90', specialPrice: 16990, discounts: [0.18, 0, 0] });
  await owner.call('saveUser', { email: 'sales1@eve.co.th', role: 'SALES', hiddenMenus: ['check', 'new'] });
  await assert.rejects(sales.call('priceCheck', { channelId: 'GT_EVE', productKey: 'HC-DEMO-90', specialPrice: 16990, discounts: [0.18, 0, 0] }), /เมนูนี้ถูกปิด/,
    'priceCheck is refused only when both menus that use it are closed');
  await owner.call('saveUser', { email: 'sales1@eve.co.th', role: 'SALES', hiddenMenus: [] });
  assert.equal((await price(sales, { groupCode: 'BT', productKey: 'HOB-TIER' })).net, 1147.5);
});
