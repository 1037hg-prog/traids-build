#!/usr/bin/env node
/**
 * TRAIDS TEST RUNNER — 2026-08-06.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE ORGANISING IDEA: THE DEFECT LOG, MADE EXECUTABLE.
 *
 * This project has logged 48 defects, 32 of them FLATTERING — errors that made a result look
 * better than it was. Every one was found by a human noticing something, sometimes weeks later.
 * The week of 2026-08-03 is what that costs: a vacuous wait condition and a count-vs-set
 * confusion between them destroyed four sessions of forward evidence while every diagnostic
 * reported green.
 *
 * So the suite is not organised by module. It is organised by DEFECT. Each test names the
 * defect it locks down, reproduces the exact failure, and asserts the fixed behaviour. A defect
 * without a test is a defect that is free to come back.
 *
 * WHY NO FRAMEWORK. The project is deliberately dependency-light — every statistic is
 * implemented from its definition so it can be interrogated when it disagrees with intuition.
 * A test runner is 30 lines; adding jest to get them is a poor trade, and a framework that
 * needs configuring is a framework that stops being run.
 *
 *   node backend/test/run.js              all suites
 *   node backend/test/run.js stats        only suites matching "stats"
 */
const fs = require("fs"), path = require("path");

let passed = 0, failed = 0, current = "";
const failures = [];

function suite(name, fn) {
  const filter = process.argv[2];
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;
  current = name;
  console.log(`\n  ${name}`);
  fn();
}

function test(what, fn) {
  try {
    fn();
    passed++;
    console.log(`    ok   ${what}`);
  } catch (e) {
    failed++;
    failures.push({ suite: current, what, msg: e.message });
    console.log(`    FAIL ${what}`);
    console.log(`         ${e.message}`);
  }
}

// Assertions kept explicit rather than clever — a failing test must say what it expected.
const eq = (got, want, msg) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${msg || "not equal"}\n           expected: ${JSON.stringify(want)}\n           got:      ${JSON.stringify(got)}`);
  }
};
const close = (got, want, tol, msg) => {
  if (!Number.isFinite(got) || Math.abs(got - want) > tol) {
    throw new Error(`${msg || "not close"}: expected ${want} +/- ${tol}, got ${got}`);
  }
};
const ok = (cond, msg) => { if (!cond) throw new Error(msg || "expected truthy"); };
const throws = (fn, msg) => {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(msg || "expected it to throw, it did not");
};

module.exports = { suite, test, eq, close, ok, throws };

// ── load every *.test.js in this directory ──────────────────────────────────────────────────
if (require.main === module) {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".test.js")).sort();
  console.log(`TRAIDS TEST SUITE — ${files.length} file(s)`);
  console.log(`Organised by DEFECT: each test locks down a specific logged failure.`);
  for (const f of files) require(path.join(dir, f));

  console.log(`\n${"─".repeat(70)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`\n  FAILURES:`);
    for (const f of failures) console.log(`    ${f.suite} :: ${f.what}\n      ${f.msg.split("\n")[0]}`);
  }
  process.exit(failed ? 1 : 0);
}
