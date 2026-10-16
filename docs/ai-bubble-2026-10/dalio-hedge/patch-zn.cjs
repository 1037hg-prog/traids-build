const fs = require("fs"); let s = fs.readFileSync("zn-month-end-regimes.cjs", "utf8");
const rep = (a, b) => { if (!s.includes(a)) throw new Error("anchor missing: " + a.slice(0, 60)); s = s.replace(a, b); };
// 1. roll detection: quarterly-expiry days with a residual > 0.5%
rep(` * ROLL   Yahoo's continuous series switches contract; a switch inside a window adds the calendar spread to the close-to-close.
 *        A window is flagged ROLL when any of its days has |ZN return - beta x IEF return| > 6 residual sd (beta by OLS on all
 *        days). Flagged windows are reported, and the headline stats are shown with and without them.`,
` * ROLL   Yahoo's continuous series follows the expiring contract to ~the 19th-23rd of Mar/Jun/Sep/Dec, then jumps by the calendar
 *        spread (seen as -3 to +2.3 pt residual days). A day is a ROLL day when it falls on the 15th-28th of Mar/Jun/Sep/Dec AND
 *        |ZN return - beta x IEF return| > 0.5% (beta by OLS on all days). Windows containing one are flagged and excluded from
 *        the regime rows; roll days are excluded from the volatility and gap statistics.`);
rep(`const res = new Map(pr.map((p) => [p[0], p[1] - beta * p[2]])); const rsd = sd([...res.values()]);`,
`const res = new Map(pr.map((p) => [p[0], p[1] - beta * p[2]])); const rsd = sd([...res.values()]);
const isRoll = (i) => { const m = CAL[i].slice(5, 7), d = +CAL[i].slice(8, 10); return ["03", "06", "09", "12"].includes(m) && d >= 15 && d <= 28 && res.has(i) && Math.abs(res.get(i)) > 0.005; };
const rollDays = CAL.map((_, i) => i).filter(isRoll);`);
rep("residual sd ${(rsd * 100).toFixed(3)}%/day; roll flag > ${(6 * rsd * 100).toFixed(2)}%`);",
    "residual sd ${(rsd * 100).toFixed(3)}%/day; ${rollDays.length} roll days flagged`);");
rep(`if (res.has(i) && Math.abs(res.get(i)) > 6 * rsd) roll = true;`, `if (isRoll(i)) roll = true;`);
rep(`if (ZC[i] && ZC[i - 1] && !(res.has(i) && Math.abs(res.get(i)) > 6 * rsd)) dp.push(`, `if (ZC[i] && ZC[i - 1] && !isRoll(i)) dp.push(`);
rep(`if (ZC[i] && ZC[i - 1] && T2[i] && T2[i - 1] && !(res.has(i) && Math.abs(res.get(i)) > 6 * rsd)) reg.push(`, `if (ZC[i] && ZC[i - 1] && T2[i] && T2[i - 1] && !isRoll(i)) reg.push(`);
// 2. bust tags vs trailing 252-session QQQ high, not the all-time high (QQQ sat >15% under its 2000 high until 2015)
rep(`const qHi = []; let h = 0; for (let i = 0; i < N; i++) { h = Math.max(h, QQQ[i] || 0); qHi.push(h); }`,
    `const qHi = CAL.map((_, i) => { let h = 0; for (let j = Math.max(0, i - 251); j <= i; j++) h = Math.max(h, QQQ[j] || 0); return h; });`);
rep(` * REGIMES at entry (no look-ahead): RISING = 10y yield up >= +0.50 pt over the prior 126 sessions; FALLING = down >= 0.50;
 *        RATE-BUST = QQQ >= 15% below its running high AND 10y up over the prior 126 sessions; FALL-BUST = QQQ >= 15% below high`,
` * REGIMES at entry (no look-ahead): RISING = 10y yield up >= +0.50 pt over the prior 126 sessions; FALLING = down >= 0.50;
 *        RATE-BUST = QQQ >= 15% below its trailing 252-session high AND 10y up over the prior 126 sessions; FALL-BUST = QQQ >= 15% below that high`);
// 3. per-window trailing vol for vol-scaled stops
rep(`  W.push({ ym, entry: CAL[e],`, `  const tv = []; for (let i = Math.max(1, e - 62); i <= e; i++) if (ZC[i] && ZC[i - 1] && !isRoll(i)) tv.push(ZC[i] - ZC[i - 1]);
  W.push({ sd5: sd(tv) * Math.sqrt(5), ym, entry: CAL[e],`);
// 4. stop-variant table + count of 36bp 5-session shocks, before the json write
rep(`out.dv01 = { ptsPerBp, worst5: worst, worst22, worst26, px };`,
`out.dv01 = { ptsPerBp, worst5: worst, worst22, worst26, px };
const stopBp = 2.5 / -ptsPerBp; let cAll = 0, c22 = 0, nAll = 0, n22 = 0;
for (let i = 5; i < TN.length; i += 5) { const d = (TN[i][4] - TN[i - 5][4]) * 100; nAll++; if (d >= stopBp) cAll++; if (TN[i][0].startsWith("2022")) { n22++; if (d >= stopBp) c22++; } }
console.log("   non-overlapping 5-session blocks with a 10y rise >= " + stopBp.toFixed(0) + " bp (= the stop at today's DV01): " + cAll + " of " + nAll + " since 1988 (" + (100 * cAll / nAll).toFixed(1) + "%); " + c22 + " of " + n22 + " in 2022 (" + (100 * c22 / n22).toFixed(1) + "%)");
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
console.log("   today's 5-session sd " + nowSd5.toFixed(2) + " pts -> 2.5 x sd stop would sit at " + (2.5 * nowSd5).toFixed(2) + " pts; 2022's 5-session sd " + out.vol["2022"].sd5.toFixed(2) + " -> " + (2.5 * out.vol["2022"].sd5).toFixed(2) + " pts");`);
fs.writeFileSync("zn-month-end-regimes.cjs", s); console.log("patched");
