#!/usr/bin/env node
/**
 * R49 / R53 GATE READ — a RELAY, not a calculation. Writes data/r49-r53-gate-read.json.
 *
 * WHAT THIS FILE USED TO DO, AND WHY IT WAS WRONG (rewritten 2026-08-28 after a code review).
 *
 * It re-derived both registered statistics itself, and got both wrong:
 *
 *   R53 — it keyed episodes on `cls|openedAt|closedAt`, an exact instant. A refused shadow is a
 *   DIFFERENT candidate arriving after the kept ticket that consumed its factor budget, so it
 *   never shared a key with that ticket. Every cross-time refusal therefore landed in a
 *   shadow-only cell with kept = [] and cappedR = 0 — meaning meanCappedEpisodeR reported 0.0000
 *   no matter what the capped book did, and meanGapR degenerated to minus the mean shadow R. The
 *   registered unit is one (factor group x entry session) cell carrying a refusal, which is what
 *   r53-factor-cap.js has always computed correctly. Worse, N refusal instants in ONE group on
 *   ONE session counted as N episodes, so `pairs.length >= 20` could flip the surface to "AT READ
 *   CONDITION" long before the registered sample existed.
 *
 *   R49 — it emitted `dayT(eqKept, r => r.rMult)`, the day-clustered t of the KEPT book's GROSS
 *   return, and printed it beside the text "bar: t>=1.724". That is neither registered statistic.
 *   The registered PRIMARY is per-entry-day D = mean costR(UNGATED) - mean costR(KEPT), and the
 *   mandatory paired DIAGNOSTIC is G = mean gross rMult(REFUSED) - mean gross rMult(KEPT). A lucky
 *   run in the kept book could have shown t 1.9 next to a 1.724 bar while the gate was RAISING
 *   cost, and a reader would have called that a pass.
 *
 * WHY A RELAY IS THE FIX RATHER THAN BETTER ARITHMETIC. test-registry.json names
 * backend/r49-spread-gate.js and backend/r53-factor-cap.js as the scripts for these tests. Those
 * files compute the registered statistics; this one guessed at them. Two implementations of one
 * statistic will always drift, and the wrong one had already been named as the BINDING TEST by
 * the authority-unlock candidates in backend/pipeline.js. So this file now computes NOTHING. It
 * reads their outputs, checks they are fresh, and relays them verbatim.
 *
 * FAIL CLOSED. If either canonical output is missing, unreadable, or older than the ledger it is
 * supposed to describe, this exits non-zero and reports the staleness. It never falls back to a
 * local calculation — a fallback is how the divergence started.
 *
 * 2026-09-10 (test-triage COUNT NOT EXPOSED fix). backend/test-triage.js resolves R49's output to
 * THIS file rather than to r49-spread-gate.json — its candidate globber matches any data/ file
 * starting with "r49-", and this one sorts first alphabetically ("r49-r53…" < "r49-spread…"). That
 * is a resolver quirk, not a reason to compute anything here: `dailyClock` below is RELAYED
 * verbatim from r49-spread-gate.json's own dailyClock, exactly as every other field in `reads` is
 * relayed. R53 is unaffected — its own file resolves correctly for its own id.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);

const SOURCES = [
  { id: "R49", file: "r49-spread-gate.json", script: "backend/r49-spread-gate.js" },
  { id: "R53", file: "r53-factor-cap.json", script: "backend/r53-factor-cap.js" },
];

const ledgerMtime = (() => { try { return fs.statSync(D("trade_log.json")).mtimeMs; } catch { return null; } })();
const STALE_TOLERANCE_MS = 26 * 3600e3;   // one daily cycle plus slack

const read = [];
let fatal = false;
for (const s of SOURCES) {
  let j = null, why = null;
  try { j = JSON.parse(fs.readFileSync(D(s.file), "utf8")); } catch (e) { why = "unreadable: " + e.message.slice(0, 80); }
  if (j) {
    const asOf = Date.parse(j.asOf || 0);
    if (!asOf) why = "no asOf timestamp — cannot establish freshness";
    else if (ledgerMtime && asOf < ledgerMtime - STALE_TOLERANCE_MS)
      why = `STALE: computed ${new Date(asOf).toISOString()} but the ledger changed ${new Date(ledgerMtime).toISOString()} — run ${s.script}`;
  }
  if (why) { fatal = true; read.push({ ...s, ok: false, why }); continue; }
  read.push({ ...s, ok: true, asOf: j.asOf, bar: j.bar, verdict: j.verdict,
    population: j.population ?? null, statistic: j.cost ?? j.paired ?? null,
    diagnostic: j.grossDiagnostic ?? null,
    episodeUnit: j.episodeUnit ?? null, refusalsByGroup: j.refusalsByGroup ?? null,
    meanEpisodeRCapped: j.meanEpisodeRCapped ?? null, meanEpisodeRUncapped: j.meanEpisodeRUncapped ?? null,
    dailyClock: j.dailyClock ?? null, bySession: j.bySession ?? null });
}

// RELAY R49's dailyClock to the TOP LEVEL — this is the file test-triage.js actually resolves for
// R49 (see header). Relayed verbatim from r49-spread-gate.json; computed nowhere in this file.
const r49 = read.find((r) => r.id === "R49");

const out = {
  spec: "r49-r53-gate-read-v2 — RELAY ONLY",
  asOf: new Date().toISOString(),
  contract: "This file computes nothing. Every figure below is relayed verbatim from the script test-registry.json names for that test. If a number here disagrees with the canonical file, the canonical file is right and this is a bug.",
  canonicalScripts: SOURCES.map((s) => `${s.id} -> ${s.script}`),
  rewrittenBecause: "v1 re-derived both statistics and got both wrong: R53 keyed episodes on an exact instant so the capped arm always read 0.0000 and the sample condition could trip early; R49 emitted the kept book's gross day-t beside the registered cost bar, which is neither registered statistic.",
  dailyClock: r49 && r49.ok ? r49.dailyClock : null,
  dailyClockNote: "relayed verbatim from r49-spread-gate.json (R49). This top-level field exists because test-triage.js's candidate resolver picks THIS file for R49, not the canonical one — see the 2026-09-10 header note.",
  bySession: r49 && r49.ok ? r49.bySession : null,
  reads: read,
  usable: !fatal,
};
writeJsonAtomic(D("r49-r53-gate-read.json"), out);

console.log("R49/R53 GATE READ — relay of the canonical readers (this file computes nothing)");
for (const r of read) {
  if (!r.ok) { console.error(`  ${r.id}  UNUSABLE — ${r.why}`); continue; }
  console.log(`  ${r.id}  ${r.verdict}`);
  console.log(`        bar ${JSON.stringify(r.bar)}`);
  console.log(`        source ${r.script} @ ${r.asOf}`);
}
if (fatal) {
  console.error("");
  console.error("  REFUSING to emit a verdict. A canonical reader is missing or stale, and this file will");
  console.error("  NOT substitute a local calculation — doing that is what produced two wrong statistics.");
  process.exit(1);
}
console.log("written: data/r49-r53-gate-read.json");
