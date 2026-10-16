#!/usr/bin/env node
"use strict";
/**
 * OPTIONS PREMIUM LANE — BASELINE (read-only). R25-0dte and R21-premium on exactly the dashboard's population:
 * lib/reconcile.js cleanEraLedger() signals, controls out, entered inside 09:25-16:00 ET. Sessions = ET entry date.
 * Prints win rate, average win/loss, break-even win rate, $ per session, session-clustered t of the daily $ sum, worst day,
 * and what the board record already charges as friction (entry crossing + $0.65 x 2 legs).
 *   node backend/profit-program/options-lane-baseline.js [--since 2026-09-25]
 * Writes backend/data/profit-program/options-lane-baseline.json
 */
const C = require("./_opt-common.js");
const { $, u$, f } = C;
const SINCE = C.arg("--since", "2026-09-25");
const L = C.ledger();
const pop = (fn, since, until = "9999") => L.signals.filter((t) => fn(t) && !t.ctrl && C.inHours(t) && C.mtDay(t.closedAt) >= since && C.mtDay(t.closedAt) <= until);
const out = { generatedFrom: "lib/reconcile.js cleanEraLedger()", since: SINCE, windows: {} };

function block(label, T) {
  const a = C.anatomy(T), s = C.bySession(T, (t) => t.pnl);
  const contracts = [...new Set(T.map((t) => t.contracts || 1))].join("/");
  const crossing$ = C.sum(T.map((t) => Math.max(0, (t.obs.creditMid - t.obs.creditCross)) * 100 * (t.contracts || 1)));
  const fee$ = C.sum(T.map((t) => 1.3 * (t.contracts || 1)));
  const credit$ = C.sum(T.map((t) => t.entry * 100 * (t.contracts || 1)));
  console.log(`${label.padEnd(30)} n ${String(a.n).padStart(4)}  win ${f(a.winPct, 1).padStart(5)}%  avgWin ${u$(a.avgWin).padStart(5)}  avgLoss -${u$(a.avgLoss).padStart(4)}  loss/win ${f(a.lossToWin)}x  breakeven ${f(a.breakEvenWinPct, 1)}%  net ${$(a.net).padStart(7)}`);
  console.log(`${"".padEnd(30)} sessions ${s.n}  $/session ${$(s.meanPerSession)}  t(session-clustered) ${f(s.t)}  worst day ${$(s.worstDay)}  best day ${$(s.bestDay)}  green days ${s.posDays}/${s.n}  contracts ${contracts}`);
  console.log(`${"".padEnd(30)} credit collected ${u$(credit$)}  of which paid away crossing ${u$(crossing$)} (already in the credit)  commissions ${u$(fee$)} (already in pnl)  -> net/credit ${f(100 * a.net / credit$, 1)}%`);
  return { label, anatomy: a, sessions: { n: s.n, meanPerSession: s.meanPerSession, t: s.t, worst: s.worstDay, best: s.bestDay, posDays: s.posDays }, contracts, crossing$, fee$, credit$ };
}
console.log(`OPTIONS PREMIUM LANE BASELINE — ledger ${L.source}, dashboard population (in-hours signals), closed (MT) since the date shown\n`);
for (const [w, since] of [["since " + SINCE, SINCE], ["since 2026-07-20 (clean epoch)", "2026-07-20"]]) {
  console.log(`== ${w}`);
  out.windows[w] = {
    R25: block("R25-0dte (all sizes)", pop(C.isR25, since)),
    R21: block("R21-premium", pop(C.isR21, since)),
    BOTH: block("R25 + R21", pop((t) => C.isR25(t) || C.isR21(t), since)),
  };
  console.log();
}
// R25 at today's size (4 contracts since 2026-09-14): the $/month anchor for every lever
const r25now = pop(C.isR25, "2026-09-14").filter((t) => (t.contracts || 1) === 4);
out.r25AtFourContracts = block("R25 at 4 contracts (09-14+)", r25now);
const sess = C.bySession(r25now, (t) => t.pnl);
console.log(`\nMONTH ANCHOR: R25 at 4 contracts ${sess.n} sessions, ${$(C.sum(r25now.map((t) => t.pnl)))} -> ${$(sess.meanPerSession)}/session x 21 sessions = ${$(sess.meanPerSession * 21)}/month (t ${f(sess.t)}; one regime, no shock day: not an edge estimate)`);
out.r25MonthAnchor = { sessions: sess.n, perSession: sess.meanPerSession, perMonth21: sess.meanPerSession * 21, t: sess.t };
// R21 sessions anchor (entry-session; the sleeve now routes new wings to shadows under OP11)
const r21 = pop(C.isR21, "2026-09-14");
const s21 = C.bySession(r21, (t) => t.pnl);
console.log(`R21 live wings since 09-14 (entry session): ${r21.length} tickets, ${s21.n} sessions, ${$(C.sum(r21.map((t) => t.pnl)))}, ${$(s21.meanPerSession)}/session, t ${f(s21.t)}`);
out.r21Since0914 = { n: r21.length, sessions: s21.n, net: C.sum(r21.map((t) => t.pnl)), perSession: s21.meanPerSession, t: s21.t };
// the full-loss tickets
const full = L.signals.filter((t) => C.isR25(t) && C.inHours(t) && C.mtDay(t.closedAt) >= SINCE && t.rMult <= -0.9);
console.log(`\nR25 full-loss tickets (rMult <= -0.90) since ${SINCE}: ${full.length}, total ${$(C.sum(full.map((t) => t.pnl)))}, mean ${$(C.mean(full.map((t) => t.pnl)))}`);
out.fullLoss = { n: full.length, total: C.sum(full.map((t) => t.pnl)), mean: C.mean(full.map((t) => t.pnl)) };
const f21 = L.signals.filter((t) => C.isR21(t) && C.inHours(t) && C.mtDay(t.closedAt) >= SINCE && t.rMult <= -0.9);
console.log(`R21 full-loss tickets (rMult <= -0.90) since ${SINCE}: ${f21.length}, total ${$(C.sum(f21.map((t) => t.pnl)))}, mean ${$(C.mean(f21.map((t) => t.pnl)))}`);
out.fullLoss21 = { n: f21.length, total: C.sum(f21.map((t) => t.pnl)), mean: C.mean(f21.map((t) => t.pnl)) };
// the arithmetic behind "a 75% win rate should be way profitable": at the 4-contract era's own average win and average loss, the win rate a monthly target needs
{
  const a = out.r25AtFourContracts.anatomy, wps = r25now.length / sess.n;
  console.log(`\nWIN RATE NEEDED (R25, 4-contract era: avg win ${u$(a.avgWin)}, avg loss -${u$(a.avgLoss)}, ${wps.toFixed(2)} wings a session, 21 sessions a month; observed win rate ${f(a.winPct, 1)}%, break-even ${f(a.breakEvenWinPct, 1)}%)`);
  out.winRateNeeded = [];
  for (const target of [0, 1000, 3000, 5000]) {
    const ev = target / 21 / wps, w = (ev - a.avgLoss) / (a.avgWin - a.avgLoss);
    console.log(`  ${target === 0 ? "break even" : $(target) + " a month"}: expected ${$(ev)} a wing -> win rate ${f(100 * w, 1)}%`);
    out.winRateNeeded.push({ target, winRatePct: 100 * w });
  }
}
console.log("\nwrote " + C.writeOut("options-lane-baseline.json", out));
