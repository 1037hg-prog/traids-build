#!/usr/bin/env node
"use strict";
/**
 * zn-month-end-regimes.cjs — the live tastytrade lane (1 ZN long over the R186/R219 month-end window, GTC disaster stop at
 * entry - 2.5 points) measured by RATE REGIME, 2000-10 .. 2026-09. Measurement only; touches no runner, places nothing.
 *
 * DATA   ./data.json (fetch-data.cjs): Yahoo ZN=F continuous front-month daily OHLC (2000-09-21+), IEF OHLC, ^TNX, ^SP500TR, QQQ.
 * WINDOW (R219 as coded in backend/r219-zn-month-end.js): NYSE sessions of the month (^SP500TR dates); entry = close of the
 *        6th-to-last session, exit = close of the last; 5 overnight holds. P&L per contract = points x $1,000; fees $2.50/side.
 * MAE    min(daily LOW of sessions entry+1 .. exit) - entry close. The stop is "hit" if MAE <= -2.5; it then books -2.5 points
 *        (no slippage) — a lower bound on the loss. Lows include the overnight Globex session in the next trade date's bar.
 * ROLL   Yahoo's continuous series follows the expiring contract to ~the 19th-23rd of Mar/Jun/Sep/Dec, then jumps by the calendar
 *        spread (seen as -3 to +2.3 pt residual days). A day is a ROLL day when it falls on the 15th-28th of Mar/Jun/Sep/Dec AND
 *        |ZN return - beta x IEF return| > 0.5% (beta by OLS on all days). Windows containing one are flagged and excluded from
 *        the regime rows; roll days are excluded from the volatility and gap statistics.
 * REGIMES at entry (no look-ahead): RISING = 10y yield up >= +0.50 pt over the prior 126 sessions; FALLING = down >= 0.50;
 *        RATE-BUST = QQQ >= 15% below its trailing 252-session high AND 10y up over the prior 126 sessions; FALL-BUST = QQQ >= 15% below that high
 *        AND 10y down; plus calendar 2022 and 2026.
 * Run: node zn-month-end-regimes.cjs
 */
const fs = require("fs"), path = require("path");
const D = JSON.parse(fs.readFileSync(path.join(__dirname, "data.json"), "utf8"));
const END = "2026-10-06", Y = D.yahoo;
const CAL = Y["^SP500TR"].map((r) => r[0]).filter((d) => d <= END && d >= "2000-09-21"), N = CAL.length;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
const Phi = (x) => 0.5 * (1 + Math.sign(x) * Math.sqrt(1 - Math.exp(-2 * x * x / Math.PI)));   // close approximation, |err| < 0.003
function align(rows, col) { const out = new Array(N).fill(null); let j = 0, last = null; const r2 = rows.filter((r) => r[col] > 0);
  for (let i = 0; i < N; i++) { let hit = false; while (j < r2.length && r2[j][0] <= CAL[i]) { if (r2[j][0] === CAL[i]) hit = true; last = r2[j][col]; j++; } out[i] = hit ? last : (col === 3 ? null : last); } return out; }
const ZC = align(Y["ZN=F"], 4), ZL = align(Y["ZN=F"], 3), IEF = align(Y.IEF, 5), TNX = align(Y["^TNX"], 4);
const QQQ = align(Y.QQQ, 5);
// beta of ZN daily % return on IEF daily % return, residual sd
const pr = []; for (let i = 1; i < N; i++) if (ZC[i] && ZC[i - 1] && IEF[i] && IEF[i - 1]) pr.push([i, ZC[i] / ZC[i - 1] - 1, IEF[i] / IEF[i - 1] - 1]);
const mx = mean(pr.map((p) => p[2])), my = mean(pr.map((p) => p[1]));
const beta = pr.reduce((s, p) => s + (p[2] - mx) * (p[1] - my), 0) / pr.reduce((s, p) => s + (p[2] - mx) ** 2, 0);
const res = new Map(pr.map((p) => [p[0], p[1] - beta * p[2]])); const rsd = sd([...res.values()]);
const isRoll = (i) => { const m = CAL[i].slice(5, 7), d = +CAL[i].slice(8, 10); return ["03", "06", "09", "12"].includes(m) && d >= 15 && d <= 28 && res.has(i) && Math.abs(res.get(i)) > 0.005; };
const rollDays = CAL.map((_, i) => i).filter(isRoll);
console.log(`ZN MONTH-END WINDOWS BY REGIME — data fetched ${D.fetchedAt}; ZN=F ${CAL[0]}..${CAL[N - 1]}; beta(ZN% on IEF%) ${beta.toFixed(3)}, residual sd ${(rsd * 100).toFixed(3)}%/day; ${rollDays.length} roll days flagged`);
// running QQQ high
const qHi = CAL.map((_, i) => { let h = 0; for (let j = Math.max(0, i - 251); j <= i; j++) h = Math.max(h, QQQ[j] || 0); return h; });
// months
const byM = new Map(); CAL.forEach((d, i) => { const ym = d.slice(0, 7); if (!byM.has(ym)) byM.set(ym, []); byM.get(ym).push(i); });
const W = [];
for (const [ym, idx] of byM) {
  if (ym < "2000-10" || ym > "2026-09" || idx.length < 8) continue;
  const e = idx[idx.length - 6], x = idx[idx.length - 1];
  if (ZC[e] == null || ZC[x] == null) continue;
  let mae = 0, roll = false, lowsOk = true;
  for (let i = e + 1; i <= x; i++) { if (ZL[i] == null) { lowsOk = false; continue; } mae = Math.min(mae, ZL[i] - ZC[e]); if (isRoll(i)) roll = true; }
  const pts = ZC[x] - ZC[e];
  // other-day drift in the month (R180's comparison): mean daily point change on the month's non-window sessions x 5
  const od = []; for (const i of idx) if ((i <= e) && i - 1 >= 0 && ZC[i] != null && ZC[i - 1] != null && CAL[i - 1].slice(0, 7) === ym) od.push(ZC[i] - ZC[i - 1]);
  const d10 = e >= 126 ? TNX[e] - TNX[e - 126] : null, dd = QQQ[e] / qHi[e] - 1;
  const tags = [];
  if (d10 != null && d10 >= 0.5) tags.push("RISING"); if (d10 != null && d10 <= -0.5) tags.push("FALLING");
  if (dd <= -0.15 && d10 > 0) tags.push("RATE-BUST"); if (dd <= -0.15 && d10 <= 0) tags.push("FALL-BUST");
  tags.push("Y" + ym.slice(0, 4));
  const tv = []; for (let i = Math.max(1, e - 62); i <= e; i++) if (ZC[i] && ZC[i - 1] && !isRoll(i)) tv.push(ZC[i] - ZC[i - 1]);
  W.push({ sd5: sd(tv) * Math.sqrt(5), ym, entry: CAL[e], exit: CAL[x], px: ZC[e], pts, mae, excess: od.length ? pts - 5 * mean(od) : null, roll, lowsOk, d10, qqqDD: dd, tags, stopPts: mae <= -2.5 ? -2.5 : pts });
}
const fmt = (x, d = 2) => (x == null ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
function row(label, ws) {
  if (!ws.length) return console.log(`${label.padEnd(26)} n 0`);
  const p = ws.map((w) => w.pts), ex = ws.filter((w) => w.excess != null).map((w) => w.excess), s = ws.map((w) => w.stopPts), m = ws.map((w) => w.mae);
  const hits = ws.filter((w) => w.mae <= -2.5).length, near = ws.filter((w) => w.mae <= -1.5).length;
  console.log(`${label.padEnd(26)} n ${String(ws.length).padStart(3)} | mean ${fmt(mean(p), 3).padStart(7)} pts (t ${fmt(tOf(p)).padStart(6)}) win ${(100 * p.filter((v) => v > 0).length / p.length).toFixed(0).padStart(3)}% | vs other days ${fmt(mean(ex), 3).padStart(7)} (t ${fmt(tOf(ex)).padStart(6)}) | worst close ${fmt(Math.min(...p)).padStart(6)} | worst MAE ${fmt(Math.min(...m)).padStart(6)} | MAE<=-1.5: ${String(near).padStart(2)} | stop hits ${hits} | $/ctr/window: no stop ${(1000 * mean(p) - 5).toFixed(0).padStart(5)}, with stop ${(1000 * mean(s) - 5).toFixed(0).padStart(5)}`);
  return { n: ws.length, meanPts: mean(p), t: tOf(p), win: p.filter((v) => v > 0).length / p.length, meanExcess: mean(ex), tExcess: tOf(ex), worstClose: Math.min(...p), worstMAE: Math.min(...m), near, hits, dollarsNoStop: 1000 * mean(p) - 5, dollarsStop: 1000 * mean(s) - 5 };
}
const out = { asOf: END, beta, rsd, groups: {} };
console.log(`\n1. Window results (points per contract; $1,000 per point)`);
const clean = W.filter((w) => !w.roll && w.lowsOk);
const G = {
  "ALL 2000-10..2026-09": W, "ALL excl. roll-flagged": clean, "R219-era 2019-07..2026-08": clean.filter((w) => w.ym >= "2019-07" && w.ym <= "2026-08"),
  "RISING 10y (+0.5/126d)": clean.filter((w) => w.tags.includes("RISING")), "FALLING 10y (-0.5/126d)": clean.filter((w) => w.tags.includes("FALLING")),
  "RATE-BUST (QQQ-15%,10y up)": clean.filter((w) => w.tags.includes("RATE-BUST")), "FALL-BUST (QQQ-15%,10y dn)": clean.filter((w) => w.tags.includes("FALL-BUST")),
  "calendar 2022": clean.filter((w) => w.tags.includes("Y2022")), "calendar 2026": clean.filter((w) => w.tags.includes("Y2026")),
};
for (const [k, ws] of Object.entries(G)) out.groups[k] = row(k, ws);
console.log(`   roll-flagged windows excluded: ${W.filter((w) => w.roll).map((w) => w.ym).join(" ")}`);
console.log(`\n2. Every 2022 and 2026 window (entry close, close-to-close pts, MAE, 10y change over prior 126 sessions, QQQ off high)`);
for (const w of W.filter((w) => w.ym.startsWith("2022") || w.ym.startsWith("2026"))) console.log(`   ${w.ym} ${w.entry}->${w.exit} entry ${w.px.toFixed(3)} pts ${fmt(w.pts, 3).padStart(7)} MAE ${fmt(w.mae, 3).padStart(7)} 10y ${fmt(w.d10).padStart(6)} QQQ ${(100 * w.qqqDD).toFixed(1).padStart(6)}% ${w.roll ? "ROLL" : ""}`);
console.log(`\n3. Ten worst MAEs (all windows)`);
for (const w of [...W].sort((a, b) => a.mae - b.mae).slice(0, 10)) console.log(`   ${w.ym} MAE ${fmt(w.mae, 3)} close ${fmt(w.pts, 3)} tags ${w.tags.join(",")} ${w.roll ? "ROLL" : ""}`);
out.windows = W;

// ── volatility regime and the stop's distance ──
console.log(`\n4. ZN daily point volatility and the -2.5 pt stop (Brownian touch probability over 5 sessions, zero drift: P = 2*Phi(-2.5/(sd*sqrt5)))`);
const dp = []; for (let i = 1; i < N; i++) if (ZC[i] && ZC[i - 1] && !isRoll(i)) dp.push([CAL[i], ZC[i] - ZC[i - 1], ZL[i] != null ? ZL[i] - ZC[i - 1] : null]);
const span = (lbl, f) => { const v = dp.filter(f).map((x) => x[1]); const s = sd(v), s5 = s * Math.sqrt(5); const p = 2 * Phi(-2.5 / s5);
  console.log(`   ${lbl.padEnd(22)} n ${String(v.length).padStart(5)}  daily sd ${s.toFixed(3)} pts  5-session sd ${s5.toFixed(2)} pts  stop = ${(2.5 / s5).toFixed(2)} sd  touch P ${(100 * p).toFixed(1)}%  worst day ${Math.min(...v).toFixed(3)}`);
  return { n: v.length, sd: s, sd5: s5, stopSd: 2.5 / s5, touchP: p, worstDay: Math.min(...v) }; };
out.vol = {};
for (const y of ["2003", "2008", "2009", "2013", "2018", "2020", "2022", "2023", "2024", "2025", "2026"]) out.vol[y] = span("year " + y, (x) => x[0].startsWith(y));
out.vol.all = span("all 2000-2026", () => true);
out.vol.last63 = span("last 63 sessions", (x) => x[0] >= CAL[N - 63]);
const gaps = dp.filter((x) => x[2] != null && x[2] <= -2.5);
console.log(`   sessions whose LOW was >= 2.5 pts under the prior close: ${gaps.length} (${gaps.map((x) => x[0]).join(", ") || "none"})`);
const big = dp.filter((x) => x[2] != null && x[2] <= -1.5); console.log(`   sessions with low >= 1.5 pts under prior close: ${big.length}; of them in 2022-2026: ${big.filter((x) => x[0] >= "2022").length}`);

// ── DV01 and yield-shock translation ──
console.log(`\n5. Rate-shock translation for 1 ZN`);
const T2 = align(Y["^TNX"], 4); const reg = []; for (let i = N - 252; i < N; i++) if (ZC[i] && ZC[i - 1] && T2[i] && T2[i - 1] && !isRoll(i)) reg.push([(T2[i] - T2[i - 1]) * 100, ZC[i] - ZC[i - 1]]);
const bx = mean(reg.map((r) => r[0])), by = mean(reg.map((r) => r[1])); const ptsPerBp = reg.reduce((s, r) => s + (r[0] - bx) * (r[1] - by), 0) / reg.reduce((s, r) => s + (r[0] - bx) ** 2, 0);
console.log(`   last 252 sessions: ZN points per +1bp of the 10y (OLS on daily changes) = ${ptsPerBp.toFixed(4)} -> $${(-ptsPerBp * 1000).toFixed(0)} per contract per bp; stop of 2.5 pts ~ ${(2.5 / -ptsPerBp).toFixed(0)} bp`);
// worst 5-session 10y rise (1988+), from full ^TNX
const TN = Y["^TNX"].filter((r) => r[4] > 0 && r[0] <= END); let worst = [0, null], worst22 = [0, null], worst26 = [0, null];
for (let i = 5; i < TN.length; i++) { const d = TN[i][4] - TN[i - 5][4]; if (d > worst[0]) worst = [d, TN[i][0]]; if (TN[i][0].startsWith("2022") && d > worst22[0]) worst22 = [d, TN[i][0]]; if (TN[i][0].startsWith("2026") && d > worst26[0]) worst26 = [d, TN[i][0]]; }
for (const [lbl, w] of [["worst 5-session 10y rise since 1988", worst], ["worst in 2022", worst22], ["worst in 2026", worst26]]) console.log(`   ${lbl.padEnd(36)} +${(w[0] * 100).toFixed(0)} bp (ending ${w[1]}) -> ${(w[0] * 100 * ptsPerBp).toFixed(2)} pts = $${(w[0] * 100 * ptsPerBp * 1000).toFixed(0)} on 1 ZN`);
const px = ZC[N - 1]; console.log(`   1 ZN at ${px.toFixed(3)} = $${(px * 1000).toFixed(0)} notional = ${(px * 1000 / 25000).toFixed(2)}x a $25,000 account; stop $2,500 = 10.0% of it; 10y yield ${T2[N - 1].toFixed(2)}% on ${CAL[N - 1]}`);
out.dv01 = { ptsPerBp, worst5: worst, worst22, worst26, px };
const stopBp = 2.5 / -ptsPerBp; let cAll = 0, c22 = 0, nAll = 0, n22 = 0;
for (let i = 5; i < TN.length; i++) { const d = (TN[i][4] - TN[i - 5][4]) * 100; nAll++; if (d >= stopBp) cAll++; if (TN[i][0].startsWith("2022")) { n22++; if (d >= stopBp) c22++; } }
console.log("   rolling 5-session windows (every possible entry day) with a 10y rise >= " + stopBp.toFixed(0) + " bp (= the stop at today's DV01): " + cAll + " of " + nAll + " since 1988 (" + (100 * cAll / nAll).toFixed(1) + "%); " + c22 + " of " + n22 + " in 2022 (" + (100 * c22 / n22).toFixed(1) + "%)");
out.shock = { stopBp, cAll, nAll, c22, n22 };
console.log("\n6. Stop variants on the clean windows (stop fills AT the stop level, no slippage; $ per contract per window after $5 fees)");
const variants = [["none", () => Infinity], ["fixed 1.5", () => 1.5], ["fixed 2.0", () => 2.0], ["fixed 2.5 (live)", () => 2.5], ["fixed 3.0", () => 3.0], ["fixed 3.5", () => 3.5], ["2.0 x 5d sd", (w) => 2.0 * w.sd5], ["2.5 x 5d sd", (w) => 2.5 * w.sd5], ["3.0 x 5d sd", (w) => 3.0 * w.sd5]];
out.stops = {};
for (const [sub, ws] of [["all clean", clean], ["RISING", G["RISING 10y (+0.5/126d)"]], ["2022", G["calendar 2022"]]]) {
  for (const [lbl, f] of variants) { const r = ws.map((w) => (w.mae <= -f(w) ? -f(w) : w.pts)); const hits = ws.filter((w) => w.mae <= -f(w)).length;
    out.stops[sub + "|" + lbl] = { mean$: 1000 * mean(r) - 5, hits, worst: Math.min(...r), t: tOf(r) };
    console.log("   " + sub.padEnd(10) + " " + lbl.padEnd(17) + " n " + String(ws.length).padStart(3) + "  mean $" + (1000 * mean(r) - 5).toFixed(0).padStart(5) + "  t " + tOf(r).toFixed(2).padStart(5) + "  stop hits " + String(hits).padStart(3) + "  worst window " + (1000 * Math.min(...r)).toFixed(0)); }
}
const nowSd5 = (() => { const v = []; for (let i = N - 63; i < N; i++) if (ZC[i] && ZC[i - 1] && !isRoll(i)) v.push(ZC[i] - ZC[i - 1]); return sd(v) * Math.sqrt(5); })();
console.log("   today's 5-session sd " + nowSd5.toFixed(2) + " pts -> 2.5 x sd stop would sit at " + (2.5 * nowSd5).toFixed(2) + " pts; 2022's 5-session sd " + out.vol["2022"].sd5.toFixed(2) + " -> " + (2.5 * out.vol["2022"].sd5).toFixed(2) + " pts");
fs.writeFileSync(path.join(__dirname, "zn-results.json"), JSON.stringify(out, null, 1));
console.log(`\nwrote zn-results.json`);
