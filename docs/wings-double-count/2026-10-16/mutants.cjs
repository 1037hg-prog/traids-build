#!/usr/bin/env node
"use strict";
/**
 * WINGS DOUBLE COUNT (2026-10-16) — MUTATION TESTS. Does the selftest actually hold the fix down?
 *
 * A test suite that passes proves nothing about the test suite. So this file breaks the staged code on
 * purpose, one named edit at a time, and requires the selftest to NOTICE. A mutant that SURVIVES — the
 * code is wrong and the selftest still passes — is a hole in the tests, and this script fails on it.
 *
 * HOW. The whole package is copied to a scratch directory, one find/replace is applied to one staged
 * file there, and that COPY's selftest is run with WDC_SECTIONS=ABC (the behavioural sections) and
 * WDC_REPO pointing back at this checkout for the two library files the package does not ship.
 * Sections D and E are left out on purpose: they compare the package's own sha256 manifest, so they
 * would kill every mutant for the wrong reason and tell us nothing about the behaviour tests.
 *
 * Each mutant names the check it must break. "killed" = the selftest failed (good). "SURVIVED" = it
 * passed with broken code (bad). "not applied" = the find string is no longer in the file, so the
 * mutant is stale and must be rewritten — also a failure, because an unapplied mutant tests nothing.
 *
 *   node docs/wings-double-count/2026-10-16/mutants.cjs            run them all
 *   node docs/wings-double-count/2026-10-16/mutants.cjs --id <id>  one of them
 *   node docs/wings-double-count/2026-10-16/mutants.cjs --list     names and targets only, run nothing
 * Exit 0 every mutant killed · 1 one or more survived or could not be applied · 2 usage.
 */
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");

const TR = "staged/backend/lib/ticket-rows.js", RC = "staged/backend/lib/reconcile.js";
const DP = "staged/backend/daily-postmortem.js", NS = "staged/backend/options-news-shadow.js", IA = "staged/backend/integrity-audit.js";

/** every mutant: a named one-line break, and what it must cost */
const MUTANTS = Object.freeze([
  { id: "pick-earliest-close", file: TR, breaks: "A2 / B / C — the surviving row would be the voided close",
    find: "if (Number.isFinite(r.closedAt) && (!Number.isFinite(group[at].closedAt) || r.closedAt > group[at].closedAt)) at = i;",
    with: "if (Number.isFinite(r.closedAt) && (!Number.isFinite(group[at].closedAt) || r.closedAt < group[at].closedAt)) at = i;" },
  { id: "drop-successor-stamp", file: TR, breaks: "A3 — only the stamp can get ticket s1 right",
    find: "  if (a.voidedPredecessor && a.voidedPredecessor === b.id && b.retired && a.restoredAfter === b.retired) return true;",
    with: "  if (false) return true;" },
  { id: "drop-void-rule", file: TR, breaks: "A2 and every wing count — the voided close would never be superseded",
    find: "  if (b.voidForEvidence === true && Number.isFinite(a.closedAt) && Number.isFinite(b.closedAt) && a.closedAt > b.closedAt) return true;",
    with: "  if (false) return true;" },
  { id: "never-report-ambiguous", file: TR, breaks: "A4 / A4b — an unexplained duplicate would be collapsed silently",
    find: "  return { row: group[at], at, dropped: group.filter((_, i) => i !== at), ambiguous: live.length !== 1 };",
    with: "  return { row: group[at], at, dropped: group.filter((_, i) => i !== at), ambiguous: false };" },
  { id: "ambiguous-only-on-ties", file: TR, breaks: "A4b — a duplicate the latest close merely tiebreaks would go unsaid",
    find: "  return { row: group[at], at, dropped: group.filter((_, i) => i !== at), ambiguous: live.length !== 1 };",
    with: "  const tied = pool.filter((i) => i !== at && (group[i].closedAt ?? null) === (group[at].closedAt ?? null));\n  return { row: group[at], at, dropped: group.filter((_, i) => i !== at), ambiguous: !live.length || tied.length > 0 };" },
  { id: "drop-idless-rows", file: TR, breaks: "A5 — a row with no id would vanish instead of passing through",
    find: "  const out = list.filter((r, i) => r && typeof r === \"object\" && (!r.id || keep.has(i)));",
    with: "  const out = list.filter((r, i) => r && typeof r === \"object\" && keep.has(i));" },
  { id: "collapse-keeps-every-row", file: TR, breaks: "A1/A6 and all of B and C — the collapse would do nothing",
    find: "  for (const [id, idx] of groups) {\n    const p = pickRow(idx.map((i) => list[i]));\n    keep.add(idx[p.at]);",
    with: "  for (const [id, idx] of groups) {\n    const p = pickRow(idx.map((i) => list[i]));\n    for (const i of idx) keep.add(i);" },
  { id: "canonical-read-uses-rows", file: RC, breaks: "B staged — the canonical read would count rows again",
    find: "  const collapse = collapseByTicket(rowsInFile);\n  const log = collapse.rows;",
    with: "  const collapse = collapseByTicket(rowsInFile);\n  const log = rowsInFile;" },
  { id: "rowsInFile-reports-tickets", file: RC, breaks: "B — 'rows in file' must keep meaning rows in the file",
    find: "    rowsInFile: rowsInFile.length, settled: settled.length,",
    with: "    rowsInFile: collapse.rows.length, settled: settled.length," },
  { id: "journal-lag-counts-rows", file: RC, breaks: "B journal — the two sides would be counted differently again",
    find: "  const settled = collapse.rows.filter((t) => t && t.id && t.closedAt && Number.isFinite(t.pnl));\n  const missing",
    with: "  const settled = file.filter((t) => t && t.id && t.closedAt && Number.isFinite(t.pnl));\n  const missing" },
  { id: "no-sealed-under-superseded", file: RC, breaks: "B journal — a ticket sealed under a superseded close would go unsaid",
    find: "  const journaledUnderSuperseded = settled.filter((t) => have.has(t.id) && have.get(t.id) !== (t.closedAt ?? null)).map((t) => t.id);",
    with: "  const journaledUnderSuperseded = [];" },
  { id: "drop-void-tag-ambiguity", file: RC, breaks: "B staged — the zero-count case would stop being surfaced",
    find: "    const affected = settled.filter((t) => t.retired && t.voidForEvidence === true && droppedById.has(t.id) && droppedById.get(t.id).retired === t.retired);",
    with: "    const affected = [];" },
  { id: "postmortem-uses-rows", file: DP, breaks: "C daily-postmortem staged — the epoch view would double count again",
    find: "  const collapse = collapseByTicket(rowsInFile);   // one row per ticket id — a wing closed twice is one wing\n  const log = collapse.rows;",
    with: "  const collapse = collapseByTicket(rowsInFile);   // one row per ticket id — a wing closed twice is one wing\n  const log = rowsInFile;" },
  { id: "postmortem-silent-collapse", file: DP, breaks: "C daily-postmortem staged — it must say what it collapsed",
    find: "  console.log(`  ledger: ${rowsInFile.length} rows · ${collapseLine(collapse)}`);",
    with: "  // the collapse is not reported" },
  { id: "news-shadow-arrival-order", file: NS, breaks: "C options-news-shadow append — arrival order would decide again",
    find: "const tickets = [...closedCollapse.rows.map((t) => ({ ...t, _state: \"closed\" })),",
    with: "const tickets = [...rd(\"trade_log.json\").map((t) => ({ ...t, _state: \"closed\" })),", },
  { id: "integrity-tripwire-rows", file: IA, breaks: "C integrity-audit staged — the tripwire would count rows",
    find: "const clean = tickets.filter(r => r.openedAt >= CLEAN", with: "const clean = rows.filter(r => r.openedAt >= CLEAN" },
  { id: "integrity-optsignal-rows", file: IA, breaks: "C integrity-audit staged — the blast-radius count would count rows",
    find: "const optSignal = tickets.filter(r => r.cls === \"Options\"", with: "const optSignal = rows.filter(r => r.cls === \"Options\"" },
  { id: "integrity-no-2b", file: IA, breaks: "C integrity-audit staged — section 2b would stop reporting duplicates",
    find: "  duplicateTickets: collapse.duplicates.slice(0, 50),", with: "  duplicateTickets: [], duplicateTicketIds: 0," },
]);

/** copy the package to a scratch dir, apply one mutant, run the copy's selftest on sections A B C */
function runMutant(m, root) {
  const dir = fs.mkdtempSync(path.join(root, m.id + "-"));
  fs.cpSync(PKG, dir, { recursive: true });
  const file = path.join(dir, ...m.file.split("/"));
  const text = fs.readFileSync(file, "utf8");
  const hits = text.split(m.find).length - 1;
  if (hits !== 1) return { id: m.id, verdict: "not applied", why: `its find string is in ${m.file} ${hits} times, not once — the mutant is stale`, dir };
  fs.writeFileSync(file, text.replace(m.find, m.with));
  const parse = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true });
  if (parse.status !== 0) return { id: m.id, verdict: "not applied", why: `the mutated ${m.file} does not parse — rewrite the mutant`, dir };
  const r = cp.spawnSync(process.execPath, [path.join(dir, "selftest.cjs")], { encoding: "utf8", timeout: 600000, windowsHide: true,
    env: { ...process.env, WDC_SECTIONS: "ABC", WDC_REPO: REPO } });
  const out = String(r.stdout || "") + String(r.stderr || "");
  const broke = out.split("\n").filter((l) => /^\s*FAIL\s/.test(l)).map((l) => l.trim());
  if (r.status === 0) return { id: m.id, verdict: "SURVIVED", why: "the selftest passed with this code broken", dir, out };
  return { id: m.id, verdict: "killed", broke, dir };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    console.log(`${MUTANTS.length} mutants:`);
    for (const m of MUTANTS) console.log(`  ${m.id.padEnd(28)} ${m.file.replace("staged/", "")}\n      must break: ${m.breaks}`);
    process.exit(0);
  }
  const only = args.indexOf("--id") >= 0 ? args[args.indexOf("--id") + 1] : null;
  if (args.some((a) => a !== "--id" && a !== only && a !== "--keep")) { console.log(`usage: node docs/wings-double-count/2026-10-16/mutants.cjs [--list | --id <id>] [--keep]\nNothing was done.`); process.exit(2); }
  const list = only ? MUTANTS.filter((m) => m.id === only) : MUTANTS;
  if (!list.length) { console.error(`no mutant named ${only}. --list shows them.`); process.exit(2); }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wdc-mutants-"));
  console.log(`MUTATION TESTS — ${list.length} mutant(s), each run against sections A B C of the selftest\n`);
  const bad = [];
  for (const m of list) {
    const r = runMutant(m, root);
    if (r.verdict === "killed") console.log(`  killed     ${m.id.padEnd(28)} ${r.broke.length} check(s) failed, first: ${(r.broke[0] || "").slice(0, 110)}`);
    else { bad.push(r); console.log(`  ${r.verdict}   ${m.id.padEnd(28)} ${r.why}\n      it should have broken: ${m.breaks}`); }
  }
  if (!args.includes("--keep")) fs.rmSync(root, { recursive: true, force: true });
  else console.log(`\nscratch kept: ${root}`);
  console.log("");
  if (bad.length) { console.log(`${bad.length} of ${list.length} MUTANT(S) NOT KILLED: ${bad.map((b) => `${b.id} (${b.verdict})`).join(", ")}\n  A surviving mutant is a hole in the tests, not a pass. Add the check it should have broken.`); process.exit(1); }
  console.log(`ALL ${list.length} MUTANTS KILLED — every deliberate break of the fix is caught by the selftest.`);
  process.exit(0);
}

module.exports = { MUTANTS, runMutant };
