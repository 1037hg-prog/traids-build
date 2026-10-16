#!/usr/bin/env node
/**
 * BOARD PAYOFF ANATOMY — read-only printer (operator 2026-10-10: "75% win rate should be way profitable").
 * Why a high win rate does or does not turn into dollars: average win $ against average loss $, by strategy, on exactly the
 * population the dashboard's daily table uses (lib/reconcile.js cleanEraLedger() signals, controls out, entries stamped outside
 * 09:25-16:00 ET out, grouped by the MT close day). The out-of-hours bucket the dashboard hides is printed separately.
 * A win is rMult > 0 (the dashboard's rule). Writes nothing, sends nothing.
 *   node backend/board-payoff-anatomy.js [--since 2026-09-25] [--until 2026-10-09]
 */
"use strict";
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SINCE = arg("--since", "2026-09-25"), UNTIL = arg("--until", "9999-12-31");
const L = require("./lib/reconcile.js").cleanEraLedger();
const mtDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
const isOvernight = (t) => { const o = t.openedAt || t.addedAt; if (!o) return false; const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(o)); return hm < "09:25" || hm >= "16:00"; };
const inRange = (t) => { const d = mtDay(t.closedAt); return d >= SINCE && d <= UNTIL; };
const all = L.signals.filter((t) => !t.ctrl && inRange(t));
const day = all.filter((t) => !isOvernight(t)), onx = all.filter(isOvernight);
const $ = (v) => (v < 0 ? "-$" : "+$") + Math.abs(Math.round(v)).toLocaleString("en-US");
const u$ = (v) => "$" + Math.abs(Math.round(v)).toLocaleString("en-US");
const sum = (a) => a.reduce((s, v) => s + v, 0), mean = (a) => (a.length ? sum(a) / a.length : NaN);

function stats(T) {
  const W = T.filter((t) => t.rMult > 0), Lo = T.filter((t) => !(t.rMult > 0));
  const gw = sum(W.map((t) => t.pnl || 0)), gl = sum(Lo.map((t) => t.pnl || 0));
  const aw = W.length ? gw / W.length : 0, al = Lo.length ? gl / Lo.length : 0;
  return { n: T.length, w: W.length, l: Lo.length, win: T.length ? W.length / T.length * 100 : NaN, gw, gl, net: gw + gl, aw, al,
    ratio: aw > 0 ? Math.abs(al) / aw : NaN, breakeven: (aw - al) > 0 ? Math.abs(al) / (aw + Math.abs(al)) * 100 : NaN,
    avgR: mean(T.map((t) => t.rMult)), risk: mean(T.map((t) => t.riskDollars).filter(Number.isFinite)) };
}
function row(label, s) {
  return `${label.padEnd(18)} ${String(s.n).padStart(4)}  ${s.win.toFixed(0).padStart(3)}%  ${u$(s.aw).padStart(7)}  ${("-" + u$(s.al)).padStart(8)}  ${(Number.isFinite(s.ratio) ? s.ratio.toFixed(2) + "x" : "n/a").padStart(6)}  ${(Number.isFinite(s.breakeven) ? s.breakeven.toFixed(0) + "%" : "n/a").padStart(5)}  ${$(s.gw).padStart(9)}  ${$(s.gl).padStart(9)}  ${$(s.net).padStart(8)}  ${s.avgR.toFixed(3).padStart(7)}  ${u$(s.risk).padStart(6)}`;
}
const HEAD = `${"".padEnd(18)} ${"n".padStart(4)}  ${"win".padStart(4)}  ${"avg win".padStart(7)}  ${"avg loss".padStart(8)}  ${"loss/win".padStart(6)}  ${"needs".padStart(5)}  ${"gains".padStart(9)}  ${"losses".padStart(9)}  ${"net".padStart(8)}  ${"avg R".padStart(7)}  ${"risk".padStart(6)}`;

console.log(`BOARD PAYOFF ANATOMY — closed ${SINCE}..${UNTIL === "9999-12-31" ? "now" : UNTIL} (MT close day), source ${L.source || "cleanEraLedger"}`);
console.log(`population: ${all.length} signal tickets = ${day.length} in the dashboard's table + ${onx.length} entered outside 09:25-16:00 ET (hidden from that table)\n`);
console.log(`"needs" = the win rate at which that average win and average loss break even = avg loss / (avg win + avg loss)\n`);
console.log(HEAD);
const S = stats(day); console.log(row("DASHBOARD TABLE", S));
console.log(`  arithmetic: ${S.w} wins x ${u$(S.aw)} = ${$(S.gw)};  ${S.l} losses x -${u$(S.al)} = ${$(S.gl)};  net ${$(S.net)}`);
const by = (T, f) => { const m = {}; for (const t of T) (m[f(t)] ||= []).push(t); return Object.entries(m).map(([k, v]) => [k, stats(v), v]).sort((a, b) => b[1].n - a[1].n); };
console.log("\nby strategy (dashboard table)"); console.log(HEAD);
for (const [k, s] of by(day, (t) => t.strategy || "?")) console.log(row(k, s));
console.log("\nby class"); console.log(HEAD);
for (const [k, s] of by(day, (t) => t.cls || "?")) console.log(row(k, s));
console.log("\nby exit reason"); console.log(HEAD);
for (const [k, s] of by(day, (t) => t.reason || "?")) console.log(row(k, s));
if (onx.length) { console.log("\nhidden from the table (entered outside 09:25-16:00 ET)"); console.log(HEAD); console.log(row("ALL HIDDEN", stats(onx))); for (const [k, s] of by(onx, (t) => t.strategy || "?")) console.log(row("  " + k, s)); console.log(row("TABLE + HIDDEN", stats(all))); }

// concentration: how much of the gross loss the largest losses carry, and what the days look like
const losers = day.filter((t) => !(t.rMult > 0)).sort((a, b) => (a.pnl || 0) - (b.pnl || 0));
const top = losers.slice(0, 10), topSum = sum(top.map((t) => t.pnl || 0));
console.log(`\n10 largest losses = ${$(topSum)} = ${(topSum / S.gl * 100).toFixed(0)}% of all losses (${$(S.gl)}); they are ${(10 / S.n * 100).toFixed(1)}% of the tickets`);
for (const t of top) console.log(`  ${mtDay(t.closedAt)}  ${String(t.strategy).padEnd(14)} ${String(t.sym).padEnd(8)} ${$(t.pnl).padStart(7)}  ${t.rMult.toFixed(2).padStart(6)}R  risk ${u$(t.riskDollars)}  ${t.reason}`);
const winners = day.filter((t) => t.rMult > 0).sort((a, b) => (b.pnl || 0) - (a.pnl || 0));
console.log(`10 largest wins = ${$(sum(winners.slice(0, 10).map((t) => t.pnl || 0)))} = ${(sum(winners.slice(0, 10).map((t) => t.pnl || 0)) / S.gw * 100).toFixed(0)}% of all gains (${$(S.gw)})`);
// R-multiple shape per strategy: how far winners run and how deep losers go
console.log("\nsize of a win and a loss in R (1R = the planned risk on the ticket)");
console.log(`${"".padEnd(18)} ${"avg win R".padStart(9)}  ${"avg loss R".padStart(10)}  ${"median win R".padStart(12)}  ${"worst R".padStart(8)}  ${"losses <= -1R".padStart(13)}`);
const med = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
for (const [k, , T] of [["DASHBOARD TABLE", S, day], ...by(day, (t) => t.strategy || "?")]) {
  const w = T.filter((t) => t.rMult > 0).map((t) => t.rMult), l = T.filter((t) => !(t.rMult > 0)).map((t) => t.rMult);
  console.log(`${k.padEnd(18)} ${(w.length ? mean(w).toFixed(3) : "n/a").padStart(9)}  ${(l.length ? mean(l).toFixed(3) : "n/a").padStart(10)}  ${(w.length ? med(w).toFixed(3) : "n/a").padStart(12)}  ${(l.length ? Math.min(...l).toFixed(2) : "n/a").padStart(8)}  ${String(l.filter((v) => v <= -1).length).padStart(13)}`);
}
