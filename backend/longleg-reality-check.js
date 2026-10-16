#!/usr/bin/env node
/**
 * TRAIDS — LONG-LEG REALITY CHECK: is the "+30%/yr" real, or is it the bull market?
 *
 * The cross-sectional test showed the ensemble's TOP-ranked names returned +30.8%/yr
 * (Sharpe 1.61) — a fundable-sounding number. It also showed its BOTTOM-ranked names
 * returned +26%. This script settles what that 30% actually is, with two controls the
 * first test didn't run:
 *
 *   CONTROL 1 — the DUMB BASKET: equal-weight buy-and-hold of the SAME universe.
 *               If the strategy ≈ the basket, the "selection" added nothing.
 *   CONTROL 2 — the BEAR MARKET: extend the window through 2022 (the year high-beta
 *               names fell 50-70%). A strategy that only exists in bull markets is a
 *               leveraged bull bet, not an edge — and you cannot know in advance which
 *               regime you're in.
 *
 * Everything is long-only, equal-weight, 5-day overlapping cohorts, net of 5bps/side.
 *
 * Usage: node backend/longleg-reality-check.js
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "2600");    // ~7 years — reaches back through 2022
const Q = 10, H = 5, COST_BPS = 5;

const UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","CRM","ADBE","AVGO","INTC","QCOM","MU","TXN","ORCL","CSCO","IBM","NOW","SHOP","UBER","PYPL","ROKU","ZM","DOCU","DDOG","NET","CRWD","ZS","OKTA","MDB","TWLO","TEAM","WDAY","PANW","FTNT","MRVL","ON","ARM","DELL","HPQ","WDC","STX","ANET","KLAC","LRCX","AMAT","ASML","TSM","SOFI","AFRM","UPST","NIO","F","GM","BA","CAT","DE","GE","HON","UNP","JPM","BAC","GS","MS","C","WFC","SCHW","V","MA","AXP","COF","BLK","LLY","UNH","JNJ","PFE","MRK","ABBV","BMY","MRNA","REGN","VRTX","GILD","AMGN","ISRG","DXCM","XOM","CVX","COP","OXY","SLB","HAL","MPC","WMT","COST","TGT","HD","LOW","NKE","SBUX","MCD","DIS","CMCSA","T","VZ","PG","KO","PEP","MARA","RIOT","DKNG","CVNA","CHWY","U","PINS","SNAP","SPOT","TTD","ENPH","FSLR","BABA","JD","PDD","MELI","SE","CMG","LULU","ORLY","ROST","TJX","MMM","LMT","RTX","NOC","GD","UPS","FDX","CSX","NSC","EMR","ITW","PH","ETN","APD","LIN","SHW","ECL","NEM","FCX","NUE","STLD","DOW","DD","PPG","KMB","CL","GIS","K","HSY","STZ","MO","PM","EL","SYY","ADM","BG","CF","MOS","DVN","FANG","EOG","PSX","VLO","KMI","WMB","OKE","D","DUK","SO","NEE","AEP","EXC","SRE","PCG","ED","XEL","WEC","AWK","AMT","PLD","EQIX","CCI","PSA","O","SPG","DLR","AVB","EQR","ARE","BXP","KIM","REG","BMRN","NBIX","JAZZ","SRPT","IONS","DLTR","ULTA","SWKS","QRVO","LSCC","TER","RMBS","CRUS","PEGA","FFIV","AKAM","BOX","DBX","EXPE","MAR","HLT","WYNN","MGM","LVS","KMX","GPC","APTV","BWA","WHR","NVR","PHM","DHI","LEN","TOL","KR","MDLZ","CPB","HRL","SJM","MKC","CLX","CAG","TSN","APA","MRO","CTRA","TRGP","ET","LNG","IDA","POR","BKH","NJR","OGS","ALE","MDU"];

async function bars(sym) {
  const start = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const out = []; let tok = null;
  do {
    const p = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED });
    if (tok) p.set("page_token", tok);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${p}`, { headers });
    if (!r.ok) break;
    const j = await r.json();
    for (const b of (j.bars?.[sym] || [])) out.push({ t: (b.t || "").slice(0, 10), h: b.h, l: b.l, c: b.c });
    tok = j.next_page_token || null;
  } while (tok);
  return out;
}
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const ann = a => (Math.pow(a.reduce((p, r) => p * (1 + r), 1), 252 / Math.max(1, a.length)) - 1) * 100;
const shp = a => sd(a) > 0 ? mean(a) / sd(a) * Math.sqrt(252) : 0;
const mdd = a => { let e = 1, pk = 1, d = 0; for (const r of a) { e *= 1 + r; pk = Math.max(pk, e); d = Math.min(d, e / pk - 1); } return d * 100; };
const ema = (arr, n) => { const k = 2 / (n + 1); let e = arr[0]; const o = [e]; for (let i = 1; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); o.push(e); } return o; };
function rsi(c, p = 14) { const o = new Array(c.length).fill(null); let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; } g /= p; l /= p; o[p] = 100 - 100 / (1 + (l ? g / l : 100)); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (p - 1) + Math.max(0, d)) / p; l = (l * (p - 1) + Math.max(0, -d)) / p; o[i] = 100 - 100 / (1 + (l ? g / l : 100)); } return o; }
function voteAt(c, h, l, e20, e50, rs, i) {
  if (i < 60) return null;
  const s20 = mean(c.slice(i - 19, i + 1)), sdv = Math.sqrt(mean(c.slice(i - 19, i + 1).map(v => (v - s20) ** 2)));
  const v = [];
  v.push(e20[i] > e50[i] ? 1 : -1);
  v.push(c[i] > s20 + 2 * sdv ? -1 : c[i] < s20 - 2 * sdv ? 1 : 0);
  v.push(rs[i] > 70 ? -1 : rs[i] < 30 ? 1 : 0);
  v.push(c[i] > mean(c.slice(i - 9, i + 1)) ? 1 : -1);
  const hi = Math.max(...h.slice(i - 55, i)), lo = Math.min(...l.slice(i - 55, i));
  v.push(c[i] > hi ? 1 : c[i] < lo ? -1 : 0);
  v.push(e20[i] > e50[i] && c[i] > e20[i] ? 1 : (e20[i] < e50[i] && c[i] < e20[i]) ? -1 : 0);
  v.push(c[i] > c[i - 5] ? 1 : -1);
  return mean(v);
}

(async () => {
  console.log(`\n  TRAIDS — LONG-LEG REALITY CHECK · is "+30%/yr" the model, or the market?`);
  console.log(`  ${UNIVERSE.length} names · ~${DAYS}d (reaches through the 2022 bear) · top ${Q}% by vote · ${H}d holds · ${COST_BPS}bps/side\n`);
  process.stdout.write("  fetching");
  const data = {};
  for (const s of UNIVERSE) { const d = await bars(s); process.stdout.write("."); if (d.length > 100) data[s] = d; }
  const spyB = await bars("SPY");
  const syms = Object.keys(data);
  console.log(` ${syms.length} names\n`);

  const idx = {}, vote = {};
  for (const s of syms) {
    const d = data[s], c = d.map(x => x.c), h = d.map(x => x.h), l = d.map(x => x.l);
    const e20 = ema(c, 20), e50 = ema(c, 50), rs = rsi(c);
    const ix = {}, vt = {};
    for (let i = 0; i < d.length; i++) { ix[d[i].t] = i; const v = voteAt(c, h, l, e20, e50, rs, i); if (v != null) vt[d[i].t] = v; }
    idx[s] = ix; vote[s] = vt;
  }
  const dates = [...new Set(syms.flatMap(s => data[s].map(b => b.t)))].sort();
  const spyRet = {}; for (let i = 1; i < spyB.length; i++) spyRet[spyB[i].t] = spyB[i].c / spyB[i - 1].c - 1;
  const fwd1 = (s, t) => { const i = idx[s][t], d = data[s]; if (i == null || i + 1 >= d.length) return null; return d[i + 1].c / d[i].c - 1; };

  const dailyCost = (2 * COST_BPS / 10000) / H;     // one leg, in+out, amortized
  const cohorts = [];
  const stratD = [], basketD = [], spyD = [], dd = [];
  for (let di = 60; di < dates.length - 1; di++) {
    const t = dates[di];
    let sum = 0, live = 0;
    for (const co of cohorts) { if (co.left <= 0) continue; const r = mean(co.longs.map(s => fwd1(s, t)).filter(x => x != null)); sum += r; live++; co.left--; }
    const ranked = syms.filter(s => vote[s][t] != null).map(s => ({ s, v: vote[s][t] })).sort((a, b) => b.v - a.v);
    if (ranked.length >= 40) { const k = Math.max(3, Math.floor(ranked.length * Q / 100)); cohorts.push({ longs: ranked.slice(0, k).map(x => x.s), left: H }); }
    while (cohorts.length && cohorts[0].left <= 0) cohorts.shift();
    if (live > 0) {
      stratD.push(sum / live - dailyCost);
      basketD.push(mean(syms.map(s => fwd1(s, t)).filter(x => x != null)));   // the DUMB BASKET
      spyD.push(spyRet[t] ?? 0);
      dd.push(t);
    }
  }

  const row = (lbl, a) => console.log("    " + String(lbl).padEnd(30) + `ann ${(ann(a) >= 0 ? "+" : "") + ann(a).toFixed(1)}%`.padEnd(14) + `Sharpe ${shp(a).toFixed(2)}`.padEnd(14) + `maxDD ${mdd(a).toFixed(1)}%`);
  console.log(`  ── FULL WINDOW (${dd[0]} → ${dd[dd.length - 1]}) ──`);
  row("STRATEGY (top 10% by vote)", stratD);
  row("DUMB BASKET (equal-wt all)", basketD);
  row("SPY", spyD);
  const alpha = ann(stratD) - ann(basketD);
  console.log(`    → SELECTION ALPHA vs the dumb basket: ${(alpha >= 0 ? "+" : "") + alpha.toFixed(2)}%/yr  ← this is ALL the model contributes\n`);

  console.log("  ── BY YEAR (the regime test — what happens when the tape turns?) ──");
  console.log("    " + "year".padEnd(8) + "STRATEGY".padEnd(14) + "DUMB BASKET".padEnd(14) + "SPY".padEnd(12) + "strat maxDD");
  const years = [...new Set(dd.map(d => d.slice(0, 4)))].sort();
  for (const y of years) {
    const m = dd.map((d, i) => d.slice(0, 4) === y ? i : -1).filter(i => i >= 0);
    if (m.length < 40) continue;
    const S = m.map(i => stratD[i]), B = m.map(i => basketD[i]), P = m.map(i => spyD[i]);
    const f = (a) => `${(ann(a) >= 0 ? "+" : "") + ann(a).toFixed(1)}%`;
    console.log("    " + y.padEnd(8) + f(S).padEnd(14) + f(B).padEnd(14) + f(P).padEnd(12) + mdd(S).toFixed(1) + "%");
  }

  console.log(`\n  READ: if STRATEGY ≈ DUMB BASKET, the "selection" is worth nothing — you are being paid`);
  console.log(`  for BETA, which you can buy for 3bps in an index fund without the work or the risk of`);
  console.log(`  picking. And look at the bear year: a strategy that only exists in bull markets is a`);
  console.log(`  LEVERAGED BULL BET, and you cannot know in advance which regime is coming.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
