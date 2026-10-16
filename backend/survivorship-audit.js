#!/usr/bin/env node
/**
 * SURVIVORSHIP / UNIVERSE AUDIT — kill-test #46, light version (2026-08-03, "fix it all").
 *
 * Full survivorship correction needs delisted-inclusive prices (paid, decision #39). What CAN
 * be done honestly today: classify every artifact that makes a historical claim by how its
 * universe was constructed, and quantify the measurable bias signatures that already sit in
 * the recorded outputs. The result is a per-artifact verdict the reports can cite instead of
 * a vague "survivorship may apply".
 *
 * The one big prior finding this formalizes: in the 13F clone evals, WORSE reconstruction
 * (more unpriceable/unmatched names) associated with BETTER returns — dropped names are
 * disproportionately delisted losers, so coverage gaps inflate performance.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const rd = (f, fb) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return fb; } };

const audit = { ranAt: new Date().toISOString(), artifacts: [] };
const add = (a) => audit.artifacts.push(a);

// ── 1. The live board ledger — the artifact the funding decision actually rests on ──────────
{
  const log = rd("trade_log.json", []);
  const rows = Array.isArray(log) ? log : log.trades || [];
  add({
    artifact: "live board ledger (trade_log.json)",
    universe: "picked point-in-time from each session's live movers/scanner — no historical membership list",
    verdict: "CLEAN",
    why: `forward collection: every ticket was chosen with same-day information and settled forward; a symbol that later delists still settles at its actual exit. n=${rows.length} rows.`,
  });
}

// ── 2. 13F clone evals — the measurable bias signature ──────────────────────────────────────
{
  const ev = rd("autopilot-eval.json", null);
  const funds = ev ? (Array.isArray(ev.funds) ? ev.funds : Object.values(ev.funds || {})) : [];
  const pts = funds.filter(f => Number.isFinite(f.alpha) && Number.isFinite(f.maxUnmatchedNames));
  let corr = null;
  if (pts.length >= 3) {
    const xs = pts.map(p => p.maxUnmatchedNames), ys = pts.map(p => p.alpha);
    const mx = xs.reduce((s, x) => s + x) / xs.length, my = ys.reduce((s, y) => s + y) / ys.length;
    const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
    const den = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
    corr = den ? +(num / den).toFixed(2) : null;
  }
  add({
    artifact: "13F clone evals (autopilot-eval.json, TRAIDS_Autopilot_Report)",
    universe: "point-in-time filings, BUT unpriceable/unmatched names are dropped from the clone",
    verdict: "BIASED UPWARD — quantified signature",
    why: `dropped names skew toward delisted/OTC losers. Across ${pts.length} funds, corr(maxUnmatchedNames, alpha) = ${corr} (worse reconstruction ↔ better number). Clone alphas are CEILINGS, not estimates. Fund detail: ${pts.map(p => `${p.fund}: ${p.maxUnmatchedNames} unmatched → alpha ${p.alpha}%`).join("; ")}`,
    fix: "delisted-inclusive prices (decision #39)",
  });
}

// ── 3. Portfolio backtests (v1/v2 allocation, TLH, direct indexing) ─────────────────────────
add({
  artifact: "portfolio backtests v1/v2 (evidence portfolio, TRAIDS_Portfolio.xlsx forecasts)",
  universe: "ETFs and index sleeves (SPY/VTI/AGG/DBMF/JEPI etc.)",
  verdict: "LARGELY CLEAN, one caveat",
  why: "index funds internalize constituent churn — the index return already includes members that later died. Caveat: fund SELECTION is survivorship-tilted (DBMF/JEPI are funds that survived long enough to be picked; a 2019 chooser might have picked funds that closed). Affects sleeve choice, not index math.",
});
add({
  artifact: "direct-indexing TLH backtest (#25)",
  universe: "TODAY'S index members replayed over the historical window",
  verdict: "BIASED — direction mixed, tax-alpha figure is the robust part",
  why: "current members exclude stocks that fell out (often after losses) — the priced basket is winner-tilted, so absolute return is inflated. The TLH ALPHA (tax-loss harvest vs same basket unharvested) compares the same universe to itself, which cancels most of the bias. Use the alpha, not the level.",
});

// ── 4. R11 power-law screens ────────────────────────────────────────────────────────────────
add({
  artifact: "R11 crash-survivor pattern (historical motivation set: MU/PLTR/NFLX...)",
  universe: "named AFTER surviving — the definition of the bias",
  verdict: "HISTORICAL SET IS ILLUSTRATION ONLY",
  why: "every motivating example is conditioned on survival; the dead crash-names (dot-com delistings, 2022 SPACs) never enter the anecdote set. This is why R11 trades a FORWARD paper sleeve with pre-registered entry/exit — the forward record is clean; the historical narrative is not evidence and was never registered as such.",
});

// ── 5. 38-year tape studies (bear gauge, cross-asset percentiles) ───────────────────────────
add({
  artifact: "bear gauge + cross-asset history (SPY/index-level, 1988→)",
  universe: "index-level series only",
  verdict: "CLEAN for what it claims",
  why: "no constituent selection happens — index/sector/asset-class series carry their own churn internally. The gauge's conditional-return tables are index-level statements and survive this audit unchanged.",
});

fs.writeFileSync(D("survivorship-audit.json"), JSON.stringify(audit, null, 1));
for (const a of audit.artifacts) console.log(`${a.verdict.padEnd(46)} ${a.artifact}`);
console.log("\nwritten: survivorship-audit.json");
