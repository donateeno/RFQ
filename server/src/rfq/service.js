'use strict';
/**
 * RFQ business logic. Every exported function takes ctx = {db, cfg, user, notify} first and is
 * reachable from the browser through the whitelisted RPC route, so each one checks the role itself.
 *
 * Visibility:  SALES       indicator only
 *              SUPERVISOR  + net prices and the MU band (e.g. "20–25%"), never cost/gain/exact %MU
 *              cost viewer + cost, gain, exact %MU   (users.can_view_cost, set from COST_VIEWERS env only)
 */
const { calculate, resolveDiscounts, round, muBand, INDICATOR, PRICE_TIERS, applyTerms, gpTierTerms, UserError } = require('../pricing');
const { tx } = require('../db');
const { getSettings, getCatalog, getChannel, lookupItem, landedFromRow, priceContext, productIn } = require('./catalog');
const { importData, parseCsv } = require('./importers');
const notifyMsg = require('./notifications');
const { loadGpTiers } = require('../seed');

const STATUS = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled', CLOSED: 'Closed' };
const DISPLAY_STATUSES = ['Pending', 'Approved', 'Expired', 'Rejected', 'Cancelled', 'Closed'];
const ROLES = ['SALES', 'SUPERVISOR', 'ADMIN'];
/** Nationwide pricelist status (sheet 'Library') shown as a warning on checks and requests. */
const STATUS_FLAGS = {
  OR: 'สินค้ายกเลิก (OR) — ขายตามสต็อกคงเหลือ',
  EX: 'สินค้า Exclusive (EX) — เฉพาะลูกค้าที่ได้รับอนุญาต',
  G: 'ของแถม / ของพรีเมียม (G)',
  MTO: 'สินค้าสั่งผลิต (MTO) — ยืนยันราคาและระยะเวลากับฝ่ายผลิตภัณฑ์/จัดซื้อ'
};

// ---------------------------------------------------------------- helpers

function requireRole(user, roles) {
  if (!roles.includes(user.role)) throw new UserError('คุณไม่มีสิทธิ์ใช้งานส่วนนี้', 403);
  return user;
}
const approver = (ctx) => requireRole(ctx.user, ['SUPERVISOR', 'ADMIN']);
const admin = (ctx) => requireRole(ctx.user, ['ADMIN']);

function todayIso(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
function str(v, max) {
  return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 500);
}
function pad(n, w) {
  return String(n).padStart(w, '0');
}

async function prepareLine(db, group, channel, line, settings, date) {
  const item = await lookupItem(db, group, channel, line.productKey, date);
  const special = num(line.specialPrice);
  if (!(special > 0)) throw new UserError('กรุณาใส่ราคาพิเศษ (มากกว่า 0) สำหรับ ' + (str(line.productKey) || 'สินค้า'));
  if (special > 100000000) throw new UserError('ราคาพิเศษสูงผิดปกติ');
  const discounts = resolveDiscounts(channel, line.discounts);
  const normal = item ? item.normalPrice : null;
  const calc = calculate({
    formula: channel.formula, normalPrice: normal, specialPrice: special, discounts,
    cost: item ? item.cost : null, vatRate: settings.VAT_RATE, rules: group.indicatorRules
  });
  const flags = [];
  if (!item) flags.push('ไม่พบในฐานข้อมูลต้นทุน');
  else if (item.missing && item.missing.length) flags.push('สินค้าในเซ็ตไม่อยู่ในรอบราคาปัจจุบัน: ' + item.missing.join(', '));
  else if (!(item.cost > 0)) flags.push('ไม่มีต้นทุน');
  if (normal > 0 && special > normal) flags.push('ราคาพิเศษสูงกว่าราคาปกติ');
  if (item && item.tiered) {
    if (normal === null) flags.push(`ไม่มีราคาขายช่องทาง ${channel.priceTier || ''} ในรอบราคานี้${item.saleChannel ? ' (' + item.saleChannel + ')' : ''}`);
    if (STATUS_FLAGS[item.status]) flags.push(STATUS_FLAGS[item.status]);
  }
  return {
    found: !!item, item,
    productKey: item ? item.key : str(line.productKey, 200),
    productName: item ? item.name : str(line.productKey, 200),
    normalPrice: normal, specialPrice: special, discounts, calc, flags
  };
}

function displayStatus(r, today) {
  if (r.status === STATUS.APPROVED && r.end_date && r.end_date < today) return 'Expired';
  return r.status;
}

const canSeeCost = (user) => user.canSeeCost === true;

/**
 * Returns a row → browser view function for this user. Loads group rules (for MU bands) and the
 * current price lists (to mark approvals made on an older list) once per call.
 */
async function makeView(ctx) {
  const { user } = ctx;
  const today = todayIso(ctx.cfg.timezone);
  const catalog = await getCatalog(ctx.db, true);
  const rules = Object.fromEntries(catalog.map((g) => [g.id, g.indicatorRules]));
  const pc = await priceContext(ctx.db, today);
  const listNames = Object.fromEntries((await ctx.db.query('select id, name from price_lists')).rows.map((l) => [l.id, l.name]));
  return function view(r) {
    const current = r.brand && pc[r.brand] && pc[r.brand].current;
    const v = {
      id: r.id, batch: r.batch_id || '', groupId: r.group_id, channel: r.channel_id, costSource: r.cost_source,
      customer: r.customer, project: r.project, note: r.note,
      productKey: r.product_key, productName: r.product_name, qty: r.qty, isBundle: !!r.bundle_id,
      normalPrice: r.normal_price, specialPrice: r.special_price,
      discounts: r.discounts || [], discountLabels: r.discount_labels || [],
      indicator: r.indicator, status: r.status, displayStatus: displayStatus(r, today),
      startDate: r.start_date || '', endDate: r.end_date || '',
      priceList: r.price_list_id ? listNames[r.price_list_id] || '' : '',
      oldPriceList: !!(r.price_list_id && current && current.id !== r.price_list_id),
      requester: r.requester, requestedAt: r.requested_at ? r.requested_at.toISOString() : '',
      decidedBy: r.decided_by || '', decidedAt: r.decided_at ? r.decided_at.toISOString() : '',
      comment: r.decision_comment || '', flags: (r.flags || []).join('; '), source: r.source
    };
    if (user.role !== 'SALES') Object.assign(v, { netIncVat: r.net_inc_vat, netExVat: r.net_ex_vat, muBand: muBand(r.mu, rules[r.group_id]) });
    if (canSeeCost(user)) Object.assign(v, { cost: r.cost, gain: r.gain, mu: r.mu });
    return v;
  };
}

/**
 * A pending request priced on an older price list, re-priced with today's list.
 * @return {object|null} new snapshot columns + priceList name, or null when nothing changed
 */
async function reprice(db, row, groupsById, settings, today) {
  if (row.cost_source !== 'PRODUCT' || !row.price_list_id) return null;
  const group = groupsById[row.group_id];
  const channel = group && group.channels.find((c) => c.id === row.channel_id);
  if (!channel) return null;
  const item = await lookupItem(db, group, channel, row.product_key, today);
  if (!item || !item.priceList || item.priceList.id === row.price_list_id) return null;
  const calc = calculate({ formula: channel.formula, normalPrice: item.normalPrice, specialPrice: row.special_price, discounts: row.discounts,
    cost: item.cost, vatRate: settings.VAT_RATE, rules: group.indicatorRules });
  return { priceListId: item.priceList.id, priceList: item.priceList.name, normalPrice: item.normalPrice, calc, rules: group.indicatorRules };
}

async function groupsWithInactive(db) {
  return Object.fromEntries((await getCatalog(db, true)).map((g) => [g.id, g]));
}

/** Builds WHERE fragments for the shared list filters. */
function buildFilter(filter, today, params) {
  const where = [];
  const p = (v) => { params.push(v); return '$' + params.length; };
  const st = filter.status;
  if (st === 'Expired') where.push(`status = 'Approved' and end_date < ${p(today)}`);
  else if (st === 'Approved') where.push(`status = 'Approved' and (end_date is null or end_date >= ${p(today)})`);
  else if (st && DISPLAY_STATUSES.includes(st)) where.push(`status = ${p(st)}`);
  if (filter.group) where.push(`group_id = ${p(String(filter.group))}`);
  if (filter.channel) where.push(`channel_id = ${p(String(filter.channel))}`);
  if (filter.indicator) where.push(`indicator = ${p(String(filter.indicator))}`);
  if (isIsoDate(filter.from)) where.push(`(requested_at at time zone 'Asia/Bangkok')::date >= ${p(filter.from)}`);
  if (isIsoDate(filter.to)) where.push(`(requested_at at time zone 'Asia/Bangkok')::date <= ${p(filter.to)}`);
  String(filter.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6).forEach((w) => {
    where.push(`concat_ws(' ', id, customer, project, note, product_key, product_name, requester) ilike ${p('%' + w.replace(/[\\%_]/g, '\\$&') + '%')}`);
  });
  return where;
}

async function log(db, email, action, ids, detail) {
  await db.query('insert into audit_log (user_email, action, req_ids, detail) values ($1, $2, $3, $4)', [email, action, ids || [], JSON.stringify(detail || {})]);
}

// ---------------------------------------------------------------- bootstrap

async function getBootstrap(ctx) {
  const { db, user, cfg } = ctx;
  const today = todayIso(cfg.timezone);
  const settings = await getSettings(db);
  const catalog = await getCatalog(db);
  const pc = await priceContext(db, today);

  // Products of each brand's current price list, with "new" and "upcoming price" markers. Never cost.
  const products = [];
  const priceByKey = {};
  const priceLists = {};
  for (const brand of Object.keys(pc)) {
    const { current, previous, upcoming } = pc[brand];
    priceLists[brand] = { current, upcoming };
    if (!current) continue;
    const prevKeys = previous ? new Set((await db.query('select key_norm from products where price_list_id = $1 and brand = $2', [previous.id, brand])).rows.map((r) => r.key_norm)) : null;
    const cols = 'key, key_norm, name, normal_price, barcode, make, status, sale_channel, price_cat, list_price, price_gt, price_dgt, price_bt, tiered';
    const up = upcoming ? new Map((await db.query(`select ${cols} from products where price_list_id = $1 and brand = $2`, [upcoming.id, brand])).rows.map((r) => [r.key_norm, r])) : null;
    const rows = (await db.query(`select ${cols} from products where price_list_id = $1 and brand = $2 order by key`, [current.id, brand])).rows;
    rows.forEach((r) => {
      const e = productView(brand, r);
      if (prevKeys && !prevKeys.has(r.key_norm)) e.nw = 1;
      if (up) {
        const u = up.get(r.key_norm);
        if (!u) e.ux = 1;
        else {
          if (u.normal_price !== r.normal_price) e.up = u.normal_price;
          if (r.tiered && u.tiered) {
            const ut = {};
            PRICE_TIERS.forEach((t) => { const k = 'price_' + t.toLowerCase(); if (u[k] !== r[k] && u[k] !== null) ut[t] = u[k]; });
            if (Object.keys(ut).length) e.ut = ut;
          }
        }
      }
      priceByKey[brand + '|' + r.key_norm] = { p: r.normal_price, t: e.t || null };
      products.push(e);
    });
  }
  const bundles = (await db.query(
    `select b.id, b.brand, b.name, b.label, b.created_by, json_agg(json_build_object('k', i.product_key, 'q', i.qty) order by i.position) as items
     from bundles b join bundle_items i on i.bundle_id = b.id where b.active group by b.id order by b.name`)).rows
    .map((b) => bundleView(b, priceByKey));

  const projects = (await db.query('select group_id as g, project_key as k, customer, description, normal_price as p from project_costs order by project_key')).rows
    .map((r) => ({ g: r.g, k: r.k, n: [r.customer, r.description].filter(Boolean).join(' · '), p: r.p }));
  const landed = (await db.query('select * from landed_items order by item_code')).rows.map((r) => {
    const g = catalog.find((x) => x.id === r.group_id);
    const lc = g ? landedFromRow(r, g.params) : null;
    return { g: r.group_id, k: r.item_code, n: r.description, p: lc ? lc.suggestedPrice : null };
  });
  const customers = (await db.query(`select distinct customer from requests where customer <> '' order by customer limit 3000`)).rows.map((r) => r.customer);
  const out = {
    user: { email: user.email, name: user.name, role: user.role, canApprove: user.role !== 'SALES', isAdmin: user.role === 'ADMIN', canSeeCost: canSeeCost(user) },
    groups: catalog.map((g) => ({ id: g.id, name: g.name, description: g.description, costSource: g.costSource, channels: g.channels })),
    settings: { defaultValidityDays: settings.DEFAULT_VALIDITY_DAYS, maxValidityDays: settings.MAX_VALIDITY_DAYS },
    products, bundles, projects, landed, customers, priceLists, today,
    customerGroups: (await db.query('select code, name, price_tier, gp_tier from customer_groups order by code')).rows
      .map((g) => ({ code: g.code, name: g.name, tier: g.price_tier, gpTier: g.gp_tier || '' }))
  };
  if (out.user.canApprove) {
    out.pendingCount = Number((await db.query(`select count(*) from requests where status = 'Pending'`)).rows[0].count);
  }
  return out;
}

/** Product for the browser (never cost): t = price per channel tier for SMG-synced products. */
function productView(brand, r) {
  const e = { b: brand, k: r.key, n: r.name, p: r.normal_price };
  if (r.tiered) {
    e.t = {};
    PRICE_TIERS.forEach((t) => { e.t[t] = r['price_' + t.toLowerCase()]; });
    if (r.barcode) e.bc = r.barcode;
    if (r.make && r.make !== brand) e.mk = r.make;
    if (r.status) e.st = r.status;
    if (r.sale_channel) e.sc = r.sale_channel;
    if (r.price_cat) e.pc = r.price_cat;
    if (r.list_price) e.lp = r.list_price;
  }
  return e;
}

/** Bundle for the browser: components and summed normal price from the current list (never cost). */
function bundleView(b, priceByKey) {
  let p = 0;
  let t = null;
  const comps = b.items.map((it) => ({ q: it.q, price: priceByKey[b.brand + '|' + String(it.k).trim().toUpperCase()] }));
  if (comps.some((c) => !c.price)) p = null;
  else {
    for (const c of comps) p = p === null || c.price.p === null ? null : p + c.price.p * c.q;
    if (comps.some((c) => c.price.t)) {
      t = {};
      PRICE_TIERS.forEach((tier) => {
        let sum = 0;
        for (const c of comps) {
          const v = c.price.t ? c.price.t[tier] : c.price.p;
          sum = sum === null || v === null || v === undefined ? null : sum + v * c.q;
        }
        t[tier] = sum;
      });
    }
  }
  const out = { id: b.id, b: b.brand, k: b.name, n: b.label || 'ชุดเซ็ต', p, items: b.items, by: b.created_by };
  if (t) out.t = t;
  return out;
}

/** {brand|key_norm → {p, t}} for bundleView, from one price list. */
async function priceMap(db, listId, brand) {
  const rows = (await db.query('select key_norm, normal_price, price_gt, price_dgt, price_bt, tiered from products where price_list_id = $1 and brand = $2', [listId, brand])).rows;
  return Object.fromEntries(rows.map((r) => [brand + '|' + r.key_norm, { p: r.normal_price, t: r.tiered ? { GT: r.price_gt, DGT: r.price_dgt, BT: r.price_bt } : null }]));
}

// ---------------------------------------------------------------- price check & submit

async function priceCheck(ctx, payload) {
  const { db, user } = ctx;
  const settings = await getSettings(db);
  const { group, channel } = await getChannel(db, payload && payload.channelId);
  const p = await prepareLine(db, group, channel, payload || {}, settings, todayIso(ctx.cfg.timezone));
  await guardPriceCheck(ctx, settings, channel, (payload || {}).productKey, p);
  const it = p.item || {};
  const out = {
    found: p.found, productKey: p.productKey, productName: p.productName, normalPrice: p.normalPrice,
    discounts: p.discounts, indicator: p.calc.indicator, flags: p.flags,
    priceList: it.priceList || null, upcoming: it.upcoming || null, isNew: !!it.isNew, isBundle: !!it.bundleId
  };
  if (user.role !== 'SALES') Object.assign(out, { netIncVat: p.calc.netIncVat, netExVat: p.calc.netExVat, muBand: muBand(p.calc.mu, group.indicatorRules) });
  if (canSeeCost(user)) Object.assign(out, { cost: p.calc.cost, gain: p.calc.gain, mu: p.calc.mu });
  return out;
}

/**
 * The indicator and MU band change at fixed %MU thresholds, so checking one item at many net prices
 * (special price, discounts or channel) narrows down its cost. For everyone who cannot see cost: log
 * each check, refuse more than PRICE_CHECK_LIMIT different net prices for one item in 24 h (or
 * PRICE_CHECK_PER_HOUR checks in total), and alert the admins when someone reaches PRICE_CHECK_ALERT.
 * Re-checking a net price already tried is free.
 */
async function guardPriceCheck(ctx, settings, channel, rawKey, p) {
  const { db, user } = ctx;
  if (canSeeCost(user)) return;
  const key = str(rawKey, 200);
  const net = p.calc.netIncVat === null || p.calc.netIncVat === undefined ? p.specialPrice : p.calc.netIncVat;
  const hourly = (await db.query(`select count(*)::int as n from price_checks where user_email = $1 and at > now() - interval '1 hour'`, [user.email])).rows[0].n;
  if (hourly >= settings.PRICE_CHECK_PER_HOUR) throw new UserError('ตรวจราคาบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่', 429);
  const seen = (await db.query(
    `select count(distinct net_price)::int as n, coalesce(bool_or(net_price = $3), false) as tried from price_checks
     where user_email = $1 and key_norm = upper(btrim($2)) and at > now() - interval '24 hours'`,
    [user.email, key, net])).rows[0];
  if (!seen.tried && seen.n >= settings.PRICE_CHECK_LIMIT) {
    throw new UserError(`ตรวจราคาสินค้านี้ครบ ${settings.PRICE_CHECK_LIMIT} ราคาใน 24 ชม. แล้ว — กรุณาส่งคำขออนุมัติ หรือติดต่อหัวหน้า`, 429);
  }
  await db.query('insert into price_checks (user_email, channel_id, key_norm, special_price, net_price, indicator) values ($1, $2, upper(btrim($3)), $4, $5, $6)',
    [user.email, channel.id, key, p.specialPrice, net, p.calc.indicator]);
  if (!seen.tried && seen.n < settings.PRICE_CHECK_ALERT && seen.n + 1 >= settings.PRICE_CHECK_ALERT) {
    const detail = { channel: channel.id, key, prices: seen.n + 1 };
    await log(db, user.email, 'PRICE_CHECK_ALERT', [], detail);
    const to = (await db.query(`select email from users where active and (role = 'ADMIN' or can_view_cost) order by email`)).rows.map((r) => r.email);
    ctx.notify(notifyMsg.priceCheckAlert(ctx.cfg, user, channel, key, detail.prices, to));
  }
}

// ---------------------------------------------------------------- customer price lookup (ราคาตามลูกค้า)

/** Customers by code or name for the picker (anyone signed in). */
async function searchCustomers(ctx, q) {
  const words = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4);
  if (!words.length) return [];
  const params = [];
  const where = words.map((w) => { params.push('%' + w.replace(/[\\%_]/g, '\\$&') + '%'); return `lower(c.code || ' ' || c.name) like $${params.length}`; });
  return (await ctx.db.query(
    `select c.code, c.name, c.sap_channel, coalesce(nullif(c.override_group, ''), m.group_code, '') as group_code
     from customers c left join sap_channel_groups m on m.sap_channel = c.sap_channel
     where ${where.join(' and ')} order by c.code limit 20`, params)).rows
    .map((r) => ({ code: r.code, name: r.name, channel: r.sap_channel, group: r.group_code }));
}

/** Price tier → where the gross price comes from in the current price list. */
const TIER_SOURCE = { GT: ['EVE', 'GT'], DGT: ['EVE', 'DGT'], BT: ['EVE', 'BT'], NTW: ['EVE', null], FOSTER: ['FOSTER', null] };
let gpTierCache = null;
const gpTierDefs = () => gpTierCache || (gpTierCache = loadGpTiers());

/**
 * "What does customer X pay for product Y?": customer → group (own override, else its SAP channel's
 * default group) → price tier → gross price from the current price list → the group's and the customer's
 * terms in order (pricing.applyTerms). Returns no cost.
 * @param {{customerCode?:string, groupCode?:string, productKey:string, qty?:number, grossPrice?:number, date?:string}} payload
 *   grossPrice is used only when the product has no price for the tier (shown as typed by the user).
 */
async function customerPriceCheck(ctx, payload) {
  const { db, cfg } = ctx;
  payload = payload || {};
  const date = isIsoDate(payload.date) ? payload.date : todayIso(cfg.timezone);
  const qty = payload.qty === undefined || payload.qty === '' ? 1 : num(payload.qty);
  if (!(qty >= 1) || !Number.isInteger(qty) || qty > 1000000) throw new UserError('จำนวนต้องเป็นเลขจำนวนเต็ม ≥ 1');

  let customer = null;
  let groupCode = str(payload.groupCode, 60).toUpperCase();
  const code = str(payload.customerCode, 60);
  if (code) {
    const r = (await db.query(
      `select c.*, m.group_code as channel_group from customers c left join sap_channel_groups m on m.sap_channel = c.sap_channel
       where c.code = $1`, [code])).rows[0];
    if (!r) throw new UserError('ไม่พบรหัสลูกค้า ' + code, 404);
    customer = { code: r.code, name: r.name, channel: r.sap_channel, salesEmployee: r.sales_employee, lastMonth: r.last_month,
      groupFrom: r.override_group ? 'ลูกค้า (Customer Map)' : 'ช่องทาง SAP (Channel Map)' };
    groupCode = (r.override_group || r.channel_group || '').toUpperCase();
    if (!groupCode) throw new UserError(`ลูกค้า ${r.code} ยังไม่ได้กำหนดกลุ่ม (ช่องทาง SAP: ${r.sap_channel || '-'})`);
  }
  if (!groupCode) throw new UserError('กรุณาเลือกลูกค้าหรือกลุ่มลูกค้า');
  const g = (await db.query('select * from customer_groups where code = $1', [groupCode])).rows[0];
  if (!g) throw new UserError('ไม่พบกลุ่มลูกค้า ' + groupCode, 404);
  const group = { code: g.code, name: g.name, tier: g.price_tier, gpTier: g.gp_tier || '', creditDays: g.credit_days };

  const key = str(payload.productKey, 200);
  if (!key) throw new UserError('กรุณาระบุสินค้า');
  let product = null;
  let row = null;
  let gross = null;
  const src = TIER_SOURCE[g.price_tier];
  if (src) {
    const pc = (await priceContext(db, date))[src[0]] || {};
    row = pc.current ? await productIn(db, pc.current.id, src[0], key) : null;
    if (row) {
      gross = row.tiered && src[1] ? row['price_' + src[1].toLowerCase()] : row.normal_price;
      product = { key: row.key, name: row.name, barcode: row.barcode || '', status: row.status || '', saleChannel: row.sale_channel || '', listPrice: row.list_price, priceList: pc.current.name };
    }
  }
  const flags = [];
  let grossSource = 'catalog';
  // GP tier of the group: per-item GP from SMG MASTER, or (NONPC) the wholesale net price with a fallback tier.
  const tierDef = g.gp_tier ? gpTierDefs().get(g.gp_tier) : null;
  if (g.gp_tier && !tierDef) flags.push(`GP Tier ${g.gp_tier} ไม่มีในระบบ — คิดเฉพาะเงื่อนไขของกลุ่ม`);
  const wholesale = tierDef && tierDef.netPrice === 'WHOLESALE' && row && row.wholesale && row.wholesale.net > 0 ? row.wholesale : null;
  if (!(gross > 0) && wholesale) {
    gross = wholesale.net;
    grossSource = 'wholesale';
  }
  if (!(gross > 0)) {
    const typed = num(payload.grossPrice);
    if (!(typed > 0)) {
      throw new UserError(product
        ? `${product.key} ไม่มีราคาฐาน ${g.price_tier} ในรอบราคา ${product.priceList} — กรอกราคาตั้งเองเพื่อคำนวณ`
        : `ไม่พบ "${key}" ในรายการราคา${src ? ' ' + src[0] : ''}${g.price_tier ? '' : ' (กลุ่มนี้ยังไม่กำหนดราคาฐาน)'} — กรอกราคาตั้งเองเพื่อคำนวณ`, 422);
    }
    if (typed > 100000000) throw new UserError('ราคาตั้งสูงผิดปกติ');
    gross = typed;
    grossSource = 'typed';
    flags.push('ราคาตั้งกรอกเอง (ไม่ได้มาจากรายการราคา)');
  }
  if (product && STATUS_FLAGS[product.status]) flags.push(STATUS_FLAGS[product.status]);

  let gpTier = null;
  let tierTerms = [];
  if (tierDef) {
    let use = tierDef;
    gpTier = { code: tierDef.code, used: tierDef.code, fallback: false, wholesale: null };
    if (tierDef.netPrice === 'WHOLESALE') {
      use = null;
      if (wholesale) {
        gpTier.wholesale = { label: wholesale.label || '', net: wholesale.net, options: wholesale.options || [] };
        if (round(gross - wholesale.net, 2) !== 0) {
          tierTerms = [{ seq: 0, code: 'WHOLESALE', name: 'ราคาส่ง Non-PC (ใบราคา WHOLESALE)', method: 'THB_UNIT', category: 'GP', pct: 0,
            thb: round(gross - wholesale.net, 2), scope: '', note: '', gpTier: true, defaulted: false }];
        }
        if (wholesale.net > gross) flags.push('ราคาส่ง Non-PC สูงกว่าราคาตั้ง — ตรวจใบราคา WHOLESALE');
      } else {
        use = gpTierDefs().get(tierDef.fallback);
        gpTier.used = use.code;
        gpTier.fallback = true;
        flags.push(`ไม่มีในใบราคา Non-PC (WHOLESALE) — ใช้ GP Tier ${use.code} แทน`);
      }
    }
    if (use) {
      tierTerms = gpTierTerms(use, row && row.gp_rates);
      const missing = tierTerms.filter((t) => t.defaulted);
      if (missing.length) flags.push(`ไม่มี GP รายสินค้าใน SMG MASTER (${missing.map((t) => t.code).join(', ')}) — ใช้ค่าเริ่มต้นของ Tier`);
    }
  }
  const replaced = new Set(((gpTier && gpTierDefs().get(gpTier.used)) || {}).replacesTerms || []);

  const scopeKeys = [key.toUpperCase(), product ? product.key.toUpperCase() : '', product ? product.barcode : ''].filter(Boolean);
  const terms = (await db.query(
    `select t.seq, t.term_code, t.pct, t.thb, t.scope, t.note, t.owner_code, p.name, p.method, p.category
     from group_terms t join price_terms p on p.code = t.term_code
     where upper(t.owner_code) = any($1::text[])
       and (t.scope = '' or upper(t.scope) = 'ALL' or upper(t.scope) = any($2::text[]))
       and (t.valid_from is null or t.valid_from <= $3) and (t.valid_to is null or t.valid_to >= $3)
     order by t.seq, t.id`,
    [[group.code, customer ? customer.code.toUpperCase() : ''].filter(Boolean), scopeKeys, date])).rows
    .map((t) => ({ seq: t.seq, code: t.term_code, name: t.name, method: t.method, category: t.category, pct: t.pct, thb: t.thb,
      scope: t.scope, note: t.note, forCustomer: !!customer && t.owner_code.toUpperCase() === customer.code.toUpperCase() }))
    .filter((t) => !replaced.has(t.code.toUpperCase()));
  const w = applyTerms(gross, qty, tierTerms.concat(terms));
  const vat = (await getSettings(db)).VAT_RATE;
  return {
    date, qty, customer, group, product, productKey: product ? product.key : key, gross, grossSource, flags, gpTier,
    steps: w.steps, net: w.net, netExVat: round(w.net / (1 + vat), 2), total: round(w.net * qty, 2), totalDiscount: w.totalDiscount, vatRate: vat
  };
}

async function submitRequest(ctx, payload) {
  const { db, user, cfg } = ctx;
  payload = payload || {};
  const settings = await getSettings(db);
  const { group, channel } = await getChannel(db, payload.channelId);
  const customer = str(payload.customer, 200);
  if (!customer) throw new UserError('กรุณาใส่ชื่อคู่ค้า / ร้านค้า');
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  if (!lines.length) throw new UserError('กรุณาเพิ่มสินค้าอย่างน้อย 1 รายการ');
  if (lines.length > 50) throw new UserError('ส่งได้สูงสุด 50 รายการต่อครั้ง');

  const today = todayIso(cfg.timezone);
  const start = isIsoDate(payload.startDate) ? payload.startDate : today;
  const end = isIsoDate(payload.endDate) ? payload.endDate : addDays(start, settings.DEFAULT_VALIDITY_DAYS);
  if (start < today) throw new UserError('วันเริ่มต้องไม่ย้อนหลัง');
  if (start > addDays(today, 60)) throw new UserError('วันเริ่มต้องไม่เกิน 60 วันจากวันนี้');
  if (end < start) throw new UserError('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  if (daysBetween(start, end) > settings.MAX_VALIDITY_DAYS) throw new UserError(`ระยะเวลาราคาพิเศษยาวได้ไม่เกิน ${settings.MAX_VALIDITY_DAYS} วัน`);

  const prepared = [];
  for (const [i, l] of lines.entries()) {
    const qty = num(l && l.qty);
    if (!(qty >= 1) || !Number.isInteger(qty) || qty > 1000000) throw new UserError(`รายการที่ ${i + 1}: จำนวนต้องเป็นเลขจำนวนเต็ม ≥ 1`);
    if (!str(l.productKey)) throw new UserError(`รายการที่ ${i + 1}: กรุณาเลือก${channel.keyLabel || 'สินค้า'}`);
    const p = await prepareLine(db, group, channel, l, settings, today);
    p.qty = qty;
    prepared.push(p);
  }

  const batchId = 'B' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase();
  const labels = channel.discounts.map((d) => d.label);
  const created = await tx(db, async (c) => {
    const rows = [];
    for (const p of prepared) {
      const n = (await c.query('update id_counters set last_value = last_value + 1 where prefix = $1 returning last_value', [channel.idPrefix])).rows[0];
      if (!n) throw new Error('missing id counter for ' + channel.idPrefix);
      const id = channel.idPrefix + pad(n.last_value, 4);
      const r = (await c.query(
        `insert into requests (id, batch_id, group_id, channel_id, cost_source, brand, customer, project, note, product_key, product_name, qty,
           normal_price, special_price, discounts, discount_labels, cost, net_inc_vat, net_ex_vat, gain, mu, indicator, status,
           start_date, end_date, requester, requested_at, flags, source, price_list_id, bundle_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'Pending',$23,$24,$25,now(),$26,'APP',$27,$28)
         returning *`,
        [id, batchId, group.id, channel.id, group.costSource, channel.brand, customer, str(payload.project, 200), str(payload.note, 500),
          p.productKey, p.productName, p.qty, p.normalPrice, p.specialPrice, JSON.stringify(p.discounts), JSON.stringify(labels),
          p.calc.cost, p.calc.netIncVat, p.calc.netExVat, p.calc.gain, p.calc.mu, p.calc.indicator, start, end, user.email, p.flags,
          p.item && p.item.priceList ? p.item.priceList.id : null, p.item && p.item.bundleId ? p.item.bundleId : null])).rows[0];
      rows.push(r);
    }
    await log(c, user.email, 'SUBMIT', rows.map((r) => r.id), { customer, channel: channel.id });
    return rows;
  });

  const approvers = await approverEmails(db, settings);
  ctx.notify(notifyMsg.submitted(cfg, created, user, group, channel, approvers.filter((e) => e !== user.email)));
  const view = await makeView(ctx);
  return { batchId, lines: created.map(view) };
}

async function approverEmails(db, settings) {
  const list = (await db.query(`select email from users where active and role in ('SUPERVISOR', 'ADMIN')`)).rows.map((r) => r.email);
  String(settings.NOTIFY_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean).forEach((e) => {
    if (!list.includes(e)) list.push(e);
  });
  return list;
}

// ---------------------------------------------------------------- lists

async function listMyRequests(ctx, filter) {
  const today = todayIso(ctx.cfg.timezone);
  const params = [ctx.user.email];
  const where = ['lower(requester) = $1'].concat(buildFilter(filter || {}, today, params));
  const rows = (await ctx.db.query(`select * from requests where ${where.join(' and ')} order by requested_at desc nulls last, id desc limit 300`, params)).rows;
  return rows.map(await makeView(ctx));
}

async function listRequests(ctx, filter) {
  approver(ctx);
  filter = filter || {};
  const today = todayIso(ctx.cfg.timezone);
  const params = [];
  const where = buildFilter(filter, today, params);
  const limit = Math.min(Number(filter.limit) || 500, 3000);
  const rows = (await ctx.db.query(`select * from requests ${where.length ? 'where ' + where.join(' and ') : ''}
    order by requested_at desc nulls last, id desc limit ${limit}`, params)).rows;
  const view = await makeView(ctx);
  const settings = await getSettings(ctx.db);
  const groups = await groupsWithInactive(ctx.db);
  const out = [];
  for (const r of rows) {
    const v = view(r);
    // Pending requests made on an older price list: show what approving today would mean.
    if (r.status === STATUS.PENDING && v.oldPriceList) {
      const rp = await reprice(ctx.db, r, groups, settings, today);
      if (rp) {
        v.repriced = { priceList: rp.priceList, normalPrice: rp.normalPrice, indicator: rp.calc.indicator, muBand: muBand(rp.calc.mu, rp.rules) };
        if (canSeeCost(ctx.user)) Object.assign(v.repriced, { cost: rp.calc.cost, mu: rp.calc.mu });
      }
    }
    out.push(v);
  }
  return out;
}

async function searchApprovedPrices(ctx, filter) {
  filter = filter || {};
  const today = todayIso(ctx.cfg.timezone);
  const params = [today];
  const where = [`status = 'Approved'`].concat(buildFilter({ q: filter.q, group: filter.group, channel: filter.channel }, today, params));
  if (!filter.includeExpired) where.push('(end_date is null or end_date >= $1) and (start_date is null or start_date <= $1)');
  const rows = (await ctx.db.query(`select * from requests where ${where.join(' and ')} order by requested_at desc nulls last, id desc limit 300`, params)).rows;
  return rows.map(await makeView(ctx));
}

async function getLineContext(ctx, id) {
  approver(ctx);
  const today = todayIso(ctx.cfg.timezone);
  const row = (await ctx.db.query('select * from requests where id = $1', [String(id)])).rows[0];
  if (!row) throw new UserError('ไม่พบคำขอ ' + id, 404);
  const sameProduct = (await ctx.db.query(
    `select * from requests where id <> $1 and cost_source = $2 and coalesce(brand, '') = coalesce($3, '') and upper(product_key) = upper($4)
     order by requested_at desc nulls last limit 10`, [row.id, row.cost_source, row.brand, row.product_key])).rows;
  const sameCustomer = row.customer ? (await ctx.db.query(
    `select * from requests where id <> $1 and lower(customer) = lower($2) order by requested_at desc nulls last limit 10`, [row.id, row.customer])).rows : [];
  const view = await makeView(ctx);
  return { sameProduct: sameProduct.map(view), sameCustomer: sameCustomer.map(view) };
}

// ---------------------------------------------------------------- decisions

async function decideRequests(ctx, payload) {
  const user = approver(ctx);
  payload = payload || {};
  const decision = payload.decision;
  if (decision !== STATUS.APPROVED && decision !== STATUS.REJECTED) throw new UserError('คำสั่งไม่ถูกต้อง');
  const comment = str(payload.comment, 500);
  if (decision === STATUS.REJECTED && !comment) throw new UserError('กรุณาใส่เหตุผลที่ไม่อนุมัติ');
  const ids = (Array.isArray(payload.ids) ? payload.ids : []).map(String).slice(0, 500);
  if (!ids.length) throw new UserError('กรุณาเลือกรายการ');
  const today = todayIso(ctx.cfg.timezone);
  // Supervisors may not decide their own requests; admins may.
  const ownGuard = user.role === 'ADMIN' ? '' : 'and lower(requester) <> $2';
  const settings = await getSettings(ctx.db);
  const groups = await groupsWithInactive(ctx.db);
  const changed = await tx(ctx.db, async (c) => {
    const pending = (await c.query(`select * from requests where id = any($1) and status = 'Pending' ${ownGuard} for update`,
      ownGuard ? [ids, user.email] : [ids])).rows;
    const rows = [];
    for (const r of pending) {
      // Approving after a new price list took effect: the snapshot follows today's list.
      const rp = decision === STATUS.APPROVED ? await reprice(c, r, groups, settings, today) : null;
      const snap = rp
        ? [rp.priceListId, rp.normalPrice, rp.calc.cost, rp.calc.netIncVat, rp.calc.netExVat, rp.calc.gain, rp.calc.mu, rp.calc.indicator,
          (r.flags || []).concat([`คิดใหม่ตามราคารอบ ${rp.priceList} ณ วันอนุมัติ`])]
        : [r.price_list_id, r.normal_price, r.cost, r.net_inc_vat, r.net_ex_vat, r.gain, r.mu, r.indicator, r.flags];
      rows.push((await c.query(
        `update requests set status = $2, decided_by = $3, decided_at = now(), decision_comment = $4, updated_at = now(),
           price_list_id = $5, normal_price = $6, cost = $7, net_inc_vat = $8, net_ex_vat = $9, gain = $10, mu = $11, indicator = $12, flags = $13
         where id = $1 returning *`, [r.id, decision, user.email, comment].concat(snap))).rows[0]);
    }
    await log(c, user.email, decision === STATUS.APPROVED ? 'APPROVE' : 'REJECT', rows.map((r) => r.id), { comment });
    return rows;
  });
  const done = changed.map((r) => r.id);
  notifyMsg.decided(ctx.cfg, changed, user).forEach((m) => ctx.notify(m));
  const view = await makeView(ctx);
  return { updated: done, skipped: ids.filter((id) => !done.includes(id)), lines: changed.map(view) };
}

async function cancelMyRequests(ctx, ids) {
  const user = ctx.user;
  ids = (Array.isArray(ids) ? ids : []).map(String).slice(0, 500);
  const changed = await tx(ctx.db, async (c) => {
    const rows = (await c.query(
      `update requests set status = 'Cancelled', decided_by = $1, decided_at = now(), decision_comment = 'ยกเลิกโดยผู้ขอ', updated_at = now()
       where id = any($2) and status = 'Pending' and lower(requester) = $1 returning id`, [user.email, ids])).rows;
    await log(c, user.email, 'CANCEL', rows.map((r) => r.id));
    return rows;
  });
  return { updated: changed.map((r) => r.id) };
}

// ---------------------------------------------------------------- dashboard

async function getDashboard(ctx, filter) {
  approver(ctx);
  filter = filter || {};
  const today = todayIso(ctx.cfg.timezone);
  const to = isIsoDate(filter.to) ? filter.to : today;
  const from = isIsoDate(filter.from) ? filter.from : addDays(to, -29);
  const sixMonthsAgo = addDays(today.slice(0, 8) + '01', -160).slice(0, 8) + '01';
  const params = [sixMonthsAgo];
  let groupSql = '';
  if (filter.group) { params.push(String(filter.group)); groupSql = ' and group_id = $2'; }
  const all = (await ctx.db.query(
    `select *, (requested_at at time zone 'Asia/Bangkok')::date::text as req_day from requests
     where (requested_at >= $1::date or status = 'Pending' or (status = 'Approved' and end_date >= current_date))${groupSql}`, params)).rows;
  const inRange = all.filter((r) => r.req_day && r.req_day >= from && r.req_day <= to);
  const approved = inRange.filter((r) => r.status === STATUS.APPROVED);
  const low = (r) => r.indicator === 'VERY LOW' || r.indicator === 'ขาดทุน';
  const showMu = canSeeCost(ctx.user);
  const avgMu = (rows) => {
    if (!showMu) return null; // an average over few rows would reveal a single item's margin
    const m = rows.map((r) => r.mu).filter((x) => x !== null && x > -1);
    return m.length ? round(m.reduce((a, b) => a + b, 0) / m.length, 4) : null;
  };
  const count = (rows, s) => rows.filter((r) => r.status === s).length;
  const group = (rows, key) => rows.reduce((g, r) => { (g[key(r)] = g[key(r)] || []).push(r); return g; }, {});

  const catalog = await getCatalog(ctx.db, true);
  const groupName = Object.fromEntries(catalog.map((g) => [g.id, g.name]));
  const chName = Object.fromEntries(catalog.flatMap((g) => g.channels.map((c) => [c.id, c.name])));

  const indicators = ['OKAY', 'LOW', 'VERY LOW', 'ขาดทุน', INDICATOR.NO_COST];
  const byInd = group(inRange, (r) => r.indicator || INDICATOR.NO_COST);
  const byCh = group(inRange, (r) => r.channel_id);
  const byReq = group(inRange, (r) => r.requester || '(ไม่ระบุ)');
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - i, 1));
    const m = d.toISOString().slice(0, 7);
    const rows = all.filter((r) => r.req_day && r.req_day.slice(0, 7) === m);
    months.push({ month: m, total: rows.length, approved: count(rows, STATUS.APPROVED), avgMu: avgMu(rows.filter((r) => r.status === STATUS.APPROVED)) });
  }
  const soon = addDays(today, 7);
  const expiringRows = all.filter((r) => r.status === STATUS.APPROVED && r.end_date && r.end_date >= today && r.end_date <= soon)
    .sort((a, b) => (a.end_date < b.end_date ? -1 : 1));
  const riskyRows = approved.filter(low).sort((a, b) => b.requested_at - a.requested_at);
  const view = await makeView(ctx);
  return {
    from, to, showMu,
    kpis: {
      total: inRange.length,
      pendingNow: all.filter((r) => r.status === STATUS.PENDING).length,
      approved: approved.length,
      rejected: count(inRange, STATUS.REJECTED),
      avgMuApproved: avgMu(approved),
      riskyApproved: riskyRows.length,
      expiringSoon: expiringRows.length
    },
    byIndicator: indicators.map((k) => ({ indicator: k, total: (byInd[k] || []).length, approved: count(byInd[k] || [], STATUS.APPROVED) })),
    byChannel: Object.keys(byCh).map((k) => ({
      channel: k, name: chName[k] || k, group: groupName[byCh[k][0].group_id] || byCh[k][0].group_id,
      total: byCh[k].length, approved: count(byCh[k], STATUS.APPROVED), avgMu: avgMu(byCh[k].filter((r) => r.status === STATUS.APPROVED))
    })).sort((a, b) => b.total - a.total),
    byRequester: Object.keys(byReq).map((k) => ({
      email: k, total: byReq[k].length, pending: count(byReq[k], STATUS.PENDING), approved: count(byReq[k], STATUS.APPROVED),
      rejected: count(byReq[k], STATUS.REJECTED), lowCount: byReq[k].filter(low).length, avgMu: avgMu(byReq[k])
    })).sort((a, b) => b.total - a.total),
    byMonth: months,
    expiring: expiringRows.slice(0, 50).map(view),
    risky: riskyRows.slice(0, 50).map(view)
  };
}

// ---------------------------------------------------------------- admin

async function getAdminInfo(ctx) {
  admin(ctx);
  const { db } = ctx;
  const q = async (sql) => (await db.query(sql)).rows;
  const settings = await q('select key, value, description from settings order by key');
  return {
    settings: settings.map((r) => ({ key: r.key, value: r.value, description: r.description })),
    users: (await q('select email, name, role, active, can_view_cost, last_login_at from users order by role desc, email')).map((u) => ({
      email: u.email, name: u.name, role: u.role, active: u.active, canViewCost: u.can_view_cost, lastLoginAt: u.last_login_at ? u.last_login_at.toISOString() : ''
    })),
    priceLists: await priceListSummary(db, todayIso(ctx.cfg.timezone)),
    catalog: await getCatalog(db, false),
    counts: {
      products: Number((await q('select count(*) from products'))[0].count),
      bundles: Number((await q('select count(*) from bundles where active'))[0].count),
      productsWithoutCost: Number((await q('select count(*) from products where cost is null or cost <= 0'))[0].count),
      productsUpdatedAt: ((await q('select max(updated_at) as m from products'))[0].m || '').toString(),
      projectCosts: Number((await q('select count(*) from project_costs'))[0].count),
      landedItems: Number((await q('select count(*) from landed_items'))[0].count),
      requests: Number((await q('select count(*) from requests'))[0].count)
    },
    priceCheckAlerts: await priceCheckAlerts(db, await getSettings(db)),
    catalogSync: await catalogSyncStatus(db),
    customerPricing: await customerPricingStatus(db),
    syncConfigured: !!ctx.cfg.syncWebhookUrl,
    recentLog: (await q('select at, user_email, action, req_ids, detail from audit_log order by at desc limit 30')).map((l) => ({
      at: l.at.toISOString(), user: l.user_email, action: l.action, ids: l.req_ids.slice(0, 5).join(', ') + (l.req_ids.length > 5 ? ' …' : ''), detail: JSON.stringify(l.detail)
    }))
  };
}

/** Last SMG catalogue sync from n8n, successful or not (counts and barcodes only, never cost). */
async function catalogSyncStatus(db) {
  const r = (await db.query(`select at, action, detail from audit_log where user_email = 'n8n' and action in ('IMPORT', 'IMPORT_FAILED')
    and detail->>'type' = 'smg_catalog' order by at desc limit 1`)).rows[0];
  if (!r) return null;
  const d = r.detail || {};
  return {
    at: r.at.toISOString(), ok: r.action === 'IMPORT', error: d.error || '', priceList: d.priceList || '', imported: d.imported || 0,
    withCost: d.withCost || 0, withoutCost: d.withoutCost || 0, notForSale: d.notForSale || 0, blankSaleStatus: d.blankSaleStatus || 0,
    statuses: d.statuses || {}, masterMismatchCount: d.masterMismatchCount || 0, masterMismatches: d.masterMismatches || [],
    duplicateBarcodes: d.duplicateBarcodes || [], badBarcodes: d.badBarcodes || 0,
    sets: d.setRows !== undefined, setRows: d.setRows || 0, setCostUsed: d.setCostUsed || 0, setNoBarcode: d.setNoBarcode || 0,
    setNoTotal: d.setNoTotal || [], setZeroPart: d.setZeroPart || [], setSumMismatch: d.setSumMismatch || [], setConflict: d.setConflict || [],
    setNotInCatalogue: d.setNotInCatalogue || 0,
    gpColumns: d.gpColumns || [], gpRated: d.gpRated || 0, gpBadRates: d.gpBadRates || [],
    wholesale: d.wholesaleRows !== undefined, wholesaleRows: d.wholesaleRows || 0, wholesaleUsed: d.wholesaleUsed || 0,
    wholesaleBadRows: d.wholesaleBadRows || 0, wholesaleDuplicates: d.wholesaleDuplicates || [], wholesaleNotInCatalogue: d.wholesaleNotInCatalogue || 0
  };
}

/** Last import of the Customer Price Mapping sheet and what is loaded now. */
async function customerPricingStatus(db) {
  const r = (await db.query(`select at, action, detail from audit_log where action in ('IMPORT', 'IMPORT_FAILED')
    and detail->>'type' = 'customer_pricing' order by at desc limit 1`)).rows[0];
  const n = async (t) => Number((await db.query(`select count(*) from ${t}`)).rows[0].count);
  const d = (r && r.detail) || {};
  return {
    at: r ? r.at.toISOString() : '', ok: r ? r.action === 'IMPORT' : null, error: d.error || '', errors: d.errors || [], errorCount: d.errorCount || 0,
    customers: await n('customers'), groups: await n('customer_groups'), terms: await n('price_terms'), groupTerms: await n('group_terms'),
    ungrouped: Number((await db.query(`select count(*) from customers c left join sap_channel_groups m on m.sap_channel = c.sap_channel
      where coalesce(nullif(c.override_group, ''), m.group_code, '') = ''`)).rows[0].count)
  };
}

/** Admin "sync now": asks n8n to read the three Google Sheets and post them to /api/integrations/import/smg_catalog. */
async function requestCatalogSync(ctx) {
  const user = admin(ctx);
  if (!ctx.cfg.syncWebhookUrl) throw new UserError('ยังไม่ได้ตั้งค่า SYNC_WEBHOOK_URL ที่เซิร์ฟเวอร์');
  if ((await ctx.db.query(`select 1 from audit_log where action = 'SYNC_REQUEST' and at > now() - interval '2 minutes'`)).rowCount) {
    throw new UserError('เพิ่งสั่งซิงค์ไปแล้ว กรุณารอ 2 นาที', 429);
  }
  await log(ctx.db, user.email, 'SYNC_REQUEST', [], {});
  let r;
  try {
    r = await fetch(ctx.cfg.syncWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ctx.cfg.integrationToken ? { Authorization: 'Bearer ' + ctx.cfg.integrationToken } : {}) },
      body: JSON.stringify({ event: 'catalog.sync', requestedBy: user.email }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) {
    throw new UserError('ติดต่อ n8n ไม่ได้: ' + e.message, 502);
  }
  if (!r.ok) throw new UserError('n8n ตอบกลับ HTTP ' + r.status, 502);
  return { ok: true };
}

/** Users who checked one item at many different prices in the last 7 days (see guardPriceCheck). */
async function priceCheckAlerts(db, settings) {
  return (await db.query(
    `select user_email, key_norm, string_agg(distinct channel_id, ', ') as channels, count(distinct net_price)::int as prices,
       count(*)::int as checks, max(at) as last_at
     from price_checks where at > now() - interval '7 days'
     group by 1, 2 having count(distinct net_price) >= $1 order by last_at desc limit 50`, [settings.PRICE_CHECK_ALERT])).rows
    .map((r) => ({ user: r.user_email, channel: r.channels, key: r.key_norm, prices: r.prices, checks: r.checks, lastAt: r.last_at.toISOString() }));
}

async function saveSettings(ctx, changes) {
  const user = admin(ctx);
  changes = changes || {};
  const numeric = { VAT_RATE: [0, 0.3], DEFAULT_VALIDITY_DAYS: [1, 365], MAX_VALIDITY_DAYS: [1, 365], PRICE_CHECK_ALERT: [2, 1000], PRICE_CHECK_LIMIT: [2, 1000], PRICE_CHECK_PER_HOUR: [10, 10000] };
  const current = await getSettings(ctx.db);
  const next = Object.assign({}, current);
  for (const key of Object.keys(changes)) {
    if (!(key in current)) continue;
    let v = changes[key];
    if (numeric[key]) {
      v = Number(v);
      if (!Number.isFinite(v) || v < numeric[key][0] || v > numeric[key][1]) throw new UserError(`${key} ต้องอยู่ระหว่าง ${numeric[key][0]}–${numeric[key][1]}`);
    } else {
      v = str(v, 1000);
    }
    next[key] = v;
  }
  if (next.DEFAULT_VALIDITY_DAYS > next.MAX_VALIDITY_DAYS) throw new UserError('DEFAULT_VALIDITY_DAYS ต้องไม่เกิน MAX_VALIDITY_DAYS');
  if (next.PRICE_CHECK_ALERT > next.PRICE_CHECK_LIMIT) throw new UserError('PRICE_CHECK_ALERT ต้องไม่เกิน PRICE_CHECK_LIMIT');
  await tx(ctx.db, async (c) => {
    for (const key of Object.keys(changes)) {
      if (key in current) await c.query('update settings set value = $2 where key = $1', [key, JSON.stringify(next[key])]);
    }
    await log(c, user.email, 'SAVE_SETTINGS', [], changes);
  });
  return getAdminInfo(ctx);
}

async function saveUser(ctx, u) {
  const me = admin(ctx);
  u = u || {};
  const email = str(u.email, 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || !ctx.cfg.allowedDomains.includes(email.split('@')[1])) {
    throw new UserError('อีเมลต้องเป็น ' + ctx.cfg.allowedDomains.map((d) => '@' + d).join(' หรือ '));
  }
  const role = String(u.role || 'SALES').toUpperCase();
  if (!ROLES.includes(role)) throw new UserError('Role ไม่ถูกต้อง');
  const active = u.active !== false;
  if (email === me.email && (role !== 'ADMIN' || !active)) throw new UserError('ไม่สามารถลดสิทธิ์หรือปิดบัญชีของตัวเองได้');
  await tx(ctx.db, async (c) => {
    await c.query(`insert into users (email, name, role, active) values ($1, $2, $3, $4)
      on conflict (email) do update set name = coalesce(nullif(excluded.name, ''), users.name), role = excluded.role, active = excluded.active`,
    [email, str(u.name, 100), role, active]);
    await log(c, me.email, 'SAVE_USER', [], { email, role, active });
  });
  return getAdminInfo(ctx);
}

/** Admin CSV upload (cost masters / legacy requests). */
async function importCsv(ctx, payload) {
  const user = admin(ctx);
  payload = payload || {};
  if (String(payload.csv || '').length > 15 * 1024 * 1024) throw new UserError('ไฟล์ใหญ่เกิน 15MB');
  const values = parseCsv(String(payload.csv || ''));
  const res = await importData(ctx.db, {
    type: payload.type, values, brand: payload.brand, group: payload.group, today: todayIso(ctx.cfg.timezone), user: user.email,
    priceList: payload.priceList ? { name: payload.priceList.name, effectiveFrom: payload.priceList.effectiveFrom } : null
  });
  await log(ctx.db, user.email, 'IMPORT', [], { type: payload.type, file: payload.fileName, ...res, errors: (res.errors || []).slice(0, 20) });
  return res;
}

// ---------------------------------------------------------------- price lists (admin)

async function priceListSummary(db, today) {
  const lists = (await db.query(`select l.id, l.name, l.effective_from::text as effective_from, l.note, l.created_by,
      (select count(*) from requests r where r.price_list_id = l.id)::int as requests
    from price_lists l order by l.effective_from desc, l.id desc`)).rows;
  const counts = (await db.query('select price_list_id, brand, count(*)::int as n from products group by 1, 2')).rows;
  const pc = await priceContext(db, today);
  return lists.map((l) => {
    const brands = counts.filter((c) => c.price_list_id === l.id).map((c) => {
      const b = pc[c.brand] || {};
      const status = b.current && b.current.id === l.id ? 'current' : (l.effective_from > today ? 'upcoming' : 'past');
      return { brand: c.brand, products: c.n, status };
    });
    return { id: l.id, name: l.name, effectiveFrom: l.effective_from, note: l.note, createdBy: l.created_by, requests: l.requests, brands };
  });
}

/** Creates an empty price list with its date, so the n8n sync can fill it (n8n never creates a list that starts today). */
async function createPriceList(ctx, payload) {
  const user = admin(ctx);
  payload = payload || {};
  const name = str(payload.name, 60);
  if (!name) throw new UserError('กรุณาระบุชื่อรอบราคา (เช่น AUG26)');
  if (!isIsoDate(payload.effectiveFrom)) throw new UserError('วันที่มีผลไม่ถูกต้อง');
  if ((await ctx.db.query('select 1 from price_lists where name_norm = upper(btrim($1))', [name])).rowCount) throw new UserError('มีรอบราคาชื่อนี้แล้ว');
  await ctx.db.query('insert into price_lists (name, effective_from, note, created_by) values ($1, $2, $3, $4)', [name, payload.effectiveFrom, str(payload.note, 300), user.email]);
  await log(ctx.db, user.email, 'CREATE_PRICE_LIST', [], { name, effectiveFrom: payload.effectiveFrom });
  return getAdminInfo(ctx);
}

async function savePriceList(ctx, payload) {
  const user = admin(ctx);
  payload = payload || {};
  if (!isIsoDate(payload.effectiveFrom)) throw new UserError('วันที่มีผลไม่ถูกต้อง');
  const r = await ctx.db.query('update price_lists set effective_from = $2, note = $3 where id = $1', [Number(payload.id), payload.effectiveFrom, str(payload.note, 300)]);
  if (!r.rowCount) throw new UserError('ไม่พบรอบราคา', 404);
  await log(ctx.db, user.email, 'SAVE_PRICE_LIST', [], payload);
  return getAdminInfo(ctx);
}

/** Only an upcoming list that no request uses can be deleted (e.g. imported by mistake). */
async function deletePriceList(ctx, id) {
  const user = admin(ctx);
  const today = todayIso(ctx.cfg.timezone);
  const l = (await ctx.db.query('select *, effective_from::text as eff from price_lists where id = $1', [Number(id)])).rows[0];
  if (!l) throw new UserError('ไม่พบรอบราคา', 404);
  if (l.eff <= today) throw new UserError('ลบได้เฉพาะรอบราคาที่ยังไม่มีผล');
  if ((await ctx.db.query('select 1 from requests where price_list_id = $1 limit 1', [l.id])).rowCount) throw new UserError('มีคำขอที่ใช้รอบราคานี้แล้ว');
  await ctx.db.query('delete from price_lists where id = $1', [l.id]);
  await log(ctx.db, user.email, 'DELETE_PRICE_LIST', [], { name: l.name });
  return getAdminInfo(ctx);
}

// ---------------------------------------------------------------- bundles (DUMMY SET) — anyone can create, everyone can use

/**
 * @param {{brand:string, label?:string, items:{productKey:string, qty?:number}[]}} payload
 * Name follows the sheet's DUMMY SET: component keys joined with " + " (" ×n" when qty > 1).
 */
async function createBundle(ctx, payload) {
  const { db, user } = ctx;
  payload = payload || {};
  const today = todayIso(ctx.cfg.timezone);
  const brand = String(payload.brand || '').toUpperCase();
  const pc = (await priceContext(db, today))[brand];
  if (!pc || !pc.current) throw new UserError('ไม่พบรายการราคาของแบรนด์ ' + brand);
  const items = (Array.isArray(payload.items) ? payload.items : []).filter((i) => i && str(i.productKey));
  if (items.length < 2 || items.length > 5) throw new UserError('ชุดเซ็ตต้องมีสินค้า 2–5 รายการ');
  const resolved = [];
  for (const [i, it] of items.entries()) {
    const qty = it.qty === undefined || it.qty === '' ? 1 : num(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new UserError(`รายการที่ ${i + 1}: จำนวนต้องเป็น 1–99`);
    const p = (await db.query('select key from products where price_list_id = $1 and brand = $2 and (key_norm = upper(btrim($3)) or barcode = btrim($3)) order by (key_norm = upper(btrim($3))) desc limit 1',
      [pc.current.id, brand, str(it.productKey, 200)])).rows[0];
    if (!p) throw new UserError(`ไม่พบสินค้า "${str(it.productKey, 80)}" ในรอบราคาปัจจุบัน`);
    resolved.push({ key: p.key, qty });
  }
  const name = resolved.map((r) => (r.qty > 1 ? `${r.key} ×${r.qty}` : r.key)).join(' + ');
  if ((await db.query('select 1 from products where price_list_id = $1 and brand = $2 and key_norm = upper($3)', [pc.current.id, brand, name])).rowCount) {
    throw new UserError('ชื่อเซ็ตซ้ำกับสินค้าที่มีอยู่');
  }
  const id = await tx(db, async (c) => {
    if ((await c.query('select 1 from bundles where active and brand = $1 and name_norm = upper($2)', [brand, name])).rowCount) {
      throw new UserError('มีชุดเซ็ตนี้อยู่แล้ว — เลือกใช้จากรายการได้เลย');
    }
    const b = (await c.query('insert into bundles (brand, name, label, created_by) values ($1, $2, $3, $4) returning id', [brand, name, str(payload.label, 120), user.email])).rows[0];
    for (const [i, r] of resolved.entries()) await c.query('insert into bundle_items (bundle_id, position, product_key, qty) values ($1, $2, $3, $4)', [b.id, i, r.key, r.qty]);
    await log(c, user.email, 'CREATE_BUNDLE', [], { brand, name });
    return b.id;
  });
  const row = (await db.query(`select b.id, b.brand, b.name, b.label, b.created_by, json_agg(json_build_object('k', i.product_key, 'q', i.qty) order by i.position) as items
     from bundles b join bundle_items i on i.bundle_id = b.id where b.id = $1 group by b.id`, [id])).rows[0];
  return bundleView(row, await priceMap(db, pc.current.id, brand));
}

/** Creator or admin. Requests that used the bundle keep their snapshot. */
async function deleteBundle(ctx, id) {
  const { db, user } = ctx;
  const b = (await db.query('select * from bundles where id = $1 and active', [Number(id)])).rows[0];
  if (!b) throw new UserError('ไม่พบชุดเซ็ต', 404);
  if (b.created_by !== user.email && user.role !== 'ADMIN') throw new UserError('ลบได้เฉพาะเซ็ตที่คุณสร้าง', 403);
  await db.query('update bundles set active = false where id = $1', [b.id]);
  await log(db, user.email, 'DELETE_BUNDLE', [], { name: b.name });
  return { ok: true };
}

module.exports = {
  // RPC-callable
  rpc: {
    getBootstrap, priceCheck, submitRequest, listMyRequests, listRequests, searchApprovedPrices, getLineContext,
    decideRequests, cancelMyRequests, getDashboard, getAdminInfo, saveSettings, saveUser, importCsv,
    createPriceList, savePriceList, deletePriceList, createBundle, deleteBundle, requestCatalogSync,
    searchCustomers, customerPriceCheck
  },
  // internal
  todayIso, STATUS
};
