"use strict";
/**
 * Compatibility suite: drives the rebuilt index.html against a mock that
 * reproduces the REAL Code.gs response shapes exactly — sentinel row,
 * `total = dataRows.length`, batch-wide fetchAll wipe, blocking `action=fetch`,
 * and the "Unknown action" reply to action=fetchChunk.
 *
 * This proves the client is correct against the server as it exists today,
 * without any server change.
 */
const { makeEnv, makeMaster, bootMaster, selectPath } = require('./harness');

const SEL = { district: 'Layyah', wing: 'Wing A', tehsil: 'Tehsil 1', markaz: 'Markaz M1' };

let pass = 0, fail = 0; const failures = [];
function ok(c, l) { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); } else { fail++; failures.push(l); console.log(`  \x1b[31m✗ ${l}\x1b[0m`); } }
function eq(a, b, l) { ok(a === b, `${l} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

function schools(n) {
  const o = [];
  for (let i = 1; i <= n; i++) o.push({ emis: 'E' + String(i).padStart(4, '0'),
    name: `Govt Primary School No ${i}`, level: 'Primary', gender: 'Male' });
  return o;
}

/**
 * Faithful mock of the real handleFetch / handleStatus pair, including the
 * sheet-as-state-machine and the sentinel row.
 */
function realServer(all, opts = {}) {
  const st = { rows: [], sentinel: null, fetchCalls: 0, wipedBatches: opts.wipeBatchAt || [] };

  // buildRow(): error rows carry "" in every numeric cell
  const buildRow = (s, bad) => bad
    ? { name: s.name, emis: s.emis, level: s.level, gender: s.gender,
        sPresent: null, sAbsent: null, sMarked: null,
        tPresent: null, tAbsent: null, tMarked: null,
        timestamp: '2026-09-25T09:00:00Z', status: 'error' }
    : { name: s.name, emis: s.emis, level: s.level, gender: s.gender,
        sPresent: 40, sAbsent: 5, sMarked: 45,
        tPresent: 3, tAbsent: 1, tMarked: 4,
        timestamp: '2026-09-25T09:00:00Z', status: 'ok' };

  return {
    st,
    handle(req) {
      // ── handleFetch: deletes, writes sentinel, batches, marks done ──
      if (req.action === 'fetch') {
        st.fetchCalls++;
        st.rows = [];                                   // deleteMarkazRows
        st.sentinel = { total: all.length, fetched: 0, state: 'fetching' };

        for (let i = 0; i < all.length; i += 10) {      // BATCH_SIZE = 10
          const batchNo = i / 10;
          // fetchAll throws => the WHOLE batch is written as error rows
          const wiped = st.wipedBatches.includes(batchNo);
          for (const s of all.slice(i, i + 10)) st.rows.push(buildRow(s, wiped));
          st.sentinel.fetched += Math.min(10, all.length - i);
        }
        st.sentinel.state = 'done';
        return { state: 'done', total: all.length };    // client never reads this
      }

      // ── action=fetchChunk does not exist on this server ──
      if (req.action === 'fetchChunk') {
        return { error: 'Unknown action. Use fetch|status|fetchMonthly|statusMonthly|verifyPassword|getConfig|saveConfig' };
      }

      // ── handleStatus ──
      if (req.action === 'status') {
        if (!st.sentinel && st.rows.length === 0) {
          return { state: 'empty', rows: [], fetched: 0, total: 0 };
        }
        const fs = st.sentinel ? st.sentinel.state : 'empty';
        return {
          state: fs || 'done',
          rows: st.rows,
          // THE KEY DETAIL: when done, total is the row count, not the school count
          fetched: fs === 'done' ? st.rows.length : st.sentinel.fetched,
          total:   fs === 'done' ? st.rows.length : st.sentinel.total,
          todayDate: '2026-09-25',
        };
      }
      return { error: 'Unknown action.' };
    },
  };
}

(async () => {
  console.log('\n' + '═'.repeat(68));
  console.log('SERVER-CONTRACT SUITE — rebuilt client vs the real Code.gs shape');
  console.log('═'.repeat(68));

  // ── 1. Happy path, 15 schools (2 batches) ───────────────────────────────
  section('1. Normal Markaz: 15 schools, no failures');
  {
    const all = schools(15);
    const srv = realServer(all);
    const env = makeEnv({ master: makeMaster(15), handler: r => srv.handle(r) });
    await bootMaster(env); await selectPath(env, SEL);
    await env.S.startFetch();
    eq(env.S.run.phase, 'done', 'completes');
    eq(env.S.run.store.size, 15, 'all 15 schools captured');
    eq(env.$('cSchools').textContent, '15', 'card reads 15');
    eq(env.$('cSPresent').textContent, (15 * 40).toLocaleString(), 'student present total correct');
    ok(env.$('completenessBar').className.includes('ok'), 'banner green');
    ok(/server did not echo the run id/i.test(env.$('completenessMsg').textContent),
       'warns that the server did not echo runId (matched by Markaz only)');
    env.window.close();
  }

  // ── 2. Secondary wing scale: 120 schools, 12 batches ────────────────────
  section('2. Secondary wing: 120 schools');
  {
    const all = schools(120);
    const srv = realServer(all);
    const env = makeEnv({ master: makeMaster(120), handler: r => srv.handle(r) });
    await bootMaster(env); await selectPath(env, SEL);
    await env.S.startFetch();
    eq(env.S.run.store.size, 120, 'all 120 schools captured');
    eq(env.S.run.phase, 'done', 'completes at secondary-wing scale');
    env.window.close();
  }

  // ── 3. One flaky school wipes its whole batch of 10 ─────────────────────
  section('3. fetchAll throws mid-run => 10 schools written as error rows');
  {
    const all = schools(25);
    const srv = realServer(all, { wipeBatchAt: [1] });   // schools 11-20 wiped
    const env = makeEnv({ master: makeMaster(25), handler: r => srv.handle(r) });
    await bootMaster(env); await selectPath(env, SEL);
    await env.S.startFetch();

    const rows = [...env.S.run.store.values()];
    const errored = rows.filter(r => r.state === 'error');
    eq(rows.length, 25, 'server still returned 25 rows (they exist, but empty)');
    eq(errored.length, 10, 'client identifies exactly the 10 wiped schools');
    eq(errored.every(r => r.present === null), true, 'wiped rows have null, not 0');
    eq(env.$('cSPresent').textContent, (15 * 40).toLocaleString(),
       'cards total only the 15 healthy schools, not the 10 empty ones');
    eq(env.$('studentsTbody').innerHTML.match(/status-error/g).length, 10,
       'exactly 10 rows render the Error pill');
    env.window.close();
  }

  // ── 4. Server reports fetched===total even when rows are missing ────────
  section('4. Server claims 100% but rows are actually missing');
  {
    // Simulates the crash path: handleStatus reports done with total=row count
    const all = schools(20);
    const partial = all.slice(0, 13);
    const env = makeEnv({
      master: makeMaster(20),
      handler: (req) => req.action === 'fetch' ? { state: 'done', total: 20 }
        : { state: 'done', rows: partial.map(s => ({
            name: s.name, emis: s.emis, level: s.level, gender: s.gender,
            sPresent: 40, sAbsent: 5, sMarked: 45, tPresent: 3, tAbsent: 1, tMarked: 4,
            timestamp: 't', status: 'ok' })),
            fetched: 13, total: 13, todayDate: '2026-09-25' },
    });
    await bootMaster(env); await selectPath(env, SEL);
    await env.S.startFetch();
    eq(env.S.run.phase, 'partial', 'client refuses the server\'s 13/13 and reports PARTIAL');
    eq(env.S.missingList(env.S.run).length, 7, 'identifies the 7 schools never returned');
    ok(env.$('completenessBar').className.includes('warn'), 'banner is amber, not green');
    ok(/13 \/ 20/.test(env.$('completenessMsg').textContent),
       `banner states the true coverage: "${env.$('completenessMsg').textContent.slice(0, 60)}"`);
    env.window.close();
  }

  // ── 5. Blocking trigger exceeds the client's 20s budget ─────────────────
  section('5. handleFetch blocks longer than the trigger budget');
  {
    const all = schools(12);
    let served = false;
    const env = makeEnv({
      master: makeMaster(12),
      handler: (req) => {
        if (req.action === 'fetch') return { __throw: 'timeout' };  // never returns in time
        if (!served) return { state: 'empty', rows: [], fetched: 0, total: 0 };
        return { state: 'done', rows: all.map(s => ({
          name: s.name, emis: s.emis, level: s.level, gender: s.gender,
          sPresent: 40, sAbsent: 5, sMarked: 45, tPresent: 3, tAbsent: 1, tMarked: 4,
          timestamp: 't', status: 'ok' })), fetched: 12, total: 12 };
      },
    });
    await bootMaster(env); await selectPath(env, SEL);
    const p = env.S.startFetch();
    await new Promise(r => setTimeout(r, 30));
    served = true;                       // server finishes while the client polls
    await p;
    eq(env.S.run.phase, 'done', 'trigger timeout treated as "still working", polling recovered the data');
    eq(env.S.run.store.size, 12, 'all 12 schools captured');
    env.window.close();
  }

  // ── 6. Crashed run leaves the sentinel stuck on "fetching" ──────────────
  section('6. Sentinel stuck on "fetching" (crashed execution)');
  {
    const all = schools(10);
    const env = makeEnv({
      master: makeMaster(10),
      handler: (req) => req.action === 'fetch' ? { state: 'done', total: 10 }
        : { state: 'fetching', rows: all.slice(0, 4).map(s => ({
            name: s.name, emis: s.emis, level: s.level, gender: s.gender,
            sPresent: 40, sAbsent: 5, sMarked: 45, tPresent: 3, tAbsent: 1, tMarked: 4,
            timestamp: 't', status: 'ok' })), fetched: 4, total: 10 },
    });
    env.S.CFG.runDeadlineMs = 500;
    env.S.CFG.maxRounds = 1;
    await bootMaster(env); await selectPath(env, SEL);
    await env.S.startFetch();
    eq(env.S.run.store.size, 4, 'the 4 rows that did arrive are kept');
    ok(env.S.run.phase === 'partial' || env.S.run.phase === 'error',
       `does not hang or claim success (phase: ${env.S.run.phase})`);
    ok(env.$('studentsTbody').querySelectorAll('tr').length === 10,
       'shows 4 received + 6 missing placeholders');
    env.window.close();
  }

  // ── 7. action=fetchChunk is unknown to this server ──────────────────────
  section('7. Stall poke against a server with no fetchChunk');
  {
    const all = schools(8);
    let polls = 0;
    let chunkErrors = 0;
    const env = makeEnv({
      master: makeMaster(8),
      handler: (req) => {
        if (req.action === 'fetch') return { state: 'done', total: 8 };
        if (req.action === 'fetchChunk') { chunkErrors++; return { error: 'Unknown action.' }; }
        polls++;
        if (polls < 8) return { state: 'fetching', rows: [], fetched: 0, total: 8 };
        return { state: 'done', rows: all.map(s => ({
          name: s.name, emis: s.emis, level: s.level, gender: s.gender,
          sPresent: 40, sAbsent: 5, sMarked: 45, tPresent: 3, tAbsent: 1, tMarked: 4,
          timestamp: 't', status: 'ok' })), fetched: 8, total: 8 };
      },
    });
    env.S.CFG.stallPolls = 2;
    await bootMaster(env); await selectPath(env, SEL);
    await env.S.startFetch();
    eq(env.S.run.phase, 'done', 'unknown fetchChunk does not derail the run');
    eq(env.consoleErrors.length, 0, 'and logs no console errors');
    env.window.close();
  }

  // ── 8. Lock contention ──────────────────────────────────────────────────
  section('8. Another user holds the Markaz lock');
  {
    const all = schools(6);
    let polls = 0;
    const env = makeEnv({
      master: makeMaster(6),
      handler: (req) => {
        if (req.action === 'fetch') return { state: 'locked', message: 'Fetch in progress by another request. Poll status.' };
        polls++;
        if (polls < 4) return { state: 'locked', rows: [], fetched: 0, total: 6 };
        return { state: 'done', rows: all.map(s => ({
          name: s.name, emis: s.emis, level: s.level, gender: s.gender,
          sPresent: 40, sAbsent: 5, sMarked: 45, tPresent: 3, tAbsent: 1, tMarked: 4,
          timestamp: 't', status: 'ok' })), fetched: 6, total: 6 };
      },
    });
    await bootMaster(env); await selectPath(env, SEL);
    await env.S.startFetch();
    eq(env.S.run.phase, 'done', 'waits out the other user and still completes');
    eq(env.S.run.store.size, 6, 'all 6 schools captured');
    env.window.close();
  }

  console.log('\n' + '═'.repeat(68));
  if (fail) { console.log(`\x1b[31m${fail} FAILED\x1b[0m, ${pass} passed`); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log(`\x1b[32mALL ${pass} CHECKS PASSED\x1b[0m`);
  process.exit(0);
})().catch(e => { console.error('\n\x1b[31mSUITE CRASHED\x1b[0m'); console.error(e); process.exit(2); });
