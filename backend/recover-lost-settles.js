#!/usr/bin/env node
/**
 * RECOVER LOST SETTLES — 2026-08-06.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WENT WRONG
 *
 * automation/daily-run.cjs settles by CLICKING a UI button and then infers success from the
 * open-position count going down:
 *
 *     await btn("Settle day").click();
 *     log(`  settled ${openCount - left}, ${left} still open`);
 *
 * Positions disappearing from the book looks IDENTICAL whether they settled correctly or were
 * silently dropped. Between 2026-08-03 and 2026-08-06 they were dropped: the log reported
 * "settled 88" on 08-06 while trade_log gained exactly ZERO rows. Four sessions of forward
 * evidence — the thing the whole project exists to accumulate — went in the bin, and every
 * diagnostic said GO because each one validates the SHAPE of what exists rather than asking
 * whether anything NEW arrived.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHY RECOVERY IS LEGITIMATE HERE, AND WHERE THE LINE IS
 *
 * This project's standing rule is: heal the plumbing, quarantine the data, NEVER heal the
 * conclusions. Reconstructing settles sounds like healing conclusions. It is not, for one
 * specific and checkable reason:
 *
 *   THE POSITIONS WERE RECORDED BEFORE THE OUTCOME. board_positions.backup-YYYY-MM-DD.json is
 *   written at the open, before the session trades. Symbol, direction, entry, stop, target,
 *   size and all 30+ observers are frozen in it. Settling those against real bars is replaying
 *   a decision that was already committed — not choosing a decision with hindsight.
 *
 * What would NOT be legitimate, and is not done here:
 *   - recovering a SUBSET chosen after seeing which ones won (all recoverable rows are written)
 *   - inventing an entry, a stop or a size that was not already in the backup
 *   - merging recovered rows silently into the evidence base
 *
 * Every row written carries `recovered: true` and `recoveredFrom`, so any analysis can include
 * or exclude them, and the registry records the decision.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE KNOWN-ANSWER GATE
 *
 * This file reimplements the settle rules that live in src/App.jsx. Two implementations of the
 * same rule are free to drift — the exact hazard flagged when marks-forward was refactored. So
 * before writing ANYTHING, it re-settles positions that DID settle correctly and compares its
 * own rMult against the recorded one. If the reproduction is not near-exact, it writes nothing
 * and exits non-zero. An unvalidated reconstruction is worse than a missing one, because a
 * missing row is visibly missing and a wrong row is not.
 *
 * Usage:
 *   node backend/recover-lost-settles.js            dry run — validate + report, write nothing
 *   node backend/recover-lost-settles.js --apply    write the recovered rows to trade_log
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const { fetchBars } = require("./lib/alpaca-bars");

const APPLY = process.argv.includes("--apply");
const LOG_PATH = D("trade_log.json");
const day = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
const arr = (x) => (Array.isArray(x) ? x : x.positions || x.open || []);

// ── settle rules, transcribed from src/App.jsx:13417-13470 ───────────────────────────────────
// MAX_LOSS_R is 0 in the app (the 0.5R cap is disabled), so the ladder is:
//   gap-aware stop  ->  target  ->  close of the last available bar
// Stop is checked BEFORE target: if one bar touches both, assuming the good one is how a
// backtest lies.
const MAX_LOSS_R = 0;

/**
 * HORIZON. The first version of this file scanned EVERY bar after entry and the known-answer
 * gate rejected it at 1.8% — recorded rMults were small partials like +0.35 while it produced
 * clean +2.00 targets and -1.00 stops. The reason: this is a DAY board. A position is settled
 * at the end of its session (and since R14, after ONE overnight session), so the scan window is
 * a single bar, not the whole future. Scanning forward until something is hit turns every trade
 * into an eventual winner or loser and destroys exactly the small-R distribution the ledger
 * actually has. The gate caught it; the horizon is now the thing being validated.
 */
function settle(p, bars, horizonBars = 1) {
  bars = bars.slice(0, horizonBars);
  const long = p.dir > 0;
  const sd = Math.max(Math.abs(p.stopDist), 1e-9);      // floored denominator (guards the ARB-class bug)
  let exit = null, reason = null, mfe = -Infinity, mae = -Infinity, barsHeld = 0;

  for (const b of bars) {
    barsHeld++;
    mfe = Math.max(mfe, (long ? b.h - p.entry : p.entry - b.l) / sd);
    mae = Math.max(mae, (long ? p.entry - b.l : b.h - p.entry) / sd);
    const hitStop = long ? b.l <= p.stop : b.h >= p.stop;
    const hitTgt = long ? b.h >= p.target : b.l <= p.target;
    // A stop is not a guarantee: a bar that OPENS through it fills at the open, not the stop.
    const gapped = b.o != null && (long ? b.o <= p.stop : b.o >= p.stop);
    const stopFill = gapped ? b.o : p.stop;
    if (hitStop) { exit = stopFill; reason = gapped ? "gap-stop" : "stop"; break; }
    if (hitTgt) { exit = p.target; reason = "target"; break; }
  }
  if (exit == null) {
    const last = bars[bars.length - 1];
    exit = last.c; reason = "close";
  }
  if (!isFinite(mfe)) mfe = 0;
  if (!isFinite(mae)) mae = 0;
  return { exit, reason, rMult: ((exit - p.entry) * p.dir) / sd, mfe, mae, barsHeld, stopDist: sd };
}

(async () => {
  const log = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
  const logIds = new Set(log.map(r => String(r.id)));

  // ── gather candidates from every pre-outcome backup ────────────────────────────────────────
  const backups = fs.readdirSync(D("")).filter(f => /^board_positions\.backup-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const cand = new Map();                                  // id -> { p, from }
  for (const f of backups) {
    const dateStr = f.match(/(\d{4}-\d{2}-\d{2})/)[1];
    for (const p of arr(JSON.parse(fs.readFileSync(D(f), "utf8")))) {
      if (!p.id || logIds.has(String(p.id))) continue;      // already in the ledger
      if (!cand.has(p.id)) cand.set(p.id, { p, from: f, snapshotDate: dateStr });
    }
  }

  // Only linear equities can be settled from the equity bar feed. Crypto/FX/Futures need their
  // own sources and Options need a chain; those are reported as NOT recovered rather than
  // guessed at. This is a real limitation and it BIASES the recovered set toward equities —
  // stated here so no downstream analysis can mistake the recovered rows for a random sample.
  const recoverable = [], skipped = { Options: 0, Crypto: 0, FX: 0, Futures: 0, other: 0, noStop: 0 };
  for (const [, v] of cand) {
    const p = v.p;
    if (p.cls !== "Equity") { skipped[p.cls] != null ? skipped[p.cls]++ : skipped.other++; continue; }
    if (!Number.isFinite(p.entry) || !Number.isFinite(p.stop) || !Number.isFinite(p.target) || !Number.isFinite(p.stopDist)) { skipped.noStop++; continue; }
    recoverable.push(v);
  }

  console.log(`RECOVER LOST SETTLES ${APPLY ? "(APPLY)" : "(dry run — writes nothing)"}`);
  console.log(`  backups scanned      : ${backups.length}`);
  console.log(`  positions not in log : ${cand.size}`);
  console.log(`  recoverable (Equity) : ${recoverable.length}`);
  console.log(`  NOT recoverable      : ${Object.entries(skipped).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  if (!recoverable.length) { console.log("\n  nothing to recover."); return; }

  // ── KNOWN-ANSWER GATE ─────────────────────────────────────────────────────────────────────
  // Re-settle equities that DID land in the ledger and check this file reproduces their rMult.
  const controlRows = log.filter(r => r.cls === "Equity" && Number.isFinite(r.rMult) && Number.isFinite(r.stopDist)
    && Number.isFinite(r.entry) && r.openedAt >= new Date("2026-07-20").getTime()).slice(-60);
  console.log(`\n  KNOWN-ANSWER GATE — reproducing ${controlRows.length} already-settled equity rows`);

  const gateSyms = [...new Set(controlRows.map(r => r.sym))];
  const gateStart = day(Math.min(...controlRows.map(r => r.openedAt)));
  const gateEnd = day(Date.now());
  const gateBars = await fetchBars(gateSyms, { start: gateStart, end: gateEnd, timeframe: "1Day", requireAll: false, quiet: true });

  // The horizon is not documented anywhere as a number, so it is DERIVED: try each candidate
  // and keep the one that reproduces the recorded ledger best. That is a fit, so it is only
  // legitimate because the thing being fitted is a mechanical setting of the existing system,
  // validated against ~60 known answers — not a parameter of any trading rule.
  // Two axes, because the cadence CHANGED mid-record. Before R14 (2026-08-03) a position was
  // settled at the close of its OWN session; after R14 it carries one night and settles at the
  // next session. So "which bars does the settle see" is `from`, and how many is `horizon`.
  let best = { horizon: null, from: null, rate: 0, matched: 0, checked: 0, diffs: [] };
  for (const from of ["entryDay", "afterEntry"])
  for (const horizon of [1, 2, 3, 5]) {
    let checked = 0, matched = 0; const diffs = [];
    for (const r of controlRows) {
      const ed = day(r.openedAt);
      const series = (gateBars.bars[r.sym] || []).filter(b => {
        const d = String(b.t).slice(0, 10);
        return from === "entryDay" ? d >= ed : d > ed;
      });
      if (!series.length) continue;
      const p = { dir: r.dir, entry: r.entry, stopDist: r.stopDist, stop: r.entry - r.dir * r.stopDist, target: r.entry + r.dir * r.stopDist * (r.rr ?? 2) };
      const got = settle(p, series, horizon);
      checked++;
      const d = Math.abs(got.rMult - r.rMult);
      if (d < 0.02) matched++; else diffs.push({ sym: r.sym, recorded: r.rMult, got: got.rMult, d });
    }
    const rate = checked ? matched / checked : 0;
    console.log(`    ${from.padEnd(10)} x ${horizon} bar(s): reproduced ${matched}/${checked} within 0.02R  (${(100 * rate).toFixed(1)}%)`);
    if (rate > best.rate) best = { horizon, from, rate, matched, checked, diffs };
  }
  const { horizon: HORIZON, from: FROM, rate, matched, checked, diffs } = best;
  console.log(`  best: ${FROM} x ${HORIZON} bar(s) at ${(100 * rate).toFixed(1)}%`);
  if (diffs.length) console.log(`  sample mismatches: ${diffs.slice(0, 5).map(x => `${x.sym} rec ${x.recorded.toFixed(2)} vs got ${x.got.toFixed(2)}`).join(" · ")}`);

  // The bar is deliberately high. These are the same rules on the same bars; anything much
  // below this means the reimplementation has drifted and its output cannot be trusted.
  if (checked < 20 || rate < 0.90) {
    console.error(`\n  GATE FAILED — refusing to write. Reproduction ${(100 * rate).toFixed(1)}% on ${checked} rows (need >=90% on >=20).`);
    console.error(`  An unvalidated reconstruction is worse than a missing row: a missing row is visibly missing.`);
    process.exit(1);
  }
  console.log(`  GATE PASSED.`);

  // ── recover ───────────────────────────────────────────────────────────────────────────────
  const syms = [...new Set(recoverable.map(v => v.p.sym))];
  const start = day(Math.min(...recoverable.map(v => v.p.addedAt)));
  const bars = await fetchBars(syms, { start, end: day(Date.now()), timeframe: "1Day", requireAll: false, quiet: true });
  console.log(`\n  bars: ${bars.returned.length}/${syms.length} symbols priced, ${bars.missing.length} unavailable`);

  const rows = [];
  let noBars = 0;
  for (const v of recoverable) {
    const p = v.p;
    const entryDay = day(p.addedAt);
    const series = (bars.bars[p.sym] || []).filter(b => {
      const d = String(b.t).slice(0, 10);
      return FROM === "entryDay" ? d >= entryDay : d > entryDay;
    });
    if (!series.length) { noBars++; continue; }             // nothing to settle against — leave it missing
    const s = settle(p, series, HORIZON);
    rows.push({
      id: p.id, sym: p.sym, cls: p.cls, dir: p.dir, sizeLabel: p.sizeLabel,
      entry: p.entry, exit: s.exit, stopDist: s.stopDist, rMult: s.rMult,
      pnl: null,                                            // dollars not reconstructed — sizeLabel is text, not a share count we can trust
      reason: s.reason, openedAt: p.addedAt,
      closedAt: new Date(`${String(series[Math.min(s.barsHeld, series.length) - 1].t).slice(0, 10)}T20:00:00Z`).getTime(),
      conf: p.conf, strategy: p.strategy, rr: p.rr, score: p.score,
      nBull: p.nBull, nBear: p.nBear, total: p.total, obs: p.obs,
      ctrl: !!p.ctrl, ctrlRand: !!p.ctrlRand, pairId: p.pairId, vetoShadow: !!p.vetoShadow,
      mfe: s.mfe, mae: s.mae, barsHeld: s.barsHeld,
      recovered: true, recoveredFrom: v.from, recoveredAt: new Date().toISOString(),
    });
  }

  const sig = rows.filter(r => !r.ctrl && !r.ctrlRand && !r.vetoShadow);
  const ctl = rows.filter(r => r.ctrl || r.ctrlRand);
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  console.log(`\n  RECOVERED ${rows.length} rows (${noBars} had no bars and stay missing)`);
  console.log(`    signals  ${String(sig.length).padStart(3)}  mean ${mean(sig.map(r => r.rMult))?.toFixed(4) ?? "—"}R`);
  console.log(`    controls ${String(ctl.length).padStart(3)}  mean ${mean(ctl.map(r => r.rMult))?.toFixed(4) ?? "—"}R`);
  const byDay = {};
  for (const r of rows) (byDay[day(r.openedAt)] ||= []).push(r);
  console.log(`    by session: ${Object.entries(byDay).sort().map(([d, g]) => `${d} ${g.length}`).join(" · ")}`);
  const byReason = {};
  for (const r of rows) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
  console.log(`    exits: ${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(", ")}`);

  // impact on the headline, stated before anything is written
  const CLEAN = new Date("2026-07-20").getTime();
  const before = log.filter(r => r.openedAt >= CLEAN && Number.isFinite(r.rMult) && !r.ctrl && !r.ctrlRand && !r.vetoShadow);
  const after = before.concat(sig);
  console.log(`\n  IMPACT on the clean-era signal ledger:`);
  console.log(`    before  n=${before.length}  mean ${mean(before.map(r => r.rMult)).toFixed(4)}R`);
  console.log(`    after   n=${after.length}  mean ${mean(after.map(r => r.rMult)).toFixed(4)}R`);

  if (!APPLY) {
    fs.writeFileSync(D("recovered-settles-preview.json"), JSON.stringify({ ranAt: new Date().toISOString(), gate: { checked, matched, rate }, rows }, null, 1));
    console.log(`\n  DRY RUN — wrote recovered-settles-preview.json. Re-run with --apply to commit to trade_log.`);
    return;
  }

  fs.writeFileSync(D(`trade_log.backup-before-recovery-${day(Date.now())}.json`), JSON.stringify(log));
  fs.writeFileSync(LOG_PATH, JSON.stringify(log.concat(rows)));
  console.log(`\n  APPLIED — trade_log ${log.length} -> ${log.length + rows.length} rows. Backup written first.`);
})();
