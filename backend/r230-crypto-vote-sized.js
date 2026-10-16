#!/usr/bin/env node
/**
 * R230 — CRYPTO MULTI-LOOKBACK VOTE + INVERSE-VOL / VOL-TARGETED SIZING, historical holdout
 * (registered 2026-09-24 before this file ran; rule frozen in the registry — see r230-register.js).
 *   node backend/r230-crypto-vote-sized.js   -> data/r230-crypto-vote-sized.json; seals once if controls pass
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), CACHE = D("training/r230"); if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")), sealTests = seals.tests || seals; if (sealTests.R230) { console.error("R230 already sealed — refusing"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === "R230"); const BAR = E.bar.tRequired;

const UNIVERSE = ["BTC", "ETH", "LTC", "BCH", "LINK", "ADA", "SOL", "DOGE", "AVAX", "DOT", "UNI", "AAVE", "XTZ"];
const FETCH_START = "2018-01-01", FETCH_END = "2026-09-23"; // buffer well before holdout for SMA200 warm-up
const HOLDOUT_START = "2025-09-24", HOLDOUT_END = "2026-09-23";
const NS = [50, 100, 200], VOLLOOK = 20, VOLTARGET = 0.30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
function nw(a, L = 5) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * g / n; } return m / Math.sqrt(v / n); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function candles(coin) {
  const f = path.join(CACHE, `${coin}.json`);
  if (fs.existsSync(f)) { const cached = JSON.parse(fs.readFileSync(f, "utf8")); if (cached.length && cached[cached.length - 1].d >= FETCH_END) return cached; }
  let all = [], end = Date.parse(FETCH_END + "T00:00:00Z") + 864e5; const stop = Date.parse(FETCH_START + "T00:00:00Z") - 864e5;
  while (end > stop) { const s = Math.max(stop, end - 299 * 864e5); const r = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(end).toISOString()}`, { headers: { "User-Agent": "TRAIDS R230" } }); const a = await r.json(); if (!Array.isArray(a)) break; all.push(...a); if (!a.length && all.length) break; end = s - 864e5; await sleep(350); }
  const rows = [...new Map(all.map((x) => [x[0], x])).values()].sort((a, b) => a[0] - b[0]).map((x) => ({ d: new Date(x[0] * 1000).toISOString().slice(0, 10), c: x[4] })).filter((x) => x.d <= FETCH_END);
  fs.writeFileSync(f, JSON.stringify(rows)); return rows;
}

function stats(port, bench) {
  const mr = mean(port), mb = mean(bench); let cv = 0, vb = 0; for (let i = 0; i < port.length; i++) { cv += (port[i] - mr) * (bench[i] - mb); vb += (bench[i] - mb) ** 2; }
  const beta = vb ? cv / vb : 0, res = port.map((x, i) => x - beta * bench[i]);
  const curve = (a) => { let e = 1, pk = 1, dd = 0; for (const x of a) { e *= 1 + x; pk = Math.max(pk, e); dd = Math.min(dd, e / pk - 1); } return { final: e, dd }; };
  const p = curve(port), b = curve(bench), yrs = port.length / 365, sh = (a) => (mean(a) / Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)) || 1e-12)) * Math.sqrt(365);
  return { days: port.length, alphaAnnualPct: +(mean(res) * 365 * 100).toFixed(2), alphaT: +nw(res).toFixed(3), beta: +beta.toFixed(3), cagrPct: +((p.final ** (1 / yrs) - 1) * 100).toFixed(1), benchCagrPct: +((b.final ** (1 / yrs) - 1) * 100).toFixed(1), maxDDPct: +(p.dd * 100).toFixed(1), benchMaxDDPct: +(b.dd * 100).toFixed(1), sharpe: +sh(port).toFixed(2), benchSharpe: +sh(bench).toFixed(2) };
}

(async () => {
  const series = {};
  for (const c of UNIVERSE) { const rows = await candles(c); if (rows.length > 260) series[c] = rows; console.log(`  ${c} ${rows.length ? rows[0].d : "—"}..${rows.length ? rows[rows.length - 1].d : "—"} (${rows.length})`); }
  const idx = Object.fromEntries(Object.entries(series).map(([c, r]) => [c, new Map(r.map((x, i) => [x.d, i]))]));
  const allDays = [...new Set(Object.values(series).flatMap((r) => r.map((x) => x.d)))].sort();
  const holdoutDays = allDays.filter((d) => d >= HOLDOUT_START && d <= HOLDOUT_END);

  // --- signal: 2-of-3 SMA vote, per coin per index i (decided from close at i, applied to i->i+1 return) ---
  function voteOn(c, i, rows) {
    if (i < NS[NS.length - 1]) return false;
    let votes = 0; for (const N of NS) { let s = 0; for (let k = i - N + 1; k <= i; k++) s += rows[k].c; if (rows[i].c > s / N) votes++; }
    return votes >= 2;
  }
  // --- vol (20d stdev of daily log returns through close i), used for inverse-vol WEIGHTS ---
  function vol20(c, i, rows) {
    if (i < VOLLOOK) return null;
    const rets = []; for (let k = i - VOLLOOK + 1; k <= i; k++) rets.push(Math.log(rows[k].c / rows[k - 1].c));
    const s = std(rets); return s * Math.sqrt(365);
  }
  // --- portfolio-level vol estimate: apply TODAY's weights w to the trailing VOLLOOK days' actual coin
  //     returns (as-if held), take stdev of that hypothetical daily portfolio-return series. This is the
  //     realised vol "the weighted combination WOULD have had at weights w_c" (captures correlation,
  //     unlike a weighted-average-of-individual-vols proxy). ---
  function portfolioVolAt(eligible, w, d0) {
    if (!eligible.length) return null;
    const dailyRets = [];
    for (let o = 1; o <= VOLLOOK; o++) {
      let r = 0, ok = true;
      for (const c of eligible) {
        const i0 = idx[c].get(d0), rows = series[c];
        const iEnd = i0 - o + 1, iStart = i0 - o;
        if (iStart < 0) { ok = false; break; }
        r += w[c] * (rows[iEnd].c / rows[iStart].c - 1);
      }
      if (!ok) return null;
      dailyRets.push(r);
    }
    return std(dailyRets) * Math.sqrt(365);
  }

  function sizeDay(eligible) {
    const raw = {}; for (const c of eligible.list) raw[c] = eligible.rawInvVol[c];
    const sumRaw = eligible.list.reduce((s, c) => s + raw[c], 0);
    const w = {}; for (const c of eligible.list) w[c] = sumRaw ? raw[c] / sumRaw : 0;
    return w;
  }

  function eligibleAt(d0, voteFn) {
    const list = [], rawInvVol = {};
    for (const [c, rows] of Object.entries(series)) {
      const i0 = idx[c].get(d0); if (i0 == null) continue;
      if (voteFn(c, i0, rows)) { const v = vol20(c, i0, rows); if (v && v > 0) { list.push(c); rawInvVol[c] = 1 / v; } }
    }
    return { list, rawInvVol };
  }

  function run(costBps, voteFn) {
    const port = [], bench = [], k_series = []; let prevW = {};
    for (let di = 1; di < holdoutDays.length; di++) {
      const d0 = holdoutDays[di - 1], d1 = holdoutDays[di];
      const elig = eligibleAt(d0, voteFn), w = sizeDay(elig);
      const portVol = portfolioVolAt(elig.list, w, d0);
      const k = portVol && portVol > 0 ? Math.min(1, VOLTARGET / portVol) : (elig.list.length ? 1 : 0);
      k_series.push(k);
      let r = 0;
      for (const c of elig.list) {
        const i0 = idx[c].get(d0), i1 = idx[c].get(d1); if (i0 == null || i1 == null) continue;
        r += k * w[c] * (series[c][i1].c / series[c][i0].c - 1);
      }
      let turnover = 0; const allCoins = new Set([...Object.keys(prevW), ...elig.list]);
      for (const c of allCoins) { const now = elig.list.includes(c) ? k * w[c] : 0, before = prevW[c] || 0; turnover += Math.abs(now - before); }
      const cost = turnover * (costBps / 10000);
      port.push(r - cost);
      const i0b = idx.BTC.get(d0), i1b = idx.BTC.get(d1);
      bench.push(i0b != null && i1b != null ? series.BTC[i1b].c / series.BTC[i0b].c - 1 : 0);
      prevW = {}; for (const c of elig.list) prevW[c] = k * w[c];
    }
    return { port, bench, k_series };
  }

  const r25 = run(25, voteOn), r10 = run(10, voteOn), r50 = run(50, voteOn);
  const s25 = stats(r25.port, r25.bench), s10 = stats(r10.port, r10.bench), s50 = stats(r50.port, r50.bench);
  const avgK = mean(r25.k_series);

  // 13-coin equal-weight buy & hold benchmark (monthly rebalance)
  const ewPort = []; { let lastRebalMonth = null, weights = {};
    for (let di = 1; di < holdoutDays.length; di++) { const d0 = holdoutDays[di - 1], d1 = holdoutDays[di], month = d1.slice(0, 7);
      if (month !== lastRebalMonth) { const live = UNIVERSE.filter((c) => series[c] && idx[c].get(d0) != null); weights = Object.fromEntries(live.map((c) => [c, 1 / live.length])); lastRebalMonth = month; }
      let r = 0; for (const [c, wt] of Object.entries(weights)) { const i0 = idx[c].get(d0), i1 = idx[c].get(d1); if (i0 == null || i1 == null) continue; r += wt * (series[c][i1].c / series[c][i0].c - 1); } ewPort.push(r); } }
  const ewStats = stats(ewPort, r25.bench);

  // R191 plain rule replicated on same window/costs: N=50, BTC+ETH equal dollar, no vol sizing
  function r191Replica(costBps) {
    const port = []; const lastPos = { BTC: 0, ETH: 0 };
    for (let di = 1; di < holdoutDays.length; di++) { const d0 = holdoutDays[di - 1], d1 = holdoutDays[di]; let r = 0;
      for (const c of ["BTC", "ETH"]) { const rows = series[c], i0 = idx[c].get(d0), i1 = idx[c].get(d1); if (i0 == null || i1 == null || i0 < 50) continue;
        let s = 0; for (let k = i0 - 49; k <= i0; k++) s += rows[k].c; const pos = rows[i0].c > s / 50 ? 1 : 0;
        const sw = pos !== lastPos[c] ? costBps / 10000 : 0; lastPos[c] = pos;
        r += 0.5 * (pos * (rows[i1].c / rows[i0].c - 1) - sw); }
      port.push(r); }
    return port;
  }
  const r191port = r191Replica(25), r191stats = stats(r191port, r25.bench);

  // random-timing control: same eligible-fraction per coin, random blocks, rebuild full sizing
  const inMkt = {}; for (const [c, rows] of Object.entries(series)) { let on = 0, n = 0, runs = 0, prev = 0;
    for (let i = 200; i < rows.length; i++) { if (rows[i].d < HOLDOUT_START || rows[i].d > HOLDOUT_END) continue; const p = voteOn(c, i, rows) ? 1 : 0; on += p; n++; if (p && !prev) runs++; prev = p; }
    inMkt[c] = { frac: n ? on / n : 0, avgLen: runs ? on / runs : 1 }; }
  const draws = [];
  for (let trial = 0; trial < 200; trial++) {
    const rng = mulberry(230000 + trial), plan = {};
    for (const [c, rows] of Object.entries(series)) { const p = new Uint8Array(rows.length); const { frac, avgLen } = inMkt[c];
      for (let i = 0; i < rows.length;) { const on = rng() < frac; const len = Math.max(1, Math.round(-Math.log(1 - rng()) * (on ? avgLen : Math.max(1, avgLen * (1 - frac) / Math.max(frac, 1e-6)))));
        for (let j = i; j < Math.min(rows.length, i + len); j++) p[j] = on ? 1 : 0; i += len; } plan[c] = p; }
    const planVote = (c, i) => !!plan[c][i];
    const rr = run(25, planVote);
    draws.push(stats(rr.port, rr.bench).alphaAnnualPct);
  }
  draws.sort((a, b) => a - b); const rand95 = draws[Math.floor(0.95 * draws.length)];
  const beatsRandom = s25.alphaAnnualPct > rand95;

  // peek control: perfect-foresight vote (next-day return > 0), same sizing machinery
  const nextRetPositive = {};
  for (const [c, rows] of Object.entries(series)) { const m = new Map(); for (let i = 0; i < rows.length - 1; i++) m.set(rows[i].d, rows[i + 1].c > rows[i].c); nextRetPositive[c] = m; }
  const peekVote = (c, i, rows) => !!nextRetPositive[c].get(rows[i].d);
  const peekRes = run(25, peekVote), peekStats = stats(peekRes.port, peekRes.bench), peekOk = peekStats.alphaT >= BAR;

  const ddCutPts = +(s25.maxDDPct - s25.benchMaxDDPct).toFixed(1); // FIXED 2026-09-25 (was backwards): strategy minus benchmark, matches R190 convention
  const passes = peekOk && s25.alphaT >= BAR && beatsRandom && ddCutPts >= 15;
  const verdict = !peekOk
    ? `CONTROLS FAILED — peek t ${peekStats.alphaT}`
    : passes
      ? `PASS — alpha t ${s25.alphaT} >= ${BAR}, beats random timing (${s25.alphaAnnualPct}% vs random95 ${rand95.toFixed(2)}%), drawdown cut ${ddCutPts} pts`
      : `DID NOT PASS — alpha t ${s25.alphaT} vs ${BAR}${beatsRandom ? "" : " (fails random-timing control)"}; drawdown cut ${ddCutPts} pts vs BTC B&H`;

  const out = {
    spec: "r230-crypto-vote-sized-v1", test: "R230", ranAt: new Date().toISOString(),
    window: [HOLDOUT_START, HOLDOUT_END], coins: Object.keys(series), days: holdoutDays.length - 1,
    bar: BAR, avgExposureK: +avgK.toFixed(3),
    primary_cost25bps: s25, sensitivity_cost10bps: s10, sensitivity_cost50bps: s50,
    vsEqualWeightBH_13coin: ewStats,
    vsR191PlainRuleReplica: r191stats,
    randomTiming: { rand95AlphaPct: +rand95.toFixed(2), trueAlphaPct: s25.alphaAnnualPct, beatsRandom },
    controls: { peek: { alphaT: peekStats.alphaT, pass: peekOk } },
    ddCutPtsVsBTC: ddCutPts,
    verdict,
  };
  writeJsonAtomic(D("r230-crypto-vote-sized.json"), out);
  console.log(`R230: alpha ${s25.alphaAnnualPct}%/yr t ${s25.alphaT} | CAGR ${s25.cagrPct}% vs BTC B&H ${s25.benchCagrPct}% | maxDD ${s25.maxDDPct}% vs ${s25.benchMaxDDPct}% | Sharpe ${s25.sharpe} vs ${s25.benchSharpe} | avg exposure k=${avgK.toFixed(2)}`);
  console.log(`  vs 13-coin equal-weight B&H: CAGR ${ewStats.cagrPct}% maxDD ${ewStats.maxDDPct}% Sharpe ${ewStats.sharpe}`);
  console.log(`  vs R191 plain-50-day replica: CAGR ${r191stats.cagrPct}% maxDD ${r191stats.maxDDPct}% Sharpe ${r191stats.sharpe}`);
  console.log(verdict);

  if (!peekOk) { console.error("controls failed — NOT sealed"); process.exit(3); }
  sealTests.R230 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "days", verdict };
  writeJsonAtomic(D("read-seals.json"), seals);
  E.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict;
  reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R230", verdict }) + "\n");
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
