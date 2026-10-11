/**
 * Request lifecycle: price check → submit → approve / reject / cancel, plus lookups.
 * Public functions (no trailing underscore) are callable from the browser via google.script.run,
 * so every one of them checks the user's role first.
 */

// ---------- view model ----------

function displayStatus_(r, today) {
  if (r.Status === STATUS.APPROVED && r.EndDate instanceof Date && startOfDay_(r.EndDate) < today) return 'Expired';
  return r.Status || STATUS.PENDING;
}

function rowToView_(r, user, today) {
  var v = {
    id: String(r.ReqId),
    batch: String(r.BatchId || ''),
    channel: String(r.Channel || ''),
    brand: String(r.Brand || ''),
    customer: String(r.Customer || ''),
    project: String(r.Project || ''),
    note: String(r.Note || ''),
    productKey: String(r.ProductKey || ''),
    productName: String(r.ProductName || ''),
    qty: toNumber_(r.Qty),
    normalPrice: toNumber_(r.NormalPrice),
    specialPrice: toNumber_(r.SpecialPrice),
    discounts: [toNumber_(r.Disc1) || 0, toNumber_(r.Disc2) || 0, toNumber_(r.Disc3) || 0],
    indicator: String(r.Indicator || ''),
    status: String(r.Status || ''),
    displayStatus: displayStatus_(r, today),
    startDate: fmtDate_(r.StartDate),
    endDate: fmtDate_(r.EndDate),
    requester: String(r.Requester || ''),
    requestedAt: fmtDateTime_(r.RequestedAt),
    decidedBy: String(r.DecidedBy || ''),
    decidedAt: fmtDateTime_(r.DecidedAt),
    comment: String(r.DecisionComment || ''),
    flags: String(r.Flags || ''),
    source: String(r.Source || '')
  };
  if (user.canSeeCost) {
    v.cost = toNumber_(r.Cost);
    v.netIncVat = toNumber_(r.NetIncVat);
    v.netExVat = toNumber_(r.NetExVat);
    v.gain = toNumber_(r.Gain);
    v.mu = toNumber_(r.MU);
  }
  return v;
}

function sortNewestFirst_(rows) {
  return rows.sort(function (a, b) {
    var ta = a.RequestedAt instanceof Date ? a.RequestedAt.getTime() : 0;
    var tb = b.RequestedAt instanceof Date ? b.RequestedAt.getTime() : 0;
    if (tb !== ta) return tb - ta;
    return String(b.ReqId).localeCompare(String(a.ReqId));
  });
}

function matchesText_(r, q) {
  if (!q) return true;
  var hay = [r.ReqId, r.Customer, r.Project, r.Note, r.ProductKey, r.ProductName, r.Requester]
    .join(' ').toLowerCase();
  return String(q).toLowerCase().split(/\s+/).every(function (w) { return !w || hay.indexOf(w) !== -1; });
}

// ---------- pricing a single line ----------

function prepareLine_(channel, line, settings) {
  var product = findProduct_(channel.brand, line.productKey);
  var special = toNumber_(line.specialPrice);
  if (!(special > 0)) throw new Error('กรุณาใส่ราคาพิเศษ (มากกว่า 0) สำหรับ ' + (line.productKey || 'สินค้า'));
  var discounts = channel.discounts.map(function (d, i) {
    if (!d.label) return 0;
    if (!d.editable) return d.def;
    var given = line.discounts && line.discounts[i];
    var n = given === '' || given === null || given === undefined ? d.def : Number(given);
    if (isNaN(n) || n < 0 || n >= 1) throw new Error(d.label + ' ต้องอยู่ระหว่าง 0% – 99%');
    return n;
  });
  var normal = product ? product.normalPrice : toNumber_(line.normalPrice);
  var calc = calcPricing_({
    normalPrice: normal,
    specialPrice: special,
    discounts: discounts,
    cost: product ? product.cost : null
  }, channel, settings);
  return {
    product: product,
    productKey: product ? product.key : String(line.productKey || '').trim(),
    productName: product ? product.name : String(line.productKey || '').trim(),
    normalPrice: normal,
    specialPrice: special,
    discounts: discounts,
    calc: calc,
    flags: flagsFor_({ normalPrice: normal, specialPrice: special }, product)
  };
}

/** Live calculator. Sales get the indicator only. */
function priceCheck(payload) {
  var user = currentUser_();
  var settings = getSettings_();
  var channel = getChannel_(payload.channelId);
  var p = prepareLine_(channel, payload, settings);
  var out = {
    found: !!p.product,
    productKey: p.productKey,
    productName: p.productName,
    normalPrice: p.normalPrice,
    discounts: p.discounts,
    indicator: p.calc.indicator,
    flags: p.flags
  };
  if (user.canSeeCost) {
    out.cost = p.calc.cost;
    out.netIncVat = p.calc.netIncVat;
    out.netExVat = p.calc.netExVat;
    out.gain = p.calc.gain;
    out.mu = p.calc.mu;
  }
  return out;
}

// ---------- submit ----------

function nextNumbers_(rows) {
  var max = {};
  getChannels_().forEach(function (c) { max[c.prefix] = 0; });
  rows.forEach(function (r) {
    var id = String(r.ReqId);
    Object.keys(max).forEach(function (prefix) {
      if (id.indexOf(prefix) !== 0) return;
      var rest = id.substring(prefix.length);
      if (/^\d+$/.test(rest)) max[prefix] = Math.max(max[prefix], Number(rest));
    });
  });
  return max;
}

function pad_(n, width) {
  var s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
}

/**
 * @param {{channelId:string, customer:string, project:string, note:string,
 *          startDate:string, endDate:string,
 *          lines:{productKey:string, qty:number, specialPrice:number, discounts:number[]}[]}} payload
 */
function submitRequest(payload) {
  var user = currentUser_();
  var settings = getSettings_();
  var channel = getChannel_(payload.channelId);
  if (!channel.active) throw new Error('ช่องทางนี้ปิดใช้งานแล้ว');
  var customer = String(payload.customer || '').trim();
  if (!customer) throw new Error('กรุณาใส่ชื่อคู่ค้า / ร้านค้า');
  var lines = payload.lines || [];
  if (!lines.length) throw new Error('กรุณาเพิ่มสินค้าอย่างน้อย 1 รายการ');
  if (lines.length > 50) throw new Error('ส่งได้สูงสุด 50 รายการต่อครั้ง');

  var today = startOfDay_(new Date());
  var start = parseIsoDate_(payload.startDate) || today;
  var end = parseIsoDate_(payload.endDate) || addDays_(start, settings.DEFAULT_VALIDITY_DAYS);
  if (start < today) throw new Error('วันเริ่มต้องไม่ย้อนหลัง');
  if (start > addDays_(today, 60)) throw new Error('วันเริ่มต้องไม่เกิน 60 วันจากวันนี้');
  if (end < start) throw new Error('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  if ((end - start) / 86400000 > settings.MAX_VALIDITY_DAYS) {
    throw new Error('ระยะเวลาราคาพิเศษยาวได้ไม่เกิน ' + settings.MAX_VALIDITY_DAYS + ' วัน');
  }

  var prepared = lines.map(function (l, i) {
    var qty = toNumber_(l.qty);
    if (!(qty >= 1) || Math.floor(qty) !== qty) throw new Error('รายการที่ ' + (i + 1) + ': จำนวนต้องเป็นเลขจำนวนเต็ม ≥ 1');
    if (!String(l.productKey || '').trim()) throw new Error('รายการที่ ' + (i + 1) + ': กรุณาเลือกสินค้า');
    var p = prepareLine_(channel, l, settings);
    p.qty = qty;
    return p;
  });

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var created;
  try {
    var existing = readTable_(SHEET.REQUESTS).rows;
    var counter = nextNumbers_(existing);
    var now = new Date();
    var batchId = 'B' + Utilities.formatDate(now, TIMEZONE, 'yyMMddHHmmss') + pad_(Math.floor(Math.random() * 100), 2);
    created = prepared.map(function (p) {
      counter[channel.prefix] += 1;
      return {
        ReqId: channel.prefix + pad_(counter[channel.prefix], 4),
        BatchId: batchId,
        Channel: channel.id,
        Brand: channel.brand,
        Customer: customer,
        Project: String(payload.project || '').trim(),
        Note: String(payload.note || '').trim(),
        ProductKey: p.productKey,
        ProductName: p.productName,
        Qty: p.qty,
        NormalPrice: p.normalPrice === null ? '' : p.normalPrice,
        SpecialPrice: p.specialPrice,
        Disc1: p.discounts[0], Disc2: p.discounts[1], Disc3: p.discounts[2],
        Cost: p.calc.cost === null ? '' : p.calc.cost,
        NetIncVat: p.calc.netIncVat,
        NetExVat: p.calc.netExVat,
        Gain: p.calc.gain === null ? '' : p.calc.gain,
        MU: p.calc.mu === null ? '' : p.calc.mu,
        Indicator: p.calc.indicator,
        Status: STATUS.PENDING,
        StartDate: start,
        EndDate: end,
        Requester: user.email,
        RequestedAt: now,
        Flags: p.flags.join('; '),
        Source: 'APP'
      };
    });
    appendObjects_(SHEET.REQUESTS, created);
  } finally {
    lock.releaseLock();
  }

  var ids = created.map(function (r) { return r.ReqId; });
  log_(user.email, 'SUBMIT', ids, { customer: customer, channel: channel.id });
  notifySubmitted_(created, user, channel);
  return { batchId: created[0].BatchId, lines: created.map(function (r) { return rowToView_(r, user, today); }) };
}

// ---------- lists ----------

function listMyRequests(filter) {
  var user = currentUser_();
  filter = filter || {};
  var today = startOfDay_(new Date());
  var rows = readTable_(SHEET.REQUESTS).rows.filter(function (r) {
    return String(r.Requester).toLowerCase() === user.email && matchesText_(r, filter.q) &&
      (!filter.status || displayStatus_(r, today) === filter.status);
  });
  return sortNewestFirst_(rows).slice(0, 300).map(function (r) { return rowToView_(r, user, today); });
}

/** Supervisor monitor: every request, filterable. */
function listRequests(filter) {
  var user = requireRole_(currentUser_(), [ROLE.SUPERVISOR, ROLE.ADMIN]);
  filter = filter || {};
  var today = startOfDay_(new Date());
  var from = parseIsoDate_(filter.from);
  var to = parseIsoDate_(filter.to);
  if (to) to = addDays_(to, 1);
  var rows = readTable_(SHEET.REQUESTS).rows.filter(function (r) {
    if (filter.status && displayStatus_(r, today) !== filter.status) return false;
    if (filter.channel && r.Channel !== filter.channel) return false;
    if (filter.indicator && r.Indicator !== filter.indicator) return false;
    if (from && !(r.RequestedAt instanceof Date && r.RequestedAt >= from)) return false;
    if (to && !(r.RequestedAt instanceof Date && r.RequestedAt < to)) return false;
    return matchesText_(r, filter.q);
  });
  var limit = Math.min(Number(filter.limit) || 500, 2000);
  return sortNewestFirst_(rows).slice(0, limit).map(function (r) { return rowToView_(r, user, today); });
}

/** "Can I offer this price?" — approved prices that are valid today (or all, if includeExpired). */
function searchApprovedPrices(filter) {
  var user = currentUser_();
  filter = filter || {};
  var today = startOfDay_(new Date());
  var rows = readTable_(SHEET.REQUESTS).rows.filter(function (r) {
    if (r.Status !== STATUS.APPROVED) return false;
    if (filter.channel && r.Channel !== filter.channel) return false;
    if (!filter.includeExpired) {
      if (r.EndDate instanceof Date && startOfDay_(r.EndDate) < today) return false;
      if (r.StartDate instanceof Date && startOfDay_(r.StartDate) > today) return false;
    }
    return matchesText_(r, filter.q);
  });
  return sortNewestFirst_(rows).slice(0, 300).map(function (r) { return rowToView_(r, user, today); });
}

/** Approval context: earlier requests for the same product and for the same customer. */
function getLineContext(id) {
  var user = requireRole_(currentUser_(), [ROLE.SUPERVISOR, ROLE.ADMIN]);
  var today = startOfDay_(new Date());
  var all = readTable_(SHEET.REQUESTS).rows;
  var row = all.filter(function (r) { return String(r.ReqId) === id; })[0];
  if (!row) throw new Error('ไม่พบคำขอ ' + id);
  var others = sortNewestFirst_(all.filter(function (r) { return r.ReqId !== row.ReqId; }));
  var sameProduct = others.filter(function (r) {
    return r.Brand === row.Brand && String(r.ProductKey).toUpperCase() === String(row.ProductKey).toUpperCase();
  }).slice(0, 10);
  var cust = String(row.Customer).trim().toLowerCase();
  var sameCustomer = cust ? others.filter(function (r) {
    return String(r.Customer).trim().toLowerCase() === cust;
  }).slice(0, 10) : [];
  var view = function (r) { return rowToView_(r, user, today); };
  return { sameProduct: sameProduct.map(view), sameCustomer: sameCustomer.map(view) };
}

// ---------- decisions ----------

/** @param {{ids:string[], decision:'Approved'|'Rejected', comment:string}} payload */
function decideRequests(payload) {
  var user = requireRole_(currentUser_(), [ROLE.SUPERVISOR, ROLE.ADMIN]);
  var decision = payload.decision;
  if (decision !== STATUS.APPROVED && decision !== STATUS.REJECTED) throw new Error('คำสั่งไม่ถูกต้อง');
  var comment = String(payload.comment || '').trim();
  if (decision === STATUS.REJECTED && !comment) throw new Error('กรุณาใส่เหตุผลที่ไม่อนุมัติ');
  var ids = (payload.ids || []).map(String);
  if (!ids.length) throw new Error('กรุณาเลือกรายการ');

  var today = startOfDay_(new Date());
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var changed;
  try {
    var now = new Date();
    changed = readTable_(SHEET.REQUESTS).rows.filter(function (r) {
      return ids.indexOf(String(r.ReqId)) !== -1 && r.Status === STATUS.PENDING;
    });
    changed.forEach(function (r) {
      r.Status = decision;
      r.DecidedBy = user.email;
      r.DecidedAt = now;
      r.DecisionComment = comment;
    });
    updateObjects_(SHEET.REQUESTS, changed);
  } finally {
    lock.releaseLock();
  }
  var done = changed.map(function (r) { return String(r.ReqId); });
  log_(user.email, decision === STATUS.APPROVED ? 'APPROVE' : 'REJECT', done, comment);
  notifyDecided_(changed, user);
  return {
    updated: done,
    skipped: ids.filter(function (id) { return done.indexOf(id) === -1; }),
    lines: changed.map(function (r) { return rowToView_(r, user, today); })
  };
}

/** Requester withdraws their own pending lines. */
function cancelMyRequests(ids) {
  var user = currentUser_();
  ids = (ids || []).map(String);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var changed;
  try {
    var now = new Date();
    changed = readTable_(SHEET.REQUESTS).rows.filter(function (r) {
      return ids.indexOf(String(r.ReqId)) !== -1 && r.Status === STATUS.PENDING &&
        String(r.Requester).toLowerCase() === user.email;
    });
    changed.forEach(function (r) {
      r.Status = STATUS.CANCELLED;
      r.DecidedBy = user.email;
      r.DecidedAt = now;
      r.DecisionComment = 'ยกเลิกโดยผู้ขอ';
    });
    updateObjects_(SHEET.REQUESTS, changed);
  } finally {
    lock.releaseLock();
  }
  var done = changed.map(function (r) { return String(r.ReqId); });
  log_(user.email, 'CANCEL', done, '');
  return { updated: done };
}
