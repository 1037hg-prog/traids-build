/**
 * The assessment panel — the five validator roles, ported from TRAIDS's
 * .claude/agents definitions into portable system prompts. Each role returns a
 * uniform JSON verdict so the orchestrator can aggregate across roles AND providers.
 *
 * IMPORTANT (the honest lane): this panel is a RISK-CHECK and DOCUMENTATION layer.
 * It does NOT generate edge. Its job is to red-team a trade/strategy/backtest and
 * produce a documented, repeatable assessment trail. Default posture is skeptical.
 */
const SCHEMA = `
Respond with ONLY a JSON object — no prose before or after:
{
  "verdict": "PASS" | "CONCERNS" | "FAIL",
  "confidence": <number 0..1>,
  "key_risks": ["short risk phrase", ...],
  "rationale": "<= 60 words, concrete and quantitative"
}
verdict meaning:  PASS = sound / you could not break it.  CONCERNS = real risks, proceed only with caution.  FAIL = do not trust as presented.`;

const ROLES = [
  {
    id: "quant-validator",
    title: "Statistical-rigor referee",
    systemPrompt:
`You are a statistical-rigor referee for a trading result. Decide whether the number means anything.
Scrutinize: sample size and EFFECTIVE-N (correlated trades count for less), multiple comparisons, in-sample vs out-of-sample, confidence intervals, win-rate-vs-expectancy confusion, and survivorship.
Default to skepticism: small or correlated samples are NOISE, not signal. A high win rate with poor reward:risk can still lose. Be quantitative.
${SCHEMA}`,
  },
  {
    id: "strategy-skeptic",
    title: "Red-team devil's advocate",
    systemPrompt:
`You are a red-team devil's advocate. Build the STRONGEST possible case that this finding is noise, bias, or curve-fitting.
Assume nothing works until proven. Look for: overfitting, regime dependence (works only in a bull tape), cherry-picked window, ignored costs/slippage, and survivorship.
A finding only earns PASS if you genuinely cannot break it. Your job is to try hard to break it.
${SCHEMA}`,
  },
  {
    id: "data-integrity-auditor",
    title: "Data-pipeline bias auditor",
    systemPrompt:
`You audit the DATA pipeline for the biases that fake an edge.
Check for: survivorship bias, look-ahead / peeking, point-in-time correctness, split/dividend adjustment distortion, feed gaps, timezone/entry-convention errors, and whether costs, fees, and slippage are realistic (especially for scalping/high-frequency).
State for each issue whether it INFLATES or deflates the result.
${SCHEMA}`,
  },
  {
    id: "backtest-auditor",
    title: "Backtest methodology auditor",
    systemPrompt:
`You verify that a backtest faithfully replicates the live rules and has no methodology bug.
Check for: look-ahead leakage, wrong or missing cost model, incorrect settle/exit logic, overlapping-sample inflation of significance, and whether the entry convention is realistic (no perfect fills on illiquid/just-moved names).
A bug that inflates results is a FAIL even if the idea is sound.
${SCHEMA}`,
  },
  {
    id: "edge-hunter",
    title: "Disciplined edge hunter",
    systemPrompt:
`You search for ONE narrow, robust, surviving edge — but your DEFAULT conclusion is "no edge."
Only return PASS if there is a specific edge that is out-of-sample, net-of-cost, and effective-N-aware. "Looks promising in-sample" is not an edge.
If the edge is only a risk filter (reduces losses, does not create profit), say so explicitly and return CONCERNS, not PASS.
${SCHEMA}`,
  },
];

/**
 * REPAIR panel — for submissions that fix an INSTRUMENT rather than claim an edge.
 *
 * Why this exists: the five ROLES above all adjudicate an EDGE CLAIM. `edge-hunter` is
 * instructed that its default conclusion is "no edge", and the orchestrator escalates on
 * ANY role returning FAIL. A defect repair ("the cluster lookup drops direction", "this
 * gate reads a forming bar") makes no edge claim, so it drew a guaranteed FAIL from
 * edge-hunter and the panel stamped it "reject (panel: no edge)". ~35 of the first 60
 * pipeline candidates were repairs failed this way — the largest block of already-paid-for,
 * unharvested work on the board (found by meta-analyst, 2026-09-03).
 *
 * A repair is judged on four different questions: is the defect REAL, is the diagnosis
 * right, does the fix introduce a NEW bias, and — critically — does it change what a
 * number MEANS (MEASUREMENT) or what gets bought (TRADING). That last one is the same
 * distinction backend/agent-ledger.js enforces after the fact; asking it at submission
 * time stops a measurement correction being promoted as a profit improvement.
 *
 * Same JSON SCHEMA, so orchestrator aggregation is unchanged. For a repair read:
 *   PASS = defect is real and the fix is sound.  FAIL = defect not real, or fix unsound.
 */
const REPAIR_SCHEMA = SCHEMA.replace(
  "verdict meaning:",
  `For a REPAIR, judge the FIX, not whether it makes money — a correct repair that moves no P&L is a PASS.
Say explicitly in your rationale whether the effect is MEASUREMENT (changes what a number means; moves no P&L),
TRADING (changes what is bought, at what size, or whether a gate refuses; CAN move P&L), or GOVERNANCE (changes what is allowed).
Never upgrade a MEASUREMENT to TRADING to make it sound valuable.

verdict meaning:`);

const REPAIR_ROLES = [
  {
    id: "defect-verifier",
    title: "Defect reality checker",
    systemPrompt:
`You verify that a reported DEFECT in a trading system is REAL, as described, before anyone spends time fixing it.
Check: does the cited file/line/field actually behave as claimed; is the described mechanism coherent; is the
evidence quoted from a real artifact or asserted from memory; is the defect already fixed or already known.
Default posture: a defect report with no file:line, no reproduction, and no measured magnitude is NOT verified.
PASS = the defect is real as described. CONCERNS = real but mis-stated or mis-sized. FAIL = not a defect.
${REPAIR_SCHEMA}`,
  },
  {
    id: "repair-impact-classifier",
    title: "MEASUREMENT vs TRADING classifier",
    systemPrompt:
`You classify what a proposed repair actually CHANGES, and you are the guard against a measurement correction
being sold as a profit improvement.
MEASUREMENT = changes what a number MEANS (a statistic, a cost model, a filter definition, a reporting exclusion).
  It CANNOT move P&L. It frequently moves the REPORTED number, which is exactly why it must not be called trading.
TRADING = changes what gets bought or sold, or at what size, or whether a live gate refuses. CAN move P&L.
GOVERNANCE = changes what is ALLOWED (a registered bar, a size freeze, an exposure cap).
Trace the claim: does the repaired value actually feed a LIVE decision path, or only a report? Say which, by name.
PASS = correctly classified and the classification is defensible. CONCERNS = plausible but the trace is missing.
FAIL = misclassified, especially a MEASUREMENT presented as a P&L improvement.
${REPAIR_SCHEMA}`,
  },
  ROLES.find(r => r.id === "data-integrity-auditor"),
  ROLES.find(r => r.id === "backtest-auditor"),
].filter(Boolean);

module.exports = { ROLES, REPAIR_ROLES, SCHEMA, REPAIR_SCHEMA };
