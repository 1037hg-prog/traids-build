#!/usr/bin/env node
/**
 * SEAL REPAIR — 2026-10-01 audit, group "seals". Dry by default; --apply writes backend/data/read-seals.json through
 * backend/lib/seal-merge.js (lock + fresh re-read + verified merge + writeJsonAtomic). Writes NOTHING else: the registry statuses that
 * go with these seals are returned to the main loop as registry notes (test-registry.json is not written here).
 *
 *  1. registry#1 — R220-R224. r220-r224-mine7.js sealed all five DID NOT PASS at 2026-09-25T04:31:16Z; r230-crypto-vote-sized.js, holding
 *     a copy of read-seals.json loaded before that, wrote it back at 04:31:44Z and erased them. Restored from the two surviving records,
 *     which must agree word for word: the GOVERNANCE seal-read rows in agent-ledger.jsonl and data/r220-r224-mine7.json. Seal shape is the
 *     one r220-r224-mine7.js:193 wrote ({sealedOn, unit: bar.unit, verdict}) plus the evidence it computed and a `restored` note.
 *     A key that already has a seal is never touched.
 *  2. stats#1 / registry#5 — R62. The 2026-09-29 seal holds the runner's constant status ("ACCRUING — …"). Its sealed evidence is kept
 *     exactly as is; a dated `correction` is added beside it applying the registered decision rule to that sealed evidence.
 *
 *   node docs/audit-fixes/2026-09-30/seals/repair-seals-0930.cjs           dry: prints every change
 *   node docs/audit-fixes/2026-09-30/seals/repair-seals-0930.cjs --apply   writes read-seals.json
 */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../../../..");
const D = (f) => path.join(ROOT, "backend", "data", f);
const SM = require(path.join(ROOT, "backend", "lib", "seal-merge.js"));
const APPLY = process.argv.includes("--apply");
const TODAY = "2026-10-01";

const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const E = (id) => reg.preregistered.find((t) => t.id === id);
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")).tests;
const ledger = fs.readFileSync(D("agent-ledger.jsonl"), "utf8").split(/\r?\n/).map((l, i) => { try { return { line: i + 1, ...JSON.parse(l) }; } catch { return null; } }).filter(Boolean);
const mine7 = JSON.parse(fs.readFileSync(D("r220-r224-mine7.json"), "utf8"));
const problems = [], adds = {}, notes = [];

// ── 1. R220-R224 ────────────────────────────────────────────────────────────────────────────
for (const id of ["R220", "R221", "R222", "R223", "R224"]) {
  if (seals[id]) { notes.push(`${id}: already sealed (${seals[id].sealedOn}) — left alone`); continue; }
  const rows = ledger.filter((r) => r.kind === "GOVERNANCE" && r.action === "seal-read" && r.test === id);
  const out = (mine7.results || {})[id] || {};
  if (rows.length !== 1) { problems.push(`${id}: expected exactly one seal-read ledger row, found ${rows.length}`); continue; }
  if (!out.verdict || out.verdict !== rows[0].verdict) { problems.push(`${id}: ledger verdict and r220-r224-mine7.json verdict disagree — refusing ("${rows[0].verdict}" vs "${out.verdict}")`); continue; }
  if (!/^DID NOT PASS|^PASS/.test(out.verdict)) { problems.push(`${id}: recovered text is not a verdict — refusing`); continue; }
  const e = E(id); if (!e) { problems.push(`${id}: not in the registry`); continue; }
  const { verdict, ...evidence } = out;
  adds[id] = { sealedOn: rows[0].ts.slice(0, 10), unit: (e.bar || {}).unit, verdict, evidence,
    restored: { on: TODAY, by: "docs/audit-fixes/2026-09-30/seals/repair-seals-0930.cjs (2026-09-30 audit, registry#1)",
      from: [`backend/data/agent-ledger.jsonl:${rows[0].line} (GOVERNANCE seal-read ${rows[0].ts})`, `backend/data/r220-r224-mine7.json (ranAt ${mine7.ranAt})`],
      why: "Sealed by r220-r224-mine7.js at 2026-09-25T04:31:16Z and erased 28 s later when r230-crypto-vote-sized.js wrote back a copy of read-seals.json loaded before that seal (a lost update; writeJsonAtomic prevents torn files, not lost updates). The verdict text is restored verbatim; nothing was re-computed or re-read." } };
}

// ── 2. R62 correction ───────────────────────────────────────────────────────────────────────
let r62 = null;
{
  const s = seals.R62, e = E("R62");
  const fail = String(((e || {}).decisionRule || {}).fail || "");
  if (!s) problems.push("R62: no seal to correct");
  else if (s.correction) notes.push(`R62: correction already present (${s.correction.date}) — left alone`);
  else if (!/^ACCRUING/.test(String(s.verdict))) problems.push(`R62: sealed text is no longer the ACCRUING string ("${String(s.verdict).slice(0, 60)}") — refusing to correct`);
  else if (!/t < 1\.732 at 20 episodes: DID NOT PASS/.test(fail)) problems.push(`R62: registry decisionRule.fail is not the text this correction applies ("${fail.slice(0, 80)}") — refusing`);
  else if (!(s.evidence && s.evidence.episodes === 20 && s.evidence.t === -1.13)) problems.push("R62: sealed evidence is not the 20-episode t -1.13 block — refusing");
  else {
    const ev = s.evidence;
    r62 = { date: TODAY,
      verdict: `DID NOT PASS — t ${ev.t} vs bar 1.732 at ${ev.episodes} overnight episodes (the sealed evidence: mean D ${ev.meanD}R per episode, ${ev.n} tickets)`,
      rule: `test-registry.json R62 decisionRule.fail: "${fail}"`,
      why: "The 2026-09-29 sweep sealed R62 from the runner's constant `status` field, so the seal froze the sentence \"ACCRUING — …\" instead of a verdict (read-seal-sweep.js row read `status`; r62-gap-exposure-twin.js had no verdict branch). The sample condition WAS met that night and the sealed evidence is kept unchanged; this applies the registered decision rule to that sealed evidence. It is not a re-read: the 21st and later episodes carry no weight.",
      interimKillCheck: "Registered kill-only look at 10 episodes (mean D negative with t <= -1.0). As-of evidence that night (nightly snapshot 8a13cf19e, 2026-09-15): 10 episodes, mean D -0.0376, t -0.938 — the kill did NOT fire. Today's re-derived pairs give t -1.001 for the same first 10 episodes; pairs are re-derived nightly from bars and the ledger, so the as-of number is the one that counts. The runner never implemented the look; it does from 2026-10-01.",
      drift: "Re-deriving the same first 20 episodes from 2026-09-30 pairs gives t -1.017 (meanD -0.0241) against the sealed -1.13; read-seals.json holds the value that counts.",
      by: "docs/audit-fixes/2026-09-30/seals/repair-seals-0930.cjs (2026-09-30 audit, stats#1 / registry#5)" };
  }
}

console.log("SEAL REPAIR — " + (APPLY ? "APPLY" : "DRY (nothing written; --apply writes backend/data/read-seals.json)"));
for (const [id, s] of Object.entries(adds)) console.log(`  RESTORE ${id}: sealedOn ${s.sealedOn} · unit "${s.unit}" · ${s.verdict}\n           evidence ${JSON.stringify(s.evidence).slice(0, 300)}\n           from ${s.restored.from.join(" + ")}`);
if (r62) console.log(`  CORRECT R62 (seal of ${seals.R62.sealedOn} kept unchanged; correction added): ${r62.verdict}\n           ${r62.rule}`);
for (const n of notes) console.log("  note: " + n);
for (const p of problems) console.log("  PROBLEM: " + p);
if (problems.length) { console.log(`UNKNOWN — ${problems.length} problem(s); nothing written.`); process.exit(3); }
if (!Object.keys(adds).length && !r62) { console.log("nothing to do."); process.exit(0); }
if (APPLY) {
  SM.mergeSeals((T) => {
    for (const [id, s] of Object.entries(adds)) if (!T[id]) T[id] = s;
    if (r62 && T.R62 && !T.R62.correction) T.R62.correction = r62;
  }, { allowEdit: r62 ? ["R62"] : [] });
  const after = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")).tests;
  const ok = Object.keys(adds).every((id) => after[id] && after[id].verdict === adds[id].verdict) && (!r62 || (after.R62.correction && after.R62.verdict === seals.R62.verdict && JSON.stringify(after.R62.evidence) === JSON.stringify(seals.R62.evidence)));
  console.log(ok ? `written and verified: ${Object.keys(adds).length} seal(s) restored${r62 ? ", R62 correction added (sealed text and evidence unchanged)" : ""}; ${Object.keys(after).length} seals in the file.` : "VERIFY FAILED after write — inspect backend/data/read-seals.json");
  if (!ok) process.exit(3);
}
