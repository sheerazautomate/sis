"use strict";
/**
 * Regression suite for the PESRP dashboard.
 * Runs the real index.html in jsdom against a mock Apps Script.
 */
const path = require('path');
const { makeEnv, makeMaster, schoolRow, bootMaster, selectPath, tick, blobText } = require('./harness');

const SEL = { district: 'Layyah', wing: 'Wing A', tehsil: 'Tehsil 1', markaz: 'Markaz M1' };

let pass = 0, fail = 0;
const failures = [];

function ok(cond, label) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function section(name) { console.log(`\n\x1b[1m${name}\x1b[0m`); }

function schools(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({ emis: 'E' + String(i).padStart(4, '0'), name: `Govt Primary School No ${i}`,
               level: i % 3 === 0 ? 'Middle' : 'Primary', gender: i % 2 ? 'Male' : 'Female' });
  }
  return out;
}

async function boot(handler, opts = {}) {
  const env = makeEnv({ master: opts.master || makeMaster(opts.n || 10), handler });
  const n = await bootMaster(env);
  await selectPath(env, SEL);
  return { env, n };
}

// ══════════════════════════════════════════════════════════════════════════
(async () => {

// ── 1. CSV parser ─────────────────────────────────────────────────────────
section('1. CSV parsing (RFC 4180)');
{
  const { env } = await boot(() => ({ state: 'empty', rows: [] }));
  const p = env.S.parseCSV;
  const rows = p('a,b,c\r\n1,"has, comma",3\r\n2,"line\nbreak",4\r\n3,"say ""hi""",5\r\n');
  eq(rows.length, 3, 'three records despite an embedded newline');
  eq(rows[0].b, 'has, comma', 'comma inside quotes kept in one field');
  eq(rows[1].b, 'line\nbreak', 'newline inside quotes does not split the record');
  eq(rows[2].b, 'say "hi"', 'escaped double-quotes decoded');
  eq(p('\uFEFFa,b\n1,2\n').length, 1, 'leading BOM stripped');
}

// ── 2. Partial "done", then auto-resume  (the headline bug) ───────────────
section('2. Server says "done" with only 6/10 schools');
{
  const all = schools(10);
  let available = all.slice(0, 6);
  let fetchCalls = 0;
  const { env } = await boot((req) => {
    if (req.action === 'fetch') {
      fetchCalls++;
      if (req.emis.length) {
        const want = new Set(req.emis);
        const map = new Map(available.map(s => [s.emis, s]));
        for (const s of all) if (want.has(s.emis)) map.set(s.emis, s);
        available = [...map.values()];
      }
      return { started: true, runId: req.runId };
    }
    return { state: 'done', rows: available.map(s => schoolRow(s)),
             fetched: available.length, total: 10, todayDate: '2026-09-25' };
  });

  await env.S.startFetch();
  const run = env.S.run;

  eq(run.phase, 'done', 'run finishes as complete, not partial');
  eq(run.store.size, 10, 'all 10 schools present after auto-resume');
  eq(env.S.missingList(run).length, 0, 'nothing missing');
  eq(env.S.coveredCount(run), 10, 'coverage 10/10');
  eq(run.round, 2, 'exactly one automatic retry round was needed');
  ok(fetchCalls >= 2, `server was re-triggered automatically (${fetchCalls} trigger calls)`);
  ok(env.$('completenessBar').className.includes('ok'), 'completeness banner shows green/ok');
  ok(!env.$('btnRetryMissing').style.display.includes('inline'), 'no retry button offered');
  eq(env.$('studentsTbody').querySelectorAll('tr').length, 10, 'students table has 10 rows');
  eq(env.$('cSchools').textContent, '10', 'card shows 10 schools');
  env.window.close();
}

// ── 3. Shrinking batches must union, not overwrite ────────────────────────
section('3. Out-of-order / shrinking batches');
{
  const all = schools(10);
  let poll = 0;
  const { env } = await boot((req) => {
    if (req.action === 'fetch') return { started: true };
    poll++;
    if (poll === 1) return { state: 'fetching', rows: all.slice(0, 8).map(s => schoolRow(s)), fetched: 8, total: 10 };
    if (poll === 2) return { state: 'fetching', rows: all.slice(8, 10).map(s => schoolRow(s)), fetched: 10, total: 10 };
    return { state: 'done', rows: all.slice(0, 2).map(s => schoolRow(s)), fetched: 10, total: 10 };
  });

  await env.S.startFetch();
  eq(env.S.run.store.size, 10, 'short final batch did not erase the 8 schools already received');
  eq(env.S.run.phase, 'done', 'run completes');
  env.window.close();
}

// ── 4. Duplicate rows ─────────────────────────────────────────────────────
section('4. Duplicate rows from the server');
{
  const all = schools(5);
  const { env } = await boot((req) => {
    if (req.action === 'fetch') return { started: true };
    const dup = [...all, ...all, all[0]].map(s => schoolRow(s));
    return { state: 'done', rows: dup, fetched: 5, total: 5 };
  }, { n: 5 });
  await env.S.startFetch();
  eq(env.S.run.store.size, 5, 'duplicates collapsed to 5 unique schools');
  eq(env.$('studentsTbody').querySelectorAll('tr').length, 5, 'table renders 5 rows');
  env.window.close();
}

// ── 5. Trigger returns an HTML auth page first, then JSON ─────────────────
section('5. Apps Script answers with an HTML auth page');
{
  const all = schools(4);
  let calls = 0;
  const { env } = await boot((req) => {
    if (req.action === 'fetch') {
      calls++;
      if (calls === 1) return { __html: '<html><body>Authorization required - sign in</body></html>' };
      return { started: true };
    }
    return { state: 'done', rows: all.map(s => schoolRow(s)), fetched: 4, total: 4 };
  }, { n: 4 });
  await env.S.startFetch();
  eq(env.S.run.phase, 'done', 'recovered after the HTML page and completed');
  eq(env.S.run.store.size, 4, 'all 4 schools fetched');
  ok(calls >= 2, `trigger was retried (${calls} calls)`);
  env.window.close();
}

// ── 6. Trigger always fails → actionable error, never silent ──────────────
section('6. Trigger always fails');
{
  const { env } = await boot(() => ({ __html: '<html><body>Authorization required, please sign in</body></html>' }));
  await env.S.startFetch();
  eq(env.S.run.phase, 'error', 'run ends in error state');
  ok(env.$('errorState').classList.contains('visible'), 'error panel is shown');
  ok(/authorisation|authorization/i.test(env.$('errorDetail').textContent),
     `error explains the cause: "${env.$('errorDetail').textContent.slice(0, 70)}…"`);
  ok(!env.$('completenessBar').className.includes(' ok'), 'does not claim success');
  env.window.close();
}

// ── 7. Server never returns data ──────────────────────────────────────────
section('7. Server never returns anything');
{
  const { env } = await boot((req) => req.action === 'fetch' ? { started: true } : { state: 'empty', rows: [] });
  env.S.CFG.runDeadlineMs = 400;
  env.S.CFG.maxNetErrors = 99;
  await env.S.startFetch();
  eq(env.S.run.phase, 'error', 'run ends in error, not silent success');
  ok(env.$('errorState').classList.contains('visible'), 'error panel shown');
  ok(/timed out|polling limit/i.test(env.$('errorMsg').textContent),
     `message says it timed out: "${env.$('errorMsg').textContent}"`);
  env.window.close();
}

// ── 8. Some schools never come back ───────────────────────────────────────
section('8. Two schools never come back');
{
  const all = schools(8);
  const { env } = await boot((req) => {
    if (req.action === 'fetch') return { started: true };
    return { state: 'done', rows: all.slice(0, 6).map(s => schoolRow(s)), fetched: 6, total: 8 };
  }, { n: 8 });
  await env.S.startFetch();
  const run = env.S.run;
  eq(run.phase, 'partial', 'run is reported as PARTIAL, never as success');
  eq(env.S.missingList(run).length, 2, 'exactly 2 schools identified as missing');
  ok(env.$('completenessBar').className.includes('warn'), 'completeness banner is a warning');
  ok(env.$('btnRetryMissing').style.display.includes('inline'), 'retry button is offered');
  eq(env.$('btnRetryMissing').textContent, 'Retry missing (2)', 'retry button names the count');
  eq(env.$('studentsTbody').querySelectorAll('tr').length, 8, 'table shows 6 real + 2 missing placeholders');
  eq(env.$('sBadge').textContent, '6 of 8 schools', 'badge states 6 of 8');
  ok(env.$('studentsTbody').innerHTML.includes('missing-row'), 'missing rows are visually marked');
  env.window.close();
}

// ── 9. Foreign run id is ignored ──────────────────────────────────────────
section('9. Status for another run id');
{
  const all = schools(4);
  const { env } = await boot((req) => {
    if (req.action === 'fetch') return { started: true };
    if (req.runId === undefined) return { state: 'done', rows: [], runId: 'someone-else' };
    return { state: 'done', rows: all.map(s => schoolRow(s)), runId: req.runId, fetched: 4, total: 4 };
  }, { n: 4 });
  env.S.CFG.runDeadlineMs = 600;
  await env.S.startFetch();
  eq(env.S.run.store.size, 4, 'only rows for our own run id were accepted');
  env.window.close();
}

// ── 10. Network blips ─────────────────────────────────────────────────────
section('10. Transport blips mid-run');
{
  const all = schools(6);
  let poll = 0;
  const { env } = await boot((req) => {
    if (req.action === 'fetch') return { started: true };
    poll++;
    if (poll <= 2) return { __throw: 'network' };
    if (poll === 3) return { __throw: 'timeout' };
    return { state: 'done', rows: all.map(s => schoolRow(s)), fetched: 6, total: 6 };
  }, { n: 6 });
  env.S.CFG.maxNetErrors = 5;   // tolerate the 3 blips below
  await env.S.startFetch();
  eq(env.S.run.phase, 'done', 'survived 3 transport failures and completed');
  eq(env.S.run.store.size, 6, 'all 6 schools fetched');
  env.window.close();
}

// ── 11. XSS ───────────────────────────────────────────────────────────────
section('11. HTML injection from school names');
{
  const evil = '<img src=x onerror=alert(1)>';
  const master = makeMaster(2, { names: [evil, 'Normal School'] });
  const all = [{ emis: 'E0001', name: evil, level: 'Primary', gender: 'Male' },
               { emis: 'E0002', name: 'Normal School', level: 'Primary', gender: 'Female' }];
  const { env } = await boot((req) => req.action === 'fetch' ? { started: true }
    : { state: 'done', rows: all.map(s => schoolRow(s)), fetched: 2, total: 2 }, { master });
  await env.S.startFetch();
  eq(env.doc.querySelectorAll('img').length, 0, 'no <img> element was injected into the page');
  ok(env.$('studentsTbody').textContent.includes(evil), 'raw name is shown as text, not parsed as HTML');
  env.window.close();
}

// ── 12. Teacher table sorts on its own columns ────────────────────────────
section('12. Independent student / teacher sorting');
{
  const all = schools(5).map((s, i) => ({ ...s, sp: (i + 1) * 10, tp: (5 - i) * 10 }));
  const { env } = await boot((req) => req.action === 'fetch' ? { started: true }
    : { state: 'done', rows: all.map(s => schoolRow(s, { sPresent: s.sp, tPresent: s.tp, sMarked: 50, tMarked: 5 })),
        fetched: 5, total: 5 }, { n: 5 });
  await env.S.startFetch();

  const thPresent = () => [...env.$('teachersTbody').querySelectorAll('tr')]
    .map(tr => tr.children[4].textContent.replace(/,/g, ''));
  const shPresent = () => [...env.$('studentsTbody').querySelectorAll('tr')]
    .map(tr => tr.children[4].textContent.replace(/,/g, ''));

  const before = thPresent();
  env.doc.querySelector('th[data-col="tPresent"][data-table="t"]').dispatchEvent(new env.window.Event('click'));
  const after = thPresent();

  ok(JSON.stringify(before) !== JSON.stringify(after), 'clicking Teachers/Present re-orders the teacher table');
  eq(after.join(','), '10,20,30,40,50', 'teacher table sorted by TEACHER present ascending');
  eq(shPresent().join(','), '10,20,30,40,50', 'student table order untouched by the teacher sort');
  eq(env.S.sortState.t.col, 'tPresent', 'teacher sort key is a teacher column');
  eq(env.S.sortState.s.col, 'status', 'student sort key unchanged');

  // Sorting by name must be case-insensitive and stable.
  env.doc.querySelector('th[data-col="name"][data-table="s"]').dispatchEvent(new env.window.Event('click'));
  const names = [...env.$('studentsTbody').querySelectorAll('tr')].map(tr => tr.children[0].textContent);
  eq(names[0], 'Govt Primary School No 1', 'sorted by school name');
  env.window.close();
}

// ── 13. Cancel ────────────────────────────────────────────────────────────
section('13. Cancel mid-run');
{
  const { env } = await boot((req) => req.action === 'fetch' ? { started: true } : { state: 'fetching', rows: [] });
  const p = env.S.startFetch();
  await tick(60);
  env.$('btnCancel').dispatchEvent(new env.window.Event('click'));
  await p;
  await tick(80);
  eq(env.S.run.phase, 'cancelled', 'run marked cancelled');
  ok(!env.$('btnCancel').classList.contains('visible'), 'cancel button hidden again');
  eq(env.$('btnFetch').textContent, 'Fetch Attendance', 'fetch button label restored');
  env.window.close();
}

// ── 14. Manual "Retry missing" ────────────────────────────────────────────
section('14. Retry-missing button');
{
  const all = schools(6);
  let serveMissing = false;
  const { env } = await boot((req) => {
    if (req.action === 'fetch') { if (req.emis.length) serveMissing = true; return { started: true }; }
    const rows = serveMissing ? all : all.slice(0, 4);
    return { state: 'done', rows: rows.map(s => schoolRow(s)), fetched: rows.length, total: 6 };
  }, { n: 6 });
  env.S.CFG.maxRounds = 1;          // force it to stop incomplete
  await env.S.startFetch();
  eq(env.S.run.phase, 'partial', 'stops incomplete when rounds are exhausted');
  eq(env.S.missingList(env.S.run).length, 2, '2 missing before retry');

  let clicked = false;
  const orig = env.S.retryMissing;
  env.window.__SIS__.retryMissing = async () => { clicked = true; return orig(); };
  env.$('btnRetryMissing').addEventListener('click', () => { clicked = true; });

  await env.S.retryMissing();
  eq(env.S.run.store.size, 6, 'manual retry recovered the remaining schools');
  eq(env.S.run.phase, 'done', 'run now complete');
  ok(env.$('completenessBar').className.includes('ok'), 'banner turns green');
  env.window.close();
}

// ── 15. CSV exports ───────────────────────────────────────────────────────
section('15. CSV exports');
{
  const all = schools(6).map((s, i) => ({ ...s, zero: i === 5 }));
  const { env } = await boot((req) => req.action === 'fetch' ? { started: true }
    : { state: 'done', rows: all.map(s => schoolRow(s, s.zero ? { sMarked: 0, tMarked: 0 } : {})),
        fetched: 6, total: 6 }, { n: 6 });
  await env.S.startFetch();
  eq(env.S.run.store.size, 6, 'six schools loaded for export');

  const reports = ['students', 'teachers', 'combined', 'summary', 'unmarked'];
  for (const kind of reports) {
    const before = env.downloads.length;
    env.S.exportReport(kind);
    eq(env.downloads.length, before + 1, `${kind}: a file was produced`);
  }

  const get = i => env.downloads[i];
  const studentsTxt = await blobText(get(0));
  const teachersTxt = await blobText(get(1));
  const combinedTxt = await blobText(get(2));
  const summaryTxt  = await blobText(get(3));
  const unmarkedTxt = await blobText(get(4));

  ok(/^pesrp_Markaz-M1_students_\d{4}-\d{2}-\d{2}_\d{6}\.csv$/.test(get(0).filename),
     `students filename is markaz+kind+timestamp: ${get(0).filename}`);
  const bytes = new Uint8Array(await get(0).bytes);
  ok(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF,
     'students CSV starts with a UTF-8 BOM (Excel-safe)');

  const sLines = studentsTxt.replace(/^\uFEFF/, '').split('\r\n');
  eq(sLines.length, 7, 'students CSV has a header + 6 rows');
  ok(sLines[0].includes('EMIS') && sLines[0].includes('Markaz') && sLines[0].includes('Students Present'),
     'students header carries EMIS + context + measure columns');
  const dataRows = sLines.slice(1);
  ok(dataRows.length === 6 && dataRows.every(l => /^E\d{4},/.test(l)),
     'every students row starts with its EMIS code');
  ok(dataRows.some(l => l.includes('E0001')) && dataRows.some(l => l.includes('E0006')),
     'EMIS codes E0001…E0006 all present');
  ok(dataRows.every(l => l.endsWith('Marked') || l.endsWith('Not Marked')),
     'every row ends with a readable Status, not a numeric code');

  const tLines = teachersTxt.replace(/^\uFEFF/, '').split('\r\n');
  eq(tLines.length, 7, 'teachers CSV has a header + 6 rows');
  ok(tLines[0].includes('Teachers Present'), 'teachers header names teacher columns');

  const cLines = combinedTxt.replace(/^\uFEFF/, '').split('\r\n');
  eq(cLines.length, 7, 'combined CSV has a header + 6 rows');
  ok(cLines[0].includes('Students Present') && cLines[0].includes('Teachers Status'),
     'combined header has both student and teacher columns');

  const sumLines = summaryTxt.replace(/^\uFEFF/, '').split('\r\n');
  ok(sumLines.some(l => l.startsWith('Schools received,6')), 'summary reports 6 schools received');
  ok(sumLines.some(l => l.startsWith('Schools missing,0')), 'summary reports 0 missing');
  ok(sumLines.some(l => l.startsWith('Coverage %,100')), 'summary reports 100% coverage');

  const uLines = unmarkedTxt.replace(/^\uFEFF/, '').split('\r\n');
  eq(uLines.length, 2, 'unmarked CSV has a header + the 1 school with zero marked');
  ok(uLines[1].includes('E0006'), 'unmarked report names the right school');
  ok(uLines[1].includes('YES'), 'unmarked report flags it');

  // "missing" report on a complete run should refuse rather than emit an empty file
  const beforeMissing = env.downloads.length;
  env.S.exportReport('missing');
  eq(env.downloads.length, beforeMissing, 'missing-report refuses to emit an empty file');
  env.window.close();
}

// ── 16. CSV escaping / formula injection ──────────────────────────────────
section('16. CSV field escaping');
{
  const { env } = await boot(() => ({ state: 'empty', rows: [] }));
  const { buildCSV, csvEscape } = env.S;
  eq(csvEscape('plain'), 'plain', 'plain value untouched');
  eq(csvEscape('a,b'), '"a,b"', 'comma quoted');
  eq(csvEscape('say "hi"'), '"say ""hi"""', 'quotes doubled and wrapped');
  eq(csvEscape('line\nbreak'), '"line\nbreak"', 'newline quoted');
  eq(csvEscape('=CMD()'), "'=CMD()", 'leading = neutralised (formula injection)');
  eq(csvEscape('+1234'), "'+1234", 'leading + neutralised');
  eq(csvEscape(null), '', 'null becomes empty');
  eq(buildCSV(['a', 'b'], [{ a: 1, b: 'x,y' }]), 'a,b\r\n1,"x,y"', 'buildCSV output shape');
  env.window.close();
}

// ── 17. Row normalisation ─────────────────────────────────────────────────
section('17. Row normalisation');
{
  const { env } = await boot(() => ({ state: 'empty', rows: [] }));
  const n = env.S.normalizeRow;
  eq(n({ emis: 'E1', name: 'X', status: 'ok', sMarked: 5 }).status, 1, 'ok + marked => Marked');
  eq(n({ emis: 'E1', name: 'X', status: 'ok', sMarked: 0 }).status, 0, 'ok + zero => Not Marked');
  eq(n({ emis: 'E1', name: 'X', status: 'ok', sMarked: '12' }).status, 1, 'string "12" coerced to a number');
  eq(n({ emis: 'E1', name: 'X', status: 'ok', sMarked: '1,200' }).status, 1, '"1,200" coerced');
  eq(n({ emis: 'E1', name: 'X', status: 'error' }).status, -1, 'error status => Error');
  eq(n({ emis: 'E1', name: 'X' }).status, -2, 'absent status => Missing/unknown, not silently Marked');
  eq(n({ emis: 'E1', name: 'X', status: 'ok', sPresent: null }).present, null, 'null stays null, not 0');
  eq(n({ name: 'X', level: 'P', gender: 'M' }).key, '~X|P|M', 'rows without EMIS get a stable key');
  env.window.close();
}

// ── 18. Master list drives the cascade ────────────────────────────────────
section('18. Cascading selects and completeness source');
{
  const { env, n: districtCount } = await boot(() => ({ state: 'empty', rows: [] }));
  eq(districtCount, 1, 'one district loaded from the master CSV');
  eq(env.$('selWing').options.length, 2, 'wing select populated (placeholder + Wing A)');
  eq(env.$('selTehsil').options.length, 2, 'tehsil select populated');
  eq(env.$('selMarkaz').options.length, 2, 'markaz select populated');
  ok(!env.$('btnFetch').disabled, 'fetch enabled once a Markaz is chosen');
  eq(env.S.masterRowsFor(SEL.district, SEL.wing, SEL.tehsil, SEL.markaz).length, 10,
     'master list yields the 10 expected schools');
  env.window.close();
}

// ── 19. CORS block on fetch() → the JSONP channel carries the run ─────────
section('19. "Cross-Origin Request Blocked" on fetch — JSONP fallback');
{
  const all = schools(10);
  const env = makeEnv({
    master: makeMaster(10),
    corsBlocked: true,                       // every fetch() to Apps Script dies CORS-style
    handler: (req) => {
      if (req.action === 'fetch') return { started: true, runId: req.runId };
      return { state: 'done', rows: all.map(s => schoolRow(s)), fetched: 10, total: 10 };
    },
  });
  await bootMaster(env);
  await selectPath(env, SEL);

  await env.S.startFetch();
  const run = env.S.run;

  eq(run.phase, 'done', 'run still completes when fetch() is CORS-blocked');
  eq(run.store.size, 10, 'all 10 schools arrived over the CORS-free channel');
  eq(env.S.transport, 'jsonp', 'transport switched to jsonp and stays there');
  ok(env.jsonpRequests.length > 0, `the <script> channel was used (${env.jsonpRequests.length} requests)`);
  ok(env.jsonpRequests.every(r => r.callback && r.callback.indexOf('__sisJsonp') === 0),
     'every fallback request carries a callback name');
  ok(!env.$('errorState').classList.contains('visible'), 'no error panel shown');

  const trigger = env.gasRequests.find(r => r.action === 'fetch');
  ok(trigger && trigger.slim === '1',
     'the trigger asks for a slim payload — rows are not needed to start a run');
  const poll = env.gasRequests.find(r => r.action === 'status');
  ok(poll && !poll.slim, 'status polls still ask for the rows, so the table fills');
  eq(env.consoleErrors.length, 0, `no console errors (${env.consoleErrors.join(' | ') || 'clean'})`);
  env.window.close();
}

// ── 20. Both channels blocked → say so, precisely ────────────────────────
section('20. Both channels blocked — CORS explained, Connection check reports');
{
  const env = makeEnv({
    master: makeMaster(4),
    corsBlocked: true,
    jsonpBlocked: true,
    handler: () => ({ started: true }),
  });
  await bootMaster(env);
  await selectPath(env, SEL);

  await env.S.startFetch();
  const msg = env.$('errorMsg').textContent;
  const detail = env.$('errorDetail').textContent;

  ok(env.$('errorState').classList.contains('visible'), 'error panel is shown');
  ok(/blocked/i.test(msg) && /cors/i.test(msg), `message names the CORS block ("${msg}")`);
  ok(detail.indexOf('script.google.com') >= 0, 'detail names the blocked Apps Script URL');
  ok(/callback|Code\.gs/i.test(detail), 'detail tells the user to deploy the new server for the fallback');
  ok(/Anyone/.test(detail), 'detail lists the deployment-access cause first');

  const report = await env.S.runConnectionCheck();
  ok(report.indexOf('script.google.com') >= 0, 'connection check names the Apps Script endpoint');
  ok(report.indexOf('docs.google.com') >= 0, 'connection check names the school-list CSV');
  ok((report.match(/FAILED/g) || []).length >= 2, 'both Apps Script channels are reported FAILED');
  eq(env.$('errorMsg').textContent, 'Connection check', 'the check renders its report in the panel');
  env.window.close();
}

// ── 21. Server without ?callback= → actionable message ────────────────────
section('21. fetch blocked and the deployed server has no ?callback= support');
{
  const env = makeEnv({
    master: makeMaster(4),
    corsBlocked: true,
    // Apps Script answers raw JSON / an HTML page: the injected script cannot execute it.
    handler: () => ({ __html: '<html><body>Script function not found</body></html>' }),
  });
  await bootMaster(env);
  await selectPath(env, SEL);

  await env.S.startFetch();
  const detail = env.$('errorDetail').textContent;
  ok(/callback|Code\.gs/i.test(detail), 'detail points at the missing ?callback= (re-deploy Code.gs)');
  ok(detail.indexOf('script.google.com') >= 0, 'detail still names the URL that was blocked');
  env.window.close();
}

// ── 22. Small calls fine, heavy response blocked → verdict names the run ──
section('22. Health call OK over the fallback, the heavy response blocked');
{
  const env = makeEnv({
    master: makeMaster(6),
    corsBlocked: true,                       // plain fetch is blocked for everything
    handler: (req) => {
      if (req.action === 'health') return { version: '3.0.0', time: 'now' };
      if (req.action === 'fetch')  return { started: true, runId: req.runId };
      return { __throw: 'network' };         // the status response never arrives either
    },
  });
  await bootMaster(env);
  await selectPath(env, SEL);

  await env.S.startFetch();
  const detail = env.$('errorDetail').textContent;
  ok(/health call/i.test(detail),
     'verdict separates "deployment unreachable" from "this response is the problem"');
  ok(/Executions/.test(detail), 'and points at the Apps Script execution log');
  ok(/secondary-wing/i.test(detail), 'and says why secondary-wing Markazes are the ones that hit it');
  env.window.close();
}

// ── 23. No console errors ─────────────────────────────────────────────────
section('23. Page health');
{
  const all = schools(4);
  const { env } = await boot((req) => req.action === 'fetch' ? { started: true }
    : { state: 'done', rows: all.map(s => schoolRow(s)), fetched: 4, total: 4 }, { n: 4 });
  await env.S.startFetch();
  env.S.exportReport('combined');
  eq(env.consoleErrors.length, 0, `no console/jsdom errors (${env.consoleErrors.join(' | ') || 'clean'})`);
  env.window.close();
}

// ── summary ───────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(64));
if (fail) {
  console.log(`\x1b[31m${fail} FAILED\x1b[0m, ${pass} passed`);
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
} else {
  console.log(`\x1b[32mALL ${pass} CHECKS PASSED\x1b[0m`);
  process.exit(0);
}

})().catch(e => { console.error('\n\x1b[31mSUITE CRASHED\x1b[0m'); console.error(e); process.exit(2); });
