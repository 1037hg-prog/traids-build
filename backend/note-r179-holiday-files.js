#!/usr/bin/env node
/**
 * R179 DATED NOTE 2026-10-08 — weekday market-holiday files (adversarial review of the weekday-files amendment, finding 1).
 *
 * The weekday-files-2026-10-08 amendment (operator "R179 A") lists as unchanged "weekday files, weekday market holidays included, read
 * exactly as before". True of the code — a weekday file is read whether or not the day is an NYSE full closure — but it implies the
 * population stays the registered one, and from the W1 cutover it does not: the home close chain never ran at its slot on a full
 * closure (lib/run-window.js HOLIDAY-CLOSED), while the VPS social timer (traids-w1-social.timer, daily 16:35 New York) has no holiday
 * check, so files dated weekday closures (first 2026-11-26) will appear and R179 would read them. "R179 A" decided weekend files only;
 * the holiday files are OPEN — the operator's decision, before 2026-11-26.
 *
 * Appends ONE dated note (kind "dated note", key holiday-files-note-2026-10-08, token holiday-note) to R179.amendments: no rule,
 * population, statistic, bar or read-condition change; the open question with both options; the runner's new fail-closed interlock
 * (holiday files reported nightly as weekdayHolidayFiles; --read refuses while one is present until an amendment with
 * decides "holiday-files" exists). Status gains the token. Writes test-registry.json (writeJsonAtomic), ONE change-registry row,
 * ONE agent-ledger GOVERNANCE line.   --dry prints everything and writes nothing.
 * Refuses when: R179 missing / sealed / read / status no longer "REGISTERED 2026-09-24"; the weekday-files amendment absent; the note
 * already recorded; a file dated an NYSE full closure already in data/social-mentions (then this is no longer a note: a decision is
 * due now); the runner lacks the interlock or its --selftest-weekday fails; the entry moved between read and write; the chain window
 * 13:50-15:50 MT (non-dry).
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { spawnSync } = require("child_process");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const RW = require("./lib/run-window.js");
const D = (f) => path.join(__dirname, "data", f), REG = D("test-registry.json"), SNAP = D("social-mentions");
const ID = "R179", KEY = "holiday-files-note-2026-10-08", TOKEN = "holiday-note", DATE = "2026-10-08", PRIOR_KEY = "weekday-files-2026-10-08";
const RUNNER = path.join(__dirname, "r179-chatter-grade.js"), DRY = process.argv.includes("--dry");
const die = (m) => { console.error(`${ID} note ${KEY} refused: ${m}`); process.exit(2); };
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const readJsonFile = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
const entryOf = (reg) => (reg.preregistered || []).find((x) => x.id === ID) || (reg.tests || []).find((x) => x.id === ID) || null;
const readReg = () => { let reg; try { reg = readJsonFile(REG); } catch (e) { die(`test-registry.json does not parse (${String(e.message).slice(0, 80)})`); } const t = entryOf(reg); if (!t) die("R179 not found"); return { reg, t }; };
const fenceCheck = () => {
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Denver", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const [h, m] = hm.split(":").map(Number), mins = h * 60 + m;
  if (mins >= 13 * 60 + 50 && mins < 15 * 60 + 50) die(`deferred: chain window (now ${hm} MT; no registry / ledger write 13:50-15:50 MT)`);
};
if (!DRY) fenceCheck();

// ── 1. not read, not sealed; the weekday-files amendment present; this note absent ───────────────────────────────────────────────────
{ let seals; try { seals = readJsonFile(D("read-seals.json")); } catch { die("read-seals.json does not parse"); } if (seals && seals.tests && seals.tests[ID]) die("R179 is sealed"); }
const first = readReg(), snap = JSON.stringify(first.t);
{
  const t = first.t, am = t.amendments || [];
  if (am.some((a) => a && a.key === KEY)) die(`${KEY} is already recorded — nothing to do`);
  if (!am.some((a) => a && a.key === PRIOR_KEY)) die(`the ${PRIOR_KEY} amendment is not on the entry`);
  if (am.some((a) => a && a.decides === "holiday-files")) die("an amendment already decides the holiday files — this note is moot");
  const readKeys = ["read", "reads", "readResult", "result", "results", "verdict", "sealed", "sealedOn", "outcome", "readOn", "readDate"].filter((k) => t[k] !== undefined && t[k] !== null);
  if (readKeys.length) die(`the entry carries read field(s): ${readKeys.join(", ")}`);
  if (!/^REGISTERED 2026-09-24\b/.test(String(t.status || ""))) die(`status no longer starts "REGISTERED 2026-09-24": ${String(t.status).slice(0, 120)}`);
}

// ── 2. the facts the note rests on (computed here) ─────────────────────────────────────────────────────────────────────────────────
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/, dow = (d) => new Date(d + "T00:00:00Z").getUTCDay();
const dated = fs.readdirSync(SNAP).filter((f) => DAY_FILE.test(f)).map((f) => f.slice(0, 10)).sort();
const weekdays = dated.filter((d) => dow(d) > 0 && dow(d) < 6), holidayNow = weekdays.filter((d) => RW.marketHoliday(d));
if (holidayNow.length) die(`data/social-mentions already holds weekday file(s) dated an NYSE full closure (${holidayNow.join(", ")}) — a decision is due now, not a note`);
const closures = Object.keys(RW.MARKET_HOLIDAYS).filter((d) => d >= "2026-10-09" && dow(d) > 0 && dow(d) < 6).sort(), firstClosure = closures[0];
const homeAtSlot = RW.runWindow(new Date("2026-11-26T21:15:00Z"));   // 14:15 MT = the close chain's slot, Thanksgiving
if (homeAtSlot.open !== false || homeAtSlot.window !== "HOLIDAY-CLOSED") die(`lib/run-window.js no longer reports HOLIDAY-CLOSED at the chain slot on 2026-11-26 (${homeAtSlot.window})`);
const addD = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const td = []; for (let d = dated[0]; td.length < 45; d = addD(d, 1)) if (dow(d) > 0 && dow(d) < 6 && !RW.marketHoliday(d)) td.push(d);
const bound = { fortiethTradingDayFromFirstSnapshot: td[39], itsFiveDayHorizonCloses: td[44] };
let nightly = null; try { const j = readJsonFile(D("r179-chatter.json")); nightly = { asOf: j.asOf, snapshotDays: j.snapshotDays, primaryS1_5SignalDays: j.cells && j.cells["S1:5"] ? j.cells["S1:5"].signalDays : null }; } catch { nightly = null; }
const timer = fs.readFileSync(path.join(__dirname, "..", "docs", "server", "wave1-crypto", "systemd", "traids-w1-social.timer"), "utf8");
const onCal = (timer.match(/^OnCalendar=(.*)$/m) || [])[1] || null; if (onCal !== "*-*-* 16:35:00 America/New_York") die(`traids-w1-social.timer OnCalendar is ${onCal} — re-check the premise`);

// ── 3. the runner carries the interlock; its selftest passes and agrees with the folder ──────────────────────────────────────────────
const runnerBytes = fs.readFileSync(RUNNER), runnerSrc = runnerBytes.toString("utf8"), runnerSha = sha(runnerBytes);
{
  const need = ["function holidayAudit(days)", "function holidayReadBlock(audit, entry)", "a.decides === \"holiday-files\"", "const hb = holidayReadBlock(hol, ENTRY); if (hb) {", "const { listed, days, snaps } = loadSnapshots(SNAP), hol = holidayAudit(days);", "weekdayHolidayFiles: hol.holidayFiles", KEY];
  const miss = need.filter((s) => !runnerSrc.includes(s)); if (miss.length) die(`the runner lacks: ${miss.join(" | ")}`);
}
const st = spawnSync(process.execPath, [RUNNER, "--selftest-weekday"], { encoding: "utf8", timeout: 120000, cwd: path.join(__dirname, "..") });
const stLine = String(st.stdout || "").split(/\r?\n/)[0] || "", stM = stLine.match(/^R179 selftest-weekday (PASS|FAIL) (\d+)\/(\d+) · folder now: (\d+) weekday file\(s\), (\d+) weekend file\(s\) ignored/);
if (st.status !== 0 || !stM || stM[1] !== "PASS" || stM[2] !== stM[3]) die(`the runner's --selftest-weekday did not pass: ${stLine.slice(0, 160) || String(st.stderr || "").slice(0, 160)}`);
if (+stM[4] !== weekdays.length) die(`the runner's folder count (${stM[4]}) disagrees with this listing (${weekdays.length})`);
const selftest = `PASS ${stM[2]}/${stM[3]}`;

// ── 4. the note ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const note = {
  date: DATE, key: KEY, token: TOKEN, kind: "dated note (no rule, population, statistic, bar or read-condition change)", preEvidence: false, preRead: true, populationChange: false, open: true, decides: null,
  field: `clarifies amendment ${PRIOR_KEY} ('unchanged': "weekday files, weekday market holidays included, read exactly as before"); records an OPEN operator decision; status (token)`,
  decidedBy: "main loop on the adversarial review of 2026-10-08 (finding 1, major): the decision itself is the operator's",
  finding: `The ${PRIOR_KEY} 'unchanged' item is true of the code (a weekday file is read whether or not the day is an NYSE full closure) but implied the population stays the registered one. It does not from the W1 cutover: the home close chain never ran at its slot on a full closure (lib/run-window.js reports ${homeAtSlot.window} at 14:15 MT on 2026-11-26), and data/social-mentions holds ${holidayNow.length} file(s) dated one (${dated.length} dated files, ${dated[0]}..${dated[dated.length - 1]}); the VPS timer traids-w1-social.timer (OnCalendar ${onCal}) has no holiday check, so files dated the weekday closures ${closures.join(", ")} (lib/run-window.js MARKET_HOLIDAYS) will appear from W1. Read as weekday files they would: make the next session's S2 compare with the holiday's list, add an S3 (crypto) signal day and a snapshot day (S1/S2 stock signals on the holiday are screened out by the SIP-bar rule). "R179 A" decided the weekend files only.`,
  openQuestion: { forOperator: true, decideBefore: firstClosure,
    optionA: "A second dated amendment: files dated an NYSE full closure (lib/run-window.js MARKET_HOLIDAYS, the single source; refuse when a file is dated past the list) are ignored like weekend files — keeps the home-chain population (the next session's S2 compares with the last trading day's list).",
    optionB: `Keep reading them and record it as a disclosed population change from ${firstClosure} (S2 after a closure compares with the closure's list; closure-day S3 signal days and snapshot days enter).` },
  timing: `The read cannot come before the 40th trading day from the first snapshot (${dated[0]}) is a signal day with a completed 5-day horizon: no earlier than after the close of ${bound.itsFiveDayHorizonCloses} (40th trading day ${bound.fortiethTradingDayFromFirstSnapshot}), and only if S1 fired on every session; primary S1:5 had ${nightly ? nightly.primaryS1_5SignalDays : "?"} signal day(s) at ${nightly ? nightly.asOf : "?"}. Any shortfall puts the read after ${firstClosure}, when the first closure file exists.`,
  interlock: `Until an amendment with decides "holiday-files" is recorded, backend/r179-chatter-grade.js reads such files exactly as before (no statistic changes), reports them nightly (r179-chatter.json weekdayHolidayFiles / weekdayFilesPastHolidayList, a WARN on the console line) and --read refuses (exit 2) while any weekday file is dated an NYSE full closure or lies past the holiday list (ends ${Object.keys(RW.MARKET_HOLIDAYS).sort().pop()}). Fail-closed: the read cannot silently include a population nobody decided.`,
  runner: { file: "backend/r179-chatter-grade.js", sha256: runnerSha, selftestWeekday: selftest,
    change: "holidayAudit / holidayReadBlock (the interlock above); loadSnapshots(dir): main's file listing and snapshot read moved verbatim into a function so --selftest-weekday tests main's loader on a temporary folder (review: the main path was untested); no statistic changes",
    equivalence: "scratch check 2026-10-08 (offline stub, no network): the amended-A runner and this runner give the same signals on the real folder (11 snapshot days; S1 76, S2 249, S3 2) and with a synthetic Thanksgiving + Saturday file (12 days; S1 83, S2 249, S3 2); --read refused with the Thanksgiving file present" },
  folder: { listedAt: new Date().toISOString(), datedFiles: dated.length, weekdayFiles: weekdays.length, filesDatedAnNyseClosure: holidayNow.length, first: dated[0], last: dated[dated.length - 1] },
  nightlyAtNote: nightly, notedBy: "backend/note-r179-holiday-files.js", appliedAt: new Date().toISOString(),
};
function entryEdits(t) {
  const tokens = [...(t.amendments || []).filter((a) => a && a.token && a.key !== KEY).map((a) => `${a.date} ${a.token}`), `${DATE} ${TOKEN}`];
  const st0 = String(t.status || ""), re = /^(REGISTERED \d{4}-\d{2}-\d{2})(?: \(amendments: [^)]*\))?/;
  return { was: { status: st0 }, becomes: { status: re.test(st0) ? st0.replace(re, `$1 (amendments: ${tokens.join("; ")})`) : `${st0} [amendments: ${tokens.join("; ")}]` } };
}
const crRow = { id: `r179-note-${KEY}`, date: DATE, recordedAt: Date.now(), area: "registry + runner — R179 retail chatter (dated note: weekday market-holiday files OPEN)", category: "registration", breaksComparability: false,
  change: `R179 dated note ${DATE} (no rule / population / statistic change): the ${PRIOR_KEY} amendment's "weekday market holidays included, read exactly as before" holds for the code, but from W1 the VPS records on NYSE full closures (first ${firstClosure}) which the home chain never did; whether R179 ignores such files or reads them as a disclosed population change is OPEN for the operator, before ${firstClosure}. Runner: such files reported nightly (weekdayHolidayFiles), --read refuses while one is present and undecided; main's loader moved into loadSnapshots() and tested; --selftest-weekday ${selftest}; sha256 ${runnerSha.slice(0, 16)}...`,
  why: "Adversarial review 2026-10-08 of the weekday-files amendment, finding 1 (major).", doesNotEstablish: "Any R179 result; no decision on the holiday files.", operator: "assistant 2026-10-08 (the decision is the operator's)", files: ["backend/r179-chatter-grade.js", "backend/note-r179-holiday-files.js"] };
const ledgerLine = { ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "dated-note-open-decision", tests: [ID], key: KEY, detail: `weekday market-holiday files (first ${firstClosure}) are not covered by "R179 A"; OPEN for the operator before ${firstClosure}; runner interlock: --read refuses while one is present and undecided`, runnerSha256: runnerSha, selftest };

if (DRY) {
  const ef = entryEdits(first.t);
  console.log(`${ID} note ${KEY} — DRY RUN (nothing written)`);
  console.log(JSON.stringify({ ...note, entryFields: ef }, null, 1));
  console.log(`would set status: ${ef.becomes.status}`);
  console.log(`would append change-registry row ${crRow.id} and one GOVERNANCE line`);
  process.exit(0);
}

// ── 5. write ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
fenceCheck();
const fresh = readReg(); if (JSON.stringify(fresh.t) !== snap) die("the R179 entry changed between reads — re-run");
const ef = entryEdits(fresh.t); note.entryFields = ef;
(fresh.t.amendments = fresh.t.amendments || []).push(note); fresh.t.status = ef.becomes.status;
fresh.reg.asOf = new Date().toISOString(); writeJsonAtomic(REG, fresh.reg);
{
  const chk = entryOf(readJsonFile(REG)), keep = JSON.parse(snap), same = (k) => JSON.stringify(chk[k]) === JSON.stringify(keep[k]);
  const ok = chk && (chk.amendments || []).filter((a) => a && a.key === KEY).length === 1 && chk.status === ef.becomes.status && chk.amendments.length === (keep.amendments || []).length + 1
    && JSON.stringify(chk.amendments.slice(0, -1)) === JSON.stringify(keep.amendments || []) && ["rule", "bar", "statistic", "decisionRule", "readCondition", "multiplicityFamily", "evidenceStart", "knownWeaknesses", "script", "interimKill"].every(same);
  if (!ok) die("post-write verification failed — inspect the registry (the registry write happened)");
}
const cr = readJsonFile(D("change-registry.json")); if (!Array.isArray(cr)) die("change-registry.json is not an array (the registry note IS written — append the change row by hand)");
cr.push(crRow); writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify(ledgerLine) + "\n");
console.log(`${ID} dated note ${DATE} written (${KEY}): holiday files OPEN for the operator before ${firstClosure}; runner sha256 ${runnerSha.slice(0, 16)}..., selftest-weekday ${selftest}; status: ${ef.becomes.status}; change-registry row ${crRow.id}; GOVERNANCE line appended`);
