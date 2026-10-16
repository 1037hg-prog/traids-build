#!/usr/bin/env node
/**
 * WHERE DOES THE RETURN LIVE — OVERNIGHT OR INTRADAY? (2026-08-03)
 *
 * Operator: "so how do we capture the gap". Today our 30 longs averaged +0.77% of GAP we were
 * never in and -0.05% since entry. The day cadence (born at the open, dead at the close) means
 * we hold ONLY the intraday half of every session, by design — the design that exists because
 * overnight gap-throughs averaged -1.81R.
 *
 * Before asking HOW to capture the gap, measure WHETHER it is worth capturing:
 *   overnight = open_t / close_(t-1) - 1     (the half we never hold)
 *   intraday  = close_t / open_t - 1         (the half we always hold)
 *
 * Both require one round trip, so the cost comparison is symmetric.
 *
 * Registry note: test #27 "Overnight anomaly" is recorded DEAD with NO detail — no universe, no
 * costs, no period. That is a hole in the record, so this re-measures from scratch and reports
 * the tail as well as the mean, because a positive mean with a fat left tail is how accounts die.
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const D = (f) => path.join(__dirname, "data", f);
const AH = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
const nap = (ms) => new Promise(r => setTimeout(r, ms));
const START = "2024-01-01", END = "2026-08-01";

const bars = {};
async function fetchBars(list) {
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25); let token = null;
    do {
      const p = new URLSearchParams({ symbols: chunk.join(","), timeframe: "1Day", start: START, end: END, limit: "10000", feed: "iex", adjustment: "all" });
      if (token) p.set("page_token", token);
      try {
        const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${p}`, { headers: AH, signal: AbortSignal.timeout(60000) });
        if (!r.ok) break;
        const j = await r.json();
        for (const [k, v] of Object.entries(j.bars || {})) bars[k] = (bars[k] || []).concat(v);
        token = j.next_page_token || null;
      } catch { break; }
      await nap(320);
    } while (token);
    if (list.length > 20) process.stdout.write(`  priced ${Object.keys(bars).length}/${list.length}\r`);
  }
}
const stat = (xs) => {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
  return { m, sd, se: sd / Math.sqrt(xs.length), t: m / (sd / Math.sqrt(xs.length)), n: xs.length };
};
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.max(0, Math.floor(q * s.length) - 1)]; };

function report(label, on, intra) {
  const so = stat(on), si = stat(intra);
  const line = (n, s, arr) => console.log(`  ${n.padEnd(11)} mean ${(s.m >= 0 ? "+" : "") + (s.m * 100).toFixed(4)}%  t ${s.t.toFixed(2).padStart(6)}   ann ${((Math.pow(1 + s.m, 252) - 1) * 100).toFixed(1).padStart(7)}%   worst ${(pct(arr, 0.01) * 100).toFixed(2)}% (1st pct)`);
  console.log(`\n${label}  (${so.n} sessions)`);
  line("OVERNIGHT", so, on);
  line("INTRADAY", si, intra);
  console.log(`  gap-minus-intraday: ${(((so.m - si.m)) * 100).toFixed(4)}% per session`);
}

(async () => {
  console.log("=== INDEX LEVEL ===");
  await fetchBars(["SPY", "QQQ", "IWM"]);
  for (const s of ["SPY", "QQQ", "IWM"]) {
    const b = bars[s]; if (!b || b.length < 100) { console.log(`${s}: no data`); continue; }
    const on = [], intra = [];
    for (let i = 1; i < b.length; i++) { on.push(b[i].o / b[i - 1].c - 1); intra.push(b[i].c / b[i].o - 1); }
    report(s, on, intra);
  }
  // ── our own tradable universe, equal-weight per session ──────────────────
  const uni = JSON.parse(fs.readFileSync(process.env.TEMP + "/uni.json", "utf8"));
  console.log(`\n\n=== OUR ${uni.length}-NAME UNIVERSE (equal-weight, one observation per session) ===`);
  await fetchBars(uni);
  const byDay = {};
  for (const s of uni) {
    const b = bars[s]; if (!Array.isArray(b) || b.length < 100) continue;
    for (let i = 1; i < b.length; i++) {
      const d = String(b[i].t).slice(0, 10);
      if (!(b[i - 1].c > 0 && b[i].o > 0)) continue;
      (byDay[d] ||= { on: [], intra: [] });
      byDay[d].on.push(b[i].o / b[i - 1].c - 1);
      byDay[d].intra.push(b[i].c / b[i].o - 1);
    }
  }
  const days = Object.keys(byDay).sort().filter(d => byDay[d].on.length >= 50);
  const on = days.map(d => byDay[d].on.reduce((s, x) => s + x, 0) / byDay[d].on.length);
  const intra = days.map(d => byDay[d].intra.reduce((s, x) => s + x, 0) / byDay[d].intra.length);
  report(`universe equal-weight`, on, intra);
  const so = stat(on), si = stat(intra);
  const COST = 0.002;   // 2 x 10bps round trip, identical for either leg
  console.log(`\n  NET OF A 20bps ROUND TRIP (same for both, so this is apples to apples):`);
  console.log(`    overnight net ${((so.m - COST) * 100).toFixed(4)}% / session   intraday net ${((si.m - COST) * 100).toFixed(4)}% / session`);
  console.log(`\n  TAIL — the reason the day cadence exists:`);
  console.log(`    worst overnight session ${(Math.min(...on) * 100).toFixed(2)}%   vs worst intraday ${(Math.min(...intra) * 100).toFixed(2)}%`);
  console.log(`    overnight 1st-pct ${(pct(on, 0.01) * 100).toFixed(2)}%   intraday 1st-pct ${(pct(intra, 0.01) * 100).toFixed(2)}%`);
  fs.writeFileSync(D("overnight-vs-intraday.json"), JSON.stringify({ ranAt: new Date().toISOString(), window: [START, END], sessions: days.length, overnight: so, intraday: si, costPerRoundTrip: COST }, null, 1));
  console.log(`\nwritten: overnight-vs-intraday.json`);
})();
