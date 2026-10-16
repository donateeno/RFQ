'use strict';
/**
 * SAP B1 report uploads from the Windows server (deploy/sap-b1/Upload-SapToRfq.ps1 → POST text/csv to
 * /api/integrations/import/sap_stock|sap_sales). Synthetic rows shaped like PowerShell Export-Csv output.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

let env;
test.before(async () => { env = await startApp(); });
test.after(async () => { await env.close(); });

// Export-Csv -Encoding UTF8 (Windows PowerShell 5.1): BOM, every field quoted, CRLF.
const csv = (rows) => '﻿' + rows.map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n') + '\r\n';
const upload = (type, file, rows, query, token) => fetch(env.base + '/api/integrations/import/' + type + '?' + new URLSearchParams(Object.assign({ file }, query || {})), {
  method: 'POST', headers: { 'Content-Type': 'text/csv; charset=utf-8', Authorization: 'Bearer ' + (token || 'test-token') }, body: csv(rows)
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const q = async (sql, args) => (await env.db.query(sql, args)).rows;

const STOCK_HEAD = ['ItemCode', 'ItemName', 'WhsCode', 'OnHand'];
const SALES_HEAD = ['DocEntry', 'LineNum', 'DocDate', 'ItemCode', 'Dscription', 'Quantity', 'LineTotal'];

test('stock upload replaces the whole table; Thai text, quotes and the file date survive', async () => {
  let r = await upload('sap_stock', 'Stock_261013.csv', [STOCK_HEAD,
    ['HC-DEMO-90', 'เครื่องดูดควัน 90 ซม.', 'W01', '12'], ['HC-DEMO-90', 'เครื่องดูดควัน 90 ซม.', 'W02', '3'], ['OLD-ITEM', 'ของเก่า', 'W01', '1']]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.imported, 3);
  r = await upload('sap_stock', 'Stock_261014.csv', [STOCK_HEAD,
    ['HC-DEMO-90', 'เครื่องดูดควัน 90 ซม.', 'W01', '10'], ['SINK "A", 2 bowls', 'ซิงค์', 'W01', '5'], ['', '', '', '']]);
  assert.equal(r.body.data.imported, 2, 'blank rows are skipped');
  assert.equal(r.body.data.fileDate, '2026-10-14');
  const rows = await q('select item_code, data from sap_stock order by id');
  assert.deepEqual(rows.map((x) => x.item_code), ['HC-DEMO-90', 'SINK "A", 2 bowls'], 'the old snapshot is gone');
  assert.equal(rows[0].data.ItemName, 'เครื่องดูดควัน 90 ซม.');
  assert.equal(rows[0].data.OnHand, '10');
  const up = await q(`select kind, file_name, to_char(file_date, 'YYYY-MM-DD') as d, rows, header from sap_uploads order by id`);
  assert.deepEqual(up.map((u) => [u.kind, u.file_name, u.d, u.rows]), [['stock', 'Stock_261013.csv', '2026-10-13', 3], ['stock', 'Stock_261014.csv', '2026-10-14', 2]]);
  assert.deepEqual(up[1].header, STOCK_HEAD);
});

test('sales upload appends new lines by key and refreshes changed ones — daily month-to-date files never duplicate', async () => {
  const day1 = [SALES_HEAD, ['101', '0', '2026-10-01', 'HC-DEMO-90', 'ดูดควัน', '1', '18990'], ['101', '1', '2026-10-01', 'SINK-DEMO', 'ซิงค์', '2', '7990']];
  let r = await upload('sap_sales', 'Sales_261001.csv', day1, { key: 'DocEntry,LineNum' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.data.inserted, r.body.data.updated], [2, 0]);
  const day2 = day1.concat([['102', '0', '2026-10-02', 'FAUCET-DEMO', 'ก๊อก', '1', '3990']]);
  day2[2] = ['101', '1', '2026-10-01', 'SINK-DEMO', 'ซิงค์', '3', '11985'];
  r = await upload('sap_sales', 'Sales_261002.csv', day2, { key: 'docentry, linenum' });
  assert.deepEqual([r.body.data.imported, r.body.data.inserted, r.body.data.updated, r.body.data.unchanged], [3, 1, 1, 1]);
  const rows = await q(`select row_key, data->>'Quantity' as qty, to_char(file_date, 'YYYY-MM-DD') as d from sap_sales order by row_key`);
  assert.deepEqual(rows.map((x) => [x.row_key, x.qty, x.d]), [['101|0', '1', '2026-10-02'], ['101|1', '3', '2026-10-02'], ['102|0', '1', '2026-10-02']]);

  // Without key columns the whole row is the key: an identical re-upload adds nothing.
  r = await upload('sap_sales', 'Sales_261002.csv', day2);
  assert.equal(r.body.data.inserted, 3, 'hash keys are separate from DocEntry|LineNum keys');
  r = await upload('sap_sales', 'Sales_261002.csv', day2);
  assert.equal(r.body.data.inserted, 0);
});

test('sales key problems are reported; a key repeated in one file is numbered, never dropped', async () => {
  let r = await upload('sap_sales', 'Sales_261003.csv', [SALES_HEAD, ['1', '0', '', 'X', '', '1', '1']], { key: 'DocNum,LineNum' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /DocNum/);
  r = await upload('sap_sales', 'Sales_261003.csv', [SALES_HEAD,
    ['201', '0', '', 'A', '', '1', '1'], ['201', '0', '', 'A', '', '9', '9'], ['', '', '', 'B', '', '1', '1']], { key: 'DocEntry,LineNum' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.data.imported, r.body.data.repeatedKeys, r.body.data.errorCount], [2, 1, 1]);
  const rows = await q(`select row_key, data->>'Quantity' as qty from sap_sales where row_key like '201|0%' order by row_key`);
  assert.deepEqual(rows.map((x) => [x.row_key, x.qty]), [['201|0', '1'], ['201|0#2', '9']]);
});

test('the real NDBS_ReportSales shape: no line number, US date-times become ISO dates', async () => {
  const head = ['DocDate', 'DocNum', 'CardCode', 'CardName', 'Channel', 'SalesEmployee', 'Brand', 'ItemCode', 'Dscription', 'Quantity', 'NetAmount', 'DocType'];
  const line = (date, doc, item, qty, type) => [date, doc, 'C0001', 'ร้านทดสอบ', 'GT', 'พนักงาน ก', 'EVE', item, 'สินค้า', qty, '1000', type];
  const r = await upload('sap_sales', 'Sales_261016.csv', [head,
    line('10/16/2024 12:00:00 AM', '5001', 'HC-1', '1', 'Invoice'), line('10/16/2024 12:00:00 AM', '5001', 'HC-1', '2', 'Invoice'),
    line('10/16/2026 1:30:00 PM', '5001', 'HC-1', '-1', 'Credit Note'), line('10/16/2026 00:00:00', '5002', 'HC-2', '1', 'Invoice')],
  { key: 'DocType,DocNum,ItemCode', date: '2026-10-16' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.data.inserted, r.body.data.repeatedKeys], [4, 1]);
  const rows = await q(`select row_key, data->>'DocDate' as d from sap_sales where row_key like '%|500%' order by row_key`);
  assert.deepEqual(rows.map((x) => [x.row_key, x.d]), [
    ['Credit Note|5001|HC-1', '2026-10-16 13:30:00'], ['Invoice|5001|HC-1', '2024-10-16'], ['Invoice|5001|HC-1#2', '2024-10-16'], ['Invoice|5002|HC-2', '2026-10-16']]);
});

test('uploads need the integration token, a sane file date and some rows; the response carries no row data', async () => {
  assert.equal((await upload('sap_stock', 'Stock_261014.csv', [STOCK_HEAD, ['A', 'a', 'W', '1']], {}, 'wrong')).status, 401);
  assert.equal((await upload('sap_stock', 'Stock_261399.csv', [STOCK_HEAD, ['A', 'a', 'W', '1']])).status, 400);
  assert.equal((await upload('sap_stock', 'Stock_261014.csv', [STOCK_HEAD])).status, 400);
  assert.equal((await upload('sap_stock', 'Stock_691014.csv', [STOCK_HEAD, ['A', 'a', 'W', '1']], { date: '14/10/2569' })).status, 400);
  const be = await upload('sap_stock', 'Stock_691014.csv', [STOCK_HEAD, ['A', 'a', 'W', '1']], { date: '2026-10-14' });
  assert.equal(be.body.data.fileDate, '2026-10-14', 'the explicit date wins over a Buddhist-era file name');
  const r = await upload('sap_stock', 'Stock_261014.csv', [STOCK_HEAD, ['A', 'a', 'W', '1']]);
  assert.deepEqual(Object.keys(r.body.data).sort(), ['columns', 'fileDate', 'imported', 'itemCodeColumn', 'type']);
  const audit = await q(`select detail from audit_log where action = 'IMPORT' order by id desc limit 1`);
  assert.equal(audit[0].detail.type, 'sap_stock');
});
