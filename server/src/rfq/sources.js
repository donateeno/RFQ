'use strict';
/**
 * Data sources (เจ้าของระบบ › แหล่งข้อมูล) and their alerts. Lists every Google Sheet range the n8n workflows send,
 * the columns the app reads and what for, and how the last sync of each went. Column letters and header text come
 * from the importers' own header checks, so the page shows exactly what the import reads. Never shows cost values.
 */
const { SMG_SHEETS, MASTER_GP_BLOCKS, MAPPING_SHEETS, colName } = require('./importers');
const { tx } = require('../db');

const FILES = {
  cost: { name: 'COST UPDATE 2021 for import', use: 'ต้นทุน ต้นทุนชุดเซ็ต และราคาส่ง Non-PC' },
  nationwide: { name: 'SMG PRICELIST NATIONWIDE', use: 'สถานะสินค้า ราคาปกติ และราคาโปรโมชั่น (ราคาฐาน)' },
  master: { name: 'SMG MASTER <รอบราคา>', use: 'Hot price GT / DGT / BT และ GP รายสินค้า — n8n ใช้ไฟล์ล่าสุดที่ชื่อขึ้นต้นด้วย "SMG MASTER "' },
  mapping: { name: 'Customer Price Mapping Template', use: 'ราคาตามลูกค้า: คลังเงื่อนไข กลุ่มลูกค้า เงื่อนไขของกลุ่ม และรายชื่อลูกค้า' }
};

const GP_USE = { SCGH: 'GP SCG Home', T15: 'GP ดีลเลอร์ T15', T18: 'GP ดีลเลอร์ T18', T20: 'GP ดีลเลอร์ T20 (และ T20 ลาว)', T24: 'GP ดีลเลอร์ T24',
  BT_GP: 'ส่วนลด BT', BT_MKT: 'ค่าการตลาด BT', BT_DC: 'ค่าศูนย์กระจายสินค้า BT', DST1: 'GP Dropship ออนไลน์' };

/** One entry per tab: which import sends it, whether the sync needs it, and what each column it reads is for. */
const TABS = [
  { key: 'cost', type: 'smg_catalog', file: 'cost', tab: '2021', spec: SMG_SHEETS.cost, required: true,
    use: { ean: 'บาร์โค้ด (ใช้จับคู่ทุกไฟล์)', model: 'ชื่อรุ่นในระบบ', cost: 'ต้นทุนต่อหน่วย (เห็นเฉพาะผู้ดูต้นทุน)', st: 'N = ไม่ขาย ไม่ใช้ต้นทุน' } },
  { key: 'sets', type: 'smg_catalog', file: 'cost', tab: 'relationship', spec: SMG_SHEETS.sets, required: false,
    use: { ean: 'บาร์โค้ดเซ็ต', part1: 'ชิ้นส่วนที่ 1', cost1: 'ต้นทุนชิ้นส่วน 1', part2: 'ชิ้นส่วนที่ 2', cost2: 'ต้นทุนชิ้นส่วน 2', part3: 'ชิ้นส่วนที่ 3',
      cost3: 'ต้นทุนชิ้นส่วน 3', part4: 'ชิ้นส่วนที่ 4', cost4: 'ต้นทุนชิ้นส่วน 4', total: 'ต้นทุนรวมของเซ็ต (ใช้เมื่อเท่ากับผลรวมชิ้นส่วน)', ean2: 'บาร์โค้ดเซ็ต (เมื่อ A ว่าง)' } },
  { key: 'wholesale', type: 'smg_catalog', file: 'cost', tab: 'WHOLESALE', spec: SMG_SHEETS.wholesale, required: false,
    use: { display: 'TRUE = ราคาที่ดีลเลอร์ Non-PC จ่าย, FALSE = ราคาตามเงื่อนไขอื่น', ean: 'บาร์โค้ด', model: 'ชื่อรุ่น', desc: 'คำอธิบายเงื่อนไข', net: 'ราคาส่งสุทธิ Non-PC' } },
  { key: 'pricelist', type: 'smg_catalog', file: 'nationwide', tab: 'Pricelist update', spec: SMG_SHEETS.pricelist, required: true,
    use: { status: 'สถานะ S / OR / EX / G / MTO', ean: 'บาร์โค้ด', brand: 'ยี่ห้อ', category: 'หมวดสินค้า', name: 'ชื่อสินค้า', normal: 'ราคาปกติ (ราคาป้าย)',
      promotion: 'ราคาโปรโมชั่น = ราคาฐาน', priceCat: 'หมวดราคาตัวโชว์' } },
  { key: 'master', type: 'smg_catalog', file: 'master', tab: 'MASTER', spec: SMG_SHEETS.master, required: true, gp: true,
    use: { item: 'บาร์โค้ด (Item No.)', brand: 'ยี่ห้อ', name: 'ชื่อสินค้า', group: 'กลุ่มสินค้า', oldSpecial: 'ราคาพิเศษเดิม (ใช้เมื่อไม่มีราคาอื่น)',
      GT: 'ราคา GT (ใช้ตรวจเทียบ)', DGT: 'ราคา DGT ออนไลน์ (ใช้ตรวจเทียบ)', BT: 'ราคา BT (ใช้ตรวจเทียบ)' } },
  { key: 'hot', type: 'smg_catalog', file: 'master', tab: 'HOTPRICE', spec: SMG_SHEETS.hot, required: true,
    use: { saleCh: 'ช่องทางขาย / ยกเลิก', ean: 'บาร์โค้ด', name: 'ชื่อรุ่น', BT: 'Hot price BT', DGT: 'Hot price DGT ออนไลน์', GT: 'Hot price GT' } },
  { key: 'terms', type: 'customer_pricing', file: 'mapping', tab: 'Term Library', spec: MAPPING_SHEETS.terms, required: true,
    use: { code: 'รหัสเงื่อนไข', name: 'ชื่อเงื่อนไข', method: 'วิธีคำนวณ (PCT_RUNNING / PCT_GROSS / THB_UNIT / THB_ORDER)' } },
  { key: 'groups', type: 'customer_pricing', file: 'mapping', tab: 'Customer Groups', spec: MAPPING_SHEETS.groups, required: true, gpTierCol: true,
    use: { code: 'รหัสกลุ่ม', name: 'ชื่อกลุ่ม', tier: 'ราคาฐาน (GT / DGT / BT / NTW / FOSTER / JS)', credit: 'เครดิตเทอม' } },
  { key: 'groupTerms', type: 'customer_pricing', file: 'mapping', tab: 'Group Terms', spec: MAPPING_SHEETS.groupTerms, required: true,
    use: { owner: 'รหัสกลุ่มหรือรหัสลูกค้า', seq: 'ลำดับการหัก', term: 'รหัสเงื่อนไข', pct: 'ค่า %', thb: 'ค่าบาท', scope: 'ใช้กับสินค้า', from: 'มีผลตั้งแต่', to: 'สิ้นสุด' } },
  { key: 'channels', type: 'customer_pricing', file: 'mapping', tab: 'Channel Map', spec: MAPPING_SHEETS.channels, required: true,
    use: { channel: 'ช่องทาง SAP', group: 'กลุ่มลูกค้าเริ่มต้น' } },
  { key: 'customerMap', type: 'customer_pricing', file: 'mapping', tab: 'Customer Map', spec: MAPPING_SHEETS.customerMap, required: true,
    use: { code: 'รหัสลูกค้า SAP', group: 'กลุ่มที่ใช้แทนกลุ่มของช่องทาง' } },
  { key: 'customers', type: 'customer_pricing', file: 'mapping', tab: 'Active Customers', spec: MAPPING_SHEETS.customers, required: true,
    use: { code: 'รหัสลูกค้า', name: 'ชื่อลูกค้า', channel: 'ช่องทาง SAP', employee: 'พนักงานขาย', last: 'ซื้อล่าสุด' } }
];
const TYPES = { smg_catalog: 'ซิงค์ราคา SMG', customer_pricing: 'ราคาตามลูกค้า (Customer Price Mapping)' };

function columns(t) {
  const cols = Object.entries(t.spec.cols).map(([k, [i, h]]) => ({ col: colName(i), header: [].concat(h)[0], use: t.use[k] || '' }));
  if (t.gp) {
    MASTER_GP_BLOCKS.forEach((b) => Object.entries(b).forEach(([k, [i, h]]) => cols.push({ col: colName(i), header: h, use: GP_USE[k] || k })));
  }
  if (t.gpTierCol) cols.push({ col: 'I', header: 'GP Tier …', use: 'GP Tier ของกลุ่ม (หาจากหัวคอลัมน์ที่ขึ้นต้นด้วย "GP Tier")' });
  return cols.sort((a, b) => a.col.length - b.col.length || a.col.localeCompare(b.col));
}
const rangeOf = (label) => (String(label).match(/'[^']+'!\S+$/) || [label])[0];
const sheetUrl = (id) => (/^[A-Za-z0-9_-]{20,100}$/.test(id || '') ? `https://docs.google.com/spreadsheets/d/${id}/edit` : '');

/** Last successful and last failed import of each type (audit_log). */
async function lastImports(db) {
  const out = {};
  for (const type of Object.keys(TYPES)) {
    const q = async (action) => (await db.query(`select at, detail from audit_log where action = $1 and detail->>'type' = $2 order by at desc limit 1`, [action, type])).rows[0] || null;
    out[type] = { ok: await q('IMPORT'), failed: await q('IMPORT_FAILED') };
  }
  return out;
}

/**
 * Every tab with its state: ok · missing (optional tab not received) · empty · stale (no successful sync for
 * SYNC_STALE_HOURS) · failed (the latest attempt was refused) · never.
 */
async function sourceStatus(db, staleHours, now) {
  now = now || new Date();
  const last = await lastImports(db);
  const types = Object.entries(TYPES).map(([type, label]) => {
    const { ok, failed } = last[type];
    const failedLatest = failed && (!ok || failed.at > ok.at);
    const stale = ok && (now - ok.at) / 3600000 > staleHours;
    return {
      type, label, lastOkAt: ok ? ok.at.toISOString() : '', lastFailedAt: failed ? failed.at.toISOString() : '',
      error: failedLatest ? String(failed.detail.error || '').slice(0, 500) : '', failed: !!failedLatest, stale: !!stale, never: !ok,
      priceList: ok ? ok.detail.priceList || '' : ''
    };
  });
  const byType = Object.fromEntries(types.map((t) => [t.type, t]));
  const fileIds = {};
  for (const type of Object.keys(TYPES)) Object.assign(fileIds, ((last[type].ok || {}).detail || {}).files || {});
  const tabs = TABS.map((t) => {
    const st = byType[t.type];
    const d = ((last[t.type].ok || {}).detail) || {};
    const rows = d.sheetRows ? d.sheetRows[t.key] : undefined;
    const missing = (d.missing || []).includes(t.key) || (!t.required && rows === null);
    let state = 'ok';
    if (st.never) state = 'never';
    else if (st.failed) state = 'failed';
    else if (missing) state = 'missing';
    else if (rows === 0) state = 'empty';
    else if (st.stale) state = 'stale';
    return { key: t.key, type: t.type, file: t.file, tab: t.tab, range: rangeOf(t.spec.label), required: t.required, rows: rows === undefined ? null : rows,
      state, columns: columns(t) };
  });
  const files = Object.entries(FILES).map(([key, f]) => {
    const id = fileIds[key] && typeof fileIds[key] === 'object' ? fileIds[key].id : fileIds[key];
    const name = fileIds[key] && typeof fileIds[key] === 'object' && fileIds[key].name ? fileIds[key].name : f.name;
    return { key, name, use: f.use, url: sheetUrl(id), tabs: tabs.filter((t) => t.file === key) };
  });
  return { types, files, staleHours };
}

/** Problems worth an alert, each with a stable key (an alert repeats at most once a day per key). */
function problems(status) {
  const out = [];
  status.types.forEach((t) => {
    if (t.failed) out.push({ key: `${t.type}:failed:${t.error.slice(0, 80)}`, text: `${t.label}: ซิงค์ไม่สำเร็จ — ${t.error}` });
    else if (t.stale) out.push({ key: `${t.type}:stale`, text: `${t.label}: ไม่มีการซิงค์สำเร็จเกิน ${status.staleHours} ชั่วโมง (ล่าสุด ${t.lastOkAt.slice(0, 16).replace('T', ' ')} UTC)` });
  });
  status.files.forEach((f) => f.tabs.forEach((t) => {
    if (t.state === 'missing') out.push({ key: `${t.key}:missing`, text: `ไม่ได้รับแท็บ ${t.tab} จากไฟล์ ${f.name} — ตรวจว่าแท็บยังอยู่และชื่อไม่เปลี่ยน` });
    if (t.state === 'empty') out.push({ key: `${t.key}:empty`, text: `แท็บ ${t.tab} ของไฟล์ ${f.name} ไม่มีข้อมูล` });
  }));
  return out;
}

/**
 * Sends owners (email) and ALERT_LINE_TO (LINE) one message per new problem; the same problem is sent again
 * after 24 hours if it is still there. Returns the problems found.
 */
async function checkAndAlert(db, cfg, notify, staleHours) {
  const list = problems(await sourceStatus(db, staleHours));
  const to = (await db.query('select email from users where active and email = any($1::text[])', [cfg.owners])).rows.map((r) => r.email);
  for (const p of list) {
    // The SMG and Customer Price Mapping imports run at the same time: lock per key so a problem is sent once.
    const fresh = await tx(db, async (c) => {
      await c.query('select pg_advisory_xact_lock(hashtext($1))', ['rfq-alert:' + p.key]);
      const sent = await c.query(`select 1 from audit_log where action = 'ALERT' and detail->>'key' = $1 and at > now() - interval '24 hours'`, [p.key]);
      if (sent.rowCount) return false;
      await c.query(`insert into audit_log (user_email, action, detail) values ('system', 'ALERT', $1)`, [JSON.stringify({ key: p.key, text: p.text })]);
      return true;
    });
    if (!fresh) continue;
    notify({
      event: 'source.alert', to, line: cfg.alertLineTo, subject: '[RFQ] แจ้งเตือนแหล่งข้อมูล: ' + p.text.slice(0, 120),
      text: `[RFQ] ${p.text}\n${cfg.baseUrl}/#sources`,
      html: `<p>${escHtml(p.text)}</p><p><a href="${cfg.baseUrl}/#sources">เปิดหน้าแหล่งข้อมูล</a></p>`, ids: []
    });
  }
  return list;
}
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** File IDs and missing tabs as n8n reports them; anything else is dropped. */
function cleanSyncMeta(body) {
  const files = {};
  const raw = (body && body.files) || {};
  for (const k of Object.keys(FILES)) {
    const v = raw[k];
    const id = v && typeof v === 'object' ? v.id : v;
    if (typeof id === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(id)) {
      files[k] = v && typeof v === 'object' && typeof v.name === 'string' ? { id, name: v.name.slice(0, 200) } : id;
    }
  }
  const keys = TABS.map((t) => t.key);
  const missing = [].concat((body && body.missing) || []).map(String).filter((k) => keys.includes(k));
  return { files, missing };
}

module.exports = { sourceStatus, problems, checkAndAlert, cleanSyncMeta, TABS };
