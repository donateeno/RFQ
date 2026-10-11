/**
 * Supervisor dashboard numbers.
 */

function getDashboard(filter) {
  var user = requireRole_(currentUser_(), [ROLE.SUPERVISOR, ROLE.ADMIN]);
  filter = filter || {};
  var today = startOfDay_(new Date());
  var to = parseIsoDate_(filter.to) || today;
  var from = parseIsoDate_(filter.from) || addDays_(to, -29);
  var toExcl = addDays_(to, 1);
  var all = readTable_(SHEET.REQUESTS).rows;
  var inRange = all.filter(function (r) {
    if (filter.channel && r.Channel !== filter.channel) return false;
    return r.RequestedAt instanceof Date && r.RequestedAt >= from && r.RequestedAt < toExcl;
  });

  function avgMu(rows) {
    if (!user.canSeeCost) return null;
    var mus = rows.map(function (r) { return toNumber_(r.MU); }).filter(function (m) { return m !== null && m > -1; });
    if (!mus.length) return null;
    return round_(mus.reduce(function (a, b) { return a + b; }, 0) / mus.length, 4);
  }
  function count(rows, status) { return rows.filter(function (r) { return r.Status === status; }).length; }
  function group(rows, keyFn) {
    var g = {};
    rows.forEach(function (r) { var k = keyFn(r); (g[k] = g[k] || []).push(r); });
    return g;
  }
  var low = [INDICATOR.VERY_LOW, INDICATOR.LOSS];
  var approved = inRange.filter(function (r) { return r.Status === STATUS.APPROVED; });

  var indicatorOrder = [INDICATOR.OKAY, INDICATOR.LOW, INDICATOR.VERY_LOW, INDICATOR.LOSS, INDICATOR.NO_COST];
  var byInd = group(inRange, function (r) { return r.Indicator || INDICATOR.NO_COST; });
  var byIndicator = indicatorOrder.map(function (k) {
    var rows = byInd[k] || [];
    return { indicator: k, total: rows.length, approved: count(rows, STATUS.APPROVED) };
  });

  var chName = {};
  getChannels_().forEach(function (c) { chName[c.id] = c.name; });
  var byCh = group(inRange, function (r) { return r.Channel; });
  var byChannel = Object.keys(byCh).map(function (k) {
    var rows = byCh[k];
    return {
      channel: k, name: chName[k] || k, total: rows.length,
      approved: count(rows, STATUS.APPROVED),
      avgMu: avgMu(rows.filter(function (r) { return r.Status === STATUS.APPROVED; }))
    };
  }).sort(function (a, b) { return b.total - a.total; });

  var byReq = group(inRange, function (r) { return String(r.Requester || '(ไม่ระบุ)'); });
  var byRequester = Object.keys(byReq).map(function (k) {
    var rows = byReq[k];
    return {
      email: k, total: rows.length,
      pending: count(rows, STATUS.PENDING),
      approved: count(rows, STATUS.APPROVED),
      rejected: count(rows, STATUS.REJECTED),
      lowCount: rows.filter(function (r) { return low.indexOf(r.Indicator) !== -1; }).length,
      avgMu: avgMu(rows)
    };
  }).sort(function (a, b) { return b.total - a.total; });

  var months = [];
  for (var i = 5; i >= 0; i--) {
    var m0 = new Date(today.getFullYear(), today.getMonth() - i, 1);
    var m1 = new Date(today.getFullYear(), today.getMonth() - i + 1, 1);
    var rows = all.filter(function (r) {
      if (filter.channel && r.Channel !== filter.channel) return false;
      return r.RequestedAt instanceof Date && r.RequestedAt >= m0 && r.RequestedAt < m1;
    });
    months.push({
      month: Utilities.formatDate(m0, TIMEZONE, 'yyyy-MM'),
      total: rows.length,
      approved: count(rows, STATUS.APPROVED),
      avgMu: avgMu(rows.filter(function (r) { return r.Status === STATUS.APPROVED; }))
    });
  }

  var soon = addDays_(today, 7);
  var view = function (r) { return rowToView_(r, user, today); };
  var expiringRows = all.filter(function (r) {
    return r.Status === STATUS.APPROVED && r.EndDate instanceof Date &&
      startOfDay_(r.EndDate) >= today && startOfDay_(r.EndDate) <= soon &&
      (!filter.channel || r.Channel === filter.channel);
  }).sort(function (a, b) { return a.EndDate - b.EndDate; });
  var expiring = expiringRows.slice(0, 50).map(view);
  var riskyRows = sortNewestFirst_(approved.filter(function (r) { return low.indexOf(r.Indicator) !== -1; }));
  var risky = riskyRows.slice(0, 50).map(view);

  return {
    from: fmtDate_(from),
    to: fmtDate_(to),
    kpis: {
      total: inRange.length,
      pendingNow: all.filter(function (r) {
        return r.Status === STATUS.PENDING && (!filter.channel || r.Channel === filter.channel);
      }).length,
      approved: approved.length,
      rejected: count(inRange, STATUS.REJECTED),
      avgMuApproved: avgMu(approved),
      riskyApproved: riskyRows.length,
      expiringSoon: expiringRows.length
    },
    byIndicator: byIndicator,
    byChannel: byChannel,
    byRequester: byRequester,
    byMonth: months,
    expiring: expiring,
    risky: risky
  };
}
