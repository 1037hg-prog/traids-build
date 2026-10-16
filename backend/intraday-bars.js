#!/usr/bin/env node
/**
 * INTRADAY BARS — 5-minute session bars for the board's roster, nightly. (manifest D4 data feed, 2026-08-21)
 *
 * The shop's horizons were 1–5 days and 0DTE options; a third horizon (hours) needs its own bars.
 * After the close, fetch the session's 5-minute bars for the 1,200-name roster (Alpaca, IEX feed —
 * prices are fine, IEX VOLUME is ~3% of the tape and is declared as such), keep the regular
 * session 09:30–15:55 ET, and persist one file per date: data/intraday/<date>.json. Append-only
 * (a date is never rewritten); the last 60 sessions are kept. ~5 MB per session.
 * Forming-bar guard: the collector refuses to run before 16:10 ET for today's date.
 * Usage: node backend/intraday-bars.js [YYYY-MM-DD]
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBarsWithBenchmark } = require("./lib/alpaca-bars");
const D = (f) => path.join(__dirname, "data", f);
const DIR = D("intraday");
const ROSTER = 1200, KEEP = 60;
const etDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const etHM = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
const hmOf = (iso) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

(async () => {
  const day = process.argv[2] || etDate;
  if (day === etDate && etHM < "16:10") { console.log(`INTRADAY BARS — ${day}: session not final before 16:10 ET (${etHM}); nothing written.`); return; }
  fs.mkdirSync(DIR, { recursive: true });
  const out = path.join(DIR, `${day}.json`);
  if (fs.existsSync(out)) { console.log(`INTRADAY BARS — ${day} already on disk (append-only; not rewritten).`); return; }
  const uni = JSON.parse(fs.readFileSync(D("universe-expanded.json"), "utf8"));
  const roster = uni.names.slice(0, ROSTER).map((n) => n.sym);
  const t0 = Date.now();
  // SIP first (consolidated tape; switched 2026-08-23). A 403 means the plan refuses SIP this close to now — fall back to IEX LOUDLY and label the file.
  let feedUsed = "sip", bars;
  try { ({ bars } = await fetchBarsWithBenchmark("SPY", roster, { start: day, end: day, timeframe: "5Min", feed: "sip", minBars: 1, quiet: true, chunkSize: 100 })); }
  catch (e) { console.warn(`  SIP fetch failed (${String(e.message).slice(0, 60)}) — falling back to IEX for ${day}`); feedUsed = "iex"; ({ bars } = await fetchBarsWithBenchmark("SPY", roster, { start: day, end: day, timeframe: "5Min", feed: "iex", minBars: 1, quiet: true, chunkSize: 100 })); }
  const symbols = {}; let total = 0, covered = 0;
  for (const sym of ["SPY", ...roster]) {
    const s = (bars[sym] || []).map((b) => ({ t: hmOf(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw })).filter((b) => b.t >= "09:30" && b.t < "16:00");
    if (s.length >= 30) { symbols[sym] = s; total += s.length; covered++; }
  }
  writeJsonAtomic(out, { date: day, writtenAt: new Date().toISOString(), feed: feedUsed === "sip" ? "alpaca-sip-5Min (consolidated tape: full volume, consolidated high/low; switched from IEX 2026-08-23 before R39 evidence)" : "alpaca-iex-5Min FALLBACK (SIP refused; IEX volume ≈3% of consolidated)", roster: roster.length, covered, bars: total, symbols });
  const files = fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) fs.unlinkSync(path.join(DIR, f));
  console.log(`INTRADAY BARS — ${day}: ${covered} of ${roster.length + 1} symbols with ≥30 session bars · ${total.toLocaleString()} bars · ${((Date.now() - t0) / 1000).toFixed(0)}s · ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
})();
