#!/usr/bin/env node
/**
 * TRAIDS — Time-Exit Test (PRE-REGISTERED)
 *
 * HYPOTHESIS (stated before looking): exiting a board trade at +2–3 hours into the
 * session earns MORE than holding it to the close. If the "+2–3h peak then fade" is real
 * and exploitable, the per-trade difference (return@exit − return@close) should be > 0
 * with a 95% CI that excludes zero — measured DAY-CLUSTERED (the honest unit, since trades
 * within a session are one correlated draw), over enough independent days.
 *
 * Costs cancel: both "exit at +2h" and "hold to close" are ONE entry + ONE exit, so the
 * paired difference is cost-neutral. This is a within-trade paired test → low variance.
 *
 * PRE-REGISTERED BAR to declare a real effect:
 *   mean(d) > 0  AND  day-clustered 95% CI excludes 0  AND  >= 15 independent trading days.
 *   Default verdict until then: "not established."
 *
 * IMPORTANT: the days currently in the log are the SAME ones that produced the +2–3h
 * observation → they are IN-SAMPLE and do not count as confirmation. Re-run as NEW days
 * accumulate; only the out-of-sample (post-2026-06-25) days are the real test.
 *
 * Usage:  node backend/timing-exit-test.js
 */
const fs = require("fs"), path = require("path");
function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC) { console.error("\n  Missing ALPACA keys.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const PREREG_CUTOFF = "2026-06-25";   // days AFTER this are out-of-sample (the real test)

const etFmtDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const etDay = ts => etFmtDay.format(new Date(ts));
const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
function etParts(iso) { const p = {}; for (const o of etFmt.formatToParts(new Date(iso))) if (o.type !== "literal") p[o.type] = o.value; let h = parseInt(p.hour); if (h === 24) h = 0; return { day: `${p.year}-${p.month}-${p.day}`, min: h * 60 + parseInt(p.minute) }; }
const OPEN = 570, CLOSE = 960;
async function fetchIntraday(sym, startISO) {
  const out = []; let tok = null;
  do { const pr = new URLSearchParams({ symbols: sym, timeframe: "5Min", start: startISO, limit: "10000", feed: FEED, adjustment: "raw" }); if (tok) pr.set("page_token", tok);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${pr}`, { headers }); if (!r.ok) break; const j = await r.json();
    for (const b of (j.bars?.[sym] || [])) out.push(b); tok = j.next_page_token || null; } while (tok);
  return out;
}
function sessionize(bars) { const d = {}; for (const b of bars) { const { day, min } = etParts(b.t); if (min < OPEN || min >= CLOSE) continue; (d[day] ||= []).push({ min, o: b.o, c: b.c }); } for (const k in d) d[k].sort((a, b) => a.min - b.min); return d; }
function priceAt(bars, m) { if (!bars || !bars.length) return null; if (m === 0) return bars[0].o; const t = OPEN + m; let px = null; for (const b of bars) { if (b.min <= t) px = b.c; else break; } return px != null ? px : bars[bars.length - 1].c; }
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

(async () => {
  const log = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "trade_log.json"), "utf8"));
  const arr = Array.isArray(log) ? log : (log.trades || []);
  const trades = arr.filter(t => t && t.cls === "Equity" && t.entry && t.dir != null && t.closedAt);
  if (!trades.length) { console.error("\n  No settled equity trades yet.\n"); process.exit(1); }
  console.log(`\n  TRAIDS — Time-Exit Test (pre-registered: exit@+2-3h vs hold-to-close)  ·  ${trades.length} equity trades\n`);

  const syms = [...new Set(trades.map(t => t.sym.toUpperCase()))].slice(0, 90);
  const start = new Date(trades.reduce((m, t) => Math.min(m, t.closedAt), Date.now()) - 2 * 86400000).toISOString();
  const sess = {};
  process.stdout.write(`  fetching intraday for ${syms.length} symbols`);
  for (const s of syms) { sess[s] = sessionize(await fetchIntraday(s, start)); process.stdout.write("."); }
  console.log("\n");

  const EXITS = [["+2h", 120], ["+2.5h", 150], ["+3h", 180]];
  // per exit: { day -> [d values] }
  const byExit = {}; EXITS.forEach(([l]) => byExit[l] = {});
  const daysSeen = new Set();
  for (const t of trades) {
    const day = etDay(t.closedAt); const bars = sess[t.sym.toUpperCase()]?.[day];
    if (!bars || bars.length < 4) continue;
    const closePx = bars[bars.length - 1].c;
    const retClose = ((closePx - t.entry) / t.entry) * t.dir;
    for (const [lbl, m] of EXITS) { const px = priceAt(bars, m); if (px == null) continue; const retX = ((px - t.entry) / t.entry) * t.dir; (byExit[lbl][day] ||= []).push(retX - retClose); }
    daysSeen.add(day);
  }
  const allDays = [...daysSeen].sort();
  const oosDays = allDays.filter(d => d > PREREG_CUTOFF);
  console.log(`  Days in sample: ${allDays.length} (${allDays[0]}…${allDays[allDays.length-1]})  ·  OUT-OF-SAMPLE (after ${PREREG_CUTOFF}): ${oosDays.length}\n`);

  const pad = (s, n) => String(s).padEnd(n);
  const report = (label, days) => {
    console.log(`  ${label}`);
    console.log("    " + pad("exit", 8) + pad("indep days", 12) + pad("mean(exit-close)", 18) + pad("95% CI (day-clustered)", 26) + "verdict");
    for (const [lbl] of EXITS) {
      const perDay = days.map(d => mean(byExit[lbl][d] || [])).filter(v => v === 0 || v);
      if (perDay.length < 2) { console.log("    " + pad(lbl, 8) + pad(perDay.length, 12) + "too few days"); continue; }
      const m = mean(perDay), se = sd(perDay) / Math.sqrt(perDay.length), lo = m - 1.96 * se, hi = m + 1.96 * se;
      const win = lo > 0;
      console.log("    " + pad(lbl, 8) + pad(perDay.length, 12) + pad((m >= 0 ? "+" : "") + (m * 100).toFixed(3) + "%", 18) + pad(`[${(lo*100).toFixed(3)}%, ${(hi*100).toFixed(3)}%]`, 26) + (win ? "✅ CI excludes 0" : "❌ contains 0"));
    }
    console.log("");
  };
  report("IN-SAMPLE (the days that PRODUCED the observation — do NOT trust):", allDays);
  if (oosDays.length) report("OUT-OF-SAMPLE (the real test):", oosDays);
  else console.log("  OUT-OF-SAMPLE: no post-cutoff days yet. Re-run as new trading days settle — that's the real test.\n");

  const oosEnough = oosDays.length >= 15;
  console.log("  PRE-REGISTERED VERDICT:");
  if (!oosEnough) console.log(`    NOT ESTABLISHED — need >=15 out-of-sample days (have ${oosDays.length}). Positive in-sample means nothing; it's where the idea came from.`);
  console.log("    Costs cancel (paired, same round-trip). A real timing edge = mean(exit-close) > 0 with the OOS CI clearing 0.\n");
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
