#!/usr/bin/env node
/**
 * CRAMER THEME COHORT — frozen 2026-08-06, graded automatically. (Test #63 in the registry.)
 *
 * Mad Money, aired 2026-08-06 18:23 ET: five themes, twelve named stocks, and an explicit
 * horizon — "you'll greatly increase your chances of making money for the rest of 2026."
 *
 * That is a fully-specified public forecast: names, date, benchmark-beating claim, endpoint.
 * The honest response is neither "Cramer is noise" nor "good themes" — it is to FREEZE the
 * cohort before any outcome exists and grade it mechanically. Same discipline as the 13F
 * cohorts and R7's scanner shadow: recorded first, graded later, never re-read.
 *
 * DESIGN, fixed before entry:
 *   entry      first daily close on/after 2026-08-07 (the show aired after the 08-06 close;
 *              pretending entry at pre-show prices would grade information nobody could act on)
 *   weighting  equal across the 12 names — he ranked nothing, so neither do we
 *   benchmark  SPY total return over the identical window (primary); RSP secondary, since an
 *              equal-weight large-cap basket's fair comparison is arguably equal-weight
 *   endpoint   last trading close of 2026 — HIS stated horizon, not one we picked
 *
 * ═══ WHAT THIS CAN AND CANNOT SHOW ═══
 * It is ONE forecast event. Twelve overlapping mega/large caps are mostly one bet on the market
 * plus sector tilts — the effective n is far below 12 and no t-statistic will be pretended.
 * Win or lose, this grades THIS call only; a pundit's hit rate needs many frozen calls. The
 * value is the same as the Kalshi and 13F work: replacing a recurring argument with a number.
 *
 * Runs in the close chain: freezes entry automatically when the 08-07 close exists, then
 * re-grades daily. Nothing here trades.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const { fetchBarsWithBenchmark } = require("./lib/alpaca-bars");

const STATE = D("cramer-cohort-2026-08-06.json");
const ENTRY_DATE = "2026-08-07";                      // first session after the show
const ENDPOINT = "2026-12-31";
const PICKS = [
  { sym: "COF", theme: "resilient consumer" }, { sym: "AXP", theme: "resilient consumer" },
  { sym: "RL", theme: "resilient consumer" }, { sym: "WSM", theme: "resilient consumer" },
  { sym: "LRCX", theme: "AI infra (semicap)" }, { sym: "KLAC", theme: "AI infra (semicap)" },
  { sym: "AMAT", theme: "AI infra (semicap)" },
  { sym: "CRWD", theme: "cybersecurity" }, { sym: "PANW", theme: "cybersecurity" },
  { sym: "GS", theme: "M&A pickup" }, { sym: "MS", theme: "M&A pickup" },
  { sym: "LLY", theme: "healthcare diversification" }, { sym: "JNJ", theme: "healthcare diversification" },
];
// 13 tickers across 5 themes (he named 13, "12" in the article deck miscounts its own list —
// counted from the text, not the headline).

(async () => {
  const st = (() => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; } })() || {
    spec: "cramer-2026-08-06", aired: "2026-08-06T18:23-04:00", entryDate: ENTRY_DATE, endpoint: ENDPOINT,
    picks: PICKS, entries: null, sealed: false,
  };

  const syms = PICKS.map(p => p.sym);
  const { bars } = await fetchBarsWithBenchmark("SPY", syms.concat("RSP"), {
    start: "2026-08-01", end: ENDPOINT, timeframe: "1Day", minBars: 1, quiet: true,
  });
  const closeOn = (sym, date) => {
    const s = (bars[sym] || []).find(b => String(b.t).slice(0, 10) >= date);
    return s ? { date: String(s.t).slice(0, 10), c: s.c } : null;
  };
  const lastClose = (sym) => { const a = bars[sym] || []; return a.length ? { date: String(a[a.length - 1].t).slice(0, 10), c: a[a.length - 1].c } : null; };

  // ── seal entries once, at the first close on/after ENTRY_DATE ─────────────────────────────
  if (!st.sealed) {
    const entries = {};
    let missing = 0;
    for (const s of syms.concat(["SPY", "RSP"])) {
      const e = closeOn(s, ENTRY_DATE);
      if (!e) { missing++; continue; }
      entries[s] = e;
    }
    if (missing || !entries.SPY) {
      console.log(`CRAMER COHORT — entry close (${ENTRY_DATE}) not yet available for ${missing} name(s); waiting. Nothing sealed.`);
      fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
      return;
    }
    st.entries = entries;
    st.sealed = true;
    st.sealedAt = new Date().toISOString();
    console.log(`CRAMER COHORT — SEALED at the ${entries.SPY.date} close. ${syms.length} names + SPY/RSP. This file is now append-only.`);
  }

  // ── grade against the sealed entries ──────────────────────────────────────────────────────
  const rows = [];
  for (const p of PICKS) {
    const e = st.entries[p.sym], l = lastClose(p.sym);
    if (!e || !l) continue;
    rows.push({ ...p, entry: e.c, last: l.c, ret: 100 * (l.c / e.c - 1) });
  }
  const spy = 100 * (lastClose("SPY").c / st.entries.SPY.c - 1);
  const rsp = st.entries.RSP ? 100 * (lastClose("RSP").c / st.entries.RSP.c - 1) : null;
  const cohort = rows.reduce((s, r) => s + r.ret, 0) / rows.length;
  const asOf = lastClose("SPY").date;
  const done = asOf >= ENDPOINT.slice(0, 10) || asOf >= "2026-12-30";

  console.log(`CRAMER THEME COHORT — sealed ${st.entries.SPY.date}, graded through ${asOf}${done ? "  ★ FINAL (his stated horizon reached)" : ""}`);
  console.log(`  cohort (equal-weight ${rows.length})  ${cohort >= 0 ? "+" : ""}${cohort.toFixed(2)}%`);
  console.log(`  SPY same window               ${spy >= 0 ? "+" : ""}${spy.toFixed(2)}%   → cohort ${cohort >= spy ? "AHEAD" : "BEHIND"} by ${(cohort - spy).toFixed(2)}pp`);
  if (rsp != null) console.log(`  RSP (equal-weight bench)      ${rsp >= 0 ? "+" : ""}${rsp.toFixed(2)}%   → cohort ${cohort >= rsp ? "AHEAD" : "BEHIND"} by ${(cohort - rsp).toFixed(2)}pp`);
  const byTheme = {};
  for (const r of rows) (byTheme[r.theme] ||= []).push(r.ret);
  for (const t in byTheme) console.log(`    ${t.padEnd(28)} ${(byTheme[t].reduce((s, x) => s + x, 0) / byTheme[t].length).toFixed(2)}%  (${byTheme[t].length})`);
  console.log(`  ONE forecast event, ~1 effective bet on the market plus tilts — a scorecard, never a t-stat.`);

  st.graded = { asOf, cohort: +cohort.toFixed(2), spy: +spy.toFixed(2), rsp: rsp == null ? null : +rsp.toFixed(2), final: done, rows: rows.map(r => ({ sym: r.sym, ret: +r.ret.toFixed(2) })) };
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  console.log(`written: ${path.basename(STATE)}`);
})();
