/**
 * One-time setup. Open the spreadsheet → Extensions → Apps Script → run setupApp().
 */

function setupApp() {
  // First run: no users yet, so whoever runs it from the editor is the owner.
  // Afterwards only an ADMIN may re-run it (it is reachable from the web app too).
  if (ss_().getSheetByName(SHEET.USERS) && readTable_(SHEET.USERS).rows.length) {
    requireRole_(currentUser_(), [ROLE.ADMIN]);
  }
  Object.keys(HEADERS).forEach(function (name) { ensureSheet_(name); });

  if (!readTable_(SHEET.SETTINGS).rows.length) {
    appendObjects_(SHEET.SETTINGS, DEFAULT_SETTINGS.map(function (d) {
      return { Key: d[0], Value: d[1], Description: d[2] };
    }));
  }
  if (!readTable_(SHEET.CHANNELS).rows.length) {
    var h = HEADERS[SHEET.CHANNELS];
    appendObjects_(SHEET.CHANNELS, DEFAULT_CHANNELS.map(function (c) {
      var o = {};
      h.forEach(function (k, i) { o[k] = c[i]; });
      return o;
    }));
  }
  if (!readTable_(SHEET.USERS).rows.length) {
    appendObjects_(SHEET.USERS, DEFAULT_USERS.map(function (u) {
      return { Email: u[0], Name: u[1], Role: u[2], Active: u[3] };
    }));
  }
  settingsMemo_ = null;
  channelsMemo_ = null;

  var count = writeProducts_();

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyRefreshProducts') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyRefreshProducts').timeBased().everyDays(1).atHour(6).create();

  formatSheets_();
  log_(Session.getActiveUser().getEmail(), 'SETUP', [], count + ' products');
  return 'Setup complete: ' + count + ' products loaded.';
}

function formatSheets_() {
  var req = sheet_(SHEET.REQUESTS);
  var h = headersOf_(SHEET.REQUESTS);
  function col(name) { return h.indexOf(name) + 1; }
  var rows = Math.max(req.getMaxRows() - 1, 1);
  ['NormalPrice', 'SpecialPrice', 'Cost', 'NetIncVat', 'NetExVat', 'Gain'].forEach(function (n) {
    req.getRange(2, col(n), rows, 1).setNumberFormat('#,##0.00');
  });
  ['Disc1', 'Disc2', 'Disc3', 'MU'].forEach(function (n) {
    req.getRange(2, col(n), rows, 1).setNumberFormat('0.00%');
  });
  ['StartDate', 'EndDate'].forEach(function (n) {
    req.getRange(2, col(n), rows, 1).setNumberFormat('dd/mm/yyyy');
  });
  ['RequestedAt', 'DecidedAt'].forEach(function (n) {
    req.getRange(2, col(n), rows, 1).setNumberFormat('dd/mm/yyyy hh:mm');
  });
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('RFQ App')
    .addItem('เปิดเว็บแอป (Open web app)', 'menuOpenApp')
    .addSeparator()
    .addItem('Setup / repair sheets', 'menuSetup')
    .addItem('Refresh product master', 'menuRefreshProducts')
    .addItem('Import old RFQ tabs', 'menuImportLegacy')
    .addToUi();
}

function menuSetup() {
  SpreadsheetApp.getUi().alert(setupApp());
}

function menuRefreshProducts() {
  SpreadsheetApp.getUi().alert('Products loaded: ' + refreshProducts().count);
}

function menuImportLegacy() {
  var report = importLegacy();
  SpreadsheetApp.getUi().alert(report.map(function (r) {
    return r.sheet + ': imported ' + r.imported + ', skipped ' + r.skipped + (r.error ? ' — ' + r.error : '');
  }).join('\n'));
}

function menuOpenApp() {
  var url = appUrl_();
  var html = url
    ? '<a href="' + url + '" target="_blank">' + url + '</a>'
    : 'ยังไม่ได้ Deploy เว็บแอป — Deploy → New deployment → Web app';
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput('<p style="font-family:sans-serif">' + html + '</p>')
    .setWidth(480).setHeight(120), 'RFQ web app');
}
