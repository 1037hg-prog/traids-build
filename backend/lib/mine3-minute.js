"use strict";
/**
 * MINE-3 minute-bar cache — shared by r193-intraday-momentum.js and r196-pre-fomc.js (2026-09-24).
 *
 * Source: Alpaca SIP 1-minute bars via lib/alpaca-bars.js fetchBars (feed "sip", timeframe "1Min", adjustment "split").
 * Cache:  data/training/mine3/<SYM>-<YYYY>.json — one file per symbol-year, REGULAR-HOURS CLOSES ONLY, keyed by ET date and
 *         ET minute-of-day of the bar's START label (570 = the 09:30 bar ... 959 = the 15:59 bar). Extended-hours bars are dropped
 *         at write time; a half-day's post-13:00 bars are kept in the file but every reader bounds by the Alpaca calendar close.
 * Price-at-time convention used by both scripts: price at HH:MM = the CLOSE of the bar labelled HH:MM-1 (the last trade before
 *         HH:MM). If that bar is missing, the last earlier bar inside the session is used, and its staleness in minutes is returned.
 * Sessions: Alpaca /v2/calendar (paper API, read-only), cached to data/training/mine3/calendar-<start>-<end>.json.
 * The fetch end is always an already-closed historical date (the registered windows end 2026-08-31), i.e. far more than 20 minutes
 * in the past; a year file is written only after its full year (or the window end) is fetched.
 */
const fs = require("fs"), path = require("path");
const { fetchBars } = require("./alpaca-bars.js");
const { writeJsonAtomic } = require("./atomic-write.js");
const DIR = path.join(__dirname, "..", "data", "training", "mine3");

const _off = new Map();
/** ET offset (minutes, negative) for a UTC calendar date; DST switches at 06:00/07:00 UTC, never inside regular hours. */
function etOffset(utcDate) {
  if (_off.has(utcDate)) return _off.get(utcDate);
  const d = new Date(utcDate + "T15:00:00Z");
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  const off = ((+p.hour % 24) - 15) * 60;   // -240 (EDT) or -300 (EST)
  _off.set(utcDate, off); return off;
}
function toET(iso) {
  const ms = Date.parse(iso), off = etOffset(iso.slice(0, 10)), l = new Date(ms + off * 60000);
  return { d: l.toISOString().slice(0, 10), m: l.getUTCHours() * 60 + l.getUTCMinutes() };
}

async function calendar(start, end) {
  fs.mkdirSync(DIR, { recursive: true });
  const f = path.join(DIR, `calendar-${start}-${end}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")).sessions;
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
  const h = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
  const r = await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${start}&end=${end}`, { headers: h, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`alpaca calendar ${r.status}`);
  const sessions = (await r.json()).map((x) => {
    const [oh, om] = x.open.split(":").map(Number), [ch, cm] = x.close.split(":").map(Number);
    return { date: x.date, open: oh * 60 + om, close: ch * 60 + cm };
  });
  writeJsonAtomic(f, { spec: "mine3-calendar-v1", source: "paper-api /v2/calendar", fetchedAt: new Date().toISOString(), sessions });
  return sessions;
}

/** Returns Map(date -> Map(minute -> close)) for one symbol over [start, end] (ISO dates), fetching missing year files. */
async function minuteCloses(sym, start, end) {
  fs.mkdirSync(DIR, { recursive: true });
  const out = new Map();
  for (let y = +start.slice(0, 4); y <= +end.slice(0, 4); y++) {
    const ys = y === +start.slice(0, 4) ? start : `${y}-01-01`, ye = y === +end.slice(0, 4) ? end : `${y}-12-31`;
    const f = path.join(DIR, `${sym}-${y}.json`);
    let doc = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
    if (!doc || doc.from > ys || doc.to < ye) {
      process.stdout.write(`  [mine3] fetching ${sym} ${ys}..${ye} (SIP 1Min, split)\n`);
      const r = await fetchBars([sym], { start: ys, end: ye + "T23:59:59Z", timeframe: "1Min", feed: "sip", adjustment: "split", requireAll: true, quiet: true, minIntervalMs: 300 });
      const days = {};
      for (const b of r.bars[sym]) {
        const { d, m } = toET(b.t);
        if (m < 570 || m > 959 || d < ys || d > ye) continue;
        (days[d] || (days[d] = {}))[m] = b.c;
      }
      doc = { spec: "mine3-minute-v1", symbol: sym, year: y, from: ys, to: ye, feed: "sip", timeframe: "1Min", adjustment: "split", rthMinutes: "570..959 (bar start label, ET)", pages: r.pages, fetchedAt: new Date().toISOString(), days };
      writeJsonAtomic(f, doc, { pretty: 0 });
    }
    for (const [d, mm] of Object.entries(doc.days)) if (d >= start && d <= end) out.set(d, new Map(Object.entries(mm).map(([k, v]) => [+k, v])));
  }
  return out;
}

/** price at ET minute T on a session: close of bar T-1, else the last earlier in-session bar. -> { p, stale } or null. */
function priceAt(dayMap, T, sessionOpen, maxStale = 5) {
  if (!dayMap) return null;
  for (let m = T - 1, s = 0; m >= sessionOpen && s <= maxStale; m--, s++) if (dayMap.has(m)) return { p: dayMap.get(m), stale: s };
  return null;
}

module.exports = { calendar, minuteCloses, priceAt, toET, DIR };
