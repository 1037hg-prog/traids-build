"use strict";
/**
 * FUTURES DAILY BARS — Schwab continuous /ROOT daily, cached on disk (2026-10-02, the daily half of the Massive exit).
 *
 * Replaces massive-futures.js (Massive 1session aggs, max-volume contract per day) for the board's POST /api/futures/bars and the
 * daily research scripts. The cache is written by backend/futures-daily-cache.js in the close chain (after the live watcher has
 * exited, so it never competes with the wire for Schwab's ~120 req/min) and READ here; nothing in this file calls Schwab except
 * fetchDaily(), which only the cache writer uses.
 *
 * Shape: data/futures-daily/<ROOT>.json { spec, root, symbol, fetchedAt, bars: [{ d, o, h, l, c, v }] }  (d = session date,
 * America/Chicago — Schwab stamps a futures daily candle at 00:00 CT of its trade date). getFuturesBars(roots) returns the exact
 * massive-futures shape the board reads: { ROOT: [{ c, h, l, v }] } oldest -> newest, about 760 days, null when absent.
 *
 * KNOWN DIFFERENCE vs Massive: the cache is refreshed nightly, so during a session the newest bar is the PREVIOUS session (Massive's
 * in-process fetch included today's forming session). Board futures have been veto shadows since OP8, so this moves no ticket.
 */
const fs = require("fs"), path = require("path");

const DIR = path.join(__dirname, "..", "data", "futures-daily");
/** The board's futures roots (src/App.jsx FUTURES, 46 as of 2026-10-02) — the ICE five had no Massive data either. */
const BOARD_ROOTS = ["ES", "NQ", "RTY", "YM", "MES", "MNQ", "CL", "NG", "RB", "GC", "SI", "HG", "ZB", "ZN", "ZF", "6E", "6J", "6B", "ZC", "ZW", "ZS",
  "ZT", "PL", "PA", "HO", "6A", "6C", "6S", "LE", "HE", "ZL", "ZM", "KE", "GF", "6N", "6M", "UB", "TN", "SR3", "NKD", "BZ", "KC", "SB", "CC", "CT", "OJ"];
const LOOKBACK_DAYS = 760;

const _ct = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
const ctDate = (ms) => _ct.format(new Date(ms));

function readDaily(root) {
  const f = path.join(DIR, `${root}.json`);
  if (!fs.existsSync(f)) return null;
  try { const j = JSON.parse(fs.readFileSync(f, "utf8")); return Array.isArray(j.bars) ? j : null; } catch { return null; }
}

/** Board shape, from the cache only. { ROOT: [{c,h,l,v}] | null } */
async function getFuturesBars(roots) {
  const out = {};
  const from = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
  for (const root of roots) {
    const j = readDaily(root);
    out[root] = j ? j.bars.filter((b) => b.d >= from && b.c > 0 && b.h > 0).map((b) => ({ c: b.c, h: b.h, l: b.l, v: b.v || 0 })) : null;
    if (out[root] && !out[root].length) out[root] = null;
  }
  return out;
}
/** Research shape: [{ d, o, h, l, c, v }] for one root, optionally from a date. Throws when the root is not cached. */
function loadDaily(root, { from = "0000-00-00" } = {}) {
  const j = readDaily(root);
  if (!j) throw new Error(`futures-daily: ${root} is not cached in ${DIR} — run backend/futures-daily-cache.js --roots ${root} (after the session)`);
  return j.bars.filter((b) => b.d >= from);
}
function cacheAge(root) { const j = readDaily(root); return j ? { fetchedAt: j.fetchedAt, last: j.bars.length ? j.bars[j.bars.length - 1].d : null } : null; }

/** Schwab pricehistory daily, continuous front month (the slash form). Used by the cache writer only. */
async function fetchDaily(root, { days = LOOKBACK_DAYS + 40, timeoutMs = 30000 } = {}) {
  const tok = await require("./schwab.js").token();
  const end = Date.now(), start = end - days * 864e5;
  const u = `https://api.schwabapi.com/marketdata/v1/pricehistory?symbol=${encodeURIComponent("/" + root)}&periodType=year&frequencyType=daily&frequency=1&startDate=${start}&endDate=${end}&needExtendedHoursData=false`;
  let r = null;
  for (let a = 0; a < 3; a++) {
    r = await fetch(u, { headers: { Authorization: "Bearer " + tok, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (r.status !== 429) break;
    await new Promise((res) => setTimeout(res, 15000 * (a + 1)));
  }
  if (!r.ok) throw new Error(`schwab daily /${root} HTTP ${r.status}`);
  const j = await r.json();
  const bars = (j.candles || []).filter((c) => c.close > 0 && c.high > 0).map((c) => ({ d: ctDate(c.datetime), o: c.open, h: c.high, l: c.low, c: c.close, v: Number(c.volume) || 0 }));
  bars.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return { symbol: j.symbol || null, bars };
}

module.exports = { DIR, BOARD_ROOTS, LOOKBACK_DAYS, readDaily, getFuturesBars, loadDaily, cacheAge, fetchDaily, buildContinuous: async (root) => (await getFuturesBars([root]))[root] || [] };
