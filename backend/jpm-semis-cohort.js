#!/usr/bin/env node
/**
 * JPMORGAN SEMICONDUCTOR COHORT — frozen 2026-08-12, graded automatically. (Test #68.)
 *
 * Benzinga, 2026-08-11 2:35 PM ET (Surbhi Jain): "Nvidia's Chip Boom Is Spreading: JPMorgan Says
 * These 6 Stocks Could Ride It." Six names across three buckets — compute (NVDA, AVGO, AMD,
 * INTC), memory (MU), networking (AVGO again, MRVL) — behind an industry call of $1.68T in 2026
 * sales (+111% y/y) and $2.25T in 2027 (+34%).
 *
 * WHY FREEZE IT. It is a named bank, six named tickers, a dated public article. That is a
 * gradeable object, and grading it costs nothing ongoing: unlike #64 and #65 this needs no daily
 * intake — it seals once and scores itself in the nightly chain until the horizon.
 *
 * ═══ THREE HONEST NOTES, fixed before any outcome exists ═══
 *
 * 1. THE HORIZON IS OURS, BECAUSE THEY DIDN'T STATE ONE. Cramer said "the rest of 2026" and made
 *    himself gradeable; this piece names no horizon, no price targets and no ratings — it is a
 *    theme, and any subsequent move can be claimed as vindication. So the endpoint is registered
 *    HERE, before entry: the last close of 2026, chosen because it is JPMorgan's own forecast
 *    year. Picking a horizon after seeing returns would be the exact trick this project exists
 *    to catch, so it is picked now and never moved.
 *
 * 2. THE BENCHMARK THAT MATTERS IS SMH, NOT SPY. The claim is that these six will "ride" the
 *    chip boom. Beating the S&P while the whole semiconductor sector rips would be beta wearing
 *    a stock-picking costume. SMH (the semi ETF) is the honest bar; SPY is reported alongside as
 *    context. Both are sealed at the same close as the cohort.
 *
 * 3. NO BACKDATING. The article published 2:35 PM ET on 08-11, so the 08-11 close was in
 *    principle actionable — but this cohort was created on 08-12, and entering at a close that
 *    had already printed would credit the picks with a move nobody acted on. Entry is the first
 *    close on or after the day this file was written. Same rule as #64.
 *
 * ═══ WHAT THIS CAN AND CANNOT SHOW ═══
 * ONE call, six overlapping semiconductor names — effectively one sector bet with tilts. The
 * effective n is far below six and no t-statistic will be pretended. Win or lose it grades THIS
 * call; a bank's hit rate needs many frozen calls. AVGO is named in two buckets and is held ONCE,
 * because a stock does not become two positions by being mentioned twice.
 *
 * Runs in the close chain. Nothing here trades.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const { fetchBarsWithBenchmark } = require("./lib/alpaca-bars");

const STATE = D("jpm-semis-cohort.json");
const CREATED = "2026-08-12";              // the day this file was written; entry is the first close on/after it
const ENDPOINT = "2026-12-31";             // JPMorgan's own forecast year — registered before entry, never moved
const PICKS = [
  { sym: "NVDA", bucket: "compute" },
  { sym: "AVGO", bucket: "compute + networking" },   // named twice, held once
  { sym: "AMD", bucket: "compute" },
  { sym: "INTC", bucket: "compute" },
  { sym: "MU", bucket: "memory" },
  { sym: "MRVL", bucket: "networking" },
];
const BENCH = ["SMH", "SPY"];              // SMH is the bar; SPY is context

(async () => {
  const st = (() => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; } })() || {
    spec: "jpm-semis-2026-08-11",
    source: "Benzinga 2026-08-11 14:35 ET — 'Nvidia's Chip Boom Is Spreading: JPMorgan Says These 6 Stocks Could Ride It' (Surbhi Jain)",
    claim: { industry2026: "$1.68T, +111% y/y", industry2027: "$2.25T, +34%", stockHorizon: "NONE STATED — endpoint below is ours" },
    createdOn: CREATED, endpoint: ENDPOINT, primaryBenchmark: "SMH", picks: PICKS, entries: null, sealed: false,
  };

  const syms = PICKS.map(p => p.sym);
  const { bars } = await fetchBarsWithBenchmark("SMH", syms.concat("SPY"), {
    start: "2026-08-05", end: ENDPOINT, timeframe: "1Day", minBars: 1, quiet: true,
  });
  const dOf = (b) => String(b.t).slice(0, 10);
  const closeOn = (sym, date) => { const s = (bars[sym] || []).find(b => dOf(b) >= date); return s ? { date: dOf(s), c: s.c } : null; };
  const lastClose = (sym) => { const a = bars[sym] || []; return a.length ? { date: dOf(a[a.length - 1]), c: a[a.length - 1].c } : null; };

  // ── seal once, at the first COMPLETED close on/after the creation date ─────────────────────
  /**
   * FORMING-BAR GUARD. `closeOn` takes the first bar dated on/after CREATED — which, run
   * mid-session, is TODAY'S INCOMPLETE bar. Sealing on that would lock an entry price that was
   * never a close, permanently, because the seal is append-only. Today's first run happened at
   * 16:16 ET with the market shut, so the entry is genuine; that was timing, not design. Before
   * 16:10 ET the current session is not a close and this refuses to seal on it. (Third instance
   * of this defect class today — signal cards and the sentiment gauge had the same hole.)
   */
  if (!st.sealed) {
    const etNow = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
    const etToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    const entries = {};
    let missing = [];
    for (const s of syms.concat(BENCH)) {
      const e = closeOn(s, CREATED);
      if (!e) { missing.push(s); continue; }
      if (e.date === etToday && etNow < "16:10") { missing.push(`${s} (today's bar is still forming)`); continue; }
      entries[s] = e;
    }
    if (missing.length) {
      console.log(`JPM SEMIS COHORT — entry close (on/after ${CREATED}) not yet available for ${missing.join(", ")}; waiting. Nothing sealed.`);
      fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
      return;
    }
    st.entries = entries; st.sealed = true; st.sealedAt = new Date().toISOString();
    console.log(`JPM SEMIS COHORT — SEALED at the ${entries.SMH.date} close. ${syms.length} names + SMH/SPY. Append-only from here.`);
  }

  // ── grade ──────────────────────────────────────────────────────────────────────────────────
  const rows = [];
  for (const p of PICKS) {
    const e = st.entries[p.sym], l = lastClose(p.sym);
    if (!e || !l) continue;
    rows.push({ ...p, entry: e.c, last: l.c, ret: 100 * (l.c / e.c - 1) });
  }
  if (!rows.length) { fs.writeFileSync(STATE, JSON.stringify(st, null, 1)); console.log("  no priced names yet."); return; }
  const smh = 100 * (lastClose("SMH").c / st.entries.SMH.c - 1);
  const spy = 100 * (lastClose("SPY").c / st.entries.SPY.c - 1);
  const cohort = rows.reduce((s, r) => s + r.ret, 0) / rows.length;
  const asOf = lastClose("SMH").date;
  const done = asOf >= ENDPOINT || asOf >= "2026-12-30";

  console.log(`JPMORGAN SEMIS COHORT (#68) — sealed ${st.entries.SMH.date}, graded through ${asOf}${done ? "  ★ FINAL" : ""}`);
  console.log(`  cohort (equal-weight ${rows.length})   ${cohort >= 0 ? "+" : ""}${cohort.toFixed(2)}%`);
  console.log(`  SMH — THE BAR                  ${smh >= 0 ? "+" : ""}${smh.toFixed(2)}%   → cohort ${cohort >= smh ? "AHEAD" : "BEHIND"} by ${(cohort - smh).toFixed(2)}pp`);
  console.log(`  SPY — context                  ${spy >= 0 ? "+" : ""}${spy.toFixed(2)}%   → cohort ${cohort >= spy ? "AHEAD" : "BEHIND"} by ${(cohort - spy).toFixed(2)}pp`);
  for (const r of rows.sort((a, b) => b.ret - a.ret)) console.log(`    ${r.sym.padEnd(5)} ${r.ret >= 0 ? "+" : ""}${r.ret.toFixed(2)}%   ${r.bucket}`);
  console.log(`  Beating SPY while the sector rips is beta in a costume — SMH is the number that answers the claim.`);
  console.log(`  ONE call, six overlapping semis: ~one sector bet with tilts. A scorecard, never a t-stat.`);

  st.graded = { asOf, cohort: +cohort.toFixed(2), smh: +smh.toFixed(2), spy: +spy.toFixed(2), final: done,
    vsSMH: +(cohort - smh).toFixed(2), rows: rows.map(r => ({ sym: r.sym, ret: +r.ret.toFixed(2) })) };
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  console.log(`written: ${path.basename(STATE)}`);
})();
