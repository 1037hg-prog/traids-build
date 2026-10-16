#!/usr/bin/env node
/**
 * SKEW OBSERVER — daily option-skew readings, LOGGED AND NEVER ACTED ON.
 *
 * Registered 2026-08-12 after CNBC/Cboe reported that ordinary portfolio hedges had been sold
 * while far-OTM crash protection stayed bid (10-delta/25-delta put ratio at the 66th percentile
 * of five years). Our own bear gauge says "if VIX<20 hedging is affordable" from a single VIX
 * threshold — which cannot see WHERE in the surface the demand actually is. This records that.
 *
 * WHAT IS MEASURED (and what is deliberately not)
 * Cboe's published figure is a VOLUME ratio on SPX index options with five years of history.
 * Neither is reproducible here: Alpaca's options feed is `indicative` (a partial view of
 * consolidated volume — measured 10,378 contracts across 200 SPY puts, which is a fraction of
 * the real tape), and this file starts with zero history. Substituting our partial volume for
 * Cboe's would be inventing agreement. So the primary series is IMPLIED VOLATILITY skew, which
 * measures the same underlying phenomenon — tail demand bids up far-OTM puts — from QUOTES,
 * which the feed does carry honestly:
 *
 *   skew_10_25  IV at delta -0.10  ÷  IV at delta -0.25      (tail bid vs ordinary hedge bid)
 *   rr_25       IV at delta -0.25  −  IV at delta +0.25      (classic 25-delta risk reversal)
 *   atm_iv      IV at delta ±0.50                            (the level the VIX-style read sees)
 *
 * Deltas are LINEARLY INTERPOLATED between the two contracts bracketing each target, so the
 * reading does not depend on whether a strike happens to sit exactly at 10 delta.
 *
 * NO PERCENTILES ARE PRINTED until this file has its own history. A "66th percentile" claim
 * needs a distribution; borrowing Cboe's while measuring something else is how a number becomes
 * a story. The reading accrues; the registry decides later whether it ever means anything.
 *
 * STATUS: observer only. Nothing here selects, sizes, or gates a single position — the same
 * standing as the other 29 observers, and it stays that way until a pre-registered test says
 * otherwise.
 *
 * Usage: node backend/skew-observer.js        → appends today's reading to data/skew-observer.json
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const OUT = path.join(__dirname, "data", "skew-observer.json");
const UNDERLYINGS = ["SPY", "QQQ", "IWM"];        // S&P, Nasdaq, Russell — the three the report contrasts
const DTE_MIN = 21, DTE_MAX = 45;                 // ~1 month, the tenor the report describes
const HDRS = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
const iso = (d) => d.toISOString().slice(0, 10);
const etDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

async function chain(sym, side, lo, hi) {
  const out = [];
  let token = null, guard = 0;
  do {
    const p = new URLSearchParams({ feed: "indicative", type: side, limit: "1000", expiration_date_gte: lo, expiration_date_lte: hi });
    if (token) p.set("page_token", token);
    const r = await fetch(`https://data.alpaca.markets/v1beta1/options/snapshots/${encodeURIComponent(sym)}?${p}`, { headers: HDRS, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`${sym} ${side} chain ${r.status}`);
    const j = await r.json();
    for (const [occ, s] of Object.entries(j.snapshots || {})) {
      const d = s.greeks?.delta, iv = Number(s.impliedVolatility);
      if (d == null || !Number.isFinite(iv) || iv <= 0) continue;
      // A quote must exist on both sides: a contract with no bid has no honest IV to read.
      if (!(s.latestQuote?.bp > 0 && s.latestQuote?.ap > 0)) continue;
      out.push({ occ, delta: Number(d), iv, exp: occ.slice(-15, -9) });
    }
    token = j.next_page_token || null;
    if (++guard > 20) break;
  } while (token);
  return out;
}

/** IV at a target delta, linearly interpolated between its two bracketing contracts. */
function ivAtDelta(rows, target) {
  const pts = rows.map(r => ({ d: r.delta, iv: r.iv })).sort((a, b) => a.d - b.d);
  if (pts.length < 2) return null;
  if (target < pts[0].d || target > pts[pts.length - 1].d) return null;   // outside the wing we can see
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].d >= target) {
      const a = pts[i - 1], b = pts[i];
      const span = b.d - a.d;
      if (Math.abs(span) < 1e-9) return b.iv;
      return a.iv + (b.iv - a.iv) * ((target - a.d) / span);
    }
  }
  return null;
}

(async () => {
  const today = etDay();
  const now = new Date();
  const lo = iso(new Date(now.getTime() + DTE_MIN * 864e5)), hi = iso(new Date(now.getTime() + DTE_MAX * 864e5));
  const state = (() => { try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {
    return { spec: "skew-observer v1", registered: "2026-08-12", status: "LOGGED-NEVER-ACTED-ON",
      measures: { skew_10_25: "IV(-0.10 delta put) / IV(-0.25 delta put)", rr_25: "IV(-0.25 put) - IV(+0.25 call)", atm_iv: "IV at |delta| 0.50" },
      note: "Cboe's published 10d/25d figure is a VOLUME ratio on SPX with 5y history; this is an IV ratio on ETF chains with none. Same phenomenon, different instrument — never quote one as the other.",
      readings: [] };
  } })();
  if (state.readings.some(r => r.date === today)) { console.log(`SKEW OBSERVER — ${today} already recorded; nothing appended (idempotent).`); return; }

  // SESSION TAG. A skew series is only comparable to itself if the readings are taken at a
  // consistent point in the session — after-hours quotes on the indicative feed are wider and
  // staler than mid-session ones. The chain runs this post-close; reading #1 was taken
  // mid-session by hand. Rather than pretend, every reading states which it is.
  const etHM = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const session = etHM >= "09:45" && etHM < "16:00" ? "mid-session" : etHM >= "16:00" && etHM < "20:00" ? "post-close" : "off-hours";
  const reading = { date: today, recordedAt: now.toISOString(), etTime: etHM, session, tenorDays: [DTE_MIN, DTE_MAX], by: {} };
  for (const sym of UNDERLYINGS) {
    try {
      const puts = await chain(sym, "put", lo, hi), calls = await chain(sym, "call", lo, hi);
      const iv10p = ivAtDelta(puts, -0.10), iv25p = ivAtDelta(puts, -0.25), iv50p = ivAtDelta(puts, -0.50);
      const iv25c = ivAtDelta(calls, 0.25);
      reading.by[sym] = {
        contracts: { puts: puts.length, calls: calls.length },
        iv10p: iv10p == null ? null : +iv10p.toFixed(4),
        iv25p: iv25p == null ? null : +iv25p.toFixed(4),
        iv25c: iv25c == null ? null : +iv25c.toFixed(4),
        atm_iv: iv50p == null ? null : +iv50p.toFixed(4),
        skew_10_25: (iv10p && iv25p) ? +(iv10p / iv25p).toFixed(4) : null,
        rr_25: (iv25p != null && iv25c != null) ? +(iv25p - iv25c).toFixed(4) : null,
      };
    } catch (e) {
      reading.by[sym] = { error: String(e.message || e) };   // recorded, not hidden
    }
  }

  // Market-wide put/call, from a source that reports the whole chain rather than our partial feed.
  // One request per run keeps the AlphaVantage free-tier budget (25/day) intact.
  try {
    const k = process.env.ALPHAVANTAGE_KEY;
    if (k) {
      const r = await fetch(`https://www.alphavantage.co/query?function=REALTIME_PUT_CALL_RATIO&symbol=SPY&apikey=${k}`, { signal: AbortSignal.timeout(20000) });
      const j = r.ok ? await r.json() : null;
      const v = j && Number(j.put_call_ratio_full_chain);
      reading.spyPutCallFullChain = Number.isFinite(v) ? v : null;
      // AV's Information text can quote the API key back (its rate-limit reply does); never store it verbatim.
      if (j && j.Information) reading.putCallNote = String(j.Information).replace(/API key as \S+/gi, "API key as [redacted]").replace(k, "[redacted]").slice(0, 160);
    }
  } catch (e) { reading.putCallNote = `unavailable: ${e.message}`; }

  state.readings.push(reading);
  fs.writeFileSync(OUT, JSON.stringify(state, null, 1));

  const n = state.readings.length;
  console.log(`SKEW OBSERVER — ${today} ${etHM} ET (${session}, ${DTE_MIN}-${DTE_MAX} DTE)  ·  reading ${n} of the series`);
  for (const sym of UNDERLYINGS) {
    const b = reading.by[sym];
    if (!b || b.error) { console.log(`  ${sym.padEnd(4)} unavailable — ${b?.error || "no data"} (recorded as absent, nothing substituted)`); continue; }
    console.log(`  ${sym.padEnd(4)} ATM IV ${(b.atm_iv * 100).toFixed(1)}%  ·  10d/25d put skew ${b.skew_10_25}  ·  25d risk reversal ${b.rr_25 >= 0 ? "+" : ""}${(b.rr_25 * 100).toFixed(2)}pp  (${b.contracts.puts}p/${b.contracts.calls}c quoted)`);
  }
  if (reading.spyPutCallFullChain != null) console.log(`  SPY put/call, full chain: ${reading.spyPutCallFullChain}`);
  console.log(n < 60
    ? `  ACCRUING — ${n} session(s) on file. No percentile, no verdict, no position: an observer with no distribution is a number, not a signal.`
    : `  ${n} sessions on file — enough for a distribution; any read still requires a pre-registered test.`);
  console.log(`written: ${path.basename(OUT)}`);
})();
