# PESRP Attendance Dashboard — bug findings and the new fetch strategy

Everything below was verified against `index.html` at commit `e8ba177` (the
pre-fix version) and re-verified against the rebuilt file by
`node tests/suite.js` (103 checks) and `node tests/prove-bugs.js`
(side-by-side old vs new).

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
npm test             # 103 checks against a mock Apps Script
npm run test:bugs    # old vs new, side by side
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
