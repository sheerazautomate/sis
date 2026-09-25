/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PESRP Attendance System — Code.gs (v3.0 — REDESIGNED)
 *
 *  Deployed for a CONSUMER @gmail.com account: 6 minutes per execution,
 *  20,000 URL Fetch calls/day, 30 concurrent executions.
 *
 *  WHAT CHANGED FROM v2.0, AND WHY
 *  ─────────────────────────────────────────────────────────────────────────
 *  1. PER-SCHOOL RETRY (the actual root cause of "have to click many times")
 *     v2 used UrlFetchApp.fetchAll for the whole batch. muteHttpExceptions
 *     only suppresses HTTP status errors — a DNS/TLS/socket failure still
 *     throws and aborts ALL 20 requests in the batch, and v2's catch block
 *     then wrote every school in that batch as an empty error row. One flaky
 *     request silently blanked 10 schools while the row count still looked
 *     complete. Now: fetchAll first, and on a batch-level throw we fall back
 *     to per-school requests, then retry whatever failed (3 attempts).
 *
 *  2. RUN STATE MOVED OFF THE SHEET
 *     The sentinel row + `getDataRange().getValues()` scan is gone. Run state
 *     and result rows live in CacheService, so `action=status` is O(1) with
 *     zero sheet I/O. No sentinel races, no stale-row-index writes.
 *
 *  3. NEVER DELETE BEFORE FETCHING
 *     v2 deleted the Markaz's rows first, so the Markaz had no data for the
 *     whole fetch window and a crashed run left nothing behind plus a sentinel
 *     stuck on "fetching" forever. Now results are committed to the sheet only
 *     once the run finishes, in one atomic block under the script lock.
 *
 *  4. TIME-BUDGETED CHUNKS — NO 6-MINUTE WALL
 *     Each execution works for at most WORK_BUDGET_MS then persists and
 *     returns. The dashboard's poll loop nudges `action=fetchChunk` to
 *     continue. A 100+ school secondary wing can take as long as it needs
 *     across as many executions as it needs.
 *
 *  5. HONEST TOTALS
 *     v2 reported `total = dataRows.length` when done, so `fetched === total`
 *     always and a shortfall was unreportable. `total` is now the number of
 *     schools in the DB for that Markaz, and `missing[]` lists the EMIS codes
 *     that never came back.
 *
 *  6. CROSS-MARKAZ WRITE RACE FIXED
 *     v2's appendRows used sheet-wide getLastRow() while the lock was
 *     per-Markaz, so two people fetching DIFFERENT Markazes could compute the
 *     same lastRow and overwrite each other. The commit now holds the script
 *     lock across delete+write, and deletes in contiguous ranges instead of
 *     one deleteRow call per school.
 *
 *  7. runId ECHO
 *     Every response echoes the client's runId, so the dashboard can tell its
 *     own run from a stale or another user's result.
 *
 *  BACKWARDS COMPATIBLE: the response shape is v2's plus new fields, and every
 *  existing action (fetch, status, fetchMonthly, statusMonthly, verifyPassword,
 *  getConfig, saveConfig) still works. The old dashboard still runs against this.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const SCRIPT_VERSION = "3.0.0";

// ── CONFIG ──────────────────────────────────────────────────────────
const CONFIG = {
  DB_SHEET_ID:        "1Y5nOSaEGtksZ7sZJNpXMCin6hKRBzTIb0yKmCmq3-pc", // Punjab Schools DB
  OUTPUT_SHEET_ID:    "1SjLf4kGpwZfeuZIQX6HR6hoWDeMFgh6u-A1-WPhbdCM", // Attendance Fetch sheet
  OUTPUT_SHEET_NAME:  "AttendanceFetch",
  MONTHLY_SHEET_NAME: "MonthlyAttendance",
  ADMIN_CONFIG_SHEET: "AdminConfig",
  DB_SHEET_NAME:      "Schools",

  BATCH_SIZE:         10,    // schools per SIS batch (2 URLs each)
  WORK_BUDGET_MS:     90000, // work this long per execution, then persist & return
  MAX_ATTEMPTS:       3,     // per-school SIS attempts before giving up on it
  RETRY_BACKOFF_MS:   400,   // base delay between retry attempts
  CACHE_TTL_SEC:      6 * 60 * 60,
  ROWS_PER_SHARD:     30,    // keeps every cache value well under the 100 KB cap
  COMMIT_LOCK_MS:     30000,

  SIS_STUDENT_URL:         "https://sis.pesrp.edu.pk/attendance/get_today_attendance_stats",
  SIS_TEACHER_URL:         "https://sis.pesrp.edu.pk/attendance/get_teachers_today_attendance_stats",
  SIS_STUDENT_MONTHLY_URL: "https://sis.pesrp.edu.pk/attendance/get_attendance_line_stats",
  SIS_TEACHER_MONTHLY_URL: "https://sis.pesrp.edu.pk/attendance/get_teachers_attendance_line_stats",

  COLS: {
    MARKAZ: 0, EMIS: 1, SCHOOL: 2, LEVEL: 3, GENDER: 4,
    S_PRESENT: 5, S_ABSENT: 6, S_MARKED: 7,
    T_PRESENT: 8, T_ABSENT: 9, T_MARKED: 10,
    TIMESTAMP: 11, STATUS: 12, FETCH_STATE: 13, TODAY_DATE: 14,
  },
  MCOLS: {
    MARKAZ: 0, EMIS: 1, SCHOOL: 2, LEVEL: 3, GENDER: 4, MONTH: 5,
    STUDENT_DATA: 6, TEACHER_DATA: 7, DAY: 8, WEEKENDS: 9, HOLIDAY_DATES: 10,
    TIMESTAMP: 11, STATUS: 12, FETCH_STATE: 13,
  },
};

const NUM_COLS         = 15;
const NUM_MONTHLY_COLS = 14;

// ════════════════════════════════════════════════════════════════════
//  ROUTER
// ════════════════════════════════════════════════════════════════════
/**
 * JSONP channel. The dashboard sends `?callback=fn` when the browser refuses
 * to hand it a CORS response ("Cross-Origin Request Blocked" — an HTML error
 * page from a failed/killed execution, a quota stop, or a large response that
 * comes back without `Access-Control-Allow-Origin`). A <script> tag is not
 * subject to CORS, so the same payload arrives as `fn({...});` instead.
 */
let JSONP_CALLBACK = "";

/**
 * Payload shaping. `slim=1` drops the `rows` array and keeps every counter, so
 * a caller that only wants to start a run or nudge a stalled one transfers a
 * few hundred bytes instead of the whole Markaz. Big responses are the ones
 * Google has been seen to answer without `Access-Control-Allow-Origin`, which
 * the browser reports as "Cross-Origin Request Blocked".
 */
let RESPONSE_OPTS = { slim: false };

function doGet(e) {
  const p      = (e && e.parameter) || {};
  const action = (p.action || "status").toLowerCase();
  const markaz = (p.markaz || "").trim();
  const month  = (p.month  || "").trim();
  const runId  = (p.runId  || "").trim();

  // Only a plain JS identifier / dotted path is accepted — never injected raw.
  const asked = String(p.callback || p.cb || "").trim();
  JSONP_CALLBACK = /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/.test(asked) ? asked : "";
  RESPONSE_OPTS  = { slim: String(p.slim || "") === "1" };

  if (action === "health") return jsonOut({ version: SCRIPT_VERSION, time: new Date().toISOString() });

  // Admin config actions need no markaz
  if (action === "verifypassword") return handleVerifyPassword(e);
  if (action === "getconfig")      return handleGetConfig(e);
  if (action === "saveconfig")     return handleSaveConfig(e);

  if (!markaz) return jsonOut({ error: "markaz parameter is required" });

  if (action === "fetch")         return jsonOut(startJob_(dailyJob_(markaz), runId, null));
  if (action === "fetchchunk")    return jsonOut(continueJob_(dailyJob_(markaz), runId));
  if (action === "status")        return jsonOut(statusFor_(dailyJob_(markaz), runId));
  if (action === "fetchmonthly")  return jsonOut(startJob_(monthlyJob_(markaz, month), runId, null));
  if (action === "fetchchunkmonthly") return jsonOut(continueJob_(monthlyJob_(markaz, month), runId));
  if (action === "statusmonthly") return jsonOut(statusFor_(monthlyJob_(markaz, month), runId));

  return jsonOut({ error: "Unknown action. Use fetch|status|fetchMonthly|statusMonthly|fetchChunk|verifyPassword|getConfig|saveConfig" });
}

function doPost(e) {
  const params = JSON.parse((e.postData && e.postData.contents) || "{}");
  const action = (params.action || "fetch").toLowerCase();

  if (action === "saveconfig") return handleSaveConfig({ parameter: params });

  const markaz = (params.markaz || "").trim();
  const month  = (params.month  || "").trim();
  const runId  = (params.runId  || "").trim();
  if (!markaz) return jsonOut({ error: "markaz required in POST body" });

  if (action === "fetchmonthly") return jsonOut(startJob_(monthlyJob_(markaz, month), runId, null));
  return jsonOut(startJob_(dailyJob_(markaz), runId, null));
}

// ════════════════════════════════════════════════════════════════════
//  ADMIN CONFIG (unchanged behaviour)
// ════════════════════════════════════════════════════════════════════
function handleVerifyPassword(e) {
  try {
    const supplied = ((e.parameter && e.parameter.password) || "").trim();
    const correct  = PropertiesService.getScriptProperties().getProperty("ADMIN_PASSWORD") || "";
    if (!correct) return jsonOut({ ok: false, error: "ADMIN_PASSWORD script property not set. Please configure it in GAS Project Settings." });
    return jsonOut({ ok: supplied.length > 0 && supplied === correct });
  } catch (err) {
    return jsonOut({ ok: false, error: err.message });
  }
}

function handleGetConfig(e) {
  const month = ((e.parameter && e.parameter.month) || "").trim();
  const sheet = SpreadsheetApp.openById(CONFIG.OUTPUT_SHEET_ID).getSheetByName(CONFIG.ADMIN_CONFIG_SHEET);
  if (!sheet) return jsonOut({ found: false, error: "AdminConfig sheet not found" });

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return jsonOut({ found: false });

  for (let i = 1; i < data.length; i++) {
    const cellValue = data[i][0];
    const rowMonth = (cellValue instanceof Date)
      ? Utilities.formatDate(cellValue, Session.getScriptTimeZone(), "yyyy-MM")
      : String(cellValue).trim();

    if (rowMonth === month) {
      return jsonOut({
        found: true,
        weekends: safeParseJSON(data[i][1]) || [],
        holidays: safeParseJSON(data[i][2]) || [],
        updatedAt: data[i][3],
      });
    }
  }
  return jsonOut({ found: false, checkedMonth: month });
}

function handleSaveConfig(e) {
  const scriptLock = LockService.getScriptLock();
  try { scriptLock.waitLock(10000); }
  catch (err) { return jsonOut({ saved: false, error: "Server is busy saving other configurations. Please try again." }); }

  try {
    const p        = e.parameter || {};
    const month    = (p.month    || "").trim();
    const weekends = (p.weekends || "[]").trim();
    const holidays = (p.holidays || "[]").trim();

    if (!month) return jsonOut({ saved: false, error: "month parameter required (e.g. 2026-05)" });
    try { JSON.parse(weekends); } catch (x) { return jsonOut({ saved: false, error: "Invalid weekends JSON" }); }
    try { JSON.parse(holidays); } catch (x) { return jsonOut({ saved: false, error: "Invalid holidays JSON" }); }

    const ss = SpreadsheetApp.openById(CONFIG.OUTPUT_SHEET_ID);
    let sheet = ss.getSheetByName(CONFIG.ADMIN_CONFIG_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.ADMIN_CONFIG_SHEET);
      sheet.getRange(1, 1, 1, 4).setValues([["month", "weekends", "holidays", "updatedAt"]]);
      sheet.setFrozenRows(1);
    }

    const now     = new Date().toISOString();
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
      for (let i = 0; i < data.length; i++) {
        if (String(data[i][0]).trim() === month) {
          sheet.getRange(i + 2, 1, 1, 4).setValues([[month, weekends, holidays, now]]);
          return jsonOut({ saved: true });
        }
      }
    }
    sheet.appendRow([month, weekends, holidays, now]);
    return jsonOut({ saved: true });
  } catch (err) {
    return jsonOut({ saved: false, error: err.message });
  } finally {
    try { scriptLock.releaseLock(); } catch (x) {}
  }
}

// ════════════════════════════════════════════════════════════════════
//  JOB DEFINITIONS
//  A "job" bundles everything the generic runner needs. Daily and monthly
//  share one runner, so chunking/retry/resume exist for both.
// ════════════════════════════════════════════════════════════════════
function dailyJob_(markaz) {
  return {
    kind:      "daily",
    key:       "run::D::" + normKey_(markaz),
    markaz:    markaz,
    month:     null,
    listSchools: () => getSchoolsByMarkaz(markaz),
    fetchBatch:  (schools) => fetchDailyBatchWithRetry(schools),
    buildRow:    (school, res) => buildDailyRow(markaz, school, res),
    // Sheet columns are only needed when falling back to a cold read.
    coldRead:    () => readDailyFromSheet_(markaz),
    commit:      (rows) => commitDailyRows_(markaz, rows),
  };
}

function monthlyJob_(markaz, month) {
  if (!month) {
    return { kind: "monthly", invalid: "month parameter is required (e.g. 2026-05)" };
  }
  return {
    kind:      "monthly",
    key:       "run::M::" + normKey_(markaz) + "::" + normKey_(month),
    markaz:    markaz,
    month:     month,
    listSchools: () => getSchoolsByMarkaz(markaz),
    fetchBatch:  (schools) => fetchMonthlyBatchWithRetry(schools, month),
    buildRow:    (school, res) => buildMonthlyRow(markaz, month, school, res),
    coldRead:    () => readMonthlyFromSheet_(markaz, month),
    commit:      (rows) => commitMonthlyRows_(markaz, month, rows),
  };
}

function normKey_(s) { return String(s || "").toUpperCase().trim(); }

// ════════════════════════════════════════════════════════════════════
//  GENERIC RUNNER — cache-backed, time-budgeted, resumable
// ════════════════════════════════════════════════════════════════════
function cache_() { return CacheService.getScriptCache(); }

function readRun_(key) {
  const raw = cache_().get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function writeRun_(key, st) {
  st.updatedAt = Date.now();
  cache_().put(key, JSON.stringify(st), CONFIG.CACHE_TTL_SEC);
}

/** Result rows are sharded so no single cache value approaches the 100 KB cap. */
function rowsKeys_(key, count) {
  const shards = Math.max(1, Math.ceil(count / CONFIG.ROWS_PER_SHARD));
  const keys = [];
  for (let i = 0; i < shards; i++) keys.push(key + "::rows::" + i);
  return keys;
}

function writeRows_(key, rows) {
  const c = cache_();
  // Clear any previous shards beyond the new count so stale data can't linger.
  const stale = [];
  for (let i = Math.ceil(rows.length / CONFIG.ROWS_PER_SHARD); i < 400; i++) {
    stale.push(key + "::rows::" + i);
    if (stale.length > 60) break;
  }
  if (stale.length) { try { c.removeAll(stale); } catch (e) {} }

  for (let i = 0; i < rows.length; i += CONFIG.ROWS_PER_SHARD) {
    const part  = rows.slice(i, i + CONFIG.ROWS_PER_SHARD);
    const shard = key + "::rows::" + (i / CONFIG.ROWS_PER_SHARD);
    try {
      c.put(shard, JSON.stringify(part), CONFIG.CACHE_TTL_SEC);
    } catch (err) {
      // Value too large even after sharding — drop the bulkiest field and retry.
      c.put(shard, JSON.stringify(part.map(r => { const q = Object.assign({}, r); delete q.raw; return q; })),
            CONFIG.CACHE_TTL_SEC);
    }
  }
}

function readRows_(key, count) {
  const keys   = rowsKeys_(key, count);
  const blobs  = cache_().getAll(keys);
  const out    = [];
  keys.forEach(k => {
    const raw = blobs && blobs[k];
    if (!raw) return;
    try { const arr = JSON.parse(raw); if (Array.isArray(arr)) out.push.apply(out, arr); } catch (e) {}
  });
  return out;
}

/** Start (or restart) a job. Returns the status payload. */
function startJob_(job, runId, _unused) {
  if (job.invalid) return { error: job.invalid, runId: runId || null };

  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (e) {
    const cur = readRun_(job.key);
    return { state: "locked", runId: cur ? cur.runId : (runId || null),
             message: "Another fetch is in progress for this Markaz. Poll status." };
  }

  try {
    const existing = readRun_(job.key);
    const reuse = existing && existing.state === "fetching" &&
                  (!runId || !existing.runId || existing.runId === runId);

    if (!reuse) {
      const schools = job.listSchools();
      if (!schools.length) {
        return { state: "error", runId: runId || null,
                 error: "No schools found for markaz: " + job.markaz };
      }
      writeRun_(job.key, {
        v: 1,
        runId:   runId || ("srv-" + Date.now()),
        kind:    job.kind,
        markaz:  job.markaz,
        month:   job.month,
        date:    todayISO_(),
        state:   "fetching",
        queue:   schools.map(s => s.emis),
        schools: schools,                 // cached so a resume needs no sheet read
        rowOrder: schools.map(s => s.emis),
        rowsStored: 0,
        total:   schools.length,
        round:   1,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: null,
      });
      writeRows_(job.key, []);
    }

    runChunk_(job);
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }

  // Commit happens only after the job lock is released (locks are not
  // re-entrant), and only once the run has actually finished.
  commitIfNeeded_(job);
  return summarize_(job, readRun_(job.key));
}

/** Continue a job that ran out of time budget. Safe to call at any time. */
function continueJob_(job, runId) {
  if (job.invalid) return { error: job.invalid, runId: runId || null };
  const st = readRun_(job.key);
  if (!st) return { state: "empty", runId: runId || null, rows: [], fetched: 0, total: 0 };
  if (st.state !== "fetching") return summarize_(job, st);

  const lock = LockService.getScriptLock();
  try { lock.waitLock(5000); }
  catch (e) { return summarize_(job, st); }   // someone else is already working

  try {
    runChunk_(job);
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }

  commitIfNeeded_(job);
  return summarize_(job, readRun_(job.key));
}

/**
 * Work for at most WORK_BUDGET_MS, persisting after every batch.
 * A crash or a 6-minute kill loses at most the in-flight batch.
 */
function runChunk_(job) {
  let st = readRun_(job.key);
  if (!st) return null;

  const started = Date.now();
  const rows    = readRows_(job.key, st.rowsStored || 0);
  const byEmis  = {};
  rows.forEach(r => { byEmis[r.emis] = r; });

  while (st.queue.length && (Date.now() - started) < CONFIG.WORK_BUDGET_MS) {
    const batchEmis  = st.queue.slice(0, CONFIG.BATCH_SIZE);
    const emisSet    = {};
    batchEmis.forEach(e => { emisSet[e] = true; });
    const batch      = st.schools.filter(s => emisSet[s.emis]);
    st.queue         = st.queue.slice(batchEmis.length);

    const results = job.fetchBatch(batch);
    results.forEach(r => { byEmis[r.school.emis] = job.buildRow(r.school, r); });

    st.rowsStored = Object.keys(byEmis).length;
    writeRows_(job.key, st.rowOrder.map(e => byEmis[e]).filter(Boolean));
    writeRun_(job.key, st);
    st = readRun_(job.key);
  }

  if (!st.queue.length) {
    st.state       = "done";
    st.completedAt = Date.now();
    // Do NOT commit here: Apps Script script locks are not re-entrant, and the
    // caller still holds the job lock. The caller commits once it lets go.
    st.needsCommit = true;
    writeRun_(job.key, st);
  }
  return st;
}

/** Publish finished results to the sheet. Runs with no job lock held. */
function commitIfNeeded_(job) {
  const st = readRun_(job.key);
  if (!st || !st.needsCommit) return;

  const rows = readRows_(job.key, st.rowsStored || 0);
  try {
    job.commit(rows);
    st.needsCommit = false;
    st.committed   = true;
    delete st.commitError;
  } catch (e) {
    // Leave needsCommit set so the next call retries the commit.
    st.commitError = String(e && e.message ? e.message : e);
  }
  writeRun_(job.key, st);
}

/** Build the JSON response. Same shape as v2 plus runId / missing / version. */
function summarize_(job, st, slim) {
  if (!st) return { state: "empty", rows: [], fetched: 0, total: 0 };

  const rows   = readRows_(job.key, st.rowsStored || 0);
  const got    = {};
  rows.forEach(r => { if (r && r.emis) got[r.emis] = true; });
  const missing = (st.rowOrder || []).filter(e => !got[e]);
  const failed  = rows.filter(r => r && r.status === "error").length;

  const todayDate = (rows.find(r => r && r.todayDate) || {}).todayDate || "";

  const omitRows = (slim === undefined) ? !!RESPONSE_OPTS.slim : !!slim;

  return {
    runId:     st.runId,
    state:     st.state,
    date:      st.date,
    todayDate: todayDate,
    rows:      omitRows ? [] : rows,     // counters below stay true either way
    rowsOmitted: omitRows,
    fetched:   rows.length,
    total:     st.total,                 // schools expected, NOT rows written
    missing:   missing,                  // EMIS codes not yet returned
    failedCount: failed,
    round:     st.round,
    hasMore:   st.state === "fetching" && (st.queue || []).length > 0,
    updatedAt: st.updatedAt,
    startedAt: st.startedAt,
    completedAt: st.completedAt,
    version:   SCRIPT_VERSION,
  };
}

/** action=status — pure cache read, no sheet I/O on the hot path. */
function statusFor_(job, runId) {
  if (job.invalid) return { error: job.invalid, runId: runId || null };

  const st = readRun_(job.key);
  if (st) {
    // Don't hand a client another run's in-flight data.
    if (runId && st.runId && st.runId !== runId && st.state === "fetching") {
      return { state: st.state, runId: st.runId, rows: [], fetched: 0, total: st.total,
               note: "run in progress belongs to " + st.runId, version: SCRIPT_VERSION };
    }
    return summarize_(job, st);
  }

  // Cache expired (or never ran): fall back to whatever is committed in the sheet.
  const cold = job.coldRead();
  if (!cold.rows.length) return { state: "empty", runId: runId || null, rows: [], fetched: 0, total: 0 };
  return {
    runId: runId || null, state: "done",
    rows: RESPONSE_OPTS.slim ? [] : cold.rows,
    rowsOmitted: !!RESPONSE_OPTS.slim,
    fetched: cold.rows.length, total: cold.rows.length, missing: [], failedCount: 0,
    todayDate: cold.todayDate, cached: false, version: SCRIPT_VERSION,
  };
}

// ════════════════════════════════════════════════════════════════════
//  SIS FETCHING WITH PER-SCHOOL RETRY
//  This is the fix for the "have to click many times" bug.
// ════════════════════════════════════════════════════════════════════

/**
 * fetchAll for speed; if the batch call itself throws (a network-level failure
 * that muteHttpExceptions cannot suppress) fall back to per-school requests so
 * one bad school cannot blank the whole batch. Then retry whatever still failed.
 */
function fetchWithRetry_(schools, buildRequests, parseOne) {
  const results = {};
  let pending = schools.slice();

  for (let attempt = 1; attempt <= CONFIG.MAX_ATTEMPTS && pending.length; attempt++) {
    const out = fetchBatchOnce_(pending, buildRequests, parseOne);
    const still = [];

    out.forEach(r => {
      const bad = (r.studentData && r.studentData.error) || (r.teacherData && r.teacherData.error);
      if (bad) { r.__attempts = attempt; still.push(r.school); results[r.school.emis] = r; }
      else results[r.school.emis] = r;
    });

    pending = still;
    if (pending.length && attempt < CONFIG.MAX_ATTEMPTS) Utilities.sleep(CONFIG.RETRY_BACKOFF_MS * attempt);
  }

  // Anything still failing after MAX_ATTEMPTS is reported honestly as an error.
  return schools.map(s => results[s.emis] || {
    school: s,
    studentData: { error: "no response after " + CONFIG.MAX_ATTEMPTS + " attempts" },
    teacherData: { error: "no response after " + CONFIG.MAX_ATTEMPTS + " attempts" },
  });
}

function fetchBatchOnce_(schools, buildRequests, parseOne) {
  const combined = [];
  schools.forEach(s => { const r = buildRequests(s); combined.push(r[0], r[1]); });

  let responses = null;
  try {
    responses = UrlFetchApp.fetchAll(combined, { muteHttpExceptions: true });
  } catch (e) {
    // Batch-level failure: retry each school individually so a single bad
    // connection costs one school instead of ten.
    return schools.map(s => {
      const reqs = buildRequests(s);
      let sr = null, tr = null;
      try { sr = UrlFetchApp.fetch(reqs[0].url, { muteHttpExceptions: true }); } catch (e1) { sr = { __err: String(e1) }; }
      try { tr = UrlFetchApp.fetch(reqs[1].url, { muteHttpExceptions: true }); } catch (e2) { tr = { __err: String(e2) }; }
      return { school: s, studentData: parseOne(sr), teacherData: parseOne(tr) };
    });
  }

  return schools.map((s, i) => ({
    school: s,
    studentData: parseOne(responses[i * 2]),
    teacherData: parseOne(responses[i * 2 + 1]),
  }));
}

function fetchDailyBatchWithRetry(schools) {
  return fetchWithRetry_(
    schools,
    (s) => [{ url: buildSISUrl(CONFIG.SIS_STUDENT_URL, s.emis), muteHttpExceptions: true },
            { url: buildSISUrl(CONFIG.SIS_TEACHER_URL, s.emis), muteHttpExceptions: true }],
    parseDailyResponse
  );
}

function fetchMonthlyBatchWithRetry(schools, month) {
  return fetchWithRetry_(
    schools,
    (s) => [{ url: buildMonthlySISUrl(CONFIG.SIS_STUDENT_MONTHLY_URL, s.emis, month), muteHttpExceptions: true },
            { url: buildMonthlySISUrl(CONFIG.SIS_TEACHER_MONTHLY_URL, s.emis, month), muteHttpExceptions: true }],
    parseMonthlyResponse
  );
}

function buildSISUrl(base, emis) {
  return base + "?district=&tehsil=&markaz=&school=&s_id_emis_code=" + encodeURIComponent(emis) + "&ony_kpztp_districts=false";
}

function buildMonthlySISUrl(base, emis, month) {
  return base + "?district=&tehsil=&markaz=&school=&month=" + encodeURIComponent(month) +
         "&s_id_emis_code=" + encodeURIComponent(emis) + "&ony_kpztp_districts=false";
}

function parseDailyResponse(response) {
  try {
    if (!response) return { error: "No response" };
    if (response.__err) return { error: "Request failed: " + response.__err };
    const code = response.getResponseCode();
    if (code !== 200) return { error: "HTTP " + code };
    const parsed = JSON.parse(response.getContentText());
    if (parsed && ('present_count' in parsed || 'marked_count' in parsed)) return parsed;
    return { error: "Unexpected response shape", raw: JSON.stringify(parsed).substring(0, 200) };
  } catch (e) {
    return { error: "Parse error: " + e.toString() };
  }
}

function parseMonthlyResponse(response) {
  try {
    if (!response) return { error: "No response" };
    if (response.__err) return { error: "Request failed: " + response.__err };
    const code = response.getResponseCode();
    if (code !== 200) return { error: "HTTP " + code };
    const parsed = JSON.parse(response.getContentText());
    if (parsed && Array.isArray(parsed.categories) && Array.isArray(parsed.present)) return parsed;
    return { error: "Unexpected response shape", raw: JSON.stringify(parsed).substring(0, 200) };
  } catch (e) {
    return { error: "Parse error: " + e.toString() };
  }
}

// ════════════════════════════════════════════════════════════════════
//  ROW BUILDERS (same column layout as v2)
// ════════════════════════════════════════════════════════════════════
function buildDailyRow(markaz, s, result) {
  const sd = result.studentData;
  const td = result.teacherData;
  const ok = sd && !sd.error && td && !td.error;
  const n = (v) => (v === null || v === undefined || v === "" ? null : (parseInt(v, 10) || 0));

  return {
    emis:     s.emis,
    name:     s.name,
    level:    s.level,
    gender:   s.gender,
    markaz:   normKey_(markaz),
    sPresent: ok ? n(sd.present_count) : null,
    sAbsent:  ok ? n(sd.absent_count)  : null,
    sMarked:  ok ? n(sd.marked_count)  : null,
    tPresent: ok ? n(td.present_count) : null,
    tAbsent:  ok ? n(td.absent_count)  : null,
    tMarked:  ok ? n(td.marked_count)  : null,
    timestamp: new Date().toISOString(),
    status:    ok ? "ok" : "error",
    error:     ok ? "" : String((sd && sd.error) || (td && td.error) || "unknown"),
    todayDate: (sd && sd.todayDate) ? sd.todayDate : ((td && td.todayDate) ? td.todayDate : ""),
  };
}

/** Object -> the 15-column sheet layout. Only the commit path needs this. */
function dailyRowToArray_(r) {
  const C = CONFIG.COLS;
  const cell = (v) => (v === null || v === undefined ? "" : v);
  const row = new Array(NUM_COLS).fill("");
  row[C.MARKAZ]      = r.markaz || "";
  row[C.EMIS]        = r.emis;
  row[C.SCHOOL]      = r.name;
  row[C.LEVEL]       = r.level;
  row[C.GENDER]      = r.gender;
  row[C.S_PRESENT]   = cell(r.sPresent);
  row[C.S_ABSENT]    = cell(r.sAbsent);
  row[C.S_MARKED]    = cell(r.sMarked);
  row[C.T_PRESENT]   = cell(r.tPresent);
  row[C.T_ABSENT]    = cell(r.tAbsent);
  row[C.T_MARKED]    = cell(r.tMarked);
  row[C.TIMESTAMP]   = r.timestamp;
  row[C.STATUS]      = r.status;
  row[C.FETCH_STATE] = "";
  row[C.TODAY_DATE]  = r.todayDate || "";
  return row;
}

function buildMonthlyRow(markaz, month, s, result) {
  const sd = result.studentData;
  const td = result.teacherData;
  const ok = sd && !sd.error && td && !td.error;

  const payload = (d) => ok
    ? { present: d.present, absent: d.absent, unmarked: d.unmarked, categories: d.categories }
    : { error: (d && d.error) || "unknown" };

  return {
    emis:   s.emis,
    name:   s.name,
    level:  s.level,
    gender: s.gender,
    markaz: normKey_(markaz),
    month:  String(month).toLowerCase(),
    studentData: payload(sd),
    teacherData: payload(td),
    day:          ok && sd.day != null ? sd.day : "",
    weekends:     ok ? (sd.weekends || {}) : {},
    holidayDates: ok ? (sd.holidayDates || []) : [],
    timestamp: new Date().toISOString(),
    status:    ok ? "ok" : "error",
  };
}

/** Object -> the 14-column monthly sheet layout. */
function monthlyRowToArray_(r) {
  const C = CONFIG.MCOLS;
  const row = new Array(NUM_MONTHLY_COLS).fill("");
  row[C.MARKAZ]        = r.markaz || "";
  row[C.EMIS]          = r.emis;
  row[C.SCHOOL]        = r.name;
  row[C.LEVEL]         = r.level;
  row[C.GENDER]        = r.gender;
  row[C.MONTH]         = r.month || "";
  row[C.STUDENT_DATA]  = JSON.stringify(r.studentData);
  row[C.TEACHER_DATA]  = JSON.stringify(r.teacherData);
  row[C.DAY]           = r.day;
  row[C.WEEKENDS]      = JSON.stringify(r.weekends || {});
  row[C.HOLIDAY_DATES] = JSON.stringify(r.holidayDates || []);
  row[C.TIMESTAMP]     = r.timestamp;
  row[C.STATUS]        = r.status;
  row[C.FETCH_STATE] = "";
  return row;
}

// ════════════════════════════════════════════════════════════════════
//  COMMIT — one atomic block, under the script lock
// ════════════════════════════════════════════════════════════════════
function commitRows_(sheet, header, matchFn, rows, numCols) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(CONFIG.COMMIT_LOCK_MS); }
  catch (e) { throw new Error("Could not acquire commit lock: " + e); }

  try {
    ensureHeader_(sheet, header);
    SpreadsheetApp.flush();
    deleteRowsBulk_(sheet, matchFn, numCols);
    if (rows && rows.length) {
      const lastRow = sheet.getLastRow();
      sheet.getRange(lastRow + 1, 1, rows.length, numCols).setValues(rows);
    }
    SpreadsheetApp.flush();
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function commitDailyRows_(markaz, rows) {
  const sheet = getOrCreateTab(CONFIG.OUTPUT_SHEET_ID, CONFIG.OUTPUT_SHEET_NAME);
  const want  = normKey_(markaz);
  commitRows_(sheet, DAILY_HEADER,
    (r) => normKey_(r[CONFIG.COLS.MARKAZ]) === want,
    rows.map(dailyRowToArray_), NUM_COLS);
}

function commitMonthlyRows_(markaz, month, rows) {
  const sheet = getOrCreateTab(CONFIG.OUTPUT_SHEET_ID, CONFIG.MONTHLY_SHEET_NAME);
  const want  = normKey_(markaz);
  const wm    = String(month).toLowerCase();
  commitRows_(sheet, MONTHLY_HEADER,
    (r) => normKey_(r[CONFIG.MCOLS.MARKAZ]) === want &&
           String(r[CONFIG.MCOLS.MONTH] || "").toLowerCase() === wm,
    rows.map(monthlyRowToArray_), NUM_MONTHLY_COLS);
}

/** Delete matching rows in contiguous ranges — one call per run, not per row. */
function deleteRowsBulk_(sheet, matchFn, numCols) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  const data = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  const hit  = data.map((r, i) => matchFn(r) ? i + 2 : 0).filter(Boolean);
  if (!hit.length) return;

  const ranges = [];
  let start = hit[0], prev = hit[0];
  for (let i = 1; i < hit.length; i++) {
    if (hit[i] === prev + 1) { prev = hit[i]; continue; }
    ranges.push([start, prev - start + 1]);
    start = prev = hit[i];
  }
  ranges.push([start, prev - start + 1]);

  // Delete bottom-up so earlier indices stay valid.
  for (let i = ranges.length - 1; i >= 0; i--) sheet.deleteRows(ranges[i][0], ranges[i][1]);
}

const DAILY_HEADER = ["Markaz","EMIS","School Name","Level","Gender",
  "S-Present","S-Absent","S-Marked","T-Present","T-Absent","T-Marked",
  "Timestamp","Status","FetchState","TodayDate"];

const MONTHLY_HEADER = ["Markaz","EMIS","School","Level","Gender","Month",
  "StudentData","TeacherData","Day","Weekends","HolidayDates",
  "Timestamp","Status","FetchState"];

function getOrCreateTab(spreadsheetId, tabName) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) sheet = ss.insertSheet(tabName);
  return sheet;
}

function ensureHeader_(sheet, header) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(header);
    sheet.setFrozenRows(1);
  }
}

// ── Cold reads (cache expired) ──────────────────────────────────────
function readDailyFromSheet_(markaz) {
  const sheet = getOrCreateTab(CONFIG.OUTPUT_SHEET_ID, CONFIG.OUTPUT_SHEET_NAME);
  ensureHeader_(sheet, DAILY_HEADER);
  const data = sheet.getDataRange().getValues();
  const C = CONFIG.COLS, want = normKey_(markaz);
  const rows = []; let todayDate = "";

  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (normKey_(r[C.MARKAZ]) !== want) continue;
    if ((r[C.FETCH_STATE] || "").toString().trim()) continue;   // legacy sentinel
    if (r[C.TODAY_DATE]) todayDate = r[C.TODAY_DATE];
    rows.push({
      emis:   r[C.EMIS]   || "",
      name:   r[C.SCHOOL] || "—",
      level:  r[C.LEVEL]  || "—",
      gender: r[C.GENDER] || "—",
      sPresent: r[C.S_PRESENT] !== "" ? Number(r[C.S_PRESENT]) : null,
      sAbsent:  r[C.S_ABSENT]  !== "" ? Number(r[C.S_ABSENT])  : null,
      sMarked:  r[C.S_MARKED]  !== "" ? Number(r[C.S_MARKED])  : null,
      tPresent: r[C.T_PRESENT] !== "" ? Number(r[C.T_PRESENT]) : null,
      tAbsent:  r[C.T_ABSENT]  !== "" ? Number(r[C.T_ABSENT])  : null,
      tMarked:  r[C.T_MARKED]  !== "" ? Number(r[C.T_MARKED])  : null,
      timestamp: r[C.TIMESTAMP] || "",
      status:    r[C.STATUS] || "error",
      todayDate: r[C.TODAY_DATE] || "",
    });
  }
  return { rows, todayDate };
}

function readMonthlyFromSheet_(markaz, month) {
  const sheet = getOrCreateTab(CONFIG.OUTPUT_SHEET_ID, CONFIG.MONTHLY_SHEET_NAME);
  ensureHeader_(sheet, MONTHLY_HEADER);
  const data = sheet.getDataRange().getValues();
  const C = CONFIG.MCOLS, want = normKey_(markaz), wm = String(month).toLowerCase();
  const rows = [];

  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (normKey_(r[C.MARKAZ]) !== want) continue;
    if (String(r[C.MONTH] || "").toLowerCase() !== wm) continue;
    if ((r[C.FETCH_STATE] || "").toString().trim()) continue;
    rows.push({
      emis:   r[C.EMIS]   || "",
      name:   r[C.SCHOOL] || "—",
      level:  r[C.LEVEL]  || "—",
      gender: r[C.GENDER] || "—",
      studentData: safeParseJSON(r[C.STUDENT_DATA]),
      teacherData: safeParseJSON(r[C.TEACHER_DATA]),
      timestamp:   r[C.TIMESTAMP] || "",
      status:      r[C.STATUS] || "error",
    });
  }
  return { rows, todayDate: "" };
}

// ════════════════════════════════════════════════════════════════════
//  SCHOOL MASTER LIST
// ════════════════════════════════════════════════════════════════════
function getSchoolsByMarkaz(targetMarkaz) {
  const sheet = SpreadsheetApp.openById(CONFIG.DB_SHEET_ID).getSheetByName(CONFIG.DB_SHEET_NAME);
  if (!sheet) return [];

  const data   = sheet.getDataRange().getValues();
  const header = (data[0] || []).map(h => String(h).trim());
  // Prefer header names; fall back to v2's fixed indices if headers differ.
  const idx = (name, fallback) => {
    const i = header.indexOf(name);
    return i >= 0 ? i : fallback;
  };
  const I_MARKAZ = idx("Markaz", 2);
  const I_EMIS   = idx("EMIS", 5);
  const I_NAME   = idx("School Name", 6);
  const I_LEVEL  = idx("Level", 7);
  const I_GENDER = idx("Gender", 8);

  const want    = normKey_(targetMarkaz);
  const seen    = {};
  const results = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (normKey_(row[I_MARKAZ]) !== want) continue;
    const emis = String(row[I_EMIS] || "").trim();
    if (!emis || seen[emis]) continue;      // de-duplicate by EMIS
    seen[emis] = true;
    results.push({
      emis:   emis,
      name:   String(row[I_NAME]   || "").trim(),
      level:  String(row[I_LEVEL]  || "").trim(),
      gender: String(row[I_GENDER] || "").trim(),
    });
  }
  return results;
}

// ════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════
function jsonOut(obj) {
  const body = JSON.stringify(obj);
  if (JSONP_CALLBACK) {
    // JavaScript MIME, not JSON: browsers refuse to execute a cross-origin
    // script response that is served as application/json (ORB/CORB).
    return ContentService.createTextOutput(JSONP_CALLBACK + "(" + body + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

function safeParseJSON(val) {
  if (val === null || val === undefined || val === "") return null;
  try { return JSON.parse(val); } catch (e) { return null; }
}

function todayISO_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}
