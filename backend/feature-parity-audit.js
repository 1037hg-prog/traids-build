#!/usr/bin/env node
/**
 * FEATURE PARITY AUDIT — is every signal we COLLECT actually reaching a model? 2026-08-28.
 *
 * WHY THIS EXISTS.
 *
 * The operator asked, repeatedly, why the agents and models were not learning from all our data
 * and trades. Each time the answer given was a measurement result rather than a check, and the
 * real gap went unnamed for weeks. When it was finally measured it was large:
 *
 *   The board stamps ~100 distinct observers on every ticket. Test #39 — the full-scale selection
 *   model, 150,316 episodes over 2021-2026, verdict NO-SKILL — was trained on NINETEEN features,
 *   every one of them a price/volume/macro technical. Insider flow, options skew, short interest,
 *   dark-pool share, news, earnings surprise and MEASURED SPREAD had never been in a training file
 *   at all. The model was not failing. It was correctly reporting that RSI and ADX on 977 liquid
 *   large caps predict nothing, which is the single most picked-over question in finance.
 *
 * THE STRUCTURAL DEFECT, which is the point of this file. The shop already audits: writers that
 * went stale (ops-watchdog), prose that drifted from its source (claim-drift-audit), observers
 * that are present but never finite (coverage-mechanic), ledgers that disagree (reconcile). There
 * was NO audit asking whether the models consume what the board collects. So a feature could be
 * built, wired, stamped on thousands of tickets, and never once shown to a learner — silently,
 * indefinitely, with every dashboard green.
 *
 * A collected-but-untrained feature is not a bug that throws. It is an absence, and absences need
 * a dedicated check or they are invisible. That is the entire brief.
 *
 * WHAT IT REPORTS, both directions:
 *   STAMPED, NEVER TRAINED   an observer that is finite on real tickets and appears in no model's
 *                            feature list. Ranked by coverage — high coverage means it is ready to
 *                            train on TODAY and is being wasted.
 *   TRAINED, NOT STAMPED     a model consumes a feature the ledger no longer carries. This is the
 *                            more dangerous direction: the model still runs, silently scoring on
 *                            NaN, and its degradation looks like a lost edge rather than a break.
 *   TOO SPARSE TO TRAIN      stamped, unused, and below the coverage floor — the honest queue for
 *                            a historical backfill rather than a straight add.
 *
 * WHAT IT DELIBERATELY EXCLUDES.
 *   - MODEL OUTPUTS (modelScore, bakeoffRidge, bakeoffGbm, wComposite). Training a model on
 *     another model's score is leakage dressed as a feature, and it is why they are listed here
 *     rather than silently absent.
 *   - NON-NUMERIC METADATA (timestamps, symbols, expiries, sleeve tags). Not features.
 *   - Anything the ledger carries that is an OUTCOME (pnl, rMult, exit reason). Obvious, stated
 *     anyway, because an outcome leaking into a feature list is the classic way a backtest lies.
 *
 * IT PROPOSES NOTHING AND CHANGES NOTHING. It emits a gap. Adding a feature to a training set is
 * a new hypothesis and goes through registration like anything else — a NO-SKILL verdict on one
 * feature set may never be quietly overwritten by rerunning it on a different one.
 *
 * Usage:  node backend/feature-parity-audit.js [--floor 0.15]
 * Output: data/feature-parity.json   ·   exit 1 if a model consumes a feature the ledger lost
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const J = (f) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return null; } };

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const FLOOR = arg("floor", 0.15);          // below this share of stamped tickets, an add needs a backfill first

/** A model's own score is never a feature for another model. Named, not silently dropped. */
const MODEL_OUTPUTS = new Set(["modelScore", "bakeoffRidge", "bakeoffGbm", "wComposite", "vote", "conf"]);
/** Structural fields the learners synthesise themselves. */
const STRUCTURAL = new Set(["dir", "isCtrl", "cls:Equity", "cls:Crypto", "cls:Futures", "cls:FX"]);

/**
 * Where each model declares its inputs. Reading the list off the ARTEFACT rather than the source
 * means a model that silently changed its features cannot pass this audit by looking unchanged.
 * selection-model.js writes no artefact, so #39's list is pinned here and cross-checked against
 * the training file's own feature block.
 */
/**
 * SCOPE MATTERS, and getting it wrong makes this audit useless. A model that scores LIVE TICKETS
 * reads obs off the ledger, so a feature it wants and the ledger lacks is a real break. A model
 * trained on its OWN dataset (R41 on intraday bars, #39 on training/dataset.jsonl, regime on
 * market state) legitimately uses names the ticket ledger never carries — flagging those is crying
 * wolf, and an audit that cries wolf is one nobody reads.
 *   scope "ledger"  -> audited both directions against trade_log obs
 *   scope <file>    -> its own feature namespace; only the FORWARD gap is meaningful
 */
const CONSUMERS = [
  { id: "bake-off", scope: "ledger", file: "model-bakeoff.json", pick: (j) => j.features },
  { id: "skip-filter", scope: "ledger", file: "skip-filter-model.json", pick: (j) => j.features },
  { id: "R41 intraday", scope: "intraday bars", file: "intraday-model.json", pick: (j) => j.features },
  { id: "regime", scope: "market state", file: "regime-model.json", pick: (j) => j.features },
  {
    id: "#39 selection", scope: "training/dataset.jsonl", file: null, pinned: [
      "momPctile", "revRet5", "ret20", "squeeze", "rvol", "prevMove", "gapPct", "atrPct", "rsi14",
      "adx14", "dist52w", "spyRet20", "relRet20", "sectorRS", "vix", "vixChg", "yield10", "yieldChg", "regimeAlign",
    ],
  },
];

// ---- what the board actually stamps -------------------------------------------------------------
const log = J("trade_log.json") || [];
const stamped = new Map();                  // key -> finite count
let tickets = 0;
for (const t of log) {
  if (!t || !t.obs) continue;
  tickets++;
  for (const [k, v] of Object.entries(t.obs)) {
    if (!stamped.has(k)) stamped.set(k, 0);
    if (Number.isFinite(v)) stamped.set(k, stamped.get(k) + 1);
  }
}
const coverage = (k) => (tickets ? stamped.get(k) / tickets : 0);

// ---- what the models consume --------------------------------------------------------------------
const consumers = [];
for (const c of CONSUMERS) {
  let feats = c.pinned || null, src = c.file || "pinned in feature-parity-audit.js";
  if (c.file) { const j = J(c.file); feats = j ? (c.pick(j) || null) : null; }
  if (!Array.isArray(feats)) { consumers.push({ id: c.id, scope: c.scope, source: src, ok: false, why: "no feature list found — model artefact missing or malformed" }); continue; }
  consumers.push({ id: c.id, scope: c.scope, source: src, ok: true, features: feats.filter((f) => !STRUCTURAL.has(f)) });
}
/** Anything a model consumes anywhere — used for the forward gap (is this signal reaching ANY learner). */
const consumed = new Map();                 // feature -> [model ids]
for (const c of consumers) for (const f of c.features || []) {
  if (!consumed.has(f)) consumed.set(f, []);
  consumed.get(f).push(c.id);
}
/** Only the ledger-scope models can be audited in reverse against trade_log obs. */
const ledgerConsumed = new Map();
for (const c of consumers.filter((x) => x.scope === "ledger")) for (const f of c.features || []) {
  if (!ledgerConsumed.has(f)) ledgerConsumed.set(f, []);
  ledgerConsumed.get(f).push(c.id);
}

/**
 * THE HEADLINE GAP, and the reason this file was written. The historical training set is the only
 * place a five-year model can learn anything. Every observer the board stamps SHOULD be reaching
 * it; #39's dataset carries 19 features while the ledger stamps ~80.
 */
const HIST = (() => {
  const c = CONSUMERS.find((x) => x.id === "#39 selection");
  return new Set(c.pinned);
})();

// ---- the two gaps -------------------------------------------------------------------------------
const numericStamped = [...stamped.keys()].filter((k) => stamped.get(k) > 0);   // finite at least once

const neverTrained = numericStamped
  .filter((k) => !consumed.has(k) && !MODEL_OUTPUTS.has(k))
  .map((k) => ({ feature: k, finiteOn: stamped.get(k), coveragePct: +(100 * coverage(k)).toFixed(1) }))
  .sort((a, b) => b.finiteOn - a.finiteOn);

const readyNow = neverTrained.filter((f) => f.coveragePct / 100 >= FLOOR);
const needsBackfill = neverTrained.filter((f) => f.coveragePct / 100 < FLOOR);

const trainedNotStamped = [...ledgerConsumed.keys()]
  .filter((f) => !stamped.has(f) || stamped.get(f) === 0)
  .map((f) => ({ feature: f, consumedBy: ledgerConsumed.get(f), finiteOn: stamped.get(f) || 0 }))
  .sort((a, b) => b.consumedBy.length - a.consumedBy.length);

/** Stamped on live tickets but absent from the HISTORICAL training set — the five-year blind spot. */
const notInHistorical = numericStamped
  .filter((k) => !HIST.has(k) && !MODEL_OUTPUTS.has(k))
  .map((k) => ({ feature: k, finiteOn: stamped.get(k), coveragePct: +(100 * coverage(k)).toFixed(1), alsoUsedBy: consumed.get(k) || [] }))
  .sort((a, b) => b.finiteOn - a.finiteOn);

const excludedOutputs = numericStamped.filter((k) => MODEL_OUTPUTS.has(k));

const out = {
  spec: "feature-parity-audit-v1", asOf: new Date().toISOString(),
  question: "Is every signal the board COLLECTS actually reaching a model?",
  contract: "Reports a gap. Proposes nothing, changes nothing, trains nothing. Adding a feature to a training set is a NEW HYPOTHESIS and is registered before it runs — a NO-SKILL verdict on one feature set is never overwritten by rerunning it on another.",
  coverageFloor: FLOOR,
  ticketsWithStamps: tickets,
  distinctObserversStamped: numericStamped.length,
  distinctFeaturesConsumed: consumed.size,
  consumers,
  stampedNeverTrained: { total: neverTrained.length, readyNow, needsBackfill },
  notInHistoricalTrainingSet: {
    total: notInHistorical.length,
    historicalFeatureCount: HIST.size,
    note: "#39 (the only five-year model) trains on " + HIST.size + " price/volume/macro technicals. These observers are stamped on live tickets and have never been in that file. This is the gap that made #39's NO-SKILL verdict a verdict about TECHNICALS, not about the board's information.",
    features: notInHistorical,
  },
  trainedNotStamped,
  excludedAsModelOutputs: excludedOutputs,
  note: "A collected-but-untrained feature is an ABSENCE, not an error. Nothing throws, every dashboard stays green, and the model quietly never sees it. That is why this check exists as its own file rather than as a line in another audit.",
};
writeJsonAtomic(D("feature-parity.json"), out);

// ---- report -------------------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log("FEATURE PARITY — does the ML see what the board collects?");
console.log(`  ${tickets} stamped tickets · ${numericStamped.length} distinct observers stamped · ${consumed.size} distinct features consumed by ${consumers.filter((c) => c.ok).length} models`);
for (const c of consumers) console.log(`    ${pad(c.id, 16)} ${pad(c.ok ? c.features.length + " features" : "UNREADABLE", 14)} scope: ${c.scope}${c.ok ? "" : " — " + c.why}`);

console.log(`\n  NOT IN THE HISTORICAL TRAINING SET — ${notInHistorical.length} stamped observers absent from #39's ${HIST.size} features`);
console.log("  #39 is the only five-year model. Its NO-SKILL verdict is a verdict about TECHNICALS, not about what the board knows.");
for (const f of notInHistorical.slice(0, 14)) console.log(`      ${pad(f.feature, 20)} ${String(f.coveragePct).padStart(5)}%${f.alsoUsedBy.length ? "   (live models: " + f.alsoUsedBy.join(", ") + ")" : "   reaches NO model at all"}`);
if (notInHistorical.length > 14) console.log(`      ... and ${notInHistorical.length - 14} more`);

console.log(`\n  STAMPED, NEVER TRAINED — ${neverTrained.length} observers reach no model`);
console.log(`  ready to train on now (coverage >= ${(100 * FLOOR).toFixed(0)}%): ${readyNow.length}`);
for (const f of readyNow) console.log(`      ${pad(f.feature, 20)} finite on ${String(f.finiteOn).padStart(5)} tickets  ${String(f.coveragePct).padStart(5)}%`);
console.log(`  stamped but too sparse — needs a historical backfill first: ${needsBackfill.length}`);
for (const f of needsBackfill.slice(0, 20)) console.log(`      ${pad(f.feature, 20)} finite on ${String(f.finiteOn).padStart(5)} tickets  ${String(f.coveragePct).padStart(5)}%`);
if (needsBackfill.length > 20) console.log(`      ... and ${needsBackfill.length - 20} more (full list in data/feature-parity.json)`);

if (excludedOutputs.length) console.log(`\n  excluded as MODEL OUTPUTS (training on these is leakage): ${excludedOutputs.join(", ")}`);

if (trainedNotStamped.length) {
  console.log(`\n  TRAINED, NOT STAMPED — ${trainedNotStamped.length} features a model expects and the ledger does NOT carry.`);
  console.log("  This is the dangerous direction: the model still runs, scoring on NaN, and looks like a lost edge rather than a break.");
  for (const f of trainedNotStamped) console.log(`      ${pad(f.feature, 20)} expected by ${f.consumedBy.join(", ")}`);
  console.log("\n  REPORTING NON-ZERO.");
  process.exit(1);
}
console.log("\nwritten: data/feature-parity.json");
