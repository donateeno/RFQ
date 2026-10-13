'use strict';
/**
 * SMG catalogue sync (n8n → /api/integrations/import/smg_catalog): cost file + Nationwide pricelist +
 * SMG MASTER (and its HOTPRICE tab). Synthetic barcodes, names and costs shaped like the real sheets.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, isoDay } = require('./helpers');

let env, owner, sup, sales;

test.before(async () => {
  env = await startApp();
  await env.seedFixtures(); // legacy list APR26, effective 60 days ago
  owner = await env.client('akrawat@eve.co.th').login();
  sup = await env.client('pak.m@eve.co.th').login();
  sales = await env.client('sales1@eve.co.th').login();
});
test.after(() => env.close());

const EAN = { A: '2000000000017', B: '2000000000024', C: '2000000000031', D: '2000000000048', E: '2000000000055', F: '2000000000062', G: '2000000000079' };
const row = (n, cells) => { const r = new Array(n).fill(''); Object.entries(cells).forEach(([i, v]) => { r[i] = v; }); return r; };

// COST UPDATE 2021 for import, '2021'!A3:AQ — A EAN13, C EVE's Model, P cost (formatted), AQ ST
const costHead = row(43, { 0: 'EAN13', 1: 'FACTORY', 2: "EVE's Model", 15: 'ราคาต้นทุนนำเข้า/หน่วย', 17: 'Promotion Price', 42: 'ST' });
const cost = (ean, model, c, st) => row(43, { 0: ean, 2: model, 15: c, 42: st });
// SMG PRICELIST NATIONWIDE, 'Pricelist update'!A2:I
const plHead = ['STATUS', 'EAN13', 'BRAND', 'CATEGORY', 'DESCRIPTION/MODEL', 'NORMAL', 'PROMOTION', 'REMARK', 'PRICE CAT.'];
// SMG MASTER, 'MASTER'!A1:R — A item, B brand, C description, E group, G old special, H GT, I DGT, R BT
const masterHead = row(18, { 0: 'Item No.', 1: 'ยี่ห้อ', 2: 'Item Description', 3: 'Status', 4: 'Group Name', 6: 'ราคาขายพิเศษเดิม', 7: 'GT HOTPRICE', 8: 'DGT HOTPRICE', 17: 'BT HOTPRICE' });
const master = (item, brand, name, old, gt, dgt, bt) => row(18, { 0: item, 1: brand, 2: name, 4: '103 เตาแก๊ส', 6: old, 7: gt, 8: dgt, 17: bt });
// SMG MASTER, 'HOTPRICE'!A1:G
const hotHead = ['SALE CH.', 'EAN13', 'Price b/f Set', 'MODEL NAME', 'BT HOTPRICE', 'DGT HOTPRICE', 'GT HOTPRICE'];

function sheets(opts) {
  opts = opts || {};
  const pl = [plHead,
    ['S', EAN.A, 'EVE', 'GAS STOVE', 'HOB ALPHA 2 หัว', '3,990', '2,490', '', 'NS'],
    ['OR', EAN.B, 'EVE', 'GAS STOVE', 'HOB BETA (เลิกผลิต)', '7,990', '5,990', '', 'A'],
    ['S', EAN.C, 'EVE', 'OVEN', 'OVEN GAMMA 60 cm', '35,990', '29,990', '', 'B']];
  if (!opts.dropEvercook) pl.push(['S', EAN.E, 'EVERCOOK', 'MISC.', 'PAN EVERCOOK 28 cm', '1,590', '990', '', 'NS']);
  return {
    cost: [costHead,
      cost(EAN.A, 'HOB-ALPHA', '1,000.00', 'Y'),
      cost(EAN.A, 'HOB-ALPHA', '9,999.00', 'Y'),            // duplicate: first row wins
      cost(EAN.B, 'HOB-BETA', '3,000.00', 'N '),            // not for sale ("N " with a space): no cost
      cost(EAN.C, 'OVEN-GAMMA', '9,000.00', ''),            // blank ST: imported
      cost(EAN.D, 'HOOD-DELTA', '5,000.00', 'Y'),
      cost(EAN.E, 'PAN-EVERCOOK', '300', 'Y'),
      cost(EAN.F, 'HOB-OLD', '700', 'Y'),
      cost(EAN.G, 'HOB-ALPHA', '1,100.00', 'Y'),            // same model name as A
      cost('8.85174E+12', 'BROKEN', '1', 'Y')],
    pricelist: opts.pricelist || pl,
    master: [masterHead,
      master('1011050', 'FOSTER', 'MILANO BOWL', '47,590.00', '51,590.00', '51,590', '51,590'),   // Foster: later
      master(EAN.A, 'EVE', 'HOB ALPHA', '0.00', '1,990.00', '2,290', '2,190'),
      master(EAN.B, 'EVE', 'HOB BETA', '1,190.00', '5,990.00', '5,990', '5,990'),
      master(EAN.C, 'EVE', 'OVEN GAMMA', '0.00', '25,990.00', '', ''),
      master(EAN.D, 'EVE', 'HOOD DELTA', '12,990.00', '12,990.00', '12,990', '11,990'),          // R differs: reported
      master(EAN.F, 'EVE', 'HOB OLD', '1,190.00', '', '', '')],
    hot: [hotHead,
      ['NTW', EAN.A, '103 เตาแก๊ส', 'HOB ALPHA', '2,190', '2,290', '1,990'],
      ['GT Exclus.', EAN.C, '112 เตาอบ', 'OVEN GAMMA', '', '', '25,990'],
      ['ยกเลิก', EAN.F, '103 เตาแก๊ส', 'HOB OLD', '', '', '']]
  };
}

const sync = (body, list) => fetch(env.base + '/api/integrations/import/smg_catalog?priceList=' + encodeURIComponent(list || 'oct26-jan27'), {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' }, body: JSON.stringify({ sheets: body })
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const check = (c, channelId, key, special, discounts) => c.call('priceCheck', { channelId, productKey: key, specialPrice: special || 1000, discounts: discounts || [] });

test('sync needs the period to exist, then imports cost, barcodes and the channel prices', async () => {
  let r = await sync(sheets());
  assert.equal(r.status, 409, 'unknown period: nothing imported');
  await owner.call('createPriceList', { name: 'OCT26-JAN27', effectiveFrom: isoDay(-1) });
  r = await sync(sheets());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.equal(d.priceList, 'OCT26-JAN27');
  assert.equal(d.imported, 7, 'A, B, C, D, E, F, G — Foster and the broken barcode skipped');
  assert.equal(d.withCost, 6);
  assert.equal(d.notForSale, 1);
  assert.equal(d.blankSaleStatus, 1);
  assert.deepEqual(d.duplicateBarcodes, [EAN.A]);
  assert.equal(d.badBarcodes, 1);
  assert.deepEqual(d.masterMismatches, [EAN.D]);
  assert.deepEqual(d.statuses, { S: 3, OR: 1, '-': 3 });
  assert.ok(!JSON.stringify(d).includes('9,000') && !JSON.stringify(d).includes('9000'), 'no cost in the import result');
});

test('each channel uses its tier: GT, DGT for online, BT; showroom uses GT; cost is the same everywhere', async () => {
  const at = async (ch, key, d) => { const r = await check(owner, ch, key, 1000, d); return [r.normalPrice, r.cost]; };
  assert.deepEqual(await at('GT_EVE', 'HOB-ALPHA', [0.18, 0, 0]), [1990, 1000]);
  assert.deepEqual(await at('OFFI_SHOPEE', 'HOB-ALPHA', [0.37]), [2290, 1000]);
  assert.deepEqual(await at('OFFI_SHOWROOM', 'HOB-ALPHA', [0.2]), [1990, 1000]);
  assert.deepEqual(await at('BT_EVE', 'HOB-ALPHA', []), [2190, 1000]);
  assert.deepEqual(await at('BT_EVE', 'HOOD-DELTA', []), [12990, 5000], 'NOTFOUND: old special price');
  assert.deepEqual(await at('GT_EVE', 'PAN-EVERCOOK', [0.18, 0, 0]), [990, 300], 'Evercook: Nationwide promotion');

  const byBarcode = await check(owner, 'GT_EVE', EAN.A, 1000, [0.18, 0, 0]);
  assert.equal(byBarcode.productKey, 'HOB-ALPHA');
  assert.equal((await check(owner, 'GT_EVE', EAN.G, 1000, [0.18, 0, 0])).productKey, 'HOB-ALPHA [' + EAN.G + ']', 'same model name, other barcode');
});

test('warnings: discontinued (OR), not for sale (no cost), not sold in a channel this period', async () => {
  const b = await check(sales, 'GT_EVE', 'HOB-BETA', 5000, [0.18, 0, 0]);
  assert.equal(b.indicator, 'NO COST');
  assert.ok(b.flags.some((f) => /ยกเลิก \(OR\)/.test(f)), b.flags.join('|'));
  assert.ok(b.flags.includes('ไม่มีต้นทุน'));

  const bt = await check(sup, 'BT_EVE', 'OVEN-GAMMA', 20000, []);
  assert.equal(bt.normalPrice, null);
  assert.ok(bt.flags.some((f) => /ไม่มีราคาขายช่องทาง BT.*GT Exclus\./.test(f)), bt.flags.join('|'));
  assert.equal((await check(sup, 'GT_EVE', 'OVEN-GAMMA', 20000, [0.18, 0, 0])).normalPrice, 25990);

  const old = await check(sales, 'GT_EVE', 'HOB-OLD', 900, [0.18, 0, 0]);
  assert.equal(old.normalPrice, null, '"ยกเลิก" in HOTPRICE: no price even with an old special price');
});

test('bootstrap sends the tier prices, barcode and status — never cost; sales/supervisor checks never show cost', async () => {
  const boot = await sales.call('getBootstrap');
  const a = boot.products.find((p) => p.k === 'HOB-ALPHA');
  assert.deepEqual(a.t, { GT: 1990, DGT: 2290, BT: 2190 });
  assert.equal(a.bc, EAN.A);
  assert.equal(a.lp, 3990);
  assert.equal(boot.products.find((p) => p.k === 'HOB-BETA').st, 'OR');
  assert.equal(boot.products.find((p) => p.k === 'PAN-EVERCOOK').mk, 'EVERCOOK');
  assert.ok(boot.products.every((p) => !('cost' in p) && !('c' in p)));
  const s = await check(sales, 'OFFI_SHOPEE', 'HOB-ALPHA', 2290, [0.37]);
  assert.ok(!('cost' in s) && !('mu' in s) && !('muBand' in s));
  const v = await check(sup, 'OFFI_SHOPEE', 'HOB-ALPHA', 2290, [0.37]);
  assert.ok(!('cost' in v) && !('mu' in v) && 'muBand' in v);
});

test('bundles of synced products are priced per channel tier', async () => {
  const b = await sales.call('createBundle', { brand: 'EVE', items: [{ productKey: 'HOB-ALPHA' }, { productKey: EAN.D }] });
  assert.equal(b.k, 'HOB-ALPHA + HOOD-DELTA', 'barcode accepted, stored by model');
  assert.deepEqual(b.t, { GT: 1990 + 12990, DGT: 2290 + 12990, BT: 2190 + 12990 });
  const r = await check(owner, 'BT_EVE', b.k, 14000, []);
  assert.equal(r.normalPrice, 2190 + 12990);
  assert.equal(r.cost, 1000 + 5000);
});

test('a moved column stops the sync and changes nothing; a later sync replaces the period (dropped items go)', async () => {
  const bad = sheets();
  bad.pricelist = bad.pricelist.map((r, i) => (i === 0 ? r.map((h) => (h === 'PROMOTION' ? 'PROMO' : h)) : r));
  const r = await sync(bad);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /คอลัมน์ G ต้องเป็น "PROMOTION" แต่พบ "PROMO"/);
  assert.equal((await check(owner, 'GT_EVE', 'PAN-EVERCOOK', 900, [0.18, 0, 0])).normalPrice, 990, 'unchanged');

  const info = await owner.call('getAdminInfo');
  assert.equal(info.catalogSync.ok, false);
  assert.match(info.catalogSync.error, /PROMOTION/);

  assert.equal((await sync(sheets({ dropEvercook: true }))).status, 200);
  const gone = await check(owner, 'GT_EVE', 'PAN-EVERCOOK', 900, [0.18, 0, 0]);
  assert.equal(gone.found, true, 'still in the cost file');
  assert.equal(gone.normalPrice, null, 'no longer in the Nationwide pricelist → no price');
  const after = await owner.call('getAdminInfo');
  assert.equal(after.catalogSync.ok, true);
  assert.equal(after.catalogSync.imported, 7);
  assert.equal(after.catalogSync.masterMismatchCount, 1);
  assert.ok(!JSON.stringify(after.catalogSync).includes('5000'), 'no cost in the sync status');
});

test('sync now: admin only, needs SYNC_WEBHOOK_URL', async () => {
  await assert.rejects(sup.call('requestCatalogSync'), /ไม่มีสิทธิ์/);
  await assert.rejects(owner.call('requestCatalogSync'), /SYNC_WEBHOOK_URL/);
});
