#!/usr/bin/env node
/**
 * THE WEEKEND, TESTED PROPERLY. (2026-09-09)
 *
 * WHERE THIS CAME FROM. The paper book's entire clean-era profit turned out to be a scheduling
 * accident: crypto trades 24/7, the settle chain runs an equity calendar, so a FRIDAY crypto entry
 * gets ~3x the holding window of any other weekday. Friday entries: 102 tickets, 70.8h median hold,
 * +$17,405, 14 of the book's 18 crypto targets. Every other weekday: 203 tickets, 7-24h holds,
 * -$6,544 between them. Remove weekend-spanning crypto and the book is -$15,105.
 *
 * That is an artifact of HOW WE TRADE. But it raises a real question the artifact cannot answer:
 * is the crypto weekend itself worth holding? The apparatus stumbled into the exposure by accident;
 * whether the exposure PAYS is a separate, testable claim.
 *
 * WHY THIS IS THE ONE PLACE THE SAMPLE PROBLEM DIES. Every other question on this board is stuck
 * behind 35 sessions and a +0.056R detection floor. This one is answerable on 5.7 years of daily
 * bars — ~296 weekends — because the claim is about the CALENDAR, not about our signals. Effective
 * N goes from 35 to ~296 without waiting a single day.
 *
 * THE DESIGN
 *   WEEKEND leg   buy each symbol at the Friday close, sell at the Monday close (3 calendar days).
 *   CONTROL leg   the same 3-day hold started on every other weekday of that same week, averaged.
 *                 Matched duration is the whole point: "more time in a rising market" is beta, not
 *                 edge, and a duration-matched control removes it by construction.
 *   STATISTIC     the paired per-week difference, weekend minus control, averaged across symbols.
 *   CLUSTERING    THE WEEK. Every symbol shares that weekend's market — a hundred coin-weekends in
 *                 one weekend is one observation, which is the same lesson the fan-out baskets in
 *                 our own ledger taught tonight. n is weeks, never symbol-weeks.
 *   COST          charged on both legs at the MEASURED crypto round trip (31.7bps, worse than the
 *                 0.2% declared, so the honest one). It cancels in the paired difference by design;
 *                 the raw weekend leg is also reported net so "does it make money" is answerable
 *                 separately from "does it beat a matched hold".
 *
 * THIS IS EXPLORATORY AND CARRIES NO WEIGHT. The hypothesis was generated from our own 2026 book,
 * so this is motivating evidence, not a registered result — the house rule is that anything computed
 * after seeing the outcome is disclosed as such and the FORWARD test is what counts. The window our
 * book actually traded (from 2026-07-20) is EXCLUDED from the main read and reported separately, so
 * the number is not simply the thing that generated the hypothesis handed back as confirmation.
 *
 * Usage: node backend/crypto-weekend-study.js [--start 2021-01-01] [--json]
 */
const path = require("path");
const { fetchCryptoBars } = require("./lib/crypto-bars.js");
const { nullBar } = require("./lib/null-bar.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const START = arg("--start", "2021-01-01");
const BOOK_START = "2026-07-20";                 // our own clean era — held out of the main read
const SYMS = ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "ADA/USD", "DOGE/USD", "LINK/USD", "LTC/USD", "AVAX/USD", "DOT/USD"];
const RT_COST_PCT = 0.317;                       // measured crypto round trip, worse than declared

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => { const s = sd(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : NaN; };
const r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : null);

(async () => {
  const data = await fetchCryptoBars(SYMS, "1Day", START, "2026-09-08");
  const have = SYMS.filter((s) => (data[s] || []).length > 100);
  if (!have.length) { console.error("no crypto history returned"); process.exit(1); }

  // index each symbol by UTC date so the same calendar day lines up across coins
  const idx = {};
  for (const s of have) { idx[s] = {}; for (const b of data[s]) idx[s][String(b.t).slice(0, 10)] = b.c; }
  const allDates = [...new Set(have.flatMap((s) => Object.keys(idx[s])))].sort();
  const dowOf = (d) => new Date(d + "T00:00:00Z").getUTCDay();   // 0=Sun .. 5=Fri, 6=Sat

  const ret = (s, d0, d1) => {
    const a = idx[s][d0], b = idx[s][d1];
    return (a && b) ? 100 * (b / a - 1) - RT_COST_PCT : null;    // net of one round trip
  };
  const plus = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

  const weeks = [];
  for (const d of allDates) {
    if (dowOf(d) !== 5) continue;                                 // Friday
    const wkEnd = plus(d, 3);                                     // Monday
    const weekendPer = have.map((s) => ret(s, d, wkEnd)).filter(Number.isFinite);
    if (weekendPer.length < 3) continue;

    // duration-matched controls: every other weekday start in the SAME week, same 3-day hold
    const ctrlPer = [];
    for (const off of [-4, -3, -2, -1]) {                         // Mon, Tue, Wed, Thu of that week
      const c0 = plus(d, off), c1 = plus(c0, 3);
      for (const s of have) { const r = ret(s, c0, c1); if (Number.isFinite(r)) ctrlPer.push(r); }
    }
    if (ctrlPer.length < 6) continue;

    weeks.push({ friday: d, weekend: mean(weekendPer), control: mean(ctrlPer), diff: mean(weekendPer) - mean(ctrlPer), nSyms: weekendPer.length });
  }

  const main = weeks.filter((w) => w.friday < BOOK_START);
  const held = weeks.filter((w) => w.friday >= BOOK_START);

  const report = (label, ws) => {
    if (ws.length < 3) return { label, weeks: ws.length, note: "too few weeks" };
    const diffs = ws.map((w) => w.diff), wknd = ws.map((w) => w.weekend), ctrl = ws.map((w) => w.control);
    const bar = nullBar({ variants: 1, n: ws.length, trials: 20000 }).p95;
    return { label, weeks: ws.length, bar: r3(bar),
      weekendNetPct: r3(mean(wknd)), controlNetPct: r3(mean(ctrl)),
      diffPct: r3(mean(diffs)), t: r3(tOf(diffs)),
      weekendT: r3(tOf(wknd)), winRate: r3(100 * diffs.filter((x) => x > 0).length / diffs.length),
      clears: tOf(diffs) >= bar && mean(diffs) > 0 };
  };

  const out = {
    spec: "crypto-weekend-v1", asOf: new Date().toISOString(), status: "EXPLORATORY — motivating only, carries no weight",
    symbols: have, costRoundTripPct: RT_COST_PCT, clusteringUnit: "week",
    heldOut: { from: BOOK_START, why: "our own book's clean era — the window that generated the hypothesis" },
    main: report(`${START} to ${BOOK_START} (hypothesis-independent)`, main),
    ourWindow: report(`${BOOK_START} onward (in-sample, generated the hypothesis)`, held),
    all: report("whole history", weeks),
  };
  writeJsonAtomic(path.join(__dirname, "data", "crypto-weekend-study.json"), out);
  if (argv.includes("--json")) { console.log(JSON.stringify(out, null, 1)); return; }

  console.log(`\n  CRYPTO WEEKEND — is the exposure our scheduler stumbled into actually worth holding?`);
  console.log(`  ${have.length} symbols · cost ${RT_COST_PCT}% (31.7bp) round trip charged on BOTH legs · clustered on the WEEK\n`);
  console.log(`  ${"window".padEnd(46)}${"wks".padStart(5)}${"weekend".padStart(10)}${"control".padStart(10)}${"diff".padStart(9)}${"t".padStart(8)}${"bar".padStart(7)}`);
  for (const k of ["main", "ourWindow", "all"]) {
    const r = out[k];
    if (r.note) { console.log(`  ${r.label.padEnd(46)}${String(r.weeks).padStart(5)}   ${r.note}`); continue; }
    console.log(`  ${r.label.slice(0, 45).padEnd(46)}${String(r.weeks).padStart(5)}${String(r.weekendNetPct + "%").padStart(10)}${String(r.controlNetPct + "%").padStart(10)}${String(r.diffPct + "%").padStart(9)}${String(r.t).padStart(8)}${String(r.bar).padStart(7)}`);
  }
  const m = out.main;
  console.log(`\n  READ (exploratory, weightless): ${m.clears
    ? `the weekend beats a duration-matched hold by ${m.diffPct}% net, t ${m.t} on ${m.weeks} weeks — worth REGISTERING a forward test.`
    : `the weekend does NOT beat a duration-matched hold (diff ${m.diffPct}%, t ${m.t} vs bar ${m.bar} on ${m.weeks} weeks).`}`);
  console.log(`  The hypothesis came from our own book, so nothing here counts until a forward test is registered and read.`);
})().catch((e) => { console.error("weekend study failed:", e.message); process.exit(1); });
