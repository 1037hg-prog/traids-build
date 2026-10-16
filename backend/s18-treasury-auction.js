#!/usr/bin/env node
/**
 * S18 — TREASURY AUCTION SUPPLY: AN ISSUER THAT NEVER WITHDRAWS OVER PRICE, AND DEALERS
 * OBLIGED TO BID. A structural candidate from the alpha-hunt queue (proposed 2026-09-03, bar
 * frozen the same day, backend/data/alpha-hunt-queue.json, proposedId "S18"), taken to a
 * verdict 2026-09-04. Modelled on backend/s9-inkind-distribution.js and backend/s12-vest-supply.js,
 * which took S9 and S12 to verdicts under this same register.
 *
 * THE COUNTERPARTY, which is why this is not a chart pattern wearing a story:
 *   The US Treasury sells a fixed quantity on a published calendar regardless of that day's price
 *   — it is funding a deficit, not optimising the sale. Primary dealers are OBLIGED to bid to keep
 *   their designation, then must warehouse and hedge whatever they are left holding; they cheapen
 *   the sector into the auction to make room and let it richen back once distributed.
 * WHAT WOULD STOP IT: post-2008 issuance is so large and near-continuous that almost every session
 *   sits near SOME auction (see the CONTAMINATION check below, which operationalises exactly this);
 *   and the effect is published (Lou, Yan & Zhang 2013), i.e. dated calendar flow that gets
 *   arbitraged away once written down.
 *
 * THE EVENT: a scheduled Treasury COUPON auction — 2y, 5y, 7y or 10y NOTE, or 30y BOND.
 * ONE arm only, pre-declared: the POST-auction reversion, entry at the auction-day close, exit at
 * auction+3 close. The into-the-auction arm is NOT tested — testing both would be a two-shot at
 * one mechanism, and the queue entry explicitly forbids it.
 *
 * ═══ THE MATURITY -> ETF MAPPING, STATED BEFORE ANY PRICE OR RETURN WAS COMPUTED ═══
 *   2-Year, 5-Year notes  -> IEI  (iShares 3-7 Year Treasury Bond ETF)
 *   7-Year, 10-Year notes -> IEF  (iShares 7-10 Year Treasury Bond ETF)
 *   30-Year bond          -> TLT  (iShares 20+ Year Treasury Bond ETF)
 * This book cannot trade the cash bond, so the queue names exactly these three ETFs as the traded
 * instrument. Only three funds exist for five maturities, so the 2-year note (duration ~1.9y) is
 * mapped to IEI (average duration ~4.5y) as the SHORTEST-duration fund in the named set — the best
 * available match, not a true match. This is a disclosed weakness, not a discovered one: a 2-year
 * auction's price impact on IEI is diluted by four to five years of unrelated duration that the
 * 2-year note itself does not carry. 7-year note auctions are assigned to IEF (the "7-10y" fund)
 * rather than IEI (the "3-7y" fund) because IEF's name states the boundary explicitly; this is a
 * boundary call, stated once, not revisited after a result was seen.
 *
 * ═══ THE BAR, FIXED 2026-09-03, COPIED VERBATIM, NOT RENEGOTIATED HERE ═══
 *   "Sample condition: >= 300 auctions across >= 8 calendar years and >= 4 maturities. Direction
 *    pre-declared POSITIVE. Clears ONLY if mean auction-close to +3d return in excess of a
 *    duration-matched buy-and-hold of the same ETF is positive at auction-day-clustered t >= 3.5,
 *    net of the board's standing ETF round-trip cost, AND carries the same sign in both halves of
 *    a chronological split. Mandatory PLACEBO: the identical entry rule on non-auction dates
 *    matched by month and maturity must fail to reach t >= 2.0."
 * No multiplicity correction is layered on top of 3.5: this is ONE pre-declared arm, ONE mapping,
 * ONE holding period, chosen before any evidence was read — not a search across variants, so
 * lib/null-bar.js has nothing to correct (variants = 1 reduces to the ordinary threshold, which is
 * exactly the immutable 3.5 already in force).
 *
 * ═══ "DURATION-MATCHED BUY-AND-HOLD ... MEASURED ON NON-AUCTION WINDOWS" — HOW THIS IS BUILT ═══
 * For each ETF, a session index i is EXCLUDED from the benchmark pool if i, or i+3, falls within
 * +/-3 sessions of ANY qualifying auction mapped to that ETF (the event window itself, plus a
 * symmetric pre-auction buffer, since the counterparty story is explicitly that dealers cheapen
 * the sector INTO the auction too). BENCHMARK[etf] is the mean 3-session forward return over every
 * surviving (non-excluded) start index — the ETF's own typical 3-day drift, away from auction
 * effects, which is what "duration-matched buy-and-hold of the SAME ETF... on non-auction windows"
 * literally specifies. A market-index benchmark (SPY, as S9/S12 use) is deliberately NOT used here
 * — comparing a rates ETF to an equity index would conflate the auction effect with rates beta.
 *
 * ═══ THE MANDATORY PLACEBO — "NON-AUCTION DATES MATCHED BY MONTH AND MATURITY" ═══
 * For every kept real event, a pseudo-event is built on the SAME ETF, exactly 365 days earlier
 * (matches month; matches maturity because it reuses the event's own ETF/maturity leg) — the same
 * shift convention S9 and S12 already use for their placebos. The identical rule is applied: that
 * date's close is "entry", +3 sessions later is "exit", excess is computed against the SAME
 * BENCHMARK[etf]. CONTAMINATION is checked directly and reported, not assumed: for each placebo
 * date, this file checks whether that date itself falls inside the exclusion window of a REAL
 * auction on the same ETF. The queue's own pre-declared most-likely failure is that this rate is
 * high enough that the placebo cannot be read as clean — if so the verdict is DESIGN-CANNOT-
 * SEPARATE, not DEAD BY PLACEBO and not CLEARS, exactly as the queue entry specifies.
 *
 * ═══ COST SIGN ═══
 * The arm is pre-declared POSITIVE — a LONG. Gross profit on a long is (ret - benchmark); cost is
 * paid on top of that and must move the number TOWARD zero, i.e. SUBTRACT from the gross excess:
 *   excessNet = excessGross - COST.roundTripPct
 * This is the opposite correction from S9/S12 (both NEGATIVE/short arms, where cost is added back
 * toward zero — see backend/s9-inkind-distribution.js:174-196 for the short-side derivation this
 * file's long-side sign is checked against). Getting this backwards is exactly the defect that
 * manufactured false CLEARS verdicts in S12/S13 before the 2026-09-02 correction sweep.
 * COST comes from cost-model.json's Equity class (0.2149% round trip) because no separate ETF
 * class exists in the shop's cost model and IEI/IEF/TLT execute as ordinary $0-commission equity
 * trades on Schwab. This is very likely an OVERSTATEMENT for three of the most liquid bond ETFs on
 * the tape (their true spreads are almost certainly tighter than the blended equity book this
 * number was measured on) — which works AGAINST the pre-declared positive direction. It cannot
 * manufacture a pass; it can only make a real edge look smaller than it is.
 *
 * SURVIVORSHIP: NONE. Three continuously listed ETFs, no cross-sectional universe, no membership
 * list touched. universe-expanded.json is not read by this file.
 *
 * DATA:
 *   - Auctions: TreasuryDirect TA_WS /securities/search (NOT /auctioned — that endpoint silently
 *     caps at 250 rows, most-recent-first, which would have thrown away all pre-2024 history).
 *     Filtered on originalSecurityTerm (the nominal program, immune to a reopening's shortened
 *     remaining-maturity label) exactly one of 2-Year/5-Year/7-Year/10-Year/30-Year, type Note or
 *     Bond (verified empirically: zero TIPS, zero FRN rows carry these types or terms).
 *   - Prices: backend/lib/alpaca-bars.js (REUSED, not reimplemented), feed "sip". IEX free daily
 *     history for these three ETFs starts 2020-07-27 on this account, which cannot clear the >= 8
 *     calendar year bar; SIP daily reaches back to 2016-01-04 (empirically verified below), which
 *     is why calendar-flow.js (an existing runner in this repo) also uses SIP rather than IEX for
 *     exactly this reason.
 *
 * Output: backend/data/s18-treasury-auction.json
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBars } = require("./lib/alpaca-bars");
const { mean, tOf, clusterMeans } = require("./lib/clustered.js");
const D = (f) => path.join(__dirname, "data", f);

const HOLD = 3;                 // sessions, close-to-close — the queue's "+3d close"
const EXCLUDE_BUFFER = 3;       // sessions either side of a real auction excluded from the benchmark pool
const FEED = "sip";             // IEX only reaches 2020-07-27 for these three ETFs — fails the 8yr bar
const BAR = {
  minAuctions: 300, minYears: 8, minMaturities: 4,
  direction: "POSITIVE", tRequired: 3.5, placeboMax: 2.0,
};
const MAP = {
  "2-Year": "IEI", "5-Year": "IEI",
  "7-Year": "IEF", "10-Year": "IEF",
  "30-Year": "TLT",
};
const ETFS = ["IEI", "IEF", "TLT"];
const TD_BASE = "https://www.treasurydirect.gov/TA_WS/securities/search?format=json&type=";
// Alpaca SIP daily bars 403 (subscription-scope refusal, not a data gap) for any request whose
// start predates 2010-01-04 on this account — verified empirically 2026-09-04 (2009-12-01 fails,
// 2010-01-01 succeeds). EVENT_FLOOR keeps every event, plus its -365d placebo lookback, safely
// inside the servable window. This is a DATA-AVAILABILITY constraint, not a design choice: it
// still leaves 2011-2026 (16 calendar years, all 5 maturities), comfortably above the >=8yr bar.
const EVENT_FLOOR = "2011-06-01";

// Equity round-trip friction, MEASURED — read off the shop's own cost model rather than assumed.
// No dedicated "ETF"/"Bond ETF" class exists; IEI/IEF/TLT trade as ordinary $0-commission equity
// tickets on Schwab, so the Equity class is the standing proxy. See file header for the direction
// of the bias this introduces (overstated, works against the pre-declared positive direction).
const COST = (() => {
  const c = JSON.parse(fs.readFileSync(D("cost-model.json"), "utf8"));
  const e = c.perClass && c.perClass.Equity;
  if (!e || !Number.isFinite(e.roundTripPct)) throw new Error("cost-model.json has no Equity.roundTripPct — refusing to invent a cost");
  return { roundTripPct: e.roundTripPct, source: e.source, appliedAs: "LONG: excessNet = excessGross - roundTripPct (cost subtracts from a long's return)" };
})();

async function fetchAuctions(type) {
  const r = await fetch(TD_BASE + type);
  if (!r.ok) throw new Error(`TreasuryDirect ${type} search returned HTTP ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`TreasuryDirect ${type} search did not return an array`);
  return j;
}

(async () => {
  console.log("S18 — TREASURY AUCTION SUPPLY (post-auction reversion, IEI/IEF/TLT)");

  // ── 1. auctions ──────────────────────────────────────────────────────────────
  const [notes, bonds] = await Promise.all([fetchAuctions("Note"), fetchAuctions("Bond")]);
  const today = new Date().toISOString().slice(0, 10);
  const allRaw = [...notes, ...bonds];
  console.log(`  TreasuryDirect: ${notes.length} Note rows + ${bonds.length} Bond rows fetched (unfiltered)`);

  const qualifying = allRaw
    .filter((x) => MAP[x.originalSecurityTerm])
    .map((x) => ({
      term: x.originalSecurityTerm, etf: MAP[x.originalSecurityTerm],
      auctionDate: String(x.auctionDate).slice(0, 10), cusip: x.cusip,
    }))
    .filter((x) => x.auctionDate <= today && x.auctionDate >= EVENT_FLOOR);
  console.log(`  ${qualifying.length} qualifying coupon auctions (2y/5y/7y/10y/30y, originalSecurityTerm-matched, ${EVENT_FLOOR} <= auctionDate <= ${today})`);

  // ONE event per (ETF, auctionDate). A same-day 2y+5y (both IEI) or 7y+10y (both IEF) auction is
  // the SAME price observation on that instrument that day — merged, not double-counted, exactly
  // the clustering discipline S9/S12 apply to same-issuer same-day filings.
  const byKey = new Map();
  for (const e of qualifying) {
    const k = e.etf + "|" + e.auctionDate;
    const p = byKey.get(k);
    if (p) p.terms.add(e.term); else byKey.set(k, { etf: e.etf, auctionDate: e.auctionDate, terms: new Set([e.term]) });
  }
  const events = [...byKey.values()].sort((a, b) => (a.auctionDate < b.auctionDate ? -1 : 1));
  const mergedAway = qualifying.length - events.length;
  console.log(`  ${events.length} (ETF, auction-day) events after same-day merge (${mergedAway} same-day duplicates merged)`);

  // ── 2. pre-price sample gate ─────────────────────────────────────────────────
  // Refuse before a single price is fetched if the bar cannot possibly be met — the dedup and
  // pricing attrition below only ever REDUCE the count.
  const preYears = new Set(events.map((e) => e.auctionDate.slice(0, 4))).size;
  const preMaturities = new Set(events.flatMap((e) => [...e.terms])).size;
  if (events.length < BAR.minAuctions || preYears < BAR.minYears || preMaturities < BAR.minMaturities) {
    const out = {
      spec: "S18-treasury-auction-v1", proposedOn: "2026-09-03", barFixedOn: "2026-09-03", builtOn: "2026-09-04",
      ranAt: new Date().toISOString(), bar: BAR, mapping: MAP,
      sampleMet: false,
      verdict: `SAMPLE NOT MET — ${events.length}/${BAR.minAuctions} auctions, ${preYears}/${BAR.minYears} years, ${preMaturities}/${BAR.minMaturities} maturities BEFORE pricing attrition, which only reduces it. No prices fetched, no statistic computed.`,
      nothingWasComputed: true,
    };
    writeJsonAtomic(D("s18-treasury-auction.json"), out);
    console.log("\n  " + out.verdict);
    return;
  }

  // ── 3. prices ────────────────────────────────────────────────────────────────
  const first = events[0].auctionDate;
  const start = new Date(new Date(first + "T00:00:00Z").getTime() - 400 * 86400000).toISOString().slice(0, 10); // buffer for -365d placebo
  // SIP free-tier refuses end=today ("subscription does not permit querying recent SIP data",
  // verified empirically 2026-09-04; the established fix elsewhere in this repo — see
  // backend/ats-motivating-check.js:54 — is to clamp end to yesterday.
  const end = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  console.log(`  [prices] ${ETFS.join(", ")}, feed=${FEED}, ${start}..${end}`);
  const { bars } = await fetchBars(ETFS, { start, end, timeframe: "1Day", feed: FEED, adjustment: "all", minBars: 300, quiet: true, requireAll: true });
  for (const s of ETFS) console.log(`  [prices] ${s}: ${bars[s].length} bars, ${bars[s][0].t.slice(0, 10)}..${bars[s][bars[s].length - 1].t.slice(0, 10)}`);

  const dOf = (b) => String(b.t).slice(0, 10);
  const idxOf = {}; // etf -> Map(dateStr -> index)
  for (const s of ETFS) idxOf[s] = new Map(bars[s].map((b, i) => [dOf(b), i]));
  /** first index >= dateStr (exact match when the auction date is itself a trading day, which it always should be). */
  function onOrAfter(sym, dateStr) {
    const exact = idxOf[sym].get(dateStr);
    if (exact != null) return exact;
    const arr = bars[sym];
    const i = arr.findIndex((b) => dOf(b) >= dateStr);
    return i;
  }

  // ── 4. price each real event, exact auction-day close as entry ───────────────
  const priced = [], unpriced = [];
  for (const e of events) {
    const arr = bars[e.etf];
    const ei = idxOf[e.etf].get(e.auctionDate);
    if (ei == null || ei + HOLD >= arr.length) { unpriced.push(e); continue; }
    priced.push(Object.assign({}, e, { ei, entryDate: dOf(arr[ei]), exitDate: dOf(arr[ei + HOLD]) }));
  }
  console.log(`  ${priced.length} priced (exact auction-day close found + ${HOLD}d exit available) · ${unpriced.length} unpriced`);

  // ── 5. exclusion mask + benchmark, per ETF, "on non-auction windows" ─────────
  const excluded = {}; // etf -> Set(index)
  for (const s of ETFS) excluded[s] = new Set();
  for (const e of priced) {
    for (let d = e.ei - EXCLUDE_BUFFER; d <= e.ei + EXCLUDE_BUFFER; d++) excluded[e.etf].add(d);
  }
  const benchmark = {};
  for (const s of ETFS) {
    const arr = bars[s];
    const rets = [];
    for (let i = 0; i + HOLD < arr.length; i++) {
      if (excluded[s].has(i) || excluded[s].has(i + HOLD)) continue;
      rets.push(100 * (arr[i + HOLD].c / arr[i].c - 1));
    }
    benchmark[s] = { n: rets.length, mean: +mean(rets).toFixed(5) };
  }
  console.log("  BENCHMARK (own-ETF mean " + HOLD + "d return, non-auction windows): "
    + ETFS.map((s) => `${s} ${benchmark[s].mean}% (n=${benchmark[s].n})`).join(" · "));

  // ── 6. excess per event, gross and net (LONG cost sign — see file header) ────
  function excessOf(sym, entryIdx) {
    const arr = bars[sym];
    const ret = 100 * (arr[entryIdx + HOLD].c / arr[entryIdx].c - 1);
    const excessGross = ret - benchmark[sym].mean;
    const excessNet = excessGross - COST.roundTripPct;
    return { ret: +ret.toFixed(4), excessGross: +excessGross.toFixed(4), excessNet: +excessNet.toFixed(4) };
  }
  const kept = priced.map((e) => Object.assign({}, e, excessOf(e.etf, e.ei)));

  // ── 7. post-price sample gate ─────────────────────────────────────────────────
  const years = new Set(kept.map((e) => e.auctionDate.slice(0, 4))).size;
  const maturities = new Set(kept.flatMap((e) => [...e.terms])).size;
  const sampleMet = kept.length >= BAR.minAuctions && years >= BAR.minYears && maturities >= BAR.minMaturities;

  // ── 8. the statistic — auction-day clusters, never the row ───────────────────
  const stat = (rows, field) => {
    const { means: m } = clusterMeans(rows, (r) => r.auctionDate, (r) => r[field]);
    const t = tOf(m); return { n: rows.length, days: m.length, mean: rows.length ? +mean(rows.map((r) => r[field])).toFixed(4) : null, dayMean: m.length ? +mean(m).toFixed(4) : null, t: t == null ? null : +t.toFixed(3) };
  };
  const gross = stat(kept, "excessGross");
  const net = stat(kept, "excessNet");

  // ── 9. THE MANDATORY PLACEBO — same ETF, exactly 365 days earlier ────────────
  const placeboRows = [], contaminated = [];
  for (const e of kept) {
    const shifted = new Date(new Date(e.auctionDate + "T00:00:00Z").getTime() - 365 * 86400000).toISOString().slice(0, 10);
    const pi = onOrAfter(e.etf, shifted);
    if (pi < 0 || pi + HOLD >= bars[e.etf].length) continue;
    const isContaminated = excluded[e.etf].has(pi) || excluded[e.etf].has(pi + HOLD);
    const ex = excessOf(e.etf, pi);
    const row = Object.assign({ etf: e.etf, auctionDate: dOf(bars[e.etf][pi]), realAuctionDate: e.auctionDate, contaminated: isContaminated }, ex);
    placeboRows.push(row);
    if (isContaminated) contaminated.push(row);
  }
  const placebo = stat(placeboRows, "excessNet");
  const placeboGross = stat(placeboRows, "excessGross");
  const contamRate = placeboRows.length ? +(100 * contaminated.length / placeboRows.length).toFixed(1) : null;

  // ── 10. chronological split, count-based median, same sign required both halves ──
  const sortedKept = [...kept].sort((a, b) => (a.auctionDate < b.auctionDate ? -1 : 1));
  const mid = Math.floor(sortedKept.length / 2);
  const half1 = stat(sortedKept.slice(0, mid), "excessNet");
  const half2 = stat(sortedKept.slice(mid), "excessNet");
  const splitSameSign = half1.dayMean != null && half2.dayMean != null && Math.sign(half1.dayMean) === Math.sign(half2.dayMean) && Math.sign(half1.dayMean) === Math.sign(net.dayMean || 0);

  // ── 11. same-day cross-ETF cluster collisions, disclosed ─────────────────────
  const dayEtfCount = new Map();
  for (const e of kept) { const s = dayEtfCount.get(e.auctionDate) || new Set(); s.add(e.etf); dayEtfCount.set(e.auctionDate, s); }
  const crossEtfDays = [...dayEtfCount.entries()].filter(([, s]) => s.size > 1).length;

  // ── 12. verdict, against the bar exactly as written ───────────────────────────
  // DESIGN-CANNOT-SEPARATE takes precedence over a plain placebo read: high contamination PLUS a
  // placebo that reads in the same direction as primary is exactly the pre-declared failure mode
  // — "the design cannot separate them", not a verdict on the mechanism either way.
  const CONTAM_HIGH = 40; // percent — pre-stated threshold for "the calendar is too dense to build a clean control"
  const placeboMoves = net.t != null && net.t !== 0 && placebo.t != null
    && Math.abs(placebo.t) >= BAR.placeboMax
    && Math.sign(placebo.dayMean) === Math.sign(net.dayMean);
  const placeboClean = placebo.t == null ? null : Math.abs(placebo.t) < BAR.placeboMax;

  let verdict;
  if (!sampleMet) {
    verdict = `SAMPLE NOT MET — ${kept.length}/${BAR.minAuctions} auctions, ${years}/${BAR.minYears} years, ${maturities}/${BAR.minMaturities} maturities after pricing attrition; no read`;
  } else if (net.t == null || placebo.t == null) {
    verdict = "NO STATISTIC — fewer than two auction-day clusters on the primary or placebo side";
  } else if (contamRate >= CONTAM_HIGH && placeboMoves) {
    verdict = `DESIGN-CANNOT-SEPARATE — ${contamRate}% of placebo control dates (365d before a real auction) themselves fall inside another real auction's own exclusion window, and the placebo reads t ${placebo.t} in the SAME direction as the primary (t ${net.t}). The auction calendar is dense enough that a matched non-auction control cannot be built clean, exactly the pre-declared most-likely failure. This is not a verdict on the mechanism.`;
  } else if (!placeboClean) {
    verdict = `DEAD BY PLACEBO — the same ETFs, one year earlier with no auction, read t ${placebo.t} (contamination ${contamRate}%, below the ${CONTAM_HIGH}% design-limit threshold); whatever the primary measures, it is not decisively the auction`;
  } else if (net.t >= BAR.tRequired && net.dayMean > 0 && splitSameSign) {
    verdict = `CLEARS — mean net +${HOLD}d excess ${net.dayMean}% at auction-day-clustered t ${net.t}, placebo clean (t ${placebo.t}, contamination ${contamRate}%), same sign both chronological halves (${half1.dayMean}% / ${half2.dayMean}%)`;
  } else {
    verdict = `NOT-ESTABLISHED — mean net +${HOLD}d excess ${net.dayMean}% at auction-day-clustered t ${net.t} vs bar ${BAR.tRequired}; splitSameSign=${splitSameSign}; placebo t ${placebo.t} (contamination ${contamRate}%)`;
  }

  const out = {
    spec: "S18-treasury-auction-v1", proposedOn: "2026-09-03", barFixedOn: "2026-09-03", builtOn: "2026-09-04",
    ranAt: new Date().toISOString(),
    counterparty: "the US Treasury as seller (funds a deficit on a published calendar regardless of price) and primary dealers obliged to bid to keep their designation, then must warehouse and hedge the inventory",
    mapping: MAP,
    eventFloor: EVENT_FLOOR,
    eventFloorReason: "Alpaca SIP daily bars for IEI/IEF/TLT 403 (subscription-scope) for any request starting before 2010-01-04 on this account, verified empirically 2026-09-04; EVENT_FLOOR keeps every event and its placebo lookback inside the servable window while still leaving 16 calendar years (2011-2026).",
    mappingCaveat: "only 3 ETFs exist for 5 maturities; 2-year notes are mapped to IEI (3-7y) as the shortest-duration fund in the named set, a duration mismatch disclosed in the file header, not discovered after the read.",
    bar: BAR, feed: FEED, holdSessions: HOLD, excludeBufferSessions: EXCLUDE_BUFFER,
    cost: COST,
    funnel: {
      tdNoteRows: notes.length, tdBondRows: bonds.length, qualifyingAuctions: qualifying.length,
      mergedSameDaySameEtf: mergedAway, eventsAfterMerge: events.length,
      priced: priced.length, unpriced: unpriced.length,
    },
    sample: { n: kept.length, years, maturities, preMet: { n: events.length, years: preYears, maturities: preMaturities } },
    sampleMet,
    benchmark,
    primary: net, primaryGross: gross,
    placebo, placeboGross, placeboClean, placeboContaminationPct: contamRate, placeboRows: placeboRows.length, placeboContaminatedRows: contaminated.length,
    chronologicalSplit: { half1, half2, splitSameSign },
    crossEtfSameDayClusterDays: crossEtfDays,
    verdict,
    rows: kept.map((r) => ({ etf: r.etf, auctionDate: r.auctionDate, terms: [...r.terms], ret: r.ret, excessGross: r.excessGross, excessNet: r.excessNet })),
  };
  writeJsonAtomic(D("s18-treasury-auction.json"), out);

  console.log(`\n  SAMPLE: ${kept.length} auctions (bar ${BAR.minAuctions}) · ${years} years (bar ${BAR.minYears}) · ${maturities} maturities (bar ${BAR.minMaturities}) · met=${sampleMet}`);
  console.log(`  GROSS  mean ${gross.mean}% · day-mean ${gross.dayMean}% · t ${gross.t} on ${gross.days} auction days`);
  console.log(`  NET    mean ${net.mean}% · day-mean ${net.dayMean}% · t ${net.t}  (long round trip: -${COST.roundTripPct}%)`);
  console.log(`  PLACEBO (same ETFs, 365d earlier) n ${placebo.n} · day-mean ${placebo.dayMean}% · t ${placebo.t} · contamination ${contamRate}%`);
  console.log(`  SPLIT  half1 ${half1.dayMean}% (t ${half1.t}) · half2 ${half2.dayMean}% (t ${half2.t}) · sameSign=${splitSameSign}`);
  console.log(`\n  ${verdict}`);
  console.log("written: s18-treasury-auction.json");
})().catch((e) => { console.error("S18 FAILED:", e.message, e.stack); process.exit(1); });
