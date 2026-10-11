'use strict';
/** Read access to settings, price groups/channels and the cost masters. */
const { landedCost, UserError } = require('../pricing');

async function getSettings(db) {
  const { rows } = await db.query('select key, value from settings');
  const s = {};
  rows.forEach((r) => { s[r.key] = r.value; });
  ['VAT_RATE', 'DEFAULT_VALIDITY_DAYS', 'MAX_VALIDITY_DAYS'].forEach((k) => { s[k] = Number(s[k]); });
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
      discounts: c.discounts, keyLabel: c.key_label, description: c.description, active: c.active
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

function landedFromRow(r, params) {
  return landedCost({ factoryRmb: r.factory_rmb, exchRate: r.exch_rate, bpDisc: r.bp_disc, incoterm: r.incoterm, miscCharge: r.misc_charge }, params);
}

/** Cost master look-up for one key → {key, name, cost, normalPrice} or null. */
async function lookupItem(db, group, channel, key) {
  key = String(key || '').trim().slice(0, 200);
  if (!key) return null;
  if (group.costSource === 'PRODUCT') {
    const r = (await db.query('select key, name, cost, normal_price from products where brand = $1 and key_norm = upper(btrim($2))', [channel.brand, key])).rows[0];
    return r ? { key: r.key, name: r.name || r.key, cost: r.cost, normalPrice: r.normal_price } : null;
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

module.exports = { getSettings, getCatalog, getChannel, lookupItem, landedFromRow };
