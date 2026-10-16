#!/usr/bin/env node
/**
 * TRAIDS — CROSS-SECTIONAL MARKET-NEUTRAL TEST
 *
 * THE PROBLEM THIS SOLVES: every "green" result this project has produced turned out to
 * be BETA — the live-trigger breakout (up-years only), the longer-hold finding (longs
 * improved, shorts didn't), the crypto shorts (one macro bet, 53 times). An absolute
 * threshold ("does this stock's signal clear 60%?") lets market drift masquerade as skill.
 *
 * THE FIX (standard quant-equity design): don't ask "is this a buy?" — ask "is this
 * BETTER THAN ITS PEERS?". Each day, RANK the whole universe by signal, go long the top
 * slice and short the bottom slice in equal dollars. Market drift affects both legs and
 * CANCELS. What's left is pure cross-sectional information — or nothing at all, revealed.
 *
 * METHOD (Jegadeesh-Titman overlapping portfolios — the right way to handle H-day holds):
 *   • Each day t, rank every name with data by the board's ensemble vote.
 *   • Form a portfolio: long the top Q%, short the bottom Q%, equal-weight, dollar-neutral.
 *   • Hold H days. On any given day, H portfolios are open; each contributes 1/H of capital.
 *   • Daily return = the average across open cohorts → a clean daily return series whose
 *     t-stat needs no clustering hack (it IS one observation per day).
 *   • COSTS: each rebalance trades both legs; 1/H of the book turns over daily. Daily cost
 *     = (2 legs × 2 sides × COST_BPS) / H. Reported at 0 / 5 / 10 bps per side.
 *   • BETA CHECK: regress the daily L/S return on SPY's daily return. A true market-neutral
 *     book should show beta ≈ 0. If beta is large, the "neutrality" is fake and the result
 *     is the same old drift.
 *   • Benchmarks: the LONG leg alone (has beta), the SHORT leg alone, and SPY itself.
 *   • Splits: out-of-sample 60/40 chronological, and by year.
 *
 * Usage: node backend/cross-sectional-test.js        (env: DAYS=760 Q=10 HOLDS=1,5,10,20)
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC) { console.error("\n  Missing ALPACA keys.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "760");
const Q = parseFloat(process.env.Q || "10");                  // % of universe in each leg
const HOLDS = (process.env.HOLDS || "1,5,10,20").split(",").map(Number);
const COSTS = [0, 5, 10];                                     // bps per side, per leg

const UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","CRM","ADBE","AVGO","INTC","QCOM","MU","TXN","ORCL","CSCO","IBM","NOW","SNOW","PLTR","SHOP","UBER","ABNB","COIN","PYPL","ROKU","ZM","DOCU","DDOG","NET","CRWD","ZS","OKTA","MDB","TWLO","TEAM","WDAY","PANW","FTNT","MRVL","ON","SMCI","ARM","DELL","HPQ","WDC","STX","ANET","KLAC","LRCX","AMAT","ASML","TSM","SOFI","HOOD","AFRM","UPST","RIVN","LCID","NIO","XPEV","LI","F","GM","BA","CAT","DE","GE","HON","UNP","JPM","BAC","GS","MS","C","WFC","SCHW","V","MA","AXP","COF","BLK","LLY","UNH","JNJ","PFE","MRK","ABBV","BMY","MRNA","REGN","VRTX","GILD","AMGN","ISRG","DXCM","XOM","CVX","COP","OXY","SLB","HAL","MPC","WMT","COST","TGT","HD","LOW","NKE","SBUX","MCD","DIS","CMCSA","T","VZ","PG","KO","PEP","MARA","RIOT","MSTR","DKNG","CVNA","CHWY","RBLX","U","DASH","PINS","SNAP","SPOT","TTD","ENPH","FSLR","BABA","JD","PDD","MELI","SE","CMG","LULU","ORLY","ROST","TJX","MMM","LMT","RTX","NOC","GD","UPS","FDX","CSX","NSC","EMR","ITW","PH","ETN","APD","LIN","SHW","ECL","NEM","FCX","NUE","STLD","DOW","DD","PPG","KMB","CL","GIS","K","HSY","STZ","MO","PM","EL","SYY","ADM","BG","CF","MOS","DVN","FANG","EOG","PSX","VLO","KMI","WMB","OKE","D","DUK","SO","NEE","AEP","EXC","SRE","PCG","ED","XEL","WEC","AWK","AMT","PLD","EQIX","CCI","PSA","O","SPG","DLR","AVB","EQR","VICI","WELL","ARE","BXP","HST","KIM","REG","WSM","BLDR","DECK","CASY","GGG","NDSN","RPM","WSO","LII","TTC","WMS","AOS","ACM","MLM","VMC","FIX","POOL","SITE","WCC","AIT","MSM","GWW","ALLE","GTLS","CR","FLS","IEX","PNR","MAS","OC","WAL","EWBC","SNV","CRS","ATI","CMC","MP","CCJ","RUN","SEDG","ORA","ATO","HL","CDE","PAAS","WPM","FNV","RGLD","GOLD","AEM","KGC","CORT","RXRX","TWST","MYGN","NEOG","XRAY","HSIC","CHE","EHC","ENSG","THC","UHS","ACHC","OPCH","GKOS","LNTH","RDNT","AKAM","BOX","DBX","FIVN","RNG","PD","WK","APP","DUOL","BILL","GTLB","CFLT","S","PATH","ESTC","FROG","APPF","MNDY","WIX","YELP","ZG","BMRN","NBIX","UTHR","RPRX","JAZZ","ACAD","SRPT","RARE","IONS","NTRA","TECH","MEDP","ARWR","BPMC","CYTK","INSM","ROIV","KRYS","VKTX","RYTM","CRNX","AXSM","APLS","FOLD","DLTR","ULTA","WING","TXRH","SWKS","QRVO","LSCC","AMKR","TER","NVMI","ONTO","ACLS","FORM","RMBS","POWI","DIOD","CRUS","SLAB","SITM","ZI","PCTY","PEGA","FFIV","SSNC","GEN","CARG","TRIP","EXPE","MAR","HLT","WYNN","MGM","CZR","LVS","KMX","GPC","APTV","BWA","LEA","WHR","NVR","PHM","DHI","LEN","TOL","BTI","CHD","KR","SFM","ACI","MDLZ","CPB","HRL","SJM","MKC","CLX","CAG","TSN","EQT","AR","RRC","SWN","CHK","MTDR","PR","CTRA","APA","MRO","OVV","TRGP","ET","LNG","IDA","POR","AVA","BKH","NWE","SR","SWX","NJR","OGS","CPK","MGEE","ALE","MDU"];

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
const tOf = a => a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0;
const ann = a => mean(a) * 252 * 100;
const shp = a => sd(a) > 0 ? mean(a) / sd(a) * Math.sqrt(252) : 0;
const maxDD = a => { let eq = 1, pk = 1, dd = 0; for (const r of a) { eq *= 1 + r; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); } return dd * 100; };
const ema = (arr, n) => { const k = 2 / (n + 1); let e = arr[0]; const o = [e]; for (let i = 1; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); o.push(e); } return o; };
function rsi(c, p = 14) { const o = new Array(c.length).fill(null); let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; } g /= p; l /= p; o[p] = 100 - 100 / (1 + (l ? g / l : 100)); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (p - 1) + Math.max(0, d)) / p; l = (l * (p - 1) + Math.max(0, -d)) / p; o[i] = 100 - 100 / (1 + (l ? g / l : 100)); } return o; }

// The board's ensemble vote (same 7-model port used by lesson-replay).
function voteAt(c, h, l, e20, e50, rs, i) {
  if (i < 60) return null;
  const sma20 = mean(c.slice(i - 19, i + 1));
  const sd20 = Math.sqrt(mean(c.slice(i - 19, i + 1).map(v => (v - sma20) ** 2)));
  const v = [];
  v.push(e20[i] > e50[i] ? 1 : -1);
  v.push(c[i] > sma20 + 2 * sd20 ? -1 : c[i] < sma20 - 2 * sd20 ? 1 : 0);
  v.push(rs[i] > 70 ? -1 : rs[i] < 30 ? 1 : 0);
  v.push(c[i] > mean(c.slice(i - 9, i + 1)) ? 1 : -1);
  const hi55 = Math.max(...h.slice(i - 55, i)), lo55 = Math.min(...l.slice(i - 55, i));
  v.push(c[i] > hi55 ? 1 : c[i] < lo55 ? -1 : 0);
  v.push(e20[i] > e50[i] && c[i] > e20[i] ? 1 : (e20[i] < e50[i] && c[i] < e20[i]) ? -1 : 0);
  v.push(c[i] > c[i - 5] ? 1 : -1);
  return mean(v);
}

(async () => {
  console.log(`\n  TRAIDS — CROSS-SECTIONAL MARKET-NEUTRAL TEST`);
  console.log(`  ${UNIVERSE.length} names · ~${DAYS}d · long top ${Q}% / short bottom ${Q}% by ensemble vote · dollar-neutral`);
  console.log(`  overlapping ${HOLDS.join("/")}-day portfolios · costs 0/5/10 bps per side per leg\n`);

  process.stdout.write("  fetching");
  const data = {};
  for (const s of UNIVERSE) { const d = await bars(s); process.stdout.write("."); if (d.length > 80) data[s] = d; }
  const syms = Object.keys(data);
  console.log(` ${syms.length} names\n`);

  // precompute per symbol: date-indexed close + vote
  const idx = {}, vote = {}, close = {};
  for (const s of syms) {
    const d = data[s], c = d.map(x => x.c), h = d.map(x => x.h), l = d.map(x => x.l);
    const e20 = ema(c, 20), e50 = ema(c, 50), rs = rsi(c);
    const ix = {}, vt = {}, cl = {};
    for (let i = 0; i < d.length; i++) { ix[d[i].t] = i; cl[d[i].t] = c[i]; const v = voteAt(c, h, l, e20, e50, rs, i); if (v != null) vt[d[i].t] = v; }
    idx[s] = ix; vote[s] = vt; close[s] = cl;
  }
  const dates = [...new Set(syms.flatMap(s => data[s].map(b => b.t)))].sort();
  const spy = data["SPY"] ? null : null;   // SPY not in universe; fetch separately for the beta check
  const spyBars = await bars("SPY");
  const spyRet = {}; for (let i = 1; i < spyBars.length; i++) spyRet[spyBars[i].t] = spyBars[i].c / spyBars[i - 1].c - 1;

  // forward 1-day return of a name from date t (used to accrue each open cohort daily)
  const fwd1 = (s, t) => { const i = idx[s][t]; const d = data[s]; if (i == null || i + 1 >= d.length) return null; return d[i + 1].c / d[i].c - 1; };

  const pad = (s, n) => String(s).padEnd(n);
  const results = {};

  for (const H of HOLDS) {
    // cohorts formed on each date; each contributes 1/H of capital for H days
    const cohorts = [];   // { formed, longs:[], shorts:[], daysLeft }
    const dailyLS = [], dailyLong = [], dailyShort = [], dailyDates = [];
    for (let di = 60; di < dates.length - 1; di++) {
      const t = dates[di];
      // 1) accrue today's return on every OPEN cohort
      let lsSum = 0, longSum = 0, shortSum = 0, live = 0;
      for (const co of cohorts) {
        if (co.daysLeft <= 0) continue;
        const lr = mean(co.longs.map(s => fwd1(s, t)).filter(x => x != null));
        const sr = mean(co.shorts.map(s => fwd1(s, t)).filter(x => x != null));
        lsSum += (lr - sr) / 2;   // dollar-neutral: half capital each leg
        longSum += lr; shortSum += sr;
        live++;
        co.daysLeft--;
      }
      // 2) form a NEW cohort on this date
      const ranked = syms.filter(s => vote[s][t] != null && Math.abs(vote[s][t]) >= 0)
                         .map(s => ({ s, v: vote[s][t] }))
                         .sort((a, b) => b.v - a.v);
      if (ranked.length >= 40) {
        const k = Math.max(3, Math.floor(ranked.length * Q / 100));
        cohorts.push({ longs: ranked.slice(0, k).map(x => x.s), shorts: ranked.slice(-k).map(x => x.s), daysLeft: H });
      }
      while (cohorts.length && cohorts[0].daysLeft <= 0) cohorts.shift();
      if (live > 0) { dailyLS.push(lsSum / live); dailyLong.push(longSum / live); dailyShort.push(shortSum / live); dailyDates.push(t); }
    }
    results[H] = { dailyLS, dailyLong, dailyShort, dailyDates };
  }

  console.log("  ── MARKET-NEUTRAL LONG/SHORT (the beta-stripped test) ──\n");
  console.log("    " + pad("hold", 7) + pad("cost", 8) + pad("ann ret", 11) + pad("Sharpe", 9) + pad("t-stat", 9) + pad("maxDD", 10) + "days");
  for (const H of HOLDS) {
    const { dailyLS, dailyDates } = results[H];
    for (const cb of COSTS) {
      const dailyCost = (2 * 2 * cb / 10000) / H;   // 2 legs × 2 sides, amortized over the hold
      const net = dailyLS.map(r => r - dailyCost);
      console.log("    " + pad(H + "d", 7) + pad(cb + "bps", 8) +
        pad((ann(net) >= 0 ? "+" : "") + ann(net).toFixed(2) + "%", 11) +
        pad(shp(net).toFixed(2), 9) + pad(tOf(net).toFixed(2), 9) +
        pad(maxDD(net).toFixed(1) + "%", 10) + dailyDates.length);
    }
    console.log("");
  }

  // beta check + leg decomposition on the primary hold
  const H0 = HOLDS.includes(5) ? 5 : HOLDS[0];
  const { dailyLS, dailyLong, dailyShort, dailyDates } = results[H0];
  const spyAligned = dailyDates.map(t => spyRet[t] ?? 0);
  const cov = mean(dailyLS.map((r, i) => (r - mean(dailyLS)) * (spyAligned[i] - mean(spyAligned))));
  const beta = cov / (sd(spyAligned) ** 2 || 1);
  console.log(`  ── BETA CHECK (${H0}-day hold) — is the neutrality REAL? ──`);
  console.log(`    L/S beta vs SPY: ${beta.toFixed(3)}   (a true market-neutral book ≈ 0; large |beta| ⇒ the old drift in disguise)`);
  console.log(`    LONG leg alone:  ann ${(ann(dailyLong) >= 0 ? "+" : "") + ann(dailyLong).toFixed(2)}%  Sharpe ${shp(dailyLong).toFixed(2)}   ← carries market beta`);
  console.log(`    SHORT leg alone: ann ${(ann(dailyShort) >= 0 ? "+" : "") + ann(dailyShort).toFixed(2)}%  Sharpe ${shp(dailyShort).toFixed(2)}   ← (return of the shorted names)`);
  console.log(`    SPY itself:      ann ${(ann(spyAligned) >= 0 ? "+" : "") + ann(spyAligned).toFixed(2)}%  Sharpe ${shp(spyAligned).toFixed(2)}`);
  console.log(`    → the L/S spread is LONG-leg minus SHORT-leg: if it's ~0, the ensemble ranks no better than chance.\n`);

  // OOS split + by year on the primary hold, net of 5bps
  const dailyCost5 = (2 * 2 * 5 / 10000) / H0;
  const net5 = dailyLS.map(r => r - dailyCost5);
  const cut = Math.floor(net5.length * 0.6);
  console.log(`  ── OUT-OF-SAMPLE (${H0}d, net 5bps) ──`);
  console.log(`    in-sample  (first 60%): ann ${(ann(net5.slice(0, cut)) >= 0 ? "+" : "") + ann(net5.slice(0, cut)).toFixed(2)}%  t ${tOf(net5.slice(0, cut)).toFixed(2)}`);
  console.log(`    out-of-sample (last 40%): ann ${(ann(net5.slice(cut)) >= 0 ? "+" : "") + ann(net5.slice(cut)).toFixed(2)}%  t ${tOf(net5.slice(cut)).toFixed(2)}\n`);
  const years = [...new Set(dailyDates.map(d => d.slice(0, 4)))].sort();
  console.log(`  ── BY YEAR (${H0}d, net 5bps) ──`);
  for (const y of years) {
    const seg = net5.filter((_, i) => dailyDates[i].slice(0, 4) === y);
    if (seg.length > 20) console.log(`    ${y}: ann ${(ann(seg) >= 0 ? "+" : "") + ann(seg).toFixed(2).padStart(7)}%   Sharpe ${shp(seg).toFixed(2).padStart(6)}   (${seg.length}d)`);
  }

  console.log(`\n  VERDICT RULE: a REAL cross-sectional edge = positive net of 5-10bps, Sharpe > ~0.5,`);
  console.log(`  t > 2, beta ≈ 0, holding out-of-sample and across years. Anything less and the ensemble`);
  console.log(`  carries no ranking information — which would finally settle it: every past "edge" was beta,`);
  console.log(`  and with beta removed there is nothing left.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
