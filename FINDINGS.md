# PESRP Attendance Dashboard — bug findings and the new fetch strategy

Everything below was verified against `index.html` at commit `e8ba177` (the
pre-fix version) and re-verified against the rebuilt file by
`node tests/suite.js` (126 checks), `node tests/server-suite.js` (94) and
`node tests/server-contract.js` (26).

---

## Why you have to click Fetch several times

There is no single bug. Five defects combine, and together they make a partial
result *look* like a finished one.

### 1. "done" was accepted without checking anything — the root cause
**Original `index.html:514-515`**
```js
if (state === 'done') { stopPolling(); setFetchingUI(false); ... }
```
The client trusted the server's word. It never asked *"did I get every school
this Markaz has?"* — even though it already had that answer: the school master
CSV it downloads at startup lists every EMIS code. `allRows` was used **only**
to populate the dropdowns (`index.html:404, 417, 428`) and never to validate
anything.

An Apps Script web-app request is hard-killed at 6 minutes. A Markaz that
cannot be scraped in time returns whatever finished, marks itself `done`, and
the dashboard renders it as complete. **Proof:** `tests/prove-bugs.js` scenario
A — original shows `6 rows, badge "6 schools"`; rebuilt shows `10 rows, badge
"10 schools"`.

**Fix:** completeness gate. `handleDone()` compares received EMIS codes against
the master list and only reports success at 100%. Otherwise it automatically
re-requests the missing codes (`maxRounds: 3`), and if they still do not come
back it reports **PARTIAL** with a `Retry missing (N)` button — never a silent
success.

### 2. Every poll overwrote everything instead of accumulating
**Original `index.html:503-504, 551`**
```js
if (rows.length > 0) { renderFromGAS(rows); }   // ...
function renderFromGAS(rows) { lastRows = rows; ... }
```
`lastRows` was replaced wholesale. A response with fewer rows than the previous
one threw the earlier schools away — permanently, for that click.

**Proof:** scenario B — poll 1 returns 8 schools, poll 3 returns 2. Original
ends with **2 rows**. Rebuilt ends with **10**.

**Fix:** rows are merged into a `Map` keyed by EMIS and never removed
(`pollOnce()`). Duplicates collapse; a short batch can no longer erase data.

### 3. Overlapping polls — `setInterval` with an `async` callback
**Original `index.html:465`**
```js
pollTimer = setInterval(() => pollStatus(markazForPoll), POLL_MS);
```
`setInterval` does not wait for the previous call. Apps Script routinely takes
longer than 2 s (cold start + the `script.google.com` →
`script.googleusercontent.com` redirect), so requests piled up and responses
arrived out of order. Combined with bug 2, an older response could overwrite a
newer one — the same click showing 60 schools and then dropping to 30.

**Fix:** a self-scheduling `while` loop (`pollLoop`) — by construction only one
request is ever in flight — with a growing interval (1.5 s → 6 s), ±20 % jitter,
and a per-request `AbortController` timeout. A `generation` counter discards any
response belonging to a superseded click.

### 4. The trigger was fire-and-forget
**Original `index.html:456`**
```js
fetch(triggerUrl).catch(() => {}); // deliberate non-await
```
If the trigger never landed — auth wall, quota, 429, offline — the client had no
idea. It went straight to polling and rendered whatever the server still had
cached, which is often **yesterday's** data.

**Proof:** scenario C — trigger returns an authorisation HTML page, status
returns 6 stale rows tagged `YESTERDAY`. Original: **no error shown, 6 stale
rows rendered as today's attendance**. Rebuilt: error panel, *"Apps Script
returned a web page, not data."*

**Fix:** the trigger is awaited (20 s budget), retried 3× with backoff, and its
response is inspected. A timeout is treated as "still working" (Apps Script
keeps running after the HTTP response is cut); an HTML page or HTTP error is
retried and then reported with an actionable explanation.

### 5. Polling stopped at exactly the moment the server gave up
**Original `index.html:351-352`** — `POLL_MS = 2000`, `POLL_MAX = 180` → 6
minutes, precisely the Apps Script execution limit. On timeout the client
stopped polling and said *"the fetch may still be running"*, then discarded
anything that arrived afterwards.

**Fix:** an 8-minute wall-clock deadline, stall detection that pokes the server
(`action=fetchChunk`) after 6 idle polls, and partial data is always kept and
exportable.

---

## Other defects fixed

| # | Where (original) | Problem | Fix |
|---|---|---|---|
| 6 | `:607`, `:645`, `:580-584` | `renderTableBody()` accepted a `sortKey` argument and ignored it, reading `sortState[table].col` instead. The teacher table's headers used `data-col="present"`, and the dead `colMap` mapped `tpresent` → so the **teacher table sorted by student figures**. | Each table has its own column keys (`tPresent`/`tAbsent`/`tMarked`/`tStatus`); the dead `colMap` is gone. Proof: scenario D — original `50,40,30,20,10`, rebuilt `10,20,30,40,50`. |
| 7 | `:370-371` | CSV parsed with `text.split('\n')` **before** handling quotes. Any school name containing a newline split one record into two, silently corrupting the master list — and therefore the expected-school count. `""` escapes were also mangled. | Proper RFC 4180 state machine (`parseCSV`). |
| 8 | `:628`, `:390` | School names from the network went into `innerHTML` unescaped → stored XSS from a spreadsheet cell. Dropdown values were string-interpolated too. | `esc()` on every injected value; `<option>` built with `textContent`. Test 11 asserts no `<img>` is created. |
| 9 | — | No de-duplication. A re-run that appended rows showed the same school twice. | `Map` keyed by EMIS. |
| 10 | `:665` | `renderCards()` used `lastRows.length` as the denominator while only counting non-error rows in the numerator, so percentages were wrong; `sMarked` compared with `>` on values that may be strings. | Denominator is `marked + notMarked`; all figures pass through `num()`. |
| 11 | — | `r.status !== 'ok'` made any unknown status an "Error". | Four states: Marked / Not Marked / Error / Missing. |
| 12 | — | Selection and theme were lost on reload. | Persisted to `localStorage`, restored and validated against the loaded list. |
| 13 | — | No way to abandon a stuck fetch. | Cancel button + generation bump. |
| 14 | — | CSV load had no retry and no cache-buster. | 3 retries with backoff, `no-store`, `_=timestamp`. |

---

## New: Download CSV

`⬇ Download CSV` in the filter bar opens a menu with six reports, and each
table has a quick `⬇ CSV` button.

| Report | Contents |
|---|---|
| **Students attendance** | One row per school: EMIS, name, District, Wing, Tehsil, Markaz, Level, Gender, present, absent, total marked, status |
| **Teachers attendance** | Same shape for teacher figures |
| **Combined per-school** | Student **and** teacher columns on one row, plus notes |
| **Summary totals** | Metric/value: run id, fetch state, rounds used, expected vs received, missing count, coverage %, all totals |
| **Not-marked schools** | Exception report — only schools where students or teachers are not marked |
| **Missing / failed schools** | EMIS codes from the master list the server never returned, ready to chase up |

Details: UTF-8 **BOM** so Excel opens Urdu and school names correctly; RFC 4180
quoting; leading `=`, `+`, `-`, `@` prefixed with `'` to block spreadsheet
formula injection; filename
`pesrp_<Markaz>_<report>_<YYYY-MM-DD_HHMMSS>.csv`; students/teachers follow the
current on-screen sort order; empty reports are refused rather than emitted as a
blank file.

---

## Run it yourself

```bash
npm install          # jsdom, dev only
npm test             # 246 checks: client (126) + server (94) + contract (26)
npm run test:bugs    # old vs new, side by side (needs the pre-fix commit on disk)
```

The suite loads the **real** `index.html` into jsdom and drives it through a
mock backend that reproduces the production failure modes. It does not
re-implement any dashboard logic.

---

## Server side

`server/Code.gs` is a drop-in Apps Script backend that makes the fix complete.
The client is correct against your **current** server, but the server still
cannot beat the 6-minute execution limit — so for a large Markaz the client
will now report `PARTIAL` accurately instead of silently under-reporting.

`Code.gs` adds:

* **Chunked, time-budgeted work** — each invocation scrapes for ≤ 4 minutes,
  persists progress after every batch, and returns. A kill loses nothing.
* **`runId` echo** — the dashboard can tell its own run from a stale or
  another-user result (it already degrades gracefully if the server omits it).
* **`action=fetch&emis=…`** — resumes only the listed codes, so a retry costs
  seconds rather than re-scraping the Markaz.
* **`status.missing[]`** — the EMIS codes still outstanding.
* **`action=fetchChunk`** — the client's "you stalled, keep going" nudge.
* `LockService` serialisation and `CacheService` for the school list.

You must paste your existing SIS scrape into `scrapeSchoolAttendance()` at the
bottom, and set `CONFIG`. The URL contract is unchanged and backwards
compatible — the old dashboard still works against it.

### Contract reference

| Request | Response |
|---|---|
| `?action=fetch&markaz=X&runId=R&round=N[&emis=a,b,c]` | `{runId, state, rows, fetched, total, round, missing[], failedCount}` |
| `?action=status&markaz=X&runId=R` | same shape, read-only, never starts work |
| `?action=fetchChunk&markaz=X&runId=R` | does one more chunk, then returns |
| `?action=health` | `{version, time}` |

`state` is one of `empty` · `fetching` · `locked` · `done` · `error`.

---

# Server audit — the real `Code.gs` (v2.0)

Audited against the script actually in production. Everything below is verified
by `npm run test:server`, which executes `server/Code.gs` in Node against an
Apps Script shim (`tests/gas-shim.js`) — the real file, not a paraphrase.

## The 6-minute limit was a red herring

With `AttendanceFetch` at ~1,059 rows, a full `getDataRange().getValues()` is
~16,000 cells and costs roughly 100–300 ms. Thirteen of those per secondary-wing
fetch is 2–4 seconds. A 15-school Markaz costs ~4 s of SIS calls plus ~15
`deleteRow` calls. **You are nowhere near 6 minutes**, and the O(n²) sentinel
scans are not the bottleneck today — they will become one as the sheet grows,
which the redesign removes anyway.

## The actual root cause

**`UrlFetchApp.fetchAll` is all-or-nothing, and `muteHttpExceptions` does not
cover network failures.** A DNS error, TLS reset or socket timeout still throws
and aborts every request in the batch. v2's catch block then wrote all ten
schools in that batch as empty error rows:

```js
} catch(e) {
    return schools.map(s => ({
      school: s, studentData: { error: "fetchAll failed: ..." }, ... }));
}
```

The row count still looked complete, so nothing flagged it, and a re-click
usually worked because the flaky request succeeded next time. Random, silent,
exactly ten schools at a time — which is precisely "sometimes I have to click
many times".

**Fixed** by `fetchWithRetry_`: try `fetchAll` for speed; if the batch call
itself throws, fall back to per-school requests so one bad connection costs one
school instead of ten; then retry whatever still failed, up to `MAX_ATTEMPTS`.
Verified — three schools that time out twice now recover fully, `failedCount`
ends at 0.

*Known cost:* when a batch aborts you pay for the partial `fetchAll` **and** the
per-school retry, so a failing batch can cost up to ~2× the URL Fetch calls.
Correctness over quota; on 20,000 calls/day at this scale that is affordable.

## Other defects fixed

| # | v2 behaviour | Fix |
|---|---|---|
| 1 | `total: dataRows.length` when done, so `fetched === total` always and a shortfall was unreportable | `total` is the DB school count; `missing[]` lists EMIS codes not returned |
| 2 | `deleteMarkazRows` ran *before* fetching — the Markaz had no data for the whole window, and a crash left nothing plus a sentinel stuck on `"fetching"` forever | Results are committed only when the run finishes; a crash leaves yesterday's data intact (verified) |
| 3 | `appendRows` used sheet-wide `getLastRow()` under a *per-Markaz* lock, so two people fetching different Markazes could compute the same row and overwrite each other | Commit holds the script lock across delete+write (verified: 8 + 6 rows from two Markazes, nothing lost) |
| 4 | One `sheet.deleteRow()` call per school | `deleteRowsBulk_` deletes contiguous ranges — verified as **1** call instead of 15 |
| 5 | `handleStatus` did a full-sheet read *plus* `SpreadsheetApp.flush()` on every poll. `flush()` pushes your own pending writes; it does not invalidate another execution's read, so it was pure overhead on the hot path | `status` is a pure `CacheService` read — verified **0** sheet reads across 25 polls |
| 6 | Sentinel row written into the data area and located by scanning; index could go stale under concurrency | No sentinel. Run state lives in cache |
| 7 | No `runId`, so a stale `done` from a previous run looked current | Every response echoes `runId`; another user's in-flight rows are withheld with a note |
| 8 | `getSchoolsByMarkaz` used hardcoded columns `row[2]`, `row[5..8]` and did not de-duplicate | Header names preferred with index fallback; de-duplicated by EMIS (verified) |
| 9 | No time budget — a large Markaz ran until the 6-minute kill | `WORK_BUDGET_MS` chunks; verified a 120-school Markaz completes across **12 executions**, committing once at the end |

## New / changed API

| Request | Notes |
|---|---|
| `?action=fetch&markaz=X&runId=R` | Starts or reuses a run; works one chunk and returns |
| `?action=fetchChunk&markaz=X&runId=R` | Continues a paused run. The dashboard calls this when progress stalls |
| `?action=status&markaz=X&runId=R` | O(1) cache read. Falls back to the sheet if the cache expired |
| `?action=fetchMonthly` / `statusMonthly` / `fetchChunkMonthly` | Same runner, same guarantees |
| `?action=health` | `{version, time}` |

Response adds `runId`, `missing[]`, `failedCount`, `hasMore`, `round`,
`startedAt`, `completedAt`, `version`. All v2 fields are unchanged, so the old
dashboard still works against this server.

---

## "Cross-Origin Request Blocked" in the browser console

A dashboard page on `sheerazautomate.github.io` is a *different origin* from
everything it reads, so every response must carry
`Access-Control-Allow-Origin`. When it does not, the browser refuses to hand the
bytes to JavaScript and the console shows `Cross-Origin Request Blocked` /
`blocked by CORS policy` — with no HTTP status, no body, and nothing the page
can inspect. It is the least informative error a browser produces, and it is
why it looked like a *secondary-wing* bug: the heavy Markazes are the ones that
hit it.

Three things can strip that header, all of them Google-side:

| Cause | What Google returns |
|---|---|
| The Apps Script execution fails — an uncaught exception, the 6-minute kill, a quota stop (`Service invoked too many times`, daily runtime) | an **HTML error page** with no CORS header |
| The web app is not deployed as *Who has access: Anyone* (`Anyone with Google account` redirects to a login page) | a redirect the fetch cannot follow |
| A very large response from a 100+ school secondary-wing Markaz | the payload, intermittently, without the header |

The last one is the wing-specific one: a primary Markaz is 10–20 schools and
answers in a few KB; a secondary Markaz is 100+ schools and the `status` payload
is an order of magnitude bigger.

### The evidence from the field

```
Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote
resource at https://script.google.com/macros/s/AKfy…/exec?action=fetch&markaz=…&runId=…
&round=1. (Reason: CORS header 'Access-Control-Allow-Origin' missing).
Status code: 200.
```

Three things in that line matter:

* the blocked URL is the **trigger** (`action=fetch`), not `status` — the longest
  call, and the one whose response is the whole Markaz;
* **`Status code: 200`** — Google answered, it just answered without the header;
* it happens on the **secondary wing** and not on the primary one, i.e. it tracks
  *response size*, not the deployment: a secondary Markaz is 100+ schools, a
  primary one 10–20. A deployment/access problem would break every wing equally.

### What the dashboard does now

**Two transports instead of one** (`index.html`, `gasFetch` / `gasJsonp` /
`gasGet`):

1. `fetch()` — the normal CORS request.
2. A `<script>` tag with `?callback=…` (**JSONP**). Script tags are *not subject
   to CORS at all*, so they read what `fetch()` is not allowed to. The server
   answers `cb({...});` with a JavaScript MIME type (a JSON MIME would be
   refused by the browser's ORB/CORB rules).

`gasGet()` tries fetch, and on a block retries the *same request* over JSONP; if
that answers, the run continues on that channel instead of paying for a blocked
request on every poll. Timeouts stay timeouts (the trigger's "server is still
working in the background" path is unchanged), and a `TypeError` from `fetch` is
no longer reported as a vague "Network error".

**Precise messaging.** A blocked call now reports the exact URL and the three
causes above in order, because "CORS" alone sends people to the wrong place —
usually the problem is a *failed run* (check Apps Script → Executions), not the
deployment settings.

**Small requests where rows are not needed.** The trigger only has to *start* a
run — the client reads `runId`/`error` from it and gets the rows from the
`status` polls — so it now sends `slim=1`, which makes the server omit the
`rows` array (counters, `state` and `missing[]` stay correct). The biggest,
longest call therefore transfers a few hundred bytes instead of the whole
Markaz. The `fetchChunk` nudge is slim too. A slim response carries
`rowsOmitted: true` so nothing has to guess.

**🔎 Connection check.** A button in the error panel probes each endpoint and
reports which channel works:

```
1. Apps Script via fetch (CORS):    OK — {"version":"3.0.0", …}
2. Apps Script via JSONP (no CORS): OK — {"version":"3.0.0", …}
3. School-list CSV:                 OK — 4,213 rows, 318,904 bytes
```

* both OK → an intermittent block, most likely the heavy secondary-wing calls
* fetch FAILED, JSONP OK → the dashboard is already working around it
* fetch OK, JSONP FAILED → the deployed server has no `?callback=` support yet
* both FAILED → deployment access / wrong URL / VPN or extension blocking
  `script.google.com` — the report names each one

When a call fails on both channels the dashboard makes one extra, tiny
**CORS-free health call** and uses the answer to split the two cases that need
different fixes: if the small call comes back, the deployment is reachable and
*that particular response* was the problem — the message then points at
Apps Script → Executions (a run that failed or was killed) instead of sending
you to the deployment settings.

### Server side

`server/Code.gs` now honours `?callback=` (also `?cb=`): the JSON payload is
wrapped as `cb({...});` and served as `application/javascript`. The callback
name is validated against a plain identifier/dotted-path pattern and is *never*
echoed raw, so `?callback=alert(1)//` is ignored. Without `callback` the
response is byte-for-byte what it was before — the old dashboard is unaffected.

> **Status 2026-09-25: the deployed build already supports it.** Probing
> `?action=health&callback=probe_cb_test` returns
> `probe_cb_test({"version":"3.0.0",…});`, so the CORS-free channel is live and
> the "re-deploy `Code.gs`" warning no longer applies. Note that the version
> string still reads `3.0.0` even though the JSONP wrapper is deployed — it is
> not a reliable indicator of which build is running.

Covered by tests: the client suite makes `fetch` throw a CORS `TypeError` on
every Apps Script call and asserts the run still completes over JSONP, that the
transport stays switched, that the trigger asks for a slim payload while
`status` keeps asking for rows, that a full block produces the CORS explanation
with the URL, that a server without `?callback=` produces the "re-deploy
Code.gs" message, and that a reachable deployment with a blocked response is
reported as such; the server suite asserts the JSONP wrapper, the MIME type,
the ignored hostile callback name and that `slim=1` drops the rows without
touching a single counter.

---

## Deployment notes

* Re-deploy as a **new version** — editing the script alone does not update the
  web app URL.
* `WORK_BUDGET_MS` is 90 s. On a consumer account the hard limit is 6 minutes,
  so there is a wide margin; raise it if you move to Workspace.
* `CacheService` holds run state for 6 hours. After that, `status` transparently
  falls back to the committed sheet and marks the reply `cached: false`.
* The client sends `runId`, `round` and `emis` parameters. This server honours
  `runId`; `emis` is ignored because the server now retries failed schools
  itself, which is cheaper than a client-driven resume.

## ⚠️ Verify before deploying

The client's completeness gate compares received EMIS codes against the
**published CSV** (`gid=2066596328`), while the server builds its school list
from `DB_SHEET_ID` → `Schools`, EMIS column. **If those two sources disagree,
the client will report schools as missing that the server never intended to
fetch.** Also note the server matches Markaz case-insensitively while the client
matches the CSV value exactly. Confirm both come from the same data.
