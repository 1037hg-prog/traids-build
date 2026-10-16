#!/usr/bin/env node
/**
 * TRAIDS — H3: PRE-REGISTERED TAKE-PROFIT RULE TEST
 *
 * THE HYPOTHESIS (the user's, stated BEFORE any data was run — this is what makes it a real
 * pre-registration rather than a grid search): "if they were real trades, I would have sold
 * them at ~$200 minimum in profit, not waited for 1R or whatever." On ~$1,000 risk per trade
 * that is a take-profit at +0.20R.
 *
 * WHY THIS DESERVED A REAL TEST: a quick pass over the 163 settled trades that carry MFE
 * showed take-profit-early beating the ride at every level (+0.2R: +0.0376R, t=2.33). The
 * path objection died on inspection — ZERO trades both reached the TP level and touched the
 * stop, so the ordering ambiguity that usually invalidates MFE-based sims doesn't bite here.
 * But that pass was in-sample, n=163, and I reported the best of 5 levels — which is exactly
 * how false positives are born. It also contradicts H1, which rejected take-profit-early over
 * 52,325 paired trades. A 163-trade result that disagrees with a 52,000-trade result loses
 * by default unless it survives the same machinery. So: same machinery.
 *
 * METHOD — identical to the H1/H2 replay that has already killed two hypotheses honestly:
 *   • PAIRED: the same entries, two exit rules. Costs and beta cancel in the difference.
 *   • Entry at the signal-day close, 1.5×ATR stop, settle the next session.
 *   • STOP-FIRST convention: if a bar touches both the stop and the take-profit, the STOP is
 *     assumed to fill first. This deliberately penalizes the rule under test.
 *   • GAP-AWARE: if the next bar OPENS through the stop, the fill is the OPEN, not the stop
 *     (14.9% of stops gap through and average −1.81R — the fix shipped 2026-07-14).
 *   • Day-clustered t: signals cluster by session, so per-trade t would be inflated.
 *   • OUT-OF-SAMPLE: chronological 60/40. In-sample is where the idea came from; it proves
 *     nothing. Only the OOS half votes.
 *
 * VERDICT RULE (pre-registered): the rule is adopted only if the OOS paired gap is POSITIVE
 * and its day-clustered 95% CI EXCLUDES ZERO. Anything else = not established.
 *
 * Usage: node backend/tp-rule-test.js        (env: DAYS=760 TP_R=0.2)
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "760");
const TP_R = parseFloat(process.env.TP_R || "0.2");        // THE pre-registered level. One number. No grid.
const ATR_MULT = 1.5, RR = 2, CONF_BAR = 0.60, COST_R = 0.05;

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
const ci95 = a => { const se = sd(a) / Math.sqrt(a.length); return [mean(a) - 1.96 * se, mean(a) + 1.96 * se]; };
const ema = (arr, n) => { const k = 2 / (n + 1); let e = arr[0]; const out = [e]; for (let i = 1; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); } return out; };
function atr(h, l, c, p = 14) { const tr = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); const r = new Array(c.length).fill(null); r[p - 1] = mean(tr.slice(0, p)); for (let i = p; i < c.length; i++) r[i] = (r[i - 1] * (p - 1) + tr[i]) / p; return r; }
function rsi(c, p = 14) { const out = new Array(c.length).fill(null); let g = 0, ls = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else ls -= d; } g /= p; ls /= p; out[p] = 100 - 100 / (1 + (ls ? g / ls : 100)); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (p - 1) + Math.max(0, d)) / p; ls = (ls * (p - 1) + Math.max(0, -d)) / p; out[i] = 100 - 100 / (1 + (ls ? g / ls : 100)); } return out; }
function signalAt(d, i) {
  if (i < 60) return null;
  const c = d.map(x => x.c), h = d.map(x => x.h), l = d.map(x => x.l);
  const e20 = ema(c.slice(0, i + 1), 20), e50 = ema(c.slice(0, i + 1), 50);
  const r = rsi(c.slice(0, i + 1))[i];
  const sma20 = mean(c.slice(i - 19, i + 1)), sd20 = Math.sqrt(mean(c.slice(i - 19, i + 1).map(v => (v - sma20) ** 2)));
  const votes = [];
  votes.push(e20[i] > e50[i] ? 1 : -1);
  votes.push(c[i] > sma20 + 2 * sd20 ? -1 : c[i] < sma20 - 2 * sd20 ? 1 : 0);
  votes.push(r > 70 ? -1 : r < 30 ? 1 : 0);
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

(async () => {
  console.log(`\n  TRAIDS — H3: PRE-REGISTERED TAKE-PROFIT TEST  (+${TP_R.toFixed(2)}R)`);
  console.log(`  The user's own rule, named before any data was run: "sell at ~$200 min profit."`);
  console.log(`  ${UNIVERSE.length} names · ~${DAYS}d · paired · stop-first · gap-aware · cost ${COST_R}R · day-clustered\n`);
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
      const stop = entry - dir * stopDist;
      const target = entry + dir * stopDist * RR;
      const tpX = entry + dir * stopDist * TP_R;
      const nb = d[i + 1];

      // GAP-AWARE stop: if the bar OPENS through the stop you fill at the OPEN, and the
      // take-profit never gets a chance. Applies identically to both legs (paired).
      const gapped = dir > 0 ? nb.o <= stop : nb.o >= stop;
      const hitStop = dir > 0 ? nb.l <= stop : nb.h >= stop;
      const hitTgt  = dir > 0 ? nb.h >= target : nb.l <= target;
      const hitTPx  = dir > 0 ? nb.h >= tpX : nb.l <= tpX;
      const stopFill = gapped ? nb.o : stop;

      // BASELINE: current rules (stop-first, then 2R target, else close)
      const exitBase = hitStop ? stopFill : hitTgt ? target : nb.c;
      const rBase = ((exitBase - entry) * dir) / stopDist - COST_R;
      // RULE UNDER TEST: same entry, take profit at +TP_R. STOP-FIRST — if the bar touched
      // both, the stop wins. This is deliberately unkind to the rule being tested.
      const exitTP = hitStop ? stopFill : hitTPx ? tpX : nb.c;
      const rTP = ((exitTP - entry) * dir) / stopDist - COST_R;

      trades.push({ t: d[i].t, rBase, rTP, diff: rTP - rBase });
    }
  }
  console.log(`\n\n  ${trades.length.toLocaleString()} paired trades on ${new Set(trades.map(t => t.t)).size} sessions\n`);

  const byDay = (arr, f) => { const m = {}; for (const t of arr) (m[t.t] = m[t.t] || []).push(f(t)); return Object.values(m).map(mean); };
  const report = (label, arr) => {
    const base = arr.map(t => t.rBase), tp = arr.map(t => t.rTP), diff = arr.map(t => t.diff);
    const dcDiff = byDay(arr, t => t.diff);
    const [lo, hi] = ci95(dcDiff);
    const excl = (lo > 0 || hi < 0);
    console.log(`  ${label}  (n ${arr.length.toLocaleString()} · ${dcDiff.length} sessions)`);
    console.log(`    baseline (ride to 2R/stop/close) : ${(mean(base) >= 0 ? "+" : "") + mean(base).toFixed(4)}R   win ${(base.filter(v => v > 0).length / base.length * 100).toFixed(1)}%`);
    console.log(`    +${TP_R.toFixed(2)}R take-profit           : ${(mean(tp) >= 0 ? "+" : "") + mean(tp).toFixed(4)}R   win ${(tp.filter(v => v > 0).length / tp.length * 100).toFixed(1)}%`);
    console.log(`    PAIRED GAP                       : ${(mean(diff) >= 0 ? "+" : "") + mean(diff).toFixed(4)}R  in favor of ${mean(diff) >= 0 ? "TAKE-PROFIT" : "the ride"}`);
    console.log(`    day-clustered t ${tOf(dcDiff).toFixed(2)} · 95% CI [${lo.toFixed(4)}, ${hi.toFixed(4)}]  ${excl ? "✓ excludes zero" : "✕ CONTAINS ZERO"}\n`);
    return { gap: mean(diff), excl, lo, hi };
  };

  const sorted = [...trades].sort((a, b) => a.t.localeCompare(b.t));
  const cut = Math.floor(sorted.length * 0.6);
  const isSample = sorted.slice(0, cut), oos = sorted.slice(cut);

  console.log("  ── FULL SAMPLE ──");
  report("all", sorted);
  console.log("  ── IN-SAMPLE (first 60%) — where the idea came from; proves nothing ──");
  report("in-sample", isSample);
  console.log("  ── OUT-OF-SAMPLE (last 40%) — THE ONLY HALF THAT VOTES ──");
  const o = report("out-of-sample", oos);

  console.log("  ── PRE-REGISTERED VERDICT ──");
  if (o.gap > 0 && o.excl) {
    console.log(`    ✓ ESTABLISHED. The +${TP_R.toFixed(2)}R take-profit beats the ride out-of-sample by`);
    console.log(`      ${o.gap.toFixed(4)}R/trade with the day-clustered CI excluding zero. This goes to the`);
    console.log(`      approval queue as ONE pre-registered rule change — not auto-adopted.`);
  } else {
    console.log(`    ✕ NOT ESTABLISHED. OOS gap ${(o.gap >= 0 ? "+" : "") + o.gap.toFixed(4)}R, CI [${o.lo.toFixed(4)}, ${o.hi.toFixed(4)}] ${o.excl ? "" : "contains zero"}.`);
    console.log(`      The rule does not survive out-of-sample. The in-sample signal was the idea's`);
    console.log(`      birthplace, not evidence for it.`);
  }
  console.log(`\n  Costs cancel (paired, same round-trip, same entry). Note the one asymmetry NOT`);
  console.log(`  modeled and it favors the take-profit: a resting limit fills at its price, while a`);
  console.log(`  stop can gap. If the rule loses even with that thumb on its scale, it loses.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
