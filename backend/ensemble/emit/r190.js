#!/usr/bin/env node
"use strict";
/**
 * Emitter — R190 crypto trend filter (N = 50 / 100 / 200) -> library entries R190-N50, R190-N100, R190-N200.
 * backend/r190-crypto-trend.js is NOT require-safe (top-level seal code), so the pieces used are COPIED verbatim:
 *   COINS/START/END/NS (lines 13-14), mean + nw (lines 15-16), stats (lines 25-31), days (line 34), run (lines 35-49),
 *   trend (line 50). run() is extended only to also record, per day, whether any capital was at risk or a switch cost was charged.
 * Data: the sealed script's own Coinbase daily candle cache backend/data/training/r190/<COIN>.json (read-only, no fetch).
 */
const fs = require("fs"), path = require("path");
const { writeEntry, writeUnavailable } = require("../lib-entry.js");
const CACHE = path.join(__dirname, "..", "..", "data", "training", "r190");
const PERSISTED = path.join(__dirname, "..", "..", "data", "r190-crypto-trend.json");
// ---- copied from backend/r190-crypto-trend.js lines 13-16 ----
const COINS = ["BTC", "LTC", "BCH", "ETC", "LINK", "XLM", "ADA", "SOL", "DOGE", "AVAX", "DOT", "ATOM", "UNI", "AAVE", "XTZ", "ALGO"];
const START = "2018-01-01", END = "2025-09-23", NS = [50, 100, 200];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function nw(a, L = 5) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * g / n; } return m / Math.sqrt(v / n); }
// ---- copied from lines 25-31 ----
function stats(port, bench) {
  const mr = mean(port), mb = mean(bench); let cv = 0, vb = 0; for (let i = 0; i < port.length; i++) { cv += (port[i] - mr) * (bench[i] - mb); vb += (bench[i] - mb) ** 2; }
  const beta = cv / vb, res = port.map((x, i) => x - beta * bench[i]);
  const curve = (a) => { let e = 1, pk = 1, dd = 0; for (const x of a) { e *= 1 + x; pk = Math.max(pk, e); dd = Math.min(dd, e / pk - 1); } return { final: e, dd }; };
  const p = curve(port), b = curve(bench), yrs = port.length / 365, sh = (a) => (mean(a) / Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)))) * Math.sqrt(365);
  return { days: port.length, alphaAnnualPct: +(mean(res) * 365 * 100).toFixed(2), alphaT: +nw(res).toFixed(3), beta: +beta.toFixed(3), cagrPct: +((p.final ** (1 / yrs) - 1) * 100).toFixed(1), benchCagrPct: +((b.final ** (1 / yrs) - 1) * 100).toFixed(1), maxDDPct: +(p.dd * 100).toFixed(1), benchMaxDDPct: +(b.dd * 100).toFixed(1), sharpe: +sh(port).toFixed(2), benchSharpe: +sh(bench).toFixed(2) };
}

const base = { registryId: "R190", script: "backend/r190-crypto-trend.js", emitter: "backend/ensemble/emit/r190.js" };
const series = {};
for (const c of COINS) { const f = path.join(CACHE, `${c}.json`); if (!fs.existsSync(f)) { for (const N of NS) writeUnavailable({ ...base, id: `R190-N${N}`, name: `Crypto trend N=${N}`, reason: `candle cache missing: backend/data/training/r190/${c}.json` }); process.exit(0); } const rows = JSON.parse(fs.readFileSync(f, "utf8")); if (rows.length > 60) series[c] = rows; }
// ---- copied from line 34 ----
const days = [...new Set(Object.values(series).flatMap((r) => r.map((x) => x.d)))].filter((d) => d >= START && d <= END).sort();
// ---- copied from lines 35-49 (plus the `active` bookkeeping: any coin long or any switch cost that day) ----
function run(N, cost, posFn) {
  const port = [], bench = [], pdays = [], active = []; const idx = Object.fromEntries(Object.entries(series).map(([c, r]) => [c, new Map(r.map((x, i) => [x.d, i]))]));
  const lastPos = {};
  for (const d of days) {
    const rs = [], bs = []; let act = false;
    for (const [c, rows] of Object.entries(series)) {
      const i = idx[c].get(d); if (i == null || i < N + 1) continue;
      const ret = rows[i].c / rows[i - 1].c - 1, pos = posFn(c, i, rows, N);
      const sw = lastPos[c] != null && pos !== lastPos[c] ? cost : 0; lastPos[c] = pos;
      const r = pos * ret - sw; rs.push(r); bs.push(ret); if (pos || sw) act = true;
    }
    if (rs.length) { port.push(mean(rs)); bench.push(mean(bs)); pdays.push(d); active.push(act); }
  }
  return { port, bench, pdays, active };
}
// ---- copied from line 50 ----
const trend = (c, i, rows, N) => { let s = 0; for (let k = i - N; k < i; k++) s += rows[k].c; return rows[i - 1].c > s / N ? 1 : 0; };

const sealedRes = JSON.parse(fs.readFileSync(PERSISTED, "utf8")).results;
for (const N of NS) {
  const r = run(N, 0.0025, trend), s = stats(r.port, r.bench), sealed = sealedRes[N].cost25.alphaT;
  const ser = r.pdays.map((d, i) => ({ d, r: r.port[i], a: r.active[i] })).filter((x) => x.a).map(({ d, r }) => ({ d, r }));
  // self-check: rebuilding the full daily port from the sparse series (absent = 0) gives back the same statistic
  const m = new Map(ser.map((x) => [x.d, x.r])), rebuilt = r.pdays.map((d) => m.get(d) ?? 0), s2 = stats(rebuilt, r.bench);
  if (s2.alphaT !== s.alphaT) throw new Error(`N${N}: sparse series does not rebuild the port (${s2.alphaT} vs ${s.alphaT})`);
  writeEntry({ ...base, id: `R190-N${N}`, name: `Crypto trend filter N=${N} (16 coins ex-ETH)`, unit: "daily", net: true,
    costModel: "25 bps per side on each per-coin switch (in<->out of the coin), charged on the switch day within that coin's sleeve",
    window: [r.pdays[0], r.pdays[r.pdays.length - 1]], calendar: "crypto-24x7", series: ser,
    reproduction: { statistic: `alpha t (NW lag 5, port vs equal-weight buy-and-hold) N=${N} at 25 bps`, sealed, emitted: s.alphaT, tolerance: 0.02, match: Math.abs(s.alphaT - sealed) <= 0.02 },
    construction: `Exactly run(${N}, 0.0025, trend) from the sealed script: per coin, long on day d when close(d-1) > SMA${N} of closes d-${N}..d-1, else cash; the day's return is the equal-weight mean over every coin with >= ${N + 1} days of history that day (cash sleeves count as 0), switch cost deducted in the sleeve. Days on which every sleeve was in cash with no switch are omitted (= 0).`,
    notes: `Sealed verdict for R190 as a whole: best N=50 alpha t 1.774 vs bar 2.149 (DID NOT PASS). Equal-weight across coins is the script's own portfolio, so cash sleeves dilute the day's return. Also matches alphaAnnualPct ${s.alphaAnnualPct} vs sealed ${sealedRes[N].cost25.alphaAnnualPct}.` });
}
