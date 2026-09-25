"use strict";
/**
 * Server suite: executes the REAL server/Code.gs in a Node-hosted Apps Script
 * shim and asserts on its behaviour. This tests the shipped server code, not a
 * re-implementation of it.
 */
const { makeGas, counters } = require('./gas-shim');

const DB_ID   = "1Y5nOSaEGtksZ7sZJNpXMCin6hKRBzTIb0yKmCmq3-pc";
const OUT_ID  = "1SjLf4kGpwZfeuZIQX6HR6hoWDeMFgh6u-A1-WPhbdCM";
const MARKAZ  = "Markaz M1";

let pass = 0, fail = 0; const failures = [];
function ok(c, l) { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); } else { fail++; failures.push(l); console.log(`  \x1b[31m✗ ${l}\x1b[0m`); } }
function eq(a, b, l) { ok(a === b, `${l} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

function schoolList(n, markaz) {
  const rows = [["#", "#", "Markaz", "#", "#", "EMIS", "School Name", "Level", "Gender"]];
  for (let i = 1; i <= n; i++) {
    rows.push(["", "", markaz || MARKAZ, "", "",
      "E" + String(i).padStart(4, "0"), `Govt Primary School No ${i}`,
      i % 3 === 0 ? "Middle" : "Primary", i % 2 ? "Male" : "Female"]);
  }
  return rows;
}

const emisOf = (url) => (url.match(/s_id_emis_code=([^&]+)/) || [])[1];
const isTeacher = (url) => url.indexOf("teachers") >= 0;
const isMonthly = (url) => url.indexOf("line_stats") >= 0;

function busyWait(ms) {
  if (!ms) return;
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** Build a SIS responder with configurable per-school failure behaviour. */
function makeSis(opts = {}) {
  const attempts = {};
  return {
    attempts,
    slowMs: opts.slowMs || 0,
    failBatch: opts.failBatch || null,
    respond(url) {
      busyWait(this.slowMs);
      const emis = emisOf(url);
      const kind = isTeacher(url) ? 't' : 's';
      const key = emis + ':' + kind;
      attempts[key] = (attempts[key] || 0) + 1;
      const n = attempts[key];

      // Always-fail schools
      if (opts.alwaysFail && opts.alwaysFail.includes(emis)) return { __throw: 'socket hang up' };
      // Fail until attempt k
      if (opts.failUntil && opts.failUntil[emis] && n <= opts.failUntil[emis]) {
        return { __throw: 'ETIMEDOUT (attempt ' + n + ')' };
      }
      if (opts.httpError && opts.httpError.includes(emis)) return { code: 500, body: 'server error' };

      if (isMonthly(url)) {
        return { code: 200, body: JSON.stringify({
          present: [10, 12], absent: [1, 0], unmarked: [0, 0], categories: ['A', 'B'],
          day: 25, weekends: { "6": true }, holidayDates: [],
        }) };
      }
      const base = kind === 's' ? { present_count: 40, absent_count: 5, marked_count: 45 }
                                : { present_count: 3,  absent_count: 1, marked_count: 4 };
      return { code: 200, body: JSON.stringify(Object.assign(base, { todayDate: '2026-09-25' })) };
    },
  };
}

function setup(n, sisOpts, extraRows) {
  const sis = makeSis(sisOpts);
  const gas = makeGas({ sis });
  const db = gas.ss[DB_ID] || (gas.ss[DB_ID] = new (require('./gas-shim').Spreadsheet)(DB_ID));
  const sh = db.tab('Schools');
  schoolList(n).concat(extraRows || []).forEach(r => sh.appendRow(r));
  return { gas, sis, db };
}

const outSheet = (gas) => {
  const { Spreadsheet } = require('./gas-shim');
  if (!gas.ss[OUT_ID]) gas.ss[OUT_ID] = new Spreadsheet(OUT_ID);
  return gas.ss[OUT_ID].tab('AttendanceFetch');
};

(async () => {
  console.log('\n' + '═'.repeat(68));
  console.log('SERVER SUITE — server/Code.gs executed under an Apps Script shim');
  console.log('═'.repeat(68));

  // ── 1. Happy path ───────────────────────────────────────────────────────
  section('1. Daily fetch, 15 schools, no failures');
  {
    const { gas } = setup(15);
    const r = gas.call({ action: 'fetch', markaz: MARKAZ, runId: 'R1' });
    eq(r.state, 'done', 'completes in one execution');
    eq(r.total, 15, 'total is the DB school count');
    eq(r.rows.length, 15, 'all 15 rows returned');
    eq(r.missing.length, 0, 'nothing missing');
    eq(r.failedCount, 0, 'no failures');
    eq(r.runId, 'R1', 'runId echoed back');
    eq(r.version, gas.api.SCRIPT_VERSION, 'version reported');
    eq(outSheet(gas).getLastRow(), 16, 'sheet committed: header + 15 rows');
    eq(r.rows.every(x => x.status === 'ok'), true, 'every row ok');
    eq(r.todayDate, '2026-09-25', 'todayDate surfaced');
  }

  // ── 2. THE ROOT-CAUSE FIX: per-school retry ─────────────────────────────
  section('2. Flaky schools recover via per-school retry');
  {
    // These three time out twice, then succeed on the third attempt.
    const { gas, sis } = setup(15, { failUntil: { E0003: 2, E0007: 2, E0011: 2 } });
    const r = gas.call({ action: 'fetch', markaz: MARKAZ, runId: 'R2' });
    eq(r.state, 'done', 'run completes');
    eq(r.failedCount, 0, 'NO schools left failed — the flaky ones recovered');
    eq(r.rows.filter(x => x.status === 'ok').length, 15, 'all 15 rows carry real data');
    ok(sis.attempts['E0003:s'] >= 3,
       `E0003 was retried at least MAX_ATTEMPTS times (${sis.attempts['E0003:s']} calls)`);
    ok(gas.stats.fetchCalls > 0,
       `the batch abort fell back to ${gas.stats.fetchCalls} individual requests (this is the fix)`);
    eq(r.rows.find(x => x.emis === 'E0003').sPresent, 40, 'recovered school has correct figures');
  }

  // ── 3. Batch-level fetchAll throw no longer blanks 10 schools ───────────
  section('3. fetchAll throws for a whole batch');
  {
    let thrown = 0;
    const { gas, sis } = setup(20, {});
    sis.failBatch = () => { if (thrown < 1) { thrown++; return true; } return false; };
    const r = gas.call({ action: 'fetch', markaz: MARKAZ, runId: 'R3' });
    eq(r.state, 'done', 'run completes');
    eq(r.failedCount, 0, 'no school was blanked by the batch failure');
    ok(gas.stats.fetchAllThrows >= 1, `fetchAll threw ${gas.stats.fetchAllThrows} time(s)`);
    ok(gas.stats.fetchCalls > 0, `fell back to ${gas.stats.fetchCalls} individual requests`);
    eq(r.rows.every(x => x.sPresent === 40), true, 'every school has real figures');
  }

  // ── 4. A genuinely dead school is reported honestly ─────────────────────
  section('4. One permanently dead school');
  {
    const { gas, sis } = setup(15, { alwaysFail: ['E0009'] });
    const r = gas.call({ action: 'fetch', markaz: MARKAZ, runId: 'R4' });
    eq(r.failedCount, 1, 'exactly one school failed');
    const bad = r.rows.find(x => x.emis === 'E0009');
    eq(bad.status, 'error', 'the dead school is marked error');
    eq(bad.sPresent, null, 'and carries no fake numbers');
    eq(r.rows.filter(x => x.status === 'ok').length, 14, 'the other 14 are unaffected');
    ok(sis.attempts['E0009:s'] >= 3,
       `it was retried at least MAX_ATTEMPTS times before giving up (${sis.attempts['E0009:s']} calls)`);
  }

  // ── 5. Time-budgeted chunking — no 6-minute wall ────────────────────────
  section('5. Chunking a 120-school secondary wing across executions');
  {
    const { gas, sis } = setup(120, { slowMs: 3 });
    gas.api.CONFIG.WORK_BUDGET_MS = 20;   // force ~1 batch per execution

    let res = gas.call({ action: 'fetch', markaz: MARKAZ, runId: 'R5' });
    eq(res.state, 'fetching', 'first execution returns before finishing');
    eq(res.hasMore, true, 'reports there is more work');
    const midSheet = gas.ss[OUT_ID] && gas.ss[OUT_ID].getSheetByName('AttendanceFetch');
    ok(!midSheet || midSheet.getLastRow() <= 1, 'nothing committed to the sheet yet');

    let chunks = 1;
    while (res.state === 'fetching' && chunks < 40) {
      res = gas.call({ action: 'fetchChunk', markaz: MARKAZ, runId: 'R5' });
      chunks++;
    }
    eq(res.state, 'done', `finished after ${chunks} executions`);
    eq(res.total, 120, 'total is 120');
    eq(res.rows.length, 120, 'all 120 rows present');
    eq(res.missing.length, 0, 'nothing missing');
    ok(chunks > 1, `work was genuinely split (${chunks} executions, none hit 6 minutes)`);
    eq(outSheet(gas).getLastRow(), 121, 'committed once, at the end: header + 120');
  }

  // ── 6. A crashed run leaves the previous data intact ────────────────────
  section('6. Never deletes before fetching');
  {
    const { gas, sis } = setup(15, { slowMs: 3 });
    const sheet = outSheet(gas);
    // Pre-existing good data from yesterday
    sheet.appendRow(["Markaz","EMIS","School Name","Level","Gender","S-Present","S-Absent","S-Marked",
                     "T-Present","T-Absent","T-Marked","Timestamp","Status","FetchState","TodayDate"]);
    for (let i = 1; i <= 15; i++) {
      sheet.appendRow([MARKAZ.toUpperCase(), "E" + String(i).padStart(4, "0"), `Old School ${i}`,
                       "Primary","Male", 99, 9, 108, 9, 1, 10, "yesterday", "ok", "", "2026-09-24"]);
    }
    const before = sheet.getLastRow();

    gas.api.CONFIG.WORK_BUDGET_MS = 20;
    const res = gas.call({ action: 'fetch', markaz: MARKAZ, runId: 'R6' });
    eq(res.state, 'fetching', 'run is mid-flight (simulating a crash here)');
    eq(sheet.getLastRow(), before, 'the previous good rows are untouched');
    eq(sheet.values[1][2], 'Old School 1', 'and are still readable');
  }

  // ── 7. Two Markazes committed together ──────────────────────────────────
  section('7. Concurrent Markazes do not overwrite each other');
  {
    const sis = makeSis({});
    const gas = makeGas({ sis });
    const { Spreadsheet } = require('./gas-shim');
    const db = gas.ss[DB_ID] || (gas.ss[DB_ID] = new Spreadsheet(DB_ID));
    const sh = db.tab('Schools');
    schoolList(8, 'Markaz A').forEach(r => sh.appendRow(r));
    schoolList(6, 'Markaz B').forEach(r => sh.appendRow(r));

    const a = gas.call({ action: 'fetch', markaz: 'Markaz A', runId: 'RA' });
    const b = gas.call({ action: 'fetch', markaz: 'Markaz B', runId: 'RB' });
    eq(a.state, 'done', 'markaz A done');
    eq(b.state, 'done', 'markaz B done');

    const sheet = outSheet(gas);
    eq(sheet.getLastRow(), 15, 'header + 8 + 6 rows, nothing lost');
    const markazes = sheet.values.slice(1).map(r => r[0]);
    eq(markazes.filter(m => m === 'MARKAZ A').length, 8, 'all 8 of A present');
    eq(markazes.filter(m => m === 'MARKAZ B').length, 6, 'all 6 of B present');
  }

  // ── 8. Re-fetch replaces, and bulk-deletes ──────────────────────────────
  section('8. Re-fetching a Markaz replaces its rows in contiguous ranges');
  {
    const { gas } = setup(15);
    gas.call({ action: 'fetch', markaz: MARKAZ, runId: 'R8a' });
    const sheet = outSheet(gas);
    eq(sheet.getLastRow(), 16, 'first fetch: 16 rows');

    const callsBefore = sheet.deleteCalls.length;
    gas.call({ action: 'fetch', markaz: MARKAZ, runId: 'R8b' });
    eq(sheet.getLastRow(), 16, 'second fetch still 16 rows, no duplication');
    eq(sheet.deleteCalls.length - callsBefore, 1,
       `deleted in ONE contiguous range, not 15 deleteRow calls (${sheet.deleteCalls.length - callsBefore})`);
  }

  // ── 9. status is O(1) — zero sheet reads ────────────────────────────────
  section('9. Polling status never reads the spreadsheet');
  {
    const { gas } = setup(15);
    gas.call({ action: 'fetch', markaz: MARKAZ, runId: 'R9' });
    counters.getDataRangeCalls = 0;
    for (let i = 0; i < 25; i++) gas.call({ action: 'status', markaz: MARKAZ, runId: 'R9' });
    eq(counters.getDataRangeCalls, 0, '25 status polls caused 0 full-sheet reads');
  }

  // ── 10. runId correlation ───────────────────────────────────────────────
  section('10. runId keeps runs apart');
  {
    const { gas, sis } = setup(40, { slowMs: 3 });
    gas.api.CONFIG.WORK_BUDGET_MS = 20;
    gas.call({ action: 'fetch', markaz: MARKAZ, runId: 'MINE' });
    const other = gas.call({ action: 'status', markaz: MARKAZ, runId: 'SOMEONE_ELSE' });
    eq(other.runId, 'MINE', 'tells the caller whose run is in flight');
    eq(other.rows.length, 0, 'and withholds another run\'s in-flight rows');
    ok(/belongs to/.test(other.note || ''), 'with an explanatory note');

    const mine = gas.call({ action: 'status', markaz: MARKAZ, runId: 'MINE' });
    ok(mine.rows.length > 0, `the owner does get their rows (${mine.rows.length})`);
  }

  // ── 11. Monthly job ─────────────────────────────────────────────────────
  section('11. Monthly fetch uses the same runner');
  {
    const { gas } = setup(10);
    const r = gas.call({ action: 'fetchMonthly', markaz: MARKAZ, month: '2026-05', runId: 'RM' });
    eq(r.state, 'done', 'monthly completes');
    eq(r.total, 10, 'total 10');
    eq(r.rows.length, 10, '10 rows');
    ok(r.rows[0].studentData && Array.isArray(r.rows[0].studentData.categories),
       'studentData carries the parsed categories array');
    eq(gas.ss[OUT_ID].tab('MonthlyAttendance').getLastRow(), 11, 'monthly sheet committed');

    const s = gas.call({ action: 'statusMonthly', markaz: MARKAZ, month: '2026-05', runId: 'RM' });
    eq(s.rows.length, 10, 'statusMonthly returns the rows');
    const bad = gas.call({ action: 'fetchMonthly', markaz: MARKAZ });
    ok(/month parameter is required/.test(bad.error || ''), 'missing month is rejected clearly');
  }

  // ── 12. Edge cases ──────────────────────────────────────────────────────
  section('12. Edge cases');
  {
    const { gas } = setup(5);
    const noSchools = gas.call({ action: 'fetch', markaz: 'Nowhere' });
    eq(noSchools.state, 'error', 'unknown markaz errors');
    ok(/No schools found/.test(noSchools.error), `with a useful message: "${noSchools.error}"`);

    const unknown = gas.call({ action: 'wat', markaz: MARKAZ });
    ok(/Unknown action/.test(unknown.error), 'unknown action rejected');

    const noMarkaz = gas.call({ action: 'fetch' });
    ok(/markaz parameter is required/.test(noMarkaz.error), 'missing markaz rejected');

    const health = gas.call({ action: 'health' });
    eq(health.version, gas.api.SCRIPT_VERSION, 'health endpoint reports the version');

    const cold = gas.call({ action: 'status', markaz: MARKAZ });
    eq(cold.state, 'empty', 'status before any fetch is empty');
  }

  // ── 13. Duplicate EMIS in the DB ────────────────────────────────────────
  section('13. Duplicate EMIS rows in the school DB');
  {
    const dup = [["", "", MARKAZ, "", "", "E0002", "Duplicate School", "Primary", "Male"]];
    const { gas } = setup(5, {}, dup);
    const r = gas.call({ action: 'fetch', markaz: MARKAZ, runId: 'R13' });
    eq(r.total, 5, 'the duplicate EMIS is counted once');
    eq(r.rows.length, 5, 'and fetched once');
  }

  // ── 14. Cold read after cache expiry ────────────────────────────────────
  section('14. Cold read falls back to the sheet');
  {
    const { gas } = setup(8);
    gas.call({ action: 'fetch', markaz: MARKAZ, runId: 'R14' });
    [...gas.cache.keys()].forEach(k => gas.cache.delete(k));   // simulate 6h expiry
    const cold = gas.call({ action: 'status', markaz: MARKAZ, runId: 'R14' });
    eq(cold.state, 'done', 'still answers from the committed sheet');
    eq(cold.rows.length, 8, 'all 8 rows recovered');
    eq(cold.cached, false, 'and says the data came from the sheet, not cache');
  }

  // ── 15. Admin endpoints untouched ───────────────────────────────────────
  section('15. Admin endpoints still work');
  {
    const { gas } = setup(3);
    gas.setProp('ADMIN_PASSWORD', 'sekrit');
    eq(gas.call({ action: 'verifyPassword', password: 'sekrit' }).ok, true, 'correct password accepted');
    eq(gas.call({ action: 'verifyPassword', password: 'nope' }).ok, false, 'wrong password rejected');

    const save = gas.call({ action: 'saveConfig', month: '2026-05', weekends: '{"6":true}', holidays: '[]' });
    eq(save.saved, true, 'config saved');
    const got = gas.call({ action: 'getConfig', month: '2026-05' });
    eq(got.found, true, 'config read back');
    eq(got.weekends['6'], true, 'weekends round-tripped');

    const save2 = gas.call({ action: 'saveConfig', month: '2026-05', weekends: '{"5":true}', holidays: '[]' });
    eq(save2.saved, true, 're-saving the same month updates in place');
    eq(gas.ss[OUT_ID].tab('AdminConfig').getLastRow(), 2, 'no duplicate month row created');
  }

  // ── 16. JSONP channel for the dashboard's CORS-free fallback ────────────
  section('16. ?callback= returns executable JSONP (CORS-free fallback)');
  {
    const { gas } = setup(3);

    const plain = gas.callRaw({ action: 'health' });
    eq(plain[0], '{', 'without ?callback= the body stays plain JSON');

    const wrapped = gas.callRaw({ action: 'health', callback: 'myCb' });
    ok(/^myCb\(\{/.test(wrapped), `body is wrapped for the script tag (${wrapped})`);
    ok(/\);\s*$/.test(wrapped), 'and terminated so the script tag executes it');
    eq(JSON.parse(wrapped.replace(/^myCb\(/, '').replace(/\);\s*$/, '')).version, gas.api.SCRIPT_VERSION,
       'the wrapped payload is the same JSON the fetch path gets');
    eq(gas.getLastMime(), 'application/javascript',
       'MIME is JavaScript — browsers refuse to execute a JSON-MIME script response (ORB)');

    // The fetch action must work over JSONP too, not just health.
    const fetchJsonp = gas.callRaw({ action: 'fetch', markaz: MARKAZ, runId: 'R16', callback: 'cb2' });
    ok(/^cb2\(/.test(fetchJsonp), 'fetch action also answers in JSONP form');
    ok(gas.getLastMime() === 'application/javascript', 'and keeps the JavaScript MIME');

    // Backwards compatible: the old client, with no callback, is unaffected.
    eq(gas.call({ action: 'health' }).version, gas.api.SCRIPT_VERSION, 'plain JSON still works');

    // A hostile callback name must never be echoed into the response body.
    const evil = gas.callRaw({ action: 'health', callback: 'alert(1)//' });
    eq(evil[0], '{', 'an invalid callback name is ignored, not injected');
  }

  console.log('\n' + '═'.repeat(68));
  if (fail) { console.log(`\x1b[31m${fail} FAILED\x1b[0m, ${pass} passed`); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log(`\x1b[32mALL ${pass} CHECKS PASSED\x1b[0m`);
  process.exit(0);
})().catch(e => { console.error('\n\x1b[31mSUITE CRASHED\x1b[0m'); console.error(e); process.exit(2); });
