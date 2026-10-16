#!/usr/bin/env node
/**
 * TRAIDS — POCKET SWEEP (test #32): the exhaustive "is there a trend ANYWHERE" answer.
 *
 * THE QUESTION (user's): "I'm trying to nail a trend with our trades." Eyeballing the
 * winner tail can't do that (n=5, four from one day). This is the industrial version:
 * replay the board's signals across the full universe, tag every trade with every
 * observable condition at entry, then test EVERY pocket simultaneously — with the
 * significance bar raised for the number of pockets searched (Benjamini-Hochberg FDR,
 * plus Bonferroni as the hard line). Searching hundreds of cells GUARANTEES some look
 * good by chance (~5% at p<0.05); the correction is what separates found from minted.
 *
 * Conditions per trade (all computable at entry, no look-ahead):
 *   strategy · direction · confidence band · SPY-regime alignment · 6-month momentum
 *   bucket · RSI bucket · ATR%-of-price (vol) bucket · 5-day run-up sign · signal age
 *   (fresh day-1 vs carried — the sigAge question, tested with power TODAY) · weekday
 * Cells: every single-factor bucket + curated two-ways (strategy×dir, strategy×regime,
 * dir×regime, dir×momentum, dir×sigAge, strategy×sigAge).
 *
 * PRE-REGISTERED RULES (before running):
 *   • A cell is only TESTED if n ≥ 200 trades on ≥ 40 distinct sessions.
 *   • Stats are day-clustered (signals cluster by session; per-trade t would be inflated).
 *   • R is net of 0.05R cost, gap-aware, stop-first — same physics as H1/H2/H3.
 *   • A pocket COUNTS only if it survives BH-FDR at 5%. Bonferroni survivors are the
 *     gold tier. Survivors go to forward confirmation — never straight to a rule change.
 *   • Expected outcome, stated in advance: nothing survives. This is written down so a
 *     surprise is a real surprise.
 *
 * Usage: node backend/pocket-sweep.js   (env: DAYS=760)
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "760");
const ATR_MULT = 1.5, RR = 2, CONF_BAR = 0.60, COST_R = 0.05;
const MIN_N = 200, MIN_DAYS = 40;

const UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","CRM","ADBE","AVGO","INTC","QCOM","MU","TXN","ORCL","CSCO","IBM","NOW","SNOW","PLTR","SHOP","UBER","ABNB","COIN","PYPL","ROKU","ZM","DOCU","DDOG","NET","CRWD","ZS","OKTA","MDB","TWLO","TEAM","WDAY","PANW","FTNT","MRVL","ON","SMCI","ARM","DELL","HPQ","WDC","STX","ANET","KLAC","LRCX","AMAT","ASML","TSM","SOFI","HOOD","AFRM","UPST","RIVN","LCID","NIO","XPEV","LI","F","GM","BA","CAT","DE","GE","HON","UNP","JPM","BAC","GS","MS","C","WFC","SCHW","V","MA","AXP","COF","BLK","LLY","UNH","JNJ","PFE","MRK","ABBV","BMY","MRNA","REGN","VRTX","GILD","AMGN","ISRG","DXCM","XOM","CVX","COP","OXY","SLB","HAL","MPC","WMT","COST","TGT","HD","LOW","NKE","SBUX","MCD","DIS","CMCSA","T","VZ","PG","KO","PEP","MARA","RIOT","MSTR","DKNG","CVNA","CHWY","RBLX","U","DASH","PINS","SNAP","SPOT","TTD","ENPH","FSLR","BABA","JD","PDD","SPY","QQQ","IWM","XLK","XLF","XLE","XLV","GLD","SLV","TLT","HYG","EEM","MELI","SE","CMG","LULU","ORLY","ROST","TJX","MMM","LMT","RTX","NOC","GD","UPS","FDX","CSX","NSC","EMR","ITW","PH","ETN","APD","LIN","SHW","ECL","NEM","FCX","NUE","STLD","DOW","DD","PPG","KMB","CL","GIS","K","HSY","STZ","MO","PM","EL","SYY","ADM","BG","CF","MOS","DVN","FANG","EOG","PSX","VLO","KMI","WMB","OKE","D","DUK","SO","NEE","AEP","EXC","SRE","PCG","ED","XEL","WEC","AWK","AMT","PLD","EQIX","CCI","PSA","O","SPG","DLR","AVB","EQR","VICI","WELL","ARE","BXP","HST","KIM","REG"];

async function bars(sym) {
  const start = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const out = []; let tok = null;
  do {
    const p = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED });
    if (tok) p.set("page_token", tok);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${p}`, { headers });
    if (!r.ok) break;
    const j = await r.json();
    for (const b of (j.bars?.[sym] || [])) out.push({ t: (b.t || "").slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c });
    tok = j.next_page_token || null;
  } while (tok);
  return out;
}
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const tOf = a => a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0;
// two-sided p from t (normal approx, fine at df≥40). NB: this classic approximation
// exp(−0.717z − 0.416z²) already lands on the TWO-sided value (z=1.96 → 0.0496); do not
// double it — doing so would understate significance and could hide a real survivor.
const pOf = (t) => { const z = Math.abs(t); return Math.min(1, Math.exp(-0.717 * z - 0.416 * z * z)); };
const ema = (arr, n) => { const k = 2 / (n + 1); let e = arr[0]; const out = [e]; for (let i = 1; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); } return out; };
function atr(h, l, c, p = 14) { const tr = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); const r = new Array(c.length).fill(null); r[p - 1] = mean(tr.slice(0, p)); for (let i = p; i < c.length; i++) r[i] = (r[i - 1] * (p - 1) + tr[i]) / p; return r; }
function rsiArr(c, p = 14) { const out = new Array(c.length).fill(null); let g = 0, ls = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else ls -= d; } g /= p; ls /= p; out[p] = 100 - 100 / (1 + (ls ? g / ls : 100)); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (p - 1) + Math.max(0, d)) / p; ls = (ls * (p - 1) + Math.max(0, -d)) / p; out[i] = 100 - 100 / (1 + (ls ? g / ls : 100)); } return out; }
function signalAt(d, i, pre) {
  if (i < 60) return null;
  const { c, h, l, e20, e50, rs } = pre;
  const sma20 = mean(c.slice(i - 19, i + 1)), sd20 = Math.sqrt(mean(c.slice(i - 19, i + 1).map(v => (v - sma20) ** 2)));
  const votes = [];
  votes.push(e20[i] > e50[i] ? 1 : -1);
  votes.push(c[i] > sma20 + 2 * sd20 ? -1 : c[i] < sma20 - 2 * sd20 ? 1 : 0);
  votes.push(rs[i] > 70 ? -1 : rs[i] < 30 ? 1 : 0);
  votes.push(c[i] > mean(c.slice(i - 9, i + 1)) ? 1 : -1);
  const hi55 = Math.max(...h.slice(Math.max(0, i - 55), i)), lo55 = Math.min(...l.slice(Math.max(0, i - 55), i));
  votes.push(c[i] > hi55 ? 1 : c[i] < lo55 ? -1 : 0);
  const trendUp = e20[i] > e50[i] && c[i] > e20[i];
  votes.push(trendUp ? 1 : (e20[i] < e50[i] && c[i] < e20[i]) ? -1 : 0);
  votes.push(c[i] > c[i - 5] ? 1 : -1);
  const vote = mean(votes);
  const agree = votes.filter(v => Math.sign(v) === Math.sign(vote) && v !== 0).length;
  const conf = Math.min(0.99, 0.45 + 0.09 * agree);
  const strat = Math.abs(votes[4]) === 1 ? "Breakout" : Math.abs(votes[1]) === 1 ? "MeanRev" : trendUp || votes[5] === -1 ? "Trend" : "Ensemble";
  return { vote, conf, strat };
}

(async () => {
  console.log(`\n  TRAIDS — POCKET SWEEP (test #32) · every pocket at once, multiplicity-corrected`);
  console.log(`  ${UNIVERSE.length} names · ~${DAYS}d · gap-aware, stop-first, cost ${COST_R}R · cell bar: n≥${MIN_N}, ≥${MIN_DAYS} sessions · BH-FDR 5% / Bonferroni\n`);

  process.stdout.write("  fetching SPY (regime)…");
  const spyBars = await bars("SPY");
  const spyC = spyBars.map(b => b.c), spyE50 = ema(spyC, 50);
  const spyUp = {}; spyBars.forEach((b, i) => spyUp[b.t] = spyC[i] > spyE50[i]);
  console.log(" ok");

  const trades = [];
  process.stdout.write("  replaying");
  for (const sym of UNIVERSE) {
    const d = await bars(sym); process.stdout.write(".");
    if (d.length < 80) continue;
    const c = d.map(x => x.c), h = d.map(x => x.h), l = d.map(x => x.l);
    const pre = { c, h, l, e20: ema(c, 20), e50: ema(c, 50), rs: rsiArr(c) };
    const A = atr(h, l, c, 14);
    let lastDir = 0, streak = 0;
    for (let i = 60; i < d.length - 1; i++) {
      const s = signalAt(d, i, pre);
      const fired = s && s.conf >= CONF_BAR && Math.abs(s.vote) >= 0.3 && A[i] > 0;
      if (!fired) { lastDir = 0; streak = 0; continue; }
      const dir = Math.sign(s.vote);
      streak = (dir === lastDir) ? streak + 1 : 1;      // consecutive days this signal has fired
      lastDir = dir;
      const entry = c[i], stopDist = A[i] * ATR_MULT;
      const stop = entry - dir * stopDist, target = entry + dir * stopDist * RR;
      const nb = d[i + 1];
      const gapped = dir > 0 ? nb.o <= stop : nb.o >= stop;
      const hitStop = dir > 0 ? nb.l <= stop : nb.h >= stop;
      const hitTgt = dir > 0 ? nb.h >= target : nb.l <= target;
      const exit = hitStop ? (gapped ? nb.o : stop) : hitTgt ? target : nb.c;
      const r = ((exit - entry) * dir) / stopDist - COST_R;
      // conditions at entry
      const mom126 = i >= 126 ? c[i] / c[i - 126] - 1 : null;
      const rsi = pre.rs[i];
      const volPct = A[i] / entry;                       // ATR as % of price
      const rev5 = (c[i] / c[i - 5] - 1) * dir;          // 5d run-up in trade direction
      const dow = new Date(d[i].t + "T12:00:00Z").getUTCDay();
      const regime = spyUp[d[i].t] == null ? "na" : (dir > 0) === spyUp[d[i].t] ? "aligned" : "counter";
      trades.push({ t: d[i].t, r,
        conds: {
          ["strat:" + s.strat]: 1, ["dir:" + (dir > 0 ? "L" : "S")]: 1,
          ["conf:" + (s.conf >= 0.8 ? "hi" : "lo")]: 1,
          ["regime:" + regime]: 1,
          ["mom6m:" + (mom126 == null ? "na" : mom126 > 0.15 ? "strong" : mom126 < -0.15 ? "weak" : "flat")]: 1,
          ["rsi:" + (rsi >= 60 ? "hi" : rsi <= 40 ? "lo" : "mid")]: 1,
          ["vol:" + (volPct >= 0.035 ? "hi" : volPct <= 0.015 ? "lo" : "mid")]: 1,
          ["runup5:" + (rev5 > 0 ? "with" : "against")]: 1,
          ["sigAge:" + (streak === 1 ? "fresh" : streak <= 3 ? "d2-3" : "d4+")]: 1,
          ["dow:" + ["sun","mon","tue","wed","thu","fri","sat"][dow]]: 1,
        },
        strat: s.strat, dirL: dir > 0, regime, sigAge: streak === 1 ? "fresh" : streak <= 3 ? "d2-3" : "d4+",
        mom: mom126 == null ? "na" : mom126 > 0.15 ? "strong" : mom126 < -0.15 ? "weak" : "flat" });
    }
  }
  console.log(`\n\n  ${trades.length.toLocaleString()} trades replayed on ${new Set(trades.map(t => t.t)).size} sessions\n`);

  // build cells: all single conditions + curated two-ways
  const cells = new Map();
  const add = (key, t) => { (cells.get(key) || cells.set(key, []).get(key)).push(t); };
  for (const t of trades) {
    for (const k in t.conds) add(k, t);
    const dir = t.dirL ? "L" : "S";
    add(`strat:${t.strat} × dir:${dir}`, t);
    add(`strat:${t.strat} × regime:${t.regime}`, t);
    add(`dir:${dir} × regime:${t.regime}`, t);
    add(`dir:${dir} × mom6m:${t.mom}`, t);
    add(`dir:${dir} × sigAge:${t.sigAge}`, t);
    add(`strat:${t.strat} × sigAge:${t.sigAge}`, t);
  }

  // test every qualifying cell, day-clustered
  const results = [];
  for (const [key, arr] of cells) {
    const byDay = {}; for (const t of arr) (byDay[t.t] = byDay[t.t] || []).push(t.r);
    const daily = Object.values(byDay).map(mean);
    if (arr.length < MIN_N || daily.length < MIN_DAYS) continue;
    const m = mean(arr.map(t => t.r)), tstat = tOf(daily), p = pOf(tstat);
    results.push({ key, n: arr.length, days: daily.length, avgR: m, t: tstat, p });
  }
  results.sort((a, b) => a.p - b.p);
  const M = results.length;
  // Benjamini-Hochberg
  let bhCut = -1;
  results.forEach((r, i) => { if (r.p <= (i + 1) / M * 0.05) bhCut = i; });
  const bonf = 0.05 / M;

  console.log(`  ${M} cells met the inclusion bar (of ${cells.size} formed) — Bonferroni line p < ${bonf.toExponential(1)}\n`);
  console.log("  rank  cell                                     n       days   avgR      t       p        verdict");
  console.log("  " + "-".repeat(103));
  results.slice(0, 15).forEach((r, i) => {
    const verdict = r.p <= bonf ? "★ BONFERRONI SURVIVOR" : i <= bhCut ? "✓ BH-FDR survivor" : "chance, once corrected";
    console.log("  " + String(i + 1).padStart(3) + "   " + r.key.padEnd(40) + String(r.n).padStart(6) + String(r.days).padStart(7) + "   " +
      ((r.avgR >= 0 ? "+" : "") + r.avgR.toFixed(4)).padStart(8) + r.t.toFixed(2).padStart(8) + r.p.toExponential(1).padStart(9) + "   " + verdict);
  });

  const survivors = results.filter((r, i) => i <= bhCut);
  console.log("\n  ── PRE-REGISTERED VERDICT ──");
  if (!survivors.length) {
    console.log("    ✕ NO POCKET SURVIVES multiplicity correction. Across every strategy, direction,");
    console.log("      regime, momentum state, RSI, vol bucket, signal age, and weekday — and their");
    console.log("      combinations — nothing clears the bar once the search itself is priced in.");
    console.log("      The nominal 'best' cells above are what " + M + " draws from a zero-mean process look like.");
  } else {
    console.log(`    ${survivors.length} cell(s) survive BH-FDR — candidates ONLY. Next step is forward confirmation`);
    console.log("      via the Edge Ledger gate, never direct adoption:");
    for (const s of survivors) console.log("      • " + s.key + `  (${(s.avgR >= 0 ? "+" : "") + s.avgR.toFixed(4)}R, t ${s.t.toFixed(2)}, p ${s.p.toExponential(1)})`);
  }
  console.log("");
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
