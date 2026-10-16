#!/usr/bin/env node
/**
 * R44 — diagnostics for the sealed read. READ-ONLY on every ledger and state file; writes r44-diagnostics.json beside this file.
 *   node docs/reads/2026-10-11/R44/r44-diagnostics.cjs [repo root]
 *
 * What it does, and nothing else:
 *   A. reproduces the registered reader (backend/exposure-alpha.js) for every non-crypto cell from the canonical ledger with the
 *      reader's own formula, and compares with the reader's output file (the crypto benchmark needs a market-data call, so the crypto
 *      cells are taken from the reader's file; none of them is readable);
 *   B. reproduces the read night (the first committed reader output with a readable cell) from the ledger rows closed by that night;
 *   C. measures the reader's best-of-N bar (lib/null-bar.js is a Monte Carlo on Math.random: the bar moves a little run to run);
 *   D. measures the benchmark the reader actually used for the equity-family classes against the registered one (SPY for the session)
 *      and re-runs the reader's formula with SPY close-to-close session returns — a SENSITIVITY, weightless, disclosed;
 *   E. population checks (what is in the pool, which cells still accrue, which cells are directional);
 *   F. the dollar table, from the reader's own rows, as the board booked them.
 * No statistic here is a new read. The read is the reader's own number.
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process");
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, "..", "..", "..", ".."));
const BK = path.join(ROOT, "backend"), D = (f) => path.join(BK, "data", f);
const { writeJsonAtomic } = require(path.join(BK, "lib", "atomic-write.js"));
const { cleanEraLedger } = require(path.join(BK, "lib", "reconcile.js"));
const NB = require(path.join(BK, "lib", "null-bar.js"));
const rj = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const git = (args) => cp.execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const r2 = (x) => +x.toFixed(2), r4 = (x) => +x.toFixed(4);

// ---- the reader's own pieces, copied character for character from backend/exposure-alpha.js -------------------------------------
const EVIDENCE_START = "2026-08-25";
const BAR = { minDays: 30, minN: 60, qFDR: 0.05, concentrationPct: 50, exposureThreshold: 0.40 };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const iso = (t) => (typeof t.openedAt === "number" ? new Date(t.openedAt).toISOString().slice(0, 10) : String(t.openedAt || "").slice(0, 10));
const pFromT = (t) => (t == null ? null : Math.min(1, Math.exp(-0.717 * Math.abs(t) - 0.416 * t * t)));
function fit(x, y) {
  const n = x.length;
  if (n < 3) return { alpha: null, beta: null, tAlpha: null, n };
  const mx = mean(x), my = mean(y);
  const sxx = x.reduce((s, v) => s + (v - mx) ** 2, 0);
  const beta = sxx > 0 ? x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / sxx : 0;
  const alpha = my - beta * mx;
  const resid = y.map((v, i) => v - alpha - beta * x[i]);
  const s2 = resid.reduce((s, r) => s + r * r, 0) / Math.max(1, n - 2);
  const seA = Math.sqrt(s2 * (1 / n + (sxx > 0 ? (mx * mx) / sxx : 0)));
  return { alpha: +alpha.toFixed(4), beta: +beta.toFixed(4), tAlpha: seA > 0 ? +(alpha / seA).toFixed(3) : null, n };
}
const cellOf = (t) => `${t.strategy || "(none)"} · ${t.cls || "(none)"}`;

/** the reader's grading of the non-crypto cells of a pool, with a benchmark map; benchOverride replaces the reader's own map */
function grade(pool, benchOverride) {
  const eqRet = {};
  const eqFrom = {};
  for (const t of pool) if (t.cls !== "Crypto" && Number.isFinite(t.mktRet)) { eqRet[iso(t)] = t.mktRet; eqFrom[iso(t)] = t; }
  const bench = benchOverride || eqRet;
  const cells = {};
  for (const t of pool) (cells[cellOf(t)] ||= []).push(t);
  const out = {};
  for (const [cell, tix] of Object.entries(cells)) {
    const byDay = {};
    for (const t of tix) (byDay[iso(t)] ||= []).push(t);
    const isCrypto = tix[0].cls === "Crypto";
    const allDays = Object.keys(byDay).sort();
    const L = tix.filter((t) => t.dir > 0).length, S = tix.filter((t) => t.dir < 0).length;
    const base = { cell, cls: tix[0].cls, n: tix.length, signalDays: allDays.length, meanR: +mean(tix.map((t) => t.rMult)).toFixed(4), netExposure: L + S ? +((L - S) / (L + S)).toFixed(3) : 0, longs: L, shorts: S, firstOpen: allDays[0], lastOpen: allDays[allDays.length - 1] };
    if (isCrypto) { out[cell] = { ...base, crypto: true }; continue; }
    const days = allDays.filter((d) => Number.isFinite(bench[d]));
    const x = [], y = [], e = [];
    for (const d of days) {
      const v = byDay[d];
      const l = v.filter((t) => t.dir > 0).length, s = v.filter((t) => t.dir < 0).length;
      const ed = l + s ? (l - s) / (l + s) : 0;
      e.push(ed); x.push(ed * bench[d]); y.push(mean(v.map((t) => t.rMult)));
    }
    const f = fit(x, y);
    // the plain day-clustered t of the daily mean R (no regressor): the intercept the fit returns when the loading is zero
    const my = mean(y), sd = y.length > 1 ? Math.sqrt(y.reduce((s, v) => s + (v - my) ** 2, 0) / (y.length - 1)) : 0;
    out[cell] = { ...base, days: days.length, daysDroppedNoBenchmark: allDays.length - days.length, alpha: f.alpha, beta: f.beta, tAlpha: f.tAlpha, p: pFromT(f.tAlpha),
      readable: days.length >= BAR.minDays && tix.length >= BAR.minN, meanAbsDailyExposure: e.length ? +mean(e.map(Math.abs)).toFixed(3) : null,
      noRegressor: { meanOfDailyMeans: my == null ? null : r4(my), t: sd > 0 ? +(my / (sd / Math.sqrt(y.length))).toFixed(3) : null } };
  }
  return { cells: out, eqRet, eqFrom };
}
function bh(cellsObj) {
  const readable = Object.values(cellsObj).filter((r) => r.readable && r.p != null).sort((a, b) => a.p - b.p);
  const m = readable.length; let maxK = 0;
  readable.forEach((r, i) => { if (r.p <= ((i + 1) / m) * BAR.qFDR) maxK = i + 1; });
  return readable.map((r, i) => ({ cell: r.cell, n: r.n, days: r.days, alpha: r.alpha, tAlpha: r.tAlpha, p: +r.p.toFixed(4), bhThreshold: +(((i + 1) / m) * BAR.qFDR).toFixed(4), bhPass: i < maxK }));
}

/** dollars, as the board booked each ticket (the field `pnl`); drawdown on the cumulative P&L in the order the tickets closed */
function dollars(tix) {
  const rows = [...tix].sort((a, b) => a.closedAt - b.closedAt || (a.openedAt > b.openedAt ? 1 : a.openedAt < b.openedAt ? -1 : 0) || String(a.id).localeCompare(String(b.id)));
  const wins = rows.filter((t) => t.pnl > 0), losers = rows.filter((t) => t.pnl < 0);
  const gains = wins.reduce((s, t) => s + t.pnl, 0), losses = losers.reduce((s, t) => s + t.pnl, 0);
  let cum = 0, peak = 0, dd = 0; for (const t of rows) { cum += t.pnl; if (cum > peak) peak = cum; if (cum - peak < dd) dd = cum - peak; }
  const byDay = {}; for (const t of rows) (byDay[iso(t)] ||= 0), (byDay[iso(t)] += t.pnl);
  const dv = Object.entries(byDay).sort((a, b) => a[1] - b[1]);
  return { tickets: rows.length, net: r2(gains + losses), gains: r2(gains), wins: wins.length, avgWin: wins.length ? r2(gains / wins.length) : null, losses: r2(losses), losers: losers.length, avgLoss: losers.length ? r2(losses / losers.length) : null,
    flat: rows.length - wins.length - losers.length, winRatePct: rows.length ? +((100 * wins.length) / rows.length).toFixed(1) : null, worstDrawdown: r2(dd),
    worstDay: dv.length ? { day: dv[0][0], pnl: r2(dv[0][1]) } : null, bestDay: dv.length ? { day: dv[dv.length - 1][0], pnl: r2(dv[dv.length - 1][1]) } : null, openDays: dv.length };
}

// ---- the pool -------------------------------------------------------------------------------------------------------------------
const L = cleanEraLedger();
const pool = L.signals.filter((t) => iso(t) >= EVIDENCE_START);
const state = rj(D("exposure-alpha.json"));
const byCellFile = Object.fromEntries((state.cells || []).map((c) => [c.cell, c]));

// A. tonight
const G = grade(pool);
const cmpKeys = ["n", "days", "meanR", "netExposure", "alpha", "beta", "tAlpha"];
const repro = Object.values(G.cells).filter((c) => !c.crypto).map((c) => { const f = byCellFile[c.cell]; const diffs = f ? cmpKeys.filter((k) => (c[k] ?? null) !== (f[k] ?? null)).map((k) => `${k}: mine ${c[k]} file ${f[k]}`) : ["not in the reader's file"]; return { cell: c.cell, matches: diffs.length === 0, diffs }; });
const cryptoFromFile = (state.cells || []).filter((c) => / · Crypto$/.test(c.cell)).map((c) => ({ cell: c.cell, n: c.n, days: c.days, readable: c.readable, netExposure: c.netExposure, alpha: c.alpha, tAlpha: c.tAlpha }));
const poolCountMatches = (state.cells || []).reduce((s, c) => s + c.n, 0) === pool.length;

// B. the read night, from git and from the ledger rows closed by then
const nightly = rj(path.join(__dirname, "r44-nightly.json"));
const fm = nightly.firstMet;
const snap = JSON.parse(git(["show", `${fm.commit}:backend/data/exposure-alpha.json`]));
const snapCells = Object.fromEntries(snap.cells.map((c) => [c.cell, c]));
const cut = Date.parse(snap.asOf);
const poolThen = pool.filter((t) => t.closedAt <= cut);
const GT = grade(poolThen);
const reproThen = Object.values(GT.cells).filter((c) => !c.crypto).map((c) => { const f = snapCells[c.cell]; const diffs = f ? cmpKeys.filter((k) => (c[k] ?? null) !== (f[k] ?? null)).map((k) => `${k}: mine ${c[k]} snapshot ${f[k]}`) : ["not in the snapshot"]; return { cell: c.cell, readableThen: !!(f && f.readable), matches: diffs.length === 0, diffs }; });

// C. the bar
function barSpread(variants, n, reps) {
  const v = []; for (let i = 0; i < reps; i++) v.push(+NB.nullBar({ variants, n, trials: 2000 }).p95.toFixed(3));
  v.sort((a, b) => a - b);
  const big = NB.nullBar({ variants, n, trials: 200000 });
  return { variants, n, trialsPerRun: 2000, runs: reps, min: v[0], median: v[Math.floor(reps / 2)], max: v[reps - 1], at200000Trials: +big.p95.toFixed(3) };
}
const readableTonight = bh(G.cells), readableThen = snap.cells.filter((c) => c.readable).sort((a, b) => a.p - b.p);
const topTonight = readableTonight[0], topThen = readableThen[0];
const bar = {
  how: "lib/null-bar.js verdict(|t of the top cell|, { variants: cells graded, n: the top cell's signal-days, trials: 2000 }).honestBar = the 95th percentile of the largest of N zero-edge t-statistics; one-sided (a survivor must also have alpha > 0). It draws from Math.random with no seed, so it differs slightly on every run.",
  readNight: { cellsGraded: readableThen.length, topCell: topThen.cell, topCellDays: topThen.days, readerPrinted: snap.honestBar, spread: barSpread(readableThen.length, topThen.days, 60) },
  tonight: { cellsGraded: readableTonight.length, topCell: topTonight.cell, topCellDays: topTonight.days, readerPrinted: state.honestBar, spread: barSpread(readableTonight.length, topTonight.days, 60) },
};

// D. the benchmark the reader used, against SPY for the session
const spy = (() => {
  const a = rj(D("r236-spy-bars.json")).bars.map((b) => [String(b.t).slice(0, 10), b.c]).filter(([d]) => d >= "2026-08-17" && d <= "2026-09-24");
  const b316 = rj(D("r316-bars.json")).bySym.SPY, b = Object.keys(b316).sort().map((d) => [d, b316[d].c]);
  const overlap = b.filter(([d]) => a.some(([x]) => x === d)).map(([d, c]) => ({ d, r316: c, r236: a.find(([x]) => x === d)[1] }));
  const series = [...a, ...b.filter(([d]) => d > "2026-09-24")];
  const ret = {}; for (let i = 1; i < series.length; i++) ret[series[i][0]] = +((series[i][1] / series[i - 1][1] - 1) * 100).toFixed(4);
  return { ret, overlap, overlapAgrees: overlap.every((o) => Math.abs(o.r316 - o.r236) < 0.011), first: series[0][0], last: series[series.length - 1][0], sources: "backend/data/r236-spy-bars.json (Alpaca SIP daily, adjusted) to 2026-09-24; backend/data/r316-bars.json (Schwab daily) from 2026-09-25" };
})();
const nonCrypto = pool.filter((t) => t.cls !== "Crypto");
const carry = nonCrypto.filter((t) => Number.isFinite(t.mktRet));
const carryByCell = {}; for (const t of nonCrypto) { const k = cellOf(t); (carryByCell[k] ||= { tickets: 0, withMktRet: 0 }).tickets++; if (Number.isFinite(t.mktRet)) carryByCell[k].withMktRet++; }
const perDay = {}; for (const t of carry) (perDay[iso(t)] ||= []).push(t);
const benchDays = Object.keys(perDay).sort().map((d) => {
  const v = perDay[d], vals = v.map((t) => t.mktRet), distinct = [...new Set(vals.map((x) => x.toFixed(6)))].length, src = G.eqFrom[d];
  return { day: d, ticketsWithMktRet: v.length, distinctValues: distinct, min: r4(Math.min(...vals)), max: r4(Math.max(...vals)), readerUsed: r4(G.eqRet[d]), fromTicket: `${src.sym} ${cellOf(src)}`, thatTicketHeldHours: +((src.closedAt - src.openedAt) / 3600000).toFixed(1), spySessionRetPct: spy.ret[d] ?? null };
});
const corr = (() => { const p = benchDays.filter((x) => x.spySessionRetPct != null); const a = p.map((x) => x.readerUsed), b = p.map((x) => x.spySessionRetPct); const ma = mean(a), mb = mean(b); const c = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0), va = a.reduce((s, v) => s + (v - ma) ** 2, 0), vb = b.reduce((s, v) => s + (v - mb) ** 2, 0); return { days: p.length, correlation: va > 0 && vb > 0 ? +(c / Math.sqrt(va * vb)).toFixed(3) : null }; })();
const GS = grade(pool, spy.ret), GST = grade(poolThen, spy.ret);
const sens = (g, reader) => Object.values(g.cells).filter((c) => !c.crypto && (reader[c.cell] || {}).readable).map((c) => ({ cell: c.cell, n: c.n, days: c.days, alpha: c.alpha, beta: c.beta, tAlpha: c.tAlpha, readerAlpha: reader[c.cell].alpha, readerT: reader[c.cell].tAlpha, noRegressorT: G.cells[c.cell] ? (g === GST ? GT : G).cells[c.cell].noRegressor.t : null }));
const sensTonight = sens(GS, byCellFile), sensThen = sens(GST, snapCells);
const anySensAboveTwo = [...sensTonight, ...sensThen].some((c) => c.alpha > 0 && c.tAlpha >= 2.0);
// would any OTHER cell become readable or clear under the SPY session benchmark? (the day count changes when the benchmark map changes)
const readableUnderSpy = Object.values(GS.cells).filter((c) => !c.crypto && c.readable).map((c) => ({ cell: c.cell, n: c.n, days: c.days, alpha: c.alpha, tAlpha: c.tAlpha }));
const readableUnderSpyThen = Object.values(GST.cells).filter((c) => !c.crypto && c.readable).map((c) => ({ cell: c.cell, n: c.n, days: c.days, alpha: c.alpha, tAlpha: c.tAlpha }));
// the night before the read night, under the SPY session benchmark: was any cell already at its sample?
const beforeSnap = JSON.parse(git(["show", `${nightly.nightBefore.commit}:backend/data/exposure-alpha.json`]));
const GSB = grade(pool.filter((t) => t.closedAt <= Date.parse(beforeSnap.asOf)), spy.ret);
const readableUnderSpyNightBefore = Object.values(GSB.cells).filter((c) => !c.crypto && c.readable).map((c) => c.cell);
const maxDaysNightBeforeUnderSpy = Math.max(...Object.values(GSB.cells).filter((c) => !c.crypto).map((c) => c.days));
// what the reader's value does track: SPY for the NEXT session?
const corrNext = (() => { const ds = Object.keys(spy.ret).sort(); const p = benchDays.map((x) => { const i = ds.indexOf(x.day); return i >= 0 && i + 1 < ds.length ? [x.readerUsed, spy.ret[ds[i + 1]]] : null; }).filter(Boolean); const a = p.map((x) => x[0]), b = p.map((x) => x[1]); const ma = mean(a), mb = mean(b); const c = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0), va = a.reduce((s, v) => s + (v - ma) ** 2, 0), vb = b.reduce((s, v) => s + (v - mb) ** 2, 0); return { days: p.length, correlation: va > 0 && vb > 0 ? +(c / Math.sqrt(va * vb)).toFixed(3) : null }; })();

// D2. the same sensitivity on every nightly snapshot: ledger rows closed by that night's reader run, SPY session benchmark
const sensByNight = nightly.nights.filter((x) => !x.unreadable && x.inEvidence).map((x) => {
  const g = grade(pool.filter((t) => t.closedAt <= Date.parse(x.asOf)), spy.ret);
  const rd = Object.values(g.cells).filter((c) => !c.crypto && c.readable).map((c) => ({ cell: c.cell, n: c.n, days: c.days, alpha: c.alpha, tAlpha: c.tAlpha }));
  const pos = rd.filter((c) => c.alpha > 0).map((c) => c.tAlpha);
  return { day: x.day, readerReadable: x.readableByMyCount, readableUnderSpy: rd.length, cells: rd, largestPositiveAlphaT: pos.length ? Math.max(...pos) : null };
});
const firstUnderSpy = sensByNight.find((x) => x.readableUnderSpy >= 1) || null;
const sensNights = sensByNight.filter((x) => x.readableUnderSpy >= 1);
const sensMaxPosT = Math.max(...sensNights.map((x) => x.largestPositiveAlphaT ?? -Infinity));

const groupsForOpen = {}; for (const t of pool) (groupsForOpen[cellOf(t)] ||= []).push(t);
// E. population
const lastOpenByCell = Object.values(G.cells).map((c) => ({ cell: c.cell, n: c.n, signalDays: c.signalDays, firstOpen: c.firstOpen, lastOpen: c.lastOpen, netExposure: c.netExposure, directional: Math.abs(c.netExposure) > BAR.exposureThreshold, readable: !!(byCellFile[c.cell] || {}).readable, daysInReader: (byCellFile[c.cell] || {}).days ?? null })).sort((a, b) => b.n - a.n);
// open booked positions (not a control, not a veto shadow) that will settle into the pool later: can a cell still gain signal-days?
const openBooked = (() => {
  const j = rj(D("board_positions.json")), arr = Array.isArray(j) ? j : (j.positions || Object.values(j));
  const by = {};
  for (const t of arr) { if (!t || typeof t !== "object" || t.ctrl || t.vetoShadow || !Number.isFinite(t.addedAt)) continue; const k = cellOf(t), d = new Date(t.addedAt).toISOString().slice(0, 10); if (d < EVIDENCE_START) continue; (by[k] ||= { open: 0, entryDates: {} }).open++; by[k].entryDates[d] = (by[k].entryDates[d] || 0) + 1; }
  for (const [k, v] of Object.entries(by)) { const have = new Set((groupsForOpen[k] || []).map(iso)); v.entryDatesNotYetInThePool = Object.keys(v.entryDates).sort().filter((d) => !have.has(d)); v.signalDaysNow = have.size; }
  return by;
})();
const directional = lastOpenByCell.filter((c) => c.directional);
const population = {
  source: L.source, epoch: L.epoch, settledSignals: L.n, evidencePool: pool.length, evidenceStart: EVIDENCE_START, poolCountMatchesTheReadersCells: poolCountMatches,
  vetoShadowsInPool: pool.filter((t) => t.vetoShadow).length, controlsInPool: pool.filter((t) => t.ctrl).length, retiredRowsExcludedByTheLedger: L.retiredExcluded, retireTagsIgnored: L.retireTagsIGNORED,
  lastTicketClosed: new Date(Math.max(...pool.map((t) => t.closedAt))).toISOString(), cells: lastOpenByCell, openBookedPositionsByCell: openBooked,
  directionalCells: { rule: "|net exposure| > 40% — the cells the registered hypothesis is about", count: directional.length, readable: directional.filter((c) => c.readable).length, list: directional.map((c) => `${c.cell} (net ${c.netExposure}, ${c.n} tickets, ${c.daysInReader ?? c.signalDays} signal-days, last opened ${c.lastOpen})`) },
};

// F. dollars
const groups = {}; for (const t of pool) (groups[cellOf(t)] ||= []).push(t);
const groupsThen = {}; for (const t of poolThen) (groupsThen[cellOf(t)] ||= []).push(t);
const gradedTonight = readableTonight.map((c) => c.cell), gradedThen = readableThen.map((c) => c.cell);
const dol = {
  sizing: "each ticket as the board booked it (the ledger's own pnl field, the board's own size per ticket); R44 has no sizing of its own — it grades the board's signal tickets",
  drawdown: "deepest fall of the cumulative P&L, tickets in the order they closed",
  tonight: { asOf: state.asOf, gradedCells: Object.fromEntries(gradedTonight.map((c) => [c, dollars(groups[c])])), gradedCellsTogether: dollars(gradedTonight.flatMap((c) => groups[c])), everyCell: Object.fromEntries(Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length).map((c) => [c, dollars(groups[c])])), wholePool: dollars(pool) },
  readNight: { day: fm.day, ticketsClosedBy: snap.asOf, gradedCells: Object.fromEntries(gradedThen.map((c) => [c, dollars(groupsThen[c] || [])])), gradedCellsTogether: dollars(gradedThen.flatMap((c) => groupsThen[c] || [])) },
};

const out = {
  generatedAt: new Date().toISOString(), by: "docs/reads/2026-10-11/R44/r44-diagnostics.cjs",
  reader: { script: "backend/exposure-alpha.js", outputAsOf: state.asOf, verdict: state.verdict, honestBar: state.honestBar, readableCells: state.readableCells, cellsTracked: state.cellsTracked, survivors: state.survivors },
  tonight: { reproduction: { nonCryptoCells: repro.length, allMatch: repro.every((r) => r.matches), mismatches: repro.filter((r) => !r.matches) }, cryptoCellsFromTheReadersFile: cryptoFromFile, graded: readableTonight,
    mandatoryDiagnostics: readableTonight.map((c) => { const f = byCellFile[c.cell]; return { cell: c.cell, netExposure: f.netExposure, top2DayShareOfAbsRPct: f.top2DayShareOfAbsRPct, topDays: f.topDays, maxSameDayAtTakeProfit: f.maxSameDayAtTakeProfit, concentrated: f.concentrated, beta: f.beta, meanR: f.meanR }; }) },
  readNight: { day: fm.day, commit: fm.commit, asOf: snap.asOf, readerVerdict: snap.verdict, honestBar: snap.honestBar, graded: readableThen.map((c) => ({ cell: c.cell, n: c.n, days: c.days, meanR: c.meanR, netExposure: c.netExposure, alpha: c.alpha, beta: c.beta, tAlpha: c.tAlpha, p: +c.p.toFixed(4), bhPass: !!c.bhPass, top2DayShareOfAbsRPct: c.top2DayShareOfAbsRPct, topDays: c.topDays, maxSameDayAtTakeProfit: c.maxSameDayAtTakeProfit, concentrated: c.concentrated })),
    reproductionFromLedgerRowsClosedByThen: { poolThen: poolThen.length, snapshotPool: snap.cells.reduce((s, c) => s + c.n, 0), readableCellsMatch: reproThen.filter((r) => r.readableThen).every((r) => r.matches), allNonCryptoMatch: reproThen.every((r) => r.matches), mismatches: reproThen.filter((r) => !r.matches) } },
  bar,
  benchmark: {
    registered: "rule (2): a class benchmark return b_d for the same session — Equity and Options = SPY, Futures = ES, FX = DXY; crypto = equal-weight return of the cell's own traded pairs",
    readerUses: "crypto: the equal-weight complex (as registered). Every other class: one map eqRet[day] = the ledger field mktRet of the LAST non-crypto ticket in ledger order that was opened that day and carries the field. mktRet is SPY over that one ticket's own hold, in percent — not SPY for the session.",
    ticketsCarryingMktRet: { nonCryptoTickets: nonCrypto.length, withMktRet: carry.length, byCell: carryByCell },
    daysWithABenchmark: benchDays.length, daysWithMoreThanOneValue: benchDays.filter((x) => x.distinctValues > 1).length, largestSameDaySpreadPct: benchDays.length ? Math.max(...benchDays.map((x) => r4(x.max - x.min))) : null,
    readerValueAgainstSpySession: corr, readerValueAgainstSpyNextSession: corrNext, spy: { sources: spy.sources, overlapAgrees: spy.overlapAgrees, overlap: spy.overlap },
    days: benchDays,
    sensitivityWEIGHTLESS: { label: "the reader's own formula on the reader's own rows with b_d = SPY close-to-close for the session (the registered benchmark for Equity and Options). Not the read. Shown so the verdict can be seen not to depend on the benchmark the reader used.",
      tonight: sensTonight, readNight: sensThen, readableCellsUnderSpyTonight: readableUnderSpy, readableCellsUnderSpyReadNight: readableUnderSpyThen, nightBeforeUnderSpy: { day: nightly.nightBefore.day, readableCells: readableUnderSpyNightBefore, mostSignalDaysInAnyCell: maxDaysNightBeforeUnderSpy },
      everyNight: { firstNightWithAReadableCellUnderSpy: firstUnderSpy ? firstUnderSpy.day : null, nightsWithAReadableCell: sensNights.length, largestPositiveAlphaTOnAnyNight: Number.isFinite(sensMaxPosT) ? sensMaxPosT : null, nights: sensNights },
      whyTheDayCountsDiffer: "the reader has a benchmark for a day only once an equity ticket opened that day and carrying mktRet has settled (usually the next morning), so its newest day is usually missing and a cell reaches 30 days a night later than it would on SPY session returns", anyGradedCellWithPositiveAlphaAtTTwoOrMore: anySensAboveTwo },
  },
  population, dollars: dol,
};
writeJsonAtomic(path.join(__dirname, "r44-diagnostics.json"), out);

const usd = (x) => `${x < 0 ? "-" : "+"}$${Math.abs(x).toFixed(2)}`;
console.log(`reader output asOf ${state.asOf}: ${state.verdict}`);
console.log(`A. reproduction tonight: ${repro.filter((r) => r.matches).length}/${repro.length} non-crypto cells match the reader's file${repro.every((r) => r.matches) ? "" : " — MISMATCH " + JSON.stringify(repro.filter((r) => !r.matches))}; pool ${pool.length} (${poolCountMatches ? "matches" : "DOES NOT MATCH"} the reader's cell counts)`);
console.log(`   graded tonight: ${readableTonight.map((c) => `${c.cell} n ${c.n} days ${c.days} alpha ${c.alpha} t ${c.tAlpha} p ${c.p} (BH line ${c.bhThreshold}${c.bhPass ? " PASS" : ""})`).join(" | ")}`);
console.log(`B. read night ${fm.day} (${fm.commit}): ${snap.verdict}`);
console.log(`   graded then: ${readableThen.map((c) => `${c.cell} n ${c.n} days ${c.days} alpha ${c.alpha} t ${c.tAlpha}`).join(" | ")}`);
console.log(`   reproduced from ledger rows closed by then: pool ${poolThen.length} vs snapshot ${snap.cells.reduce((s, c) => s + c.n, 0)}; readable cells match ${out.readNight.reproductionFromLedgerRowsClosedByThen.readableCellsMatch}; all non-crypto match ${out.readNight.reproductionFromLedgerRowsClosedByThen.allNonCryptoMatch} ${JSON.stringify(out.readNight.reproductionFromLedgerRowsClosedByThen.mismatches)}`);
console.log(`C. bar: read night best-of-${bar.readNight.cellsGraded} at n ${bar.readNight.topCellDays}: reader printed ${bar.readNight.readerPrinted}; ${bar.readNight.spread.runs} runs ${bar.readNight.spread.min}..${bar.readNight.spread.max}, median ${bar.readNight.spread.median}, 200k trials ${bar.readNight.spread.at200000Trials}`);
console.log(`        tonight   best-of-${bar.tonight.cellsGraded} at n ${bar.tonight.topCellDays}: reader printed ${bar.tonight.readerPrinted}; ${bar.tonight.spread.runs} runs ${bar.tonight.spread.min}..${bar.tonight.spread.max}, median ${bar.tonight.spread.median}, 200k trials ${bar.tonight.spread.at200000Trials}`);
console.log(`D. benchmark: ${carry.length}/${nonCrypto.length} non-crypto tickets carry mktRet ${JSON.stringify(carryByCell)}`);
console.log(`   ${benchDays.length} days with a benchmark; ${out.benchmark.daysWithMoreThanOneValue} carry more than one value that day (largest same-day spread ${out.benchmark.largestSameDaySpreadPct} pct); reader's value vs SPY session return: correlation ${corr.correlation} on ${corr.days} days; SPY overlap agrees ${spy.overlapAgrees}`);
console.log(`   sensitivity (weightless), SPY session benchmark, tonight: ${sensTonight.map((c) => `${c.cell} alpha ${c.alpha} t ${c.tAlpha} [reader ${c.readerAlpha} / ${c.readerT}; no regressor t ${c.noRegressorT}]`).join(" | ")}`);
console.log(`   sensitivity (weightless), SPY session benchmark, read night: ${sensThen.map((c) => `${c.cell} alpha ${c.alpha} t ${c.tAlpha} [reader ${c.readerAlpha} / ${c.readerT}; no regressor t ${c.noRegressorT}]`).join(" | ")}`);
console.log(`   readable under SPY tonight: ${readableUnderSpy.map((c) => `${c.cell} d${c.days} t${c.tAlpha}`).join(" ; ")}`);
console.log(`   readable under SPY on the read night: ${readableUnderSpyThen.map((c) => `${c.cell} n${c.n} d${c.days} a${c.alpha} t${c.tAlpha}`).join(" ; ")}; the night before (${nightly.nightBefore.day}): ${readableUnderSpyNightBefore.length} readable, most signal-days in any cell ${maxDaysNightBeforeUnderSpy}; reader's value vs SPY NEXT session: correlation ${corrNext.correlation} on ${corrNext.days} days`);
console.log(`   every night under SPY: first night with a readable cell ${firstUnderSpy ? firstUnderSpy.day : "none"}; ${sensNights.map((x) => `${x.day}: ${x.cells.map((c) => `${c.cell} d${c.days} t${c.tAlpha}`).join(", ")}`).join(" | ")}; largest positive-alpha t on any night ${sensMaxPosT}`);
console.log(`E. population: pool ${pool.length}, veto shadows ${population.vetoShadowsInPool}, controls ${population.controlsInPool}, last close ${population.lastTicketClosed}`);
for (const c of lastOpenByCell) console.log(`   ${c.cell.padEnd(26)} n ${String(c.n).padStart(4)} signal-days ${String(c.signalDays).padStart(3)} (reader ${c.daysInReader}) ${c.firstOpen}..${c.lastOpen} net ${String(c.netExposure).padStart(6)} ${c.directional ? "DIRECTIONAL" : ""} ${c.readable ? "GRADED" : ""}`);
console.log(`   open booked positions that can still add signal-days: ${Object.entries(openBooked).filter(([, v]) => v.entryDatesNotYetInThePool.length).map(([k, v]) => `${k} ${v.open} open, new entry dates ${v.entryDatesNotYetInThePool.join(" ")}`).join(" ; ") || "none"}`);
console.log(`   directional cells: ${directional.length}, graded ${population.directionalCells.readable}`);
const line = (k, d) => `   ${k.padEnd(26)} ${String(d.tickets).padStart(4)} tickets  net ${usd(d.net).padStart(11)}  gains ${usd(d.gains)} on ${d.wins} (avg ${d.avgWin == null ? "—" : usd(d.avgWin)})  losses ${usd(d.losses)} on ${d.losers} (avg ${d.avgLoss == null ? "—" : usd(d.avgLoss)})  win ${d.winRatePct}%  worst drawdown ${usd(d.worstDrawdown)}`;
console.log(`F. dollars tonight (as booked):`);
for (const [k, d] of Object.entries(dol.tonight.everyCell)) console.log(line(k + (gradedTonight.includes(k) ? " *" : ""), d));
console.log(line("graded cells together", dol.tonight.gradedCellsTogether)); console.log(line("whole pool", dol.tonight.wholePool));
console.log(`   read night ${fm.day}:`); for (const [k, d] of Object.entries(dol.readNight.gradedCells)) console.log(line(k, d)); console.log(line("graded cells together", dol.readNight.gradedCellsTogether));
