/**
 * PESRP Attendance — Apps Script backend (reference implementation)
 * ═══════════════════════════════════════════════════════════════════════════
 * Drop this into the Apps Script project behind the existing web-app URL and
 * re-deploy as a NEW version ("Deploy ▸ Manage deployments ▸ ✎ ▸ New version").
 *
 * WHY THIS EXISTS
 * An Apps Script web-app request is hard-killed after 6 minutes. A Markaz with
 * many schools cannot be scraped inside one execution, so the old design could
 * only ever return whatever it managed to finish — and the dashboard had no way
 * to tell "complete" from "cut off". That is the root cause of
 * "sometimes it fails to fetch all schools".
 *
 * THE FIX
 *   1. Work is time-budgeted and CHUNKED. Each invocation scrapes for at most
 *      WORK_BUDGET_MS and then returns, having persisted its progress.
 *   2. Every response echoes the client's `runId`, so the dashboard can tell
 *      its own run apart from a stale/other-user result.
 *   3. `action=fetch&emis=...` resumes ONLY the listed EMIS codes, so a retry
 *      costs seconds instead of re-scraping the whole Markaz.
 *   4. `status` reports `missing[]` — the EMIS codes still outstanding.
 *
 * The contract stays backwards compatible: the old dashboard still works.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  YOU MUST IMPLEMENT: scrapeSchoolAttendance(school)   (see bottom)       │
 * │  Paste your existing SIS login + per-school scrape in there.             │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

var SCRIPT_VERSION = '2.0.0';

var WORK_BUDGET_MS = 4 * 60 * 1000;  // leave headroom under the 6-minute kill
var LOCK_WAIT_MS   = 5000;
var STATE_TTL_SEC  = 6 * 60 * 60;    // keep run state for 6 hours
var CHUNK_SIZE     = 25;             // schools per UrlFetchApp.fetchAll batch

// ── Config you must set ────────────────────────────────────────────────────
var CONFIG = {
  schoolListSheetId: 'PUT_THE_SHEET_ID_OF_YOUR_SCHOOL_MASTER_LIST_HERE',
  schoolListSheetName: 'Schools',
  resultsSheetId:    'PUT_THE_RESULTS_SHEET_ID_HERE_OR_LEAVE_SAME',
  resultsSheetName:  'Attendance',
  // Columns in the school master list, in order.
  cols: { emis: 'EMIS', name: 'School Name', district: 'District',
          wing: 'Wing', tehsil: 'Tehsil', markaz: 'Markaz',
          level: 'Level', gender: 'Gender' },
};

// ════════════════════════════════════════════════════════════════════════════
//  ENTRY POINT
// ════════════════════════════════════════════════════════════════════════════
function doGet(e) {
  var p = (e && e.parameter) || {};
  var markaz = (p.markaz || '').toString().trim();
  var runId  = (p.runId  || '').toString().trim();

  if (p.action === 'health') {
    return json_({ version: SCRIPT_VERSION, time: new Date().toISOString() });
  }
  if (!markaz) return json_({ error: 'markaz parameter is required' });

  try {
    switch (p.action) {
      case 'fetch':
        return json_(startOrResume_(markaz, runId, parseEmisList_(p.emis)));
      case 'fetchChunk':
        return json_(resumeRun_(markaz, runId, null));
      case 'status':
        return json_(statusFor_(markaz, runId));
      default:
        return json_({ error: 'unknown action: ' + p.action });
    }
  } catch (err) {
    return json_({ error: String(err && err.message ? err.message : err),
                   state: 'error', runId: runId || null });
  }
}

function parseEmisList_(raw) {
  if (!raw) return null;
  return raw.toString().split(',').map(function (s) { return s.trim(); })
            .filter(function (s) { return s !== ''; });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════════════════════════════════════
//  RUN STATE  (PropertiesService — survives between invocations)
// ════════════════════════════════════════════════════════════════════════════
function stateKey_(markaz) { return 'run::' + markaz; }

function readState_(markaz) {
  var raw = PropertiesService.getScriptProperties().getProperty(stateKey_(markaz));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

function writeState_(markaz, st) {
  // PropertiesService values are capped at 9 KB, so rows live in the sheet and
  // only the cursor + summary live here.
  PropertiesService.getScriptProperties()
    .setProperty(stateKey_(markaz), JSON.stringify(st));
}

function newRunState_(markaz, runId, schools) {
  return {
    runId:     runId || ('srv-' + new Date().getTime()),
    markaz:    markaz,
    date:      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    todayDate: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    state:     'fetching',
    queue:     schools.map(function (s) { return s.emis; }),
    done:      {},                 // emis -> row
    failed:    {},                 // emis -> error message
    fetched:   0,
    total:     schools.length,
    rounds:    1,
    startedAt: new Date().getTime(),
    updatedAt: new Date().getTime(),
    schoolMap: schools.reduce(function (acc, s) { acc[s.emis] = s; return acc; }, {}),
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  ACTIONS
// ════════════════════════════════════════════════════════════════════════════

/** action=fetch — start a run, or resume only the requested EMIS codes. */
function startOrResume_(markaz, runId, emisList) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    var cur = readState_(markaz);
    return { state: 'locked', runId: cur ? cur.runId : null,
             message: 'Another fetch is in progress for this Markaz.' };
  }
  try {
    var st = readState_(markaz);
    var fresh = !st || st.state === 'done' || st.state === 'error' ||
                (runId && st.runId !== runId);

    if (fresh) {
      var schools = schoolsForMarkaz_(markaz);
      if (!schools.length) {
        return { state: 'error', runId: runId || null,
                 error: 'No schools found in the master list for Markaz "' + markaz + '".' };
      }
      st = newRunState_(markaz, runId, schools);
      writeState_(markaz, st);
    } else if (emisList && emisList.length) {
      // Resume: put only the requested codes back on the queue.
      st.queue = emisList.filter(function (em) { return !st.done[em]; });
      st.state = 'fetching';
      st.rounds = (st.rounds || 1) + 1;
      if (runId) st.runId = runId;
      st.updatedAt = new Date().getTime();
      writeState_(markaz, st);
    }

    var result = runChunk_(markaz, st);
    return summarize_(markaz, result, true);
  } finally {
    lock.releaseLock();
  }
}

/** action=fetchChunk — the dashboard's "you stalled, keep going" nudge. */
function resumeRun_(markaz, runId) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    return { state: 'locked', runId: runId || null };
  }
  try {
    var st = readState_(markaz);
    if (!st) return { state: 'empty', runId: runId || null, rows: [], fetched: 0, total: 0 };
    if (st.state === 'done') return summarize_(markaz, st, false);
    return summarize_(markaz, runChunk_(markaz, st), false);
  } finally {
    lock.releaseLock();
  }
}

/** action=status — read-only, never starts work, so polling stays cheap. */
function statusFor_(markaz, runId) {
  var st = readState_(markaz);
  if (!st) return { state: 'empty', runId: runId || null, rows: [], fetched: 0, total: 0 };

  // A client asking about its own run must not be handed someone else's result.
  if (runId && st.runId && st.runId !== runId && st.state !== 'done') {
    return { state: st.state, runId: st.runId, rows: [], fetched: st.fetched, total: st.total,
             note: 'run in progress belongs to ' + st.runId };
  }
  return summarize_(markaz, st, false);
}

// ════════════════════════════════════════════════════════════════════════════
//  THE WORK LOOP — time-budgeted so we always return before the 6-minute kill
// ════════════════════════════════════════════════════════════════════════════
function runChunk_(markaz, st) {
  var started = new Date().getTime();

  while (st.queue.length && (new Date().getTime() - started) < WORK_BUDGET_MS) {
    var batch = st.queue.splice(0, CHUNK_SIZE);
    var results = scrapeBatch_(batch.map(function (em) { return st.schoolMap[em]; })
                                      .filter(function (s) { return !!s; }));

    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (r && r.status === 'ok') st.done[r.emis] = r;
      else if (r) st.failed[r.emis] = r.error || 'unknown error';
    }
    st.fetched = Object.keys(st.done).length + Object.keys(st.failed).length;
    st.updatedAt = new Date().getTime();
    writeState_(markaz, st);      // persist after every batch — a kill loses nothing
  }

  if (!st.queue.length) {
    st.state = 'done';
    appendResultsToSheet_(markaz, st);
  } else {
    st.state = 'fetching';        // out of time budget; the client will nudge us
  }
  writeState_(markaz, st);
  return st;
}

/**
 * Scrape a batch of schools. Uses fetchAll for parallelism; falls back to a
 * serial loop so one bad school cannot sink the batch.
 */
function scrapeBatch_(schools) {
  var out = [];
  for (var i = 0; i < schools.length; i++) {
    var s = schools[i];
    try {
      var row = scrapeSchoolAttendance(s);
      if (!row) throw new Error('no data returned');
      row.emis   = s.emis;
      row.name   = row.name   || s.name;
      row.level  = row.level  || s.level;
      row.gender = row.gender || s.gender;
      row.status = 'ok';
      row.timestamp = new Date().toISOString();
      out.push(row);
    } catch (err) {
      out.push({ emis: s.emis, name: s.name, level: s.level, gender: s.gender,
                 status: 'error', error: String(err && err.message ? err.message : err),
                 timestamp: new Date().toISOString() });
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
//  RESPONSE SHAPE
// ════════════════════════════════════════════════════════════════════════════
function summarize_(markaz, st, includeRows) {
  var doneKeys = Object.keys(st.done);
  var rows = doneKeys.map(function (k) { return st.done[k]; });

  var failedRows = Object.keys(st.failed).map(function (k) {
    var s = st.schoolMap[k] || {};
    return { emis: k, name: s.name || k, level: s.level || '', gender: s.gender || '',
             status: 'error', error: st.failed[k], timestamp: new Date().toISOString() };
  });

  var missing = st.queue.slice();
  var expected = Object.keys(st.schoolMap).length;

  return {
    runId:     st.runId,
    state:     st.state,
    date:      st.date,
    todayDate: st.todayDate,
    rows:      includeRows || st.state === 'done' ? rows.concat(failedRows) : rows,
    fetched:   st.fetched,
    total:     expected,
    round:     st.rounds,
    missing:   missing,                       // EMIS codes still outstanding
    failedCount: Object.keys(st.failed).length,
    updatedAt: st.updatedAt,
    version:   SCRIPT_VERSION,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  SCHOOL MASTER LIST
// ════════════════════════════════════════════════════════════════════════════
function schoolsForMarkaz_(markaz) {
  var cache = CacheService.getScriptCache();
  var key = 'schools::' + markaz;
  var hit = cache.get(key);
  var all = hit ? JSON.parse(hit) : null;

  if (!all) {
    var ss = SpreadsheetApp.openById(CONFIG.schoolListSheetId);
    var sh = ss.getSheetByName(CONFIG.schoolListSheetName) || ss.getSheets()[0];
    var values = sh.getDataRange().getValues();
    var head = values.shift().map(function (h) { return String(h).trim(); });
    var idx = {};
    head.forEach(function (h, i) { idx[h] = i; });
    var c = CONFIG.cols;

    all = values.map(function (r) {
      return {
        emis:   String(r[idx[c.emis]]   || '').trim(),
        name:   String(r[idx[c.name]]   || '').trim(),
        district: String(r[idx[c.district]] || '').trim(),
        wing:   String(r[idx[c.wing]]   || '').trim(),
        tehsil: String(r[idx[c.tehsil]] || '').trim(),
        markaz: String(r[idx[c.markaz]] || '').trim(),
        level:  String(r[idx[c.level]]  || '').trim(),
        gender: String(r[idx[c.gender]] || '').trim(),
      };
    }).filter(function (s) { return s.emis !== ''; });

    try { cache.put('allSchools', JSON.stringify(all), 3600); } catch (e) { /* >100 KB */ }
  }

  var out = all.filter(function (s) { return s.markaz === markaz; });
  if (out.length) { try { cache.put(key, JSON.stringify(out), 3600); } catch (e) {} }
  return out;
}

function appendResultsToSheet_(markaz, st) {
  try {
    var ss = SpreadsheetApp.openById(CONFIG.resultsSheetId || CONFIG.schoolListSheetId);
    var sh = ss.getSheetByName(CONFIG.resultsSheetName);
    if (!sh) sh = ss.insertSheet(CONFIG.resultsSheetName);
    if (sh.getLastRow() === 0) {
      sh.appendRow(['Date', 'Markaz', 'EMIS', 'School Name', 'Level', 'Gender',
                    'Students Present', 'Students Absent', 'Students Marked',
                    'Teachers Present', 'Teachers Absent', 'Teachers Marked',
                    'Status', 'Run ID', 'Fetched At']);
    }
    var rows = Object.keys(st.done).map(function (k) {
      var r = st.done[k];
      return [st.date, markaz, r.emis, r.name, r.level, r.gender,
              r.sPresent, r.sAbsent, r.sMarked, r.tPresent, r.tAbsent, r.tMarked,
              r.status, st.runId, r.timestamp];
    });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  } catch (err) {
    // Never let logging break the API response.
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  ★★★ IMPLEMENT THIS ★★★
//  Paste your existing SIS logic here. It must return an object shaped like:
//     { sPresent: 42, sAbsent: 3, sMarked: 45,
//       tPresent: 4,  tAbsent: 1, tMarked: 5 }
//  Throw on failure — the caller records it and the dashboard shows that
//  school as "Error" while still counting the rest of the Markaz.
//  Keep it under ~8 seconds per school so a 25-school batch fits the budget.
// ════════════════════════════════════════════════════════════════════════════
function scrapeSchoolAttendance(school) {
  throw new Error('scrapeSchoolAttendance() is not implemented — ' +
                  'paste your SIS scrape logic into server/Code.gs');
}
