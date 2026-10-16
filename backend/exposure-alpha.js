#!/usr/bin/env node
/**
 * R44 — DIRECTIONAL EXPOSURE OR SIGNAL? Registered 2026-08-24, bar fixed before this ran.
 *
 * THE QUESTION. Breakout showed +0.7688R across 36 clean-era tickets at a 75% win rate. Decomposed,
 * 19 of those 36 fall on two sessions, both entirely crypto, averaging +1.4936R; the other 17 tickets
 * across six days average -0.0413R. On 2026-08-21 twelve alt-coins closed at exactly +2.00R in one
 * session — one correlated move counted twelve times, so the effective sample that day is about one.
 * The direction split then named the mechanism: Breakout-Crypto runs 19 long against 1 short.
 *
 * So the question is not about Breakout. It is whether ANY cell's measured edge is simply its net
 * direction meeting a favourable tape.
 *
 * THE TEST. For every STRATEGY x CLASS cell:
 *   e_d   daily net directional exposure, (longs - shorts) / (longs + shorts), among that cell's
 *         signal tickets opened on day d
 *   b_d   the class benchmark return for that session
 *   fit   regress the cell's DAILY MEAN realized R on the product e_d * b_d
 * The slope is the cell's exposure loading. The INTERCEPT is its alpha — what the cell earned that
 * its direction does not explain. The statistic is that intercept with a day-clustered t, graded as
 * one Benjamini-Hochberg family at q=0.05 with a best-of-N null bar sized to the cells graded.
 *
 * THE BENCHMARK, and why the ledger's own field could not be used. trade_log carries mktRet, but it
 * is a single equity-market series stamped on every class: on 2026-08-21 it reads -0.280 for Crypto,
 * Futures and FX alike, on the very session the crypto complex rallied hard enough to close twelve
 * tickets at full target. Benchmarking a crypto cell against that would credit the signal for a move
 * the benchmark never saw. So crypto uses an equal-weight complex built from the cell's OWN traded
 * pairs (lib/crypto-bars.js), and the equity-family classes keep the ledger series.
 *
 * MANDATORY DIAGNOSTICS, printed for every cell whether or not it clears, because the Breakout case
 * proved a t-statistic is not sufficient on its own:
 *   - net directional exposure
 *   - the share of the cell's ABSOLUTE R contributed by its top TWO days. Absolute, not net: the
 *     first cut divided by the net total, which is undefined when the net is near zero and printed
 *     readings of -666% and 241.5%. Share of the sum of |daily R| always lies in [0,100].
 *   - how many tickets resolved at exactly the take-profit multiple on a single session, the
 *     signature of one correlated move counted many times
 * A cell whose top two days supply more than half its absolute R is labelled CONCENTRATED regardless.
 *
 * CRYPTO BENCHMARK COVERAGE. Alpaca lists 18 of the 51 pairs the board has traded this era. Those 18
 * are the majors and carry the complex move, but the coverage figure is printed on every run so a
 * later reader can judge it rather than assume it.
 *
 * Usage: node backend/exposure-alpha.js
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchCryptoBars, dailyComplexReturn } = require("./lib/crypto-bars.js");
const NB = require("./lib/null-bar.js");
const { cleanEraLedger } = require("./lib/reconcile.js");
const D = (f) => path.join(__dirname, "data", f);
const OUT = D("exposure-alpha.json");

const CLEAN = new Date("2026-07-20T00:00:00-06:00").getTime();
const EVIDENCE_START = "2026-08-25";      // fixed at registration
const BAR = { minDays: 30, minN: 60, qFDR: 0.05, concentrationPct: 50, exposureThreshold: 0.40 };

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const iso = (t) => (typeof t.openedAt === "number" ? new Date(t.openedAt).toISOString().slice(0, 10) : String(t.openedAt || "").slice(0, 10));
const pFromT = (t) => (t == null ? null : Math.min(1, Math.exp(-0.717 * Math.abs(t) - 0.416 * t * t)));

/** OLS of y on a single regressor plus intercept; returns {alpha, beta, tAlpha} with day-clustered t */
function fit(x, y) {
  const n = x.length;
  if (n < 3) return { alpha: null, beta: null, tAlpha: null, n };
  const mx = mean(x), my = mean(y);
  const sxx = x.reduce((s, v) => s + (v - mx) ** 2, 0);
  const beta = sxx > 0 ? x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / sxx : 0;
  const alpha = my - beta * mx;
  const resid = y.map((v, i) => v - alpha - beta * x[i]);
  const s2 = resid.reduce((s, r) => s + r * r, 0) / Math.max(1, n - 2);
  // each day is one observation already, so the residual SE is the clustered SE
  const seA = Math.sqrt(s2 * (1 / n + (sxx > 0 ? (mx * mx) / sxx : 0)));
  return { alpha: +alpha.toFixed(4), beta: +beta.toFixed(4), tAlpha: seA > 0 ? +(alpha / seA).toFixed(3) : null, n };
}

(async () => {
  // canonical source only — see lib/reconcile.js. Reading the JSONL shadow here would silently drop
  // settled rows without a finite pnl, which is how the side-by-side panel got its edge wrong.
  const rows = cleanEraLedger().signals;
  const evidence = rows.filter((t) => iso(t) >= EVIDENCE_START);
  const pool = evidence.length ? evidence : rows;      // before evidence accrues, report the motivating pool clearly labelled
  const isEvidence = evidence.length > 0;

  // crypto benchmark from the traded pairs themselves
  const cryptoSyms = [...new Set(pool.filter((t) => t.cls === "Crypto").map((t) => t.sym))].filter((s) => /\//.test(s));
  let cryptoRet = {};
  if (cryptoSyms.length) {
    try {
      const bars = await fetchCryptoBars(cryptoSyms, "1Day", "2026-07-15", new Date().toISOString().slice(0, 10));
      cryptoRet = dailyComplexReturn(bars);
      console.log(`  crypto complex: ${Object.keys(bars).length}/${cryptoSyms.length} pairs · ${Object.keys(cryptoRet).length} sessions`);
    } catch (e) { console.error(`  crypto benchmark unavailable: ${e.message}`); }
  }
  // equity-family benchmark: the ledger's own series, which IS an equity-market return
  const eqRet = {};
  for (const t of pool) if (t.cls !== "Crypto" && Number.isFinite(t.mktRet)) eqRet[iso(t)] = t.mktRet;

  const cells = {};
  for (const t of pool) { const k = `${t.strategy || "(none)"} · ${t.cls || "(none)"}`; (cells[k] ||= []).push(t); }

  const results = [];
  for (const [cell, tix] of Object.entries(cells)) {
    const byDay = {};
    for (const t of tix) (byDay[iso(t)] ||= []).push(t);
    const isCrypto = tix[0].cls === "Crypto";
    const bench = isCrypto ? cryptoRet : eqRet;

    const days = Object.keys(byDay).sort().filter((d) => Number.isFinite(bench[d]));
    const x = [], y = [];
    for (const d of days) {
      const v = byDay[d];
      const L = v.filter((t) => t.dir > 0).length, S = v.filter((t) => t.dir < 0).length;
      const e = L + S ? (L - S) / (L + S) : 0;
      x.push(e * bench[d]); y.push(mean(v.map((t) => t.rMult)));
    }
    const f = fit(x, y);

    // diagnostics — reported regardless of the bar
    const L = tix.filter((t) => t.dir > 0).length, S = tix.filter((t) => t.dir < 0).length;
    const netExposure = L + S ? +((L - S) / (L + S)).toFixed(3) : 0;
    /**
     * CONCENTRATION AS A SHARE OF ABSOLUTE MOVEMENT, not of net R. The first cut of this divided the
     * top two days by the cell's NET total, which is undefined when the net is near zero and produced
     * readings of -666% and 241.5% — noise dressed as a percentage. Share of the sum of |daily R| is
     * always in [0,100] and answers the question actually being asked: how much of everything this
     * cell did happened on two days.
     */
    const dayTot = Object.entries(byDay).map(([d, v]) => [d, v.reduce((s, t) => s + t.rMult, 0)])
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const totalAbs = dayTot.reduce((s, [, r]) => s + Math.abs(r), 0);
    const top2 = dayTot.slice(0, 2).reduce((s, [, r]) => s + Math.abs(r), 0);
    const top2Pct = totalAbs > 0 ? +((top2 / totalAbs) * 100).toFixed(1) : null;
    const tpMult = Math.max(...tix.map((t) => t.rMult));
    const maxSameDayAtTP = Math.max(0, ...Object.values(byDay).map((v) => v.filter((t) => Math.abs(t.rMult - tpMult) < 1e-6).length));

    results.push({ cell, n: tix.length, days: days.length, meanR: +mean(tix.map((t) => t.rMult)).toFixed(4),
      netExposure, alpha: f.alpha, beta: f.beta, tAlpha: f.tAlpha, p: pFromT(f.tAlpha),
      top2DayShareOfAbsRPct: top2Pct, topDays: dayTot.slice(0, 2).map(([d, r]) => `${d} ${r >= 0 ? "+" : ""}${r.toFixed(2)}R`),
      maxSameDayAtTakeProfit: maxSameDayAtTP,
      concentrated: top2Pct != null && top2Pct > BAR.concentrationPct,
      readable: days.length >= BAR.minDays && tix.length >= BAR.minN });
  }

  const readable = results.filter((r) => r.readable && r.p != null).sort((a, b) => a.p - b.p);
  const m = readable.length;
  let maxK = 0;
  readable.forEach((r, i) => { if (r.p <= ((i + 1) / m) * BAR.qFDR) maxK = i + 1; });
  readable.forEach((r, i) => { r.bhPass = i < maxK; });
  const top = readable[0] || null;
  const honest = top && top.days >= 5 ? NB.verdict(Math.abs(top.tAlpha), { variants: Math.max(1, m), n: top.days, trials: 2000 }) : null;
  const survivors = readable.filter((r) => r.bhPass && r.alpha > 0 && honest && Math.abs(r.tAlpha) >= honest.honestBar);

  const verdict = !isEvidence
    ? `NOT YET IN EVIDENCE — evidence starts ${EVIDENCE_START}; the figures below are the MOTIVATING pool and are not gradeable`
    : !m ? `ACCRUING — 0/${results.length} cells at >=${BAR.minDays} signal-days and >=${BAR.minN} tickets`
    : survivors.length ? `${survivors.length} cell(s) show alpha beyond their direction at BH q=${BAR.qFDR}`
    : `NO CELL CLEARS — ${m} cells graded, none with positive alpha above the null bar${honest ? ` (${honest.honestBar})` : ""}`;

  /**
   * 2026-09-10 (test-triage COUNT NOT EXPOSED fix). R44's bar is minDays:30 — days of EVIDENCE since
   * 2026-08-25. R44 grades many cells at once, each with its OWN `days` count (thinner cells accrue
   * slower), so there is no single cell-level number that is "the" test's clock. The honest,
   * non-fabricated proxy is the elapsed evidence-day count for the BUSIEST cell — no cell can have
   * accrued more days than that, so it never overstates readiness (never a false READY). There is no
   * single scalar "the registered statistic" across a multi-cell BH family, so estimate is left null
   * rather than picking one cell's alpha and implying it speaks for the test.
   */
  const maxCellDays = isEvidence && results.length ? Math.max(...results.map((r) => r.days)) : 0;
  const dailyClock = {
    sessions: maxCellDays,
    estimate: null,
    unit: "signal-days since evidenceStart (busiest cell; thinner cells accrue slower — see cells[].days)",
    note: "R44 grades a BH family of cells, not one statistic — no single scalar stands in for 'current value'; see cells[].alpha per cell",
  };

  writeJsonAtomic(OUT, { spec: "R44 exposure-alpha v1", registered: "2026-08-24", evidenceStart: EVIDENCE_START,
    asOf: new Date().toISOString(), inEvidence: isEvidence, bar: BAR, dailyClock,
    benchmark: { crypto: "equal-weight complex of the cell's own traded pairs (lib/crypto-bars.js)",
      other: "trade_log mktRet, an equity-market series",
      why: "mktRet is a single equity series stamped on every class — on 2026-08-21 it reads -0.280 for Crypto, Futures and FX alike, on the session the crypto complex rallied twelve tickets to full target." },
    cryptoBenchmarkCoverage: cryptoSyms.length ? { pairsMatched: Object.keys(cryptoRet).length ? "see log" : 0, pairsRequested: cryptoSyms.length, note: "Alpaca does not list every pair the board trades; the complex is built from those it does, which are the majors and carry the move." } : null,
    cellsTracked: results.length, readableCells: m, honestBar: honest ? honest.honestBar : null,
    cells: results.sort((a, b) => b.n - a.n), survivors: survivors.map((r) => r.cell), verdict });

  console.log(`\nR44 EXPOSURE-ALPHA — ${results.length} strategy x class cells${isEvidence ? "" : "  [MOTIVATING POOL, not evidence]"}\n`);
  const w = Math.max(...results.map((r) => r.cell.length));
  console.log(`  ${"cell".padEnd(w)}  ${"n".padStart(4)} ${"days".padStart(4)}  ${"meanR".padStart(8)}  ${"netExp".padStart(7)}  ${"alpha".padStart(8)}  ${"tAlpha".padStart(7)}  top2%  flags`);
  for (const r of results) {
    const flags = [r.concentrated ? "CONCENTRATED" : "", Math.abs(r.netExposure) > BAR.exposureThreshold ? "DIRECTIONAL" : "",
      r.maxSameDayAtTakeProfit >= 5 ? `${r.maxSameDayAtTakeProfit}@TP-one-day` : "", r.readable ? "" : "thin"].filter(Boolean).join(" ");
    console.log(`  ${r.cell.padEnd(w)}  ${String(r.n).padStart(4)} ${String(r.days).padStart(4)}  ${String(r.meanR).padStart(8)}  ${String(r.netExposure).padStart(7)}  ${String(r.alpha ?? "—").padStart(8)}  ${String(r.tAlpha ?? "—").padStart(7)}  ${String(r.top2DayShareOfAbsRPct ?? "—").padStart(5)}  ${flags}`);
  }
  console.log(`\n  ${verdict}`);
  console.log(`\nwritten: exposure-alpha.json`);
})().catch((e) => { console.error("R44 failed:", e.message); process.exit(1); });
