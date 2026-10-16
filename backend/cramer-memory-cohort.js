#!/usr/bin/env node
/**
 * #74 — CRAMER'S "CAN'T AFFORD NOT TO" MEMORY FOUR, vs THE WHALE WHO JUST SOLD. Frozen 2026-08-20.
 *
 * SOURCE. Mad Money segment aired 2026-08-17, syndicated 2026-08-20 (operator-pasted):
 * "Sometimes, it really is different... the opportunity is too great, and you can't afford not
 * to take it." Named "indispensable": Seagate (STX), Western Digital (WDC), Micron (MU),
 * Sandisk (SNDK). Stated at MU +669%/yr, STX +200%+ — an explicit buy-high, cycle-is-broken
 * call, made in an article whose own middle section argues the cycle isn't broken.
 *
 * THE NATURAL EXPERIMENT. The same week, Duquesne's Q2 13F (filed 08-14, processed here 08-14)
 * shows Druckenmiller EXITING Micron after the run — and adding Seagate. Two celebrity signals,
 * partially opposed, same assets, same week, one ledger. The MU row is the duel's scoreboard.
 *
 * ═══ PRE-REGISTERED DESIGN (the #69 pattern) ═══
 *   entry     first completed close on/after 2026-08-20 (forming-bar guard <16:10 ET). The
 *             price a viewer acting on the segment could actually get.
 *   horizon   last close of 2027. "It's different this time" is a claim about the CYCLE, so it
 *             gets a window long enough for the cycle to answer — a 3-month read would test
 *             momentum, not the claim.
 *   THE BAR   mean excess over SMH (semis). Memory names beating SPY in an AI-capex boom is
 *             sector beta; only excess over their own complex tests the "indispensable" claim.
 *             SPY carried for context. Four names, one theme = ~1 independent bet; a scorecard,
 *             never a t-stat.
 *   PRIOR     stated now: memory is the most cyclical corner of semis; "this time is different"
 *             at +200-670% trailing has a long and expensive base rate. Equipoise would be
 *             generous; the design gives the claim its fair shot anyway.
 * Runs in the close chain. Nothing here trades.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const { fetchBarsWithBenchmark } = require("./lib/alpaca-bars");

const STATE = D("cramer-memory-cohort.json");
const CREATED = "2026-08-20", ENDPOINT = "2027-12-31";
const PICKS = [
  { sym: "STX", note: "Cramer buy · Druckenmiller ADDED (Q2 13F) — aligned" },
  { sym: "WDC", note: "Cramer buy" },
  { sym: "MU", note: "Cramer 'can't afford not to' · Druckenmiller EXITED (Q2 13F) — THE DUEL ROW" },
  { sym: "SNDK", note: "Cramer buy" },
];
const BENCH = ["SMH", "SPY"];

(async () => {
  const st = (() => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; } })() || {
    spec: "cramer-memory-cohort-2026-08-20", test: 74,
    source: "Mad Money 2026-08-17 segment (operator-pasted 2026-08-20): STX WDC MU SNDK 'indispensable', explicit buy-high cycle-broken call",
    duel: "MU: Cramer must-buy vs Druckenmiller Q2 exit — same asset, same week",
    createdOn: CREATED, endpoint: ENDPOINT, primaryBenchmark: "SMH",
    picks: PICKS, entries: null, sealed: false,
  };
  const syms = PICKS.map(p => p.sym);
  const { bars } = await fetchBarsWithBenchmark("SMH", syms.concat("SPY"), { start: "2026-08-13", end: ENDPOINT, timeframe: "1Day", minBars: 1, quiet: true });
  const dOf = (b) => String(b.t).slice(0, 10);
  const closeOn = (s, d) => { const x = (bars[s] || []).find(b => dOf(b) >= d); return x ? { date: dOf(x), c: x.c } : null; };
  const lastClose = (s) => { const a = bars[s] || []; return a.length ? { date: dOf(a[a.length - 1]), c: a[a.length - 1].c } : null; };

  if (!st.sealed) {
    const etNow = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
    const etToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    const entries = {}; const missing = [];
    for (const s of syms.concat(BENCH)) {
      const e = closeOn(s, CREATED);
      if (!e) { missing.push(s); continue; }
      if (e.date === etToday && etNow < "16:10") { missing.push(`${s} (forming)`); continue; }
      entries[s] = e;
    }
    if (missing.length) { console.log(`CRAMER MEMORY (#74) — waiting on ${missing.join(", ")}. Nothing sealed.`); writeJsonAtomic(STATE, st); return; }
    st.entries = entries; st.sealed = true; st.sealedAt = new Date().toISOString();
    console.log(`CRAMER MEMORY (#74) — SEALED at the ${entries.SMH.date} close. Append-only from here.`);
  }

  const rows = [];
  for (const p of PICKS) {
    const e = st.entries[p.sym], l = lastClose(p.sym);
    if (!e || !l) continue;
    rows.push({ ...p, ret: 100 * (l.c / e.c - 1) });
  }
  if (!rows.length) { writeJsonAtomic(STATE, st); console.log("  nothing priced yet."); return; }
  const smh = 100 * (lastClose("SMH").c / st.entries.SMH.c - 1);
  const spy = 100 * (lastClose("SPY").c / st.entries.SPY.c - 1);
  const cohort = rows.reduce((s, r) => s + r.ret, 0) / rows.length;
  const asOf = lastClose("SMH").date;
  console.log(`CRAMER MEMORY FOUR (#74) — sealed ${st.entries.SMH.date}, graded through ${asOf}`);
  console.log(`  cohort ${cohort >= 0 ? "+" : ""}${cohort.toFixed(2)}% · SMH ${smh >= 0 ? "+" : ""}${smh.toFixed(2)}% → ${cohort >= smh ? "AHEAD" : "BEHIND"} by ${(cohort - smh).toFixed(2)}pp · SPY ${spy >= 0 ? "+" : ""}${spy.toFixed(2)}%`);
  for (const r of rows) console.log(`    ${r.sym.padEnd(5)} ${r.ret >= 0 ? "+" : ""}${r.ret.toFixed(2)}%  (${r.note})`);
  console.log(`  One theme, ~1 independent bet. The MU row is Cramer vs Druckenmiller, settled by the tape.`);
  st.graded = { asOf, cohort: +cohort.toFixed(2), smh: +smh.toFixed(2), spy: +spy.toFixed(2), vsSMH: +(cohort - smh).toFixed(2), rows: rows.map(r => ({ sym: r.sym, ret: +r.ret.toFixed(2) })) };
  writeJsonAtomic(STATE, st);
})();
