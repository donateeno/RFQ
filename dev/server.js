/**
 * Local preview: serves src/Index.html and answers google.script.run calls by running the
 * real src/*.gs code against an in-memory spreadsheet seeded with test data.
 *
 *   node dev/server.js            → http://localhost:8080/?as=sales1@eve.co.th
 *                                    http://localhost:8080/?as=pak.m@eve.co.th#approvals
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createEnv } = require('../test/gas-mock');
const { seed, day } = require('../test/fixtures');

const SRC = path.join(__dirname, '..', 'src');
const env = seed(createEnv(), { import: true });

function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
// a few live requests so every page has something to show
[
  ['sales1@eve.co.th', 'GT_EVE', 'ร้านวัสดุดีมาก', 'โครงการคอนโด A', [['HC-DEMO-90', 20, 15990, [0.18, 0.05, 0]], ['FAUCET-DEMO', 20, 2300, [0.18, 0, 0]]]],
  ['sales2@eve.co.th', 'GT_FOSTER', 'ปาริชาติ', 'โชว์รูม', [['2451090', 1, 125000, [0.18, 0, 0]]]],
  ['sales2@eve.co.th', 'BT_EVE', 'บุญถาวร พระราม 2', 'Flash sale', [['SINK-DEMO 760/510', 3, 6490, []], ['NOT-IN-LIST', 1, 990, []]]]
].forEach(([who, ch, cust, proj, lines]) => {
  env.call(who, 'submitRequest', {
    channelId: ch, customer: cust, project: proj, note: '', startDate: iso(day(0)), endDate: iso(day(30)),
    lines: lines.map(([k, q, p, d]) => ({ productKey: k, qty: q, specialPrice: p, discounts: d }))
  });
});
const first = env.call('sales1@eve.co.th', 'submitRequest', {
  channelId: 'GT_EVE', customer: 'ร้านทดสอบอนุมัติแล้ว', project: '', note: 'ลูกค้าเก่า', startDate: iso(day(0)), endDate: iso(day(5)),
  lines: [{ productKey: 'SET-A + SET-B', qty: 2, specialPrice: 7490, discounts: [0.15, 0, 0] }]
});
env.call('pak.m@eve.co.th', 'decideRequests', { ids: first.lines.map((l) => l.id), decision: 'Approved', comment: 'ok' });

const SHIM = `<script>
(function () {
  var as = new URLSearchParams(location.search).get('as') || 'sales1@eve.co.th';
  function runner(ok, bad) {
    return new Proxy({}, { get: function (_, fn) {
      if (fn === 'withSuccessHandler') return function (f) { return runner(f, bad); };
      if (fn === 'withFailureHandler') return function (f) { return runner(ok, f); };
      return function () {
        var args = Array.prototype.slice.call(arguments);
        fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn: fn, args: args, as: as }) })
          .then(function (r) { return r.json(); })
          .then(function (r) { setTimeout(function () { r.ok ? ok && ok(r.data) : bad && bad(new Error(r.error)); }, 120); });
      };
    } });
  }
  window.google = { script: { run: runner(), history: { replace: function (s, p, h) { history.replaceState(null, '', '?as=' + as + '#' + h); } },
    url: { getLocation: function (cb) { cb({ hash: location.hash.replace('#', '') }); } } } };
})();
</script>`;

function render() {
  const read = (n) => fs.readFileSync(path.join(SRC, n + '.html'), 'utf8');
  return read('Index')
    .replace("<?!= include('Styles'); ?>", () => read('Styles'))
    .replace("<?!= include('App'); ?>", () => SHIM + read('App'));
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/rpc') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { fn, args, as } = JSON.parse(body);
      let out;
      try { out = { ok: true, data: env.call(as, fn, ...args) }; } catch (e) { out = { ok: false, error: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.url.startsWith('/mail')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(env.mail.map((m) => '<h3>To: ' + m.to + '<br>' + m.subject + '</h3>' + m.htmlBody).join('<hr>'));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(render());
}).listen(Number(process.env.PORT) || 8080, () => console.log('Preview on http://localhost:' + (process.env.PORT || 8080)));
