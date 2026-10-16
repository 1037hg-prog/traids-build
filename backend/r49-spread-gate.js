#!/usr/bin/env node
/**
 * R49 — THE EQUITY SPREAD GATE, READ (registered 2026-08-25, evidence from 2026-08-26).
 *
 * THE REFUSAL ALREADY EXISTS. lib/enforcement-gates.js has refused equity tickets whose live
 * obs.spreadBps exceeds 100 since 2026-08-27, converting each into the house veto-shadow shape
 * (ctrl:true, vetoShadow:true, veto:"R49 spread-gate 100bps"). What was missing was the READER:
 * shadows accrued and nothing graded them. This is that reader. It refuses nothing, changes
 * nothing, and adjudicates the registered bar only.
 *
 * THE POPULATION, and why it is wider than "the shadows". Evidence opened 2026-08-26; enforcement
 * began 2026-08-27. On 08-26 a wide-spread ticket was OPENED rather than shadowed. Those rows are
 * still refusals under the registered rule — the rule is "spreadBps > 100", not "was refused by
 * the wiring" — so the REFUSED arm is every equity row over the threshold, whether it executed
 * before the gate was wired or shadowed after it. Excluding the executed ones would silently
 * discard the arm's earliest and best-resolved evidence.
 *
 *   KEPT      non-ctrl equity, spreadBps <= 100          — the gated book
 *   REFUSED   veto:"R49 …" shadows, PLUS non-ctrl equity with spreadBps > 100 (pre-enforcement)
 *   UNGATED   KEPT + REFUSED                             — the book with no gate at all
 *   excluded  ctrlRand coin-flips, and R53's shadows — different experiments, not this one
 *
 * COST CONVENTION, matching cost-model.js:114 and r56-apply.js exactly:
 *   costR = (obs.spreadBps / 100) / stopPct,  stopPct = 100 * stopDist / entry
 * obs.spreadBps is the ROUND-TRIP quoted spread in bps (cost-model.js:81 states this), so no
 * doubling is applied here. Each ticket uses its OWN stamp over its OWN stop distance — the
 * registration is explicit that a class median is not permitted.
 *
 * STATISTIC (frozen, test-registry.json R49):
 *   PRIMARY   per entry DAY, D = mean costR(UNGATED) − mean costR(KEPT). D >= 0 means the gate
 *             lowered cost. Day-clustered t on D. A day where nothing was refused contributes
 *             D = 0 — a real observation, per lib/clustered.js Convention 2.
 *   PAIRED DIAGNOSTIC (mandatory, the test cannot be read on cost alone)
 *             per entry DAY, G = mean gross rMult(REFUSED) − mean gross rMult(KEPT), on days
 *             where BOTH arms have a settled row. A materially POSITIVE G means the gate buys
 *             cheap execution by cutting the best trades.
 *
 * BAR: 20 entry days, >=150 combined tickets, t >= 1.724 (p95 honest bar, lib/null-bar.js, 1
 * variant at 20 clusters). INTERIM at 10 entry days is KILL-ONLY: if the kept book's mean cost is
 * not lower than the ungated book's, the gate is doing nothing and is retired.
 *
 * LEDGER SOURCE: lib/reconcile.js. This script does NOT read trade_log.json itself — the standing
 * rule since 2026-08-24 is that no analysis picks its own ledger source, and the canonical read
 * carries the epoch filter and the retired-row guard that a hand-rolled filter would miss.
 *
 * Output: data/r49-spread-gate.json
 */
const path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const rc = require("./lib/reconcile.js");
const { mean, clusteredT, pairedClusteredT, etDay } = require("./lib/clustered.js");

const D = (f) => path.join(__dirname, "data", f);
const OUT = D("r49-spread-gate.json");
const EVIDENCE_START = "2026-08-26";
const CUTOFF_BPS = 100;                       // registered, fixed in advance, never tuned here
const BAR = { minEntryDays: 20, minTickets: 150, tRequired: 1.724, interimEntryDays: 10 };

/** costR from a ticket's own stamp over its own stop. Null when either input is absent. */
const costRof = (t) => {
  const bps = t.obs && t.obs.spreadBps;
  if (!Number.isFinite(bps) || !(t.stopDist > 0) || !(t.entry > 0)) return null;
  const stopPct = 100 * t.stopDist / t.entry;
  return stopPct > 0 ? (bps / 100) / stopPct : null;
};
const entryDay = (t) => etDay(t.openedAt);
const inWindow = (t) => t.cls === "Equity" && t.openedAt && entryDay(t) >= EVIDENCE_START;

(() => {
  const L = rc.cleanEraLedger();
  rc.assertReconciled("clean-era pooled edge", rc.recomputeEdge(L), L.pooledEdgeR);   // sources from the canonical read

  // KEPT — what the gated board actually holds.
  const kept = L.signals.filter((t) => inWindow(t) && Number.isFinite(costRof(t)) && t.obs.spreadBps <= CUTOFF_BPS);
  // REFUSED — the gate's own shadows, plus the pre-enforcement rows the rule would have refused.
  const shadows = L.controls.filter((t) => inWindow(t) && t.vetoShadow && /R49/.test(t.veto || "") && Number.isFinite(costRof(t)));
  const preEnforcement = L.signals.filter((t) => inWindow(t) && Number.isFinite(costRof(t)) && t.obs.spreadBps > CUTOFF_BPS);
  const refused = [...shadows, ...preEnforcement];
  const ungated = [...kept, ...refused];

  // ---- PRIMARY: does the gate lower cost, day by day? ---------------------------------------
  // Every day with a kept ticket contributes, D = 0 on days nothing was refused.
  const days = [...new Set(ungated.map(entryDay))].sort();
  const meanCostOn = (rows, d) => { const v = rows.filter((t) => entryDay(t) === d).map(costRof); return v.length ? mean(v) : null; };
  const perDay = days.map((d) => {
    const cu = meanCostOn(ungated, d), ck = meanCostOn(kept, d);
    return { day: d, ungatedCostR: cu, keptCostR: ck, d: cu != null && ck != null ? cu - ck : null,
             nUngated: ungated.filter((t) => entryDay(t) === d).length, nKept: kept.filter((t) => entryDay(t) === d).length };
  }).filter((r) => Number.isFinite(r.d));
  const cost = clusteredT(perDay, (r) => r.day, (r) => r.d);

  // ---- MANDATORY PAIRED DIAGNOSTIC: what did the refused trades DO? --------------------------
  const gross = pairedClusteredT(refused, kept, entryDay, (t) => t.rMult);

  const entryDays = cost.k, nTickets = ungated.length;
  const meanUngated = ungated.length ? mean(ungated.map(costRof)) : null;
  const meanKept = kept.length ? mean(kept.map(costRof)) : null;
  const costFalls = meanUngated != null && meanKept != null && meanKept < meanUngated;

  // ---- verdict --------------------------------------------------------------------------------
  // Read in the registered order: the interim can only KILL, the diagnostic can only REJECT, and
  // a clear needs BOTH the cost line and a refused tail that is not carrying edge.
  let verdict;
  if (entryDays < BAR.interimEntryDays) {
    verdict = `ACCRUING — ${entryDays}/${BAR.minEntryDays} entry days, ${nTickets}/${BAR.minTickets} tickets (${kept.length} kept, ${refused.length} refused)`;
  } else if (!costFalls) {
    verdict = `KILLED AT INTERIM — at ${entryDays} entry days the kept book's mean cost (${meanKept?.toFixed(4)}R) is not lower than the ungated book's (${meanUngated?.toFixed(4)}R); the gate is doing nothing and is retired`;
  } else if (entryDays < BAR.minEntryDays || nTickets < BAR.minTickets) {
    verdict = `ACCRUING — ${entryDays}/${BAR.minEntryDays} entry days, ${nTickets}/${BAR.minTickets} tickets · interim at ${entryDays}: cost IS falling (${meanUngated.toFixed(4)}R -> ${meanKept.toFixed(4)}R), not dead`;
  } else if (gross.t != null && gross.t >= BAR.tRequired) {
    verdict = `REJECTED — the refused tail carries POSITIVE gross edge (${gross.mean}R/ticket, t ${gross.t} across ${gross.k} days). The gate buys cheap execution by cutting the best trades; the THRESHOLD needs revisiting, not the idea`;
  } else if (cost.t != null && cost.t >= BAR.tRequired) {
    verdict = `PASS — a pure cost fix: mean executed cost ${meanUngated.toFixed(4)}R -> ${meanKept.toFixed(4)}R (D ${cost.mean}R/day, t ${cost.t}, ${entryDays} entry days) and the refused tail is not distinguishable on gross rMult (t ${gross.t ?? "n/a"})`;
  } else {
    verdict = `DID NOT PASS — cost D ${cost.mean}R/day at t ${cost.t ?? "n/a"} across ${entryDays} entry days, against the registered ${BAR.tRequired}`;
  }

  /**
   * 2026-09-10 (test-triage COUNT NOT EXPOSED fix). Per the registry's own bar object R49 carries
   * BOTH minEntryDays:20 (the statistic's clustering unit) and minTickets:150 — test-triage.js's
   * field-priority resolver (backend/test-triage.js:133) matches "minTickets" before it would ever
   * look for "minEntryDays" (which is not one of the names it knows), so minTickets:150 is the
   * count the triage tool actually compares against. dailyClock.sessions is therefore nTickets
   * (the UNGATED population size, since evidenceStart by construction of inWindow), not entryDays,
   * so the exposed count matches what the triage tool's `need` will be read against. entryDays is
   * still reported alongside as the statistic's real clustering unit. estimate is the PRIMARY
   * registered statistic (mean daily cost D). bySession is per ENTRY DAY (the statistic's actual
   * unit), from cost.keys/cost.means, which lib/clustered.js already computes.
   */
  const dailyClock = {
    sessions: nTickets,
    estimate: cost.mean,
    unit: "tickets (ungated equity population since evidenceStart) — the registered clustering unit is entry days, reported separately as entryDays",
    entryDays,
  };
  const bySession = (cost.keys || []).map((k, i) => ({ session: k, mean: cost.means[i] }));

  const state = {
    spec: "R49-spread-gate-read-v1", registered: "2026-08-25", evidenceStart: EVIDENCE_START,
    enforcementLive: "2026-08-27 (lib/enforcement-gates.js) — rows from 08-26 were opened, not shadowed, and are counted in the REFUSED arm by RULE",
    cutoffBps: CUTOFF_BPS, bar: BAR, asOf: new Date().toISOString(), dailyClock, bySession,
    population: {
      kept: kept.length, refusedTotal: refused.length, refusedShadows: shadows.length,
      refusedPreEnforcement: preEnforcement.length, ungated: nTickets, entryDays,
      note: "ctrlRand coin-flips and R53 shadows are excluded — different experiments.",
    },
    cost: { meanUngatedCostR: meanUngated == null ? null : +meanUngated.toFixed(4), meanKeptCostR: meanKept == null ? null : +meanKept.toFixed(4),
            meanDailyD: cost.mean, tClustered: cost.t, days: cost.k, falls: costFalls },
    grossDiagnostic: { meanRefusedMinusKept: gross.mean, tClustered: gross.t, daysBothArms: gross.k,
                       meanRefusedR: refused.length ? +mean(refused.map((t) => t.rMult)).toFixed(4) : null,
                       meanKeptR: kept.length ? +mean(kept.map((t) => t.rMult)).toFixed(4) : null },
    perDay, verdict,
  };
  writeJsonAtomic(OUT, state);

  console.log(`R49 SPREAD GATE — ${CUTOFF_BPS}bps, evidence from ${EVIDENCE_START}. Reads shadows; refuses nothing.`);
  console.log(`  kept ${kept.length} · refused ${refused.length} (${shadows.length} shadowed, ${preEnforcement.length} pre-enforcement) · ${entryDays}/${BAR.minEntryDays} entry days · ${nTickets}/${BAR.minTickets} tickets`);
  console.log(`  COST      ungated ${meanUngated == null ? "n/a" : meanUngated.toFixed(4)}R -> kept ${meanKept == null ? "n/a" : meanKept.toFixed(4)}R · D ${cost.mean ?? "n/a"}R/day · t ${cost.t ?? "n/a"} vs ${BAR.tRequired}`);
  console.log(`  GROSS     refused ${state.grossDiagnostic.meanRefusedR ?? "n/a"}R vs kept ${state.grossDiagnostic.meanKeptR ?? "n/a"}R · D ${gross.mean ?? "n/a"}R · t ${gross.t ?? "n/a"} across ${gross.k} day(s) with both arms`);
  console.log(`  ${verdict}`);
  console.log("written: r49-spread-gate.json");
})();
