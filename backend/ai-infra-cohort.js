#!/usr/bin/env node
/**
 * AI INFRASTRUCTURE COHORT — "the diamond in the rough search". Frozen 2026-09-08, graded automatically. (Test #83.)
 *
 * TRIGGER. Operator, 2026-09-08, sharing the MSN/24-7 Wall St piece "Weeks after Nancy Pelosi disclosed a $3 million bet, Bloom Energy
 * is joining the S&P 500 and the stock is soaring": "add this to our diamond in the rough search with anything related to ai,
 * semiconductors, chips, energy, building data centers".
 *
 * THE FACTS AS PUBLISHED (24/7 Wall St, 2026-09-08 06:20 ET; Yahoo Finance syndication). Bloom Energy (NYSE: BE), solid-oxide fuel
 * cells for onsite generation at hyperscale data centres. A periodic transaction report filed 2026-08-21 under Speaker Emerita Pelosi's
 * name (accounts owned by Paul Pelosi) lists purchases on 2026-07-24 (stock $1M-5M band + options $1M-5M) and 2026-07-28 (stock
 * $500K-1M + options $500K-1M): floor $3M, ceiling $12M. S&P Dow Jones announced BE joins the S&P 500 at the September quarterly
 * rebalance (announced 2026-09-04, alongside two other names). Stock: +7% Friday 09-04, ~+8% Monday morning 09-08, +26% on the week,
 * +207% YTD, last $266.53 premarket Tuesday, ~$74.5B market cap. Q2-2026 revenue $1.07B (+165% YoY).
 *
 * ═══ HONEST NOTES, fixed before any outcome exists ═══
 *
 * 1. THIS IS OUR LIST, NOT THE ARTICLE'S. The article names one stock. The operator asked for the THEME: AI compute, semiconductors and
 *    chip equipment, energy for data centres, and the data-centre build-out. The nineteen US-listed names below were chosen by us on
 *    2026-09-08 from the board's sector map before any close after that date was seen. Frozen, append-only. Overlaps are disclosed:
 *    GEV / VRT / ETN / PWR are also in #82 (power & cooling); the chip names overlap #68 (JPM semis). A theme this popular is one bet
 *    with tilts, and this cohort measures whether being in it FROM HERE pays, not whether it paid to date (it did: the run is the caveat).
 * 2. THE NEWS IS ALREADY IN THE PRICE. BE is entered at the first completed close on/after 2026-09-08, i.e. AFTER the +7% and +8% days
 *    and after the index announcement. Index-inclusion drift is a known, mostly pre-announcement effect; this cohort measures what a
 *    reader of the article on Monday evening could have done, which is the only honest thing it can measure.
 * 3. THE BAR IS SMH. The theme's obvious proxy is the chip index; if the broader AI-infrastructure basket cannot beat SMH it added
 *    nothing beyond owning the chips. XLI (industrial build-out) and XLU (power) are reported beside it; SPY is context.
 * 4. HORIZON IS OURS: the last close of 2026, same convention as #68 and #82, registered here and never moved.
 * 5. THE CONGRESSIONAL ANGLE IS GRADED ELSEWHERE. The Pelosi filing is already in the congress PTR feed (backend/congress-ptr.js), where
 *    disclosed trades are graded as a cohort of their own; nothing here double-counts it.
 *
 * WHAT THIS CAN AND CANNOT SHOW. One theme, nineteen correlated names: a scorecard, never a t-stat. Equal weight, no rebalancing,
 * dividends ignored, no cost (a buy-and-hold to year-end; cost is a rounding error at this horizon).
 */
const fs = require("fs"), path = require("path");
const { fetchBarsWithBenchmark } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f);
for (const ln of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }
const STATE = D("ai-infra-cohort.json");
const CREATED = "2026-09-08";
const ENDPOINT = "2026-12-31";
const PICKS = [
  { sym: "BE", bucket: "energy for data centres (fuel cells) — the article's name" },
  { sym: "VST", bucket: "energy for data centres (generation)" }, { sym: "CEG", bucket: "energy for data centres (nuclear generation)" }, { sym: "GEV", bucket: "energy for data centres (turbines / grid) — also #82" }, { sym: "TLN", bucket: "energy for data centres (generation)" },
  { sym: "NVDA", bucket: "AI compute" }, { sym: "AVGO", bucket: "AI compute (networking / custom silicon)" }, { sym: "AMD", bucket: "AI compute" },
  { sym: "TSM", bucket: "semiconductors (foundry, ADR)" }, { sym: "MU", bucket: "semiconductors (memory)" }, { sym: "LRCX", bucket: "chip equipment" }, { sym: "AMAT", bucket: "chip equipment" }, { sym: "KLAC", bucket: "chip equipment" },
  { sym: "VRT", bucket: "data-centre build-out (power + cooling) — also #82" }, { sym: "ETN", bucket: "data-centre build-out (electrical) — also #82" }, { sym: "PWR", bucket: "data-centre build-out (construction) — also #82" }, { sym: "DLR", bucket: "data-centre build-out (REIT)" }, { sym: "EQIX", bucket: "data-centre build-out (REIT)" }, { sym: "SMCI", bucket: "data-centre build-out (servers)" },
];
const BENCH = ["SMH", "XLI", "XLU", "SPY"];   // SMH is the bar

(async () => {
  const st = (() => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; } })() || {
    spec: "ai-infra-cohort-2026-09-08", test: 83,
    source: "24/7 Wall St 2026-09-08 06:20 ET (syndicated MSN / Yahoo Finance): 'Weeks After Nancy Pelosi Disclosed A $3 Million Bet, Bloom Energy Is Joining The S&P 500 And The Stock Is Soaring'; shared by the operator 2026-09-08 evening",
    facts: { ticker: "BE", pelosiFiling: "PTR filed 2026-08-21; purchases 2026-07-24 (stock $1M-5M + options $1M-5M) and 2026-07-28 (stock $500K-1M + options $500K-1M); accounts owned by Paul Pelosi", indexAdd: "S&P 500, September 2026 quarterly rebalance, announced 2026-09-04 with two other names", moves: "+7% Fri 09-04, ~+8% Mon 09-08 morning, +26% on the week, +207% YTD; $266.53 premarket Tue 09-09; ~$74.5B cap", business: "solid-oxide fuel cells for onsite generation at hyperscale data centres; Q2-2026 revenue $1.07B (+165% YoY)" },
    theme: "operator's standing screen: anything related to AI, semiconductors, chips, energy, building data centers",
    listNote: "nineteen US-listed names chosen by us on 2026-09-08 from the board's sector map before any later close was seen; frozen, append-only; overlaps with #82 and #68 disclosed per bucket",
    createdOn: CREATED, endpoint: ENDPOINT, primaryBenchmark: "SMH", picks: PICKS, entries: null, sealed: false,
  };
  const syms = PICKS.map((p) => p.sym);
  const { bars } = await fetchBarsWithBenchmark("SMH", syms.concat(["XLI", "XLU", "SPY"]), { start: "2026-09-01", end: ENDPOINT, timeframe: "1Day", minBars: 1, quiet: true, feed: process.env.ALPACA_FEED || "iex" });
  const dOf = (b) => String(b.t).slice(0, 10);
  const closeOn = (sym, date) => { const s = (bars[sym] || []).find((b) => dOf(b) >= date); return s ? { date: dOf(s), c: s.c } : null; };
  const lastClose = (sym) => { const a = bars[sym] || []; return a.length ? { date: dOf(a[a.length - 1]), c: a[a.length - 1].c } : null; };
  if (!st.sealed) {
    const etNow = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
    const etToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    const entries = {}; const missing = [];
    for (const s of syms.concat(BENCH)) { const e = closeOn(s, CREATED); if (!e) { missing.push(s); continue; } if (e.date === etToday && etNow < "16:10") { missing.push(`${s} (today's bar is still forming)`); continue; } entries[s] = e; }
    if (missing.length) { console.log(`AI INFRA COHORT (#83) — entry close (on/after ${CREATED}) not yet available for ${missing.join(", ")}; waiting. Nothing sealed.`); fs.writeFileSync(STATE, JSON.stringify(st, null, 1)); return; }
    st.entries = entries; st.sealed = true; st.sealedAt = new Date().toISOString();
    console.log(`AI INFRA COHORT — SEALED at the ${entries.SMH.date} close. ${syms.length} names + SMH/XLI/XLU/SPY. Append-only from here.`);
  }
  const rows = [];
  for (const p of PICKS) { const e = st.entries[p.sym], l = lastClose(p.sym); if (!e || !l) continue; rows.push({ ...p, entry: e.c, last: l.c, ret: 100 * (l.c / e.c - 1) }); }
  if (!rows.length) { fs.writeFileSync(STATE, JSON.stringify(st, null, 1)); console.log("  no priced names yet."); return; }
  const bench = (s) => 100 * (lastClose(s).c / st.entries[s].c - 1);
  const smh = bench("SMH"), xli = bench("XLI"), xlu = bench("XLU"), spy = bench("SPY");
  const cohort = rows.reduce((s, r) => s + r.ret, 0) / rows.length;
  const be = rows.find((r) => r.sym === "BE");
  const asOf = lastClose("SMH").date; const done = asOf >= ENDPOINT || asOf >= "2026-12-30";
  console.log(`AI INFRA COHORT (#83) — sealed ${st.entries.SMH.date}, graded through ${asOf}${done ? "  ★ FINAL" : ""}`);
  console.log(`  cohort (equal-weight ${rows.length})  ${cohort >= 0 ? "+" : ""}${cohort.toFixed(2)}%   BE alone ${be ? (be.ret >= 0 ? "+" : "") + be.ret.toFixed(2) + "%" : "n/a"}`);
  console.log(`  SMH — THE BAR                 ${smh >= 0 ? "+" : ""}${smh.toFixed(2)}%   → cohort ${cohort >= smh ? "AHEAD" : "BEHIND"} by ${(cohort - smh).toFixed(2)}pp`);
  console.log(`  XLI ${xli >= 0 ? "+" : ""}${xli.toFixed(2)}%  ·  XLU ${xlu >= 0 ? "+" : ""}${xlu.toFixed(2)}%  ·  SPY ${spy >= 0 ? "+" : ""}${spy.toFixed(2)}%`);
  for (const r of rows.sort((a, b) => b.ret - a.ret)) console.log(`    ${r.sym.padEnd(5)} ${r.ret >= 0 ? "+" : ""}${r.ret.toFixed(2)}%   ${r.bucket}`);
  console.log(`  One theme, nineteen correlated names: a scorecard, never a t-stat. Entered after the news; graded to year-end.`);
  st.graded = { asOf, cohort: +cohort.toFixed(2), be: be ? +be.ret.toFixed(2) : null, smh: +smh.toFixed(2), xli: +xli.toFixed(2), xlu: +xlu.toFixed(2), spy: +spy.toFixed(2), vsSMH: +(cohort - smh).toFixed(2), final: done, rows: rows.map((r) => ({ sym: r.sym, bucket: r.bucket, entry: r.entry, last: r.last, ret: +r.ret.toFixed(2) })) };
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
})().catch((e) => { console.error("ai-infra-cohort failed:", e.message); process.exit(1); });
