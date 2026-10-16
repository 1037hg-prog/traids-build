#!/usr/bin/env node
/**
 * THE BOARD-IMPROVEMENT QUESTION, 2026-08-31 alpha hunt. ONE question, asked and answered.
 *
 * WHY THIS QUESTION AND NOT THE USUAL ONE. The standing instruction is "does any observer separate
 * winners from losers out-of-sample". That ground is searched to death: 18 observer buckets died in
 * the August checkup, 22 offline candidates died before them, and #77 already read NO — SELECTION
 * DOES NOT PAY. Asking it again is how edge-hunter went 4-for-0. Tonight's autopsy says where the
 * money actually goes: direction BEFORE cost +46.05R, cost paid -61.63R, identity holds. The
 * signals are not the problem. So the question is aimed at cost instead.
 *
 * THE QUESTION. costR = (spreadBps/100) / stopPct. Of those two terms only stopPct is observed on
 * this book at scale — obs.spreadBps is stamped on 6% of rows and modelled on the rest, whereas
 * stopDist is on 86%. So the dominant driver of how expensive a ticket is, in R, is 1/stopPct: a
 * TIGHT STOP IS EXPENSIVE, mechanically, because the same spread is a larger fraction of a smaller
 * denominator. stopPct is knowable at the instant of entry and requires no forecast of anything.
 *
 *   Does stopPct — pre-entry, unfitted, forecast-free — rank REALIZED NET rMult?
 *
 * WHY THIS IS NOT CIRCULAR, which is the first objection and it is a good one. directionR is
 * DEFINED as rMult + costR, so any statement about direction is immune to the cost model by
 * construction and worthless. This test never touches directionR. It ranks on stopPct, which is a
 * measured price fact, and scores on rMult, which is measured money. The cost model appears
 * nowhere in the statistic.
 *
 * METHOD, fixed before the numbers were read:
 *   population   canonical ledger via lib/reconcile.js cleanEraLedger(), signals only (controls and
 *                veto shadows are ctrl and already excluded), finite rMult, finite stopDist, entry>0
 *   split        CHRONOLOGICAL on entry day, never random. Earlier half picks the threshold; the
 *                later half is the only thing scored.
 *   threshold    the IN-SAMPLE median stopPct. Chosen on the in-sample half alone; a median is not
 *                a tuned parameter, it is the only split that cannot be shopped.
 *   statistic    day-clustered mean rMult of the WIDE-stop (cheap) arm minus the TIGHT-stop
 *                (expensive) arm, out-of-sample. One observation per entry day per arm.
 *   null         permutation, 5,000 draws, shuffling the arm label WITHIN day x DIRECTION. Day-only
 *                shuffling certified 0.61 of an AUC on this book that turned out to be pure
 *                long/short asymmetry; the direction stratum is not optional here.
 *   robustness   the same read at the EPISODE level (reconcile.episodes), because 898 of 1038 rows
 *                share an open and close instant with others and a day is not always the cluster.
 *
 * This changes no rule and enables no gate. R49 is the registered forward gate on cost and its bar
 * is untouched; this is the retrospective read that says whether R49 is AIMED at the right thing.
 *
 * Output: backend/data/alpha-hunt-costrank.json
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { cleanEraLedger, episodes } = require("./lib/reconcile.js");
const { mean, tOf, clusterMeans, etDay } = require("./lib/clustered.js");
const D = (f) => path.join(__dirname, "data", f);

const DRAWS = 5000;
// Deterministic PRNG: Math.random would make this unreproducible, and a permutation null that
// cannot be re-run is not evidence.
let seed = 20260831;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const L = cleanEraLedger();
// 2026-09-04 (cost lens): options-sleeve.js:324 and zero-dte-sleeve.js:197 set entry === stopDist === creditCross, so stopPct is
// identically 100 for every wing — not a stop distance. 112 wings sat in the WIDE arm (46% of it) on a fictional denominator and
// doubled the apparent effect size (OOS gap -0.0389R -> -0.0167R without them). Excluded with the reason logged, never silently.
const OPTIONS_HAVE_NO_STOP = "cls Options: entry === stopDist === creditCross by construction, stopPct = 100 is an artefact";
const excludedOptions = L.signals.filter((t) => t.cls === "Options").length;
console.log(`  excluded ${excludedOptions} options rows — ${OPTIONS_HAVE_NO_STOP}`);
const pop = L.signals.filter((t) =>
  t.cls !== "Options" &&
  Number.isFinite(t.rMult) && Number.isFinite(t.stopDist) && t.stopDist > 0 &&
  Number.isFinite(t.entry) && t.entry > 0 && t.openedAt
).map((t) => ({
  id: t.id, sym: t.sym, cls: t.cls, dir: t.dir > 0 ? "L" : "S",
  day: etDay(t.openedAt), openedAt: t.openedAt, closedAt: t.closedAt,
  rMult: t.rMult, stopPct: +(100 * t.stopDist / t.entry).toFixed(4),
})).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

const days = [...new Set(pop.map((r) => r.day))].sort();
const cutIdx = Math.floor(days.length / 2);
const cutDay = days[cutIdx];
const IS = pop.filter((r) => r.day < cutDay);
const OOS = pop.filter((r) => r.day >= cutDay);

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const THRESH = median(IS.map((r) => r.stopPct));

/** day-clustered mean-difference between the two arms. One observation per day per arm. */
function armGap(rows) {
  const wide = rows.filter((r) => r.stopPct >= THRESH), tight = rows.filter((r) => r.stopPct < THRESH);
  const w = clusterMeans(wide, (r) => r.day, (r) => r.rMult);
  const t = clusterMeans(tight, (r) => r.day, (r) => r.rMult);
  // Paired on the day where both arms traded — a day with only one arm carries no difference.
  const tm = new Map(t.keys.map((k, i) => [k, t.means[i]]));
  const diffs = [];
  w.keys.forEach((k, i) => { if (tm.has(k)) diffs.push(w.means[i] - tm.get(k)); });
  return {
    wideN: wide.length, tightN: tight.length,
    wideMeanR: wide.length ? +mean(wide.map((r) => r.rMult)).toFixed(4) : null,
    tightMeanR: tight.length ? +mean(tight.map((r) => r.rMult)).toFixed(4) : null,
    pairedDays: diffs.length,
    gap: diffs.length ? +mean(diffs).toFixed(4) : null,
    t: tOf(diffs), diffs,
  };
}

const isRead = armGap(IS);
const oosRead = armGap(OOS);

// ── the null: shuffle the ARM LABEL within day x direction ──────────────────────
// Shuffling stopPct itself would also destroy the size/class structure it is correlated with; the
// label is what the claim is about, so the label is what gets permuted.
function nullDraw(rows) {
  const strata = new Map();
  for (const r of rows) { const k = r.day + "|" + r.dir; (strata.get(k) || strata.set(k, []).get(k)).push(r); }
  const out = [];
  for (const group of strata.values()) {
    const labels = shuffle(group.map((r) => r.stopPct >= THRESH));
    group.forEach((r, i) => out.push({ ...r, stopPct: labels[i] ? THRESH + 1 : THRESH - 1 }));
  }
  return armGap(out).gap;
}
const nulls = [];
for (let i = 0; i < DRAWS; i++) { const g = nullDraw(OOS); if (g != null) nulls.push(g); }
const obs = oosRead.gap;
const pTwo = obs == null || !nulls.length ? null
  : +((nulls.filter((g) => Math.abs(g) >= Math.abs(obs)).length + 1) / (nulls.length + 1)).toFixed(4);

// ── robustness: the episode is the cluster, not the day ─────────────────────────
const EP = (() => {
  try {
    const e = episodes();
    const list = e.signalEpisodes || e.episodes || e.signals || null;
    if (!Array.isArray(list)) return { available: false, why: "reconcile.episodes() did not return an episode array under a key this script knows" };
    return { available: true, n: list.length };
  } catch (err) { return { available: false, why: err.message }; }
})();
// Episode-equivalent done here directly so it does not depend on that shape: collapse rows sharing
// (class, openedAt, closedAt, direction) to one observation, then re-read out-of-sample.
const epKey = (r) => [r.cls, r.openedAt, r.closedAt, r.dir].join("|");
function collapse(rows) {
  const by = new Map();
  for (const r of rows) { const k = epKey(r); (by.get(k) || by.set(k, []).get(k)).push(r); }
  return [...by.values()].map((g) => ({
    ...g[0], rMult: mean(g.map((x) => x.rMult)), stopPct: mean(g.map((x) => x.stopPct)), members: g.length,
  }));
}
const oosEp = armGap(collapse(OOS));

const summary =
  obs == null ? "NO STATISTIC — no out-of-sample day carried both arms"
  : (pTwo != null && pTwo <= 0.05 && obs > 0) ? "WIDE STOPS PAY — the cheap arm beats the expensive arm out of sample by " + obs + "R/day at p " + pTwo
  : (pTwo != null && pTwo <= 0.05 && obs < 0) ? "BACKWARDS — the EXPENSIVE arm wins out of sample by " + (-obs) + "R/day at p " + pTwo + "; the cost lever points the other way"
  : "NO — stop distance does not rank realized net R out of sample (gap " + obs + "R/day, day-clustered t " + oosRead.t + ", permutation p " + pTwo + " against a within-day-x-direction null). The board's selection is not improvable this way.";

const out = {
  spec: "alpha-hunt-costrank-v1", ranAt: new Date().toISOString(),
  question: "Does stop distance as a fraction of entry price — pre-entry, unfitted, forecast-free, and the dominant driver of costR since costR = (spreadBps/100)/stopPct — rank realized net rMult out of sample?",
  whyThisQuestion: "Tonight's autopsy: direction before cost +46.05R vs cost paid -61.63R, identity holds. The signals are not the problem, so a selection question aimed at the signals is aimed at the wrong thing.",
  notCircular: "directionR is DEFINED as rMult + costR and is therefore immune to the cost model. This test never uses it. It ranks on a measured price fact and scores on measured money; the cost model appears nowhere in the statistic.",
  canonicalLedger: { source: L.source, epoch: L.epoch, settled: L.settled, signals: L.n, meanR: L.meanR, pooledEdgeR: L.pooledEdgeR },
  population: { n: pop.length, droppedNoStopDist: L.n - pop.length, days: days.length, firstDay: days[0], lastDay: days[days.length - 1] },
  split: { kind: "CHRONOLOGICAL, never random", cutDay, inSampleRows: IS.length, outOfSampleRows: OOS.length },
  threshold: { statistic: "in-sample median stopPct", valuePct: +THRESH.toFixed(4), chosenOn: "the in-sample half alone" },
  inSample: { ...isRead, diffs: undefined },
  outOfSample: { ...oosRead, diffs: undefined },
  permutationNull: { draws: nulls.length, stratum: "day x DIRECTION", seed: 20260831, observedGap: obs, pTwoSided: pTwo,
    nullMean: nulls.length ? +mean(nulls).toFixed(5) : null,
    why: "a day-only null certified 0.61 of an AUC on this book that was pure long/short asymmetry; the direction stratum is mandatory here" },
  episodeRobustness: { ...oosEp, diffs: undefined, note: "rows sharing (class, openedAt, closedAt, direction) collapsed to one observation before the same read", reconcileEpisodes: EP },
  changesNothing: "REPORT-ONLY. No rule, gate, bar or size moved. R49 is the registered forward cost gate and its bar is untouched.",
  summary,
};
writeJsonAtomic(D("alpha-hunt-costrank.json"), out);

console.log("BOARD-IMPROVEMENT READ — does pre-entry stop distance rank realized net R?");
console.log("  canonical ledger: " + L.settled + " settled, " + L.n + " signals, meanR " + L.meanR + "R");
console.log("  population " + pop.length + " rows over " + days.length + " entry days (" + days[0] + ".." + days[days.length - 1] + ")");
console.log("  chronological split at " + cutDay + " · in-sample " + IS.length + " rows · OOS " + OOS.length + " rows");
console.log("  threshold: in-sample median stopPct " + THRESH.toFixed(3) + "%");
console.log("  IN-SAMPLE   wide " + isRead.wideMeanR + "R (n " + isRead.wideN + ") vs tight " + isRead.tightMeanR + "R (n " + isRead.tightN + ") · gap " + isRead.gap + "R/day · t " + isRead.t + " on " + isRead.pairedDays + " paired days");
console.log("  OUT-OF-SAMPLE wide " + oosRead.wideMeanR + "R (n " + oosRead.wideN + ") vs tight " + oosRead.tightMeanR + "R (n " + oosRead.tightN + ") · gap " + oosRead.gap + "R/day · t " + oosRead.t + " on " + oosRead.pairedDays + " paired days");
console.log("  PERMUTATION NULL (" + nulls.length + " draws, within day x direction): p " + pTwo + " · null mean " + (nulls.length ? mean(nulls).toFixed(5) : "n/a"));
console.log("  EPISODE-COLLAPSED OOS gap " + oosEp.gap + "R/day · t " + oosEp.t + " on " + oosEp.pairedDays + " paired days");
console.log("\n  " + summary);
console.log("written: alpha-hunt-costrank.json");
