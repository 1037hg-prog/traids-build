#!/usr/bin/env node
"use strict";
/**
 * CAPITAL MODEL — MEASURED COST (2026-10-16) — MUTANTS: break the staged code on purpose, one small change at a time, and show that
 * selftest.cjs catches every one. A check that no mutant can kill is a check that proves nothing.
 *
 *   node docs/capital-model-measured-cost/2026-10-16/mutants.cjs              run them all (exit 1 if any mutant SURVIVES)
 *   node docs/capital-model-measured-cost/2026-10-16/mutants.cjs --only <id>  run one
 *   node docs/capital-model-measured-cost/2026-10-16/mutants.cjs --list       print the list and do nothing
 *   node docs/capital-model-measured-cost/2026-10-16/mutants.cjs --keep       leave the mutant trees on disk
 *
 * HOW: nothing in the repo is touched. Each mutant gets its own temp mini-repo — the four live files the package and its fixture read,
 * plus a copy of this package — the mutation is applied to the COPY's staged file, the copy's deploy.cjs is re-stamped with the mutated
 * sha256 (so the mutant is killed by a real check and not by the sha), and the copy's selftest is run. A mutant is KILLED when that
 * selftest exits non-zero; the first FAIL line it printed is shown as the cause.
 */
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", ".."), PKG_REL = "docs/capital-model-measured-cost/2026-10-16";
const MODEL = "staged/backend/profit-program/planE-model.js", BASELINE = "staged/backend/profit-program/planE-baseline.js";
const LIVE = ["backend/profit-program/planE-model.js", "backend/profit-program/planE-baseline.js", "backend/lib/atomic-write.js", "backend/lib/run-window.js", "backend/risk-manager.js"];

/** every mutant: a single, plausible slip. `from` must appear exactly once in the file. */
const MUTANTS = Object.freeze([
  { id: "equity-unit", file: MODEL, why: "the equity rate is charged as if a flip were a round trip (half the cost)",
    from: "trendFlip: c.equityBpsPerSide / 1e4", to: "trendFlip: c.equityBpsPerSide / 2 / 1e4" },
  { id: "crypto-unit", file: MODEL, why: "the crypto round trip is charged at every switch (twice the cost)",
    from: "switchCost: c.cryptoBpsPerRoundTrip / 2 / 1e4", to: "switchCost: c.cryptoBpsPerRoundTrip / 1e4" },
  { id: "zn-sign", file: MODEL, why: "the ZN re-pricing has its sign the wrong way round (a dearer note makes more money)",
    from: "const d = (carriedBps - bps) / 1e4;", to: "const d = (bps - carriedBps) / 1e4;" },
  { id: "zn-not-identity", file: MODEL, why: "the ZN rows are rebuilt as tre + carried - bps even at the carried rate (the last bit moves)",
    from: "return rows.map((r) => (d === 0 ? { ...r } : { ...r, tre: r.tre + d }));", to: "return rows.map((r) => ({ ...r, tre: r.tre + carriedBps / 1e4 - bps / 1e4 }));" },
  { id: "zn-ignored", file: MODEL, why: "the measured ZN rate is read and then never applied",
    from: "const rows = repriceZnRows(znRows || znWindows(), costs.znBpsPerRoundTrip);", to: "const rows = (znRows || znWindows()).map((r) => ({ ...r }));" },
  { id: "zn-ignored-table", file: MODEL, why: "the table's own scenarios keep the assumed ZN rate",
    from: "znRows: repriceZnRows(base, costs.znBpsPerRoundTrip)", to: "znRows: repriceZnRows(base, ASSUMED_COSTS.znBpsPerRoundTrip)" },
  { id: "cost-ignored", file: MODEL, why: "every scenario is priced at the assumed rates whatever the file says",
    from: "const costs = scaleCosts(c0, mult), b = pyBuild(inp, { asOf,", to: "const costs = scaleCosts(ASSUMED_COSTS, mult), b = pyBuild(inp, { asOf," },
  { id: "mult-wrong", file: MODEL, why: "the sensitivity multiple is 1.4 instead of 1.5",
    from: "const COST_MULTS = Object.freeze([1, 1.5, 2]);", to: "const COST_MULTS = Object.freeze([1, 1.4, 2]);" },
  { id: "mult-wrong-cli", file: BASELINE, why: "the script asks for its own multiples instead of the library's",
    from: "mults: M.COST_MULTS", to: "mults: [1, 1.4, 2]" },
  { id: "scale-misses-zn", file: MODEL, why: "the multiple is applied to two legs and not to the note",
    from: "const scaleCosts = (c, k) => Object.freeze(Object.fromEntries(COST_KEYS.map((q) => [q, c[q] * k])));",
    to: "const scaleCosts = (c, k) => Object.freeze(Object.fromEntries(COST_KEYS.map((q) => [q, q === \"znBpsPerRoundTrip\" ? c[q] : c[q] * k])));" },
  { id: "labels-swapped", file: MODEL, why: "the assumed and the measured rows are labelled the wrong way round",
    from: '[["assumed", assumed], ["measured", measured]]', to: '[["measured", assumed], ["assumed", measured]]' },
  { id: "unknown-key-allowed", file: MODEL, why: "a misspelled rate is accepted and the leg quietly keeps the assumed cost",
    from: "if (unknown.length) bad(", to: "if (false && unknown.length) bad(" },
  { id: "negative-allowed", file: MODEL, why: "a negative cost is accepted",
    from: "if (v < 0) bad(", to: "if (v < -1e9) bad(" },
  { id: "string-rate-allowed", file: MODEL, why: "a rate written as a string is coerced instead of refused",
    from: 'if (typeof v !== "number" || !Number.isFinite(v)) bad(', to: "if (!Number.isFinite(Number(v))) bad(" },
  { id: "spec-not-checked", file: MODEL, why: "any JSON file is accepted as a measured-cost file",
    from: "if (j.spec !== COST_SPEC) bad(", to: "if (false) bad(" },
  { id: "block-always", file: BASELINE, why: "the measured block is printed even with no file given",
    from: "  if (MC) {", to: "  if (MC || true) {" },
  { id: "key-always", file: BASELINE, why: "the measuredCosts key is written even with no file given",
    from: "  writeJsonAtomic(OUT, out);", to: '  out.measuredCosts = out.measuredCosts || { spec: "planE-measured-cost-v1" };\n  writeJsonAtomic(OUT, out);' },
  { id: "py-overwritten", file: BASELINE, why: "the measured run overwrites the headline py.E number risk-manager.js reads",
    from: "    out.measuredCosts = { spec:", "to": "    out.py.E.annualReturnPct = cmp.rows[3].annualReturnPct;\n    out.measuredCosts = { spec:" },
  { id: "refusal-exits-zero", file: BASELINE, why: "a bad measured-cost file is reported and then ignored",
    from: "process.exit(2); } }", to: "console.error('(carrying on)'); } }" },
  { id: "block-after-write", file: BASELINE, why: "the block is printed after the file is written, so a reader cannot tell which run wrote it",
    from: "  writeJsonAtomic(OUT, out); console.log(`\\nwrote ${path.relative(process.cwd(), OUT)}`);",
    to: "  writeJsonAtomic(OUT, out); console.log(`\\nwrote ${path.relative(process.cwd(), OUT)}`);\n  if (MC) for (const l of M.costTableLines(M.costCompare(inp, { measured: MC.costs, znRows: M.znWindows() }))) console.log(l);" },
]);

const a = process.argv.slice(2), only = a.includes("--only") ? a[a.indexOf("--only") + 1] : null, KEEP = a.includes("--keep");
if (a.includes("--list")) { for (const m of MUTANTS) console.log(`  ${m.id.padEnd(22)} ${path.basename(m.file)}  ${m.why}`); process.exit(0); }
const list = only ? MUTANTS.filter((m) => m.id === only) : MUTANTS;
if (!list.length) { console.error(`no mutant called ${only}; --list shows them`); process.exit(2); }

const copyDir = (from, to) => { fs.mkdirSync(to, { recursive: true }); for (const e of fs.readdirSync(from, { withFileTypes: true })) { const s = path.join(from, e.name), d = path.join(to, e.name); if (e.isDirectory()) copyDir(s, d); else if (e.isFile()) fs.copyFileSync(s, d); } };
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cmmc-mutants-"));
console.log(`mutants — ${PKG_REL}  (${list.length} of ${MUTANTS.length})\n  trees: ${ROOT}`);

const survived = [], killed = [];
for (const m of list) {
  const tree = path.join(ROOT, m.id), pkg = path.join(tree, ...PKG_REL.split("/"));
  for (const rel of LIVE) { const d = path.join(tree, ...rel.split("/")); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.join(REPO, ...rel.split("/")), d); }
  copyDir(PKG, pkg);
  const target = path.join(pkg, ...m.file.split("/")), text = fs.readFileSync(target, "utf8"), hits = text.split(m.from).length - 1;
  if (hits !== 1) { survived.push(`${m.id}: its anchor is in ${m.file} ${hits} times, not once — the mutant could not be made`); console.log(`BAD  ${m.id.padEnd(22)} anchor appears ${hits} times`); continue; }
  fs.writeFileSync(target, text.replace(m.from, m.to));
  const st = cp.spawnSync(process.execPath, [path.join(pkg, "stamp.cjs"), "--write"], { encoding: "utf8" });
  if (st.status !== 0) { survived.push(`${m.id}: the mutant package could not be re-stamped (${String(st.stderr).trim().slice(0, 160)})`); console.log(`BAD  ${m.id.padEnd(22)} stamp failed`); continue; }
  const r = cp.spawnSync(process.execPath, [path.join(pkg, "selftest.cjs")], { cwd: tree, encoding: "utf8", timeout: 1800000, maxBuffer: 256 << 20 });
  const out = String(r.stdout || "") + String(r.stderr || ""), first = (out.split("\n").find((l) => l.startsWith("FAIL ")) || "").slice(5, 150);
  if (r.status === 0) { survived.push(`${m.id} SURVIVED (${m.why}) — no check noticed it`); console.log(`SURVIVED  ${m.id.padEnd(18)} ${m.why}`); }
  else { killed.push(m.id); console.log(`killed    ${m.id.padEnd(18)} by: ${first || `exit ${r.status}`}`); }
}
if (!KEEP) fs.rmSync(ROOT, { recursive: true, force: true }); else console.log(`(--keep) the mutant trees are at ${ROOT}`);
if (survived.length) { console.error(`\n${survived.length} of ${list.length} MUTANTS SURVIVED:\n  - ${survived.join("\n  - ")}`); process.exit(1); }
console.log(`ALL ${killed.length} MUTANTS KILLED by ${PKG_REL}/selftest.cjs`);
