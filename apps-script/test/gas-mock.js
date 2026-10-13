/**
 * Minimal in-memory stand-in for the Apps Script services the app uses, so the real
 * src/*.gs files can run under Node for tests and the local preview server.
 */
'use strict';
process.env.TZ = 'Asia/Bangkok';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

class FakeRange {
  constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr, nc }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const src = this.sheet.data[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.nc; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined || v === null ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.nr || values.some((l) => l.length !== this.nc)) {
      throw new Error(`setValues size mismatch: range ${this.nr}x${this.nc}, data ${values.length}x${values[0] && values[0].length}`);
    }
    values.forEach((line, r) => {
      const idx = this.row - 1 + r;
      while (this.sheet.data.length <= idx) this.sheet.data.push([]);
      line.forEach((v, c) => { this.sheet.data[idx][this.col - 1 + c] = v; });
    });
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.nr; r++) {
      const line = this.sheet.data[this.row - 1 + r];
      if (!line) continue;
      for (let c = 0; c < this.nc; c++) line[this.col - 1 + c] = '';
    }
    return this;
  }
  setNumberFormat() { return this; }
}

class FakeSheet {
  constructor(name, data) { this.name = name; this.data = data || []; }
  getName() { return this.name; }
  getLastRow() {
    for (let r = this.data.length - 1; r >= 0; r--) {
      if ((this.data[r] || []).some((v) => v !== '' && v !== undefined && v !== null)) return r + 1;
    }
    return 0;
  }
  getLastColumn() {
    let max = 0;
    this.data.forEach((line) => {
      for (let c = (line || []).length - 1; c >= 0; c--) {
        if (line[c] !== '' && line[c] !== undefined && line[c] !== null) { max = Math.max(max, c + 1); break; }
      }
    });
    return max;
  }
  getMaxRows() { return Math.max(1000, this.data.length); }
  getRange(row, col, nr, nc) {
    if (typeof row !== 'number' || row < 1 || col < 1) throw new Error('getRange: bad args ' + [row, col, nr, nc]);
    return new FakeRange(this, row, col, nr || 1, nc || 1);
  }
  setFrozenRows() { return this; }
}

class FakeSpreadsheet {
  constructor(id) { this.id = id; this.sheets = {}; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { this.sheets[n] = new FakeSheet(n); return this.sheets[n]; }
  addSheet(n, rows) {
    // Real Sheets hand the script Date objects of the script's own realm.
    const D = this.DateCtor || Date;
    const conv = (v) => (v instanceof Date ? new D(v.getTime()) : v);
    this.sheets[n] = new FakeSheet(n, rows.map((r) => r.map(conv)));
    return this.sheets[n];
  }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
}

function pad(n, w) { return String(n).padStart(w || 2, '0'); }
function formatDate(d, tz, fmt) {
  // Node runs with TZ=Asia/Bangkok so local getters match the script timezone.
  const parts = [];
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] === "'") {
      const j = fmt.indexOf("'", i + 1);
      parts.push(fmt.substring(i + 1, j));
      i = j + 1;
      continue;
    }
    const m = /^(yyyy|yy|MM|dd|HH|mm|ss)/.exec(fmt.substring(i));
    if (m) {
      const t = m[1];
      parts.push({
        yyyy: d.getFullYear(), yy: pad(d.getFullYear() % 100), MM: pad(d.getMonth() + 1), dd: pad(d.getDate()),
        HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds())
      }[t]);
      i += t.length;
      continue;
    }
    parts.push(fmt[i]);
    i++;
  }
  return parts.join('');
}

/**
 * Creates a fresh environment with the app loaded.
 * @return {{ctx, active: FakeSpreadsheet, books: Object, mail: Array, as: function(string), call: function}}
 */
function createEnv() {
  const books = {};
  const active = new FakeSpreadsheet('ACTIVE_ID');
  books.ACTIVE_ID = active;
  const mail = [];
  const cache = {};
  const triggers = [];
  const state = { email: '' };

  const ctx = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => active,
      openById: (id) => { if (!books[id]) throw new Error('No spreadsheet ' + id); return books[id]; },
      getUi: () => { throw new Error('No UI in tests'); }
    },
    Session: { getActiveUser: () => ({ getEmail: () => state.email }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in cache ? cache[k] : null),
        put: (k, v) => { cache[k] = v; },
        remove: (k) => { delete cache[k]; }
      })
    },
    MailApp: { sendEmail: (o) => { mail.push(o); } },
    Utilities: { formatDate },
    ScriptApp: {
      getService: () => ({ getUrl: () => 'https://script.google.com/a/macros/eve.co.th/s/TEST/exec' }),
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: (fn) => {
        const b = { timeBased: () => b, everyDays: () => b, atHour: () => b, create: () => { const t = { getHandlerFunction: () => fn }; triggers.push(t); return t; } };
        return b;
      }
    },
    HtmlService: {}
  };
  vm.createContext(ctx);
  active.DateCtor = vm.runInContext('Date', ctx);
  const dir = path.join(__dirname, '..', 'src');
  fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).sort().forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  });

  // Every google.script.run call is a fresh execution in Apps Script, so per-call memos reset.
  function call(email, fn, ...args) {
    state.email = email;
    vm.runInContext('userMemo_ = null; settingsMemo_ = null; channelsMemo_ = null; productsMemo_ = null;', ctx);
    if (typeof ctx[fn] !== 'function') throw new Error('No function ' + fn);
    if (fn.endsWith('_')) throw new Error(fn + ' is private and not callable from the browser');
    // Round-trip through JSON like google.script.run does (Dates are not allowed there).
    const res = ctx[fn](...JSON.parse(JSON.stringify(args)));
    return res === undefined ? undefined : JSON.parse(JSON.stringify(res));
  }

  return { ctx, active, books, mail, triggers, call, addBook: (id) => { books[id] = new FakeSpreadsheet(id); books[id].DateCtor = active.DateCtor; return books[id]; } };
}

module.exports = { createEnv, formatDate };
