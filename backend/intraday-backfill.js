#!/usr/bin/env node
/**
 * INTRADAY BACKFILL — two years of 5-minute session bars for the roster, same file format as the
 * nightly D4 feed (intraday-bars.js), in its own directory. (2026-08-23, operator: "channel our inner
 * medallion" → "go".)
 *
 * WHY. Medallion's data was measured in decades; our intraday store started on 2026-08-21. Alpaca
 * serves historical 5-minute bars on the feed we already use, so the R39 family (and any model that
 * eats its rows) can be tested on ~500 sessions of walk-forward history instead of two weeks of
 * forward evidence. History is IN-SAMPLE EXPLORATION and is labelled so everywhere it is read:
 * the forward ledger stays the verdict. (The board's own daily backtests showed ~0 edge; this may too.)
 *
 * WHAT. For every weekday in [--from, --to], fetch the session's 5-minute IEX bars for today's
 * top-1,200 roster (+ SPY), keep 09:30–15:55 ET, write data/intraday-history/<date>.json with the
 * exact schema intraday-bars.js writes, plus history:true. Resumable (a date on disk is skipped),
 * newest-first so the most relevant year lands first, holidays skipped when nothing trades.
 *
 * DECLARED WEAKNESSES (carried into every read of this data):
 *   - SURVIVORSHIP: the roster is today's top 1,200 by liquidity, applied to the past. Names that
 *     died or shrank are absent; names that grew into the roster are present before they qualified.
 *     The D2 point-in-time snapshots only begin 2026-08-21, so this cannot be fixed for history.
 *   - IEX bars: prices representative, volume ≈3% of the consolidated tape (VWAP is IEX-weighted).
 *   - adjustment=all (total-return series), matching the nightly collector so history and forward
 *     sessions grade identically; within a single session the adjustment is immaterial.
 *
 * Usage: node backend/intraday-backfill.js [--from 2024-08-26] [--to 2026-08-20] [--roster 1200]
 * Budget: ~12 requests per session at the helper's 350 ms floor → ~4–5 s per session, ~40 min for
 * two years. Safe to stop and rerun.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBars } = require("./lib/alpaca-bars");
const D = (f) => path.join(__dirname, "data", f);
const DIR = D("intraday-history");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const FROM = arg("--from", "2024-08-26"), TO = arg("--to", "2026-08-20"), ROSTER = +arg("--roster", 1200);
const hmOf = (iso) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const uni = JSON.parse(fs.readFileSync(D("universe-expanded.json"), "utf8"));
  const roster = uni.names.slice(0, ROSTER).map((n) => n.sym);
  const days = [];
  for (let d = new Date(TO + "T12:00:00Z"); d >= new Date(FROM + "T12:00:00Z"); d = new Date(d.getTime() - 864e5)) {
    const dow = d.getUTCDay(); if (dow === 0 || dow === 6) continue;
    days.push(d.toISOString().slice(0, 10));
  }
  const have = new Set(fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)));
  const todo = days.filter((d) => !have.has(d) && !have.has(d + ".nosession"));
  console.log(`INTRADAY BACKFILL — ${FROM} → ${TO}: ${days.length} weekdays, ${have.size} on disk, ${todo.length} to fetch · roster ${roster.length} + SPY · newest first`);
  const t0 = Date.now(); let done = 0, skipped = 0, bars = 0;
  for (const day of todo) {
    const t1 = Date.now();
    let res;
    try {
      res = await fetchBars(["SPY", ...roster], { start: day, end: day, timeframe: "5Min", feed: "sip", chunkSize: 100, requireAll: false, requireSymbols: null, quiet: true });
    } catch (e) { console.log(`  ${day}: fetch failed — ${e.message} (will retry on the next run)`); continue; }
    const symbols = {}; let total = 0, covered = 0;
    for (const sym of ["SPY", ...roster]) {
      const s = (res.bars[sym] || []).map((b) => ({ t: hmOf(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw })).filter((b) => b.t >= "09:30" && b.t < "16:00");
      if (s.length >= 30) { symbols[sym] = s; total += s.length; covered++; }
    }
    if (covered < 50 || !symbols.SPY) {   // holiday or half-day too thin to grade: mark it so the rerun skips it
      fs.writeFileSync(path.join(DIR, `${day}.nosession`), `${covered} symbols with >=30 bars; SPY ${symbols.SPY ? "present" : "absent"}\n`);
      skipped++; console.log(`  ${day}: no session (${covered} covered)`); continue;
    }
    writeJsonAtomic(path.join(DIR, `${day}.json`), { date: day, history: true, writtenAt: new Date().toISOString(), feed: "alpaca-sip-5Min (consolidated tape: full volume, consolidated high/low; switched from IEX 2026-08-23 before R39 evidence)", rosterAsOf: uni.builtAt || null, survivorship: "today's roster applied to the past — declared", roster: roster.length, covered, bars: total, symbols });
    done++; bars += total;
    const el = (Date.now() - t0) / 1000, per = el / (done + skipped), left = (todo.length - done - skipped) * per;
    console.log(`  ${day}: ${covered} symbols · ${total.toLocaleString()} bars · ${((Date.now() - t1) / 1000).toFixed(1)}s · ${done + skipped}/${todo.length} · ~${(left / 60).toFixed(0)} min left`);
  }
  console.log(`INTRADAY BACKFILL — done: ${done} sessions written, ${skipped} non-sessions, ${bars.toLocaleString()} bars, ${((Date.now() - t0) / 60000).toFixed(1)} min · on disk now ${fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).length} sessions`);
})().catch((e) => { console.error("INTRADAY BACKFILL failed:", e.message); process.exit(1); });
