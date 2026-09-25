"use strict";
/**
 * Test harness: loads the REAL index.html into jsdom and drives it against a
 * mock Google Apps Script that reproduces the failure modes seen in production
 * (partial "done", shrinking batches, HTML auth pages, duplicates, blips).
 *
 * Nothing here re-implements dashboard logic — it exercises the shipped file.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', 'index.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');
const loadHTML = p => fs.readFileSync(p, 'utf8');

const CSV_HOST = 'docs.google.com';
const GAS_HOST = 'script.google.com';

// ── synthetic school master list ────────────────────────────────────────────
function makeMaster(n, opts = {}) {
  const rows = [['EMIS', 'School Name', 'District', 'Wing', 'Tehsil', 'Markaz', 'Level', 'Gender']];
  for (let i = 1; i <= n; i++) {
    const emis = 'E' + String(i).padStart(4, '0');
    let name = opts.names && opts.names[i - 1] ? opts.names[i - 1] : `Govt Primary School No ${i}`;
    rows.push([emis, name, opts.district || 'Layyah', opts.wing || 'Wing A',
               opts.tehsil || 'Tehsil 1', opts.markaz || 'Markaz M1',
               i % 3 === 0 ? 'Middle' : 'Primary', i % 2 ? 'Male' : 'Female']);
  }
  return toCSVText(rows);
}

function toCSVText(rows) {
  return rows.map(r => r.map(c => {
    const s = String(c);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
}

function schoolRow(s, over = {}) {
  return Object.assign({
    emis: s.emis, name: s.name, level: s.level, gender: s.gender,
    sPresent: 40, sAbsent: 5, sMarked: 45,
    tPresent: 3,  tAbsent: 1, tMarked: 4,
    status: 'ok', timestamp: '2026-09-25T09:00:00Z',
  }, over);
}

// ── environment ─────────────────────────────────────────────────────────────
/**
 * @param {object} opts
 *   master       published school-list CSV
 *   handler      mock Apps Script: (req, n) => response object
 *   htmlPath     dashboard to load (defaults to index.html)
 *   corsBlocked  every fetch() to Apps Script throws TypeError — exactly what a
 *                browser does when the response arrives without
 *                Access-Control-Allow-Origin ("Cross-Origin Request Blocked")
 *   jsonpBlocked the CORS-free <script> channel fails as well
 */
function makeEnv({ master, handler, htmlPath, corsBlocked = false, jsonpBlocked = false }) {
  const downloads = [];
  const gasRequests = [];
  const consoleErrors = [];
  const jsonpRequests = [];

  const vc = new VirtualConsole();
  vc.on('jsdomError', e => consoleErrors.push('jsdomError: ' + e.message));
  vc.on('error', (...a) => consoleErrors.push('console.error: ' + a.join(' ')));

  let pendingBlob = null;

  const dom = new JSDOM(htmlPath ? loadHTML(htmlPath) : HTML, {
    runScripts: 'dangerously',
    url: 'http://localhost/',
    pretendToBeVisual: true,
    virtualConsole: vc,
    resources: undefined,
    beforeParse(window) {
      if (!window.AbortController) window.AbortController = AbortController;
      try { window.crypto = require('crypto').webcrypto; } catch (e) {}

      window.URL.createObjectURL = blob => {
        // jsdom's Blob has no .text(); read it eagerly through the window's FileReader.
        const rec = { blob };
        rec.text = (typeof blob.text === 'function')
          ? blob.text()
          : new Promise((res, rej) => {
              const fr = new window.FileReader();
              fr.onload = () => res(fr.result);
              fr.onerror = () => rej(new Error('FileReader failed'));
              fr.readAsText(blob);
            });
        rec.bytes = (typeof blob.arrayBuffer === 'function')
          ? blob.arrayBuffer()
          : new Promise((res, rej) => {
              const fr = new window.FileReader();
              fr.onload = () => res(fr.result);
              fr.onerror = () => rej(new Error('FileReader failed'));
              fr.readAsArrayBuffer(blob);
            });
        pendingBlob = rec;
        return 'blob:fake';
      };
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () {
        downloads.push({
          filename: this.download,
          blob: pendingBlob && pendingBlob.blob,
          text: pendingBlob && pendingBlob.text,
          bytes: pendingBlob && pendingBlob.bytes,
        });
      };

      window.fetch = async (url, opts) => {
        const u = new URL(url, 'http://localhost/');
        const resp = (obj) => ({
          ok: obj.status ? obj.status < 400 : true,
          status: obj.status || 200,
          text: async () => obj.body,
          // The pre-fix dashboard called resp.json() directly; keep it working
          // so the baseline can be driven by the same mock.
          json: async () => JSON.parse(obj.body),
        });

        if (u.hostname.includes(CSV_HOST)) {
          return resp({ body: master });
        }

        if (u.hostname.includes(GAS_HOST)) {
          const req = {
            action: u.searchParams.get('action'),
            markaz: u.searchParams.get('markaz'),
            runId:  u.searchParams.get('runId'),
            round:  u.searchParams.get('round'),
            emis:   (u.searchParams.get('emis') || '').split(',').filter(Boolean),
          };
          gasRequests.push(req);

          // A CORS block: the browser never lets the page read the response.
          if (corsBlocked) throw new TypeError('Failed to fetch');

          const out = await handler(req, gasRequests.length);

          if (out.__throw === 'network') throw new TypeError('Failed to fetch');
          if (out.__throw === 'timeout') {
            const e = new Error('aborted'); e.name = 'AbortError'; throw e;
          }
          if (out.__html !== undefined) return resp({ body: out.__html, status: out.__status || 200 });
          if (out.__status) return resp({ body: out.__body || '', status: out.__status });
          if (out.__raw !== undefined) return resp({ body: out.__raw });
          return resp({ body: JSON.stringify(out) });
        }

        return resp({ body: '', status: 404 });
      };

      // ── JSONP channel (the dashboard's CORS-free fallback) ────────────────
      // jsdom does not fetch external scripts, so the injected <script> is
      // answered here through the same mock backend as fetch().
      // document.head is not parsed yet inside beforeParse, so hook the
      // prototype that head's appendChild resolves through.
      const nativeAppend = window.Element.prototype.appendChild;
      window.Element.prototype.appendChild = function (node) {
        if (!node || node.tagName !== 'SCRIPT' || !node.src || node.src.indexOf(GAS_HOST) === -1) {
          return nativeAppend.call(this, node);
        }
        const u = new URL(node.src, 'http://localhost/');
        const cb = u.searchParams.get('callback');
        const req = {
          action:   u.searchParams.get('action'),
          markaz:   u.searchParams.get('markaz'),
          runId:    u.searchParams.get('runId'),
          round:    u.searchParams.get('round'),
          emis:     (u.searchParams.get('emis') || '').split(',').filter(Boolean),
          callback: cb,
        };
        gasRequests.push(req);
        jsonpRequests.push(req);

        Promise.resolve()
          .then(() => (jsonpBlocked ? { __throw: 'network' } : handler(req, gasRequests.length)))
          .then(out => {
            if (out && out.__throw === 'network') {
              node.dispatchEvent(new window.Event('error'));
              return;
            }
            if (out && out.__html !== undefined) {
              // An HTML error page is not executable — the browser reports a
              // script parse failure, never a callback.
              const ev = new window.Event('error');
              ev.filename = node.src;
              window.dispatchEvent(ev);
              return;
            }
            if (typeof window[cb] === 'function') window[cb](out);
          })
          .catch(() => node.dispatchEvent(new window.Event('error')));

        return node;
      };
    },
  });

  const { window } = dom;
  const S = window.__SIS__;

  // Shrink all timings so the suite runs in milliseconds.
  if (S && S.CFG) Object.assign(S.CFG, {
    pollStartMs: 4, pollMaxMs: 6, pollStepMs: 0, pollJitter: 0,
    pollTimeoutMs: 1000, triggerTimeoutMs: 1000, triggerRetries: 3,
    maxPolls: 400, maxRounds: 3, roundGateMs: 8, stallPolls: 4,
    maxNetErrors: 3, runDeadlineMs: 20000, csvRetries: 1,
    jsonpTimeoutMs: 500, probeTimeoutMs: 500,
  });

  return { dom, window, S, downloads, gasRequests, jsonpRequests, consoleErrors,
           doc: window.document, $: id => window.document.getElementById(id) };
}

async function bootMaster(env) {
  // Wait for init() to finish populating the district select.
  for (let i = 0; i < 600; i++) {
    const opts = env.$('selDistrict') ? env.$('selDistrict').options.length : 0;
    if (opts > 1) return opts - 1;
    await new Promise(r => setTimeout(r, 5));
  }
  return 0;
}

async function selectPath(env, { district, wing, tehsil, markaz }) {
  const set = (id, val, evt) => {
    const el = env.$(id);
    el.value = val;
    el.dispatchEvent(new env.window.Event('change'));
  };
  set('selDistrict', district);
  await tick(); if (wing)   set('selWing', wing);
  await tick(); if (tehsil) set('selTehsil', tehsil);
  await tick(); if (markaz) set('selMarkaz', markaz);
  await tick();
}

const tick = (ms = 1) => new Promise(r => setTimeout(r, ms));

async function blobText(rec) {
  if (!rec) return null;
  if (rec.text) return rec.text;
  if (typeof rec.text === 'function') return rec.text();
  return null;
}

module.exports = { makeEnv, makeMaster, toCSVText, schoolRow, bootMaster, selectPath, tick, blobText };
