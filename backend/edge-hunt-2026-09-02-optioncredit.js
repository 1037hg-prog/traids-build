#!/usr/bin/env node
/**
 * EDGE-HUNTER, evening wave 2026-09-02. ONE pre-specified hypothesis, run once.
 *
 * DOMAIN: execution/cost mechanics on the OPTIONS credit-spread program (R21-premium, R25-0dte).
 * This population has never been tested this way. alpha-hunt-costrank.js (2026-08-31) asked
 * whether stopPct ranks net rMult, but it is defined only for equity/futures (stopDist>0) and
 * explicitly excludes every options wing (no stop, defined-risk by strikes instead) -- see
 * lib/options-cost.js and trade-autopsy.js "unattributed" bucket. That test read NO for
 * equity/futures. This test asks the OPTIONS-side analogue with the OPTIONS-side ex-ante variable.
 *
 * HYPOTHESIS (stated before any OOS number is read):
 *   creditPct = obs.creditMid / obs.width -- the fraction of a credit spread max defined loss
 *   captured as premium at entry -- is chosen by the sleeve strike-selection logic BEFORE the
 *   trade is placed. It is a structural entry choice, not a fitted feature: further-OTM strikes
 *   (lower creditPct) are cheaper relative to their own risk and carry a lower breakeven win rate;
 *   closer-to-the-money strikes (higher creditPct) collect more premium but need a higher win rate
 *   to justify it. Standard premium-selling prior, not a price-pattern/chart-shape claim.
 *   PREDICTED DIRECTION: the LOW-creditPct (further-OTM, cheaper-relative-to-risk) arm beats the
 *   HIGH-creditPct (closer-to-the-money) arm in realized net rMult, out of sample.
 *
 * POPULATION: canonical ledger via lib/reconcile.js cleanEraLedger().signals, cls==="Options",
 * strategy in {R21-premium, R25-0dte} -- the two SHORT-PREMIUM credit-spread sleeves. PEAD-manual
 * and Ensemble options rows are directional bets in the same asset class and are excluded per the
 * pooling-audit STRUCTURE-SPLIT rule (premium selling and directional options are not the same
 * instrument). Rows must price as optionsCostR(t).structure==="credit" with finite width/creditMid.
 *
 * METHOD, fixed before results:
 *   split       CHRONOLOGICAL on entry day (ET). Earlier half picks the threshold only.
 *   threshold   in-sample MEDIAN creditPct -- not shopped.
 *   statistic   day-clustered mean rMult, LOW arm minus HIGH arm, out-of-sample, paired on days
 *               where both arms traded that day.
 *   null        permutation, 5000 draws, arm label shuffled WITHIN day x DIRECTION (dir=1 put
 *               spread / dir=-1 call spread) -- a day-only null was already shown on this book to
 *               certify pure long/short asymmetry as skill (reconcile.js).
 *   robustness  episode-collapsed read (key = strategy|openedAt|dir), since these tickets fire in
 *               same-instant baskets and a ticket count is not a sample size.
 *
 * Effective N is SESSIONS (entry days), reported before any t or p.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { cleanEraLedger } = require("./lib/reconcile.js");
const { optionsCostR } = require("./lib/options-cost.js");
const { mean, tOf, clusterMeans, etDay } = require("./lib/clustered.js");
const D = (f) => path.join(__dirname, "data", f);

const DRAWS = 5000;
let seed = 20260902;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const L = cleanEraLedger();
const raw = L.signals.filter((t) => t.cls === "Options" && (t.strategy === "R21-premium" || t.strategy === "R25-0dte"));

const pop = [];
for (const t of raw) {
  const c = optionsCostR(t);
  if (!c || c.structure !== "credit") continue;
  const width = c.maxDefinedLoss, creditMid = t.obs && t.obs.creditMid;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(creditMid)) continue;
  pop.push({
    id: t.id, sym: t.sym, strategy: t.strategy, dir: t.dir > 0 ? "P" : "C",
    day: etDay(t.openedAt), openedAt: t.openedAt, closedAt: t.closedAt,
    rMult: t.rMult, creditPct: +(creditMid / width).toFixed(4),
  });
}
pop.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

const days = [...new Set(pop.map((r) => r.day))].sort();
const cutIdx = Math.floor(days.length / 2);
const cutDay = days[cutIdx];
const IS = pop.filter((r) => r.day < cutDay);
const OOS = pop.filter((r) => r.day >= cutDay);

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const THRESH = median(IS.map((r) => r.creditPct));

function armGap(rows) {
  const low = rows.filter((r) => r.creditPct < THRESH), high = rows.filter((r) => r.creditPct >= THRESH);
  const l = clusterMeans(low, (r) => r.day, (r) => r.rMult);
  const h = clusterMeans(high, (r) => r.day, (r) => r.rMult);
  const hm = new Map(h.keys.map((k, i) => [k, h.means[i]]));
  const diffs = [];
  l.keys.forEach((k, i) => { if (hm.has(k)) diffs.push(l.means[i] - hm.get(k)); });
  return {
    lowN: low.length, highN: high.length,
    lowMeanR: low.length ? +mean(low.map((r) => r.rMult)).toFixed(4) : null,
    highMeanR: high.length ? +mean(high.map((r) => r.rMult)).toFixed(4) : null,
    pairedDays: diffs.length, gap: diffs.length ? +mean(diffs).toFixed(4) : null, t: tOf(diffs), diffs,
  };
}

const isRead = armGap(IS);
const oosRead = armGap(OOS);

function nullDraw(rows) {
  const strata = new Map();
  for (const r of rows) { const k = r.day + "|" + r.dir; (strata.get(k) || strata.set(k, []).get(k)).push(r); }
  const out = [];
  for (const group of strata.values()) {
    const labels = shuffle(group.map((r) => r.creditPct < THRESH));
    group.forEach((r, i) => out.push({ ...r, creditPct: labels[i] ? THRESH - 0.001 : THRESH + 0.001 }));
  }
  return armGap(out).gap;
}
const nulls = [];
for (let i = 0; i < DRAWS; i++) { const g = nullDraw(OOS); if (g != null) nulls.push(g); }
const obs = oosRead.gap;
const pTwo = obs == null || !nulls.length ? null
  : +((nulls.filter((g) => Math.abs(g) >= Math.abs(obs)).length + 1) / (nulls.length + 1)).toFixed(4);

const epKey = (r) => [r.strategy, r.openedAt, r.dir].join("|");
function collapse(rows) {
  const by = new Map();
  for (const r of rows) { const k = epKey(r); (by.get(k) || by.set(k, []).get(k)).push(r); }
  return [...by.values()].map((g) => ({ ...g[0], rMult: mean(g.map((x) => x.rMult)), creditPct: mean(g.map((x) => x.creditPct)), members: g.length }));
}
const isEp = collapse(IS), oosEp = collapse(OOS);
const oosEpRead = armGap(oosEp);

const summary =
  days.length < 10 ? "INSUFFICIENT SESSIONS -- " + days.length + " entry days across the whole population is too thin to split chronologically and read anything; population needs to accrue further before this hypothesis can be tested."
  : obs == null ? "NO STATISTIC -- no out-of-sample day carried both arms"
  : (pTwo != null && pTwo <= 0.05 && obs > 0) ? "LOW creditPct (further-OTM, cheaper-relative-to-risk) PAYS -- beats the near-the-money arm out of sample by " + obs + "R/day at p " + pTwo
  : (pTwo != null && pTwo <= 0.05 && obs < 0) ? "BACKWARDS -- the near-the-money (HIGH creditPct) arm wins out of sample by " + (-obs) + "R/day at p " + pTwo + "; the predicted direction was wrong"
  : "NO -- creditPct does not rank realized net rMult out of sample on this population (gap " + obs + "R/day, day-clustered t " + oosRead.t + ", permutation p " + pTwo + ").";

const out = {
  spec: "edge-hunt-2026-09-02-optioncredit-v1", ranAt: new Date().toISOString(),
  question: "Does creditPct (credit collected / max defined loss, an ex-ante strike-selection choice) rank realized net rMult out of sample on the R21-premium + R25-0dte credit-spread program?",
  predictedDirectionStatedBeforeRead: "LOW creditPct (further OTM) beats HIGH creditPct (closer to money) out of sample.",
  notCircular: "rMult is the raw settled trade result; creditPct is a strike-width/credit ratio fixed at entry from the quoted chain, not derived from directionR or costR. The cost model appears nowhere in the statistic.",
  canonicalLedger: { source: L.source, epoch: L.epoch, settled: L.settled, signals: L.n },
  population: { n: pop.length, strategies: { "R21-premium": pop.filter((r) => r.strategy === "R21-premium").length, "R25-0dte": pop.filter((r) => r.strategy === "R25-0dte").length }, days: days.length, firstDay: days[0], lastDay: days[days.length - 1] },
  effectiveN_sessions: days.length,
  split: { kind: "CHRONOLOGICAL, never random", cutDay, inSampleRows: IS.length, outOfSampleRows: OOS.length, inSampleDays: [...new Set(IS.map((r) => r.day))].length, outOfSampleDays: [...new Set(OOS.map((r) => r.day))].length },
  threshold: { statistic: "in-sample median creditPct", value: +THRESH.toFixed(4), chosenOn: "the in-sample half alone" },
  inSample: { ...isRead, diffs: undefined },
  outOfSample: { ...oosRead, diffs: undefined },
  permutationNull: { draws: nulls.length, stratum: "day x DIRECTION (put/call spread)", seed: 20260902, observedGap: obs, pTwoSided: pTwo, nullMean: nulls.length ? +mean(nulls).toFixed(5) : null },
  episodeRobustness: { inSampleEpisodes: isEp.length, outOfSampleEpisodes: oosEp.length, oosEpisodeGap: oosEpRead.gap, oosEpisodeT: oosEpRead.t, oosEpisodePairedDays: oosEpRead.pairedDays },
  changesNothing: "REPORT-ONLY. No rule, gate, bar or size moved.",
  summary,
};
writeJsonAtomic(D("edge-hunt-2026-09-02-optioncredit.json"), out);

console.log("EDGE HUNT 2026-09-02 -- does creditPct rank net rMult on R21/R25 credit spreads OOS?");
console.log("  population " + pop.length + " rows, " + days.length + " entry days (" + days[0] + ".." + days[days.length - 1] + ")  <- EFFECTIVE N = SESSIONS");
console.log("  split at " + cutDay + " . IS " + IS.length + " rows/" + [...new Set(IS.map((r) => r.day))].length + " days . OOS " + OOS.length + " rows/" + [...new Set(OOS.map((r) => r.day))].length + " days");
console.log("  threshold: in-sample median creditPct " + THRESH.toFixed(4));
console.log("  IN-SAMPLE   low " + isRead.lowMeanR + "R (n" + isRead.lowN + ") vs high " + isRead.highMeanR + "R (n" + isRead.highN + ") . gap " + isRead.gap + "R/day . t " + isRead.t + " on " + isRead.pairedDays + " paired days");
console.log("  OUT-OF-SAMPLE low " + oosRead.lowMeanR + "R (n" + oosRead.lowN + ") vs high " + oosRead.highMeanR + "R (n" + oosRead.highN + ") . gap " + oosRead.gap + "R/day . t " + oosRead.t + " on " + oosRead.pairedDays + " paired days");
console.log("  PERMUTATION NULL (" + nulls.length + " draws, day x direction): p " + pTwo);
console.log("  EPISODE ROBUSTNESS: OOS episodes " + oosEp.length + " . gap " + oosEpRead.gap + " . t " + oosEpRead.t + " on " + oosEpRead.pairedDays + " paired days");
console.log("\n  " + summary);
console.log("written: edge-hunt-2026-09-02-optioncredit.json");
