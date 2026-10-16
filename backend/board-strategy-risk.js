#!/usr/bin/env node
/**
 * BOARD BY STRATEGY: PROFIT PER DAY AND THE RISK TAKEN FOR IT — read-only printer (operator 2026-10-10: "the last two weeks of the
 * daily board ... what the risk for each"). Population = the dashboard's daily table (lib/reconcile.js cleanEraLedger() signals,
 * controls out, entries stamped outside 09:25-16:00 ET out, MT close day), plus the tickets that table hides, shown apart.
 * Every strategy is measured over the SAME session days (a day with no close counts as $0), so the rows add up to the board.
 * "Risk put on" = the planned loss at the stop (riskDollars) of the tickets, by the day they were OPENED. Dollars as booked
 * (before modelled trading cost). Writes nothing.
 *   node backend/board-strategy-risk.js [--since 2026-09-25] [--until 2026-10-09]
 */
"use strict";
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SINCE = arg("--since", "2026-09-25"), UNTIL = arg("--until", "9999-12-31");
const L = require("./lib/reconcile.js").cleanEraLedger();
const mtDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
const isOvernight = (t) => { const o = t.openedAt || t.addedAt; if (!o) return false; const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(o)); return hm < "09:25" || hm >= "16:00"; };
const sum = (a) => a.reduce((s, v) => s + v, 0), mean = (a) => (a.length ? sum(a) / a.length : NaN);
const $ = (v) => (!Number.isFinite(v) ? "n/a" : (v < 0 ? "-$" : "+$") + Math.abs(Math.round(v)).toLocaleString("en-US")), u$ = (v) => (Number.isFinite(v) ? "$" + Math.round(v).toLocaleString("en-US") : "n/a");
const inR = (t) => { const d = mtDay(t.closedAt); return d >= SINCE && d <= UNTIL; };
const all = L.signals.filter((t) => !t.ctrl && inR(t)), table = all.filter((t) => !isOvernight(t)), hidden = all.filter(isOvernight);
const DAYS = [...new Set(table.map((t) => mtDay(t.closedAt)))].sort();
function row(label, T) {
  const byDay = Object.fromEntries(DAYS.map((d) => [d, 0])); for (const t of T) { const d = mtDay(t.closedAt); byDay[d] = (byDay[d] || 0) + (t.pnl || 0); }
  const v = Object.keys(byDay).sort().map((d) => byDay[d]), n = v.length, mu = mean(v), sd = Math.sqrt(sum(v.map((x) => (x - mu) ** 2)) / (n - 1));
  let peak = 0, cum = 0, dd = 0; for (const x of v) { cum += x; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  const risks = T.map((t) => t.riskDollars).filter(Number.isFinite), rk = mean(risks);
  const open = {}; for (const t of T) if (Number.isFinite(t.riskDollars)) { const d = mtDay(t.openedAt); open[d] = (open[d] || 0) + t.riskDollars; }
  const od = Object.values(open), worstT = T.length ? Math.min(...T.map((t) => t.pnl || 0)) : NaN, totRisk = sum(risks);
  console.log(`${label.padEnd(20)} ${String(T.length).padStart(4)}  ${$(sum(v)).padStart(8)}  ${$(mu).padStart(6)}  ${("±" + u$(sd)).padStart(7)}  ${$(Math.min(...v)).padStart(7)}  ${$(dd).padStart(8)}  ${String(v.filter((x) => x < 0).length + "/" + n).padStart(6)}  ${u$(rk).padStart(6)}  ${u$(od.length ? mean(od) : NaN).padStart(8)}  ${u$(od.length ? Math.max(...od) : NaN).padStart(8)}  ${$(worstT).padStart(7)}  ${(totRisk > 0 ? (100 * sum(T.map((t) => t.pnl || 0)) / totRisk).toFixed(1) + "%" : "n/a").padStart(7)}`);
}
console.log(`BOARD BY STRATEGY — closed ${SINCE}..${UNTIL === "9999-12-31" ? "now" : UNTIL}, ${DAYS.length} session days (${DAYS[0]}..${DAYS[DAYS.length - 1]}); dollars as booked, before modelled trading cost\n`);
console.log(`${"".padEnd(20)} ${"tix".padStart(4)}  ${"total".padStart(8)}  ${"/day".padStart(6)}  ${"swing".padStart(7)}  ${"worst d".padStart(7)}  ${"drop".padStart(8)}  ${"losing".padStart(6)}  ${"risk/t".padStart(6)}  ${"risk/day".padStart(8)}  ${"max/day".padStart(8)}  ${"worst t".padStart(7)}  ${"on risk".padStart(7)}`);
const strategies = [...new Set(table.map((t) => t.strategy || "?"))].sort((a, b) => table.filter((t) => t.strategy === b).length - table.filter((t) => t.strategy === a).length);
for (const s of strategies) row(s, table.filter((t) => (t.strategy || "?") === s));
row("BOARD (table)", table);
if (hidden.length) { console.log(""); for (const s of [...new Set(hidden.map((t) => t.strategy))]) row(s + " (hidden)", hidden.filter((t) => t.strategy === s)); row("BOARD + hidden", all); }
console.log(`\ncolumns: tix = tickets closed · /day = total / ${DAYS.length} days · swing = one standard deviation of the daily result · worst d = worst day · drop = deepest fall from a running peak · losing = losing days / days · risk/t = average planned loss at the stop per ticket · risk/day, max/day = planned loss put on per day it opened tickets (average, largest) · worst t = worst single ticket · on risk = total P&L / total planned risk`);
