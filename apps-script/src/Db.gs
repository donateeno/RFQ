/**
 * Thin data layer over the APP_ sheets. Rows are plain objects keyed by header.
 */

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('ไม่พบชีต ' + name + ' — กรุณารัน setupApp() ก่อน');
  return sh;
}

/** Ensures a sheet exists with the expected headers (adds any missing header at the end). */
function ensureSheet_(name) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  var wanted = HEADERS[name];
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, wanted.length).setValues([wanted]);
    sh.setFrozenRows(1);
    return sh;
  }
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var have = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var missing = wanted.filter(function (h) { return have.indexOf(h) === -1; });
  if (have.length === 1 && have[0] === '') {
    sh.getRange(1, 1, 1, wanted.length).setValues([wanted]);
    sh.setFrozenRows(1);
  } else if (missing.length) {
    sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

/**
 * Reads a whole APP_ sheet.
 * @return {{headers: string[], rows: Object[]}} each row has a hidden _row (1-based sheet row).
 */
function readTable_(name) {
  var sh = sheet_(name);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastCol < 1) return { headers: [], rows: [] };
  var values = sh.getRange(1, 1, Math.max(lastRow, 1), lastCol).getValues();
  var headers = values[0].map(String);
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var line = values[r];
    var empty = true;
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      obj[headers[c]] = line[c];
      if (line[c] !== '' && line[c] !== null) empty = false;
    }
    if (empty) continue;
    obj._row = r + 1;
    rows.push(obj);
  }
  return { headers: headers, rows: rows };
}

function headersOf_(name) {
  var sh = sheet_(name);
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

function toRowArray_(headers, obj) {
  return headers.map(function (h) {
    var v = obj[h];
    return v === undefined || v === null ? '' : v;
  });
}

function appendObjects_(name, objs) {
  if (!objs.length) return;
  var sh = sheet_(name);
  var headers = headersOf_(name);
  var data = objs.map(function (o) { return toRowArray_(headers, o); });
  sh.getRange(sh.getLastRow() + 1, 1, data.length, headers.length).setValues(data);
}

/** Writes back objects that came from readTable_ (uses their _row). */
function updateObjects_(name, objs) {
  if (!objs.length) return;
  var sh = sheet_(name);
  var headers = headersOf_(name);
  objs.forEach(function (o) {
    if (!o._row) throw new Error('updateObjects_: missing _row');
    sh.getRange(o._row, 1, 1, headers.length).setValues([toRowArray_(headers, o)]);
  });
}

/** Replaces all data rows (keeps the header). */
function replaceAll_(name, objs) {
  var sh = sheet_(name);
  var headers = headersOf_(name);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, headers.length).clearContent();
  if (!objs.length) return;
  var data = objs.map(function (o) { return toRowArray_(headers, o); });
  sh.getRange(2, 1, data.length, headers.length).setValues(data);
}

function log_(user, action, reqIds, detail) {
  try {
    appendObjects_(SHEET.LOG, [{
      At: new Date(), User: user, Action: action,
      ReqIds: (reqIds || []).join(', '),
      Detail: typeof detail === 'string' ? detail : JSON.stringify(detail || '')
    }]);
  } catch (e) {
    console.error('log_ failed: ' + e);
  }
}

// ---------- settings & channels ----------

var settingsMemo_ = null;
function getSettings_() {
  if (settingsMemo_) return settingsMemo_;
  var s = {};
  DEFAULT_SETTINGS.forEach(function (d) { s[d[0]] = d[1]; });
  readTable_(SHEET.SETTINGS).rows.forEach(function (r) {
    if (r.Key !== '' && r.Value !== '') s[String(r.Key).trim()] = r.Value;
  });
  ['VAT_RATE', 'MU_LOSS_BELOW', 'MU_VERY_LOW_MAX', 'MU_LOW_MAX',
    'DEFAULT_VALIDITY_DAYS', 'MAX_VALIDITY_DAYS'].forEach(function (k) { s[k] = Number(s[k]); });
  settingsMemo_ = s;
  return s;
}

var channelsMemo_ = null;
function getChannels_() {
  if (channelsMemo_) return channelsMemo_;
  channelsMemo_ = readTable_(SHEET.CHANNELS).rows.map(function (r) {
    var discounts = [1, 2, 3].map(function (i) {
      return {
        label: String(r['Disc' + i + 'Label'] || ''),
        def: toFraction_(r['Disc' + i + 'Default']),
        editable: toBool_(r['Disc' + i + 'Editable'])
      };
    });
    return {
      id: String(r.ChannelId).trim(),
      name: String(r.Name),
      brand: String(r.Brand).trim().toUpperCase(),
      prefix: String(r.IdPrefix),
      formula: String(r.Formula).trim().toUpperCase() || FORMULA.MULTIPLY,
      discounts: discounts,
      active: toBool_(r.Active),
      description: String(r.Description || '')
    };
  }).filter(function (c) { return c.id; });
  return channelsMemo_;
}

function getChannel_(id) {
  var ch = getChannels_().filter(function (c) { return c.id === id; })[0];
  if (!ch) throw new Error('ไม่พบช่องทาง (channel) ' + id);
  return ch;
}

// ---------- small value helpers ----------

function toBool_(v) {
  if (v === true || v === false) return v;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1';
}

/** 0.18, 18, "18%", "0.18" → 0.18. Blank → 0. */
function toFraction_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  var s = String(v).replace('%', '').trim();
  var n = Number(s);
  if (isNaN(n)) return 0;
  if (String(v).indexOf('%') !== -1 || n > 1) n = n / 100;
  return n;
}

function toNumber_(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  var n = Number(String(v).replace(/,/g, '').trim());
  return isNaN(n) ? null : n;
}

function round_(n, dp) {
  if (n === null || n === undefined || !isFinite(n)) return null;
  var f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

function startOfDay_(d) {
  var x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays_(d, n) {
  var x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

/** Accepts a Date or 'yyyy-mm-dd' (from the web form). */
function parseIsoDate_(v) {
  if (v instanceof Date) return startOfDay_(v);
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fmtDate_(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
}

function fmtDateTime_(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss");
}
