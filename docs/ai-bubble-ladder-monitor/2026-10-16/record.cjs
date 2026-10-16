#!/usr/bin/env node
"use strict";
/**
 * AI-BUBBLE LADDER MONITOR (2026-10-16) — RECORD the new monitor: ONE change-registry row and ONE agent-ledger
 * GOVERNANCE line, "a read-only daily reading of the AI-bubble contingency plan's B1 and B2 rungs from stored daily
 * closes; it places no orders and changes nothing but its own dated status file".
 *
 *   node docs/ai-bubble-ladder-monitor/2026-10-16/record.cjs --dry    print the two records and whether the write
 *                                                                     would go through. Writes NOTHING and takes no
 *                                                                     lock. This is the command a cloud session runs.
 *   node docs/ai-bubble-ladder-monitor/2026-10-16/record.cjs          write them — the operator's command at home,
 *                                                                     AFTER deploy.cjs --apply
 *
 * THE ROW (backend/data/change-registry.json): id ai-bubble-ladder-monitor-2026-10-16, category ops,
 *   breaksComparability FALSE — it changes no registered test's rule, bar, population, statistic or read condition,
 *   and nothing reads it: it adds a new read-only reading beside the 10-07 measurement lenses. THE LINE
 *   (backend/data/agent-ledger.jsonl): kind GOVERNANCE, naming the row.
 * REFUSED, nothing written: between 13:50 and 15:50 MT on a trading weekday (the close chain owns these files then);
 *   while the live files are not the staged ones (deploy.cjs --apply first: a change is recorded after it is in);
 *   when either record is already there (both: "already recorded", exit 0; one: refused, saying which).
 * WRITES, in this order: change-registry.json through backend/lib/atomic-write.js writeJsonAtomic (read back), then
 *   ONE line appended to agent-ledger.jsonl (an append never rewrites what other writers added). A failure after the
 *   first write says what is still owed.
 * Exit 0 written / already recorded / dry · 1 failed after a write · 2 refused or usage.
 */
const fs = require("fs"), path = require("path");
const D = require("./deploy.cjs");

const CR_ID = "ai-bubble-ladder-monitor-2026-10-16";
const TEXT = "a read-only daily reading of the AI-bubble contingency plan's B1 and B2 rungs from stored daily closes; it places no orders and changes nothing but its own dated status file";
const CR_REL = "backend/data/change-registry.json", LEDGER_REL = "backend/data/agent-ledger.jsonl";
const DRY = process.argv.includes("--dry");
if (process.argv.slice(2).some((a) => a !== "--dry")) { console.log(`usage: node ${D.PKG_REL}/record.cjs [--dry]\nNothing was done.`); process.exit(2); }

const F = (rel) => path.join(D.REPO, ...rel.split("/"));
const readJson = (rel) => { try { return JSON.parse(fs.readFileSync(F(rel), "utf8")); } catch (e) { return { __missing: e.code || e.message }; } };
const readText = (rel) => { try { return fs.readFileSync(F(rel), "utf8"); } catch (e) { return null; } };

/** the two records, built from the package's own facts */
function records(nowIso, mtDate) {
  const files = Object.fromEntries(D.FILES.map((f) => [f.rel, { before: null, after: f.stagedSha }]));
  const row = {
    id: CR_ID, date: mtDate, recordedAt: nowIso, area: "AI-bubble contingency plan (2026-10-07): a daily reading of its de-risking ladder",
    category: "ops", breaksComparability: false, affectedFrom: mtDate,
    change: `${TEXT}. Two NEW files, nothing changed: backend/ai-bubble-ladder.js holds the two rules as arithmetic — B1, the daily 200-day +/-2% band on QQQ, SPY and SMH (docs/ai-bubble-2026-10/bust/triggers.js:51-57 dailyTrend(S,200,0.02); plan-sizing.cjs:24; plan-review/precedent.cjs:9), and B2, the monthly 10-month flip on QQQ, SPY and the VWEHX/VFITX credit ratio (bust/triggers.js:50 tenMonth and :83; plan-review/flip-levels.cjs:12-15), each rung carrying the line it comes from. backend/ai-bubble-ladder-monitor.js reads the stored daily closes (default docs/ai-bubble-2026-10/bust/data, the cache bust/fetch.js writes), computes each rung as of the one day every series reaches, prints a plain summary saying for each rung whether it is ARMED with the value and the threshold it was judged against, and — only with --write — puts that day's status under its own date key in backend/data/ai-bubble-ladder-status.json through backend/lib/atomic-write.js. It makes no network call and no broker call (it holds no client and no URL), reads no account and no position, places NO ORDER of any kind, sets no switch, adds nothing to the close chain and is scheduled by nothing: the operator runs it. A rung whose series is too short to read (fewer than 200 closes, fewer than 10 month-ends) is reported NOT READ, never "not armed".`,
    why: "The plan's ladder was measured once, on 2026-10-07, by the lenses in docs/ai-bubble-2026-10/ against a cut of 2026-10-06. Nothing read it after that day. This is the same arithmetic as a dated daily reading, so the rungs' state is on record as it moves rather than re-derived by hand each time it matters.",
    comparabilityNote: "None. It adds a reading; it changes no registered rule, bar, population, statistic or read condition, and no registered test or live program reads its output. The plan's own write-up (docs/ai-bubble-contingency-plan-2026-10-07.md) is the authority on what the ladder MEANS; this records only how it is READ.",
    doesNotChange: "Any registered test; any live program (nothing requires these files); the close chain; any switch; any broker, account or position. It writes one file of its own and nothing else.",
    owed: `A look at the first reading against docs/ai-bubble-2026-10/bust/now.js over the same store (they read the same rules from the same cache), and the operator's confirmation that the B1/B2 rung set matches the plan's own write-up, which is not in the code-only copy this was built in (docs/ai-bubble-ladder-monitor/2026-10-16/NOTES.md, "What the code pins and what it does not"). Back at any time: node ${D.PKG_REL}/rollback.cjs --apply.`,
    operator: `assistant (cloud build session), package ${D.PKG_REL}`,
    files, package: D.PKG_REL,
  };
  const line = { ts: nowIso, kind: "GOVERNANCE", actor: "assistant (cloud build session)", action: "ai-bubble-ladder-monitor-added", note: TEXT, changeRegistry: CR_ID };
  return { row, line };
}

const nowIso = new Date().toISOString(), mt = D.mtNow();
const { row, line } = records(nowIso, mt.date);
const P = D.plan();

// what stands in the way
const why = [];
if (mt.tradingWeekday && mt.mins >= D.WINDOW.from && mt.mins < D.WINDOW.to) why.push(`${mt.hms} MT ${mt.dow} ${mt.date} is inside 13:50-15:50 MT on a trading weekday — the close chain owns ${CR_REL} and ${LEDGER_REL} then`);
if (!P.allApplied) why.push(`the live files are not the staged ones yet (${P.files.map((x) => `${x.rel}: ${x.state}`).join(", ")}) — run deploy.cjs --apply first: a change is recorded after it is in`);
const cr = readJson(CR_REL), led = readText(LEDGER_REL);
const rows = Array.isArray(cr) ? cr : Array.isArray(cr && cr.changes) ? cr.changes : null;
const haveRow = rows ? rows.some((r) => r && r.id === CR_ID) : null;
const haveLine = led == null ? null : led.includes(`"changeRegistry":"${CR_ID}"`) || led.includes(`"changeRegistry": "${CR_ID}"`);
if (cr.__missing) why.push(`${CR_REL} cannot be read (${cr.__missing}) — this copy of the repository holds no data; run this at home`);
if (led == null) why.push(`${LEDGER_REL} cannot be read — this copy of the repository holds no data; run this at home`);
if (haveRow === true && haveLine === true) why.push("ALREADY RECORDED: both the row and the ledger line are there");
else if (haveRow === true) why.push(`the change-registry row ${CR_ID} is already there but the ledger line is not — refused; add the line by hand or remove the row first`);
else if (haveLine === true) why.push(`the ledger line for ${CR_ID} is already there but the row is not — refused; put the row in by hand`);

console.log(`RECORD ${DRY ? "--dry (nothing is written, no lock is taken)" : ""} — AI-bubble ladder monitor — ${D.mtWords(Date.now())}`);
console.log(`\nTHE ROW -> ${CR_REL}`);
console.log(JSON.stringify(row, null, 1));
console.log(`\nTHE LINE -> ${LEDGER_REL} (appended)`);
console.log(JSON.stringify(line));
console.log(`\nSTATE NOW: live files ${P.files.map((x) => `${x.rel.replace("backend/", "")} ${x.state}`).join(" · ")}`);
console.log(`  ${CR_REL}: ${cr.__missing ? `not readable (${cr.__missing})` : `${rows ? rows.length + " row(s)" : "an unexpected shape"}; this row ${haveRow ? "IS" : "is NOT"} there`}`);
console.log(`  ${LEDGER_REL}: ${led == null ? "not readable" : `${led.split(/\r?\n/).filter(Boolean).length} line(s); this line ${haveLine ? "IS" : "is NOT"} there`}`);
console.log(`\nWOULD THE WRITE GO THROUGH? ${why.length ? `NO — refused:\n  - ${why.join("\n  - ")}` : "yes"}`);

if (DRY) { console.log("\n--dry: nothing was written."); process.exit(0); }
if (why.length) { console.error("\nREFUSED — nothing written."); process.exit(why.some((w) => w.startsWith("ALREADY RECORDED")) ? 0 : 2); }

const { writeJsonAtomic } = require(path.join(D.REPO, "backend", "lib", "atomic-write.js"));
const next = Array.isArray(cr) ? [...cr, row] : { ...cr, changes: [...cr.changes, row] };
try { writeJsonAtomic(F(CR_REL), next); } catch (e) { console.error(`FAILED before anything was written: ${CR_REL} (${e.message})`); process.exit(1); }
const back = readJson(CR_REL), backRows = Array.isArray(back) ? back : (back && back.changes) || [];
if (!backRows.some((r) => r && r.id === CR_ID)) { console.error(`FAILED: ${CR_REL} does not read back with the row — the ledger line was NOT appended; put both in by hand`); process.exit(1); }
try { fs.appendFileSync(F(LEDGER_REL), JSON.stringify(line) + "\n"); }
catch (e) { console.error(`THE ROW IS IN, THE LINE IS NOT: appending to ${LEDGER_REL} failed (${e.message}) — append it by hand:\n${JSON.stringify(line)}`); process.exit(1); }
if (!String(readText(LEDGER_REL) || "").includes(CR_ID)) { console.error(`THE ROW IS IN, THE LINE DID NOT READ BACK — append it by hand:\n${JSON.stringify(line)}`); process.exit(1); }
console.log(`\nRECORDED: the row ${CR_ID} in ${CR_REL} and one GOVERNANCE line in ${LEDGER_REL}. Nothing else was written.`);
process.exit(0);
