#!/usr/bin/env node
/** CRYPTO TREND SLEEVE + TREASURY OVERLAY BOOK (2026-09-25, operator: "plain 50-day trend 20% will work" / "why not stop loss on the
 *  drawdown"). EXPLORATORY decision support; seals nothing. Every stop level examined is reported (no best-of selection shown alone).
 *  Crypto: BTC and ETH, Coinbase daily candles, 50/50. Signal at each close: in if close > SMA50 (closed bars only; the position applies
 *  to the NEXT day). Optional per-coin TRAILING STOP s: exit at the close that is >= s below the highest close since entry; after a stop,
 *  re-enter only on a new close above that peak or on a fresh cross (close <= SMA50 then > SMA50). 25 bps per side on every switch.
 *  Cash (when out) earns the 3-month T-bill (FRED DTB3). Treasury: 5x ZN month-end windows from data/futures-month-end.json.
 *  Book = Treasury overlay on the whole NAV (margin only) + x of NAV in the crypto sleeve + the rest in T-bills; monthly rebalance.
 *  node backend/crypto-trend-book.js */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function candles(coin) { const all = [], stop = Date.parse("2016-01-01"); let end = Date.parse("2026-09-01");
  while (end > stop) { const s = Math.max(stop, end - 299 * 864e5); const r = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(end).toISOString()}`, { headers: { "User-Agent": "TRAIDS crypto-trend-book" } }); const a = await r.json(); if (!Array.isArray(a)) break; all.push(...a); if (!a.length && all.length) break; end = s - 864e5; await sleep(350); }
  const m = new Map(); for (const [t, , , , c] of all) m.set(new Date(t * 1000).toISOString().slice(0, 10), c); return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, c]) => ({ d, c })); }
function tbillDaily() { const f = path.join(__dirname, "data", "training", "fred", "DTB3.csv"), M = {}; for (const l of fs.readFileSync(f, "utf8").trim().split(/\r?\n/).slice(1)) { const [d, v] = l.split(","); if (v && v !== ".") M[d.slice(0, 7)] = +v / 100 / 365; } return M; }
function coinDaily(rows, stopPct, tb) {   // returns Map(date -> net daily return of this coin's sleeve incl. cash interest)
  const out = new Map(); let pos = 0, peak = 0, stopped = false, stopPeak = 0, wasBelow = false;
  for (let i = 50; i < rows.length; i++) {
    const r = rows[i].c / rows[i - 1].c - 1; out.set(rows[i].d, pos ? r : tb[rows[i].d.slice(0, 7)] || 0);   // today's return with yesterday's decision
    const sma = mean(rows.slice(i - 49, i + 1).map((x) => x.c)), c = rows[i].c, on = c > sma; let next = pos;
    if (pos) { peak = Math.max(peak, c); if (!on) next = 0; else if (stopPct && c <= peak * (1 - stopPct)) { next = 0; stopped = true; stopPeak = peak; wasBelow = false; } }
    else { if (stopped) { if (!on) wasBelow = true; if ((on && wasBelow) || c > stopPeak) { next = on ? 1 : 0; if (next) stopped = false; } } else if (on) next = 1;
           if (next) peak = c; }
    if (next !== pos) out.set(rows[i].d, out.get(rows[i].d) - 0.0025);   // switch cost at today's close
    pos = next;
  }
  return out; }
(async () => {
  const btc = await candles("BTC"), eth = await candles("ETH"), tb = tbillDaily();
  const trs = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "futures-month-end.json"), "utf8")).rowsOut; const TR = new Map(trs.map((r) => [r.m, r]));
  const bhDaily = (rows) => { const m = new Map(); for (let i = 1; i < rows.length; i++) m.set(rows[i].d, rows[i].c / rows[i - 1].c - 1); return m; };
  function monthly(dailyA, dailyB) { const M = {}; for (const [d, a] of dailyA) { if (!dailyB.has(d) || d < "2017-01-01" || d > "2026-08-31") continue; const r = 0.5 * a + 0.5 * dailyB.get(d); const m = d.slice(0, 7); M[m] = (M[m] || 1) * (1 + r); } return Object.fromEntries(Object.entries(M).map(([m, v]) => [m, v - 1])); }
  function stats(monthlyObj) { const ms = Object.keys(monthlyObj).sort(), r = ms.map((m) => monthlyObj[m]), w = r.reduce((p, x) => p * (1 + x), 1); let pk = 1, v = 1, dd = 0; for (const x of r) { v *= 1 + x; pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); }
    const Y = {}; ms.forEach((m, i) => (Y[m.slice(0, 4)] = (Y[m.slice(0, 4)] || 1) * (1 + r[i]))); const yr = Object.entries(Y).map(([y, x]) => [y, x - 1]);
    return { cagrPct: +(100 * (w ** (12 / r.length) - 1)).toFixed(1), sharpe: +((mean(r) / sd(r)) * Math.sqrt(12)).toFixed(2), maxDDPct: +(100 * dd).toFixed(1), worstYear: yr.reduce((a, b) => (b[1] < a[1] ? b : a)).map((x, i) => (i ? +(100 * x).toFixed(1) : x)).join(" "), last12mPct: +(100 * (r.slice(-12).reduce((p, x) => p * (1 + x), 1) - 1)).toFixed(1) }; }
  const res = { window: "2017-01..2026-08", cryptoAlone: {}, book: {} };
  res.cryptoAlone["buy & hold 50/50 BTC+ETH"] = stats(monthly(bhDaily(btc), bhDaily(eth)));
  const sleeves = {}; for (const s of [0, 0.10, 0.15, 0.20, 0.25]) { const k = s ? `trend50 + ${100 * s}% trailing stop` : "trend50 (no stop)"; sleeves[k] = monthly(coinDaily(btc, s, tb), coinDaily(eth, s, tb)); res.cryptoAlone[k] = stats(sleeves[k]); }
  for (const [k, sl] of Object.entries(sleeves)) for (const x of [0, 0.2, 0.3, 0.5]) {
    if (x === 0 && k !== "trend50 (no stop)") continue;
    const book = {}; for (const m of Object.keys(sl)) { const t = TR.get(m); if (!t) continue; book[m] = 5 * t.tre + (1 - x) * t.tb + x * sl[m]; }
    res.book[x === 0 ? "Treasury 5x + T-bills only" : `Treasury 5x + ${100 * x}% crypto [${k}]`] = stats(book); }
  writeJsonAtomic(path.join(__dirname, "data", "crypto-trend-book.json"), { ranAt: new Date().toISOString(), exploratory: true, res });
  const pr = (o) => Object.entries(o).forEach(([k, v]) => console.log(k.padEnd(62), JSON.stringify(v)));
  console.log("CRYPTO SLEEVE ALONE"); pr(res.cryptoAlone); console.log("BOOK"); pr(res.book);
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
