(function () {
  'use strict';

  // ================= helpers =================
  var S = {
    boot: null, route: '', items: {}, chIndex: {},
    pc: null, cart: null, mine: null, mineFilter: { status: '', q: '' },
    appr: null, sel: {}, mon: null, monFilter: { status: '', group: '', channel: '', indicator: '', q: '', from: '', to: '' },
    dashFilter: { from: '', to: '', group: '' }, ap: { q: '', group: '', includeExpired: false, rows: null }
  };

  function run(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return fetch('/api/rpc/' + fn, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-RFQ': '1' },
      body: JSON.stringify({ args: args })
    }).then(function (r) {
      if (r.status === 401) { location.href = '/login' + location.hash; throw new Error('กรุณาเข้าสู่ระบบ'); }
      return r.json().catch(function () { throw new Error('เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (HTTP ' + r.status + ')'); });
    }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'เกิดข้อผิดพลาด');
      return r.data;
    });
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n, dp) {
    if (n === null || n === undefined || n === '' || isNaN(n)) return '–';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: dp === undefined ? 0 : dp, maximumFractionDigits: 2 });
  }
  function pct(n, dp) {
    if (n === null || n === undefined || n === '' || isNaN(n)) return '–';
    return (Number(n) * 100).toFixed(dp === undefined ? 2 : dp) + '%';
  }
  function pctInput(frac) { return frac ? String(Math.round(frac * 10000) / 100) : '0'; }
  function fromPctInput(s) { var n = Number(String(s).replace('%', '').trim()); return isNaN(n) ? NaN : n / 100; }
  function dateTh(iso) {
    if (!iso) return '–';
    var d = iso.length > 10 ? new Date(iso) : null;
    var y, m, dd;
    if (d) {
      var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).split('-');
      y = parts[0]; m = parts[1]; dd = parts[2];
    } else {
      var p = iso.split('-'); y = p[0]; m = p[1]; dd = p[2];
    }
    return dd + '/' + m + '/' + y.substring(2);
  }
  function addDaysIso(iso, n) {
    var p = iso.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return d.toISOString().slice(0, 10);
  }
  function debounce(fn, ms) {
    var t;
    return function () { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms); };
  }
  function toast(msg, isErr) {
    var el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, isErr ? 6000 : 3000);
  }
  function fail(e) { toast(e && e.message ? e.message : String(e), true); }
  function cssEsc(s) { return String(s).replace(/(["\\])/g, '\\$1'); }
  function num(s) { return Number(String(s).replace(/,/g, '')); }

  var IND = {
    'OKAY': { cls: 'OKAY', icon: '✓', msg: 'กำไรอยู่ในเกณฑ์ดี' },
    'LOW': { cls: 'LOW', icon: '!', msg: 'กำไรค่อนข้างต่ำ' },
    'VERY LOW': { cls: 'VERY_LOW', icon: '!!', msg: 'กำไรต่ำมาก — ควรทบทวนราคา' },
    'ขาดทุน': { cls: 'LOSS', icon: '✕', msg: 'ต่ำกว่าเกณฑ์ขั้นต่ำ — โอกาสอนุมัติน้อย' },
    'NO COST': { cls: 'NO_COST', icon: '?', msg: 'ไม่มีข้อมูลต้นทุน — หัวหน้าจะพิจารณาเอง' }
  };
  function indInfo(ind) { return IND[ind] || IND['NO COST']; }
  function indBadge(ind) {
    if (!ind) return '<span class="muted">–</span>';
    var i = indInfo(ind);
    return '<span class="ind ' + i.cls + '"><span class="dot">' + i.icon + '</span>' + esc(ind) + '</span>';
  }
  var STATUS_TH = { Pending: 'รออนุมัติ', Approved: 'อนุมัติ', Rejected: 'ไม่อนุมัติ', Cancelled: 'ยกเลิก', Expired: 'หมดอายุ', Closed: 'ปิด (เดิม)' };
  function statusBadge(s) { return '<span class="status ' + esc(s) + '">' + esc(STATUS_TH[s] || s) + '</span>'; }
  function flagsHtml(f) {
    if (!f) return '';
    return f.split(';').map(function (x) { x = x.trim(); return x ? '<span class="flag' + (x.indexOf('นำเข้า') === 0 ? '' : ' warn') + '">' + esc(x) + '</span>' : ''; }).join('');
  }
  function canApprove() { return S.boot && S.boot.user.canApprove; }
  function canSeeCost() { return S.boot && S.boot.user.canSeeCost; }
  /** % MU cell: exact for the cost viewer, the band for supervisors */
  function muCell(r) { return canSeeCost() ? '<b>' + pct(r.mu) + '</b>' : '<span class="band">' + esc(r.muBand || '–') + '</span>'; }
  function muHead() { return canSeeCost() ? '%MU' : 'ช่วง MU'; }
  function itemTags(it) {
    if (!it) return '';
    return (it.nw ? '<span class="tag new">ใหม่</span>' : '') + (it.bundle ? '<span class="tag new">ชุดเซ็ต</span>' : '') +
      (it.up ? '<span class="tag up">ราคาใหม่ ' + money(it.up) + '</span>' : '') + (it.ux ? '<span class="tag up">เลิกขายรอบหน้า</span>' : '');
  }
  function priceListBanner() {
    var pl = S.boot.priceLists || {};
    var up = Object.keys(pl).filter(function (b) { return pl[b].upcoming; }).map(function (b) {
      return esc(b) + ': รอบ <b>' + esc(pl[b].upcoming.name) + '</b> มีผล ' + dateTh(pl[b].upcoming.effectiveFrom);
    });
    var cur = Object.keys(pl).filter(function (b) { return pl[b].current; }).map(function (b) { return esc(b) + ' ' + esc(pl[b].current.name); });
    return (up.length ? '<div class="banner">ราคาตั้งรอบใหม่กำลังจะมีผล — ' + up.join(' · ') + ' · รายการที่ราคาเปลี่ยนจะมีป้าย <span class="tag up">ราคาใหม่</span></div>' : '') +
      (cur.length ? '<p class="hint" style="margin:-8px 0 12px">รอบราคาปัจจุบัน: ' + cur.join(' · ') + '</p>' : '');
  }

  // ----- catalog
  function channel(id) { return S.chIndex[id] && S.chIndex[id].channel; }
  function groupOf(channelId) { return S.chIndex[channelId] && S.chIndex[channelId].group; }
  function group(id) { return S.boot.groups.filter(function (g) { return g.id === id; })[0]; }
  function channelName(id) { var c = channel(id); return c ? c.name : id; }
  /** datalist id + lookup map key for a channel's items */
  function itemSet(chId) {
    var g = groupOf(chId), c = channel(chId);
    if (!g || !c) return '';
    return g.costSource === 'PRODUCT' ? 'P-' + c.brand : (g.costSource === 'PROJECT' ? 'J-' : 'L-') + g.id;
  }
  function item(chId, key) { var set = S.items[itemSet(chId)]; return key && set ? set[String(key).trim().toUpperCase()] : null; }
  function keyLabel(ch) { return ch.keyLabel || 'สินค้า'; }
  function normalLabel(chId) { return groupOf(chId).costSource === 'LANDED' ? 'ราคาแนะนำ' : 'ปกติ'; }
  function defaultDiscs(ch) { return ch.discounts.map(function (d) { return pctInput(d.default); }); }
  function discText(r) {
    var labels = r.discountLabels && r.discountLabels.length ? r.discountLabels : (channel(r.channel) ? channel(r.channel).discounts.map(function (d) { return d.label; }) : []);
    var parts = [];
    (r.discounts || []).forEach(function (d, i) { if (labels[i]) parts.push(pct(d, d * 100 % 1 ? 2 : 0)); });
    return parts.join(' + ') || '–';
  }
  function groupChip(r) { var g = group(r.groupId); return '<span class="group-chip">' + esc(g ? g.name : r.groupId) + '</span>'; }

  // ================= shell & routing =================
  function routes() {
    var r = [
      { id: 'check', label: 'ตรวจราคา' },
      { id: 'new', label: 'ขออนุมัติราคา' },
      { id: 'mine', label: 'คำขอของฉัน' },
      { id: 'approved', label: 'ราคาที่อนุมัติแล้ว' },
      { id: 'bundles', label: 'ชุดเซ็ต' }
    ];
    if (canApprove()) {
      r.push({ sep: true });
      r.push({ id: 'approvals', label: 'รออนุมัติ', badge: S.boot.pendingCount });
      r.push({ id: 'monitor', label: 'คำขอทั้งหมด' });
      r.push({ id: 'dashboard', label: 'ภาพรวม' });
    }
    if (S.boot.user.isAdmin) r.push({ id: 'admin', label: 'ตั้งค่า' });
    return r;
  }

  function renderNav() {
    $('#tabs').innerHTML = routes().map(function (r) {
      if (r.sep) return '<span class="sep"></span>';
      return '<a href="#' + r.id + '" data-route="' + r.id + '" class="' + (S.route === r.id ? 'active' : '') + '">' + esc(r.label) +
        (r.badge ? ' <span class="badge">' + r.badge + '</span>' : '') + '</a>';
    }).join('');
    $$('#tabs a').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); go(a.getAttribute('data-route')); });
    });
  }

  function go(route) {
    var ids = routes().filter(function (r) { return r.id; }).map(function (r) { return r.id; });
    if (ids.indexOf(route) === -1) route = 'check';
    S.route = route;
    history.replaceState(null, '', '#' + route);
    renderNav();
    $('#actionbar').classList.remove('show');
    window.scrollTo(0, 0);
    ({ check: viewCheck, 'new': viewNew, mine: viewMine, approved: viewApproved, bundles: viewBundles,
      approvals: viewApprovals, monitor: viewMonitor, dashboard: viewDashboard, admin: viewAdmin })[route]();
  }

  function boot() {
    run('getBootstrap').then(function (b) {
      S.boot = b;
      b.groups.forEach(function (g) { g.channels.forEach(function (c) { S.chIndex[c.id] = { group: g, channel: c }; }); });
      var lists = {};
      function add(set, k, n, p, extra) {
        var e = { k: k, n: n || k, p: p };
        if (extra) Object.keys(extra).forEach(function (x) { e[x] = extra[x]; });
        (S.items[set] = S.items[set] || {})[String(k).toUpperCase()] = e;
        var tags = (e.nw ? ' · ใหม่' : '') + (e.bundle ? ' · ชุดเซ็ต' : '') + (e.up ? ' · ราคาใหม่ ' + money(e.up) : '') + (e.ux ? ' · เลิกขายรอบหน้า' : '');
        (lists[set] = lists[set] || []).push('<option value="' + esc(k) + '">' + (n && n !== k ? esc(n) + ' · ' : '') + (p ? money(p) + ' ฿' : '') + esc(tags) + '</option>');
      }
      b.products.forEach(function (p) { add('P-' + p.b, p.k, p.n, p.p, { nw: p.nw, up: p.up, ux: p.ux }); });
      b.bundles.forEach(function (x) { add('P-' + x.b, x.k, x.n, x.p, { bundle: true }); });
      b.projects.forEach(function (p) { add('J-' + p.g, p.k, p.n, p.p); });
      b.landed.forEach(function (p) { add('L-' + p.g, p.k, p.n, p.p); });
      S.lists = lists;
      $('#datalists').innerHTML = Object.keys(lists).map(function (k) { return '<datalist id="dl-' + esc(k) + '">' + lists[k].join('') + '</datalist>'; }).join('');
      $('#dl-customers').innerHTML = (b.customers || []).map(function (c) { return '<option value="' + esc(c) + '">'; }).join('');
      $('#who').innerHTML = esc(b.user.name) + '<span class="role-chip">' + esc(b.user.role) + '</span><br><span class="em">' + esc(b.user.email) + '</span>' +
        ' <button class="logout" id="logout">ออกจากระบบ</button>';
      $('#logout').addEventListener('click', function () {
        fetch('/auth/logout', { method: 'POST', headers: { 'X-RFQ': '1' } }).then(function () { location.href = '/login'; });
      });
      go(location.hash.replace('#', '') || (canApprove() && b.pendingCount ? 'approvals' : 'check'));
    }).catch(function (e) {
      $('#view').innerHTML = '<div class="gate card"><h1>เข้าใช้งานไม่ได้</h1><p class="sub">' + esc(e.message) + '</p></div>';
    });
  }

  function page(title, sub, actions) {
    return '<div class="page-head"><div><h1>' + esc(title) + '</h1>' + (sub ? '<p class="sub">' + sub + '</p>' : '') + '</div>' +
      (actions ? '<div class="row">' + actions + '</div>' : '') + '</div>';
  }

  /** Price group row + channel row. onPick(channelId) */
  function pickerHtml(id, channelId) {
    var g = groupOf(channelId);
    var ch = channel(channelId);
    return '<div class="picker" id="' + id + '">' +
      '<div><span class="label">กลุ่มราคา (Price group)</span><div class="seg groups">' + S.boot.groups.map(function (x) {
        return '<button type="button" data-grp="' + esc(x.id) + '" class="' + (x.id === g.id ? 'on' : '') + '" title="' + esc(x.description) + '">' + esc(x.name) + '</button>';
      }).join('') + '</div></div>' +
      '<div><span class="label">ช่องทาง</span><div class="seg">' + g.channels.map(function (c) {
        return '<button type="button" data-ch="' + esc(c.id) + '" class="' + (c.id === channelId ? 'on' : '') + '" title="' + esc(c.description) + '">' + esc(c.name) + '</button>';
      }).join('') + '</div><div class="ch-desc">' + esc(ch.description || g.description) + '</div></div></div>';
  }
  function bindPicker(id, onPick) {
    $$('#' + id + ' [data-grp]').forEach(function (b) {
      b.addEventListener('click', function () { onPick(group(b.getAttribute('data-grp')).channels[0].id); });
    });
    $$('#' + id + ' [data-ch]').forEach(function (b) {
      b.addEventListener('click', function () { onPick(b.getAttribute('data-ch')); });
    });
  }

  function discountInputs(ch, values, prefix) {
    return ch.discounts.map(function (d, i) {
      var hint = d.editable ? (d.min ? 'ขั้นต่ำ ' + pctInput(d.min) + '%' : '') : 'กำหนดโดยช่องทาง';
      return '<div class="field"><label>' + esc(d.label) + '</label><div class="pct-wrap"><input type="text" inputmode="decimal" class="num" data-' + prefix + '-disc="' + i + '" value="' + esc(values[i]) + '"' + (d.editable ? '' : ' disabled') + '></div>' +
        '<span class="hint">' + esc(hint) + '</span></div>';
    }).join('');
  }

  function firstChannelId() { return S.boot.groups[0].channels[0].id; }

  // ================= Price check =================
  function viewCheck() {
    if (!S.pc || !channel(S.pc.channelId)) {
      var c0 = channel(firstChannelId());
      S.pc = { channelId: c0.id, productKey: '', special: '', discs: defaultDiscs(c0), result: null, busy: false };
    }
    var ch = channel(S.pc.channelId);
    $('#view').innerHTML = page('ตรวจราคา', 'ใส่ราคาที่จะเสนอลูกค้า ระบบจะบอกทันทีว่าราคานี้อยู่ในเกณฑ์หรือไม่ (ยังไม่บันทึก)') + priceListBanner() +
      '<div class="grid-2"><div class="card">' + pickerHtml('pc-pick', ch.id) +
      '<div class="field"><label for="pc-prod">' + esc(keyLabel(ch)) + '</label><input type="search" id="pc-prod" list="dl-' + esc(itemSet(ch.id)) + '" autocomplete="off" placeholder="พิมพ์เพื่อค้นหา…" value="' + esc(S.pc.productKey) + '"><div class="hint" id="pc-prod-info"></div></div>' +
      '<div class="fields prices" style="--n:' + (ch.discounts.length + 1) + '">' +
      '<div class="field"><label for="pc-special">ราคาพิเศษสุทธิ (รวม VAT)</label><input type="text" inputmode="decimal" class="num" id="pc-special" value="' + esc(S.pc.special) + '" placeholder="0"><span class="hint"></span></div>' +
      discountInputs(ch, S.pc.discs, 'pc') +
      '</div>' +
      '<div class="row end" style="margin-top:16px"><button class="btn primary" id="pc-add">+ ใช้ราคานี้ขออนุมัติ</button></div>' +
      '</div><div class="card"><div id="pc-result"></div></div></div>';

    bindPicker('pc-pick', function (id) {
      if (itemSet(id) !== itemSet(S.pc.channelId)) S.pc.productKey = '';
      S.pc.channelId = id; S.pc.discs = defaultDiscs(channel(id)); S.pc.result = null;
      viewCheck(); check();
    });
    $('#pc-prod').addEventListener('input', function (e) { S.pc.productKey = e.target.value; prodInfo(); check(); });
    $('#pc-special').addEventListener('input', function (e) { S.pc.special = e.target.value; check(); });
    $$('[data-pc-disc]').forEach(function (inp) {
      inp.addEventListener('input', function () { S.pc.discs[Number(inp.getAttribute('data-pc-disc'))] = inp.value; check(); });
    });
    $('#pc-add').addEventListener('click', function () {
      if (!S.pc.productKey) return toast('กรุณาเลือก' + keyLabel(ch), true);
      startCart(S.pc.channelId);
      var empty = S.cart.lines.filter(function (l) { return !l.productKey; })[0];
      var line = empty || newLine(channel(S.pc.channelId));
      line.productKey = S.pc.productKey; line.special = S.pc.special; line.discs = S.pc.discs.slice(); line.result = S.pc.result;
      if (!empty) S.cart.lines.push(line);
      go('new');
      toast('เพิ่มลงคำขอแล้ว — กรอกข้อมูลลูกค้าแล้วกดส่ง');
    });
    prodInfo();
    renderPcResult();

    function prodInfo() {
      var p = item(ch.id, S.pc.productKey);
      $('#pc-prod-info').innerHTML = p
        ? (p.n !== p.k ? esc(p.n) + ' · ' : '') + (p.p ? normalLabel(ch.id) + ' <b>' + money(p.p) + '</b> ฿' : '') + itemTags(p)
        : (S.pc.productKey ? '<span style="color:var(--danger)">ไม่พบในรายการราคาปัจจุบัน</span>' : '');
    }
  }

  var check = debounce(function () {
    var pc = S.pc;
    var special = num(pc.special);
    if (!pc.productKey || !(special > 0)) { pc.result = null; renderPcResult(); return; }
    var discs = pc.discs.map(fromPctInput);
    if (discs.some(function (d) { return isNaN(d); })) { pc.result = { error: 'ส่วนลดต้องเป็นตัวเลข' }; renderPcResult(); return; }
    pc.busy = true; renderPcResult();
    var payload = { channelId: pc.channelId, productKey: pc.productKey, specialPrice: special, discounts: discs };
    var stamp = JSON.stringify(payload);
    pc.stamp = stamp;
    run('priceCheck', payload).then(function (res) {
      if (pc.stamp !== stamp) return;
      pc.busy = false; pc.result = res; renderPcResult();
    }).catch(function (e) {
      if (pc.stamp !== stamp) return;
      pc.busy = false; pc.result = { error: e.message }; renderPcResult();
    });
  }, 450);

  function offerVsNormal(normal) {
    var diff = 1 - num(S.pc.special) / normal;
    if (Math.abs(diff) < 0.0005) return 'เท่ากับราคา' + normalLabel(S.pc.channelId);
    return 'ราคาที่เสนอ' + (diff > 0 ? 'ต่ำกว่า' : 'สูงกว่า') + normalLabel(S.pc.channelId) + ' ' + pct(Math.abs(diff), 1);
  }

  function renderPcResult() {
    var box = $('#pc-result');
    if (!box) return;
    var r = S.pc.result;
    var scale = '<div class="scale">' + ['OKAY', 'LOW', 'VERY LOW', 'ขาดทุน'].map(indBadge).join('') + '</div>';
    if (S.pc.busy && !r) { box.innerHTML = '<div class="result"><span class="spin"></span></div>'; return; }
    if (!r) { box.innerHTML = '<div class="result"><div class="msg">เลือกรายการและใส่ราคาเพื่อดูผล</div>' + scale + '</div>'; return; }
    if (r.error) { box.innerHTML = '<div class="result"><div class="msg" style="color:var(--danger)">' + esc(r.error) + '</div></div>'; return; }
    var i = indInfo(r.indicator);
    var html = '<div class="result ' + i.cls + '">' +
      '<div class="big"><span class="dot">' + i.icon + '</span>' + esc(r.indicator) + (S.pc.busy ? ' <span class="spin"></span>' : '') + '</div>' +
      '<div class="msg">' + esc(i.msg) + '</div>' +
      (r.normalPrice ? '<div class="msg">ราคา' + normalLabel(S.pc.channelId) + ' ' + money(r.normalPrice) + ' ฿ · ' + offerVsNormal(r.normalPrice) + '</div>' : '') +
      (r.priceList ? '<div class="msg hint">ราคารอบ ' + esc(r.priceList.name) + (r.isNew ? ' <span class="tag new">สินค้าใหม่</span>' : '') + '</div>' : '') +
      (r.upcoming ? '<div class="msg"><span class="tag up">รอบ ' + esc(r.upcoming.name) + ' มีผล ' + dateTh(r.upcoming.effectiveFrom) + '</span> ' +
        (r.upcoming.discontinued ? 'ไม่มีสินค้านี้ในรอบใหม่' : 'ราคา' + normalLabel(S.pc.channelId) + 'ใหม่ ' + money(r.upcoming.normalPrice) + ' ฿') + '</div>' : '') +
      (r.flags && r.flags.length ? '<div>' + r.flags.map(function (f) { return '<span class="flag warn">' + esc(f) + '</span>'; }).join('') + '</div>' : '') +
      '</div>';
    if (canApprove() && r.netExVat !== undefined) {
      html += '<dl class="kv"><dt>สุทธิหลังส่วนลด (รวม VAT)</dt><dd>' + money(r.netIncVat, 2) + '</dd>' +
        '<dt>สุทธิ (ไม่รวม VAT)</dt><dd>' + money(r.netExVat, 2) + '</dd>' +
        (canSeeCost() ? '<dt>ต้นทุน / หน่วย</dt><dd>' + money(r.cost, 2) + '</dd><dt>กำไร (Gain)</dt><dd>' + money(r.gain, 2) + '</dd><dt>%MU</dt><dd>' + pct(r.mu) + '</dd>'
          : '<dt>ช่วง MU</dt><dd>' + esc(r.muBand || '–') + '</dd>') + '</dl>';
    }
    box.innerHTML = html + scale;
  }

  // ================= New request =================
  function newLine(ch) { return { productKey: '', qty: '1', special: '', discs: defaultDiscs(ch), result: null }; }
  function startCart(channelId) {
    if (S.cart && S.cart.channelId === channelId) return;
    var keep = S.cart || {};
    var keepLines = S.cart && itemSet(S.cart.channelId) === itemSet(channelId);
    S.cart = {
      channelId: channelId, customer: keep.customer || '', project: keep.project || '', note: keep.note || '',
      start: keep.start || S.boot.today, end: keep.end || addDaysIso(S.boot.today, S.boot.settings.defaultValidityDays),
      lines: keepLines ? S.cart.lines.map(function (l) { l.discs = defaultDiscs(channel(channelId)); l.result = null; return l; }) : []
    };
  }

  function viewNew() {
    if (!S.cart || !channel(S.cart.channelId)) startCart(firstChannelId());
    if (!S.cart.lines.length) S.cart.lines.push(newLine(channel(S.cart.channelId)));
    var c = S.cart, ch = channel(c.channelId);
    var maxEnd = addDaysIso(c.start || S.boot.today, S.boot.settings.maxValidityDays);
    $('#view').innerHTML = page('ขออนุมัติราคาพิเศษ', 'ส่งได้หลายรายการต่อครั้ง ทุกคำขอต้องได้รับอนุมัติจากหัวหน้า') + priceListBanner() +
      '<div class="card">' + pickerHtml('nr-pick', ch.id) +
      '<div class="fields head">' +
      '<div class="field"><label class="req" for="nr-cust">ชื่อคู่ค้า / ร้านค้า / ลูกค้า</label><input type="text" id="nr-cust" list="dl-customers" value="' + esc(c.customer) + '"></div>' +
      '<div class="field"><label for="nr-proj">สาขา / ชื่อโครงการ / แคมเปญ</label><input type="text" id="nr-proj" value="' + esc(c.project) + '"></div>' +
      '<div class="field"><label for="nr-start">เริ่มราคาพิเศษ</label><input type="date" id="nr-start" min="' + S.boot.today + '" value="' + esc(c.start) + '"></div>' +
      '<div class="field"><label for="nr-end">สิ้นสุด</label><input type="date" id="nr-end" min="' + esc(c.start) + '" max="' + maxEnd + '" value="' + esc(c.end) + '"></div>' +
      '<div class="field wide"><label for="nr-note">หมายเหตุ / #Tag</label><input type="text" id="nr-note" placeholder="เช่น ส่งครั้งเดียว, แบ่งส่ง 2 ครั้ง, ลูกค้าเก่า" value="' + esc(c.note) + '">' +
      '<span class="hint">ราคาพิเศษใช้ได้ ' + S.boot.settings.defaultValidityDays + ' วันโดยค่าเริ่มต้น · สูงสุด ' + S.boot.settings.maxValidityDays + ' วัน</span></div>' +
      '</div></div>' +
      '<div class="card" style="--disc-count:' + ch.discounts.length + '"><h2>รายการ</h2>' +
      '<div class="line-head"><span>' + esc(keyLabel(ch)) + '</span><span>จำนวน</span><span>ราคาพิเศษ (รวม VAT)</span>' +
      ch.discounts.map(function (d) { return '<span>' + esc(d.label) + '</span>'; }).join('') + '<span>Indicator</span></div>' +
      '<div id="nr-lines">' + c.lines.map(function (l, i) { return lineHtml(ch, l, i); }).join('') + '</div>' +
      '<div class="row" style="margin-top:12px"><button class="btn" id="nr-addline">+ เพิ่มรายการ</button><span class="spacer"></span>' +
      '<button class="btn ghost" id="nr-clear">ล้างทั้งหมด</button><button class="btn primary" id="nr-submit">ส่งขออนุมัติ</button></div></div>';

    bindPicker('nr-pick', function (id) {
      if (id === c.channelId) return;
      var hasLines = c.lines.some(function (l) { return l.productKey; });
      if (hasLines && itemSet(id) !== itemSet(c.channelId) && !confirm('ช่องทางนี้ใช้รายการสินค้าคนละชุด รายการที่กรอกไว้จะถูกล้าง ต้องการต่อหรือไม่?')) return;
      startCart(id);
      viewNew();
      S.cart.lines.forEach(function (l, i) { lineCheck(i); });
    });
    bindVal('#nr-cust', 'customer'); bindVal('#nr-proj', 'project'); bindVal('#nr-note', 'note');
    $('#nr-start').addEventListener('change', function (e) {
      c.start = e.target.value;
      if (!c.end || c.end < c.start) c.end = addDaysIso(c.start, S.boot.settings.defaultValidityDays);
      viewNew();
    });
    bindVal('#nr-end', 'end');
    $('#nr-addline').addEventListener('click', function () { c.lines.push(newLine(ch)); viewNew(); var last = $$('[data-l-prod]').pop(); if (last) last.focus(); });
    $('#nr-clear').addEventListener('click', function () { if (confirm('ล้างข้อมูลทั้งหมด?')) { S.cart = null; viewNew(); } });
    $('#nr-submit').addEventListener('click', submitCart);
    bindLines(ch);

    function bindVal(sel, key) { $(sel).addEventListener('input', function (e) { c[key] = e.target.value; }); }
  }

  function lineHtml(ch, l, i) {
    var discs = ch.discounts.map(function (d, j) {
      return '<div class="field"><span class="label">' + esc(d.label) + '</span><div class="pct-wrap"><input type="text" inputmode="decimal" class="num" data-l-disc="' + i + ':' + j + '" value="' + esc(l.discs[j]) + '"' + (d.editable ? '' : ' disabled') + '></div></div>';
    }).join('');
    return '<div class="line" data-line="' + i + '">' +
      '<div class="field prod"><span class="label">' + esc(keyLabel(ch)) + '</span><input type="search" list="dl-' + esc(itemSet(ch.id)) + '" autocomplete="off" data-l-prod="' + i + '" value="' + esc(l.productKey) + '" placeholder="พิมพ์เพื่อค้นหา…"><div class="np" id="np-' + i + '">' + npText(ch, l) + '</div></div>' +
      '<div class="field"><span class="label">จำนวน</span><input type="text" inputmode="numeric" class="num" data-l-qty="' + i + '" value="' + esc(l.qty) + '"></div>' +
      '<div class="field"><span class="label">ราคาพิเศษ (รวม VAT)</span><input type="text" inputmode="decimal" class="num" data-l-special="' + i + '" value="' + esc(l.special) + '"></div>' +
      discs +
      '<div class="line-end"><div class="ind-cell" id="li-' + i + '">' + lineInd(l) + '</div>' +
      '<button class="icon-btn" data-l-del="' + i + '" title="ลบรายการ">✕</button></div></div>';
  }
  function npText(ch, l) {
    var p = item(ch.id, l.productKey);
    if (p) return (p.n !== p.k ? esc(p.n) + ' · ' : '') + (p.p ? normalLabel(ch.id) + ' ' + money(p.p) + ' ฿' : '') + itemTags(p);
    return l.productKey ? '<span style="color:var(--danger)">ไม่พบในรายการราคาปัจจุบัน (จะส่งแบบไม่มีต้นทุน)</span>' : '';
  }
  function lineInd(l) {
    if (l.busy) return '<span class="spin"></span>';
    if (!l.result) return '<span class="muted">–</span>';
    if (l.result.error) return '<span class="flag warn">' + esc(l.result.error) + '</span>';
    return indBadge(l.result.indicator) + (canSeeCost() && l.result.mu !== undefined ? '<div class="muted">MU ' + pct(l.result.mu) + '</div>'
      : (canApprove() && l.result.muBand ? '<div class="muted">' + esc(l.result.muBand) + '</div>' : ''));
  }

  var lineTimers = {};
  function lineCheck(i) {
    clearTimeout(lineTimers[i]);
    lineTimers[i] = setTimeout(function () {
      var c = S.cart, l = c && c.lines[i];
      if (!l) return;
      var special = num(l.special);
      if (!l.productKey || !(special > 0)) { l.result = null; paint(); return; }
      var discs = l.discs.map(fromPctInput);
      if (discs.some(function (d) { return isNaN(d); })) { l.result = { error: 'ส่วนลดต้องเป็นตัวเลข' }; paint(); return; }
      var stamp = JSON.stringify([c.channelId, l.productKey, special, discs]);
      l.stamp = stamp; l.busy = true; paint();
      run('priceCheck', { channelId: c.channelId, productKey: l.productKey, specialPrice: special, discounts: discs })
        .then(function (res) { if (l.stamp === stamp) { l.busy = false; l.result = res; paint(); } })
        .catch(function (e) { if (l.stamp === stamp) { l.busy = false; l.result = { error: e.message }; paint(); } });
      function paint() { var el = $('#li-' + i); if (el && S.cart && S.cart.lines[i] === l) el.innerHTML = lineInd(l); }
    }, 450);
  }

  function bindLines(ch) {
    var c = S.cart;
    $$('[data-l-prod]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var i = Number(inp.getAttribute('data-l-prod')); c.lines[i].productKey = inp.value;
        $('#np-' + i).innerHTML = npText(ch, c.lines[i]);
        lineCheck(i);
      });
    });
    $$('[data-l-qty]').forEach(function (inp) {
      inp.addEventListener('input', function () { c.lines[Number(inp.getAttribute('data-l-qty'))].qty = inp.value; });
    });
    $$('[data-l-special]').forEach(function (inp) {
      inp.addEventListener('input', function () { var i = Number(inp.getAttribute('data-l-special')); c.lines[i].special = inp.value; lineCheck(i); });
    });
    $$('[data-l-disc]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var p = inp.getAttribute('data-l-disc').split(':').map(Number);
        c.lines[p[0]].discs[p[1]] = inp.value; lineCheck(p[0]);
      });
    });
    $$('[data-l-del]').forEach(function (b) {
      b.addEventListener('click', function () { c.lines.splice(Number(b.getAttribute('data-l-del')), 1); viewNew(); });
    });
  }

  function submitCart() {
    var c = S.cart, ch = channel(c.channelId);
    if (!c.customer.trim()) { toast('กรุณาใส่ชื่อคู่ค้า / ร้านค้า', true); $('#nr-cust').focus(); return; }
    var lines = c.lines.filter(function (l) { return l.productKey.trim() || String(l.special).trim(); });
    if (!lines.length) return toast('กรุณาเพิ่มอย่างน้อย 1 รายการ', true);
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!l.productKey.trim()) return toast('รายการที่ ' + (i + 1) + ': กรุณาเลือก' + keyLabel(ch), true);
      if (!(num(l.special) > 0)) return toast('รายการที่ ' + (i + 1) + ': กรุณาใส่ราคาพิเศษ', true);
      if (!/^\d+$/.test(String(l.qty).trim()) || Number(l.qty) < 1) return toast('รายการที่ ' + (i + 1) + ': จำนวนต้องเป็นเลขจำนวนเต็ม', true);
    }
    var unknown = lines.filter(function (l) { return !item(ch.id, l.productKey); }).length;
    if (unknown && !confirm(unknown + ' รายการไม่พบในฐานข้อมูลต้นทุน ต้องการส่งต่อหรือไม่?')) return;
    var btn = $('#nr-submit');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> กำลังส่ง…';
    run('submitRequest', {
      channelId: c.channelId, customer: c.customer, project: c.project, note: c.note, startDate: c.start, endDate: c.end,
      lines: lines.map(function (x) { return { productKey: x.productKey.trim(), qty: Number(x.qty), specialPrice: num(x.special), discounts: x.discs.map(fromPctInput) }; })
    }).then(function (res) {
      S.cart = null; S.mine = null;
      if (canApprove()) { S.boot.pendingCount = (S.boot.pendingCount || 0) + res.lines.length; renderNav(); }
      $('#view').innerHTML = '<div class="card success-box"><div class="tick">✓</div><h1>ส่งคำขอแล้ว</h1>' +
        '<p class="sub">หัวหน้าจะได้รับการแจ้งเตือน และคุณจะได้รับอีเมลเมื่อมีผลการพิจารณา</p>' +
        '<div class="table-wrap" style="margin:16px auto;max-width:640px;text-align:left"><table><thead><tr><th>Req. Id.</th><th>รายการ</th><th class="num">ราคาพิเศษ</th><th>Indicator</th></tr></thead><tbody>' +
        res.lines.map(function (r) { return '<tr><td class="nowrap"><b>' + esc(r.id) + '</b></td><td>' + esc(r.productName) + '</td><td class="num">' + money(r.specialPrice) + '</td><td>' + indBadge(r.indicator) + '</td></tr>'; }).join('') +
        '</tbody></table></div><div class="row" style="justify-content:center"><button class="btn" id="ok-mine">ดูคำขอของฉัน</button><button class="btn primary" id="ok-new">ขออนุมัติรายการใหม่</button></div></div>';
      $('#ok-mine').addEventListener('click', function () { go('mine'); });
      $('#ok-new').addEventListener('click', function () { viewNew(); });
    }).catch(function (e) { fail(e); btn.disabled = false; btn.textContent = 'ส่งขออนุมัติ'; });
  }

  // ================= My requests =================
  function viewMine() {
    $('#view').innerHTML = page('คำขอของฉัน', 'สถานะคำขอทั้งหมดที่คุณส่ง', '<button class="btn small" id="mine-reload">↻ รีเฟรช</button>') +
      '<div class="filters"><div class="chips" id="mine-chips"></div><span class="spacer"></span><input type="search" id="mine-q" placeholder="ค้นหา ลูกค้า / สินค้า / Req. Id." value="' + esc(S.mineFilter.q) + '"></div>' +
      '<div id="mine-list"><div class="loading"><span class="spin"></span></div></div>';
    $('#mine-reload').addEventListener('click', function () { S.mine = null; viewMine(); });
    $('#mine-q').addEventListener('input', debounce(function (e) { S.mineFilter.q = e.target.value; renderMine(); }, 200));
    if (S.mine) return renderMine();
    run('listMyRequests', {}).then(function (rows) { S.mine = rows; renderMine(); }).catch(fail);
  }

  function renderMine() {
    var rows = S.mine || [];
    var counts = {};
    rows.forEach(function (r) { counts[r.displayStatus] = (counts[r.displayStatus] || 0) + 1; });
    $('#mine-chips').innerHTML = [['', 'ทั้งหมด', rows.length]].concat(['Pending', 'Approved', 'Expired', 'Rejected', 'Cancelled', 'Closed']
      .filter(function (s) { return counts[s]; }).map(function (s) { return [s, STATUS_TH[s], counts[s]]; }))
      .map(function (c) { return '<button class="chip' + (S.mineFilter.status === c[0] ? ' on' : '') + '" data-st="' + c[0] + '">' + esc(c[1]) + ' ' + c[2] + '</button>'; }).join('');
    $$('#mine-chips .chip').forEach(function (b) { b.addEventListener('click', function () { S.mineFilter.status = b.getAttribute('data-st'); renderMine(); }); });
    var q = S.mineFilter.q.toLowerCase();
    var list = rows.filter(function (r) {
      return (!S.mineFilter.status || r.displayStatus === S.mineFilter.status) &&
        (!q || [r.id, r.customer, r.project, r.productKey, r.productName, r.note].join(' ').toLowerCase().indexOf(q) !== -1);
    });
    if (!list.length) { $('#mine-list').innerHTML = '<div class="empty card">ไม่มีคำขอ</div>'; return; }
    var hasPending = list.some(function (r) { return r.status === 'Pending'; });
    $('#mine-list').innerHTML = (hasPending ? '<div class="row end" style="margin-bottom:8px"><button class="btn small bad" id="mine-cancel" disabled>ยกเลิกรายการที่เลือก</button></div>' : '') +
      '<div class="table-wrap"><table class="cards"><thead><tr><th></th><th>Req. Id.</th><th>วันที่ขอ</th><th>คู่ค้า / โครงการ</th><th>รายการ</th><th class="num">จำนวน</th><th class="num">ราคาพิเศษ</th><th>ส่วนลด</th><th>Indicator</th><th>สถานะ</th><th>ใช้ได้ถึง</th><th>หมายเหตุผู้อนุมัติ</th></tr></thead><tbody>' +
      list.map(function (r) {
        return '<tr><td data-label="' + (r.status === 'Pending' ? 'เลือก' : '') + '">' + (r.status === 'Pending' ? '<input type="checkbox" data-cancel="' + esc(r.id) + '">' : '') + '</td>' +
          '<td data-label="Req. Id." class="nowrap"><b>' + esc(r.id) + '</b><div class="muted">' + esc(channelName(r.channel)) + '</div></td>' +
          '<td data-label="วันที่ขอ" class="nowrap">' + dateTh(r.requestedAt) + '</td>' +
          '<td data-label="คู่ค้า">' + esc(r.customer) + (r.project ? '<div class="muted">' + esc(r.project) + '</div>' : '') + '</td>' +
          '<td data-label="รายการ">' + esc(r.productName) + (r.productName !== r.productKey ? '<div class="muted">' + esc(r.productKey) + '</div>' : '') + '</td>' +
          '<td data-label="จำนวน" class="num">' + (r.qty || '–') + '</td>' +
          '<td data-label="ราคาพิเศษ" class="num">' + money(r.specialPrice) + '<div class="muted">ปกติ ' + money(r.normalPrice) + '</div></td>' +
          '<td data-label="ส่วนลด" class="nowrap">' + discText(r) + '</td>' +
          '<td data-label="Indicator">' + indBadge(r.indicator) + '</td>' +
          '<td data-label="สถานะ">' + statusBadge(r.displayStatus) + '</td>' +
          '<td data-label="ใช้ได้" class="nowrap">' + dateTh(r.startDate) + ' – ' + dateTh(r.endDate) + '</td>' +
          '<td data-label="หมายเหตุ">' + esc(r.comment) + (r.decidedBy ? '<div class="muted">' + esc(r.decidedBy) + '</div>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    var btn = $('#mine-cancel');
    if (!btn) return;
    var pick = function () { return $$('[data-cancel]').filter(function (c) { return c.checked; }).map(function (c) { return c.getAttribute('data-cancel'); }); };
    $$('[data-cancel]').forEach(function (c) { c.addEventListener('change', function () { btn.disabled = !pick().length; }); });
    btn.addEventListener('click', function () {
      var ids = pick();
      if (!confirm('ยกเลิก ' + ids.length + ' รายการ?')) return;
      run('cancelMyRequests', ids).then(function (res) { toast('ยกเลิกแล้ว ' + res.updated.length + ' รายการ'); S.mine = null; viewMine(); }).catch(fail);
    });
  }

  function groupOptions(cur, allLabel) {
    return '<option value="">' + esc(allLabel || 'ทุกกลุ่มราคา') + '</option>' + S.boot.groups.map(function (g) {
      return '<option value="' + esc(g.id) + '"' + (cur === g.id ? ' selected' : '') + '>' + esc(g.name) + '</option>';
    }).join('');
  }

  // ================= Approved prices =================
  function viewApproved() {
    var ap = S.ap;
    $('#view').innerHTML = page('ราคาที่อนุมัติแล้ว', 'ค้นหาว่าลูกค้า / สินค้านี้มีราคาพิเศษที่อนุมัติและยังใช้ได้อยู่หรือไม่') +
      '<div class="filters"><input type="search" id="ap-q" placeholder="ค้นหา ลูกค้า / สินค้า / โครงการ" value="' + esc(ap.q) + '" style="max-width:420px">' +
      '<select id="ap-grp">' + groupOptions(ap.group) + '</select>' +
      '<label class="row" style="font-size:13px;color:var(--ink-2)"><input type="checkbox" id="ap-exp"' + (ap.includeExpired ? ' checked' : '') + '> รวมที่หมดอายุแล้ว</label></div>' +
      '<div id="ap-list"></div>';
    var load = debounce(function () {
      $('#ap-list').innerHTML = '<div class="loading"><span class="spin"></span></div>';
      run('searchApprovedPrices', { q: ap.q, group: ap.group, includeExpired: ap.includeExpired }).then(function (rows) { ap.rows = rows; renderAp(); }).catch(fail);
    }, 350);
    $('#ap-q').addEventListener('input', function (e) { ap.q = e.target.value; load(); });
    $('#ap-grp').addEventListener('change', function (e) { ap.group = e.target.value; load(); });
    $('#ap-exp').addEventListener('change', function (e) { ap.includeExpired = e.target.checked; load(); });
    if (ap.rows) renderAp(); else load();
  }

  function renderAp() {
    var rows = S.ap.rows || [];
    if (!rows.length) { $('#ap-list').innerHTML = '<div class="empty card">ไม่พบราคาที่อนุมัติ</div>'; return; }
    var appr = canApprove();
    $('#ap-list').innerHTML = '<div class="muted" style="margin-bottom:6px">' + rows.length + ' รายการ</div><div class="table-wrap"><table class="cards"><thead><tr><th>รายการ</th><th>คู่ค้า / โครงการ</th><th class="num">ราคาพิเศษ</th><th class="num">ขายปกติ</th><th>ส่วนลด</th><th>Indicator</th>' + (appr ? '<th class="num">' + muHead() + '</th>' : '') + '<th>ใช้ได้</th><th>Req. Id.</th><th>ผู้ขอ / ผู้อนุมัติ</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td data-label="รายการ"><b>' + esc(r.productName) + '</b>' + (r.productName !== r.productKey ? '<div class="muted">' + esc(r.productKey) + '</div>' : '') + '</td>' +
          '<td data-label="คู่ค้า">' + esc(r.customer) + (r.project ? '<div class="muted">' + esc(r.project) + '</div>' : '') + (r.note ? '<div class="muted">' + esc(r.note) + '</div>' : '') + '</td>' +
          '<td data-label="ราคาพิเศษ" class="num"><b>' + money(r.specialPrice) + '</b></td>' +
          '<td data-label="ขายปกติ" class="num">' + money(r.normalPrice) + '</td>' +
          '<td data-label="ส่วนลด" class="nowrap">' + discText(r) + '</td>' +
          '<td data-label="Indicator">' + indBadge(r.indicator) + '</td>' +
          (appr ? '<td data-label="' + muHead() + '" class="num">' + muCell(r) + '</td>' : '') +
          '<td data-label="ใช้ได้" class="nowrap">' + dateTh(r.startDate) + ' – ' + dateTh(r.endDate) + (r.displayStatus === 'Expired' ? ' ' + statusBadge('Expired') : '') +
          (r.oldPriceList ? '<div><span class="tag old">อนุมัติจากราคารอบ ' + esc(r.priceList) + '</span></div>' : '') + '</td>' +
          '<td data-label="Req. Id." class="nowrap">' + esc(r.id) + '<div class="muted">' + esc(channelName(r.channel)) + '</div></td>' +
          '<td data-label="ผู้ขอ"><div class="muted">' + esc(r.requester) + '</div><div class="muted">✓ ' + esc(r.decidedBy) + '</div></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  // ================= Approvals (supervisor) =================
  function viewApprovals() {
    S.sel = {};
    $('#view').innerHTML = page('รออนุมัติ', (canSeeCost() ? 'ตรวจต้นทุนและ %MU' : 'ตรวจ Indicator และช่วง MU') + ' แล้วอนุมัติหรือไม่อนุมัติ เลือกได้หลายรายการพร้อมกัน', '<button class="btn small" id="ap-reload">↻ รีเฟรช</button>') +
      '<div id="appr-list"><div class="loading"><span class="spin"></span></div></div>';
    $('#ap-reload').addEventListener('click', viewApprovals);
    run('listRequests', { status: 'Pending', limit: 3000 }).then(function (rows) {
      S.appr = rows; S.boot.pendingCount = rows.length; renderNav(); renderApprovals();
    }).catch(fail);
  }

  function renderApprovals() {
    var rows = S.appr || [];
    if (!rows.length) { $('#appr-list').innerHTML = '<div class="empty card">ไม่มีคำขอรออนุมัติ 🎉</div>'; renderActionBar(); return; }
    var groups = [], byKey = {};
    rows.slice().sort(function (a, b) { return (a.requestedAt || '').localeCompare(b.requestedAt || '') || a.id.localeCompare(b.id); }).forEach(function (r) {
      var k = r.batch || r.id;
      if (!byKey[k]) { byKey[k] = { key: k, rows: [] }; groups.push(byKey[k]); }
      byKey[k].rows.push(r);
    });
    $('#appr-list').innerHTML = '<div class="muted" style="margin-bottom:8px">' + rows.length + ' รายการ ใน ' + groups.length + ' คำขอ (เก่าสุดก่อน)</div>' + groups.map(function (g) {
      var f = g.rows[0];
      var own = f.requester === S.boot.user.email && S.boot.user.role !== 'ADMIN';
      return '<div class="group card" style="padding:0">' +
        '<div class="group-head"><label class="row">' + (own ? '' : '<input type="checkbox" data-gsel="' + esc(g.key) + '">') + '</label>' +
        '<span class="cust">' + esc(f.customer || '(ไม่ระบุคู่ค้า)') + '</span>' +
        (f.project ? '<span>' + esc(f.project) + '</span>' : '') + groupChip(f) +
        '<span class="meta">' + esc(channelName(f.channel)) + '</span>' +
        '<span class="meta">ผู้ขอ ' + esc(f.requester || '–') + ' · ' + dateTh(f.requestedAt) + '</span>' +
        '<span class="meta">ใช้ได้ ' + dateTh(f.startDate) + ' – ' + dateTh(f.endDate) + '</span>' +
        (f.note ? '<span class="meta">📝 ' + esc(f.note) + '</span>' : '') +
        (own ? '<span class="flag warn">คำขอของคุณเอง — ต้องให้ผู้อนุมัติคนอื่นพิจารณา</span>' : '') + '</div>' +
        '<div class="table-wrap"><table class="cards"><thead><tr><th></th><th>Req. Id.</th><th>รายการ</th><th class="num">จำนวน</th><th class="num">ขายปกติ</th><th class="num">ราคาพิเศษ</th><th>ส่วนลด</th><th class="num">สุทธิ ex VAT</th>' +
        (canSeeCost() ? '<th class="num">ต้นทุน</th><th class="num">Gain</th>' : '') + '<th class="num">' + muHead() + '</th><th>Indicator</th><th></th></tr></thead><tbody>' +
        g.rows.map(function (r) {
          return '<tr data-row="' + esc(r.id) + '"><td data-label="' + (own ? '' : 'เลือก') + '">' + (own ? '' : '<input type="checkbox" data-sel="' + esc(r.id) + '" data-g="' + esc(g.key) + '">') + '</td>' +
            '<td data-label="Req. Id." class="nowrap"><b>' + esc(r.id) + '</b></td>' +
            '<td data-label="รายการ">' + esc(r.productName) + (r.isBundle ? '<span class="tag new">ชุดเซ็ต</span>' : '') +
              (r.productName !== r.productKey ? '<div class="muted">' + esc(r.productKey) + '</div>' : '') + flagsHtml(r.flags) + repricedHtml(r) + '</td>' +
            '<td data-label="จำนวน" class="num">' + (r.qty || '–') + '</td>' +
            '<td data-label="ขายปกติ" class="num">' + money(r.normalPrice) + (r.priceList ? '<div class="muted">' + esc(r.priceList) + '</div>' : '') + '</td>' +
            '<td data-label="ราคาพิเศษ" class="num"><b>' + money(r.specialPrice) + '</b></td>' +
            '<td data-label="ส่วนลด" class="nowrap">' + discText(r) + '</td>' +
            '<td data-label="สุทธิ ex VAT" class="num">' + money(r.netExVat, 2) + '</td>' +
            (canSeeCost() ? '<td data-label="ต้นทุน" class="num">' + money(r.cost, 2) + '</td><td data-label="Gain" class="num">' + money(r.gain, 2) + '</td>' : '') +
            '<td data-label="' + muHead() + '" class="num">' + muCell(r) + '</td>' +
            '<td data-label="Indicator">' + indBadge(r.indicator) + '</td>' +
            '<td data-label=""><button class="btn small ghost" data-hist="' + esc(r.id) + '">ประวัติ</button></td></tr>';
        }).join('') + '</tbody></table></div></div>';
    }).join('');

    $$('[data-sel]').forEach(function (c) { c.addEventListener('change', function () { setSel(c.getAttribute('data-sel'), c.checked); syncGroupBoxes(); }); });
    $$('[data-gsel]').forEach(function (c) {
      c.addEventListener('change', function () {
        $$('[data-g="' + cssEsc(c.getAttribute('data-gsel')) + '"]').forEach(function (b) { b.checked = c.checked; setSel(b.getAttribute('data-sel'), c.checked); });
      });
    });
    $$('[data-hist]').forEach(function (b) { b.addEventListener('click', function () { toggleHistory(b); }); });
    renderActionBar();
  }
  /** Pending request made on an older price list: what approving today means. */
  function repricedHtml(r) {
    var x = r.repriced;
    if (!x) return '';
    return '<div class="banner" style="margin:6px 0 0;padding:6px 10px">ราคาตั้งรอบใหม่ <b>' + esc(x.priceList) + '</b>: ปกติ ' + money(x.normalPrice) + ' ฿ → ' +
      indBadge(x.indicator) + ' <span class="band">' + esc(canSeeCost() ? pct(x.mu) : x.muBand || '') + '</span><div class="hint">อนุมัติแล้วระบบจะบันทึกตามราคารอบใหม่</div></div>';
  }

  function setSel(id, on) {
    if (on) S.sel[id] = true; else delete S.sel[id];
    var tr = $('tr[data-row="' + cssEsc(id) + '"]');
    if (tr) tr.classList.toggle('sel', on);
    renderActionBar();
  }
  function syncGroupBoxes() {
    $$('[data-gsel]').forEach(function (g) {
      var boxes = $$('[data-g="' + cssEsc(g.getAttribute('data-gsel')) + '"]');
      g.checked = boxes.length && boxes.every(function (b) { return b.checked; });
    });
  }

  function renderActionBar() {
    var bar = $('#actionbar');
    var ids = Object.keys(S.sel);
    if (S.route !== 'approvals' || !ids.length) { bar.classList.remove('show'); return; }
    bar.innerHTML = '<div class="actionbar-inner"><b>เลือก ' + ids.length + ' รายการ</b>' +
      '<input type="text" id="dec-comment" placeholder="หมายเหตุ (จำเป็นเมื่อไม่อนุมัติ)">' +
      '<button class="btn bad" id="dec-reject">✕ ไม่อนุมัติ</button><button class="btn good" id="dec-approve">✓ อนุมัติ</button>' +
      '<button class="btn ghost" id="dec-clear">ล้าง</button></div>';
    bar.classList.add('show');
    $('#dec-approve').addEventListener('click', function () { decide('Approved'); });
    $('#dec-reject').addEventListener('click', function () { decide('Rejected'); });
    $('#dec-clear').addEventListener('click', function () {
      S.sel = {}; $$('[data-sel],[data-gsel]').forEach(function (c) { c.checked = false; }); $$('tr.sel').forEach(function (t) { t.classList.remove('sel'); }); renderActionBar();
    });
  }

  function decide(decision) {
    var ids = Object.keys(S.sel);
    var comment = $('#dec-comment').value.trim();
    if (decision === 'Rejected' && !comment) { toast('กรุณาใส่เหตุผลที่ไม่อนุมัติ', true); $('#dec-comment').focus(); return; }
    var risky = (S.appr || []).filter(function (r) { return S.sel[r.id] && (r.indicator === 'ขาดทุน' || r.indicator === 'NO COST'); }).length;
    var msg = (decision === 'Approved' ? 'อนุมัติ ' : 'ไม่อนุมัติ ') + ids.length + ' รายการ?' +
      (decision === 'Approved' && risky ? '\n\n⚠ มี ' + risky + ' รายการที่ขาดทุนหรือไม่มีต้นทุน' : '');
    if (!confirm(msg)) return;
    $$('#actionbar button').forEach(function (b) { b.disabled = true; });
    run('decideRequests', { ids: ids, decision: decision, comment: comment }).then(function (res) {
      toast((decision === 'Approved' ? 'อนุมัติ' : 'ไม่อนุมัติ') + 'แล้ว ' + res.updated.length + ' รายการ' + (res.skipped.length ? ' (ข้าม ' + res.skipped.length + ' รายการ)' : ''));
      S.ap.rows = null; S.mon = null;
      viewApprovals();
    }).catch(function (e) { fail(e); renderActionBar(); });
  }

  function toggleHistory(btn) {
    var id = btn.getAttribute('data-hist');
    var tr = btn.closest('tr');
    var next = tr.nextElementSibling;
    if (next && next.classList.contains('hist-row')) { next.remove(); return; }
    var row = document.createElement('tr');
    row.className = 'hist-row';
    row.innerHTML = '<td colspan="14" class="history"><span class="spin"></span></td>';
    tr.parentNode.insertBefore(row, tr.nextSibling);
    run('getLineContext', id).then(function (ctx) {
      function mini(list) {
        if (!list.length) return '<div class="muted">ไม่มีข้อมูล</div>';
        return '<table><tbody>' + list.map(function (r) {
          return '<tr><td class="nowrap">' + esc(r.id) + '</td><td class="nowrap">' + dateTh(r.requestedAt) + '</td><td>' + esc(r.customer) + '</td><td>' + esc(r.productName) + '</td><td class="num">' + money(r.specialPrice) + '</td><td class="nowrap">' + discText(r) + '</td><td class="num">' + muCell(r) + '</td><td>' + indBadge(r.indicator) + '</td><td>' + statusBadge(r.displayStatus) + '</td></tr>';
        }).join('') + '</tbody></table>';
      }
      row.firstChild.innerHTML = '<h3>รายการเดียวกัน (ล่าสุด 10)</h3>' + mini(ctx.sameProduct) + '<h3>คู่ค้าเดียวกัน (ล่าสุด 10)</h3>' + mini(ctx.sameCustomer);
    }).catch(function (e) { row.firstChild.textContent = e.message; });
  }

  // ================= Monitor (all requests) =================
  function viewMonitor() {
    var f = S.monFilter;
    var opt = function (v, l, cur) { return '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(l) + '</option>'; };
    var chans = f.group ? group(f.group).channels : [];
    $('#view').innerHTML = page('คำขอทั้งหมด', 'ติดตามและควบคุมส่วนลด / %MU ของทุกคำขอ', '<button class="btn small" id="mon-csv">⬇ ดาวน์โหลด CSV</button>') +
      '<div class="filters">' +
      '<input type="search" id="mon-q" placeholder="ค้นหา" value="' + esc(f.q) + '">' +
      '<select id="mon-st">' + opt('', 'ทุกสถานะ', f.status) + ['Pending', 'Approved', 'Expired', 'Rejected', 'Cancelled', 'Closed'].map(function (s) { return opt(s, STATUS_TH[s], f.status); }).join('') + '</select>' +
      '<select id="mon-grp">' + groupOptions(f.group) + '</select>' +
      (chans.length > 1 ? '<select id="mon-ch">' + opt('', 'ทุกช่องทาง', f.channel) + chans.map(function (c) { return opt(c.id, c.name, f.channel); }).join('') + '</select>' : '') +
      '<select id="mon-ind">' + opt('', 'ทุก Indicator', f.indicator) + Object.keys(IND).map(function (k) { return opt(k, k, f.indicator); }).join('') + '</select>' +
      '<input type="date" id="mon-from" value="' + esc(f.from) + '" title="ขอตั้งแต่"><input type="date" id="mon-to" value="' + esc(f.to) + '" title="ถึง">' +
      '</div><div id="mon-list"><div class="loading"><span class="spin"></span></div></div>';
    var load = debounce(function () {
      $('#mon-list').innerHTML = '<div class="loading"><span class="spin"></span></div>';
      run('listRequests', f).then(function (rows) { S.mon = rows; renderMonitor(); }).catch(fail);
    }, 300);
    $('#mon-q').addEventListener('input', function (e) { f.q = e.target.value; load(); });
    $('#mon-grp').addEventListener('change', function (e) { f.group = e.target.value; f.channel = ''; S.mon = null; viewMonitor(); });
    [['#mon-st', 'status'], ['#mon-ch', 'channel'], ['#mon-ind', 'indicator'], ['#mon-from', 'from'], ['#mon-to', 'to']].forEach(function (p) {
      var el = $(p[0]);
      if (el) el.addEventListener('change', function (e) { f[p[1]] = e.target.value; load(); });
    });
    $('#mon-csv').addEventListener('click', downloadCsv);
    if (S.mon) renderMonitor(); else load();
  }

  function renderMonitor() {
    var rows = S.mon || [];
    if (!rows.length) { $('#mon-list').innerHTML = '<div class="empty card">ไม่พบคำขอ</div>'; return; }
    $('#mon-list').innerHTML = '<div class="muted" style="margin-bottom:6px">' + rows.length + ' รายการ' + (rows.length >= 500 ? ' (แสดงสูงสุด 500 — ใช้ตัวกรองเพื่อจำกัด)' : '') + '</div>' +
      '<div class="table-wrap"><table class="cards"><thead><tr><th>Req. Id.</th><th>วันที่ขอ</th><th>คู่ค้า / โครงการ</th><th>รายการ</th><th class="num">จำนวน</th><th class="num">ขายปกติ</th><th class="num">ราคาพิเศษ</th><th>ส่วนลด</th>' + (canSeeCost() ? '<th class="num">ต้นทุน</th>' : '') + '<th class="num">' + muHead() + '</th><th>Indicator</th><th>สถานะ</th><th>ผู้ขอ / ผู้อนุมัติ</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td data-label="Req. Id." class="nowrap"><b>' + esc(r.id) + '</b><div class="muted">' + esc(channelName(r.channel)) + '</div></td>' +
          '<td data-label="วันที่ขอ" class="nowrap">' + dateTh(r.requestedAt) + '</td>' +
          '<td data-label="คู่ค้า">' + esc(r.customer) + (r.project ? '<div class="muted">' + esc(r.project) + '</div>' : '') + '</td>' +
          '<td data-label="รายการ">' + esc(r.productName) + flagsHtml(r.flags) + '</td>' +
          '<td data-label="จำนวน" class="num">' + (r.qty || '–') + '</td>' +
          '<td data-label="ขายปกติ" class="num">' + money(r.normalPrice) + '</td>' +
          '<td data-label="ราคาพิเศษ" class="num"><b>' + money(r.specialPrice) + '</b></td>' +
          '<td data-label="ส่วนลด" class="nowrap">' + discText(r) + '</td>' +
          (canSeeCost() ? '<td data-label="ต้นทุน" class="num">' + money(r.cost, 2) + '</td>' : '') +
          '<td data-label="' + muHead() + '" class="num">' + muCell(r) + '</td>' +
          '<td data-label="Indicator">' + indBadge(r.indicator) + '</td>' +
          '<td data-label="สถานะ">' + statusBadge(r.displayStatus) + (r.comment ? '<div class="muted">' + esc(r.comment) + '</div>' : '') + '</td>' +
          '<td data-label="ผู้ขอ"><div class="muted">' + esc(r.requester) + '</div>' + (r.decidedBy ? '<div class="muted">✓ ' + esc(r.decidedBy) + '</div>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function downloadCsv() {
    var rows = S.mon || [];
    var cols = [['id', 'Req. Id.'], ['groupId', 'Price group'], ['channel', 'Channel'], ['requestedAt', 'Requested'], ['customer', 'Customer'], ['project', 'Project'], ['note', 'Note'],
      ['productKey', 'Key'], ['productName', 'Item'], ['qty', 'Qty'], ['normalPrice', 'Normal price'], ['specialPrice', 'Special price'],
      ['d1', 'Disc 1'], ['d2', 'Disc 2'], ['d3', 'Disc 3'], ['netExVat', 'Net ex VAT']].concat(canSeeCost() ? [['cost', 'Cost'], ['gain', 'Gain'], ['mu', '%MU']] : [['muBand', 'MU band']]).concat([
      ['priceList', 'Price list'], ['indicator', 'Indicator'], ['displayStatus', 'Status'], ['startDate', 'Start'], ['endDate', 'End'], ['requester', 'Requester'],
      ['decidedBy', 'Decided by'], ['decidedAt', 'Decided at'], ['comment', 'Comment'], ['flags', 'Flags']]);
    var lines = [cols.map(function (c) { return c[1]; })].concat(rows.map(function (r) {
      return cols.map(function (c) { return /^d[123]$/.test(c[0]) ? r.discounts[Number(c[0].charAt(1)) - 1] : r[c[0]]; });
    }));
    var csv = '\ufeff' + lines.map(function (l) {
      return l.map(function (v) {
        v = v === null || v === undefined ? '' : String(v);
        if (/^[=+\-@]/.test(v)) v = "'" + v; // no formula injection when opened in Excel/Sheets
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'rfq-requests-' + S.boot.today + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ================= Dashboard =================
  var IND_COLOR = { 'OKAY': 'var(--good)', 'LOW': 'var(--warning)', 'VERY LOW': 'var(--serious)', 'ขาดทุน': 'var(--critical)', 'NO COST': 'var(--neutral)' };

  function viewDashboard() {
    var f = S.dashFilter;
    if (!f.to) { f.to = S.boot.today; f.from = addDaysIso(S.boot.today, -29); }
    $('#view').innerHTML = page('ภาพรวม', 'ส่วนลดและ %MU ของคำขอในช่วงเวลาที่เลือก') +
      '<div class="filters"><span class="label">ช่วงวันที่ขอ</span><input type="date" id="d-from" value="' + esc(f.from) + '"><span>–</span><input type="date" id="d-to" value="' + esc(f.to) + '">' +
      '<select id="d-grp">' + groupOptions(f.group) + '</select>' +
      '<div class="chips">' + [['7 วัน', 6], ['30 วัน', 29], ['90 วัน', 89], ['1 ปี', 364]].map(function (p) { return '<button class="chip" data-days="' + p[1] + '">' + p[0] + '</button>'; }).join('') + '</div></div>' +
      '<div id="dash"><div class="loading"><span class="spin"></span></div></div>';
    var load = function () {
      $('#dash').innerHTML = '<div class="loading"><span class="spin"></span></div>';
      run('getDashboard', f).then(renderDashboard).catch(fail);
    };
    $('#d-from').addEventListener('change', function (e) { f.from = e.target.value; load(); });
    $('#d-to').addEventListener('change', function (e) { f.to = e.target.value; load(); });
    $('#d-grp').addEventListener('change', function (e) { f.group = e.target.value; load(); });
    $$('[data-days]').forEach(function (b) {
      b.addEventListener('click', function () { f.to = S.boot.today; f.from = addDaysIso(f.to, -Number(b.getAttribute('data-days'))); viewDashboard(); });
    });
    load();
  }

  function renderDashboard(d) {
    var k = d.kpis;
    var kpi = function (label, val, sub) { return '<div class="kpi"><div class="k">' + esc(label) + '</div><div class="v">' + val + '</div>' + (sub ? '<div class="s">' + sub + '</div>' : '') + '</div>'; };
    var maxInd = Math.max.apply(null, d.byIndicator.map(function (x) { return x.total; }).concat([1]));
    var maxMonth = Math.max.apply(null, d.byMonth.map(function (x) { return x.total; }).concat([1]));
    var maxMu = Math.max.apply(null, d.byMonth.map(function (x) { return x.avgMu || 0; }).concat([0.01]));
    var html = '<div class="kpis">' +
      kpi('คำขอในช่วงนี้', k.total) +
      kpi('รออนุมัติตอนนี้', k.pendingNow, k.pendingNow ? '<a href="#approvals" id="k-pending">ไปที่หน้ารออนุมัติ →</a>' : '') +
      kpi('อนุมัติ / ไม่อนุมัติ', k.approved + ' / ' + k.rejected) +
      (d.showMu ? kpi('%MU เฉลี่ยที่อนุมัติ', pct(k.avgMuApproved, 1)) : '') +
      kpi('อนุมัติทั้งที่ MU ต่ำ', k.riskyApproved, 'VERY LOW หรือ ขาดทุน') +
      kpi('จะหมดอายุใน 7 วัน', k.expiringSoon) + '</div>';

    html += '<div class="grid-2 even"><div class="card"><h2>จำนวนคำขอตาม Indicator</h2><div class="bars">' +
      d.byIndicator.map(function (x) {
        return '<div class="bar-row" title="' + esc(x.indicator) + ': ' + x.total + ' คำขอ, อนุมัติ ' + x.approved + '">' +
          '<span>' + indBadge(x.indicator) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + (x.total / maxInd * 100) + '%;background:' + IND_COLOR[x.indicator] + '"></div></div>' +
          '<span class="val">' + x.total + ' <span class="muted">(✓' + x.approved + ')</span></span></div>';
      }).join('') + '</div></div>' +
      '<div class="card"><h2>จำนวนคำขอรายเดือน (6 เดือน)</h2><div class="cols">' +
      d.byMonth.map(function (x) {
        return '<div class="col" title="' + x.month + ': ' + x.total + ' คำขอ, อนุมัติ ' + x.approved + '"><span class="colval">' + x.total + '</span><div class="colbar" style="height:' + (x.total / maxMonth * 100) + '%"></div></div>';
      }).join('') + '</div><div class="col-labels">' + d.byMonth.map(function (x) { return '<span>' + x.month.substring(2) + '</span>'; }).join('') + '</div>' +
      (d.showMu ? '<h2 style="margin-top:18px">%MU เฉลี่ยที่อนุมัติ รายเดือน</h2><div class="cols" style="height:110px">' +
      d.byMonth.map(function (x) {
        return '<div class="col" title="' + x.month + ': ' + pct(x.avgMu, 1) + '"><span class="colval">' + (x.avgMu === null ? '–' : pct(x.avgMu, 0)) + '</span><div class="colbar" style="height:' + ((x.avgMu || 0) / maxMu * 100) + '%;opacity:.7"></div></div>';
      }).join('') + '</div><div class="col-labels">' + d.byMonth.map(function (x) { return '<span>' + x.month.substring(2) + '</span>'; }).join('') + '</div>' : '') + '</div></div>';

    var muTh = d.showMu ? '<th class="num">%MU เฉลี่ย</th>' : '';
    var muTd = function (v) { return d.showMu ? '<td class="num">' + pct(v, 1) + '</td>' : ''; };
    html += '<div class="grid-2 even stack-gap"><div class="card"><h2>ตามผู้ขอ</h2>' + (d.byRequester.length ? '<div class="table-wrap"><table><thead><tr><th>ผู้ขอ</th><th class="num">คำขอ</th><th class="num">รอ</th><th class="num">อนุมัติ</th><th class="num">ไม่อนุมัติ</th><th class="num">MU ต่ำ</th>' + muTh + '</tr></thead><tbody>' +
      d.byRequester.map(function (x) { return '<tr><td>' + esc(x.email) + '</td><td class="num">' + x.total + '</td><td class="num">' + x.pending + '</td><td class="num">' + x.approved + '</td><td class="num">' + x.rejected + '</td><td class="num">' + x.lowCount + '</td>' + muTd(x.avgMu) + '</tr>'; }).join('') +
      '</tbody></table></div>' : '<div class="empty">ไม่มีข้อมูล</div>') + '</div>' +
      '<div class="card"><h2>ตามช่องทาง</h2>' + (d.byChannel.length ? '<div class="table-wrap"><table><thead><tr><th>ช่องทาง</th><th class="num">คำขอ</th><th class="num">อนุมัติ</th>' + muTh + '</tr></thead><tbody>' +
      d.byChannel.map(function (x) { return '<tr><td>' + esc(x.name) + '<div class="muted">' + esc(x.group) + '</div></td><td class="num">' + x.total + '</td><td class="num">' + x.approved + '</td>' + muTd(x.avgMu) + '</tr>'; }).join('') +
      '</tbody></table></div>' : '<div class="empty">ไม่มีข้อมูล</div>') + '</div></div>';

    var mini = function (title, list, empty) {
      return '<div class="card"><h2>' + title + '</h2>' + (list.length ? '<div class="table-wrap"><table class="cards"><thead><tr><th>Req. Id.</th><th>คู่ค้า</th><th>รายการ</th><th class="num">ราคาพิเศษ</th><th class="num">' + muHead() + '</th><th>Indicator</th><th>ใช้ได้ถึง</th><th>อนุมัติโดย</th></tr></thead><tbody>' +
        list.map(function (r) { return '<tr><td data-label="Req. Id." class="nowrap">' + esc(r.id) + '</td><td data-label="คู่ค้า">' + esc(r.customer) + '</td><td data-label="รายการ">' + esc(r.productName) + '</td><td data-label="ราคาพิเศษ" class="num">' + money(r.specialPrice) + '</td><td data-label="' + muHead() + '" class="num">' + muCell(r) + '</td><td data-label="Indicator">' + indBadge(r.indicator) + '</td><td data-label="ใช้ได้ถึง" class="nowrap">' + dateTh(r.endDate) + '</td><td data-label="อนุมัติโดย"><span class="muted">' + esc(r.decidedBy) + '</span></td></tr>'; }).join('') +
        '</tbody></table></div>' : '<div class="empty">' + empty + '</div>') + '</div>';
    };
    html += '<div class="stack-gap">' + mini('อนุมัติทั้งที่ MU ต่ำ (VERY LOW / ขาดทุน)', d.risky, 'ไม่มี') + mini('ราคาพิเศษที่จะหมดอายุใน 7 วัน', d.expiring, 'ไม่มี') + '</div>';
    $('#dash').innerHTML = html;
    var kp = $('#k-pending');
    if (kp) kp.addEventListener('click', function (e) { e.preventDefault(); go('approvals'); });
  }

  // ================= Bundles (ชุดเซ็ต / DUMMY SET) =================
  function bundleBrands() {
    var seen = {};
    S.boot.groups.forEach(function (g) { if (g.costSource === 'PRODUCT') g.channels.forEach(function (c) { if (c.brand) seen[c.brand] = true; }); });
    return Object.keys(seen);
  }

  function viewBundles() {
    var brands = bundleBrands();
    S.bf = S.bf || { brand: brands[0], rows: [{ k: '', q: '1' }, { k: '', q: '1' }], label: '', q: '' };
    var f = S.bf;
    $('#view').innerHTML = page('ชุดเซ็ตโปรโมชั่น', 'จับสินค้า 2–5 รายการเป็นชุดเซ็ตเพื่อเสนอโปรโมชั่น ทุกคนใช้ชุดเซ็ตร่วมกันได้ ราคาตั้งของเซ็ต = ผลรวมราคาตั้งในรอบราคาปัจจุบัน') +
      '<div class="grid-2"><div class="card"><h2>สร้างชุดเซ็ตใหม่</h2>' +
      '<div class="field" style="margin-bottom:12px"><span class="label">แบรนด์</span><div class="seg" id="bf-brand">' + brands.map(function (b) {
        return '<button type="button" data-b="' + esc(b) + '" class="' + (b === f.brand ? 'on' : '') + '">' + esc(b) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="bundle-rows">' + f.rows.map(function (r, i) {
        var it = item(chForBrand(f.brand), r.k);
        return '<div class="bundle-row"><div class="field"><span class="label">สินค้าที่ ' + (i + 1) + '</span><input type="search" list="dl-P-' + esc(f.brand) + '" autocomplete="off" data-bk="' + i + '" value="' + esc(r.k) + '" placeholder="พิมพ์เพื่อค้นหา…">' +
          '<div class="np">' + (it ? (it.n !== it.k ? esc(it.n) + ' · ' : '') + money(it.p) + ' ฿' + itemTags(it) : (r.k ? '<span style="color:var(--danger)">ไม่พบในรอบราคาปัจจุบัน</span>' : '')) + '</div></div>' +
          '<div class="field"><span class="label">จำนวน</span><input type="text" inputmode="numeric" class="num" data-bq="' + i + '" value="' + esc(r.q) + '"></div>' +
          '<div class="field"><span class="label">&nbsp;</span><button class="icon-btn" data-bdel="' + i + '" title="ลบ"' + (f.rows.length <= 2 ? ' disabled' : '') + '>✕</button></div></div>';
      }).join('') + '</div>' +
      '<div class="row" style="margin:10px 0 14px"><button class="btn small" id="bf-add"' + (f.rows.length >= 5 ? ' disabled' : '') + '>+ เพิ่มสินค้า</button></div>' +
      '<div class="field"><label for="bf-label">ชื่อโปรโมชั่น (ไม่บังคับ)</label><input type="text" id="bf-label" maxlength="120" placeholder="เช่น โปรครัวครบชุด 11.11" value="' + esc(f.label) + '"><span class="hint"></span></div>' +
      '<dl class="kv"><dt>ชื่อเซ็ต</dt><dd id="bf-name">' + esc(bundleName(f)) + '</dd><dt>ราคาตั้งรวม</dt><dd id="bf-total">' + bundleTotal(f) + '</dd></dl>' +
      '<div class="row end" style="margin-top:14px"><button class="btn primary" id="bf-save">สร้างชุดเซ็ต</button></div></div>' +
      '<div class="card"><h2>ชุดเซ็ตทั้งหมด</h2><div class="filters"><input type="search" id="bf-q" placeholder="ค้นหาชุดเซ็ต / สินค้า" value="' + esc(f.q) + '" style="max-width:none"></div><div id="bf-list"></div></div></div>';

    $$('#bf-brand [data-b]').forEach(function (b) {
      b.addEventListener('click', function () { f.brand = b.getAttribute('data-b'); f.rows = [{ k: '', q: '1' }, { k: '', q: '1' }]; viewBundles(); });
    });
    $$('[data-bk]').forEach(function (inp) {
      inp.addEventListener('change', function () { f.rows[Number(inp.getAttribute('data-bk'))].k = inp.value; viewBundles(); });
      inp.addEventListener('input', function () { f.rows[Number(inp.getAttribute('data-bk'))].k = inp.value; $('#bf-name').textContent = bundleName(f); $('#bf-total').textContent = bundleTotal(f); });
    });
    $$('[data-bq]').forEach(function (inp) {
      inp.addEventListener('input', function () { f.rows[Number(inp.getAttribute('data-bq'))].q = inp.value; $('#bf-name').textContent = bundleName(f); $('#bf-total').textContent = bundleTotal(f); });
    });
    $$('[data-bdel]').forEach(function (b) { b.addEventListener('click', function () { f.rows.splice(Number(b.getAttribute('data-bdel')), 1); viewBundles(); }); });
    $('#bf-add').addEventListener('click', function () { f.rows.push({ k: '', q: '1' }); viewBundles(); });
    $('#bf-label').addEventListener('input', function (e) { f.label = e.target.value; });
    $('#bf-q').addEventListener('input', debounce(function (e) { f.q = e.target.value; renderBundleList(); }, 200));
    $('#bf-save').addEventListener('click', function () {
      var btn = $('#bf-save');
      btn.disabled = true;
      run('createBundle', { brand: f.brand, label: f.label, items: f.rows.map(function (r) { return { productKey: r.k.trim(), qty: r.q }; }) }).then(function (b) {
        S.boot.bundles.push(b);
        addItem('P-' + b.b, b.k, b.n, b.p, { bundle: true });
        S.bf = null;
        toast('สร้างชุดเซ็ต "' + b.k + '" แล้ว');
        viewBundles();
      }).catch(function (e) { fail(e); btn.disabled = false; });
    });
    renderBundleList();
  }

  function chForBrand(brand) {
    for (var i = 0; i < S.boot.groups.length; i++) {
      var g = S.boot.groups[i];
      if (g.costSource !== 'PRODUCT') continue;
      for (var j = 0; j < g.channels.length; j++) if (g.channels[j].brand === brand) return g.channels[j].id;
    }
    return '';
  }
  function bundleName(f) {
    var ch = chForBrand(f.brand);
    return f.rows.filter(function (r) { return r.k.trim(); }).map(function (r) {
      var it = item(ch, r.k); var k = it ? it.k : r.k.trim(); var q = parseInt(r.q, 10) || 1;
      return q > 1 ? k + ' ×' + q : k;
    }).join(' + ') || '–';
  }
  function bundleTotal(f) {
    var ch = chForBrand(f.brand), total = 0, ok = false;
    for (var i = 0; i < f.rows.length; i++) {
      var r = f.rows[i];
      if (!r.k.trim()) continue;
      var it = item(ch, r.k);
      if (!it || it.bundle || !it.p) return '–';
      total += it.p * (parseInt(r.q, 10) || 1); ok = true;
    }
    return ok ? money(total) + ' ฿' : '–';
  }

  function renderBundleList() {
    var q = (S.bf.q || '').toLowerCase();
    var list = S.boot.bundles.filter(function (b) { return !q || (b.k + ' ' + b.n + ' ' + b.by).toLowerCase().indexOf(q) !== -1; });
    if (!list.length) { $('#bf-list').innerHTML = '<div class="empty">ยังไม่มีชุดเซ็ต</div>'; return; }
    $('#bf-list').innerHTML = '<div class="table-wrap"><table class="cards"><thead><tr><th>ชุดเซ็ต</th><th class="num">ราคาตั้งรวม</th><th>สร้างโดย</th><th></th></tr></thead><tbody>' +
      list.slice(0, 300).map(function (b) {
        var mine = b.by === S.boot.user.email || S.boot.user.isAdmin;
        return '<tr><td data-label="ชุดเซ็ต"><b>' + esc(b.n) + '</b> <span class="group-chip">' + esc(b.b) + '</span><div class="muted">' + esc(b.k) + '</div></td>' +
          '<td data-label="ราคาตั้งรวม" class="num">' + (b.p ? money(b.p) : '<span class="muted">มีสินค้าไม่อยู่ในรอบราคา</span>') + '</td>' +
          '<td data-label="สร้างโดย"><span class="muted">' + esc(b.by) + '</span></td>' +
          '<td data-label=""><div class="row"><button class="btn small" data-buse="' + b.id + '">ตรวจราคา</button>' + (mine ? '<button class="btn small ghost" data-bremove="' + b.id + '">ลบ</button>' : '') + '</div></td></tr>';
      }).join('') + '</tbody></table></div>' + (list.length > 300 ? '<p class="hint">แสดง 300 รายการแรก — พิมพ์ค้นหาเพื่อกรอง</p>' : '');
    $$('[data-buse]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var b = S.boot.bundles.filter(function (x) { return String(x.id) === btn.getAttribute('data-buse'); })[0];
        var ch = chForBrand(b.b);
        S.pc = { channelId: ch, productKey: b.k, special: '', discs: defaultDiscs(channel(ch)), result: null };
        go('check');
      });
    });
    $$('[data-bremove]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('ลบชุดเซ็ตนี้? (คำขอเดิมที่ใช้เซ็ตนี้ไม่ได้รับผลกระทบ)')) return;
        var id = Number(btn.getAttribute('data-bremove'));
        run('deleteBundle', id).then(function () {
          var b = S.boot.bundles.filter(function (x) { return x.id === id; })[0];
          S.boot.bundles = S.boot.bundles.filter(function (x) { return x.id !== id; });
          if (b && S.items['P-' + b.b]) delete S.items['P-' + b.b][b.k.toUpperCase()];
          toast('ลบชุดเซ็ตแล้ว'); renderBundleList();
        }).catch(fail);
      });
    });
  }

  /** Adds one entry to an item set and its datalist (used after creating a bundle). */
  function addItem(set, k, n, p, extra) {
    var e = { k: k, n: n || k, p: p };
    Object.keys(extra || {}).forEach(function (x) { e[x] = extra[x]; });
    (S.items[set] = S.items[set] || {})[String(k).toUpperCase()] = e;
    var dl = document.getElementById('dl-' + set);
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'dl-' + set; $('#datalists').appendChild(dl); }
    var o = document.createElement('option');
    o.value = k; o.textContent = (n && n !== k ? n + ' · ' : '') + (p ? money(p) + ' ฿' : '') + ' · ชุดเซ็ต';
    dl.appendChild(o);
  }

  // ================= Admin =================
  var IMPORT_TYPES = [
    ['cost_price_sheet', 'ต้นทุน/ราคาสินค้า — ชีต _Cost&Price (CSV)'],
    ['cal_dummy_sheet', 'ชุดเซ็ตเดิม — ชีต _CalDummy / DUMMY SET (CSV)'],
    ['products', 'สินค้า (CSV: brand, key, name, cost, normal_price)'],
    ['project_costs', 'ต้นทุนโครงการ Joseph Space (CSV: project_key, customer, description, cost)'],
    ['landed_items', 'สินค้านำเข้า JS-OVS — ชีต _Manual.Cal หรือ CSV'],
    ['GT.EVE_RFQ', 'คำขอเดิม: GT.EVE_RFQ'], ['GT.FOSTER_RFQ', 'คำขอเดิม: GT.FOSTER_RFQ'],
    ['BT.EVE_RFQ', 'คำขอเดิม: BT.EVE_RFQ'], ['BT.FOSTER_RFQ', 'คำขอเดิม: BT.FOSTER_RFQ'], ['OFFI_RFQ', 'คำขอเดิม: OFFI_RFQ']
  ];

  function viewAdmin() {
    $('#view').innerHTML = page('ตั้งค่า', 'สำหรับ Admin — กลุ่มราคา/ช่องทางแก้ไขผ่านไฟล์ config/price-groups.json (ผ่าน Pull Request)') + '<div id="adm"><div class="loading"><span class="spin"></span></div></div>';
    run('getAdminInfo').then(renderAdmin).catch(fail);
  }

  function renderAdmin(a) {
    var c = a.counts;
    var editable = ['VAT_RATE', 'DEFAULT_VALIDITY_DAYS', 'MAX_VALIDITY_DAYS', 'NOTIFY_EMAILS', 'PRICE_CHECK_ALERT', 'PRICE_CHECK_LIMIT', 'PRICE_CHECK_PER_HOUR'];
    var setting = function (k) { var x = a.settings.filter(function (s) { return s.key === k; })[0]; return x ? x.value : ''; };
    var rulesText = function (rules) {
      return (rules || []).map(function (r) { return '<code>' + esc(r.indicator) + ' ' + (r.below !== undefined ? '&lt; ' + pct(r.below, 0) : '≤ ' + pct(r.upTo, 0)) + '</code>'; }).join(' ') + ' <code>OKAY</code>';
    };
    $('#adm').innerHTML =
      '<div class="grid-2"><div class="card"><h2>นำเข้าข้อมูล (CSV)</h2>' +
      '<p class="hint">Google Sheets → File → Download → Comma-separated values (.csv) ของแท็บที่ต้องการ · n8n สามารถส่งข้อมูลเดียวกันอัตโนมัติผ่าน /api/integrations/import</p>' +
      '<div class="fields"><div class="field wide"><label>ประเภท</label><select id="imp-type">' + IMPORT_TYPES.map(function (t) { return '<option value="' + t[0] + '">' + esc(t[1]) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field pl-only"><label>รอบราคา</label><input type="text" id="imp-pl" placeholder="เช่น AUG26" list="dl-pricelists"><span class="hint">ชื่อเดิม = แก้ไขรอบนั้น (ไม่สนตัวพิมพ์เล็ก/ใหญ่) · ชื่อใหม่ = สร้างรอบใหม่</span></div>' +
      '<div class="field pl-only"><label>มีผลตั้งแต่ (รอบใหม่)</label><input type="date" id="imp-eff"><span class="hint">ต้องระบุเมื่อสร้างรอบใหม่</span></div>' +
      '<div class="field brand-only"><label>Brand (CSV สินค้า)</label><select id="imp-brand"><option>EVE</option><option>FOSTER</option></select><span class="hint"></span></div>' +
      '<div class="field"><label>ไฟล์ CSV</label><input type="file" id="imp-file" accept=".csv,text/csv"><span class="hint"></span></div></div>' +
      '<datalist id="dl-pricelists">' + a.priceLists.map(function (l) { return '<option value="' + esc(l.name) + '">'; }).join('') + '</datalist>' +
      '<div class="row end" style="margin-top:10px"><button class="btn primary" id="imp-go">นำเข้า</button></div><div id="imp-res"></div>' +
      '<dl class="kv"><dt>สินค้า (ทุกรอบราคา)</dt><dd>' + c.products + ' (ไม่มีต้นทุน ' + c.productsWithoutCost + ')</dd><dt>ชุดเซ็ต</dt><dd>' + c.bundles + '</dd>' +
      '<dt>ต้นทุนโครงการ JS</dt><dd>' + c.projectCosts + '</dd><dt>สินค้านำเข้า JS-OVS</dt><dd>' + c.landedItems + '</dd>' +
      '<dt>คำขอทั้งหมด</dt><dd>' + c.requests + '</dd></dl></div>' +

      '<div class="card"><h2>เกณฑ์และค่าตั้งต้น</h2><div class="fields">' +
      a.settings.filter(function (s) { return editable.indexOf(s.key) !== -1; }).map(function (s) {
        var isPct = s.key === 'VAT_RATE';
        return '<div class="field wide"><label>' + esc(s.key) + '</label>' +
          (isPct ? '<div class="pct-wrap"><input type="text" class="num" data-set="' + esc(s.key) + '" data-pct="1" value="' + esc(pctInput(Number(s.value))) + '"></div>'
            : '<input type="text" data-set="' + esc(s.key) + '" value="' + esc(s.value) + '">') +
          '<span class="hint">' + esc(s.description) + '</span></div>';
      }).join('') + '</div><div class="row end" style="margin-top:12px"><button class="btn primary" id="adm-save">บันทึก</button></div></div></div>' +

      '<div class="card stack-gap"><h2>รอบราคา (Price list)</h2><p class="hint">ราคาตั้งปรับทุกรอบ (~4 เดือน) — นำเข้ารอบใหม่ล่วงหน้าได้ ระบบสลับให้อัตโนมัติเมื่อถึงวันมีผล ราคาพิเศษที่อนุมัติแล้วใช้ได้จนวันสิ้นสุดเดิม คำขอที่ยังรออนุมัติจะถูกคิดใหม่ด้วยราคารอบใหม่</p>' +
      '<div class="table-wrap"><table class="cards"><thead><tr><th>รอบ</th><th>มีผลตั้งแต่</th><th>แบรนด์ / สถานะ</th><th class="num">คำขอ</th><th>หมายเหตุ</th><th></th></tr></thead><tbody>' +
      a.priceLists.map(function (l) {
        var st = { current: '<span class="tag new">ใช้อยู่</span>', upcoming: '<span class="tag up">รอบหน้า</span>', past: '<span class="tag old">เก่า</span>' };
        return '<tr><td data-label="รอบ"><b>' + esc(l.name) + '</b></td><td data-label="มีผลตั้งแต่" class="nowrap"><input type="date" data-pl-eff="' + l.id + '" value="' + esc(l.effectiveFrom) + '" style="width:auto;min-height:32px;padding:4px 8px"></td>' +
          '<td data-label="แบรนด์">' + (l.brands.length ? l.brands.map(function (b) { return esc(b.brand) + ' ' + b.products + ' รายการ ' + st[b.status]; }).join('<br>') : '<span class="muted">ไม่มีสินค้า</span>') + '</td>' +
          '<td data-label="คำขอ" class="num">' + l.requests + '</td><td data-label="หมายเหตุ" class="muted">' + esc(l.note) + '</td>' +
          '<td data-label=""><div class="row"><button class="btn small ghost" data-pl-save="' + l.id + '">บันทึกวันที่</button>' +
          (l.effectiveFrom > S.boot.today && !l.requests ? '<button class="btn small bad" data-pl-del="' + l.id + '">ลบ</button>' : '') + '</div></td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="user-form"><div class="field"><label>สร้างรอบราคาใหม่ (ว่าง)</label><input type="text" id="pl-new-name" placeholder="เช่น AUG26"></div>' +
      '<div class="field"><label>มีผลตั้งแต่</label><input type="date" id="pl-new-eff"></div>' +
      '<button class="btn primary" id="pl-new-go">สร้างรอบราคา</button></div>' +
      '<p class="hint">สร้างรอบล่วงหน้าพร้อมวันที่มีผล แล้วให้ n8n ดึงราคาเข้ารอบนี้ — การนำเข้าอัตโนมัติจะไม่สร้างรอบที่มีผลวันนี้เอง</p></div>' +
      '<div class="card stack-gap"><h2>การตรวจราคาที่ผิดปกติ (7 วัน)</h2><p class="hint">ผู้ใช้ที่ตรวจราคาสินค้าเดียวกันตั้งแต่ ' + esc(String(setting('PRICE_CHECK_ALERT'))) + ' ราคาขึ้นไป อาจเป็นการไล่ราคาเพื่อเดาต้นทุน — ระบบแจ้งอีเมล Admin และจำกัดที่ ' + esc(String(setting('PRICE_CHECK_LIMIT'))) + ' ราคา/สินค้า/24 ชม.</p>' +
      (a.priceCheckAlerts.length ? '<div class="table-wrap"><table class="cards"><thead><tr><th>ผู้ใช้</th><th>ช่องทาง</th><th>สินค้า</th><th class="num">จำนวนราคา</th><th class="num">ครั้ง</th><th>ล่าสุด</th></tr></thead><tbody>' +
        a.priceCheckAlerts.map(function (x) {
          return '<tr><td data-label="ผู้ใช้">' + esc(x.user) + '</td><td data-label="ช่องทาง">' + esc(x.channel) + '</td><td data-label="สินค้า">' + esc(x.key) + '</td><td data-label="จำนวนราคา" class="num">' + x.prices + '</td><td data-label="ครั้ง" class="num">' + x.checks + '</td><td data-label="ล่าสุด" class="nowrap">' + esc(x.lastAt.replace('T', ' ').slice(0, 16)) + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="muted">ไม่พบ</div>') + '</div>' +
      '<div class="card stack-gap"><h2>ผู้ใช้และสิทธิ์</h2><p class="hint">ทุกคนที่ใช้อีเมลบริษัทเข้าใช้ได้ในฐานะ SALES อัตโนมัติ เพิ่มที่นี่เพื่อกำหนดเป็น SUPERVISOR / ADMIN หรือปิดบัญชี · สิทธิ์ดูต้นทุนกำหนดได้เฉพาะที่เซิร์ฟเวอร์ (COST_VIEWERS) ไม่สามารถให้สิทธิ์จากหน้านี้</p>' +
      '<div class="table-wrap"><table class="cards"><thead><tr><th>อีเมล</th><th>ชื่อ</th><th>Role</th><th>ดูต้นทุน</th><th>ใช้งาน</th><th>เข้าใช้ล่าสุด</th><th></th></tr></thead><tbody>' +
      a.users.map(function (u) {
        return '<tr><td data-label="อีเมล">' + esc(u.email) + '</td><td data-label="ชื่อ">' + esc(u.name) + '</td><td data-label="Role">' + esc(u.role) + '</td><td data-label="ดูต้นทุน">' + (u.canViewCost ? '🔒 ✓' : '–') + '</td><td data-label="ใช้งาน">' + (u.active ? '✓' : '–') + '</td><td data-label="เข้าใช้ล่าสุด" class="nowrap">' + (u.lastLoginAt ? dateTh(u.lastLoginAt) : '–') + '</td>' +
          '<td data-label=""><button class="btn small ghost" data-edit-user="' + esc(u.email) + '">แก้ไข</button></td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="user-form"><div class="field"><label>อีเมล</label><input type="text" id="u-email" placeholder="name@eve.co.th"></div>' +
      '<div class="field"><label>ชื่อ</label><input type="text" id="u-name"></div>' +
      '<div class="field"><label>Role</label><select id="u-role"><option>SALES</option><option>SUPERVISOR</option><option>ADMIN</option></select></div>' +
      '<label class="row" style="font-size:13px;padding-bottom:10px"><input type="checkbox" id="u-active" checked> ใช้งาน</label>' +
      '<button class="btn primary" id="u-save">บันทึกผู้ใช้</button></div></div>' +

      '<div class="card stack-gap"><h2>กลุ่มราคาและช่องทาง</h2><p class="hint">อ่านอย่างเดียว — แก้ไขที่ server/config/price-groups.json แล้วเปิด Pull Request (AI ตรวจโค้ด → คุณอนุมัติ → deploy อัตโนมัติ)</p>' +
      a.catalog.map(function (g) {
        return '<h3 style="margin:14px 0 4px">' + esc(g.name) + ' <span class="group-chip">' + esc(g.costSource) + '</span></h3><div class="rules">' + rulesText(g.indicatorRules) + '</div>' +
          '<div class="table-wrap" style="margin-top:6px"><table class="cards"><thead><tr><th>ช่องทาง</th><th>Prefix</th><th>สูตร</th><th>ส่วนลด (default / min–max)</th></tr></thead><tbody>' +
          g.channels.map(function (ch) {
            return '<tr><td data-label="ช่องทาง">' + esc(ch.name) + '<div class="muted">' + esc(ch.id) + '</div></td><td data-label="Prefix">' + esc(ch.idPrefix) + '</td><td data-label="สูตร">' + esc(ch.formula) + '</td><td data-label="ส่วนลด">' +
              ch.discounts.map(function (d) { return esc(d.label) + ' ' + pct(d.default, 1) + (d.editable ? ' (' + pct(d.min || 0, 0) + '–' + pct(d.max === undefined ? 0.99 : d.max, 0) + ')' : ' 🔒'); }).join('<br>') + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }).join('') + '</div>' +

      '<div class="card stack-gap"><h2>บันทึกการใช้งานล่าสุด</h2><div class="table-wrap"><table class="cards"><thead><tr><th>เวลา</th><th>ผู้ใช้</th><th>การกระทำ</th><th>Req. Id.</th><th>รายละเอียด</th></tr></thead><tbody>' +
      a.recentLog.map(function (l) { return '<tr><td data-label="เวลา" class="nowrap">' + esc(l.at.replace('T', ' ').slice(0, 16)) + '</td><td data-label="ผู้ใช้">' + esc(l.user) + '</td><td data-label="การกระทำ">' + esc(l.action) + '</td><td data-label="Req. Id.">' + esc(l.ids) + '</td><td data-label="รายละเอียด" class="muted">' + esc(l.detail.slice(0, 160)) + '</td></tr>'; }).join('') +
      '</tbody></table></div></div>';

    var syncImp = function () {
      var t = $('#imp-type').value;
      $$('.pl-only').forEach(function (el) { el.classList.toggle('hidden', t !== 'cost_price_sheet' && t !== 'products'); });
      $$('.brand-only').forEach(function (el) { el.classList.toggle('hidden', t !== 'products'); });
    };
    $('#imp-type').addEventListener('change', syncImp);
    syncImp();
    $('#pl-new-go').addEventListener('click', function () {
      var name = $('#pl-new-name').value.trim(), eff = $('#pl-new-eff').value;
      if (!name || !eff) return toast('กรุณาระบุชื่อรอบและวันที่มีผล', true);
      run('createPriceList', { name: name, effectiveFrom: eff }).then(function (a2) { toast('สร้างรอบราคา ' + name + ' แล้ว'); renderAdmin(a2); }).catch(fail);
    });
    $$('[data-pl-save]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-pl-save');
        var l = a.priceLists.filter(function (x) { return String(x.id) === id; })[0];
        run('savePriceList', { id: Number(id), effectiveFrom: $('[data-pl-eff="' + id + '"]').value, note: l.note })
          .then(function (info) { toast('บันทึกแล้ว — โหลดหน้าใหม่เพื่อใช้ราคาตามวันที่ใหม่'); renderAdmin(info); }).catch(fail);
      });
    });
    $$('[data-pl-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!confirm('ลบรอบราคานี้และสินค้าทั้งหมดในรอบนี้?')) return;
        run('deletePriceList', Number(b.getAttribute('data-pl-del'))).then(function (info) { toast('ลบแล้ว'); renderAdmin(info); }).catch(fail);
      });
    });
    $('#imp-go').addEventListener('click', function () {
      var file = $('#imp-file').files[0];
      if (!file) return toast('กรุณาเลือกไฟล์ CSV', true);
      var btn = $('#imp-go');
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
      file.text().then(function (csv) {
        var t = $('#imp-type').value;
        var pl = (t === 'cost_price_sheet' || t === 'products') ? { name: $('#imp-pl').value.trim(), effectiveFrom: $('#imp-eff').value } : null;
        if (pl && !pl.name) throw new Error('กรุณาระบุชื่อรอบราคา');
        return run('importCsv', { type: t, brand: $('#imp-brand').value, priceList: pl, csv: csv, fileName: file.name });
      }).then(function (r) {
        $('#imp-res').innerHTML = '<div class="notice" style="margin-top:10px">นำเข้า ' + r.imported + ' รายการ' + (r.priceList ? ' เข้ารอบราคา ' + esc(r.priceList) + (r.newPriceList ? ' (รอบใหม่)' : '') : '') + (r.skipped ? ', ข้าม ' + r.skipped + ' (มีอยู่แล้ว)' : '') +
          (r.costConflictCount ? '<div class="banner" style="margin:6px 0 0;padding:6px 10px">ต้นทุนในชีตไม่ตรงกัน ' + r.costConflictCount + ' รายการ (A:C EVE master ≠ E:G GT hot price) — ระบบใช้ต้นทุน E:G เป็นต้นทุนเดียวของทุกกลุ่มราคา: ' + r.costConflicts.slice(0, 20).map(esc).join(', ') + (r.costConflictCount > 20 ? ' …' : '') + '</div>' : '') +
          (r.errors && r.errors.length ? '<br><span style="color:var(--danger)">' + r.errors.slice(0, 10).map(esc).join('<br>') + (r.errors.length > 10 ? '<br>…' : '') + '</span>' : '') + '</div>';
        S.mon = null; S.ap.rows = null;
      }).catch(fail).then(function () { btn.disabled = false; btn.textContent = 'นำเข้า'; });
    });
    $('#adm-save').addEventListener('click', function () {
      var changes = {};
      $$('[data-set]').forEach(function (i) { changes[i.getAttribute('data-set')] = i.getAttribute('data-pct') ? fromPctInput(i.value) : i.value; });
      run('saveSettings', changes).then(function (info) { toast('บันทึกแล้ว'); renderAdmin(info); }).catch(fail);
    });
    $$('[data-edit-user]').forEach(function (b) {
      b.addEventListener('click', function () {
        var u = a.users.filter(function (x) { return x.email === b.getAttribute('data-edit-user'); })[0];
        $('#u-email').value = u.email; $('#u-name').value = u.name; $('#u-role').value = u.role; $('#u-active').checked = u.active;
        $('#u-email').scrollIntoView({ block: 'center' });
      });
    });
    $('#u-save').addEventListener('click', function () {
      run('saveUser', { email: $('#u-email').value, name: $('#u-name').value, role: $('#u-role').value, active: $('#u-active').checked })
        .then(function (info) { toast('บันทึกผู้ใช้แล้ว'); renderAdmin(info); }).catch(fail);
    });
  }

  boot();
})();
