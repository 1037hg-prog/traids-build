#!/usr/bin/env node
/**
 * BOARD REPLAY — 2021-2023 HOLDOUT BUILD for registered test R177 leg (a). Built AFTER R177 was registered (2026-09-24).
 *
 * SAME PIPELINE as the 2024-2026 build: the same roster (board-replay.js boardRoster), the same scan (board-replay-build.js
 * scanSession → lib/board-scan-port.js, the board's functions extracted from src/App.jsx), the same settle rule and caps, --feed sip,
 * --mode forming. Only the DATA FETCH differs, for rate reasons (Alpaca 200 req/min; full-day 5m bars for 1,200 names x 753
 * sessions is ~3.5 h): the scan needs only each name's 09:30 and 09:35 bars, so the whole roster is fetched for 09:30-09:40
 * (o5/), the session is scanned, and full-day 5m bars are fetched only for the CAP-KEPT tickets (f5/), which are then settled
 * by the same settle(). The next session's 09:30 bar comes from its o5/ window. Uncapped signals are written to the cache
 * WITHOUT an R (their full-day path was never fetched) — they are not the board's shown set and are not used by R177.
 *
 *   node backend/board-replay-holdout.js --fetch-daily
 *   node backend/board-replay-holdout.js --fetch-open [--from 2021-01-04 --to 2024-01-02]
 *   node backend/board-replay-holdout.js --build      [--from 2021-01-04 --to 2023-12-29]
 * Output: data/board-replay/replay-2021.jsonl .. replay-2023.jsonl (cap-kept, settled) + replay-meta-holdout-2021-2023.json.
 * Never touches the 2024-2026 files. PAPER ONLY — market data in, research files out.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { boardRoster, CACHE, OUT, hmOf } = require("./board-replay.js");
const B = require("./board-replay-build.js"), P = require("./lib/board-scan-port.js");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DAILY = "daily-sip-2020-2023.json", O5 = path.join(CACHE, "o5"), F5 = path.join(CACHE, "f5");

async function fetchDaily() {
  const { fetchBars } = require("./lib/alpaca-bars.js"), f = path.join(CACHE, DAILY);
  if (fs.existsSync(f)) return console.log(DAILY + " exists");
  const syms = [...new Set(["SPY", ...boardRoster().roster])];
  const { bars, missing } = await fetchBars(syms, { start: "2020-03-01", end: "2024-01-12T23:59:59Z", timeframe: "1Day", feed: "sip", chunkSize: 100, requireAll: false, quiet: true });
  const out = {}; for (const [s, rows] of Object.entries(bars)) out[s] = rows.map((b) => [b.t.slice(0, 10), b.o, b.h, b.l, b.c, b.v]);
  writeJsonAtomic(f, { feed: "sip", adjustment: "all", start: "2020-03-01", end: "2024-01-12", fetchedAt: new Date().toISOString(), missing, bars: out }, { pretty: 0 });
  console.log(`${DAILY}: ${Object.keys(out).length} symbols, ${missing.length} missing`);
}
const sessionsOf = (daily, from, to) => daily.get("SPY").d.filter((d) => d >= from && d <= to);
// rows are always filtered by the ET clock; the request window is the exact ET slot (DST-aware)
async function fetchWindow(syms, day, fromHm, toHm, startZ, endZ, chunkSize) {
  const { fetchBars } = require("./lib/alpaca-bars.js");
  const res = await fetchBars(syms, { start: `${day}T${startZ}`, end: `${day}T${endZ}`, timeframe: "5Min", feed: "sip", chunkSize, requireAll: false, quiet: true });
  const out = {}; for (const [s, rows] of Object.entries(res.bars)) { const k = rows.map((b) => [hmOf(b.t), b.o, b.h, b.l, b.c, b.v]).filter((x) => x[0] >= fromHm && x[0] < toHm); if (k.length) out[s] = k; }
  return out;
}
async function fetchOpen() {
  fs.mkdirSync(O5, { recursive: true });
  const daily = B.loadDaily(DAILY), syms = [...new Set(["SPY", ...boardRoster().roster])];
  const days = sessionsOf(daily, arg("--from", "2021-01-04"), arg("--to", "2024-01-02")); let n = 0; const t0 = Date.now();
  for (const day of days) {
    const f = path.join(O5, day + ".json"); if (fs.existsSync(f)) continue;
    const est = hmOf(`${day}T14:30:00Z`) === "09:30", z0 = est ? "14:30:00Z" : "13:30:00Z", z1 = est ? "14:39:59Z" : "13:39:59Z";   // exactly 09:30-09:40 ET
    const symbols = await fetchWindow(syms, day, "09:30", "09:40", z0, z1, 600);
    writeJsonAtomic(f, { date: day, feed: "alpaca-sip-5Min adjustment=all 09:30-09:40 ET", symbols }, { pretty: 0 });
    if (++n % 25 === 0) console.log(`  o5 ${day}: ${Object.keys(symbols).length} names · ${n} days · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  }
  console.log(`o5 done — ${n} new days`);
}
const readSyms = (f) => (fs.existsSync(f) ? new Map(Object.entries(JSON.parse(fs.readFileSync(f, "utf8")).symbols)) : new Map());

async function build(prefetchOnly = false) {
  fs.mkdirSync(F5, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
  const FROM = arg("--from", "2021-01-04"), TO = arg("--to", "2023-12-29");
  const daily = B.loadDaily(DAILY), cal = daily.get("SPY").d, sessions = sessionsOf(daily, FROM, TO);
  const panel = B.loadPanel(sessions), R = boardRoster(), t0 = Date.now(), perSession = [], started = {};
  const gaps = { noOpenWindow: [], thinOpenWindow: [], keptWithoutFullDay: 0, nextOpenFromDaily: 0 };
  for (let k = 0; k < sessions.length; k++) {
    const day = sessions[k], nextDay = cal[cal.indexOf(day) + 1];
    const open = readSyms(path.join(O5, day + ".json")), nextOpen = readSyms(path.join(O5, nextDay + ".json"));
    if (!open.size) { gaps.noOpenWindow.push(day); perSession.push({ day, skipped: "no 09:30-09:40 bars" }); continue; }
    if (open.size < 600) gaps.thinOpenWindow.push(`${day}:${open.size}`);
    // pass 1: scan on the open window only → which tickets the board would have kept
    const ctx = { roster: R.roster, daily, intra: open, intraNext: nextOpen, mode: "forming", panel };
    const pass1 = B.scanSession(day, nextDay, ctx);
    const keptSyms = [...new Set(pass1.tickets.filter((t) => t.capKept).map((t) => t.s))];
    // full-day 5m for the kept names (cached)
    const ff = path.join(F5, day + ".json");
    let full = readSyms(ff);
    const need = keptSyms.filter((s) => !full.has(s));
    if (need.length) {
      const got = await fetchWindow(need, day, "09:30", "16:00", "13:25:00Z", "21:05:00Z", 100);
      for (const s of need) full.set(s, got[s] || []);
      writeJsonAtomic(ff, { date: day, feed: "alpaca-sip-5Min adjustment=all RTH, cap-kept names only", symbols: Object.fromEntries(full) }, { pretty: 0 });
    }
    if (prefetchOnly) { if (k % 25 === 0) console.log(`  prefetch ${day}: ${keptSyms.length} kept names · ${((Date.now() - t0) / 60000).toFixed(1)} min`); continue; }
    // pass 2: same scan, same settle; kept names now carry their full-day path. Scan inputs (09:30/09:35 bars) are identical.
    // The 09:30/09:35 scan bars ALWAYS come from the o5 fetch (so pass 2 scans exactly what pass 1 scanned). The full-day path supplies
    // only bars >= 09:40. Found 2021-03-05 (GOLD): a separate request can return the same trades at a different adjustment factor
    // (identical volumes, prices x1.116). When the full-day 09:35 close disagrees with o5's, the path is rescaled by o5/full so entry
    // and path share one price scale (counted in gaps.fullDayRescaled); if the full-day fetch has no 09:35 bar to anchor on, the
    // ticket is left unsettled rather than guessed.
    const intra = new Map(open), unanchored = new Set();
    for (const s of keptSyms) {
      const fb = full.get(s) || [], ob = open.get(s) || [];
      if (!fb.length) { gaps.keptWithoutFullDay++; continue; }
      const o35 = ob.find((b) => b[0] === "09:35") || ob.find((b) => b[0] === "09:30"), f35 = o35 && fb.find((b) => b[0] === o35[0]);
      if (!o35 || !f35) { unanchored.add(s); continue; }
      const kf = o35[4] / f35[4], sc = Math.abs(kf - 1) > 1e-6;
      if (sc) gaps.fullDayRescaled = (gaps.fullDayRescaled || 0) + 1;
      intra.set(s, [...ob, ...fb.filter((b) => b[0] >= "09:40").map((b) => (sc ? [b[0], b[1] * kf, b[2] * kf, b[3] * kf, b[4] * kf, b[5]] : b))]);
    }
    const { tickets, stats } = B.scanSession(day, nextDay, { ...ctx, intra });
    const keptSet = new Set(pass1.tickets.filter((t) => t.capKept).map((t) => t.s + "|" + t.dir + "|" + t.st));
    const kt = tickets.filter((t) => t.capKept);
    if (kt.length !== keptSet.size || kt.some((t) => !keptSet.has(t.s + "|" + t.dir + "|" + t.st))) throw new Error(`holdout: pass-2 kept set differs from pass 1 on ${day} — the scan must not depend on the settle path`);
    // scale check against the one-request daily series: the scan-day 09:30 open and the next session's 09:30 open (separate o5 requests)
    // must agree with the daily opens within 5%, or the ticket's entry/exit sit on different adjustment factors → unsettled. 5%, not tighter:
    // at 0.5% the check caught 755 ordinary auction-vs-first-trade differences, and its next-day leg reads a POST-entry quantity, so a
    // tight threshold would select tickets on their exit; real scale breaks are large (GOLD ~x1.12 on every 2021-23 day, two 5% prints).
    for (const t of kt) {
      const db = daily.get(t.s), qi = db ? db.d.indexOf(day) : -1, qn = db ? db.d.indexOf(nextDay) : -1;
      const o30 = (open.get(t.s) || []).find((b) => b[0] === "09:30"), n30 = (nextOpen.get(t.s) || []).find((b) => b[0] === "09:30");
      const off = (a, b) => a > 0 && b > 0 && Math.abs(a / b - 1) > 0.05;
      if ((qi >= 0 && o30 && off(o30[1], db.o[qi])) || (qn >= 0 && n30 && off(n30[1], db.o[qn]))) { t.scaleMismatch = true; gaps.scaleMismatch = (gaps.scaleMismatch || 0) + 1; }
    }
    for (const t of kt) { if (t.scaleMismatch) { t.r = null; t.how = "scale-mismatch"; continue; } if (!(full.get(t.s) || []).length || unanchored.has(t.s)) { t.r = null; t.how = unanchored.has(t.s) ? "no-anchor" : "no-full-day"; gaps.unanchored = (gaps.unanchored || 0) + (unanchored.has(t.s) ? 1 : 0); } if (t.how === "next-open-daily") gaps.nextOpenFromDaily++; }
    const y = day.slice(0, 4), f = path.join(OUT, `replay-${y}.jsonl`), fa = path.join(CACHE, `replay-all-${y}.jsonl`);
    if (!started[y]) { started[y] = true; fs.writeFileSync(f, ""); fs.writeFileSync(fa, ""); }
    fs.appendFileSync(f, kt.map((t) => JSON.stringify(t)).join("\n") + (kt.length ? "\n" : ""));
    const rest = tickets.filter((t) => !t.capKept).map((t) => ({ ...t, r: null, how: "uncapped-not-settled", rRatchet: null, rClose: null, mfe: null, mae: null }));
    fs.appendFileSync(fa, [...kt, ...rest].map((t) => JSON.stringify(t)).join("\n") + (tickets.length ? "\n" : ""));
    perSession.push({ day, ...stats, settled: kt.filter((t) => Number.isFinite(t.r)).length, trendKept: kt.filter((t) => t.st === "Trend").length });
    if (k % 25 === 0) console.log(`  ${day}: scanned ${stats.scanned} · signals ${stats.signals} (kept ${stats.kept}, Trend ${kt.filter((t) => t.st === "Trend").length}) · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  }
  if (prefetchOnly) return console.log(`prefetch done ${FROM}..${TO}`);
  const meta = { spec: B.VERSION + "-holdout-2021-2023", builtAt: new Date().toISOString(), forTest: "R177 leg (a)", scanSourceHash: P.SOURCE_HASH, minConf: P.MIN_CONF, rr: P.RR, feed: "sip", mode: "forming", from: FROM, to: TO,
    roster: { size: R.roster.length, universeBuiltAt: R.universeBuiltAt, survivorship: "today's board roster applied to 2021-2023 — worse than 2024 (names not yet listed/large are absent or early); pitLiquid marks the point-in-time top 1,500 by 60-session median dollar volume (v2 panel)" },
    fetch: "daily SIP 2020-03-01..2024-01-12; 5m SIP 09:30-09:40 for every roster name (o5/), full-day RTH 5m only for cap-kept names (f5/); same scan inputs as the full build",
    settle: "identical to the 2024-2026 build (board-replay-build.js settle). GROSS — no costs in R.",
    gaps: { ...gaps, noOpenWindow: gaps.noOpenWindow.length ? gaps.noOpenWindow : [], thinOpenWindow: gaps.thinOpenWindow },
    sessions: perSession.length, sessionsScanned: perSession.filter((x) => !x.skipped).length, ticketsCapKept: perSession.reduce((s, x) => s + (x.kept || 0), 0), trendKept: perSession.reduce((s, x) => s + (x.trendKept || 0), 0), perSession };
  writeJsonAtomic(path.join(OUT, "replay-meta-holdout-2021-2023.json"), meta);
  console.log(`HOLDOUT build — ${meta.sessionsScanned} sessions · ${meta.ticketsCapKept} cap-kept (${meta.trendKept} Trend) · gaps ${JSON.stringify({ noOpen: gaps.noOpenWindow.length, thin: gaps.thinOpenWindow.length, keptWithoutFullDay: gaps.keptWithoutFullDay, nextOpenFromDaily: gaps.nextOpenFromDaily })} · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

(async () => {
  if (process.argv.includes("--fetch-daily")) return fetchDaily();
  if (process.argv.includes("--fetch-open")) return fetchOpen();
  if (process.argv.includes("--prefetch-full")) return build(true);   // pass 1 + full-day fetch only (parallel-safe per year); writes no outputs
  if (process.argv.includes("--build")) return build();
  console.log("usage: --fetch-daily | --fetch-open | --build");
})().catch((e) => { console.error("board-replay-holdout FAILED:", e.stack || e.message); process.exit(1); });
