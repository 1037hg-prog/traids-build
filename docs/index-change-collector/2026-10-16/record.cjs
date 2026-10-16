#!/usr/bin/env node
"use strict";
/**
 * INDEX CHANGE COLLECTOR (2026-10-16) — RECORD: the one change-registry row and the one agent-ledger
 * line that say this collector exists at home.
 *
 *   node docs/index-change-collector/2026-10-16/record.cjs --dry    READ-ONLY: prints both, writes nothing
 *   node docs/index-change-collector/2026-10-16/record.cjs          writes them (home only)
 *
 * IT REGISTERS NO TEST. Backlog row 14 is collection: a recorder and its file, nothing that is scored
 * and nothing that is traded. There is no rule, no bar, no population and no read condition here, so
 * there is nothing to pre-register, and test-registry.json is NOT touched — not read, not written. A
 * test that one day uses these rows is registered then, on its own terms, by its own script.
 *
 * It refuses unless all three shipped files are applied at home (deploy.cjs --apply first) and the
 * collector's own --selftest is green, so the row cannot claim something that is not there.
 *
 * In the cloud copy of this repository there is no backend/data/, so the write mode refuses and says so;
 * --dry works anywhere and is what a build session runs.
 *
 * Exit 0 written, or printed under --dry · 1 failed · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process");
const L = require("./lib.cjs");

const DATE = "2026-10-16";
const D = (f) => path.join(L.REPO, "backend", "data", f);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
if (args.some((a) => a !== "--dry")) { console.log(`usage: node ${L.PKG_REL}/record.cjs [--dry]\nNothing was done.`); process.exit(2); }

const P = L.plan();
const shas = {};
for (const x of P.files) shas[x.rel] = x.home;

/** the collector's own known-answer checks, as the evidence the row cites */
function collectorSelftest() {
  const f = path.join(L.REPO, "backend", "index-change-collector.js");
  if (!fs.existsSync(f)) return { ok: false, line: "backend/index-change-collector.js is not at home" };
  const r = cp.spawnSync(process.execPath, [f, "--selftest"], { encoding: "utf8", windowsHide: true, timeout: 300000 });
  const last = String(r.stdout || "").trim().split("\n").pop() || "";
  return { ok: r.status === 0 && /^ALL \d+ CHECKS PASSED$/.test(last), line: last || `exit ${r.status}` };
}
/**
 * This package's selftest, as the evidence for the staged bytes.
 *
 * selftest.cjs runs `record.cjs --dry` as one of its own checks, so it sets ICC_NESTED=1 to stop this
 * running it back and recursing forever. A nested run reports the selftest as skipped, which the write
 * mode treats as "not green" — the write mode is the operator's command and is never nested.
 */
function packageSelftest() {
  if (process.env.ICC_NESTED === "1") return { ok: null, line: "skipped: this run was started BY selftest.cjs (ICC_NESTED=1), which is running those checks itself" };
  const r = cp.spawnSync(process.execPath, [path.join(L.PKG, "selftest.cjs")], { cwd: L.REPO, encoding: "utf8", windowsHide: true, timeout: 900000 });
  const last = String(r.stdout || "").trim().split("\n").pop() || "";
  return { ok: r.status === 0 && /^ALL \d+ CHECKS PASSED$/.test(last), line: last || `exit ${r.status}` };
}

const pkgTest = packageSelftest();
const liveTest = P.applied ? collectorSelftest() : { ok: false, line: "not applied at home yet" };

const crRow = {
  id: `index-change-collector-${DATE}`,
  date: DATE,
  recordedAt: Date.now(),
  area: "tooling — index change collector (backlog row 14, the first forced-flow collector)",
  category: "tooling",
  breaksComparability: false,
  change: `Three NEW files at home: backend/lib/index-changes.js (parse layer: saved announcement page text -> rows; no fs, no network, no clock), backend/lib/index-changes-fetch.js (fetch layer: an injected fetcher only, no network client in it) and backend/index-change-collector.js (wiring; writes ${L.DATA_DIR}/index-changes-<collection date>.jsonl through lib/atomic-write.js, plus a .pages.json sidecar holding each page's sha256, byte length and fetch time). It records announced S&P 500 / MidCap 400 / SmallCap 600 and Nasdaq-100 ADDITIONS and DELETIONS with the date each was ANNOUNCED and the date it becomes EFFECTIVE, from public announcement pages. The two dates are separate blocks on every row and there is no scalar date key; knownAt reads the announcement only, visibleAsOf() is the point-in-time reader and looks at nothing else, and effectiveOn() refuses to run without an explicit asOf. A page with no announcement date produces NO rows. No existing file was changed.`,
  why: `backend/index-recon-test.js (#53) reads a list of EFFECTIVE dates and assumes in a comment that announcements precede them by roughly a week. The concession in an index change is paid between the announcement and the effective date, so a window anchored on the wrong date either misses the move or trades on information nobody had. This collector records both dates, at collection time, from the page that stated them, and makes it structurally hard to use one as the other.`,
  doesNotEstablish: "Anything about index-change returns. No test is registered, no rule, bar, population or read condition exists here, and nothing trades or is scored on these rows.",
  operator: `operator ${DATE} (backlog row 14: "the first forced-flow collector")`,
  files: ["backend/lib/index-changes.js", "backend/lib/index-changes-fetch.js", "backend/index-change-collector.js"],
  sha256: shas,
  evidence: { packageSelftest: pkgTest.line, collectorSelftest: liveTest.line, fixtures: `${L.PKG_REL}/fixtures/ (FICTIONAL pages: invented companies, invented tickers, example.invalid URLs)` },
  writes: [`${L.DATA_DIR}/index-changes-<collection date>.jsonl (append-only; a row already on file is not written twice)`, `${L.DATA_DIR}/index-changes-<collection date>.pages.json (provenance)`],
  registersNoTest: true,
  package: L.PKG_REL,
};

const ledgerLine = {
  ts: new Date().toISOString(),
  kind: "GOVERNANCE",
  actor: "assistant on operator instruction",
  action: "tooling",
  tests: [],
  detail: `index change collector applied (backlog row 14): announced S&P 500/400/600 and Nasdaq-100 additions and deletions to ${L.DATA_DIR}/index-changes-<date>.jsonl, announcement date and effective date kept in separate blocks; no test registered`,
  files: crRow.files,
  sha256: shas,
  packageSelftest: pkgTest.line,
  collectorSelftest: liveTest.line,
};

if (DRY) {
  console.log(`RECORD — index change collector — DRY RUN (nothing is written)`);
  console.log(`  state at home: ${P.files.map((x) => `${x.rel} ${x.state}`).join(" · ")}`);
  console.log(`  this package's selftest: ${pkgTest.ok === true ? pkgTest.line : pkgTest.ok === null ? pkgTest.line : "NOT GREEN — " + pkgTest.line}`);
  console.log(`  the collector's own --selftest at home: ${liveTest.ok ? liveTest.line : "NOT GREEN — " + liveTest.line}`);
  console.log(`  test-registry.json: NOT read and NOT written — this change registers no test.`);
  console.log(`  would append to change-registry.json:\n${JSON.stringify(crRow, null, 1)}`);
  console.log(`  would append to agent-ledger.jsonl:\n${JSON.stringify(ledgerLine)}`);
  process.exit(0);
}

const refusals = [];
if (P.problems.length) refusals.push(...P.problems);
if (!P.applied) refusals.push(`not every path is applied at home (${P.files.map((x) => `${x.rel} ${x.state}`).join(", ")}) — run deploy.cjs --apply first`);
if (pkgTest.ok !== true) refusals.push(`this package's selftest is not green: ${pkgTest.line}`);
if (!liveTest.ok) refusals.push(`the collector's own --selftest at home is not green: ${liveTest.line}`);
const cr = readJson(D("change-registry.json"));
if (!Array.isArray(cr)) refusals.push("backend/data/change-registry.json is not there, or is not an array — this is the code-only copy of the repository; the write mode runs at home");
if (refusals.length) { console.error(`REFUSED — nothing written:\n  - ${refusals.join("\n  - ")}`); process.exit(2); }

if (cr.some((r) => r && r.id === crRow.id)) { console.log(`already recorded: change-registry row ${crRow.id} is on file. Nothing written.`); process.exit(0); }
const { writeJsonAtomic } = require(path.join(L.REPO, "backend", "lib", "atomic-write.js"));
cr.push(crRow);
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify(ledgerLine) + "\n");
console.log(`RECORDED: change-registry row ${crRow.id}, and one GOVERNANCE line in agent-ledger.jsonl. test-registry.json untouched — no test was registered.`);
process.exit(0);
