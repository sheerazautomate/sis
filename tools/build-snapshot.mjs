#!/usr/bin/env node
/**
 * SIS → JSON snapshot builder.
 * ═══════════════════════════════════════════════════════════════════════════
 * Pulls attendance straight from sis.pesrp.edu.pk and writes static JSON into
 * this repository, which GitHub Pages then serves from the SAME ORIGIN as the
 * dashboard. A same-origin request cannot be "Cross-Origin Request Blocked",
 * so the whole class of failures the dashboard has been fighting disappears
 * from the read path — along with the Apps Script 6-minute limit, its quotas,
 * and the JSONP fallback.
 *
 * Why this can run here at all: the SIS stats endpoints answer a plain GET
 * with no cookie, no token and no session (verified 2026-09-25 — a request
 * with no credentials returned real JSON). CORS is a *browser* mechanism; a
 * Node process in GitHub Actions is not a browser, so it is not subject to it.
 *
 * Row shape is deliberately identical to buildDailyRow() in server/Code.gs, so
 * the dashboard's normalizeRow() consumes a snapshot with no changes at all.
 *
 * Usage (see also .github/workflows/sis-snapshot.yml):
 *   node tools/build-snapshot.mjs --district LAYYAH --concurrency 4
 *   node tools/build-snapshot.mjs --schools ./schools.csv --markaz "Markaz M1"
 *   node tools/build-snapshot.mjs --dry-run --limit 20
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const SIS_URLS = {
  student:         'https://sis.pesrp.edu.pk/attendance/get_today_attendance_stats',
  teacher:         'https://sis.pesrp.edu.pk/attendance/get_teachers_today_attendance_stats',
  studentMonthly:  'https://sis.pesrp.edu.pk/attendance/get_attendance_line_stats',
  teacherMonthly:  'https://sis.pesrp.edu.pk/attendance/get_teachers_attendance_line_stats',
};

export const DEFAULT_SCHOOLS_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQFGaSeUAf7BVkqHbcQg91XXeZbrVi8rATTJ-jxmOC1taoFXYvFa5J-LL6-Q1KR-Pz5AMS7tG8Skn2h/pub?gid=2066596328&single=true&output=csv';

// ── helpers (kept semantically identical to the dashboard's own) ────────────
/** RFC 4180 — mirrors parseCSV() in index.html. */
export function parseCSV(text) {
  const rows = [];
  let field = '', row = [], inQ = false;
  const src = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQ = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

/** Turns a parsed CSV into objects keyed by header name. */
export function csvToObjects(text) {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const head = rows[0].map(h => String(h).trim());
  return rows.slice(1).map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = String(r[i] === undefined ? '' : r[i]).trim(); });
    return o;
  });
}

/** Mirrors slug() in index.html so file names and export names agree. */
export function slug(s) {
  return String(s || 'export').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'export';
}

export function normKey(s) { return String(s || '').toUpperCase().trim(); }

/**
 * SIS returns counts as STRINGS and, above 999, as comma-grouped strings
 * ("10,470,662"). parseInt() on that yields 10 — so strip grouping first.
 * (server/Code.gs uses a bare parseInt and has this latent bug; it has not
 * bitten yet only because per-school counts are small.)
 */
export function toCount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/** Same URL shape the production server builds, and the one verified live. */
export function sisUrl(base, emis, month) {
  const u = new URL(base);
  u.searchParams.set('district', '');
  u.searchParams.set('tehsil', '');
  u.searchParams.set('markaz', '');
  u.searchParams.set('school', '');
  if (month) u.searchParams.set('month', month);
  u.searchParams.set('s_id_emis_code', String(emis));
  u.searchParams.set('ony_kpztp_districts', 'false');
  return u.toString();
}

// ── fetching ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** GET + JSON, with bounded retries. `fetchImpl` is injectable for tests. */
export async function getJson(url, { fetchImpl = fetch, retries = 3, backoffMs = 400, timeoutMs = 20000 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow' });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !('present_count' in parsed) && !('marked_count' in parsed)
          && !Array.isArray(parsed.categories)) {
        throw new Error(`unexpected shape: ${text.slice(0, 120)}`);
      }
      return { ok: true, data: parsed };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(backoffMs * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: String((lastErr && lastErr.message) || lastErr || 'failed') };
}

/** One school = two calls (students + teachers), exactly as Code.gs does. */
export async function fetchSchool(school, { month, fetchImpl, retries, backoffMs, timeoutMs } = {}) {
  const sBase = month ? SIS_URLS.studentMonthly : SIS_URLS.student;
  const tBase = month ? SIS_URLS.teacherMonthly : SIS_URLS.teacher;
  const [s, t] = await Promise.all([
    getJson(sisUrl(sBase, school.emis, month), { fetchImpl, retries, backoffMs, timeoutMs }),
    getJson(sisUrl(tBase, school.emis, month), { fetchImpl, retries, backoffMs, timeoutMs }),
  ]);
  return { student: s, teacher: t };
}

/**
 * Row shape == server/Code.gs buildDailyRow(), which is what the dashboard's
 * normalizeRow() already understands. Do not rename fields casually.
 */
export function buildRow(ctx, school, studentRes, teacherRes, nowIso) {
  const sd = studentRes.ok ? studentRes.data : { error: studentRes.error };
  const td = teacherRes.ok ? teacherRes.data : { error: teacherRes.error };
  const ok = !sd.error && !td.error;
  return {
    emis:     school.emis,
    name:     school.name,
    level:    school.level,
    gender:   school.gender,
    markaz:   ctx.markaz,
    district: ctx.district,
    wing:     ctx.wing,
    tehsil:   ctx.tehsil,
    sPresent: ok ? toCount(sd.present_count) : null,
    sAbsent:  ok ? toCount(sd.absent_count)  : null,
    sMarked:  ok ? toCount(sd.marked_count)  : null,
    tPresent: ok ? toCount(td.present_count) : null,
    tAbsent:  ok ? toCount(td.absent_count)  : null,
    tMarked:  ok ? toCount(td.marked_count)  : null,
    timestamp: nowIso,
    status:    ok ? 'ok' : 'error',
    error:     ok ? '' : String(sd.error || td.error || 'unknown'),
    todayDate: sd.todayDate || td.todayDate || '',
    ...(ctx.month ? { month: ctx.month } : {}),
  };
}

/** Bounded-concurrency worker pool — never opens more than `concurrency` sockets. */
export async function mapPool(items, concurrency, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.max(1, Math.min(concurrency, items.length))).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

// ── school list ─────────────────────────────────────────────────────────────
/** Column names are matched by header, with the fallbacks the client uses. */
export function normaliseSchool(o) {
  const emis = o['EMIS'] || o['Emis'] || o['emis'] || o['EMIS Code'] || o['EMISCode'] || '';
  if (!emis) return null;
  return {
    emis,
    name:     o['School Name'] || o['School'] || o['Name'] || o['schoolName'] || emis,
    level:    o['Level'] || o['level'] || '',
    gender:   o['Gender'] || o['gender'] || '',
    district: o['District'] || o['district'] || '',
    wing:     o['Wing'] || o['wing'] || '',
    tehsil:   o['Tehsil'] || o['tehsil'] || '',
    markaz:   normKey(o['Markaz'] || o['markaz'] || ''),
  };
}

/** Read the master list once; both the fetch pass and schools.json use it. */
export async function loadSchoolsText(source, { fetchImpl = fetch } = {}) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetchImpl(source, { redirect: 'follow' });
    if (!res.ok) throw new Error(`school list ${source} returned HTTP ${res.status}`);
    return await res.text();
  }
  return fs.readFile(source, 'utf8');
}

/**
 * Schools to FETCH: de-duplicated by EMIS, because the published list repeats
 * codes and one school only needs one pair of SIS calls.
 */
export function schoolsFromText(text) {
  const objs = csvToObjects(text).map(normaliseSchool).filter(Boolean);
  const seen = new Map();
  for (const s of objs) if (!seen.has(s.emis)) seen.set(s.emis, s);
  return [...seen.values()];
}

export async function loadSchools(source, opts = {}) {
  return schoolsFromText(await loadSchoolsText(source, opts));
}

/**
 * The master list to PUBLISH, as a compact column table. Deliberately NOT
 * de-duplicated and NOT normalised: the dashboard's dropdowns are built from
 * every row, so dropping a duplicate could delete a Wing or Markaz from the
 * selectors. Values are passed through exactly as the sheet has them.
 */
export function schoolsTable(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { columns: [], rows: [] };
  const columns = rows[0].map(h => String(h).trim());
  return { columns, rows: rows.slice(1).map(r => columns.map((_, i) => String(r[i] === undefined ? '' : r[i]))) };
}

export async function writeSchools(outDir, text, generatedAt) {
  const table = schoolsTable(text);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'schools.json'),
    JSON.stringify({ schema: 1, generatedAt, source: 'published school list', ...table }));
  return table;
}

// ── snapshot ────────────────────────────────────────────────────────────────
export function dateStamp(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/**
 * Fetch every school in `schools` and group the rows by Markaz.
 * Returns { markazes: Map, stats }.
 */
export async function buildSnapshot(schools, opts = {}) {
  const {
    concurrency = 4, delayMs = 120, retries = 3, backoffMs = 400,
    timeoutMs = 20000, month = '', fetchImpl = fetch, onProgress,
  } = opts;

  const nowIso = new Date().toISOString();
  const markazes = new Map();
  let done = 0, ok = 0, failed = 0;

  const rows = await mapPool(schools, concurrency, async (school) => {
    const r = await fetchSchool(school, { month, fetchImpl, retries, backoffMs, timeoutMs });
    const row = buildRow({
      markaz: school.markaz, district: school.district,
      wing: school.wing, tehsil: school.tehsil, month,
    }, school, r.student, r.teacher, nowIso);

    if (row.status === 'ok') ok++; else failed++;
    done++;
    if (onProgress && (done % 25 === 0 || done === schools.length)) {
      onProgress({ done, total: schools.length, ok, failed });
    }
    if (delayMs) await sleep(delayMs);
    return row;
  });

  for (const row of rows) {
    const key = `${row.district}|${row.wing}|${row.tehsil}|${row.markaz}`;
    if (!markazes.has(key)) {
      markazes.set(key, {
        district: row.district, wing: row.wing, tehsil: row.tehsil, markaz: row.markaz,
        slug: slug(`${row.district}-${row.markaz}`), rows: [],
      });
    }
    markazes.get(key).rows.push(row);
  }

  const todayDate = (rows.find(r => r.todayDate) || {}).todayDate || '';
  return { markazes, rows, generatedAt: nowIso, todayDate, stats: { ok, failed, total: rows.length } };
}

function totals(rows) {
  const t = { schools: rows.length, ok: 0, error: 0, sPresent: 0, sAbsent: 0, sMarked: 0, tPresent: 0, tAbsent: 0, tMarked: 0 };
  for (const r of rows) {
    if (r.status !== 'ok') { t.error++; continue; }
    t.ok++;
    t.sPresent += r.sPresent || 0; t.sAbsent += r.sAbsent || 0; t.sMarked += r.sMarked || 0;
    t.tPresent += r.tPresent || 0; t.tAbsent += r.tAbsent || 0; t.tMarked += r.tMarked || 0;
  }
  return t;
}

/**
 * Writes dated files + a manifest. The manifest is the only file the dashboard
 * has to know the name of; it points at the dated payload for each Markaz, so
 * history accumulates for free and nothing is ever duplicated.
 */
export async function writeSnapshot(outDir, snap, { day = dateStamp(), month = '' } = {}) {
  const dayDir = path.join(outDir, 'days', day);
  const entries = [];
  const summary = [];

  for (const m of [...snap.markazes.values()].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const rel = path.posix.join('days', day, `${m.slug}.json`);
    const abs = path.join(outDir, rel);
    const t = totals(m.rows);
    const payload = {
      schema: 1,
      generatedAt: snap.generatedAt,
      todayDate: snap.todayDate,
      ...(month ? { month } : {}),
      district: m.district, wing: m.wing, tehsil: m.tehsil, markaz: m.markaz,
      total: m.rows.length,
      totals: t,
      rows: m.rows,
    };
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify(payload));
    entries.push({
      district: m.district, wing: m.wing, tehsil: m.tehsil, markaz: m.markaz,
      slug: m.slug, file: rel, schools: m.rows.length,
      marked: t.sMarked, errors: t.error,
    });
    summary.push({ district: m.district, wing: m.wing, tehsil: m.tehsil, markaz: m.markaz, ...t });
  }

  await fs.writeFile(path.join(dayDir, 'summary.json'), JSON.stringify({
    schema: 1, day, generatedAt: snap.generatedAt, todayDate: snap.todayDate, markazes: summary,
  }));

  const manifest = {
    schema: 1,
    generatedAt: snap.generatedAt,
    todayDate: snap.todayDate,
    day,
    ...(month ? { month } : {}),
    source: 'sis.pesrp.edu.pk',
    stats: snap.stats,
    districts: [...new Set(entries.map(e => e.district))].sort(),
    markazes: entries,
  };
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return manifest;
}

/** Delete day folders older than keepDays. Keeps the repository from growing forever. */
export async function pruneDays(outDir, keepDays) {
  const root = path.join(outDir, 'days');
  let dirs = [];
  try { dirs = (await fs.readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString().slice(0, 10);
  const removed = [];
  for (const name of dirs) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(name) && name < cutoff) {
      await fs.rm(path.join(root, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function argVal(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) return dflt;
  return argv[i + 1];
}
function argAll(argv, name) {
  const out = [];
  argv.forEach((a, i) => { if (a === `--${name}` && argv[i + 1]) out.push(argv[i + 1]); });
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const schoolsSrc   = argVal(argv, 'schools', DEFAULT_SCHOOLS_URL);
  const outDir       = argVal(argv, 'out', 'data');
  const concurrency  = Number(argVal(argv, 'concurrency', '4'));
  const delayMs      = Number(argVal(argv, 'delay-ms', '120'));
  const retries      = Number(argVal(argv, 'retries', '3'));
  const keepDays     = Number(argVal(argv, 'keep-days', '7'));
  const limit        = Number(argVal(argv, 'limit', '0'));
  const month        = argVal(argv, 'month', '');
  const dryRun       = argv.includes('--dry-run');
  const districts    = argAll(argv, 'district').map(normKey);
  const markazes     = argAll(argv, 'markaz').map(normKey);

  console.log(`[snapshot] school list: ${schoolsSrc}`);
  const masterText = await loadSchoolsText(schoolsSrc);
  let schools = schoolsFromText(masterText);
  console.log(`[snapshot] ${schools.length} unique schools in the master list`);

  if (districts.length) schools = schools.filter(s => districts.includes(normKey(s.district)));
  if (markazes.length)  schools = schools.filter(s => markazes.includes(normKey(s.markaz)));
  if (limit > 0) schools = schools.slice(0, limit);
  console.log(`[snapshot] ${schools.length} school(s) in scope`
    + ` · concurrency ${concurrency} · ~${schools.length * 2} SIS requests`);

  if (!schools.length) { console.error('[snapshot] nothing in scope — check --district/--markaz'); process.exit(2); }

  const snap = await buildSnapshot(schools, {
    concurrency, delayMs, retries, month,
    onProgress: p => console.log(`[snapshot] ${p.done}/${p.total} · ok ${p.ok} · failed ${p.failed}`),
  });

  console.log(`[snapshot] fetched ${snap.stats.total} rows · ok ${snap.stats.ok} · failed ${snap.stats.failed}`
    + ` · ${snap.markazes.size} markaz group(s) · SIS todayDate "${snap.todayDate}"`);

  // A run where every school failed is a SIS-side outage, not a data set —
  // bail out BEFORE writing, so a broken snapshot is never published.
  if (snap.stats.ok === 0) { console.error('[snapshot] every school failed — refusing to publish'); process.exit(3); }

  if (dryRun) { console.log('[snapshot] --dry-run: nothing written'); return snap; }

  const manifest = await writeSnapshot(outDir, snap, { month });
  console.log(`[snapshot] wrote ${manifest.markazes.length} markaz file(s) + manifest into ${outDir}/`);

  // Publishing the master list too removes the dashboard's last cross-origin
  // read: it currently pulls a 3.4 MB CSV from docs.google.com on every load.
  const table = await writeSchools(outDir, masterText, snap.generatedAt);
  console.log(`[snapshot] wrote schools.json — ${table.rows.length} rows, ${table.columns.length} columns`);

  const removed = await pruneDays(outDir, keepDays);
  if (removed.length) console.log(`[snapshot] pruned ${removed.length} old day folder(s): ${removed.join(', ')}`);

  return snap;
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) main().catch(e => { console.error('[snapshot] fatal:', e && e.stack || e); process.exit(1); });
