#!/usr/bin/env node
/**
 * SELFTEST — server-backtest-runner, OFFLINE, synthetic bars only (no market data, no network). 2026-10-16.
 *   node docs/server-backtest-runner/2026-10-16/selftest.cjs
 * Covers: the verbatim reuse of r313-ibs-etfs.js (source text compared), a hand-computed known answer (trades, net, monthly mean, NW t), the
 * registered bar's known answer (R313: n 320, seed 313 -> 1.66), a PLANTED-EDGE universe that must PASS, NO-EDGE universes that must NOT pass,
 * costs, the time cap, bar-file refusals, rule refusals, and the CLI end to end in a temp tree (sealed file written once, read-only, verified,
 * tamper detected). The last line says "ALL ... PASSED" only when every case passed.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const H = __dirname, REPO = path.resolve(H, "..", "..", ".."), BT = path.join(H, "staged", "backend", "bt");
const B = require(path.join(BT, "bt-core.cjs")), RUN = require(path.join(BT, "bt-run.cjs"));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail ? " — " + String(detail).slice(0, 500) : "")); } };
const quiet = (s) => String(s).replace(/ALL/g, "all");
const section = (title, fn) => { console.log(title); try { fn(); } catch (e) { ok(`${title}: the section ran to its end`, false, `threw: ${String(e.stack || e).split("\n").slice(0, 3).join(" ")}`); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bt-selftest-"));
// the house null bar as an installed runner would find it: backend/lib/null-bar.js, else the research server's verbatim port (the clean copy has only the port)
const { writeJsonAtomic: writeJsonAtomicT } = require(path.join(H, "aw.cjs")).loadAtomicWrite(REPO);
const NB = B.loadNullBar([path.join(REPO, "backend", "lib", "null-bar.js"), path.join(REPO, "docs", "server", "wave6-agents", "server", "factory", "lib", "nullbar.cjs")]);

// ── synthetic bars ───────────────────────────────────────────────────────────────────────────────────────────────────────
function sessions(from, n) { const out = []; for (let t = Date.parse(from + "T12:00:00Z"); out.length < n; t += 86400000) { const g = new Date(t).getUTCDay(); if (g !== 0 && g !== 6) out.push(new Date(t).toISOString().slice(0, 10)); } return out; }
/** a daily OHLC path; edge > 0 adds that drift to the day AFTER a close with IBS < 0.1 (the planted dip-buy edge); 0 = no edge */
function synth(seed, n, edge = 0, from = "2010-01-04", drift = 0) {
  const rng = B.mulberry(seed), nrm = () => { let u = 0, v = 0; while (u === 0) u = rng(); v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const days = sessions(from, n), bars = []; let c = 100, lastIbs = 0.5;
  for (const t of days) {
    const o = c * (1 + 0.002 * nrm()), r = 0.012 * nrm() + drift + (lastIbs < 0.1 ? edge : 0), cl = c * (1 + r);
    const h = Math.max(o, cl) * (1 + Math.abs(0.005 * nrm())), l = Math.min(o, cl) * (1 - Math.abs(0.005 * nrm()));
    bars.push({ t, o, h, l, c: cl, v: 1000 }); lastIbs = h > l ? (cl - l) / (h - l) : 0.5; c = cl;
  }
  return bars;
}
const writeBars = (dir, sym, bars) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, sym + ".json"), JSON.stringify(bars)); };
const SYMS = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH", "III", "JJJ"];
const baseRule = (o = {}) => ({ schema: "bt-rule-v1", id: "FIXTURE-IBS", family: "ibs-dip", universe: SYMS, params: { entry: { ibsBelow: 0.1 }, exit: { ibsAbove: 0.9 }, maxHoldDays: null },
  window: { from: "2010-01-01", to: "2017-12-31", lastBar: "2017-12-31" }, costs: { roundTrip: 0.0006, stress: 0.0012 }, unit: "month", bar: { tRequired: 1.66, source: "fixture" },
  gates: { minTrades: 100, minMonths: 36 }, controls: { placeboDraws: 100, placeboSeed: 313, floorSeeds: 20, leakSeeds: [1, 2], freeSeeds: 2 }, registration: { id: "RFIX", registeredOn: "2026-10-16" }, ...o });

section("reuse: the R313 functions are r313-ibs-etfs.js's text, verbatim", () => {
  const src313 = fs.readFileSync(path.join(REPO, "backend", "r313-ibs-etfs.js"), "utf8"), mine = fs.readFileSync(path.join(BT, "bt-core.cjs"), "utf8");
  const grab = (src, name) => {
    let i = src.search(new RegExp(`^(function ${name}\\(|const ${name} = )`, "m")); if (i < 0) return null;
    const lineEnd = src.indexOf("\n", i), first = src.slice(i, lineEnd);
    if (!first.trimEnd().endsWith("{")) return first;                       // a one-line definition
    let depth = 0, j = i; for (; j < src.length; j++) { const ch = src[j]; if (ch === "{") depth++; else if (ch === "}") { depth--; if (depth === 0) break; } }
    return src.slice(i, j + 1);
  };
  const names = ["ibsOf", "mkTrade", "simulate", "sma", "rmaSeeded", "rsiWilder", "mean", "nwT", "monthlySeries", "summarise", "strip", "nearestRank", "mulberry", "hash", "scramble", "shiftMonth", "placeboPrepC", "placeboRunC", "pairedDiffs", "floorGate"];
  const diff = names.filter((n) => { const a = grab(src313, n), b = grab(mine, n); return !a || !b || a !== b; });
  ok(`${names.length} functions (the rule, the statistics, the scramble, the corrected placebo, the floor gate) are byte-identical to r313-ibs-etfs.js`, !diff.length, diff.join(", "));
  ok(`the null bar loaded is the house's (${path.relative(REPO, NB.path)}) and gives a number`, typeof NB.nullBar === "function" && Number.isFinite(NB.nullBar({ variants: 1, n: 30, trials: 200, rng: B.mulberry(1) }).p95));
  const code = mine + fs.readFileSync(path.join(BT, "bt-run.cjs"), "utf8");
  ok("NO AI and NO NETWORK in the runner: no http/https/net/dns/tls/child_process module, no fetch(, no model client", !/require\(["'](https?|net|dns|tls|child_process|dgram)["']\)|\bfetch\(|anthropic|openai|XMLHttpRequest|WebSocket/i.test(code));
});

section("known answer — hand-computed", () => {
  // one symbol, 12 sessions from 2020-01-02 (a full year): IBS 0.05 on bar 2 (close 100), 0.5 on bar 3, 0.95 on bar 4 (close 103), entry again
  // on bar 6 (close 50, IBS 0.0) -> exit bar 8 (close 49, IBS 1.0); entry on bar 10 never exits -> OPEN, not counted
  const days = sessions("2020-01-02", 12), mk = (c, ibs) => ({ o: c, h: c + 1, l: c - 1, c: c - 1 + 2 * ibs });
  const spec = [[90, 0.5], [95, 0.5], [100.9, 0.05], [101, 0.5], [102.1, 0.95], [102, 0.5], [51, 0.0], [50, 0.5], [48, 1.0], [48, 0.5], [47.5, 0.02], [47, 0.5]];
  const bars = spec.map(([c, i], k) => ({ t: days[k], ...mk(c, i), v: 10 }));
  const R = baseRule({ universe: ["ONE"], window: { from: "2020-01-01", to: "2020-12-31", lastBar: "2020-12-31" } });
  const P = B.prepRule(bars, R), r = B.simulateRule(P, "ONE", R);
  const tr = r.closed.map((x) => ({ ...x, net: x.gross - 0.0006 }));
  const want = [{ e: days[2], x: days[4], g: 103 / 100 - 1 }, { e: days[6], x: days[8], g: 49 / 50 - 1 }];
  ok("two closed trades at the hand-picked closes (entry 100 -> exit 103, entry 50 -> exit 49), gross exact", tr.length === 2 && tr.every((x, i) => x.entryDate === want[i].e && x.exitDate === want[i].x && Math.abs(x.gross - want[i].g) < 1e-12), JSON.stringify(tr.map((x) => [x.entryDate, x.exitDate, x.entry, x.exit, x.gross])));
  ok("the trade entered on bar 10 never exits: listed OPEN, not counted", r.open.length === 1 && r.open[0].entryDate === days[10]);
  ok("net = gross - 0.06% exactly; both in January 2020: the month's mean is their mean", Math.abs(tr[0].net - 0.0294) < 1e-12 && Math.abs(tr[1].net - (-0.0206)) < 1e-12 && Math.abs(B.summarise(tr).meanNet - 0.0044) < 1e-12 && B.summarise(tr).months === 1);
  ok("Newey-West t, lag 1, on [1%, 2%, -0.5%, 1.5%] = 3.5777 (worked by hand: v = 8.75e-5 - 5.625e-5)", Math.abs(B.nwT([0.01, 0.02, -0.005, 0.015]) - 0.01 / Math.sqrt(3.125e-5 / 4)) < 1e-9 && Math.abs(B.nwT([0.01, 0.02, -0.005, 0.015]) - 3.5777) < 1e-4);
  const Rc = baseRule({ universe: ["ONE"], window: { from: "2020-01-01", to: "2020-12-31", lastBar: "2020-12-31" }, params: { entry: { ibsBelow: 0.1 }, exit: { ibsAbove: 0.99 }, maxHoldDays: 2 } });
  const rc = B.simulateRule(B.prepRule(bars, Rc), "ONE", Rc);
  { const Rw = baseRule({ universe: ["ONE"], window: { from: "2020-01-08", to: "2020-12-31", lastBar: "2020-12-31" }, params: { entry: { ibsBelow: 0.1 }, exit: { ibsAbove: 0.99 }, maxHoldDays: 2 } }), rw = B.simulateRule(B.prepRule(bars, Rw), "ONE", Rw);
    { const Rw2 = baseRule({ universe: ["ONE"], window: { from: "2020-01-01", to: "2020-01-13", lastBar: "2020-01-17" }, params: { entry: { ibsBelow: 0.1 }, exit: { ibsAbove: 0.99 }, maxHoldDays: 5 } }), rw2 = B.simulateRule(B.prepRule(bars, Rw2), "ONE", Rw2);
      ok("the time-capped simulate: no entry after window.to (the 01-16 signal is not taken), and a capped position still open at the last bar is LISTED open", rw2.closed.every((x) => x.entryDate <= "2020-01-13") && !rw2.open.some((x) => x.entryDate === days[10]) && (() => { const R3 = baseRule({ universe: ["ONE"], window: { from: "2020-01-01", to: "2020-12-31", lastBar: "2020-12-31" }, params: { entry: { ibsBelow: 0.1 }, exit: { ibsAbove: 0.99 }, maxHoldDays: 5 } }); const r3 = B.simulateRule(B.prepRule(bars, R3), "ONE", R3); return r3.open.length === 1 && r3.open[0].entryDate === days[10]; })(), JSON.stringify([rw2.closed.map((x) => x.entryDate), rw2.open.map((x) => x.entryDate)])); }
    ok("the time-capped simulate honours the window too: with entries from 2020-01-08, the bar-2 signal (01-06) is not taken", rw.closed.every((x) => x.entryDate >= "2020-01-08") && !rw.closed.some((x) => x.entryDate === days[2]), JSON.stringify(rw.closed.map((x) => x.entryDate))); }
  { // rsi-dip signals from prepRule (checker cycle 3, D2): each condition known-answer on a hand series
    const cs = [10, 10, 10, 10, 10, 10, 9, 8, 7, 8, 9, 10, 11], bs = cs.map((c, k) => ({ t: sessions("2020-01-02", 13)[k], o: c, h: c + 0.5, l: c - 0.5, c, v: 1 }));
    const Rr2 = baseRule({ family: "rsi-dip", universe: ["ONE"], window: { from: "2020-01-01", to: "2020-12-31", lastBar: "2020-12-31" }, params: { entry: { rsiBelow: 10, rsiN: 2, closeBelowSma: 3 }, exit: { closeAboveSma: 3 } } });
    const P2 = B.prepRule(bs, Rr2), rs = B.rsiWilder(cs, 2), s3 = B.sma(cs, 3);
    const wantSig = cs.map((c, k) => Number.isFinite(rs[k]) && rs[k] < 10 && Number.isFinite(s3[k]) && c < s3[k]), wantEx = cs.map((c, k) => Number.isFinite(s3[k]) && c > s3[k]);
    ok("rsi-dip: entry = RSI(2) < 10 AND close < SMA(3), exit = close > SMA(3), day by day; the falling days signal, the rising days exit", JSON.stringify(P2.sig) === JSON.stringify(wantSig) && JSON.stringify(P2.ex) === JSON.stringify(wantEx) && P2.sig[8] === true && P2.ex[10] === true && P2.sig.filter(Boolean).length >= 1);
    const Rt = baseRule({ family: "rsi-dip", universe: ["ONE"], window: { from: "2020-01-01", to: "2020-12-31", lastBar: "2020-12-31" }, params: { entry: { rsiBelow: 10, rsiN: 2, trendSma: 5 }, exit: { closeAboveSma: 3 } } }), Pt = B.prepRule(bs, Rt), s5 = B.sma(cs, 5);
    ok("rsi-dip with a trend filter (close > SMA(5)): no entry on a day below its SMA(5)", Pt.sig.every((v, k) => !v || cs[k] > s5[k]) && Pt.sig.filter(Boolean).length < P2.sig.filter(Boolean).length + 1);
    // checker cycle 4 (D-4): series where each condition DECIDES
    const c2 = [10, 12, 14, 16, 18, 20, 22, 21, 20.9, 20.95, 22, 24, 23], b2 = c2.map((c, k) => ({ t: sessions("2020-01-02", 13)[k], o: c, h: c + 0.5, l: c - 0.5, c, v: 1 }));
    const rsiOnly = baseRule({ family: "rsi-dip", universe: ["ONE"], window: { from: "2020-01-01", to: "2020-12-31", lastBar: "2020-12-31" }, params: { entry: { rsiBelow: 60, rsiN: 2 }, exit: { rsiAbove: 70, rsiN: 2 } } });
    const withSma = baseRule({ family: "rsi-dip", universe: ["ONE"], window: { from: "2020-01-01", to: "2020-12-31", lastBar: "2020-12-31" }, params: { entry: { rsiBelow: 60, rsiN: 2, closeBelowSma: 5 }, exit: { rsiAbove: 70, rsiN: 2 } } });
    const withTrend = baseRule({ family: "rsi-dip", universe: ["ONE"], window: { from: "2020-01-01", to: "2020-12-31", lastBar: "2020-12-31" }, params: { entry: { rsiBelow: 60, rsiN: 2, trendSma: 5 }, exit: { rsiAbove: 70, rsiN: 2 } } });
    const r2 = B.rsiWilder(c2, 2), m5 = B.sma(c2, 5), Pa = B.prepRule(b2, rsiOnly), Pb = B.prepRule(b2, withSma), Pc = B.prepRule(b2, withTrend);
    const dRsi = c2.map((c, k) => Number.isFinite(r2[k]) && r2[k] < 60), dSma = dRsi.map((v, k) => v && Number.isFinite(m5[k]) && c2[k] < m5[k]), dTr = dRsi.map((v, k) => v && Number.isFinite(m5[k]) && c2[k] > m5[k]);
    ok("closeBelowSma DECIDES on a pullback in an up-trend: RSI(2) < 60 alone signals on days the close is still above SMA(5); with closeBelowSma those days drop out", JSON.stringify(Pa.sig) === JSON.stringify(dRsi) && JSON.stringify(Pb.sig) === JSON.stringify(dSma) && dRsi.filter(Boolean).length > dSma.filter(Boolean).length);
    ok("the trend filter lets an entry THROUGH (close > SMA(5) on an RSI dip in an up-trend), and the rsiAbove exit fires where RSI(2) > 70", JSON.stringify(Pc.sig) === JSON.stringify(dTr) && dTr.some(Boolean) && JSON.stringify(Pa.ex) === JSON.stringify(c2.map((c, k) => Number.isFinite(r2[k]) && r2[k] > 70)) && Pa.ex.some(Boolean)); }
  ok("the time cap (maxHoldDays 2, exit IBS > 0.99): the first trade closes at bar 4 by the cap, the second at bar 8 by its exit (IBS 1.0)", rc.closed.length === 2 && rc.closed[0].exitDate === days[4] && rc.closed[0].capped === true && rc.closed[1].exitDate === days[8] && !rc.closed[1].capped, JSON.stringify(rc.closed.map((x) => [x.entryDate, x.exitDate, x.capped])));
  const Rr = baseRule({ family: "rsi-dip", universe: ["ONE"], params: { entry: { rsiBelow: 10, rsiN: 2 }, exit: { closeAboveSma: 5 } } });
  ok("rsi-dip signals come from R313's rsiWilder: RSI(2) on a falling-then-rising series is < 10 at the bottom", (() => { const c = [10, 9, 8, 7, 6, 7, 8]; const rs = B.rsiWilder(c, 2); return rs[4] < 10 && rs[6] > 50 && B.checkRule(Rr) === Rr; })());
});

section("the bar — R313's known answer", () => {
  const b = B.barFor(320, { variants: 1, seed: 313, NB });
  ok(`barFor(n 320, 1 variant, seed 313): the NW-on-noise part is R313's registered 1.66 exactly (${b.nwSim})`, b.nwSim === 1.66, JSON.stringify(b));
  // the null-bar part (checker cycle 1, D1): R313's registry value 1.658 came from an UNSEEDED nullBar call at registration (register-r310.js
  // calls nullBar with no rng: Math.random); over 40 seeds the port's p95 at n 320 spans 1.608..1.674 (seed 313: 1.666). So 1.658 is not a
  // seeded known answer and is not asserted. What IS asserted: the bar is max(NW part, null-bar part), and — at home, where both exist —
  // the house backend/lib/null-bar.js and the server's port give the SAME value for the same seeded call.
  ok("barFor's bar is max(its NW part, its null-bar part), rounded to 3 places", b.bar === Math.max(b.nwSim, b.iid));
  const housePath = path.join(REPO, "backend", "lib", "null-bar.js"), portPath = path.join(REPO, "docs", "server", "wave6-agents", "server", "factory", "lib", "nullbar.cjs");
  if (fs.existsSync(housePath)) { const hb = B.barFor(320, { variants: 1, seed: 313, trialsNw: 10, NB: B.loadNullBar([housePath]) }), pb = B.barFor(320, { variants: 1, seed: 313, trialsNw: 10, NB: B.loadNullBar([portPath]) }); ok(`the house null-bar.js and the server's port agree for the same seeded call (${hb.iid} / ${pb.iid})`, hb.iid === pb.iid); }
  else { console.log(`  NOTE (not counted) backend/lib/null-bar.js is not in this copy: the house-vs-port equality is checked at home (the port gives ${b.iid} for n 320, seed 313)`); ok("the port's null bar is deterministic for the same call (seeded)", B.barFor(320, { variants: 1, seed: 313, NB, trialsNw: 10 }).iid === b.iid); }
  const b5 = B.barFor(120, { variants: 5, seed: 7, trialsNw: 3000, trialsIid: 3000, NB }), b1 = B.barFor(120, { variants: 1, seed: 7, trialsNw: 3000, trialsIid: 3000, NB });
  ok(`best of 5 variants raises the bar (${b5.bar} > ${b1.bar}), and the same inputs give the same bar (seeded)`, b5.bar > b1.bar && B.barFor(120, { variants: 5, seed: 7, trialsNw: 3000, trialsIid: 3000, NB }).bar === b5.bar);
});

const N = 8 * 261;
/** a calibration seed's verdict, recomputed from its recorded gate inputs */
const recompute = (x, run) => B.decideRule({ ...x, leakPass: true, positivePass: true, bar: run.bar.tRequired, minTrades: 100, minMonths: 36 }).verdict;
const badRule = (o, re) => { try { B.checkRule(baseRule(o)); return false; } catch (e) { return re.test(e.message); } };
section("PLANTED EDGE — must PASS", () => {
  const dir = path.join(TMP, "edge"); SYMS.forEach((s, i) => writeBars(dir, s, synth(1000 + i, N, 0.008)));
  const r = RUN.run(baseRule(), dir, { NB });
  ok(`a +0.8% bounce after IBS < 0.1 on 10 symbols x 8 years: PASS (${r.stats.trades} trades, ${r.stats.months} months, t ${r.stats.tNet}, placebo paired t ${r.placebo.pairedT}, floor clears ${r.floor.gate.clears})`, r.verdict === "PASS" && r.failed.length === 0, `${r.verdict} failed ${r.failed.join(",")} t ${r.stats.tNet} pl ${r.placebo.pairedT}`);
  ok("its controls: leak test t < 2 on both drift-free shuffles; positive control t >= 3; 2x cost still > 0", r.leakTest.every((x) => x.pass) && r.positiveControl.pass && r.stats.stress.meanNet > 0, JSON.stringify([r.leakTest, r.positiveControl]));
  const r2 = RUN.run(baseRule({ costs: { roundTrip: 0.0016, stress: 0.0032 } }), dir, { NB });
  ok("costs: +0.10% round trip lowers every trade's net by exactly 0.001 and the monthly mean by exactly 0.001", r2.trades.length === r.trades.length && r2.trades.every((x, i) => Math.abs((r.trades[i].net - x.net) - 0.001) < 1e-12) && Math.abs((r.stats.meanNet - r2.stats.meanNet) - 0.001) < 1e-12);
  // checker cycle 3 (D1): "at most 1 of 20" is the structural ceiling, so it cannot fail — what CAN fail: every drift-kept seed the calibration
  // calls PASS really clears the t gate and its OWN placebo t gate, and the ceiling is reported in the sealed file
  ok("the calibration (R313) on the planted edge: calibrated, the floor complete (20 seeds); every per-seed PASS clears t and its OWN placebo t (>= the bar); the 5% ceiling at 20 seeds is reported (cannot hold)", r.calibration.calibrated === true && r.floor.seeds === 20 && r.calibration.perSeed.filter((x) => x.verdict === "PASS").every((x) => x.tNW >= 1.66 && x.placeboPairedT >= 1.66) && r.calibration.ceiling.maxPossiblePasses === 1 && r.calibration.ceiling.canHold === false, JSON.stringify(r.calibration.perSeed.filter((x) => x.verdict === "PASS")));
  ok("calibrationCeiling (leave-one-out floor, nearest-rank p95): 10 -> 1, 20 -> 1, 21 -> 2, 40 -> 2, 60 -> 3 — exactly 5% at 20 / 40 / 60 seeds", [10, 20, 21, 40, 60].map(B.calibrationCeiling).join() === "1,1,2,2,3");
  ok("the drift-FREE arm (R313's, reported, decides nothing): seeds 1..freeSeeds, DEMEANED scrambles — its seed 1 mean differs from the drift-kept seed 1 mean", JSON.stringify(r.calibration.driftFreeArm.perSeed.map((x) => x.seed)) === "[1,2]" && r.calibration.driftFreeArm.perSeed[0].meanNet !== B.r4(r.calibration.perSeed[0].meanNet) && r.calibration.driftFreeArm.perSeed.every((x) => typeof x.verdict === "string"));
  // checker cycle 4 (D-5): each per-seed verdict recomputed from its recorded gate inputs — pins every gate of the calibration on its own
  ok("every per-seed calibration verdict (planted edge) equals decideRule over that seed's recorded inputs (t, own placebo t, floor gates, halves, 2x cost)", r.calibration.perSeed.every((x) => x.verdict === recompute(x, r)) && r.calibration.perSeed.length === 20);
  ok("the runner's gap check: every symbol's largest gap is in the sealed file (here at most 4 days)", Object.values(r.data.files).every((f) => Number.isFinite(f.maxGapDays) && f.maxGapDays <= 4));
  ok("the positive control is the WINNERS only: its trade count is the number of trades with net > 0", r.positiveControl.trades === r.trades.filter((x) => x.net > 0).length);
  ok("the data set's sha256 covers every file's sha256 (recomputed here)", r.data.setSha256 === require("crypto").createHash("sha256").update(Object.keys(r.data.files).sort().map((k) => `${r.data.files[k].sha256}  ${k}`).join("\n") + "\n").digest("hex"));
  ok("open trades are listed, never counted: stats.trades equals the closed trades, none of which lacks an exit", r.stats.trades === r.trades.length && r.trades.every((x) => x.exitDate) && Array.isArray(r.open));
  ok("the 2x-cost mean is exactly the mean less (stress - roundTrip)", Math.abs(r.stats.stress.meanNet - (r.stats.meanNet - 0.0006)) < 1e-12);
  const rb = RUN.run(baseRule({ bar: { tRequired: 99, source: "fixture" } }), dir, { NB });
  ok("a registered rule's bar is used AS GIVEN (99, never recomputed): the same edge then DID NOT PASS on the t gate (and the timing gates)", rb.bar.tRequired === 99 && rb.bar.computed === false && rb.verdict === "DID NOT PASS" && rb.failed.includes("tAtLeastBar"), JSON.stringify([rb.bar, rb.failed]));
  const rw2 = RUN.run(baseRule({ window: { from: "2012-01-01", to: "2017-12-31", lastBar: "2017-12-31" } }), dir, { NB });
  ok("window.from moves the first entry (no entry before 2012-01-01; fewer trades than from 2010)", rw2.trades.every((x) => x.entryDate >= "2012-01-01") && rw2.trades.length < r.trades.length && Object.values(rw2.perSymbol).every((p) => p.entryFrom === "2012-01-01"));
  const rc2 = RUN.run(baseRule({ costs: { roundTrip: 0.0016, stress: 0.0032 } }), dir, { NB });
  ok("the placebo trades carry the same cost: +0.10% round trip shifts the placebo's median by exactly 0.10%/month", Math.abs((r.placebo.p50PctPerMonth - rc2.placebo.p50PctPerMonth) - 0.1) < 0.0002, `${r.placebo.p50PctPerMonth} ${rc2.placebo.p50PctPerMonth}`);
  const r3 = RUN.run(baseRule(), dir, { NB });
  ok("deterministic: the same rule over the same bars gives the same trades, statistics and placebo", JSON.stringify(r3.stats) === JSON.stringify(r.stats) && JSON.stringify(r3.placebo) === JSON.stringify(r.placebo) && r3.data.setSha256 === r.data.setSha256);
});

section("NO EDGE — must NOT pass", () => {
  const verdicts = [];
  for (const seed of [11, 22, 33]) {
    const dir = path.join(TMP, "noedge-" + seed); SYMS.forEach((s, i) => writeBars(dir, s, synth(seed * 100 + i, N, 0)));
    const r = RUN.run(baseRule(), dir, { NB }); verdicts.push(`${r.verdict} (t ${r.stats.tNet}, placebo t ${r.placebo.pairedT})`);
  }
  console.log("  info " + verdicts.join(" | "));
  ok(`three no-edge universes (random walks, same shape): none passes — ${verdicts.join(" | ")}`, verdicts.every((v) => !/^PASS/.test(v)));
  // DRIFT-KEPT no edge (checker cycle 1): a steady up-drift makes the dip-buy's mean and t large, but its TIMING adds nothing — the
  // placebo and the drift-kept floor must say so
  const dk = path.join(TMP, "drift"); SYMS.forEach((s, i) => writeBars(dk, s, synth(700 + i, N, 0, "2010-01-04", 0.0012)));
  const rd = RUN.run(baseRule(), dk, { NB });
  ok(`a drift-kept no-edge universe (+0.12%/day drift, no bounce): t ${rd.stats.tNet} clears the bar, mean > 0 — yet NOT PASS: the placebo gate and the drift-kept floor fail (${rd.failed.join(", ")})`, rd.stats.tNetRaw >= 1.66 && rd.stats.meanNet > 0 && rd.verdict === "DID NOT PASS" && rd.failed.includes("correctedPlaceboPairedTAtLeastBar") && (rd.failed.includes("floorMeanAboveP95") || rd.failed.includes("floorTVsP50AtLeastBar")), JSON.stringify([rd.verdict, rd.failed, rd.stats.tNet, rd.placebo.pairedT]));
  // the calibration HOLDS a read: with a bar no scramble can miss (-100) and a 0% limit, drift-kept scrambles "pass" -> HELD, not PASS
  const rh = RUN.run(baseRule({ bar: { tRequired: -100, source: "fixture: a bar nothing misses" }, controls: { placeboDraws: 100, placeboSeed: 313, floorSeeds: 20, leakSeeds: [1, 2], maxWholeRuleFalsePass: 0 } }), dk, { NB });
  ok(`the calibration holds a read: drift-kept scrambles pass a bar of -100 (${rh.calibration.passes} of ${rh.calibration.driftKeptSeeds}, limit 0%) -> HELD, its rule verdict kept beside it`, rh.calibration.calibrated === false && rh.calibration.passes > 0 && /^HELD — /.test(rh.verdict) && typeof rh.ruleVerdict === "string", JSON.stringify([rh.verdict, rh.calibration]));
  // at 21 seeds the ceiling is 2 of 21 (9.5%): the calibration CAN hold — with a bar nothing misses, it does, at R313's default 5%
  const r21 = RUN.run(baseRule({ bar: { tRequired: -100, source: "fixture" }, controls: { placeboDraws: 50, placeboSeed: 313, floorSeeds: 21, leakSeeds: [1, 2], freeSeeds: 2 } }), dk, { NB });
  ok(`at 21 drift-kept seeds (ceiling 2 of 21) the DEFAULT 5% limit holds a read: ${r21.calibration.passes} of 21 pass a bar of -100 -> HELD`, r21.calibration.ceiling.canHold === true && r21.calibration.passes === 2 && /^HELD — /.test(r21.verdict), JSON.stringify([r21.verdict, r21.calibration.ceiling]));
  ok("leakPasses / positivePasses at t = 2.5 (between the two thresholds): the leak test FAILS (not < 2), the positive control FAILS (not >= 3); null fails both", B.leakPasses(2.5) === false && B.positivePasses(2.5) === false && B.leakPasses(1.99) && B.positivePasses(3) && !B.leakPasses(null) && !B.positivePasses(null));
  // the leak test on a scramble whose t cannot be measured (fewer than 3 months): it FAILS -> CANNOT MEASURE
  const rn = RUN.run(baseRule({ universe: ["AAA", "BBB"], window: { from: "2010-01-01", to: "2010-02-26", lastBar: "2010-02-26" }, gates: { minTrades: 1, minMonths: 3 } }), path.join(TMP, "edge"), { NB });
  ok("a leak scramble with no measurable t (2 months): the leak test FAILS and the verdict is CANNOT MEASURE", rn.leakTest.some((l) => l.tNW == null) && rn.leakTest.filter((l) => l.tNW == null).every((l) => l.pass === false) && /^CANNOT MEASURE/.test(rn.verdict) && rn.failed.includes("leakTestPassed"), JSON.stringify([rn.leakTest, rn.verdict]));
  ok("... and its positive control (no measurable t either) is wired into the verdict: positiveControlPassed is among the failed gates and the verdict names it", rn.positiveControl.pass === false && rn.failed.includes("positiveControlPassed") && /positive control failed/.test(rn.verdict));
  ok("gate boundaries: exactly minTrades trades and exactly minMonths months PASS those gates", (() => { const v = B.decideRule({ trades: 100, months: 36, meanNet: 0.01, tNW: 5, halfFirst: 0.01, halfSecond: 0.01, meanNet2x: 0.005, placeboPairedT: 4, floorMeanAboveP95: true, floorTVsP50AtLeastBar: true, leakPass: true, positivePass: true, bar: 1.66, minTrades: 100, minMonths: 36 }); return v.verdict === "PASS"; })());
  // checker cycle 2: the calibration needs EVERY scramble judged — one symbol has no placebo (no other symbol's holds), so it CANNOT be measured
  const r1s = RUN.run(baseRule({ universe: ["AAA"], gates: { minTrades: 1, minMonths: 3 } }), path.join(TMP, "edge"), { NB });
  ok("a universe whose scrambles give no measurable placebo t (one symbol): CANNOT MEASURE (the calibration is incomplete), never 'calibrated with 0 passes'", /^CANNOT MEASURE — of 20 drift-kept scrambles/.test(r1s.verdict) && r1s.calibration.calibrated === false, r1s.verdict);
  ok("... and its placebo percentiles are null, not 0", r1s.placebo.p50PctPerMonth === null && r1s.placebo.p95PctPerMonth === null, JSON.stringify(r1s.placebo));
  ok("the calibration limit defaults to R313's 0.05, and a rule may not loosen it (0.2 refused; 0.01 accepted)", rd.calibration.limit === 0.05 && (() => { try { B.checkRule(baseRule({ controls: { placeboDraws: 100, placeboSeed: 313, floorSeeds: 20, leakSeeds: [1, 2], maxWholeRuleFalsePass: 0.2 } })); return false; } catch (e) { return /never looser/.test(e.message); } })() && !!B.checkRule(baseRule({ controls: { placeboDraws: 100, placeboSeed: 313, floorSeeds: 20, leakSeeds: [1, 2], maxWholeRuleFalsePass: 0.01 } })));
  ok("on the drift-kept universe, every per-seed PASS clears its OWN placebo t and floor t at the bar (a calibration that skipped those gates would pass the top seed)", rd.calibration.perSeed.length === 20 && rd.calibration.perSeed.filter((x) => x.verdict === "PASS").every((x) => x.placeboPairedT >= 1.66) && rd.calibration.passes === rd.calibration.perSeed.filter((x) => x.verdict === "PASS").length, JSON.stringify(rd.calibration.perSeed.map((x) => [x.verdict, x.placeboPairedT])));
  ok("every per-seed calibration verdict (drift-kept universe) equals decideRule over that seed's recorded inputs", rd.calibration.perSeed.every((x) => x.verdict === recompute(x, rd)));
  ok("each drift-kept scramble is judged with its OWN placebo: 20 per-seed placebo t's, all finite and no-edge-sized (|t| < 4)", rd.calibration.perSeed.length === 20 && rd.calibration.perSeed.every((x) => Number.isFinite(x.placeboPairedT) && Math.abs(x.placeboPairedT) < 4) && new Set(rd.calibration.perSeed.map((x) => x.placeboPairedT)).size > 1, JSON.stringify(rd.calibration.perSeed.map((x) => x.placeboPairedT)));
  ok("R313's control thresholds: leak t < 2, positive control t >= 3 — the runner's verdicts follow them", B.LEAK_T_MAX === 2 && B.POSITIVE_T_MIN === 3 && [rd, rn].every((x) => x.leakTest.every((l) => l.pass === (l.tNW != null && l.tNW < 2)) && x.positiveControl.pass === (x.positiveControl.tNW != null && x.positiveControl.tNW >= 3)));
  // decideRule gate by gate: with everything else passing, each gate alone turns PASS into DID NOT PASS (or CANNOT MEASURE for its own conditions)
  const good = { trades: 500, months: 100, meanNet: 0.01, tNW: 5, halfFirst: 0.01, halfSecond: 0.01, meanNet2x: 0.005, placeboPairedT: 4, floorMeanAboveP95: true, floorTVsP50AtLeastBar: true, leakPass: true, positivePass: true, bar: 1.66, minTrades: 100, minMonths: 36 };
  const flips = { tradesAtLeastMin: { trades: 50 }, monthsAtLeastMin: { months: 20 }, meanNetPositive: { meanNet: -0.001 }, tAtLeastBar: { tNW: 1.5 }, correctedPlaceboPairedTAtLeastBar: { placeboPairedT: 1.65 }, floorMeanAboveP95: { floorMeanAboveP95: false }, floorTVsP50AtLeastBar: { floorTVsP50AtLeastBar: false }, bothHalvesPositive: { halfSecond: -0.001 }, cost2xMeanPositive: { meanNet2x: -0.0001 }, leakTestPassed: { leakPass: false }, positiveControlPassed: { positivePass: false } };
  const cm = ["tradesAtLeastMin", "monthsAtLeastMin", "leakTestPassed", "positiveControlPassed"];
  ok("decideRule: all gates true -> PASS; each of the 11 gates false alone -> DID NOT PASS naming it (CANNOT MEASURE for trades, months, leak test, positive control)", B.decideRule(good).verdict === "PASS" && Object.entries(flips).every(([g, o]) => { const v = B.decideRule({ ...good, ...o }); return v.failed.join() === g && (cm.includes(g) ? /^CANNOT MEASURE/.test(v.verdict) : v.verdict === "DID NOT PASS"); }));
  ok("the positive control's verdict is its own t >= 3; the leak test's is t < 2 with an unmeasured (null) t FAILING (R313)", [rd].every((x) => x.positiveControl.pass === (x.positiveControl.tNW != null && x.positiveControl.tNW >= 3) && x.leakTest.every((l) => l.pass === (l.tNW != null && l.tNW < 2))));
  // the runner passes window.lastBar and window.to on to the bar loader
  const rl = RUN.run(baseRule({ window: { from: "2010-01-01", to: "2016-12-30", lastBar: "2016-12-30" } }), path.join(TMP, "edge"), { NB });
  ok("the runner applies window.lastBar: every symbol's bars after it are dropped and counted; no trade or mark after it", Object.values(rl.data.files).every((f) => f.afterLastBarDropped > 200 && f.last <= "2016-12-30") && rl.trades.every((x) => x.exitDate <= "2016-12-30") && rl.open.every((x) => x.markDate <= "2016-12-30"));
  let ec = null; try { RUN.run(baseRule({ window: { from: "2010-01-01", to: "2019-12-31", lastBar: "2019-12-31" } }), path.join(TMP, "edge"), { NB }); } catch (x) { ec = x.message; }
  ok("the runner applies coverage: a window running past the files' end is REFUSED", /coverage/.test(ec || ""), ec);
  let eL = null; try { RUN.run(baseRule({ window: { from: "2010-01-01", to: "2017-12-31" } }), path.join(TMP, "edge"), { NB }); } catch (x) { eL = x.message; }
  ok("a REGISTERED rule without window.lastBar: REFUSED (a read must not depend on when the bars were fetched)", /window\.lastBar/.test(eL || ""), eL);
  // a planted edge too weak to clear the bar does not pass either
  const dir = path.join(TMP, "weak"); SYMS.slice(0, 3).forEach((s, i) => writeBars(dir, s, synth(500 + i, 3 * 261, 0.0005)));
  const rw = RUN.run(baseRule({ universe: SYMS.slice(0, 3), window: { from: "2010-01-01", to: "2012-12-31", lastBar: "2012-12-31" } }), dir, { NB });
  ok(`a tiny edge on 3 symbols x 3 years: not PASS (${rw.verdict})`, !/^PASS/.test(rw.verdict));
  const rf = RUN.run(baseRule({ universe: ["AAA"], window: { from: "2010-01-01", to: "2010-06-30", lastBar: "2010-06-30" } }), path.join(TMP, "edge"), { NB });
  ok(`too few trades / months: CANNOT MEASURE (${rf.verdict}); a leak scramble with no measurable t FAILS it`, /^CANNOT MEASURE — \d+ trades < 100; \d+ months < 36/.test(rf.verdict) && rf.leakTest.every((l) => l.tNW != null || l.pass === false));
});

section("refusals — bars and rules", () => {
  const dir = path.join(TMP, "bad"), good = synth(9, 300);
  const refuse = (sym, bars, re) => { writeBars(dir, sym, bars); let e = null; try { B.loadBars(dir, sym); } catch (x) { e = x.message; } return re.test(e || ""); };
  ok("a missing bar file: REFUSED", (() => { try { B.loadBars(dir, "NOPE"); return false; } catch (e) { return /no bar file/.test(e.message); } })());
  ok("high < low, a price <= 0 or NaN, a duplicate date, dates out of order, a malformed date: each REFUSED", refuse("HL", good.map((b, i) => (i === 50 ? { ...b, h: b.l - 1 } : b)), /high .* < low/) && refuse("NEG", good.map((b, i) => (i === 7 ? { ...b, c: -1 } : b)), /finite number > 0/) && refuse("NAN", good.map((b, i) => (i === 7 ? { ...b, o: "x" } : b)), /finite number > 0/) && refuse("DUP", [...good.slice(0, 10), good[9], ...good.slice(10)], /strictly increase/) && refuse("ORD", [good[1], good[0], ...good.slice(2)], /strictly increase/) && refuse("BADD", good.map((b, i) => (i === 3 ? { ...b, t: "2010-13-45" } : b)), /bad date/));
  ok("an open ABOVE high, a close BELOW low, a price of exactly 0: each REFUSED", refuse("OHI", good.map((b, i) => (i === 9 ? { ...b, o: b.h * 1.01 } : b)), /outside \[low, high\]/) && refuse("CLO", good.map((b, i) => (i === 9 ? { ...b, c: b.l * 0.99 } : b)), /outside \[low, high\]/) && refuse("ZERO", good.map((b, i) => (i === 9 ? { ...b, l: 0 } : b)), /finite number > 0/));
  // the runner's gap wiring (checker cycle 4, D-1, D-2)
  const gd = path.join(TMP, "gapuni"); SYMS.slice(0, 3).forEach((sy, i) => { const b = synth(900 + i, N, 0.008); writeBars(gd, sy, i === 1 ? [...b.slice(0, 1000), ...b.slice(1030)] : b); });
  let eg = null; try { RUN.run(baseRule({ universe: SYMS.slice(0, 3) }), gd, { NB }); } catch (x) { eg = x.message; }
  ok("the RUNNER refuses a symbol missing a month inside the window (default maxGapDays 14)", /BBB: a gap of \d+ calendar days/.test(eg || ""), eg);
  const gp = path.join(TMP, "gappre"); SYMS.slice(0, 3).forEach((sy, i) => { const b = synth(900 + i, N, 0.008); writeBars(gp, sy, i === 1 ? [...b.slice(0, 100), ...b.slice(130)] : b); });
  const rgp = RUN.run(baseRule({ universe: SYMS.slice(0, 3), window: { from: "2012-01-01", to: "2017-12-31", lastBar: "2017-12-31" } }), gp, { NB });
  ok("a hole in 2010, more than a year before window.from 2012-01-01, does NOT refuse the symbol (gaps are measured from a year before the window)", typeof rgp.verdict === "string" && rgp.data.files.BBB.maxGapDays <= 4);
  ok("rule bounds, exactly: lastBar = to + 10 days accepted, to + 11 refused; maxGapDays 4 accepted, 3 refused; window.to 2017-02-30 refused", !!B.checkRule(baseRule({ window: { from: "2010-01-01", to: "2017-12-31", lastBar: "2018-01-10" } })) && badRule({ window: { from: "2010-01-01", to: "2017-12-31", lastBar: "2018-01-11" } }, /lastBar/) && !!B.checkRule(baseRule({ window: { from: "2010-01-01", to: "2017-12-31", lastBar: "2017-12-31", maxGapDays: 4 } })) && badRule({ window: { from: "2010-01-01", to: "2017-12-31", lastBar: "2017-12-31", maxGapDays: 3 } }, /maxGapDays/) && badRule({ window: { from: "2010-01-01", to: "2017-02-30", lastBar: "2017-03-01" } }, /window: from < to/));
  ok("a gap in the data (a month missing) is REFUSED above window.maxGapDays and reported otherwise", refuse("GAP", [...good.slice(0, 100), ...good.slice(130)], /calendar days after/) === false && (() => { writeBars(dir, "GAP2", [...good.slice(0, 100), ...good.slice(130)]); try { B.loadBars(dir, "GAP2", { maxGapDays: 14 }); return false; } catch (e) { return /a gap of \d+ calendar days/.test(e.message); } })() && B.loadBars(dir, "GAP2").maxGapDays > 30);
  ok("an open or close outside [low, high], and an impossible date (2010-02-30): each REFUSED", refuse("OUT", good.map((b, i) => (i === 9 ? { ...b, c: b.h * 1.01 } : b)), /outside \[low, high\]/) && refuse("OPN", good.map((b, i) => (i === 9 ? { ...b, o: b.l * 0.99 } : b)), /outside \[low, high\]/) && refuse("FEB", good.map((b, i) => (i === 3 ? { ...b, t: "2010-02-30" } : b)), /bad date/));
  writeBars(dir, "LAST", good);
  ok("window.lastBar (the forming-bar guard): bars after it are dropped and counted; a file that ends before the window's end is REFUSED (coverage)", (() => { const L = B.loadBars(dir, "LAST", { lastBar: good[200].t }); return L.bars.length === 201 && L.afterLastDropped === 99; })() && (() => { try { B.loadBars(dir, "LAST", { coverTo: "2015-12-31" }); return false; } catch (e) { return /coverage/.test(e.message); } })());
  ok("coverage allows 7 days (a holiday week), not 8: a file ending 7 days before the window's end loads, 8 days is REFUSED", (() => { const last = good[good.length - 1].t, plus = (k) => new Date(Date.parse(last + "T00:00:00Z") + k * 86400000).toISOString().slice(0, 10); B.loadBars(dir, "LAST", { coverTo: plus(7) }); try { B.loadBars(dir, "LAST", { coverTo: plus(8) }); return false; } catch (e) { return /coverage/.test(e.message); } })());
  ok("entries start Jan 1 of the first FULL year: data from 2010-01-04 -> 2010-01-01; from 2010-01-05 -> 2011-01-01; never before window.from", B.entryFromOf("2010-01-04", "2000-01-01") === "2010-01-01" && B.entryFromOf("2010-01-05", "2000-01-01") === "2011-01-01" && B.entryFromOf("2010-01-04", "2012-01-01") === "2012-01-01");
  writeBars(dir, "WKD", [...good.slice(0, 5), { ...good[5], t: "2010-01-09" }, ...good.slice(6)].filter((b, i) => i !== 6 || true));
  ok("a weekend row is dropped and counted (as R313 did), not traded", (() => { const L = B.loadBars(dir, "WKD"); return L.weekendDropped === 1 && !L.bars.some((b) => b.t === "2010-01-09"); })());
  fs.writeFileSync(path.join(dir, "CSV.csv"), "Date,Open,High,Low,Close,Volume\n" + good.slice(0, 20).map((b) => [b.t, b.o, b.h, b.l, b.c, b.v].join(",")).join("\n") + "\n");
  ok("a CSV bar file reads the same bars as JSON", (() => { const L = B.loadBars(dir, "CSV"); return L.bars.length === 20 && Math.abs(L.bars[5].c - good[5].c) < 1e-9; })());
  const bad = (o, re) => { try { B.checkRule(baseRule(o)); return false; } catch (e) { return re.test(e.message); } };
  ok("rule bounds: floorSeeds 4, window.lastBar before window.to or more than 10 days after it (9999-12-31), roundTrip 0.05, minMonths 2: each REFUSED", bad({ controls: { placeboDraws: 100, placeboSeed: 313, floorSeeds: 4, leakSeeds: [1] } }, /floorSeeds/) && bad({ window: { from: "2010-01-01", to: "2017-12-31", lastBar: "2017-12-01" } }, /lastBar/) && bad({ window: { from: "2010-01-01", to: "2017-12-31", lastBar: "9999-12-31" } }, /lastBar/) && bad({ costs: { roundTrip: 0.05, stress: 0.1 } }, /roundTrip/) && bad({ gates: { minTrades: 100, minMonths: 2 } }, /minMonths/));
  ok("canon drops undefined keys (as JSON does): the seal is over what the file holds", RUN.canon({ b: 1, a: undefined, c: [1, { d: undefined, e: 2 }] }) === '{"b":1,"c":[1,{"e":2}]}');
  ok("rule refusals: wrong schema, unknown family, empty universe, a unit other than month, a missing bar, no exit, costs.stress < roundTrip", bad({ schema: "x" }, /schema/) && bad({ family: "momentum" }, /family/) && bad({ universe: [] }, /universe/) && bad({ unit: "week" }, /unit must be "month"/) && bad({ bar: {} }, /bar:/) && bad({ params: { entry: { ibsBelow: 0.1 }, exit: {} } }, /params\.exit/) && bad({ costs: { roundTrip: 0.002, stress: 0.001 } }, /stress/));
  let e1 = null; try { RUN.run(baseRule({ registration: undefined }), path.join(TMP, "edge"), { NB }); } catch (x) { e1 = x.message; }
  ok("a rule with no registration: REFUSED unless --exploratory", /--exploratory/.test(e1 || ""), e1);
  const rx = RUN.run(baseRule({ registration: undefined, bar: { variants: 1, trialsNw: 2000, trialsIid: 2000 } }), path.join(TMP, "edge"), { exploratory: true, NB });
  ok("--exploratory: runs, the bar is COMPUTED (best of 1), and the verdict and label say EXPLORATORY", rx.mode === "exploratory" && /^EXPLORATORY: /.test(rx.verdict) && /never a read/.test(rx.label) && rx.bar.computed === true && rx.bar.n === rx.stats.months, `${rx.verdict} ${JSON.stringify(rx.bar).slice(0, 200)}`);
  let er = null; try { RUN.run(baseRule({ registration: undefined, reservedForRegistration: true }), path.join(TMP, "edge"), { exploratory: true, NB }); } catch (x) { er = x.message; }
  ok("a rule RESERVED FOR REGISTRATION: an exploratory run is REFUSED (its bars are not read before it is registered)", /RESERVED FOR REGISTRATION/.test(er || ""), er);
  let e2 = null; try { RUN.run(baseRule({ bar: { variants: 1 } }), path.join(TMP, "edge"), { NB }); } catch (x) { e2 = x.message; }
  ok("a registered rule without its registered bar.tRequired: REFUSED (a registered bar is never recomputed)", /registered bar\.tRequired/.test(e2 || ""), e2);
});

section("the CLI end to end (temp tree: sealed once, read-only, verified, tamper detected)", () => {
  const T = path.join(TMP, "tree"), TB = path.join(T, "backend");
  fs.mkdirSync(path.join(TB, "bt"), { recursive: true }); fs.mkdirSync(path.join(TB, "lib")); fs.mkdirSync(path.join(T, "factory", "lib"), { recursive: true });
  for (const f of ["bt-core.cjs", "bt-run.cjs"]) fs.copyFileSync(path.join(BT, f), path.join(TB, "bt", f));
  fs.copyFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"), path.join(TB, "lib", "atomic-write.js"));
  fs.writeFileSync(path.join(TB, "package.json"), '{"type":"commonjs"}');   // stands in for home's backend/package.json (absent from the clean copy)
  fs.copyFileSync(path.join(REPO, "docs", "server", "wave6-agents", "server", "factory", "lib", "nullbar.cjs"), path.join(T, "factory", "lib", "nullbar.cjs"));   // the PORT (self-contained), also at home   // the server layout: <root>/factory/lib/nullbar.cjs
  const ruleF = path.join(TMP, "rule.json"); fs.writeFileSync(ruleF, JSON.stringify(baseRule()));
  const out = path.join(TMP, "results", "edge.json"); fs.mkdirSync(path.dirname(out));
  const cli = (...a) => cp.spawnSync(process.execPath, [path.join(TB, "bt", "bt-run.cjs"), ...a], { encoding: "utf8", cwd: T });
  const r = cli("--rule", ruleF, "--bars", path.join(TMP, "edge"), "--out", out);
  ok("bt-run --rule --bars --out: exit 0, VERDICT PASS printed, SEALED", r.status === 0 && /VERDICT PASS/.test(r.stdout) && /SEALED/.test(r.stdout), r.stdout + r.stderr);
  const j = JSON.parse(fs.readFileSync(out, "utf8"));
  ok("the sealed file holds the rule, every bar file's sha256, the code's sha256, the null bar used, every trade, mean, t (month unit), costs, placebo, floor, leak, positive control, gates",
    j.schema === "bt-result-v1" && j.rule.id === "FIXTURE-IBS" && Object.keys(j.data.files).length === 10 && Object.values(j.data.files).every((f) => /^[0-9a-f]{64}$/.test(f.sha256)) && /^[0-9a-f]{64}$/.test(j.code.files["bt-core.cjs"]) && /factory/.test(j.code.nullBar.file) &&
    j.trades.length === j.stats.trades && Number.isFinite(j.stats.tNet) && /month/.test(j.unit) && j.costs.roundTrip === 0.0006 && Number.isFinite(j.placebo.pairedT) && j.floor.seeds === 20 && j.leakTest.length === 2 && "positiveControl" in j && j.gates.tAtLeastBar === true);
  ok("the file is read-only (0444)", (fs.statSync(out).mode & 0o777) === 0o444);
  const v = cli("--verify", out);
  ok("--verify: INTACT", v.status === 0 && /INTACT/.test(v.stdout), v.stdout + v.stderr);
  const again = cli("--rule", ruleF, "--bars", path.join(TMP, "edge"), "--out", out);
  ok("a second run to the same --out: REFUSED (a sealed result is never overwritten), the file unchanged", again.status === 1 && /never overwritten/.test(again.stderr) && fs.readFileSync(out, "utf8") === JSON.stringify(j, null, 1));
  const tam = path.join(TMP, "results", "tampered.json"), jt = JSON.parse(JSON.stringify(j)); jt.stats.tNet = 9.99; fs.writeFileSync(tam, JSON.stringify(jt));
  const vt = cli("--verify", tam);
  ok("a sealed file with one number changed: --verify ALTERED (exit 1)", vt.status === 1 && /ALTERED/.test(vt.stderr), vt.stderr);
  const tamper = (mut, name) => { const f = path.join(TMP, "results", name + ".json"), x = JSON.parse(JSON.stringify(j)); mut(x); fs.writeFileSync(f, JSON.stringify(x)); return cli("--verify", f).status; };
  ok("the seal covers the trades and the rule too: one trade's net changed, or the rule's universe, -> ALTERED", tamper((x) => { x.trades[0].net += 0.001; }, "t1") === 1 && tamper((x) => { x.rule.universe[0] = "ZZZ"; }, "t2") === 1 && tamper((x) => { x.bar.tRequired = 1; }, "t3") === 1);
  const raceOut = path.join(TMP, "results", "race.json"); let er2 = null;
  try { RUN.writeSealed(raceOut, j, (f, o) => { writeJsonAtomicT(f, o); fs.writeFileSync(raceOut, "someone else's file"); }); } catch (x) { er2 = x.message; }
  ok("write once with no race: a file that appears between the check and the write is NOT replaced (link fails), and no temp is left", /never overwritten/.test(er2 || "") && fs.readFileSync(raceOut, "utf8") === "someone else's file" && !fs.readdirSync(path.join(TMP, "results")).some((f) => /sealing/.test(f)), er2);
  ok("argument errors: --verify with no path, a flag given twice, a flag whose value is another flag -> exit 2", cli("--verify").status === 2 && cli("--rule", ruleF, "--rule", ruleF, "--bars", "x", "--out", "y").status === 2 && cli("--rule", ruleF, "--bars", path.join(TMP, "edge"), "--out", "--exploratory").status === 2);
  const unreg = path.join(TMP, "unreg.json"); fs.writeFileSync(unreg, JSON.stringify(baseRule({ registration: undefined })));
  const ru = cli("--rule", unreg, "--bars", path.join(TMP, "edge"), "--out", path.join(TMP, "results", "x.json"));
  ok("an unregistered rule without --exploratory: REFUSED, nothing written", ru.status === 1 && /--exploratory/.test(ru.stderr) && !fs.existsSync(path.join(TMP, "results", "x.json")), ru.stderr);
  const bad = cli("--rule", ruleF, "--bars", path.join(TMP, "edge"));
  ok("usage errors: exit 2", bad.status === 2 && cli("--nonsense").status === 2);
  const shipped = JSON.parse(fs.readFileSync(path.join(BT, "rules", "dip-ibs-country-etfs.json"), "utf8"));
  ok("the FIRST-USE rule file is RESERVED FOR REGISTRATION (no exploratory read of its bars) and has the forming-bar guard", shipped.reservedForRegistration === true && shipped.window.lastBar === "2026-10-01");
  ok("the FIRST-USE rule freezes its gap limit (14) and uses 61 drift-kept seeds, where the calibration CAN hold (ceiling 4 of 61 = 6.6% > 5%), and R313's 20 drift-free seeds", shipped.window.maxGapDays === 14 && shipped.controls.floorSeeds === 61 && B.calibrationCeiling(61) / 61 > 0.05 && shipped.controls.freeSeeds === 20);
  ok("the FIRST-USE rule file (R313's IBS rule on 24 single-country ETFs) passes checkRule, carries NO registration (a draft) and none of R313's 20 symbols", B.checkRule(shipped) === shipped && !shipped.registration && shipped.universe.length === 24 && !shipped.universe.some((s) => ["SPY", "IWM", "DIA", "MDY", "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "EFA", "EEM", "EWJ", "EWG", "EWU", "EWC", "EWA", "QQQ"].includes(s)) && shipped.params.entry.ibsBelow === 0.1 && shipped.params.exit.ibsAbove === 0.9);
  const mr = cp.spawnSync(process.execPath, [path.join(H, "make-rules.cjs"), "--check"], { encoding: "utf8" });
  ok("the shipped rule file is exactly what make-rules.cjs writes (JSON written only through writeJsonAtomic)", mr.status === 0, mr.stdout);
});

section("the package (deploy / rollback / record on a temp repo)", () => {
  const repo = fs.mkdtempSync(path.join(TMP, "repo-")); fs.writeFileSync(path.join(repo, "AGENTS.md"), "x"); fs.mkdirSync(path.join(repo, "backend"));
  const node = (f, ...a) => cp.spawnSync(process.execPath, [path.join(H, f), ...a, "--repo", repo], { encoding: "utf8" });
  const rels = require(path.join(H, "files.cjs")).FILES.map((f) => f.rel);
  const p = node("deploy.cjs", "--plan"), a = node("deploy.cjs", "--apply");
  ok("deploy --plan then --apply: the three new files are the staged bytes", p.status === 0 && /would write 3 file/.test(p.stdout) && a.status === 0 && rels.every((r) => fs.readFileSync(path.join(repo, r)).equals(fs.readFileSync(path.join(H, "staged", r)))), p.stdout + a.stdout + a.stderr);
  fs.appendFileSync(path.join(repo, rels[0]), "// edited\n");
  const rr = node("rollback.cjs");
  ok("rollback over an edited file: REFUSED, nothing removed", rr.status === 1 && rels.every((r) => fs.existsSync(path.join(repo, r))), rr.stdout);
  fs.writeFileSync(path.join(repo, rels[0]), fs.readFileSync(path.join(H, "staged", rels[0])));
  const rb = node("rollback.cjs");
  ok("rollback: the three new files are removed", rb.status === 0 && rels.every((r) => !fs.existsSync(path.join(repo, r))), rb.stdout);
  const own = cp.spawnSync(process.execPath, [path.join(H, "deploy.cjs"), "--plan"], { encoding: "utf8" });
  ok("deploy --plan without --repo (on this repository): exit 0, nothing written", own.status === 0 && /^(base|applied) +backend\/bt\/bt-core\.cjs/m.test(own.stdout), own.stdout + own.stderr);
  const rec = node("record.cjs", "--dry");
  ok("record --dry prints the record and writes nothing", rec.status === 0 && /DRY: nothing written/.test(rec.stdout));
  const all = [...fs.readdirSync(H).filter((f) => f.endsWith(".cjs")).map((f) => path.join(H, f)), path.join(BT, "bt-core.cjs"), path.join(BT, "bt-run.cjs")];
  ok("node --check of every package file", all.every((f) => cp.spawnSync(process.execPath, ["--check", f]).status === 0));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fail ? quiet(`SELFTEST: ${fail} of ${pass + fail} cases FAILED`) : `ALL ${pass} CASES PASSED (server-backtest-runner; synthetic bars, no network)`);
process.exitCode = fail ? 1 : 0;
