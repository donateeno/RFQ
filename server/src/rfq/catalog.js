'use strict';
/** Read access to settings, price groups/channels, price lists, bundles and the cost masters. */
const { landedCost, UserError } = require('../pricing');

const PRODUCT_COLS = `key, name, cost, normal_price, barcode, make, category, status, sale_channel, price_cat, list_price,
  price_gt, price_dgt, price_bt, tiered, gp_rates, wholesale, master_row`;

async function getSettings(db) {
  const { rows } = await db.query('select key, value from settings');
  const s = {};
  rows.forEach((r) => { s[r.key] = r.value; });
  ['VAT_RATE', 'DEFAULT_VALIDITY_DAYS', 'MAX_VALIDITY_DAYS', 'PRICE_CHECK_ALERT', 'PRICE_CHECK_LIMIT', 'PRICE_CHECK_PER_HOUR', 'SYNC_STALE_HOURS'].forEach((k) => { s[k] = Number(s[k]); });
  return s;
}

/** Groups with their channels (active only unless includeInactive). */
async function getCatalog(db, includeInactive) {
  const groups = (await db.query(`select * from price_groups ${includeInactive ? '' : 'where active'} order by sort`)).rows;
  const channels = (await db.query(`select * from channels ${includeInactive ? '' : 'where active'} order by sort`)).rows;
  return groups.map((g) => ({
    id: g.id, name: g.name, description: g.description, costSource: g.cost_source,
    indicatorRules: g.indicator_rules, params: g.params, active: g.active,
    channels: channels.filter((c) => c.group_id === g.id).map((c) => ({
      id: c.id, groupId: c.group_id, name: c.name, brand: c.brand, idPrefix: c.id_prefix, formula: c.formula,
      discounts: c.discounts, keyLabel: c.key_label, description: c.description, priceTier: c.price_tier || null, active: c.active
    }))
  }));
}

async function getChannel(db, channelId, includeInactive) {
  const catalog = await getCatalog(db, includeInactive);
  for (const g of catalog) {
    const ch = g.channels.find((c) => c.id === channelId);
    if (ch) return { group: g, channel: ch };
  }
  throw new UserError('ไม่พบช่องทาง (channel) ' + channelId);
}

/**
 * Price list periods per brand on a given date. A brand uses the newest list that has products of
 * that brand and is already effective, so EVE and FOSTER can be re-priced on different dates.
 * @return {Object<string, {current, previous, upcoming}>} each a {id, name, effectiveFrom} or null
 */
async function priceContext(db, date) {
  const rows = (await db.query(
    `select l.id, l.name, l.effective_from::text as effective_from, b.brand
     from price_lists l join (select distinct price_list_id, brand from products) b on b.price_list_id = l.id
     order by b.brand, l.effective_from, l.id`)).rows;
  const out = {};
  rows.forEach((r) => { (out[r.brand] = out[r.brand] || { all: [] }).all.push({ id: r.id, name: r.name, effectiveFrom: r.effective_from }); });
  Object.values(out).forEach((b) => {
    const past = b.all.filter((l) => l.effectiveFrom <= date);
    b.current = past[past.length - 1] || null;
    b.previous = past[past.length - 2] || null;
    b.upcoming = b.all.find((l) => l.effectiveFrom > date) || null;
    delete b.all;
  });
  return out;
}

function landedFromRow(r, params) {
  return landedCost({ factoryRmb: r.factory_rmb, exchRate: r.exch_rate, bpDisc: r.bp_disc, incoterm: r.incoterm, miscCharge: r.misc_charge }, params);
}

/** Product of a price list by key (model) or barcode. */
async function productIn(db, listId, brand, key) {
  return (await db.query(
    `select ${PRODUCT_COLS} from products where price_list_id = $1 and brand = $2 and (key_norm = upper(btrim($3)) or barcode = btrim($3))
     order by (key_norm = upper(btrim($3))) desc limit 1`, [listId, brand, key])).rows[0] || null;
}

/**
 * Selling price of a product row in a channel: SMG-synced (tiered) products use the channel's tier price
 * (null = not sold in that channel this period); other products use normal_price.
 */
function channelPrice(p, channel) {
  if (!p) return null;
  if (!p.tiered) return p.normal_price;
  const tier = channel && channel.priceTier;
  return tier ? p['price_' + tier.toLowerCase()] : p.normal_price;
}

/** Bundle priced from one price list: cost/normal are sums × qty, null when any component is missing. */
async function priceBundle(db, bundleId, listId, brand, channel) {
  const items = (await db.query('select product_key, qty from bundle_items where bundle_id = $1 order by position', [bundleId])).rows;
  let cost = 0;
  let normal = 0;
  const missing = [];
  for (const it of items) {
    const p = listId ? await productIn(db, listId, brand, it.product_key) : null;
    if (!p) { missing.push(it.product_key); continue; }
    const price = channelPrice(p, channel);
    cost = cost === null || !(p.cost > 0) ? null : cost + p.cost * it.qty;
    normal = normal === null || price === null ? null : normal + price * it.qty;
  }
  if (missing.length) return { cost: null, normalPrice: null, missing, items };
  return { cost, normalPrice: normal, missing, items };
}

/**
 * Cost master look-up for one key → {key, name, cost, normalPrice, priceList?, bundleId?, upcoming?} or null.
 * @param {string} date  pricing date (YYYY-MM-DD); price lists effective on that date are used
 */
async function lookupItem(db, group, channel, key, date) {
  key = String(key || '').trim().slice(0, 200);
  if (!key) return null;
  if (group.costSource === 'PRODUCT') {
    const pc = (await priceContext(db, date))[channel.brand] || {};
    const cur = pc.current;
    if (cur) {
      const p = await productIn(db, cur.id, channel.brand, key);
      if (p) {
        const out = { key: p.key, name: p.name || p.key, cost: p.cost, normalPrice: channelPrice(p, channel), priceList: cur };
        if (p.tiered) {
          Object.assign(out, { tiered: true, barcode: p.barcode, make: p.make, status: p.status, saleChannel: p.sale_channel, priceCat: p.price_cat, listPrice: p.list_price });
        }
        if (pc.previous && !(await productIn(db, pc.previous.id, channel.brand, key))) out.isNew = true;
        if (pc.upcoming) {
          const u = await productIn(db, pc.upcoming.id, channel.brand, key);
          out.upcoming = { name: pc.upcoming.name, effectiveFrom: pc.upcoming.effectiveFrom, normalPrice: u ? channelPrice(u, channel) : null, discontinued: !u };
        }
        return out;
      }
    }
    const b = (await db.query('select * from bundles where active and brand = $1 and name_norm = upper(btrim($2))', [channel.brand, key])).rows[0];
    if (!b) return null;
    const priced = await priceBundle(db, b.id, cur && cur.id, channel.brand, channel);
    return {
      key: b.name, name: b.label ? `${b.label} (${b.name})` : b.name, cost: priced.cost, normalPrice: priced.normalPrice,
      priceList: cur, bundleId: b.id, missing: priced.missing
    };
  }
  if (group.costSource === 'PROJECT') {
    const r = (await db.query('select * from project_costs where group_id = $1 and key_norm = upper(btrim($2))', [group.id, key])).rows[0];
    return r ? { key: r.project_key, name: [r.customer, r.description].filter(Boolean).join(' · ') || r.project_key, cost: r.cost, normalPrice: r.normal_price } : null;
  }
  const r = (await db.query('select * from landed_items where group_id = $1 and key_norm = upper(btrim($2))', [group.id, key])).rows[0];
  if (!r) return null;
  const lc = landedFromRow(r, group.params);
  return { key: r.item_code, name: r.description || r.item_code, cost: lc.cost, normalPrice: lc.suggestedPrice };
}

module.exports = { getSettings, getCatalog, getChannel, lookupItem, landedFromRow, priceContext, productIn, priceBundle, channelPrice, PRODUCT_COLS };
