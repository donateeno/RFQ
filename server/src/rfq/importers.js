'use strict';
/**
 * Imports from Google Sheets exports (CSV upload by an admin, or 2-D `values` arrays sent by n8n).
 *
 *   products            flat: brand, key, name, cost, normal_price
 *   cost_price_sheet    raw "_Cost&Price" tab (A:C EVE model | E:G GT hot price | I:L Foster code)
 *   cal_dummy_sheet     raw "_CalDummy" tab (dummy set name, total cost in L, total price in S)
 *   project_costs       flat: project_key, customer, description, cost, normal_price   (group: JS)
 *   landed_items        flat or raw "_Manual.Cal": item_code/Ref. ItmCode, description/ItmDescrption,
 *                       factory_rmb/FactoryRMB, exch_rate/ExCh. Rate, bp_disc/BP Disc., incoterm, misc_charge
 *   GT.EVE_RFQ | GT.FOSTER_RFQ | BT.EVE_RFQ | BT.FOSTER_RFQ | OFFI_RFQ   old request tabs
 */
const { calculate, UserError, PRICE_TIERS, TERM_METHODS, resolveTierPrice } = require('../pricing');
const { tx } = require('../db');
const { getSettings, getCatalog, lookupItem } = require('./catalog');

// ---------------------------------------------------------------- parsing helpers

/** RFC 4180 CSV → string[][] (handles quotes, commas and newlines inside quotes, BOM). */
function parseCsv(text) {
  text = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const cell = (row, i) => (row && row[i] !== undefined && row[i] !== null ? String(row[i]).trim() : '');

/** "19,990.00" → 19990, "18.00%" → 0.18, "#N/A"/"" → null */
function toNum(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s || s.startsWith('#') || s === '-') return null;
  const pct = s.endsWith('%');
  const n = Number(s.replace(/[,%฿\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}

/** Fractions may come as 0.18, 18% or 18 → 0.18 */
function toFraction(v) {
  const n = toNum(v);
  if (n === null) return null;
  return n > 1 ? n / 100 : n;
}

/**
 * Sheet date text → 'YYYY-MM-DD'. The source sheets mix two display formats:
 * 4-digit year = M/D/YYYY (sheet locale), 2-digit year = DD/MM/YY (custom format).
 */
function parseSheetDate(v) {
  const s = String(v || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s|$)/.exec(s);
  if (!m) return null;
  if (m[3].length === 4) return valid(+m[3], +m[1], +m[2]);
  return valid(2000 + +m[3], +m[2], +m[1]);
  function valid(y, mo, d) {
    if (y < 2015 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return null;
    return dt.toISOString().slice(0, 10);
  }
}

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Finds the header row (first row containing one of `marker` names) and maps names → index. */
function headerMap(values, aliases) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  for (let r = 0; r < Math.min(values.length, 10); r++) {
    const names = values[r].map(norm);
    const map = {};
    Object.keys(aliases).forEach((k) => {
      const idx = names.findIndex((n) => aliases[k].map(norm).includes(n));
      if (idx !== -1) map[k] = idx;
    });
    if (map.key !== undefined) return { row: r, map };
  }
  throw new UserError('ไม่พบหัวคอลัมน์ที่ต้องการ (' + aliases.key.join(' / ') + ')');
}

// ---------------------------------------------------------------- cost masters

/**
 * Finds the price list by name (case-insensitive) or creates it. Re-importing into an existing list
 * corrects it in place and keeps its date. A new list always needs an explicit effective date, so an
 * import can never switch prices on the import day by accident. `futureOnly` (n8n) only lets it create
 * lists that start after today; anything else must be set up by an admin in ตั้งค่า → รอบราคา first.
 */
async function resolvePriceList(c, priceList, today, user, futureOnly) {
  const name = String((priceList && priceList.name) || '').trim().slice(0, 60);
  if (!name) throw new UserError('กรุณาระบุชื่อรอบราคา (เช่น AUG26)');
  const eff = priceList.effectiveFrom ? parseSheetDate(priceList.effectiveFrom) : null;
  if (priceList.effectiveFrom && !eff) throw new UserError('วันที่มีผลของรอบราคาไม่ถูกต้อง');
  const found = (await c.query('select id, name, effective_from::text as eff from price_lists where name_norm = upper(btrim($1))', [name])).rows[0];
  if (found) return { id: found.id, name: found.name, effectiveFrom: found.eff, created: false };
  if (!eff) throw new UserError(`รอบราคา ${name} ยังไม่มีในระบบ — รอบใหม่ต้องระบุวันที่มีผล หรือให้ Admin สร้างรอบที่ ตั้งค่า → รอบราคา ก่อน`, 409);
  if (futureOnly && eff <= today) throw new UserError(`รอบราคา ${name} ยังไม่มีในระบบ — การนำเข้าอัตโนมัติสร้างได้เฉพาะรอบที่มีผลหลังวันนี้ ให้ Admin สร้างรอบที่ ตั้งค่า → รอบราคา`, 409);
  const r = (await c.query('insert into price_lists (name, effective_from, created_by) values ($1, $2, $3) returning id, name, effective_from::text as eff',
    [name, eff, user || ''])).rows[0];
  return { id: r.id, name: r.name, effectiveFrom: r.eff, created: true };
}

async function upsertProducts(db, products, priceList, today, user, futureOnly) {
  let n = 0;
  const list = await tx(db, async (c) => {
    const pl = await resolvePriceList(c, priceList, today, user, futureOnly);
    for (const p of products) {
      await c.query(
        `insert into products (price_list_id, brand, key, name, cost, normal_price, source, updated_at) values ($1, $2, $3, $4, $5, $6, $7, now())
         on conflict (price_list_id, brand, key_norm) do update set key = excluded.key, name = excluded.name,
           cost = coalesce(excluded.cost, products.cost), normal_price = coalesce(excluded.normal_price, products.normal_price),
           source = excluded.source, updated_at = now()`,
        [pl.id, p.brand, p.key, p.name || p.key, p.cost, p.normalPrice, p.source || '']);
      n++;
    }
    return pl;
  });
  return { imported: n, priceList: list.name, effectiveFrom: list.effectiveFrom, newPriceList: list.created };
}

/** The legacy _CalDummy tab becomes shared bundles (component SKUs in B, D, F, H, J; "NON" = empty). */
async function importBundles(db, values, user) {
  let imported = 0;
  let skipped = 0;
  await tx(db, async (c) => {
    for (const r of values.slice(1)) {
      const parts = [1, 3, 5, 7, 9].map((i) => cell(r, i)).filter((k) => k && k.toUpperCase() !== 'NON' && !k.startsWith('#'));
      if (parts.length < 2) continue;
      const name = parts.join(' + ');
      const exists = (await c.query(`select 1 from bundles where active and brand = 'EVE' and name_norm = upper($1)`, [name])).rowCount;
      if (exists) { skipped++; continue; }
      const b = (await c.query(`insert into bundles (brand, name, created_by) values ('EVE', $1, $2) returning id`, [name, user || 'import'])).rows[0];
      for (const [i, k] of parts.entries()) await c.query('insert into bundle_items (bundle_id, position, product_key, qty) values ($1, $2, $3, 1)', [b.id, i, k]);
      imported++;
    }
  });
  return { imported, skipped };
}

/**
 * The _Cost&Price tab: EVE master in A:C, GT hot price in E:G (wins over the master), Foster in I:L.
 * One cost per product is used by every price group, so keys whose E:G cost differs from the A:C cost
 * are reported (keys only — the result is shown to admins who may not see cost).
 */
function productsFromCostPriceSheet(values) {
  const eve = new Map();
  const costConflicts = [];
  const put = (key, cost, price, source, override) => {
    key = String(key || '').trim();
    if (!key || key.startsWith('#')) return;
    const id = key.toUpperCase();
    const cur = eve.get(id);
    cost = toNum(cost); price = toNum(price);
    if (!cur) eve.set(id, { brand: 'EVE', key, name: key, cost, normalPrice: price, source });
    else if (override) {
      if (cost !== null && cur.cost !== null && Math.abs(cost - cur.cost) >= 0.005) costConflicts.push(key);
      if (cost !== null) cur.cost = cost;
      if (price !== null) cur.normalPrice = price;
      cur.source = source;
    } else {
      if (cur.cost === null) cur.cost = cost;
      if (cur.normalPrice === null) cur.normalPrice = price;
    }
  };
  const data = values.slice(1);
  data.forEach((r) => put(r[0], r[1], r[2], 'EVE master', false));
  data.forEach((r) => put(r[4], r[5], r[6], 'GT hot price', true));
  const foster = new Map();
  data.forEach((r) => {
    const code = cell(r, 8);
    if (!code || code.startsWith('#') || foster.has(code.toUpperCase())) return;
    foster.set(code.toUpperCase(), { brand: 'FOSTER', key: code, name: cell(r, 9) || code, cost: toNum(r[10]), normalPrice: toNum(r[11]), source: 'Foster master' });
  });
  return { products: [...eve.values(), ...foster.values()], costConflicts };
}

function productsFlat(values, defaultBrand) {
  const { row, map } = headerMap(values, {
    key: ['key', 'model', 'sku', 'code', "eve's model", 'ref. code', 'ชื่อสินค้า'],
    brand: ['brand'], name: ['name', 'description', 'model description'],
    cost: ['cost', 'cost/unit', 'smgcost'], normalPrice: ['normal_price', 'normal price', 'price', 'retail price', 'ขายปกติ']
  });
  return values.slice(row + 1).map((r) => ({
    brand: (cell(r, map.brand) || defaultBrand || '').toUpperCase(),
    key: cell(r, map.key), name: cell(r, map.name), cost: toNum(r[map.cost]), normalPrice: toNum(r[map.normalPrice]), source: 'Upload'
  })).filter((p) => p.key && !p.key.startsWith('#'));
}

async function importProjectCosts(db, values, groupId) {
  const { row, map } = headerMap(values, {
    key: ['project_key', 'proj. id', 'project', 'project id', '#proj. tag'],
    customer: ['customer', 'ชื่อลูกค้า', "owner's name"], description: ['description', '#tag', 'หมายเหตุ'],
    cost: ['cost', 'ต้นทุนขาย (-vat)', 'รวมต้นทุนขาย (thb, -vat)', 'รวมต้นทุนขาย'], normalPrice: ['normal_price', 'ราคาขายปกติ']
  });
  let imported = 0;
  await tx(db, async (c) => {
    for (const r of values.slice(row + 1)) {
      const key = cell(r, map.key);
      if (!key) continue;
      await c.query(
        `insert into project_costs (group_id, project_key, customer, description, cost, normal_price, source, updated_at)
         values ($1, $2, $3, $4, $5, $6, 'Upload', now())
         on conflict (group_id, key_norm) do update set project_key = excluded.project_key, customer = excluded.customer,
           description = excluded.description, cost = excluded.cost, normal_price = excluded.normal_price, updated_at = now()`,
        [groupId, key, cell(r, map.customer), cell(r, map.description), toNum(r[map.cost]), toNum(r[map.normalPrice])]);
      imported++;
    }
  });
  return { imported };
}

async function importLandedItems(db, values, groupId) {
  const { row, map } = headerMap(values, {
    key: ['item_code', 'ref. itmcode'], description: ['description', 'itmdescrption', 'itmdescription'],
    factoryRmb: ['factory_rmb', 'factoryrmb'], exchRate: ['exch_rate', 'exch. rate'], bpDisc: ['bp_disc', 'bp disc.'],
    incoterm: ['incoterm'], misc: ['misc_charge', 'misc. charge']
  });
  let imported = 0;
  const errors = [];
  await tx(db, async (c) => {
    for (const [i, r] of values.slice(row + 1).entries()) {
      const key = cell(r, map.key);
      if (!key) continue;
      const rmb = toNum(r[map.factoryRmb]);
      const rate = toNum(r[map.exchRate]);
      if (!(rmb > 0) || !(rate > 0)) { errors.push(`แถว ${row + i + 2} (${key}): ไม่มี FactoryRMB หรือ ExCh. Rate`); continue; }
      const inc = cell(r, map.incoterm).toUpperCase();
      await c.query(
        `insert into landed_items (group_id, item_code, description, factory_rmb, exch_rate, bp_disc, incoterm, misc_charge, source, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'Upload', now())
         on conflict (group_id, key_norm) do update set item_code = excluded.item_code, description = excluded.description,
           factory_rmb = excluded.factory_rmb, exch_rate = excluded.exch_rate, bp_disc = excluded.bp_disc,
           incoterm = excluded.incoterm, misc_charge = excluded.misc_charge, updated_at = now()`,
        [groupId, key, cell(r, map.description), rmb, rate, toFraction(r[map.bpDisc]) || 0,
          inc === 'EXW' || inc === 'FOB' ? inc : null, toNum(r[map.misc]) || 0]);
      imported++;
    }
  });
  return { imported, errors };
}

// ---------------------------------------------------------------- legacy requests

/** Column layout of each old RFQ tab (0-based). */
const LEGACY = {
  'GT.EVE_RFQ': { channel: 'GT_EVE', key: 6, customer: 3, project: 4, note: 5, normal: 7, special: 8, disc: [9, 10, 11], status: 14, decidedAt: 15, decidedBy: 16, requester: 17, requestDate: 18 },
  'GT.FOSTER_RFQ': { channel: 'GT_FOSTER', key: 5, customer: 3, project: 4, normal: 7, special: 8, disc: [9, 10, 11], status: 14, decidedAt: 15, decidedBy: 16, requester: 17, requestDate: 18 },
  'BT.EVE_RFQ': { channel: 'BT_EVE', key: 6, branch: 4, project: 3, note: 5, normal: 7, special: 8, status: 11, decidedAt: 12, decidedBy: 13, requester: 14 },
  'BT.FOSTER_RFQ': { channel: 'BT_FOSTER', key: 5, branch: 4, project: 3, note: 15, normal: 7, special: 8, status: 11, decidedAt: 12, decidedBy: 13, requester: 14 },
  'OFFI_RFQ': { channel: offiChannel, key: 6, customer: 4, project: 3, note: 5, normal: 7, special: 8, disc: [9], status: 13, decidedAt: 14, decidedBy: 15, requester: 16 }
};

/** OFFI branch text → channel. Unknown text falls back to showroom and is flagged. */
function offiChannel(row) {
  const t = cell(row, 4).toLowerCase();
  const rules = [['shopee', 'OFFI_SHOPEE'], ['lazada', 'OFFI_LAZADA'], ['tiktok', 'OFFI_TIKTOK'], ['homepro', 'OFFI_HOMEPRO'],
    ['line', 'OFFI_LINE'], ['outlet', 'OFFI_OUTLET'], ['first service', 'OFFI_OUTLET'], ['showroom', 'OFFI_SHOWROOM'],
    ['web', 'OFFI_WEB'], ['makro', 'OFFI_WEB'], ['amaze', 'OFFI_WEB'], ['บุญถาวร', 'OFFI_WEB']];
  const hit = rules.find(([k]) => t.includes(k));
  return { id: hit ? hit[1] : 'OFFI_SHOWROOM', guessed: !hit };
}

async function importLegacy(db, type, values, today) {
  const layout = LEGACY[type];
  const settings = await getSettings(db);
  const catalog = await getCatalog(db, true);
  const findChannel = (id) => {
    for (const g of catalog) { const ch = g.channels.find((c) => c.id === id); if (ch) return { group: g, channel: ch }; }
    throw new UserError('ไม่พบช่องทาง ' + id);
  };
  const res = { type, imported: 0, skipped: 0, errors: [] };
  const rows = [];
  for (const [i, v] of values.slice(1).entries()) {
    const id = cell(v, 0);
    if (!id || !cell(v, layout.key)) continue;
    try {
      rows.push(await legacyRow(db, v, layout, findChannel, settings, today));
    } catch (e) {
      res.errors.push(`แถว ${i + 2} (${id}): ${e.message}`);
    }
  }
  await tx(db, async (c) => {
    for (const r of rows) {
      const cols = Object.keys(r);
      const out = await c.query(
        `insert into requests (${cols.join(', ')}) values (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) on conflict (id) do nothing`,
        cols.map((k) => r[k]));
      if (out.rowCount) res.imported++; else res.skipped++;
    }
    await syncCounters(c);
  });
  return res;
}

async function legacyRow(db, v, L, findChannel, settings, today) {
  const ch = typeof L.channel === 'function' ? L.channel(v) : { id: L.channel };
  const { group, channel } = findChannel(ch.id);
  const flags = ['นำเข้าจากชีตเดิม: ต้นทุน/%MU คิดจากต้นทุน ณ วันนำเข้า'];
  if (ch.guessed) flags.push(`ช่องทางเดิม "${cell(v, 4)}" ไม่ชัดเจน — จัดเป็น ${channel.name}`);

  const item = await lookupItem(db, group, channel, cell(v, L.key), today);
  const productKey = cell(v, L.key);
  const productName = item ? item.name : (channel.brand === 'FOSTER' ? cell(v, 6) || productKey : productKey);

  let discounts;
  if (L.disc) {
    discounts = channel.discounts.map((d, i) => {
      let n = L.disc[i] === undefined ? null : toNum(v[L.disc[i]]);
      if (n === null) return 0;
      if (n >= 1) { flags.push(`ส่วนลดเดิม ${round2(n * 100)}% ถูกแปลงเป็น ${round2(n)}%`); n = n / 100; }
      return n;
    });
  } else {
    discounts = channel.discounts.map((d) => d.default || 0);
  }

  let normal = toNum(v[L.normal]);
  if (normal === null && item) normal = item.normalPrice;
  const special = toNum(v[L.special]);
  const calc = special > 0
    ? calculate({ formula: channel.formula, normalPrice: normal, specialPrice: special, discounts, cost: item ? item.cost : null, vatRate: settings.VAT_RATE, rules: group.indicatorRules })
    : { cost: null, netIncVat: null, netExVat: null, gain: null, mu: null, indicator: 'NO COST' };
  if (!item) flags.push('ไม่พบในฐานข้อมูลต้นทุน');
  if (normal > 0 && special > normal) flags.push('ราคาพิเศษสูงกว่าราคาปกติ');

  const requested = (L.requestDate !== undefined && parseSheetDate(v[L.requestDate])) || parseSheetDate(v[1]) || parseSheetDate(v[L.decidedAt]);
  const start = parseSheetDate(v[1]) || requested;
  let end = parseSheetDate(v[2]);
  if (start && (!end || end < start)) end = addDays(start, settings.DEFAULT_VALIDITY_DAYS);

  const raw = cell(v, L.status).toLowerCase();
  let status;
  if (raw.startsWith('approve')) status = 'Approved';
  else if (raw.startsWith('cancel')) status = 'Cancelled';
  else if (raw.startsWith('reject')) status = 'Rejected';
  else status = end && end < today ? 'Closed' : 'Pending';
  const decided = status === 'Approved' || status === 'Cancelled' || status === 'Rejected';

  const customer = L.branch !== undefined ? ('บุญถาวร ' + cell(v, L.branch)).trim() : cell(v, L.customer);
  return {
    id: cell(v, 0), batch_id: null, group_id: group.id, channel_id: channel.id, cost_source: group.costSource, brand: channel.brand,
    customer, project: cell(v, L.project), note: L.note !== undefined ? cell(v, L.note) : '',
    product_key: productKey, product_name: productName, qty: null,
    normal_price: normal, special_price: special, discounts: JSON.stringify(discounts), discount_labels: JSON.stringify(channel.discounts.map((d) => d.label)),
    cost: calc.cost, net_inc_vat: calc.netIncVat, net_ex_vat: calc.netExVat, gain: calc.gain, mu: calc.mu, indicator: calc.indicator,
    status, start_date: start, end_date: end,
    requester: cell(v, L.requester).toLowerCase(),
    requested_at: requested ? requested + 'T09:00:00+07:00' : null,
    decided_by: decided ? cell(v, L.decidedBy).toLowerCase() || null : null,
    decided_at: decided && parseSheetDate(v[L.decidedAt]) ? parseSheetDate(v[L.decidedAt]) + 'T12:00:00+07:00' : null,
    decision_comment: status === 'Closed' ? 'หมดอายุโดยไม่มีการพิจารณา (ข้อมูลเดิม)' : '',
    flags, source: 'LEGACY:' + Object.keys(LEGACY).find((k) => LEGACY[k] === L),
    price_list_id: item && item.priceList ? item.priceList.id : null,
    bundle_id: item && item.bundleId ? item.bundleId : null
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

/** Keeps id_counters ahead of every numeric id already in requests. */
async function syncCounters(c) {
  const prefixes = (await c.query('select prefix from id_counters')).rows.map((r) => r.prefix);
  for (const p of prefixes) {
    const re = '^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([0-9]+)$';
    await c.query(
      `update id_counters set last_value = greatest(last_value, coalesce((select max((regexp_match(id, $2))[1]::int) from requests where id ~ $2), 0))
       where prefix = $1`, [p, re]);
  }
}

// ---------------------------------------------------------------- SMG catalogue (n8n sync of three Google Sheets)

/**
 * Expected header text per sheet at fixed columns (0-based). A moved or renamed column stops the import
 * instead of loading wrong numbers.
 */
const SMG_SHEETS = {
  cost: { label: "COST UPDATE 2021 for import '2021'!A3:AQ", cols: { ean: [0, 'EAN13'], model: [2, "EVE's Model"], cost: [15, 'ราคาต้นทุนนำเข้า/หน่วย'], st: [42, 'ST'] } },
  pricelist: { label: "SMG PRICELIST NATIONWIDE 'Pricelist update'!A2:I", cols: {
    status: [0, 'STATUS'], ean: [1, 'EAN13'], brand: [2, 'BRAND'], category: [3, 'CATEGORY'], name: [4, 'DESCRIPTION/MODEL'],
    normal: [5, 'NORMAL'], promotion: [6, 'PROMOTION'], priceCat: [8, 'PRICE CAT.'] } },
  master: { label: "SMG MASTER 'MASTER'!A1:R", cols: {
    item: [0, 'Item No.'], brand: [1, 'ยี่ห้อ'], name: [2, 'Item Description'], group: [4, 'Group Name'], oldSpecial: [6, 'ราคาขายพิเศษเดิม'],
    GT: [7, 'GT HOTPRICE'], DGT: [8, 'DGT HOTPRICE'], BT: [17, 'BT HOTPRICE'] } },
  hot: { label: "SMG MASTER 'HOTPRICE'!A1:G", cols: {
    saleCh: [0, 'SALE CH.'], ean: [1, 'EAN13'], name: [3, 'MODEL NAME'], BT: [4, 'BT HOTPRICE'], DGT: [5, 'DGT HOTPRICE'], GT: [6, 'GT HOTPRICE'] } }
};
const SMG_MAKES = ['EVE', 'EVERCOOK', 'EXCEL'];
const colName = (i) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26));
const normHead = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();

function smgRows(sheets, name) {
  const spec = SMG_SHEETS[name];
  const values = sheets && sheets[name];
  if (!Array.isArray(values) || values.length < 2) throw new UserError(`ไม่มีข้อมูลจาก ${spec.label}`);
  const head = values[0] || [];
  const wrong = Object.values(spec.cols).filter(([i, h]) => normHead(head[i]) !== normHead(h))
    .map(([i, h]) => `คอลัมน์ ${colName(i)} ต้องเป็น "${h}" แต่พบ "${cell(head, i)}"`);
  if (wrong.length) throw new UserError(`หัวตารางของ ${spec.label} ไม่ตรงกับที่ระบบรู้จัก — ${wrong.join('; ')}`);
  return values.slice(1).map((r) => {
    const o = {};
    for (const [k, [i]] of Object.entries(spec.cols)) o[k] = cell(r, i);
    return o;
  });
}

const isEan = (s) => /^\d{8,14}$/.test(s);
const price = (v) => { const n = toNum(v); return n > 0 ? n : null; };

/**
 * Builds the EVE / Evercook / Excel catalogue of one price list from the four sheet ranges and replaces
 * that list's SMG products in one transaction. Cost = cost file column P where ST (AQ) is not "N".
 * Selling price per tier = resolveTierPrice (MASTER H / I / R logic); the result is checked against
 * MASTER's own H / I / R and differences are reported (barcodes only, never cost).
 */
async function importSmgCatalog(db, sheets, priceList, today, user, futureOnly) {
  const costRows = smgRows(sheets, 'cost');
  const plRows = smgRows(sheets, 'pricelist');
  const masterRows = smgRows(sheets, 'master');
  const hotRows = smgRows(sheets, 'hot');
  const report = { costRows: 0, notForSale: 0, blankSaleStatus: 0, duplicateBarcodes: [], badBarcodes: 0 };

  const first = (rows, keep) => {
    const m = new Map();
    for (const r of rows) {
      if (!isEan(r.ean)) { if (r.ean) report.badBarcodes++; continue; }
      if (keep && !keep(r)) continue;
      if (m.has(r.ean)) { if (report.duplicateBarcodes.length < 50) report.duplicateBarcodes.push(r.ean); continue; }
      m.set(r.ean, r);
    }
    return m;
  };
  const models = new Map();   // model names from every cost row (ST only decides whether the cost is used)
  costRows.forEach((r) => { if (isEan(r.ean) && r.model && !models.has(r.ean)) models.set(r.ean, r.model); });
  const cost = first(costRows, (r) => {
    report.costRows++;
    const st = r.st.toUpperCase();
    if (st === 'N') { report.notForSale++; return false; }
    if (!st) report.blankSaleStatus++;
    return true;
  });
  const smgMake = (r) => !r.brand || SMG_MAKES.includes(r.brand.toUpperCase());   // Foster rows come later, in their own import
  const pl = first(plRows.filter(smgMake));
  const hot = first(hotRows);
  const master = first(masterRows.filter((r) => r.brand && smgMake(r)).map((r) => Object.assign(r, { ean: r.item })));

  const eans = new Set([...master.keys(), ...pl.keys(), ...hot.keys(), ...cost.keys()]);
  const products = [];
  const mismatches = [];
  const usedKeys = new Map();
  let skipped = 0;
  for (const ean of eans) {
    const c = cost.get(ean); const n = pl.get(ean); const h = hot.get(ean); const m = master.get(ean);
    const tiers = {};
    for (const t of PRICE_TIERS) {
      tiers[t] = resolveTierPrice({ inHot: !!h, hot: h && price(h[t]), inNationwide: !!n, promotion: n && price(n.promotion), oldSpecial: m && price(m.oldSpecial) });
    }
    const unitCost = c ? price(c.cost) : null;
    const base = n ? price(n.promotion) : (m ? price(m.oldSpecial) : null);
    if (!unitCost && !base && PRICE_TIERS.every((t) => !tiers[t])) { skipped++; continue; }
    if (m && PRICE_TIERS.some((t) => (price(m[t]) || null) !== tiers[t]) && mismatches.length < 100) mismatches.push(ean);
    let key = models.get(ean) || (m && m.name) || (n && n.name) || (h && h.name) || ean;
    key = key.slice(0, 190);
    if (usedKeys.has(key.toUpperCase())) key = `${key} [${ean}]`;
    usedKeys.set(key.toUpperCase(), ean);
    products.push({
      key, name: (n && n.name) || (m && m.name) || (h && h.name) || key, barcode: ean,
      make: ((n && n.brand) || (m && m.brand) || 'EVE').toUpperCase(), category: (m && m.group) || (n && n.category) || '',
      status: n ? n.status.toUpperCase() : '', saleChannel: h ? h.saleCh : '', priceCat: n ? n.priceCat.toUpperCase() : '',
      listPrice: n ? price(n.normal) : null, cost: unitCost, normalPrice: base, tiers
    });
  }

  const list = await tx(db, async (c) => {
    const pl2 = await resolvePriceList(c, priceList, today, user, futureOnly);
    await c.query(`delete from products where price_list_id = $1 and brand = 'EVE' and source = 'SMG'`, [pl2.id]);
    for (const p of products) {
      await c.query(
        `insert into products (price_list_id, brand, key, name, cost, normal_price, source, barcode, make, category, status, sale_channel,
           price_cat, list_price, price_gt, price_dgt, price_bt, tiered, updated_at)
         values ($1, 'EVE', $2, $3, $4, $5, 'SMG', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, true, now())
         on conflict (price_list_id, brand, key_norm) do update set name = excluded.name, cost = excluded.cost, normal_price = excluded.normal_price,
           source = 'SMG', barcode = excluded.barcode, make = excluded.make, category = excluded.category, status = excluded.status,
           sale_channel = excluded.sale_channel, price_cat = excluded.price_cat, list_price = excluded.list_price, price_gt = excluded.price_gt,
           price_dgt = excluded.price_dgt, price_bt = excluded.price_bt, tiered = true, updated_at = now()`,
        [pl2.id, p.key, p.name, p.cost, p.normalPrice, p.barcode, p.make, p.category, p.status, p.saleChannel, p.priceCat, p.listPrice,
          p.tiers.GT, p.tiers.DGT, p.tiers.BT]);
    }
    return pl2;
  });
  const statuses = {};
  products.forEach((p) => { statuses[p.status || '-'] = (statuses[p.status || '-'] || 0) + 1; });
  return {
    imported: products.length, priceList: list.name, effectiveFrom: list.effectiveFrom, newPriceList: list.created,
    withCost: products.filter((p) => p.cost).length, withoutCost: products.filter((p) => !p.cost).length, skippedNoPrice: skipped,
    statuses, masterMismatchCount: mismatches.length, masterMismatches: mismatches.slice(0, 50), ...report
  };
}

// ---------------------------------------------------------------- customer price mapping (n8n, Google Sheet template)

/** Tabs of the "Customer Price Mapping Template" sheet and the header expected at each column used. */
const MAPPING_SHEETS = {
  terms: { label: "'Term Library'!A1:K", cols: {
    code: [0, 'รหัสเงื่อนไข (Term code)'], name: [1, 'ชื่อเงื่อนไข'], nameEn: [2, 'Name (EN)'], category: [3, 'หมวด'], method: [4, 'วิธีคำนวณ'],
    basis: [5, 'ฐานที่ใช้คิด'], borneBy: [6, 'ผู้รับภาระ'], onInvoice: [7, 'หักในใบกำกับภาษี?'], inMuNet: [8, 'นับรวมในราคาสุทธิเพื่อคิด %MU?'],
    reference: [9, 'ค่าอ้างอิงที่พบ'], source: [10, 'ที่มา'] } },
  groups: { label: "'Customer Groups'!A1:H", cols: {
    code: [0, 'รหัสกลุ่ม'], name: [1, 'ชื่อกลุ่มลูกค้า'], tier: [2, 'ราคาฐาน (Price tier)'], credit: [3, 'เครดิตเทอม (วัน)'], approver: [6, 'ผู้อนุมัติ'], note: [7, 'หมายเหตุ'] } },
  groupTerms: { label: "'Group Terms'!A1:K", cols: {
    owner: [0, 'รหัสกลุ่ม หรือรหัสลูกค้า'], seq: [1, 'ลำดับการหัก'], term: [2, 'รหัสเงื่อนไข'], pct: [5, 'ค่า (%)'], thb: [6, 'ค่า (บาท)'],
    scope: [7, 'ใช้กับสินค้า (ALL หรือบาร์โค้ด)'], from: [8, 'มีผลตั้งแต่'], to: [9, 'สิ้นสุด'], note: [10, 'หมายเหตุ / ที่มา'] } },
  channels: { label: "'Channel Map'!A1:B", cols: { channel: [0, 'ช่องทาง SAP'], group: [1, 'กลุ่มลูกค้าเริ่มต้น'] } },
  customerMap: { label: "'Customer Map'!A1:D", cols: { code: [0, 'รหัสลูกค้า (SAP)'], group: [3, 'กลุ่มลูกค้า (แทนกลุ่มของช่องทาง)'] } },
  customers: { label: "'Active Customers'!A6:H", cols: {
    code: [0, 'รหัสลูกค้า'], name: [1, 'ชื่อลูกค้า'], channel: [2, 'ช่องทาง SAP'], employee: [3, 'พนักงานขาย'], last: [7, 'ซื้อล่าสุด'] } }
};
const PRICE_TIER_CODES = ['GT', 'DGT', 'BT', 'NTW', 'FOSTER', 'JS'];

function mappingRows(sheets, name) {
  const spec = MAPPING_SHEETS[name];
  const values = sheets && sheets[name];
  if (!Array.isArray(values) || !values.length) throw new UserError(`ไม่มีข้อมูลจาก ${spec.label}`);
  const head = values[0] || [];
  const wrong = Object.values(spec.cols).filter(([i, h]) => normHead(head[i]) !== normHead(h))
    .map(([i, h]) => `คอลัมน์ ${colName(i)} ต้องเป็น "${h}" แต่พบ "${cell(head, i)}"`);
  if (wrong.length) throw new UserError(`หัวตารางของ ${spec.label} ไม่ตรงกับแม่แบบ — ${wrong.join('; ')}`);
  return values.slice(1).map((r) => {
    const o = {};
    for (const [k, [i]] of Object.entries(spec.cols)) o[k] = cell(r, i);
    return o;
  });
}

/**
 * Replaces the whole customer price mapping (terms, groups, group terms, channel map, customers) in one
 * transaction. Rows that cannot be used are skipped and listed in `errors`; nothing here holds cost.
 */
async function importCustomerPricing(db, sheets) {
  const errors = [];
  const upper = (v) => String(v || '').trim().toUpperCase();
  const terms = new Map();
  mappingRows(sheets, 'terms').forEach((r, i) => {
    const code = upper(r.code);
    if (!code) return;
    const method = upper(r.method);
    if (!TERM_METHODS.includes(method)) { errors.push(`Term Library แถว ${i + 2}: ${code} วิธีคำนวณ "${r.method}" ไม่ถูกต้อง`); return; }
    if (!terms.has(code)) terms.set(code, Object.assign({}, r, { code, method }));
  });
  const groups = new Map();
  mappingRows(sheets, 'groups').forEach((r, i) => {
    const code = upper(r.code);
    if (!code) return;
    const tier = upper(r.tier);
    if (tier && !PRICE_TIER_CODES.includes(tier)) { errors.push(`Customer Groups แถว ${i + 2}: ${code} ราคาฐาน "${r.tier}" ไม่ถูกต้อง`); return; }
    const credit = toNum(r.credit);
    if (!groups.has(code)) groups.set(code, Object.assign({}, r, { code, tier, credit: credit === null ? null : Math.round(credit) }));
  });
  const groupTerms = [];
  mappingRows(sheets, 'groupTerms').forEach((r, i) => {
    const owner = upper(r.owner);
    if (!owner) return;
    const at = `Group Terms แถว ${i + 2}`;
    const term = terms.get(upper(r.term));
    if (!term) { errors.push(`${at}: ไม่พบรหัสเงื่อนไข "${r.term}" ใน Term Library`); return; }
    const pct = toNum(r.pct);
    const thb = toNum(r.thb);
    if (term.method.startsWith('PCT') && (pct === null || pct < -1 || pct > 1)) { errors.push(`${at}: ${term.code} ต้องมีค่า (%) ระหว่าง -100% ถึง 100%`); return; }
    if (term.method.startsWith('THB') && thb === null) { errors.push(`${at}: ${term.code} ต้องมีค่า (บาท)`); return; }
    const from = r.from ? parseSheetDate(r.from) : null;
    const to = r.to ? parseSheetDate(r.to) : null;
    if ((r.from && !from) || (r.to && !to)) { errors.push(`${at}: วันที่ไม่ถูกต้อง`); return; }
    groupTerms.push({ owner, seq: Math.round(toNum(r.seq) || 0), term: term.code, pct, thb, scope: (r.scope || 'ALL').trim().slice(0, 200), from, to, note: r.note });
  });
  const channels = new Map();
  mappingRows(sheets, 'channels').forEach((r) => { if (r.channel) channels.set(r.channel, upper(r.group)); });
  const overrides = new Map();
  mappingRows(sheets, 'customerMap').forEach((r) => { if (r.code) overrides.set(r.code, upper(r.group)); });
  const customers = new Map();
  mappingRows(sheets, 'customers').forEach((r) => { if (r.code && !customers.has(r.code)) customers.set(r.code, r); });
  // Customers only in Customer Map (no sales in the window) can still be priced.
  for (const code of overrides.keys()) if (!customers.has(code)) customers.set(code, { code, name: '', channel: '', employee: '', last: '' });

  const usedGroups = [...channels.values(), ...overrides.values()].filter((g) => g && !groups.has(g));
  if (usedGroups.length) errors.push(`กลุ่มที่ใช้แต่ไม่มีใน Customer Groups: ${[...new Set(usedGroups)].join(', ')}`);

  await tx(db, async (c) => {
    await c.query('delete from group_terms');
    await c.query('delete from price_terms');
    await c.query('delete from customer_groups');
    await c.query('delete from sap_channel_groups');
    await c.query('delete from customers');
    for (const t of terms.values()) {
      await c.query(`insert into price_terms (code, name, name_en, category, method, basis, borne_by, on_invoice, in_mu_net, reference, source)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [t.code, t.name, t.nameEn, t.category, t.method, t.basis, t.borneBy, t.onInvoice, t.inMuNet, t.reference, t.source]);
    }
    for (const g of groups.values()) {
      await c.query('insert into customer_groups (code, name, price_tier, credit_days, approver, note) values ($1, $2, $3, $4, $5, $6)',
        [g.code, g.name, g.tier, g.credit, g.approver, g.note]);
    }
    for (const t of groupTerms) {
      await c.query(`insert into group_terms (owner_code, seq, term_code, pct, thb, scope, valid_from, valid_to, note)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [t.owner, t.seq, t.term, t.pct, t.thb, t.scope, t.from, t.to, t.note]);
    }
    for (const [ch, g] of channels) await c.query('insert into sap_channel_groups (sap_channel, group_code) values ($1, $2)', [ch, g]);
    for (const r of customers.values()) {
      await c.query(`insert into customers (code, name, sap_channel, sales_employee, last_month, override_group) values ($1, $2, $3, $4, $5, $6)`,
        [r.code, r.name, r.channel, r.employee, r.last, overrides.get(r.code) || '']);
    }
  });
  return {
    imported: customers.size, terms: terms.size, groups: groups.size, groupTerms: groupTerms.length, channels: channels.size,
    overrides: overrides.size, errors: errors.slice(0, 100), errorCount: errors.length
  };
}

// ---------------------------------------------------------------- entry point

/** @param {{newListFutureOnly?: boolean}} opts newListFutureOnly: set for n8n (see resolvePriceList) */
async function importData(db, { type, values, sheets, brand, group, today, priceList, user, newListFutureOnly }) {
  if (type === 'smg_catalog') return { type, ...(await importSmgCatalog(db, sheets, priceList, today, user, newListFutureOnly)) };
  if (type === 'customer_pricing') return { type, ...(await importCustomerPricing(db, sheets)) };
  if (!Array.isArray(values) || values.length < 2) throw new UserError('ไฟล์ว่างหรือไม่มีข้อมูล');
  if (values.length > 60000) throw new UserError('ข้อมูลมากเกินไป (สูงสุด 60,000 แถว)');
  switch (type) {
    case 'products': return { type, ...(await upsertProducts(db, productsFlat(values, brand), priceList, today, user, newListFutureOnly)) };
    case 'cost_price_sheet': {
      const sheet = productsFromCostPriceSheet(values);
      const res = await upsertProducts(db, sheet.products, priceList, today, user, newListFutureOnly);
      return { type, ...res, costConflicts: sheet.costConflicts.slice(0, 100), costConflictCount: sheet.costConflicts.length };
    }
    case 'cal_dummy_sheet': return { type, ...(await importBundles(db, values, user)) };
    case 'project_costs': return { type, ...(await importProjectCosts(db, values, group || 'JS')) };
    case 'landed_items': return { type, ...(await importLandedItems(db, values, group || 'JS_OVS')) };
    default:
      if (LEGACY[type]) return importLegacy(db, type, values, today);
      throw new UserError('ประเภทข้อมูลไม่ถูกต้อง: ' + type);
  }
}

module.exports = { importData, parseCsv, parseSheetDate, toNum, LEGACY_TYPES: Object.keys(LEGACY) };
