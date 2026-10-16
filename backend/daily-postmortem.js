#!/usr/bin/env node
/**
 * TRAIDS — DAILY POST-MORTEM: what actually happened today, and is any of it real?
 *
 * WHY THIS EXISTS. On 2026-07-28 the board lost $3,202 and the operator asked whether the system
 * was getting dumber. Answering took six separate hand-written queries: decompose the loss, split
 * by class and direction, check concentration, test the stop floor, check what #7 permitted, then
 * test whether the apparent culprit survived a clustered t. The answer — three trades, one gap
 * through a stop, no real cohort — was obtainable in seconds and took twenty minutes.
 *
 * This runs that entire diagnosis automatically after every close.
 *
 * ── THE DISCIPLINE THAT MATTERS MORE THAN THE DIAGNOSIS ────────────────────────────────────
 * A post-mortem that names a culprit every day is worse than useless — it manufactures a story
 * for what is usually noise, and this project has now twice been on the edge of wiring a rule
 * off a single session (#7 on 2026-07-27, crypto shorts on 2026-07-28). Both would have been
 * mistakes; the second was caught only because the first had just been walked back.
 *
 * So every cohort is tested at a DAY-CLUSTERED t and reported as ACTIONABLE only if it clears
 * |t| >= 2.5 across at least 4 sessions. A cohort that lost money today and does not clear that
 * bar is printed as NOISE, explicitly, with the number that makes it noise. The report is built
 * to say "nothing to do here" on most days, because on most days there is nothing to do.
 *
 * WHAT IT CHECKS
 *   1. CONCENTRATION — how few trades account for 80% of the day's P&L. A day driven by three
 *      names is an outlier story, not a strategy story.
 *   2. GAP-THROUGH-STOPS — any trade whose loss exceeded 1.0R. The stop is supposed to cap at
 *      1.0R; anything past that is gap risk, which sizing controls and stops do not.
 *   3. COHORT SCAN — class x direction, each with a day-clustered t over the clean epoch.
 *   4. THE GATES — what the options-debit gate and the #7 regime filter actually did, and what
 *      the trades they touched went on to do. A gate that blocks winners must be visible.
 *   5. TREND — the equity curve and whether today is inside its own noise band.
 *
 * ONE ROW PER TICKET (2026-10-16). This report reads data/trade_log.json directly — deliberately, it is
 * the day's realized cash and it must see rows the clean-era filters drop. Direct is not the same as
 * per-row: six R21 wings whose loss-cap close was voided and whose expiry settled under the SAME ticket id
 * have two rows each, so this report counted each wing twice — in the epoch cohort scan, in the equity
 * curve and in the sd that decides whether today is unusual. It now collapses to one row per ticket first
 * (lib/ticket-rows.js) and says on its own first line what that collapsed. No-op on a clean ledger.
 *
 * Usage:  node backend/daily-postmortem.js [YYYY-MM-DD]
 */
const fs = require("fs"), path = require("path");
const { collapseByTicket, collapseLine } = require("./lib/ticket-rows.js");
const D = (f) => path.join(__dirname, "data", f);
const CLEAN = new Date("2026-07-20T00:00:00-06:00").getTime();
const T_BAR = 2.5, MIN_SESSIONS = 4;
// SESSION KEY fixed 2026-09-04: was America/Denver; every test uses ET. Day-clustered stats key on OPEN; the target-day settle list stays on CLOSE (realized cash) and is labelled. See lib/session.js.
const day = require("./lib/session.js").sessionOf;
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const usd = (v) => (v < 0 ? "-" : "") + "$" + Math.abs(Math.round(v)).toLocaleString();
const R = (v) => (v >= 0 ? "+" : "") + v.toFixed(4);

/** day-clustered t: sessions are the unit, because names share a day's market move */
function clusteredT(rows) {
  const ds = [...new Set(rows.map(t => day(t.openedAt)))];   // clustered stat: OPEN session
  if (ds.length < 3) return { t: null, sessions: ds.length };
  const per = ds.map(d => mean(rows.filter(t => day(t.openedAt) === d).map(t => t.rMult)));
  const m = mean(per), s = sd(per);
  return { t: s ? m / (s / Math.sqrt(per.length)) : null, sessions: ds.length };
}

(async () => {
  const rowsInFile = (() => { try { return JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8")); } catch { return []; } })();
  const collapse = collapseByTicket(rowsInFile);   // one row per ticket id — a wing closed twice is one wing
  const log = collapse.rows;
  const clean = log.filter(t => t && t.closedAt >= CLEAN && Number.isFinite(t.rMult) && Math.abs(t.rMult) < 10);
  const sig = clean.filter(t => !t.ctrl);
  const sessions = [...new Set(sig.map(t => day(t.closedAt)))].sort();
  const target = process.argv[2] || sessions[sessions.length - 1];
  const td = sig.filter(t => day(t.closedAt) === target);
  const ctrlTd = clean.filter(t => t.ctrl && day(t.closedAt) === target);

  console.log(`\n  TRAIDS — DAILY POST-MORTEM · ${target}`);
  console.log(`  ledger: ${rowsInFile.length} rows · ${collapseLine(collapse)}`);
  if (!td.length) { console.log(`  no settles recorded for ${target}.\n`); return; }
  const pnl = td.reduce((s, t) => s + (t.pnl || 0), 0);
  console.log(`  ${td.length} settles · win ${(100 * td.filter(t => t.rMult > 0).length / td.length).toFixed(0)}% · avgR ${R(mean(td.map(t => t.rMult)))} · ${usd(pnl)}\n`);

  // ── 1. concentration ──────────────────────────────────────────────────────
  const sorted = td.slice().sort((a, b) => (a.pnl || 0) - (b.pnl || 0));
  let run = 0, k = 0;
  for (const t of sorted) { run += (t.pnl || 0); k++; if (pnl < 0 ? run <= pnl * 0.8 : run >= pnl * 0.8) break; }
  console.log(`  1. CONCENTRATION`);
  console.log(`     ${k} of ${td.length} trades account for 80% of the day (${(100 * k / td.length).toFixed(0)}% of the book)`);
  console.log(`     ${sorted.slice(0, 4).map(t => `${t.sym} ${usd(t.pnl)}`).join(" · ")}`);
  console.log(`     -> ${k <= 3 ? "an OUTLIER story, not a strategy story. Do not generalise from it." : "broadly distributed — the day reflects the book, not a few names."}`);

  // ── 2. gap-through-stops ──────────────────────────────────────────────────
  const gapped = td.filter(t => t.rMult < -1.0);
  console.log(`\n  2. GAP-THROUGH-STOPS  (a stop should cap the loss at -1.0R)`);
  if (!gapped.length) console.log(`     none — every loss stayed inside its stop.`);
  else {
    for (const t of gapped) console.log(`     ${String(t.sym).padEnd(12)} ${t.rMult.toFixed(3)}R  ${usd(t.pnl)}  (${(100 * (Math.abs(t.rMult) - 1)).toFixed(0)}% past the stop)`);
    console.log(`     -> gap risk is not controlled by stops. Only SIZING controls it.`);
  }

  // ── 3. cohort scan, with the bar that prevents story-telling ──────────────
  console.log(`\n  3. COHORT SCAN  (class x direction, day-clustered over the clean epoch)`);
  console.log(`     cohort            today          epoch n   epoch avgR   clust t   verdict`);
  const keyOf = (t) => `${t.cls || "?"} ${t.dir > 0 ? "LONG" : "SHORT"}`;
  const keys = [...new Set(sig.map(keyOf))];
  const actionable = [];
  for (const kk of keys) {
    const epoch = sig.filter(t => keyOf(t) === kk);
    const today = td.filter(t => keyOf(t) === kk);
    const { t, sessions: ns } = clusteredT(epoch);
    const isAct = t != null && Math.abs(t) >= T_BAR && ns >= MIN_SESSIONS;
    if (isAct) actionable.push({ kk, t, avgR: mean(epoch.map(x => x.rMult)) });
    const verdict = isAct ? (mean(epoch.map(x => x.rMult)) < 0 ? "ACTIONABLE — persistent loser" : "ACTIONABLE — persistent winner")
      : `noise (needs |t|>=${T_BAR} over >=${MIN_SESSIONS} sessions)`;
    console.log(`     ${kk.padEnd(16)} ${today.length ? (usd(today.reduce((s, x) => s + (x.pnl || 0), 0))).padStart(8) : "       —"}      ${String(epoch.length).padStart(4)}   ${R(mean(epoch.map(x => x.rMult))).padStart(9)}   ${(t == null ? "—" : t.toFixed(2)).padStart(7)}   ${verdict}`);
  }
  console.log(`\n     -> ${actionable.length ? `${actionable.length} actionable cohort(s): ${actionable.map(a => a.kk).join(", ")}` : "NOTHING ACTIONABLE. Today's worst cohort is inside its own noise band — do not gate it."}`);

  // ── 4. what the gates did ─────────────────────────────────────────────────
  console.log(`\n  4. THE GATES`);
  const eqL = td.filter(t => t.cls === "Equity" && t.dir > 0), eqS = td.filter(t => t.cls === "Equity" && t.dir < 0);
  console.log(`     #41 options-debit gate : ${td.filter(t => t.cls === "Options").length} options settle(s) today (legacy positions; the gate blocks NEW ones)`);
  console.log(`     #7  regime filter      : equity LONG ${eqL.length} @ ${R(mean(eqL.map(t => t.rMult)))}  ·  equity SHORT ${eqS.length} @ ${R(mean(eqS.map(t => t.rMult)))}`);
  if (eqL.length && eqS.length) {
    const better = mean(eqL.map(t => t.rMult)) > mean(eqS.map(t => t.rMult)) ? "LONGS" : "SHORTS";
    console.log(`     -> ${better} did better today. #7 blocks whichever side opposes the SPY-50MA regime,`);
    console.log(`        so if it is blocking the better side repeatedly, that shows up here before the checkpoint does.`);
  }
  if (ctrlTd.length) console.log(`     controls (UNGATED)     : n=${ctrlTd.length} avgR ${R(mean(ctrlTd.map(t => t.rMult)))} — the book must beat THIS, not zero`);

  // ── 5. is today inside its own noise band? ────────────────────────────────
  const daily = sessions.map(d => sig.filter(t => day(t.closedAt) === d).reduce((s, t) => s + (t.pnl || 0), 0));
  const m = mean(daily), s = sd(daily);
  const todayPnl = pnl;
  console.log(`\n  5. IS TODAY UNUSUAL?`);
  console.log(`     ${sessions.length} sessions · mean ${usd(m)}/day · sd ${usd(s || 0)}`);
  console.log(`     today ${usd(todayPnl)} = ${s ? ((todayPnl - m) / s).toFixed(2) : "—"} standard deviations from the mean`);
  console.log(`     -> ${s && Math.abs((todayPnl - m) / s) > 2 ? "OUTSIDE 2 sd — a genuinely unusual session, which is exactly when the urge to change something is strongest and most wrong." : "inside the normal band. Nothing here justifies a change."}`);
  let cum = 0; const curve = daily.map(v => (cum += v));
  console.log(`     equity curve: ${curve.map(v => usd(v)).join(" -> ")}`);
  console.log("");
})();
