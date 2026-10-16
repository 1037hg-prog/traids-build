#!/usr/bin/env node
/**
 * TRAIDS — WHOLE-BOOK COST SENSITIVITY (companion to test #32)
 *
 * WHY. The pocket sweep found 28 conditional cells and every one negative, clustered around
 * −0.048R, against a flat charge of 0.05R. That pattern says the board is a coin flip GROSS and
 * loses by the toll — but it was measured at ONE cost assumption, chosen before anyone asked
 * whether it was the right one. If 0.05R is pessimistic, the conclusion softens; if it is
 * optimistic, the board is worse than reported. Either way the number was never graded.
 *
 * THE KEY STRUCTURAL FACT that makes this cheap: the sweep settles as
 *     r = ((exit − entry) · dir) / stopDist − COST_R
 * so cost enters as a pure additive shift on R. Replay ONCE storing gross R, and every cost
 * level is then exact arithmetic rather than another five-minute refetch. Mean R shifts
 * linearly; WIN RATE does not, because a trade at gross +0.03R is a winner at 2bp and a loser
 * at 5bp — so win rate is recomputed per trade, per cost level, never extrapolated.
 *
 * THE TRANSLATION THAT MAKES IT DECIDABLE. "0.05R" is not something anyone can check against a
 * broker statement. R is the stop distance, and the stop is 1.5×ATR, so
 *     cost_as_fraction_of_notional = COST_R × stopDist / entry = COST_R × 1.5 × (ATR/price)
 * Every trade therefore carries its own conversion, and the grid is reported in BOTH units.
 * Basis points of notional is the unit a fill report is denominated in; R is not.
 *
 * WHAT THIS CANNOT SETTLE. It grades the COST ASSUMPTION, not the fill assumption underneath
 * it. Every exit here is a stop, a target, or a close — all modelled, none observed. Task #45
 * (fill-realism) is the study that would test whether those fills are attainable, and it has
 * not been run. A book that only works at 1bp is a book betting on fills nobody has verified.
 *
 * Usage:  node backend/cost-sensitivity-book.js        (env: DAYS=760)
 *         re-uses backend/data/book-gross.json if present; pass --refresh to replay
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "760");
const ATR_MULT = 1.5, RR = 2, CONF_BAR = 0.60;
const CACHE = path.join(__dirname, "data", "book-gross.json");
const REFRESH = process.argv.includes("--refresh");

// identical universe to pocket-sweep.js — same book, or the comparison is meaningless
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
  return { vote, conf: Math.min(0.99, 0.45 + 0.09 * agree) };
}

async function replay() {
  const trades = [];
  process.stdout.write("  replaying");
  const spyBars = await bars("SPY");
  const spyC = spyBars.map(b => b.c), spyE50 = ema(spyC, 50);
  const spyUp = {}; spyBars.forEach((b, i) => spyUp[b.t] = spyC[i] > spyE50[i]);
  for (const sym of UNIVERSE) {
    const d = await bars(sym); process.stdout.write(".");
    if (d.length < 80) continue;
    const c = d.map(x => x.c), h = d.map(x => x.h), l = d.map(x => x.l);
    const pre = { c, h, l, e20: ema(c, 20), e50: ema(c, 50), rs: rsiArr(c) };
    const A = atr(h, l, c, 14);
    for (let i = 60; i < d.length - 1; i++) {
      const s = signalAt(d, i, pre);
      if (!(s && s.conf >= CONF_BAR && Math.abs(s.vote) >= 0.3 && A[i] > 0)) continue;
      const dir = Math.sign(s.vote);
      const entry = c[i], stopDist = A[i] * ATR_MULT;
      const stop = entry - dir * stopDist, target = entry + dir * stopDist * RR;
      const nb = d[i + 1];
      const gapped = dir > 0 ? nb.o <= stop : nb.o >= stop;
      const hitStop = dir > 0 ? nb.l <= stop : nb.h >= stop;
      const hitTgt = dir > 0 ? nb.h >= target : nb.l <= target;
      const exit = hitStop ? (gapped ? nb.o : stop) : hitTgt ? target : nb.c;
      trades.push({
        t: d[i].t,
        g: ((exit - entry) * dir) / stopDist,     // GROSS R — cost applied later
        // stopDist/entry converts a cost in R into a cost in notional:
        //   bps_of_notional = COST_R * (stopDist/entry) * 10000
        sf: stopDist / entry,
        reg: spyUp[d[i].t] == null ? "na" : (dir > 0) === spyUp[d[i].t] ? "aligned" : "counter",
      });
    }
  }
  console.log("");
  return trades;
}

(async () => {
  console.log(`\n  TRAIDS — WHOLE-BOOK COST SENSITIVITY`);
  console.log(`  the same replay as test #32, scored across a cost grid instead of one assumption\n`);

  let trades;
  if (!REFRESH && fs.existsSync(CACHE)) {
    trades = JSON.parse(fs.readFileSync(CACHE, "utf8")).trades;
    console.log(`  using cached gross book (${trades.length.toLocaleString()} trades) — pass --refresh to replay\n`);
  } else {
    trades = await replay();
    fs.writeFileSync(CACHE, JSON.stringify({ generated: new Date().toISOString(), days: DAYS, atrMult: ATR_MULT, rr: RR, confBar: CONF_BAR, trades }));
    console.log(`  cached to backend/data/book-gross.json\n`);
  }

  const days = [...new Set(trades.map(t => t.t))];
  const medSf = (() => { const a = trades.map(t => t.sf).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; })();
  console.log(`  ${trades.length.toLocaleString()} trades on ${days.length} sessions · median stop = ${(medSf * 100).toFixed(2)}% of price`);
  console.log(`  so 0.01R of cost = ${(0.01 * medSf * 10000).toFixed(1)} bps of notional round-trip, at the median trade\n`);

  // day-clustered t: signals cluster by session, so per-trade t would be inflated
  const clusterT = (rows, cost) => {
    const byDay = {};
    for (const t of rows) (byDay[t.t] ||= []).push(t.g - cost);
    const per = Object.values(byDay).map(mean);
    const m = mean(per), s = sd(per);
    return { m, t: s > 0 ? m / (s / Math.sqrt(per.length)) : 0, k: per.length };
  };

  const score = (rows, cost) => {
    const net = rows.map(t => t.g - cost);
    const w = net.filter(x => x > 0), l = net.filter(x => x <= 0);
    const gp = w.reduce((s, x) => s + x, 0), gl = Math.abs(l.reduce((s, x) => s + x, 0));
    const c = clusterT(rows, cost);
    return { n: net.length, win: 100 * w.length / net.length, avgR: mean(net), pf: gl > 0 ? gp / gl : Infinity, t: c.t, k: c.k };
  };

  const GRID = [0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.04, 0.05, 0.075, 0.10];
  console.log(`  ══ WHOLE BOOK ACROSS THE COST GRID ══`);
  console.log(`  cost(R)   bps r/t    win%     avgR       PF      day-clust t   verdict`);
  console.log(`  ${"".padEnd(78, "─")}`);
  for (const c of GRID) {
    const s = score(trades, c);
    const v = s.avgR > 0 ? (Math.abs(s.t) > 1.96 ? "POSITIVE, significant" : "positive, not significant") : (Math.abs(s.t) > 1.96 ? "NEGATIVE, significant" : "negative, not significant");
    console.log(`  ${c.toFixed(3).padStart(6)}   ${(c * medSf * 10000).toFixed(1).padStart(6)}   ${s.win.toFixed(1).padStart(6)}%  ${(s.avgR >= 0 ? "+" : "") + s.avgR.toFixed(4)}   ${s.pf.toFixed(3).padStart(6)}   ${s.t.toFixed(2).padStart(8)}      ${v}`);
  }

  // breakeven: cost at which mean net R = 0 is exactly mean gross R
  const be = mean(trades.map(t => t.g));
  console.log(`\n  ══ BREAKEVEN ══`);
  console.log(`  gross expectancy          ${(be >= 0 ? "+" : "") + be.toFixed(4)}R`);
  console.log(`  -> the book breaks even only if total round-trip friction stays under ${be.toFixed(4)}R`);
  console.log(`     = ${(be * medSf * 10000).toFixed(1)} bps of notional, round trip, at the median trade`);
  const g0 = clusterT(trades, 0);
  console.log(`  and even at ZERO cost the gross book is ${(g0.m >= 0 ? "+" : "") + g0.m.toFixed(4)}R, day-clustered t ${g0.t.toFixed(2)} over ${g0.k} sessions`);
  console.log(`     -> ${Math.abs(g0.t) > 1.96 ? (g0.m > 0 ? "a real gross edge exists; the whole question is whether it clears the toll" : "the book is significantly negative BEFORE any cost — friction is not the problem") : "gross is indistinguishable from zero: there is no edge to protect from costs"}`);

  console.log(`\n  ══ THE #7 SPLIT, ACROSS COSTS ══`);
  console.log(`  cohort        cost 0     cost 0.01   cost 0.02   cost 0.05`);
  for (const [lbl, rows] of [["aligned (#7 keeps)", trades.filter(t => t.reg === "aligned")], ["counter (#7 blocks)", trades.filter(t => t.reg === "counter")]]) {
    const cells = [0, 0.01, 0.02, 0.05].map(c => { const s = score(rows, c); return ((s.avgR >= 0 ? "+" : "") + s.avgR.toFixed(4)).padStart(9); });
    console.log(`  ${lbl.padEnd(20)} ${cells.join("  ")}`);
  }
  console.log(`\n  written: backend/data/book-gross.json (gross R cached — future cost questions are instant)\n`);
})();
