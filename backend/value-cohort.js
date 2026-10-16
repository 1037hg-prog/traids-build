#!/usr/bin/env node
/**
 * #69 — DISCLOSED VALUE POSITIONS (Ackman / Burry). Frozen 2026-08-14, graded automatically.
 *
 * Yahoo Finance, 2026-08-14: "Forget Nvidia, Michael Burry and Bill Ackman..." — Ackman disclosed
 * S&P Global (SPGI) in his latest investor letter; Burry was reported "piling into" Adobe (ADBE)
 * earlier in 2026. Both claims verify against our own bars: SPGI sits 21.2% below its 2025 high,
 * ADBE is down 20.6% year to date. Unlike most material that reaches this system, the numbers
 * in the article are accurate.
 *
 * WHY THIS ONE IS WORTH FREEZING. Every prior cohort here tested a MOMENTUM or technical claim,
 * and the 38 dead lab candidates were overwhelmingly the same family. A deep-value thesis is a
 * different effect with its own literature, and this project has never measured it. "Everything
 * failed" does not extend to something never tried, so it gets its own bar instead of inheriting
 * a verdict.
 *
 * ═══ THE THREE BARS ═══
 *   1. SPY          the market. Weakest bar — these names are down 13% and 21% YTD while SPY is
 *                   up 14.2%, so simply closing that gap would clear it without the thesis being
 *                   right about anything specific.
 *   2. IWD / VTV    large-cap VALUE. The decisive bar. If beaten-down value rallies as a style,
 *                   these two ride it; only the excess over value tells us whether ACKMAN AND
 *                   BURRY picked well, versus being early to a style rotation anyone could buy.
 *   3. NVDA         the name the headline says to forget, carried as the opportunity cost the
 *                   article invites and never shows.
 *
 * ═══ WHAT IS PRE-REGISTERED, BEFORE ANY OUTCOME ═══
 *   entry     first completed close on or after this file was written. NOT the disclosure dates,
 *             which are vague ("latest investor letter", "earlier in 2026") and already past —
 *             backdating to them would credit the picks with moves nobody could have acted on.
 *   horizon   the last close of 2027. Neither manager stated one, so it is fixed HERE and never
 *             moved. Chosen long because a value thesis that needs a quarter to work was never a
 *             value thesis; Burry's Adobe entry is already months old.
 *   weight    equal. Neither was ranked above the other.
 *
 * ═══ WHAT THIS CANNOT SHOW ═══
 * TWO positions from two managers is one observation of a style, not a test of stock-picking.
 * No t-statistic will be pretended. It answers one question — did following these disclosed value
 * positions, from the day a retail reader could have acted, beat the alternatives — and nothing
 * about whether copying famous investors works in general.
 *
 * Runs in the close chain. Nothing here trades.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const { fetchBarsWithBenchmark } = require("./lib/alpaca-bars");

const STATE = D("value-cohort.json");
const CREATED = "2026-08-14";
const ENDPOINT = "2027-12-31";
const PICKS = [
  { sym: "SPGI", who: "Ackman", thesis: "near-duopoly with Moody's, >95% of US corporate debt rated; >20% off the 2025 high" },
  { sym: "ADBE", who: "Burry", thesis: "under 11x forward vs a five-year average near 27x; free-tier MAU 50M -> 90M in a year; >$27B recurring revenue" },
];
const BENCH = ["IWD", "SPY", "NVDA"];        // IWD = large-cap value, the bar that matters

(async () => {
  const st = (() => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; } })() || {
    spec: "value-cohort-2026-08-14", test: 69,
    source: "Yahoo Finance 2026-08-14 — Ackman (SPGI, investor letter) and Burry (ADBE, reported earlier in 2026)",
    verified: "SPGI -21.2% from its 2025 high, ADBE -20.6% YTD, both confirmed against our own bars on the freeze date",
    createdOn: CREATED, endpoint: ENDPOINT, primaryBenchmark: "IWD",
    note: "The disclosures predate this freeze and are vague in date. Entry is the first completed close on/after creation — no backdating.",
    picks: PICKS, entries: null, sealed: false,
  };

  const syms = PICKS.map(p => p.sym);
  const { bars } = await fetchBarsWithBenchmark("IWD", syms.concat(BENCH.filter(b => b !== "IWD")), {
    start: "2026-08-07", end: ENDPOINT, timeframe: "1Day", minBars: 1, quiet: true,
  });
  const dOf = (b) => String(b.t).slice(0, 10);
  const closeOn = (s, date) => { const x = (bars[s] || []).find(b => dOf(b) >= date); return x ? { date: dOf(x), c: x.c } : null; };
  const lastClose = (s) => { const a = bars[s] || []; return a.length ? { date: dOf(a[a.length - 1]), c: a[a.length - 1].c } : null; };

  if (!st.sealed) {
    // Forming-bar guard: before 16:10 ET today's bar is not a close, and the seal is append-only.
    const etNow = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
    const etToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    const entries = {}; const missing = [];
    for (const s of syms.concat(BENCH)) {
      const e = closeOn(s, CREATED);
      if (!e) { missing.push(s); continue; }
      if (e.date === etToday && etNow < "16:10") { missing.push(`${s} (today's bar still forming)`); continue; }
      entries[s] = e;
    }
    if (missing.length) {
      console.log(`VALUE COHORT (#69) — waiting on ${missing.join(", ")}. Nothing sealed.`);
      fs.writeFileSync(STATE, JSON.stringify(st, null, 1)); return;
    }
    st.entries = entries; st.sealed = true; st.sealedAt = new Date().toISOString();
    console.log(`VALUE COHORT (#69) — SEALED at the ${entries.IWD.date} close. Append-only from here.`);
  }

  const rows = [];
  for (const p of PICKS) {
    const e = st.entries[p.sym], l = lastClose(p.sym);
    if (!e || !l) continue;
    rows.push({ ...p, entry: e.c, last: l.c, ret: 100 * (l.c / e.c - 1) });
  }
  if (!rows.length) { fs.writeFileSync(STATE, JSON.stringify(st, null, 1)); console.log("  nothing priced yet."); return; }
  const bench = {};
  for (const b of BENCH) { const l = lastClose(b); if (l && st.entries[b]) bench[b] = 100 * (l.c / st.entries[b].c - 1); }
  const cohort = rows.reduce((s, r) => s + r.ret, 0) / rows.length;
  const asOf = lastClose("IWD").date;
  const done = asOf >= ENDPOINT || asOf >= "2027-12-30";

  console.log(`DISCLOSED VALUE COHORT (#69) — sealed ${st.entries.IWD.date}, graded through ${asOf}${done ? "  ★ FINAL" : ""}`);
  console.log(`  cohort (equal-weight ${rows.length})   ${cohort >= 0 ? "+" : ""}${cohort.toFixed(2)}%`);
  for (const r of rows) console.log(`    ${r.sym.padEnd(5)} ${r.ret >= 0 ? "+" : ""}${r.ret.toFixed(2)}%   (${r.who})`);
  console.log(`  IWD — THE BAR (large-cap value)  ${bench.IWD >= 0 ? "+" : ""}${(bench.IWD ?? 0).toFixed(2)}%   → cohort ${cohort >= (bench.IWD ?? 0) ? "AHEAD" : "BEHIND"} by ${(cohort - (bench.IWD ?? 0)).toFixed(2)}pp`);
  console.log(`  SPY — market                     ${bench.SPY >= 0 ? "+" : ""}${(bench.SPY ?? 0).toFixed(2)}%   → ${cohort >= (bench.SPY ?? 0) ? "AHEAD" : "BEHIND"} by ${(cohort - (bench.SPY ?? 0)).toFixed(2)}pp`);
  console.log(`  NVDA — the "forget" trade        ${bench.NVDA >= 0 ? "+" : ""}${(bench.NVDA ?? 0).toFixed(2)}%   → ${cohort >= (bench.NVDA ?? 0) ? "AHEAD" : "BEHIND"} by ${(cohort - (bench.NVDA ?? 0)).toFixed(2)}pp`);
  console.log(`  Beating SPY while value rotates is style beta; IWD is the number that answers the claim.`);
  console.log(`  TWO positions from two managers — one observation of a style. A scorecard, never a t-stat.`);

  st.graded = { asOf, cohort: +cohort.toFixed(2), bench: Object.fromEntries(Object.entries(bench).map(([k, v]) => [k, +v.toFixed(2)])),
    vsIWD: +(cohort - (bench.IWD ?? 0)).toFixed(2), final: done, rows: rows.map(r => ({ sym: r.sym, ret: +r.ret.toFixed(2) })) };
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  console.log(`written: ${path.basename(STATE)}`);
})();
