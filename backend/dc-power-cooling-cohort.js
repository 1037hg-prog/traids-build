#!/usr/bin/env node
/**
 * DATA-CENTRE POWER & COOLING COHORT — frozen 2026-09-04, graded automatically. (Test #82.)
 *
 * Reuters, 2026-09-01 (Clare Jim, Hong Kong): "Not just Nvidia: these power and cooling firms are riding the
 * trillion-dollar data centre boom." The claim: the AI build-out is bottlenecked on transformers and cooling, not
 * chips, and the equipment suppliers are taking the orders (HD Hyundai Electric backlog +23% to $8.5B; Jinpan
 * data-centre orders x4; BofA: liquid cooling 70% of new AI installs by 2030; McKinsey: ~$7T data-centre capex by
 * 2030). The article's own caveat is recorded with it: the stocks already ran (Delta +90% YTD, HD Hyundai flat after
 * +100% in 2025, Jinpan -30% and Envicool -20% after +118%/+244%), Delta's chairman expects no margin expansion,
 * and BofA: "not everyone can win."
 *
 * ═══ HONEST NOTES, fixed before any outcome exists ═══
 *
 * 1. THESE ARE NOT THE ARTICLE'S NAMES. Every supplier Reuters names is listed in Taiwan, Shenzhen, Shanghai or
 *    Korea with no US ADR — unreachable from our rails. This cohort holds the US-LISTED ANALOGS in the same three
 *    buckets, chosen by us on 2026-09-04 from the board's own sector map before any price after that date was seen.
 *    So this grades the THEME as we could actually have traded it, not the journalist's picks. Our selection is a
 *    choice, and choices are disclosed, not hidden: the list below is frozen and append-only.
 * 2. THE HORIZON IS OURS. The article states none (McKinsey's 2030 is a capex figure, not a stock call). Endpoint:
 *    the last close of 2026, same convention as #68, registered here and never moved.
 * 3. THE BAR IS XLI, NOT SPY. Nine of eleven names are industrials in the board's factor map; the claim is that
 *    THESE names ride the boom, not that industrials do. SMH is reported beside it because the headline is
 *    "not just Nvidia" — the interesting comparison is whether the plumbing beat the chips. SPY is context.
 * 4. NO BACKDATING. The article published 09-01/02; this file was written 09-04 mid-session. Entry is the first
 *    COMPLETED close on/after 2026-09-04 (forming-bar guard below), never a close that had already printed.
 *
 * WHAT THIS CAN AND CANNOT SHOW. One theme, eleven overlapping industrial names: effectively one sector bet with
 * tilts. Effective n is far below eleven and no t-statistic will be pretended. It is a scorecard of one call.
 * Nothing here trades. Runs in the close chain.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const { fetchBarsWithBenchmark } = require("./lib/alpaca-bars");

const STATE = D("dc-power-cooling-cohort.json");
const CREATED = "2026-09-04";
const ENDPOINT = "2026-12-31";
const PICKS = [
  { sym: "ETN", bucket: "transformers / electrical" },
  { sym: "HUBB", bucket: "transformers / electrical" },
  { sym: "POWL", bucket: "transformers / switchgear" },
  { sym: "GEV", bucket: "generation / grid" },
  { sym: "VRT", bucket: "power + cooling infrastructure" },
  { sym: "NVT", bucket: "power + cooling infrastructure" },
  { sym: "MOD", bucket: "cooling" },
  { sym: "TT", bucket: "cooling" },
  { sym: "JCI", bucket: "cooling" },
  { sym: "PWR", bucket: "build-out" },
  { sym: "FIX", bucket: "build-out" },
];
const BENCH = ["XLI", "SMH", "SPY"];        // XLI is the bar; SMH answers "not just Nvidia"; SPY is context

(async () => {
  const st = (() => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; } })() || {
    spec: "dc-power-cooling-2026-09-01",
    source: "Reuters 2026-09-01/02 (Clare Jim) — 'Not just Nvidia: these power and cooling firms are riding the trillion-dollar data centre boom'; read by the operator 2026-09-04",
    claim: { thesis: "AI build-out bottlenecked on transformers and cooling; equipment suppliers take the orders", articleCaveats: "stocks already ran; margins flat (Delta); 'not everyone can win' (BofA); horizon NONE STATED — endpoint below is ours" },
    articleNames: ["HD Hyundai Electric (KRX)", "Hainan Jinpan 688676.SS", "Delta Electronics 2308.TW", "Asia Vital Components 3017.TW", "Auras Technology 3324.TW", "Shenzhen Envicool 002837.SZ"],
    analogNote: "US-listed analogs chosen by us on 2026-09-04 from the board's sector map; the article's names have no US listing",
    createdOn: CREATED, endpoint: ENDPOINT, primaryBenchmark: "XLI", picks: PICKS, entries: null, sealed: false,
  };

  const syms = PICKS.map(p => p.sym);
  const { bars } = await fetchBarsWithBenchmark("XLI", syms.concat(["SMH", "SPY"]), { start: "2026-08-28", end: ENDPOINT, timeframe: "1Day", minBars: 1, quiet: true });
  const dOf = (b) => String(b.t).slice(0, 10);
  const closeOn = (sym, date) => { const s = (bars[sym] || []).find(b => dOf(b) >= date); return s ? { date: dOf(s), c: s.c } : null; };
  const lastClose = (sym) => { const a = bars[sym] || []; return a.length ? { date: dOf(a[a.length - 1]), c: a[a.length - 1].c } : null; };

  if (!st.sealed) {
    const etNow = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
    const etToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    const entries = {}; const missing = [];
    for (const s of syms.concat(BENCH)) {
      const e = closeOn(s, CREATED);
      if (!e) { missing.push(s); continue; }
      if (e.date === etToday && etNow < "16:10") { missing.push(`${s} (today's bar is still forming)`); continue; }
      entries[s] = e;
    }
    if (missing.length) { console.log(`DC POWER/COOLING COHORT (#82) — entry close (on/after ${CREATED}) not yet available for ${missing.join(", ")}; waiting. Nothing sealed.`); fs.writeFileSync(STATE, JSON.stringify(st, null, 1)); return; }
    st.entries = entries; st.sealed = true; st.sealedAt = new Date().toISOString();
    console.log(`DC POWER/COOLING COHORT — SEALED at the ${entries.XLI.date} close. ${syms.length} names + XLI/SMH/SPY. Append-only from here.`);
  }

  const rows = [];
  for (const p of PICKS) { const e = st.entries[p.sym], l = lastClose(p.sym); if (!e || !l) continue; rows.push({ ...p, entry: e.c, last: l.c, ret: 100 * (l.c / e.c - 1) }); }
  if (!rows.length) { fs.writeFileSync(STATE, JSON.stringify(st, null, 1)); console.log("  no priced names yet."); return; }
  const bench = (s) => 100 * (lastClose(s).c / st.entries[s].c - 1);
  const xli = bench("XLI"), smh = bench("SMH"), spy = bench("SPY");
  const cohort = rows.reduce((s, r) => s + r.ret, 0) / rows.length;
  const asOf = lastClose("XLI").date;
  const done = asOf >= ENDPOINT || asOf >= "2026-12-30";
  console.log(`DC POWER/COOLING COHORT (#82) — sealed ${st.entries.XLI.date}, graded through ${asOf}${done ? "  ★ FINAL" : ""}`);
  console.log(`  cohort (equal-weight ${rows.length})   ${cohort >= 0 ? "+" : ""}${cohort.toFixed(2)}%`);
  console.log(`  XLI — THE BAR                  ${xli >= 0 ? "+" : ""}${xli.toFixed(2)}%   → cohort ${cohort >= xli ? "AHEAD" : "BEHIND"} by ${(cohort - xli).toFixed(2)}pp`);
  console.log(`  SMH — 'not just Nvidia'        ${smh >= 0 ? "+" : ""}${smh.toFixed(2)}%   → cohort ${cohort >= smh ? "AHEAD" : "BEHIND"} by ${(cohort - smh).toFixed(2)}pp`);
  console.log(`  SPY — context                  ${spy >= 0 ? "+" : ""}${spy.toFixed(2)}%`);
  for (const r of rows.sort((a, b) => b.ret - a.ret)) console.log(`    ${r.sym.padEnd(5)} ${r.ret >= 0 ? "+" : ""}${r.ret.toFixed(2)}%   ${r.bucket}`);
  console.log(`  One theme, eleven overlapping industrials: a scorecard, never a t-stat. Our analogs, not the article's names.`);
  st.graded = { asOf, cohort: +cohort.toFixed(2), xli: +xli.toFixed(2), smh: +smh.toFixed(2), spy: +spy.toFixed(2), final: done, vsXLI: +(cohort - xli).toFixed(2), vsSMH: +(cohort - smh).toFixed(2), rows: rows.map(r => ({ sym: r.sym, ret: +r.ret.toFixed(2) })) };
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  console.log(`written: ${path.basename(STATE)}`);
})();
