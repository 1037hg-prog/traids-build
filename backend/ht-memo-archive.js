#!/usr/bin/env node
/**
 * HEAD-TRADER MEMO ARCHIVE — turns a one-session file into the memo-day ledger HT1 needs.
 * Built 2026-08-31.
 *
 * THE DEFECT. data/ht-memo-seal.json holds ONE object: { session, directives, memo, sealedAt }.
 * Every new seal overwrites the last, so the file has never held more than a single day. HT1 grades
 * MEMO-DAYS — the sealed WOULD-DO against the board as actually run — and its unit therefore never
 * accrued past one. The adjudicator already says so in its own output: "NO PERSISTENT MEMO-DAY
 * LEDGER EXISTS". The seat was not idle; its evidence was being erased nightly.
 *
 * WHY A SEPARATE FILE RATHER THAN MAKING THE SEAL AN ARRAY. lib/seat-authority.js reads
 * ht-memo-seal.json LIVE at the entry POST and expects exactly that object shape — the directives
 * in it are consumed, not shadowed. Changing the shape to satisfy a grader would change what the
 * enforcement path reads, which is the wrong trade in both directions. The live seal keeps its
 * contract; the history accrues beside it.
 *
 * IDEMPOTENT BY SESSION. Re-running appends nothing if that session is already archived, so it is
 * safe in the close chain, safe to run by hand, and safe to run twice. A session whose memo is
 * REVISED after archiving is appended again as a new row carrying supersedes: <prior sealedAt> —
 * rewriting the archived row would be editing history, which this file exists to prevent.
 *
 * Records only. Grades nothing, proposes nothing, changes no directive.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const SEAL = D("ht-memo-seal.json"), HIST = D("ht-memo-history.jsonl");

const seal = (() => { try { return JSON.parse(fs.readFileSync(SEAL, "utf8")); } catch { return null; } })();
if (!seal || !seal.session) {
  console.log("HT MEMO ARCHIVE — no sealed memo to archive (ht-memo-seal.json absent or has no session). Nothing written.");
  process.exit(0);
}

const prior = (() => {
  try { return fs.readFileSync(HIST, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); }
  catch { return []; }
})();

const sameSession = prior.filter((r) => r.session === seal.session);
const already = sameSession.some((r) => r.sealedAt === seal.sealedAt);

if (already) {
  console.log(`HT MEMO ARCHIVE — ${seal.session} already archived (sealedAt ${seal.sealedAt}). ${prior.length} memo-day row(s) on file.`);
  process.exit(0);
}

const row = {
  ...seal,
  archivedAt: new Date().toISOString(),
  ...(sameSession.length ? { supersedes: sameSession[sameSession.length - 1].sealedAt, revision: sameSession.length + 1 } : {}),
};
fs.appendFileSync(HIST, JSON.stringify(row) + "\n");

const rows = prior.length + 1;
const sessions = new Set([...prior, row].map((r) => r.session)).size;
console.log(`HT MEMO ARCHIVE — archived ${seal.session}${row.supersedes ? ` (revision ${row.revision}, supersedes ${row.supersedes})` : ""}`);
console.log(`  ht-memo-history.jsonl now ${rows} row(s) over ${sessions} memo-day(s) · ${seal.directives?.length || 0} directive(s) in this seal`);
console.log("  HT1 grades memo-DAYS; this is the ledger that unit accrues in. The live seal is untouched.");
