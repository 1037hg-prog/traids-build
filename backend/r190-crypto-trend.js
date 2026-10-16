#!/usr/bin/env node
/**
 * R190 — CRYPTO TREND FILTER ACROSS COINS, ETH EXCLUDED (registered 2026-09-24 before this file ran; rule frozen in the registry).
 * Per coin: position for day d+1 = 1 if close(d) > SMA_N(close through d), else 0 (cash at 0%). Equal-weight across coins trading that day,
 * daily rebalanced, vs equal-weight buy-and-hold of the same coins. Costs 25 bps per side on each switch (10 bps reported). Coinbase daily.
 *   node backend/r190-crypto-trend.js     -> data/r190-crypto-trend.json; seals once if the controls pass
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), CACHE = D("training/r190"); if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")), sealTests = seals.tests || seals; if (sealTests.R190) { console.error("R190 already sealed — refusing"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === "R190"); const BAR = E.bar.tRequired;
const COINS = ["BTC", "LTC", "BCH", "ETC", "LINK", "XLM", "ADA", "SOL", "DOGE", "AVAX", "DOT", "ATOM", "UNI", "AAVE", "XTZ", "ALGO"];
const START = "2018-01-01", END = "2025-09-23", NS = [50, 100, 200];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function nw(a, L = 5) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * g / n; } return m / Math.sqrt(v / n); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
async function candles(coin) {
  const f = path.join(CACHE, `${coin}.json`); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  let all = [], end = Date.parse(END + "T00:00:00Z") + 864e5; const stop = Date.parse("2016-06-01T00:00:00Z");
  while (end > stop) { const s = Math.max(stop, end - 299 * 864e5); const r = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(end).toISOString()}`, { headers: { "User-Agent": "TRAIDS R190" } }); const a = await r.json(); if (!Array.isArray(a)) break; all.push(...a); if (!a.length && all.length) break; end = s - 864e5; await sleep(350); }
  const rows = [...new Map(all.map((x) => [x[0], x])).values()].sort((a, b) => a[0] - b[0]).map((x) => ({ d: new Date(x[0] * 1000).toISOString().slice(0, 10), c: x[4] }));
  fs.writeFileSync(f, JSON.stringify(rows)); return rows;
}
function stats(port, bench) {
  const mr = mean(port), mb = mean(bench); let cv = 0, vb = 0; for (let i = 0; i < port.length; i++) { cv += (port[i] - mr) * (bench[i] - mb); vb += (bench[i] - mb) ** 2; }
  const beta = cv / vb, res = port.map((x, i) => x - beta * bench[i]);
  const curve = (a) => { let e = 1, pk = 1, dd = 0; for (const x of a) { e *= 1 + x; pk = Math.max(pk, e); dd = Math.min(dd, e / pk - 1); } return { final: e, dd }; };
  const p = curve(port), b = curve(bench), yrs = port.length / 365, sh = (a) => (mean(a) / Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)))) * Math.sqrt(365);
  return { days: port.length, alphaAnnualPct: +(mean(res) * 365 * 100).toFixed(2), alphaT: +nw(res).toFixed(3), beta: +beta.toFixed(3), cagrPct: +((p.final ** (1 / yrs) - 1) * 100).toFixed(1), benchCagrPct: +((b.final ** (1 / yrs) - 1) * 100).toFixed(1), maxDDPct: +(p.dd * 100).toFixed(1), benchMaxDDPct: +(b.dd * 100).toFixed(1), sharpe: +sh(port).toFixed(2), benchSharpe: +sh(bench).toFixed(2) };
}
(async () => {
  const series = {}; for (const c of COINS) { const rows = await candles(c); if (rows.length > 60) series[c] = rows; console.log(`  ${c} ${rows.length ? rows[0].d : "—"}..${rows.length ? rows[rows.length - 1].d : "—"} (${rows.length})`); }
  const days = [...new Set(Object.values(series).flatMap((r) => r.map((x) => x.d)))].filter((d) => d >= START && d <= END).sort();
  function run(N, cost, posFn) {   // posFn(coin, i, rows) -> 0/1 position for day i (decided on day i-1's close)
    const port = [], bench = [], perCoin = {}; const idx = Object.fromEntries(Object.entries(series).map(([c, r]) => [c, new Map(r.map((x, i) => [x.d, i]))]));
    const lastPos = {};
    for (const d of days) {
      const rs = [], bs = [];
      for (const [c, rows] of Object.entries(series)) {
        const i = idx[c].get(d); if (i == null || i < N + 1) continue;
        const ret = rows[i].c / rows[i - 1].c - 1, pos = posFn(c, i, rows, N);
        const sw = lastPos[c] != null && pos !== lastPos[c] ? cost : 0; lastPos[c] = pos;
        const r = pos * ret - sw; rs.push(r); bs.push(ret); (perCoin[c] = perCoin[c] || { p: [], b: [] }).p.push(r); perCoin[c].b.push(ret);
      }
      if (rs.length) { port.push(mean(rs)); bench.push(mean(bs)); }
    }
    return { port, bench, perCoin };
  }
  const trend = (c, i, rows, N) => { let s = 0; for (let k = i - N; k < i; k++) s += rows[k].c; return rows[i - 1].c > s / N ? 1 : 0; };
  const results = {};
  for (const N of NS) {
    const r25 = run(N, 0.0025, trend), r10 = run(N, 0.001, trend), s = stats(r25.port, r25.bench);
    const coinTbl = Object.fromEntries(Object.entries(r25.perCoin).map(([c, v]) => { const st = stats(v.p, v.b); return [c, { days: st.days, alphaT: st.alphaT, alphaPct: st.alphaAnnualPct, dd: st.maxDDPct, bhDD: st.benchMaxDDPct }]; }));
    // random-timing control: same in-market fraction per coin, random blocks of the same mean length
    const inMkt = {}; for (const [c, rows] of Object.entries(series)) { let on = 0, n = 0, runs = 0, prev = 0; for (let i = N + 1; i < rows.length; i++) { if (rows[i].d < START || rows[i].d > END) continue; const p = trend(c, i, rows, N); on += p; n++; if (p && !prev) runs++; prev = p; } inMkt[c] = { frac: n ? on / n : 0, avgLen: runs ? on / runs : 1 }; }
    const draws = [];
    for (let k = 0; k < 200; k++) {
      const rng = mulberry(190 * 1000 + N * 7 + k), plan = {};
      for (const [c, rows] of Object.entries(series)) { const p = new Uint8Array(rows.length); const { frac, avgLen } = inMkt[c]; for (let i = 0; i < rows.length;) { const on = rng() < frac; const len = Math.max(1, Math.round(-Math.log(1 - rng()) * (on ? avgLen : Math.max(1, avgLen * (1 - frac) / Math.max(frac, 1e-6))))); for (let j = i; j < Math.min(rows.length, i + len); j++) p[j] = on ? 1 : 0; i += len; } plan[c] = p; }
      const rr = run(N, 0.0025, (c, i) => plan[c][i]); draws.push(stats(rr.port, rr.bench).alphaAnnualPct);
    }
    draws.sort((a, b) => a - b); const rand95 = draws[Math.floor(0.95 * draws.length)];
    results[N] = { cost25: s, cost10: stats(r10.port, r10.bench), perCoin: coinTbl, randomTiming95AlphaPct: rand95, beatsRandom: s.alphaAnnualPct > rand95, ddReductionPts: +(s.maxDDPct - s.benchMaxDDPct).toFixed(1) };
    console.log(`N=${N}: alpha ${s.alphaAnnualPct}%/yr t ${s.alphaT} | CAGR ${s.cagrPct}% vs ${s.benchCagrPct}% | maxDD ${s.maxDDPct}% vs ${s.benchMaxDDPct}% | Sharpe ${s.sharpe} vs ${s.benchSharpe} | random95 ${rand95}%`);
  }
  const peek = stats(run(50, 0.0025, (c, i, rows) => (rows[i].c > rows[i - 1].c ? 1 : 0)).port, run(50, 0.0025, (c, i, rows) => (rows[i].c > rows[i - 1].c ? 1 : 0)).bench);
  const peekOk = peek.alphaT >= BAR;
  const passing = NS.filter((N) => results[N].cost25.alphaT >= BAR && results[N].beatsRandom && results[N].ddReductionPts >= 15);
  const best = NS.map((N) => [N, results[N].cost25.alphaT]).sort((a, b) => b[1] - a[1])[0];
  const verdict = !peekOk ? `CONTROLS FAILED — peek t ${peek.alphaT}` : passing.length ? `PASS — N=${passing.join(",")}: alpha t ${passing.map((N) => results[N].cost25.alphaT).join("/")} >= ${BAR}, beats random timing, drawdown cut ${passing.map((N) => results[N].ddReductionPts).join("/")} pts` : `DID NOT PASS — best N=${best[0]} alpha t ${best[1]} vs ${BAR}; drawdown cuts ${NS.map((N) => `N${N} ${results[N].ddReductionPts}`).join(", ")} pts`;
  const out = { spec: "r190-crypto-trend-v1", test: "R190", ranAt: new Date().toISOString(), window: [START, END], coins: Object.keys(series), days: days.length, bar: BAR, results, controls: { peek: { alphaT: peek.alphaT, pass: peekOk } }, verdict };
  writeJsonAtomic(D("r190-crypto-trend.json"), out); console.log(verdict);
  if (!peekOk) { console.error("controls failed — NOT sealed"); process.exit(3); }
  sealTests.R190 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "days", verdict }; writeJsonAtomic(D("read-seals.json"), seals);
  E.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R190", verdict }) + "\n");
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
