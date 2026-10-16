#!/usr/bin/env node
/**
 * R189 — ALPHAINSIDER CRYPTO ENSEMBLE vs A TEXTBOOK TREND RULE (registered 2026-09-24; frozen rule/statistic/bar/controls in
 * data/test-registry.json -> preregistered R189). Paper research only: no orders, no broker calls.
 *
 * Built ONLY from R187's VERIFIED translations (data/r187-ai-crypto-scripts.json -> verified; >= 80% trade-log match), used
 * exactly as translated in backend/r187-ai-crypto-scripts.js (imported, unchanged, at the timeframe each was verified on).
 * No refitting; an R187-excluded script stays out. With fewer than 2 verified scripts this reports "cannot build" and never seals.
 *
 * IMPLEMENTATION NOTES (written before any number was computed; none chosen on results):
 *  N1 WINDOW. UTC days 2021-01-01 .. 2025-09-23; Coinbase candles (R187's files); script positions carried in from warm-up.
 *     Two scripts were published inside the window (DMI/DPO 2021-05-02, Triple Threat 2022-03-15): their pre-publication days
 *     are in-sample for the author — the registry fixes this window, so it is kept and disclosed.
 *  N2 E1. Each verified script trades its own asset at 1.0x exposure (the script's own long/short/flat logic; the 1.5x in R187
 *     was AlphaInsider's account leverage, not the script) so E1 is comparable with E2 and both benchmarks, which are 1x by rule.
 *     Capital equal across scripts, rebalanced daily (daily return = mean of the sleeves' daily net returns).
 *  N3 E2. Per asset, a script is "long at the bar close" of day d if its position after every fill at or before the next open
 *     (00:00 UTC of d+1) is long — i.e. signals decided by that close. Strict majority of that asset's verified scripts long ->
 *     long 100% of that asset's half on day d+1 (open to close), else cash. BTC has 3 scripts (>= 2 long), ETH 2 (both long).
 *  N4 BENCHMARKS. TEXTBOOK TREND per asset: long on day d+1 when day d's close > SMA(100) of daily closes, else cash; 50/50,
 *     rebalanced daily. 50/50 BUY-AND-HOLD: weights reset to 50/50 on each month's first day (10 bps on the turnover).
 *     Costs: 10 bps per side on every position change (sleeves, E2, trend).
 *  N5 STATISTIC. Primary: daily (ensemble - textbook trend) net return, Newey-West (Bartlett, lag 5) t of its mean. Bar 1.949
 *     (best of 2). Context: alpha vs 50/50 B&H (OLS intercept x 365, NW t), CAGR, max drawdown, Sharpe (daily mean/sd x sqrt365),
 *     time in market (share of days with any exposure) and mean gross exposure — for E1, E2 and both benchmarks.
 *  N6 CONTROLS. randomTiming: for every verified script, its window position path is cut into runs (trades and flat spells),
 *     the runs shuffled into random order (seeded; 200 draws — R187's construction), E1/E2 rebuilt from the shuffled paths and
 *     the primary t recomputed; an ensemble must beat its draws' 95th percentile. The control PASSES when the draws' median t is
 *     below the bar (random timing does not manufacture a pass). peek: perfect-foresight long/flat, 50/50, long on days the asset
 *     closes up; its primary t must clear the bar. Verdict PASS only for an ensemble with t >= bar AND t > random p95.
 *
 *   node backend/r189-ai-crypto-ensemble.js          read + seal (seals only if controls pass and >= 2 scripts verified)
 *   node backend/r189-ai-crypto-ensemble.js --dry    everything except the registry / seal / ledger writes
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const R = require("./r187-ai-crypto-scripts.js");            // guarded module: requiring it runs nothing
const D = (f) => path.join(__dirname, "data", f);
const OUT = D("r189-ai-crypto-ensemble.json"), FROM = "2021-01-01", TO = "2025-09-23", BAR = 1.949, DRAWS = 200, COST = R.COST;
const DRY = process.argv.includes("--dry");

function nwMeanT(a, lag = 5) { const n = a.length, m = a.reduce((s, x) => s + x, 0) / n, d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n;
  for (let l = 1; l <= lag; l++) { let c = 0; for (let i = l; i < n; i++) c += d[i] * d[i - l]; v += 2 * (1 - l / (lag + 1)) * c / n; } return v > 0 ? m / Math.sqrt(v / n) : 0; }
function metrics(days, r, expo) {
  let eq = 1, pk = 1, mdd = 0; for (const x of r) { eq *= 1 + x; pk = Math.max(pk, eq); mdd = Math.max(mdd, 1 - eq / pk); }
  const n = r.length, m = r.reduce((s, x) => s + x, 0) / n, sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  return { days: n, cagrPct: +(100 * (eq ** (365 / n) - 1)).toFixed(2), totalPct: +(100 * (eq - 1)).toFixed(1), maxDDPct: +(100 * mdd).toFixed(1), sharpe: +(m / sd * Math.sqrt(365)).toFixed(3),
    timeInMarketPct: +(100 * expo.filter((x) => x > 0).length / n).toFixed(1), meanGrossExposure: +(expo.reduce((s, x) => s + x, 0) / n).toFixed(3) };
}
// side of the script at the close of each day (N3): last event whose fill time <= next day's 00:00
function sideAtClose(bars, events, days, startSide = 0) {
  const es = [...events].sort((a, b) => a.i - b.i), out = new Map(); let k = 0, s = startSide;
  for (const d of days) { const lim = Date.parse(d) / 1000 + 86400; while (k < es.length && bars[es[k].i].ts <= lim) s = es[k++].side; out.set(d, s); }
  return out;
}
const pathEvents = (bars, i0, runs) => { const ev = []; let i = i0, p = 0; for (const r of runs) { if (r.side !== p) ev.push({ i, px: bars[i].o, side: r.side }); p = r.side; i += r.len; } return ev; };

(async () => {
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), T = reg.preregistered.find((x) => x.id === "R189");
  if (!T) { console.error("R189 not registered"); process.exit(2); }
  if (T.bar.tRequired !== BAR) { console.error(`bar mismatch: registry ${T.bar.tRequired} vs script ${BAR}`); process.exit(2); }
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R189) { console.error("R189 already sealed — refusing"); process.exit(2); }
  const r187 = JSON.parse(fs.readFileSync(D("r187-ai-crypto-scripts.json"), "utf8"));
  if (!seals.tests.R187) { console.error("R187 not sealed — R189 waits for R187's gate"); process.exit(2); }
  const ver = r187.scripts.filter((s) => s.gate.pass);
  if (ver.length < 2) { writeJsonAtomic(OUT, { spec: "r189-read-v1", asOf: new Date().toISOString(), verdict: "cannot build", verified: ver.map((s) => s.id) }); console.log("R189 cannot build (<2 verified scripts)"); return; }
  const H = { BTC: await R.hourly("BTC"), ETH: await R.hourly("ETH") }, daily = { BTC: R.agg(H.BTC, 24), ETH: R.agg(H.ETH, 24) };
  const ad = { BTC: R.assetDays(daily.BTC, FROM, TO), ETH: R.assetDays(daily.ETH, FROM, TO) };
  const sleeves = ver.map((v) => { const S = R.SCRIPTS.find((x) => x.id === v.id), bars = R.agg(H[S.asset], R.TF[v.gate.timeframe]), ev = S.run(bars); return { id: v.id, name: S.name, asset: S.asset, tf: v.gate.timeframe, bars, ev }; });
  const days = [...ad.BTC.keys()].filter((d) => ad.ETH.has(d)).sort();
  // textbook trend + B&H (N4)
  const trendPos = (asset) => { const b = daily[asset], c = b.map((x) => x.c), m = new Map(); for (let i = 100; i < b.length; i++) { let s = 0; for (let k = 0; k < 100; k++) s += c[i - k]; m.set(R.dayOf(b[i].ts + 86400), c[i] > s / 100 ? 1 : 0); } return m; };
  const tp = { BTC: trendPos("BTC"), ETH: trendPos("ETH") };
  const longCash = (posMap, asset) => { let prev = null; return days.map((d) => { const p = posMap.get(d) ?? 0, c = prev == null ? 0 : COST * Math.abs(p - prev); prev = p; return p * ad[asset].get(d) - c; }); };
  const trendR = { BTC: longCash(tp.BTC, "BTC"), ETH: longCash(tp.ETH, "ETH") }, trend = days.map((d, i) => 0.5 * trendR.BTC[i] + 0.5 * trendR.ETH[i]);
  const trendExpo = days.map((d) => 0.5 * (tp.BTC.get(d) ?? 0) + 0.5 * (tp.ETH.get(d) ?? 0));
  let wB = 0.5, wE = 0.5; const bh = days.map((d, i) => { let c = 0; if (i === 0 || d.slice(8) === "01") { c = COST * (Math.abs(0.5 - wB) + Math.abs(0.5 - wE)) * (i ? 1 : 0); wB = 0.5; wE = 0.5; }
    const rB = ad.BTC.get(d), rE = ad.ETH.get(d), r = wB * rB + wE * rE; wB = wB * (1 + rB) / (1 + r); wE = wE * (1 + rE) / (1 + r); return r - c; });
  // ensembles from a set of per-sleeve event lists
  const build = (evs, startSides) => {
    const sl = sleeves.map((s, k) => { const dm = R.account(s.bars, evs[k], 1, FROM, TO, startSides ? startSides[k] : null); return days.map((d) => dm.get(d) ?? 0); });
    const e1 = days.map((d, i) => sl.reduce((a, r) => a + r[i], 0) / sl.length);
    const sides = sleeves.map((s, k) => sideAtClose(s.bars, evs[k], ["2020-12-31", ...days], startSides ? startSides[k] : 0));
    const vote = (asset) => { const idx = sleeves.map((s, k) => (s.asset === asset ? k : -1)).filter((k) => k >= 0), m = new Map(); if (!idx.length) return null;
      ["2020-12-31", ...days].forEach((d) => { const longs = idx.filter((k) => sides[k].get(d) === 1).length; m.set(R.dayOf(Date.parse(d) / 1000 + 86400), longs * 2 > idx.length ? 1 : 0); }); return m; };
    const vB = vote("BTC"), vE = vote("ETH"), assets = [vB && "BTC", vE && "ETH"].filter(Boolean);
    const e2parts = { BTC: vB && longCash(vB, "BTC"), ETH: vE && longCash(vE, "ETH") }, e2 = days.map((d, i) => assets.reduce((a, x) => a + e2parts[x][i], 0) / assets.length);
    const e1Expo = days.map((d) => sides.reduce((a, s) => a + Math.abs(s.get(R.dayOf(Date.parse(d) / 1000 - 86400)) ?? 0), 0) / sides.length);
    const e2Expo = days.map((d) => assets.reduce((a, x) => a + ((x === "BTC" ? vB : vE).get(d) ?? 0), 0) / assets.length);
    return { e1, e2, e1Expo, e2Expo };
  };
  const real = build(sleeves.map((s) => s.ev), null);
  const primary = (r) => nwMeanT(r.map((x, i) => x - trend[i]));
  const vsBH = (r) => { const o = R.olsNW(r, bh); return { alphaAnnPct: +(100 * o.alphaAnn).toFixed(2), beta: +o.beta.toFixed(3), tNW: +o.t.toFixed(3) }; };
  const block = (r, expo) => ({ ...metrics(days, r, expo), vsTrend: { meanDiffPctPerYear: +(100 * 365 * r.reduce((s, x, i) => s + x - trend[i], 0) / r.length).toFixed(2), tNW: +primary(r).toFixed(3) }, vsBuyHold: vsBH(r) });
  const res = { E1: block(real.e1, real.e1Expo), E2: block(real.e2, real.e2Expo), TEXTBOOK_TREND: { ...metrics(days, trend, trendExpo), vsBuyHold: vsBH(trend) }, BUY_HOLD_5050: metrics(days, bh, days.map(() => 1)) };
  // controls (N6)
  const rng = R.mulberry(1890000), dr = { E1: [], E2: [] }, win = sleeves.map((s) => R.runsIn(s.bars, s.ev, FROM, TO));
  for (let z = 0; z < DRAWS; z++) { const evs = win.map((w, k) => pathEvents(sleeves[k].bars, w.i0, w.runs.map((r) => ({ ...r, key: rng() })).sort((x, y) => x.key - y.key)));
    const b = build(evs, sleeves.map(() => 0)); dr.E1.push(primary(b.e1)); dr.E2.push(primary(b.e2)); }
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3); };
  const rand = { E1: { p95: q(dr.E1, 0.95), median: q(dr.E1, 0.5) }, E2: { p95: q(dr.E2, 0.95), median: q(dr.E2, 0.5) } };
  const peekR = days.map((d) => 0.5 * Math.max(0, ad.BTC.get(d)) + 0.5 * Math.max(0, ad.ETH.get(d))), peekT = +primary(peekR).toFixed(3);
  const ctl = { randomTiming: { draws: DRAWS, ...rand, pass: rand.E1.median < BAR && rand.E2.median < BAR }, peek: { tNW: peekT, pass: peekT >= BAR, note: "foresight long/flat 50/50, no cost charged (an upper-bound detector check)" } };
  ctl.pass = ctl.randomTiming.pass && ctl.peek.pass;
  const clears = ["E1", "E2"].filter((k) => res[k].vsTrend.tNW >= BAR && res[k].vsTrend.tNW > rand[k].p95), verdict = clears.length ? "PASS" : "DID NOT PASS";
  const tb = res.TEXTBOOK_TREND, bhm = res.BUY_HOLD_5050, ddAdv = +(bhm.maxDDPct - tb.maxDDPct).toFixed(1);
  const line = `${verdict}${clears.length ? ` (${clears.join(", ")})` : ""} — ${sleeves.length} verified scripts, ${days.length} days ${days[0]}..${days[days.length - 1]}: E1 vs textbook trend t ${res.E1.vsTrend.tNW} (random p95 ${rand.E1.p95}), E2 t ${res.E2.vsTrend.tNW} (random p95 ${rand.E2.p95}) vs bar ${BAR}; CAGR E1 ${res.E1.cagrPct}% E2 ${res.E2.cagrPct}% trend ${tb.cagrPct}% B&H ${bhm.cagrPct}%; maxDD E1 ${res.E1.maxDDPct}% E2 ${res.E2.maxDDPct}% trend ${tb.maxDDPct}% B&H ${bhm.maxDDPct}%`;
  console.log(`R189 ${line}`); console.log(`  controls: random median t E1 ${rand.E1.median} E2 ${rand.E2.median} · peek t ${peekT} -> ${ctl.pass ? "PASS" : "FAIL"}`);
  for (const [k, v] of Object.entries(res)) console.log(`  ${k.padEnd(15)} ${JSON.stringify(v)}`);
  const out = { spec: "r189-read-v1", asOf: new Date().toISOString(), bar: BAR, window: [FROM, TO], costPerSide: COST, sleeves: sleeves.map(({ id, name, asset, tf }) => ({ id, name, asset, tf })), results: res, controls: ctl, verdict, verdictLine: line,
    textbookDrawdownFinding: { maxDDTrendPct: tb.maxDDPct, maxDDBuyHoldPct: bhm.maxDDPct, advantagePts: ddAdv, sharpeTrend: tb.sharpe, sharpeBuyHold: bhm.sharpe }, sealed: false };
  if (ctl.pass && !DRY) {
    const day = new Date().toISOString().slice(0, 10);
    seals.tests.R189 = { sealedOn: day, unit: "days 2021-01-01..2025-09-23 (ensemble minus textbook trend, daily)", verdict: line, file: "r189-ai-crypto-ensemble.json" }; writeJsonAtomic(D("read-seals.json"), seals);
    T.status = `READ ${day} — ${line}`; writeJsonAtomic(D("test-registry.json"), reg);
    fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R189", verdict: line }) + "\n");
    out.sealed = true;
  } else if (!ctl.pass) console.log("R189 controls FAIL — not sealed");
  writeJsonAtomic(OUT, out);
})().catch((e) => { console.error("R189 FAILED:", e.stack || e.message); process.exit(1); });
