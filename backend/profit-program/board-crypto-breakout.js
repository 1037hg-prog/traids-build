#!/usr/bin/env node
"use strict";
/**
 * CRYPTO BREAKOUT — what made the August week, how many independent events it was, and whether today's rules could repeat it
 * (profit program lever 6). READ-ONLY printer. EXPLORATORY / IN-SAMPLE. Population: lib/reconcile.js cleanEraLedger() signals.
 * Independent events are counted three ways (tickets are NOT the sample size): MT close days, entry episodes (same class+direction, entries
 * within 10 minutes, exits within 60 minutes), and the share of the class P&L in the best sessions.
 * Today's-rules counterfactual: lib/enforcement-gates.js groupTokens (R53: one live ticket per factor group per rolling 24 h) applied to each
 * Breakout-crypto entry batch, sized at today's crypto 1R (median of the regime window), same R multiple.
 *   node backend/profit-program/board-crypto-breakout.js
 */
const C = require("./_common.js");
const EG = require("../lib/enforcement-gates.js");
const REC = require("../lib/reconcile.js");
const { $, f, pad, lpad, mean, sum } = C;
const B = C.laneBoard();
const cryptoAll = B.sig.filter((t) => t.cls === "Crypto");
const bo = cryptoAll.filter((t) => t.strategy === "Breakout");
const todayRisk = C.median(cryptoAll.filter((t) => t._day >= C.REGIME_START).map((t) => t._risk).filter(Number.isFinite));
const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
console.log(`CRYPTO BREAKOUT (lever 6) source ${B.source}; Breakout-crypto signals ${bo.length}, all-crypto signals ${cryptoAll.length}; today's crypto 1R = $${todayRisk.toFixed(0)} (median, closed >= ${C.REGIME_START}); Breakout-crypto 1R in the sample = $${C.median(bo.map((t) => t._risk)).toFixed(0)}`);

console.log(`\n[1] EVERY Breakout-crypto ticket (open UTC, close UTC, dir, reason, R, pnl)`);
for (const t of [...bo].sort((a, b) => a.openedAt - b.openedAt)) console.log(`   ${iso(t.openedAt)} -> ${iso(t.closedAt)}  ${t.dir > 0 ? "L" : "S"}  ${lpad(t.sym, 9)} ${lpad(t.reason, 8)} ${pad(f(t.rMult, 2), 6)}R ${pad($(t.pnl), 7)}  1R $${t._risk.toFixed(0)}  close day ${t._day}`);

console.log(`\n[2] HOW MANY INDEPENDENT EVENTS`);
const sorted = [...bo].sort((a, b) => a.openedAt - b.openedAt), eps = [];
for (const t of sorted) { const e = eps.find((x) => x.dir === t.dir && Math.abs(x.open - t.openedAt) <= 10 * 60e3 && Math.abs(x.close - t.closedAt) <= 60 * 60e3); if (e) e.rows.push(t); else eps.push({ dir: t.dir, open: t.openedAt, close: t.closedAt, rows: [t] }); }
console.log(`   tickets ${bo.length}; MT close days ${new Set(bo.map((t) => t._day)).size}; entry episodes ${eps.length}; reconcile.episodes() (exact-ms key) ${REC.episodes(bo).length}`);
for (const e of eps) console.log(`   episode opened ${iso(e.open)} ${e.dir > 0 ? "long" : "short"}: ${e.rows.length} tickets, mean R ${f(mean(e.rows.map((t) => t.rMult)), 2)}, pnl ${$(sum(e.rows.map((t) => t.pnl)))}, ${e.rows.filter((t) => t.reason === "target").length} hit the 2R target`);
const epPnl = eps.map((e) => sum(e.rows.map((t) => t.pnl))).sort((a, b) => b - a);
console.log(`   best episode = ${$(epPnl[0])} = ${(epPnl[0] / sum(epPnl) * 100).toFixed(0)}% of the Breakout-crypto total ${$(sum(epPnl))}; without it the other ${eps.length - 1} episodes net ${$(sum(epPnl) - epPnl[0])} (${bo.length - eps.find((e) => sum(e.rows.map((t) => t.pnl)) === epPnl[0]).rows.length} tickets)`);

console.log(`\n[3] THE CRYPTO CLASS BY SESSION (all strategies, signals; clean era) — is the class result one week?`);
const bs = {}; for (const t of cryptoAll) bs[t._day] = (bs[t._day] || 0) + t.pnl;
const days = Object.entries(bs).sort((a, b) => b[1] - a[1]);
console.log(`   crypto signals ${cryptoAll.length}, net ${$(sum(cryptoAll.map((t) => t.pnl)))} over ${days.length} close days. Best 3 days: ${days.slice(0, 3).map(([d, v]) => d + " " + $(v)).join(", ")}. Worst 3 days: ${days.slice(-3).map(([d, v]) => d + " " + $(v)).join(", ")}`);
const exclude = new Set(days.slice(0, 2).map((d) => d[0]));
console.log(`   excluding the 2 best days: ${$(sum(days.filter(([d]) => !exclude.has(d)).map((d) => d[1])))} over ${days.length - 2} days; excluding the best 2 AND worst 2 days: ${$(sum(days.slice(2, -2).map((d) => d[1])))}`);
const w0 = cryptoAll.filter((t) => t._day < C.REGIME_START), w1 = cryptoAll.filter((t) => t._day >= C.REGIME_START);
console.log(`   before ${C.REGIME_START} (1R about $1,000): ${w0.length} tickets ${$(sum(w0.map((t) => t.pnl)))}; from ${C.REGIME_START} (1R about $${todayRisk.toFixed(0)}): ${w1.length} tickets ${$(sum(w1.map((t) => t.pnl)))}`);
const tape = C.tapeByClassDay(B.sig, B.ctl);
for (const d of ["2026-08-20", "2026-08-21", "2026-08-24"]) { const x = tape.get("Crypto|" + d); if (x) console.log(`   crypto tape ${d}: equal-weight mean move of ${x.n} crypto tickets (signals+controls) closing that day = ${(x.b * 100).toFixed(2)}%`); }

console.log(`\n[4] COULD TODAY'S RULES REPEAT THE AUGUST WEEK? (R53 one live ticket per factor group per 24 h; crypto 1R = $${todayRisk.toFixed(0)}; same R multiples)`);
let totActual = 0, totToday = 0;
for (const e of eps.filter((x) => x.rows.length > 1)) {
  const seen = new Set(), kept = [];
  for (const t of [...e.rows].sort((a, b) => a.openedAt - b.openedAt)) { const g = EG.groupTokens(t); if (!g.length) { kept.push(t); continue; } if (g.some((x) => seen.has(x))) continue; g.forEach((x) => seen.add(x)); kept.push(t); }
  const actual = sum(e.rows.map((t) => t.pnl)), today = sum(kept.map((t) => t.rMult * todayRisk));
  totActual += actual; totToday += today;
  console.log(`   episode ${iso(e.open)}: ${e.rows.length} tickets (${actual >= 0 ? "+" : ""}${$(actual)}) -> R53 groups ${[...seen].join(",")} => ${kept.length} ticket(s) kept: ${kept.map((t) => t.sym).join(", ")} => ${$(today)} at today's 1R`);
}
console.log(`   all multi-ticket episodes: actual ${$(totActual)} vs same episodes under today's rules and sizing ${$(totToday)} (${(totToday / totActual * 100).toFixed(1)}% of what was booked)`);
const rScaled = sum(bo.map((t) => t.rMult * todayRisk));
console.log(`   ALL Breakout-crypto tickets re-priced at today's 1R (no R53 cap): ${$(rScaled)} instead of ${$(sum(bo.map((t) => t.pnl)))}`);

console.log(`\n[5] IS ANYTHING REPEATABLE? Breakout-crypto outside its best episode, by R`);
const bestEp = eps.reduce((a, b) => (sum(b.rows.map((t) => t.pnl)) > sum(a.rows.map((t) => t.pnl)) ? b : a));
const rest = bo.filter((t) => !bestEp.rows.includes(t));
console.log(`   best episode: ${bestEp.rows.length} tickets mean R ${f(mean(bestEp.rows.map((t) => t.rMult)), 3)}. All other Breakout-crypto: ${rest.length} tickets, mean R ${f(mean(rest.map((t) => t.rMult)), 3)}, pnl ${$(sum(rest.map((t) => t.pnl)))}, in ${new Set(rest.map((t) => t._day)).size} close days, ${rest.filter((t) => t.rMult > 0).length} winners.`);
const rd = {}; for (const t of rest) rd[t._day] = (rd[t._day] || []).concat(t.rMult);
const dayMeans = Object.values(rd).map((a) => mean(a));
console.log(`   day-clustered: ${dayMeans.length} days, mean of day means ${f(mean(dayMeans), 3)}R, days positive ${dayMeans.filter((x) => x > 0).length}`);
console.log(`\n   already concluded (sealed, cited not redone): R307 ride-the-wave bail exits DID NOT PASS (t -6.07, gross flat, 0.50% RT is the loss); R308 crest predictor DID NOT PASS (t -0.97; models hold 48 h; post-hoc lead only: BTC+ETH surge hold-48 +0.71%/day t 2.58, 283 days);`);
console.log(`   R309 = that lead registered FORWARD on Alpaca paper (bar 1.687 at 40 entry days; collecting, not read). Registry history for Breakout: #8 STAGNANT, #21 STAGNANT, #40 NO-EDGE; R44 exposure-alpha registered 2026-08-24 (not yet read).`);
C.write("board-crypto-breakout.json", { spec: "board-crypto-breakout-v1", asOf: new Date().toISOString(), tickets: bo.length, episodes: eps.length, totActual, totToday, todayRisk });
