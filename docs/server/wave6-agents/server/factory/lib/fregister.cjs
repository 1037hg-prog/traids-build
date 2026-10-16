"use strict";
/**
 * FREGISTER — from a registrar agent's DRAFT to a frozen F registration, in plain code. 2026-10-09 (docs/server/wave6-agents; stage 3).
 * The agent proposes; this file decides (design §4 "register before evidence"):
 *   - the draft must be the w6 registration schema below, testable in the daily harness (eq-daily | fut-daily), with a cost at or
 *     above the house floor, a window inside the dataset, minN and an MDE in range, and a non-empty knownWeaknesses list;
 *   - it may carry NO computed statistic (keys like t / pValue / sharpe / backtest / returns / winRate anywhere refuse it) and must
 *     affirm noComputedStatistic: true;
 *   - the multiplicity family is counted over R + F: R members from the read-only redacted registry copy in factory/in (an
 *     in-house-only R entry is id-only there and joins no count: a LOWER bound, as registry-view.js says at home) and every F
 *     member, each weighted by its variants;
 *   - the bar is fixed here (nullbar.cjs fBar: max(2.0, best-of-V p95), seeded) — never by the agent;
 *   - the controls get the caps' minimums (scrambles, power runs, leak cuts) and the house limits (false-pass <= 5%, power >= 0.8).
 * familyKeyOf is registry-view.js's (home) rule, ported; the package selftest proves it equal on the real registry.
 */
const { fBar } = require("./nullbar.cjs");
const NOT_A_FAMILY = new Set(["SINGLE", "PRIMARY", "INHERITED", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN",
  "ELEVEN", "TWELVE", "TWENTY-TWO", "THREE VARIANTS", "SINGLE VARIANT", "NONE", "N/A"]);
const KEY_RE = /^([A-Z0-9][A-Z0-9 /&+._-]*?[A-Z0-9])\s*(?:—|–|--| - |\(|:|;|,|\.(?:\s|$)|$)/;
function familyKeyOf(t) {
  if (!t || typeof t !== "object") return null;
  const norm = (k) => { const s = k.replace(/\s+/g, " ").trim(); return /[A-Z]/.test(s) && !NOT_A_FAMILY.has(s) && !/^(SINGLE|BEST-OF|ONE|PRIMARY|INHERITED|THIRD)\b/.test(s) ? s : null; };
  if (typeof t.family === "string" && t.family.trim()) { const m = KEY_RE.exec(t.family.trim()); return m ? norm(m[1]) : null; }
  const s = typeof t.multiplicityFamily === "string" ? t.multiplicityFamily.trim() : "";
  const m = KEY_RE.exec(s);
  return m ? norm(m[1]) : null;
}
const STAT_KEY = /^(t|tstat|t_stat|tvalue|pvalue|p_value|p|sharpe|sortino|result|results|backtest|backtested|observed\w*|winrate|win_rate|cagr|returns?|pnl|profit|hitrate)$/i;
const GATES = ["t >= bar", "both halves t > 0", "t at 2x cost > 0", "random-timing placebo t < bar", "invested days >= minN"];
const COST_FLOOR = { "eq-daily": 10, "fut-daily": 2 };
const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + "T00:00:00Z"));
function statKeys(v, at = "$", out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => statKeys(x, `${at}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (STAT_KEY.test(k)) out.push(`${at}.${k}`); statKeys(x, `${at}.${k}`, out); }
  return out;
}
/**
 * Pure: validate a draft. coverage: { "eq-daily": {from, to}, "fut-daily": {from, to} } (the data actually on the server);
 * caps.controls: { scrambles, powerRuns, leakCuts }. -> { ok, problems[], spec } (spec = the fields fstate.register freezes, minus the
 * family members and bar, which familyAndBar adds)
 */
function validateDraft(d, { key, coverage, caps }) {
  const p = [];
  if (!d || typeof d !== "object" || Array.isArray(d)) return { ok: false, problems: ["the draft is not a JSON object"] };
  if (d.key !== key) p.push(`key is ${JSON.stringify(d.key)}, want ${key}`);
  if (d.refuse === true) return { ok: false, refused: true, problems: [`the registrar refused: ${String(d.why || "no reason").slice(0, 300)}`] };
  const sk = statKeys(d); if (sk.length) p.push(`a computed statistic is not allowed in a registration (found ${sk.slice(0, 4).join(", ")}) — register before evidence`);
  if (d.noComputedStatistic !== true) p.push("noComputedStatistic must be true");
  for (const k of ["name", "hypothesis", "rule"]) if (typeof d[k] !== "string" || d[k].trim().length < (k === "name" ? 4 : 20)) p.push(`${k} missing or too short`);
  const fam = familyKeyOf({ family: d.family }); if (!fam || fam !== String(d.family || "").trim()) p.push(`family ${JSON.stringify(d.family)} is not a family KEY (UPPER-CASE, e.g. "SHORT-TERM REVERSAL")`);
  if (!Number.isInteger(d.variantsInThisTest) || d.variantsInThisTest < 1 || d.variantsInThisTest > 50) p.push("variantsInThisTest must be an integer 1..50");
  if (!COST_FLOOR[d.dataset]) p.push(`dataset ${JSON.stringify(d.dataset)} is not served here (eq-daily | fut-daily)`);
  const u = d.universe; if (!u || !(u.kind === "all" || (u.kind === "list" && Array.isArray(u.symbols) && u.symbols.length >= 1 && u.symbols.length <= 500 && u.symbols.every((s) => typeof s === "string" && /^[A-Z0-9.\-]{1,10}$/.test(s))))) p.push('universe must be {"kind":"all"} or {"kind":"list","symbols":[...<=500]}');
  if (!["close", "nextOpen"].includes(d.entry)) p.push('entry must be "close" or "nextOpen"');
  if (!Number.isInteger(d.rebalanceDays) || d.rebalanceDays < 1 || d.rebalanceDays > 60) p.push("rebalanceDays must be an integer 1..60");
  if (!(typeof d.costBps === "number" && d.costBps >= (COST_FLOOR[d.dataset] || 0) && d.costBps <= 200)) p.push(`costBps must be >= the house floor ${COST_FLOOR[d.dataset] || "?"} bps one-way (and <= 200)`);
  const w = d.window || {}, cov = (coverage || {})[d.dataset];
  if (!isDay(w.from) || !isDay(w.to) || w.from >= w.to) p.push("window must be {from, to} as YYYY-MM-DD, from < to");
  else if (!cov) p.push(`no coverage known for ${d.dataset}`);
  else { if (w.from < cov.from || w.to > cov.to) p.push(`window ${w.from}..${w.to} is outside the data on the server (${cov.from}..${cov.to})`); if (Date.parse(w.to) - Date.parse(w.from) < 365 * 86400000) p.push("window must span at least one year"); }
  if (!Number.isInteger(d.minN) || d.minN < 120 || d.minN > 5000) p.push("minN must be an integer 120..5000 (invested days)");
  if (!(typeof d.mdeDailyBps === "number" && d.mdeDailyBps >= 0.5 && d.mdeDailyBps <= 200)) p.push("mdeDailyBps must be 0.5..200 (the planted edge the controls must detect)");
  const c = d.controls || {}; if (!Number.isInteger(c.blockDays) || c.blockDays < 1 || c.blockDays > 20) p.push("controls.blockDays must be an integer 1..20");
  if (!Array.isArray(d.knownWeaknesses) || !d.knownWeaknesses.length || !d.knownWeaknesses.every((x) => typeof x === "string" && x.trim().length > 5)) p.push("knownWeaknesses must be a non-empty list of sentences");
  if (p.length) return { ok: false, problems: p };
  const C = (caps && caps.controls) || {};
  const spec = {
    name: d.name.trim().slice(0, 140), hypothesis: d.hypothesis.trim().slice(0, 2000), rule: d.rule.trim().slice(0, 4000), family: fam, variantsInThisTest: d.variantsInThisTest,
    dataset: d.dataset, universe: u.kind === "all" ? { kind: "all" } : { kind: "list", symbols: [...new Set(u.symbols)].sort() }, entry: d.entry, rebalanceDays: d.rebalanceDays, costBps: d.costBps,
    statistic: { kind: "daily-portfolio", unit: "days", clustering: "days", nwLag: 5, measure: "Newey-West t of the mean net daily portfolio return over invested days" },
    window: { from: w.from, to: w.to }, minN: d.minN, mdeDailyBps: d.mdeDailyBps,
    controls: { blockDays: c.blockDays, scrambles: Math.max(C.scrambles || 100, Number.isInteger(c.scrambles) ? c.scrambles : 0), powerRuns: Math.max(C.powerRuns || 20, Number.isInteger(c.powerRuns) ? c.powerRuns : 0), leakCuts: Math.max(C.leakCuts || 3, Number.isInteger(c.leakCuts) ? c.leakCuts : 0), falsePassMax: 0.05, plantedPowerMin: 0.8 },
    decisionGates: GATES, evidenceStart: w.from, knownWeaknesses: d.knownWeaknesses.map((x) => x.trim().slice(0, 300)).slice(0, 12),
  };
  return { ok: true, problems: [], spec };
}
/** Pure: the family over R (the redacted registry copy) + F, and the frozen bar. -> { members[], variantsTotal, bar } */
function familyAndBar(spec, { rRegistry, fTests, barOpts = {} }) {
  const R = [...((rRegistry && rRegistry.tests) || []), ...((rRegistry && rRegistry.preregistered) || [])].filter((t) => t && typeof t === "object" && !t.ipRedacted);
  const rM = R.filter((t) => familyKeyOf(t) === spec.family), fM = (fTests || []).filter((t) => familyKeyOf(t) === spec.family);
  const vOf = (t) => { const v = Number(t && t.bar && t.bar.variants); return Number.isInteger(v) && v >= 1 && v <= 1000 ? v : 1; };
  const variantsTotal = rM.reduce((a, t) => a + vOf(t), 0) + fM.reduce((a, t) => a + (Number.isInteger(t.variantsInThisTest) ? t.variantsInThisTest : 1), 0) + spec.variantsInThisTest;
  return { members: [...rM.map((t) => String(t.id)), ...fM.map((t) => String(t.id))], variantsTotal, bar: fBar(variantsTotal, barOpts) };
}
module.exports = { familyKeyOf, validateDraft, familyAndBar, statKeys, GATES, COST_FLOOR, KEY_RE };
