"use strict";
/**
 * Minimal Google Apps Script runtime shim so server/Code.gs can be executed
 * and tested in Node. Simulates SpreadsheetApp, CacheService, UrlFetchApp,
 * LockService, PropertiesService, ContentService, Utilities and Session.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class Range {
  constructor(sheet, row, col, nRows, nCols) {
    Object.assign(this, { sheet, row, col, nRows, nCols });
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nRows; i++) {
      const src = this.sheet.values[this.row - 1 + i] || [];
      const line = [];
      for (let c = 0; c < this.nCols; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(arr) {
    for (let i = 0; i < arr.length; i++) {
      const target = this.row - 1 + i;
      while (this.sheet.values.length <= target) this.sheet.values.push([]);
      for (let c = 0; c < arr[i].length; c++) {
        this.sheet.values[target][this.col - 1 + c] = arr[i][c];
      }
    }
    this.sheet.writes++;
    return this;
  }
  setValue(v) {
    const target = this.row - 1;
    while (this.sheet.values.length <= target) this.sheet.values.push([]);
    this.sheet.values[target][this.col - 1] = v;
    this.sheet.writes++;
    return this;
  }
}

const counters = { getDataRangeCalls: 0 };

class Sheet {
  constructor(name) {
    this.name = name; this.values = []; this.frozen = 0;
    this.writes = 0; this.deleteCalls = []; this.appendCalls = 0;
  }
  getLastRow() { return this.values.length; }
  appendRow(r) { this.values.push(r.slice()); this.appendCalls++; return this; }
  getRange(row, col, nRows, nCols) {
    if (nRows === undefined) return new Range(this, row, col, 1, 1);
    return new Range(this, row, col, nRows, nCols);
  }
  getDataRange() {
    counters.getDataRangeCalls++;
    const cols = this.values.length ? Math.max(...this.values.map(r => r.length)) : 1;
    return new Range(this, 1, 1, this.values.length, cols);
  }
  deleteRows(start, count) { this.deleteCalls.push([start, count]); this.values.splice(start - 1, count); }
  deleteRow(r) { this.deleteRows(r, 1); }
  setFrozenRows(n) { this.frozen = n; return this; }
  insertSheet() { throw new Error('use spreadsheet.insertSheet'); }
}

class Spreadsheet {
  constructor(id) { this.id = id; this.sheets = {}; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets[n] = s; return s; }
  getSheets() { return Object.values(this.sheets); }
  tab(n) { if (!this.sheets[n]) this.sheets[n] = new Sheet(n); return this.sheets[n]; }
}

function makeGas({ spreadsheets, sis, sleep = () => {} } = {}) {
  const ss = spreadsheets || {};
  const cache = new Map();
  const stats = { fetchAllCalls: 0, fetchAllThrows: 0, fetchCalls: 0, cacheReads: 0, cacheWrites: 0,
                  fullSheetReads: 0, sleeps: 0, flushes: 0 };

  const CacheService = {
    getScriptCache: () => ({
      get: (k) => { stats.cacheReads++; return cache.has(k) ? cache.get(k) : null; },
      put: (k, v, ttl) => {
        if (typeof v !== 'string') throw new Error('cache value must be a string');
        if (v.length > 100 * 1024) throw new Error('cache value exceeds 100KB: ' + v.length);
        stats.cacheWrites++; cache.set(k, v);
      },
      getAll: (keys) => { stats.cacheReads++; const o = {}; keys.forEach(k => { if (cache.has(k)) o[k] = cache.get(k); }); return o; },
      removeAll: (keys) => keys.forEach(k => cache.delete(k)),
    }),
  };

  const resp = (r) => ({ getResponseCode: () => r.code, getContentText: () => r.body });

  const UrlFetchApp = {
    fetchAll: (requests, opts) => {
      stats.fetchAllCalls++;
      if (sis.failBatch && sis.failBatch(requests)) { stats.fetchAllThrows++; throw new Error('Connection reset (simulated)'); }
      return requests.map(rq => {
        const out = sis.respond(rq.url);
        if (out && out.__throw) throw new Error(out.__throw);
        return resp(out);
      });
    },
    fetch: (url, opts) => {
      stats.fetchCalls++;
      const out = sis.respond(url);
      if (out && out.__throw) throw new Error(out.__throw);
      return resp(out);
    },
  };

  let lockHeld = 0;
  const LockService = {
    getScriptLock: () => ({
      waitLock: (ms) => { if (lockHeld) throw new Error('lock busy'); lockHeld++; },
      tryLock:  (ms) => { if (lockHeld) return false; lockHeld++; return true; },
      releaseLock: () => { lockHeld = Math.max(0, lockHeld - 1); },
    }),
  };

  const props = new Map();
  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => props.set(k, v),
    }),
  };

  let lastOutput = null, lastMime = null;
  const ContentService = {
    MimeType: { JSON: 'application/json', JAVASCRIPT: 'application/javascript' },
    createTextOutput: (s) => ({
      setMimeType: (m) => { lastOutput = s; lastMime = m; return { getContent: () => s }; },
    }),
  };

  const Utilities = {
    formatDate: (d, tz, fmt) => {
      const p = n => String(n).padStart(2, '0');
      return fmt.replace('yyyy', d.getUTCFullYear()).replace('MM', p(d.getUTCMonth() + 1)).replace('dd', p(d.getUTCDate()));
    },
    sleep: (ms) => { stats.sleeps++; sleep(ms); },
  };

  const Session = { getScriptTimeZone: () => 'Asia/Karachi' };

  const sandbox = {
    SpreadsheetApp: {
      openById: (id) => { if (!ss[id]) ss[id] = new Spreadsheet(id); return ss[id]; },
      flush: () => { stats.flushes++; },
      getActiveSpreadsheet: () => null,
    },
    CacheService, UrlFetchApp, LockService, PropertiesService, ContentService, Utilities, Session,
    console, JSON, Math, Date, Object, Array, String, Number, parseInt, parseFloat, isNaN, encodeURIComponent,
  };
  sandbox.globalThis = sandbox;

  // Top-level `const` in a vm script does not land on the sandbox object, so
  // publish the internals we need to assert against.
  const code = fs.readFileSync(path.join(__dirname, '..', 'server', 'Code.gs'), 'utf8') +
    '\n;globalThis.__api = { CONFIG, SCRIPT_VERSION, doGet, doPost, getSchoolsByMarkaz,' +
    ' deleteRowsBulk_, fetchWithRetry_, buildDailyRow, NUM_COLS };';
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'Code.gs' });

  /** Verbatim body of the response — needed to assert on JSONP wrapping. */
  const callRaw = (params) => {
    lastOutput = null; lastMime = null;
    sandbox.doGet({ parameter: params });
    return lastOutput;
  };

  const call = (params) => {
    const raw = callRaw(params);
    return raw ? JSON.parse(raw) : null;
  };

  return { sandbox, api: sandbox.__api, ss, cache, stats, counters, call, callRaw,
           getLastOutput: () => lastOutput, getLastMime: () => lastMime,
           setProp: (k, v) => props.set(k, v) };
}

module.exports = { makeGas, Sheet, Spreadsheet, counters };
