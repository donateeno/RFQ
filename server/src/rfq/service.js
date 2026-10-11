'use strict';
/**
 * RFQ business logic. Every exported function takes ctx = {db, cfg, user, notify} first and is
 * reachable from the browser through the whitelisted RPC route, so each one checks the role itself.
 * Cost/gain/%MU are only ever returned to SUPERVISOR/ADMIN.
 */
const { calculate, resolveDiscounts, round, INDICATOR, UserError } = require('../pricing');
const { tx } = require('../db');
const { getSettings, getCatalog, getChannel, lookupItem, landedFromRow } = require('./catalog');
const { importData, parseCsv } = require('./importers');
const notifyMsg = require('./notifications');

const STATUS = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled', CLOSED: 'Closed' };
const DISPLAY_STATUSES = ['Pending', 'Approved', 'Expired', 'Rejected', 'Cancelled', 'Closed'];
const ROLES = ['SALES', 'SUPERVISOR', 'ADMIN'];

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

async function prepareLine(db, group, channel, line, settings) {
  const item = await lookupItem(db, group, channel, line.productKey);
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
  else if (!(item.cost > 0)) flags.push('ไม่มีต้นทุน');
  if (normal > 0 && special > normal) flags.push('ราคาพิเศษสูงกว่าราคาปกติ');
  return {
    found: !!item,
    productKey: item ? item.key : str(line.productKey, 200),
    productName: item ? item.name : str(line.productKey, 200),
    normalPrice: normal, specialPrice: special, discounts, calc, flags
  };
}

function displayStatus(r, today) {
  if (r.status === STATUS.APPROVED && r.end_date && r.end_date < today) return 'Expired';
  return r.status;
}

function toView(r, user, today) {
  const v = {
    id: r.id, batch: r.batch_id || '', groupId: r.group_id, channel: r.channel_id, costSource: r.cost_source,
    customer: r.customer, project: r.project, note: r.note,
    productKey: r.product_key, productName: r.product_name, qty: r.qty,
    normalPrice: r.normal_price, specialPrice: r.special_price,
    discounts: r.discounts || [], discountLabels: r.discount_labels || [],
    indicator: r.indicator, status: r.status, displayStatus: displayStatus(r, today),
    startDate: r.start_date || '', endDate: r.end_date || '',
    requester: r.requester, requestedAt: r.requested_at ? r.requested_at.toISOString() : '',
    decidedBy: r.decided_by || '', decidedAt: r.decided_at ? r.decided_at.toISOString() : '',
    comment: r.decision_comment || '', flags: (r.flags || []).join('; '), source: r.source
  };
  if (user.role === 'SUPERVISOR' || user.role === 'ADMIN') {
    Object.assign(v, { cost: r.cost, netIncVat: r.net_inc_vat, netExVat: r.net_ex_vat, gain: r.gain, mu: r.mu });
  }
  return v;
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
  const settings = await getSettings(db);
  const catalog = await getCatalog(db);
  const products = (await db.query('select brand as b, key as k, name as n, normal_price as p from products order by brand, key')).rows;
  const projects = (await db.query('select group_id as g, project_key as k, customer, description, normal_price as p from project_costs order by project_key')).rows
    .map((r) => ({ g: r.g, k: r.k, n: [r.customer, r.description].filter(Boolean).join(' · '), p: r.p }));
  const landedRows = (await db.query('select * from landed_items order by item_code')).rows;
  const landed = landedRows.map((r) => {
    const g = catalog.find((x) => x.id === r.group_id);
    const lc = g ? landedFromRow(r, g.params) : null;
    return { g: r.group_id, k: r.item_code, n: r.description, p: lc ? lc.suggestedPrice : null };
  });
  const customers = (await db.query(`select distinct customer from requests where customer <> '' order by customer limit 3000`)).rows.map((r) => r.customer);
  const out = {
    user: { email: user.email, name: user.name, role: user.role, canApprove: user.role !== 'SALES', isAdmin: user.role === 'ADMIN' },
    groups: catalog.map((g) => ({ id: g.id, name: g.name, description: g.description, costSource: g.costSource, channels: g.channels })),
    settings: { defaultValidityDays: settings.DEFAULT_VALIDITY_DAYS, maxValidityDays: settings.MAX_VALIDITY_DAYS },
    products, projects, landed, customers,
    today: todayIso(cfg.timezone)
  };
  if (out.user.canApprove) {
    out.groups.forEach((g) => { g.indicatorRules = catalog.find((x) => x.id === g.id).indicatorRules; });
    out.pendingCount = Number((await db.query(`select count(*) from requests where status = 'Pending'`)).rows[0].count);
  }
  return out;
}

// ---------------------------------------------------------------- price check & submit

async function priceCheck(ctx, payload) {
  const { db, user } = ctx;
  const settings = await getSettings(db);
  const { group, channel } = await getChannel(db, payload && payload.channelId);
  const p = await prepareLine(db, group, channel, payload || {}, settings);
  const out = {
    found: p.found, productKey: p.productKey, productName: p.productName, normalPrice: p.normalPrice,
    discounts: p.discounts, indicator: p.calc.indicator, flags: p.flags
  };
  if (user.role !== 'SALES') Object.assign(out, { cost: p.calc.cost, netIncVat: p.calc.netIncVat, netExVat: p.calc.netExVat, gain: p.calc.gain, mu: p.calc.mu });
  return out;
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
    const p = await prepareLine(db, group, channel, l, settings);
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
           start_date, end_date, requester, requested_at, flags, source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'Pending',$23,$24,$25,now(),$26,'APP')
         returning *`,
        [id, batchId, group.id, channel.id, group.costSource, channel.brand, customer, str(payload.project, 200), str(payload.note, 500),
          p.productKey, p.productName, p.qty, p.normalPrice, p.specialPrice, JSON.stringify(p.discounts), JSON.stringify(labels),
          p.calc.cost, p.calc.netIncVat, p.calc.netExVat, p.calc.gain, p.calc.mu, p.calc.indicator, start, end, user.email, p.flags])).rows[0];
      rows.push(r);
    }
    await log(c, user.email, 'SUBMIT', rows.map((r) => r.id), { customer, channel: channel.id });
    return rows;
  });

  const approvers = await approverEmails(db, settings);
  ctx.notify(notifyMsg.submitted(cfg, created, user, group, channel, approvers.filter((e) => e !== user.email)));
  return { batchId, lines: created.map((r) => toView(r, user, today)) };
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
  return rows.map((r) => toView(r, ctx.user, today));
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
  return rows.map((r) => toView(r, ctx.user, today));
}

async function searchApprovedPrices(ctx, filter) {
  filter = filter || {};
  const today = todayIso(ctx.cfg.timezone);
  const params = [today];
  const where = [`status = 'Approved'`].concat(buildFilter({ q: filter.q, group: filter.group, channel: filter.channel }, today, params));
  if (!filter.includeExpired) where.push('(end_date is null or end_date >= $1) and (start_date is null or start_date <= $1)');
  const rows = (await ctx.db.query(`select * from requests where ${where.join(' and ')} order by requested_at desc nulls last, id desc limit 300`, params)).rows;
  return rows.map((r) => toView(r, ctx.user, today));
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
  return { sameProduct: sameProduct.map((r) => toView(r, ctx.user, today)), sameCustomer: sameCustomer.map((r) => toView(r, ctx.user, today)) };
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
  const ownGuard = user.role === 'ADMIN' ? '' : 'and lower(requester) <> $5';
  const params = [decision, user.email, comment, ids];
  if (ownGuard) params.push(user.email);
  const changed = await tx(ctx.db, async (c) => {
    const rows = (await c.query(
      `update requests set status = $1, decided_by = $2, decided_at = now(), decision_comment = $3, updated_at = now()
       where id = any($4) and status = 'Pending' ${ownGuard} returning *`, params)).rows;
    await log(c, user.email, decision === STATUS.APPROVED ? 'APPROVE' : 'REJECT', rows.map((r) => r.id), { comment });
    return rows;
  });
  const done = changed.map((r) => r.id);
  notifyMsg.decided(ctx.cfg, changed, user).forEach((m) => ctx.notify(m));
  return { updated: done, skipped: ids.filter((id) => !done.includes(id)), lines: changed.map((r) => toView(r, user, today)) };
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
  const avgMu = (rows) => {
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
  const view = (r) => toView(r, ctx.user, today);
  return {
    from, to,
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
    users: (await q('select email, name, role, active, last_login_at from users order by role desc, email')).map((u) => ({
      email: u.email, name: u.name, role: u.role, active: u.active, lastLoginAt: u.last_login_at ? u.last_login_at.toISOString() : ''
    })),
    catalog: await getCatalog(db, false),
    counts: {
      products: Number((await q('select count(*) from products'))[0].count),
      productsWithoutCost: Number((await q('select count(*) from products where cost is null or cost <= 0'))[0].count),
      productsUpdatedAt: ((await q('select max(updated_at) as m from products'))[0].m || '').toString(),
      projectCosts: Number((await q('select count(*) from project_costs'))[0].count),
      landedItems: Number((await q('select count(*) from landed_items'))[0].count),
      requests: Number((await q('select count(*) from requests'))[0].count)
    },
    recentLog: (await q('select at, user_email, action, req_ids, detail from audit_log order by at desc limit 30')).map((l) => ({
      at: l.at.toISOString(), user: l.user_email, action: l.action, ids: l.req_ids.slice(0, 5).join(', ') + (l.req_ids.length > 5 ? ' …' : ''), detail: JSON.stringify(l.detail)
    }))
  };
}

async function saveSettings(ctx, changes) {
  const user = admin(ctx);
  changes = changes || {};
  const numeric = { VAT_RATE: [0, 0.3], DEFAULT_VALIDITY_DAYS: [1, 365], MAX_VALIDITY_DAYS: [1, 365] };
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
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || email.split('@')[1] !== ctx.cfg.allowedDomain) throw new UserError(`อีเมลต้องเป็น @${ctx.cfg.allowedDomain}`);
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
  const res = await importData(ctx.db, { type: payload.type, values, brand: payload.brand, group: payload.group, sourceName: payload.fileName, today: todayIso(ctx.cfg.timezone) });
  await log(ctx.db, user.email, 'IMPORT', [], { type: payload.type, file: payload.fileName, ...res, errors: (res.errors || []).slice(0, 20) });
  return res;
}

module.exports = {
  // RPC-callable
  rpc: {
    getBootstrap, priceCheck, submitRequest, listMyRequests, listRequests, searchApprovedPrices, getLineContext,
    decideRequests, cancelMyRequests, getDashboard, getAdminInfo, saveSettings, saveUser, importCsv
  },
  // internal
  todayIso, STATUS
};
