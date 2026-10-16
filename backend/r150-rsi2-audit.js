#!/usr/bin/env node
/**
 * R150 RSI-2 POST-READ AUDIT (2026-09-23). R150's sealed read cleared ONE member, RSI-2, at t 2.562 against a 2.523 bar. House rule
 * (Josh 2026-09-18): no positive is shown before an input audit, a leak test and an independent check. The leak test ran before the
 * read. This script is the input/robustness audit. It is WEIGHTLESS: it changes nothing in the sealed R150 verdict.
 *
 *   1. SIDE SPLIT        longs vs shorts, each with its own monthly NW t
 *   2. COST              the same trades at 0.20% and 0.30% round trip
 *   3. SURVIVORSHIP      the identical rule on 15 ETFs that existed the whole period (SPY QQQ IWM DIA + 11 sector SPDRs) — no
 *                        survivor selection possible
 *   4. MATCHED PLACEBO   for every real LONG trade: 20 random entry days in the SAME symbol where close > SMA200 (the rule's own
 *                        trend filter), held the SAME number of sessions — isolates RSI-2's timing from "long a winner in an uptrend"
 *   5. CONCENTRATION     by year and by symbol; share of the net from the top 10 symbols
 */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f);
const START = "2016-01-01", END = "2026-09-22T21:00:00Z";
const sma = (a, n) => { const o = new Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
const rma = (a, n) => { const o = new Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { if (i < n) { s += a[i]; if (i === n - 1) o[i] = s / n; } else o[i] = (a[i] + (n - 1) * o[i - 1]) / n; } return o; };
function rsi2Trades(b, sym) {                                          // identical to r150-classics.js RSI2 + its runner
  const c = b.map((x) => x.c), ch = c.map((v, i) => i ? v - c[i - 1] : 0), up = rma(ch.map((x) => Math.max(x, 0)), 2), dn = rma(ch.map((x) => -Math.min(x, 0)), 2);
  const rsi = up.map((u, i) => dn[i] === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / dn[i])), m5 = sma(c, 5), m200 = sma(c, 200), out = [];
  let pos = null, pending = null;
  for (let i = 0; i < b.length; i++) {
    if (pending !== null) { if (pos && (pending === 0 || pending !== pos.dir)) { out.push({ sym, dir: pos.dir, ei: pos.i, xi: i, entry: pos.px, exit: b[i].o, t: b[pos.i].t }); pos = null; } if (pending !== 0 && !pos) pos = { dir: pending, px: b[i].o, i }; pending = null; }
    let s = null; if (!isNaN(m200[i])) { if (pos && pos.dir > 0 && c[i] > m5[i]) s = 0; else if (pos && pos.dir < 0 && c[i] < m5[i]) s = 0; else if (!pos && c[i] > m200[i] && c[i] < m5[i] && rsi[i] < 10) s = 1; else if (!pos && c[i] < m200[i] && c[i] > m5[i] && rsi[i] > 90) s = -1; }
    if (s !== null && i + 1 < b.length) pending = s;
  }
  return { trades: out, m200 };
}
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
function nwT(a) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return v > 0 ? +(m / Math.sqrt(v / n)).toFixed(3) : null; }
function monthly(tr, cost) { const by = new Map(); for (const x of tr) { const k = x.t.slice(0, 7); (by.get(k) || by.set(k, []).get(k)).push(x.dir * (x.exit / x.entry - 1) - cost); } const s = [...by.keys()].sort().map((k) => mean(by.get(k))); return { trades: tr.length, months: s.length, meanPctPerMonth: +(100 * mean(s)).toFixed(4), tNW: nwT(s) }; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

(async () => {
  const uni = JSON.parse(fs.readFileSync(D("r147-universe.json"), "utf8")).names, all = [], placebo = [], rng = mulberry(1500);
  for (let i = 0; i < uni.length; i += 25) {
    const { bars } = await fetchBars(uni.slice(i, i + 25), { start: START, end: END, feed: "sip", requireAll: false, quiet: true });
    for (const [s, b] of Object.entries(bars)) { if (b.length < 250) continue; const { trades, m200 } = rsi2Trades(b, s); all.push(...trades);
      const ok = []; for (let k = 200; k < b.length - 1; k++) if (b[k].c > m200[k]) ok.push(k);   // days the trend filter is on
      for (const x of trades.filter((y) => y.dir > 0)) { const hold = x.xi - x.ei; for (let r = 0; r < 20; r++) { const k = ok[Math.floor(rng() * ok.length)]; if (k + 1 + hold >= b.length) continue;
        placebo.push({ sym: s, dir: 1, entry: b[k + 1].o, exit: b[k + 1 + hold].o, t: b[k + 1].t }); } } }
  }
  const longs = all.filter((x) => x.dir > 0), shorts = all.filter((x) => x.dir < 0);
  const etfs = ["SPY", "QQQ", "IWM", "DIA", "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "XLC"], et = [];
  const { bars: eb } = await fetchBars(etfs, { start: START, end: END, feed: "sip", requireAll: false, quiet: true });
  for (const [s, b] of Object.entries(eb)) if (b.length > 250) et.push(...rsi2Trades(b, s).trades);
  const net = (x, c = 0.001) => x.dir * (x.exit / x.entry - 1) - c;
  const bySym = new Map(); for (const x of all) bySym.set(x.sym, (bySym.get(x.sym) || 0) + net(x)); const symSorted = [...bySym.entries()].sort((a, b) => b[1] - a[1]);
  const totalNet = [...bySym.values()].reduce((a, b) => a + b, 0), top10 = symSorted.slice(0, 10).reduce((a, [, v]) => a + v, 0);
  const byYear = {}; for (const x of all) { const y = x.t.slice(0, 4); (byYear[y] ||= []).push(net(x)); }
  const out = { spec: "r150-rsi2-audit-v1", asOf: new Date().toISOString(), weightless: true,
    sideSplit: { long: monthly(longs, 0.001), short: monthly(shorts, 0.001) },
    cost: { at0_10: monthly(all, 0.001), at0_20: monthly(all, 0.002), at0_30: monthly(all, 0.003) },
    etfs: { all: monthly(et, 0.001), long: monthly(et.filter((x) => x.dir > 0), 0.001), short: monthly(et.filter((x) => x.dir < 0), 0.001) },
    matchedPlacebo: { realLong: monthly(longs, 0.001), placeboLong: monthly(placebo, 0.001), realLongMeanPctPerTrade: +(100 * mean(longs.map((x) => net(x)))).toFixed(4), placeboMeanPctPerTrade: +(100 * mean(placebo.map((x) => net(x)))).toFixed(4), meanHoldSessions: +mean(longs.map((x) => x.xi - x.ei)).toFixed(2) },
    timingOverPlacebo: (() => { const g = (tr) => { const m = new Map(); for (const x of tr) { const k = x.t.slice(0, 7); (m.get(k) || m.set(k, []).get(k)).push(net(x)); } return m; }; const r = g(longs), p = g(placebo); const d = [...r.keys()].filter((k) => p.has(k)).sort().map((k) => mean(r.get(k)) - mean(p.get(k))); return { months: d.length, meanDiffPctPerMonth: +(100 * mean(d)).toFixed(4), tNW: nwT(d) }; })(),
    concentration: { top10SymbolsShareOfNet: +(top10 / totalNet).toFixed(3), top10: symSorted.slice(0, 10).map(([s, v]) => [s, +(100 * v).toFixed(1)]), bottom5: symSorted.slice(-5).map(([s, v]) => [s, +(100 * v).toFixed(1)]),
      byYearMeanPctPerTrade: Object.fromEntries(Object.entries(byYear).map(([y, a]) => [y, +(100 * mean(a)).toFixed(3)])) } };
  writeJsonAtomic(D("r150-rsi2-audit.json"), out);
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error("audit FAILED:", e.message); process.exit(1); });
