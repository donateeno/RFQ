/**
 * Product master. refreshProducts() flattens the existing hidden sheets into APP_Products:
 *
 *  _Cost&Price  A:C  EVE model      | cost | promotion price
 *               E:G  EVE model/set  | cost | GT hot price      (wins over A:C, same as the old VLOOKUP order)
 *               I:L  Foster code    | description | SMG cost | retail price
 *  _CalDummy    A, L, S  dummy set name | total cost | total price (only if not already listed)
 *
 * Cost never leaves the server for Sales users.
 */

function productSourceSpreadsheet_() {
  var id = String(getSettings_().PRODUCT_SOURCE_SPREADSHEET_ID || '').trim();
  return id ? SpreadsheetApp.openById(id) : ss_();
}

function readBlock_(sh, col, width) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, col, last - 1, width).getValues();
}

function buildProducts_() {
  var src = productSourceSpreadsheet_();
  var cp = src.getSheetByName('_Cost&Price');
  if (!cp) throw new Error('ไม่พบชีต _Cost&Price ในไฟล์ต้นทาง');
  var now = new Date();
  var eve = {};
  var order = [];

  function putEve(key, cost, price, source, override) {
    key = String(key || '').trim();
    if (!key || key.charAt(0) === '#') return;
    cost = toNumber_(cost);
    price = toNumber_(price);
    var cur = eve[key];
    if (!cur) {
      eve[key] = { Brand: 'EVE', Key: key, Name: key, Cost: cost, NormalPrice: price, Source: source, UpdatedAt: now };
      order.push(key);
    } else if (override) {
      if (cost !== null) cur.Cost = cost;
      if (price !== null) cur.NormalPrice = price;
      cur.Source = source;
    } else {
      if (cur.Cost === null) cur.Cost = cost;
      if (cur.NormalPrice === null) cur.NormalPrice = price;
    }
  }

  readBlock_(cp, 1, 3).forEach(function (r) { putEve(r[0], r[1], r[2], 'EVE master', false); });
  readBlock_(cp, 5, 3).forEach(function (r) { putEve(r[0], r[1], r[2], 'GT hot price', true); });

  var dummy = src.getSheetByName('_CalDummy');
  if (dummy) {
    readBlock_(dummy, 1, 19).forEach(function (r) { putEve(r[0], r[11], r[18], 'Dummy set', false); });
  }

  var foster = [];
  var seen = {};
  readBlock_(cp, 9, 4).forEach(function (r) {
    var code = String(r[0] || '').trim();
    if (!code || code.charAt(0) === '#' || seen[code]) return;
    seen[code] = true;
    foster.push({
      Brand: 'FOSTER', Key: code, Name: String(r[1] || code).trim(),
      Cost: toNumber_(r[2]), NormalPrice: toNumber_(r[3]), Source: 'Foster master', UpdatedAt: now
    });
  });

  return order.map(function (k) { return eve[k]; }).concat(foster);
}

/** Admin button in the web app. */
function refreshProducts() {
  var user = requireRole_(currentUser_(), [ROLE.ADMIN]);
  var count = writeProducts_();
  log_(user.email, 'REFRESH_PRODUCTS', [], count + ' products');
  return { count: count };
}

/** Daily time-driven trigger (installed by setupApp). Harmless if called by anyone. */
function dailyRefreshProducts() {
  var count = writeProducts_();
  log_('trigger', 'REFRESH_PRODUCTS', [], count + ' products');
}

function writeProducts_() {
  var products = buildProducts_();
  ensureSheet_(SHEET.PRODUCTS);
  replaceAll_(SHEET.PRODUCTS, products);
  productsMemo_ = null;
  CacheService.getScriptCache().remove('productList');
  return products.length;
}

var productsMemo_ = null;
/** @return {Object<string, Object>} keyed by BRAND|key (key upper-cased). */
function productIndex_() {
  if (productsMemo_) return productsMemo_;
  var idx = {};
  readTable_(SHEET.PRODUCTS).rows.forEach(function (r) {
    var p = {
      brand: String(r.Brand).toUpperCase(),
      key: String(r.Key).trim(),
      name: String(r.Name || r.Key),
      cost: toNumber_(r.Cost),
      normalPrice: toNumber_(r.NormalPrice)
    };
    idx[p.brand + '|' + p.key.toUpperCase()] = p;
  });
  productsMemo_ = idx;
  return idx;
}

function findProduct_(brand, key) {
  if (!key) return null;
  return productIndex_()[String(brand).toUpperCase() + '|' + String(key).trim().toUpperCase()] || null;
}

/** Product list for the browser: no cost. Cached for 1 hour. */
function productListForClient_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('productList');
  if (hit) return JSON.parse(hit);
  var idx = productIndex_();
  var list = Object.keys(idx).map(function (k) {
    var p = idx[k];
    return { b: p.brand, k: p.key, n: p.name, p: p.normalPrice };
  });
  try {
    var json = JSON.stringify(list);
    if (json.length < 100000) cache.put('productList', json, 3600);
  } catch (e) { /* too big for cache — fine */ }
  return list;
}
