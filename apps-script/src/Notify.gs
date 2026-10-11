/**
 * Email notifications. Failures are logged but never block a submit/decision.
 */

function appUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

function esc_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function money_(n) {
  n = toNumber_(n);
  if (n === null) return '-';
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function pct_(n) {
  n = toNumber_(n);
  return n === null ? '-' : (n * 100).toFixed(2) + '%';
}

function emailTable_(rows, withMargin) {
  var head = ['Req. Id.', 'สินค้า', 'จำนวน', 'ขายปกติ', 'ราคาพิเศษ', 'Indicator'];
  if (withMargin) head.push('%MU');
  head.push('สถานะ');
  var th = head.map(function (h) {
    return '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;background:#f5f5f4">' + esc_(h) + '</th>';
  }).join('');
  var trs = rows.map(function (r) {
    var cells = [r.ReqId, r.ProductName, r.Qty, money_(r.NormalPrice), money_(r.SpecialPrice), r.Indicator];
    if (withMargin) cells.push(pct_(r.MU));
    cells.push(r.Status + (r.DecisionComment ? ' — ' + r.DecisionComment : ''));
    return '<tr>' + cells.map(function (c) {
      return '<td style="padding:6px 8px;border-bottom:1px solid #eee">' + esc_(c) + '</td>';
    }).join('') + '</tr>';
  }).join('');
  return '<table style="border-collapse:collapse;font-family:sans-serif;font-size:13px">' +
    '<tr>' + th + '</tr>' + trs + '</table>';
}

function notifySubmitted_(rows, user, channel) {
  try {
    var to = approverEmails_().filter(function (e) { return e !== user.email; });
    if (!to.length) return;
    var first = rows[0];
    var url = appUrl_();
    var html = '<p><b>' + esc_(user.email) + '</b> ขออนุมัติราคาพิเศษ ' + rows.length + ' รายการ</p>' +
      '<p>ช่องทาง: ' + esc_(channel.name) + '<br>คู่ค้า: ' + esc_(first.Customer) +
      (first.Project ? '<br>โครงการ: ' + esc_(first.Project) : '') +
      (first.Note ? '<br>หมายเหตุ: ' + esc_(first.Note) : '') +
      '<br>ช่วงราคา: ' + fmtDate_(first.StartDate) + ' ถึง ' + fmtDate_(first.EndDate) + '</p>' +
      emailTable_(rows, true) +
      (url ? '<p><a href="' + url + '#approvals">เปิดหน้ารออนุมัติ</a></p>' : '');
    MailApp.sendEmail({
      to: to.join(','),
      subject: '[RFQ] ขออนุมัติราคา ' + first.Customer + ' (' + rows.length + ' รายการ) ' + first.ReqId,
      htmlBody: html,
      name: APP_NAME
    });
  } catch (e) {
    console.error('notifySubmitted_ failed: ' + e);
  }
}

function notifyDecided_(rows, approver) {
  if (!rows.length) return;
  var byRequester = {};
  rows.forEach(function (r) {
    var to = String(r.Requester || '').trim();
    if (!to || to.indexOf('@') === -1) return;
    (byRequester[to] = byRequester[to] || []).push(r);
  });
  var url = appUrl_();
  Object.keys(byRequester).forEach(function (to) {
    try {
      var list = byRequester[to];
      var approved = list.filter(function (r) { return r.Status === STATUS.APPROVED; }).length;
      var html = '<p>' + esc_(approver.email) + ' พิจารณาคำขอของคุณแล้ว: อนุมัติ ' + approved +
        ' / ไม่อนุมัติ ' + (list.length - approved) + '</p>' +
        emailTable_(list, false) +
        (url ? '<p><a href="' + url + '#mine">ดูคำขอของฉัน</a></p>' : '');
      MailApp.sendEmail({
        to: to,
        subject: '[RFQ] ผลการพิจารณา ' + list[0].Customer + ' — ' + list.map(function (r) { return r.ReqId; }).join(', '),
        htmlBody: html,
        name: APP_NAME
      });
    } catch (e) {
      console.error('notifyDecided_ failed for ' + to + ': ' + e);
    }
  });
}
