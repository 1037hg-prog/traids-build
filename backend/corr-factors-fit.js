"use strict";
/**
 * CORR-FACTORS FIT — nightly low-rank correlation model for correlation-aware sizing. 2026-09-24.
 *
 * WHY. 81% of the board's -66.85R stop tail was correlated exposure: many same-direction tickets on
 * names that move together, losing on one day. R53 refuses by a fixed factor-group LABEL. This is
 * the MEASURED layer beside it: a 60-session daily-return correlation, compressed to k factors, so
 * that lib/corr-size.js can shrink (never refuse) a ticket that piles onto an exposure the book
 * already carries. Operator approval: "go on 1", 2026-09-24.
 *
 * MODEL. Standardised 60-day log returns Z (names x T). PCA through the T x T Gram matrix (T=60, so
 * a 60x60 Jacobi eigensolve regardless of how many names). Loadings L_i = (Z u_k)/sqrt(T-1) for
 * the top k eigenvectors u_k, idiosyncratic variance = 1 - |L_i|^2 (standardised units), so the
 * model correlation of any pair is simply L_i . L_j.
 *
 * SOURCES (point-in-time — only closes through the last COMPLETED session are used):
 *   equities/ETFs  Alpaca SIP daily bars (lib/alpaca-bars.js, pagination exhausted, loud failures)
 *   crypto         Coinbase public hourly candles, sampled at 16:00 America/New_York of each session
 *                  (Alpaca serves only ~17 of the ~49 alts the board trades; a UTC-midnight daily bar
 *                  would be 4h out of sync with the equity close and bias crypto-equity rho down)
 *   FX pairs       SYNTHETIC from currency ETFs (FXE FXY FXF FXC FXA FXB): r(A/B) = r(A) - r(B),
 *                  USD = 0. NZD and MXN have no clean ETF -> NZD/MXN pairs are NOT covered.
 *   futures        ETF PROXIES (MES->SPY, 6J->FXY, ZN->IEF, SB->CANE ...), flagged proxy:true.
 *                  6N (NZD) and 6M (MXN) have no proxy -> NOT covered.
 * Unknown names are simply absent; lib/corr-size.js fails OPEN (mult 1) for them.
 *
 * USAGE   node corr-factors-fit.js            -> writes data/corr-factors.json
 *         node corr-factors-fit.js --dry      -> fit and print, write nothing
 * Library (used by corr-size-preview.js): buildPanel(opts), fitAt(panel, endIdx, opts), universe()
 */
const fs = require("fs"), path = require("path");
const { fetchBars } = require("./lib/alpaca-bars");
const { writeJsonAtomic } = require("./lib/atomic-write");
const { sessionOf } = require("./lib/session");

const D = (f) => path.join(__dirname, "data", f);
const OUT = D("corr-factors.json");
const VERSION = "corr-factors-v1";
const WINDOW = 60, K = 10, MIN_FRAC = 0.9;
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

const CORE_ETFS = ["SPY", "QQQ", "IWM", "DIA", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC",
  "SMH", "KRE", "XBI", "GDX", "TLT", "IEF", "IEI", "SHY", "GLD", "SLV", "USO", "UNG", "UUP", "CANE", "CORN", "SOYB", "WEAT"];
const CCY_ETF = { EUR: "FXE", JPY: "FXY", CHF: "FXF", CAD: "FXC", AUD: "FXA", GBP: "FXB" };   // USD is the numeraire (0)
const FUT_PROXY = {
  ES: "SPY", MES: "SPY", NQ: "QQQ", MNQ: "QQQ", YM: "DIA", MYM: "DIA", RTY: "IWM", M2K: "IWM",
  GC: "GLD", MGC: "GLD", SI: "SLV", SIL: "SLV", CL: "USO", MCL: "USO", NG: "UNG",
  ZT: "SHY", ZF: "IEI", ZN: "IEF", TN: "IEF", ZB: "TLT", UB: "TLT",
  "6E": "FXE", M6E: "FXE", "6J": "FXY", "6B": "FXB", "6A": "FXA", "6C": "FXC", "6S": "FXF",
  SB: "CANE", ZC: "CORN", ZS: "SOYB", ZW: "WEAT",
};
const CRYPTO_MAJORS = ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "DOGE/USD", "ADA/USD", "AVAX/USD", "LINK/USD", "LTC/USD", "BCH/USD", "DOT/USD"];

// ── time helpers (node Intl, never the shell clock) ─────────────────────────────────────────────
function etParts(ms) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const o = {}; for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, hour: +o.hour % 24, minute: +o.minute, weekday: o.weekday };
}
/** epoch ms of 16:00 America/New_York on a YYYY-MM-DD */
function closeMsET(date) {
  for (const h of [20, 21]) { const ms = Date.parse(`${date}T${h}:00:00Z`); const p = etParts(ms); if (p.hour === 16 && p.date === date) return ms; }
  return Date.parse(`${date}T20:00:00Z`);
}

// ── universe ────────────────────────────────────────────────────────────────────────────────────
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } }
function universe({ topN = 250 } = {}) {
  const eq = new Set(CORE_ETFS), crypto = new Set(CRYPTO_MAJORS), fx = new Set(), fut = new Set();
  const add = (t) => {
    if (!t || !t.sym) return;
    const s = String(t.sym).toUpperCase();
    if (t.cls === "Crypto") crypto.add(s);
    else if (t.cls === "FX") fx.add(s);
    else if (t.cls === "Futures") fut.add(s);
    else if (/^[A-Z][A-Z.]{0,5}$/.test(s)) eq.add(s);                          // Equity + Options underlyings
  };
  // Membership only — which names the board trades. No outcome field is read.
  for (const t of readJson(D("trade_log.json"), [])) add(t);
  for (const t of readJson(D("board_positions.json"), [])) add(t);
  const ux = readJson(D("universe-expanded.json"), { names: [] });
  for (const n of (ux.names || []).slice().sort((a, b) => (b.medDollarVol || 0) - (a.medDollarVol || 0)).slice(0, topN)) if (/^[A-Z][A-Z.]{0,5}$/.test(n.sym)) eq.add(n.sym);
  for (const e of Object.values(CCY_ETF)) eq.add(e);
  for (const e of Object.values(FUT_PROXY)) eq.add(e);
  return { equities: [...eq].sort(), crypto: [...crypto].sort(), fx: [...fx].sort(), futures: [...fut].sort() };
}

// ── crypto: Coinbase public hourly candles, sampled at the 16:00 ET equity close ───────────────
async function coinbaseHourly(sym, startMs, endMs) {
  const prod = sym.replace("/", "-");
  const out = new Map();                                                     // candle start (s) -> close
  const STEP = 300 * 3600 * 1000;
  for (let a = startMs; a < endMs; a += STEP) {
    const b = Math.min(endMs, a + STEP);
    const url = `https://api.exchange.coinbase.com/products/${prod}/candles?granularity=3600&start=${new Date(a).toISOString()}&end=${new Date(b).toISOString()}`;
    let j = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      await nap(130);
      let r; try { r = await fetch(url, { headers: { "User-Agent": "traids-research", Accept: "application/json" }, signal: AbortSignal.timeout(30000) }); } catch { await nap(500 * 2 ** attempt); continue; }
      if (r.status === 404) return { ok: false, why: "not listed on Coinbase (404)" };
      if (r.ok) { j = await r.json(); break; }
      if (r.status === 429 || r.status >= 500) { await nap(500 * 2 ** attempt); continue; }
      return { ok: false, why: `Coinbase ${r.status}` };
    }
    if (!Array.isArray(j)) return { ok: false, why: "Coinbase fetch failed after retries" };
    for (const c of j) out.set(c[0], c[4]);                                  // [time, low, high, open, close, volume]
  }
  if (!out.size) return { ok: false, why: "no candles returned" };
  return { ok: true, candles: out };
}
/** close at 16:00 ET = close of the candle starting 15:00 ET; tolerate up to 3h of missing candles before it */
function sampleAtClose(candles, closeMs) {
  for (let back = 1; back <= 4; back++) {
    const k = Math.round(closeMs / 1000) - back * 3600;
    if (candles.has(k)) return candles.get(k);
  }
  return null;
}

// ── panel ───────────────────────────────────────────────────────────────────────────────────────
/**
 * buildPanel({ start, nowMs, withCrypto }) -> { dates, closes:{name:[..]}, meta:{name:{src,cls,proxy?}}, coverage }
 * dates = SPY session dates through the last COMPLETED session (forming-bar guard: today's bar only
 * after 16:30 ET).
 */
async function buildPanel({ start, nowMs = Date.now(), withCrypto = true, topN = 250, quiet = false } = {}) {
  const U = universe({ topN });
  const now = etParts(nowMs);
  const endDate = new Date(nowMs - 20 * 60e3).toISOString();                // SIP: no data inside the last 15 min; forming bar guarded below
  const log = (m) => { if (!quiet) console.log(m); };

  log(`  universe: ${U.equities.length} equities/ETFs, ${U.crypto.length} crypto, ${U.fx.length} FX pairs, ${U.futures.length} futures`);
  const spy = await fetchBars(["SPY"], { start, end: endDate, feed: "sip", adjustment: "all", requireAll: true, quiet: true });
  const todayComplete = now.hour > 16 || (now.hour === 16 && now.minute >= 30);
  let dates = spy.bars.SPY.map((b) => String(b.t).slice(0, 10));
  dates = dates.filter((d) => d < now.date || (d === now.date && todayComplete));
  if (dates.length < WINDOW + 1) throw new Error(`SPY returned only ${dates.length} completed sessions since ${start}; need >= ${WINDOW + 1}`);
  const idx = new Map(dates.map((d, i) => [d, i]));

  const eq = await fetchBars(U.equities, { start, end: endDate, feed: "sip", adjustment: "all", requireAll: false, requireSymbols: ["SPY"], quiet });
  const closes = {}, meta = {};
  for (const [s, rows] of Object.entries(eq.bars)) {
    const a = new Array(dates.length).fill(null);
    for (const b of rows) { const i = idx.get(String(b.t).slice(0, 10)); if (i != null && b.c > 0) a[i] = b.c; }
    closes[s] = a; meta[s] = { src: "alpaca-sip-daily", cls: "Equity" };
  }

  const cryptoMissing = {};
  if (withCrypto) {
    const t0 = closeMsET(dates[0]) - 6 * 3600e3, t1 = closeMsET(dates[dates.length - 1]) + 3600e3;
    let n = 0;
    for (const sym of U.crypto) {
      const r = await coinbaseHourly(sym, t0, t1);
      if (!r.ok) { cryptoMissing[sym] = r.why; continue; }
      const a = dates.map((d) => sampleAtClose(r.candles, closeMsET(d)));
      closes[sym] = a; meta[sym] = { src: "coinbase-1h@16:00ET", cls: "Crypto" };
      if (!quiet) process.stdout.write(`  [coinbase] ${++n}/${U.crypto.length}\r`);
    }
    if (!quiet) process.stdout.write("\n");
  }

  return { dates, closes, meta, universe: U, eqMissing: eq.missing, cryptoMissing };
}

// ── returns + synthetic series ──────────────────────────────────────────────────────────────────
function logReturns(a) {
  const r = new Array(a.length).fill(null);
  for (let i = 1; i < a.length; i++) if (a[i] > 0 && a[i - 1] > 0) r[i] = Math.log(a[i] / a[i - 1]);
  return r;
}
/** returns per name, including synthetic FX pairs and futures proxies. Cached on the panel. */
function returnsOf(panel) {
  if (panel._rets) return panel._rets;
  const R = {}, meta = {}, notCovered = {};
  for (const [s, a] of Object.entries(panel.closes)) { R[s] = logReturns(a); meta[s] = panel.meta[s]; }
  const T = panel.dates.length;
  const ccy = (c) => (c === "USD" ? new Array(T).fill(0) : CCY_ETF[c] && R[CCY_ETF[c]] ? R[CCY_ETF[c]] : null);
  for (const pair of panel.universe.fx) {
    const [A, B] = pair.split("/");
    const ra = ccy(A), rb = ccy(B);
    if (!ra || !rb) { notCovered[pair] = `no clean daily source for ${!ra ? A : B}`; continue; }
    R[pair] = ra.map((x, i) => (x == null || rb[i] == null ? null : x - rb[i]));
    meta[pair] = { src: `synthetic ${CCY_ETF[A] || "USD"}-${CCY_ETF[B] || "USD"}`, cls: "FX", proxy: true };
  }
  for (const f of panel.universe.futures) {
    const p = FUT_PROXY[f];
    if (!p || !R[p]) { notCovered[f] = p ? `proxy ${p} unpriced` : "no clean daily proxy"; continue; }
    R[f] = R[p]; meta[f] = { src: `proxy ${p}`, cls: "Futures", proxy: true, proxyOf: p };
  }
  panel._rets = { R, meta, notCovered };
  return panel._rets;
}

// ── symmetric eigensolver (cyclic Jacobi) for the T x T Gram matrix ─────────────────────────────
function jacobiEigen(A0) {
  const n = A0.length, A = A0.map((r) => r.slice()), V = A0.map((_, i) => A0.map((__, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-15) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  const vals = A.map((r, i) => r[i]);
  const order = vals.map((v, i) => i).sort((a, b) => vals[b] - vals[a]);
  return { values: order.map((i) => vals[i]), vectors: order.map((i) => V.map((r) => r[i])) };   // vectors[k] = u_k (length n)
}

/**
 * fitAt(panel, endIdx) -> the corr-factors document for a fit AS OF panel.dates[endIdx].
 * Uses the WINDOW returns ending at endIdx (return i = close i-1 -> close i). Nothing after endIdx is read.
 */
function fitAt(panel, endIdx, { window = WINDOW, k = K, minFrac = MIN_FRAC } = {}) {
  const { R, meta, notCovered } = returnsOf(panel);
  const lo = endIdx - window + 1;
  if (lo < 1) throw new Error(`fitAt: need ${window} returns before index ${endIdx}`);
  const T = window, names = [], Z = [], vols = [], thin = [];
  for (const [s, r] of Object.entries(R)) {
    const w = r.slice(lo, endIdx + 1);
    const v = w.filter((x) => x != null && Number.isFinite(x));
    if (v.length < Math.ceil(minFrac * T)) { thin.push(s); continue; }
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
    if (!(sd > 1e-9)) { thin.push(s); continue; }
    names.push(s); vols.push(sd);
    Z.push(w.map((x) => (x == null || !Number.isFinite(x) ? 0 : (x - m) / sd)));   // missing -> mean (z 0)
  }
  // Gram H = M'M with M = Z/sqrt(T-1)  (T x T)
  const H = Array.from({ length: T }, () => new Array(T).fill(0));
  for (const z of Z) for (let a = 0; a < T; a++) { const za = z[a]; if (!za) continue; for (let b = a; b < T; b++) H[a][b] += za * z[b]; }
  for (let a = 0; a < T; a++) for (let b = a; b < T; b++) { H[a][b] /= T - 1; H[b][a] = H[a][b]; }
  const eig = jacobiEigen(H);
  const kk = Math.min(k, T - 1);
  const totalVar = eig.values.reduce((a, b) => a + Math.max(0, b), 0);
  const out = {};
  for (let i = 0; i < names.length; i++) {
    const z = Z[i];
    const L = [];
    for (let f = 0; f < kk; f++) { const u = eig.vectors[f]; let s = 0; for (let t = 0; t < T; t++) s += z[t] * u[t]; L.push(s / Math.sqrt(T - 1)); }
    let comm = L.reduce((a, b) => a + b * b, 0);
    if (comm > 0.99) { const sc = Math.sqrt(0.99 / comm); for (let f = 0; f < kk; f++) L[f] *= sc; comm = 0.99; }
    out[names[i]] = { loadings: L.map((x) => +x.toFixed(4)), idioVar: +(1 - comm).toFixed(4), vol: +vols[i].toFixed(5), cls: meta[names[i]].cls, src: meta[names[i]].src, ...(meta[names[i]].proxy ? { proxy: true } : {}) };
  }
  const byCls = {};
  for (const v of Object.values(out)) byCls[v.cls] = (byCls[v.cls] || 0) + 1;
  return {
    version: VERSION,
    fittedAt: new Date().toISOString(),
    asOfSession: panel.dates[endIdx],
    windowStart: panel.dates[lo - 1], windowReturns: T,
    k: kk,
    varianceExplained: +(eig.values.slice(0, kk).reduce((a, b) => a + b, 0) / totalVar).toFixed(4),
    eigenvalues: eig.values.slice(0, kk).map((x) => +x.toFixed(3)),
    names: out,
    coverage: {
      fitted: names.length, byCls,
      thinHistory: thin.length, thinHistorySample: thin.slice(0, 25),
      notCovered, equityMissing: panel.eqMissing || [], cryptoMissing: panel.cryptoMissing || {},
      notes: [
        "FX pairs are synthetic from currency ETFs (USD numeraire); NZD and MXN have no clean daily source",
        "futures use ETF proxies (proxy:true); 6N/6M have none",
        "crypto sampled at 16:00 America/New_York from Coinbase public hourly candles",
      ],
    },
  };
}

async function main() {
  const dry = process.argv.includes("--dry");
  const nowMs = Date.now();
  const start = new Date(nowMs - 150 * 86400e3).toISOString().slice(0, 10);   // ~100 sessions, need 61
  console.log(`corr-factors-fit ${VERSION}  now ET ${etParts(nowMs).date} ${etParts(nowMs).hour}:${String(etParts(nowMs).minute).padStart(2, "0")}`);
  const panel = await buildPanel({ start, nowMs });
  const doc = fitAt(panel, panel.dates.length - 1);
  // point-in-time assertion: the fit must never contain the forming session
  const n = etParts(nowMs);
  if (doc.asOfSession > n.date || (doc.asOfSession === n.date && (n.hour < 16 || (n.hour === 16 && n.minute < 30)))) throw new Error(`PIT violation: asOfSession ${doc.asOfSession} not complete at run time`);
  if (!doc.names.SPY) throw new Error("SPY not fitted — refusing to write");
  if (doc.coverage.fitted < 100) throw new Error(`only ${doc.coverage.fitted} names fitted — refusing to write`);
  console.log(`  asOfSession ${doc.asOfSession}  window from ${doc.windowStart}  k ${doc.k}  var explained ${(doc.varianceExplained * 100).toFixed(1)}%`);
  console.log(`  fitted ${doc.coverage.fitted} ${JSON.stringify(doc.coverage.byCls)}  thin ${doc.coverage.thinHistory}  notCovered ${Object.keys(doc.coverage.notCovered).length}  cryptoMissing ${Object.keys(doc.coverage.cryptoMissing).length}`);
  const rho = (a, b) => { const A = doc.names[a], B = doc.names[b]; return A && B ? +A.loadings.reduce((s, x, i) => s + x * B.loadings[i], 0).toFixed(3) : null; };
  console.log(`  spot: SPY~QQQ ${rho("SPY", "QQQ")}  SPY~IWM ${rho("SPY", "IWM")}  BTC~ETH ${rho("BTC/USD", "ETH/USD")}  SPY~BTC ${rho("SPY", "BTC/USD")}  SPY~TLT ${rho("SPY", "TLT")}  EUR/USD~USD/CHF ${rho("EUR/USD", "USD/CHF")}`);
  if (dry) { console.log("  --dry: not written"); return; }
  writeJsonAtomic(OUT, doc, { pretty: 0 });
  console.log(`  wrote ${path.relative(path.join(__dirname, ".."), OUT)}`);
}

module.exports = { buildPanel, fitAt, returnsOf, universe, closeMsET, etParts, VERSION, FUT_PROXY, CCY_ETF };
if (require.main === module) main().catch((e) => { console.error("corr-factors-fit FAILED:", e.message); process.exitCode = 1; });
