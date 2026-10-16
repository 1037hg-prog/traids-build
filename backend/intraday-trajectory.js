#!/usr/bin/env node
/**
 * TRAIDS — Intraday Trajectory: WHEN do the signals actually work?
 *
 * Settle day gives one end-of-day outcome per trade. This reconstructs what each settled
 * EQUITY trade was doing THROUGH the session — its return vs entry at fixed marks
 * (open, +30m, +1h, +2h, +3h, +4h, close) — from Alpaca 5-min bars, then aggregates into
 * an alpha curve. It also splits eventual WINNERS vs LOSERS to see if winners reveal
 * themselves early, and breaks the curve down by strategy.
 *
 * Answers: does the edge show at the open and fade, or build into the close? Is there a
 * better exit time than the fixed +2R/+1R rules? Analysis only — reads the trade log +
 * intraday bars and reports; changes nothing about the test.
 *
 * NOTE: equities only (Alpaca has no retail crypto/futures intraday). Free IEX is a thin
 * feed — treat the shape as indicative, not gospel.
 *
 * Usage:  node backend/intraday-trajectory.js
 */
const fs = require("fs");
const path = require("path");

function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
  } catch {}
}
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC || /your_|xxx|changeme/i.test(KEY)) { console.error("\n  No real ALPACA keys in backend/.env — can't fetch intraday bars.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };

const etFmtDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const etDay = ts => etFmtDay.format(new Date(ts));
const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
function etParts(iso) { const p = {}; for (const o of etFmt.formatToParts(new Date(iso))) if (o.type !== "literal") p[o.type] = o.value; let hh = parseInt(p.hour); if (hh === 24) hh = 0; return { day: `${p.year}-${p.month}-${p.day}`, minOfDay: hh * 60 + parseInt(p.minute) }; }
const OPEN_MIN = 9 * 60 + 30, CLOSE_MIN = 16 * 60;

async function fetchIntraday(sym, startISO) {
  const out = []; let pageToken = null;
  do {
    const params = new URLSearchParams({ symbols: sym, timeframe: "5Min", start: startISO, limit: "10000", feed: FEED, adjustment: "raw" });
    if (pageToken) params.set("page_token", pageToken);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${params}`, { headers });
    if (!r.ok) break;
    const j = await r.json();
    for (const b of (j.bars?.[sym] || [])) out.push(b);
    pageToken = j.next_page_token || null;
  } while (pageToken);
  return out;
}
function sessionize(bars) {
  const byDay = {};
  for (const b of bars) { const { day, minOfDay } = etParts(b.t); if (minOfDay < OPEN_MIN || minOfDay >= CLOSE_MIN) continue; (byDay[day] ||= []).push({ minOfDay, o: b.o, h: b.h, l: b.l, c: b.c }); }
  for (const d in byDay) byDay[d].sort((a, b) => a.minOfDay - b.minOfDay);
  return byDay;
}

const MARKS = [["open", 0], ["+30m", 30], ["+1h", 60], ["+2h", 120], ["+3h", 180], ["+4h", 240], ["close", 390]];
function priceAt(bars, m) {
  if (!bars || !bars.length) return null;
  if (m === 0) return bars[0].o;
  const target = OPEN_MIN + m; let px = null;
  for (const b of bars) { if (b.minOfDay <= target) px = b.c; else break; }
  return px != null ? px : bars[bars.length - 1].c;
}
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const winPct = a => a.length ? a.filter(v => v > 0).length / a.length * 100 : 0;

(async () => {
  const file = path.join(__dirname, "data", "trade_log.json");
  const log = JSON.parse(fs.readFileSync(file, "utf8"));
  const arr = Array.isArray(log) ? log : (log.trades || []);
  const trades = arr.filter(t => t && t.cls === "Equity" && t.exit != null && t.entry && t.dir != null && t.closedAt);
  if (!trades.length) { console.error("\n  No settled equity trades in the log yet.\n"); process.exit(1); }
  console.log(`\n  TRAIDS — Intraday Trajectory  ·  ${trades.length} settled equity trades  ·  5-min ${FEED.toUpperCase()} bars\n`);

  // fetch each unique symbol once over the needed date range
  const syms = [...new Set(trades.map(t => t.sym.toUpperCase()))].slice(0, 80);
  const minDay = trades.reduce((m, t) => Math.min(m, t.closedAt), Date.now());
  const startISO = new Date(minDay - 2 * 86_400_000).toISOString();
  const sessBySym = {};
  process.stdout.write(`  fetching intraday for ${syms.length} symbols`);
  for (const s of syms) { sessBySym[s] = sessionize(await fetchIntraday(s, startISO)); process.stdout.write("."); }
  console.log("\n");

  // build per-trade trajectory (return vs entry at each mark)
  const traj = [];   // { strat, marks: {label: ret}, closeRet }
  for (const t of trades) {
    const bars = sessBySym[t.sym.toUpperCase()]?.[etDay(t.closedAt)];
    if (!bars || !bars.length) continue;
    const marks = {}; let ok = true;
    for (const [label, m] of MARKS) { const px = priceAt(bars, m); if (px == null) { ok = false; break; } marks[label] = ((px - t.entry) / t.entry) * t.dir * 100; }
    if (!ok) continue;
    traj.push({ strat: t.strategy || "?", marks, closeRet: marks["close"] });
  }
  if (!traj.length) { console.error("  No trades had usable intraday data (feed gap or too old).\n"); process.exit(1); }

  const pad = (s, n) => String(s).padEnd(n);
  const fmt = v => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  const rowFor = (set, label) => {
    const cells = MARKS.map(([m]) => mean(set.map(x => x.marks[m])));
    const wins = MARKS.map(([m]) => winPct(set.map(x => x.marks[m])));
    return { label, cells, wins, n: set.length };
  };

  console.log(`  Reconstructed ${traj.length}/${trades.length} trades.  Avg return vs entry at each mark:\n`);
  console.log("  " + pad("", 16) + MARKS.map(([m]) => pad(m, 9)).join(""));
  console.log("  " + "─".repeat(16 + MARKS.length * 9));
  const all = rowFor(traj, "ALL avg ret");
  console.log("  " + pad(all.label, 16) + all.cells.map(c => pad(fmt(c), 9)).join(""));
  console.log("  " + pad("ALL win%", 16) + all.wins.map(w => pad(w.toFixed(0) + "%", 9)).join(""));

  // winners vs losers (by intraday close outcome)
  const win = traj.filter(x => x.closeRet > 0), los = traj.filter(x => x.closeRet <= 0);
  console.log("");
  for (const [set, lbl] of [[win, `WINNERS (${win.length})`], [los, `LOSERS (${los.length})`]]) {
    if (!set.length) continue;
    const r = rowFor(set, lbl);
    console.log("  " + pad(r.label, 16) + r.cells.map(c => pad(fmt(c), 9)).join(""));
  }

  // by strategy (avg return at +1h / +2h / close)
  const strats = [...new Set(traj.map(x => x.strat))];
  console.log("\n  By strategy (avg ret):   " + pad("", 0) + ["+1h", "+2h", "close"].map(m => pad(m, 9)).join(""));
  console.log("  " + "─".repeat(24 + 27));
  for (const st of strats) {
    const set = traj.filter(x => x.strat === st);
    console.log("  " + pad(st + ` (${set.length})`, 24) + [["+1h"], ["+2h"], ["close"]].map(([m]) => pad(fmt(mean(set.map(x => x.marks[m]))), 9)).join(""));
  }

  // peak-interval insight
  const avgByMark = MARKS.map(([m]) => [m, mean(traj.map(x => x.marks[m]))]);
  const peak = avgByMark.reduce((a, b) => b[1] > a[1] ? b : a);
  console.log(`\n  Peak average return is at ${peak[0]} (${fmt(peak[1])}).  If close < an earlier mark, your trades`);
  console.log(`  give back gains into the afternoon → an earlier exit may beat hold-to-close. Indicative (thin IEX, small n).\n`);
})().catch(e => { console.error("\n  Intraday Trajectory error:", e.message, "\n"); process.exit(1); });
