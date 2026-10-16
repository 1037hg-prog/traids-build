#!/usr/bin/env node
/**
 * POOLING AUDIT — does this aggregate hide sub-populations that do not belong together?
 *
 * WHY THIS EXISTS. The board's "Options" row read: n=110, 80% wins, -0.0210R, -$2,254. Every
 * figure correct, and the row was still misleading, because it pooled four unrelated things:
 *   R21-premium  n=77  79.2% win  1:4.6  breakeven 82.2%   -$288   (3 points short)
 *   R25-0dte     n=30  90.0% win  1:2.8  breakeven 73.8%   +$270   (WORKS, +16 pts of margin)
 *   Ensemble     n= 2   0.0% win  no width recorded      -$1,703   (not a credit spread)
 *   PEAD-manual  n= 1   0.0% win  no width recorded        -$533   (not a credit spread)
 * Three tickets carrying 99% of the loss were structurally not the same instrument as the other
 * 107. "We won 80% and lost money" was not a phenomenon — it was an artifact of the pooling.
 *
 * The same defect class appeared FOUR times on 2026-08-26 alone: the autopsy summing direction
 * and cost over 871 rows against a 965-row total; the stop tail and the clustering loss presented
 * as separate pools when they overlap 81%; a transcript corpus quoted from 15 of its 44 sessions;
 * and this. It is the most frequent error on this board and nothing was checking for it.
 *
 * WHY A TEST AND NOT AN AGENT. quant-validator's remit already covers "is this number
 * overstated or understated", it runs daily, and it missed this — because agents audit analyses
 * they are pointed at, not aggregates a dashboard happens to render. An agent MIGHT catch it.
 * An assertion that runs over every aggregate WILL. Same reasoning as `identityHolds` in
 * trade-autopsy.js: the check that fires without anyone remembering to look is the one worth having.
 *
 * WHAT IT FLAGS — each is a way an average lies about the rows underneath it:
 *   CONCENTRATION   a small minority of tickets carries a majority of the P&L
 *   SIGN-SPLIT      sub-populations point in opposite directions
 *   STRUCTURE-SPLIT sub-populations are not the same instrument (fields present for some, not others)
 *   PAYOFF-SPLIT    sub-populations need materially different win rates to break even
 *
 * It does not fix anything and it does not judge whether an aggregate is WRONG — pooling is
 * sometimes exactly right. It says "this mean is standing on rows that disagree", and leaves the
 * call to a human. Output: data/pooling-audit.json
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { cleanEraLedger } = require("./lib/reconcile.js");

const D = (f) => path.join(__dirname, "data", f);
const S = (a, k) => a.reduce((s, x) => s + (x[k] || 0), 0);
const mean = (a, k) => (a.length ? S(a, k) / a.length : 0);

function payoff(rows) {
  const w = rows.filter((t) => (t.pnl || 0) > 0), l = rows.filter((t) => (t.pnl || 0) <= 0);
  if (!w.length || !l.length) return null;
  const mw = S(w, "pnl") / w.length, ml = Math.abs(S(l, "pnl") / l.length);
  return { winPct: +(100 * w.length / rows.length).toFixed(1), meanWin: +mw.toFixed(0), meanLoss: +ml.toFixed(0),
    ratio: +(ml / mw).toFixed(2), breakeven: +(100 * ml / (mw + ml)).toFixed(1) };
}

/** Which fields are present on essentially all rows of a group? Used to spot instrument mismatch. */
const fieldSig = (rows, keys) => keys.filter((k) => rows.filter((t) => t.obs && Number.isFinite(t.obs[k])).length >= rows.length * 0.8);

function audit(label, rows, splitBy) {
  const groups = {};
  for (const t of rows) (groups[t[splitBy] || "(none)"] ||= []).push(t);
  const names = Object.keys(groups);
  if (names.length < 2) return null;

  const findings = [];
  const totalPnl = S(rows, "pnl");

  // CONCENTRATION — a minority of tickets carrying a majority of the P&L movement
  const byAbs = [...rows].sort((a, b) => Math.abs(b.pnl || 0) - Math.abs(a.pnl || 0));
  const top = byAbs.slice(0, Math.max(1, Math.ceil(rows.length * 0.05)));
  const share = totalPnl !== 0 ? Math.abs(S(top, "pnl") / totalPnl) : 0;
  if (share >= 0.5) findings.push({ kind: "CONCENTRATION", detail: `top ${top.length} of ${rows.length} tickets (${(100 * top.length / rows.length).toFixed(0)}%) carry ${(100 * share).toFixed(0)}% of the net P&L`, worst: top.slice(0, 5).map((t) => ({ sym: t.sym, strategy: t.strategy, pnl: Math.round(t.pnl || 0) })) });

  // SIGN-SPLIT — sub-populations disagree on direction
  const signs = names.map((n) => ({ n, pnl: S(groups[n], "pnl"), size: groups[n].length }));
  const pos = signs.filter((s) => s.pnl > 0), neg = signs.filter((s) => s.pnl < 0);
  if (pos.length && neg.length) findings.push({ kind: "SIGN-SPLIT", detail: `${pos.length} sub-population(s) profitable, ${neg.length} not — the pooled mean is a blend of both`, groups: signs.map((s) => ({ ...s, pnl: Math.round(s.pnl) })) });

  // STRUCTURE-SPLIT — the groups are not the same instrument
  const OPT_KEYS = ["width", "creditMid", "shortDelta"];
  const sigs = {}; for (const n of names) sigs[n] = fieldSig(groups[n], OPT_KEYS).join(",");
  const distinct = [...new Set(Object.values(sigs))];
  if (distinct.length > 1) findings.push({ kind: "STRUCTURE-SPLIT", detail: "sub-populations do not share the same recorded structure — they are not the same instrument and their averages are not commensurable", signatures: Object.fromEntries(names.map((n) => [n, sigs[n] || "(none)"])) });

  // PAYOFF-SPLIT — materially different breakeven requirements
  const pays = names.map((n) => ({ n, ...(payoff(groups[n]) || {}) })).filter((p) => p.breakeven != null);
  if (pays.length >= 2) {
    const lo = Math.min(...pays.map((p) => p.breakeven)), hi = Math.max(...pays.map((p) => p.breakeven));
    if (hi - lo >= 8) findings.push({ kind: "PAYOFF-SPLIT", detail: `breakeven win rate ranges ${lo}% to ${hi}% across sub-populations — one pooled win rate cannot be judged against one bar`, groups: pays });
  }

  if (!findings.length) return null;
  return { aggregate: label, splitBy, n: rows.length, pnl: Math.round(totalPnl), pooled: payoff(rows), subPopulations: names.length, findings };
}

const L = cleanEraLedger();
const rows = L.signals;
const flags = [];

// every aggregate the board renders: by class (split by strategy), and by strategy (split by symbol)
const byClass = {}; for (const t of rows) (byClass[t.cls || "(none)"] ||= []).push(t);
for (const [cls, g] of Object.entries(byClass)) { const a = audit(`class:${cls}`, g, "strategy"); if (a) flags.push(a); }
const byStrat = {}; for (const t of rows) (byStrat[t.strategy || "(none)"] ||= []).push(t);
for (const [s, g] of Object.entries(byStrat)) { if (g.length < 10) continue; const a = audit(`strategy:${s}`, g, "cls"); if (a) flags.push(a); }

const out = { spec: "pooling-audit-v1", asOf: new Date().toISOString(), aggregatesChecked: Object.keys(byClass).length + Object.keys(byStrat).length, flagged: flags.length, flags };
writeJsonAtomic(D("pooling-audit.json"), out);

console.log(`POOLING AUDIT — ${out.aggregatesChecked} aggregates checked · ${flags.length} flagged\n`);
for (const f of flags) {
  console.log(`  ${f.aggregate}  n=${f.n}  $${f.pnl}  · split by ${f.splitBy} → ${f.subPopulations} sub-populations`);
  if (f.pooled) console.log(`     pooled reads: ${f.pooled.winPct}% wins · win $${f.pooled.meanWin} / lose $${f.pooled.meanLoss} · breakeven ${f.pooled.breakeven}%`);
  for (const d of f.findings) console.log(`     [${d.kind}] ${d.detail}`);
  console.log("");
}
if (!flags.length) console.log("  no aggregate is standing on rows that disagree.");
console.log("written: data/pooling-audit.json");
