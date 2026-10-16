#!/usr/bin/env node
/**
 * TRAIDS — Observer Validation
 *
 * After the forward test, this reads the trade log and asks, for each PASSIVE OBSERVER
 * we logged alongside every trade (regime alignment, cross-sectional momentum, short-term
 * reversal, volatility squeeze, RVOL, news sentiment): did it actually relate to the
 * realized outcome? It reports, per observer:
 *   • Pearson correlation of the observer vs realized R-multiple
 *   • split-bucket comparison (high vs low observer → win rate & avg R), with the gap
 *   • coverage (how many trades actually carried that observer)
 *
 * The observers NEVER affected which trades were taken — so any relationship here is a
 * genuine, out-of-sample-ish hint about which signal might help FUTURE selection. The
 * honest default expectation is ~zero correlation; a real, persistent gap is the rare
 * find worth acting on (and only after more data confirms it).
 *
 * Usage:  node backend/observer-validation.js
 *         node backend/observer-validation.js path/to/trade_log.json
 */
const fs = require("fs");
const path = require("path");

const FILE = process.argv[2] || path.join(__dirname, "data", "trade_log.json");

// observer key → human label + how to read it
const OBSERVERS = [
  { key: "regimeAlign", label: "Regime alignment", note: "+1 trade-with-SPY-trend, −1 against" },
  { key: "momPctile",   label: "X-sec momentum",   note: "0..1 N-day return rank in class" },
  { key: "revRet5",     label: "5-day reversal",   note: "recent 5d return (neg = loser)" },
  { key: "squeeze",     label: "Vol squeeze",      note: "1 = band-width at a low" },
  { key: "rvol",        label: "Relative volume",  note: "today vol / 20d avg" },
  { key: "newsScore",   label: "News sentiment",   note: "−1..+1 headline lexicon" },
];

function load() {
  let arr;
  try { const d = JSON.parse(fs.readFileSync(FILE, "utf8")); arr = Array.isArray(d) ? d : (d.trades || d.log || []); }
  catch (e) { console.error(`\n  Could not read ${FILE}: ${e.message}\n`); process.exit(1); }
  // closed trades with a realized R and an observer block
  return arr.filter(t => t && t.obs && t.rMult != null && isFinite(t.rMult));
}

function pearson(xs, ys) {
  const n = xs.length; if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const winRate = a => a.length ? a.filter(r => r > 0).length / a.length : 0;

(async () => {
  const trades = load();
  console.log(`\n  TRAIDS — Observer Validation  ·  ${trades.length} closed trades with observers  (${FILE})`);
  if (trades.length < 20) {
    console.log(`\n  ⚠ Only ${trades.length} trades carry observer data — far too few to read anything into.`);
    console.log(`    Observers were added 2026-06-24; they populate going forward. Re-run as the log grows`);
    console.log(`    (want 60+, ideally 100+, before any gap below means something).\n`);
  }
  console.log(`  (observers never affected selection — any signal here is a clean hint for FUTURE use)\n`);

  const pad = (s, n) => String(s).padEnd(n);
  console.log("  " + pad("Observer", 18) + pad("Cover", 8) + pad("Corr vs R", 12) + pad("Low→avgR", 11) + pad("High→avgR", 12) + pad("Win% L/H", 12) + "Read");
  console.log("  " + "─".repeat(96));

  const findings = [];
  for (const o of OBSERVERS) {
    const rows = trades.filter(t => t.obs[o.key] != null && isFinite(t.obs[o.key]));
    if (rows.length < 6) { console.log("  " + pad(o.label, 18) + pad(`${rows.length}`, 8) + "— too few"); continue; }
    const xs = rows.map(t => t.obs[o.key]), ys = rows.map(t => t.rMult);
    const corr = pearson(xs, ys);
    // median split into low / high observer buckets
    const sorted = [...xs].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const low = rows.filter(t => t.obs[o.key] <= med), high = rows.filter(t => t.obs[o.key] > med);
    const lowR = mean(low.map(t => t.rMult)), highR = mean(high.map(t => t.rMult));
    const gap = highR - lowR;
    const flag = corr != null && Math.abs(corr) >= 0.2 && Math.sign(corr) === Math.sign(gap) ? "★ worth watching" : "≈ noise";
    if (flag.startsWith("★")) findings.push({ o, corr, gap, n: rows.length });
    console.log("  " + pad(o.label, 18) + pad(`${rows.length}`, 8) +
      pad(corr == null ? "—" : corr.toFixed(2), 12) +
      pad(lowR.toFixed(2) + "R", 11) + pad(highR.toFixed(2) + "R", 12) +
      pad(`${(winRate(low.map(t=>t.rMult))*100).toFixed(0)}/${(winRate(high.map(t=>t.rMult))*100).toFixed(0)}%`, 12) + flag);
  }

  console.log("\n  Reading: 'Corr vs R' near 0 = no relationship (expected). A persistent |corr| ≥ ~0.2 where the");
  console.log("  high-bucket avg R clearly beats the low bucket is the rare candidate to fold into selection.");
  if (findings.length) {
    console.log(`\n  ★ ${findings.length} observer(s) showed a non-trivial relationship — candidates, NOT conclusions:`);
    for (const f of findings) console.log(`     • ${f.o.label}: corr ${f.corr.toFixed(2)}, high−low gap ${f.gap.toFixed(2)}R (n=${f.n}) — confirm with more data before trusting.`);
  } else {
    console.log("\n  → No observer beat noise yet. Honest and expected — keep logging, re-run when the sample is larger.");
  }
  console.log("");
})();
