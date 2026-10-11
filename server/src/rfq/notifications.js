'use strict';
/**
 * Builds notification messages. Delivery is done by n8n (NOTIFY_WEBHOOK_URL): the app POSTs
 * {event, to[], subject, html, ids[]} and n8n sends the email / LINE message.
 * Requester emails never contain cost or %MU.
 */

function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const money = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const pct = (n) => (n === null || n === undefined ? '-' : (Number(n) * 100).toFixed(2) + '%');

function table(rows, withMargin) {
  const head = ['Req. Id.', 'สินค้า', 'จำนวน', 'ขายปกติ', 'ราคาพิเศษ', 'Indicator'].concat(withMargin ? ['%MU'] : []).concat(['สถานะ']);
  const th = head.map((h) => `<th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;background:#f5f5f4">${esc(h)}</th>`).join('');
  const trs = rows.map((r) => {
    const cells = [r.id, r.product_name, r.qty ?? '-', money(r.normal_price), money(r.special_price), r.indicator]
      .concat(withMargin ? [pct(r.mu)] : [])
      .concat([r.status + (r.decision_comment ? ' — ' + r.decision_comment : '')]);
    return '<tr>' + cells.map((c) => `<td style="padding:6px 8px;border-bottom:1px solid #eee">${esc(c)}</td>`).join('') + '</tr>';
  }).join('');
  return `<table style="border-collapse:collapse;font-family:sans-serif;font-size:13px"><tr>${th}</tr>${trs}</table>`;
}

function submitted(cfg, rows, user, group, channel, to) {
  if (!to.length || !rows.length) return null;
  const f = rows[0];
  return {
    event: 'request.submitted',
    to,
    subject: `[RFQ] ขออนุมัติราคา ${f.customer} (${rows.length} รายการ) ${f.id}`,
    html: `<p><b>${esc(user.email)}</b> ขออนุมัติราคาพิเศษ ${rows.length} รายการ</p>
      <p>กลุ่มราคา: ${esc(group.name)} · ช่องทาง: ${esc(channel.name)}<br>คู่ค้า: ${esc(f.customer)}${f.project ? '<br>โครงการ: ' + esc(f.project) : ''}
      ${f.note ? '<br>หมายเหตุ: ' + esc(f.note) : ''}<br>ช่วงราคา: ${esc(f.start_date)} ถึง ${esc(f.end_date)}</p>
      ${table(rows, true)}<p><a href="${cfg.baseUrl}/#approvals">เปิดหน้ารออนุมัติ</a></p>`,
    ids: rows.map((r) => r.id)
  };
}

function decided(cfg, rows, approver) {
  const byRequester = {};
  rows.forEach((r) => {
    if (r.requester && r.requester.includes('@')) (byRequester[r.requester] = byRequester[r.requester] || []).push(r);
  });
  return Object.keys(byRequester).map((to) => {
    const list = byRequester[to];
    const ok = list.filter((r) => r.status === 'Approved').length;
    return {
      event: 'request.decided',
      to: [to],
      subject: `[RFQ] ผลการพิจารณา ${list[0].customer} — ${list.map((r) => r.id).join(', ')}`,
      html: `<p>${esc(approver.email)} พิจารณาคำขอของคุณแล้ว: อนุมัติ ${ok} / ไม่อนุมัติ ${list.length - ok}</p>
        ${table(list, false)}<p><a href="${cfg.baseUrl}/#mine">ดูคำขอของฉัน</a></p>`,
      ids: list.map((r) => r.id)
    };
  });
}

/** Fire-and-forget POST to n8n. Never throws. */
function createNotifier(cfg, logger) {
  return function notify(msg) {
    if (!msg) return;
    if (!cfg.notifyWebhookUrl) { logger.info(`[notify:skipped] ${msg.event} → ${msg.to.join(', ')}`); return; }
    fetch(cfg.notifyWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.integrationToken ? { Authorization: 'Bearer ' + cfg.integrationToken } : {}) },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(8000)
    }).then((r) => { if (!r.ok) logger.error(`[notify] ${msg.event} failed: HTTP ${r.status}`); })
      .catch((e) => logger.error(`[notify] ${msg.event} failed: ${e.message}`));
  };
}

module.exports = { submitted, decided, createNotifier };
