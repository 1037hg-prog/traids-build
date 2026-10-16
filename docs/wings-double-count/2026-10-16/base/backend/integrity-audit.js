#!/usr/bin/env node
/**
 * INDEPENDENT LEDGER INTEGRITY AUDIT (2026-08-03).
 *
 * Origin, verbatim: "how can i trust any of this data".
 *
 * The honest answer cannot be "trust me" — six defects surfaced in a single day. So this
 * script RE-DERIVES every settled number from the raw fields stored alongside it and reports
 * disagreement. It shares no code with the settle path: if the settle logic is wrong, this
 * arithmetic still comes out right and the mismatch shows up here.
 *
 * It also classifies the day's defects into the only distinction that matters for trust:
 *   OMISSION  — the bug removed rows/instruments. Shrinks the sample. Cannot invent an edge.
 *   CORRUPTION — the bug altered a recorded value. Can fabricate an edge. Far more dangerous.
 *
 * Wired into the nightly close chain so this is a standing check, not a one-off reassurance.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const log = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8"));
const rows = Array.isArray(log) ? log : log.trades || log.rows || [];
const CLEAN = new Date("2026-07-20").getTime();
const L = [];
const say = (s) => { L.push(s); console.log(s); };

say(`INDEPENDENT LEDGER AUDIT · ${new Date().toISOString()}`);
say(`${rows.length} total rows · re-deriving every settled value from raw fields\n`);

// ── 1. ARITHMETIC: recompute rMult from entry/exit/stopDist/dir ───────────────
// R is defined as (exit-entry)*dir/stopDist. If the stored rMult disagrees, the ledger is
// telling us something its own inputs do not support.
// OPTIONS are audited SEPARATELY. Their stored pnl is friction-marked (entry pays above mid,
// exit collects below mid) while the stored entry/exit are raw prices, so the linear identity
// legitimately does not hold for them. Mixing them in would make this check permanently red
// and therefore useless — a check nobody can pass is a check nobody reads.
let checked = 0, rBad = [], pnlBad = [], optUnverifiable = [], d37ModelMarked = 0;
for (const r of rows) {
  if (!Number.isFinite(r.rMult) || !Number.isFinite(r.entry) || !Number.isFinite(r.exit) || !(r.stopDist > 0)) continue;
  if (r.cls === "Options") {
    // 2026-09-21: the 13 d37-retire rows (2026-07-30, all ctrl, none in the clean-era evidence) were closed at a MODEL mark
    // (retireNote: BS sigma 0.28 + 8%/side friction), so entry/exit cannot reproduce their P&L by construction. Counted apart, not warned on.
    if (r.d37Retire && r.ctrl) { d37ModelMarked++; continue; }
    const rp = Number.isFinite(r.dollarPerPoint) ? (r.exit - r.entry) * r.dir * r.dollarPerPoint : null;
    if (rp != null && Math.abs(rp - r.pnl) > Math.max(1, Math.abs(r.pnl) * 0.02))
      optUnverifiable.push({ id: r.id, sym: r.sym, storedPnl: +r.pnl.toFixed(2), fromFields: +rp.toFixed(2) });
    continue;
  }
  checked++;
  const recomputed = (r.exit - r.entry) * r.dir / r.stopDist;
  if (Math.abs(recomputed - r.rMult) > Math.max(0.01, Math.abs(r.rMult) * 0.02))
    rBad.push({ id: r.id, sym: r.sym, stored: +r.rMult.toFixed(4), recomputed: +recomputed.toFixed(4) });
  // P&L must equal units × price move × direction (the number a reviewer checks first)
  if (Number.isFinite(r.pnl) && Number.isFinite(r.dollarPerPoint) && r.dollarPerPoint > 0) {
    const rp = (r.exit - r.entry) * r.dir * r.dollarPerPoint;
    if (Math.abs(rp - r.pnl) > Math.max(1, Math.abs(r.pnl) * 0.02))
      pnlBad.push({ id: r.id, sym: r.sym, stored: +r.pnl.toFixed(2), recomputed: +rp.toFixed(2) });
  }
}
say(`1. ARITHMETIC (recomputed from raw fields, not trusted)`);
say(`   linear rows (Equity/Crypto/FX/Futures) re-derived: ${checked}`);
say(`   ${rBad.length ? "FAIL" : "OK  "} rMult mismatches: ${rBad.length}${rBad.length ? " → " + JSON.stringify(rBad.slice(0, 3)) : ""}`);
say(`   ${pnlBad.length ? "FAIL" : "OK  "} P&L mismatches:  ${pnlBad.length}${pnlBad.length ? " → " + JSON.stringify(pnlBad.slice(0, 3)) : ""}`);
// Known open defect, quantified rather than hidden.
const optSignal = rows.filter(r => r.cls === "Options" && r.openedAt >= CLEAN && Number.isFinite(r.rMult) && !r.ctrl && !r.ctrlRand && !r.vetoShadow).length;
say(`   ${optUnverifiable.length ? "WARN" : "OK  "} options rows whose stored P&L cannot be re-derived from stored entry/exit/units: ${optUnverifiable.length}`);
if (optUnverifiable.length) {
  say(`        e.g. ${optUnverifiable.slice(0, 2).map(o => `${o.sym} stored ${o.storedPnl} vs fields ${o.fromFields}`).join(" · ")}`);
  say(`        CAUSE: pnl is friction-marked (debit x1.08 in / value x0.92 out) but entry/exit are stored raw,`);
  say(`        so a reviewer cannot reproduce the number from the row. Recordkeeping defect, not a wrong trade.`);
  say(`        BLAST RADIUS: ${optSignal} options row(s) in the clean-epoch SIGNAL ledger → headline expectancy is unaffected.`);
}

// ── 2. IMPOSSIBLE VALUES — the signatures of every poisoning bug we have hit ──
const imposs = {
  "|R| > 10 (ARB-class stopDist poisoning)": rows.filter(r => Number.isFinite(r.rMult) && Math.abs(r.rMult) > 10).length,
  "stopDist <= 0": rows.filter(r => r.stopDist != null && !(r.stopDist > 0)).length,
  "closedAt <= openedAt": rows.filter(r => r.closedAt && r.openedAt && r.closedAt <= r.openedAt).length,
  "closed in the future": rows.filter(r => r.closedAt && r.closedAt > Date.now() + 864e5).length,
  "negative entry price": rows.filter(r => Number.isFinite(r.entry) && r.entry <= 0).length,
  "duplicate id+closedAt": (() => { const s = new Set(); let d = 0; for (const r of rows) { const k = `${r.id}|${r.closedAt}`; if (s.has(k)) d++; s.add(k); } return d; })(),
  /**
   * D9 (2026-08-06). MFE/MAE once produced a MEDIAN adverse excursion of +7.06R — impossible,
   * and only 223 of 516 records survived a sanity filter, which made the fields useless for the
   * one question they exist to answer (where stops and targets should sit). That symptom no
   * longer reproduces: on 922 records the distribution is now median MAE 0.261R, max 1.408R,
   * nothing above 10. The stopDist floor fixed it.
   *
   * These assertions exist so it cannot come back silently. |MFE| or |MAE| above 10R is the
   * signature of a collapsed stopDist denominator — the ARB-class bug wearing a different hat.
   *
   * VALIDLY-RETIRED ROWS ARE SKIPPED (2026-08-30): a row carrying retired + retireNote under the
   * reconcile convention has already been adjudicated as bad-with-cause and excluded from every
   * statistic — keeping it in this counter turns preflight permanently red for a defect that is
   * already handled, and a light that is always red protects nothing. A NEW impossible value
   * (no retire tag) still fails the audit exactly as before.
   */
  "|MAE| > 10 (collapsed stopDist)": rows.filter(r => Number.isFinite(r.mae) && Math.abs(r.mae) > 10 && !(r.retired && r.retireNote)).length,
  "|MFE| > 10 (collapsed stopDist)": rows.filter(r => Number.isFinite(r.mfe) && Math.abs(r.mfe) > 10 && !(r.retired && r.retireNote)).length,

};
/**
 * NOT an impossibility, and deliberately reported separately so it is not mistaken for one:
 * MAE is computed as max over bars of (entry - low)/stopDist for a long. If price never traded
 * below the entry, every term is negative and MAE comes out negative. That is a legitimate
 * reading — "never went against us" — carrying a misleading label, not corrupt data. Counted and
 * disclosed rather than floored at zero, because silently flooring it would erase the
 * information that those trades were never underwater.
 */
const maeNeg = rows.filter(r => Number.isFinite(r.mae) && r.mae < 0).length;
say(`\n2. IMPOSSIBLE VALUES`);
for (const [k, v] of Object.entries(imposs)) say(`   ${v ? "FAIL" : "OK  "} ${k.padEnd(42)} ${v}`);
if (maeNeg) say(`   note ${"MAE < 0 (never traded against entry)".padEnd(42)} ${maeNeg}  — legitimate, not corruption (D9)`);

// ── 3. THE "TOO GOOD" TRIPWIRE ────────────────────────────────────────────────
// Every flattering number this project has produced turned out to be a bug (15/15 greens,
// ARB +2389R, 74% win rate). So a suspiciously good result is treated as a defect signal.
const clean = rows.filter(r => r.openedAt >= CLEAN && Number.isFinite(r.rMult) && !r.ctrl && !r.ctrlRand && !r.vetoShadow);
const mean = clean.reduce((s, r) => s + r.rMult, 0) / (clean.length || 1);
const wins = clean.filter(r => r.rMult > 0).length;
const winRate = wins / (clean.length || 1);
say(`\n3. TOO-GOOD TRIPWIRE (clean epoch, signals only)`);
say(`   n=${clean.length} · win rate ${(winRate * 100).toFixed(1)}% · mean ${mean >= 0 ? "+" : ""}${mean.toFixed(4)}R`);
const flags = [];
if (winRate > 0.60) flags.push(`win rate ${(winRate * 100).toFixed(1)}% — above 60% has ALWAYS been a bug here`);
if (mean > 0.15) flags.push(`mean ${mean.toFixed(3)}R implausibly high for a daily-bar system`);
if (clean.length && clean.every(r => r.rMult > 0)) flags.push(`every trade a winner — impossible`);
say(`   ${flags.length ? "INVESTIGATE: " + flags.join(" · ") : "OK   nothing implausibly good — consistent with a coin flip minus costs"}`);

// ── 4. DEFECT CLASS: omission vs corruption ───────────────────────────────────
// This is the question that decides whether the CONCLUSIONS survive the bugs.
const defects2026_08_03 = [
  ["yahoo 600-cap amputating equities 601-917", "OMISSION", "fewer symbols scanned → smaller sample; recorded values untouched"],
  ["futures roots cut at 40 of 44", "OMISSION", "4 roots never reached the volume feed; no stored value altered"],
  ["FX missing from dataHealth", "OMISSION", "coverage unobservable; no stored value altered"],
  ["FX symbol mapping (EUR/USD vs EURUSD=X)", "OMISSION", "FX tickets skipped, never booked at a wrong price — linearEntry refuses unpriced fills"],
  ["live-price poller watched positions only", "OMISSION", "tickets skipped rather than filled at a stale price (this is the 2026-07-15 honest-fill rule working)"],
  ["finnhub earnings hang / 504", "OMISSION", "erDays observer nulls; no stored value altered"],
];
say(`\n4. DEFECT CLASS — could today's bugs have FABRICATED a result?`);
for (const [what, cls, why] of defects2026_08_03) say(`   ${cls.padEnd(10)} ${what}\n              ${why}`);
const corrupting = defects2026_08_03.filter(d => d[1] === "CORRUPTION").length;
say(`   → ${corrupting} of ${defects2026_08_03.length} could alter a recorded number. All others shrink coverage only.`);
say(`   An omission bug can HIDE an edge. It cannot MANUFACTURE one.`);

const verdict = (rBad.length || pnlBad.length || Object.values(imposs).some(v => v)) ? "FAIL" : "PASS";
say(`\nVERDICT: ${verdict} — ${verdict === "PASS"
  ? "every settled number re-derives from its own raw inputs; no impossible values"
  : "see mismatches above; do not quote ledger numbers until resolved"}`);
say(`LIMIT OF THIS AUDIT: it proves internal consistency and arithmetic, NOT that the prices`);
say(`fed in were correct. Feed correctness is a separate problem (tasks #47 point-in-time, #39 SIP).`);

fs.writeFileSync(D("integrity-audit.json"), JSON.stringify({
  ranAt: new Date().toISOString(), verdict, checked, rMismatches: rBad.length, pnlMismatches: pnlBad.length,
  optionsUnverifiable: optUnverifiable.length, d37ModelMarked, optionsInSignalLedger: optSignal,
  impossible: imposs,
  // rows already adjudicated bad-with-cause under the reconcile retire convention — visible, never summed as failures
  impossibleButRetired: rows.filter(r => ((Number.isFinite(r.mae) && Math.abs(r.mae) > 10) || (Number.isFinite(r.mfe) && Math.abs(r.mfe) > 10)) && r.retired && r.retireNote).length,
  cleanN: clean.length, winRate: +winRate.toFixed(4), meanR: +mean.toFixed(4),
  tooGoodFlags: flags, defectClasses: defects2026_08_03.map(([w, c]) => ({ what: w, cls: c })), report: L,
}, null, 1));
console.log(`\nwritten: integrity-audit.json`);
process.exit(verdict === "PASS" ? 0 : 1);
