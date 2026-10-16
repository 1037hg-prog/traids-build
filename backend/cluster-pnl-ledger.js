#!/usr/bin/env node
/**
 * CLUSTER-LEVEL P&L LEDGER — the correlation-cartographer's standing instrument.
 *
 * WHY THIS EXISTS. R53 (one factor is one bet) is the primary lever on the board's biggest
 * defect — the shop has now found "many tickets, one decision" FOUR times (twelve alt-coins at
 * exactly +2.00R, a congressional-trade result that collapsed at t=12, sixteen simultaneous
 * crypto names carrying the whole pooled edge, and REGN/BDX/DGX same-instant on 2026-08-27,
 * which is what finally got R53 wired into a live refusal gate) — and until this file, R53 had
 * live shadow-grading (backend/r53-factor-cap.js) but no PER-CLUSTER LEDGER: no way to look at
 * one factor bet at a time and see its gross risk, its net direction, its realized R, and
 * whether the cap would have bound. This file is that ledger. It is a MOTIVATING/DIAGNOSTIC
 * instrument, retroactive over history — it does NOT replace backend/r53-factor-cap.js, which
 * is the live forward-accruing evidential test. Per project rule, anything computed by
 * inspecting existing data carries weight zero as evidence; this file is read alongside the
 * live shadow grade, never instead of it.
 *
 * TAXONOMY — FROZEN BEFORE THE EVIDENCE (cluster-taxonomy-v1). Re-cutting cluster boundaries
 * after seeing which grouping looks worst is the exact post-hoc error this shop exists to
 * avoid, so both cluster TYPES below are anchored to code that was frozen for an unrelated
 * reason before this file was written, not tuned by this file:
 *
 *   TYPE A "temporal-episode"  confidence 1.00 (definitional, no inference)
 *     Exactly backend/lib/reconcile.js `episodes()`'s own key: same asset class, same openedAt
 *     (to the millisecond), same closedAt, same direction sign. Two tickets in the same episode
 *     were ONE decision, booked N times, by construction — there is nothing to estimate.
 *
 *   TYPE B "factor-group"  confidence 0.85 (registered taxonomy + one analytic judgment)
 *     Built on backend/lib/enforcement-gates.js `groupTokens()` — the R53 REGISTRATION's own
 *     factor groups (same-currency FX crosses same side, same-complex futures, same-sector
 *     equity by identical sector ETF, crypto majors one group / alt-coins one group), imported
 *     verbatim, never restated. Two tickets sharing a token are candidates for the same bet
 *     regardless of their direction label (crypto/equity tokens carry no direction at all,
 *     which is deliberate: "two positions with opposite labels and identical factor loading are
 *     one bet"). The one judgment this file adds: tickets sharing a token are chained into one
 *     cluster only while consecutive entries are <=24h apart (the same width as R53's registered
 *     cap window); a gap longer than that starts a new cluster instance of the same factor. That
 *     boundary is why confidence is 0.85, not 1.00 — the token is measured, the chaining width is
 *     a stated, reused convention (matches R53's own window), not fit to this data.
 *   A ticket carrying no token (Options wings, unsectored equities) cannot be placed in a
 *   factor-group and is reported independent for that view. This is a data gap, not a claim of
 *   zero correlation, and is stated as such below.
 *
 * A ticket may be a member of a temporal-episode cluster, a factor-group cluster, both, or
 * neither. The four P&L views make the unit-of-analysis choice explicit rather than picking one
 * silently:
 *   ticket-level          every settled signal ticket is its own observation (naive; contrast only)
 *   independent-episode   backend/lib/reconcile.js episodes() directly — one observation per
 *                          same-instant basket, called (not reimplemented) so this file cannot drift
 *                          from the canonical de-clustering
 *   factor-cluster         one observation per CONNECTED COMPONENT of shared factor-group tokens
 *                          (union-find over 24h-chained token segments) — "one factor is one bet,
 *                          however many tickets, however many DIFFERENT tokens link them"
 *   session-clustered      one observation per ET calendar day of closedAt, via lib/clustered.js
 *
 * R53 RETROACTIVE ADMISSION SIMULATION. One single pass over the WHOLE clean-era signal book in
 * chronological (openedAt) order, per token: a candidate is admitted iff no ticket already
 * admitted under that SAME token has an openedAt within the trailing 24h; otherwise it is a
 * simulated refusal. This mirrors backend/lib/enforcement-gates.js evaluateGates()'s R53 branch
 * exactly (recent24h = admitted tickets opened in the trailing 24h sharing a token), run once,
 * globally, so every cluster row's wouldR53HaveCapped / rIfCapped comes from the SAME simulation
 * rather than being re-derived per cluster and risking drift.
 *
 * Effective N for every reported statistic is CLUSTERS or SESSIONS, never tickets.
 * Concentration, where reported, is always a share of ABSOLUTE R, never net R.
 *
 * Output: backend/data/cluster-pnl-ledger.json
 */
"use strict";
const path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const rc = require("./lib/reconcile.js");
const { groupTokens } = require("./lib/enforcement-gates.js");
const { tOf, etDay, clusteredT } = require("./lib/clustered.js");

const D = (f) => path.join(__dirname, "data", f);
const OUT = D("cluster-pnl-ledger.json");
const TAXONOMY_VERSION = "cluster-taxonomy-v1";
const DAY_MS = 24 * 60 * 60 * 1000;

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const sd = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const r4 = (x) => (x == null ? null : +x.toFixed(4));

// ---- risk-dollar proxy: the realized $-per-R for a ticket. Stop-based sizing means this is
// constant regardless of outcome for a clean stop; for a gap-stop it understates the PLANNED
// risk (the plan was 1R, the fill was worse) — flagged wherever used, never silently assumed.
const riskDollars = (t) => (Number.isFinite(t.pnl) && Number.isFinite(t.rMult) && t.rMult !== 0 ? Math.abs(t.pnl / t.rMult) : null);

// =====================================================================================
// TYPE A — temporal-episode clusters (built independently of, but reconciled against,
// backend/lib/reconcile.js episodes())
// =====================================================================================
function episodeKey(t) {
  return `${t.cls || "?"}|${t.openedAt}|${t.closedAt}|${t.dir > 0 ? "L" : "S"}`;
}

function buildTemporalEpisodes(signals) {
  const by = new Map();
  for (const t of signals) {
    const k = episodeKey(t);
    (by.get(k) || by.set(k, []).get(k)).push(t);
  }
  return [...by.entries()].map(([key, members]) => ({ key, members }));
}

// =====================================================================================
// TYPE B — factor-group clusters: per-token 24h-gap chaining, then union-find across tokens
// so a ticket carrying >1 token (FX legs) collapses its group memberships into one bet.
// =====================================================================================
function buildFactorGroups(signals) {
  // per-token chronological chains, split whenever the gap to the previous ticket in that
  // token exceeds 24h
  const byToken = new Map();
  for (const t of signals) {
    const toks = groupTokens(t);
    for (const tok of toks) (byToken.get(tok) || byToken.set(tok, []).get(tok)).push(t);
  }
  const tokenSegments = []; // { token, members: [] }
  for (const [tok, list] of byToken) {
    const sorted = [...list].sort((a, b) => a.openedAt - b.openedAt);
    let seg = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].openedAt - sorted[i - 1].openedAt <= DAY_MS) seg.push(sorted[i]);
      else { tokenSegments.push({ token: tok, members: seg }); seg = [sorted[i]]; }
    }
    tokenSegments.push({ token: tok, members: seg });
  }

  // union-find over tickets: two tickets are unioned if they co-occur in the same token segment
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const t of signals) if (!parent.has(t.id)) parent.set(t.id, t.id);
  for (const seg of tokenSegments) for (let i = 1; i < seg.members.length; i++) union(seg.members[0].id, seg.members[i].id);

  const byId = new Map(signals.map((t) => [t.id, t]));
  const components = new Map();
  for (const t of signals) {
    const r = find(t.id);
    (components.get(r) || components.set(r, []).get(r)).push(t);
  }

  // per-token segments with >=2 members are the reported LEDGER ROWS (one row per token
  // instance, e.g. crypto:alt on 08-19/08-20 is a different row from crypto:alt on 08-24/08-25)
  const rows = tokenSegments.filter((s) => s.members.length >= 1);
  return { tokenSegments: rows, components: [...components.values()], byId };
}

// =====================================================================================
// R53 retroactive admission simulation — ONE global pass, chronological, per token.
// =====================================================================================
function simulateR53(signals) {
  const admittedAt = new Map(); // token -> sorted array of openedAt for ADMITTED tickets
  const admitted = new Map(); // ticket id -> boolean
  const sorted = [...signals].sort((a, b) => a.openedAt - b.openedAt);
  for (const t of sorted) {
    const toks = groupTokens(t);
    if (!toks.length) { admitted.set(t.id, true); continue; } // no token => nothing to cap against
    let refused = false;
    for (const tok of toks) {
      const hist = admittedAt.get(tok) || [];
      if (hist.some((ts) => t.openedAt - ts <= DAY_MS && t.openedAt - ts >= 0)) { refused = true; break; }
    }
    admitted.set(t.id, !refused);
    if (!refused) for (const tok of toks) (admittedAt.get(tok) || admittedAt.set(tok, []).get(tok)).push(t.openedAt);
  }
  return admitted;
}

// =====================================================================================
// MAIN
// =====================================================================================
(() => {
  const L = rc.cleanEraLedger();
  rc.assertReconciled("clean-era pooled edge (cluster ledger input)", rc.recomputeEdge(L), L.pooledEdgeR);
  const signals = L.signals.filter((t) => Number.isFinite(t.openedAt) && Number.isFinite(t.closedAt));

  const admitted = simulateR53(signals);

  // ---------------- ticket-level view ----------------
  const ticketRs = signals.map((t) => t.rMult);
  const ticketLevel = {
    unit: "ticket", n: signals.length, aggregateR: r4(sum(ticketRs)), meanR: r4(mean(ticketRs)),
    sd: r4(sd(ticketRs)), t: r4(tOf(ticketRs)),
    note: "the naive count, shown only to be contrasted with the three views below",
  };

  // ---------------- independent-episode view (via reconcile.js episodes(), called not reimplemented) ----------------
  const canonEpisodes = rc.episodes(signals);
  const epRs = canonEpisodes.map((e) => e.rMult);
  const independentEpisode = {
    unit: "episode (lib/reconcile.js episodes())", n: canonEpisodes.length,
    aggregateR: r4(sum(epRs)), meanR: r4(mean(epRs)), sd: r4(sd(epRs)), t: r4(tOf(epRs)),
    ticketToEpisodeInflation: canonEpisodes.length ? +(signals.length / canonEpisodes.length).toFixed(2) : null,
  };

  // ---------------- factor-cluster view (union-find components over factor-group tokens) ----------------
  const { tokenSegments, components } = buildFactorGroups(signals);
  const compRs = components.map((mem) => mean(mem.map((t) => t.rMult)));
  const factorCluster = {
    unit: "factor-cluster (connected component of R53 factor-group tokens, one observation per component)",
    n: components.length, aggregateR: r4(sum(compRs)), meanR: r4(mean(compRs)), sd: r4(sd(compRs)), t: r4(tOf(compRs)),
    ticketToClusterInflation: components.length ? +(signals.length / components.length).toFixed(2) : null,
    ticketsWithNoFactorToken: signals.length - [...new Set(tokenSegments.flatMap((s) => s.members.map((m) => m.id)))].length,
  };

  // R53-admitted-only twin (what the book would have realized, ticket-for-ticket, if the cap had
  // bound retroactively across all of history) — reported alongside, both tails included
  const admittedTickets = signals.filter((t) => admitted.get(t.id));
  const refusedTickets = signals.filter((t) => !admitted.get(t.id));
  const r53Retroactive = {
    note: "RETROACTIVE, MOTIVATING ONLY — not evidence. The live forward test is backend/r53-factor-cap.js (shadow-graded since 2026-08-27, currently ACCRUING).",
    admitted: { n: admittedTickets.length, aggregateR: r4(sum(admittedTickets.map((t) => t.rMult))) },
    refused: { n: refusedTickets.length, aggregateR: r4(sum(refusedTickets.map((t) => t.rMult))),
      lossesAvoided: r4(sum(refusedTickets.filter((t) => t.rMult < 0).map((t) => t.rMult))),
      gainsForegone: r4(sum(refusedTickets.filter((t) => t.rMult > 0).map((t) => t.rMult))) },
    netEffectOfCap_R: r4(sum(refusedTickets.map((t) => t.rMult)) * -1),
  };

  // ---------------- session-clustered view (day as the unit, via lib/clustered.js) ----------------
  const sessStat = clusteredT(signals, (t) => etDay(t.closedAt), (t) => t.rMult);
  const perSession = sessStat.keys.map((k, i) => ({ day: k, meanR: r4(sessStat.means[i]), n: sessStat.sizes[i] }));
  const sessionClustered = {
    unit: "session (closedAt ET calendar day, lib/clustered.js clusteredT)", n: sessStat.k,
    aggregateR: r4(sum(ticketRs)), meanRperSession: r4(sessStat.mean), sdAcrossSessions: r4(sd(sessStat.means)), t: sessStat.t,
    note: "aggregateR is unchanged from ticket-level because sessions partition every ticket exactly once; what changes is the EFFECTIVE N used for significance (sessions, not tickets) and the visible session-to-session variance.",
    perSession,
  };

  // ================= CLUSTER LEDGER ROWS =================
  const clusters = [];
  let epN = 0;
  for (const { key, members } of buildTemporalEpisodes(signals)) {
    if (members.length < 2) continue;
    epN++;
    const rMults = members.map((m) => m.rMult);
    const risks = members.map(riskDollars).filter(Number.isFinite);
    const admittedN = members.filter((m) => admitted.get(m.id)).length;
    const worstConcurrent = sum(rMults.filter((r) => r < 0)); // proxy, see note below
    clusters.push({
      clusterId: `EP-${String(epN).padStart(4, "0")}`,
      clusterType: "temporal-episode",
      clusterConfidence: 1.0,
      commonDriver: `same-instant basket (${members[0].cls}, ${members[0].dir > 0 ? "long" : "short"}, opened ${new Date(members[0].openedAt).toISOString()})`,
      componentTickets: members.map((m) => ({ id: m.id, sym: m.sym, rMult: r4(m.rMult), admittedUnderR53: admitted.get(m.id) })),
      componentCount: members.length,
      grossPlannedRisk: { rUnits: members.length, dollars: risks.length ? +sum(risks).toFixed(2) : null, dollarsCoverage: `${risks.length}/${members.length}` },
      netDirectionalExposure: { rUnitsNet: +sum(members.map((m) => m.dir)).toFixed(2), dollarsNet: risks.length ? +sum(members.map((m) => (Number.isFinite(riskDollars(m)) ? m.dir * riskDollars(m) : 0))).toFixed(2) : null },
      realizedAggregateR: r4(mean(rMults)),
      worstConcurrentAdverseExcursion: { approxR: r4(worstConcurrent), coverage: `${members.length}/${members.length}`, note: "proxy = sum of each losing member's own realized R, i.e. the drawdown if every losing leg's worst point coincided; not a verified simultaneous-timestamp MAE (not present in this ledger) -- approximation, flagged" },
      wouldR53HaveCapped: admittedN < members.length,
      rIfCapped: r4(sum(members.filter((m) => admitted.get(m.id)).map((m) => m.rMult))),
    });
  }
  let fgN = 0;
  for (const { token, members } of tokenSegments) {
    if (members.length < 2) continue;
    fgN++;
    const rMults = members.map((m) => m.rMult);
    const risks = members.map(riskDollars).filter(Number.isFinite);
    const admittedN = members.filter((m) => admitted.get(m.id)).length;
    const worstConcurrent = sum(rMults.filter((r) => r < 0));
    clusters.push({
      clusterId: `FG-${String(fgN).padStart(4, "0")}`,
      clusterType: "factor-group",
      clusterConfidence: 0.85,
      commonDriver: token,
      componentTickets: members.map((m) => ({ id: m.id, sym: m.sym, rMult: r4(m.rMult), openedAt: new Date(m.openedAt).toISOString(), admittedUnderR53: admitted.get(m.id) })),
      componentCount: members.length,
      grossPlannedRisk: { rUnits: members.length, dollars: risks.length ? +sum(risks).toFixed(2) : null, dollarsCoverage: `${risks.length}/${members.length}` },
      netDirectionalExposure: { rUnitsNet: +sum(members.map((m) => m.dir)).toFixed(2), dollarsNet: risks.length ? +sum(members.map((m) => (Number.isFinite(riskDollars(m)) ? m.dir * riskDollars(m) : 0))).toFixed(2) : null },
      realizedAggregateR: r4(mean(rMults)),
      worstConcurrentAdverseExcursion: { approxR: r4(worstConcurrent), coverage: `${members.length}/${members.length}`, note: "proxy = sum of each losing member's own realized R -- approximation, flagged; see temporal-episode rows for the same caveat" },
      wouldR53HaveCapped: admittedN < members.length,
      rIfCapped: r4(sum(members.filter((m) => admitted.get(m.id)).map((m) => m.rMult))),
    });
  }
  clusters.sort((a, b) => a.realizedAggregateR - b.realizedAggregateR);

  const topWorstClusters = clusters.slice(0, 10).map((c) => ({ clusterId: c.clusterId, clusterType: c.clusterType, commonDriver: c.commonDriver, n: c.componentCount, realizedAggregateR: c.realizedAggregateR, rIfCapped: c.rIfCapped }));
  const topBestClusters = [...clusters].sort((a, b) => b.realizedAggregateR - a.realizedAggregateR).slice(0, 10)
    .map((c) => ({ clusterId: c.clusterId, clusterType: c.clusterType, commonDriver: c.commonDriver, n: c.componentCount, realizedAggregateR: c.realizedAggregateR, rIfCapped: c.rIfCapped }));

  // ---------------- broadest clustered-vs-independent split ----------------
  const inTemporalEpisode = new Set(buildTemporalEpisodes(signals).filter((e) => e.members.length >= 2).flatMap((e) => e.members.map((m) => m.id)));
  const inFactorGroup = new Set(tokenSegments.filter((s) => s.members.length >= 2).flatMap((s) => s.members.map((m) => m.id)));
  let temporalOnly = 0, factorOnly = 0, both = 0;
  for (const t of signals) {
    const a = inTemporalEpisode.has(t.id), b = inFactorGroup.has(t.id);
    if (a && b) both++; else if (a) temporalOnly++; else if (b) factorOnly++;
  }
  const unionIds = new Set([...inTemporalEpisode, ...inFactorGroup]);
  const clusteredTickets = signals.filter((t) => unionIds.has(t.id));
  const independentTickets = signals.filter((t) => !unionIds.has(t.id));
  const broadestClusteredVsIndependent = {
    note: "a ticket counts as clustered if it shares EITHER a same-instant basket (temporal-episode) OR a 24h-chained factor-group token with >=1 other ticket",
    temporalEpisodeOnly_n: temporalOnly, factorGroupOnly_n: factorOnly, bothTypes_n: both,
    unionClustered: { n: clusteredTickets.length, R: r4(sum(clusteredTickets.map((t) => t.rMult))) },
    trulyIndependent: { n: independentTickets.length, R: r4(sum(independentTickets.map((t) => t.rMult))) },
  };

  // ---------------- nuance check: same driver, opposite outcome (2026-08-20 vs 2026-08-24) ----------------
  function dayCheck(day) {
    const all = signals.filter((t) => etDay(t.closedAt) === day);
    const crypto = all.filter((t) => t.cls === "Crypto");
    return { day, allTicketsThatDay: all.length, netDayR: r4(sum(all.map((t) => t.rMult))), netDayDollar: Math.round(sum(all.map((t) => t.pnl || 0))), cryptoThatDay: crypto.length, cryptoR: r4(sum(crypto.map((t) => t.rMult))) };
  }
  const nuanceCheck_2026_08_20_vs_08_24 = {
    check0820: dayCheck("2026-08-20"), check0824: dayCheck("2026-08-24"),
    reading: "Same cluster mechanism (crypto factor-group), opposite outcomes. A cluster cap that had bound on both days would have cut the 08-20 loss AND the 08-24 gain -- clusters are where the variance is, in both directions.",
  };

  const state = {
    spec: "cluster-pnl-ledger-v1",
    taxonomyVersion: `${TAXONOMY_VERSION} (frozen; see header comment in backend/cluster-pnl-ledger.js)`,
    asOf: new Date().toISOString(),
    source: L.source, epoch: L.epoch,
    reconciled: { pooledEdgeR: L.pooledEdgeR, signalsN: L.n, controlsN: L.controlN },
    population: {
      settledSignals: signals.length,
      temporalEpisodeClusters: epN, factorGroupClusters: fgN,
      largestClusterSize: clusters.length ? Math.max(...clusters.map((c) => c.componentCount)) : null,
    },
    fourViews: { ticketLevel, independentEpisode, factorCluster, sessionClustered },
    r53Retroactive,
    nuanceCheck_2026_08_20_vs_08_24,
    broadestClusteredVsIndependent,
    topWorstClusters, topBestClusters,
    clusters,
  };
  writeJsonAtomic(OUT, state);

  console.log(`CLUSTER-LEVEL P&L LEDGER  (${TAXONOMY_VERSION})`);
  console.log(`  settled signals ${signals.length} · temporal-episode clusters ${epN} · factor-group clusters ${fgN} · largest ${state.population.largestClusterSize}`);
  console.log(`\nFOUR VIEWS, SIDE BY SIDE:`);
  console.log(`  ticket-level          n=${ticketLevel.n.toString().padStart(4)}  aggregateR ${ticketLevel.aggregateR}  meanR ${ticketLevel.meanR}  t ${ticketLevel.t}`);
  console.log(`  independent-episode   n=${independentEpisode.n.toString().padStart(4)}  aggregateR ${independentEpisode.aggregateR}  meanR ${independentEpisode.meanR}  t ${independentEpisode.t}  (inflation ${independentEpisode.ticketToEpisodeInflation}x)`);
  console.log(`  factor-cluster        n=${factorCluster.n.toString().padStart(4)}  aggregateR ${factorCluster.aggregateR}  meanR ${factorCluster.meanR}  t ${factorCluster.t}  (inflation ${factorCluster.ticketToClusterInflation}x)`);
  console.log(`  session-clustered     n=${sessionClustered.n.toString().padStart(4)}  aggregateR ${sessionClustered.aggregateR}  meanR/session ${sessionClustered.meanRperSession}  t ${sessionClustered.t}`);
  console.log(`\nR53 retroactive (motivating only): admitted ${r53Retroactive.admitted.n} (${r53Retroactive.admitted.aggregateR}R) · refused ${r53Retroactive.refused.n} (${r53Retroactive.refused.aggregateR}R = ${r53Retroactive.refused.lossesAvoided}R avoided + ${r53Retroactive.refused.gainsForegone}R foregone)`);
  console.log(`\nNuance: 08-20 crypto ${nuanceCheck_2026_08_20_vs_08_24.check0820.cryptoThatDay}@${nuanceCheck_2026_08_20_vs_08_24.check0820.cryptoR}R vs 08-24 crypto ${nuanceCheck_2026_08_20_vs_08_24.check0824.cryptoThatDay}@${nuanceCheck_2026_08_20_vs_08_24.check0824.cryptoR}R`);
  console.log(`written: data/cluster-pnl-ledger.json (${clusters.length} cluster rows)`);
})();
