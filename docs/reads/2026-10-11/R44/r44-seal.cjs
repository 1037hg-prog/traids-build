#!/usr/bin/env node
/**
 * R44 — write, seal, record (read-test ritual, step 4). ONE script, atomic JSON writes, one lock.
 *   node r44-seal.cjs <repo root>            dry run: builds every record, writes nothing, takes no lock
 *   node r44-seal.cjs <repo root> --apply    takes backend/data/registry-write.lock (wx; waits up to 120 s), writes, removes the lock
 * Writes: read-seals.json (first seal only), test-registry.json (read + readCondition + status), change-registry.json (category read),
 *         agent-ledger.jsonl (kind READ, one appended line). Nothing else.
 * The verdict is DERIVED here from the registered reader's own committed output and the registry bar. Every number in the records comes
 * from the evidence files in docs/reads/2026-10-11/R44 after they are re-checked against git and the live state file.
 * The script refuses if anything it checks has moved.
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process");
const ROOT = path.resolve(process.argv[2] || "."), APPLY = process.argv.includes("--apply");
const BK = path.join(ROOT, "backend"), D = (f) => path.join(BK, "data", f);
const EV = path.join(ROOT, "docs", "reads", "2026-10-11", "R44");
const { writeJsonAtomic } = require(path.join(BK, "lib", "atomic-write.js"));
const ID = "R44", LOCK = D("registry-write.lock"), STATE = "backend/data/exposure-alpha.json";
const rj = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const mtDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(d);
const usd = (x) => `${x < 0 ? "-" : "+"}$${Math.abs(x).toFixed(2)}`;
const sg = (x, dp = 4) => `${x < 0 ? "-" : "+"}${Math.abs(x).toFixed(dp)}`;
const pc = (x) => `${x < 0 ? "-" : "+"}${Math.abs(100 * x).toFixed(1)}%`;
const gitShow = (commit, file) => cp.execFileSync("git", ["-C", ROOT, "show", `${commit}:${file}`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

function inCloseChainWindow(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Denver", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now).map((x) => [x.type, x.value]));
  const mins = Number(p.hour) * 60 + Number(p.minute), weekday = !["Sat", "Sun"].includes(p.weekday);
  return { blocked: weekday && mins >= 13 * 60 + 50 && mins < 15 * 60 + 50, mt: `${p.weekday} ${p.hour}:${p.minute} MT` };
}

function build() {
  const now = new Date(), nowIso = now.toISOString(), today = mtDay(now);
  const seals = rj(D("read-seals.json"));
  if ((seals.tests || {})[ID]) return { stop: "ALREADY-SEALED", detail: seals.tests[ID] };
  const reg = rj(D("test-registry.json"));
  const inTests = (reg.tests || []).filter((x) => x && x.id === ID), t = (reg.preregistered || []).find((x) => x.id === ID);
  if (!t) throw new Error("no registry entry for " + ID);
  if (inTests.length) throw new Error(ID + " also appears in registry.tests — read both before sealing");
  if (t.read && typeof t.read === "object") throw new Error(ID + " already carries a read object");
  if (t.readCondition && t.readCondition !== t.read) throw new Error(ID + " already carries a different readCondition");
  if (Array.isArray(t.amendments) && t.amendments.length) throw new Error(ID + " now carries amendments — re-read the contract before sealing");
  if (t.freeze) throw new Error(ID + " is frozen");

  // ---- the contract ------------------------------------------------------------------------------------------------------
  const bar = t.bar || {};
  if (bar.fixedInAdvance !== true || bar.minDays !== 30 || bar.minN !== 60 || bar.qFDR !== 0.05 || bar.tRequired !== "best-of-N null bar on the top cell, N = cells graded") throw new Error("registry bar is not 30 signal-days / 60 tickets / BH q 0.05 / best-of-N on cells graded");
  if (t.evidenceStart !== "2026-08-25" || t.script !== "backend/exposure-alpha.js" || t.registered !== "2026-08-24") throw new Error("registry registered / evidenceStart / script moved");
  const ann = t.annotations || [];
  if (ann.length !== 2 || ann[0].date !== "2026-09-04" || ann[1].date !== "2026-10-05" || !/not an amendment/.test(String(ann[1].kind))) throw new Error("the entry's annotations changed — re-read the contract before sealing");
  if (!/must never again be quoted without its net exposure beside it/.test(String(bar.decisionRule)) || !/The test adopts nothing by itself/.test(String(bar.decisionRule))) throw new Error("decisionRule text moved");

  // ---- the evidence files, re-checked ------------------------------------------------------------------------------------
  const nightly = rj(path.join(EV, "r44-nightly.json")), diag = rj(path.join(EV, "r44-diagnostics.json"));
  if (!nightly.everyReaderFlagAgreesWithTheCellRows || nightly.unreadable) throw new Error("a nightly snapshot is unreadable or its readable flag disagrees with its cell rows");
  const fm = nightly.firstMet, before = nightly.nightBefore, since = nightly.sinceFirstMet;
  if (!fm) return { stop: "NOT-READABLE", detail: { note: "no committed reader output has a cell at >= 30 signal-days and >= 60 tickets", nights: nightly.snapshots } };
  if (!before || before.readableCells !== 0) throw new Error("the night before the read night already had a readable cell");
  // the read night against git, independently of the evidence file
  const snap = JSON.parse(gitShow(fm.commit, STATE));
  const snapReadable = (snap.cells || []).filter((c) => c.days >= bar.minDays && c.n >= bar.minN);
  if (snap.asOf !== fm.asOf || snap.honestBar !== fm.honestBar || snap.verdict !== fm.verdict || snapReadable.length !== fm.readable.length) throw new Error("the read night in r44-nightly.json does not match git show " + fm.commit);
  for (const c of fm.readable) { const s = snapReadable.find((x) => x.cell === c.cell); if (!s || s.alpha !== c.alpha || s.tAlpha !== c.tAlpha || s.days !== c.days || s.n !== c.n || !!s.bhPass !== c.bhPass || !s.readable) throw new Error("read-night cell " + c.cell + " does not match git"); }
  if (!snap.inEvidence || snap.evidenceStart !== t.evidenceStart) throw new Error("the read-night output is not in evidence from the registered start");
  if (snap.bar.minDays !== bar.minDays || snap.bar.minN !== bar.minN || snap.bar.qFDR !== bar.qFDR) throw new Error("the reader's bar on the read night is not the registry's");
  if (!/^NO CELL CLEARS/.test(String(snap.verdict)) || (snap.survivors || []).length) throw new Error("the reader's own verdict on the read night was not NO CELL CLEARS: " + snap.verdict);
  // tonight's reader output must be the one the diagnostics describe
  const m = rj(D("exposure-alpha.json"));
  if (diag.reader.outputAsOf !== m.asOf || diag.reader.verdict !== m.verdict) throw new Error("the reader's output changed since the diagnostics ran — re-run r44-diagnostics.cjs");
  if (!diag.tonight.reproduction.allMatch) throw new Error("diagnostics did not reproduce the reader tonight");
  if (diag.readNight.commit !== fm.commit || !diag.readNight.reproductionFromLedgerRowsClosedByThen.allNonCryptoMatch) throw new Error("diagnostics did not reproduce the read night from the ledger");
  const P = diag.population;
  if (!P.poolCountMatchesTheReadersCells || P.vetoShadowsInPool !== 0 || P.controlsInPool !== 0 || P.source !== "data/trade_log.json" || (P.retireTagsIgnored || []).length) throw new Error("population check failed");
  if (!diag.benchmark.spy.overlapAgrees) throw new Error("the two SPY stores disagree on their overlap — the sensitivity is not usable");

  // ---- sample condition and verdict — derived ----------------------------------------------------------------------------
  if (fm.readable.length < 1) return { stop: "NOT-READABLE", detail: fm };
  const clears = (cells, hb) => cells.filter((c) => c.bhPass && c.alpha > 0 && hb != null && Math.abs(c.tAlpha) >= hb);
  const verdict = clears(fm.readable, fm.honestBar).length ? "CLEARED" : "DID NOT PASS";
  if (verdict !== "DID NOT PASS") throw new Error("verdict is " + verdict + " — the records below were written for DID NOT PASS; stop and re-do step 3");
  const B = diag.bar, lowestBarDraw = Math.min(B.readNight.spread.min, B.tonight.spread.min);
  const tonightGraded = diag.tonight.graded, S = diag.benchmark.sensitivityWEIGHTLESS, SE = S.everyNight;
  // the verdict must not hang on a choice: the night, the Monte Carlo draw of the bar, or the benchmark
  if (since.anyNightWithASurvivor || since.anyBhPass || (m.survivors || []).length || tonightGraded.some((c) => c.bhPass)) throw new Error("some night has a survivor or a BH pass — the verdict depends on the night; stop and report");
  const maxPosReader = Math.max(since.maxPositiveAlphaT, ...tonightGraded.filter((c) => c.alpha > 0).map((c) => c.tAlpha));
  if (maxPosReader >= lowestBarDraw) throw new Error("a positive-alpha t reaches the lowest draw of the Monte Carlo bar — the verdict depends on the draw; stop and report");
  if (SE.largestPositiveAlphaTOnAnyNight != null && SE.largestPositiveAlphaTOnAnyNight >= lowestBarDraw) throw new Error("on SPY session returns a cell reaches the lowest bar draw — the verdict depends on the benchmark; stop and report");

  // ---- numbers for the records -------------------------------------------------------------------------------------------
  const cellLine = (c) => `${c.cell} alpha ${sg(c.alpha)}R, t ${c.tAlpha} on ${c.days} signal-days (${c.n} tickets; net exposure ${pc(c.netExposure)}; p ${c.p})`;
  const rn = fm.readable, m2 = rn.length;
  const bhLines = [...rn].sort((a, b) => a.p - b.p).map((c, i) => `${c.cell} p ${c.p} against ${(((i + 1) / m2) * bar.qFDR).toFixed(4)}`).join("; ");
  const DC = P.directionalCells, nearest = P.cells.filter((c) => c.directional).sort((a, b) => b.daysInReader - a.daysInReader)[0];
  const mr = P.cells.find((c) => c.cell === "Mean-Reversion · Equity"), r21 = P.cells.find((c) => c.cell === "R21-premium · Options"), te = P.cells.find((c) => c.cell === "Trend · Equity");
  const r21Open = (P.openBookedPositionsByCell || {})["R21-premium · Options"] || { open: 0, entryDates: {}, entryDatesNotYetInThePool: [] };
  const r21Final = r21.daysInReader + r21Open.entryDatesNotYetInThePool.length;
  if (r21Final >= bar.minDays) throw new Error("R21-premium · Options can still reach its sample — re-word the contract disclosure before sealing");
  const fileCells = Object.fromEntries((m.cells || []).map((c) => [c.cell, c]));
  const r25Nights = nightly.nights.filter((x) => (x.readable || []).some((c) => c.cell === "R25-0dte · Options")), r25First = r25Nights[0], r25c = r25First ? r25First.readable.find((c) => c.cell === "R25-0dte · Options") : null;
  const dT = diag.dollars.tonight, dR = diag.dollars.readNight;
  const bookLine = (k, b) => `${k}: ${b.tickets} tickets, net ${usd(b.net)} (gains ${usd(b.gains)} on ${b.wins} wins, average ${usd(b.avgWin)}; losses ${usd(b.losses)} on ${b.losers} losers, average ${usd(b.avgLoss)}; win rate ${b.winRatePct}%; worst drawdown ${usd(b.worstDrawdown)})`;
  const bm = diag.benchmark, sensLine = (a) => a.map((c) => `${c.cell} t ${c.tAlpha} (${c.days} days)`).join(", ");
  const firstSpy = SE.nights[0];

  const stat1 = `day-clustered t on the regression intercept (alpha net of net direction x benchmark; one observation per signal-day) per strategy x class cell, by the registered reader on the canonical ledger. Read night ${fm.day}, the first night any cell reached ${bar.minDays} signal-days and ${bar.minN} tickets — ${m2} cells graded: ${rn.map(cellLine).join("; ")}. Benjamini-Hochberg at q ${bar.qFDR}: none passes (${bhLines}). Best-of-${m2} bar ${fm.honestBar}: no positive alpha at or above it. ${snap.cellsTracked - m2} other cells were under their sample and were not graded.`;
  const barText = `per cell >= ${bar.minDays} signal-days and >= ${bar.minN} tickets; a cell clears with positive alpha inside the Benjamini-Hochberg family of graded cells at q = ${bar.qFDR} AND |t| >= the best-of-N null bar (lib/null-bar.js, N = cells graded, n = the top cell's signal-days). Read night: N = ${m2}, n = ${B.readNight.topCellDays}, the reader printed ${fm.honestBar}. The bar is a 2,000-trial Monte Carlo without a seed, so it moves a little on each run: ${B.readNight.spread.runs} re-draws gave ${B.readNight.spread.min} to ${B.readNight.spread.max}, and 200,000 trials give ${B.readNight.spread.at200000Trials}. Fixed at registration 2026-08-24; never amended.`;
  const headline = `DID NOT PASS — NO CELL CLEARS: ${m2} cells graded on ${fm.day}, the first night any cell met its sample (${rn.map((c) => `${c.cell} alpha ${sg(c.alpha)}R t ${c.tAlpha}`).join("; ")}; ${rn[0].days} signal-days each) against the best-of-${m2} bar ${fm.honestBar} and Benjamini-Hochberg q ${bar.qFDR}. No survivor on any of the ${since.nights} nightly outputs from the read night on (largest positive-alpha t ${since.maxPositiveAlphaT} against bars of ${since.honestBarMin} to ${since.honestBarMax}) or tonight (${tonightGraded.length} cells, bar ${m.honestBar}). No cell is proposed for a filter or a size dial. The registered hypothesis is about cells above 40% net exposure: none of the ${DC.count} such cells reached its sample, so it was not put to the test. Nothing live changes.`;

  const readNight = {
    rule: "read-once (read-seal-sweep.js semantics): the read is the reader's own output on the first night the registered sample condition held for any cell; later nights are post-seal, disclosed, weightless",
    night: fm.day, commit: fm.commit, asOf: fm.asOf, cellsTracked: snap.cellsTracked, cellsGraded: m2, honestBar: fm.honestBar, readerVerdict: fm.verdict, graded: rn,
    nightBefore: { day: before.day, commit: before.commit, readableCells: before.readableCells, readerVerdict: before.verdict, conditionMet: false },
    confirmedAgainstGit: `git show ${fm.commit}:${STATE} — the readable cells, their alpha and t, the bar and the verdict match (docs/reads/2026-10-11/R44/r44-nightly.cjs walks all ${nightly.snapshots} committed versions); the two graded cells also reproduce from the canonical ledger rows closed by that run (${diag.readNight.reproductionFromLedgerRowsClosedByThen.poolThen} tickets; r44-diagnostics.cjs)`,
    everyNightSinceFirstMet: { nights: since.nights, cellsGraded: `${since.readableCellsMin} to ${since.readableCellsMax}`, bar: `${since.honestBarMin} to ${since.honestBarMax}`, largestPositiveAlphaT: since.maxPositiveAlphaT, largestAbsT: since.maxAbsT, anyBenjaminiHochbergPass: false, anySurvivor: false },
    theChoiceOfNightCannotMoveTheVerdict: true,
    cellsThatReachedTheirSampleLater: r25c ? [{ cell: "R25-0dte · Options", firstReadableNight: r25First.day, alpha: r25c.alpha, tAlpha: r25c.tAlpha, days: r25c.days, n: r25c.n, bar: r25First.honestBar, bhPass: r25c.bhPass, note: "post-seal by one night; under the bar then and tonight" }] : [],
  };
  const hypothesis = {
    registered: t.hypothesis,
    finding: `${DC.count} of the ${P.cells.length} cells have |net exposure| above 40%; ${DC.readable} of them reached ${bar.minDays} signal-days and ${bar.minN} tickets. The nearest is ${nearest.cell} (net ${pc(nearest.netExposure)}, ${nearest.n} tickets, ${nearest.daysInReader} signal-days, last opened ${nearest.lastOpen}). The cells that were graded sit at ${rn.map((c) => `${pc(c.netExposure)}`).join(" and ")} net exposure. The hypothesis was therefore not put to the test by this read; it is neither confirmed nor refuted.`,
    directionalCells: DC.list,
  };
  const benchmarkDisclosure = {
    finding: `the registered rule names SPY for the session as the benchmark for Equity and Options cells. The registered reader takes the ledger field mktRet instead. Measured: ${bm.ticketsCarryingMktRet.withMktRet} of ${bm.ticketsCarryingMktRet.nonCryptoTickets} non-crypto tickets carry the field (no options ticket does); there is one value per open-day; and that value moves with SPY's NEXT session (correlation ${bm.readerValueAgainstSpyNextSession.correlation}) and not with the session the tickets opened in (correlation ${bm.readerValueAgainstSpySession.correlation}, ${bm.readerValueAgainstSpySession.days} days). The reader's direction-times-tape term therefore carries almost nothing about the session, and its intercept is close to the cell's plain daily mean R.`,
    sensitivityWeightless: { what: S.label, readNight: S.readableCellsUnderSpyReadNight, tonight: S.readableCellsUnderSpyTonight, firstNightWithAReadableCell: SE.firstNightWithAReadableCellUnderSpy, thatNight: firstSpy.cells, largestPositiveAlphaTOnAnyNight: SE.largestPositiveAlphaTOnAnyNight, whyTheDayCountsDiffer: S.whyTheDayCountsDiffer },
    ruling: `the read is the registered reader's number. On SPY session returns no cell clears either: read night ${sensLine(S.readableCellsUnderSpyReadNight)}; tonight ${sensLine(S.readableCellsUnderSpyTonight)}; largest positive-alpha t on any night ${SE.largestPositiveAlphaTOnAnyNight}, below every draw of the bar (lowest ${lowestBarDraw}). On SPY returns a cell would first have reached its sample one night earlier (${SE.firstNightWithAReadableCellUnderSpy}: ${sensLine(firstSpy.cells)}). The verdict does not depend on the benchmark. The reader was not edited for this read; the defect is filed for any successor (take SPY, ES and DXY session returns, never mktRet).`,
  };
  const postSeal = {
    label: "POST-SEAL, WEIGHTLESS — the registered reader run once on " + today + " (ledger unchanged since the 2026-10-09 close)",
    asOf: m.asOf, cellsTracked: m.cellsTracked, cellsGraded: tonightGraded.length, honestBar: m.honestBar, readerVerdict: m.verdict, graded: tonightGraded.map((c) => ({ ...c, netExposure: fileCells[c.cell].netExposure, meanR: fileCells[c.cell].meanR })),
    barSpread: B.tonight.spread,
  };
  const everyCell = (m.cells || []).map((c) => ({ cell: c.cell, n: c.n, days: c.days, meanR: c.meanR, netExposure: c.netExposure, alpha: c.alpha, tAlpha: c.tAlpha, top2DayShareOfAbsRPct: c.top2DayShareOfAbsRPct, topDays: c.topDays, maxSameDayAtTakeProfit: c.maxSameDayAtTakeProfit, concentrated: c.concentrated, directional: Math.abs(c.netExposure) > 0.4, graded: !!c.readable }));
  const mandatoryDiagnostics = {
    registered: "reported for every cell regardless of the bar: (a) net directional exposure; (b) the share of the cell's R on its top two days; (c) tickets resolving at exactly the take-profit multiple on one session. A cell above 50% on (b) is labelled CONCENTRATED.",
    note: "the reader measures (b) as a share of the sum of |daily R| (its header says why: a share of net R is undefined near zero)",
    asOf: m.asOf, cells: everyCell,
    concentrated: everyCell.filter((c) => c.concentrated).map((c) => c.cell), gradedCellsConcentrated: everyCell.filter((c) => c.graded && c.concentrated).map((c) => c.cell),
    mostSameDayTakeProfitTickets: Math.max(...everyCell.map((c) => c.maxSameDayAtTakeProfit)),
  };
  const dollars = {
    sizing: diag.dollars.sizing, drawdown: diag.dollars.drawdown,
    readNight: { day: dR.day, gradedCells: dR.gradedCells, gradedCellsTogether: dR.gradedCellsTogether },
    tonightPostSeal: { asOf: dT.asOf, gradedCells: dT.gradedCells, gradedCellsTogether: dT.gradedCellsTogether, everyCell: dT.everyCell, wholePool: dT.wholePool },
    text: `Read night ${dR.day}, the two graded cells as the board booked them — ${Object.entries(dR.gradedCells).map(([k, b]) => bookLine(k, b)).join("; ")}; ${bookLine("both together", dR.gradedCellsTogether)}. Tonight, post-seal — ${Object.entries(dT.gradedCells).map(([k, b]) => bookLine(k, b)).join("; ")}; ${bookLine("the three together", dT.gradedCellsTogether)}; ${bookLine("all 15 cells, every board signal ticket opened since 2026-08-25", dT.wholePool)}.`,
  };
  const quoted = tonightGraded.map((c) => `${c.cell} ${sg(fileCells[c.cell].meanR)}R at ${pc(fileCells[c.cell].netExposure)} net`).join("; ");
  const adoption = `NOTHING ADOPTED AND NOTHING PROPOSED. decisionRule, the branch for a cell that does not clear: "A cell that does not is exposure wearing a strategy name, and its standalone mean R must never again be quoted without its net exposure beside it. The test adopts nothing by itself." It applies to every graded cell. Measured, for those cells: no alpha beyond direction, and no edge to explain in the first place — their daily mean R is not distinguishable from zero and their net exposure is small. From here their mean R is quoted with net exposure beside it (${quoted}). No filter, size dial, gate or rule changes; Board Trend, the ensemble and the 0DTE sleeve stay exactly as the operator has them. The reader keeps running in the close chain; its later numbers are post-seal and weightless.`;
  const file = `${STATE} at nightly snapshot ${fm.commit} (asOf ${fm.asOf}); reader backend/exposure-alpha.js; evidence and scripts in docs/reads/2026-10-11/R44`;
  const contractDisclosure = `The entry carries no amendment. Two dated annotations, neither changing the bar, the rule or the definition of the population: 2026-09-04 (the reader was put on the close chain's schedule; it grades from the ledger, so nothing was lost) and 2026-10-05 (OP10, an operating decision outside the test: board Trend and Mean-Reversion signal tickets to veto shadows from 2026-10-06, which changes the composition of the population from that date). OP10b the same night kept Trend live, so the annotation's line that Trend cells stop accruing did not come true: Trend · Equity last opened ${te.lastOpen}. Mean-Reversion · Equity last opened ${mr.lastOpen} and is frozen at ${mr.daysInReader} signal-days; R21-premium · Options, the largest cell (${r21.n} tickets), has ${r21.daysInReader} signal-days and reaches ${r21Final} when its last booked wings settle (${r21Open.open} still open, entry dates not yet counted: ${r21Open.entryDatesNotYetInThePool.join(", ") || "none"}); new R21 wings have been shadows since 2026-10-05 (OP11), so it stops ${bar.minDays - r21Final} short of its sample and will not be graded. The reader was edited once after the evidence start (2026-09-10, a dailyClock field in its output; no change to the statistic, the population or the bar). Population as registered: cleanEraLedger().signals opened from 2026-08-25 — ${diag.readNight.reproductionFromLedgerRowsClosedByThen.poolThen} tickets on the read night, ${P.evidencePool} tonight; 0 veto shadows, 0 controls, validly retired rows excluded by the ledger. No cost model is registered: the statistic is on each ticket's realized R as the ledger booked it. bar-unit-check: R44 is not flagged — the gate (signal-days) is the unit the statistic clusters on. The best-of-N bar is one-sided and a survivor needs positive alpha, so the null holds direction.`;

  const read = {
    date: fm.day, recordedOn: today, readAt: nowIso, letter: "DID NOT PASS", verdict: "DID NOT PASS", statistic: stat1, n: rn[0].days,
    unit: `signal-days in each graded cell — the unit the intercept's t clusters on and the n the best-of-N bar is drawn at (${m2} cells graded: ${rn.map((c) => `${c.cell} ${c.days} days / ${c.n} tickets`).join(", ")})`,
    bar: barText, file, adoption, sealedOn: today,
    evidence: { readNight: { day: fm.day, commit: fm.commit, asOf: fm.asOf, cellsGraded: m2, honestBar: fm.honestBar, graded: rn, survivors: [] }, bar: { minDays: bar.minDays, minN: bar.minN, qFDR: bar.qFDR, bestOfN: fm.honestBar, barSpread: B.readNight.spread } },
    decisionRule: { text: bar.decisionRule, branchTaken: "a cell that does not clear (every graded cell)" },
    readNight, hypothesis, benchmarkDisclosure, contractDisclosure,
    multiplicity: `the result is not positive, so no best-of-N correction arises. For the record: the bar is sized to the cells graded (${m2} on the read night, ${tonightGraded.length} from ${r25First ? r25First.day : "later"}), not to the ${snap.cellsTracked} cells tracked.`,
    postSealWeightless: postSeal, mandatoryDiagnostics, dollars,
    knownWeaknessesStillTrue: `${t.knownWeaknesses} Added by the read: R25-0dte opens a put side and a call side together, so its net exposure is about zero by construction and its alpha is its plain daily mean R; and the equity-family benchmark the reader uses is not SPY for the session (benchmarkDisclosure).`,
    owed: ["a successor reader must take SPY / ES / DXY session returns for the equity-family classes, not the ledger's mktRet (filed; not built here)", "wherever a cell's mean R is quoted (reports, board panels), its net exposure goes beside it — the registered consequence of this read (reporting rule; not built here)"],
    reproduce: ["node backend/adjudicator.js", "node backend/exposure-alpha.js", "node docs/reads/2026-10-11/R44/r44-nightly.cjs", "node docs/reads/2026-10-11/R44/r44-diagnostics.cjs"],
    method: "read-test ritual 2026-10-11 (operator: 'Tests ready to be read'): adjudicator READY TO READ; the read night found by walking every committed reader output and confirmed against git; the registered reader run once tonight; its statistic compared with the bar as written; sealed the same night. Nothing recomputed beyond reproducing the reader's formula on its own rows; the SPY-session sensitivity is weightless and disclosed.",
    statusBeforeRead: t.status,
  };
  const status = `DID NOT PASS — READ SEALED ${today} at the first night any cell met its sample (${fm.day}): NO CELL CLEARS. Graded: ${rn.map((c) => `${c.cell} alpha ${sg(c.alpha)}R, t ${c.tAlpha}`).join("; ")} (${rn[0].days} signal-days each) against the best-of-${m2} bar ${fm.honestBar} and BH q ${bar.qFDR}. Post-seal ${today}: ${tonightGraded.length} cells graded, largest positive-alpha t ${Math.max(...tonightGraded.filter((c) => c.alpha > 0).map((c) => c.tAlpha))} against ${m.honestBar}. No cell above 40% net exposure reached its sample, so the registered hypothesis was not put to the test. The reader's equity benchmark is not SPY for the session (disclosed; on SPY session returns the largest t is ${SE.largestPositiveAlphaTOnAnyNight}, same verdict). Nothing proposed; nothing live changes.`;
  const seal = {
    sealedOn: today, sessions: rn[0].days,
    unit: `signal-days in each of the ${m2} cells graded on the read night ${fm.day}, the first night any cell met its sample (${rn.map((c) => `${c.cell} ${c.n} tickets`).join(", ")}; ${snap.cellsTracked - m2} other cells under their sample)`,
    verdict: headline,
    evidence: { readNight: { day: fm.day, commit: fm.commit, asOf: fm.asOf, cellsTracked: snap.cellsTracked, cellsGraded: m2, honestBar: fm.honestBar, graded: rn, survivors: [], readerVerdict: fm.verdict }, bar: { minDays: bar.minDays, minN: bar.minN, qFDR: bar.qFDR, bestOfN: fm.honestBar, barSpread: B.readNight.spread } },
    file, firstMet: readNight, hypothesisNotTested: hypothesis.finding, benchmark: { finding: benchmarkDisclosure.finding, ruling: benchmarkDisclosure.ruling },
    postSeal, dollars: dollars.text,
    recordedOn: today, recordedAt: nowIso, recordedBy: "read-test workflow 2026-10-11 (operator: 'Tests ready to be read'); evidence and scripts in docs/reads/2026-10-11/R44",
  };
  const area = "R44 — sealed read (directional exposure or signal: alpha net of a cell's own net direction)";
  const change = {
    id: "r44-read-sealed-" + today, date: today, recordedAt: now.getTime(), area, category: "read", breaksComparability: false,
    change: `R44: DID NOT PASS — NO CELL CLEARS. Read at the first night any cell met its sample (${fm.day}, snapshot ${fm.commit}): ${rn.map(cellLine).join("; ")}; best-of-${m2} bar ${fm.honestBar}, Benjamini-Hochberg q ${bar.qFDR}, no survivor. No survivor on any of the ${since.nights} nightly outputs from the read night on (largest positive-alpha t ${since.maxPositiveAlphaT}) or tonight (${tonightGraded.map((c) => `${c.cell} t ${c.tAlpha}`).join(", ")}; bar ${m.honestBar}). Dollar table, tickets as the board booked them: ${dollars.text}`,
    why: `Operator 2026-10-11: 'Tests ready to be read'. The adjudicator showed READY TO READ (${m.readableCells} cells at their sample against 1 needed). The read night was found by walking every committed reader output; the verdict is the same on every night and on both benchmarks, so it was sealed with the disclosures.`,
    doesNotEstablish: `That direction explains the board's results: ${hypothesis.finding} Nor that the graded cells are 'exposure': their net exposure is small and their mean R is itself not distinguishable from zero. Nor anything about the exposure loading: ${benchmarkDisclosure.finding}`,
    owed: read.owed,
    operator: "Josh 2026-10-11 (asked for the ready tests to be read); read by the assistant (read-test workflow)",
    files: ["backend/data/exposure-alpha.json", "backend/data/read-seals.json", "backend/data/test-registry.json", "docs/reads/2026-10-11/R44/r44-nightly.json", "docs/reads/2026-10-11/R44/r44-diagnostics.json"],
  };
  const ledger = { ts: nowIso, kind: "READ", agent: "GOVERNANCE", actor: "assistant (read-test workflow, 2026-10-11)", action: "seal-read", test: ID, verdict: "DID NOT PASS", sealedOn: today, readNight: fm.day, n: rn[0].days, unit: `signal-days per graded cell (${m2} cells graded: ${rn.map((c) => `${c.cell} ${c.n} tickets`).join(", ")})`, cellsGraded: m2, largestPositiveAlphaT: Math.max(...rn.filter((c) => c.alpha > 0).map((c) => c.tAlpha), -Infinity), bar: fm.honestBar,
    detail: `DID NOT PASS — NO CELL CLEARS: ${rn.map((c) => `${c.cell} alpha ${sg(c.alpha)}R t ${c.tAlpha}`).join("; ")} on ${rn[0].days} signal-days each at the first-met night ${fm.day}, best-of-${m2} bar ${fm.honestBar}, BH q ${bar.qFDR}; no survivor on any night since or tonight (${tonightGraded.length} cells, largest positive-alpha t ${Math.max(...tonightGraded.filter((c) => c.alpha > 0).map((c) => c.tAlpha))} vs ${m.honestBar}). No cell above 40% net exposure reached its sample (${DC.readable} of ${DC.count}): the registered hypothesis was not put to the test. Reader's equity benchmark is not SPY for the session (correlation ${bm.readerValueAgainstSpySession.correlation}); on SPY session returns the largest positive-alpha t is ${SE.largestPositiveAlphaTOnAnyNight} — same verdict. Nothing proposed; nothing live changes.`,
    changeRegistry: area };
  if (!Number.isFinite(ledger.largestPositiveAlphaT)) ledger.largestPositiveAlphaT = null;
  return { seals, reg, t, read, status, seal, change, ledger, today, readNightDay: fm.day };
}

function main() {
  const fence = inCloseChainWindow(new Date());
  if (fence.blocked) { console.log(`BLOCKED — ${fence.mt} is inside the close chain's window (13:50-15:50 MT on a trading day); nothing written.`); process.exitCode = 4; return; }
  if (!APPLY) {
    const b = build();
    if (b.stop) { console.log(b.stop, JSON.stringify(b.detail, null, 1)); process.exitCode = 5; return; }
    for (const k of ["read", "seal", "change", "ledger"]) JSON.parse(JSON.stringify(b[k]));
    console.log("DRY RUN — nothing written, no lock taken.\nstatus: " + b.status + "\n\nseal.verdict: " + b.seal.verdict + "\n\nseal.unit: " + b.seal.unit + "\n\nread.statistic: " + b.read.statistic + "\n\nread.bar: " + b.read.bar + "\n\nread.unit: " + b.read.unit + "\n\nadoption: " + b.read.adoption + "\n\nhypothesis: " + b.read.hypothesis.finding + "\n\nbenchmark: " + b.read.benchmarkDisclosure.finding + "\n  ruling: " + b.read.benchmarkDisclosure.ruling + "\n\ncontract: " + b.read.contractDisclosure + "\n\ndollars: " + b.read.dollars.text + "\n\nchange: " + JSON.stringify(b.change, null, 1) + "\n\nledger: " + JSON.stringify(b.ledger) + "\n\nsizes: read " + JSON.stringify(b.read).length + " bytes, seal " + JSON.stringify(b.seal).length + " bytes");
    return;
  }
  let haveLock = false; const t0 = Date.now();
  for (;;) {
    try { const fd = fs.openSync(LOCK, "wx"); fs.writeSync(fd, JSON.stringify({ pid: process.pid, who: "read-test " + ID, at: new Date().toISOString() })); fs.closeSync(fd); haveLock = true; break; }
    catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (Date.now() - t0 > 120000) { let holder = "?"; try { holder = fs.readFileSync(LOCK, "utf8"); } catch {} console.log("BLOCKED — registry-write.lock held for more than 120 s by " + holder + "; nothing written."); process.exitCode = 3; return; }
      sleep(2000);
    }
  }
  try {
    const b = build();                                                   // every file re-read INSIDE the lock
    if (b.stop) { console.log(b.stop, JSON.stringify(b.detail, null, 1)); process.exitCode = 5; return; }
    const cr = rj(D("change-registry.json"));
    if (!Array.isArray(cr)) throw new Error("change-registry.json is not an array");
    if (cr.some((x) => x && (x.id === b.change.id || (x.category === "read" && /^R44 /.test(String(x.area)))))) throw new Error("change-registry already holds an R44 read row");
    const ledgerLine = JSON.stringify(b.ledger); JSON.parse(ledgerLine);
    const ledgerBefore = fs.readFileSync(D("agent-ledger.jsonl"), "utf8");
    if (!ledgerBefore.endsWith("\n")) throw new Error("agent-ledger.jsonl does not end with a newline — refusing to append");
    const counts0 = { pre: b.reg.preregistered.length, tests: b.reg.tests.length, seals: Object.keys(b.seals.tests).length, changes: cr.length };
    // 1. the seal (first seal only — checked in build(), inside the lock)
    b.seals.tests[ID] = b.seal; writeJsonAtomic(D("read-seals.json"), b.seals);
    // 2. the registry: the old read-condition string kept word for word, then read + status; nothing else
    if (typeof b.t.read === "string") b.t.readCondition = b.t.read;
    b.t.read = b.read; b.t.status = b.status; b.reg.asOf = b.read.readAt; writeJsonAtomic(D("test-registry.json"), b.reg);
    // 3. the change registry
    cr.push(b.change); writeJsonAtomic(D("change-registry.json"), cr);
    // 4. the governance ledger: one appended line (append-only file; the house sealing scripts append the same way)
    fs.appendFileSync(D("agent-ledger.jsonl"), ledgerLine + "\n");
    // verify
    const s2 = rj(D("read-seals.json")), r2 = rj(D("test-registry.json")), c2 = rj(D("change-registry.json")), l2 = fs.readFileSync(D("agent-ledger.jsonl"), "utf8").trimEnd().split("\n");
    const t2 = r2.preregistered.find((x) => x.id === ID), mineL = l2.filter((l) => l.includes('"kind":"READ"') && l.includes('"test":"R44"'));
    const ok = { seal: !!(s2.tests[ID] && s2.tests[ID].sealedOn === b.today), sealsCount: `${counts0.seals} -> ${Object.keys(s2.tests).length}`, registryRead: !!(t2.read && t2.read.verdict === "DID NOT PASS" && t2.read.date === b.readNightDay), readConditionKept: typeof t2.readCondition === "string", registryStatus: t2.status.startsWith("DID NOT PASS — READ SEALED " + b.today), registryEntries: `${r2.preregistered.length} preregistered / ${r2.tests.length} tests (was ${counts0.pre} / ${counts0.tests})`, changeRows: `${counts0.changes} -> ${c2.length}`, changeRow: c2.some((x) => x.id === b.change.id), ledgerReadLinesForR44: mineL.length, lastLedgerLineParses: (() => { try { JSON.parse(l2[l2.length - 1]); return true; } catch { return false; } })() };
    console.log("SEALED " + ID + " — " + b.seal.verdict + "\n" + JSON.stringify(ok, null, 1));
  } finally {
    if (haveLock) { try { fs.unlinkSync(LOCK); } catch (err) { console.log("WARNING — could not remove the lock: " + err.message); } }
  }
}
main();
