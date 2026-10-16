#!/usr/bin/env node
/**
 * BT-RUN — the server backtest runner. NO AI in it and NO NETWORK: it takes a rule definition (JSON, schema bt-rule-v1), runs it over stored
 * daily bars (one file per symbol in a folder), with costs, and writes ONE SEALED result file. 2026-10-16 (docs/server-backtest-runner/2026-10-16).
 *
 *   node backend/bt/bt-run.cjs --rule <rule.json> --bars <dir> --out <result.json> [--exploratory]
 *   node backend/bt/bt-run.cjs --verify <result.json>        recompute the seal: exit 0 intact, 1 altered or unreadable
 *
 * WHAT IT COMPUTES (the dip-buy family's registered read, R313's design; the arithmetic is bt-core.cjs, ported verbatim from r313-ibs-etfs.js):
 *   trades     entry at the close of a signal day, exit at the close of the first exit day (or the time cap), one position per symbol, a signal
 *              while long ignored; entries inside the window from Jan 1 of each symbol's first full year; trades still open at the last bar
 *              are listed, never counted. net = exit / entry - 1 - costs.roundTrip.
 *   mean, t    the registered clustering unit: calendar MONTH of entry, the mean net of the month's trades (symbols pooled); t = Newey-West lag 1
 *              over months; both halves; the same trades at costs.stress (2x cost).
 *   placebo    R313's CORRECTED MATCHED PLACEBO: per real trade a random non-signal day of the same symbol in the same month (+-1), window
 *              disjoint from [t-3, u], hold drawn from OTHER symbols' real holds, same cost; gate: NW t of the monthly paired difference >= bar.
 *   floor      R150 drift-kept floor: the rule on controls.floorSeeds within-symbol bar shuffles; gate: mean > floor p95 AND NW t (series - p50) >= bar.
 *   leak       drift-free shuffles (controls.leakSeeds): t < 2 on each, else CANNOT MEASURE.  positive control: the rule's own winners, t >= 3.
 *   bar        rule.bar.tRequired when the rule carries its REGISTERED bar (used as given, never recomputed); otherwise the best-of-variants bar
 *              barFor(n months, rule.bar.variants) = max(NW-on-noise p95, backend/lib/null-bar.js p95), seeded.
 * A rule without `registration` runs only with --exploratory, and its file and verdict say EXPLORATORY: it is never a read of a registered
 * test (registering happens at home, in backend/data/test-registry.json; this runner never reads or writes the registry).
 *
 * THE SEALED FILE: schema bt-result-v1 — the rule (embedded, with its sha256), the sha256 of every bar file and of the set, the sha256 of this
 * runner's code and of the null bar used, every trade, the statistics, the controls, the gates, the verdict; seal.sha256 = sha256 of the
 * canonical JSON (sorted keys) of everything else — it detects an accidental or naive edit; it is NOT a signature (anyone can re-seal). Written once (an existing file is REFUSED, never overwritten), through
 * backend/lib/atomic-write.js, then made read-only (0444).
 * Exit 0 written (whatever the verdict) · 1 refused (rule, bars, existing output) · 2 usage.
 */
"use strict";
const fs = require("fs"), path = require("path");
const B = require("./bt-core.cjs");
const { fin, r4, r3, mean, nwT, summarise, strip, nearestRank, scramble, placeboPrepC, placeboRunC, pairedDiffs, floorGate, sha256 } = B;

/** canonical JSON: keys sorted at every level (the seal is over these bytes) */
const canon = (x) => (Array.isArray(x) ? `[${x.map(canon).join(",")}]` : x && typeof x === "object" ? `{${Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(x[k])}`).join(",")}}` : JSON.stringify(x === undefined ? null : x));
const pct = (x) => (x == null || !fin(x) ? null : r4(100 * x));
const sealOf = (body) => sha256(Buffer.from(canon(body), "utf8"));

/** the rule over loaded bars -> trades + statistics for one set of bars (real or scrambled) */
function runRule(R, barsBy) {
  const PS = {}, tr = [], open = [], perSymbol = {};
  for (const s of R.universe) {
    const P = B.prepRule(barsBy[s], R); PS[s] = P;
    const r = B.simulateRule(P, s, R);
    const mine = r.closed.map((x) => ({ ...x, net: x.gross - R.costs.roundTrip }));
    tr.push(...mine); open.push(...r.open);
    perSymbol[s] = { trades: mine.length, meanNetPctPerTrade: mine.length ? r4(100 * mean(mine.map((x) => x.net))) : null, ignoredSignals: r.ignored, entryFrom: P.from, open: r.open.length };
  }
  return { PS, tr, open, perSymbol };
}

/**
 * RUN (pure apart from reading the bar files). -> the result body (unsealed). opts: { exploratory, NB (a loaded null bar) }
 */
function run(rule, barsDir, opts = {}) {
  const R = B.checkRule(rule);
  const mode = R.registration ? "registered" : opts.exploratory ? "exploratory" : null;
  if (mode === "exploratory" && R.reservedForRegistration) throw new Error("this rule is RESERVED FOR REGISTRATION (reservedForRegistration: true): its universe's bars must not be read before the test is registered at home — no exploratory run");
  if (!mode) throw new Error("the rule carries no `registration` (it is not a registered test): run it with --exploratory, and its result is labelled EXPLORATORY — never a read");
  if (R.registration && !(typeof R.registration.id === "string" && /^\d{4}-\d{2}-\d{2}$/.test(R.registration.registeredOn || "") && fin(R.bar.tRequired) && R.window.lastBar))
    throw new Error("a registered rule needs registration.id, registration.registeredOn (YYYY-MM-DD), its registered bar.tRequired and window.lastBar (the forming-bar guard: a read must not depend on when the bars were fetched)");
  // data
  const files = {}, barsBy = {};
  for (const s of R.universe) { const L = B.loadBars(barsDir, s, { lastBar: R.window.lastBar || null, coverTo: R.window.to, maxGapDays: R.window.maxGapDays ?? 14 }); barsBy[s] = L.bars; files[s] = { file: L.file, sha256: L.sha, bars: L.bars.length, first: L.bars[0].t, last: L.bars[L.bars.length - 1].t, weekendRowsDropped: L.weekendDropped, afterLastBarDropped: L.afterLastDropped, maxGapDays: L.maxGapDays, maxGapAfter: L.maxGapAfter }; }
  const dataSha = sha256(Buffer.from(Object.keys(files).sort().map((s) => `${files[s].sha256}  ${s}`).join("\n") + "\n"));
  // the real run
  const { PS, tr, open, perSymbol } = runRule(R, barsBy);
  const S = summarise(tr), S2 = summarise(tr, { netOf: (x) => x.gross - R.costs.stress });
  // bar
  const NB = opts.NB || B.loadNullBar();
  const bar = fin(R.bar.tRequired) ? { tRequired: R.bar.tRequired, source: R.bar.source || "the rule's registered bar (used as given)", computed: false }
    : (() => { const b = B.barFor(R.bar.n ?? Math.max(S.months, 3), { variants: R.bar.variants, seed: R.bar.seed ?? 313, trialsNw: R.bar.trialsNw ?? 50000, trialsIid: R.bar.trialsIid ?? 20000, NB }); return { tRequired: b.bar, computed: true, ...b, source: `barFor: max(NW lag-1 t on noise p95, null-bar p95), best of ${b.variants}, n ${b.n}, seed ${b.seed}` }; })();
  const t = bar.tRequired;
  // placebo
  const C = R.controls;
  const pl = tr.length ? placeboRunC(placeboPrepC(tr, PS), PS, { draws: C.placeboDraws, seed: C.placeboSeed, cost: R.costs.roundTrip }) : null;
  const dC = pl ? pairedDiffs(S, pl) : [], placeboPairedT = nwT(dC);
  // drift-kept scrambles: the floor, and (R313's calibration) the WHOLE decision rule's false-pass rate on them
  const kept = [];
  for (let seed = 1; seed <= C.floorSeeds; seed++) {
    const sb = {}; for (const s of R.universe) sb[s] = scramble(barsBy[s], seed, s, false);
    const x = runRule(R, sb), Sx = summarise(x.tr), S2x = summarise(x.tr, { netOf: (y) => y.gross - R.costs.stress });
    const plx = x.tr.length ? placeboRunC(placeboPrepC(x.tr, x.PS), x.PS, { draws: C.placeboDraws, seed: C.placeboSeed, cost: R.costs.roundTrip }) : null;
    kept.push({ seed, S: Sx, S2: S2x, placeboPairedT: plx ? nwT(pairedDiffs(Sx, plx)) : null });
    if (opts.progress) opts.progress(`drift-kept scramble ${seed} of ${C.floorSeeds}`);
  }
  const floorOf = (rows) => { const v = rows.map((r) => r.S.meanNet).filter(fin).sort((a, b) => a - b); return { seeds: v.length, p50: nearestRank(v, 0.5), p95: nearestRank(v, 0.95) }; };
  // complete (R313's ok): every seed gave a mean AND a measurable placebo t — a seed that cannot be judged is never counted as "not passing"
  const floor = floorOf(kept), floorComplete = floor.seeds === C.floorSeeds && kept.every((r) => fin(r.placeboPairedT));
  const fg = floorGate(S, floor, t);
  // each drift-kept scramble judged by the full rule against the floor of the OTHER seeds (leave-one-out; leak + positive control taken as passed)
  const judged = kept.map((r, j) => { const fl = floorOf(kept.filter((_, i) => i !== j)), g = floorGate(r.S, fl, t);
    return B.decideRule({ trades: r.S.trades, months: r.S.months, meanNet: r.S.meanNet, tNW: r.S.tNetRaw, halfFirst: r.S.halves && r.S.halves.first.meanNet, halfSecond: r.S.halves && r.S.halves.second.meanNet,
      meanNet2x: r.S2.meanNet, placeboPairedT: r.placeboPairedT, floorMeanAboveP95: g.meanAboveP95, floorTVsP50AtLeastBar: g.tVsP50AtLeastBar, leakPass: true, positivePass: true, bar: t, minTrades: R.gates.minTrades, minMonths: R.gates.minMonths }).verdict; });
  const maxFP = fin(C.maxWholeRuleFalsePass) ? C.maxWholeRuleFalsePass : 0.05, falsePass = judged.length ? judged.filter((v) => v === "PASS").length / judged.length : null;
  // REPORTED (R313 reports it too, it decides nothing): drift-FREE scrambles judged against the full floor — no structural ceiling
  const freeArm = (C.leakSeeds || []).map((seed) => { const sb = {}; for (const s of R.universe) sb[s] = scramble(barsBy[s], 1000 + seed, s, true); const x = runRule(R, sb), Sx = summarise(x.tr), S2x = summarise(x.tr, { netOf: (y) => y.gross - R.costs.stress });
    const plx = x.tr.length ? placeboRunC(placeboPrepC(x.tr, x.PS), x.PS, { draws: C.placeboDraws, seed: C.placeboSeed, cost: R.costs.roundTrip }) : null, g = floorGate(Sx, floor, t);
    return { seed: 1000 + seed, verdict: B.decideRule({ trades: Sx.trades, months: Sx.months, meanNet: Sx.meanNet, tNW: Sx.tNetRaw, halfFirst: Sx.halves && Sx.halves.first.meanNet, halfSecond: Sx.halves && Sx.halves.second.meanNet, meanNet2x: S2x.meanNet, placeboPairedT: plx ? nwT(pairedDiffs(Sx, plx)) : null, floorMeanAboveP95: g.meanAboveP95, floorTVsP50AtLeastBar: g.tVsP50AtLeastBar, leakPass: true, positivePass: true, bar: t, minTrades: R.gates.minTrades, minMonths: R.gates.minMonths }).verdict }; });
  const ceiling = B.calibrationCeiling(judged.length);
  const calibration = { ceiling: { maxPossiblePasses: ceiling, ofSeeds: judged.length, rate: judged.length ? ceiling / judged.length : null, canHold: judged.length ? ceiling / judged.length > maxFP : false,
      note: `by construction at most ${ceiling} of ${judged.length} drift-kept seeds can pass (leave-one-out floor, nearest-rank p95); ${judged.length && ceiling / judged.length > maxFP ? "so the calibration CAN hold a read" : `that is ${(100 * ceiling / Math.max(1, judged.length)).toFixed(1)}% <= the limit: at this seed count the calibration CANNOT hold a read (R313's registered design has the same property at 60 seeds)`}` },
    driftFreeArm: { seeds: freeArm.length, passes: freeArm.filter((x) => x.verdict === "PASS").length, perSeed: freeArm, note: "REPORTED ONLY (as in R313): drift-free scrambles judged against the full drift-kept floor" },
    perSeed: kept.map((r, j) => ({ seed: r.seed, verdict: judged[j], tNW: r4(r.S.tNetRaw), placeboPairedT: r4(r.placeboPairedT) })), driftKeptSeeds: judged.length, passes: judged.filter((v) => v === "PASS").length, falsePass, limit: maxFP, calibrated: falsePass != null && falsePass <= maxFP && floorComplete,
    note: "R313's design: the full decision rule on the drift-kept scrambles (no timing edge by construction), each against the floor of the other seeds; above the limit the read is HELD" };
  // leak test (drift-free shuffles) and positive control (own winners)
  const leak = C.leakSeeds.map((seed) => { const sb = {}; for (const s of R.universe) sb[s] = scramble(barsBy[s], seed, s, true); const x = summarise(runRule(R, sb).tr); return { seed, trades: x.trades, months: x.months, tNW: r4(x.tNetRaw), pass: B.leakPasses(x.tNetRaw) }; });   // R313: an unmeasured t (null) FAILS the leak test
  const pos = summarise(tr.filter((x) => x.net > 0)), positive = { trades: pos.trades, months: pos.months, tNW: r4(pos.tNetRaw), pass: B.positivePasses(pos.tNetRaw) };
  const J = B.decideRule({ trades: S.trades, months: S.months, meanNet: S.meanNet, tNW: S.tNetRaw, halfFirst: S.halves && S.halves.first.meanNet, halfSecond: S.halves && S.halves.second.meanNet,
    meanNet2x: S2.meanNet, placeboPairedT, floorMeanAboveP95: fg.meanAboveP95, floorTVsP50AtLeastBar: fg.tVsP50AtLeastBar, leakPass: leak.every((x) => x.pass), positivePass: positive.pass,
    bar: t, minTrades: R.gates.minTrades, minMonths: R.gates.minMonths });
  // the verdict: CANNOT MEASURE first (the rule's own), then a HELD read when the floor is incomplete or the calibration is over its limit
  let verdict = J.verdict;
  if (!/^CANNOT MEASURE/.test(verdict) && !floorComplete) verdict = `CANNOT MEASURE — of ${C.floorSeeds} drift-kept scrambles, ${floor.seeds} gave a mean and ${kept.filter((r) => fin(r.placeboPairedT)).length} a measurable placebo t (all are needed for the floor and the calibration)`;
  else if (!/^CANNOT MEASURE/.test(verdict) && !calibration.calibrated) verdict = `HELD — the whole rule passes ${calibration.passes} of ${calibration.driftKeptSeeds} drift-kept no-edge scrambles (${(100 * falsePass).toFixed(1)}% > ${100 * maxFP}%): its verdict (${J.verdict}) is not a read until the registry amends it`;
  const codeFiles = ["bt-core.cjs", "bt-run.cjs"].map((f) => [f, sha256(fs.readFileSync(path.join(__dirname, f)))]);
  return {
    schema: "bt-result-v1", mode, label: mode === "exploratory" ? "EXPLORATORY — not a registered test; this result is never a read" : `registered test ${R.registration.id} (registered ${R.registration.registeredOn})`,
    rule: R, ruleSha256: sha256(Buffer.from(canon(R), "utf8")),
    data: { dir: path.resolve(barsDir), setSha256: dataSha, files },
    code: { files: Object.fromEntries(codeFiles), nullBar: { file: NB.path || null, sha256: NB.sha || null }, node: process.version },
    bar, unit: "month of entry; Newey-West t, lag 1",
    stats: { ...strip(S), meanNetPctPerMonth: S.meanNetPctPerMonth, monthly: S._keys ? S._keys.map((k, i) => [k, r4(100 * S._series[i])]) : [], stress: { roundTrip: R.costs.stress, meanNetPctPerMonth: S2.meanNetPctPerMonth, meanNet: S2.meanNet } },
    costs: R.costs,
    placebo: pl ? { draws: pl.draws, seed: pl.seed, months: pl.months, pairedT: r4(placeboPairedT), pairedTRaw: placeboPairedT, pairedMeanDiffPctPerMonth: dC.length ? r4(100 * mean(dC)) : null,
      p05PctPerMonth: pct(pl.p05), p50PctPerMonth: pct(pl.p50), p95PctPerMonth: pct(pl.p95), widenedPerDraw: r3(pl.widenedPerDraw), droppedPerDraw: r3(pl.droppedPerDraw) } : null,
    floor: { ...floor, wanted: C.floorSeeds, p50PctPerMonth: pct(floor.p50), p95PctPerMonth: pct(floor.p95), gate: { meanAboveP95: fg.meanAboveP95, tVsP50: fg.tVsP50, clears: fg.clears } },
    calibration, ruleVerdict: J.verdict,
    leakTest: leak, positiveControl: positive,
    gates: J.gates, failed: J.failed, verdict: (mode === "exploratory" ? "EXPLORATORY: " : "") + verdict,
    perSymbol, trades: tr.map((x) => ({ sym: x.sym, entryDate: x.entryDate, exitDate: x.exitDate, entry: x.entry, exit: x.exit, hold: x.hold, month: x.month, gross: x.gross, net: x.net, ...(x.capped ? { capped: true } : {}) })),
    open: open.map((x) => ({ sym: x.sym, entryDate: x.entryDate, entry: x.entry, markDate: x.markDate, mark: x.mark })),
  };
}
/** body -> the sealed object */
const seal = (body, now = new Date()) => { const b = { ...body, sealedAt: now.toISOString() }; return { ...b, seal: { algo: "sha256 of the canonical JSON (sorted keys) of every field but seal", sha256: sealOf(b) } }; };
/** -> { ok, why } */
function verify(obj) {
  if (!obj || obj.schema !== "bt-result-v1" || !obj.seal || !/^[0-9a-f]{64}$/.test(obj.seal.sha256 || "")) return { ok: false, why: "not a sealed bt-result-v1 file" };
  const { seal: s, ...body } = obj, got = sealOf(body);
  return got === s.sha256 ? { ok: true, why: null } : { ok: false, why: `the seal does not match: the file was altered after sealing (want ${s.sha256.slice(0, 16)}, the content gives ${got.slice(0, 16)})` };
}
/** write once: refuse an existing file; atomic; then read-only */
function writeSealed(out, sealed, writeJson) {
  if (fs.existsSync(out)) throw new Error(`${out} exists — a sealed result is never overwritten (choose a new --out)`);
  // written in full beside it (atomic-write), then LINKED to its name: link() fails if the name exists, so a file that appeared meanwhile is
  // never replaced (no exists-then-rename race)
  const tmp = `${out}.sealing-${process.pid}`;
  writeJson(tmp, sealed);
  try { fs.chmodSync(tmp, 0o444); fs.linkSync(tmp, out); }
  catch (e) { if (e.code === "EEXIST") throw new Error(`${out} exists — a sealed result is never overwritten (choose a new --out)`); throw e; }
  finally { fs.rmSync(tmp, { force: true }); }
  const back = JSON.parse(fs.readFileSync(out, "utf8")), v = verify(back);
  if (!v.ok) throw new Error(`written but does not verify: ${v.why}`);
}

function main(argv, deps = {}) {
  const log = deps.log || console.log, err = deps.err || console.error, a = argv.slice();
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const known = new Set(["--rule", "--bars", "--out", "--exploratory", "--verify"]);
  const seen = new Set();
  for (let i = 0; i < a.length; i++) {
    if (!known.has(a[i])) { err(`bt-run: unknown argument ${JSON.stringify(a[i])}`); return 2; }
    if (seen.has(a[i])) { err(`bt-run: ${a[i]} given twice`); return 2; } seen.add(a[i]);
    if (a[i] !== "--exploratory") { if (a[i + 1] == null || a[i + 1].startsWith("--")) { err(`bt-run: ${a[i]} needs a value`); return 2; } i++; }
  }
  if (a.includes("--verify")) {
    let o; try { o = JSON.parse(fs.readFileSync(opt("--verify"), "utf8")); } catch (e) { err(`REFUSED: ${e.message}`); return 1; }
    const v = verify(o); if (v.ok) { log(`INTACT: ${o.label}; verdict ${o.verdict}; seal ${o.seal.sha256.slice(0, 16)}`); return 0; } err(`ALTERED: ${v.why}`); return 1;
  }
  const rf = opt("--rule"), bd = opt("--bars"), out = opt("--out");
  if (!rf || !bd || !out) { err("usage: node backend/bt/bt-run.cjs --rule <rule.json> --bars <dir> --out <result.json> [--exploratory] | --verify <result.json>"); return 2; }
  try {
    if (fs.existsSync(out)) throw new Error(`${out} exists — a sealed result is never overwritten (choose a new --out)`);
    const rule = JSON.parse(fs.readFileSync(rf, "utf8"));
    const body = run(rule, bd, { exploratory: a.includes("--exploratory"), NB: deps.NB, progress: (m) => err(`  ... ${m}`) });
    const sealed = seal(body, deps.now ? deps.now() : new Date());
    const writeJson = deps.writeJson || require(path.join(__dirname, "..", "lib", "atomic-write.js")).writeJsonAtomic;
    writeSealed(out, sealed, writeJson);
    log(`${sealed.label}\n  ${sealed.stats.trades} trades over ${sealed.stats.months} months · mean ${sealed.stats.meanNetPctPerMonth}%/month · t ${sealed.stats.tNet} (bar ${sealed.bar.tRequired}) · placebo paired t ${sealed.placebo ? sealed.placebo.pairedT : "n/a"}`);
    log(`  VERDICT ${sealed.verdict}${sealed.failed.length ? ` (failed: ${sealed.failed.join(", ")})` : ""}\n  SEALED ${out} (${sealed.seal.sha256.slice(0, 16)})`);
    return 0;
  } catch (e) { err(`REFUSED: ${e.message}`); return 1; }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { canon, sealOf, runRule, run, seal, verify, writeSealed, main };
