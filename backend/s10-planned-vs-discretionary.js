#!/usr/bin/env node
/**
 * S10 — DISCRETIONARY VERSUS 10b5-1-PLANNED INSIDER SELLING — THE DIFFERENCE, NOT EITHER ARM.
 * A structural candidate from the alpha-hunt queue (proposed 2026-08-26, bar frozen the same day,
 * data blocker cleared 2026-08-31), built 2026-09-04. Modelled on backend/s9-inkind-distribution.js,
 * the sibling runner that took the same "refuse until the sample is genuinely there" design to a
 * clean SAMPLE NOT MET.
 *
 * THE COUNTERPARTY, which is why this is not a chart pattern wearing a story:
 *   Whoever buys shares sold under a Rule 10b5-1 plan. They are buying from a seller who has no
 *   current information and, crucially, no choice: the sale date, size and price mechanism were
 *   fixed months earlier and the plan cannot be timed or cancelled without destroying the
 *   affirmative defence.
 * WHY THEY ACCEPT A WORSE PRICE: the planned seller is price-insensitive by contract — the same
 *   economics as an index fund on reconstitution day (S1), except the seller is an individual and
 *   the schedule is private until the Form 4 lands. The discretionary seller is the opposite:
 *   they chose today, which is the only insider sale that can carry information.
 * WHAT WOULD STOP IT: the December 2022 amendments added mandatory cooling-off periods and a
 *   checkbox on the face of the Form 4, so the event is visible to anyone who reads the filing —
 *   any concession may already be arbitraged, and the same fact both enables and threatens the test.
 *
 * THE EVENT: code-S (open-market disposition, ad === "D") rows in a Form 4, split into two arms by
 * the filing-level <aff10b5One> flag: true = PLANNED, false = DISCRETIONARY. null (flag absent —
 * pre-2023 filings, or the field not yet re-parsed) is DROPPED, never counted as discretionary.
 * Entry at the first close strictly AFTER the FILING date, never the transaction date — a Form 4
 * is due two business days after the transaction, so the transaction date is not knowable live.
 *
 * THE ACTUAL HYPOTHESIS (from the queue, verbatim): not "insider selling predicts returns" — that
 * is picked over. The claim is that the SPLIT matters: mean forward excess after DISCRETIONARY
 * selling minus mean forward excess after PLANNED selling is negative. Testing the difference,
 * not either arm, cancels the generic insider-selling drift that confounds every naive version.
 * Neither arm's own level is a result; only the difference is registered. This runner never prints
 * a standalone-arm verdict as a finding, only as a diagnostic toward the difference.
 *
 * ═══ THE BAR, FIXED 2026-08-26 BEFORE ANY EVIDENCE WAS READ — copied verbatim from the queue ═══
 *   ">= 100 events in EACH arm on >= 40 distinct filing days per arm, matched within size decile
 *    and within calendar month so the arms are not a market-cap comparison in disguise. Clears
 *    only if (discretionary mean +20d excess) minus (planned mean +20d excess) is negative at a
 *    filing-day-clustered t <= -2.0 on non-overlapping blocks. Neither arm's own level is a
 *    result; only the difference is registered."
 * S10 is one of several queued candidates, so the house |t| >= 3.5 search bar (adjudicator.json:696
 * "a result found by SEARCHING needs |t| >= 3.5 here, not 2.0") is the OPERATIVE number for a
 * CLEARS verdict. -2.0 is reported only to show the bar was not moved after the fact — same
 * convention as S9.
 *
 * ═══ WHY THIS IS EXPECTED TO REFUSE TODAY, STATED BEFORE RUNNING ═══
 * <aff10b5One> is FORWARD-ONLY (backend/insider-edgar.js:122-123, added 2026-08-31): cached
 * filings are not re-parsed, so both arms start accruing from the first filing collected after
 * that date. As of this run the flag exists on 1,407 of 35,396 cached accessions, almost all of
 * them filed in the single month 2026-09 (1,045 of 1,407). A per-arm EVENT count can look large
 * fast because many tickers file on the same handful of days once the collector starts stamping,
 * but the bar's harder constraint is DISTINCT FILING DAYS per arm (>= 40), which cannot be
 * satisfied by volume on few days — it requires the calendar itself to pass. This is a waiting
 * problem, identical in shape to S9's.
 *
 * ═══ COST SIGN ═══
 * Direction is pre-declared NEGATIVE for the DIFFERENCE (discretionary − planned), not for either
 * arm's own level. The tradeable expression is: short the discretionary-seller name, or equivalently
 * be relatively long the planned-seller name, over the same +20d window — the counterparty analysis
 * says the discretionary sale is the informative (bearish) one. Per-arm excess is computed GROSS
 * only; cost is applied ONCE, to the DIFFERENCE, and in the direction that makes trading the
 * difference cost money rather than free money — i.e. cost is subtracted from the magnitude of the
 * (already negative, pre-declared) diff, moving it TOWARD zero, exactly the correction applied at
 * backend/s9-inkind-distribution.js:174-196 for S9's short leg. Applying cost to each arm
 * separately and then differencing would double-count a friction that is paid once per relative
 * trade and, worse, would partially cancel if both raw legs are treated identically — so cost is
 * applied to the spread, not to the legs.
 *
 * SURVIVORSHIP: issuers reaching this script are whatever backend/insider-edgar.js scanned, which
 * iterates universe-expanded.json (CURRENT MEMBERSHIP). A name delisted before today is absent
 * entirely. This drops losers from both arms roughly symmetrically since the split is a filing
 * attribute, not a return attribute, so it is not expected to bias the DIFFERENCE in either
 * direction the way it would bias a single-arm level test.
 *
 * SIZE-DECILE / CALENDAR-MONTH MATCH: required by the bar to keep the arms from being a market-cap
 * comparison in disguise. This runner does NOT attempt it — there is no market-cap or float field
 * on disk anywhere in this repo (checked: no per-symbol cap file, only universe-expanded.json which
 * carries symbols, no fundamentals). Matching is therefore a second, independent blocker on top of
 * the day-count blocker, disclosed here rather than silently skipped as "not engaged" (the S13
 * convention at backend/s13-form144.js:36,474). It does not change today's verdict: the runner
 * refuses on the day-count and event-count gate BEFORE matching would ever be attempted, so the
 * missing match is moot today and becomes the SECOND thing that must exist before this can clear,
 * once the calendar clears the first.
 *
 * Output: backend/data/s10-planned-vs-discretionary.json
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBarsWithBenchmark } = require("./lib/alpaca-bars");
const { mean, tOf, clusterMeans } = require("./lib/clustered.js");
const D = (f) => path.join(__dirname, "data", f);

const HOLD = 20;                       // sessions, close-to-close — the queue's +20 trading session horizon
const OVERLAP_SESSIONS = 20;           // non-overlapping blocks per issuer, same window as the hold
const BAR = { minEventsPerArm: 100, minFilingDaysPerArm: 40, direction: "NEGATIVE (discretionary - planned)", tRequired: -2.0, tSearchBar: -3.5 };
const TICKER_OK = /^[A-Z]{1,5}$/;

// Equity round-trip friction, MEASURED — read off the shop's own cost model rather than assumed.
const COST = (() => {
  const c = JSON.parse(fs.readFileSync(D("cost-model.json"), "utf8"));
  const e = c.perClass && c.perClass.Equity;
  if (!e || !Number.isFinite(e.roundTripPct)) throw new Error("cost-model.json has no Equity.roundTripPct — refusing to invent a cost");
  return { roundTripPct: e.roundTripPct, source: e.source };
})();

(async () => {
  // ── 1. events, split into two arms by the filing-level flag ─────────────────────────────────
  const cache = JSON.parse(fs.readFileSync(D("edgar-form4-cache.json"), "utf8"));
  const funnel = { cachedFilings: 0, flagPresent: 0, withCodeSDisposition: 0, unstamped: 0, badTicker: 0, flagNull: 0 };
  const rawByArm = { true: [], false: [] };
  for (const acc of Object.keys(cache)) {
    const v = cache[acc];
    if (!v || !Array.isArray(v.rows)) continue;
    funnel.cachedFilings++;
    if (v.aff10b5One === null || v.aff10b5One === undefined) { if (v.aff10b5One === null) funnel.flagNull++; continue; }
    funnel.flagPresent++;
    const s = v.rows.filter((r) => r.code === "S" && r.ad === "D");
    if (!s.length) continue;
    funnel.withCodeSDisposition++;
    if (!v.sym || !v.filingDate) { funnel.unstamped++; continue; }
    if (!TICKER_OK.test(v.sym)) { funnel.badTicker++; continue; }
    rawByArm[String(v.aff10b5One)].push({
      acc, sym: v.sym, owner: v.owner, filingDate: v.filingDate,
      shares: s.reduce((sum, r) => sum + (r.shares || 0), 0),
    });
  }

  /** ONE event per (issuer, filing day) per arm — several code-S rows in one filing are one event. */
  function collapse(raw) {
    const byKey = new Map();
    for (const e of raw) {
      const k = e.sym + "|" + e.filingDate;
      const p = byKey.get(k);
      if (p) { p.shares += e.shares; p.filings++; }
      else byKey.set(k, { sym: e.sym, filingDate: e.filingDate, shares: e.shares, filings: 1 });
    }
    return [...byKey.values()].sort((a, b) => (a.filingDate < b.filingDate ? -1 : 1));
  }
  const eventsPlanned = collapse(rawByArm.true);         // aff10b5One === true
  const eventsDiscretionary = collapse(rawByArm.false);  // aff10b5One === false

  const daysPlanned = new Set(eventsPlanned.map((e) => e.filingDate)).size;
  const daysDiscretionary = new Set(eventsDiscretionary.map((e) => e.filingDate)).size;

  console.log("S10 — DISCRETIONARY VS 10b5-1-PLANNED INSIDER SELLING (the difference, not either arm)");
  console.log("  funnel: " + funnel.cachedFilings + " cached filings -> " + funnel.flagPresent + " carry the aff10b5One flag ("
    + funnel.flagNull + " flag=null, dropped) -> " + funnel.withCodeSDisposition + " with a code-S disposition ("
    + funnel.unstamped + " unstamped, " + funnel.badTicker + " bad ticker)");
  console.log("  PLANNED (true):        " + eventsPlanned.length + " issuer-day events on " + daysPlanned + " distinct filing days, "
    + new Set(eventsPlanned.map((e) => e.sym)).size + " issuers");
  console.log("  DISCRETIONARY (false): " + eventsDiscretionary.length + " issuer-day events on " + daysDiscretionary + " distinct filing days, "
    + new Set(eventsDiscretionary.map((e) => e.sym)).size + " issuers");

  /**
   * SAMPLE GATE BEFORE PRICES, BOTH ARMS, BOTH THRESHOLDS. Refuse early rather than fetching
   * hundreds of price series to produce a "SAMPLE NOT MET" that was knowable from the event
   * count alone. Dedup and pricing attrition only ever REDUCE counts, so a pre-dedup shortfall
   * on EITHER arm on EITHER dimension (events, days) is decisive on its own.
   */
  const sampleMetPre = eventsPlanned.length >= BAR.minEventsPerArm && daysPlanned >= BAR.minFilingDaysPerArm
    && eventsDiscretionary.length >= BAR.minEventsPerArm && daysDiscretionary >= BAR.minFilingDaysPerArm;

  const shortfalls = [];
  if (eventsPlanned.length < BAR.minEventsPerArm) shortfalls.push("PLANNED events " + eventsPlanned.length + "/" + BAR.minEventsPerArm);
  if (daysPlanned < BAR.minFilingDaysPerArm) shortfalls.push("PLANNED filing days " + daysPlanned + "/" + BAR.minFilingDaysPerArm);
  if (eventsDiscretionary.length < BAR.minEventsPerArm) shortfalls.push("DISCRETIONARY events " + eventsDiscretionary.length + "/" + BAR.minEventsPerArm);
  if (daysDiscretionary < BAR.minFilingDaysPerArm) shortfalls.push("DISCRETIONARY filing days " + daysDiscretionary + "/" + BAR.minFilingDaysPerArm);

  if (!sampleMetPre) {
    const out = {
      spec: "S10-planned-vs-discretionary-v1", proposedOn: "2026-08-26", barFixedOn: "2026-08-26",
      dataBlockerResolvedOn: "2026-08-31", builtOn: "2026-09-04",
      ranAt: new Date().toISOString(), bar: BAR, funnel,
      arms: {
        planned: { events: eventsPlanned.length, filingDays: daysPlanned, issuers: new Set(eventsPlanned.map((e) => e.sym)).size },
        discretionary: { events: eventsDiscretionary.length, filingDays: daysDiscretionary, issuers: new Set(eventsDiscretionary.map((e) => e.sym)).size },
      },
      sampleMet: false,
      verdict: "SAMPLE NOT MET — " + shortfalls.join("; ") + ". No prices fetched, no statistic computed, no size/month match attempted.",
      whyNoRead: "Refusing early is the point. The bar was frozen 2026-08-26 and is not negotiable. <aff10b5One> is forward-only from 2026-08-31 (backend/insider-edgar.js:122-123 inside parseForm4, populated by the nightly collector at insider-edgar.js:277 onward); this is a waiting problem, not a plumbing problem. Re-run on any schedule — this file reads itself the moment BOTH arms clear BOTH thresholds.",
      secondBlockerDisclosed: "even once the day-count clears, the bar also requires matching within size decile and within calendar month. No market-cap or float field exists anywhere in this repo's data directory today, so that match is UNIMPLEMENTED and would need its own data source (e.g. a shares-outstanding or float field) before a CLEARS verdict could be trusted. Stated now so it is not discovered late.",
      nothingWasComputed: "No returns, no excess, no t. Nothing here is evidence and nothing here can be quoted as a result.",
    };
    writeJsonAtomic(D("s10-planned-vs-discretionary.json"), out);
    console.log("\n  " + out.verdict);
    console.log("  " + out.secondBlockerDisclosed);
    console.log("written: s10-planned-vs-discretionary.json");
    return;
  }

  // ── 2. prices (only reached once both arms clear the pre-dedup gate) ────────────────────────
  const allEvents = eventsPlanned.concat(eventsDiscretionary);
  const tickers = [...new Set(allEvents.map((e) => e.sym))];
  const first = allEvents.slice().sort((a, b) => (a.filingDate < b.filingDate ? -1 : 1))[0].filingDate;
  const start = new Date(new Date(first + "T00:00:00Z").getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);
  console.log("  [prices] SPY + " + tickers.length + " tickers, " + start + ".." + end);
  const { bars, benchmark: spy, coverage } = await fetchBarsWithBenchmark("SPY", tickers, {
    start, end, timeframe: "1Day", feed: "iex", adjustment: "all", minBars: 200, quiet: true,
  });
  console.log("  [prices] " + coverage.returned.length + "/" + coverage.requested.length + " priced; " + coverage.missing.length + " missing (delisted/unavailable — attrition, recorded)");

  const dOf = (b) => String(b.t).slice(0, 10);
  const spyIdx = new Map(spy.map((b, i) => [dOf(b), i]));
  const after = (arr, dateStr) => arr.findIndex((b) => dOf(b) > dateStr);

  function win(sym, fromDate) {
    const b = bars[sym];
    if (!Array.isArray(b) || b.length < 30) return null;
    const ei = after(b, fromDate);
    if (ei < 0 || ei + HOLD >= b.length) return null;
    const entryDate = dOf(b[ei]);
    const si = spyIdx.get(entryDate);
    if (si == null || si + HOLD >= spy.length) return null;
    const ret = 100 * (b[ei + HOLD].c / b[ei].c - 1);
    const bench = 100 * (spy[si + HOLD].c / spy[si].c - 1);
    return { entryDate, exitDate: dOf(b[ei + HOLD]), ret: +ret.toFixed(4), bench: +bench.toFixed(4), excessGross: +(ret - bench).toFixed(4), ei };
  }

  // ── 3. non-overlapping blocks per issuer per arm, in filing-date order ──────────────────────
  function block(events) {
    const kept = [], droppedOverlap = [], unpriced = [];
    const lastKeptIdx = new Map();
    for (const e of events) {
      const w = win(e.sym, e.filingDate);
      if (!w) { unpriced.push(e); continue; }
      const prev = lastKeptIdx.get(e.sym);
      if (prev != null && w.ei - prev <= OVERLAP_SESSIONS) { droppedOverlap.push(Object.assign({}, e, { sepSessions: w.ei - prev })); continue; }
      lastKeptIdx.set(e.sym, w.ei);
      kept.push(Object.assign({}, e, w));
    }
    return { kept, droppedOverlap, unpriced };
  }
  const bPlanned = block(eventsPlanned);
  const bDiscretionary = block(eventsDiscretionary);
  const filingDaysPlannedPost = new Set(bPlanned.kept.map((e) => e.filingDate));
  const filingDaysDiscretionaryPost = new Set(bDiscretionary.kept.map((e) => e.filingDate));

  console.log("  PLANNED post-block:        " + bPlanned.kept.length + " events on " + filingDaysPlannedPost.size + " filing days · " + bPlanned.droppedOverlap.length + " dropped overlap · " + bPlanned.unpriced.length + " unpriced");
  console.log("  DISCRETIONARY post-block:  " + bDiscretionary.kept.length + " events on " + filingDaysDiscretionaryPost.size + " filing days · " + bDiscretionary.droppedOverlap.length + " dropped overlap · " + bDiscretionary.unpriced.length + " unpriced");

  // ── 4. sample gate AGAIN, post-attrition — the pre-gate only proves it is not hopeless ──────
  const sampleMetPost = bPlanned.kept.length >= BAR.minEventsPerArm && filingDaysPlannedPost.size >= BAR.minFilingDaysPerArm
    && bDiscretionary.kept.length >= BAR.minEventsPerArm && filingDaysDiscretionaryPost.size >= BAR.minFilingDaysPerArm;

  const statArm = (rows) => {
    const { means: m } = clusterMeans(rows, (r) => r.filingDate, (r) => r.excessGross);
    return { n: rows.length, days: m.length, mean: rows.length ? +mean(rows.map((r) => r.excessGross)).toFixed(4) : null, dayMean: m.length ? +mean(m).toFixed(4) : null, t: tOf(m) };
  };
  const plannedStat = statArm(bPlanned.kept);
  const discretionaryStat = statArm(bDiscretionary.kept);

  /**
   * THE STATISTIC: the DIFFERENCE, clustered on filing day. Each arm's own days are clustered
   * separately (they are not the same calendar days in general — a paired-same-day design is not
   * what the bar asks for; it asks for the DIFFERENCE OF MEANS between two independently observed
   * populations, each clustered on its own filing day, which is a two-sample t on cluster means).
   * Cost is applied ONCE, to the diff, per the cost-sign note at the top of this file.
   */
  function twoSampleT(meansA, meansB) {
    if (meansA.length < 2 || meansB.length < 2) return null;
    const mA = mean(meansA), mB = mean(meansB);
    const sdOf = (a, m) => Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
    const sA = sdOf(meansA, mA), sB = sdOf(meansB, mB);
    const se = Math.sqrt((sA * sA) / meansA.length + (sB * sB) / meansB.length);
    if (!(se > 0)) return null;
    return { diff: mA - mB, t: (mA - mB) / se, meanA: mA, meanB: mB, seDiff: se };
  }
  const clustersDiscretionary = clusterMeans(bDiscretionary.kept, (r) => r.filingDate, (r) => r.excessGross);
  const clustersPlanned = clusterMeans(bPlanned.kept, (r) => r.filingDate, (r) => r.excessGross);
  const diffGross = twoSampleT(clustersDiscretionary.means, clustersPlanned.means);
  // cost applied to the DIFFERENCE only, toward zero, per the cost-sign note above
  const diffNet = diffGross ? {
    diff: +(diffGross.diff + (diffGross.diff < 0 ? COST.roundTripPct : -COST.roundTripPct)).toFixed(4),
    t: null, meanA: diffGross.meanA, meanB: diffGross.meanB,
  } : null;
  if (diffNet) {
    // recompute t with the shifted diff but the SAME standard error (a constant shift leaves SE untouched)
    diffNet.t = +(diffNet.diff / diffGross.seDiff).toFixed(3);
    diffNet.diff = +diffNet.diff.toFixed(4);
  }
  if (diffGross) diffGross.t = +diffGross.t.toFixed(3);
  if (diffGross) diffGross.diff = +diffGross.diff.toFixed(4);

  // ── 5. verdict, against the bar exactly as written ───────────────────────────────────────────
  let verdict;
  const sizeMonthMatch = "NOT ATTEMPTED — no market-cap/float field exists in this repo's data directory; the bar requires it and this run cannot honestly claim to have met it even where the raw counts clear.";
  if (!sampleMetPost) {
    verdict = "SAMPLE NOT MET AFTER ATTRITION — " + (bPlanned.kept.length < BAR.minEventsPerArm || filingDaysPlannedPost.size < BAR.minFilingDaysPerArm ? "PLANNED " + bPlanned.kept.length + "/" + BAR.minEventsPerArm + " on " + filingDaysPlannedPost.size + "/" + BAR.minFilingDaysPerArm + " days; " : "")
      + (bDiscretionary.kept.length < BAR.minEventsPerArm || filingDaysDiscretionaryPost.size < BAR.minFilingDaysPerArm ? "DISCRETIONARY " + bDiscretionary.kept.length + "/" + BAR.minEventsPerArm + " on " + filingDaysDiscretionaryPost.size + "/" + BAR.minFilingDaysPerArm + " days" : "");
  } else if (!diffNet || diffNet.t == null) {
    verdict = "NO STATISTIC — fewer than two filing-day clusters in one arm";
  } else {
    verdict = "SAMPLE MET ON COUNTS BUT SIZE/MONTH MATCH NOT ATTEMPTED — the bar is not honestly cleared without it; raw diff t " + diffNet.t + " reported as a DIAGNOSTIC ONLY, not a verdict.";
  }

  const out = {
    spec: "S10-planned-vs-discretionary-v1", proposedOn: "2026-08-26", barFixedOn: "2026-08-26",
    dataBlockerResolvedOn: "2026-08-31", builtOn: "2026-09-04",
    ranAt: new Date().toISOString(),
    counterparty: "whoever buys shares sold under a Rule 10b5-1 plan — a price-insensitive seller by contract, date/size/mechanism fixed months earlier",
    bar: BAR,
    barIsSearchBar: "YES — S10 is one of several candidates in the alpha-hunt queue, so the house significanceBar |t| >= 3.5 (adjudicator.json:696) is the operative number for CLEARS. -2.0 is reported only to show the bar was not renegotiated.",
    costAppliedTo: "the DIFFERENCE only (discretionary minus planned), toward zero, once — not to each arm separately. See cost-sign note in the file header.",
    cost: COST,
    sizeMonthMatch,
    funnel: Object.assign({}, funnel, {
      priced: coverage.returned.length, missing: coverage.missing.length,
      plannedKept: bPlanned.kept.length, plannedDroppedOverlap: bPlanned.droppedOverlap.length, plannedUnpriced: bPlanned.unpriced.length, plannedFilingDays: filingDaysPlannedPost.size,
      discretionaryKept: bDiscretionary.kept.length, discretionaryDroppedOverlap: bDiscretionary.droppedOverlap.length, discretionaryUnpriced: bDiscretionary.unpriced.length, discretionaryFilingDays: filingDaysDiscretionaryPost.size,
    }),
    arms: { planned: plannedStat, discretionary: discretionaryStat },
    diffGross, diffNet,
    sampleMetPre, sampleMetPost, verdict,
  };
  writeJsonAtomic(D("s10-planned-vs-discretionary.json"), out);
  console.log("\n  PLANNED       day-mean " + plannedStat.dayMean + "% on " + plannedStat.days + " days");
  console.log("  DISCRETIONARY day-mean " + discretionaryStat.dayMean + "% on " + discretionaryStat.days + " days");
  if (diffGross) console.log("  DIFF gross " + diffGross.diff + "% t " + diffGross.t + "  ·  DIFF net " + (diffNet ? diffNet.diff + "% t " + diffNet.t : "n/a"));
  console.log("\n  " + verdict);
  console.log("written: s10-planned-vs-discretionary.json");
})().catch((e) => { console.error("S10 FAILED:", e.message); process.exit(1); });
