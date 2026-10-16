#!/usr/bin/env node
/**
 * BOARD REPLAY (2026-09-24, operator Josh approved items 2+3) — replay the board's OWN equity scanner over 2024-01 .. 2026-09 so the
 * prediction models get ~50x more rows than the live ledger holds, and settle every synthetic ticket under the board's settle rule.
 *
 * PAPER ONLY. Reads market data, writes research files. No orders, no server calls, no registry, never touches the live wire.
 *
 *   node backend/board-replay.js --fetch       daily SIP + daily IEX + 5-minute SIP session bars into the gitignored training cache
 *   node backend/board-replay.js --build       run the scan day by day → data/board-replay/replay-<year>.jsonl (+ replay-meta.json)
 *   node backend/board-replay.js --fidelity    KNOWN-ANSWER CHECK: replay vs the real clean-era signal tickets 2026-07-20..2026-09-23
 *
 * THE SCAN is lib/board-scan-port.js: the board's own functions extracted from src/App.jsx at run time (SOURCE_HASH stamped).
 *
 * UNIVERSE (the board's definition, applied to the past — SURVIVORSHIP DECLARED): the incumbent roster (SP500 array + BOARD_EQ_EXTRA
 * + BOARD_EQ_MID from src/App.jsx) filled to 1,200 from data/universe-expanded.json in its liquidity order, exactly as generate()
 * builds it. That list is today's; names that died before 2026 are absent, names that grew into it are present early. Every row
 * also carries pitLiquid = the name ranked inside the top 1,500 by trailing 60-session median dollar volume in the look-ahead-safe
 * v2 panel (data/anomaly-cache-v2) ON THAT DATE, so studies can drop names that were not yet liquid. Rows on/after a v2 panel
 * truncation date (a +300% splice) are excluded.
 *
 * SCAN-TIME BAR (approximation, declared): the board scans ~09:38 ET and overlays the live price on today's forming daily bar.
 * The replay builds that bar from 5-minute SIP bars: open = 09:30 open, high/low/volume = the 09:30 and 09:35 bars, close = the
 * 09:35 bar's close (i.e. the 09:40 price). Daily history = the Alpaca daily bars of the 300 calendar days before the scan, as the
 * board requests (days: 300). --feed asWas uses IEX daily bars before 2026-09-11 (the board's feed then) and SIP after; --feed sip
 * (default for the history build) uses SIP throughout. adjustment=all as the board.
 *
 * SETTLE RULE (the board's next-open convention, the current one; approximation declared):
 *   entry = scan-time price; stop = entry -/+ max(1.5*ATR14, 0.4% of price); target = entry +/- 2*stopDist.
 *   Entry day: 5-minute bars from 09:40 to 15:55 in order; stop touched → exit at the stop; target touched → exit at the target;
 *   both inside one bar → the STOP (conservative, as board-discipline). Next session: open through the stop → exit at the open
 *   (gap-stop); open through the target → exit at the target (never better); else the 09:30 bar's range is checked the same way,
 *   and an untouched ticket exits at the 09:30 bar's close (the ~09:35 print the board's morning settle reads).
 *   rMult = dir*(exit-entry)/stopDist. GROSS: no spread, commission or slippage is modelled in R.
 *   rRatchet: the same path with OP2b on top (arm at +0.15R to breakeven, then a 0.20R continuous trail) — 5-minute bars cannot order
 *   a bar's own high and low, so the ratchet column is the rougher of the two (the board moved to 1-minute bars for exactly this).
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const CACHE = D(path.join("training", "board-replay"));           // gitignored (backend/data/training/)
const OUT = D("board-replay");
const HIST = D("intraday-history");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const FROM = arg("--from", "2024-01-02"), TO = arg("--to", "2026-09-23");
const SIP_SWITCH = "2026-09-11";                                     // /api/equities/bars default feed IEX → SIP on this date

const etFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
const hmOf = (iso) => etFmt.format(new Date(iso));
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);

function boardRoster() {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "App.jsx"), "utf8");
  const a = src.indexOf("\nconst SP500 = ["), b = src.indexOf("\n];", a);
  const sp = [...src.slice(a, b).matchAll(/symbol:\s*"([A-Z.\-]+)"/g)].map((m) => m[1]);
  const arr = (name) => { const m = new RegExp(`\\nconst ${name} = \\[([\\s\\S]*?)\\];`).exec(src); if (!m) throw new Error("roster: " + name + " not found"); return [...m[1].replace(/\/\/.*$/gm, "").matchAll(/"([A-Z.\-]+)"/g)].map((x) => x[1]); };
  const spSet = new Set(sp), extra = arr("BOARD_EQ_EXTRA"), mid = arr("BOARD_EQ_MID");
  const inc = [...new Set([...sp, ...[...new Set([...extra, ...mid])].filter((s) => !spSet.has(s))])];
  const uni = JSON.parse(fs.readFileSync(D("universe-expanded.json"), "utf8"));
  const seen = new Set(inc), exp = uni.names.map((n) => n.sym).filter((s) => !seen.has(s)).slice(0, Math.max(0, 1200 - inc.length));
  return { incumbents: inc, expansion: exp, roster: [...inc, ...exp], universeBuiltAt: uni.builtAt };
}

// ─────────────────────────────────────────────── FETCH ───────────────────────────────────────────────
async function fetchAll() {
  const { fetchBars } = require("./lib/alpaca-bars.js");
  fs.mkdirSync(path.join(CACHE, "i5"), { recursive: true });
  const R = boardRoster(), syms = [...new Set(["SPY", ...R.roster])];
  console.log(`BOARD REPLAY fetch — roster ${R.roster.length} (${R.incumbents.length} incumbents + ${R.expansion.length} expansion) + SPY`);
  for (const [feed, start, end, file] of [["sip", "2023-03-01", "2026-09-23", "daily-sip.json"], ["iex", "2025-09-01", "2026-09-23", "daily-iex.json"]]) {
    const f = path.join(CACHE, file); if (fs.existsSync(f)) { console.log(`  ${file} exists`); continue; }
    const { bars, missing } = await fetchBars(syms, { start, end: end + "T23:59:59Z", timeframe: "1Day", feed, chunkSize: 100, requireAll: false, quiet: true });
    const out = {}; for (const [s, rows] of Object.entries(bars)) out[s] = rows.map((b) => [b.t.slice(0, 10), b.o, b.h, b.l, b.c, b.v]);
    writeJsonAtomic(f, { feed, adjustment: "all", start, end, fetchedAt: new Date().toISOString(), missing, bars: out }, { pretty: 0 });
    console.log(`  ${file}: ${Object.keys(out).length} symbols (${missing.length} missing)`);
  }
  const spy = JSON.parse(fs.readFileSync(path.join(CACHE, "daily-sip.json"), "utf8")).bars.SPY.map((r) => r[0]);
  const sessions = spy.filter((d) => d >= FROM && d <= TO);
  let n = 0; const t0 = Date.now();
  for (const day of sessions) {
    const f = path.join(CACHE, "i5", day + ".json"); if (fs.existsSync(f)) continue;
    let have = new Set();
    const hf = path.join(HIST, day + ".json");
    if (fs.existsSync(hf)) { try { have = new Set(Object.keys(JSON.parse(fs.readFileSync(hf, "utf8")).symbols)); } catch { have = new Set(); } }
    const need = syms.filter((s) => !have.has(s));
    const res = need.length ? await fetchBars(need, { start: day, end: day, timeframe: "5Min", feed: "sip", chunkSize: 100, requireAll: false, quiet: true }) : { bars: {} };
    const symbols = {};
    for (const [s, rows] of Object.entries(res.bars)) { const k = rows.map((b) => [hmOf(b.t), b.o, b.h, b.l, b.c, b.v]).filter((x) => x[0] >= "09:30" && x[0] < "16:00"); if (k.length) symbols[s] = k; }
    writeJsonAtomic(f, { date: day, feed: "alpaca-sip-5Min adjustment=all RTH", complementsIntradayHistory: have.size > 0, symbols }, { pretty: 0 });
    n++; if (n % 10 === 0) console.log(`  i5 ${day}: ${Object.keys(symbols).length}/${need.length} fetched · ${n} days · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  }
  console.log(`BOARD REPLAY fetch done — ${n} new session files`);
}

module.exports = { boardRoster, CACHE, OUT, HIST, SIP_SWITCH, addDays, hmOf };
if (require.main === module) {
  (async () => {
    if (process.argv.includes("--fetch")) return fetchAll();
    if (process.argv.includes("--build") || process.argv.includes("--fidelity")) return require("./board-replay-build.js").main(process.argv);
    console.log("usage: --fetch | --build | --fidelity");
  })().catch((e) => { console.error("board-replay FAILED:", e.stack || e.message); process.exit(1); });
}
