"use strict";
/**
 * Demonstrates that the bugs fixed in v2 were real, by running the ORIGINAL
 * index.html (tests/_original-index.html, extracted from git HEAD) through the
 * same harness as the new one.
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { makeEnv, makeMaster, schoolRow, bootMaster, selectPath, tick } = require('./harness');

const SEL = { district: 'Layyah', wing: 'Wing A', tehsil: 'Tehsil 1', markaz: 'Markaz M1' };
const ORIG = path.join(__dirname, '_original-index.html');
const BASELINE = 'e8ba1774afd1070c386ca7379d3a083b7473f613';

// Extract the pre-fix dashboard from git on demand so the baseline can never drift.
if (!fs.existsSync(ORIG)) {
  const html = execFileSync('git', ['show', `${BASELINE}:index.html`],
                            { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 1 << 24 });
  fs.writeFileSync(ORIG, html);
  console.log(`extracted baseline index.html from ${BASELINE.slice(0, 7)} (${html.length} bytes)`);
}

function schools(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push({ emis: 'E' + String(i).padStart(4, '0'),
    name: `Govt Primary School No ${i}`, level: 'Primary', gender: 'Male' });
  return out;
}

const wait = ms => new Promise(r => setTimeout(r, ms));
async function waitUntil(fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(25); }
  return false;
}
const rowCount = env => env.$('studentsTbody').querySelectorAll('tr').length;

async function bootOriginal(handler, n) {
  const env = makeEnv({ master: makeMaster(n), handler, htmlPath: ORIG });
  await bootMaster(env);
  await selectPath(env, SEL);
  env.$('btnFetch').disabled = false;
  return env;
}

function head(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }
function verdict(label, original, fixed) {
  console.log(`  original : ${original}`);
  console.log(`  fixed    : ${fixed}`);
}

(async () => {
  console.log('\n' + '═'.repeat(68));
  console.log('REGRESSION PROOF — original index.html vs rebuilt index.html');
  console.log('═'.repeat(68));

  // ── A. Server reports "done" with only 6 of 10 schools ──────────────────
  head('A. Server says state=done after returning only 6 of 10 schools');
  {
    const all = schools(10);
    let available = all.slice(0, 6);
    const handler = (req) => {
      if (req.action === 'fetch') {
        if (req.emis.length) {
          const want = new Set(req.emis);
          const map = new Map(available.map(s => [s.emis, s]));
          for (const s of all) if (want.has(s.emis)) map.set(s.emis, s);
          available = [...map.values()];
        }
        return { started: true };
      }
      return { state: 'done', rows: available.map(s => schoolRow(s)), fetched: available.length, total: 10 };
    };

    const o = await bootOriginal(handler, 10);
    o.$('btnFetch').dispatchEvent(new o.window.Event('click'));
    await waitUntil(() => rowCount(o) > 0, 8000);
    await wait(600);
    const origRows = rowCount(o);
    const origBadge = o.$('sBadge').textContent;
    const origWarn = o.$('completenessBar') ? o.$('completenessBar').className : '(element does not exist)';
    o.window.close();

    const f = makeEnv({ master: makeMaster(10), handler });
    await bootMaster(f); await selectPath(f, SEL);
    await f.S.startFetch();
    const fixedRows = rowCount(f);
    const fixedBadge = f.$('sBadge').textContent;
    const fixedBar = f.$('completenessBar').className;
    f.window.close();

    verdict('', `${origRows} rows shown, badge "${origBadge}", completeness bar: ${origWarn}`,
               `${fixedRows} rows shown, badge "${fixedBadge}", bar: "${fixedBar}" — auto-retried until complete`);
    console.log(`  \x1b[33m=> the original silently presented 6/10 as a finished result.\x1b[0m`);
  }

  // ── B. Batches shrink between polls ─────────────────────────────────────
  head('B. Later poll returns fewer rows than an earlier one');
  {
    const all = schools(10);
    let poll = 0;
    const handler = (req) => {
      if (req.action === 'fetch') return { started: true };
      poll++;
      if (poll === 1) return { state: 'fetching', rows: all.slice(0, 8).map(s => schoolRow(s)), fetched: 8, total: 10 };
      if (poll === 2) return { state: 'fetching', rows: all.slice(8, 10).map(s => schoolRow(s)), fetched: 10, total: 10 };
      return { state: 'done', rows: all.slice(0, 2).map(s => schoolRow(s)), fetched: 10, total: 10 };
    };

    const o = await bootOriginal(handler, 10);
    o.$('btnFetch').dispatchEvent(new o.window.Event('click'));
    await waitUntil(() => o.$('sBadge') && /2 schools/.test(o.$('sBadge').textContent), 12000);
    await wait(300);
    const origRows = rowCount(o);
    o.window.close();

    poll = 0;
    const f = makeEnv({ master: makeMaster(10), handler });
    await bootMaster(f); await selectPath(f, SEL);
    await f.S.startFetch();
    const fixedRows = rowCount(f);
    f.window.close();

    verdict('', `${origRows} rows survive — the 8 schools from poll 1 were thrown away`,
               `${fixedRows} rows — batches are unioned by EMIS`);
    console.log(`  \x1b[33m=> renderFromGAS() replaced lastRows wholesale, so the newest (smallest)\x1b[0m`);
    console.log(`  \x1b[33m   response overwrote everything already on screen.\x1b[0m`);
  }

  // ── C. Trigger fails; server still serves a stale cached result ─────────
  head('C. Trigger fails, but status still returns a stale cached result');
  {
    const stale = schools(6).map(s => ({ ...s, name: s.name + ' (YESTERDAY)' }));
    const handler = (req) => {
      if (req.action === 'fetch') return { __html: '<html><body>Authorization required</body></html>' };
      return { state: 'done', rows: stale.map(s => schoolRow(s)), fetched: 6, total: 6 };
    };

    const o = await bootOriginal(handler, 10);
    o.$('btnFetch').dispatchEvent(new o.window.Event('click'));
    await waitUntil(() => rowCount(o) > 0, 8000);
    await wait(400);
    const origErr = o.$('errorState').classList.contains('visible');
    const origShown = rowCount(o);
    const origStale = o.$('studentsTbody').textContent.includes('YESTERDAY');
    o.window.close();

    const f = makeEnv({ master: makeMaster(10), handler });
    await bootMaster(f); await selectPath(f, SEL);
    await f.S.startFetch();
    const fixedErr = f.$('errorState').classList.contains('visible');
    const fixedMsg = f.$('errorMsg').textContent;
    f.window.close();

    verdict('',
      `error shown: ${origErr}; ${origShown} stale rows rendered as if fresh (contains "YESTERDAY": ${origStale})`,
      `error shown: ${fixedErr}; message: "${fixedMsg}"`);
    console.log(`  \x1b[33m=> the trigger was fire-and-forget, so a failed trigger was invisible and\x1b[0m`);
    console.log(`  \x1b[33m   yesterday's cached rows were presented as today's attendance.\x1b[0m`);
  }

  // ── D. Teacher table sorted by the wrong column ─────────────────────────
  head('D. Teacher table sorted by student figures');
  {
    const all = schools(5).map((s, i) => ({ ...s, sp: (i + 1) * 10, tp: (5 - i) * 10 }));
    const handler = (req) => req.action === 'fetch' ? { started: true }
      : { state: 'done', rows: all.map(s => schoolRow(s, { sPresent: s.sp, tPresent: s.tp })), fetched: 5, total: 5 };

    const o = await bootOriginal(handler, 5);
    o.$('btnFetch').dispatchEvent(new o.window.Event('click'));
    await waitUntil(() => rowCount(o) === 5, 8000);
    // Original teacher headers use data-col="present" (the STUDENT column key).
    const origHeader = o.doc.querySelector('#teachersTable th[data-col="present"]');
    origHeader.dispatchEvent(new o.window.Event('click'));
    await wait(60);
    const origTeacherOrder = [...o.$('teachersTbody').querySelectorAll('tr')]
      .map(tr => tr.children[3].textContent).join(',');
    const origHeaderKeys = [...o.doc.querySelectorAll('#teachersTable th')].map(th => th.dataset.col).join(',');
    o.window.close();

    const f = makeEnv({ master: makeMaster(5), handler });
    await bootMaster(f); await selectPath(f, SEL);
    await f.S.startFetch();
    f.doc.querySelector('#teachersTable th[data-col="tPresent"]').dispatchEvent(new f.window.Event('click'));
    const fixedTeacherOrder = [...f.$('teachersTbody').querySelectorAll('tr')]
      .map(tr => tr.children[4].textContent).join(',');
    f.window.close();

    verdict('',
      `teacher column keys were [${origHeaderKeys}] — clicking Present sorted by sPresent => ${origTeacherOrder}`,
      `teacher columns keyed tPresent/tAbsent/tMarked => ${fixedTeacherOrder}`);
    console.log(`  \x1b[33m=> sortData()'s colMap mapped "tpresent" but the headers said "present",\x1b[0m`);
    console.log(`  \x1b[33m   and renderTableBody() ignored its own sortKey argument entirely.\x1b[0m`);
  }

  // ── E. No CSV export at all ─────────────────────────────────────────────
  head('E. CSV export');
  {
    const o = await bootOriginal(() => ({ state: 'empty', rows: [] }), 3);
    const origHas = !!o.doc.querySelector('[data-report], [data-quickexport], #btnExport');
    o.window.close();
    const f = makeEnv({ master: makeMaster(3), handler: () => ({ state: 'empty', rows: [] }) });
    await bootMaster(f);
    const fixedCount = f.doc.querySelectorAll('[data-report]').length +
                       f.doc.querySelectorAll('[data-quickexport]').length;
    f.window.close();
    verdict('', `any export control present: ${origHas}`, `${fixedCount} export controls (6 reports + 2 table shortcuts)`);
  }

  console.log('\n' + '═'.repeat(68) + '\n');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(2); });
