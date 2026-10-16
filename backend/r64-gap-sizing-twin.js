#!/usr/bin/env node
/**
 * GAP-AWARE SIZING — RETROSPECTIVE, BOTH TAILS. Writes data/gap-sizing-retro.json.
 *
 * Re-sizes every clean-era ticket under lib/gap-aware-sizing.js and reports what the book would
 * have looked like. The rule shrinks size on gap-prone names, so it necessarily shrinks WINNERS
 * on those names as well as losers. This file exists to make that cost visible BEFORE anything is
 * wired, because the version of this that only shows prevented losses is a sales pitch, and a
 * rule proposed this morning on exactly that basis (flat-at-close) died the moment both arms were
 * measured — mean D -0.037R, holding came out marginally ahead.
 *
 * WHAT IS AND IS NOT CHANGED. Only the denominator: qty = riskDollars / effectiveStopDist where
 * effectiveStopDist = max(stopDist, p95 adverse overnight gap x entry). Entries, exits, stops,
 * signals and the risk budget per ticket are all untouched — the same trades, at a size set
 * against the risk actually taken. P&L rescales by shrinkFactor = stopDist / effectiveStopDist.
 *
 * THE HONEST STATISTIC is the paired per-SESSION difference, day-clustered. Rescaling every
 * ticket by a factor is not a new sample; it is the same sample re-weighted, so a t across
 * tickets would be meaningless. Sessions are the unit.
 */
const fs = require("fs"), path = require("path");
const rc = require("./lib/reconcile.js");
const GAS = require("./lib/gap-aware-sizing.js");
const { fetchBars } = require("./lib/alpaca-bars.js");
const { fetchCryptoBars } = require("./lib/crypto-bars.js");
const OUT = path.join(__dirname, "data", "r64-gap-sizing-twin.json");
const EVIDENCE_START = "2026-08-31";
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

(async () => {
  const L = rc.cleanEraLedger();
  rc.assertReconciled("clean-era pooled edge", rc.recomputeEdge(L), L.pooledEdgeR);
  const T = L.signals.filter(t => t && Number.isFinite(t.pnl) && Number.isFinite(t.stopDist) && t.stopDist > 0
    && Number.isFinite(t.entry) && t.entry > 0 && t.openedAt && t.closedAt);

  const eq = [...new Set(T.filter(t => t.cls === "Equity").map(t => t.sym))];
  const cx = [...new Set(T.filter(t => t.cls === "Crypto").map(t => t.sym))];
  let bars = {};
  try {
    const end = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    if (eq.length) Object.assign(bars, (await fetchBars(eq, { start: "2026-01-02", end, timeframe: "1Day", requireAll: false, quiet: true })).bars || {});
    if (cx.length) Object.assign(bars, await fetchCryptoBars(cx, "1Day", "2026-01-02", end));
  } catch (e) { console.error("bar fetch failed: " + e.message + " — class floors only for the affected names"); }

  const rows = [];
  for (const t of T) {
    const overnight = etDay(t.openedAt) !== etDay(t.closedAt);
    const b = (bars[t.sym] || []).filter(x => x.t.slice(0, 10) <= etDay(t.openedAt));   // POINT IN TIME
    const s = GAS.sizeQty({ riskDollars: t.riskDollars || 250, cls: t.cls, entry: t.entry,
      stopDist: t.stopDist, dir: t.dir || 1, bars: b.length ? b : null, holdsOvernight: overnight });
    rows.push({ sym: t.sym, cls: t.cls, day: etDay(t.closedAt), overnight,
      pnl: t.pnl, rMult: t.rMult, shrink: +s.shrinkFactor.toFixed(4), basis: s.basis,
      newPnl: t.pnl * s.shrinkFactor, reason: t.reason || null });
  }

  const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);
  const win = rows.filter(r => r.pnl > 0), loss = rows.filter(r => r.pnl <= 0);
  const byDay = {};
  for (const r of rows) (byDay[r.day] ||= []).push(r);
  const dayKeys = Object.keys(byDay).sort();
  const diffOf = (d) => sum(byDay[d], "newPnl") - sum(byDay[d], "pnl");
  const evDays = dayKeys.filter(d => d >= EVIDENCE_START), pvDays = dayKeys.filter(d => d < EVIDENCE_START);
  const tCalc = (a) => { if (a.length < 2) return null; const m2 = mean(a); const s2 = Math.sqrt(a.reduce((s, x) => s + (x - m2) ** 2, 0) / (a.length - 1)); return s2 > 0 ? +(m2 / (s2 / Math.sqrt(a.length))).toFixed(3) : null; };
  const evidence = { sessions: evDays.length, meanDelta: evDays.length ? +mean(evDays.map(diffOf)).toFixed(2) : null, t: tCalc(evDays.map(diffOf)) };
  const preview = { sessions: pvDays.length, meanDelta: pvDays.length ? +mean(pvDays.map(diffOf)).toFixed(2) : null, t: tCalc(pvDays.map(diffOf)), weightless: true };
  const diffs = dayKeys.map(diffOf);
  const m = mean(diffs), sd = diffs.length > 1 ? Math.sqrt(diffs.reduce((s, x) => s + (x - m) ** 2, 0) / (diffs.length - 1)) : 0;
  const t = sd > 0 ? m / (sd / Math.sqrt(diffs.length)) : null;

  const shrunk = rows.filter(r => r.shrink < 0.999);
  /**
   * 2026-09-10 (test-triage COUNT NOT EXPOSED fix). R64's registry bar is minSessions:30 —
   * test-triage.js's field-priority resolver (backend/test-triage.js:133) matches "minSessions"
   * directly, and evDays.length (evidence.sessions below) is exactly that count. dailyClock.sessions
   * = evidence.sessions. estimate = evidence.meanDelta, the registered statistic (mean per-session
   * dollar delta, gap-aware sizing minus live). bySession is one row per evidence session, that
   * session's own dollar diffOf(d) — the numbers evidence.t was built from.
   */
  const dailyClock = {
    sessions: evDays.length,
    estimate: evidence.meanDelta,
    unit: "entry sessions since evidenceStart (mean per-session dollar delta, gap-aware sizing minus live)",
  };
  const bySession = evDays.map((d) => ({ session: d, mean: +diffOf(d).toFixed(2) }));

  const out = { dailyClock, bySession,
    spec: "R64 gap-sizing twin", registered: "2026-08-28", evidenceStart: EVIDENCE_START, bar: "day-clustered t >= 2.378 at 30 sessions (best-of-4)", builtAt: new Date().toISOString(),
    rule: "qty = riskDollars / max(stopDist, p95 adverse overnight gap x entry); intraday and defined-risk tickets unchanged",
    tickets: rows.length, resized: shrunk.length, medianShrink: shrunk.length ? +[...shrunk.map(r => r.shrink)].sort((a, b) => a - b)[Math.floor(shrunk.length / 2)].toFixed(3) : null,
    bothTails: {
      winners: { n: win.length, before: Math.round(sum(win, "pnl")), after: Math.round(sum(win, "newPnl")), givenUp: Math.round(sum(win, "pnl") - sum(win, "newPnl")) },
      losers: { n: loss.length, before: Math.round(sum(loss, "pnl")), after: Math.round(sum(loss, "newPnl")), saved: Math.round(sum(loss, "newPnl") - sum(loss, "pnl")) },
    },
    net: { before: Math.round(sum(rows, "pnl")), after: Math.round(sum(rows, "newPnl")), delta: Math.round(sum(rows, "newPnl") - sum(rows, "pnl")) },
    evidence, preview,
    perSession: { sessions: diffs.length, meanDeltaDollars: m === null ? null : +m.toFixed(2), tClustered: t === null ? null : +t.toFixed(3) },
    worstTicketsBefore: rows.slice().sort((a, b) => a.pnl - b.pnl).slice(0, 6)
      .map(r => ({ sym: r.sym, reason: r.reason, was: Math.round(r.pnl), now: Math.round(r.newPnl), shrink: r.shrink })),
    biggestWinnersBefore: rows.slice().sort((a, b) => b.pnl - a.pnl).slice(0, 6)
      .map(r => ({ sym: r.sym, reason: r.reason, was: Math.round(r.pnl), now: Math.round(r.newPnl), shrink: r.shrink })),
    caveat: "Rescaling the same tickets is not a new sample — it is the same sample re-weighted, so the honest unit is the SESSION and the honest statistic is the paired per-session difference. Nothing here is a registered result.",
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  const $ = (n) => (n >= 0 ? "+$" : "-$") + Math.abs(n).toLocaleString();
  console.log(`GAP-AWARE SIZING — retrospective on ${rows.length} clean-era tickets`);
  console.log(`  resized: ${shrunk.length} (median shrink to ${out.medianShrink} of original size) · intraday and defined-risk untouched`);
  console.log("");
  console.log("  BOTH TAILS");
  console.log(`    winners  ${out.bothTails.winners.n}   ${$(out.bothTails.winners.before)} -> ${$(out.bothTails.winners.after)}    GIVEN UP ${$(-out.bothTails.winners.givenUp)}`);
  console.log(`    losers   ${out.bothTails.losers.n}   ${$(out.bothTails.losers.before)} -> ${$(out.bothTails.losers.after)}    SAVED    ${$(out.bothTails.losers.saved)}`);
  console.log("");
  console.log(`  NET  ${$(out.net.before)} -> ${$(out.net.after)}   delta ${$(out.net.delta)}`);
  console.log(`  per session: mean ${$(out.perSession.meanDeltaDollars)} over ${out.perSession.sessions} sessions · day-clustered t ${out.perSession.tClustered}`);
  console.log("");
  console.log("  worst tickets before -> after:");
  for (const r of out.worstTicketsBefore) console.log(`    ${r.sym.padEnd(9)}${String(r.reason || "").padEnd(10)} ${$(r.was).padStart(9)} -> ${$(r.now).padStart(9)}   (x${r.shrink})`);
  console.log("  biggest winners before -> after:");
  for (const r of out.biggestWinnersBefore) console.log(`    ${r.sym.padEnd(9)}${String(r.reason || "").padEnd(10)} ${$(r.was).padStart(9)} -> ${$(r.now).padStart(9)}   (x${r.shrink})`);
  console.log("");
  console.log();
  console.log();
  console.log("");
  console.log("  R64 PREVIEW (weightless): " + preview.sessions + " sessions · mean "
    + (preview.meanDelta === null ? "n/a" : $(preview.meanDelta)) + "/session · t " + (preview.t === null ? "n/a" : preview.t));
  console.log("  R64 EVIDENCE:             " + evidence.sessions + " sessions · mean "
    + (evidence.meanDelta === null ? "n/a" : $(evidence.meanDelta)) + "/session · t " + (evidence.t === null ? "n/a" : evidence.t)
    + "   bar t >= 2.378 at 30 sessions");
  console.log("written: data/r64-gap-sizing-twin.json");
})();
