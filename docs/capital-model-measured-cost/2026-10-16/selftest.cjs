#!/usr/bin/env node
"use strict";
/**
 * CAPITAL MODEL — MEASURED COST (2026-10-16) — SELFTEST. Offline, no network, no broker, no data of the real system: it builds its own
 * synthetic fixture tree (make-fixture.cjs) twice — once with the package's base/ files, once with its staged/ ones — and runs the real
 * planE-baseline.js in each.
 *
 *   node docs/capital-model-measured-cost/2026-10-16/selftest.cjs                 run every check (the last line says it passed)
 *   node docs/capital-model-measured-cost/2026-10-16/selftest.cjs --keep          leave the trees on disk and print where they are
 *   node docs/capital-model-measured-cost/2026-10-16/selftest.cjs --freeze-known  rewrite the known answers in fixtures/fixture-spec.json
 *
 * WHAT IT PROVES, in order:
 *   1 the package's base copies ARE the live files, the staged files parse, the fixture is byte-stable against its frozen shas
 *   2 THE DEFAULT IS BYTE-IDENTICAL: with no argument the staged script prints the same bytes as the base script and writes the same
 *     planE-baseline.json, byte for byte; and the staged library answers the same as the base library for pyBuild / znWindows / tbillByMonth
 *   3 the measured run adds ONE block to stdout and ONE key to the JSON and changes nothing else: take the block out of the measured
 *     stdout and it is the default stdout; delete measuredCosts from the measured JSON and it is the default JSON
 *   4 KNOWN ANSWERS: every number of the measured block equals the frozen one (fixtures/fixture-spec.json "known")
 *   5 the arithmetic: assumed x1 reproduces the script's own PY table exactly; a measured file holding the assumed rates reproduces it
 *     too (which is what fixes the per-side / per-round-trip units); each leg's rate moves the answer on its own; a dearer cost always
 *     lowers the year; repriceZnRows at the carried rate does not move a single bit
 *   6 the refusals: a bad spec, a missing / misspelled / negative / non-numeric / absurd rate, an unreadable file and a stray argument
 *     are all refused with exit 2, before anything is computed and WITHOUT writing planE-baseline.json
 * Exit 0 and a last line "ALL <n> CHECKS PASSED", or exit 1 with the failures listed.
 */
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto");
const F = require("./make-fixture.cjs");
const PKG = __dirname, REPO = F.REPO, PKG_REL = "docs/capital-model-measured-cost/2026-10-16";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const KEEP = process.argv.includes("--keep"), FREEZE = process.argv.includes("--freeze-known");
const spec = F.loadSpec();

let n = 0; const fails = [];
const check = (name, fn) => { n++; let r; try { r = fn(); } catch (e) { fails.push(`${name}: threw ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`); console.log(`FAIL ${name} — threw ${e && e.message}`); return; }
  if (r === true || r == null) { console.log(`ok   ${name}`); return; }
  fails.push(`${name}: ${r}`); console.log(`FAIL ${name} — ${r}`); };
const eq = (a, b, what) => (a === b ? true : `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

// ── the two trees ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cmmc-selftest-"));
const TREE = { base: path.join(ROOT, "base"), staged: path.join(ROOT, "staged") };
const built = { base: F.buildTree(TREE.base, { which: "base", spec }), staged: F.buildTree(TREE.staged, { which: "staged", spec }) };
const BASELINE = (w) => path.join(TREE[w], "backend", "profit-program", "planE-baseline.js");
const OUTJSON = (w) => path.join(TREE[w], "backend", "data", "profit-program", "planE-baseline.json");
const run = (w, args = []) => { const r = cp.spawnSync(process.execPath, [BASELINE(w), ...args], { cwd: TREE[w], encoding: "utf8", timeout: 600000, maxBuffer: 256 << 20 }); return { status: r.status, out: String(r.stdout || ""), err: String(r.stderr || "") }; };
const costFile = (obj, name) => { const p = path.join(ROOT, name); fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj, null, 1)); return p; };
const MEASURED = { spec: "planE-measured-costs-v1", measuredAt: "2026-10-16", source: "SELFTEST — made up", equityBpsPerSide: 3.4, cryptoBpsPerRoundTrip: 38, znBpsPerRoundTrip: 6.5 };
const ASSUMED_AS_FILE = { spec: "planE-measured-costs-v1", equityBpsPerSide: 5, cryptoBpsPerRoundTrip: 50, znBpsPerRoundTrip: 4 };

console.log(`selftest — ${PKG_REL}\n  trees: ${ROOT}  (${built.base.sessionCount} sessions, ${built.base.cryptoDays} crypto days, SYNTHETIC)`);

// ── 0. the clock ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const todayUtc = new Date().toISOString().slice(0, 10);
check("clock: today is past the fixture's last day (the model only reads completed crypto days)", () => (todayUtc > spec.last ? true : `today is ${todayUtc}, the fixture ends ${spec.last} — the crypto leg would be cut short; move the fixture's last day back`));

// ── 1. the package itself ────────────────────────────────────────────────────────────────────────────────────────────────────
const DEP = require("./deploy.cjs");
for (const f of DEP.FILES) {
  check(`package: base/${f.rel} is the live file it was built against (or the apply has happened)`, () => {
    const live = path.join(REPO, ...f.rel.split("/")), b = path.join(PKG, ...f.base.split("/"));
    if (!fs.existsSync(live)) return `${f.rel} is missing from this copy of the repo`;
    const sl = sha(fs.readFileSync(live)), sb = sha(fs.readFileSync(b));
    if (sb !== f.baseSha) return `base copy sha ${sb.slice(0, 12)} is not the declared ${f.baseSha.slice(0, 12)}`;
    if (sl === sb) return true;                                           // before the apply: home holds the base bytes
    return sl === f.stagedSha ? true : `the live file (${sl.slice(0, 12)}) is neither the base copy (${sb.slice(0, 12)}) nor the staged one (${f.stagedSha.slice(0, 12)}) — DRIFT: the package must be rebuilt against it`;
  });
  check(`package: staged/${f.rel} matches its declared sha and parses`, () => {
    const s = path.join(PKG, ...f.staged.split("/")), ss = sha(fs.readFileSync(s));
    if (ss !== f.stagedSha) return `staged copy sha ${ss.slice(0, 12)} is not the declared ${f.stagedSha.slice(0, 12)} (deploy.cjs STAGED_SHA)`;
    const c = cp.spawnSync(process.execPath, ["--check", s], { encoding: "utf8" });
    return c.status === 0 ? true : `node --check: ${String(c.stderr).trim().split("\n")[0]}`;
  });
}
check("fixture: the generated tree matches the frozen shas and is built twice the same", () => {
  const again = F.buildTree(path.join(ROOT, "again"), { which: "base", spec });
  for (const k of Object.keys(spec.shas)) { if (built.base.shas[k] !== spec.shas[k]) return `${k} is ${built.base.shas[k].slice(0, 12)}, frozen ${spec.shas[k].slice(0, 12)}`; if (again.shas[k] !== spec.shas[k]) return `${k} differs between two builds`; }
  return built.staged.shas.inputs === spec.shas.inputs ? true : "the staged tree's data differs from the base tree's";
});

// ── 2. the default is byte-identical ─────────────────────────────────────────────────────────────────────────────────────────
const R = { base: run("base"), staged: run("staged") };
check("default: the base script runs green on the fixture (its own asserts pass)", () => (R.base.status === 0 && /reproduction OK/.test(R.base.out) ? true : `exit ${R.base.status}; ${R.base.err.trim().split("\n")[0] || R.base.out.trim().split("\n").pop()}`));
check("default: the staged script runs green with no argument", () => eq(R.staged.status, 0, `exit (stderr: ${R.staged.err.trim().slice(0, 200)})`));
check("DEFAULT STDOUT IS BYTE-IDENTICAL (staged vs base, no argument)", () => {
  if (R.base.out === R.staged.out) return true;
  const a = R.base.out.split("\n"), b = R.staged.out.split("\n"), i = a.findIndex((l, k) => l !== b[k]);
  return `first difference at line ${i + 1}:\n       base   ${JSON.stringify(a[i])}\n       staged ${JSON.stringify(b[i])}`;
});
check("DEFAULT STDERR IS BYTE-IDENTICAL", () => eq(R.staged.err, R.base.err, "stderr"));
const J = { base: fs.readFileSync(OUTJSON("base"), "utf8"), staged: fs.readFileSync(OUTJSON("staged"), "utf8") };
check("DEFAULT planE-baseline.json IS BYTE-IDENTICAL", () => (J.base === J.staged ? true : `sha ${sha(J.base).slice(0, 12)} vs ${sha(J.staged).slice(0, 12)} (${J.base.length} vs ${J.staged.length} bytes)`));
check("default: the staged JSON holds no measuredCosts key", () => (JSON.parse(J.staged).measuredCosts === undefined ? true : "measuredCosts is written without --measured-costs"));
const LIB = { base: require(path.join(TREE.base, "backend", "profit-program", "planE-model.js")), staged: require(path.join(TREE.staged, "backend", "profit-program", "planE-model.js")) };
check("library: every export of the base model is still exported by the staged one", () => {
  const miss = Object.keys(LIB.base).filter((k) => !(k in LIB.staged));
  return miss.length ? `missing: ${miss.join(", ")}` : true;
});
check("library: pyBuild / znWindows / tbillByMonth answer the same in both (no argument changed)", () => {
  const inp = LIB.base.loadInputs(), out = {};
  for (const w of ["base", "staged"]) { const M = LIB[w], py = M.pyBuild(inp, { asOf: "2026-09-30" });
    out[w] = JSON.stringify({ E: M.monthlyStats(py.run("2019-06", "2026-09", M.PYW.E).mo), D2: M.monthlyStats(py.run("2019-06", "2026-09", M.PYW.D2).mo), D: M.monthlyStats(py.run("2019-06", "2026-09", M.PYW.D).mo), zn: M.znWindows(), tb: M.tbillByMonth() }); }
  return eq(out.staged, out.base, "the two libraries answer differently");
});

// ── 3. the measured run adds one block and one key, and nothing else ─────────────────────────────────────────────────────────
const MF = costFile(MEASURED, "measured-costs.json");
const RM = run("staged", ["--measured-costs", MF]);
check("measured: the staged script runs green with --measured-costs", () => eq(RM.status, 0, `exit (stderr: ${RM.err.trim().slice(0, 300)})`));
const BLOCK_HEAD = "measured trading cost: the model's assumed rates beside the measured ones";
function withoutBlock(text) {
  const L = text.split("\n"), s = L.indexOf(BLOCK_HEAD);
  if (s < 0) return { ok: false, why: `the measured block's first line is missing` };
  let e = L.findIndex((l, i) => i > s && /^  the "assumed x1" rows /.test(l));
  if (e < 0) return { ok: false, why: "the measured block's last line is missing" };
  if (L[s - 1] !== "") return { ok: false, why: "the measured block does not start after a blank line" };
  const block = L.slice(s, e + 1);
  return { ok: true, rest: L.slice(0, s - 1).concat(L.slice(e + 1)).join("\n"), block };
}
const WB = withoutBlock(RM.out);
check("measured: stdout is the default stdout with ONE block inserted (nothing else moved)", () => {
  if (!WB.ok) return WB.why;
  if (WB.rest === R.base.out) return true;
  const a = R.base.out.split("\n"), b = WB.rest.split("\n"), i = a.findIndex((l, k) => l !== b[k]);
  return `with the block removed the measured stdout still differs at line ${i + 1}:\n       default  ${JSON.stringify(a[i])}\n       measured ${JSON.stringify(b[i])}`;
});
const JM = fs.readFileSync(OUTJSON("staged"), "utf8"), OM = JSON.parse(JM);
check("measured: planE-baseline.json gains measuredCosts as its LAST key and nothing else changes", () => {
  const keys = Object.keys(OM);
  if (keys[keys.length - 1] !== "measuredCosts") return `the last key is ${keys[keys.length - 1]}, not measuredCosts`;
  const copy = { ...OM }; delete copy.measuredCosts;
  const back = JSON.stringify(copy, null, 1);
  return back === J.base ? true : `with measuredCosts deleted the file is not the default one (${sha(back).slice(0, 12)} vs ${sha(J.base).slice(0, 12)})`;
});
check("measured: py.E / py.D2 (what risk-manager.js reads) are untouched by the measured run", () => {
  const d = JSON.parse(J.base);
  return eq(JSON.stringify(OM.py), JSON.stringify(d.py), "the py block moved");
});

// ── 4. known answers ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const M = LIB.staged, INP = M.loadInputs(), ZN = M.znWindows();
/** two weight sets whose worst months do NOT coincide (the note alone, and everything but the note) — section 5 reads this */
const PLAN_W = { ZNONLY: { L: 4.2, q: 0, s: 0, c: 0, g: 0, e: 0, db: 0 }, NOZN: { L: 0, q: 0.15, s: 0.15, c: 0.15, g: 0.10, e: 0.10, db: 0.15 } };
const perPlan = Object.fromEntries(M.costCompare(INP, { measured: MEASURED, plans: ["ZNONLY", "NOZN"], mults: [1], znRows: ZN, weightsBy: PLAN_W })
  .rows.map((r) => [`${r.plan}/${r.set}`, [r.worstMonth, r.worstMonthPct, r.annualReturnPct]]));
const rowKey = (r) => `${r.plan}/${r.set}/x${r.mult}`;
/** the block as frozen: the one line naming the cost file holds this run's temp path, so that path alone is normalised away */
const blockText = (WB.block || []).map((l) => l.split(ROOT).join("<tmp>")).join("\n");
const knownNow = {
  defaultStdoutSha: sha(R.base.out), defaultJsonSha: sha(J.base), measuredBlockSha: sha(blockText), measuredBlockLines: (WB.block || []).length,
  py: { E: JSON.parse(J.base).py.E.annualReturnPct, D2: JSON.parse(J.base).py.D2.annualReturnPct, worstE: JSON.parse(J.base).py.E.worstMonth, ddE: JSON.parse(J.base).py.E.maxDDmonthEndPct },
  measured: MEASURED, rows: Object.fromEntries((OM.measuredCosts ? OM.measuredCosts.rows : []).map((r) => [rowKey(r), [r.annualReturnPct, r.worstMonth, r.worstMonthPct, r.maxDDmonthEndPct]])),
  blockSpec: OM.measuredCosts ? OM.measuredCosts.spec : null, perPlanWorstMonth: perPlan,
};
if (FREEZE) {
  const s2 = F.loadSpec(); s2.known = knownNow;
  require(path.join(REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic(F.SPEC_FILE, s2, { pretty: 1 });
  console.log(`\nfixtures/fixture-spec.json "known" rewritten:\n${JSON.stringify(knownNow, null, 1)}\n(--freeze-known: no verdict line is printed)`);
  if (!KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(0);
}
check("known answers: the frozen block is there to check against", () => (spec.known && spec.known.rows && Object.keys(spec.known.rows).length === 12 ? true : "fixtures/fixture-spec.json has no frozen known answers (run --freeze-known once, and read what it writes)"));
if (spec.known && spec.known.rows) {
  check("known answers: the default stdout and JSON are the frozen ones", () => {
    const a = [];
    if (knownNow.defaultStdoutSha !== spec.known.defaultStdoutSha) a.push(`stdout sha ${knownNow.defaultStdoutSha.slice(0, 12)} != frozen ${String(spec.known.defaultStdoutSha).slice(0, 12)}`);
    if (knownNow.defaultJsonSha !== spec.known.defaultJsonSha) a.push(`json sha ${knownNow.defaultJsonSha.slice(0, 12)} != frozen ${String(spec.known.defaultJsonSha).slice(0, 12)}`);
    return a.length ? a.join("; ") : true;
  });
  check("known answers: the fixture still reproduces the baseline's own refereed numbers", () => {
    const d = JSON.parse(J.base), a = [];
    if (Math.abs(d.py.E.annualReturnPct - 24.24) >= 0.05) a.push(`E ${d.py.E.annualReturnPct}`);
    if (Math.abs(d.py.D2.annualReturnPct - 28.16) >= 0.05) a.push(`D2 ${d.py.D2.annualReturnPct}`);
    if (d.py.E.months !== 88) a.push(`${d.py.E.months} months`);
    return a.length ? a.join(", ") + " — the fixture no longer satisfies planE-baseline.js's own asserts" : true;
  });
  check("known answers: every row of the measured block equals the frozen row", () => {
    const bad = [];
    for (const [k, v] of Object.entries(spec.known.rows)) { const g = knownNow.rows[k]; if (!g) { bad.push(`${k} missing`); continue; } if (JSON.stringify(g) !== JSON.stringify(v)) bad.push(`${k} ${JSON.stringify(g)} != frozen ${JSON.stringify(v)}`); }
    for (const k of Object.keys(knownNow.rows)) if (!(k in spec.known.rows)) bad.push(`${k} is new`);
    return bad.length ? bad.join("; ") : true;
  });
  check("known answers: the printed measured block is the frozen text, line for line", () => {
    if (knownNow.measuredBlockSha === spec.known.measuredBlockSha) return true;
    return `the block is ${knownNow.measuredBlockLines} line(s), frozen ${spec.known.measuredBlockLines}; sha ${knownNow.measuredBlockSha.slice(0, 12)} != frozen ${String(spec.known.measuredBlockSha).slice(0, 12)}. The block as printed now:\n${blockText.split("\n").map((l) => "       | " + l).join("\n")}`;
  });
}

// ── 5. the arithmetic ────────────────────────────────────────────────────────────────────────────────────────────────────────
const rowsOf = (o) => Object.fromEntries(o.measuredCosts.rows.map((r) => [rowKey(r), r]));
const RS = rowsOf(OM);
check("arithmetic: assumed x1 reproduces the script's own PY table exactly (same rule, same windows, same cost)", () => {
  const d = JSON.parse(J.base), a = [];
  for (const p of ["E", "D2"]) { const r = RS[`${p}/assumed/x1`], s = d.py[p];
    if (r.annualReturnPct !== s.annualReturnPct) a.push(`${p} year ${r.annualReturnPct} != ${s.annualReturnPct}`);
    if (r.worstMonth !== s.worstMonth[0] || r.worstMonthPct !== s.worstMonth[1]) a.push(`${p} worst month ${r.worstMonth} ${r.worstMonthPct} != ${s.worstMonth.join(" ")}`);
    if (r.maxDDmonthEndPct !== s.maxDDmonthEndPct) a.push(`${p} worst drop ${r.maxDDmonthEndPct} != ${s.maxDDmonthEndPct}`); }
  return a.length ? a.join("; ") : true;
});
check("arithmetic: a measured file holding the ASSUMED rates reproduces the assumed rows exactly (the per-side / per-round-trip units)", () => {
  const r = run("staged", ["--measured-costs", costFile(ASSUMED_AS_FILE, "same-as-assumed.json")]);
  if (r.status !== 0) return `exit ${r.status}: ${r.err.trim().slice(0, 200)}`;
  const rs = rowsOf(JSON.parse(fs.readFileSync(OUTJSON("staged"), "utf8"))), bad = [];
  for (const p of ["E", "D2"]) for (const m of [1, 1.5, 2]) { const a = rs[`${p}/assumed/x${m}`], b = rs[`${p}/measured/x${m}`];
    for (const k of ["annualReturnPct", "worstMonth", "worstMonthPct", "maxDDmonthEndPct"]) if (a[k] !== b[k]) bad.push(`${p} x${m} ${k}: assumed ${a[k]} vs measured ${b[k]}`); }
  return bad.length ? bad.join("; ") : true;
});
check("arithmetic: costOpts(assumed) IS the model's own default pricing (0.0005 a flip, 0.0025 a switch)", () => {
  const o = M.costOpts(M.ASSUMED_COSTS);
  return Object.is(o.trendFlip, 0.0005) && Object.is(o.switchCost, 0.0025) ? true : `trendFlip ${o.trendFlip}, switchCost ${o.switchCost}`;
});
check("arithmetic: repriceZnRows at the carried rate moves no bit; at another rate it shifts every row by exactly the difference", () => {
  const same = M.repriceZnRows(ZN, M.ASSUMED_COSTS.znBpsPerRoundTrip);
  for (let i = 0; i < ZN.length; i++) if (!Object.is(same[i].tre, ZN[i].tre)) return `row ${ZN[i].m} moved: ${ZN[i].tre} -> ${same[i].tre}`;
  const dearer = M.repriceZnRows(ZN, M.ASSUMED_COSTS.znBpsPerRoundTrip + 2), d = 2 / 1e4;
  for (let i = 0; i < ZN.length; i++) if (!Object.is(dearer[i].tre, ZN[i].tre - d)) return `row ${ZN[i].m}: ${dearer[i].tre} != ${ZN[i].tre - d}`;
  if (same.length !== ZN.length || dearer.length !== ZN.length) return "the row count changed";
  return ZN.every((r, i) => same[i].m === r.m && same[i].tb === r.tb) ? true : "a month or its T-bill changed";
});
check("arithmetic: scaleCosts multiplies all three rates", () => {
  const s = M.scaleCosts(MEASURED, 1.5);
  return M.COST_KEYS.every((k) => Math.abs(s[k] - MEASURED[k] * 1.5) < 1e-12) ? true : JSON.stringify(s);
});
check("arithmetic: a dearer cost never raises the year (x1 > x1.5 > x2 on both sets, both plans)", () => {
  const bad = [];
  for (const p of ["E", "D2"]) for (const s of ["assumed", "measured"]) { const a = RS[`${p}/${s}/x1`].annualReturnPct, b = RS[`${p}/${s}/x1.5`].annualReturnPct, c = RS[`${p}/${s}/x2`].annualReturnPct; if (!(a > b && b > c)) bad.push(`${p}/${s}: ${a} ${b} ${c}`); }
  return bad.length ? bad.join("; ") : true;
});
// each leg on its own: one rate dearer than the assumed set, the other two at the assumed rate -> the year must fall
for (const [k, bump] of [["equityBpsPerSide", 10], ["cryptoBpsPerRoundTrip", 60], ["znBpsPerRoundTrip", 6]]) {
  check(`arithmetic: ${k} alone moves the answer (a leg that is read but never charged would not)`, () => {
    const f = { ...ASSUMED_AS_FILE, [k]: bump }, r = run("staged", ["--measured-costs", costFile(f, `one-leg-${k}.json`)]);
    if (r.status !== 0) return `exit ${r.status}: ${r.err.trim().slice(0, 200)}`;
    const rs = rowsOf(JSON.parse(fs.readFileSync(OUTJSON("staged"), "utf8"))), a = rs["E/assumed/x1"].annualReturnPct, b = rs["E/measured/x1"].annualReturnPct;
    return b < a ? true : `E stays at ${b} (assumed ${a}) when ${k} goes from ${ASSUMED_AS_FILE[k]} to ${bump} bps`;
  });
}
check("arithmetic: the x1.5 and x2 rows are the x1 cost multiplied, not a relabelled copy", () => {
  const bad = [];
  for (const p of ["E", "D2"]) for (const s of ["assumed", "measured"]) for (const m of [1.5, 2]) {
    const r = RS[`${p}/${s}/x${m}`], one = RS[`${p}/${s}/x1`];
    for (const k of M.COST_KEYS) if (Math.abs(r.bps[k] - one.bps[k] * m) > 1e-9) bad.push(`${p}/${s}/x${m} ${k} ${r.bps[k]} != ${one.bps[k] * m}`);
  }
  return bad.length ? bad.join("; ") : true;
});
check("arithmetic: the block prices the two plans and the three multiples and no more (12 rows)", () => {
  const rs = OM.measuredCosts.rows;
  if (rs.length !== 12) return `${rs.length} rows`;
  if (JSON.stringify(OM.measuredCosts.mults) !== "[1,1.5,2]") return `mults ${JSON.stringify(OM.measuredCosts.mults)}`;
  return rs.every((r) => r.months === 88) ? true : "a row does not cover the 88 months";
});
check("arithmetic: the work order's multiples (x1, x1.5, x2) are named once, in the library, and that is what the script asks for", () => {
  if (JSON.stringify(M.COST_MULTS) !== "[1,1.5,2]") return `COST_MULTS is ${JSON.stringify(M.COST_MULTS)}`;
  const lib = M.costCompare(INP, { measured: MEASURED, plans: ["E"], znRows: ZN });       // no mults given: the library's own default
  if (JSON.stringify(lib.mults) !== "[1,1.5,2]") return `costCompare defaults to ${JSON.stringify(lib.mults)}`;
  const want = JSON.stringify(M.COST_MULTS);
  return JSON.stringify(OM.measuredCosts.mults) === want ? true : `the script wrote ${JSON.stringify(OM.measuredCosts.mults)}, the library says ${want}`;
});
check("arithmetic: the library's costScenario agrees with the row the script wrote", () => {
  const s = M.costScenario(INP, { costs: M.scaleCosts(MEASURED, 1.5), plan: "E", znRows: ZN }), r = RS["E/measured/x1.5"];
  return s.annualReturnPct === r.annualReturnPct && s.worstMonth === r.worstMonth && s.maxDDmonthEndPct === r.maxDDmonthEndPct ? true : `${JSON.stringify([s.annualReturnPct, s.worstMonth, s.maxDDmonthEndPct])} vs ${JSON.stringify([r.annualReturnPct, r.worstMonth, r.maxDDmonthEndPct])}`;
});

check("arithmetic: the worst month is read PER PLAN (two plans whose worst months differ, through costCompare)", () => {
  // every plan of PYW holds the same leg mix at a different size, so on this fixture they all share one worst month, and a label taken
  // from plan E would look right. Two weight sets that do NOT share one are priced here instead: the note alone, and everything but
  // the note. Each row is held to the same plan priced on its own (costScenario).
  const got = perPlan;
  if (got["ZNONLY/measured"][0] === got["NOZN/measured"][0]) return `the two weight sets share the worst month ${got["ZNONLY/measured"][0]} — this check proves nothing on this fixture any more`;
  for (const set of ["assumed", "measured"]) for (const plan of ["ZNONLY", "NOZN"]) {
    const costs = M.scaleCosts(set === "assumed" ? M.ASSUMED_COSTS : MEASURED, 1);
    const s = M.costScenario(INP, { costs, weights: PLAN_W[plan], znRows: ZN }), g = got[`${plan}/${set}`];
    if (g[0] !== s.worstMonth || g[1] !== s.worstMonthPct || g[2] !== s.annualReturnPct) return `${plan}/${set}: the table says ${JSON.stringify(g)}, the plan priced on its own says ${JSON.stringify([s.worstMonth, s.worstMonthPct, s.annualReturnPct])}`;
  }
  const frozen = spec.known && spec.known.perPlanWorstMonth;
  if (frozen && JSON.stringify(got) !== JSON.stringify(frozen)) return `the rows moved from the frozen ones: ${JSON.stringify(got)} vs ${JSON.stringify(frozen)}`;
  return true;
});
check("measured: the JSON block's own spec tag is not the measured-cost FILE's spec tag (two tags a key apart are misread)", () => {
  if (OM.measuredCosts.spec === M.COST_SPEC) return `the block is tagged ${OM.measuredCosts.spec}, which is also the file format's tag`;
  if (OM.measuredCosts.read.spec !== M.COST_SPEC) return `the file's spec is recorded as ${OM.measuredCosts.read.spec}`;
  const frozen = spec.known && spec.known.blockSpec;
  return !frozen || OM.measuredCosts.spec === frozen ? true : `the block is tagged ${OM.measuredCosts.spec}, frozen ${frozen}`;
});

// ── 6. the refusals ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const BAD = [
  ["a wrong spec", { ...MEASURED, spec: "something-else" }, /spec must be/],
  ["no spec at all", (() => { const o = { ...MEASURED }; delete o.spec; return o; })(), /spec must be/],
  ["a missing rate", (() => { const o = { ...MEASURED }; delete o.znBpsPerRoundTrip; return o; })(), /znBpsPerRoundTrip is missing/],
  ["a misspelled rate", (() => { const o = { ...MEASURED }; delete o.equityBpsPerSide; o.equityBps = 3.4; return o; })(), /unknown key\(s\) equityBps/],
  ["a negative rate", { ...MEASURED, cryptoBpsPerRoundTrip: -1 }, /is negative/],
  ["a rate written as a string", { ...MEASURED, equityBpsPerSide: "3.4" }, /must be a finite number/],
  ["a rate given in percent by mistake", { ...MEASURED, znBpsPerRoundTrip: 5000 }, /above the 1000 bps/],
  ["a rate that is not a number at all", { ...MEASURED, znBpsPerRoundTrip: null }, /must be a finite number/],
  ["a note that is not a string", { ...MEASURED, note: 7 }, /note must be a string/],
  ["a JSON list instead of an object", [1, 2, 3], /not a JSON object/],
  ["text that is not JSON", "{ not json", /not JSON/],
  ["the same rate written twice (JSON.parse would keep the last)", '{ "spec": "planE-measured-costs-v1", "equityBpsPerSide": 99999, "equityBpsPerSide": 3.4, "cryptoBpsPerRoundTrip": 38, "znBpsPerRoundTrip": 6.5 }', /equityBpsPerSide is written 2 times/],
];
for (const [what, body, re] of BAD) {
  check(`refusal: ${what} is refused (exit 2, nothing written)`, () => {
    const before = fs.readFileSync(OUTJSON("staged"));
    const r = run("staged", ["--measured-costs", costFile(body, `bad-${sha(JSON.stringify(body) + what).slice(0, 8)}.json`)]);
    if (r.status !== 2) return `exit ${r.status} (expected 2); ${(r.err || r.out).trim().slice(0, 200)}`;
    if (!re.test(r.err)) return `the message does not say why: ${r.err.trim().slice(0, 200)}`;
    if (!/REFUSED/.test(r.err)) return `the message does not say REFUSED: ${r.err.trim().slice(0, 120)}`;
    if (!fs.readFileSync(OUTJSON("staged")).equals(before)) return "planE-baseline.json was written by a refused run";
    if (r.out.length) return `a refused run printed ${r.out.length} bytes on stdout`;
    return true;
  });
}
check("refusal: a measured-cost file that does not exist is refused (exit 2, nothing written)", () => {
  const before = fs.readFileSync(OUTJSON("staged")), r = run("staged", ["--measured-costs", path.join(ROOT, "no-such-file.json")]);
  if (r.status !== 2 || !/cannot be read/.test(r.err)) return `exit ${r.status}: ${(r.err || r.out).trim().slice(0, 200)}`;
  return fs.readFileSync(OUTJSON("staged")).equals(before) ? true : "planE-baseline.json was written";
});
for (const [what, args] of [["a stray argument", ["--fast"]], ["--measured-costs with no file", ["--measured-costs"]], ["a second argument", ["--measured-costs", "a.json", "b.json"]], ["a file name that looks like a switch", ["--measured-costs", "--oops"]]]) {
  check(`refusal: ${what} is refused with the usage (exit 2, nothing written)`, () => {
    const before = fs.readFileSync(OUTJSON("staged")), r = run("staged", args);
    if (r.status !== 2) return `exit ${r.status}`;
    if (!/usage: node backend\/profit-program\/planE-baseline\.js/.test(r.err)) return `no usage line: ${r.err.trim().slice(0, 160)}`;
    return fs.readFileSync(OUTJSON("staged")).equals(before) ? true : "planE-baseline.json was written";
  });
}
check("refusal: the base script ignores arguments, so the staged refusals are new behaviour on a new switch only", () => {
  const r = run("base", ["--measured-costs", MF]);
  return r.status === 0 ? true : `the base script exited ${r.status} on an argument it used to ignore — the comparison above would not be like for like`;
});
// ── 7. the write path of deploy.cjs and rollback.cjs, on a scratch repo (nothing in the real repo is touched) ─────────────────
const SR = path.join(ROOT, "scratch-repo"), SRF = (rel) => path.join(SR, ...rel.split("/"));
const putScratch = (which) => { for (const f of DEP.FILES) { const p = SRF(f.rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.copyFileSync(path.join(PKG, ...(which === "base" ? f.base : f.staged).split("/")), p); } };
const SAT = Date.parse("2026-10-17T23:00:00Z");          // a Saturday, 17:00 MT: the clock fence is clear
const MON = Date.parse("2026-10-19T16:00:00Z");          // a Monday, 10:00 MT: inside 05:30-16:00 MT
const okGate = { what: "a fake gate", run: () => ({ ok: true, line: "ALL 99 CHECKS PASSED (fake)" }) };
const deps = (over = {}) => ({ repo: SR, pkg: PKG, now: () => SAT, log: () => {}, listProcs: () => [], chainStatus: () => null, holidays: DEP.HOLIDAYS, run: () => { throw new Error("the write-path checks must never spawn a child"); }, ...over });
const scratchSha = (rel) => sha(fs.readFileSync(SRF(rel)));

check("deploy: the fences are clear on a Saturday with an empty process list, and each one refuses on its own", () => {
  putScratch("base");
  const clear = DEP.make(deps()).fences(); if (clear.length) return `the clear case refused: ${clear.join("; ")}`;
  const clock = DEP.make(deps({ now: () => MON })).fences();
  if (!clock.some((x) => /inside 05:30-16:00 MT/.test(x))) return `the clock fence did not fire on a Monday 10:00 MT: ${JSON.stringify(clock)}`;
  const proc = DEP.make(deps({ listProcs: () => [{ pid: 4321, cmd: `node ${SR}/backend/profit-program/planE-levers.js` }] })).fences();
  if (!proc.some((x) => /profit-program script is running/.test(x))) return `a running profit-program script did not refuse: ${JSON.stringify(proc)}`;
  const chainProc = DEP.make(deps({ listProcs: () => [{ pid: 99, cmd: "node automation/close-chain.cjs" }] })).fences();
  if (!chainProc.some((x) => /close chain is running/.test(x))) return `a running close chain did not refuse: ${JSON.stringify(chainProc)}`;
  const unreadable = DEP.make(deps({ listProcs: () => { throw new Error("ps died"); } })).fences();
  if (!unreadable.some((x) => /could not be read/.test(x))) return `an unreadable process list did not refuse (fail-closed): ${JSON.stringify(unreadable)}`;
  const chain = DEP.make(deps({ now: () => SAT, chainStatus: () => ({ started: new Date(SAT - 36e5).toISOString(), finished: null }) })).fences();
  if (!chain.some((x) => /close chain started/.test(x))) return `an unfinished close chain did not refuse: ${JSON.stringify(chain)}`;
  const done = DEP.make(deps({ chainStatus: () => ({ started: new Date(SAT - 36e5).toISOString(), finished: new Date(SAT - 18e5).toISOString() }) })).fences();
  return done.length ? `a FINISHED chain refused: ${done.join("; ")}` : true;
});
check("deploy: --apply writes both staged files on a scratch repo, and a rollback puts the base bytes back", () => {
  putScratch("base");
  const a = DEP.make(deps()).writeUnit({ to: "staged", gate: okGate });
  if (a.result !== "done" || a.written.length !== 2) return `apply: ${a.result} ${JSON.stringify(a.why || a.written)}`;
  for (const f of DEP.FILES) if (scratchSha(f.rel) !== f.stagedSha) return `after the apply ${f.rel} is ${scratchSha(f.rel).slice(0, 12)}, not the staged ${f.stagedSha.slice(0, 12)}`;
  if (!DEP.plan({ repo: SR, pkg: PKG }).applied) return "plan() does not read `applied` after the apply";
  const again = DEP.make(deps()).writeUnit({ to: "staged", gate: okGate });
  if (again.result !== "done" || again.written.length) return `a second apply wrote ${JSON.stringify(again.written)} (it must be a no-op)`;
  const b = require("./rollback.cjs").rollback(deps());
  if (b.result !== "done" || b.written.length !== 2) return `rollback: ${b.result} ${JSON.stringify(b.why || b.written)}`;
  for (const f of DEP.FILES) {
    if (scratchSha(f.rel) !== f.baseSha) return `after the rollback ${f.rel} is ${scratchSha(f.rel).slice(0, 12)}, not the base ${f.baseSha.slice(0, 12)}`;
    if (!fs.readFileSync(SRF(f.rel)).equals(fs.readFileSync(path.join(PKG, ...f.base.split("/"))))) return `${f.rel} is not byte-identical to base/${f.rel}`;
  }
  return true;
});
check("deploy: DRIFT at home refuses and writes nothing (apply and rollback both)", () => {
  putScratch("base");
  fs.appendFileSync(SRF(DEP.FILES[0].rel), "\n// someone changed this at home\n");
  const drifted = scratchSha(DEP.FILES[0].rel), P = DEP.plan({ repo: SR, pkg: PKG });
  if (!P.problems.some((x) => /is DRIFT at home/.test(x))) return `plan() does not call it DRIFT: ${JSON.stringify(P.problems)}`;
  for (const [what, r] of [["apply", DEP.make(deps()).writeUnit({ to: "staged", gate: okGate })], ["rollback", require("./rollback.cjs").rollback(deps())]]) {
    if (r.result !== "refused" || !r.why.some((x) => /DRIFT/.test(x))) return `${what}: ${r.result} ${JSON.stringify(r.why)}`;
  }
  if (scratchSha(DEP.FILES[0].rel) !== drifted) return "the drifted file was written anyway";
  return scratchSha(DEP.FILES[1].rel) === DEP.FILES[1].baseSha ? true : "the other file was written while one was DRIFT";
});
check("deploy: the two files are one unit — a half-applied pair refuses and writes nothing", () => {
  putScratch("base");
  fs.copyFileSync(path.join(PKG, ...DEP.FILES[0].staged.split("/")), SRF(DEP.FILES[0].rel));   // one applied, one base
  const P = DEP.plan({ repo: SR, pkg: PKG });
  if (!P.problems.some((x) => /different states/.test(x))) return `plan() allows the half-applied pair: ${JSON.stringify(P.problems)}`;
  const r = DEP.make(deps()).writeUnit({ to: "staged", gate: okGate });
  if (r.result !== "refused") return `apply: ${r.result}`;
  return scratchSha(DEP.FILES[0].rel) === DEP.FILES[0].stagedSha && scratchSha(DEP.FILES[1].rel) === DEP.FILES[1].baseSha ? true : "a refused apply wrote something";
});
check("deploy: a fence, a failing gate, or a fence that closes DURING the gate all refuse before anything is written", () => {
  putScratch("base");
  const fenced = DEP.make(deps({ now: () => MON })).writeUnit({ to: "staged", gate: okGate });
  if (fenced.result !== "refused" || !fenced.why.some((x) => /05:30-16:00 MT/.test(x))) return `the clock fence did not refuse the apply: ${fenced.result} ${JSON.stringify(fenced.why)}`;
  const badGate = DEP.make(deps()).writeUnit({ to: "staged", gate: { what: "a failing gate", run: () => ({ ok: false, why: "2 of 55 CHECKS FAILED" }) } });
  if (badGate.result !== "refused" || !badGate.why.some((x) => /did not pass/.test(x))) return `a failing gate did not refuse: ${badGate.result} ${JSON.stringify(badGate.why)}`;
  let t = SAT;                                                         // the clock walks into the fenced window while the gate runs
  const late = DEP.make(deps({ now: () => t })).writeUnit({ to: "staged", gate: { what: "a slow gate", run: () => { t = MON; return { ok: true, line: "ALL 99 CHECKS PASSED (fake)" }; } } });
  if (late.result !== "refused") return `the fences were not asked again after the gate: ${late.result}`;
  for (const f of DEP.FILES) if (scratchSha(f.rel) !== f.baseSha) return `${f.rel} was written by a refused apply`;
  return true;
});
check("deploy: a staged copy that does not match its declared sha refuses the apply but not the rollback", () => {
  putScratch("base");
  const fake = path.join(ROOT, "pkg-bad-staged");
  for (const e of ["deploy.cjs", "rollback.cjs"]) fs.cpSync(path.join(PKG, e), path.join(fake, e));
  for (const f of DEP.FILES) { for (const rel of [f.base, f.staged]) { const d = path.join(fake, ...rel.split("/")); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.join(PKG, ...rel.split("/")), d); } }
  fs.appendFileSync(path.join(fake, ...DEP.FILES[0].staged.split("/")), "\n// a staged copy nobody reviewed\n");
  const ap = DEP.plan({ repo: SR, pkg: fake });
  if (!ap.problems.some((x) => /staged copy/.test(x))) return `the apply plan accepts a changed staged copy: ${JSON.stringify(ap.problems)}`;
  const rp = DEP.plan({ repo: SR, pkg: fake, forRollback: true });
  if (rp.problems.some((x) => /staged copy/.test(x))) return `the rollback plan refuses on a changed staged copy: ${JSON.stringify(rp.problems)}`;
  fs.appendFileSync(path.join(fake, ...DEP.FILES[0].base.split("/")), "\n// a base copy nobody reviewed\n");
  const rp2 = DEP.plan({ repo: SR, pkg: fake, forRollback: true });
  return rp2.problems.some((x) => /base copy/.test(x)) ? true : `the rollback plan accepts a changed BASE copy: ${JSON.stringify(rp2.problems)}`;
});
check("deploy: writeExact leaves the file as the new bytes and reads them back", () => {
  const p = path.join(ROOT, "write-exact.txt"), buf = Buffer.from("one\ntwo\n");
  DEP.writeExact(p, buf);
  if (!fs.readFileSync(p).equals(buf)) return "the bytes do not read back";
  DEP.writeExact(p, Buffer.from("three\n"));
  return fs.readFileSync(p).toString() === "three\n" && !fs.readdirSync(ROOT).some((f) => /write-exact\.txt\.tmp/.test(f)) ? true : "a temp file was left behind, or the second write did not land";
});

const D_FILES_SHAS = () => DEP.FILES.flatMap((f) => [f.baseSha, f.stagedSha]);
check("record.cjs --dry prints both records, says it would be refused until the apply, and writes nothing", () => {
  const data = path.join(REPO, "backend", "data"), before = ["change-registry.json", "agent-ledger.jsonl", "registry-write.lock"].map((f) => { const p = path.join(data, f); return [f, fs.existsSync(p) ? sha(fs.readFileSync(p)) : null]; });
  const r = cp.spawnSync(process.execPath, [path.join(PKG, "record.cjs"), "--dry"], { cwd: REPO, encoding: "utf8", timeout: 300000 });
  if (r.status !== 0) return `exit ${r.status}: ${String(r.stderr).trim().slice(0, 200)}`;
  const o = String(r.stdout);
  if (!o.includes('"id": "capital-model-measured-cost-2026-10-16"')) return "the change-registry row is not printed";
  if (!/"kind":"GOVERNANCE"/.test(o)) return "the ledger line is not printed";
  if (!/DRY — nothing written/.test(o)) return "it does not say that nothing was written";
  for (const f of D_FILES_SHAS()) if (!o.includes(f)) return `the row does not carry the sha256 ${f.slice(0, 12)}`;
  for (const [f, s] of before) { const p = path.join(data, f), now = fs.existsSync(p) ? sha(fs.readFileSync(p)) : null; if (now !== s) return `${f} changed during a --dry run`; }
  return true;
});
check("library: parseMeasuredCosts names the file it refuses", () => {
  try { M.parseMeasuredCosts("{}", "/some/where.json"); return "it did not throw"; }
  catch (e) { return /\/some\/where\.json/.test(e.message) ? true : `the message does not name the file: ${e.message}`; }
});

// ── the verdict ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (KEEP) console.log(`\n(--keep) the trees are at ${ROOT}`); else fs.rmSync(ROOT, { recursive: true, force: true });
if (fails.length) { console.error(`\n${fails.length} of ${n} CHECKS FAILED:\n  - ${fails.join("\n  - ")}`); process.exit(1); }
console.log(`ALL ${n} CHECKS PASSED (${PKG_REL}/selftest.cjs, synthetic fixture, no network)`);
