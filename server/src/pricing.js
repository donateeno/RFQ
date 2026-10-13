'use strict';
/**
 * Pricing engine — pure functions, no database. Mirrors the _CalEngine / _Manual.Cal sheet maths.
 *
 *   Net incl. VAT   MULTIPLY      special × Π(1 − dᵢ)
 *                   GP_ON_NORMAL  normal × Π(1 − dᵢ) − (normal − special)
 *   Net ex VAT    = Net incl. VAT ÷ (1 + VAT)
 *   Gain          = Net ex VAT − Cost
 *   %MU           = Gain ÷ Net ex VAT
 *   Indicator     = first matching group rule, else OKAY
 */

const INDICATOR = Object.freeze({ OKAY: 'OKAY', NO_COST: 'NO COST' });
const FORMULAS = ['MULTIPLY', 'GP_ON_NORMAL'];
const COST_SOURCES = ['PRODUCT', 'PROJECT', 'LANDED'];

function round(n, dp) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function keepFactor(discounts) {
  return (discounts || []).reduce((acc, d) => acc * (1 - (Number(d) || 0)), 1);
}

function netIncVat(formula, normal, special, discounts) {
  const keep = keepFactor(discounts);
  if (formula === 'GP_ON_NORMAL' && normal > 0) return normal * keep - (normal - special);
  return special * keep;
}

/** rules: [{indicator, below}|{indicator, upTo}] in ascending order. */
function indicatorFor(mu, rules) {
  if (mu === null || mu === undefined || !Number.isFinite(mu)) return INDICATOR.NO_COST;
  for (const r of rules || []) {
    if (r.below !== undefined && mu < r.below) return r.indicator;
    if (r.upTo !== undefined && mu <= r.upTo) return r.indicator;
  }
  return INDICATOR.OKAY;
}

/**
 * The MU range an exact %MU falls in, from the group's own thresholds — e.g. "20–25%", "> 25%".
 * Shown to supervisors instead of the exact figure, which would let them back out the cost.
 */
function muBand(mu, rules) {
  if (mu === null || mu === undefined || !Number.isFinite(mu)) return '';
  const pct = (v) => `${round(v * 100, 2)}%`;
  let lower = null;
  for (const r of rules || []) {
    const v = r.below !== undefined ? r.below : r.upTo;
    const hit = r.below !== undefined ? mu < v : mu <= v;
    if (hit) return lower === null ? (r.below !== undefined ? `< ${pct(v)}` : `≤ ${pct(v)}`) : `${pct(lower)}–${pct(v)}`;
    lower = v;
  }
  if (lower === null) return '';
  const last = rules[rules.length - 1];
  return last.below !== undefined ? `≥ ${pct(lower)}` : `> ${pct(lower)}`;
}

/**
 * @param {{formula, normalPrice, specialPrice, discounts:number[], cost, vatRate, rules}} p
 */
function calculate(p) {
  const special = Number(p.specialPrice);
  const normal = p.normalPrice === null || p.normalPrice === undefined ? null : Number(p.normalPrice);
  const inc = netIncVat(p.formula, normal, special, p.discounts);
  const ex = inc / (1 + p.vatRate);
  const cost = p.cost === null || p.cost === undefined || p.cost === '' ? null : Number(p.cost);
  const out = { netIncVat: round(inc, 2), netExVat: round(ex, 2), cost: cost === null ? null : round(cost, 2), gain: null, mu: null, indicator: INDICATOR.NO_COST };
  if (!(cost > 0)) return out;
  out.gain = round(ex - cost, 2);
  out.mu = ex > 0 ? round((ex - cost) / ex, 4) : -1;
  out.indicator = indicatorFor(out.mu, p.rules);
  return out;
}

/** Excel ROUNDUP(x, -digits): away from zero to a multiple of 10^digits. */
function roundUpTo(x, digits) {
  const f = 10 ** digits;
  return Math.sign(x) * Math.ceil(Math.abs(x) / f - 1e-9) * f;
}

/**
 * Joseph Space OVS landed cost (sheet _Manual.Cal / _Qry.CASA, columns F → AB).
 * @param {{factoryRmb:number, exchRate:number, bpDisc:number, incoterm?:string, miscCharge?:number}} item
 * @param {object} params group params (see price-groups.json)
 */
function landedCost(item, params) {
  const rmb = Number(item.factoryRmb) || 0;
  const incoterm = (item.incoterm || (rmb < params.exwBelowUsd * params.usdCny ? 'EXW' : 'FOB')).toUpperCase();
  const thb = rmb * Number(item.exchRate);                                   // I
  const net = thb * (1 - (Number(item.bpDisc) || 0));                         // K
  const freight = net * params.freightRate;                                   // N
  const importTax = (net + freight) * (incoterm === 'EXW' ? params.importTaxExw : 0); // P
  const markup = net * (1 + params.freightRate) * params.markupRate;         // R
  const landed = net + freight + markup + importTax + (Number(item.miscCharge) || 0); // T
  const withMkt = landed * (1 + params.mktFeeRate);                           // V
  const lastMile = Math.max(withMkt * params.lastMileRate, params.lastMileMin); // X
  const install = Math.max(withMkt * params.installRate, params.installMin);    // Y
  const error = withMkt * params.errorRate;                                     // Z
  const cost = withMkt + lastMile + install + error;                            // AB
  return {
    incoterm,
    cost: round(cost, 6), // full precision like the sheet; calculate() rounds for display
    suggestedPrice: roundUpTo(cost * params.suggestMultiplier, 3) - 10        // AD
  };
}

/**
 * Validates browser-supplied discounts against a channel's discount config.
 * @return {number[]} discounts to use (non-editable ones forced to default)
 */
function resolveDiscounts(channel, given) {
  return channel.discounts.map((d, i) => {
    if (!d.editable) return d.default || 0;
    const raw = given && given[i];
    const n = raw === '' || raw === null || raw === undefined ? (d.default || 0) : Number(raw);
    const min = d.min ?? 0;
    const max = d.max ?? 0.99;
    if (!Number.isFinite(n)) throw new UserError(`${d.label} ต้องเป็นตัวเลข`);
    if (n < min - 1e-9) throw new UserError(`${d.label} ห้ามต่ำกว่า ${pctText(min)}`);
    if (n > max + 1e-9) throw new UserError(`${d.label} ห้ามเกิน ${pctText(max)}`);
    return n;
  });
}

function pctText(f) {
  return `${round(f * 100, 2)}%`;
}

class UserError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 400;
  }
}

const PRICE_TIERS = ['GT', 'DGT', 'BT'];

/**
 * Selling price of one product for one channel tier, as SMG MASTER columns H (GT), I (DGT) and R (BT) set it:
 *   found in HOTPRICE (first row for the barcode) → that row's tier price, even when blank (e.g. "ยกเลิก")
 *   else found in the Nationwide pricelist      → its PROMOTION price
 *   else                                          → MASTER "ราคาขายพิเศษเดิม" (old special price)
 * Blank or 0 means "no price".
 * @param {{hot?: number|null, inHot: boolean, promotion?: number|null, inNationwide: boolean, oldSpecial?: number|null}} p
 */
function resolveTierPrice(p) {
  const v = p.inHot ? p.hot : (p.inNationwide ? p.promotion : p.oldSpecial);
  return Number(v) > 0 ? Number(v) : null;
}

const TERM_METHODS = ['PCT_RUNNING', 'PCT_GROSS', 'THB_UNIT', 'THB_ORDER'];

/**
 * Customer price waterfall (Customer Price Mapping template, tab Price Check): starting from the gross
 * price, each term in order takes
 *   PCT_RUNNING  pct of the price left after the previous step
 *   PCT_GROSS    pct of the gross price
 *   THB_UNIT     thb per unit
 *   THB_ORDER    thb per order, spread over qty
 * @param {number} gross
 * @param {number} qty
 * @param {{method:string, pct?:number|null, thb?:number|null}[]} terms  already in order
 */
function applyTerms(gross, qty, terms) {
  let price = Number(gross);
  const steps = (terms || []).map((t) => {
    const pct = Number(t.pct) || 0;
    const thb = Number(t.thb) || 0;
    let d = 0;
    if (t.method === 'PCT_RUNNING') d = price * pct;
    else if (t.method === 'PCT_GROSS') d = gross * pct;
    else if (t.method === 'THB_UNIT') d = thb;
    else if (t.method === 'THB_ORDER') d = qty > 0 ? thb / qty : 0;
    price -= d;
    return Object.assign({}, t, { deduction: round(d, 2), after: round(price, 2) });
  });
  return { steps, net: round(price, 2), totalDiscount: gross > 0 ? round(1 - price / gross, 6) : 0 };
}

module.exports = { INDICATOR, FORMULAS, COST_SOURCES, PRICE_TIERS, TERM_METHODS, resolveTierPrice, applyTerms, round, netIncVat, indicatorFor, muBand, calculate, landedCost, roundUpTo, resolveDiscounts, UserError };
