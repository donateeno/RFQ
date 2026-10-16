'use strict';
/**
 * Every expected number below is copied from the live source sheets, so a pass means the web
 * app reproduces the sheet maths exactly.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculate, landedCost, indicatorFor, resolveDiscounts, roundUpTo, resolveTierPrice, PRICE_TIERS, applyTerms, gpTierTerms } = require('../src/pricing');
const { loadPriceGroups, loadGpTiers, validatePriceGroups } = require('../src/seed');

const groups = loadPriceGroups();
const G = Object.fromEntries(groups.map((g) => [g.id, g]));
const CH = Object.fromEntries(groups.flatMap((g) => g.channels.map((c) => [c.id, c])));
const calc = (groupId, channelId, o) => calculate(Object.assign({ formula: CH[channelId].formula, vatRate: 0.07, rules: G[groupId].indicatorRules }, o));

test('GT (RFQ MGR GT _CalEngine, GT.0001): 16,990 less 18% GP, cost 7,402.13 → 43.15% OKAY', () => {
  const r = calc('GT', 'GT_EVE', { normalPrice: 19990, specialPrice: 16990, discounts: [0.18, 0, 0], cost: 7402.13 });
  assert.equal(r.netIncVat, 13931.8);
  assert.equal(r.netExVat, 13020.37);
  assert.equal(r.gain, 5618.24);
  assert.equal(r.mu, 0.4315);
  assert.equal(r.indicator, 'OKAY');
});

test('BT EVE (RFQ PriceGroup BT _CalEngine, BT.0001): GP on normal price → 30.68% OKAY; BT.0002 → 22.08% LOW', () => {
  const r = calc('BT', 'BT_EVE', { normalPrice: 19990, specialPrice: 16990, discounts: [0.278304], cost: 7403.23 });
  assert.equal(r.netIncVat, 11426.7);
  assert.equal(r.netExVat, 10679.16);
  assert.equal(r.gain, 3275.93);
  assert.equal(r.mu, 0.3068);
  const r2 = calc('BT', 'BT_EVE', { normalPrice: 20990, specialPrice: 20990, discounts: [0.278304], cost: 11031.56 });
  assert.equal(r2.netExVat, 14157.38);
  assert.equal(r2.mu, 0.2208);
  assert.equal(r2.indicator, 'LOW');
});

test('BT FOSTER (_CalEngineFos&Pro, BTFOSTER.0001): special × (1 − 27.8304%) → 35.14%', () => {
  const r = calc('BT', 'BT_FOSTER', { normalPrice: 7590, specialPrice: 7500, discounts: [0.278304], cost: 3280.84 });
  assert.equal(r.netExVat, 5058.62);
  assert.equal(r.gain, 1777.78);
  assert.equal(r.mu, 0.3514);
});

test('OFFI (RFQ PriceGroup DGT.OFFI _CalEngine, OFFI.0001/0002): GP 27% → 36.13% OKAY, 22.97% LOW', () => {
  const r = calc('OFFI', 'OFFI_SHOWROOM', { normalPrice: 19990, specialPrice: 16990, discounts: [0.27], cost: 7403.23 });
  assert.equal(r.netIncVat, 12402.7);
  assert.equal(r.netExVat, 11591.31);
  assert.equal(r.gain, 4188.08);
  assert.equal(r.mu, 0.3613);
  const r2 = calc('OFFI', 'OFFI_SHOWROOM', { normalPrice: 20990, specialPrice: 20990, discounts: [0.27], cost: 11031.56 });
  assert.equal(r2.mu, 0.2297);
  assert.equal(r2.indicator, 'LOW');
});

test('Joseph Space TH (_Cal.TH): project cost vs special price; below 15% = ขาดทุน (owner rule, Oct 2026)', () => {
  const a = calc('JS', 'JS_TH', { specialPrice: 95000, discounts: [0], cost: 115630.88 });
  assert.equal(a.netExVat, 88785.05);
  assert.equal(a.gain, -26845.83);
  assert.equal(a.mu, -0.3024);
  assert.equal(a.indicator, 'ขาดทุน', 'the sheet said VERY LOW; owner set < 15% = ขาดทุน');
  const b = calc('JS', 'JS_TH', { specialPrice: 123975, discounts: [0], cost: 90567.25 });
  assert.equal(b.mu, 0.2183);
  assert.equal(b.indicator, 'LOW');
  const c = calc('JS', 'JS_TH', { specialPrice: 242389, discounts: [0], cost: 177265.35 });
  assert.equal(c.netExVat, 226531.78);
  assert.equal(c.mu, 0.2175);
});

test('Joseph Space OVS landed cost (_Manual.Cal JS00032 / JS00027) and suggested price', () => {
  const params = G.JS_OVS.params;
  const a = landedCost({ factoryRmb: 30648.44 / 0.5, exchRate: 5.2, bpDisc: 0.44 }, params);
  assert.equal(a.incoterm, 'FOB');
  assert.equal(Math.round(a.cost * 100) / 100, 296935.22);
  assert.equal(a.suggestedPrice, 742990);
  const r = calc('JS_OVS', 'JS_OVS', { normalPrice: a.suggestedPrice, specialPrice: 742990, discounts: [0.3], cost: a.cost });
  assert.equal(r.netIncVat, 520093);
  assert.equal(r.netExVat, 486068.22);
  assert.equal(r.gain, 189133.01);
  assert.equal(r.mu, 0.3891);
  assert.equal(r.indicator, 'OKAY');

  const b = landedCost({ factoryRmb: 29853.47 / 0.5, exchRate: 5.2, bpDisc: 0.44 }, params);
  assert.equal(Math.round(b.cost * 100) / 100, 289233.21);
  assert.equal(b.suggestedPrice, 723990);

  // Small orders are EXW (< 1500 USD in RMB) and pay 8% import tax.
  const exw = landedCost({ factoryRmb: 5000, exchRate: 5.2, bpDisc: 0 }, params);
  assert.equal(exw.incoterm, 'EXW');
  assert.ok(exw.cost > landedCost({ factoryRmb: 5000, exchRate: 5.2, bpDisc: 0, incoterm: 'FOB' }, params).cost);
});

test('indicator rules: "below" is strict, "upTo" inclusive', () => {
  const gt = G.GT.indicatorRules;
  assert.equal(indicatorFor(0.1799, gt), 'ขาดทุน');
  assert.equal(indicatorFor(0.18, gt), 'VERY LOW');
  assert.equal(indicatorFor(0.2, gt), 'VERY LOW');
  assert.equal(indicatorFor(0.2001, gt), 'LOW');
  assert.equal(indicatorFor(0.25, gt), 'LOW');
  assert.equal(indicatorFor(0.2501, gt), 'OKAY');
  const js = G.JS.indicatorRules;
  assert.equal(indicatorFor(0.1499, js), 'ขาดทุน');
  assert.equal(indicatorFor(0.15, js), 'VERY LOW');
  assert.equal(indicatorFor(0.1799, js), 'VERY LOW');
  assert.equal(indicatorFor(0.18, js), 'LOW');
  assert.equal(indicatorFor(0.23, js), 'OKAY');
  const ovs = G.JS_OVS.indicatorRules;
  assert.equal(indicatorFor(0.15, ovs), 'ขาดทุน');
  assert.equal(indicatorFor(0.18, ovs), 'VERY LOW');
  assert.equal(indicatorFor(0.23, ovs), 'LOW');
  assert.equal(indicatorFor(null, gt), 'NO COST');
});

test('channel discount rules: OFFI minimum GP, BT fixed GP', () => {
  assert.throws(() => resolveDiscounts(CH.OFFI_SHOPEE, [0.36]), /ห้ามต่ำกว่า 37%/);
  assert.deepEqual(resolveDiscounts(CH.OFFI_SHOPEE, [0.4]), [0.4]);
  assert.deepEqual(resolveDiscounts(CH.OFFI_SHOPEE, []), [0.37]);
  assert.throws(() => resolveDiscounts(CH.OFFI_TIKTOK, [0.15]), /ห้ามต่ำกว่า 20%/);
  assert.deepEqual(resolveDiscounts(CH.BT_EVE, [0]), [0.278304]);
  assert.throws(() => resolveDiscounts(CH.GT_EVE, [0.18, 8, 0]), /ห้ามเกิน/);
  assert.throws(() => resolveDiscounts(CH.GT_EVE, ['abc']), /ตัวเลข/);
});

test('SMG MASTER OCT26-JAN27 columns H / I / R: hot price, else Nationwide promotion, else old special price', () => {
  const tiers = (p) => PRICE_TIERS.map((t) => resolveTierPrice({ ...p, hot: p.hot && p.hot[t] }));
  // HOB HP35-1Q/FGB (NTW in HOTPRICE): GT 1,490 / DGT 1,990 / BT 1,590, Nationwide promotion 1,590 not used
  assert.deepEqual(tiers({ inHot: true, hot: { GT: 1490, DGT: 1990, BT: 1590 }, inNationwide: true, promotion: 1590, oldSpecial: 9990 }), [1490, 1990, 1590]);
  // HOB TORQUE 72 CM. (OR, not in HOTPRICE): Nationwide promotion 5,990 in every column, old special 1,190 ignored
  assert.deepEqual(tiers({ inHot: false, inNationwide: true, promotion: 5990, oldSpecial: 1190 }), [5990, 5990, 5990]);
  // HOB HB73-2VC/TC (NOTFOUND): old special price 9,990
  assert.deepEqual(tiers({ inHot: false, inNationwide: false, oldSpecial: 9990 }), [9990, 9990, 9990]);
  // HOB SPIRAL 2B ("ยกเลิก" row in HOTPRICE, prices blank): blank, even with an old special price of 1,190
  assert.deepEqual(tiers({ inHot: true, hot: { GT: null, DGT: null, BT: null }, inNationwide: false, oldSpecial: 1190 }), [null, null, null]);
  // OVEN 35 ลิตร รุ่น BT135 (NOTFOUND, 0): no price
  assert.deepEqual(tiers({ inHot: false, inNationwide: false, oldSpecial: 0 }), [null, null, null]);
});

test('customer price waterfall (Customer Price Mapping, Price Check): BT 20% + MKT 5% + DC 5.04% = 27.8304%', () => {
  // HOB HP35-1Q/FGB at BT HOTPRICE 1,590 (SMG MASTER OCT26-JAN27 R1459); BT terms from SMG MASTER columns T, U, V
  const r = applyTerms(1590, 1, [{ method: 'PCT_RUNNING', pct: 0.2 }, { method: 'PCT_RUNNING', pct: 0.05 }, { method: 'PCT_RUNNING', pct: 0.0504 }]);
  assert.deepEqual(r.steps.map((s) => [s.deduction, s.after]), [[318, 1272], [63.6, 1208.4], [60.9, 1147.5]]);
  assert.equal(r.net, 1147.5);
  assert.equal(r.totalDiscount, 0.278304, 'same as the fixed GP + MKT FEE (BT) in price-groups.json');
  // the other methods: % of gross, baht per unit, baht per order spread over the quantity
  const m = applyTerms(1000, 4, [{ method: 'PCT_GROSS', pct: 0.1 }, { method: 'PCT_RUNNING', pct: 0.1 }, { method: 'THB_UNIT', thb: 50 }, { method: 'THB_ORDER', thb: 200 }]);
  assert.deepEqual(m.steps.map((s) => s.after), [900, 810, 760, 710]);
  assert.equal(m.totalDiscount, 0.29);
  assert.equal(applyTerms(1000, 1, []).net, 1000);
});

test('GP tiers (SMG MASTER K–O, T–V, Y; partner list): HOOD HI-HEE89-90 at GT 29,990 / DGT 34,590', () => {
  const tiers = loadGpTiers();
  const net = (code, gross, rates, extra) => applyTerms(gross, 1, gpTierTerms(tiers.get(code), rates).concat(extra || [])).net;
  const rates = { SCGH: 0.2, T15: 0.15, T18: 0.18, T20: 0.2, T24: 0.24, DST1: 0.33 };
  assert.equal(net('T15', 29990, rates), 25491.5);
  assert.equal(net('T18', 29990, rates), 24591.8);
  assert.equal(net('T20', 29990, rates), 23992);
  assert.equal(net('T20_LA', 29990, rates), 23992, 'Laos dealers use column N (T20)');
  assert.equal(net('T24', 29990, rates, [{ method: 'PCT_RUNNING', pct: 0.03 }]), 22108.63, 'Souvanny: 24% then Exw 3%');
  assert.equal(net('DST1', 34590, rates), 23175.3, 'dropship: DGT less column Y');
  // F = 99 (MISC25) items carry 25% in every column: the item's own rate wins over the tier default
  assert.equal(net('T15', 1000, { T15: 0.25 }), 750);
  // BT compounds GP × MKT fee × DC fee: 9,990 → 7,660.35 inc. VAT = 7,159.21 ex. VAT (partner sheet)
  const bt = applyTerms(9990, 1, gpTierTerms(tiers.get('BT'), { BT_GP: 0.15, BT_MKT: 0.05, BT_DC: 0.0504 }));
  assert.deepEqual(bt.steps.map((s) => s.after), [8491.5, 8066.93, 7660.35]);
  assert.equal(Math.round(bt.net / 1.07 * 100) / 100, 7159.21);
  // no rate for the item: the tier default (27.83% for BT, as today), flagged
  const d = gpTierTerms(tiers.get('BT'), null);
  assert.ok(d.every((t) => t.defaulted));
  assert.equal(applyTerms(1590, 1, d).net, 1147.5);
  assert.deepEqual(gpTierTerms(tiers.get('T18'), { T18: 0 }).map((t) => [t.pct, t.defaulted]), [[0, false]], '0% is a rate, not a gap');
  assert.equal(tiers.get('NONPC').fallback, 'T20');
});

test('ROUNDUP to thousands matches Excel', () => {
  assert.equal(roundUpTo(742338.05, 3), 743000);
  assert.equal(roundUpTo(743000, 3), 743000);
});

test('price-groups.json validation catches mistakes', () => {
  const bad = { groups: [{ id: 'X', costSource: 'PRODUCT', indicatorRules: [{ indicator: 'LOW', upTo: 0.3 }, { indicator: 'VERY LOW', upTo: 0.2 }],
    channels: [{ id: 'X1', formula: 'NOPE', idPrefix: 'X.', discounts: [{ label: 'GP', default: 0.1, min: 0.2 }] }] }] };
  assert.throws(() => validatePriceGroups(bad), (e) => /ascending/.test(e.message) && /formula/.test(e.message) && /brand/.test(e.message) && /default outside/.test(e.message));
  const badTiers = { groups: [], gpTiers: [{ code: 'A', steps: [{ rate: 'T99', label: 'x', default: 0.1 }] }, { code: 'B', steps: [{ rate: 'T15', label: 'x', default: 1.5 }] },
    { code: 'N', netPrice: 'WHOLESALE', fallback: 'N2' }, { code: 'N2', netPrice: 'WHOLESALE' }, { code: 'A', steps: [] }] };
  assert.throws(() => validatePriceGroups(badTiers), (e) => /rate must be/.test(e.message) && /bad step/.test(e.message) && /fallback must be/.test(e.message) && /duplicate/.test(e.message));
});
