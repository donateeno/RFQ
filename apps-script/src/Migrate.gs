/**
 * One-time import of the old RFQ tabs into APP_Requests. Safe to run again:
 * Req. Ids already in APP_Requests are skipped.
 *
 * Old rows keep their Req. Id, status, approver and dates. Cost and %MU are re-calculated
 * with today's product master (the old sheet never stored them), and flagged as such.
 */

var LEGACY_SOURCES = [
  { sheet: 'GT.EVE_RFQ', channel: 'GT_EVE', layout: 'GT', keyCol: 6 },
  { sheet: 'GT.FOSTER_RFQ', channel: 'GT_FOSTER', layout: 'GT', keyCol: 5 },
  { sheet: 'BT.EVE_RFQ', channel: 'BT_EVE', layout: 'BT', keyCol: 6, external: 'LEGACY_BT_SPREADSHEET_ID' },
  { sheet: 'BT.FOSTER_RFQ', channel: 'BT_FOSTER', layout: 'BT', keyCol: 5, external: 'LEGACY_BT_SPREADSHEET_ID' }
];

function importLegacy() {
  var user = requireRole_(currentUser_(), [ROLE.ADMIN]);
  var settings = getSettings_();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var report = [];
  try {
    var existing = {};
    readTable_(SHEET.REQUESTS).rows.forEach(function (r) { existing[String(r.ReqId)] = true; });
    LEGACY_SOURCES.forEach(function (src) {
      var res = { sheet: src.sheet, imported: 0, skipped: 0, error: '' };
      report.push(res);
      try {
        var book = src.external ? SpreadsheetApp.openById(String(settings[src.external]).trim()) : ss_();
        var sh = book.getSheetByName(src.sheet);
        if (!sh) { res.error = 'ไม่พบชีต'; return; }
        var last = sh.getLastRow();
        if (last < 2) return;
        var values = sh.getRange(2, 1, last - 1, Math.max(Math.min(sh.getLastColumn(), 19), 16)).getValues();
        var channel = getChannel_(src.channel);
        var rows = [];
        values.forEach(function (v) {
          var id = String(v[0] || '').trim();
          if (!id || !String(v[src.keyCol] || '').trim()) return;
          if (existing[id]) { res.skipped++; return; }
          rows.push(legacyRowToRequest_(v, src, channel, settings));
          existing[id] = true;
        });
        appendObjects_(SHEET.REQUESTS, rows);
        res.imported = rows.length;
      } catch (e) {
        res.error = String(e.message || e);
      }
    });
  } finally {
    lock.releaseLock();
  }
  log_(user.email, 'IMPORT_LEGACY', [], report);
  return report;
}

/** 'dd/mm/yy', 'dd/mm/yyyy' or a Date → Date (or null). */
function parseLegacyDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) || v.getFullYear() < 2000 ? null : startOfDay_(v);
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(v || '').trim());
  if (!m) return null;
  var y = Number(m[3]);
  if (y < 100) y += 2000;
  var d = new Date(y, Number(m[2]) - 1, Number(m[1]));
  return d.getFullYear() < 2000 ? null : d;
}

function legacyRowToRequest_(v, src, channel, settings) {
  var gt = src.layout === 'GT';
  var flags = ['นำเข้าจากชีตเดิม: ต้นทุน/%MU คิดจากต้นทุน ณ วันนำเข้า'];

  var product = findProduct_(channel.brand, v[src.keyCol]);
  var productKey = String(v[src.keyCol]).trim();
  var productName = product ? product.name : (channel.brand === 'FOSTER' ? String(v[6] || productKey) : productKey);

  var discounts;
  if (gt) {
    discounts = [9, 10, 11].map(function (c) {
      var n = toNumber_(v[c]);
      if (n === null) return 0;
      if (n >= 1) { flags.push('ส่วนลดเดิม ' + n + ' ถูกแปลงเป็น ' + n + '%'); n = n / 100; }
      return n;
    });
  } else {
    discounts = channel.discounts.map(function (d) { return d.label ? d.def : 0; });
  }

  var normal = toNumber_(v[7]);
  if (normal === null && product) normal = product.normalPrice;
  var special = toNumber_(v[8]);
  var calc = special > 0
    ? calcPricing_({ normalPrice: normal, specialPrice: special, discounts: discounts, cost: product ? product.cost : null }, channel, settings)
    : { cost: null, netIncVat: null, netExVat: null, gain: null, mu: null, indicator: INDICATOR.NO_COST };
  flagsFor_({ normalPrice: normal, specialPrice: special }, product).forEach(function (f) { flags.push(f); });

  var c = gt
    ? { status: 14, decidedAt: 15, decidedBy: 16, requester: 17, requestDate: 18 }
    : { status: 11, decidedAt: 12, decidedBy: 13, requester: 14, requestDate: -1 };
  var requested = (c.requestDate >= 0 && parseLegacyDate_(v[c.requestDate])) || parseLegacyDate_(v[1]) ||
    parseLegacyDate_(v[c.decidedAt]);
  var start = parseLegacyDate_(v[1]) || requested;
  var end = parseLegacyDate_(v[2]);
  if (start && (!end || end < start)) end = addDays_(start, settings.DEFAULT_VALIDITY_DAYS);

  var today = startOfDay_(new Date());
  var raw = String(v[c.status] || '').trim().toLowerCase();
  var status;
  if (raw.indexOf('approve') === 0) status = STATUS.APPROVED;
  else if (raw.indexOf('cancel') === 0) status = STATUS.CANCELLED;
  else if (raw.indexOf('reject') === 0) status = STATUS.REJECTED;
  else status = end && end < today ? STATUS.CLOSED : STATUS.PENDING;

  return {
    ReqId: String(v[0]).trim(),
    BatchId: '',
    Channel: channel.id,
    Brand: channel.brand,
    Customer: gt ? String(v[3] || '').trim() : ('บุญถาวร ' + String(v[4] || '').trim()).trim(),
    Project: gt ? String(v[4] || '').trim() : String(v[3] || '').trim(),
    // GT EVE col F = note; GT/BT FOSTER col F = Foster code (BT FOSTER keeps its #Tag in col P); BT EVE col F = remark
    Note: String((channel.brand === 'EVE' ? v[5] : (gt ? '' : v[15])) || '').trim(),
    ProductKey: productKey,
    ProductName: productName,
    Qty: '',
    NormalPrice: normal === null ? '' : normal,
    SpecialPrice: special === null ? '' : special,
    Disc1: discounts[0], Disc2: discounts[1], Disc3: discounts[2],
    Cost: calc.cost === null ? '' : calc.cost,
    NetIncVat: calc.netIncVat === null ? '' : calc.netIncVat,
    NetExVat: calc.netExVat === null ? '' : calc.netExVat,
    Gain: calc.gain === null ? '' : calc.gain,
    MU: calc.mu === null ? '' : calc.mu,
    Indicator: calc.indicator,
    Status: status,
    StartDate: start || '',
    EndDate: end || '',
    Requester: String(v[c.requester] || '').trim().toLowerCase(),
    RequestedAt: requested || '',
    DecidedBy: status === STATUS.APPROVED || status === STATUS.CANCELLED ? String(v[c.decidedBy] || '').trim().toLowerCase() : '',
    DecidedAt: status === STATUS.APPROVED || status === STATUS.CANCELLED ? (v[c.decidedAt] instanceof Date ? v[c.decidedAt] : parseLegacyDate_(v[c.decidedAt]) || '') : '',
    DecisionComment: status === STATUS.CLOSED ? 'หมดอายุโดยไม่มีการพิจารณา (ข้อมูลเดิม)' : '',
    Flags: flags.join('; '),
    Source: 'LEGACY:' + src.sheet
  };
}
