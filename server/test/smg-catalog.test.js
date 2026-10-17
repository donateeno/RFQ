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

// COST UPDATE 2021 for import, 'relationship'!A2:AA — A EAN13, C/E/G/I parts, D/F/H/J part costs, K total, AA EAN13
const setHead = row(27, { 0: 'EAN13', 1: 'Description', 2: 'Subset1 Description', 3: 'Cost subset1', 4: 'Subset2 Description', 5: 'Cost subset2',
  6: 'Subset1 Description', 7: 'Cost subset3', 8: 'Subset4 Description', 9: 'Cost subset4', 10: 'Total Set Cost', 26: 'EAN13' });
const setRow = (ean, parts, total, ean2) => {
  const r = row(27, { 0: ean || '', 10: total, 26: ean2 || '' });
  [0, 1, 2, 3].forEach((i) => { r[2 + i * 2] = parts[i] ? parts[i][0] : ''; r[3 + i * 2] = parts[i] ? parts[i][1] : '0'; });
  return r;
};
const SET = { ok: '2000000000086', viaAA: '2000000000093', zero: '2000000000109', na: '2000000000116', sum: '2000000000123',
  conflict: '2000000000130', twice: '2000000000147', notSold: '2000000000154', blank: '2000000000161' };

test('set costs come from the relationship tab only when every part has a cost and the total adds up', async () => {
  const s = sheets();
  for (const [k, ean] of Object.entries(SET)) if (k !== 'notSold') s.master.push(master(ean, 'EVE', 'SET ' + k.toUpperCase(), '4,990.00', '4,990.00', '', ''));
  s.sets = [setHead,
    setRow(SET.ok, [['HOB-ALPHA', '1,000.00'], ['HOOD-DELTA', '5,000.00']], '6,000.00'),
    setRow('', [['HOB-ALPHA', '1,000.00'], ['PAN-EVERCOOK', '300.00']], '1,300.00', SET.viaAA),
    setRow(SET.zero, [['HOB-ALPHA', '1,000.00'], ['HOOD-DELTA', '5,000.00'], ['NEW-SINK', '0']], '6,000.00'),   // part not found → 0
    setRow(SET.blank, [['HOB-ALPHA', '1,000.00'], ['HOOD-DELTA', '']], '1,000.00'),                          // part named, cost blank
    setRow(EAN.B, [['HOB-ALPHA', '1,000.00'], ['PAN-EVERCOOK', '300.00']], '1,300.00'),                     // ST = N in '2021'
    setRow(SET.na, [['HOB-NEW', '#N/A'], ['HOOD-DELTA', '5,000.00']], '#N/A'),
    setRow(SET.sum, [['HOB-ALPHA', '1,000.00'], ['HOOD-DELTA', '5,000.00']], '5,500.00'),
    setRow(SET.conflict, [['HOB-ALPHA', '1,000.00'], ['HOOD-DELTA', '5,000.00']], '6,000.00'),
    setRow(SET.conflict, [['HOB-ALPHA', '1,000.00'], ['PAN-EVERCOOK', '300.00']], '1,300.00'),
    setRow(SET.twice, [['HOB-ALPHA', '1,000.00'], ['PAN-EVERCOOK', '300.00']], '1,300.00'),
    setRow(SET.twice, [['HOB-ALPHA', '1,000.00'], ['PAN-EVERCOOK', '300.00']], '1,300.00'),
    setRow(SET.notSold, [['HOB-ALPHA', '1,000.00'], ['PAN-EVERCOOK', '300.00']], '1,300.00'),
    setRow(EAN.A, [['HOB-ALPHA', '1,000.00'], ['PAN-EVERCOOK', '300.00']], '1,300.00'),                     // has its own unit cost
    setRow('', [['SMART II', '4,000.00'], ['ARC 90', '500.07']], '4,500.07'),                                  // no barcode
    setRow('', [], '#N/A')];                                                                                    // empty template row
  const r = await sync(s);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.equal(d.setRows, 14);
  assert.equal(d.setNoBarcode, 1);
  assert.equal(d.setCostUsed, 3, 'ok, via AA, identical duplicate rows');
  assert.deepEqual(d.setZeroPart, [SET.zero, SET.blank]);
  assert.deepEqual(d.setNoTotal, [SET.na]);
  assert.deepEqual(d.setSumMismatch, [SET.sum]);
  assert.deepEqual(d.setConflict, [SET.conflict]);
  assert.deepEqual(d.setNotInCatalogueList, [SET.notSold]);
  assert.ok(!/6,?000|1,?300/.test(JSON.stringify(d)), 'no cost in the import result');

  const costOf = async (ean) => (await check(owner, 'GT_EVE', ean, 4000, [0.18, 0, 0])).cost;
  assert.equal(await costOf(SET.ok), 6000);
  assert.equal(await costOf(SET.viaAA), 1300);
  assert.equal(await costOf(SET.twice), 1300);
  for (const k of ['zero', 'blank', 'na', 'sum', 'conflict']) assert.equal(await costOf(SET[k]), null, k + ': no cost rather than a wrong one');
  assert.equal(await costOf(EAN.B), null, 'ST = N in the 2021 tab: no cost, not even a set cost');
  assert.equal(await costOf(EAN.A), 1000, 'a unit cost from the 2021 tab wins');
  const seen = await check(sales, 'GT_EVE', SET.ok, 4000, [0.18, 0, 0]);
  assert.ok(!('cost' in seen) && !('mu' in seen), 'sales still see the indicator only');

  const info = await owner.call('getAdminInfo');
  assert.equal(info.catalogSync.setCostUsed, 3);
  assert.deepEqual(info.catalogSync.setZeroPart, [SET.zero, SET.blank]);
  assert.ok(!/6,?000|1,?300/.test(JSON.stringify(info)), 'no set cost in the sync status or the audit log');

  const fixedTypo = sheets();
  fixedTypo.master.push(master(SET.ok, 'EVE', 'SET OK', '4,990.00', '4,990.00', '', ''));
  fixedTypo.sets = [setHead.map((h, i) => (i === 6 ? 'Subset3 Description' : h)), setRow(SET.ok, [['HOB-ALPHA', '1,000.00'], ['HOOD-DELTA', '5,000.00']], '6,000.00')];
  assert.equal((await sync(fixedTypo)).status, 200, 'G may be renamed to "Subset3 Description"');
  assert.equal(await costOf(SET.ok), 6000);
  assert.equal((await sync(Object.assign(sheets(), { sets: [] }))).status, 200, 'an empty relationship tab does not stop the sync');
  assert.equal((await sync(sheets())).status, 200, 'the sets range is optional');
});

// MASTER!A1:Y adds the per-item GP columns K–O and T, U, V, Y; 'WHOLESALE'!A1:M is the NON PC price list
const gpHead = row(25, Object.assign({}, Object.fromEntries(masterHead.map((h, i) => [i, h])),
  { 10: 'ส่วนลด SCGH', 11: 'ส่วนลดT15', 12: 'ส่วนลดT18', 13: 'ส่วนลดT20', 14: 'ส่วนลดT24', 19: 'ส่วนลด BT', 20: 'BT MKT FEE', 21: 'DC FEE', 24: 'DST1 GP' }));
const withGp = (r, rates) => { const o = r.concat(new Array(25 - r.length).fill('')); Object.entries(rates).forEach(([i, v]) => { o[i] = v; }); return o; };
const whHead = ['DisplayinUPC', 'EAN13', 'MODEL NAME', 'DESCRIPTION', 'UP/DOWN COST', 'COST', 'PROMOTION2', 'WH PRICE', 'ค่าขนส่ง', 'Column1', '%DISC.', 'GP', 'GP DISC.'];
const wh = (display, ean, desc, net) => [display, ean, 'MODEL', desc, '', '', '', '', '', '', '', '', net];

test('per-item GP rates from SMG MASTER and NON PC wholesale prices are stored with the period (never cost)', async () => {
  const s = sheets();
  s.master = s.master.map((r, i) => {
    if (i === 0) return gpHead;
    if (r[0] === EAN.A) return withGp(r, { 10: '20%', 11: '15.00%', 12: '18%', 13: '20%', 14: '24%', 19: '15%', 20: '5%', 21: '5.04%', 24: '33%' });
    if (r[0] === EAN.D) return withGp(r, { 11: '150%', 13: '25%', 14: '60%' });   // 150%: typo, skipped and listed; 60% = gpRateMax: kept
    if (r[0] === EAN.F) return withGp(r, { 11: '0.15', 12: '-' });                 // no % format: ambiguous, listed
    return withGp(r, {});
  });
  s.wholesale = [whHead,
    wh('TRUE', EAN.A, 'ราคาส่ง', '501.50'), wh('FALSE', EAN.A, 'ซื้อ 12 ชิ้นขึ้นไป', '480.00'), wh('TRUE', EAN.A, 'ซ้ำ', '1.00'),
    wh('TRUE', '2000000009999', 'ไม่มีในรอบราคา', '100.00'), wh('TRUE', 'BAD', 'บาร์โค้ดผิด', '100.00'), []];
  const r = await sync(s);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.deepEqual(d.gpColumns, ['SCGH', 'T15', 'T18', 'T20', 'T24', 'BT_GP', 'BT_MKT', 'BT_DC', 'DST1']);
  assert.equal(d.gpRated, 2);
  assert.deepEqual(d.gpBadRates, [EAN.D, EAN.F]);
  assert.equal(d.wholesaleRows, 5);
  assert.equal(d.wholesaleBadRows, 1);
  assert.deepEqual(d.wholesaleDuplicates, [EAN.A]);
  assert.equal(d.wholesaleUsed, 1);
  assert.deepEqual(d.wholesaleNotInCatalogueList, ['2000000009999']);

  const stored = async (ean) => (await env.db.query(`select gp_rates, wholesale from products p join price_lists l on l.id = p.price_list_id
    where l.name = 'OCT26-JAN27' and p.barcode = $1`, [ean])).rows[0];
  const a = await stored(EAN.A);
  assert.deepEqual(a.gp_rates, { SCGH: 0.2, T15: 0.15, T18: 0.18, T20: 0.2, T24: 0.24, BT_GP: 0.15, BT_MKT: 0.05, BT_DC: 0.0504, DST1: 0.33 });
  assert.deepEqual(a.wholesale, { net: 501.5, label: 'ราคาส่ง', row: 2, options: [{ label: 'ซื้อ 12 ชิ้นขึ้นไป', net: 480 }] });
  assert.deepEqual((await stored(EAN.D)).gp_rates, { T20: 0.25, T24: 0.6 });
  assert.equal((await stored(EAN.F)).gp_rates, null);
  assert.equal((await stored(EAN.C)).gp_rates, null);

  const info = (await owner.call('getAdminInfo')).catalogSync;
  assert.equal(info.gpRated, 2);
  assert.equal(info.wholesaleUsed, 1);
  assert.ok(!/1,?000|5,?000/.test(JSON.stringify(info)), 'no cost in the sync status');

  const moved = sheets();
  moved.master[0] = gpHead.map((h, i) => (i === 12 ? 'ส่วนลด T18 ใหม่' : h));
  const bad = await sync(moved);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /คอลัมน์ M ต้องเป็น "ส่วนลดT18"/);
  assert.deepEqual((await stored(EAN.A)).gp_rates.T18, 0.18, 'unchanged');
  const movedBt = sheets();
  movedBt.master[0] = gpHead.map((h, i) => (i === 21 ? 'DC FEE ใหม่' : h));
  assert.match((await sync(movedBt)).body.error, /คอลัมน์ V ต้องเป็น "DC FEE"/, 'the T–Y block is checked on its own');
  const onlyKtoO = sheets();
  onlyKtoO.master = onlyKtoO.master.map((r, i) => (i === 0 ? gpHead.slice(0, 18) : r));
  const partial = await sync(onlyKtoO);
  assert.equal(partial.status, 200, 'MASTER!A1:R with K–O only still imports');
  assert.deepEqual(partial.body.data.gpColumns, ['SCGH', 'T15', 'T18', 'T20', 'T24']);
});

test('sync now: admin only, needs SYNC_WEBHOOK_URL', async () => {
  await assert.rejects(sup.call('requestCatalogSync'), /ไม่มีสิทธิ์/);
  await assert.rejects(owner.call('requestCatalogSync'), /SYNC_WEBHOOK_URL/);
});

// ------------------------------------------------------------- data sources page and alerts (owner only)

const FILE_ID = { cost: '1CostFileId_abcdefghijklmnop', nationwide: '1NationwideId_abcdefghijklmn', master: '1MasterFileId_abcdefghijklmno' };
const syncWith = (body, meta) => fetch(env.base + '/api/integrations/import/smg_catalog?priceList=OCT26-JAN27', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' }, body: JSON.stringify(Object.assign({ sheets: body }, meta))
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const alerts = () => env.mail.filter((m) => m.event === 'source.alert');

test('data sources: every file, tab, range and column; links from n8n; missing optional tabs are alerted by email and LINE', async () => {
  await assert.rejects(sup.call('getDataSources'), /เฉพาะเจ้าของระบบ/);
  env.mail.length = 0;
  await env.db.query(`delete from audit_log where action = 'ALERT'`);   // earlier syncs in this file already alerted
  const s = sheets();
  s.sets = [setHead];
  const r = await syncWith(s, { files: { cost: FILE_ID.cost, nationwide: FILE_ID.nationwide, master: { id: FILE_ID.master, name: 'SMG MASTER OCT26-JAN27' }, evil: 'x' },
    missing: ['wholesale', 'nope'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const d = await owner.call('getDataSources');
  const file = (k) => d.files.find((f) => f.key === k);
  assert.equal(file('cost').url, `https://docs.google.com/spreadsheets/d/${FILE_ID.cost}/edit`);
  assert.equal(file('master').name, 'SMG MASTER OCT26-JAN27');
  assert.equal(file('mapping').url, '', 'not synced yet');
  const tab = (k) => d.files.flatMap((f) => f.tabs).find((t) => t.key === k);
  assert.deepEqual([tab('cost').range, tab('cost').state, tab('cost').rows], ["'2021'!A3:AQ", 'ok', 9]);
  assert.deepEqual(tab('cost').columns.find((c) => c.col === 'P'), { col: 'P', header: 'ราคาต้นทุนนำเข้า/หน่วย', use: 'ต้นทุนต่อหน่วย (เห็นเฉพาะผู้ดูต้นทุน)' });
  assert.ok(tab('master').columns.some((c) => c.col === 'M' && c.header === 'ส่วนลดT18'), 'GP columns listed');
  assert.equal(tab('master').range, "'MASTER'!A1:Y");
  assert.equal(tab('wholesale').state, 'missing');
  assert.equal(tab('sets').state, 'empty');
  assert.equal(tab('terms').state, 'never');
  assert.ok(!JSON.stringify(d).includes('9,000') && !JSON.stringify(d).includes('9000'), 'no cost values');

  const sent = alerts();
  assert.equal(sent.length, 2, sent.map((m) => m.subject).join('|'));
  assert.ok(sent.some((m) => /ไม่ได้รับแท็บ WHOLESALE จากไฟล์ COST UPDATE 2021 for import/.test(m.subject)));
  assert.ok(sent.some((m) => /แท็บ relationship ของไฟล์ COST UPDATE 2021 for import ไม่มีข้อมูล/.test(m.subject)));
  assert.deepEqual(sent[0].to, ['akrawat@eve.co.th']);
  assert.deepEqual(sent[0].line, ['U0123456789abcdef0123456789abcdef'], 'invalid LINE IDs in ALERT_LINE_TO are dropped');
  assert.match(sent[0].text, /#sources/);
  assert.equal((await owner.call('getBootstrap')).alerts.length, 2, 'banner for the owner');
  assert.ok(!('alerts' in (await sup.call('getBootstrap'))));

  await syncWith(s, { missing: ['wholesale'] });
  assert.equal(alerts().length, 2, 'the same problem is not sent again within 24 hours');

  const bad = sheets();
  bad.pricelist = bad.pricelist.map((row, i) => (i === 0 ? row.map((h) => (h === 'PROMOTION' ? 'PROMO' : h)) : row));
  assert.equal((await syncWith(bad, {})).status, 400);
  const failed = alerts().filter((m) => /ซิงค์ไม่สำเร็จ/.test(m.subject));
  assert.equal(failed.length, 1);
  assert.match(failed[0].text, /PROMOTION/);
  assert.equal((await owner.call('getDataSources')).types.find((t) => t.type === 'smg_catalog').failed, true);

  // header row moved down by one: the check must not quote the data cell it finds (column P is cost)
  const shifted = sheets();
  shifted.cost = shifted.cost.slice(1);
  const moved = await syncWith(shifted, {});
  assert.equal(moved.status, 400);
  assert.match(moved.body.error, /คอลัมน์ P ต้องเป็น "ราคาต้นทุนนำเข้า\/หน่วย" แต่พบ ตัวเลข/);
  assert.ok(!/1,000|9,999/.test(moved.body.error) && !alerts().some((m) => /1,000|9,999/.test(m.subject + m.text + m.html)), 'no cost in the error or the alerts');

  const ok = Object.assign(sheets(), { sets: [setHead, setRow(SET.ok, [['HOB-ALPHA', '1,000.00'], ['HOOD-DELTA', '5,000.00']], '6,000.00')], wholesale: [whHead, wh('TRUE', EAN.A, 'ราคาส่ง', '501.50')] });
  assert.equal((await syncWith(ok, { files: { cost: FILE_ID.cost } })).status, 200);
  const healthy = await owner.call('getDataSources');
  assert.deepEqual(healthy.problems.filter((p) => !/ราคาตามลูกค้า/.test(p)), [], 'all SMG tabs fine again');
  assert.equal(healthy.files.find((f) => f.key === 'cost').url, `https://docs.google.com/spreadsheets/d/${FILE_ID.cost}/edit`);
});

test('no successful sync for SYNC_STALE_HOURS: the hourly check alerts once', async () => {
  const { checkAndAlert } = require('../src/rfq/sources');
  env.mail.length = 0;
  await env.db.query(`update audit_log set at = now() - interval '30 hours' where action in ('IMPORT', 'IMPORT_FAILED')`);
  await env.db.query(`delete from audit_log where action = 'ALERT'`);
  const notify = (m) => env.mail.push(m);
  const found = await checkAndAlert(env.db, env.cfg, notify, 26);
  assert.ok(found.some((p) => /ซิงค์ราคา SMG: ไม่มีการซิงค์สำเร็จเกิน 26 ชั่วโมง/.test(p.text)), found.map((p) => p.text).join('|'));
  const n = alerts().length;
  await checkAndAlert(env.db, env.cfg, notify, 26);
  assert.equal(alerts().length, n, 'once a day');
  assert.equal((await checkAndAlert(env.db, env.cfg, notify, 48)).filter((p) => /SMG: ไม่มีการซิงค์/.test(p.text)).length, 0, 'threshold from the setting');
});

test('GP per item: the exact MASTER and WHOLESALE cells, for the owner and users granted ตาราง GP', async () => {
  const s = sheets();
  s.master = s.master.map((r, i) => (i === 0 ? gpHead : r[0] === EAN.A ? withGp(r, { 12: '18%', 24: '33%' }) : withGp(r, {})));
  s.wholesale = [whHead, wh('FALSE', EAN.A, 'ซื้อ 12 ชิ้น', '480.00'), wh('TRUE', EAN.A, 'ราคาส่ง', '501.50')];
  assert.equal((await sync(s)).status, 200);
  await assert.rejects(sales.call('getGpItem', 'HOB-ALPHA'), /เมนูนี้ถูกปิด/);
  const it = await owner.call('getGpItem', EAN.A);
  assert.equal(it.key, 'HOB-ALPHA');
  assert.equal(it.masterRow, 3, 'HOB ALPHA is on MASTER row 3');
  assert.deepEqual(it.rates.find((x) => x.rate === 'T18'), { rate: 'T18', col: 'M', header: 'ส่วนลดT18', value: 0.18, cell: 'SMG MASTER OCT26-JAN27 › MASTER!M3' });
  assert.equal(it.rates.find((x) => x.rate === 'T15').value, null);
  assert.deepEqual([it.wholesale.net, it.wholesale.cell], [501.5, 'COST UPDATE 2021 for import › WHOLESALE!M3']);
  assert.ok(!('cost' in it) && !/"cost"/.test(JSON.stringify(it)));
  await owner.call('saveUser', { email: 'sales1@eve.co.th', role: 'SALES', grantedMenus: ['gptable', 'users'] });
  assert.deepEqual((await sales.call('getBootstrap')).user.openMenus, ['gptable'], 'only opt-in menus can be granted');
  const asSales = await sales.call('getGpItem', 'HOB-ALPHA');
  assert.equal(asSales.rates.find((x) => x.rate === 'DST1').value, 0.33);
  const noCost = (o) => !/"(cost|gain|mu|unitCost)"\s*:/.test(JSON.stringify(o)) && !/1,?000(\.0+)?\b/.test(JSON.stringify(o));
  assert.ok(noCost(asSales) && noCost(await sales.call('getGpTable')), 'a granted sales user gets no cost from the GP table or lookup');
  await assert.rejects(sales.call('getDataSources'), /เฉพาะเจ้าของระบบ/);
  await owner.call('saveUser', { email: 'sales1@eve.co.th', role: 'SALES', grantedMenus: [] });
  await assert.rejects(sales.call('getGpTable'), /เมนูนี้ถูกปิด/);
});
