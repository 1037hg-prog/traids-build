#!/usr/bin/env node
/**
 * CANDLE DIVERGENCE — Schwab-built 5m candles vs Massive exchange aggregates, nightly. (2026-08-21)
 *
 * 2026-10-02 Massive exit: the reference is now the local futures store's exchange 1m bars aggregated to 5m (lib/futures-bars.js; the nightly
 * appender writes the session from Schwab pricehistory before this step runs). Same question: do the wire's QUOTE-sampled candles
 * match exchange bars? Rows from today carry `reference` and `referenceBars`; earlier rows' `massiveBars` are left as written.
 * A session with wire candles but no exchange bars in the store exits 1 (it used to exit 0 with no key — a silent pass).
 *
 * Operator: "then we don't need Massive?" — an empirical question, so it gets a measurement. The
 * live watcher now builds NQ 5m candles from Schwab real-time quotes (trade prints sampled every
 * 3 s) and persists them (data/schwab-candles/NQ-<date>.json). Massive serves the exchange's own
 * aggregates, which the registered ledger is built on. If the two agree to within a tick on
 * closes and within a few ticks on highs/lows, the sampled candles are fit to carry the live feed
 * AND, over time, to stand as an independent history. If they don't, Massive stays.
 *
 * Per session: bars matched by ET time, mean/max abs diff per field, the share of bars whose
 * H or L differ by more than 2 ticks (0.50 NQ pts) — the number that decides whether stop/target
 * touches would be judged the same way on both feeds. Appends one row per session to
 * data/candle-divergence.json. Report-only; changes no source.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const FB = require("./lib/futures-bars.js");   // 2026-10-02 Massive exit: reference bars from the local store
const TICK = 0.25, TOL_TICKS = 2;
const fmtET = (ns) => { const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ns / 1e6)); const g = (t) => p.find((x) => x.type === t).value; return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}` }; };

(async () => {
  const day = process.argv[2] || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const file = D(path.join("schwab-candles", `NQ-${day}.json`));
  if (!fs.existsSync(file)) { console.log(`CANDLE DIVERGENCE — no Schwab candles for ${day} (feed not yet run that session). Nothing measured.`); return; }
  const sc = JSON.parse(fs.readFileSync(file, "utf8"));
  // 2026-09-02: the watcher builds 1-MINUTE candles now (v4 wire). This comparison is against Massive
  // 5-minute aggregates, so 1m Schwab bars are aggregated to 5m here first — matching 1m bars to 5m
  // bars by their shared :00/:05 timestamps would compare one minute against five and call it divergence.
  if (sc.resolution === "1m" && Array.isArray(sc.bars)) {
    const groups = new Map();
    for (const b of sc.bars) { const [h, m] = b.time.split(":").map(Number); const k = h * 60 + Math.floor(m / 5) * 5; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(b); }
    sc.bars = [...groups.entries()].sort((a, b) => a[0] - b[0]).filter(([, g]) => g.length === 5).map(([k, g]) => ({
      time: `${String(Math.floor(k / 60)).padStart(2, "0")}:${String(k % 60).padStart(2, "0")}`, o: g[0].o, h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)), c: g[g.length - 1].c, n: g.reduce((s, x) => s + (x.n || 0), 0),
    }));
    sc.aggregatedFrom = "1m";
  }
  FB.assertCompleteOrExit("NQ", { cutoff: "16:00", date: day, who: "candle divergence (candle-divergence.js)" });   // completeness gate (repair 2026-10-02): exit 3, nothing written, unless the session is closed and held through 15:59 ET
  let ms = [];
  try { ms = FB.aggregateClock(FB.loadRange("NQ", day, day), 5).map((b) => ({ date: b.date, time: b.time, o: b.o, h: b.h, l: b.l, c: b.c })); }
  catch (e) { console.error(`CANDLE DIVERGENCE — futures store unreadable: ${e.message}`); process.exit(1); }
  if (!ms.length) { console.error(`CANDLE DIVERGENCE — the futures store has no NQ bars for ${day} (did backend/futures-bars-append.js run?). Nothing measured.`); process.exit(1); }
  const byTime = new Map(ms.map((b) => [b.time, b]));
  const rows = [];
  for (const s of sc.bars) { const m = byTime.get(s.time); if (m) rows.push({ time: s.time, dO: s.o - m.o, dH: s.h - m.h, dL: s.l - m.l, dC: s.c - m.c }); }
  const abs = (k) => rows.map((x) => Math.abs(x[k]));
  const mean = (a) => a.length ? a.reduce((p, q) => p + q, 0) / a.length : null;
  const stat = (k) => ({ meanAbs: +mean(abs(k)).toFixed(3), maxAbs: Math.max(...abs(k)), withinTick: +(100 * abs(k).filter((d) => d <= TICK + 1e-9).length / rows.length).toFixed(1) });
  const hlBreach = rows.filter((x) => Math.abs(x.dH) > TOL_TICKS * TICK || Math.abs(x.dL) > TOL_TICKS * TICK).length;
  const row = { date: day, ticker: sc.ticker, schwabBars: sc.bars.length, referenceBars: ms.length, reference: "futures-bars store 1m->5m (exchange bars; Schwab pricehistory for sessions after 2026-10-02)", matched: rows.length,
    open: stat("dO"), high: stat("dH"), low: stat("dL"), close: stat("dC"),
    hlBeyond2Ticks: rows.length ? +(100 * hlBreach / rows.length).toFixed(1) : null,
    read: rows.length ? (hlBreach / rows.length <= 0.05 && stat("dC").withinTick >= 95 ? "AGREES (closes within a tick >=95%, H/L beyond 2 ticks <=5%)" : "DIVERGES — sampled candles miss range; exchange bars stay the record") : "no overlap" };
  const st = (() => { try { return JSON.parse(fs.readFileSync(D("candle-divergence.json"), "utf8")); } catch { return { spec: "schwab-vs-massive-5m-v1", registered: "2026-08-21", sessions: [] }; } })();
  st.sessions = st.sessions.filter((x) => x.date !== day).concat([row]).sort((a, b) => a.date.localeCompare(b.date)).slice(-250);
  writeJsonAtomic(D("candle-divergence.json"), st);
  console.log(`CANDLE DIVERGENCE — ${day} ${sc.ticker}: ${rows.length} bars matched (schwab ${sc.bars.length} / exchange ${ms.length})`);
  console.log(`  close: mean |Δ| ${row.close.meanAbs} pts, max ${row.close.maxAbs}, within a tick ${row.close.withinTick}% · high: mean ${row.high.meanAbs}, max ${row.high.maxAbs} · low: mean ${row.low.meanAbs}, max ${row.low.maxAbs}`);
  console.log(`  bars with H or L beyond ${TOL_TICKS} ticks: ${row.hlBeyond2Ticks}% → ${row.read}`);
  console.log(`written: candle-divergence.json`);
})();
