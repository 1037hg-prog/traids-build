#!/usr/bin/env node
/**
 * TEST #57 — DOES MARKET-LEVEL STATE CONDITION THE BOARD'S OUTCOMES?
 *
 * PRE-REGISTERED 2026-07-28, before any result was computed. Operator-specified: "does sector
 * leadership or index dispersion condition the board's outcomes, on the 9,652-session record
 * rather than 7 observations."
 *
 * WHY THIS IS THE FIRST FAIR VERSION OF THE QUESTION. Every previous attempt to ask whether
 * market state matters ran on the observer fields, which exist only inside trade records — 16
 * sessions total, and only where something was traded. The market tape built 2026-07-28 records
 * the four indices separately, 11 sectors, breadth and cross-asset every session back to 1988,
 * independent of whether we traded. Joined to the 52,312-trade replay book, a market-level
 * question finally has a market-sized sample.
 *
 * WHAT IS ALREADY KNOWN, so this is not re-asking a settled question. Test #32 tested REGIME as
 * a conditioner on 44,002 trades: regime:aligned −0.0400R, regime:counter −0.0574R, both
 * negative, nothing to keep. But that was SPY-versus-its-50-day-MA — a single binary on one
 * index. It says nothing about SECTOR DISPERSION, index DISAGREEMENT, or BREADTH, which are the
 * states the operator actually named and which no test here has touched.
 *
 * THE CONDITIONS TESTED — declared now, 6 cells, no search
 *   1. sector dispersion HIGH  (top tercile of cross-sector sd)
 *   2. sector dispersion LOW   (bottom tercile)
 *   3. indices DISAGREED on sign that session
 *   4. indices AGREED on sign
 *   5. breadth NARROW (equal-weight underperformed cap-weight, bottom tercile)
 *   6. breadth BROAD  (top tercile)
 * Bonferroni over 6 → |t| >= 2.64.
 *
 * STATISTICS. Day-clustered — hundreds of trades share each session's market move, so a
 * per-trade t is inflated by roughly sqrt(trades-per-day). This is the correction that turned
 * #52's apparent 2.39 into 1.06, and it is applied from the start here.
 *
 * WHAT WOULD COUNT. A condition is only useful if its COMPLEMENT differs. "Trades do badly in
 * high dispersion" is worthless if they do equally badly in low dispersion — that was the
 * finding that killed the whole cohort-deletion idea on 2026-07-28, where every partition of
 * the book was negative on both sides. So each pair is reported together and the SPREAD between
 * them is the statistic, not either leg.
 *
 * DECISION RULE — fixed now
 *   CONDITIONING FOUND   if any declared pair shows a spread with |day-clustered t| >= 2.64
 *                        AND the two legs differ in SIGN (one side actually positive).
 *   NO CONDITIONING      if no pair clears that, or if every leg is negative — in which case
 *                        the state describes the market without separating our outcomes.
 *
 * EXPECTED OUTCOME, ON THE RECORD: no conditioning. The board's gross expectancy is +0.0017R
 * with t 0.19 at ZERO cost, and a book with no edge to redistribute has nothing for a
 * conditioner to find. I expect every leg negative net of cost and the spreads inside noise.
 * If a pair separates with one side genuinely positive, that is the first market-level
 * conditioner this project has found and it would matter.
 *
 * Usage: node backend/tape-conditioning-test.js
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const T_BAR = 2.64;                     // Bonferroni over 6 declared cells
const COST_R = 0.05;                    // same charge the replay book was scored at in #32

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const R = (v) => v == null ? "     —" : (v >= 0 ? "+" : "") + v.toFixed(4);

/** day-clustered mean and t: the session is the unit of independence */
function clustered(rows) {
  const by = new Map();
  for (const r of rows) { const a = by.get(r.t) || []; a.push(r.g - COST_R); by.set(r.t, a); }
  const per = [...by.values()].map(mean);
  if (per.length < 5) return { m: null, t: null, days: per.length, n: rows.length };
  const m = mean(per), s = sd(per);
  return { m, t: s ? m / (s / Math.sqrt(per.length)) : null, days: per.length, n: rows.length, per };
}
/** difference of two day-clustered series, paired where the days overlap */
function spreadT(aRows, bRows) {
  const ma = new Map(), mb = new Map();
  for (const r of aRows) { const x = ma.get(r.t) || []; x.push(r.g - COST_R); ma.set(r.t, x); }
  for (const r of bRows) { const x = mb.get(r.t) || []; x.push(r.g - COST_R); mb.set(r.t, x); }
  // these are DISJOINT day sets by construction (a day is high-dispersion or it isn't), so the
  // comparison is unpaired — use a two-sample t on the per-day means.
  const A = [...ma.values()].map(mean), B = [...mb.values()].map(mean);
  if (A.length < 5 || B.length < 5) return { diff: null, t: null };
  const mA = mean(A), mB = mean(B), sA = sd(A), sB = sd(B);
  const se = Math.sqrt((sA * sA) / A.length + (sB * sB) / B.length);
  return { diff: mA - mB, t: se ? (mA - mB) / se : null, nA: A.length, nB: B.length };
}

(async () => {
  console.log(`\n  TEST #57 — DOES MARKET-LEVEL STATE CONDITION THE BOARD'S OUTCOMES?`);
  console.log(`  pre-registered 2026-07-28 · 6 declared cells · Bonferroni bar |t| >= ${T_BAR}`);
  console.log(`  day-clustered throughout — a per-trade t here would be inflated ~sqrt(trades/day)\n`);

  if (!fs.existsSync(D("book-gross.json"))) { console.error("  book-gross.json missing — run cost-sensitivity-book.js first.\n"); process.exit(1); }
  if (!fs.existsSync(D("market-tape.json"))) { console.error("  market-tape.json missing — run market-tape.js --full first.\n"); process.exit(1); }
  const book = JSON.parse(fs.readFileSync(D("book-gross.json"), "utf8")).trades;
  const tape = JSON.parse(fs.readFileSync(D("market-tape.json"), "utf8")).days;

  // join: every replayed trade carries its session date
  const joined = book.filter(x => tape[x.t]);
  const days = [...new Set(joined.map(x => x.t))];
  console.log(`  ${book.length.toLocaleString()} replayed trades · ${joined.length.toLocaleString()} joined to a tape session (${days.length} sessions)`);
  const miss = book.length - joined.length;
  if (miss) console.log(`  ${miss.toLocaleString()} trades had no tape row — reported, not dropped silently.`);

  // tercile cuts computed on the JOINED sessions only, so the cut points describe this window
  const cut = (key) => {
    const vals = days.map(d => tape[d][key]).filter(v => v != null).sort((a, b) => a - b);
    return { lo: vals[Math.floor(vals.length / 3)], hi: vals[Math.floor(2 * vals.length / 3)] };
  };
  const cDisp = cut("secDisp"), cBr = cut("breadth");
  console.log(`\n  cut points on this window:  sector dispersion ${(100 * cDisp.lo).toFixed(2)}% / ${(100 * cDisp.hi).toFixed(2)}%   ·   breadth ${(100 * cBr.lo).toFixed(2)}% / ${(100 * cBr.hi).toFixed(2)}%`);

  const CELLS = [
    ["sector dispersion HIGH", x => tape[x.t].secDisp != null && tape[x.t].secDisp >= cDisp.hi],
    ["sector dispersion LOW", x => tape[x.t].secDisp != null && tape[x.t].secDisp <= cDisp.lo],
    ["indices DISAGREED", x => tape[x.t].split === true],
    ["indices AGREED", x => tape[x.t].split === false],
    ["breadth NARROW", x => tape[x.t].breadth != null && tape[x.t].breadth <= cBr.lo],
    ["breadth BROAD", x => tape[x.t].breadth != null && tape[x.t].breadth >= cBr.hi],
  ];

  console.log(`\n  ══ THE SIX DECLARED CELLS (net of ${COST_R}R) ══`);
  console.log(`  condition                    trades   sessions   avgR       clust t`);
  const res = {};
  for (const [label, fn] of CELLS) {
    const rows = joined.filter(fn);
    const c = clustered(rows);
    res[label] = c;
    console.log(`  ${label.padEnd(28)} ${String(c.n).padStart(6)}   ${String(c.days).padStart(6)}   ${R(c.m).padStart(9)}   ${(c.t == null ? "—" : c.t.toFixed(2)).padStart(6)}`);
  }
  const whole = clustered(joined);
  console.log(`  ${"— whole book —".padEnd(28)} ${String(whole.n).padStart(6)}   ${String(whole.days).padStart(6)}   ${R(whole.m).padStart(9)}   ${(whole.t == null ? "—" : whole.t.toFixed(2)).padStart(6)}`);

  console.log(`\n  ══ THE PAIRS — a condition is only useful if its COMPLEMENT differs ══`);
  console.log(`  pair                                    spread     t       both legs negative?`);
  const PAIRS = [
    ["dispersion HIGH − LOW", "sector dispersion HIGH", "sector dispersion LOW"],
    ["indices DISAGREED − AGREED", "indices DISAGREED", "indices AGREED"],
    ["breadth BROAD − NARROW", "breadth BROAD", "breadth NARROW"],
  ];
  let found = [];
  for (const [label, a, b] of PAIRS) {
    const rowsA = joined.filter(CELLS.find(c => c[0] === a)[1]);
    const rowsB = joined.filter(CELLS.find(c => c[0] === b)[1]);
    const s = spreadT(rowsA, rowsB);
    const bothNeg = res[a].m < 0 && res[b].m < 0;
    const clears = s.t != null && Math.abs(s.t) >= T_BAR && !bothNeg;
    if (clears) found.push(label);
    console.log(`  ${label.padEnd(38)} ${R(s.diff).padStart(9)}  ${(s.t == null ? "—" : s.t.toFixed(2)).padStart(6)}    ${bothNeg ? "YES — nothing to keep" : "no"}`);
  }

  console.log(`\n  ══ ADJUDICATION ══`);
  const verdict = found.length
    ? `CONDITIONING FOUND — ${found.join(", ")} clears |t| >= ${T_BAR} with a positive leg. First market-level conditioner in this project; forward confirmation required before any rule change.`
    : `NO CONDITIONING — no declared pair separates outcomes at the corrected bar with a positive side. Market-level state describes the market; it does not separate this book's results. Consistent with the board's gross expectancy of +0.0017R at t 0.19: a book with no edge has nothing for a conditioner to redistribute.`;
  console.log(`  ${verdict}\n`);

  fs.writeFileSync(D("tape-conditioning-57.json"), JSON.stringify({
    generated: new Date().toISOString(), test: 57,
    preRegistered: "2026-07-28, operator-specified, before any result computed.",
    joinedTrades: joined.length, sessions: days.length, unjoined: miss,
    costR: COST_R, correctedBar: T_BAR, cutPoints: { secDisp: cDisp, breadth: cBr },
    cells: res, verdict,
    caveats: [
      "The replay book is the board's ARCHETYPE (7-vote ensemble, ATR stops, next-bar settle), not literally today's live board.",
      "Tape and book overlap only where both exist; unjoined trades are reported above, never dropped silently.",
      "Tercile cuts are computed on the joined window, so they describe this period rather than all history.",
      "A null here does not mean market state is irrelevant to trading — it means it does not separate THIS book's outcomes.",
    ],
  }, null, 1));
  console.log(`  written: backend/data/tape-conditioning-57.json\n`);
})();
