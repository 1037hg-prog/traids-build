/**
 * TRAIDS — Massive.com continuous-futures engine.
 *
 * Massive serves individual expiring contracts (ESU6, CLQ6…). The board needs a continuous,
 * ~2-year daily OHLCV series per product. This stitches contracts by picking the max-VOLUME
 * (liquid front-month) contract each day and using its raw OHLC — good enough for the board's
 * MA/breakout/ATR signals (small roll gaps a few times a year). Unlimited calls on the futures
 * plan make the over-fetch cheap; results are cached per ET trading day.
 *
 * Exports: getFuturesBars(roots) -> { ROOT: [{c,h,l,v}] }  (board-shaped, oldest→newest)
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const KEY = process.env.MASSIVE_API_KEY, BASE = (process.env.MASSIVE_API_BASE_URL || "https://api.massive.com").replace(/\/$/, "");
const MCODES = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"];   // Jan…Dec
const etDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const cache = new Map();   // root -> { day, bars }

async function fetchContract(ticker, from) {
  const url = `${BASE}/futures/v1/aggs/${ticker}?resolution=1session&window_start.gte=${from}&limit=50000`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.results || []).map(b => ({ d: b.session_end_date || new Date(b.window_start / 1e6).toISOString().slice(0, 10), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume || 0 })).filter(x => x.c > 0 && x.h > 0);
  } catch { return []; }
}

async function buildContinuous(root) {
  const c = cache.get(root); const day = etDay();
  if (c && c.day === day) return c.bars;
  const now = new Date(); const yrs = [now.getFullYear() - 2, now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
  const from = new Date(Date.now() - 760 * 86_400_000).toISOString().slice(0, 10);
  // candidate contracts: every month code across the recent years (empties return fast)
  const tickers = []; for (const y of yrs) for (const m of MCODES) tickers.push(`${root}${m}${y % 10}`);
  // fetch concurrently in batches (unlimited calls)
  const got = [];
  for (let i = 0; i < tickers.length; i += 16) { const batch = tickers.slice(i, i + 16); const res = await Promise.all(batch.map(t => fetchContract(t, from).then(bars => ({ t, bars })))); for (const r of res) if (r.bars.length) got.push(r); }
  // date -> contracts; pick max-volume (liquid front) each day, use its raw OHLC
  const byDate = {};
  for (const { t, bars } of got) for (const b of bars) (byDate[b.d] ||= []).push({ t, ...b });
  const bars = Object.keys(byDate).sort().map(d => { const recs = byDate[d]; let a = recs[0]; for (const r of recs) if (r.v > a.v) a = r; return { c: a.c, h: a.h, l: a.l, v: a.v }; });
  cache.set(root, { day, bars });
  return bars;
}

async function getFuturesBars(roots) {
  const out = {};
  for (const root of roots) { try { out[root] = await buildContinuous(root); } catch { out[root] = null; } }
  return out;
}

module.exports = { getFuturesBars, buildContinuous };

// self-test:  node backend/massive-futures.js ES NQ CL GC
if (require.main === module) {
  (async () => {
    if (!KEY) { console.error("\n  Missing MASSIVE_API_KEY.\n"); process.exit(1); }
    const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["ES", "NQ", "CL", "GC", "ZN", "6E"];
    console.log(`\n  Massive continuous-futures self-test · ${roots.join(", ")}\n`);
    for (const root of roots) {
      const b = await buildContinuous(root);
      if (!b.length) { console.log(`  ${root}: no data`); continue; }
      const last = b[b.length - 1];
      console.log(`  ${root}: ${b.length} session bars · last C ${last.c} H ${last.h} L ${last.l} VOL ${last.v}`);
    }
    console.log("");
  })();
}
