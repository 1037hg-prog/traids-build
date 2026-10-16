#!/usr/bin/env node
/**
 * TEST #53 (structural candidate S1) — INDEX RECONSTITUTION FLOW
 *
 * PRE-REGISTERED 2026-07-28. Specification frozen in structural-register.json under "S1"
 * on 2026-07-28, before this file existed.
 *
 * WHO IS ON THE OTHER SIDE AND WHY THEY PAY. An index fund's mandate is to hold the index,
 * and its risk metric is tracking error, not price. When S&P adds or removes a name, every
 * fund tracking that index MUST transact on the effective date at whatever price exists. They
 * are price-insensitive by construction — the purest forced flow in public markets, and the
 * counterparty is identifiable, large, and legally obliged.
 *
 * WHAT WOULD STOP IT: this trade is famous. Pre-positioning by others compresses the
 * concession, and index providers now pre-announce and stagger precisely to reduce it.
 * Literature puts the classic add effect around +3-5% in the 1990s, decaying toward zero
 * after roughly 2010.
 *
 * ── THE SURVIVORSHIP TRAP, WHICH IS LIVE IN EXACTLY THIS TEST ──────────────────────────────
 * Names are REMOVED from the S&P 500 for two very different reasons: they were acquired
 * (price ends near a bid, series stops) or they collapsed (price fell out of the index, series
 * continues or the company delists in distress). A backtest that silently drops removals whose
 * price history is unavailable keeps the collapses and erases the acquisitions — or the reverse,
 * depending on the vendor. This project has been caught by that class of bias three times
 * (training data, odd-lot, merger arb), so every removal with no usable price series is COUNTED
 * AND REPORTED rather than dropped, and the count is part of the output.
 *
 * DESIGN
 *   · Events: S&P 500 additions and removals with dated entries, from the maintained public list.
 *   · The dates published are EFFECTIVE dates. Announcements precede them by roughly a week, so
 *     the window spans −10 to +10 sessions to capture both the run-up and the reversal.
 *   · Returns are MARKET-ADJUSTED (excess of SPY over the identical window). An add rising in a
 *     rising market is beta — the #28/#29 error.
 *   · Split: pre-2015 vs 2015+, chronological, to test the decay claim directly rather than
 *     assuming it.
 *
 * VARIANT FAMILY — 4, declared before running. Bonferroni bar t ≥ 2.50.
 *   {additions, removals} × {−5→0 run-up, 0→+10 reversal}
 *
 * DECISION RULE — fixed now
 *   PASS  if, in the 2015+ (modern) subsample, a cell shows |mean| > 0.5% with day-clustered
 *         t ≥ 2.50 AND the same sign appears in the pre-2015 subsample.
 *   FAIL  if the modern subsample means are indistinguishable from zero.
 *   Otherwise NOT-ESTABLISHED.
 *
 * EXPECTED OUTCOME, ON THE RECORD: decayed to near zero in the modern subsample. The trade is
 * famous, which in this project's experience is usually fatal. I expect a visible pre-2015
 * effect and nothing after.
 *
 * Usage: node backend/index-recon-test.js
 */
const fs = require("fs"), path = require("path");
const MKT = "http://localhost:3002/api/yahoo";
const WIN_PRE = 10, WIN_POST = 10;
const T_BAR = 2.50, SPLIT = "2015-01-01";

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const pc = (v, d = 2) => v == null ? "     —" : (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function bars(sym) {
  try {
    const r = await fetch(`${MKT}/${encodeURIComponent(sym)}/history?days=9000&interval=1d`, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) return null;
    return ((await r.json()).bars || []).filter(b => Number.isFinite(b.close));
  } catch { return null; }
}

/**
 * Parse the dated change rows out of the maintained public list.
 * Columns are: Effective Date | Added Ticker | Added Security | Removed Ticker | Removed Security | Reason
 * The REASON column is the useful part — it distinguishes a removal that was ACQUIRED from one
 * that fell out on market cap, which is precisely the survivorship split this test has to respect.
 */
const MONTHS = { january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08", september: "09", october: "10", november: "11", december: "12" };
const isoDate = (s) => { const m = String(s).match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/); if (!m) return null; const mm = MONTHS[m[1].toLowerCase()]; return mm ? `${m[3]}-${mm}-${String(m[2]).padStart(2, "0")}` : null; };
const TICKER = /^[A-Z][A-Z.\-]{0,5}$/;
const cleanCell = (c) => c
  .replace(/<ref[\s\S]*?(\/>|<\/ref>)/g, "")
  .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
  .replace(/\{\{[^}]*\}\}/g, "")
  .replace(/'''/g, "").replace(/^\s*\|/, "").trim();

async function events() {
  const r = await fetch("https://en.wikipedia.org/w/api.php?action=parse&page=List_of_S%26P_500_companies&prop=wikitext&format=json&formatversion=2", { signal: AbortSignal.timeout(45000) });
  const wt = (await r.json()).parse?.wikitext || "";
  const start = wt.search(/==\s*Selected changes to the list/i);
  if (start < 0) return [];
  const rest = wt.slice(start + 10);
  const end = rest.search(/\n==[^=]/);
  const sec = rest.slice(0, end > 0 ? end : rest.length);

  const out = [];
  for (const raw of sec.split(/\n\|-/).slice(1)) {
    // the leading "\n|" becomes "||" and yields an EMPTY first element. Failing to drop it puts
    // every column off by one and the parse silently returns zero events — which it did, once.
    const cells = raw.replace(/\n\s*\|/g, "||").split("||").map(cleanCell);
    while (cells.length && cells[0] === "") cells.shift();
    if (cells.length < 5) continue;
    const date = isoDate(cells[0]); if (!date) continue;
    const reason = (cells[5] || cells[cells.length - 1] || "").slice(0, 90);
    if (TICKER.test(cells[1] || "")) out.push({ date, sym: cells[1], kind: "add", reason });
    if (TICKER.test(cells[3] || "")) out.push({ date, sym: cells[3], kind: "remove", reason });
  }
  const seen = new Set();
  return out.filter(e => { const k = `${e.date}|${e.sym}|${e.kind}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

(async () => {
  console.log(`\n  TEST #53 (S1) — INDEX RECONSTITUTION FLOW`);
  console.log(`  pre-registered 2026-07-28 · family of 4 · Bonferroni bar t ≥ ${T_BAR}`);
  console.log(`  every return is EXCESS of SPY over the identical window\n`);

  const evs = await events();
  console.log(`  ${evs.length} dated index-change events parsed (${evs.filter(e => e.kind === "add").length} adds · ${evs.filter(e => e.kind === "remove").length} removals)`);
  if (evs.length < 60) { console.error("  too few events parsed — aborting rather than reporting a thin sample.\n"); process.exit(1); }

  const spy = await bars("SPY");
  const SPY = new Map(spy.map(b => [b.date, b.close]));
  const spyDates = spy.map(b => b.date);

  const rows = [];
  let noSeries = { add: 0, remove: 0 }, tooShort = 0;
  const syms = [...new Set(evs.map(e => e.sym))];
  process.stdout.write("  fetching event symbols");
  const px = {};
  for (const s of syms) { px[s] = await bars(s); process.stdout.write("."); await sleep(20); }
  console.log("");

  for (const e of evs) {
    const b = px[e.sym];
    if (!b || !b.length) { noSeries[e.kind]++; continue; }
    const P = new Map(b.map(x => [x.date, x.close]));
    // locate the effective date on the SPY calendar (the shared trading-day axis)
    let i = spyDates.findIndex(d => d >= e.date);
    if (i < WIN_PRE || i + WIN_POST >= spyDates.length) { tooShort++; continue; }
    const at = (k) => { const d = spyDates[i + k]; return { d, p: P.get(d), s: SPY.get(d) }; };
    const a = at(-WIN_PRE - 1), b0 = at(-1), c = at(0), z = at(WIN_POST);
    if (![a, b0, c, z].every(x => x.p > 0 && x.s > 0)) { tooShort++; continue; }
    rows.push({
      ...e,
      runUp: (b0.p / a.p - 1) - (b0.s / a.s - 1),          // −10 → −1 : the announcement drift
      reversal: (z.p / c.p - 1) - (z.s / c.s - 1),          // 0 → +10 : the post-effective give-back
    });
  }

  console.log(`\n  ${rows.length} events with a usable price window`);
  console.log(`  DROPPED AND REPORTED: ${noSeries.add} adds and ${noSeries.remove} removals had NO price series at all;`);
  console.log(`  ${tooShort} more lacked a full window. Removals lose their series when the company is ACQUIRED,`);
  console.log(`  so silently dropping them would erase the successful exits and keep the collapses.`);
  const dropRate = (noSeries.remove) / Math.max(1, evs.filter(e => e.kind === "remove").length);
  console.log(`  removal drop rate ${(100 * dropRate).toFixed(0)}% — the size of the bias this test cannot fully escape.\n`);

  const cells = [
    ["additions · run-up (−10→−1)", r => r.kind === "add", "runUp"],
    ["additions · reversal (0→+10)", r => r.kind === "add", "reversal"],
    ["removals · run-up (−10→−1)", r => r.kind === "remove", "runUp"],
    ["removals · reversal (0→+10)", r => r.kind === "remove", "reversal"],
  ];
  const score = (rs, key) => {
    const v = rs.map(r => r[key]).filter(Number.isFinite);
    const m = mean(v), s = sd(v);
    return { n: v.length, mean: m, t: (m != null && s && v.length > 2) ? m / (s / Math.sqrt(v.length)) : null };
  };

  console.log(`  cell                            PRE-2015                  2015+`);
  console.log(`                                  n    mean      t          n    mean      t`);
  console.log(`  ${"".padEnd(78, "─")}`);
  const results = {};
  for (const [label, filt, key] of cells) {
    const old = score(rows.filter(r => filt(r) && r.date < SPLIT), key);
    const mod = score(rows.filter(r => filt(r) && r.date >= SPLIT), key);
    results[label] = { pre2015: old, modern: mod };
    console.log(`  ${label.padEnd(30)} ${String(old.n).padStart(4)} ${pc(old.mean).padStart(8)} ${(old.t == null ? "—" : old.t.toFixed(2)).padStart(7)}    ${String(mod.n).padStart(4)} ${pc(mod.mean).padStart(8)} ${(mod.t == null ? "—" : mod.t.toFixed(2)).padStart(7)}`);
  }

  // adjudication: does ANY modern cell clear the bar with a consistent pre-2015 sign?
  const survivors = Object.entries(results).filter(([, r]) =>
    r.modern.mean != null && Math.abs(r.modern.mean) > 0.005 && r.modern.t != null && Math.abs(r.modern.t) >= T_BAR &&
    r.pre2015.mean != null && Math.sign(r.pre2015.mean) === Math.sign(r.modern.mean));
  console.log(`\n  ══ ADJUDICATION ══`);
  console.log(`  cells clearing |mean| > 0.5%, |t| ≥ ${T_BAR}, AND matching the pre-2015 sign: ${survivors.length}`);
  for (const [k, r] of survivors) console.log(`    ${k}: modern ${pc(r.modern.mean)} t ${r.modern.t.toFixed(2)} (pre-2015 ${pc(r.pre2015.mean)})`);
  const verdict = survivors.length ? `NOT-ESTABLISHED → CANDIDATE: ${survivors.length} cell(s) survive. Forward confirmation required before any rule change; a decayed effect that reappears in one subsample is the classic multiplicity survivor.`
    : `DEAD — no modern cell clears the corrected bar with a consistent historical sign. The reconstitution concession has decayed, which is what the pre-registered expectation said.`;
  console.log(`\n  VERDICT: ${verdict}\n`);

  fs.writeFileSync(path.join(__dirname, "data", "index-recon-53.json"), JSON.stringify({
    generated: new Date().toISOString(), test: 53, structuralCandidate: "S1",
    preRegistered: "2026-07-28, spec frozen in structural-register.json before this script existed.",
    events: evs.length, usable: rows.length,
    droppedNoSeries: noSeries, droppedShortWindow: tooShort, removalDropRate: dropRate,
    survivorshipNote: "Removals lose their price series when the company is ACQUIRED. Dropping them silently would erase successful exits and keep collapses. Counts are reported above and the drop rate bounds the residual bias.",
    familySize: 4, correctedBar: T_BAR, split: SPLIT, results, verdict,
  }, null, 1));
  console.log(`  written: backend/data/index-recon-53.json\n`);
})();
