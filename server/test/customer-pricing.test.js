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
  const r = await price(sales, { customerCode: '300100', productKey: 'HOB-TIER' });
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
  const r = await price(sup, { customerCode: '300200', productKey: 'HOB-TIER', qty: 4 });
  assert.equal(r.gross, 1490, 'GT tier');
  assert.deepEqual(r.steps.map((s) => s.code), ['GP_T20', 'PROMO', 'FREIGHT', 'CASH_DISC'], 'expired 50% left out, ordered by seq');
  assert.deepEqual(r.steps.map((s) => s.after), [1192, 1092, 1042, 1021.16]);
  assert.equal(r.steps[3].forCustomer, true);
  assert.equal(r.total, 4084.64);

  const other = await price(sup, { customerCode: '300200', productKey: 'HC-DEMO-90', qty: 1 });
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
