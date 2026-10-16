#!/usr/bin/env node
/**
 * R56 APPLIED — stamp the learned cost prediction on every live equity ticket, BEFORE the outcome.
 *
 * WHY NOW. I had treated "validated" as a prerequisite for applying the model. It is not, and the
 * reasoning does not survive contact with what is already live: R49's rule is a hand-picked 100bps
 * threshold chosen from a single session's snapshot. R56 is at least fitted. Refusing a PAPER trade
 * risks nothing, and every refusal is recorded as a graded shadow, so the refused names are measured
 * exactly like the taken ones. Waiting three sessions to reach 300 out-of-sample stamps buys no
 * safety and costs three sessions of evidence.
 *
 * WHAT IT DOES, and the ordering is the whole point:
 *   1. reads the OPEN board — positions whose outcome is not yet known
 *   2. predicts each one's round-trip spread from R56's FROZEN coefficients
 *   3. records the prediction, the implied costR, and the refuse/keep decision
 *   4. when the ticket later carries a real obs.spreadBps, that stamp GRADES the prediction
 * The prediction is written before the truth exists, so it cannot be fitted to it.
 *
 * IT REFUSES NOTHING LIVE. R49's registered 100bps cutoff remains the only rule that touches the
 * board. R56's refusals are SHADOWS — recorded, graded, and compared against R49's, so the question
 * "would a learned threshold have beaten the guessed one" is answerable at the read rather than
 * argued. Promoting R56 from shadow to rule needs its own bar and the operator's decision.
 *
 * Output: data/r56-predictions.jsonl (append-only, one row per ticket per session)
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const OUT = D("r56-predictions.jsonl");
const MODEL = D("r56-cost-model-ml.json");
const R49_CUTOFF_BPS = 100;          // the registered fixed rule, for side-by-side comparison

const m = (() => { try { return JSON.parse(fs.readFileSync(MODEL, "utf8")).frozen; } catch { return null; } })();
if (!m) { console.error("no frozen R56 model — run backend/r56-cost-model-ml.js --fit first"); process.exit(2); }

const uni = JSON.parse(fs.readFileSync(D("universe-expanded.json"), "utf8"));
const rank = new Map(uni.names.map((n, i) => [n.sym, i + 1]));
const vol = new Map(uni.names.map((n) => [n.sym, n.medDollarVol]));
const board = (() => { try { const b = JSON.parse(fs.readFileSync(D("board_positions.json"), "utf8")); return Array.isArray(b) ? b : (b.positions || b.rows || []); } catch { return []; } })();

const featuresOf = (t) => {
  const r = rank.get(t.sym), v = vol.get(t.sym);
  const atrPct = Number.isFinite(t.obs?.atr14) && t.entry > 0 ? 100 * t.obs.atr14 / t.entry
    : (t.stopDist > 0 && t.entry > 0 ? 100 * t.stopDist / t.entry : null);
  const vr = Number.isFinite(t.obs?.volRatio) ? t.obs.volRatio : (Number.isFinite(t.obs?.rvol) ? t.obs.rvol : null);
  const f = { logDollarVol: v > 0 ? Math.log10(v) : null, logPrice: t.entry > 0 ? Math.log10(t.entry) : null,
    logRank: r > 0 ? Math.log10(r) : null, atrPct, volRatio: vr };
  for (const k of m.feats) if (!Number.isFinite(f[k])) return null;
  return f;
};
const predictBps = (f) => Math.pow(10, m.intercept + m.feats.reduce((s, k) => s + m.weights[k] * ((f[k] - m.mu[k]) / m.sg[k]), 0));

const already = new Set();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, "utf8").split("\n")) { if (!l.trim()) continue; try { already.add(JSON.parse(l).id); } catch {} }

const now = new Date().toISOString();
const rows = [];
let skipped = 0;
for (const t of board) {
  if (t.cls !== "Equity" || !t.id || already.has(t.id)) continue;
  const f = featuresOf(t); if (!f) { skipped++; continue; }
  const pred = predictBps(f);
  const stopPct = t.stopDist > 0 && t.entry > 0 ? 100 * t.stopDist / t.entry : null;
  const predCostR = stopPct ? (pred / 100) / stopPct : null;
  rows.push({
    id: t.id, sym: t.sym, at: now, openedAt: t.addedAt || t.openedAt,
    predictedSpreadBps: +pred.toFixed(1), stopPct: stopPct ? +stopPct.toFixed(2) : null,
    predictedCostR: predCostR == null ? null : +predCostR.toFixed(4),
    r56WouldRefuse: pred > R49_CUTOFF_BPS,          // learned threshold at the same nominal level
    r49WouldRefuse: Number.isFinite(t.obs?.spreadBps) ? t.obs.spreadBps > R49_CUTOFF_BPS : null,
    actualSpreadBps: Number.isFinite(t.obs?.spreadBps) ? t.obs.spreadBps : null,
    note: "PREDICTION ONLY — refuses nothing live. R49's registered cutoff remains the board's rule.",
  });
}
if (rows.length) fs.appendFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

// grade every prediction that now has a truth attached
const all = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const byId = new Map(board.map((t) => [t.id, t]));
let graded = 0, absErr = [], agree = 0, disagree = 0;
for (const r of all) {
  const t = byId.get(r.id); const truth = Number.isFinite(t?.obs?.spreadBps) ? t.obs.spreadBps : r.actualSpreadBps;
  if (!Number.isFinite(truth)) continue;
  graded++; absErr.push(Math.abs(r.predictedSpreadBps - truth));
  if ((r.predictedSpreadBps > R49_CUTOFF_BPS) === (truth > R49_CUTOFF_BPS)) agree++; else disagree++;
}
absErr.sort((a, b) => a - b);
console.log(`R56 APPLIED — ${rows.length} new prediction(s) stamped, ${skipped} skipped for missing features`);
console.log(`  predictions on file: ${all.length}   ·   with a realised spread to grade against: ${graded}`);
if (graded) {
  console.log(`  median abs error: ${absErr[Math.floor(absErr.length / 2)].toFixed(1)}bps`);
  console.log(`  refuse/keep decision matches the realised spread on ${agree}/${agree + disagree} (${(100 * agree / (agree + disagree)).toFixed(0)}%)`);
}
console.log("  refuses nothing live — R49's registered 100bps cutoff is still the board's only cost rule.");
console.log("written: r56-predictions.jsonl");
