#!/usr/bin/env node
/**
 * TRAIDS — MARKET TAPE: a standalone daily record of what the market did.
 *
 * WHY THIS DID NOT EXIST, WHICH IS THE POINT. Asked on 2026-07-28 whether TRAIDS tracks the
 * market as a whole, the answer was no. Market state was recorded ONLY as observer fields
 * attached to trade records — vix, oil20, y10, curve and the rest — which means:
 *
 *   · the market history was exactly as long as the TRADING history: 16 sessions;
 *   · a day with no trades produced no market record at all;
 *   · and the market could only ever be described in the shape of our own positions.
 *
 * Meanwhile ^GSPC goes back to 1988 (9,653 sessions), ^VIX to 1990, and all of it is free.
 * The system was measuring itself and calling it measuring the market.
 *
 * WHAT THIS RECORDS. Every session, independent of whether anything was traded:
 *   · the four indices separately — Dow, S&P, Nasdaq, Russell — because "the market was up"
 *     hides the case the operator actually named: Dow up while Nasdaq is down.
 *   · DISPERSION across those four, which is the size of that disagreement.
 *   · cross-asset context: VIX, the 10-year, the dollar, gold, high yield, long bonds.
 *   · a breadth proxy from the equal-weight vs cap-weight spread (RSP vs SPY), which says
 *     whether a move was broad or a handful of names.
 *
 * IT IS APPEND-ONLY AND BACKFILLED. First run pulls the full available history so the record
 * starts deep rather than starting today. Later runs append only what is new. A market record
 * that begins the day you thought of it is worth very little.
 *
 * WHAT IT IS NOT. This is a LEDGER, not a signal. It makes questions like "does index
 * divergence predict tomorrow" answerable on thousands of sessions instead of the seven the
 * observer fields could offer — but it asserts nothing about prediction, and nothing here is
 * wired to any trading decision.
 *
 * Usage:  node backend/market-tape.js            append today, print the read
 *         node backend/market-tape.js --full     rebuild the whole history
 *         node backend/market-tape.js --stats    what the record can already answer
 */
const fs = require("fs"), path = require("path");
const MKT = "http://localhost:3002/api/yahoo";
const STORE = path.join(__dirname, "data", "market-tape.json");
const FULL = process.argv.includes("--full");
const STATS = process.argv.includes("--stats");

const SERIES = [
  ["dow", "^DJI", "Dow Jones Industrial"],
  ["spx", "^GSPC", "S&P 500"],
  ["ndx", "^IXIC", "Nasdaq Composite"],
  ["rut", "^RUT", "Russell 2000"],
  ["vix", "^VIX", "volatility index"],
  ["y10", "^TNX", "10-year yield"],
  ["dxy", "DX-Y.NYB", "dollar index"],
  ["gld", "GLD", "gold"],
  ["hyg", "HYG", "high yield credit"],
  ["tlt", "TLT", "long treasuries"],
  ["spy", "SPY", "cap-weighted S&P"],
  ["rsp", "RSP", "equal-weighted S&P"],
];

/**
 * SECTORS — the half that was missing from the first version, and the half the operator named:
 * "sector up or down being a major signal".
 *
 * A single market direction is a lossy summary. On 2026-07-28 the Dow rose 1.03% while the
 * Nasdaq fell 0.22% — the indices disagreed on SIGN, which happens in 32% of sessions. The
 * sector spread is where that disagreement is legible: it says WHAT rotated, not just whether
 * "the market" was up.
 *
 * Recorded as a ledger, exactly like the indices. Nothing here is wired to a decision.
 */
const SECTORS = [
  ["xlk", "XLK", "Technology"], ["xlf", "XLF", "Financials"], ["xle", "XLE", "Energy"],
  ["xlv", "XLV", "Health Care"], ["xli", "XLI", "Industrials"], ["xly", "XLY", "Cons Discretionary"],
  ["xlp", "XLP", "Cons Staples"], ["xlu", "XLU", "Utilities"], ["xlre", "XLRE", "Real Estate"],
  ["xlb", "XLB", "Materials"], ["xlc", "XLC", "Communication"],
];

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const pct = (v, d = 2) => v == null ? "    —" : (v >= 0 ? "+" : "") + (100 * v).toFixed(d) + "%";
const arrow = (v) => v == null ? " " : v > 0.0005 ? "▲" : v < -0.0005 ? "▼" : "·";

async function series(sym) {
  try {
    const r = await fetch(`${MKT}/${encodeURIComponent(sym)}/history?days=${FULL ? 14000 : 400}&interval=1d`, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) return null;
    return ((await r.json()).bars || []).filter(b => Number.isFinite(b.close));
  } catch { return null; }
}

(async () => {
  console.log(`\n  TRAIDS — MARKET TAPE${FULL ? "  (full backfill)" : ""}`);
  const store = (() => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return { started: "2026-07-28", note: "Standalone daily market record, independent of whether TRAIDS traded. Append-only.", days: {} }; } })();

  if (!STATS) {
    const data = {};
    process.stdout.write("  fetching");
    for (const [k, sym] of [...SERIES, ...SECTORS]) { data[k] = await series(sym); process.stdout.write(data[k] ? "." : "x"); }
    console.log("");

    // union of dates where at least the four indices exist
    const idx = ["dow", "spx", "ndx", "rut"];
    const maps = {}; for (const [k] of [...SERIES, ...SECTORS]) maps[k] = new Map((data[k] || []).map(b => [b.date, b.close]));
    const dates = [...new Set(idx.flatMap(k => [...maps[k].keys()]))].sort();

    let added = 0;
    for (let i = 1; i < dates.length; i++) {
      const d = dates[i], p = dates[i - 1];
      if (store.days[d] && !FULL) continue;
      const ret = (k) => { const a = maps[k].get(p), b = maps[k].get(d); return (a > 0 && b > 0) ? b / a - 1 : null; };
      const row = {};
      for (const [k] of [...SERIES, ...SECTORS]) { const v = ret(k); if (v != null) row[k] = +v.toFixed(6); }
      // VIX and the 10-year are LEVELS worth keeping, not just changes
      if (maps.vix.get(d) != null) row.vixLvl = maps.vix.get(d);
      if (maps.y10.get(d) != null) row.y10Lvl = maps.y10.get(d);
      const four = idx.map(k => row[k]).filter(v => v != null);
      if (four.length < 3) continue;
      row.disp = +(sd(four) ?? 0).toFixed(6);                       // how much the indices disagreed
      row.split = four.some(v => v > 0) && four.some(v => v < 0);    // did they disagree on SIGN
      const sv = SECTORS.map(([k]) => row[k]).filter(v => v != null);
      if (sv.length >= 8) { row.secDisp = +(sd(sv) ?? 0).toFixed(6); row.secUp = sv.filter(v => v > 0).length; row.secN = sv.length; }
      if (row.spy != null && row.rsp != null) row.breadth = +(row.rsp - row.spy).toFixed(6);  // equal-weight minus cap-weight
      store.days[d] = row;
      added++;
    }
    fs.writeFileSync(STORE, JSON.stringify(store));
    console.log(`  +${added} session(s) appended · ${Object.keys(store.days).length.toLocaleString()} sessions held`);
  }

  const days = Object.keys(store.days).sort();
  if (!days.length) { console.log("  no data.\n"); return; }
  const last = days[days.length - 1], r = store.days[last];
  console.log(`  record spans ${days[0]} → ${last}\n`);

  console.log(`  ══ ${last} ══`);
  for (const [k, , label] of SERIES.slice(0, 4)) console.log(`    ${arrow(r[k])} ${label.padEnd(24)} ${pct(r[k])}`);
  console.log(`    ${r.split ? "⚠  THE INDICES DISAGREED ON SIGN" : "   indices agreed on direction"} · dispersion ${pct(r.disp, 2)}`);
  console.log("");
  for (const [k, , label] of SERIES.slice(4, 10)) if (r[k] != null) console.log(`    ${arrow(r[k])} ${label.padEnd(24)} ${pct(r[k])}`);
  if (r.vixLvl != null) console.log(`      VIX level ${r.vixLvl.toFixed(2)}${r.y10Lvl != null ? `   ·   10-year ${r.y10Lvl.toFixed(2)}` : ""}`);
  if (r.breadth != null) console.log(`    ${arrow(r.breadth)} breadth (equal−cap weight)  ${pct(r.breadth)}  ${r.breadth < -0.002 ? "← narrow: a few names carried it" : r.breadth > 0.002 ? "← broad participation" : ""}`);

  // ── SECTOR ROTATION for the session ──────────────────────────────────────
  // "The market was up" is a lossy summary. This says WHAT rotated — which is the half the
  // operator named and the half the board weighs at zero.
  const secRows = SECTORS.map(([k, , label]) => [label, r[k]]).filter(x => x[1] != null).sort((a, b) => b[1] - a[1]);
  if (secRows.length) {
    console.log(`\n  ══ SECTOR ROTATION ══   ${r.secUp}/${r.secN} sectors up · dispersion ${pct(r.secDisp, 2)}`);
    for (const [label, v] of secRows) console.log(`    ${arrow(v)} ${label.padEnd(20)} ${pct(v)}`);
    const spread = secRows[0][1] - secRows[secRows.length - 1][1];
    console.log(`    -> leadership: ${secRows[0][0]} over ${secRows[secRows.length - 1][0]}, a ${pct(spread)} spread`);
  }

  console.log(`\n  ══ WHAT THIS RECORD MAKES ANSWERABLE ══`);
  const withAll = days.filter(d => store.days[d].dow != null && store.days[d].ndx != null);
  const splits = withAll.filter(d => store.days[d].split);
  console.log(`  ${withAll.length.toLocaleString()} sessions with all four indices`);
  console.log(`  ${splits.length.toLocaleString()} of them (${(100 * splits.length / withAll.length).toFixed(1)}%) had the indices DISAGREE ON SIGN`);
  console.log(`     — i.e. "Dow up, Nasdaq down" is not rare; it is roughly one session in ${Math.round(withAll.length / Math.max(1, splits.length))}.`);
  // next-day behaviour after a split day, purely descriptive
  const nxt = [];
  for (let i = 0; i < withAll.length - 1; i++) {
    if (!store.days[withAll[i]].split) continue;
    const n = store.days[withAll[i + 1]];
    if (n && n.spx != null) nxt.push(n.spx);
  }
  const base = withAll.slice(0, -1).map(d => store.days[d].spx).filter(v => v != null);
  if (nxt.length > 30) {
    const m1 = mean(nxt), m0 = mean(base), s = sd(nxt);
    const t = s ? (m1 - m0) / (s / Math.sqrt(nxt.length)) : null;
    console.log(`\n  descriptive only — S&P the day AFTER a sign-split day:`);
    console.log(`     ${pct(m1, 3)} vs an unconditional ${pct(m0, 3)}   difference ${pct(m1 - m0, 3)}   t ${t == null ? "—" : t.toFixed(2)}`);
    console.log(`     ${t != null && Math.abs(t) >= 2 ? "distinguishable — worth a PRE-REGISTERED test, which this is not" : "not distinguishable from the unconditional mean"}`);
  }
  console.log(`\n  This is a LEDGER. Nothing here is wired to a trading decision, and no hypothesis`);
  console.log(`  has been pre-registered against it. It exists so that day-level questions have a`);
  console.log(`  sample measured in thousands rather than the 7 the observer fields could offer.\n`);
})();
