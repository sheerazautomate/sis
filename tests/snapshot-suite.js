"use strict";
/**
 * Snapshot suite — proves the GitHub-JSON path end to end, OFFLINE.
 *
 *   mock SIS  →  tools/build-snapshot.mjs  →  data/*.json  →  the REAL index.html
 *
 * The last step matters: it is the shipped dashboard, loaded in jsdom by
 * tests/harness.js, rendering the exact bytes the builder writes. If the
 * snapshot schema ever drifts from what normalizeRow() expects, this fails.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeEnv, toCSVText, bootMaster, selectPath, tick } = require('./harness');

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

const SEL = { district: 'Layyah', wing: 'Wing A', tehsil: 'Tehsil 1', markaz: 'Markaz M1' };

/** The exact shape sis.pesrp.edu.pk returned live on 2026-09-25: counts are
 *  comma-grouped STRINGS, and there is a csrf_test_name nobody asked for. */
const LIVE_SHAPE = (present, absent, marked) => JSON.stringify({
  todayDate: '26 Sep',
  present_count: String(present), present_percentage: 0,
  absent_count: String(absent), absent_percentage: 0,
  unmarked_count: '10,470,662',
  marked_count: String(marked),
  unmarked_percentage: 100, marked_percentage: 0,
  csrf_test_name: '6274a3ffe4fb5b5d54a3d6677cd8fa74',
});

function fakeSchools(n) {
  const rows = [['EMIS', 'School Name', 'District', 'Wing', 'Tehsil', 'Markaz', 'Level', 'Gender']];
  const list = [];
  for (let i = 1; i <= n; i++) {
    const emis = '3110' + String(i).padStart(5, '0');
    const name = `Govt Primary School No ${i}`;
    rows.push([emis, name, 'Layyah', 'Wing A', 'Tehsil 1', 'Markaz M1',
               i % 3 === 0 ? 'Middle' : 'Primary', i % 2 ? 'Male' : 'Female']);
    list.push({ emis, name });
  }
  return { csv: toCSVText(rows), list };
}

/** Mock transport that mimics the SIS endpoints and counts what it was asked. */
function makeFakeSis({ failEmis = new Set() } = {}) {
  const calls = [];
  const impl = async (url) => {
    const u = new URL(url);
    const emis = u.searchParams.get('s_id_emis_code');
    const kind = u.pathname.includes('teachers') ? 'teacher' : 'student';
    calls.push({ emis, kind, host: u.host, path: u.pathname });
    if (failEmis.has(emis)) { const e = new Error('socket hang up'); throw e; }
    const n = Number(emis.slice(-2));
    return {
      ok: true,
      status: 200,
      text: async () => (kind === 'student' ? LIVE_SHAPE(40, 5, 45) : LIVE_SHAPE(3, 1, 4)),
    };
  };
  return { impl, calls };
}

(async () => {
  const B = await import('../tools/build-snapshot.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sis-snap-'));

  // ── 1. Pure helpers ───────────────────────────────────────────────────────
  section('1. Builder helpers');
  {
    const objs = B.csvToObjects('EMIS,School Name,Markaz\r\n123,"Govt, High",MARKAZ A\r\n');
    eq(objs.length, 1, 'csvToObjects returns one object per record');
    eq(objs[0]['School Name'], 'Govt, High', 'quoted comma kept inside the field');

    eq(B.slug('Markaz M1'), 'Markaz-M1', 'slug matches the dashboard\'s slug()');
    eq(B.slug(''), 'export', 'empty slug falls back like the dashboard\'s');

    eq(B.toCount('10,470,662'), 10470662, 'comma-grouped count parsed in full');
    eq(B.toCount('0'), 0, 'string zero parsed as 0, not null');
    eq(B.toCount(''), null, 'empty count stays null');
    eq(parseInt('10,470,662', 10), 10, 'baseline: bare parseInt truncates at the comma (the Code.gs bug)');
  }

  // ── 2. URL shape ──────────────────────────────────────────────────────────
  section('2. SIS request shape (the URL verified live)');
  {
    const url = B.sisUrl(B.SIS_URLS.student, '311000001');
    const u = new URL(url);
    eq(u.origin + u.pathname, 'https://sis.pesrp.edu.pk/attendance/get_today_attendance_stats', 'student endpoint');
    eq(u.searchParams.get('s_id_emis_code'), '311000001', 'EMIS carried as s_id_emis_code');
    eq(u.searchParams.get('ony_kpztp_districts'), 'false', 'ony_kpztp_districts=false, as production sends it');
    ok(u.searchParams.has('district') && u.searchParams.get('district') === '', 'empty filters present, as production sends them');
    ok(B.sisUrl(B.SIS_URLS.studentMonthly, '1', '2026-09').includes('month=2026-09'), 'monthly URL carries month');
  }

  // ── 3. Fetch + row build, happy path ──────────────────────────────────────
  section('3. buildSnapshot against a mock SIS');
  const { csv, list } = fakeSchools(6);
  const schoolsCsvPath = path.join(tmp, 'schools.csv');
  fs.writeFileSync(schoolsCsvPath, csv);

  let sis = makeFakeSis();
  let schools = await B.loadSchools(schoolsCsvPath, { fetchImpl: sis.impl });
  eq(schools.length, 6, 'six schools loaded from the master list');
  eq(schools[0].markaz, 'MARKAZ M1', 'markaz normalised to upper case, as Code.gs does');

  let snap = await B.buildSnapshot(schools, { fetchImpl: sis.impl, concurrency: 2, delayMs: 0 });
  eq(snap.rows.length, 6, 'one row per school');
  eq(snap.stats.ok, 6, 'all six succeeded');
  eq(sis.calls.length, 12, 'exactly two SIS calls per school (students + teachers)');
  eq(new Set(sis.calls.map(c => c.host)).size, 1, 'every call went to one host');
  ok(sis.calls.every(c => c.host === 'sis.pesrp.edu.pk'), 'that host is sis.pesrp.edu.pk — no Apps Script involved');

  const r0 = snap.rows[0];
  eq(r0.sPresent, 40, 'sPresent is a NUMBER, not the string SIS returned');
  eq(r0.sMarked, 45, 'sMarked coerced');
  eq(r0.tPresent, 3, 'tPresent coerced');
  eq(r0.status, 'ok', 'status ok');
  eq(r0.todayDate, '26 Sep', 'todayDate carried through for the header');
  eq(typeof r0.markaz, 'string', 'markaz present on the row');

  // ── 4. Row shape is what the dashboard already speaks ─────────────────────
  section('4. Row shape == server/Code.gs buildDailyRow()');
  {
    const need = ['emis', 'name', 'level', 'gender', 'sPresent', 'sAbsent', 'sMarked',
                  'tPresent', 'tAbsent', 'tMarked', 'timestamp', 'status', 'error'];
    ok(need.every(k => k in r0), 'every field the client reads is present');
    eq(r0.emis, list[0].emis, 'emis preserved verbatim (the completeness gate keys on it)');
    eq(r0.name, list[0].name, 'school name preserved');
  }

  // ── 5. A failing school must not blank the others ─────────────────────────
  section('5. One school down, the rest survive');
  {
    const bad = makeFakeSis({ failEmis: new Set([list[2].emis]) });
    const s2 = await B.buildSnapshot(schools, { fetchImpl: bad.impl, concurrency: 2, delayMs: 0, retries: 2, backoffMs: 1 });
    eq(s2.stats.ok, 5, 'five schools ok');
    eq(s2.stats.failed, 1, 'one school reported failed, not silently dropped');
    const badRow = s2.rows.find(r => r.emis === list[2].emis);
    eq(badRow.status, 'error', 'the failed school is marked error');
    ok(/socket hang up/.test(badRow.error), 'and carries the real reason');
    ok(s2.rows.length === 6, 'row count still complete — the completeness gate stays meaningful');
  }

  // ── 6. Files on disk ──────────────────────────────────────────────────────
  section('6. writeSnapshot / manifest / pruning');
  const outDir = path.join(tmp, 'data');
  const manifest = await B.writeSnapshot(outDir, snap, { day: '2026-09-26' });
  eq(manifest.markazes.length, 1, 'one markaz entry');
  eq(manifest.markazes[0].schools, 6, 'manifest reports 6 schools');
  ok(fs.existsSync(path.join(outDir, 'manifest.json')), 'manifest.json written');

  const payload = JSON.parse(fs.readFileSync(path.join(outDir, manifest.markazes[0].file), 'utf8'));
  eq(payload.rows.length, 6, 'payload holds every row');
  eq(payload.totals.sPresent, 240, 'totals summed (6 × 40)');
  eq(payload.total, 6, 'payload.total matches rows');

  const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'days', '2026-09-26', 'summary.json'), 'utf8'));
  eq(summary.markazes.length, 1, 'summary holds one markaz line');
  eq(summary.markazes[0].sMarked, 270, 'summary totals correct (6 × 45)');

  fs.mkdirSync(path.join(outDir, 'days', '2020-01-01'), { recursive: true });
  const removed = await B.pruneDays(outDir, 7);
  ok(removed.includes('2020-01-01'), 'old day folder pruned');
  ok(!removed.includes('2026-09-26') && fs.existsSync(path.join(outDir, 'days', '2026-09-26')), 'today\'s snapshot kept');

  // ── 7. THE POINT: the shipped dashboard renders the snapshot unchanged ────
  section('7. The real index.html renders the snapshot file');
  {
    const snapshotRows = payload.rows;
    const env = makeEnv({
      master: csv,
      handler: (req) => {
        if (req.action === 'fetch') return { started: true, runId: req.runId, state: 'fetching', rows: [], total: 6 };
        // Exactly what the dashboard would fetch from ./data/…json on Pages.
        return { state: 'done', rows: snapshotRows, fetched: snapshotRows.length, total: 6, todayDate: payload.todayDate };
      },
    });
    const n = await bootMaster(env);
    eq(n, 1, 'master list bootstrapped one district');
    await selectPath(env, SEL);

    // Same-origin read: what the static path replaces the Apps Script call with.
    const n0 = env.S.normalizeRow(snapshotRows[0]);
    eq(n0.state, 'ok', 'normalizeRow accepts the snapshot row');
    eq(n0.present, 40, 'present read from the snapshot');
    eq(n0.tMarked, 4, 'teacher marked read from the snapshot');

    await env.S.startFetch();
    const run = env.S.run;
    eq(run.phase, 'done', 'run completes as DONE from snapshot data');
    eq(run.store.size, 6, 'all 6 schools in the store');
    eq(env.S.coverageText(run).indexOf('6 / 6') !== -1, true, 'completeness gate passes: "6 / 6"');

    const stuRows = env.doc.querySelectorAll('#studentsTbody tr');
    eq(stuRows.length, 6, 'six rows rendered in the students table');
    const cells = [...env.doc.querySelectorAll('#studentsTbody tr:first-child td')].map(td => td.textContent.trim());
    ok(cells.includes('40') && cells.includes('45'), 'present (40) and marked (45) rendered from the snapshot');
    eq(env.$('cSPresent').textContent, '240', 'summary card shows 240 students present (6 × 40)');
    eq(env.$('cTPresent').textContent, '18', 'teacher card shows 18 present (6 × 3)');
    eq(env.doc.querySelectorAll('#teachersTbody tr').length, 6, 'teacher table rendered too');
    eq(env.consoleErrors.length, 0, 'no console errors while rendering a snapshot');
  }

  // ── 8. The shipped button now reads the snapshot, same-origin ────────────
  section('8. Clicking Fetch reads data/ — Apps Script is never called');
  {
    const dataFiles = {
      'data/manifest.json': manifest,
      [`data/${manifest.markazes[0].file}`]: payload,
    };
    const env = makeEnv({
      master: csv,
      dataFiles,
      handler: () => ({ state: 'empty', rows: [] }),   // must never be reached
    });
    await bootMaster(env);
    await selectPath(env, SEL);
    ok(!env.$('btnLive').disabled, 'the ⟳ Live button is enabled once a Markaz is chosen');

    env.$('btnFetch').dispatchEvent(new env.window.Event('click'));
    for (let i = 0; i < 400 && (!env.S.run || /triggering|polling/.test(env.S.run.phase)); i++) await tick(2);

    const run = env.S.run;
    eq(run.source, 'snapshot', 'the run is tagged as a snapshot run');
    eq(run.phase, 'done', 'snapshot run completes as DONE');
    eq(run.store.size, 6, 'all 6 schools came from the snapshot');
    eq(env.gasRequests.length, 0, 'ZERO Apps Script requests — no CORS surface at all');
    ok(/snapshot/.test(env.$('completenessMsg').textContent), 'the bar says it is a snapshot: "' + env.$('completenessMsg').textContent.trim().slice(0, 60) + '…"');
    eq(env.doc.querySelectorAll('#studentsTbody tr').length, 6, 'table rendered from the snapshot');
    eq(env.$('cSPresent').textContent, '240', 'cards correct from the snapshot');
    eq(env.$('headerDate').textContent, '26 Sep', 'header date taken from the snapshot\'s todayDate');
    eq(env.consoleErrors.length, 0, 'no console errors on the snapshot path');
  }

  // ── 9. No snapshot published yet → falls back to live, silently ──────────
  section('9. No snapshot yet: automatic fallback to Apps Script');
  {
    const env = makeEnv({
      master: csv,
      // no dataFiles: the repo has not published a snapshot yet
      handler: (req) => {
        if (req.action === 'fetch') return { started: true, runId: req.runId, state: 'fetching', rows: [], total: 6 };
        return { state: 'done', fetched: 6, total: 6, todayDate: '26 Sep',
                 rows: list.map((s, i) => ({ emis: s.emis, name: s.name, level: 'Primary', gender: 'Male',
                   sPresent: 40, sAbsent: 5, sMarked: 45, tPresent: 3, tAbsent: 1, tMarked: 4,
                   status: 'ok', timestamp: '2026-09-26T09:00:00Z' })) };
      },
    });
    await bootMaster(env);
    await selectPath(env, SEL);
    env.$('btnFetch').dispatchEvent(new env.window.Event('click'));
    for (let i = 0; i < 600 && (!env.S.run || /triggering|polling/.test(env.S.run.phase)); i++) await tick(2);

    eq(env.S.run.phase, 'done', 'live fetch completed instead');
    eq(env.S.run.source, 'live', 'the fallback run is tagged live');
    eq(env.S.run.store.size, 6, 'all 6 schools arrived over the live path');
    ok(env.gasRequests.length > 0, 'Apps Script was used, as it must be when no snapshot exists');
    ok(!/snapshot/.test(env.$('completenessMsg').textContent), 'the bar does not claim a snapshot it did not use');
  }

  // ── 10. An incomplete snapshot must NOT auto-resume against Apps Script ──
  section('10. Snapshot missing schools → PARTIAL, no surprise live calls');
  {
    const partial = JSON.parse(JSON.stringify(payload));
    partial.rows = partial.rows.slice(0, 3);
    partial.total = 3;
    const man2 = JSON.parse(JSON.stringify(manifest));
    man2.markazes[0].schools = 3;
    man2.markazes[0].file = 'days/2026-09-26/partial.json';

    const env = makeEnv({
      master: csv,
      dataFiles: { 'data/manifest.json': man2, 'data/days/2026-09-26/partial.json': partial },
      handler: () => ({ state: 'empty', rows: [] }),   // must never be reached
    });
    await bootMaster(env);
    await selectPath(env, SEL);
    env.$('btnFetch').dispatchEvent(new env.window.Event('click'));
    for (let i = 0; i < 400 && (!env.S.run || /triggering|polling/.test(env.S.run.phase)); i++) await tick(2);

    const run = env.S.run;
    eq(run.phase, 'partial', 'reported PARTIAL, never a silent success');
    eq(run.store.size, 3, 'the 3 schools in the snapshot are kept');
    eq(env.S.missingList(run).length, 3, 'the 3 missing schools are identified');
    eq(env.gasRequests.length, 0, 'no auto-resume: a snapshot cannot be re-requested into completeness');
    ok(/in the published snapshot/.test(env.$('completenessMsg').textContent), 'the message names the snapshot as the source of the gap');
    eq(env.doc.querySelectorAll('#studentsTbody tr').length, 6, 'missing schools still listed as placeholders');

    // The gap is real, so the live escape hatch IS offered — and it must go to
    // Apps Script (a snapshot cannot be re-requested into completeness) while
    // keeping the rows the snapshot already delivered.
    eq(env.$('btnRetryMissing').style.display, 'inline-block', 'the live retry is offered for a snapshot gap');
    eq(env.$('btnRetryMissing').textContent, 'Retry missing (3)', 'it names the 3 missing schools');

    let triggerEmis = null;
    const live = makeEnv({
      master: csv,
      dataFiles: { 'data/manifest.json': man2, 'data/days/2026-09-26/partial.json': partial },
      handler: (req) => {
        if (req.action === 'fetch') { triggerEmis = req.emis; return { started: true, runId: req.runId, state: 'fetching', rows: [], total: 6 }; }
        return { state: 'done', fetched: 6, total: 6, todayDate: '26 Sep',
                 rows: list.slice(3).map(s => ({ emis: s.emis, name: s.name, level: 'Primary', gender: 'Male',
                   sPresent: 1, sAbsent: 1, sMarked: 2, tPresent: 1, tAbsent: 0, tMarked: 1,
                   status: 'ok', timestamp: '2026-09-26T09:00:00Z' })) };
      },
    });
    await bootMaster(live);
    await selectPath(live, SEL);
    live.$('btnFetch').dispatchEvent(new live.window.Event('click'));
    for (let i = 0; i < 400 && (!live.S.run || /triggering|polling/.test(live.S.run.phase)); i++) await tick(2);
    eq(live.S.run.phase, 'partial', 'snapshot gap reproduced');

    live.$('btnRetryMissing').dispatchEvent(new live.window.Event('click'));
    for (let i = 0; i < 600 && /triggering|polling/.test(live.S.run.phase); i++) await tick(2);

    eq(live.S.run.source, 'live', 'the retry run is a LIVE run');
    ok(Array.isArray(triggerEmis) && triggerEmis.length === 3, 'Apps Script was asked for exactly the 3 missing EMIS codes');
    eq(live.S.run.store.size, 6, 'the 3 snapshot rows were kept and the 3 live rows added');
    eq(live.S.run.phase, 'done', 'the gap closed and the run is now complete');
  }

  // ── 11. The master list is published too, and the client prefers it ──────
  section('11. schools.json replaces the 3.4 MB cross-origin CSV');
  {
    // A school listed under two Wings: de-duplicating by EMIS would delete a
    // row, and with it a Wing from the dropdown. The published list must not.
    const dupCsv = [
      'EMIS,School Name,District,Wing,Tehsil,Markaz,Level,Gender',
      '311000001,GPS One,Layyah,Wing A,Tehsil 1,Markaz M1,Primary,Male',
      '311000001,GPS One,Layyah,Wing B,Tehsil 1,Markaz M1,Primary,Male',
      '311000002,GPS Two,Layyah,Wing B,Tehsil 1,Markaz M1,Primary,Female',
    ].join('\n');

    const table = B.schoolsTable(dupCsv);
    eq(table.rows.length, 3, 'published list keeps all 3 rows (no de-duplication)');
    eq(B.schoolsFromText(dupCsv).length, 2, 'the FETCH list de-duplicates to 2 schools');
    eq(table.columns[1], 'School Name', 'header names preserved');
    eq(table.rows[1][3], 'Wing B', 'original values preserved verbatim, not normalised');

    await B.writeSchools(path.join(outDir, 'static'), dupCsv, '2026-09-26T09:00:00Z');
    const published = JSON.parse(fs.readFileSync(path.join(outDir, 'static', 'schools.json'), 'utf8'));
    eq(published.rows.length, 3, 'schools.json holds all 3 rows');

    // The client must build the same objects from the table as parseCSV does
    // from the CSV — otherwise the dropdowns and the completeness gate would
    // disagree depending on which source answered.
    const env = makeEnv({
      master: 'EMIS,School Name,District,Wing,Tehsil,Markaz,Level,Gender\n99999999,DECOY,Decoyland,Wing Z,Tehsil Z,Markaz Z,Primary,Male',
      dataFiles: { 'data/schools.json': published },
      handler: () => ({ state: 'empty', rows: [] }),
    });
    const n = await bootMaster(env);
    eq(n, 1, 'one district bootstrapped');
    eq(env.$('selDistrict').options[1].value, 'Layyah', 'the district came from schools.json, NOT the CSV');
    ok(![...env.$('selDistrict').options].some(o => o.value === 'Decoyland'), 'the CSV decoy was never used');
    eq(env.S.allRows.length, 3, 'all 3 rows loaded into allRows');

    const wings = env.S.masterRowsFor('Layyah', null, null, null).map(r => r['Wing']);
    ok(wings.includes('Wing A') && wings.includes('Wing B'), 'both Wings survived — the de-duped list would have lost Wing A');
    eq(env.gasRequests.length, 0, 'still zero Apps Script requests');
  }

  // ── 12. Connection check reports which source is actually live ───────────
  section('12. Connection check names the live source, not a guess');
  {
    // Re-read what section 11 wrote, rather than reaching across block scopes.
    const published = JSON.parse(fs.readFileSync(path.join(outDir, 'static', 'schools.json'), 'utf8'));
    const withData = makeEnv({
      master: csv,
      dataFiles: {
        'data/manifest.json': manifest,
        'data/schools.json': published,
        [`data/${manifest.markazes[0].file}`]: payload,
      },
      handler: () => ({ state: 'empty', rows: [] }),
    });
    await bootMaster(withData);
    const rep = await withData.S.runConnectionCheck();
    ok(/Snapshot data \(same-origin\):\s+OK — 1 Markaz file/.test(rep), 'reports the published snapshot and its Markaz count');
    ok(/School list \(same-origin\):\s+OK — 3 rows, in use/.test(rep), 'reports the static school list as in use');
    ok(/School-list CSV \(fallback\)/.test(rep), 'the CSV is labelled a fallback, not the primary source');

    const noData = makeEnv({ master: csv, handler: () => ({ state: 'empty', rows: [] }) });
    await bootMaster(noData);
    const rep2 = await noData.S.runConnectionCheck();
    ok(/none published — the dashboard is reading live from Apps Script/.test(rep2), 'with no snapshot it says so plainly');
    ok(/not published — falling back to the CSV/.test(rep2), 'and says the CSV is what it is using');
  }

  // ── 13. The shipped CLI, end to end, writing real files ──────────────────
  // Everything above calls the builder's functions. This drives main() — the
  // actual entry point the workflow runs — with only the network stubbed.
  section('13. main() as the workflow invokes it');
  {
    const cliCsv = path.join(tmp, 'cli-schools.csv');
    const rows = [['EMIS', 'School Name', 'District', 'Wing', 'Tehsil', 'Markaz', 'Level', 'Gender']];
    // Two Markazes, so grouping and the manifest are exercised.
    for (let i = 1; i <= 8; i++) {
      rows.push(['3110' + String(i).padStart(5, '0'), `GPS No ${i}`, 'Layyah', 'Wing A', 'Tehsil 1',
                 i <= 5 ? 'Markaz M1' : 'Markaz M2', 'Primary', i % 2 ? 'Male' : 'Female']);
    }
    fs.writeFileSync(cliCsv, toCSVText(rows));

    const cliOut = path.join(tmp, 'cli-data');
    const realFetch = globalThis.fetch;
    let sisCalls = 0;
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.host !== 'sis.pesrp.edu.pk') throw new Error('unexpected host ' + u.host);
      sisCalls++;
      const kind = u.pathname.includes('teachers') ? 't' : 's';
      return { ok: true, status: 200,
               text: async () => (kind === 's' ? LIVE_SHAPE(40, 5, 45) : LIVE_SHAPE(3, 1, 4)) };
    };

    let snap;
    try {
      snap = await B.main(['--schools', cliCsv, '--out', cliOut,
                           '--concurrency', '3', '--delay-ms', '0', '--retries', '2']);
    } finally {
      globalThis.fetch = realFetch;
    }

    eq(snap.stats.ok, 8, 'all 8 schools fetched through main()');
    eq(sisCalls, 16, 'main() made exactly 2 SIS calls per school');

    const man3 = JSON.parse(fs.readFileSync(path.join(cliOut, 'manifest.json'), 'utf8'));
    eq(man3.markazes.length, 2, 'main() grouped the schools into 2 Markaz files');
    eq(man3.markazes[0].schools + man3.markazes[1].schools, 8, 'and every school landed in one of them');
    ok(man3.markazes.every(m => fs.existsSync(path.join(cliOut, m.file))), 'every manifest entry points at a file that exists');

    const day = man3.day;
    ok(fs.existsSync(path.join(cliOut, 'days', day, 'summary.json')), 'summary.json written for the run day');
    const schoolsJson = JSON.parse(fs.readFileSync(path.join(cliOut, 'schools.json'), 'utf8'));
    eq(schoolsJson.rows.length, 8, 'main() published the school list too');
    eq(schoolsJson.columns[0], 'EMIS', 'with the original header names');

    // The published list must feed the client unchanged. Note the case
    // mismatch this deliberately exercises: the builder upper-cases Markaz
    // names, the school list keeps the sheet's own spelling. The dropdown
    // offers "Markaz M1"; the manifest keys it "MARKAZ M1". findSnapshotEntry
    // has to bridge that or the snapshot is never found.
    const first = man3.markazes[0];
    const markazCol = schoolsJson.columns.indexOf('Markaz');
    const asPublished = schoolsJson.rows.find(r => r[0] === '311000001')[markazCol];
    ok(first.markaz !== asPublished && first.markaz.toUpperCase() === asPublished.toUpperCase(),
       `the mismatch is real: dropdown offers "${asPublished}", manifest keys "${first.markaz}"`);

    const env = makeEnv({
      master: 'EMIS,School Name,District\n0,DECOY,Decoyland',
      dataFiles: { 'data/schools.json': schoolsJson, 'data/manifest.json': man3,
                   [`data/${first.file}`]: JSON.parse(fs.readFileSync(path.join(cliOut, first.file), 'utf8')) },
      handler: () => ({ state: 'empty', rows: [] }),
    });
    await bootMaster(env);
    await selectPath(env, { district: 'Layyah', wing: 'Wing A', tehsil: 'Tehsil 1', markaz: asPublished });
    ok(!env.$('btnFetch').disabled, 'the Markaz from the published list enabled Fetch');
    env.$('btnFetch').dispatchEvent(new env.window.Event('click'));
    for (let i = 0; i < 400 && (!env.S.run || /triggering|polling/.test(env.S.run.phase)); i++) await tick(2);
    eq(env.S.run.phase, 'done', 'the CLI\'s own output drives the dashboard to DONE');
    eq(env.S.run.store.size, first.schools, 'with every school that Markaz file contains');
    eq(env.gasRequests.length, 0, 'and still zero Apps Script requests');
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n' + '═'.repeat(64));
  if (fail) {
    console.log(`\x1b[31m${fail} CHECK(S) FAILED\x1b[0m`);
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log(`\x1b[32mALL ${pass} CHECKS PASSED\x1b[0m`);
})().catch(e => { console.error(e); process.exit(1); });
