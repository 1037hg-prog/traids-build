#!/usr/bin/env node
/**
 * R48 — FILER-CLUSTER WEIGHTING ON THE WHALE-OVERLAP COHORT.
 *
 * TWO JOBS, KEPT STRICTLY SEPARATE. Read this before quoting any number out of it.
 *
 *   A. DISPLAY (what runs today). Recomputes the cluster-weighted sleeve over test #70's SEALED
 *      12-name cohort so the allocation is reproducible instead of living in a chat transcript.
 *      This is a MOTIVATING artifact with weight zero. #70's own filer data came from a pasted
 *      aggregator documented in whale-consensus-cohort.js as forensically broken — one manager
 *      shown at ~40x real AUM, puts counted as buyers, quarters mixed. The CLUSTERS derived here
 *      are only as good as that source.
 *
 *   B. EVIDENCE (from 2026-11-15). R48 grades this weighting against name-equal weighting on a
 *      cohort rebuilt from RAW EDGAR 13F-HR originals via best-ideas-13f.js, NOT from the
 *      aggregator. Evidence starts at the next filing window. #70's already-observed period is
 *      never backfilled — that would report the winner of a search already seen.
 *
 * THE PROBLEM IT SOLVES. Equal-weighting twelve names looks like twelve bets and is really 2.5.
 * RenTech appears on 9 of the 12 and Bridgewater on 9 of 12, both jointly on 7 — so those seven
 * move as one disclosure. At name-equal weight the two filers jointly carry 58.3% of gross
 * exposure. Sector diversification does NOT fix it: the RenTech-linked names span four of the six
 * sector ETFs, so rebalancing by sector leaves most of the book keyed to one filer's quarter.
 *
 * THE CONSTRUCTION.
 *   stage 1  equal weight ACROSS filer-overlap clusters (joint / RenTech-only / BW-only / neither)
 *   stage 2  equal weight BY NAME within each cluster
 *   then     cap any correlated COMPLEX at 25% of gross (see COMPLEX_OF below — the return driver,
 *            not the sector label), redistributing the released weight across the uncapped names
 *
 * WHAT IT BUYS AND WHAT IT COSTS, both reported every run and neither hidden: independent bets
 * rise (2.5 -> 3.2, +28%) while effective NAMES fall (12.0 -> 8.8). It is a trade of name
 * diversification for filer diversification. That trade is only right because filer overlap is the
 * concentration the data actually shows and nobody watches, while name concentration is the one
 * everybody already does.
 *
 * THE TWO OBJECTIVES CONFLICT, AND THIS IS THE HONEST CENTRE OF THE WHOLE CONSTRUCTION.
 * Capping the TECH complex at 25% costs 0.6 independent bets: it was 3.8 under the old label-based
 * cap and is 3.2 now, because releasing weight out of tech pushes it into JOINT — 30.0% -> 37.5% —
 * and JOINT is the seven names that move on ONE filing. Lowering visible concentration RAISES
 * hidden concentration. There is no weighting of these twelve names that fixes both, because the
 * cohort only contains four filer clusters; the constraint is the cohort, not the algebra. Both
 * numbers are printed every run so the trade is chosen rather than stumbled into.
 *
 * WHAT IT DOES NOT DO. It does not reduce equity beta. Twelve correlated US large-caps, long-only,
 * one country, no hedge — roughly 3.2 real bets. This is a lowest-hidden-concentration
 * construction available FROM THIS SET; the set is not a low-risk asset class.
 *
 * AND THE COHORT ITSELF HAS NO ESTABLISHED EDGE. Tested 2026-08-25 against 500 random 12-name
 * baskets drawn from the same present-day universe — the control that carries the identical
 * survivorship bias — the cohort's 5-year return landed at the 59th PERCENTILE. Its 23-point
 * outperformance vs SPY is survivorship, not selection. Weighting a set of names well does not make
 * the set worth holding.
 *
 * Nothing here has cleared a bar. #70 is accruing; R48 has no evidence until November.
 *
 * ── AMENDMENT 2026-08-28, PRE-EVIDENCE (R48's evidence leg opens 2026-11-15; nothing has accrued).
 *
 * This file treats filer overlap as a WEIGHTING problem. Measuring it from raw EDGAR shows it is
 * also a GENERATING-PROCESS problem, and that is the larger finding.
 *
 *   RenTech files 3,140 share positions, Bridgewater 997. They JOINTLY HOLD 588 names — 59% of
 *   Bridgewater's entire disclosed book. Coatue, a 66-name book, is 71.2% contained in RenTech's.
 *   Applying #70's own rule (NEW or >= +25%, both filers, corporate actions screened) to the
 *   RenTech x Bridgewater pair qualifies 147 NAMES, not twelve. #70's seven JOINT names are 4.8%
 *   of that set, chosen by the aggregator.
 *
 * So the overlap is a consequence of position count, not of agreement, and #70 is properly read as
 * "did an aggregator's pick of 7 from a 147-name mechanical intersection beat its sectors" — a
 * legitimate sealed test, but never to be reported as a test of whale consensus.
 *
 * CONSEQUENCES FOR THE NOVEMBER REBUILD, recorded now so they are not chosen after seeing results:
 *   - filer clusters become MEASURED from filings across the whole universe, not asserted for 12;
 *   - narrowing 147 names to a cohort IS A SEARCH and owes a best-of-N bar;
 *   - the sharper control is 500 random draws FROM THE 147 — holding the generating process fixed —
 *     alongside the existing 500 random draws from the present-day universe.
 *
 * Extractor: backend/whale-overlap-edgar.js  ·  Note: docs/whale-overlap-finding-2026-08-28.md
 *
 * Usage: node backend/whale-cluster-weight.js [--capital 100000]
 * Output: data/whale-cluster-weight.json
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const OUT = D("whale-cluster-weight.json");
const SECTOR_CAP = 0.25;
/**
 * CAP ON THE CORRELATED COMPLEX, NOT THE SECTOR LABEL (2026-08-25, before any R48 evidence).
 * An outside review caught this: XYZ is Block — Square and Cash App — so its returns track fintech
 * and software, not banks, whatever its XLF tag says. The cap was enforced on the LABEL, bound on
 * SMH at 37.5% and cut it to 25 — and never saw XYZ at all. Real correlated-tech exposure was 40%,
 * not the 25% the sector table displayed. Mapping a name to its RETURN DRIVER rather than its
 * classification is the whole point of a concentration cap; a cap that a relabelling can evade is
 * not a cap. Same principle as the filer clustering: group by what moves together.
 */
const COMPLEX_OF = { SMH: "TECH", XLK: "TECH", XLE: "ENERGY", XOP: "ENERGY" };
const OVERRIDE = { XYZ: "TECH" };   // Block: fintech/software beta, not bank beta
const complexOf = (p) => OVERRIDE[p.sym] || COMPLEX_OF[p.etf] || p.etf;
const CAPITAL = (() => { const i = process.argv.indexOf("--capital"); return i > 0 ? +process.argv[i + 1] : 100000; })();

/** Cluster a name by WHICH of the two dominant filers hold it. The two dominant filers are not
 *  hardcoded by preference — they are whichever appear on the most names, computed below. */
function dominantPair(picks) {
  const count = {};
  for (const p of picks) for (const f of String(p.who).split(/·|,/)) {
    const name = f.trim().split(/\s+(new|add|\+)/)[0].trim();
    if (name) count[name] = (count[name] || 0) + 1;
  }
  return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => ({ filer: k, n: v }));
}

const coh = JSON.parse(fs.readFileSync(D("whale-consensus-cohort.json"), "utf8"));
const picks = coh.picks.map((p) => ({ ...p }));
const [f1, f2] = dominantPair(picks);
const has = (p, f) => new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(p.who);
for (const p of picks) {
  const a = has(p, f1.filer), b = has(p, f2.filer);
  p.cluster = a && b ? "JOINT" : a ? `${f1.filer}-only` : b ? `${f2.filer}-only` : "neither";
}

const groups = {};
for (const p of picks) (groups[p.cluster] ||= []).push(p);
const nClusters = Object.keys(groups).length;
for (const g of Object.keys(groups)) for (const p of groups[g]) p.w = (1 / nClusters) / groups[g].length;

// sector cap, with the released weight redistributed proportionally over the uncapped names
const bySec = {};
for (const p of picks) (bySec[complexOf(p)] ||= []).push(p);
const capsBound = [];
for (const [etf, arr] of Object.entries(bySec)) {
  const tot = arr.reduce((s, p) => s + p.w, 0);
  if (tot <= SECTOR_CAP) continue;
  const k = SECTOR_CAP / tot;
  for (const p of arr) { p.capped = true; p.w *= k; }
  const released = tot - SECTOR_CAP;
  const free = picks.filter((p) => !p.capped), freeSum = free.reduce((s, p) => s + p.w, 0);
  for (const p of free) p.w += released * (p.w / freeSum);
  capsBound.push({ complex: etf, before: +(100 * tot).toFixed(1), after: 25, releasedPct: +(100 * released).toFixed(1) });
}

const hhi = (ws) => ws.reduce((s, w) => s + w * w, 0);
const eqW = 1 / picks.length;
const eqClusterHHI = hhi(Object.values(groups).map((a) => a.length * eqW));
const rows = picks.map((p) => ({ sym: p.sym, sector: p.etf, cluster: p.cluster, weightPct: +(100 * p.w).toFixed(2), usd: Math.round(p.w * CAPITAL), who: p.who }))
  .sort((a, b) => b.weightPct - a.weightPct);

const out = {
  spec: "R48-cluster-weight-v1", builtAt: new Date().toISOString(),
  SCOPE: "DISPLAY/MOTIVATING, weight zero. R48's EVIDENCE starts 2026-11-15 on a cohort rebuilt from RAW EDGAR, not from #70's aggregator. Nothing here has cleared a bar.",
  source: { cohort: "whale-consensus-cohort.json (#70)", sealed: coh.sealed, sealedAt: coh.sealedAt,
    sourceWarning: "#70's filer data came from a pasted aggregator documented as forensically broken (a manager at ~40x real AUM, puts counted as buyers, quarters mixed). Clusters are only as good as that source — which is precisely why R48 rebuilds from EDGAR." },
  capital: CAPITAL, sectorCap: SECTOR_CAP, dominantFilers: [f1, f2], capsBound,
  allocation: rows,
  bySector: Object.fromEntries(Object.entries(bySec).map(([e, a]) => [e, +(100 * a.reduce((s, p) => s + p.w, 0)).toFixed(1)]).sort((x, y) => y[1] - x[1])),
  byCluster: Object.fromEntries(Object.entries(groups).map(([g, a]) => [g, +(100 * a.reduce((s, p) => s + p.w, 0)).toFixed(1)])),
  effectiveN: {
    namesEqualWeight: +(1 / hhi(picks.map(() => eqW))).toFixed(1),
    namesClusterWeight: +(1 / hhi(picks.map((p) => p.w))).toFixed(1),
    independentBetsEqualWeight: +(1 / eqClusterHHI).toFixed(1),
    independentBetsClusterWeight: +(1 / hhi(Object.values(groups).map((a) => a.reduce((s, p) => s + p.w, 0)))).toFixed(1),
    reading: "Independent bets RISE and effective names FALL. That is the trade, stated both ways so neither half is hidden: name diversification is exchanged for filer diversification.",
  },
  doesNotDo: "Does not reduce equity beta. Twelve correlated US large-caps, long-only, one country, no hedge. Lowest-hidden-concentration construction available FROM THIS SET; the set is not a low-risk asset class.",
  // 2026-09-10 NO COUNTABLE BAR fix: R48's OWN evidence leg has not opened (evidenceStart 2026-11-15, the
  // next 13F filing window) — this script only recomputes the DISPLAY/MOTIVATING sleeve over #70's already-
  // sealed cohort, weight zero, and has no cohort-accrual loop at all. dailyClock.sessions is honestly 0:
  // no quarterly filer-cluster cohort has accrued under R48's own rule yet. Do not backfill this from #70's
  // already-observed period — that would report the winner of a search already seen (see registry rule).
  dailyClock: { sessions: 0, unit: "quarterly filer-cluster cohorts since evidenceStart (2026-11-15, not yet reached)", estimate: null },
};
writeJsonAtomic(OUT, out);

console.log(`WHALE CLUSTER-WEIGHT SLEEVE — $${CAPITAL.toLocaleString()}  (DISPLAY ONLY, weight zero)`);
console.log(`  dominant filers: ${f1.filer} on ${f1.n}/${picks.length}, ${f2.filer} on ${f2.n}/${picks.length}`);
for (const c of capsBound) console.log(`  complex cap bound on ${c.complex}: ${c.before}% -> ${c.after}%, released ${c.releasedPct}%`);
console.log("\n  sym    sector  cluster              weight        $");
for (const r of rows) console.log(`  ${r.sym.padEnd(6)} ${r.sector.padEnd(6)} ${r.cluster.padEnd(19)} ${String(r.weightPct.toFixed(2)).padStart(6)}%  ${("$" + r.usd.toLocaleString()).padStart(9)}`);
console.log("\n  sectors  " + Object.entries(out.bySector).map(([e, v]) => `${e} ${v}`).join("  "));
console.log("  clusters " + Object.entries(out.byCluster).map(([e, v]) => `${e} ${v}%`).join("  "));
const e = out.effectiveN;
console.log(`\n  independent bets  ${e.independentBetsEqualWeight} -> ${e.independentBetsClusterWeight}   (+${Math.round(100 * (e.independentBetsClusterWeight / e.independentBetsEqualWeight - 1))}%)`);
console.log(`  effective names   ${e.namesEqualWeight} -> ${e.namesClusterWeight}`);
console.log("written: whale-cluster-weight.json");
