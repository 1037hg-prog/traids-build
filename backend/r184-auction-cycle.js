#!/usr/bin/env node
/**
 * R184 — TREASURY AUCTION CYCLE (Lou, Yan & Zhang 2013). Registered 2026-09-24 (family SCOUT-0924, best-of-5) BEFORE this file ran;
 * rule, statistic, bar and control are frozen in data/test-registry.json (preregistered[id=R184]); the bar is read from there.
 *
 * RULE (registry text, summarised): 10-year and 30-year note/bond auction dates (originals and reopenings) from the U.S. Treasury
 * fiscaldata API (auctions_query). IEF for 10y auctions, TLT for 30y, Alpaca SIP daily total return. Leg 1: short from the close 5
 * trading days before the auction to the auction-day close; leg 2: long from the auction-day close to the close 5 trading days after.
 * Primary: leg 2 minus leg 1 per auction (the V-shape). Cost: 2 bps per side per leg.
 * STATISTIC: per auction, net (post - pre) return; t over auctions. Each leg alone and the 10y/30y split reported.
 * BAR: t >= ENTRY.bar.tRequired (2.366). CONTROL: auction dates shifted to random non-auction dates in the same month (200 draws);
 * the true dates must beat the 95th percentile.
 *
 * IMPLEMENTATION NOTES (fixed before any outcome was computed):
 *  N1. Auction set: fiscaldata auctions_query rows with auction_date in 2016-01-01..2026-08-31, original_security_term "10-Year" or
 *      "30-Year", inflation_index_security "No" (TIPS are not "notes/bonds" of the nominal cycle) and floating_rate "No". Reopenings
 *      are rows with reopening "Yes" (security_term "9-Year 10-Month", "29-Year 11-Month", ...). A row whose security_term is under
 *      9 years (10y family) or under 29 years (30y family) — e.g. an old 10-year CUSIP reopened as a 3-YEAR note — is a different
 *      auction cycle and is excluded. Duplicate (date, tenor) rows are collapsed to one.
 *  N2. Prices: IEF/TLT Alpaca SIP daily adjustment=all, 2016-01-01..2026-09-15 (Alpaca SIP history begins 2016-01; the first auction, 2016-01-13, still has 5 prior sessions; an auction without 5 sessions either side is excluded and listed),
 *      asserted complete against Alpaca's /v2/calendar. An auction date that is not an equity session is excluded and listed.
 *  N3. pre = C[a]/C[a-5] - 1, post = C[a+5]/C[a] - 1 (a = auction-day session). Leg 1 (short) net = -pre - 4bps; leg 2 (long) net =
 *      post - 4bps; primary = post - pre - 8bps (2 bps per side per leg, both legs charged even though the flip at the auction close
 *      could be netted — the registered cost is per leg).
 *  N4. "t over auctions" = plain one-sample t (mean / (sd_{n-1}/sqrt n)); overlapping windows are a registered known weakness.
 *  N5. Placebo: each auction's date is replaced by a session drawn uniformly from the same calendar month of the same ETF's sessions,
 *      excluding every date in the auction set (either tenor) and any date without 5 sessions either side; the primary t is recomputed;
 *      200 draws, seed 184. "Beat the 95th percentile" = true t strictly greater than sorted[ceil(0.95*200)-1].
 *  N6. Validity controls for sealing: price coverage (N2), the auction set non-empty, the placebo computed. The placebo is a verdict
 *      input, not a seal gate.
 *
 *   node backend/r184-auction-cycle.js   -> data/r184-auction-cycle.json (one read; refuses if R184 is already sealed)
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f);
const DRY = process.argv.includes("--dry");
const ID = "R184", OUT = D("r184-auction-cycle.json");
{ const s = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (s.tests[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); } }
const ENTRY0 = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((t) => t.id === ID);
if (!ENTRY0) { console.error(`${ID} not registered`); process.exit(2); }
const BAR = ENTRY0.bar.tRequired, A_START = "2016-01-01", A_END = "2026-08-31", P_START = "2016-01-01", P_END = "2026-09-15";
const COST_LEG = 0.0004, K = 5, DRAWS = 200, SEED = 184;

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const tstat = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r3 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(3)), r6 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(6));
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const summ = (a) => a.length > 1 ? { n: a.length, meanPct: r3(100 * mean(a)), t: r3(tstat(a)) } : { n: a.length };

async function alpacaCalendar(start, end) {
  require("dotenv").config({ path: path.join(__dirname, ".env") });
  const h = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
  const r = await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${start}&end=${end}`, { headers: h, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`alpaca calendar ${r.status}`);
  return (await r.json()).map((x) => x.date);
}
async function auctions() {
  const fields = "auction_date,security_type,security_term,original_security_term,inflation_index_security,floating_rate,cusip,reopening";
  const rows = []; let page = 1, total = null;
  do {
    const u = `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query?fields=${fields}` +
      `&filter=auction_date:gte:${A_START},auction_date:lte:${A_END},original_security_term:in:(10-Year,30-Year)&sort=auction_date&page[size]=500&page[number]=${page}`;
    const r = await fetch(u, { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(`fiscaldata ${r.status}`);
    const j = await r.json(); rows.push(...j.data); total = j.meta["total-count"]; page++;
    if (page > 20) throw new Error("fiscaldata pagination runaway");
  } while (rows.length < total);
  const years = (term) => { const m = /^(\d+)-Year/.exec(term || ""); return m ? +m[1] : 0; };
  const kept = [], excluded = [];
  for (const x of rows) {
    const tenor = x.original_security_term === "10-Year" ? "10y" : "30y", y = years(x.security_term);
    const why = x.inflation_index_security !== "No" ? "TIPS" : x.floating_rate !== "No" ? "FRN" : (tenor === "10y" ? y < 9 : y < 29) ? `security_term ${x.security_term}` : null;
    if (why) { excluded.push({ date: x.auction_date, tenor, why }); continue; }
    kept.push({ date: x.auction_date, tenor, term: x.security_term, reopening: x.reopening === "Yes", cusip: x.cusip });
  }
  const seen = new Set(), uniq = []; for (const a of kept) { const k = a.date + a.tenor; if (!seen.has(k)) { seen.add(k); uniq.push(a); } }
  return { total, kept: uniq, duplicates: kept.length - uniq.length, excluded };
}

(async () => {
  console.log(`${ID} — Treasury auction cycle · bar t >= ${BAR}`);
  const A = await auctions();
  const exWhy = {}; for (const e of A.excluded) exWhy[e.why.startsWith("security_term") ? e.why : e.why] = (exWhy[e.why] || 0) + 1;
  console.log(`  auctions: ${A.total} API rows -> ${A.kept.length} kept (10y ${A.kept.filter((a) => a.tenor === "10y").length}, 30y ${A.kept.filter((a) => a.tenor === "30y").length}; reopenings ${A.kept.filter((a) => a.reopening).length}); excluded ${JSON.stringify(exWhy)}; dup ${A.duplicates}`);
  if (!A.kept.length) throw new Error("no auctions");

  const cal = await alpacaCalendar(P_START, P_END);
  const { bars } = await fetchBars(["IEF", "TLT"], { start: P_START, end: P_END + "T23:59:59Z", feed: "sip", adjustment: "all", timeframe: "1Day", requireAll: true, quiet: true });
  const S = {}, coverage = {};
  for (const sym of ["IEF", "TLT"]) {
    const x = bars[sym].map((b) => ({ d: b.t.slice(0, 10), c: b.c })).filter((b) => b.d >= P_START && b.d <= P_END);
    const have = new Set(x.map((b) => b.d)), missing = cal.filter((d) => !have.has(d));
    coverage[sym] = { sessions: cal.length, bars: x.length, missing };
    if (missing.length) throw new Error(`${sym} coverage incomplete: ${missing.slice(0, 5)}`);
    S[sym] = { d: x.map((b) => b.d), c: x.map((b) => b.c), idx: new Map(x.map((b, i) => [b.d, i])) };
  }
  console.log(`  prices: IEF ${coverage.IEF.bars}/${coverage.IEF.sessions}, TLT ${coverage.TLT.bars}/${coverage.TLT.sessions} sessions`);

  const symOf = (tenor) => (tenor === "10y" ? "IEF" : "TLT");
  const evalAt = (sym, a) => { const c = S[sym].c; if (a - K < 0 || a + K >= c.length) return null; const pre = c[a] / c[a - K] - 1, post = c[a + K] / c[a] - 1; return { pre, post, leg1: -pre - COST_LEG, leg2: post - COST_LEG, net: post - pre - 2 * COST_LEG, gross: post - pre }; };
  const rows = [], notSession = [];
  for (const a of A.kept) { const sym = symOf(a.tenor), i = S[sym].idx.get(a.date); if (i == null) { notSession.push(a.date); continue; } const e = evalAt(sym, i); if (!e) { notSession.push(a.date + " (edge)"); continue; } rows.push({ ...a, sym, ...e }); }
  const net = rows.map((r) => r.net), tTrue = tstat(net);
  const out10 = rows.filter((r) => r.tenor === "10y"), out30 = rows.filter((r) => r.tenor === "30y");
  const split = (rs) => ({ net: summ(rs.map((r) => r.net)), gross: summ(rs.map((r) => r.gross)), leg1ShortPre: summ(rs.map((r) => r.leg1)), leg2LongPost: summ(rs.map((r) => r.leg2)) });
  const all = split(rows), s10 = split(out10), s30 = split(out30), orig = split(rows.filter((r) => !r.reopening)), reop = split(rows.filter((r) => r.reopening));
  console.log(`  PRIMARY ${rows.length} auctions: net V ${all.net.meanPct}%/auction, t ${all.net.t} (bar ${BAR}) · gross ${all.gross.meanPct}% t ${all.gross.t}`);
  console.log(`  legs: short-pre ${all.leg1ShortPre.meanPct}% t ${all.leg1ShortPre.t} · long-post ${all.leg2LongPost.meanPct}% t ${all.leg2LongPost.t}`);
  console.log(`  10y (IEF) n ${s10.net.n}: net ${s10.net.meanPct}% t ${s10.net.t} · 30y (TLT) n ${s30.net.n}: net ${s30.net.meanPct}% t ${s30.net.t}`);
  if (notSession.length) console.log(`  excluded (auction date not an equity session / edge): ${notSession.join(", ")}`);

  // ---- placebo ----------------------------------------------------------------------------------------------------------------
  const aucDates = new Set(A.kept.map((a) => a.date)), rnd = mulberry(SEED), ts = [];
  const pools = new Map(); for (const r of rows) { const k = r.sym + r.date.slice(0, 7); if (!pools.has(k)) pools.set(k, S[r.sym].d.map((d, i) => [d, i]).filter(([d, i]) => d.slice(0, 7) === r.date.slice(0, 7) && !aucDates.has(d) && i - K >= 0 && i + K < S[r.sym].c.length).map(([, i]) => i)); }
  const emptyPools = [...pools.values()].filter((p) => !p.length).length; if (emptyPools) throw new Error(`placebo: ${emptyPools} empty month pools`);
  for (let k = 0; k < DRAWS; k++) ts.push(tstat(rows.map((r) => { const p = pools.get(r.sym + r.date.slice(0, 7)); return evalAt(r.sym, p[Math.floor(rnd() * p.length)]).net; })));
  const srt = [...ts].sort((x, y) => x - y), p95 = srt[Math.ceil(0.95 * DRAWS) - 1], beat = tTrue > p95;
  console.log(`  PLACEBO (shifted dates, ${DRAWS} draws): p50 ${r3(srt[Math.ceil(0.5 * DRAWS) - 1])} p95 ${r3(p95)} max ${r3(srt[DRAWS - 1])} -> true t ${r3(tTrue)} ${beat ? "BEATS" : "does NOT beat"} p95`);

  const primaryClears = tTrue >= BAR, pass = primaryClears && beat;
  const verdict = `${pass ? "PASS" : "DID NOT PASS"} — auction V (post minus pre) net ${all.net.meanPct}%/auction, t ${r3(tTrue)} vs bar ${BAR} over ${rows.length} auctions; shifted-date placebo p95 ${r3(p95)} (${beat ? "beaten" : "not beaten"}); 10y t ${s10.net.t}, 30y t ${s30.net.t}; short-pre t ${all.leg1ShortPre.t}, long-post t ${all.leg2LongPost.t}`;
  const out = { spec: "r184-auction-cycle-v1", test: ID, asOf: new Date().toISOString(), auctionWindow: [A_START, A_END], bar: BAR, costPerLegRoundTrip: COST_LEG,
    auctionSource: { api: "fiscaldata auctions_query", apiRows: A.total, kept: A.kept.length, duplicatesCollapsed: A.duplicates, excluded: exWhy, notSessionOrEdge: notSession },
    coverage: { IEF: { sessions: coverage.IEF.sessions, bars: coverage.IEF.bars }, TLT: { sessions: coverage.TLT.sessions, bars: coverage.TLT.bars } },
    primary: { n: rows.length, meanNetPct: all.net.meanPct, t: r3(tTrue), clearsBar: primaryClears }, all, tenor10y: s10, tenor30y: s30, originals: orig, reopenings: reop,
    controls: { placebo: { draws: DRAWS, seed: SEED, p50: r3(srt[Math.ceil(0.5 * DRAWS) - 1]), p95: r3(p95), max: r3(srt[DRAWS - 1]), trueT: r3(tTrue), beaten: beat, all: ts.map(r3) } },
    auctions: rows.map((r) => ({ date: r.date, tenor: r.tenor, reopening: r.reopening, sym: r.sym, pre: r6(r.pre), post: r6(r.post), net: r6(r.net) })),
    verdict, pass };
  writeJsonAtomic(DRY ? OUT.replace(/\.json$/, ".dry.json") : OUT, out);
  console.log(`\n  VERDICT: ${verdict}`);
  if (DRY) { console.log("  --dry: harness check only, NOT sealed"); return; }
  const today = todayET();
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests[ID]) throw new Error("sealed concurrently — not overwriting");
  seals.tests[ID] = { sealedOn: today, unit: "auctions", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === ID);
  E.status = `READ ${today} — ${verdict}`; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict }) + "\n");
  console.log(`  sealed ${ID} (${today})`);
})().catch((e) => { console.error(`${ID} FAILED (nothing sealed):`, e.message); process.exit(1); });
