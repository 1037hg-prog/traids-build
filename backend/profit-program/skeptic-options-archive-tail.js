#!/usr/bin/env node
"use strict";
/**
 * SKEPTIC (options-premium lane): what does the tail of R25 look like at TODAY'S size? The live record is 19 sessions at 4 contracts
 * (worst day -770). The frozen rule's own 501-session archive (data/r116-zero-dte-replay-wings.json, the sealed R116 replay, per
 * contract, net of the borrowed crossing and the modelled 1.30 fee) has already seen what the live sample has not. Read-only; no fetch.
 * Every archive session is scaled to 4 contracts (the session's own wings; the archive carries 7.72 wings a session, live 7.84).
 *   node backend/profit-program/skeptic-options-archive-tail.js
 * Writes backend/data/profit-program/skeptic-options-archive-tail.json
 */
const fs = require("fs"), path = require("path");
const C = require("./_opt-common.js");
const { $, f } = C;
const CT = 4, HALT = 2000;
const A = JSON.parse(fs.readFileSync(path.join(C.DATA, "r116-zero-dte-replay-wings.json"), "utf8"));
const byDay = new Map();
for (const w of A) (byDay.get(w.day) || byDay.set(w.day, []).get(w.day)).push(w);
const days = [...byDay.keys()].sort();
const S = days.map((d) => { const W = byDay.get(d); const full = W.filter((w) => w.cost >= w.width - 1e-9);
  return { d, n: W.length, pnl: CT * C.sum(W.map((w) => w.pnl)), fullP: full.filter((w) => w.right === "P").length, fullC: full.filter((w) => w.right === "C").length, losers: W.filter((w) => w.pnl < 0).length }; });
const p = S.map((s) => s.pnl), sorted = p.slice().sort((a, b) => a - b), q = (x) => sorted[Math.min(sorted.length - 1, Math.floor(x * sorted.length))];
let peak = 0, cum = 0, dd = 0, ddAt = null; for (const s of S) { cum += s.pnl; if (cum > peak) peak = cum; if (peak - cum > dd) { dd = peak - cum; ddAt = s.d; } }
const out = { label: "SKEPTIC, archive (sealed R116 replay rows), scaled to 4 contracts", sessions: S.length, wings: A.length, wingsPerSession: A.length / S.length };
console.log("R25 ARCHIVE AT TODAY'S SIZE (4 contracts): " + A.length + " wings, " + S.length + " sessions " + days[0] + ".." + days[days.length - 1] + ", " + (A.length / S.length).toFixed(2) + " wings a session");
console.log("  total " + $(C.sum(p)) + "; mean " + $(C.mean(p)) + "/session (t " + f(C.tOf(p)) + ") = " + $(C.mean(p) * 21) + "/month; green sessions " + p.filter((x) => x > 0).length + " of " + p.length + " (" + f(100 * p.filter((x) => x > 0).length / p.length, 0) + "%)");
console.log("  worst session " + $(sorted[0]) + " (" + S.find((s) => s.pnl === sorted[0]).d + "); 1st percentile " + $(q(0.01)) + "; 5th percentile " + $(q(0.05)) + "; median " + $(q(0.5)) + "; best " + $(sorted[sorted.length - 1]));
const cnt = (x) => p.filter((v) => v <= x).length;
console.log("  sessions at or below the live worst day (-770): " + cnt(-770) + " (" + f(100 * cnt(-770) / p.length, 1) + "%, one every " + f(p.length / Math.max(1, cnt(-770)), 0) + " sessions); at or below -1,000: " + cnt(-1000) + "; at or below -1,500: " + cnt(-1500) + "; at or below the daily halt (-" + HALT + "): " + cnt(-HALT));
console.log("  max drawdown " + $(-dd) + " (trough " + ddAt + ")");
Object.assign(out, { total: C.sum(p), perSession: C.mean(p), t: C.tOf(p), perMonth: C.mean(p) * 21, green: p.filter((x) => x > 0).length, worst: sorted[0], p01: q(0.01), p05: q(0.05), atOrBelowLiveWorst: cnt(-770), atOrBelow1000: cnt(-1000), atOrBelow1500: cnt(-1500), atOrBelowHalt: cnt(-HALT), maxDrawdown: dd, troughDay: ddAt });
// both sides on one day: an underlying can only breach one side at the close, but different underlyings can breach different sides
const both = S.filter((s) => s.fullP > 0 && s.fullC > 0).length, oneSide3 = S.filter((s) => Math.max(s.fullP, s.fullC) >= 3).length;
console.log("  sessions with a FULL loss on a put wing AND on a call wing (different underlyings): " + both + " of " + S.length + "; sessions with three or more full losses on one side: " + oneSide3);
Object.assign(out, { bothSidesFullLoss: both, threePlusOneSide: oneSide3 });
// calendar months
const mo = new Map(); for (const s of S) mo.set(s.d.slice(0, 7), (mo.get(s.d.slice(0, 7)) || 0) + s.pnl);
const M = [...mo.entries()].sort(), mv = M.map((x) => x[1]), full = M.filter((x) => x[0] !== days[0].slice(0, 7) && x[0] !== days[days.length - 1].slice(0, 7));
const fv = full.map((x) => x[1]), fs2 = fv.slice().sort((a, b) => a - b);
console.log("\n  by calendar month (" + full.length + " full months): positive " + fv.filter((x) => x > 0).length + ", negative " + fv.filter((x) => x <= 0).length + "; mean " + $(C.mean(fv)) + ", sd " + $(C.sd(fv)).replace("+", "") + "; worst " + $(fs2[0]) + ", median " + $(fs2[Math.floor(fs2.length / 2)]) + ", best " + $(fs2[fs2.length - 1]));
console.log("  " + M.map((x) => x[0].slice(2) + " " + $(x[1])).join(" | "));
out.months = { full: full.length, positive: fv.filter((x) => x > 0).length, mean: C.mean(fv), sd: C.sd(fv), worst: fs2[0], median: fs2[Math.floor(fs2.length / 2)], best: fs2[fs2.length - 1], byMonth: Object.fromEntries(M) };
// how many of the archive's 19-session windows look as good as or better than the live 4-contract era (+187)?
const LIVE = 187, WN = 19; let ge = 0, tot = 0; const wsum = [];
for (let i = 0; i + WN <= p.length; i++) { const s = C.sum(p.slice(i, i + WN)); wsum.push(s); tot++; if (s >= LIVE) ge++; }
const ws = wsum.slice().sort((a, b) => a - b);
console.log("\n  rolling " + WN + "-session windows in the archive (" + tot + ", overlapping): sum at or above the live era's +" + LIVE + " on " + ge + " (" + f(100 * ge / tot, 0) + "%); 5th pct " + $(ws[Math.floor(0.05 * ws.length)]) + ", median " + $(ws[Math.floor(0.5 * ws.length)]) + ", 95th pct " + $(ws[Math.floor(0.95 * ws.length)]));
out.rolling19 = { windows: tot, atOrAboveLive: ge, p05: ws[Math.floor(0.05 * ws.length)], median: ws[Math.floor(0.5 * ws.length)], p95: ws[Math.floor(0.95 * ws.length)] };
// the live 4-contract era, same statistics, for the side-by-side
const L = C.ledger(), live = L.signals.filter((t) => C.isR25(t) && C.etDay(t.openedAt) >= "2026-09-14" && (t.contracts || 1) === 4), ls = C.bySession(live, (t) => t.pnl);
console.log("\n  LIVE 4-contract era for comparison: " + live.length + " wings, " + ls.n + " sessions, total " + $(C.sum(ls.sums)) + ", worst day " + $(ls.worstDay) + ", green " + ls.posDays + " of " + ls.n);
out.live = { wings: live.length, sessions: ls.n, total: C.sum(ls.sums), worst: ls.worstDay, green: ls.posDays };
console.log("\nwrote " + C.writeOut("skeptic-options-archive-tail.json", out));
