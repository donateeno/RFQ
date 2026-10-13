/**
 * Web app entry point + bootstrap/admin endpoints.
 */

function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Everything the browser needs on load. No cost data for Sales users. */
function getBootstrap() {
  var user = currentUser_();
  var settings = getSettings_();
  var out = {
    user: user,
    channels: getChannels_().filter(function (c) { return c.active; }),
    settings: {
      defaultValidityDays: settings.DEFAULT_VALIDITY_DAYS,
      maxValidityDays: settings.MAX_VALIDITY_DAYS
    },
    products: productListForClient_(),
    customers: distinctCustomers_(),
    today: fmtDate_(new Date())
  };
  if (user.canApprove) {
    out.settings.vatRate = settings.VAT_RATE;
    out.settings.thresholds = {
      loss: settings.MU_LOSS_BELOW, veryLow: settings.MU_VERY_LOW_MAX, low: settings.MU_LOW_MAX
    };
    out.pendingCount = readTable_(SHEET.REQUESTS).rows.filter(function (r) {
      return r.Status === STATUS.PENDING;
    }).length;
  }
  if (user.isAdmin) out.sheetUrl = ss_().getUrl();
  return out;
}

function distinctCustomers_() {
  var seen = {};
  readTable_(SHEET.REQUESTS).rows.forEach(function (r) {
    var c = String(r.Customer || '').trim();
    if (c) seen[c] = true;
  });
  return Object.keys(seen).sort().slice(0, 2000);
}

/** Admin page data. */
function getAdminInfo() {
  requireRole_(currentUser_(), [ROLE.ADMIN]);
  var products = readTable_(SHEET.PRODUCTS).rows;
  var updated = products.length && products[0].UpdatedAt instanceof Date ? fmtDateTime_(products[0].UpdatedAt) : '';
  return {
    settings: readTable_(SHEET.SETTINGS).rows.map(function (r) {
      return { key: String(r.Key), value: r.Value instanceof Date ? fmtDate_(r.Value) : r.Value, description: String(r.Description || '') };
    }),
    users: readTable_(SHEET.USERS).rows.map(function (r) {
      return { email: String(r.Email), name: String(r.Name), role: String(r.Role), active: r.Active === '' || toBool_(r.Active) };
    }),
    productCount: products.length,
    productsWithoutCost: products.filter(function (p) { return !(toNumber_(p.Cost) > 0); }).length,
    productsUpdatedAt: updated,
    requestCount: readTable_(SHEET.REQUESTS).rows.length,
    sheetUrl: ss_().getUrl()
  };
}

/** Admin edits APP_Settings values from the web app. */
function saveSettings(changes) {
  var user = requireRole_(currentUser_(), [ROLE.ADMIN]);
  var numeric = ['VAT_RATE', 'MU_LOSS_BELOW', 'MU_VERY_LOW_MAX', 'MU_LOW_MAX', 'DEFAULT_VALIDITY_DAYS', 'MAX_VALIDITY_DAYS'];
  var rows = readTable_(SHEET.SETTINGS).rows;
  var changed = [];
  Object.keys(changes || {}).forEach(function (key) {
    var row = rows.filter(function (r) { return String(r.Key) === key; })[0];
    if (!row) return;
    var val = changes[key];
    if (numeric.indexOf(key) !== -1) {
      val = Number(val);
      if (isNaN(val) || val < 0) throw new Error(key + ' ต้องเป็นตัวเลข');
    }
    row.Value = val;
    changed.push(row);
  });
  var s = {};
  rows.forEach(function (r) { s[r.Key] = Number(r.Value); });
  if (!(s.MU_LOSS_BELOW <= s.MU_VERY_LOW_MAX && s.MU_VERY_LOW_MAX <= s.MU_LOW_MAX)) {
    throw new Error('เกณฑ์ต้องเรียงจากน้อยไปมาก: ขาดทุน ≤ VERY LOW ≤ LOW');
  }
  updateObjects_(SHEET.SETTINGS, changed);
  settingsMemo_ = null;
  log_(user.email, 'SAVE_SETTINGS', [], changes);
  return getAdminInfo();
}
