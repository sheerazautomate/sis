# Plan: serve attendance as static JSON from this repository

**Verdict: yes, this works — and it removes the CORS problem structurally rather than
working around it.** Not by retrying, not by JSONP, but by deleting the second origin
from the read path entirely.

Everything asserted below was checked on **2026-09-25** with a live call, a GitHub API
call, or a test in this repo. Unverified items are labelled **UNCHECKED**.

---

## 1. Why it works — the three facts it rests on

**a) The SIS endpoints need no credentials.** A plain GET with no cookie, no token and
no session returned real JSON:

```
GET https://sis.pesrp.edu.pk/attendance/get_today_attendance_stats
      ?district=&tehsil=&markaz=&school=&s_id_emis_code=00000000&ony_kpztp_districts=false

{"todayDate":"26 Sep","present_count":"0","absent_count":"0","unmarked_count":"10,470,662",
 "marked_count":"0","csrf_test_name":"6274a3ffe4fb5b5d54a3d6677cd8fa74"}
```

That is the exact URL shape `buildSISUrl()` in `server/Code.gs` already builds — the
server never attaches auth either, which is why it works today.

**b) CORS is a browser mechanism, not a network one.** A Node process in GitHub Actions
is not a browser. `Access-Control-Allow-Origin` is irrelevant to it, as is the redirect
chain `script.google.com → script.googleusercontent.com` that the browser has to follow.
The whole failure mode you have been fighting does not exist outside a browser.

**c) GitHub Pages serves this repo at the dashboard's own origin.** Verified via the API:
`html_url = https://sheerazautomate.github.io/sis/`, `source = main /`, and a live request
for `https://sheerazautomate.github.io/sis/package.json` returned this repo's `package.json`
byte for byte. So `data/anything.json` in this repo is served from
`https://sheerazautomate.github.io/sis/data/anything.json` — the **same origin** as the
page. A same-origin request cannot be "Cross-Origin Request Blocked". There is nothing to
negotiate.

---

## 2. Two claims in the existing docs that are now wrong

**`FINDINGS.md` says the deployed Apps Script has no `?callback=` support** ("the deployed
build today is `3.0.0`, i.e. the version before this change"). It does:

```
GET …/exec?action=health&callback=probe_cb_test
→ probe_cb_test({"version":"3.0.0","time":"2026-09-25T19:07:30.831Z"});
```

The JSONP fallback is live. So the third bullet in the Connection-check "Causes" list
("the deployed server does not support `?callback=`") is not a candidate cause any more.

**"Page origin: https://sheerazautomate.github.io" is not a different site.** That line
prints `location.origin`, which strips the path — the dashboard is at `/sis/`. There is no
root `sheerazautomate.github.io` repo (the API returns 404 for it). This matters, because
it is what makes fact (c) true: the JSON goes in *this* repo and is same-origin.

---

## 3. Architecture

```
        TODAY                                   PLAN
┌──────────────────────┐          ┌────────────────────────────────┐
│ browser              │          │ GitHub Actions (cron, UTC)     │
│  ├ CSV 3.4 MB        │          │  └ node tools/build-snapshot   │
│  └ Apps Script       │          │      └ GET sis.pesrp.edu.pk ×2 │
│    fetch + JSONP     │          │         per school             │
│    CORS risk ────────┼──┐       └──────────────┬─────────────────┘
└──────────────────────┘  │                      │ git commit data/*.json
                          ▼                      ▼
              ┌───────────────────────────────────────────────┐
              │ GitHub Pages  https://…github.io/sis/         │
              │   index.html  +  data/  ← SAME ORIGIN         │
              └───────────────────────────────────────────────┘
                                        ▲
                                        │ relative fetch, no CORS possible
                              ┌─────────┴──────────┐
                              │ browser            │
                              └────────────────────┘
```

Apps Script disappears from the read path. It can stay as an optional "Refresh this
Markaz now" button (Phase 4) — for a single Markaz it is seconds of work and the JSONP
fallback already handles it.

---

## 4. What actually changes

| File | Change |
|---|---|
| `tools/build-snapshot.mjs` | **New, written.** Fetches SIS, writes `data/`. |
| `deploy/sis-snapshot.yml` | **New, written.** Two-tier cron + manual dispatch, commits `data/`. Must be copied to `.github/workflows/` — see the warning below. |
| `config/hot-markaz.txt` | **New, written.** The Markazes the 30-minute tick refreshes. Ships empty. |
| `data/manifest.json` | Generated. The only file whose name the client must know. |
| `data/days/<YYYY-MM-DD>/<district>-<markaz>.json` | Generated. One file per Markaz per day. |
| `data/days/<YYYY-MM-DD>/summary.json` | Generated. Per-Markaz totals, tiny — this is the long-history layer. |
| `data/schools.json` | Generated. The master list as a compact column table — replaces the 3.4 MB cross-origin CSV. |
| `index.html` | **Done.** `loadSnapshot()` is now what the Fetch button does: same-origin read, and **every** failure path falls through to the live Apps Script fetch. New `⟳ Live` button forces the live path. `normalizeRow()`, the completeness gate, the tables, the cards and all six CSV exports are untouched. |
| `tests/harness.js` | **Done.** Optional `dataFiles` so tests can serve same-origin snapshot files. |

Row shape is deliberately identical to `buildDailyRow()` in `server/Code.gs`, so the
snapshot drops straight into the existing renderer.

**The fallback is what makes this safe to ship before any snapshot exists.** No
manifest, no entry for this Markaz, or an unreadable file → the dashboard does exactly
what it did before, over Apps Script. Test 9 asserts that.

---

## 5. Numbers (measured, not estimated)

Built 1,000 realistic rows through the real builder and measured:

| | |
|---|---|
| Bytes per row | **359.6** |
| Full master list, 38,134 schools (your verified row count) | **13.1 MB/day** raw |
| One Markaz file (100 schools) | **~36 KB** raw, ~2–4 KB gzipped |
| Today's school-list CSV on every page load | **3,439,164 bytes**, cross-origin, fetched `no-store` with a cache-buster so it is **never** cached (your Connection check) |
| Same list as `data/schools.json` | same size, but same-origin and cacheable — after the first load it costs a revalidation, not 3.4 MB |

So the *page* gets dramatically lighter — a 36 KB same-origin file replaces a 3.4 MB
cross-origin CSV plus an Apps Script round trip.

**Repo growth is the real constraint.** 13.1 MB/day × 365 = **4.8 GB**, well past GitHub's
1 GB recommended repo size. Hence:

* `data/days/` pruned to **7 days** of per-school files (`--keep-days`, default 7) → ~92 MB steady state.
* `summary.json` (a few hundred bytes per Markaz) can be kept for **90+ days** for trend views at negligible cost.
* The Google Sheet stays the permanent archive — Git is not the system of record.
* Escape hatch if growth still annoys: publish from an orphan `gh-pages` branch with a
  shallow history (Phase 5). Not needed at 7 days.

The 2.7% gzip ratio I measured is from synthetic rows and is optimistic; treat real-world
as 5–12%. It does not change any decision, because a page loads one Markaz file, not the
province.

---

## 6. What you give up

**Freshness.** Today a click fetches the Markaz live. With static JSON, data is as fresh
as the last run — so the schedule is two tiers, because a province-wide sweep takes
~1.5–2 h and cannot run every 30 minutes:

| Tier | When (PKT) | What it covers |
|---|---|---|
| **province** | 11:00 and 15:05 Mon–Fri | every Markaz in the school list |
| **hot** | every 30 min, 08:00–14:30 Mon–Fri | only the Markazes in `config/hot-markaz.txt` |

The hot list ships **empty**, so the 30-minute tick does nothing until you name the
Markazes you actually watch — no list, no extra load on SIS. And because the client falls
back to live, anything not in a snapshot is still reachable with `⟳ Live`.

PKT is UTC+5 with no DST, so the UTC cron entries stay correct year-round. Also note the
SIS day rolls over at **PKT midnight = 19:00 UTC**: at 19:07 UTC on 25 Sep the endpoint
already reported `todayDate: "26 Sep"`. Any "today" logic must be PKT-based.

**Volume politeness.** A full province sweep is 38,134 × 2 = **76,268 requests**. At
concurrency 4 with a 120 ms gap that is roughly 1.5–2 h of runtime — feasible inside the
6 h job limit, but it is a government server. Options, in order of politeness:
sweep one district at a time; sweep the Markazes people actually open (recorded from
Pages logs or a click log); or keep the full sweep to twice a day and use the live
Apps Script path for on-demand refresh.

**Nothing else.** No 6-minute execution limit, no `UrlFetchApp` quota, no `LockService`,
no JSONP, no HTML-error-page-without-CORS-header class of failure.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| SIS blocks or rate-limits a datacentre IP range | Concurrency 4 + 120 ms gap; on total failure the builder exits **3** and nothing is committed (verified). Fall back to Apps Script, which runs from Google's IPs. |
| SIS response shape changes | Builder rejects an unexpected shape and reports it; the test suite pins the live shape captured today, including the comma-grouped strings. |
| Cron skipped (GitHub load, or repo idle 60 days) | `workflow_dispatch` for manual runs; dashboard shows `generatedAt` so a stale snapshot is visible, not silent. |
| Run overlaps the next tick | `concurrency: sis-snapshot, cancel-in-progress: false`. |
| Commit race with a normal push | `git pull --rebase` + 3 retries in the workflow. |
| Repo bloat | `--keep-days` pruning; summary-only long history; orphan-branch escape hatch. |
| **UNCHECKED:** whether GitHub's runner IP range reaches `sis.pesrp.edu.pk` | My sandbox has no outbound network to that host (`SSL_ERROR_SYSCALL`), so I could not prove it. It answered a non-sandbox egress fine, and it answers Google's. First workflow run settles it in one step — `--dry-run --limit 20` is a 30-second check. |
| **UNCHECKED:** the true Markaz count | The published CSV returns HTTP 500 to my fetch tool (3.4 MB is beyond its limit). Your browser reads it fine — 38,134 rows. The workflow logs the real count on its first run. |
| Header names in the published CSV | **Closed by proof, not assumption.** Extracted every key `index.html` reads off a master-list row (`newRun` + `masterRowsFor`) and every key the builder's `normaliseSchool` accepts: the builder covers all 17, missing **none**, and it accepts 3 more. So whatever spelling the sheet uses, if the dashboard works today the builder reads the same list. All four EMIS spellings (`EMIS`/`emis`/`EMIS Code`/`EMISCode`) round-trip correctly. |

---

## 8. Already built, and how it was verified

`npm test` → **347 checks passed** (126 client + 94 server + 26 contract + 101 snapshot).

`npm run test:snapshot` runs the real builder against a mock SIS that returns the exact
payload captured live today, writes the files, and then loads **the shipped `index.html`**
in jsdom and drives it through a real button click:

*Builder:* comma-grouped counts parsed in full (`parseInt` gives 10, `toCount` gives
10470662); URL shape matches the live-verified one; 2 SIS calls per school, all to
`sis.pesrp.edu.pk`; one school timing out marks that row `error` and leaves the rest
intact; manifest/dated payload/summary totals correct; old day folders pruned.

*Client, through the real button:*
* click Fetch → `run.source === 'snapshot'`, phase `done`, 6/6 schools, table and cards
  correct, header date from the snapshot — and **`gasRequests.length === 0`**
* no manifest published → falls back to Apps Script automatically, phase `done`, and the
  bar does *not* claim a snapshot it did not use
* snapshot missing 3 schools → reported **PARTIAL**, the 3 gaps named, **no** auto-resume
  (a snapshot cannot be re-requested into completeness), and the live retry button offered
* clicking that retry makes a **live** run, asks Apps Script for exactly the 3 missing EMIS
  codes, keeps the 3 snapshot rows, and closes the gap to `done`
* zero console errors on every path

*Master list:* the published table keeps all rows while the fetch list de-duplicates —
a school listed under two Wings would lose a Wing from the dropdown if the two were
confused; with `data/schools.json` present the client builds its dropdowns from it and
never touches the CSV (a decoy district in the CSV proves it); and `runConnectionCheck`
names the source actually in use instead of always pointing at the sheet.

The pre-existing 126 client checks still pass with `index.html` changed — including
`tests/prove-bugs.js`'s button clicks, which now take the fallback path.

Also verified: the workflow YAML parses (`js-yaml`) with the three crons, the
province/hot/custom modes, `contents: write` and the concurrency group; all six
scope-resolution branches exercised in bash (empty hot list → `skip=true`; both province
crons → no filter; hot list → one `--markaz` per non-comment line; custom → district
passed through); and `node tools/build-snapshot.mjs --schools … --district LAYYAH
--limit 2 --dry-run` loads the list, applies the filter, and exits **3** when every school
fails so a broken snapshot is never committed.

**The commit step was executed, not just read** — extracted from the YAML and run in a
scratch repo against a real local `origin`. That found two bugs reading alone would not
have:

1. `git add data` exits **128** (`fatal: pathspec 'data' did not match any files`) when
   `data/` does not exist yet, and under `set -euo pipefail` that aborts the step instead
   of reporting "nothing to commit". Now guarded with `[ -d data ]`.
2. `git pull --rebase` **refuses to run with anything unstaged**, so all three push
   attempts failed and the snapshot was committed locally but never published — a silent
   loss. Now `--autostash`. Re-run confirms: commit contains `data/` only, the unrelated
   dirty file is left dirty, and `origin` head matches local head.

**Not verified, and I want to be explicit about it:** no real SIS request has been made
from this sandbox — it has no outbound route to `sis.pesrp.edu.pk` (`SSL_ERROR_SYSCALL`).
The URL shape is the one I confirmed live; the transport is first proven by the workflow's
first run. And `npm run test:bugs` cannot run here at all: this clone is shallow
(1 commit), so the baseline commit `e8ba177` it extracts from git does not exist. That is
pre-existing and unrelated to this change — it is not part of `npm test`.

---

## 9. Phases

1. **Done** — builder + workflow written, tested offline; client is snapshot-first with a
   live fallback.
2. **Install the workflow** — copy `deploy/sis-snapshot.yml` to
   `.github/workflows/sis-snapshot.yml` on `main`. This one step cannot be automated from
   here: pushing it was **rejected** with *"refusing to allow a GitHub App to create or
   update workflow `.github/workflows/sis-snapshot.yml` without `workflows` permission"*.
   A person can add it through the web UI in about a minute. Until it exists nothing is
   scheduled, and the dashboard keeps using the live Apps Script path automatically.
3. **First real run** — `workflow_dispatch` with `mode: custom`, `district: LAYYAH`,
   `dry_run: true`. That single run proves runner→SIS reachability and prints the true
   school/Markaz counts. Then repeat without `dry_run` and load
   `https://sheerazautomate.github.io/sis/`.
4. **Fill in `config/hot-markaz.txt`** with the Markazes you watch, so the 30-minute tick
   does something. Leave it empty and only the twice-daily province sweep runs.
5. **Watch the first week** — runtime per sweep, repo growth, and how often the dashboard
   falls back to live (the run log records every fallback).
6. **Optional** — split `data/schools.json` per district so a page load pulls ~160 KB
   instead of the full list (it is cacheable now, so this is a first-load optimisation
   only); orphan `gh-pages` branch if history growth ever matters; monthly snapshots via
   the builder's `--month`.

---

## 10. Bonus finding: a latent bug in `server/Code.gs`

SIS returns counts as **comma-grouped strings** — `"10,470,662"`. `buildDailyRow()`'s
helper is `parseInt(v, 10)`, and `parseInt("10,470,662")` is **10**. The test suite pins
this (`baseline: bare parseInt truncates at the comma`). It has not bitten only because
per-school counts are small; the province-level figures are not. The new builder strips
grouping first (`toCount`), and `index.html`'s `num()` already did.
