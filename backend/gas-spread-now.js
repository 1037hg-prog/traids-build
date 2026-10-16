#!/usr/bin/env node
/**
 * US vs EUROPE NATURAL GAS SPREAD (2026-10-07, operator: "how do we make money on the natural gas disparity between the us and europe").
 * Read-only. Yahoo daily closes: NG=F (Henry Hub front month, $/MMBtu), TTF=F (Dutch TTF front month, EUR/MWh), EURUSD=X.
 * TTF converted to $/MMBtu: EUR/MWh x EURUSD / 3.412 (1 MWh = 3.412 MMBtu). Prints today's spread with the arithmetic, and the
 * spread's distribution over the available history (daily, dates where all three series have a close).
 *   node backend/gas-spread-now.js [--years 5]
 */
"use strict";
const path = require("path");
const YF = require(path.join(__dirname, "node_modules", "yahoo-finance2")).default;
const yf = typeof YF === "function" ? new YF({ suppressNotices: ["yahooSurvey"] }) : YF;
const YEARS = (() => { const i = process.argv.indexOf("--years"); return i > 0 ? +process.argv[i + 1] : 5; })();
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
(async () => {
  const period1 = new Date(Date.now() - YEARS * 365.25 * 864e5);
  const get = async (sym) => { const r = await yf.chart(sym, { period1, interval: "1d" }); return new Map(r.quotes.filter((x) => x.close != null).map((x) => [x.date.toISOString().slice(0, 10), x.close])); };
  const [ng, ttf, fx] = await Promise.all([get("NG=F"), get("TTF=F"), get("EURUSD=X")]);
  const days = [...ttf.keys()].filter((d) => ng.has(d) && fx.has(d)).sort();
  const rows = days.map((d) => { const hh = ng.get(d), t = ttf.get(d) * fx.get(d) / 3.412; return { d, hh, ttfUsd: t, spread: t - hh, ratio: t / hh }; });
  const last = rows[rows.length - 1];
  console.log(`Latest common close ${last.d}: Henry Hub $${last.hh.toFixed(3)}/MMBtu; TTF EUR ${ttf.get(last.d).toFixed(2)}/MWh x ${fx.get(last.d).toFixed(4)} / 3.412 = $${last.ttfUsd.toFixed(3)}/MMBtu`);
  console.log(`Spread TTF - HH = $${last.spread.toFixed(2)}/MMBtu; ratio ${last.ratio.toFixed(2)}x`);
  const sp = rows.map((r) => r.spread);
  console.log(`\nHistory ${rows[0].d} .. ${last.d} (${rows.length} common days): spread p10 $${q(sp, .1).toFixed(2)} | median $${q(sp, .5).toFixed(2)} | p90 $${q(sp, .9).toFixed(2)} | min $${Math.min(...sp).toFixed(2)} | max $${Math.max(...sp).toFixed(2)}`);
  const pct = sp.filter((x) => x <= last.spread).length / sp.length;
  console.log(`Today's spread sits at the ${(100 * pct).toFixed(0)}th percentile of that history.`);
  for (const y of [...new Set(rows.map((r) => r.d.slice(0, 4)))]) { const s = rows.filter((r) => r.d.startsWith(y)).map((r) => r.spread); console.log(`  ${y}: median $${q(s, .5).toFixed(2)}, range $${Math.min(...s).toFixed(2)} .. $${Math.max(...s).toFixed(2)} (${s.length} days)`); }
})().catch((e) => { console.log("error:", e.message); process.exitCode = 1; });
