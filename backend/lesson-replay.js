#!/usr/bin/env node
/**
 * TRAIDS — LESSON REPLAY: answer the two open improvement hypotheses on ~2 years of
 * history instead of waiting weeks for n=100 forward trades.
 *
 * WHY THIS IS LEGITIMATE (and where it isn't):
 *   These are RELATIVE comparisons inside the SAME trade population — not edge claims.
 *   Backtest bias inflates whether a strategy makes money; it does NOT systematically
 *   favor one exit rule over another on identical entries, nor one entry-condition
 *   bucket over another. So history can answer "which exit is better?" honestly even
 *   though it cannot answer "is this profitable?" (27 tests already answered that: no).
 *   The forward record remains the confirmation set.
 *
 * PRE-REGISTERED HYPOTHESES (fixed before the run):
 *   H1 — EXIT RULE: taking profit at +1R beats riding to the 2R target.
 *        Paired: both outcomes computed on the SAME entries. Forward evidence so far: +0.042R for 1R-TP (n=24).
 *   H2 — 5-DAY RUN-UP FILTER: entries made after a large 5-day run in the trade's
 *        direction settle worse than entries after a flat/counter 5-day move.
 *        Forward evidence so far: −0.091R high-vs-low bucket gap (n=34).
 *
 * METHOD (mirrors the live board exactly):
 *   • Daily bars, ~470 liquid names (Alpaca), ~2 years.
 *   • Signal: the board's ensemble archetypes — a simplified faithful port (trend / breakout /
 *     mean-reversion / ensemble vote) with the same 60% confidence bar.
 *   • Entry at the signal day's CLOSE. Stop = 1.5×ATR(14). Target = 2R.
 *   • Settle on the NEXT session against its actual high/low; stop-first if both touched
 *     (identical to settleDay). rMult = as-traded; rMultTP = take profit at +1R.
 *   • MAE/MFE recorded per trade (the excursion data the live log now also captures).
 *   • Significance is DAY-CLUSTERED (all of a day's trades are one correlated bet).
 *
 * Usage: node backend/lesson-replay.js       (needs ALPACA keys)
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC) { console.error("\n  Missing ALPACA keys.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "760");
const ATR_MULT = 1.5, RR = 2, CONF_BAR = 0.60, COST_R = 0.05;   // cost ≈ 10bps on a ~1.4% stop

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
    for (const b of (j.bars?.[sym] || [])) out.push({ t: (b.t || "").slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
    tok = j.next_page_token || null;
  } while (tok);
  return out;
}
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const tOf = a => a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0;
const ema = (arr, n) => { const k = 2 / (n + 1); let e = arr[0]; const out = [e]; for (let i = 1; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); } return out; };
function atr(h, l, c, p = 14) { const tr = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); const r = new Array(c.length).fill(null); r[p - 1] = mean(tr.slice(0, p)); for (let i = p; i < c.length; i++) r[i] = (r[i - 1] * (p - 1) + tr[i]) / p; return r; }
function rsi(c, p = 14) { const out = new Array(c.length).fill(null); let g = 0, ls = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else ls -= d; } g /= p; ls /= p; out[p] = 100 - 100 / (1 + (ls ? g / ls : 100)); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (p - 1) + Math.max(0, d)) / p; ls = (ls * (p - 1) + Math.max(0, -d)) / p; out[i] = 100 - 100 / (1 + (ls ? g / ls : 100)); } return out; }

// Faithful-enough port of the board's ensemble: models vote, confidence = agreement strength.
function signalAt(d, i) {
  if (i < 60) return null;
  const c = d.map(x => x.c), h = d.map(x => x.h), l = d.map(x => x.l);
  const e20 = ema(c.slice(0, i + 1), 20), e50 = ema(c.slice(0, i + 1), 50);
  const r = rsi(c.slice(0, i + 1))[i];
  const sma20 = mean(c.slice(i - 19, i + 1)), sd20 = Math.sqrt(mean(c.slice(i - 19, i + 1).map(v => (v - sma20) ** 2)));
  const votes = [];
  votes.push(e20[i] > e50[i] ? 1 : -1);                                     // EMA alignment
  votes.push(c[i] > sma20 + 2 * sd20 ? -1 : c[i] < sma20 - 2 * sd20 ? 1 : 0); // Bollinger / mean-rev
  votes.push(r > 70 ? -1 : r < 30 ? 1 : 0);                                  // RSI
  votes.push(c[i] > mean(c.slice(i - 9, i + 1)) ? 1 : -1);                   // momentum
  const hi55 = Math.max(...h.slice(Math.max(0, i - 55), i)), lo55 = Math.min(...l.slice(Math.max(0, i - 55), i));
  votes.push(c[i] > hi55 ? 1 : c[i] < lo55 ? -1 : 0);                        // breakout
  const trendUp = e20[i] > e50[i] && c[i] > e20[i];
  votes.push(trendUp ? 1 : (e20[i] < e50[i] && c[i] < e20[i]) ? -1 : 0);     // trend
  votes.push(c[i] > c[i - 5] ? 1 : -1);                                      // 5d momentum
  const vote = mean(votes);
  const agree = votes.filter(v => Math.sign(v) === Math.sign(vote) && v !== 0).length;
  const conf = Math.min(0.99, 0.45 + 0.09 * agree);                          // ~agreement → confidence
  const strat = Math.abs(votes[4]) === 1 ? "Breakout" : Math.abs(votes[1]) === 1 ? "Mean-Reversion" : trendUp || votes[5] === -1 ? "Trend" : "Ensemble";
  return { vote, conf, strat };
}

(async () => {
  console.log(`\n  TRAIDS — LESSON REPLAY · pre-registered H1 (exit rule) + H2 (5-day run-up filter)`);
  console.log(`  ${UNIVERSE.length} names · ~${DAYS}d · entry at signal-day close · 1.5×ATR stop · settle next session · cost ${COST_R}R\n`);
  const trades = [];
  process.stdout.write("  replaying");
  for (const sym of UNIVERSE) {
    const d = await bars(sym); process.stdout.write(".");
    if (d.length < 80) continue;
    const H = d.map(x => x.h), L = d.map(x => x.l), C = d.map(x => x.c);
    const A = atr(H, L, C, 14);
    for (let i = 60; i < d.length - 1; i++) {
      const s = signalAt(d, i);
      if (!s || s.conf < CONF_BAR || Math.abs(s.vote) < 0.3) continue;
      const a = A[i]; if (!(a > 0)) continue;
      const dir = Math.sign(s.vote), entry = C[i], stopDist = a * ATR_MULT;
      const stop = entry - dir * stopDist, target = entry + dir * stopDist * RR, tp1 = entry + dir * stopDist;
      const nb = d[i + 1];
      const hitStop = dir > 0 ? nb.l <= stop : nb.h >= stop;
      const hitTgt  = dir > 0 ? nb.h >= target : nb.l <= target;
      const hitTP1  = dir > 0 ? nb.h >= tp1 : nb.l <= tp1;
      const exitAs  = hitStop ? stop : hitTgt ? target : nb.c;                // stop-first convention
      const rMult   = ((exitAs - entry) * dir) / stopDist - COST_R;
      const exitTP  = hitStop ? stop : hitTP1 ? tp1 : nb.c;                   // the 1R take-profit variant
      const rMultTP = ((exitTP - entry) * dir) / stopDist - COST_R;
      // excursions (the MAE/MFE the live log now records too)
      const mfe = ((dir > 0 ? nb.h - entry : entry - nb.l)) / stopDist;
      const mae = ((dir > 0 ? entry - nb.l : nb.h - entry)) / stopDist;
      // H2 conditioning variable: the prior 5-day move IN THE TRADE'S DIRECTION
      const rev5 = ((C[i] - C[i - 5]) / C[i - 5]) * dir;
      trades.push({ t: d[i].t, sym, dir, strat: s.strat, conf: s.conf, rMult, rMultTP, mfe, mae, rev5 });
    }
  }
  console.log(`\n\n  ${trades.length} replayed trades on ${new Set(trades.map(t => t.t)).size} sessions\n`);

  const byDay = (arr, f) => { const m = {}; for (const t of arr) (m[t.t] = m[t.t] || []).push(f(t)); return Object.values(m).map(mean); };
  const line = (lbl, arr, f) => { const per = arr.map(f), dc = byDay(arr, f);
    console.log("    " + lbl.padEnd(30) + `n ${String(arr.length).padEnd(7)}avg ${(mean(per) >= 0 ? "+" : "") + mean(per).toFixed(4)}R   win ${(per.filter(v => v > 0).length / per.length * 100).toFixed(1)}%   day-clustered t ${tOf(dc).toFixed(2)} (${dc.length}d)`); };

  console.log("  H1 — EXIT RULE (paired: same entries, two exits)");
  line("as traded: ride to 2R", trades, t => t.rMult);
  line("take profit at +1R", trades, t => t.rMultTP);
  const diffs = trades.map(t => t.rMultTP - t.rMult);
  const dcDiff = byDay(trades, t => t.rMultTP - t.rMult);
  console.log(`    → PAIRED GAP: ${(mean(diffs) >= 0 ? "+" : "") + mean(diffs).toFixed(4)}R per trade in favor of ${mean(diffs) >= 0 ? "1R-TP" : "2R-ride"} · day-clustered t ${tOf(dcDiff).toFixed(2)} · 95% CI [${(mean(dcDiff) - 1.96 * sd(dcDiff) / Math.sqrt(dcDiff.length)).toFixed(4)}, ${(mean(dcDiff) + 1.96 * sd(dcDiff) / Math.sqrt(dcDiff.length)).toFixed(4)}]`);
  console.log(`    forward record so far: +0.042R for 1R-TP (n=24) — does history agree?\n`);

  console.log("  H2 — 5-DAY RUN-UP FILTER (does entering after a big run in-direction hurt?)");
  const sorted = [...trades].sort((a, b) => a.rev5 - b.rev5);
  const third = Math.floor(sorted.length / 3);
  const lo = sorted.slice(0, third), mid = sorted.slice(third, 2 * third), hi = sorted.slice(-third);
  line("LOW  (counter/flat 5d)", lo, t => t.rMult);
  line("MID", mid, t => t.rMult);
  line("HIGH (big run-up in-dir)", hi, t => t.rMult);
  const gap = mean(hi.map(t => t.rMult)) - mean(lo.map(t => t.rMult));
  console.log(`    → HIGH-minus-LOW GAP: ${(gap >= 0 ? "+" : "") + gap.toFixed(4)}R (negative = run-ups hurt; trigger threshold is ≤ −0.15R)`);
  console.log(`    forward record so far: −0.091R gap (n=34) — does history agree?\n`);

  console.log("  BONUS — EXCURSION PROFILE (the MAE/MFE data now logged live: where should stops/targets actually be?)");
  const mfes = trades.map(t => t.mfe), maes = trades.map(t => t.mae);
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * s.length)]; };
  console.log(`    MFE (best run in favor, R):  median ${pct(mfes, .5).toFixed(2)} · 75th ${pct(mfes, .75).toFixed(2)} · 90th ${pct(mfes, .9).toFixed(2)}  ← how often does 2R even get touched?`);
  console.log(`    MAE (worst run against, R):  median ${pct(maes, .5).toFixed(2)} · 75th ${pct(maes, .75).toFixed(2)} · 90th ${pct(maes, .9).toFixed(2)}  ← is the 1.5×ATR stop too tight/loose?`);
  console.log(`    reached +1R: ${(trades.filter(t => t.mfe >= 1).length / trades.length * 100).toFixed(1)}% of trades · reached +2R: ${(trades.filter(t => t.mfe >= 2).length / trades.length * 100).toFixed(1)}% · hit −1R stop: ${(trades.filter(t => t.mae >= 1).length / trades.length * 100).toFixed(1)}%`);

  console.log(`\n  VERDICT RULE: a hypothesis is ANSWERED when history and the forward record agree in sign`);
  console.log(`  and the day-clustered CI excludes zero. Then it goes to the approval queue as a single`);
  console.log(`  pre-registered rule change. History alone never changes a rule — it just stops us waiting\n  weeks to learn something a paired comparison can settle today.\n`);

  try { fs.writeFileSync(path.join(__dirname, "data", "lesson-replay.json"), JSON.stringify({ ran: new Date().toISOString(), n: trades.length, h1Gap: mean(diffs), h1t: tOf(dcDiff), h2Gap: gap, mfeMedian: pct(mfes, .5), maeMedian: pct(maes, .5) })); } catch {}
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
