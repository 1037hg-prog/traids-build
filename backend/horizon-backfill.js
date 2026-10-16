#!/usr/bin/env node
/**
 * TRAIDS — HORIZON BACKFILL: for every settled trade, compute what it WOULD have
 * returned at +3d / +5d / +10d past its exit, in R.
 *
 * WHY: the board settles on a short hold, and the replay showed the 2R target is
 * reached only 0.6% of the time on a 1-day hold — meaning the trade structure may be
 * mismatched to the signal's horizon. This answers "is the hold too short?" with data
 * instead of opinion, and it costs nothing: the bars already exist.
 *
 * It writes fwdR3 / fwdR5 / fwdR10 back into the trade log (idempotent — only fills
 * missing fields, never rewrites an outcome). Safe to run daily; the server merges.
 *
 * Usage: node backend/horizon-backfill.js
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const LOG = path.join(__dirname, "data", "trade_log.json");
const HORIZONS = [3, 5, 10];

async function eqBars(sym, fromISO) {
  const p = new URLSearchParams({ symbols: sym, timeframe: "1Day", start: fromISO, limit: "200", adjustment: "all", feed: FEED });
  try {
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${p}`, { headers });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.bars?.[sym] || []).map(b => ({ t: (b.t || "").slice(0, 10), c: b.c }));
  } catch { return []; }
}
async function yBars(sym, days) {
  try {
    const r = await fetch(`http://localhost:3002/api/yahoo/batch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: [sym], days }) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data?.[sym.toUpperCase()] || []).map(b => ({ t: b.t, c: b.c }));
  } catch { return []; }
}
const ymap = (t) => t.cls === "Crypto" ? t.sym.replace("/", "-") : t.cls === "Futures" ? (t.priceSym || t.sym) + "=F" : t.cls === "FX" ? t.sym.replace("/", "") + "=X" : t.sym;

(async () => {
  let log = []; try { log = JSON.parse(fs.readFileSync(LOG, "utf8")); } catch { console.error("no trade log"); process.exit(1); }
  // Historical trades predate stopDist being logged — but it's recoverable:
  // rMult = (exit − entry)·dir / stopDist  ⟹  stopDist = (exit − entry)·dir / rMult.
  let recovered = 0;
  for (const t of log) {
    if (t.stopDist > 0 || t.cls === "Options") continue;
    if (!Number.isFinite(t.entry) || !Number.isFinite(t.exit) || !Number.isFinite(t.rMult) || Math.abs(t.rMult) < 1e-6) continue;
    const sd = ((t.exit - t.entry) * t.dir) / t.rMult;
    if (sd > 0 && isFinite(sd)) { t.stopDist = +sd.toFixed(6); recovered++; }
  }
  if (recovered) console.log(`\n  recovered stopDist on ${recovered} historical trades (from entry/exit/rMult)`);
  const need = log.filter(t => t.cls !== "Options" && Number.isFinite(t.entry) && Number.isFinite(t.stopDist) && t.stopDist > 0
    && t.closedAt && HORIZONS.some(h => t[`fwdR${h}`] === undefined));
  console.log(`\n  TRAIDS — Horizon backfill · ${log.length} logged · ${need.length} need forward R\n`);
  if (!need.length) { console.log("  nothing to do.\n"); return; }

  const bySym = {};
  for (const t of need) (bySym[t.sym] = bySym[t.sym] || []).push(t);
  let filled = 0;
  for (const sym of Object.keys(bySym)) {
    const group = bySym[sym];
    const earliest = new Date(Math.min(...group.map(t => t.closedAt)) - 5 * 86400000).toISOString().slice(0, 10);
    const cls = group[0].cls;
    const bars = cls === "Equity" ? await eqBars(sym, earliest) : await yBars(ymap(group[0]), 120);
    if (!bars.length) continue;
    for (const t of group) {
      const day = new Date(t.closedAt).toISOString().slice(0, 10);
      const i = bars.findIndex(b => b.t >= day);
      if (i < 0) continue;
      for (const h of HORIZONS) {
        if (t[`fwdR${h}`] !== undefined) continue;
        const j = i + h;
        if (j >= bars.length) continue;                       // not enough future yet — leave undefined, retry later
        t[`fwdR${h}`] = +(((bars[j].c - t.entry) * t.dir) / t.stopDist).toFixed(3);
        filled++;
      }
    }
    process.stdout.write(".");
  }
  fs.writeFileSync(LOG, JSON.stringify(log));
  console.log(`\n\n  filled ${filled} horizon values.\n`);

  // Report: does holding longer help?
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  const at = (k) => log.filter(t => Number.isFinite(t[k])).map(t => t[k]);
  const settled = log.filter(t => Number.isFinite(t.rMult)).map(t => t.rMult);
  console.log("  HOLD-PERIOD COMPARISON (avg R, same trades):");
  console.log(`    as settled (short hold)   n ${String(settled.length).padEnd(6)} ${(mean(settled) >= 0 ? "+" : "") + mean(settled).toFixed(4)}R`);
  for (const h of HORIZONS) { const a = at(`fwdR${h}`); if (a.length) console.log(`    held +${String(h).padEnd(2)} sessions      n ${String(a.length).padEnd(6)} ${(mean(a) >= 0 ? "+" : "") + mean(a).toFixed(4)}R`); }
  console.log(`\n  READ: if longer holds are systematically better/worse, the trade STRUCTURE is mismatched\n  to the signal's horizon — a pre-registered structural question, not a tweak to chase.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
