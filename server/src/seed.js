'use strict';
const fs = require('fs');
const path = require('path');
const { FORMULAS, COST_SOURCES, PRICE_TIERS, GP_RATE_KEYS } = require('./pricing');
const { tx } = require('./db');

const DEFAULT_SETTINGS = [
  ['VAT_RATE', 0.07, 'VAT ที่ใช้แปลงราคาสุทธิเป็นราคาไม่รวม VAT'],
  ['DEFAULT_VALIDITY_DAYS', 30, 'จำนวนวันเริ่มต้นระหว่างวันเริ่มและวันสิ้นสุดราคาพิเศษ'],
  ['MAX_VALIDITY_DAYS', 90, 'ระยะเวลาราคาพิเศษสูงสุดที่ผู้ขอเลือกได้'],
  ['NOTIFY_EMAILS', '', 'อีเมลเพิ่มเติม (คั่นด้วย ,) ที่ได้รับแจ้งเมื่อมีคำขอใหม่ — Supervisor/Admin ได้รับเสมอ'],
  ['PRICE_CHECK_ALERT', 15, 'แจ้งเตือน Admin เมื่อผู้ใช้ตรวจราคาสินค้าเดียวกันครบกี่ราคาสุทธิ (ไม่ซ้ำ ทุกช่องทาง) ใน 24 ชม. — ป้องกันการเดาต้นทุน'],
  ['PRICE_CHECK_LIMIT', 30, 'จำนวนราคาสุทธิ (ไม่ซ้ำ ทุกช่องทาง) สูงสุดที่ผู้ใช้ตรวจสินค้าเดียวกันได้ใน 24 ชม.'],
  ['PRICE_CHECK_PER_HOUR', 300, 'จำนวนครั้งตรวจราคาสูงสุดต่อผู้ใช้ต่อชั่วโมง'],
  ['SYNC_STALE_HOURS', 26, 'แจ้งเตือนเจ้าของระบบเมื่อไม่มีการซิงค์จาก Google Sheets สำเร็จนานเกินกี่ชั่วโมง (n8n ซิงค์ทุกวัน)']
];

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'price-groups.json');

function loadPriceGroups(file) {
  const raw = JSON.parse(fs.readFileSync(file || CONFIG_FILE, 'utf8'));
  validatePriceGroups(raw);
  return raw.groups;
}

/** GP tiers of customer groups (price-groups.json "gpTiers" as a Map code -> tier) and the highest GP rate the import accepts. */
function loadGpConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file || CONFIG_FILE, 'utf8'));
  validatePriceGroups(raw);
  return { tiers: new Map((raw.gpTiers || []).map((t) => [t.code, t])), rateMax: raw.gpRateMax, zeroRateFlag: raw.gpZeroRateFlag || '' };
}
const loadGpTiers = (file) => loadGpConfig(file).tiers;

/** Fails fast (and in CI) on a malformed price-groups.json. */
function validatePriceGroups(raw) {
  const errors = [];
  const groupIds = new Set();
  const channelIds = new Set();
  (raw.groups || []).forEach((g) => {
    if (!g.id || groupIds.has(g.id)) errors.push(`group id missing or duplicate: ${g.id}`);
    groupIds.add(g.id);
    if (!COST_SOURCES.includes(g.costSource)) errors.push(`${g.id}: costSource must be one of ${COST_SOURCES}`);
    let prev = -Infinity;
    (g.indicatorRules || []).forEach((r) => {
      const v = r.below ?? r.upTo;
      if (!r.indicator || typeof v !== 'number') errors.push(`${g.id}: bad indicator rule ${JSON.stringify(r)}`);
      if (v < prev) errors.push(`${g.id}: indicator rules must be ascending`);
      prev = v;
    });
    if (g.costSource === 'LANDED') {
      ['usdCny', 'exwBelowUsd', 'freightRate', 'importTaxExw', 'markupRate', 'mktFeeRate', 'lastMileRate', 'lastMileMin',
        'installRate', 'installMin', 'errorRate', 'suggestMultiplier'].forEach((k) => {
        if (typeof (g.params || {})[k] !== 'number') errors.push(`${g.id}: params.${k} is required`);
      });
    }
    if (!(g.channels || []).length) errors.push(`${g.id}: needs at least one channel`);
    (g.channels || []).forEach((c) => {
      if (!c.id || channelIds.has(c.id)) errors.push(`channel id missing or duplicate: ${c.id}`);
      channelIds.add(c.id);
      if (!FORMULAS.includes(c.formula)) errors.push(`${c.id}: formula must be one of ${FORMULAS}`);
      if (!c.idPrefix) errors.push(`${c.id}: idPrefix is required`);
      if (g.costSource === 'PRODUCT' && !c.brand) errors.push(`${c.id}: brand is required for PRODUCT cost source`);
      if (c.priceTier !== undefined && (g.costSource !== 'PRODUCT' || !PRICE_TIERS.includes(c.priceTier))) errors.push(`${c.id}: priceTier must be one of ${PRICE_TIERS} (PRODUCT channels only)`);
      if (!(c.discounts || []).length || c.discounts.length > 3) errors.push(`${c.id}: 1–3 discounts required`);
      (c.discounts || []).forEach((d) => {
        const vals = [d.default, d.min ?? 0, d.max ?? 0.99];
        if (!d.label || vals.some((v) => typeof v !== 'number' || v < 0 || v >= 1)) errors.push(`${c.id}: bad discount ${JSON.stringify(d)}`);
        if ((d.min ?? 0) > d.default || d.default > (d.max ?? 0.99)) errors.push(`${c.id}: ${d.label} default outside min/max`);
      });
    });
  });
  const tiers = new Set();
  if (raw.gpTiers && !(typeof raw.gpRateMax === 'number' && raw.gpRateMax > 0 && raw.gpRateMax < 1)) errors.push('gpRateMax must be a fraction between 0 and 1');
  if (raw.gpZeroRateFlag !== undefined && typeof raw.gpZeroRateFlag !== 'string') errors.push('gpZeroRateFlag must be text');
  (raw.gpTiers || []).forEach((t) => {
    if (!t.code || tiers.has(t.code)) errors.push(`gpTiers: code missing or duplicate: ${t.code}`);
    tiers.add(t.code);
    if (t.netPrice !== undefined) {
      if (t.netPrice !== 'WHOLESALE') errors.push(`gpTiers ${t.code}: netPrice must be "WHOLESALE"`);
      if (!t.fallback) errors.push(`gpTiers ${t.code}: a netPrice tier needs a fallback tier`);
      return;
    }
    if (!(t.steps || []).length) errors.push(`gpTiers ${t.code}: steps required`);
    if (t.replacesTerms !== undefined && !(Array.isArray(t.replacesTerms) && t.replacesTerms.every((c) => typeof c === 'string' && c && c === c.trim().toUpperCase()))) {
      errors.push(`gpTiers ${t.code}: replacesTerms must be a list of upper-case term codes`);
    }
    (t.steps || []).forEach((s) => {
      if (!GP_RATE_KEYS.includes(s.rate)) errors.push(`gpTiers ${t.code}: rate must be one of ${GP_RATE_KEYS}`);
      if (!s.label || typeof s.default !== 'number' || s.default < 0 || s.default >= 1) errors.push(`gpTiers ${t.code}: bad step ${JSON.stringify(s)}`);
      if (s.fee !== undefined && typeof s.fee !== 'boolean') errors.push(`gpTiers ${t.code}: fee must be true or false`);
    });
  });
  (raw.gpTiers || []).forEach((t) => {
    if (t.fallback === undefined) return;
    const f = (raw.gpTiers || []).find((x) => x.code === t.fallback);
    if (!f || f.netPrice !== undefined) errors.push(`gpTiers ${t.code}: fallback must be a tier with steps: ${t.fallback}`);
  });
  if (errors.length) throw new Error('price-groups.json is invalid:\n- ' + errors.join('\n- '));
}

/** Idempotent: safe on every start. */
async function seed(pool, cfg, groups) {
  groups = groups || loadPriceGroups();
  await tx(pool, async (c) => {
    for (const [key, value, description] of DEFAULT_SETTINGS) {
      await c.query('insert into settings (key, value, description) values ($1, $2, $3) on conflict (key) do update set description = excluded.description',
        [key, JSON.stringify(value), description]);
    }
    const groupIds = [];
    const channelIds = [];
    for (const [gi, g] of groups.entries()) {
      groupIds.push(g.id);
      await c.query(
        `insert into price_groups (id, name, description, cost_source, indicator_rules, params, sort, active)
         values ($1, $2, $3, $4, $5, $6, $7, true)
         on conflict (id) do update set name = excluded.name, description = excluded.description, cost_source = excluded.cost_source,
           indicator_rules = excluded.indicator_rules, params = excluded.params, sort = excluded.sort, active = true`,
        [g.id, g.name, g.description || '', g.costSource, JSON.stringify(g.indicatorRules || []), JSON.stringify(g.params || {}), gi]);
      for (const [ci, ch] of g.channels.entries()) {
        channelIds.push(ch.id);
        await c.query(
          `insert into channels (id, group_id, name, brand, id_prefix, formula, discounts, key_label, description, sort, price_tier, active)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
           on conflict (id) do update set group_id = excluded.group_id, name = excluded.name, brand = excluded.brand,
             id_prefix = excluded.id_prefix, formula = excluded.formula, discounts = excluded.discounts,
             key_label = excluded.key_label, description = excluded.description, sort = excluded.sort, price_tier = excluded.price_tier, active = true`,
          [ch.id, g.id, ch.name, ch.brand ? ch.brand.toUpperCase() : null, ch.idPrefix, ch.formula, JSON.stringify(ch.discounts),
            ch.keyLabel || '', ch.description || '', gi * 100 + ci, ch.priceTier || null]);
        await c.query('insert into id_counters (prefix) values ($1) on conflict do nothing', [ch.idPrefix]);
      }
    }
    // Removed from config → inactive (history keeps pointing at them).
    await c.query('update channels set active = false where not (id = any($1))', [channelIds]);
    await c.query('update price_groups set active = false where not (id = any($1))', [groupIds]);

    for (const email of cfg.bootstrapAdmins) {
      await c.query(`insert into users (email, name, role) values ($1, $2, 'ADMIN') on conflict (email) do nothing`, [email, email.split('@')[0]]);
    }
    for (const email of cfg.bootstrapSupervisors) {
      await c.query(`insert into users (email, name, role) values ($1, $2, 'SUPERVISOR') on conflict (email) do nothing`, [email, email.split('@')[0]]);
    }
    for (const email of cfg.costViewers) {
      await c.query(`insert into users (email, name) values ($1, $2) on conflict (email) do nothing`, [email, email.split('@')[0]]);
    }
    await c.query('update users set can_view_cost = (email = any($1::text[]))', [cfg.costViewers]);
    await c.query(`delete from price_checks where at < now() - interval '180 days'`);
  });
}

module.exports = { seed, loadPriceGroups, loadGpConfig, loadGpTiers, validatePriceGroups };
