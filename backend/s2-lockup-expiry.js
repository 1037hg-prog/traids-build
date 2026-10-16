#!/usr/bin/env node
/**
 * S2 — IPO LOCKUP EXPIRY SUPPLY. Frozen 2026-07-28 in data/structural-register.json, candidate
 * S2. This file EXECUTES that frozen spec; nothing here was re-specified after seeing a result.
 *
 * ═══ THE HYPOTHESIS (fixed before this ran) ═══
 *   Counterparty: insiders and early investors who become free to sell on the date the 180-day
 *   lockup fixed in the prospectus expires. They are undiversified, have a liquidity motive
 *   unrelated to fundamental value, and the date and direction of the coming flow are both
 *   public well in advance.
 *   What would stop it: the date is IN THE S-1. Rational anticipation can move the concession
 *   forward of the event, or erase it entirely, before a trader ever sees it.
 *   Written down BEFORE running: "priced in. Any measured effect is likely a small-cap
 *   illiquidity premium in disguise." A PLACEBO (identical window, same names, one year
 *   earlier) is the required instrument to tell the two apart — if the placebo shows the same
 *   effect, the finding is the premium, not the lockup mechanism.
 *
 * ═══ DESIGN, PER THE FROZEN SPEC ═══
 *   universe     Alpha Vantage LISTING_STATUS, BOTH state=active and state=delisted (the
 *                delisted call is what fixes survivorship — see universe-expanded.json's own
 *                warning that current-membership universes drop exactly the failures).
 *   lockup date  ipoDate + 180 CALENDAR days (standard convention, NOT hand-tuned; EDGAR S-1
 *                term-extraction was in scope but not run at this universe size — see
 *                knownWeaknesses). Mis-dating from the convention biases toward the null: a
 *                supply shock measured on the wrong day looks like noise, not signal.
 *   prices       Alpaca SIP daily bars (lib/sip-fetch.js), split/div-adjusted. SIP daily
 *                coverage on this account starts 2016-01-04 (measured empirically below), which
 *                caps how early an episode's window can be priced.
 *   window       -10 to +21 trading days around the lockup date, MARKET-ADJUSTED: excess =
 *                stock buy-and-hold return over the window minus SPY's over the identical dates.
 *                Raw (non-market-adjusted) return was the exact mistake tests #28/#29 made.
 *   episode      one lockup CALENDAR DATE is one observation; several companies unlocking on
 *                the same date average into that one episode (per the frozen spec, verbatim).
 *   clustering   the significanceBar standing rule (test-registry.json) generalizes the R12
 *                lesson: per-episode-day t is inflated whenever an event's holding window
 *                (31 trading days here) is wider than the average spacing between episodes,
 *                which is true in every busy IPO year. The HEADLINE statistic is therefore the
 *                NON-OVERLAPPING BLOCK t (consecutive episodes whose windows touch are merged
 *                into one block before the mean and t are taken); the naive per-episode t is
 *                also reported, labeled explicitly as pre-correction, to show the gap.
 *   OOS          chronological split on episode date: earlier half characterises, later half
 *                judges. The verdict below is read off the TEST (later) half, not the pooled
 *                sample.
 *   placebo      REQUIRED. Same names, same -10/+21 window, centred 365 calendar days earlier
 *                (a date with no lockup). If the placebo t clears the same bar with the same
 *                sign, the result is attributed to the small-cap illiquidity premium, not to
 *                the lockup, and the verdict is DEAD regardless of the real-event statistic.
 *   costs        base assumption 15bp/side (30bp round trip) on top of the entry/exit trade
 *                implied by holding through the window — stated, not assumed away — plus a
 *                sensitivity table at 0/10/20/30/50/75bp round trip, reported not cherry-picked.
 *   bar          single pre-specified hypothesis with a stated mechanism -> |t| >= 2.0
 *                (test-registry.json significanceBar.standingRule.preRegisteredSingleComparison)
 *
 * ═══ KNOWN WEAKNESSES, STATED UP FRONT ═══
 *   1. 180-DAY CONVENTION. Real lockups range ~90-180 days and vary by underwriter; this study
 *      uses one convention for the entire universe rather than reading each S-1. Mis-dated
 *      episodes dilute toward zero; they cannot manufacture a false positive.
 *   2. LISTING TYPE IS NOT DISAMBIGUATED. AV's ipoDate is "first trade date on this exchange",
 *      which also catches OTC-to-NASDAQ uplistings and other non-underwritten listings that may
 *      carry no lockup at all. SPAC-named entities are filtered by a name regex (imperfect);
 *      de-SPAC mergers that renamed the shell before the AV snapshot will leak through.
 *   3. AV DELISTED COVERAGE. Measured below; dense from ~2009 onward, sparse before — reported,
 *      not assumed complete.
 *   4. SIP DAILY HISTORY starts 2016-01-04 on this account. Episodes whose placebo window
 *      (365 days earlier) falls before that date lose their placebo observation more often
 *      than their real-event observation, an asymmetry disclosed rather than patched.
 *   5. FLOOR PRICE >= $3 at entry, matching the floor convention already used elsewhere in this
 *      repo (universe-expanded.json), to keep the mean from being dominated by penny-stock
 *      noise. Applied uniformly, not tuned to the result.
 *
 * Usage:  node backend/s2-lockup-expiry.js               (uses cached AV universe if present)
 *         node backend/s2-lockup-expiry.js --refresh-universe   re-pull LISTING_STATUS
 * Output: backend/data/s2-lockup-expiry.json
 */
"use strict";
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBarsSip } = require("./lib/sip-fetch.js");
const D = (f) => path.join(__dirname, "data", f);
const OUT = D("s2-lockup-expiry.json");
const UNIVERSE_CACHE = D("s2-av-listing-cache.json");
const REFRESH = process.argv.includes("--refresh-universe");

const AV_KEY = process.env.ALPHAVANTAGE_KEY;
const LOCKUP_DAYS = 180;
const ENTRY_OFF = -10, EXIT_OFF = 21;          // trading days relative to the lockup date
const PLACEBO_OFFSET_DAYS = -365;              // calendar days, applied to the lockup date
const FLOOR_PRICE = 3;
const EXCH_ALLOWED = new Set(["NASDAQ", "NYSE", "NYSE MKT", "AMEX"]);
const SYM_RE = /^[A-Z]{1,5}$/;                // plain common tickers only — AV symbols with underscores/digits (e.g. "DTV_1") 400 the Alpaca bars endpoint
const SPAC_RE = /(acquisition corp|acquisition company|acquisition holdings|blank check|special purpose acquisition|\bspac\b)/i;
const INSTR_RE = /\bwarrant|\brights?\b|\bunits?\b|when issued|\bwt\b/i;
const COST_LEVELS_BP = [0, 10, 20, 30, 50, 75];
const BASE_COST_BP = 30;                       // round-trip, stated assumption (15bp/side)

const todayISO = new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const IPO_START = "2015-06-01";
const IPO_END = addDays(todayISO, -(LOCKUP_DAYS + 35));   // lockup must clear 35 cal days before today

// ── t-critical (two-sided, 95%) — small table then normal approximation ─────────────────────
const TCRIT = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  12: 2.179, 15: 2.131, 20: 2.086, 25: 2.060, 30: 2.042 };
function tCrit95(df) {
  if (df <= 0) return NaN;
  if (TCRIT[df]) return TCRIT[df];
  const keys = Object.keys(TCRIT).map(Number).sort((a, b) => a - b);
  for (const k of keys) if (df < k) return TCRIT[k];
  return 1.96;
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sdOf = (a) => { const n = a.length; if (n < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)); };
function stat(values) {
  const n = values.length;
  if (n < 2) return { n, mean: mean(values), sd: null, t: null, ci95: null };
  const m = mean(values), sd = sdOf(values), se = sd / Math.sqrt(n);
  const t = se > 0 ? m / se : null;
  const tc = tCrit95(n - 1);
  return { n, mean: +m.toFixed(4), sd: +sd.toFixed(4), t: t == null ? null : +t.toFixed(4), ci95: t == null ? null : [+(m - tc * se).toFixed(4), +(m + tc * se).toFixed(4)] };
}

// ── AV LISTING_STATUS ────────────────────────────────────────────────────────────────────────
function parseCsv(txt) {
  const lines = txt.trim().split(/\r?\n/);
  const out = [];
  for (const l of lines.slice(1)) {
    const p = l.split(",");
    if (p.length !== 7) continue;
    out.push({ sym: p[0], name: p[1], exch: p[2], type: p[3], ipoDate: p[4], delistingDate: p[5], status: p[6] });
  }
  return out;
}
async function fetchListingStatus(state) {
  const nap = (ms) => new Promise((res) => setTimeout(res, ms));
  let lastTxt = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(`https://www.alphavantage.co/query?function=LISTING_STATUS&state=${state}&apikey=${AV_KEY}`);
    const txt = await r.text();
    if (txt.trim().length >= 100) return parseCsv(txt);
    lastTxt = txt;
    await nap(3000 * (attempt + 1));
  }
  throw new Error(`AV LISTING_STATUS state=${state} returned a suspiciously short body after retries: ${lastTxt.slice(0, 200)}`);
}
async function loadUniverse() {
  if (!REFRESH && fs.existsSync(UNIVERSE_CACHE)) {
    const c = JSON.parse(fs.readFileSync(UNIVERSE_CACHE, "utf8"));
    console.log(`  [universe] loaded cached AV listing snapshot from ${c.fetchedAt} (${c.active.length} active + ${c.delisted.length} delisted) — pass --refresh-universe to re-pull`);
    return c;
  }
  if (!AV_KEY) throw new Error("ALPHAVANTAGE_KEY not set in backend/.env");
  console.log("  [universe] pulling AV LISTING_STATUS state=active ...");
  const active = await fetchListingStatus("active");
  console.log(`  [universe] pulling AV LISTING_STATUS state=delisted ... (${active.length} active rows)`);
  const delisted = await fetchListingStatus("delisted");
  const c = { fetchedAt: new Date().toISOString(), active, delisted };
  fs.writeFileSync(UNIVERSE_CACHE, JSON.stringify(c));
  return c;
}

function delistedCoverageReport(delisted) {
  const dates = delisted.map((r) => r.delistingDate).filter((d) => d && d !== "null").sort();
  const byYear = {};
  for (const d of dates) byYear[d.slice(0, 4)] = (byYear[d.slice(0, 4)] || 0) + 1;
  return { n: dates.length, earliest: dates[0] || null, latest: dates[dates.length - 1] || null, byYear };
}

function buildCandidates(active, delisted) {
  const rows = [...active.map((r) => ({ ...r, state: "active" })), ...delisted.map((r) => ({ ...r, state: "delisted" }))];
  const base = rows.filter((r) =>
    r.type === "Stock" && EXCH_ALLOWED.has(r.exch) && SYM_RE.test(r.sym) &&
    r.ipoDate && r.ipoDate !== "null" && r.ipoDate >= IPO_START && r.ipoDate <= IPO_END &&
    !SPAC_RE.test(r.name) && !INSTR_RE.test(r.name));
  const map = new Map();
  for (const r of base) { if (!map.has(r.sym) || r.state === "active") map.set(r.sym, r); }
  const out = [...map.values()].map((r) => ({ sym: r.sym, name: r.name, ipoDate: r.ipoDate, lockupDate: addDays(r.ipoDate, LOCKUP_DAYS), state: r.state }));
  out.sort((a, b) => a.lockupDate.localeCompare(b.lockupDate));
  return out;
}

// ── bucketing by lockup month, so one fetch window covers a batch of names ──────────────────
function monthKey(iso) { return iso.slice(0, 7); }
function monthBounds(key) {
  const [y, m] = key.split("-").map(Number);
  const start = `${key}-01`;
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const end = addDays(nextMonth, -1);
  return { start, end };
}

function nearestIdxOnOrAfter(series, dateStr) {
  // series sorted ascending by t; linear-ish binary search
  let lo = 0, hi = series.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = String(series[mid].t).slice(0, 10);
    if (d >= dateStr) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans;
}

function windowReturn(series, centerDate, spySeries) {
  const idx = nearestIdxOnOrAfter(series, centerDate);
  if (idx < 0) return null;
  const entryIdx = idx + ENTRY_OFF, exitIdx = idx + EXIT_OFF;
  if (entryIdx < 0 || exitIdx >= series.length) return null;
  const entry = series[entryIdx], exit = series[exitIdx];
  if (!entry || !exit || entry.c < FLOOR_PRICE) return null;
  const entryDate = String(entry.t).slice(0, 10), exitDate = String(exit.t).slice(0, 10);
  const sEntryIdx = nearestIdxOnOrAfter(spySeries, entryDate), sExitIdx = nearestIdxOnOrAfter(spySeries, exitDate);
  if (sEntryIdx < 0 || sExitIdx < 0) return null;
  const spyEntry = spySeries[sEntryIdx], spyExit = spySeries[sExitIdx];
  if (String(spyEntry.t).slice(0, 10) !== entryDate) return null;  // require exact calendar match — no silent nearest-day drift
  const stockRet = exit.c / entry.c - 1, spyRet = spyExit.c / spyEntry.c - 1;
  return { entryDate, exitDate, stockRet, spyRet, excessPct: (stockRet - spyRet) * 100 };
}

// ── non-overlapping block clustering (R12 lesson, generalized in significanceBar) ───────────
// episodes: [{date, meanExcess, exitDate}] sorted by date. Merge any episode whose date falls
// before the running block's latest known exitDate into that block.
function toBlocks(episodes) {
  const sorted = [...episodes].sort((a, b) => a.date.localeCompare(b.date));
  const blocks = [];
  let cur = null, curEnd = null;
  for (const ep of sorted) {
    if (!cur || ep.date > curEnd) { cur = []; blocks.push(cur); curEnd = ep.exitDate; }
    cur.push(ep);
    if (ep.exitDate > curEnd) curEnd = ep.exitDate;
  }
  return blocks.map((b) => ({ start: b[0].date, end: b[b.length - 1].date, nEpisodes: b.length, meanExcess: mean(b.map((e) => e.meanExcess)) }));
}

function splitChrono(episodes) {
  const sorted = [...episodes].sort((a, b) => a.date.localeCompare(b.date));
  const mid = Math.floor(sorted.length / 2);
  return { train: sorted.slice(0, mid), test: sorted.slice(mid) };
}

(async () => {
  console.log("S2 — IPO lockup expiry supply. Frozen spec, executing now.\n");

  const { active, delisted } = await loadUniverse();
  const coverage = delistedCoverageReport(delisted);
  console.log(`  [universe] AV delisted coverage: n=${coverage.n}, earliest=${coverage.earliest}, latest=${coverage.latest}`);
  console.log(`  [universe] delisted-by-year (density check): ${JSON.stringify(coverage.byYear)}\n`);

  const candidates = buildCandidates(active, delisted);
  console.log(`  [universe] ${candidates.length} candidate common-stock IPOs, ${IPO_START}..${IPO_END} (NASDAQ/NYSE/NYSE MKT/AMEX, SPAC- and instrument-name filtered)\n`);

  // SIP daily coverage floor — measured empirically, not assumed
  const probe = await fetchBarsSip(["AAPL"], { start: "2015-01-01", end: "2016-03-01", timeframe: "1Day", minBars: 1, quiet: true });
  const sipStart = probe.bars.AAPL[0] ? String(probe.bars.AAPL[0].t).slice(0, 10) : null;
  console.log(`  [data] SIP daily coverage on this account begins ${sipStart} (probed via AAPL)\n`);

  // SPY once, full span
  console.log("  [data] fetching SPY benchmark, full span ...");
  const spyStart = addDays(IPO_START, PLACEBO_OFFSET_DAYS - 60);
  const spyEnd = addDays(IPO_END, LOCKUP_DAYS + 60);
  const spyRes = await fetchBarsSip(["SPY"], { start: spyStart, end: todayISO > spyEnd ? spyEnd : todayISO, timeframe: "1Day", minBars: 200, quiet: true });
  const spySeries = spyRes.bars.SPY;
  console.log(`  [data] SPY: ${spySeries.length} bars, ${spySeries[0].t.slice(0, 10)}..${spySeries[spySeries.length - 1].t.slice(0, 10)} (effectiveEnd ${spyRes.effectiveEnd})\n`);

  // bucket candidates by lockup month
  const buckets = new Map();
  for (const c of candidates) { const k = monthKey(c.lockupDate); (buckets.get(k) || buckets.set(k, []).get(k)).push(c); }
  const bucketKeys = [...buckets.keys()].sort();
  console.log(`  [fetch] ${bucketKeys.length} monthly buckets to fetch\n`);

  const realRecords = [], placeboRecords = [];
  let noData = 0, floored = 0, fetchErrors = 0;

  for (let bi = 0; bi < bucketKeys.length; bi++) {
    const key = bucketKeys[bi];
    const members = buckets.get(key);
    const { start: mStart, end: mEnd } = monthBounds(key);
    const fetchStart = addDays(mStart, PLACEBO_OFFSET_DAYS - 20);
    const fetchEnd = addDays(mEnd, EXIT_OFF + 20);
    const syms = members.map((m) => m.sym);
    process.stdout.write(`  [fetch] bucket ${bi + 1}/${bucketKeys.length} ${key} (${syms.length} syms) ${fetchStart}..${fetchEnd}          \r`);
    let bars = {};
    try {
      const r = await fetchBarsSip(syms, { start: fetchStart, end: fetchEnd > todayISO ? todayISO : fetchEnd, timeframe: "1Day", minBars: 1, requireAll: false, quiet: true });
      bars = r.bars;
    } catch (e) {
      fetchErrors++;
      console.log(`\n  [fetch] bucket ${key} FAILED: ${e.message}`);
      continue;
    }
    for (const cand of members) {
      const series = bars[cand.sym];
      if (!series || series.length < (EXIT_OFF - ENTRY_OFF + 5)) { noData++; continue; }
      const real = windowReturn(series, cand.lockupDate, spySeries);
      if (!real) { noData++; continue; }
      realRecords.push({ sym: cand.sym, lockupDate: cand.lockupDate, ...real });

      const placeboCenter = addDays(cand.lockupDate, PLACEBO_OFFSET_DAYS);
      const placebo = windowReturn(series, placeboCenter, spySeries);
      if (placebo) placeboRecords.push({ sym: cand.sym, lockupDate: cand.lockupDate, placeboCenter, ...placebo });
    }
  }
  console.log(`\n\n  [fetch] done. ${fetchErrors} bucket errors. realRecords=${realRecords.length} placeboRecords=${placeboRecords.length} (noData/floor skips=${noData})\n`);

  if (realRecords.length < 30) {
    console.log("ABORT: fewer than 30 usable real-event records — the data will not support a verdict here.");
    writeJsonAtomic(OUT, { ranAt: new Date().toISOString(), verdict: "NOT-ESTABLISHED — insufficient data", realRecords: realRecords.length, candidates: candidates.length });
    return;
  }

  // ── group into episodes by lockup calendar date ──────────────────────────────────────────
  function groupEpisodes(records, dateField = "lockupDate") {
    const byDate = {};
    for (const r of records) (byDate[r[dateField]] ||= []).push(r);
    return Object.entries(byDate).map(([date, recs]) => ({
      date, n: recs.length, names: recs.map((r) => r.sym),
      meanExcess: mean(recs.map((r) => r.excessPct)),
      exitDate: recs.map((r) => r.exitDate).sort().pop(),
    })).sort((a, b) => a.date.localeCompare(b.date));
  }
  const realEpisodes = groupEpisodes(realRecords, "lockupDate");
  const placeboEpisodes = groupEpisodes(placeboRecords, "placeboCenter");
  console.log(`  episodes: real=${realEpisodes.length} (from ${realRecords.length} company-records), placebo=${placeboEpisodes.length} (from ${placeboRecords.length})\n`);

  // ── non-overlapping blocks — the headline unit ───────────────────────────────────────────
  const realBlocks = toBlocks(realEpisodes);
  const placeboBlocks = toBlocks(placeboEpisodes);
  console.log(`  blocks (non-overlapping, headline unit): real=${realBlocks.length}, placebo=${placeboBlocks.length}\n`);

  // ── chronological OOS split, on EPISODES (spec says "earlier half / later half") ────────
  const { train: realTrainEp, test: realTestEp } = splitChrono(realEpisodes);
  const realTrainBlocks = toBlocks(realTrainEp), realTestBlocks = toBlocks(realTestEp);

  const realEpisodeStat = stat(realEpisodes.map((e) => e.meanExcess));
  const realBlockStat = stat(realBlocks.map((b) => b.meanExcess));
  const realTrainBlockStat = stat(realTrainBlocks.map((b) => b.meanExcess));
  const realTestBlockStat = stat(realTestBlocks.map((b) => b.meanExcess));
  const placeboEpisodeStat = stat(placeboEpisodes.map((e) => e.meanExcess));
  const placeboBlockStat = stat(placeboBlocks.map((b) => b.meanExcess));

  // ── cost sensitivity (round-trip bp deducted from excess, in percentage points) ─────────
  const costSensitivity = {};
  for (const bp of COST_LEVELS_BP) {
    const net = realBlocks.map((b) => b.meanExcess - bp / 100);
    costSensitivity[`${bp}bp`] = stat(net);
  }
  const netAtBase = costSensitivity[`${BASE_COST_BP}bp`];

  // ── multiplicity: this is ONE pre-specified hypothesis (S2), variants=1 ──────────────────
  let nullBarVerdict = null;
  try {
    const { verdict } = require("./lib/null-bar.js");
    nullBarVerdict = verdict(Math.abs(realTestBlockStat.t || 0), { variants: 1, n: Math.max(3, realTestBlockStat.n) });
  } catch (e) { console.log("  [null-bar] unavailable:", e.message); }

  // ── verdict, per the frozen bar ────────────────────────────────────────────────────────
  const BAR_T = 2.0;
  const testClears = realTestBlockStat.t != null && Math.abs(realTestBlockStat.t) >= BAR_T;
  const placeboAlsoSignificant = placeboBlockStat.t != null && Math.abs(placeboBlockStat.t) >= BAR_T;
  const sameSignAsPlacebo = placeboBlockStat.mean != null && realTestBlockStat.mean != null &&
    Math.sign(placeboBlockStat.mean) === Math.sign(realTestBlockStat.mean);
  const netClearsCost = netAtBase.t != null && Math.abs(netAtBase.t) >= BAR_T;

  let verdict, verdictReason;
  if (realTestBlockStat.n < 5) {
    verdict = "NOT-ESTABLISHED"; verdictReason = `only ${realTestBlockStat.n} non-overlapping test-half blocks — too few to judge`;
  } else if (!testClears) {
    verdict = "NOT-ESTABLISHED"; verdictReason = `test-half block t=${realTestBlockStat.t} does not clear |t|>=${BAR_T}`;
  } else if (placeboAlsoSignificant && sameSignAsPlacebo) {
    verdict = "DEAD"; verdictReason = `test-half clears (t=${realTestBlockStat.t}) but the placebo (same names, 1yr earlier) also clears with the same sign (t=${placeboBlockStat.t}) — this is the pre-written small-cap illiquidity premium, not the lockup`;
  } else if (!netClearsCost) {
    verdict = "NOT-ESTABLISHED"; verdictReason = `clears gross but net of the stated ${BASE_COST_BP}bp round-trip cost, t=${netAtBase.t} does not clear |t|>=${BAR_T}`;
  } else {
    verdict = "CLEARS"; verdictReason = `test-half clears (t=${realTestBlockStat.t}), placebo does not replicate it (t=${placeboBlockStat.t}), net of ${BASE_COST_BP}bp cost still clears (t=${netAtBase.t})`;
  }

  console.log("═".repeat(90));
  console.log(`REAL EVENT — pooled episodes (naive, pre-overlap-correction): n=${realEpisodeStat.n} mean=${realEpisodeStat.mean}% t=${realEpisodeStat.t}`);
  console.log(`REAL EVENT — non-overlapping blocks (HEADLINE): n=${realBlockStat.n} mean=${realBlockStat.mean}% t=${realBlockStat.t} ci95=${JSON.stringify(realBlockStat.ci95)}`);
  console.log(`  TRAIN half (blocks): n=${realTrainBlockStat.n} mean=${realTrainBlockStat.mean}% t=${realTrainBlockStat.t}`);
  console.log(`  TEST  half (blocks, JUDGED): n=${realTestBlockStat.n} mean=${realTestBlockStat.mean}% t=${realTestBlockStat.t} ci95=${JSON.stringify(realTestBlockStat.ci95)}`);
  console.log(`PLACEBO (1yr earlier, same names) — blocks: n=${placeboBlockStat.n} mean=${placeboBlockStat.mean}% t=${placeboBlockStat.t} ci95=${JSON.stringify(placeboBlockStat.ci95)}`);
  console.log(`COST SENSITIVITY (blocks, round-trip bp deducted): ${JSON.stringify(costSensitivity, null, 1)}`);
  if (nullBarVerdict) console.log(`NULL-BAR (variants=1): ${JSON.stringify(nullBarVerdict)}`);
  console.log("═".repeat(90));
  console.log(`VERDICT: ${verdict} — ${verdictReason}`);
  console.log("═".repeat(90));

  const out = {
    spec: "S2 IPO lockup expiry supply v1", registeredAt: "2026-07-28", ranAt: new Date().toISOString(),
    params: { lockupDays: LOCKUP_DAYS, entryOffsetTradingDays: ENTRY_OFF, exitOffsetTradingDays: EXIT_OFF, placeboOffsetCalendarDays: PLACEBO_OFFSET_DAYS, floorPrice: FLOOR_PRICE, ipoDateRange: [IPO_START, IPO_END], exchangesAllowed: [...EXCH_ALLOWED] },
    universe: { candidates: candidates.length, avDelistedCoverage: coverage, sipDailyCoverageBegins: sipStart },
    fetch: { buckets: bucketKeys.length, bucketFetchErrors: fetchErrors, noDataOrFloorSkips: noData },
    counts: { realRecords: realRecords.length, realEpisodes: realEpisodes.length, realBlocks: realBlocks.length, placeboRecords: placeboRecords.length, placeboEpisodes: placeboEpisodes.length, placeboBlocks: placeboBlocks.length },
    real: { pooledEpisodeNaive: realEpisodeStat, blockHeadline: realBlockStat, trainBlocks: realTrainBlockStat, testBlocksJudged: realTestBlockStat },
    placebo: { pooledEpisodeNaive: placeboEpisodeStat, blockHeadline: placeboBlockStat },
    costSensitivityBlocksPct: costSensitivity,
    baseCostAssumptionBp: BASE_COST_BP,
    nullBar: nullBarVerdict,
    bar: { type: "single pre-specified hypothesis with stated mechanism", tRequired: BAR_T },
    verdict, verdictReason,
    knownWeaknesses: [
      "180-calendar-day lockup convention, not read per-filing from each S-1/424B — real terms vary 90-180 days; mis-dating dilutes toward the null, cannot manufacture a positive.",
      "AV ipoDate is first-trade-date, not underwriting-type-aware; OTC uplistings and de-SPAC mergers that already renamed can leak into the universe despite the name-regex filter.",
      "AV delisted coverage is sparse before ~2009 (see universe.avDelistedCoverage.byYear) — not assumed complete at any date.",
      "SIP daily history begins 2016-01-04 on this account; placebo windows (365 days earlier) fail more often than real-event windows for the earliest cohort, an availability asymmetry, not a selection choice.",
      "Market-adjustment is raw excess vs SPY (subtraction), not a beta-adjusted market model — matches the frozen spec's literal instruction.",
    ],
  };
  writeJsonAtomic(OUT, out);
  console.log(`\nwritten: ${OUT}`);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
