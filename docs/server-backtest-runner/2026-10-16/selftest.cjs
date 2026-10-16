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
const NB = B.loadNullBar([path.join(REPO, "backend", "lib", "null-bar.js"), path.join(REPO, "docs", "server", "wave6-agents", "server", "factory", "lib", "nullbar.cjs")]);

// ── synthetic bars ───────────────────────────────────────────────────────────────────────────────────────────────────────
function sessions(from, n) { const out = []; for (let t = Date.parse(from + "T12:00:00Z"); out.length < n; t += 86400000) { const g = new Date(t).getUTCDay(); if (g !== 0 && g !== 6) out.push(new Date(t).toISOString().slice(0, 10)); } return out; }
/** a daily OHLC path; edge > 0 adds that drift to the day AFTER a close with IBS < 0.1 (the planted dip-buy edge); 0 = no edge */
function synth(seed, n, edge = 0, from = "2010-01-04") {
  const rng = B.mulberry(seed), nrm = () => { let u = 0, v = 0; while (u === 0) u = rng(); v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const days = sessions(from, n), bars = []; let c = 100, lastIbs = 0.5;
  for (const t of days) {
    const o = c * (1 + 0.002 * nrm()), r = 0.012 * nrm() + (lastIbs < 0.1 ? edge : 0), cl = c * (1 + r);
    const h = Math.max(o, cl) * (1 + Math.abs(0.005 * nrm())), l = Math.min(o, cl) * (1 - Math.abs(0.005 * nrm()));
    bars.push({ t, o, h, l, c: cl, v: 1000 }); lastIbs = h > l ? (cl - l) / (h - l) : 0.5; c = cl;
  }
  return bars;
}
const writeBars = (dir, sym, bars) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, sym + ".json"), JSON.stringify(bars)); };
const SYMS = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH", "III", "JJJ"];
const baseRule = (o = {}) => ({ schema: "bt-rule-v1", id: "FIXTURE-IBS", family: "ibs-dip", universe: SYMS, params: { entry: { ibsBelow: 0.1 }, exit: { ibsAbove: 0.9 }, maxHoldDays: null },
  window: { from: "2010-01-01", to: "2017-12-31" }, costs: { roundTrip: 0.0006, stress: 0.0012 }, unit: "month", bar: { tRequired: 1.66, source: "fixture" },
  gates: { minTrades: 100, minMonths: 36 }, controls: { placeboDraws: 100, placeboSeed: 313, floorSeeds: 10, leakSeeds: [1, 2] }, registration: { id: "RFIX", registeredOn: "2026-10-16" }, ...o });

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
  const R = baseRule({ universe: ["ONE"], window: { from: "2020-01-01", to: "2020-12-31" } });
  const P = B.prepRule(bars, R), r = B.simulateRule(P, "ONE", R);
  const tr = r.closed.map((x) => ({ ...x, net: x.gross - 0.0006 }));
  const want = [{ e: days[2], x: days[4], g: 103 / 100 - 1 }, { e: days[6], x: days[8], g: 49 / 50 - 1 }];
  ok("two closed trades at the hand-picked closes (entry 100 -> exit 103, entry 50 -> exit 49), gross exact", tr.length === 2 && tr.every((x, i) => x.entryDate === want[i].e && x.exitDate === want[i].x && Math.abs(x.gross - want[i].g) < 1e-12), JSON.stringify(tr.map((x) => [x.entryDate, x.exitDate, x.entry, x.exit, x.gross])));
  ok("the trade entered on bar 10 never exits: listed OPEN, not counted", r.open.length === 1 && r.open[0].entryDate === days[10]);
  ok("net = gross - 0.06% exactly; both in January 2020: the month's mean is their mean", Math.abs(tr[0].net - 0.0294) < 1e-12 && Math.abs(tr[1].net - (-0.0206)) < 1e-12 && Math.abs(B.summarise(tr).meanNet - 0.0044) < 1e-12);
  ok("Newey-West t, lag 1, on [1%, 2%, -0.5%, 1.5%] = 3.5777 (worked by hand: v = 8.75e-5 - 5.625e-5)", Math.abs(B.nwT([0.01, 0.02, -0.005, 0.015]) - 0.01 / Math.sqrt(3.125e-5 / 4)) < 1e-9 && Math.abs(B.nwT([0.01, 0.02, -0.005, 0.015]) - 3.5777) < 1e-4);
  const Rc = baseRule({ universe: ["ONE"], window: { from: "2020-01-01", to: "2020-12-31" }, params: { entry: { ibsBelow: 0.1 }, exit: { ibsAbove: 0.99 }, maxHoldDays: 2 } });
  const rc = B.simulateRule(B.prepRule(bars, Rc), "ONE", Rc);
  ok("the time cap (maxHoldDays 2, exit IBS > 0.99): the first trade closes at bar 4 by the cap, the second at bar 8 by its exit (IBS 1.0)", rc.closed.length === 2 && rc.closed[0].exitDate === days[4] && rc.closed[0].capped === true && rc.closed[1].exitDate === days[8] && !rc.closed[1].capped, JSON.stringify(rc.closed.map((x) => [x.entryDate, x.exitDate, x.capped])));
  const Rr = baseRule({ family: "rsi-dip", universe: ["ONE"], params: { entry: { rsiBelow: 10, rsiN: 2 }, exit: { closeAboveSma: 5 } } });
  ok("rsi-dip signals come from R313's rsiWilder: RSI(2) on a falling-then-rising series is < 10 at the bottom", (() => { const c = [10, 9, 8, 7, 6, 7, 8]; const rs = B.rsiWilder(c, 2); return rs[4] < 10 && rs[6] > 50 && B.checkRule(Rr) === Rr; })());
});

section("the bar — R313's known answer", () => {
  const b = B.barFor(320, { variants: 1, seed: 313, NB });
  ok(`barFor(n 320, 1 variant, seed 313): the NW-on-noise part is R313's registered 1.66 exactly (${b.nwSim})`, b.nwSim === 1.66, JSON.stringify(b));
  // the null-bar part: R313's registry says 1.658 from backend/lib/null-bar.js. With the HOUSE file that must be reproduced exactly. The clean copy
  // has only the research server's port, which gives 1.666 for the same call — a difference this package REPORTS (NOTES.md), never hides.
  if (/backend[\\/]lib[\\/]null-bar\.js$/.test(NB.path)) ok(`with the house backend/lib/null-bar.js: null bar ${b.iid} = R313's registered 1.658, bar ${b.bar} = 1.66`, b.iid === 1.658 && b.bar === 1.66, JSON.stringify(b));
  else { console.log(`  NOTE (not counted) the null bar loaded is the PORT ${path.relative(REPO, NB.path)}: n 320 seed 313 gives ${b.iid}, R313's registry says 1.658 from the house file — see NOTES.md (run this selftest at home, where the house file is loaded and this becomes a counted case)`); ok("the port's null bar is deterministic for the same call (seeded)", B.barFor(320, { variants: 1, seed: 313, NB, trialsNw: 10 }).iid === b.iid); }
  const b5 = B.barFor(120, { variants: 5, seed: 7, trialsNw: 3000, trialsIid: 3000, NB }), b1 = B.barFor(120, { variants: 1, seed: 7, trialsNw: 3000, trialsIid: 3000, NB });
  ok(`best of 5 variants raises the bar (${b5.bar} > ${b1.bar}), and the same inputs give the same bar (seeded)`, b5.bar > b1.bar && B.barFor(120, { variants: 5, seed: 7, trialsNw: 3000, trialsIid: 3000, NB }).bar === b5.bar);
});

const N = 8 * 261;
section("PLANTED EDGE — must PASS", () => {
  const dir = path.join(TMP, "edge"); SYMS.forEach((s, i) => writeBars(dir, s, synth(1000 + i, N, 0.008)));
  const r = RUN.run(baseRule(), dir, { NB });
  ok(`a +0.8% bounce after IBS < 0.1 on 10 symbols x 8 years: PASS (${r.stats.trades} trades, ${r.stats.months} months, t ${r.stats.tNet}, placebo paired t ${r.placebo.pairedT}, floor clears ${r.floor.gate.clears})`, r.verdict === "PASS" && r.failed.length === 0, `${r.verdict} failed ${r.failed.join(",")} t ${r.stats.tNet} pl ${r.placebo.pairedT}`);
  ok("its controls: leak test t < 2 on both drift-free shuffles; positive control t >= 3; 2x cost still > 0", r.leakTest.every((x) => x.pass) && r.positiveControl.pass && r.stats.stress.meanNet > 0, JSON.stringify([r.leakTest, r.positiveControl]));
  const r2 = RUN.run(baseRule({ costs: { roundTrip: 0.0016, stress: 0.0032 } }), dir, { NB });
  ok("costs: +0.10% round trip lowers every trade's net by exactly 0.001 and the monthly mean by exactly 0.001", r2.trades.length === r.trades.length && r2.trades.every((x, i) => Math.abs((r.trades[i].net - x.net) - 0.001) < 1e-12) && Math.abs((r.stats.meanNet - r2.stats.meanNet) - 0.001) < 1e-12);
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
  // a planted edge too weak to clear the bar does not pass either
  const dir = path.join(TMP, "weak"); SYMS.slice(0, 3).forEach((s, i) => writeBars(dir, s, synth(500 + i, 3 * 261, 0.0005)));
  const rw = RUN.run(baseRule({ universe: SYMS.slice(0, 3), window: { from: "2010-01-01", to: "2012-12-31" } }), dir, { NB });
  ok(`a tiny edge on 3 symbols x 3 years: not PASS (${rw.verdict})`, !/^PASS/.test(rw.verdict));
  const rf = RUN.run(baseRule({ universe: ["AAA"], window: { from: "2010-01-01", to: "2010-06-30" } }), path.join(TMP, "edge"), { NB });
  ok(`too few trades / months: CANNOT MEASURE (${rf.verdict})`, /^CANNOT MEASURE — \d+ trades < 100; \d+ months < 36/.test(rf.verdict));
});

section("refusals — bars and rules", () => {
  const dir = path.join(TMP, "bad"), good = synth(9, 300);
  const refuse = (sym, bars, re) => { writeBars(dir, sym, bars); let e = null; try { B.loadBars(dir, sym); } catch (x) { e = x.message; } return re.test(e || ""); };
  ok("a missing bar file: REFUSED", (() => { try { B.loadBars(dir, "NOPE"); return false; } catch (e) { return /no bar file/.test(e.message); } })());
  ok("high < low, a price <= 0 or NaN, a duplicate date, dates out of order, a malformed date: each REFUSED", refuse("HL", good.map((b, i) => (i === 50 ? { ...b, h: b.l - 1 } : b)), /high .* < low/) && refuse("NEG", good.map((b, i) => (i === 7 ? { ...b, c: -1 } : b)), /finite number > 0/) && refuse("NAN", good.map((b, i) => (i === 7 ? { ...b, o: "x" } : b)), /finite number > 0/) && refuse("DUP", [...good.slice(0, 10), good[9], ...good.slice(10)], /strictly increase/) && refuse("ORD", [good[1], good[0], ...good.slice(2)], /strictly increase/) && refuse("BADD", good.map((b, i) => (i === 3 ? { ...b, t: "2010-13-45" } : b)), /bad date/));
  writeBars(dir, "WKD", [...good.slice(0, 5), { ...good[5], t: "2010-01-09" }, ...good.slice(6)].filter((b, i) => i !== 6 || true));
  ok("a weekend row is dropped and counted (as R313 did), not traded", (() => { const L = B.loadBars(dir, "WKD"); return L.weekendDropped === 1 && !L.bars.some((b) => b.t === "2010-01-09"); })());
  fs.writeFileSync(path.join(dir, "CSV.csv"), "Date,Open,High,Low,Close,Volume\n" + good.slice(0, 20).map((b) => [b.t, b.o, b.h, b.l, b.c, b.v].join(",")).join("\n") + "\n");
  ok("a CSV bar file reads the same bars as JSON", (() => { const L = B.loadBars(dir, "CSV"); return L.bars.length === 20 && Math.abs(L.bars[5].c - good[5].c) < 1e-9; })());
  const bad = (o, re) => { try { B.checkRule(baseRule(o)); return false; } catch (e) { return re.test(e.message); } };
  ok("rule refusals: wrong schema, unknown family, empty universe, a unit other than month, a missing bar, no exit, costs.stress < roundTrip", bad({ schema: "x" }, /schema/) && bad({ family: "momentum" }, /family/) && bad({ universe: [] }, /universe/) && bad({ unit: "week" }, /unit must be "month"/) && bad({ bar: {} }, /bar:/) && bad({ params: { entry: { ibsBelow: 0.1 }, exit: {} } }, /params\.exit/) && bad({ costs: { roundTrip: 0.002, stress: 0.001 } }, /stress/));
  let e1 = null; try { RUN.run(baseRule({ registration: undefined }), path.join(TMP, "edge"), { NB }); } catch (x) { e1 = x.message; }
  ok("a rule with no registration: REFUSED unless --exploratory", /--exploratory/.test(e1 || ""), e1);
  const rx = RUN.run(baseRule({ registration: undefined, bar: { variants: 1, trialsNw: 2000, trialsIid: 2000 } }), path.join(TMP, "edge"), { exploratory: true, NB });
  ok("--exploratory: runs, the bar is COMPUTED (best of 1), and the verdict and label say EXPLORATORY", rx.mode === "exploratory" && /^EXPLORATORY: /.test(rx.verdict) && /never a read/.test(rx.label) && rx.bar.computed === true && rx.bar.n === rx.stats.months, `${rx.verdict} ${JSON.stringify(rx.bar).slice(0, 200)}`);
  let e2 = null; try { RUN.run(baseRule({ bar: { variants: 1 } }), path.join(TMP, "edge"), { NB }); } catch (x) { e2 = x.message; }
  ok("a registered rule without its registered bar.tRequired: REFUSED (a registered bar is never recomputed)", /registered bar\.tRequired/.test(e2 || ""), e2);
});

section("the CLI end to end (temp tree: sealed once, read-only, verified, tamper detected)", () => {
  const T = path.join(TMP, "tree"), TB = path.join(T, "backend");
  fs.mkdirSync(path.join(TB, "bt"), { recursive: true }); fs.mkdirSync(path.join(TB, "lib")); fs.mkdirSync(path.join(T, "factory", "lib"), { recursive: true });
  for (const f of ["bt-core.cjs", "bt-run.cjs"]) fs.copyFileSync(path.join(BT, f), path.join(TB, "bt", f));
  fs.copyFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"), path.join(TB, "lib", "atomic-write.js"));
  fs.writeFileSync(path.join(TB, "package.json"), '{"type":"commonjs"}');   // stands in for home's backend/package.json (absent from the clean copy)
  fs.copyFileSync(NB.path, path.join(T, "factory", "lib", "nullbar.cjs"));   // the server layout: <root>/factory/lib/nullbar.cjs
  const ruleF = path.join(TMP, "rule.json"); fs.writeFileSync(ruleF, JSON.stringify(baseRule()));
  const out = path.join(TMP, "results", "edge.json"); fs.mkdirSync(path.dirname(out));
  const cli = (...a) => cp.spawnSync(process.execPath, [path.join(TB, "bt", "bt-run.cjs"), ...a], { encoding: "utf8", cwd: T });
  const r = cli("--rule", ruleF, "--bars", path.join(TMP, "edge"), "--out", out);
  ok("bt-run --rule --bars --out: exit 0, VERDICT PASS printed, SEALED", r.status === 0 && /VERDICT PASS/.test(r.stdout) && /SEALED/.test(r.stdout), r.stdout + r.stderr);
  const j = JSON.parse(fs.readFileSync(out, "utf8"));
  ok("the sealed file holds the rule, every bar file's sha256, the code's sha256, the null bar used, every trade, mean, t (month unit), costs, placebo, floor, leak, positive control, gates",
    j.schema === "bt-result-v1" && j.rule.id === "FIXTURE-IBS" && Object.keys(j.data.files).length === 10 && Object.values(j.data.files).every((f) => /^[0-9a-f]{64}$/.test(f.sha256)) && /^[0-9a-f]{64}$/.test(j.code.files["bt-core.cjs"]) && /factory/.test(j.code.nullBar.file) &&
    j.trades.length === j.stats.trades && Number.isFinite(j.stats.tNet) && /month/.test(j.unit) && j.costs.roundTrip === 0.0006 && Number.isFinite(j.placebo.pairedT) && j.floor.seeds === 10 && j.leakTest.length === 2 && "positiveControl" in j && j.gates.tAtLeastBar === true);
  ok("the file is read-only (0444)", (fs.statSync(out).mode & 0o777) === 0o444);
  const v = cli("--verify", out);
  ok("--verify: INTACT", v.status === 0 && /INTACT/.test(v.stdout), v.stdout + v.stderr);
  const again = cli("--rule", ruleF, "--bars", path.join(TMP, "edge"), "--out", out);
  ok("a second run to the same --out: REFUSED (a sealed result is never overwritten), the file unchanged", again.status === 1 && /never overwritten/.test(again.stderr) && fs.readFileSync(out, "utf8") === JSON.stringify(j, null, 1));
  const tam = path.join(TMP, "results", "tampered.json"), jt = JSON.parse(JSON.stringify(j)); jt.stats.tNet = 9.99; fs.writeFileSync(tam, JSON.stringify(jt));
  const vt = cli("--verify", tam);
  ok("a sealed file with one number changed: --verify ALTERED (exit 1)", vt.status === 1 && /ALTERED/.test(vt.stderr), vt.stderr);
  const unreg = path.join(TMP, "unreg.json"); fs.writeFileSync(unreg, JSON.stringify(baseRule({ registration: undefined })));
  const ru = cli("--rule", unreg, "--bars", path.join(TMP, "edge"), "--out", path.join(TMP, "results", "x.json"));
  ok("an unregistered rule without --exploratory: REFUSED, nothing written", ru.status === 1 && /--exploratory/.test(ru.stderr) && !fs.existsSync(path.join(TMP, "results", "x.json")), ru.stderr);
  const bad = cli("--rule", ruleF, "--bars", path.join(TMP, "edge"));
  ok("usage errors: exit 2", bad.status === 2 && cli("--nonsense").status === 2);
  const shipped = JSON.parse(fs.readFileSync(path.join(BT, "rules", "dip-ibs-country-etfs.json"), "utf8"));
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
