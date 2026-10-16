#!/usr/bin/env node
"use strict";
/**
 * Library emitter (v2, 2026-09-25) — BTC/ETH 50-day trend sleeve, with and without per-coin trailing stops. READ-ONLY on every
 * registry/seal file. Source rule: backend/crypto-trend-book.js (EXPLORATORY, seals nothing); the forward test of the no-stop rule is
 * R191, its historical parent R190 (sealed DID NOT PASS on alpha, t 1.774 vs 2.149).
 *
 * crypto-trend-book.js is not require()-safe (main runs on load), so its coinDaily() is reproduced here VERBATIM in logic and checked
 * against the stats it persisted (data/crypto-trend-book.json, cryptoAlone: CAGR / Sharpe / maxDD on 2017-01..2026-08, T-bill on cash).
 * Candles: Coinbase Exchange BTC-USD / ETH-USD daily, the script's own fetch window (2016-01-01 .. 2026-09-01), cached under
 * data/strategy-library/_cache/benchmarks/{BTC,ETH}-cb-20260901.json.
 *
 * LIBRARY SERIES (contract: cash at 0%): 50/50 BTC/ETH daily net return, cash days = 0 (the T-bill is NOT in the series; book
 * simulations add T-bill interest on idle capital explicitly). 25 bps per side on every switch, charged at that day's close.
 * Entries: CRYPTO-T50 (no stop), CRYPTO-T50-S10 / S15 / S20 / S25 (trailing stop 10/15/20/25%), plus CRYPTO-BH (50/50 buy-and-hold,
 * a BENCHMARK entry kept for beta/stress work — not a strategy).
 */
const fs = require("fs"), path = require("path");
const { writeEntry } = require("../lib-entry.js");
const { writeJsonAtomic } = require("../../lib/atomic-write.js");
const CACHE = path.join(__dirname, "..", "..", "data", "strategy-library", "_cache", "benchmarks");
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function candles(coin) {   // == crypto-trend-book.js candles(), cached
  const f = path.join(CACHE, `${coin}-cb-20260901.json`); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const all = [], stop = Date.parse("2016-01-01"); let end = Date.parse("2026-09-01");
  while (end > stop) { const s = Math.max(stop, end - 299 * 864e5); const r = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(end).toISOString()}`, { headers: { "User-Agent": "TRAIDS ensemble v2" } }); const a = await r.json(); if (!Array.isArray(a)) break; all.push(...a); if (!a.length && all.length) break; end = s - 864e5; await sleep(350); }
  const m = new Map(); for (const [t, , , , c] of all) m.set(new Date(t * 1000).toISOString().slice(0, 10), c);
  const rows = [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, c]) => ({ d, c }));
  writeJsonAtomic(f, rows, { pretty: 0 }); return rows; }
function tbillDaily() { const f = path.join(__dirname, "..", "..", "data", "training", "fred", "DTB3.csv"), M = {}; for (const l of fs.readFileSync(f, "utf8").trim().split(/\r?\n/).slice(1)) { const [d, v] = l.split(","); if (v && v !== ".") M[d.slice(0, 7)] = +v / 100 / 365; } return M; }
function coinDaily(rows, stopPct, tb) {   // == crypto-trend-book.js coinDaily(); tb = {} gives cash at 0%
  const out = new Map(); let pos = 0, peak = 0, stopped = false, stopPeak = 0, wasBelow = false;
  for (let i = 50; i < rows.length; i++) {
    const r = rows[i].c / rows[i - 1].c - 1; out.set(rows[i].d, pos ? r : tb[rows[i].d.slice(0, 7)] || 0);
    const sma = mean(rows.slice(i - 49, i + 1).map((x) => x.c)), c = rows[i].c, on = c > sma; let next = pos;
    if (pos) { peak = Math.max(peak, c); if (!on) next = 0; else if (stopPct && c <= peak * (1 - stopPct)) { next = 0; stopped = true; stopPeak = peak; wasBelow = false; } }
    else { if (stopped) { if (!on) wasBelow = true; if ((on && wasBelow) || c > stopPeak) { next = on ? 1 : 0; if (next) stopped = false; } } else if (on) next = 1;
           if (next) peak = c; }
    if (next !== pos) out.set(rows[i].d, out.get(rows[i].d) - 0.0025);
    pos = next;
  }
  return out; }
function monthlyStats(dA, dB) {   // == crypto-trend-book.js monthly() + stats() (cagr, sharpe, maxDD)
  const M = {}; for (const [d, a] of dA) { if (!dB.has(d) || d < "2017-01-01" || d > "2026-08-31") continue; const r = 0.5 * a + 0.5 * dB.get(d); const m = d.slice(0, 7); M[m] = (M[m] || 1) * (1 + r); }
  const r = Object.keys(M).sort().map((m) => M[m] - 1), w = r.reduce((p, x) => p * (1 + x), 1); let pk = 1, v = 1, dd = 0; for (const x of r) { v *= 1 + x; pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); }
  return { cagrPct: +(100 * (w ** (12 / r.length) - 1)).toFixed(1), sharpe: +((mean(r) / sd(r)) * Math.sqrt(12)).toFixed(2), maxDDPct: +(100 * dd).toFixed(1) }; }
(async () => {
  const btc = await candles("BTC"), eth = await candles("ETH"), tb = tbillDaily();
  const persisted = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "crypto-trend-book.json"), "utf8")).res.cryptoAlone;
  const variants = [[0, "CRYPTO-T50", "trend50 (no stop)"], [0.10, "CRYPTO-T50-S10", "trend50 + 10% trailing stop"], [0.15, "CRYPTO-T50-S15", "trend50 + 15% trailing stop"], [0.20, "CRYPTO-T50-S20", "trend50 + 20% trailing stop"], [0.25, "CRYPTO-T50-S25", "trend50 + 25% trailing stop"]];
  const both = (a, b) => [...a.keys()].filter((d) => b.has(d) && d <= "2026-08-31").sort();
  for (const [s, id, key] of variants) {
    const rep = monthlyStats(coinDaily(btc, s, tb), coinDaily(eth, s, tb)), want = persisted[key];
    const A = coinDaily(btc, s, {}), B = coinDaily(eth, s, {}), ds = both(A, B);
    const series = ds.map((d) => ({ d, r: 0.5 * A.get(d) + 0.5 * B.get(d) })).filter((x) => x.r !== 0);
    writeEntry({ id, name: `BTC/ETH 50/50, long when close > 50-day SMA${s ? `, ${100 * s}% trailing stop per coin` : ""} (cash at 0%)`, registryId: s ? "R190" : "R191",
      script: "backend/crypto-trend-book.js", emitter: "backend/ensemble/emit/v2-crypto-trend-sleeve.js", unit: "daily", net: true,
      costModel: "25 bps per side on every switch (crypto-trend-book.js); cash at 0% in the library series", window: [ds[0], ds[ds.length - 1]], calendar: "crypto-24x7", series,
      reproduction: { statistic: `crypto-trend-book.json cryptoAlone['${key}'] CAGR% / Sharpe / maxDD% (2017-01..2026-08, T-bill on cash)`, sealed: `${want.cagrPct} / ${want.sharpe} / ${want.maxDDPct}`, emitted: `${rep.cagrPct} / ${rep.sharpe} / ${rep.maxDDPct}`, tolerance: "0.1 / 0.01 / 0.1",
        match: Math.abs(rep.cagrPct - want.cagrPct) <= 0.1 && Math.abs(rep.sharpe - want.sharpe) <= 0.01 && Math.abs(rep.maxDDPct - want.maxDDPct) <= 0.1 },
      construction: "Per coin, signal at each completed UTC daily close (close > mean of the last 50 closes incl. today), position applies from the NEXT day; switch cost at the signal close. Sleeve = 0.5 BTC + 0.5 ETH daily (daily rebalanced). Days with zero return (both coins in cash, no switch) are omitted = 0.",
      notes: `${s ? "Trailing-stop variant: exploratory (5 stop levels were examined in crypto-trend-book.js; none registered). " : "The registered forward form is R191 (Alpaca paper, $10k per coin, weekday evaluation). "}Mostly crypto BETA with a drawdown cut: R190 found no alpha at its bar; 2017 (ETH ~90x) dominates the 2017-2026 CAGR.` });
  }
  { const ds = [...btc.keys()].length ? btc.map((x) => x.d).filter((d) => d >= "2016-07-01" && d <= "2026-08-31") : [];
    const bm = new Map(btc.map((x, i) => [x.d, i ? x.c / btc[i - 1].c - 1 : null])), em = new Map(eth.map((x, i) => [x.d, i ? x.c / eth[i - 1].c - 1 : null]));
    const series = ds.filter((d) => bm.get(d) != null && em.get(d) != null).map((d) => ({ d, r: 0.5 * bm.get(d) + 0.5 * em.get(d) }));
    const rep = monthlyStats(new Map(series.map((x) => [x.d, x.r])), new Map(series.map((x) => [x.d, x.r]))), want = persisted["buy & hold 50/50 BTC+ETH"];
    writeEntry({ id: "CRYPTO-BH", name: "BENCHMARK — BTC/ETH 50/50 buy-and-hold (daily rebalanced)", registryId: "R191", script: "backend/crypto-trend-book.js", emitter: "backend/ensemble/emit/v2-crypto-trend-sleeve.js", unit: "daily", net: true,
      costModel: "none (benchmark)", window: [series[0].d, series[series.length - 1].d], calendar: "crypto-24x7", series,
      reproduction: { statistic: "crypto-trend-book.json cryptoAlone['buy & hold 50/50 BTC+ETH'] CAGR% / Sharpe / maxDD%", sealed: `${want.cagrPct} / ${want.sharpe} / ${want.maxDDPct}`, emitted: `${rep.cagrPct} / ${rep.sharpe} / ${rep.maxDDPct}`, tolerance: "0.1 / 0.01 / 0.1",
        match: Math.abs(rep.cagrPct - want.cagrPct) <= 0.1 && Math.abs(rep.sharpe - want.sharpe) <= 0.01 && Math.abs(rep.maxDDPct - want.maxDDPct) <= 0.1 },
      construction: "0.5 x BTC + 0.5 x ETH daily close-to-close (Coinbase). A benchmark, excluded from every strategy count and selection.", notes: "benchmark: true" });
  }
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
