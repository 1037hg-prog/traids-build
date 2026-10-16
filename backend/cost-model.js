#!/usr/bin/env node
/**
 * PER-INSTRUMENT COST MODEL (manifest A3, built 2026-08-21). Replaces "10 bps/side, everywhere".
 *
 * Cost in R for a round trip = (spread round-trip % + commission %) / stop distance %, plus the
 * measured timing slip. Stop distance is MEASURED per class from the ledger (median |entry−stop|/entry).
 * Spread inputs, per class, each labelled MEASURED or DECLARED:
 *   Equity   MEASURED from obs.spreadBps stamped at track time (D1, from 2026-08-24); until then the
 *            #45 fill-realism slip (measured, +0.003R median) and a DECLARED 10 bps/side stress input
 *   Crypto   DECLARED 10 bps/side (Coinbase major pairs) until the quote spread is stamped at track
 *   FX       DECLARED 1.5 pips/side (majors; 0.015% of price) — spot-dealer quality, not retail
 *   Futures  DECLARED 1 tick/side + $2.50/side commission on the front contract
 *   Options  NO flat toll. The July-29 OPT_FRICTION (8%/side) was a modeled assumption the operator
 *            rejected ("we will never trade a contract at 8%") and it was deleted 2026-07-31: every wing
 *            books the MEASURED spread it crossed at entry (4%/side chain gate) + Schwab $0.65/contract/side
 *            (2 legs at entry; expiry is commission-free). Options are excluded from perClass below.
 * Every settled row gets a cost estimate in a SIDE file (data/cost-model.json rowsScored) — the
 * ledger is never edited. daily-health and the parameters table read the per-class table.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const et = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const TICK = { NQ: { tick: 0.25, mult: 20 }, ES: { tick: 0.25, mult: 50 }, YM: { tick: 1, mult: 5 }, RTY: { tick: 0.1, mult: 50 }, CL: { tick: 0.01, mult: 1000 }, GC: { tick: 0.1, mult: 100 }, ZC: { tick: 0.25, mult: 50 }, ZS: { tick: 0.25, mult: 50 }, ZW: { tick: 0.25, mult: 50 }, NG: { tick: 0.001, mult: 10000 }, SI: { tick: 0.005, mult: 5000 }, HG: { tick: 0.0005, mult: 25000 }, "6E": { tick: 0.00005, mult: 125000 } };
/**
 * VENUE COMMISSIONS — Charles Schwab pricing, operator-supplied 2026-08-21 (schwab.com/pricing):
 * online U.S. stocks & ETFs $0 · options $0 base + $0.65 per contract · futures $2.25 per contract
 * · OTC $6.95 per trade (never traded: the universe floor excludes OTC) · U.S. Treasuries $0 online
 * (the allocation stack's ladders) · broker-assisted +$25 (never). Equity cost is therefore spread-only.
 */
const VENUE = { name: "Schwab", asOf: "2026-08-21", source: "schwab.com/pricing, operator-supplied schedule", equityCommission: 0, preferredAndReits: 0, optionsPerContractSide: 0.65, optionsExerciseOrAssignment: 0, futuresPerContractSide: 2.25, futuresOptionsPerContractSide: 2.25, forexCommission: 0, forexNote: "cost is the bid/ask spread only — FX stays spread-modeled, declared until measured", otcPerTrade: 6.95, treasuriesOnline: 0, secondaryBondsPerBond: 1, brokerAssisted: 25 };
const DECLARED = { Crypto: { spreadBpsSide: 10, source: "DECLARED — Coinbase majors; stamp the quote spread at track to measure" }, FX: { spreadBpsSide: 1.5, source: "DECLARED — 1.5 pips on majors, spot-dealer quality" }, Equity: { spreadBpsSide: 10, source: "DECLARED stress input until obs.spreadBps (D1) accrues; #45 slip is measured; commission $0 (Schwab)" } };

const log = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8"));   // kept for measuredSpread(): the SPREAD sample legitimately includes open and control rows
// 2026-09-04 (cost lens): the R population is the CANONICAL ledger, not a hand-rolled filter over the raw file. The old filter let 22
// non-canonical rows in — 18 with pnl:null (incl. AMZN -3.79R) and 4 validly retired, two under fabricated-stop-denominator-r24, retired
// for an invented stop distance, the exact quantity this file divides by. Equity gross read -0.0243R vs the canonical -0.0124R (1.96x).
const L = require("./lib/reconcile.js").cleanEraLedger();
const rows = [...L.signals, ...L.controls].filter((t) => t.entry > 0 && t.stopDist > 0 && t.cls !== "Options");
/** Minimum tick in PRICE units. The multiplier is NOT re-derived: each ledger row carries its own dollarPerPoint (micro vs full self-corrects). */
const TICK_PRICE = { NQ: 0.25, ES: 0.25, YM: 1, RTY: 0.1, CL: 0.01, GC: 0.1, ZC: 0.25, ZS: 0.25, ZW: 0.25, NG: 0.001, SI: 0.005, HG: 0.0005, "6E": 0.00005, SB: 0.01, "6J": 0.0000005, "6M": 0.00001, "6C": 0.00005, "6B": 0.0001, "6N": 0.00005, "6A": 0.00005, ZT: 0.0078125, ZF: 0.0078125, ZN: 0.015625, TN: 0.03125 };
let futPriced = null, futUnpriced = [];
const fill = (() => { try { return JSON.parse(fs.readFileSync(D("fill-realism.json"), "utf8")); } catch { return null; } })();
const slipR = fill?.summary?.timingOnly?.medianHaircutR ?? 0;
// A class is only called MEASURED once enough INDEPENDENT quote stamps have accrued. Two defects made
// this necessary (found 2026-08-26): a cloned control row double-counted one OKLO stamp, and the median
// of the resulting 3-value array set the round-trip spread for all 625 equity rows off a single microcap.
const MIN_SPREAD_N = 20;                            // distinct stamps before DECLARED gives way to MEASURED
/**
 * BOTH SOURCES (2026-08-26). obs.spreadBps went live 2026-08-24 and is stamped AT ENTRY, so the
 * richest sample is the OPEN book, not the closed one: 117 stamped tickets in board_positions.json
 * against 3 in trade_log.json. Reading only closed rows meant the whole equity cost model rested on
 * three stamps — all controls, two of them duplicate legs of one OKLO ticket — while 117 properly
 * stamped tickets sat unread. An open ticket's ENTRY spread is already final; nothing about it
 * changes when the position closes, so there is no look-ahead in using it.
 */
const openBook = (() => {
  try { const b = JSON.parse(fs.readFileSync(D("board_positions.json"), "utf8")); return Array.isArray(b) ? b : (b.positions || b.rows || []); }
  catch { return []; }
})();
const measuredSpread = (cls) => {
  const seen = new Set(), vals = [];
  for (const t of [...log, ...openBook]) {
    if (t.cls !== cls || !Number.isFinite(t.obs?.spreadBps)) continue;
    const key = t.pairId ?? t.id;                   // a repeated pairId is ONE observation, not two
    if (key != null) { if (seen.has(key)) continue; seen.add(key); }
    vals.push(t.obs.spreadBps);
  }
  // MEDIAN sets the class figure, but the MEAN is carried alongside because the two disagree by ~2x
  // (23.0 vs 48.8bps on 2026-08-25) and that gap IS the finding: the distribution has a long right
  // tail, the top decile of names carries 38% of all spread exposure, and a class median cannot see
  // it. Per-row scoring below is what actually fixes that; this pair exists so the gap stays visible.
  return { m: med(vals), mean: vals.length ? +(vals.reduce((s, x) => s + x, 0) / vals.length).toFixed(2) : null, n: vals.length };
};

const perClass = {};
for (const cls of ["Equity", "Crypto", "FX", "Futures"]) {
  const cr = rows.filter((t) => t.cls === cls);
  const stopPct = med(cr.map((t) => 100 * t.stopDist / t.entry));
  let spreadSide, source, meanBps = null;
  if (cls === "Futures") {
    // 2026-09-04 (cost lens): the old mapper stripped the micro prefix onto the FULL multiplier (M6E priced 3.4x light) and silently
    // dropped 67 of 96 rows whose root was not in the table (SB, 6J, 6M, 6C, 6B, 6N, 6A, ZT, ZF, TN, ZN). Now: the row's own dollarPerPoint,
    // a complete tick table, and every unpriced row disclosed.
    futUnpriced = [];
    const per = cr.map((t) => { const root = String(t.sym).replace(/[FGHJKMNQUVXZ]\d{1,2}$/, "").replace(/^M/, ""); const tick = TICK_PRICE[root]; const mult = Number.isFinite(t.dollarPerPoint) && t.dollarPerPoint > 0 ? t.dollarPerPoint : null; if (tick == null || !mult) { futUnpriced.push(t.sym); return null; } return 100 * ((tick * mult) + VENUE.futuresPerContractSide) / (t.entry * mult); }).filter(Number.isFinite);
    futPriced = per.length;
    spreadSide = med(per); source = `DECLARED — 1 tick + ${VENUE.futuresPerContractSide} Schwab commission per side on the row's own contract size (${per.length}/${cr.length} rows priced${futUnpriced.length ? ", unpriced: " + [...new Set(futUnpriced)].join(" ") : ""})`;
  } else {
    const ms = measuredSpread(cls); const m = ms.m, n = ms.n; meanBps = ms.mean;
    const decSide = DECLARED[cls].spreadBpsSide, mSide = m == null ? null : m / 2;   // obs.spreadBps is round trip
    if (mSide != null && n >= MIN_SPREAD_N) {
      spreadSide = mSide / 100; source = `MEASURED — median obs.spreadBps ${m} at track, n=${n} distinct stamps (half-spread per side)`;
    } else if (mSide == null) {
      spreadSide = decSide / 100; source = DECLARED[cls].source;
    } else {
      // Below the gate the DECLARED stress input stands, but we never book LESS cost than the thin
      // measurement already shows. Fails closed: this can only make an edge look worse, never better.
      const bpsSide = Math.max(decSide, mSide);
      spreadSide = bpsSide / 100;
      source = `DECLARED stress input held — only n=${n} distinct spread stamp${n === 1 ? "" : "s"} (median ${m} bps round trip), below the n>=${MIN_SPREAD_N} gate; booked at max(declared ${decSide}, measured ${mSide}) = ${bpsSide} bps/side`;
    }
  }
  const rtPct = 2 * spreadSide;                       // % of price, round trip
  const costR = stopPct ? +(rtPct / stopPct + (cls === "Equity" ? -slipR : 0)).toFixed(4) : null;
  perClass[cls] = { rows: cr.length, ...(cls === "Futures" ? { pricedRows: futPriced, unpricedRows: futUnpriced.length, unpricedSyms: [...new Set(futUnpriced)] } : {}), meanSpreadBps: meanBps, medianStopPct: stopPct != null ? +stopPct.toFixed(3) : null, spreadPctSide: +spreadSide.toFixed(4), roundTripPct: +rtPct.toFixed(4), timingSlipR: cls === "Equity" ? slipR : 0, costR, source };
}
// per-row estimates (side file): cost_R = rtPct / (stopDist/entry %)
/**
 * PER-ROW SCORING (2026-08-26). Every row used to be charged its CLASS MEDIAN spread. That is why a
 * hundredfold dispersion inside one class was invisible to the very tool built to find cost: on the
 * 2026-08-25 NBBO snapshot per-ticket costR ran 0.005R on BAC/META/GOOGL to 0.50R on ACLS, and the
 * top decile of names carried 38% of all spread exposure. A row that carries its OWN entry-stamped
 * spread is now charged that spread; a row without one still falls back to the class figure, which
 * is the honest treatment of a missing measurement rather than an invented one.
 */
let ownStamp = 0;
const scored = rows.map((t) => {
  const pc = perClass[t.cls]; if (!pc) return { id: t.id, cls: t.cls, costR: null };
  const stopPct = 100 * t.stopDist / t.entry;
  const own = Number.isFinite(t.obs?.spreadBps) ? t.obs.spreadBps / 100 : null;   // bps -> % round trip
  if (own != null) ownStamp++;
  const rt = own != null ? own : pc.roundTripPct;
  return { id: t.id, cls: t.cls, costR: +((rt / stopPct) + (t.cls === "Equity" ? -slipR : 0)).toFixed(4), spreadSource: own != null ? "own-stamp" : "class-median" };
}).filter((r) => r.costR != null);
const byCls = {}; for (const r of scored) (byCls[r.cls] ||= []).push(r.costR);
const netEdge = {}; for (const cls of Object.keys(perClass)) { const a = rows.filter((t) => t.cls === cls && !t.ctrl && !t.ctrlRand && !t.vetoShadow); const c = byCls[cls] || []; if (a.length) netEdge[cls] = { signals: a.length, grossAvgR: +mean(a.map((t) => t.rMult)).toFixed(4), meanCostR: c.length ? +mean(c).toFixed(4) : null, netAvgR: c.length ? +(mean(a.map((t) => t.rMult)) - mean(c)).toFixed(4) : null }; }
writeJsonAtomic(D("cost-model.json"), { spec: "cost-model-v1", built: "2026-08-21", asOf: new Date().toISOString(), venue: VENUE, options: { note: "no flat toll (the 8%/side OPT_FRICTION was deleted 2026-07-31); each wing books the measured spread crossed at entry (4%/side chain gate) plus Schwab $0.65 per contract per side, 2 legs at entry, expiry commission-free", commissionPerWingUsd: 1.30, flatSpreadToll: null }, perClass, rowsScored: scored.length, rowsScoredOwnStamp: ownStamp, netEdgeByClass: netEdge, note: "costR = round-trip spread % / stop % (+ measured slip for equities). DECLARED inputs are stress assumptions, replaced class by class as measured spreads accrue (obs.spreadBps from 2026-08-24)." });
console.log("COST MODEL — per class (round-trip cost in R, at the class's median stop distance):");
for (const [cls, v] of Object.entries(perClass)) console.log(`  ${cls.padEnd(8)} rows ${String(v.rows).padStart(4)} · stop ${v.medianStopPct}% of price · spread ${v.spreadPctSide}%/side · round trip ${v.roundTripPct}% → cost ${v.costR}R   [${v.source}]`);
console.log("  signal edge gross → net of this cost:");
for (const [cls, v] of Object.entries(netEdge)) console.log(`    ${cls.padEnd(8)} n ${v.signals} · gross ${v.grossAvgR}R · cost ${v.meanCostR}R · net ${v.netAvgR}R`);
console.log("written: cost-model.json");
