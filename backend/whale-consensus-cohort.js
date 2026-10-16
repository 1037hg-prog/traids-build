#!/usr/bin/env node
/**
 * #70 — 13F CONSENSUS ADDS (Q2 2026). Frozen 2026-08-19, graded automatically.
 *
 * SOURCE. Q2 2026 13F-HR filings hitting EDGAR 2026-08-13/14, surfaced via an aggregator the
 * operator pasted on 2026-08-19. The aggregator itself was FORENSICALLY BROKEN (Appaloosa shown
 * at $765B — 40x the real fund; "+14,804,905%" adds; put options counted as buyers; Q4-2025 and
 * Q1-2026 filings mixed into "this quarter"), so the signal was extracted under written rules
 * rather than taken as displayed. This cohort tests whether anything real survives the cleanup.
 *
 * RELATION TO #38. best-ideas-13f tests CONCENTRATION (each manager's top-3, any name). This
 * tests CONSENSUS (many managers adding the same name in the same quarter). Different mechanism,
 * different literature; #38's forward leg is +0.90pp/qtr on one closed cohort.
 *
 * ═══ EXTRACTION RULES, FIXED BEFORE ANY OUTCOME ═══
 *   - Filings dated 2026-08-13/14 only (Q2 2026 positions as of 6/30 — already ~50 days stale
 *     at freeze; that staleness is part of what is being tested).
 *   - Long common stock only. Puts/calls are not conviction.
 *   - EXCLUDED: Citadel and Point72 (market makers; 13F is hedging inventory), Appaloosa (the
 *     aggregator's block for it was corrupted beyond use).
 *   - An ADD = NEW BUY or position increase >= +25%. A SELL = decrease >= -25%.
 *   - QUALIFYING NAME: >= 2 fresh adds AND adds >= 2x fresh sells. (GOOGL fails at 4 adds vs
 *     3 sells — genuinely contested names are the noise this rule exists to drop.)
 *
 * ═══ THE COHORT (12) ═══
 *   INTC (Coatue new, Tiger +160%, Bridgewater new)         SMH
 *   AMD  (Coatue new, Tiger new, Duquesne new / RenTech)    SMH
 *   UNP  (Third Point +250%, RenTech +948%)                 XLI
 *   CVX  (RenTech, Bridgewater)                             XLE
 *   COP  (RenTech new, Bridgewater new)                     XLE
 *   EOG  (RenTech, Bridgewater)                             XLE
 *   SHEL (RenTech new, Bridgewater +389%)                   XLE
 *   NFLX (RenTech, Fundsmith new)                           XLC
 *   RTX  (RenTech new, Bridgewater new)                     XLI
 *   REGN (RenTech +122%, Bridgewater +126%)                 XLV
 *   TMUS (RenTech +115%, Bridgewater +75%)                  XLC
 *   SQ   (Third Point new, Bridgewater +194%)               XLF
 *
 * ═══ PRE-REGISTERED DESIGN ═══
 *   entry      first completed close on/after 2026-08-19 (forming-bar guard: never today's bar
 *              before 16:10 ET). Not the filing date, not 6/30 — the day a reader of this page
 *              could actually have acted.
 *   horizon    last close of 2026. 13F theses refresh quarterly; this reads one full cycle plus
 *              the Q3 filing window without pretending to be a long-term study.
 *   THE BAR    mean excess of each name over ITS OWN SECTOR ETF. Half this cohort is an energy
 *              rotation — beating SPY while XLE rallies is style beta anyone could buy. SPY and
 *              raw returns are carried for context, never for the verdict.
 *   weight     equal. The rule set ranked nothing.
 *
 * 12 names, heavily clustered (4 energy, 2 semis, 2 comm) — call it ~6 independent bets. A
 * scorecard with a stated bar, not a t-test. Runs in the close chain. Nothing here trades.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const { fetchBarsWithBenchmark } = require("./lib/alpaca-bars");

const STATE = D("whale-consensus-cohort.json");
const CREATED = "2026-08-19";
const ENDPOINT = "2026-12-31";
const PICKS = [
  { sym: "INTC", etf: "SMH", who: "Coatue new · Tiger +160% · Bridgewater new" },
  { sym: "AMD", etf: "SMH", who: "Coatue new · Tiger new · Duquesne new" },
  { sym: "UNP", etf: "XLI", who: "Third Point +250% · RenTech +948%" },
  { sym: "CVX", etf: "XLE", who: "RenTech +42% · Bridgewater add" },
  { sym: "COP", etf: "XLE", who: "RenTech new · Bridgewater new" },
  { sym: "EOG", etf: "XLE", who: "RenTech +754% · Bridgewater add" },
  { sym: "SHEL", etf: "XLE", who: "RenTech new · Bridgewater +389%" },
  { sym: "NFLX", etf: "XLC", who: "RenTech add · Fundsmith new" },
  { sym: "RTX", etf: "XLI", who: "RenTech new · Bridgewater new" },
  { sym: "REGN", etf: "XLV", who: "RenTech +122% · Bridgewater +126%" },
  { sym: "TMUS", etf: "XLC", who: "RenTech +115% · Bridgewater +75%" },
  { sym: "XYZ", etf: "XLF", who: "Third Point new · Bridgewater +194% (filed as SQ — Block renamed to XYZ in 2025; aggregator symbology was stale)" },
];
const ETFS = [...new Set(PICKS.map(p => p.etf))].concat("SPY");

(async () => {
  const st = (() => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; } })() || {
    spec: "whale-consensus-cohort-2026-08-19", test: 70,
    source: "Q2 2026 13F-HR filings (EDGAR 2026-08-13/14) via operator-pasted aggregator, extracted under the written rules in this file's header",
    rule: ">=2 fresh long adds (NEW or +25%) AND adds >= 2x fresh sells; Citadel/Point72/Appaloosa excluded",
    createdOn: CREATED, endpoint: ENDPOINT, primaryBenchmark: "own sector ETF (SMH/XLE/XLI/XLC/XLV/XLF)",
    picks: PICKS, entries: null, sealed: false,
  };

  const syms = PICKS.map(p => p.sym);
  const { bars } = await fetchBarsWithBenchmark("SPY", syms.concat(ETFS.filter(e => e !== "SPY")), {
    start: "2026-08-12", end: ENDPOINT, timeframe: "1Day", minBars: 1, quiet: true,
  });
  const dOf = (b) => String(b.t).slice(0, 10);
  const closeOn = (s, date) => { const x = (bars[s] || []).find(b => dOf(b) >= date); return x ? { date: dOf(x), c: x.c } : null; };
  const lastClose = (s) => { const a = bars[s] || []; return a.length ? { date: dOf(a[a.length - 1]), c: a[a.length - 1].c } : null; };

  if (!st.sealed) {
    const etNow = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
    const etToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    const entries = {}; const missing = [];
    for (const s of syms.concat(ETFS)) {
      const e = closeOn(s, CREATED);
      if (!e) { missing.push(s); continue; }
      if (e.date === etToday && etNow < "16:10") { missing.push(`${s} (today's bar still forming)`); continue; }
      entries[s] = e;
    }
    if (missing.length) {
      console.log(`WHALE CONSENSUS (#70) — waiting on ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ` +${missing.length - 4}` : ""}. Nothing sealed.`);
      fs.writeFileSync(STATE, JSON.stringify(st, null, 1)); return;
    }
    st.entries = entries; st.sealed = true; st.sealedAt = new Date().toISOString();
    console.log(`WHALE CONSENSUS (#70) — SEALED at the ${entries.SPY.date} close. Append-only from here.`);
  }

  const rows = [];
  for (const p of PICKS) {
    const e = st.entries[p.sym], l = lastClose(p.sym);
    const eE = st.entries[p.etf], lE = lastClose(p.etf);
    if (!e || !l || !eE || !lE) continue;
    const ret = 100 * (l.c / e.c - 1), sec = 100 * (lE.c / eE.c - 1);
    rows.push({ ...p, ret, sec, ex: ret - sec });
  }
  if (!rows.length) { fs.writeFileSync(STATE, JSON.stringify(st, null, 1)); console.log("  nothing priced yet."); return; }
  const spy = 100 * (lastClose("SPY").c / st.entries.SPY.c - 1);
  const cohort = rows.reduce((s, r) => s + r.ret, 0) / rows.length;
  const exSec = rows.reduce((s, r) => s + r.ex, 0) / rows.length;
  const asOf = lastClose("SPY").date;
  const done = asOf >= "2026-12-30";

  console.log(`WHALE CONSENSUS ADDS (#70) — sealed ${st.entries.SPY.date}, graded through ${asOf}${done ? "  ★ FINAL" : ""}`);
  console.log(`  cohort (equal-weight ${rows.length})  ${cohort >= 0 ? "+" : ""}${cohort.toFixed(2)}%  ·  vs SPY ${(cohort - spy) >= 0 ? "+" : ""}${(cohort - spy).toFixed(2)}pp`);
  console.log(`  THE BAR — mean excess over own sector ETF: ${exSec >= 0 ? "+" : ""}${exSec.toFixed(2)}pp   (${rows.filter(r => r.ex > 0).length}/${rows.length} names ahead of their sector)`);
  for (const r of rows.sort((a, b) => b.ex - a.ex))
    console.log(`    ${r.sym.padEnd(5)} ${r.ret >= 0 ? "+" : ""}${r.ret.toFixed(2)}%  vs ${r.etf} ${r.ex >= 0 ? "+" : ""}${r.ex.toFixed(2)}pp   (${r.who})`);
  console.log(`  4 energy + 2 semis + 2 comm in 12 names — ~6 independent bets. Sector excess is the verdict; SPY is decoration.`);

  st.graded = { asOf, cohort: +cohort.toFixed(2), spy: +spy.toFixed(2), exSector: +exSec.toFixed(2),
    ahead: rows.filter(r => r.ex > 0).length, of: rows.length, final: done,
    rows: rows.map(r => ({ sym: r.sym, ret: +r.ret.toFixed(2), ex: +r.ex.toFixed(2) })) };
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  console.log(`written: ${path.basename(STATE)}`);
})();
