#!/usr/bin/env node
/**
 * R179 amendment 2026-10-08 — WEEKDAY FILES ONLY (operator decision 2026-10-08, verbatim: "R179 A").
 *
 * Context: R179 (backend/r179-chatter-grade.js, close-chain step "r179 chatter grade") reads every file in data/social-mentions/. Until
 * the W1 cutover the recorder ran only in the weekday home close chain, so only weekday files exist. From Sat 2026-10-10 the VPS records
 * daily including Saturday and Sunday and those files are pulled home (docs/server/wave1-crypto/NOTES.md "Needs your decision"). Option A:
 * R179 keeps reading WEEKDAY files only — the population as registered and as accrued since 2026-09-24.
 *
 * Appends ONE dated amendment (key weekday-files-2026-10-08, token weekday-files) to R179.amendments (created; R179 carries none) with the
 * operator's choice verbatim, was / becomes, why, an explicit "unchanged" list, and the folder listing that shows this is NOT a population
 * change (the count of Saturday / Sunday files, which must be 0). Updates status with the token (keeps the "REGISTERED 2026-09-24" prefix;
 * adds "(amendments: 2026-10-08 weekday-files)"), was / becomes recorded. NOTHING else in the entry changes (rule text kept verbatim).
 *
 * Refuses when: R179 is missing; an amendment with this key exists; R179 has a read or a seal (read-seals.json tests.R179, a read/verdict
 * field on the entry, or a status that no longer starts "REGISTERED 2026-09-24"); ANY Saturday / Sunday file exists in data/social-mentions
 * (the amendment would then change the population — not this script's claim); the runner does not carry the weekday filter at its single
 * file listing, or its --selftest-weekday (synthetic snapshots, no network, no writes) does not PASS, or its folder count disagrees with
 * this script's listing; the R179 entry moved between the read and the write (entry-level compare-and-swap, as amend-r337-status.js);
 * a non-dry run inside the close-chain window 13:50-15:50 MT.
 * Writes: data/test-registry.json (lib/atomic-write.js writeJsonAtomic), ONE data/change-registry.json row (category "registration",
 * breaksComparability false), ONE data/agent-ledger.jsonl GOVERNANCE line.   --dry prints everything and writes nothing.
 * Never reads an outcome: no --read, no pricing; the nightly output data/r179-chatter.json is read only for its population counts.
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { spawnSync } = require("child_process");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), REG = D("test-registry.json"), SNAP = D("social-mentions");
const ID = "R179", KEY = "weekday-files-2026-10-08", TOKEN = "weekday-files", DATE = "2026-10-08";
const RUNNER = path.join(__dirname, "r179-chatter-grade.js"), DRY = process.argv.includes("--dry");
const die = (m) => { console.error(`${ID} amendment ${KEY} refused: ${m}`); process.exit(2); };
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const readJsonFile = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
const entryOf = (reg) => (reg.preregistered || []).find((x) => x.id === ID) || (reg.tests || []).find((x) => x.id === ID) || null;
const readReg = () => { let reg; try { reg = readJsonFile(REG); } catch (e) { die(`test-registry.json does not parse (${String(e.message).slice(0, 80)})`); } const t = entryOf(reg); if (!t) die("R179 not found in the registry"); return { reg, t }; };
const fenceCheck = () => {
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Denver", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const [h, m] = hm.split(":").map(Number), mins = h * 60 + m;
  if (mins >= 13 * 60 + 50 && mins < 15 * 60 + 50) die(`deferred: chain window (now ${hm} MT; no registry / ledger write 13:50-15:50 MT)`);
};

// ── 0. clock fence ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (!DRY) fenceCheck();

// ── 1. no read, no seal; key absent ──────────────────────────────────────────────────────────────────────────────────────────────────
{
  let seals; try { seals = readJsonFile(D("read-seals.json")); } catch { die("read-seals.json does not parse — cannot prove R179 is unsealed"); }
  if (seals && seals.tests && seals.tests[ID]) die(`R179 is sealed (read-seals.json: ${JSON.stringify(seals.tests[ID]).slice(0, 120)})`);
}
const first = readReg(), snap = JSON.stringify(first.t);
{
  const t = first.t;
  if ((t.amendments || []).some((a) => a && a.key === KEY)) die(`an amendment with key ${KEY} is already recorded — nothing to do`);
  const readKeys = ["read", "reads", "readResult", "result", "results", "verdict", "sealed", "sealedOn", "outcome", "readOn", "readDate"].filter((k) => t[k] !== undefined && t[k] !== null);
  if (readKeys.length) die(`the R179 entry carries read field(s): ${readKeys.join(", ")}`);
  if (!/^REGISTERED 2026-09-24\b/.test(String(t.status || ""))) die(`R179 status no longer starts "REGISTERED 2026-09-24": ${String(t.status).slice(0, 120)}`);
}

// ── 2. the folder: no Saturday / Sunday file has ever existed (so this is NOT a population change) ──────────────────────────────────
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;
const weekdayOf = (d) => new Date(d + "T00:00:00Z").getUTCDay();   // the file's own date (its name = the ET day of the run), not a host clock
const names = fs.existsSync(SNAP) ? fs.readdirSync(SNAP) : die("data/social-mentions does not exist");
const dated = names.filter((f) => DAY_FILE.test(f)).map((f) => f.slice(0, 10)).sort();
const weekend = dated.filter((d) => [0, 6].includes(weekdayOf(d))), weekdays = dated.filter((d) => ![0, 6].includes(weekdayOf(d)));
const otherNames = names.filter((f) => !DAY_FILE.test(f));
if (!dated.length) die("data/social-mentions holds no dated file");
if (weekend.length) die(`data/social-mentions already holds ${weekend.length} Saturday/Sunday file(s) (${weekend.slice(0, 6).join(", ")}) — ignoring them now WOULD change the population; not this amendment`);
const folder = { listedAt: new Date().toISOString(), datedFiles: dated.length, weekdayFiles: weekdays.length, saturdaySundayFiles: weekend.length, first: dated[0], last: dated[dated.length - 1], otherEntries: otherNames.length,
  byWeekday: Object.fromEntries(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((n, i) => [n, dated.filter((d) => weekdayOf(d) === i).length])) };
let nightly = null;
try { const j = readJsonFile(D("r179-chatter.json")); nightly = { asOf: j.asOf, snapshotDays: j.snapshotDays, signalsByLeg: j.signalsByLeg, primaryS1_5SignalDays: j.cells && j.cells["S1:5"] ? j.cells["S1:5"].signalDays : null, verdict: j.verdict }; } catch { nightly = null; }

// ── 3. the runner carries the filter at its single listing, and its selftest passes ─────────────────────────────────────────────────
const runnerBytes = fs.readFileSync(RUNNER), runnerSrc = runnerBytes.toString("utf8"), runnerSha = sha(runnerBytes);
{
  const need = [["const isWeekendDay = (d) => { const w = new Date(d + \"T00:00:00Z\").getUTCDay(); return w === 0 || w === 6; };", "isWeekendDay (the file's own date)"],
    ["function listDays(names) {", "listDays"], ["return { days: all.filter((d) => !isWeekendDay(d)), weekendIgnored: all.filter(isWeekendDay) };", "the weekday filter"],
    ["const listed = listDays(fs.existsSync(SNAP) ? fs.readdirSync(SNAP) : []), days = listed.days;", "the filter at the file listing"],
    ["snaps[days[i - 1]]", "S2's previous file taken from the weekday list"], ["const sig = buildSignals(days, snaps);", "signals built from the weekday list"],
    ['process.argv.includes("--selftest-weekday")', "--selftest-weekday"], [KEY, "the amendment key"]];
  const miss = need.filter(([s]) => !runnerSrc.includes(s)).map(([, w]) => w); if (miss.length) die(`the runner does not carry the weekday filter (${miss.join(", ")} not found)`);
  const main = runnerSrc.slice(runnerSrc.indexOf("(async () => {"));
  const nList = (main.match(/readdirSync\(/g) || []).length; if (runnerSrc.indexOf("(async () => {") < 0 || nList !== 1) die(`the runner's main body lists files ${nList} times (expected exactly 1, filtered)`);
}
const st = spawnSync(process.execPath, [RUNNER, "--selftest-weekday"], { encoding: "utf8", timeout: 120000, cwd: path.join(__dirname, "..") });
const stLine = String(st.stdout || "").split(/\r?\n/)[0] || "";
const stM = stLine.match(/^R179 selftest-weekday (PASS|FAIL) (\d+)\/(\d+) · folder now: (\d+) weekday file\(s\), (\d+) weekend file\(s\) ignored/);
if (st.status !== 0 || !stM || stM[1] !== "PASS" || stM[2] !== stM[3]) die(`the runner's --selftest-weekday did not pass: ${stLine.slice(0, 160) || String(st.stderr || "").slice(0, 160)}`);
if (+stM[4] !== weekdays.length || +stM[5] !== weekend.length) die(`the runner's folder count (${stM[4]} weekday, ${stM[5]} weekend) disagrees with this listing (${weekdays.length}, ${weekend.length})`);
const selftest = `PASS ${stM[2]}/${stM[3]}`;

// ── 4. the amendment ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const amendment = {
  date: DATE, key: KEY, token: TOKEN, preEvidence: false, preRead: true, populationChange: false,
  field: "population: which data/social-mentions files every R179 statistic reads (weekday files only) and S2's 'previous recorded day' (the previous weekday file); status (token)",
  decidedBy: "operator", operatorWords: "R179 A", operatorMessage: "R179 A; shadow yes (the second clause is a separate decision, not this amendment)",
  optionA: "R179 keeps reading WEEKDAY files only (population exactly as registered and as accrued since 2026-09-24): Monday's 'newly trending' check keeps comparing with Friday's list, no weekend crypto signal days, nothing else changes.",
  optionNotChosen: "Leave it: read every file in the folder, as the rule text literally allows (Monday's S2 against Sunday's list; weekend S3 crypto signal days; weekend S1/S2 stock signals screened out by the SIP-bar rule).",
  evidence: `POST-EVIDENCE-START, PRE-READ: evidence started with the 2026-09-24 snapshot; R179 is not read and not sealed (read-seals.json has no R179; status still "REGISTERED 2026-09-24"). NOT a population change: data/social-mentions holds ${dated.length} dated file(s) (${dated[0]} .. ${dated[dated.length - 1]}), ${weekend.length} of them dated a Saturday or Sunday — no weekend file has ever existed in the folder (the recorder ran only in the weekday home close chain), so every file R179 has read stays in, S2's previous file is unchanged for every day so far, and no statistic changes. The runner's own --selftest-weekday folder line agrees (${stM[4]} weekday, ${stM[5]} weekend).`,
  folder, nightlyAtAmendment: nightly,
  why: "The recorder's weekend cadence starting 2026-10-10 (W1 cutover planned Fri 2026-10-09: social-mentions-record.js on the VPS daily at 16:35 New York time including Saturday and Sunday, files pulled home) would otherwise change R179's population mid-evidence: Monday's S2 'absent from the previous recorded day's list' would compare with Sunday's list instead of Friday's, weekend S3 (crypto) signal days would appear, and weekend S1/S2 stock rows would enter the snapshot count only to be screened out by the SIP-bar rule. Fixed now, before the first weekend file and before the read, the population stays the registered and accrued one.",
  was: "Every data/social-mentions/<D>.json file in the folder is read (rule[0]: 'Snapshot for day D = data/social-mentions/<D>.json (ET date)'), and S2's 'previous recorded day' (rule[2]) is the previous file in the folder whatever its weekday. Only weekday files existed because the recorder ran in the weekday-only home close chain.",
  becomes: "Files whose date is a Saturday or Sunday in the file's own date convention (the file name = the ET day of the recorder's run; the weekday computed from that date string, not from any host clock) are ignored by every R179 statistic — S1, S2, S3, the controls, the snapshot count, the read. Any 'previous file' comparison (S2's 'absent from the previous recorded day's list') uses the previous WEEKDAY file: Monday compares with Friday (or with the last earlier weekday file present, exactly as a missing weekday file was already handled). Weekend files stay in the folder as data (the recorder is unchanged); r179-chatter.json reports how many were ignored (weekendFilesIgnored).",
  rule: "The registered rule text is kept verbatim; this amendment governs which files it reads (rule[0]) and what 'the previous recorded day' means (rule[2]).",
  unchanged: ["the legs S1 / S2 / S3 and every threshold (S1: mentions >= 20, rank <= 100, >= 3 x max(24h-ago, 3); S2: new on the Stocktwits trending list; S3: crypto mentions >= 10, >= 3 x max(24h-ago, 3), XXX.X -> Coinbase XXX-USD, BTC excluded)",
    "the listing and price screen (Alpaca SIP daily bar on D, raw close >= $2; crypto a Coinbase <COIN>-USD product)", "entries and exits (stocks D+1 open to the close h trading days later; crypto 00:00 UTC the day after the snapshot, h days)",
    "the horizons (S1, S2: 1/5/20 trading days; S3: 1/5 days)", "the controls (5 non-spiking names from D's ApeWisdom all-stocks rows, seed = hash of D and the name; crypto control BTC)",
    "the statistic (per signal day mean excess; Newey-West t over signal days, lag h-1; two-sided)", "the multiplicity family CHATTER-16 and the primary cell S1:5",
    "the bar (|t| >= 2.913, 16 variants, >= 40 signal days per cell, fixed in advance)", "the read condition (primary S1:5 >= 40 signal days; every cell read at that moment; read-once)",
    "the decision rules (pass and fail as registered)", "evidenceStart (the 2026-09-24 snapshot)", "interimKill (none — nothing trades)",
    "weekday files, weekday market holidays included, read exactly as before", "the recorder (backend/social-mentions-record.js) and its files", "the close-chain step order (r179 chatter grade after social mentions record)"],
  whatItCosts: "Weekend chatter recorded from 2026-10-10 does not enter R179; a name that started trending on Saturday or Sunday and is still trending Monday counts as Monday's 'new' S2 name (as it did before the weekend files existed).",
  runner: { file: "backend/r179-chatter-grade.js", sha256: runnerSha, selftestWeekday: selftest, change: "listDays(): the weekday filter at the single file listing; buildSignals(): the registered signal loop moved verbatim into a function of the weekday list (so days[i - 1] is the previous weekday file); --selftest-weekday known answers; weekendFilesIgnored reported" },
  amendedBy: "backend/amend-r179-weekday-files.js", appliedAt: new Date().toISOString(),
};
function entryEdits(t) {
  const tokens = [...(t.amendments || []).filter((a) => a && a.token && a.key !== KEY).map((a) => `${a.date} ${a.token}`), `${DATE} ${TOKEN}`];
  const st0 = String(t.status || ""), re = /^(REGISTERED \d{4}-\d{2}-\d{2})(?: \(amendments: [^)]*\))?/;
  const status = re.test(st0) ? st0.replace(re, `$1 (amendments: ${tokens.join("; ")})`) : `${st0} [amendments: ${tokens.join("; ")}]`;
  return { was: { status: st0 }, becomes: { status } };
}
const crRow = { id: `r179-amend-${KEY}`, date: DATE, recordedAt: Date.now(), area: "registry + runner — R179 retail chatter (amendment: weekday files only; operator 'R179 A')", category: "registration", breaksComparability: false,
  change: `R179 amendment ${DATE} (operator "R179 A"; post-evidence-start, pre-read, NOT a population change): R179 reads WEEKDAY data/social-mentions files only — a file dated a Saturday or Sunday (its own name, the ET day of the run) is ignored by every statistic, and S2's 'previous recorded day' is the previous weekday file (Monday vs Friday). The folder holds ${dated.length} dated file(s), ${weekend.length} on a weekend, so nothing already read changes. Runner: the filter at its single file listing (listDays), the signal loop moved verbatim into buildSignals(weekday list), --selftest-weekday ${selftest}, weekendFilesIgnored reported; sha256 ${runnerSha.slice(0, 16)}... Status token added; rule text, legs, screen, horizons, controls, statistic, bar, read condition unchanged.`,
  why: "From Sat 2026-10-10 the VPS records social mentions 7 days a week (W1); without this, Monday's S2 would compare with Sunday's list and weekend S3 crypto signal days would enter — a population change mid-evidence.",
  doesNotEstablish: "Any R179 result.", operator: `operator ${DATE} ("R179 A")`, files: ["backend/r179-chatter-grade.js", "backend/amend-r179-weekday-files.js"] };
const ledgerLine = { ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-operator-decision", tests: [ID], key: KEY, decision: "R179 A", field: amendment.field,
  detail: `weekday files only (Sat/Sun files ignored by every statistic; S2 previous = previous weekday file); not a population change (${dated.length} dated files, ${weekend.length} weekend); rule text kept, amendment recorded`, runnerSha256: runnerSha, selftest };

if (DRY) {
  const efDry = entryEdits(first.t);
  console.log(`${ID} amendment ${KEY} — DRY RUN (nothing written)`);
  console.log(`  checks: R179 found (${(first.reg.preregistered || []).some((x) => x.id === ID) ? "preregistered" : "tests"}); amendments now ${(first.t.amendments || []).length}; no "${KEY}" yet; not read, not sealed; folder ${dated.length} dated file(s) ${dated[0]}..${dated[dated.length - 1]}, ${weekend.length} Sat/Sun, ${otherNames.length} other entr(y/ies); runner carries the filter at its single listing; --selftest-weekday ${selftest}`);
  console.log(`  would append to R179.amendments:\n${JSON.stringify({ ...amendment, entryFields: efDry }, null, 1)}`);
  console.log(`  would set R179.status:\n   ${efDry.becomes.status}`);
  console.log(`  would append to change-registry.json:\n${JSON.stringify(crRow, null, 1)}`);
  console.log(`  would append to agent-ledger.jsonl:\n${JSON.stringify(ledgerLine)}`);
  process.exit(0);
}

// ── 5. write: registry (entry-level compare-and-swap), change-registry, agent ledger ────────────────────────────────────────────────
fenceCheck();
if (fs.readdirSync(SNAP).some((f) => DAY_FILE.test(f) && [0, 6].includes(weekdayOf(f.slice(0, 10))))) die("a Saturday/Sunday file appeared during the run — re-run");
const fresh = readReg(); if (JSON.stringify(fresh.t) !== snap) die("the R179 entry changed between reads — re-run");
const ef = entryEdits(fresh.t); amendment.entryFields = ef;
(fresh.t.amendments = fresh.t.amendments || []).push(amendment);
fresh.t.status = ef.becomes.status;
fresh.reg.asOf = new Date().toISOString(); writeJsonAtomic(REG, fresh.reg);
{
  const chk = entryOf(readJsonFile(REG)), keep = JSON.parse(snap);
  const same = (k) => JSON.stringify(chk[k]) === JSON.stringify(keep[k]);
  const ok = chk && (chk.amendments || []).filter((a) => a && a.key === KEY && a.runner && a.runner.sha256 === runnerSha).length === 1 && chk.status === ef.becomes.status
    && ["rule", "bar", "statistic", "decisionRule", "readCondition", "multiplicityFamily", "evidenceStart", "knownWeaknesses", "script", "interimKill"].every(same);
  if (!ok) die("post-write verification failed — inspect the registry (the registry write happened)");
}
const cr = readJsonFile(D("change-registry.json")); if (!Array.isArray(cr)) die("change-registry.json is not an array (the registry amendment IS written — append the change row by hand)");
cr.push(crRow); writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify(ledgerLine) + "\n");
console.log(`${ID} amended ${DATE} (operator "R179 A"): weekday files only — ${dated.length} dated file(s), ${weekend.length} Sat/Sun (not a population change); runner sha256 ${runnerSha.slice(0, 16)}..., selftest-weekday ${selftest}; status: ${ef.becomes.status}; change-registry row ${crRow.id}; agent-ledger GOVERNANCE line appended`);
