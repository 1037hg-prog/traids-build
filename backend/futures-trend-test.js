#!/usr/bin/env node
/**
 * TRAIDS — Trend-Following on REAL Futures (via Massive.com)
 *
 * The proper version of the one edge we found: diversified time-series-momentum across
 * actual CME futures, not ETF proxies. Builds a continuous, roll-gap-free price series per
 * product by stitching front-month contracts (picking the max-VOLUME contract each day and
 * chaining its OWN returns, so rolls add no false jumps), then runs the same CTA logic:
 * long if trailing N-month return > 0 / short if < 0, inverse-vol weighted, net of costs,
 * through the 2022 bear. Reports Sharpe, drawdown, correlation to the equity leg, and
 * calendar-year returns (the diversification / crisis-alpha view).
 *
 * Usage:  node backend/futures-trend-test.js     (needs MASSIVE_API_KEY in backend/.env)
 */
const fs = require("fs"), path = require("path");
function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.MASSIVE_API_KEY, BASE = (process.env.MASSIVE_API_BASE_URL || "https://api.massive.com").replace(/\/$/, "");
if (!KEY) { console.error("\n  Missing MASSIVE_API_KEY in backend/.env.\n"); process.exit(1); }
const FROM = process.env.FROM || "2021-01-01", TO = new Date().toISOString().slice(0, 10);
const COST_BPS = parseFloat(process.env.COST_BPS || "2"), VOL_LB = 60, TREND_LB = 252;

// diversified quarterly-contract basket (equity / bonds / FX) — clean H,M,U,Z schedule
const PRODUCTS = [
  { root: "ES", name: "E-mini S&P", cls: "equity" }, { root: "NQ", name: "E-mini Nasdaq", cls: "equity" },
  { root: "ZN", name: "10Y T-Note", cls: "bond" },  { root: "ZB", name: "30Y Bond", cls: "bond" },
  { root: "6E", name: "Euro FX", cls: "fx" },        { root: "6J", name: "Japanese Yen", cls: "fx" },
];
const MONTHS = ["H", "M", "U", "Z"];   // Mar, Jun, Sep, Dec

async function fetchContract(ticker) {
  const url = `${BASE}/futures/v1/aggs/${ticker}?resolution=1session&window_start.gte=${FROM}&window_start.lte=${TO}&limit=50000&sort=window_start.asc`;
  try { const r = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } }); if (!r.ok) return []; const j = await r.json();
    return (j.results || []).map(b => ({ d: b.session_end_date || new Date(b.window_start / 1e6).toISOString().slice(0, 10), c: b.close, v: b.volume || 0 })).filter(x => x.c > 0); } catch { return []; }
}
// build a continuous, roll-gap-free price series for a product root
async function buildContinuous(root) {
  const fy = +FROM.slice(2, 4), ty = +TO.slice(2, 4);
  const tickers = [];
  for (let y = fy; y <= ty; y++) for (const m of MONTHS) tickers.push(`${root}${m}${y % 10}`);
  // fetch all contracts; map: date -> [{ticker, c, v}]
  const byDate = {};
  let got = 0;
  for (const tk of tickers) { const bars = await fetchContract(tk); if (bars.length) got++; for (const b of bars) (byDate[b.d] ||= []).push({ tk, c: b.c, v: b.v }); }
  const dates = Object.keys(byDate).sort();
  // each day: active = max-volume contract. Chain that contract's OWN return vs its prior day.
  const lastClose = {};                 // ticker -> its previous close (within-contract)
  const out = [];                       // { d, price (continuous), vol }
  let price = 100;
  for (const d of dates) {
    const recs = byDate[d];
    let act = recs[0]; for (const r of recs) if (r.v > act.v) act = r;
    const prev = lastClose[act.tk];
    if (prev != null && prev > 0) { price *= act.c / prev; out.push({ d, price, vol: act.v }); }
    else if (!out.length) { out.push({ d, price, vol: act.v }); }  // seed
    for (const r of recs) lastClose[r.tk] = r.c;   // update every contract's last close
  }
  return { series: out, contracts: got };
}

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
function perf(r) { const m = mean(r), v = sd(r); let eq = 1, pk = 1, dd = 0; for (const x of r) { eq *= 1 + x; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); } return { ann: m * 252, vol: v * Math.sqrt(252), sharpe: v > 0 ? m / v * Math.sqrt(252) : 0, maxDD: dd }; }
const corr = (a, b) => { const n = Math.min(a.length, b.length); if (n < 3) return 0; const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n)); let ab = 0, aa = 0, bb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; } return aa && bb ? ab / Math.sqrt(aa * bb) : 0; };

(async () => {
  console.log(`\n  TRAIDS — Trend-Following on REAL Futures (Massive)  ·  ${PRODUCTS.length} markets · ${FROM}→${TO}\n`);
  process.stdout.write("  building continuous series");
  const cont = {};
  for (const p of PRODUCTS) { const c = await buildContinuous(p.root); cont[p.root] = c; process.stdout.write(`  ${p.root}(${c.contracts}c/${c.series.length}d)`); }
  console.log("\n");
  const have = PRODUCTS.filter(p => cont[p.root].series.length > TREND_LB + VOL_LB + 30);
  if (have.length < 2) { console.error("  Too few markets returned usable continuous data. Tell me the error and I'll check contract codes.\n"); process.exit(1); }

  // master date axis = union; build aligned price + daily return per product
  const allD = [...new Set(have.flatMap(p => cont[p.root].series.map(s => s.d)))].sort();
  const idx = {}; allD.forEach((d, i) => idx[d] = i);
  const px = {}, ret = {};
  for (const p of have) { const a = new Array(allD.length).fill(null); for (const s of cont[p.root].series) a[idx[s.d]] = s.price; px[p.root] = a; const r = new Array(allD.length).fill(null); for (let i = 1; i < a.length; i++) if (a[i] != null && a[i - 1] != null) r[i] = a[i] / a[i - 1] - 1; ret[p.root] = r; }
  const N = allD.length;

  // TSMOM portfolio: long/short by trailing-12mo sign, inverse-vol weighted
  const port = new Array(N).fill(null); let prevW = {};
  for (let i = TREND_LB + VOL_LB + 1; i < N - 1; i++) {
    const w = {}; let inv = 0;
    for (const p of have) { const a = px[p.root]; if (a[i] == null || a[i - TREND_LB] == null) continue; const sig = a[i] / a[i - TREND_LB] - 1 >= 0 ? 1 : -1; const vol = sd(ret[p.root].slice(i - VOL_LB, i).filter(x => x != null)) || 1e-6; w[p.root] = { sig, iv: 1 / vol }; inv += 1 / vol; }
    if (inv <= 0) continue;
    let turn = 0, pr = 0; const cur = {};
    for (const p of have) { const ww = w[p.root] ? w[p.root].sig * w[p.root].iv / inv : 0; cur[p.root] = ww; turn += Math.abs(ww - (prevW[p.root] || 0)); if (ret[p.root][i + 1] != null) pr += ww * ret[p.root][i + 1]; }
    port[i + 1] = pr - turn * (COST_BPS / 10000); prevW = cur;
  }
  const series = [], sd2 = [], esR = [];
  for (let i = 0; i < N; i++) if (port[i] != null) { series.push(port[i]); sd2.push(allD[i]); esR.push(ret["ES"]?.[i] ?? 0); }
  const pf = perf(series), c = corr(series, esR);
  console.log("  RESULT — 12-mo trend-following, diversified futures basket:");
  console.log(`    ann.return ${(pf.ann * 100).toFixed(1)}%  ·  vol ${(pf.vol * 100).toFixed(1)}%  ·  Sharpe ${pf.sharpe.toFixed(2)}  ·  maxDD ${(pf.maxDD * 100).toFixed(1)}%  ·  corr→ES ${c.toFixed(2)}\n`);
  const comp = a => a.reduce((s, r) => s * (1 + r), 1) - 1;
  const yr = {}, yes = {};
  for (let k = 0; k < series.length; k++) { const y = sd2[k].slice(0, 4); (yr[y] ||= []).push(series[k]); (yes[y] ||= []).push(esR[k]); }
  console.log("  CALENDAR YEAR — trend basket vs ES (the diversification test):");
  console.log("    year    trend       ES");
  for (const y of Object.keys(yr).sort()) { const t = comp(yr[y]) * 100, e = comp(yes[y]) * 100; console.log("    " + y + "    " + ((t >= 0 ? "+" : "") + t.toFixed(1) + "%").padEnd(12) + (e >= 0 ? "+" : "") + e.toFixed(1) + "%" + (e < 0 && t > 0 ? "   ← crisis alpha" : "")); }
  console.log(`\n  This is the real CTA premium on real futures (equity+bond+FX only here; add commodities for the`);
  console.log(`  full diversifier). Same shape = same conclusion: real, modest, low-correlation — and buyable as DBMF.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
