#!/usr/bin/env node
/**
 * S12 — THE SCHEDULED RSU VEST WAVE. A structural candidate taken from the alpha-hunt queue
 * (proposed 2026-08-27, backend/data/alpha-hunt-queue.json) all the way to a verdict.
 *
 * THE COUNTERPARTY, which is the whole reason this is not a chart pattern wearing a story:
 *   Rank-and-file employees of the issuer. Restricted stock vests on a date fixed years earlier
 *   in a grant agreement. The holder is maximally undiversified (salary and savings are the same
 *   company), the tax is due in the same instant, and the sale motive is diversification and
 *   liquidity — not a view. The date was set by someone else, years ago.
 * WHY THEY ACCEPT A WORSE PRICE: they did not choose the day and hold no view.
 * WHAT WOULD STOP IT: the supply becoming anticipated, or never reaching the tape at all.
 *
 * THE EVENT: a Form 4 carrying a code-F row — shares WITHHELD to satisfy tax on vesting.
 * Entry at the first close strictly AFTER the FILING date, never the transaction date: a Form 4
 * is due two business days after the transaction, so the transaction date is not knowable when
 * it happens and anything entering on it is look-ahead.
 *
 * THE BAR, FIXED 2026-08-27 BEFORE ANY EVIDENCE WAS READ, copied verbatim from the queue entry:
 *   ">= 150 code-F events on >= 40 distinct FILING days, non-overlapping blocks per issuer (a
 *    second event whose +/-10-session window overlaps an already-counted event of the same issuer
 *    is dropped, not double-counted). Direction pre-declared NEGATIVE. Clears ONLY if mean +10d
 *    excess is negative at a filing-day-clustered t <= -2.0 AND a PLACEBO — the same issuers, the
 *    same window length, shifted one year earlier, with no vest — is indistinguishable from zero."
 *   searchBarNote: read as one of several candidates, the registry significanceBar applies and
 *   the requirement is |t| >= 3.5, not 2.0. It IS one of six queued candidates, so 3.5 is the
 *   operative number; 2.0 is reported only to show the bar was not renegotiated after the fact.
 *
 * SURVIVORSHIP, disclosed in advance rather than discovered later: the issuer list reaching this
 * script is whatever backend/insider-edgar.js scanned, and that scan iterates universe-expanded.json,
 * which is CURRENT MEMBERSHIP. A name delisted before today is not in the cache at all. This read is
 * backfilled over 2026-05..2026-08 and carries survivorship bias. The direction matters and is
 * stated so it is auditable: dropping delisted names removes losers, which biases measured returns
 * UP — i.e. AGAINST the pre-declared negative direction. It cannot manufacture a pass.
 *
 * Output: backend/data/s12-vest-supply.json
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBarsWithBenchmark } = require("./lib/alpaca-bars");
const { mean, tOf, clusterMeans } = require("./lib/clustered.js");
const D = (f) => path.join(__dirname, "data", f);

const HOLD = 10;                       // sessions, close-to-close
const OVERLAP_SESSIONS = 10;           // "a +/-10-session window overlaps an already-counted event"
const BAR = { minEvents: 150, minFilingDays: 40, direction: "NEGATIVE", tRequired: -2.0, tSearchBar: -3.5 };
const TICKER_OK = /^[A-Z]{1,5}$/;
// FEED. This key is 403 on SIP for DAILY equity bars (verified 2026-08-31), so IEX is the only
// option. An IEX daily close is the last IEX print, not the consolidated official close — noisier
// than SIP, but the stock and the SPY benchmark come from the SAME feed, so the excess is a like
// for like difference and the noise does not carry a direction.
const FEED = "iex";

// Equity round-trip friction, MEASURED — read off the shop's own cost model rather than assumed.
const COST = (() => {
  const c = JSON.parse(fs.readFileSync(D("cost-model.json"), "utf8"));
  const e = c.perClass && c.perClass.Equity;
  if (!e || !Number.isFinite(e.roundTripPct)) throw new Error("cost-model.json has no Equity.roundTripPct — refusing to invent a cost");
  return { roundTripPct: e.roundTripPct, source: e.source };
})();

(async () => {
  // ── 1. events ────────────────────────────────────────────────────────────────
  const cache = JSON.parse(fs.readFileSync(D("edgar-form4-cache.json"), "utf8"));
  let withF = 0, unstamped = 0;
  const raw = [];
  for (const a of Object.keys(cache)) {
    const v = cache[a];
    if (!v || !Array.isArray(v.rows)) continue;
    if (!v.rows.some((r) => r.code === "F")) continue;
    withF++;
    if (!v.sym || !v.filingDate) { unstamped++; continue; }
    if (!TICKER_OK.test(v.sym)) continue;
    const shares = v.rows.filter((r) => r.code === "F").reduce((s, r) => s + (r.shares || 0), 0);
    raw.push({ acc: a, sym: v.sym, filingDate: v.filingDate, shares });
  }
  // ONE event per (issuer, filing day). Several officers of one company vest on one date and file
  // separately; that is one supply event, not five, and counting it five times is the clustering
  // defect this shop has already found four times.
  const byKey = new Map();
  for (const e of raw) {
    const k = e.sym + "|" + e.filingDate;
    const p = byKey.get(k);
    if (p) { p.shares += e.shares; p.filings++; } else byKey.set(k, { sym: e.sym, filingDate: e.filingDate, shares: e.shares, filings: 1 });
  }
  const events = [...byKey.values()].sort((a, b) => (a.filingDate < b.filingDate ? -1 : 1));
  console.log("S12 — " + withF + " filings carry a code-F row; " + unstamped + " unusable (no sym/filingDate stamp — insider-edgar.js:262 stamps only what its 90-day lookback revisits)");
  console.log("  " + raw.length + " stamped F-filings -> " + events.length + " issuer-day events, " + new Set(events.map((e) => e.sym)).size + " issuers");
  if (!events.length) throw new Error("no usable events");

  // ── 2. prices ────────────────────────────────────────────────────────────────
  const tickers = [...new Set(events.map((e) => e.sym))];
  const first = events[0].filingDate;
  // the placebo needs the same window one year earlier, so reach back ~13 months before event one
  const start = new Date(new Date(first + "T00:00:00Z").getTime() - 400 * 86400000).toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);
  console.log("  [prices] SPY + " + tickers.length + " tickers, " + start + ".." + end + " (feed " + FEED + ", adjustment all)");
  const { bars, benchmark: spy, coverage } = await fetchBarsWithBenchmark("SPY", tickers, {
    start, end, timeframe: "1Day", feed: FEED, adjustment: "all", minBars: 200, quiet: true,
  });
  console.log("  [prices] " + coverage.returned.length + "/" + coverage.requested.length + " priced; " + coverage.missing.length + " missing (delisted/unavailable — attrition, recorded)");

  const dOf = (b) => String(b.t).slice(0, 10);
  const spyIdx = new Map(spy.map((b, i) => [dOf(b), i]));
  /** first index STRICTLY AFTER dateStr. Never on it: the filing lands intraday. */
  const after = (arr, dateStr) => arr.findIndex((b) => dOf(b) > dateStr);

  /**
   * COST SIGN — corrected 2026-09-02. Same defect family as the one found in
   * backend/s13-form144.js, swept across every sibling candidate runner.
   *
   * The original line read `excessNet = ret - bench - COST.roundTripPct`, which is the LONG
   * convention. This test's direction is pre-declared NEGATIVE (BAR.direction at line 47): the
   * thesis is that the name UNDERPERFORMS after a vest wave, and the only way to monetize that
   * is to SHORT it. For a short, gross profit is -(ret - bench) and cost is subtracted from
   * THAT, so in this file's "more negative is better" convention the trading cost must move the
   * measured excess TOWARD zero. Subtracting it drove the excess further negative — it counted
   * the cost of trading as if it were part of the edge.
   *
   * In S13, where the effect ran the same way as the hypothesis, this exact sign turned dayMean
   * -0.2431% into -0.4567% and the t from -2.532 to -4.756, manufacturing a "CLEARS" verdict out
   * of a null. Paying to trade can never strengthen a result. The correction is exact rather
   * than approximate because subtracting a constant shifts every day-mean and leaves the
   * variance untouched, so the standard error is identical on both readings — in the stored S12
   * run, 0.5761/1.2703 = 0.45351 gross against 0.2745/0.6053 = 0.45350 net.
   *
   * S12'S VERDICT DOES NOT CHANGE, and the direction of the error is worth stating plainly: this
   * test measured a POSITIVE excess (+0.5761% gross day-mean) against a pre-declared NEGATIVE
   * direction, so the effect already ran opposite to the hypothesis. The wrong sign pulled that
   * number DOWN toward the pass side; correcting it pushes the number further from passing.
   * NOT-ESTABLISHED before, NOT-ESTABLISHED after — the sign flattered a failing test rather
   * than rescuing it.
   *
   * No bar, rule, population or read date was touched. Only the arithmetic was.
   */
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
    return {
      entryDate, exitDate: dOf(b[ei + HOLD]), ret: +ret.toFixed(4), bench: +bench.toFixed(4),
      excessGross: +(ret - bench).toFixed(4), excessNet: +(ret - bench + COST.roundTripPct).toFixed(4), ei,
    };
  }

  // ── 3. non-overlapping blocks per issuer, in filing-date order ───────────────
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
  const filingDays = new Set(kept.map((e) => e.filingDate));
  console.log("  " + kept.length + " events kept on " + filingDays.size + " filing days · " + droppedOverlap.length + " dropped as overlapping · " + unpriced.length + " unpriced");

  // ── 4. the statistic: filing-day clusters, never the row ─────────────────────
  const stat = (rows, field) => {
    // clusterMeans returns { keys, means, k } — the cluster is the FILING DAY, never the row.
    const { means: m } = clusterMeans(rows, (r) => r.filingDate, (r) => r[field]);
    return {
      n: rows.length, days: m.length,
      mean: rows.length ? +mean(rows.map((r) => r[field])).toFixed(4) : null,
      dayMean: m.length ? +mean(m).toFixed(4) : null, t: tOf(m),
    };
  };
  const gross = stat(kept, "excessGross");
  const net = stat(kept, "excessNet");

  // ── 5. THE MANDATORY PLACEBO — same issuers, same window, one year earlier ───
  // S2 died to exactly this omission: its whole effect was reproduced by a cohort with no event.
  const placeboRows = [];
  for (const e of kept) {
    const shifted = new Date(new Date(e.filingDate + "T00:00:00Z").getTime() - 365 * 86400000).toISOString().slice(0, 10);
    const w = win(e.sym, shifted);
    if (w) placeboRows.push(Object.assign({}, e, { filingDate: shifted }, w));
  }
  const placebo = stat(placeboRows, "excessNet");

  // ── 6. sensitivity: the stricter reading of "windows overlap" (20 sessions) ──
  const strict = [], lastStrict = new Map();
  for (const e of events) {
    const w = win(e.sym, e.filingDate); if (!w) continue;
    const prev = lastStrict.get(e.sym);
    if (prev != null && w.ei - prev <= 2 * OVERLAP_SESSIONS) continue;
    lastStrict.set(e.sym, w.ei); strict.push(Object.assign({}, e, w));
  }
  const strictNet = stat(strict, "excessNet");

  // ── 7. verdict, against the bar exactly as written ───────────────────────────
  const sampleMet = kept.length >= BAR.minEvents && filingDays.size >= BAR.minFilingDays;
  const placeboClean = placebo.t == null ? null : Math.abs(placebo.t) < 2.0;
  let verdict;
  if (!sampleMet) verdict = "SAMPLE NOT MET — " + kept.length + "/" + BAR.minEvents + " events on " + filingDays.size + "/" + BAR.minFilingDays + " filing days; no read";
  else if (net.t == null) verdict = "NO STATISTIC — fewer than two filing-day clusters";
  else if (placeboClean === false) verdict = "DEAD BY PLACEBO — the same issuers one year earlier, with no vest, show the same thing (placebo t " + placebo.t + "); whatever this measures, it is not the vest";
  else if (net.t <= BAR.tSearchBar && net.dayMean < 0) verdict = "CLEARS — mean net +10d excess " + net.dayMean + "% at filing-day-clustered t " + net.t + ", past the search bar " + BAR.tSearchBar + ", placebo clean (t " + placebo.t + ")";
  else if (net.t <= BAR.tRequired && net.dayMean < 0) verdict = "DOES NOT CLEAR — t " + net.t + " passes the standalone bar " + BAR.tRequired + " but NOT the search bar " + BAR.tSearchBar + " that applies to a candidate read alongside five others; NOT-ESTABLISHED";
  else verdict = "NOT-ESTABLISHED — mean net +10d excess " + net.dayMean + "% at filing-day-clustered t " + net.t + "; direction was pre-declared NEGATIVE and the operative bar was " + BAR.tSearchBar;

  const out = {
    spec: "S12-vest-supply-v1", proposedOn: "2026-08-27", barFixedOn: "2026-08-27", ranAt: new Date().toISOString(),
    counterparty: "rank-and-file employees receiving vested restricted stock on a date fixed years earlier; undiversified, tax due in the same instant, selling for liquidity and not for a view",
    bar: BAR,
    barIsSearchBar: "YES — S12 is one of six candidates in the alpha-hunt queue, so the registry significanceBar |t| >= 3.5 is the operative number. -2.0 is reported only to show the bar was not renegotiated.",
    survivorship: "backfilled over the cache's dense window (2026-05..2026-08) from universe-expanded.json, which is CURRENT MEMBERSHIP. Delisted names are absent. The bias raises measured returns and therefore works AGAINST the pre-declared negative direction; it cannot manufacture a pass.",
    cost: COST,
    funnel: {
      filingsWithCodeF: withF, unusableNoStamp: unstamped, stampedFilings: raw.length, issuerDayEvents: events.length,
      priced: coverage.returned.length, missing: coverage.missing.length, keptAfterOverlap: kept.length,
      droppedOverlap: droppedOverlap.length, unpriced: unpriced.length, filingDays: filingDays.size,
    },
    primary: net, gross, placebo, sensitivityStrictOverlap: strictNet,
    sampleMet, placeboClean, verdict,
    rows: kept.map((r) => ({ sym: r.sym, filingDate: r.filingDate, entryDate: r.entryDate, exitDate: r.exitDate, filings: r.filings, shares: r.shares, excessNet: r.excessNet })),
  };
  writeJsonAtomic(D("s12-vest-supply.json"), out);
  console.log("\n  GROSS  mean " + gross.mean + "% · day-mean " + gross.dayMean + "% · t " + gross.t + " on " + gross.days + " filing days");
  console.log("  NET    mean " + net.mean + "% · day-mean " + net.dayMean + "% · t " + net.t + "  (short-side round trip: +" + COST.roundTripPct + "% toward zero)");
  console.log("  PLACEBO (same issuers, one year earlier) n " + placebo.n + " · day-mean " + placebo.dayMean + "% · t " + placebo.t);
  console.log("  STRICT OVERLAP (20-session separation) n " + strictNet.n + " · day-mean " + strictNet.dayMean + "% · t " + strictNet.t);
  console.log("\n  " + verdict);
  console.log("written: s12-vest-supply.json");
})().catch((e) => { console.error("S12 FAILED:", e.message); process.exit(1); });
