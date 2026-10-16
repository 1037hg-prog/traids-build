#!/usr/bin/env node
/**
 * trend-lag.cjs — MEASURES (not a test; known allocation rule, operator 09-25) three things for the Dalio plan, read-only:
 *  A. FLIP THRESHOLDS for the 10-30 month-end: the Plan E 10-month rule (book-etf-rebalancer.js: IN iff month-end close > mean of the last
 *     10 month-end closes INCLUDING the current one) flips at P* = mean of the last 9 completed month-end closes. Data: Alpaca SIP daily,
 *     adjustment=all (the rebalancer's own source, lib/alpaca-bars.js), through the last completed session.
 *  B. LAG of that monthly rule in past busts, QQQ from 1999-03 and SPY from 1993: daily adjClose from the local Yahoo proxy (:3002).
 *     Out = cash at 0% (T-bills omitted: understates the rule). For each OUT switch: prior peak, exit close, loss already taken at exit.
 *     Per episode: buy-and-hold max drawdown vs the rule's max drawdown (daily closes).
 *  C. ZN PROXY in rising-rate vs crash months: IEF (Alpaca SIP, adjustment=all) over R219's window = close of the 6th-to-last session to the
 *     last session's close (5 daily returns); per year n / mean / worst window / worst in-window dip; and the windows of named stress months.
 */
const path = require("path");
const B = "C:/Users/joshc/Downloads/traids (2)/traids-bundle/backend";
process.chdir(B); require(path.join(B, "node_modules/dotenv")).config({ path: path.join(B, ".env") });
const { fetchBars } = require(path.join(B, "lib/alpaca-bars.js"));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (x, d = 1) => (x >= 0 ? "+" : "") + (100 * x).toFixed(d) + "%";

function monthEnds(series) { const me = new Map(); for (const [d, c] of series) me.set(d.slice(0, 7), [d, c]); return [...me.values()]; }

function trendRule(series, label) {
  // series: [[date, close]] ascending. Signal at each month-end close; position applies from the next session.
  const me = monthEnds(series), sigByMonth = new Map();
  for (let i = 9; i < me.length; i++) { const avg = mean(me.slice(i - 9, i + 1).map((x) => x[1])); sigByMonth.set(me[i][0], me[i][1] > avg); }
  let pos = null, nav = 1, bh = 1, navPk = 1, bhPk = 1, ddRule = 0, ddBH = 0, peakClose = 0, lastEntryPx = null; const switches = [], daily = [];
  const meSet = new Set(me.map((x) => x[0]));
  for (let i = 1; i < series.length; i++) {
    const [d, c] = series[i], [, p] = series[i - 1], r = c / p - 1;
    peakClose = Math.max(peakClose, p);
    if (pos !== null) { nav *= 1 + (pos ? r : 0); bh *= 1 + r; navPk = Math.max(navPk, nav); bhPk = Math.max(bhPk, bh); ddRule = Math.min(ddRule, nav / navPk - 1); ddBH = Math.min(ddBH, bh / bhPk - 1); daily.push({ d, nav, bh }); }
    if (meSet.has(d) && sigByMonth.has(d)) {
      const on = sigByMonth.get(d);
      if (pos === null) { pos = on; lastEntryPx = on ? c : null; peakClose = c; }
      else if (on !== pos) {
        const peak = Math.max(peakClose, c);
        switches.push({ d, to: on ? "IN" : "OUT", close: +c.toFixed(2), lossFromPeakAtExit: on ? null : c / peak - 1, reentryVsExit: null });
        if (on && switches.length >= 2) { const ex = switches[switches.length - 2]; if (ex.to === "OUT") switches[switches.length - 1].reentryVsExit = c / ex.close - 1; }
        if (on) peakClose = c;   // the loss is measured from the highest close SINCE THE LAST ENTRY (the rule's own holding)
        pos = on;
      }
    }
  }
  return { label, switches, ddRule, ddBH, daily, from: series[0][0], to: series[series.length - 1][0], start: sigByMonth.keys().next().value };
}
function episode(daily, from, to) {
  const w = daily.filter((x) => x.d >= from && x.d <= to); if (w.length < 2) return null;
  let a = w[0].nav, b = w[0].bh, pa = a, pb = b, da = 0, db = 0;
  for (const x of w) { pa = Math.max(pa, x.nav); pb = Math.max(pb, x.bh); da = Math.min(da, x.nav / pa - 1); db = Math.min(db, x.bh / pb - 1); }
  return { rule: da, bh: db, ruleRet: w[w.length - 1].nav / w[0].nav - 1, bhRet: w[w.length - 1].bh / w[0].bh - 1 };
}

(async () => {
  console.log(`TREND-LAG / FLIP / ZN-PROXY MEASUREMENT — run ${new Date().toISOString()}`);

  // ── A. flip thresholds ───────────────────────────────────────────────
  const endIso = new Date(Date.now() - 20 * 60e3).toISOString();
  const r = await fetchBars(["QQQ", "SPY", "GLD", "EFA", "IEF"], { start: "2016-01-01", end: endIso, feed: "sip", adjustment: "all", quiet: true });
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  console.log(`\nA. FLIP THRESHOLDS for the 2026-10-30 month-end (Alpaca SIP adjustment=all; bars through ${endIso}; only sessions before ${today} used)`);
  for (const s of ["QQQ", "SPY", "EFA", "GLD"]) {
    const bars = r.bars[s].filter((b) => b.t.slice(0, 10) < today);
    const ser = bars.map((b) => [b.t.slice(0, 10), b.c]); const me = monthEnds(ser).filter((x) => x[0].slice(0, 7) < today.slice(0, 7));
    const last9 = me.slice(-9), thr = mean(last9.map((x) => x[1])), last = ser[ser.length - 1];
    const sepAvg10 = mean(me.slice(-10).map((x) => x[1])), sepClose = me[me.length - 1][1];
    console.log(`  ${s.padEnd(4)} Sep-30 close ${sepClose.toFixed(2)} vs its 10-mo avg ${sepAvg10.toFixed(2)} (${pct(sepClose / sepAvg10 - 1)}) -> ${sepClose > sepAvg10 ? "IN" : "OUT"} now`);
    console.log(`       10-30 flip level P* = mean of 9 month-ends ${last9[0][0]}..${last9[8][0]} = ${thr.toFixed(2)}; last close ${last[0]} ${last[1].toFixed(2)} -> ${sepClose > sepAvg10 ? "goes OUT only if it closes 10-30 below P*, i.e. " + pct(thr / last[1] - 1) + " from here" : "comes IN only if it closes 10-30 above P*, i.e. " + pct(thr / last[1] - 1) + " from here"}`);
  }

  // ── B. lag in past busts ─────────────────────────────────────────────
  console.log(`\nB. LAG OF THE MONTHLY 10-MONTH RULE IN PAST BUSTS (Yahoo proxy :3002 daily adjClose; out = 0% cash)`);
  const EPIS = [["dot-com 2000-03..2002-10", "2000-03-01", "2002-10-31"], ["GFC 2007-10..2009-03", "2007-10-01", "2009-03-31"], ["2011 Aug", "2011-04-01", "2011-12-31"], ["2015-16", "2015-05-01", "2016-03-31"], ["2018 Q4", "2018-09-01", "2018-12-31"], ["COVID 2020-02..03", "2020-02-01", "2020-04-30"], ["2022 rate bust", "2022-01-01", "2022-12-31"], ["2025 Feb-Apr", "2025-02-01", "2025-05-31"]];
  for (const s of ["QQQ", "SPY"]) {
    const j = await (await fetch(`http://localhost:3002/api/yahoo/${s}/history?days=12500&interval=1d`)).json();
    const ser = j.bars.filter((b) => Number.isFinite(b.adjClose) && b.date < today).map((b) => [b.date.slice(0, 10), b.adjClose]);
    const t = trendRule(ser, s);
    console.log(`  ${s}: ${ser.length} sessions ${t.from}..${t.to}; first signal ${t.start}; full-period max DD rule ${pct(t.ddRule)} vs buy-and-hold ${pct(t.ddBH)} (rule measured from its first signal)`);
    const outs = t.switches.filter((x) => x.to === "OUT"), ins = t.switches.filter((x) => x.to === "IN");
    const whip = ins.filter((x) => x.reentryVsExit != null && x.reentryVsExit > 0);
    console.log(`    switches ${t.switches.length} (${outs.length} OUT / ${ins.length} IN) over ${((Date.parse(t.to) - Date.parse(t.start)) / 3.156e10).toFixed(1)} yrs; re-entries ABOVE the prior exit price (whipsaw cost) ${whip.length} of ${ins.length}, median ${whip.length ? pct(whip.map((x) => x.reentryVsExit).sort((a, b) => a - b)[Math.floor(whip.length / 2)]) : "-"}`);
    const outsLoss = outs.map((x) => x.lossFromPeakAtExit).sort((a, b) => a - b);
    console.log(`    loss from the highest close since the last IN switch, ALREADY TAKEN at each OUT month-end: median ${pct(outsLoss[Math.floor(outsLoss.length / 2)])}, worst ${pct(outsLoss[0])}`);
    for (const [name, a, b] of EPIS) { const e = episode(t.daily, a, b); if (!e) continue; const o = outs.filter((x) => x.d >= a && x.d <= b); console.log(`    ${name.padEnd(26)} max DD: rule ${pct(e.rule).padStart(7)} vs B&H ${pct(e.bh).padStart(7)} · return rule ${pct(e.ruleRet).padStart(7)} vs B&H ${pct(e.bhRet).padStart(7)} · OUT at ${o.map((x) => `${x.d} (already ${pct(x.lossFromPeakAtExit)} off peak)`).join(", ") || "none in window"}`); }
  }

  // ── C. IEF month-end windows by year, and in stress months ───────────
  console.log(`\nC. IEF OVER R219's MONTH-END WINDOW (6th-to-last close -> last close; Alpaca SIP adjustment=all; ZN-on-IEF beta 0.79 is risk-manager.js's, not used here)`);
  const ief = r.bars.IEF.map((b) => [b.t.slice(0, 10), b.c]).filter(([d]) => d < today);
  const byM = {}; ief.forEach(([d, c], i) => (byM[d.slice(0, 7)] = byM[d.slice(0, 7)] || []).push(i));
  const thisM = today.slice(0, 7), wins = [];
  for (const [m, idx] of Object.entries(byM)) { if (m >= thisM || idx.length < 6) continue; const i0 = idx[idx.length - 6], i1 = idx[idx.length - 1]; let mn = 0; for (let k = i0 + 1; k <= i1; k++) mn = Math.min(mn, ief[k][1] / ief[i0][1] - 1); wins.push({ m, ret: ief[i1][1] / ief[i0][1] - 1, dip: mn }); }
  const byY = {}; for (const w of wins) (byY[w.m.slice(0, 4)] = byY[w.m.slice(0, 4)] || []).push(w);
  for (const [y, ws] of Object.entries(byY)) { const rets = ws.map((w) => w.ret); const worst = ws.reduce((a, b) => (b.ret < a.ret ? b : a)); const dip = ws.reduce((a, b) => (b.dip < a.dip ? b : a)); console.log(`  ${y}: n ${ws.length} · mean ${pct(mean(rets), 2)} · positive ${ws.filter((w) => w.ret > 0).length}/${ws.length} · worst ${worst.m} ${pct(worst.ret, 2)} · worst in-window dip ${dip.m} ${pct(dip.dip, 2)}`); }
  const all = wins.map((w) => w.ret), sd = Math.sqrt(all.reduce((x, v) => x + (v - mean(all)) ** 2, 0) / (all.length - 1));
  console.log(`  all ${wins[0].m}..${wins[wins.length - 1].m}: n ${all.length} · mean ${pct(mean(all), 3)} · t ${(mean(all) / (sd / Math.sqrt(all.length))).toFixed(2)} (gross, no cost, no baseline subtraction — NOT R180's statistic)`);
  const STRESS = ["2018-10", "2018-12", "2020-02", "2020-03", "2022-04", "2022-06", "2022-09", "2025-03", "2025-04"];
  console.log(`  stress months: ${STRESS.map((m) => { const w = wins.find((x) => x.m === m); return w ? `${m} ${pct(w.ret, 2)} (dip ${pct(w.dip, 2)})` : `${m} n/a`; }).join(" · ")}`);
})().catch((e) => { console.error("trend-lag FAILED:", e.stack); process.exit(1); });
