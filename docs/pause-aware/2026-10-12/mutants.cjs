#!/usr/bin/env node
"use strict";
/**
 * PAUSE-AWARE (2026-10-12) — MUTATION CHECK of the selftest. Read-only on the repo and on this package. Two kinds of mutant:
 *   a broken STAGED EDIT   a broken copy of edits.json in a temp folder, which only the selftest reads (PAUSE_AWARE_SELFTEST_EDITS)
 *   a broken ENGINE        a broken copy of lib.cjs in a temp folder, served to the selftest process in place of the real one by
 *                          harness/overlay.cjs (the edit states and the marks, the fences, apply, rollback and its report)
 * deploy.cjs, rollback.cjs and verify-live.cjs always use the package's own edits.json and lib.cjs.
 *   node docs/pause-aware/2026-10-12/mutants.cjs            every mutant, each against the selftest cases that should catch it
 *   node docs/pause-aware/2026-10-12/mutants.cjs <id> ...   the named mutants only
 * A mutant is KILLED when the selftest fails on it; where its known answer sits in several places (a list of cases), every place must fail
 * alone. One that SURVIVES is a hole in the selftest. Exit 0 every mutant killed · 1 a survivor or a mutant that could not be built. It
 * takes several minutes: each run starts the touched files' selftests it needs.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process");
const L = require("./lib.cjs");
const BOTH_OWN = (id) => [id, id + "@w1-staged"];
const CMP_PKG = "compare.cjs: a DIFF that is the pause", CMP_OWN = "existing selftest of docs/server/wave3-sleeves/compare.cjs", OPS_HABIT = "ops-health.js: a paused ledger is judged WHATEVER";
const OPS_OWNER = "ops-health.js: a switch on this PC is a pause only", DECAY_OWNER = "decay-monitor.js: data/r295-OFF is a pause only", DECAY_SELF = "existing selftest of backend/decay-monitor.js";
const CONSOLE_PKG = "console.js 'Pause switches'", CONSOLE_SELF = "existing selftest of backend/console.js", DECLARES = "what a unit declares";
/** [id, what it breaks, edit ids, from, to, the selftest cases that must catch it (a regex on their names)] */
const MUTANTS = [
  ["guard-ignores-absent", "a switch absent on the server is let through", BOTH_OWN("own-guard-fn"), "if (!have) bad.push(", "if (false) bad.push(", "cutover guard on a fake server|own.cjs cannot go round|existing selftest of deploy/server/own.cjs"],
  ["guard-asks-shadow", "the guard asks the SHADOW tree", BOTH_OWN("own-guard-fn"), "srv = PS.remoteShas(ssh, remoteData, names); }", "srv = PS.remoteShas(ssh, String(remoteData).replace(\"/home/traids/traids\", \"/home/traids/w3-shadow\"), names); }", "cutover guard on a fake server|own.cjs cannot go round"],
  ["guard-fail-open", "a server that cannot be asked is let through", BOTH_OWN("own-guard-fn"), "let srv; try { srv = PS.remoteShas(ssh, remoteData, names); }", "let srv; try { try { srv = PS.remoteShas(ssh, remoteData, names); } catch (e0) { return { refuse: null, lines: [], set }; } }", "cutover guard on a fake server|own.cjs cannot go round"],
  ["guard-halt-by-name-only", "an empty *.json halt on the server passes for the halt", BOTH_OWN("own-guard-fn"), "else if (json && have !== sha(", "else if (false && have !== sha(", "cutover guard on a fake server"],
  ["guard-blind-cell-passes", "a W3 unit whose cell table does not load is let through", BOTH_OWN("own-guard-fn"), "if (sw == null) blind.push(u); else for", "if (sw == null) continue; else for", "existing selftest of deploy/server/own.cjs"],
  ["own-guard-not-wired", "own.cjs computes the guard and ignores it", BOTH_OWN("own-guard-call"), "if (pz.refuse) throw new Error(pz.refuse);", "if (false) throw new Error(pz.refuse);", "own.cjs cannot go round|existing selftest of deploy/server/own.cjs"],
  ["w3-guard-not-wired", "the W3 cutover computes the guard and ignores it", ["w3d-guard-call"], "if (pg.refuse) throw new Error(pg.refuse);", "if (false) throw new Error(pg.refuse);", "existing selftest of docs/server/wave3-sleeves/deploy.cjs"],
  ["w3-guard-wrong-dir", "the W3 cutover looks for home's switch beside the code, not beside the map", ["w3d-sig"], "homeData = path.dirname(mapFile)", "homeData = path.join(root, \"no-such-data\")", "existing selftest of docs/server/wave3-sleeves/deploy.cjs"],
  ["compare-switch-changes-verdict", "a session explained by the pause is turned CLEAN", ["cmp-print"], "    for (const s of r.sessions) log(", "    for (const s of r.sessions) if (pauseNote(s, paused, u)) s.state = \"CLEAN\";\n    for (const s of r.sessions) log(", "compare.cjs: a DIFF that is the pause"],
  ["compare-note-never", "the pause is never named", ["cmp-fn"], "const P = (paused || []).filter((p) => p.since <= s.day); if (!P.length) return \"\";", "const P = []; if (!P.length) return \"\";", "compare.cjs: a DIFF that is the pause"],
  ["compare-note-any-date", "a switch set after the session explains it", ["cmp-fn"], ".filter((p) => p.since <= s.day)", ".filter(() => true)", "compare.cjs: a DIFF that is the pause"],
  ["compare-note-on-home-only", "'home decided, the shadow did not' is called the pause", ["cmp-fn"], "!/the shadow decided, home did not: /.test(String(s.note || \"\"))", "!/did not: /.test(String(s.note || \"\"))", "compare.cjs: a DIFF that is the pause"],
  ["ops-quiet-always", "a paused leg with an exit due stays quiet", ["oh-paused"], "if (!due.length) { pausedQuiet.push(f); return true; }", "if (true) { pausedQuiet.push(f); return true; }", "ops-health.js writers block"],
  ["ops-exempt-without-switch", "the exemption applies with no switch set", ["oh-paused"], "if (!fs.existsSync(D(p.sw))) continue;", "if (false) continue;", "ops-health.js writers block"],
  ["ops-unreadable-is-ok", "an unreadable state counts as nothing due", ["oh-paused"], "(${String(err && err.message).slice(0, 80)})`; return false; }", "(${String(err && err.message).slice(0, 80)})`; return true; }", "ops-health.js writers block"],
  ["ops-review-never", "the exemption never comes up for review", ["oh-paused"], "const PAUSED_REVIEW_BY = \"2026-11-13\";", "const PAUSED_REVIEW_BY = \"2099-01-01\";", "ops-health.js writers block"],
  ["ops-due-before-close", "a lot due today counts as due before the close", ["oh-paused"], "(d === e.date && e.mins >= 16 * 60)", "(d === e.date)", "ops-health.js writers block"],
  ["ops-closed-lot-ignored", "a lot closed after the last write owes no row", ["oh-paused"], "else if (l.status === \"closed\" && Date.parse(l.exitFilledAt) > lastWriteMs) due.push(", "else if (false) due.push(", "ops-health.js writers block"],
  ["decay-paused-always", "R295 is read as paused with no switch", ["dm-r295-head"], "paused = sw && host === \"home\";", "paused = true;", "decay-monitor.js: R295 is PAUSED|existing selftest of backend/decay-monitor.js"],
  ["decay-touches-other-legs", "every leg's row gains a field", ["dm-row"], "if (got.paused) row.paused = got.paused;", "row.paused = got.paused || null;", "decay-monitor.js: R295 is PAUSED"],
  ["decay-not-on-line", "the paused leg is not named on the line", ["dm-line"], "...named, ...pausedLegs(out)].join(", "...named, ...pausedLegs({ legs: [] })].join(", "decay-monitor.js: R295 is PAUSED|existing selftest of backend/decay-monitor.js"],
  ["activity-typed-date", "the pause date is typed again", ["aa-pause-map"], "(PAUSED ${mmdd(z.since)};", "(PAUSED 10-10;", "all-activity-per-day.js"],
  ["activity-one-today-row", "the second 'today' row is never printed", ["aa-totals"], "if (holding.length) row(TODAY_HELD, $(afterHeld),", "if (false) row(TODAY_HELD, $(afterHeld),", "all-activity-per-day.js"],
  ["activity-paused-still-counted", "paused legs stay inside 'today'", ["aa-totals"], "sleevesRunning = sum(runningLegs.map(val))", "sleevesRunning = sum(counted.map(val))", "all-activity-per-day.js"],
  ["activity-flat-leg-held", "a flat paused leg is kept in the second row", ["aa-totals"], "holding = pausedLegs.filter((x) => PZ.get(x).n !== 0)", "holding = pausedLegs.slice()", "all-activity-per-day.js"],
  ["activity-label-not-replaced", "the loop's typed label 'except R295' is printed again", ["aa-totals"], "RELABEL.set(\"today: everything running except R295\", TODAY_OUT);", "", "all-activity-per-day.js"],
  ["console-still-ok", "a home switch for a server-owned sleeve reads OK", ["cs-state"], "hard.length || away.length ? ATTENTION", "hard.length || (away.length && false) ? ATTENTION", "console.js 'Pause switches'|existing selftest of backend/console.js"],
  ["console-guard-attention", "the R309 guard turns ATTENTION", ["cs-away"], "if (k.homeGuard) { guard.push(n);", "if (false) { guard.push(n);", "console.js 'Pause switches'|existing selftest of backend/console.js"],
  ["console-no-what-to-do", "the line does not say what to do", ["cs-parts"], " If it should be paused, the same file must be set on the server; if the pause is over, remove it here", "", "console.js 'Pause switches'"],
  ["console-home-owned-attention", "a home-owned sleeve's switch turns ATTENTION", ["cs-away"], "if (k.unit && units && units[k.unit] === \"server\") {", "if (k.unit && units) {", "console.js 'Pause switches'|existing selftest of backend/console.js"],
  // the mutants the review of 2026-10-12 (cycle 1) found alive. Where the known answer was added in several places, each place must kill the mutant alone.
  ["guard-second-switch-first-answer", "every switch is judged by the FIRST switch's answer", BOTH_OWN("own-guard-fn"), "const have = srv.get(s), json = ", "const have = srv.get(names[0]), json = ", ["cutover guard, more than one switch", "existing selftest of deploy/server/own.cjs", "existing selftest of docs/server/wave3-sleeves/deploy.cjs"]],
  ["guard-refuses-only-if-all-missing", "the guard refuses only when EVERY set switch is missing", BOTH_OWN("own-guard-fn"), "if (bad.length) return { refuse: `PAUSED at home", "if (bad.length === set.length) return { refuse: `PAUSED at home", ["cutover guard, more than one switch", "existing selftest of deploy/server/own.cjs", "existing selftest of docs/server/wave3-sleeves/deploy.cjs"]],
  ["w3-open-without-own-guard", "an own.cjs without the guard is let through by the W3 cutover", ["w3d-guard-fn"], "return { refuse: \"deploy/server/own.cjs has no pause guard (it is not the 2026-10-12 version), so a pause set at home could not be checked at the move — REFUSED (nothing changed; fail-closed)\", lines: [] };", "return { refuse: null, lines: [] };", ["cutover guard, more than one switch", "existing selftest of docs/server/wave3-sleeves/deploy.cjs"]],
  ["ops-pending-lot-never-due", "a lot still pending past its exit day owes nothing", ["oh-paused"], "if ([\"pending\", \"open\", \"exiting\"].includes(l.status)) {", "if ([\"open\", \"exiting\"].includes(l.status)) {", "ops-health.js writers block"],
  ["decay-paused-hides-unknown", "a paused leg that is UNKNOWN is also named as paused", ["dm-line-fn"], "out.legs.filter((r) => r.paused && r.state !== \"UNKNOWN\")", "out.legs.filter((r) => r.paused)", "decay-monitor.js: R295 is PAUSED"],
  // the breaks behind the review of 2026-10-12, cycle 2: an exit explained away by the pause, and a paused ledger that drops out of sight under the habit rule
  ["compare-exit-is-the-pause", "an exit home did not send is explained by an entries-only switch", ["cmp-fn"], "all = P.some((p) => p.exitsToo);", "all = true;", [CMP_PKG, CMP_OWN]],
  ["compare-every-id-an-entry", "every id the shadow planned alone is taken for a new entry", ["cmp-fn"], "const entries = ids.filter((x) => isEntry(u, x)), exits = ids.filter((x) => !isEntry(u, x)),", "const entries = ids.slice(), exits = [],", [CMP_PKG, CMP_OWN]],
  ["compare-exits-too-table-empty", "r151-OFF and r231-OFF are taken for entries-only switches", ["cmp-fn"], "const STOPS_EXITS_TOO = [\"r151-OFF\", \"r231-OFF\"];", "const STOPS_EXITS_TOO = [];", [CMP_PKG, CMP_OWN]],
  ["compare-halt-says-nothing", "a halt file's own stopsExits is not read", ["cmp-fn"], "exitsToo = JSON.parse(fs.readFileSync(f, \"utf8\")).stopsExits === true;", "exitsToo = false;", CMP_OWN],
  ["compare-unit-not-passed", "the printed line does not hand the unit to pauseNote", ["cmp-print"], "    for (const s of r.sessions) log(`  ${s.day}  ${s.state.padEnd(7)} ${s.note}${pauseNote(s, paused, u)}`);", "    for (const s of r.sessions) log(`  ${s.day}  ${s.state.padEnd(7)} ${s.note}${pauseNote(s, paused)}`);", [CMP_PKG, CMP_OWN]],
  ["ops-low-habit-not-judged", "a paused ledger under the habit rule is not judged: its exits go unwatched from about the fifth quiet night", ["oh-paused"], "  if (habit !== null && habit >= 4) continue;        // the loop below judges it", "  continue;", OPS_HABIT],
  ["ops-low-habit-always-fires", "a paused ledger under the habit rule is reported with nothing due", ["oh-paused"], "  if (!quiet) note(\"writer\", f, `${age.toFixed(0)}h stale", "  if (true) note(\"writer\", f, `${age.toFixed(0)}h stale", OPS_HABIT],
  ["ops-low-habit-expiry-silent", "under the habit rule the expired exemption is never reported", ["oh-paused"], "  if (expired) note(\"check\",", "  if (false) note(\"check\",", OPS_HABIT],
  ["ops-said-twice", "a ledger the files loop judges is judged by the second loop as well", ["oh-paused"], "  if (habit !== null && habit >= 4) continue;", "  if (false) continue;", ["ops-health.js writers block", OPS_HABIT]],
  ["ops-git-unreadable-skipped", "with git history unreadable a paused ledger is not judged", ["oh-paused"], "habit = cadence ? cadence[f] || 0 : null;", "habit = cadence ? cadence[f] || 0 : 8;", OPS_HABIT],
  ["ops-expired-still-listed", "past its review-by a paused ledger is still listed as quiet on purpose", ["oh-paused"], " if (expired) pausedQuiet.length = listed;", "", OPS_HABIT],
  ["ops-fresh-ledger-judged", "a ledger written tonight is judged by the second loop", ["oh-paused"], "  if (age <= STALE_FILE_H) continue;", "  if (false) continue;", OPS_HABIT],
  ["ops-unpaused-judged", "an un-paused ledger comes to the second loop", ["oh-paused"], "const e = CONDITIONAL_WRITERS[f]; if (!e || !fs.existsSync(D(f))) continue;", "const e = CONDITIONAL_WRITERS[f] || { reviewBy: PAUSED_REVIEW_BY, reason: \"x\", quietOk: () => false }; if (!fs.existsSync(D(f))) continue;", OPS_HABIT],
  // the breaks behind the review of 2026-10-12, cycle 3: a switch on this PC taken as proof of a pause whoever runs the leg (ops-health, the leg monitor, the dollar page);
  // a manifest list standing in for the cell table, a name dropped silently, a move that declares nothing saying nothing; the Console reading OK when the owners cannot be read;
  // a lot with a status the runners do not set read as nothing due
  ["ops-server-owned-exempt", "a switch on this PC exempts a ledger whose leg the SERVER runs", ["oh-paused"], "  if (own.host !== \"home\") {", "  if (false) {", OPS_OWNER],
  ["ops-owner-unreadable-exempt", "a leg whose owner cannot be read is taken to run on this PC", ["oh-paused"], "  if (own.host !== \"home\") {", "  if (own.host === \"server\") {", OPS_OWNER],
  ["ops-not-named-is-home", "a unit the ownership map does not name is taken to run on this PC", ["oh-paused"], ": { host: null, why: `data/host-ownership.json does not name ${u}` });", ": { host: \"home\" });", OPS_OWNER],
  ["ops-not-home-listed-quiet", "a ledger whose switch does not count is still 'quiet is ok'", ["oh-paused"], "CONDITIONAL_WRITERS[f] = { reviewBy: \"9999-12-31\", quietOk: () => false, reason:", "CONDITIONAL_WRITERS[f] = { reviewBy: \"9999-12-31\", quietOk: () => { pausedQuiet.push(f); return true; }, reason:", OPS_OWNER],
  ["ops-unknown-status-nothing-due", "a lot with a status the runners do not set owes nothing", ["oh-paused"], "    else if (![\"closed\", \"unfilled\", \"orphan\"].includes(l.status)) throw new Error(", "    else if (false) throw new Error(", "ops-health.js writers block"],
  ["ops-orphan-is-unknown", "an orphan lot (a status the runner sets) is taken for an unknown one", ["oh-paused"], "    else if (![\"closed\", \"unfilled\", \"orphan\"].includes(l.status)) throw new Error(", "    else if (![\"closed\", \"unfilled\"].includes(l.status)) throw new Error(", "ops-health.js writers block"],
  ["decay-server-owned-paused", "R295 run by the SERVER is read as paused by the switch on this PC", ["dm-r295-head"], "paused = sw && host === \"home\";", "paused = sw && host !== null;", [DECAY_OWNER, DECAY_SELF]],
  ["decay-owner-unreadable-paused", "R295 is read as paused when which machine runs it cannot be read", ["dm-r295-head"], "paused = sw && host === \"home\";", "paused = sw && host !== \"server\";", [DECAY_OWNER, DECAY_SELF]],
  ["decay-reason-silent", "the UNKNOWN reason does not say the switch was not taken as a pause", ["dm-r295-head"], "    catch (e) { if (notHere && e instanceof Unknown && / — the writer may have stopped$/.test(e.message)) throw new Unknown(`${e.message} (${notHere})`); throw e; }", "    catch (e) { throw e; }", [DECAY_OWNER, DECAY_SELF]],
  ["activity-server-owned-paused", "a leg the SERVER runs is tagged PAUSED by a switch on this PC and left out of 'today'", ["aa-pause-map"], "  if (host !== \"home\") return { id: p.id,", "  if (false) return { id: p.id,", "all-activity-per-day.js"],
  ["activity-owner-unreadable-paused", "a leg whose owner cannot be read is tagged PAUSED", ["aa-pause-map"], "  if (host !== \"home\") return { id: p.id,", "  if (host === \"server\") return { id: p.id,", "all-activity-per-day.js"],
  ["activity-not-here-left-out", "a leg whose switch does not count is still left out of 'today'", ["aa-rows"], "PZ = new Map(counted.map((x) => [x, SW.get(x) && !SW.get(x).notHere ? SW.get(x) : null]));", "PZ = SW;", "all-activity-per-day.js"],
  ["console-owner-unreadable-ok", "a switch that lets exits continue reads OK when where its job runs cannot be read", ["cs-away"], "      if (k.unit && !units && !k.stopsExits) { blind.push(n);", "      if (false) { blind.push(n);", [CONSOLE_PKG, CONSOLE_SELF]],
  ["console-blind-still-ok", "such a switch is named but the line still reads OK", ["cs-state"], "unknown.length || blind.length ? UNKNOWN", "unknown.length ? UNKNOWN", [CONSOLE_PKG, CONSOLE_SELF]],
  ["console-hard-switch-unknown", "a switch that also stops exits turns UNKNOWN when the owners cannot be read (it is ATTENTION on either machine)", ["cs-away"], "      if (k.unit && !units && !k.stopsExits) { blind.push(n);", "      if (k.unit && !units) { blind.push(n);", [CONSOLE_PKG, CONSOLE_SELF]],
  ["console-not-named-unknown", "a job a READABLE ownership file does not name turns UNKNOWN (it has not been entered to move: it runs here)", ["cs-away"], "      if (k.unit && !units && !k.stopsExits) { blind.push(n);", "      if (k.unit && !(units && units[k.unit] === \"home\") && !k.stopsExits) { blind.push(n);", [CONSOLE_PKG, CONSOLE_SELF]],
  ["guard-manifest-list-replaces-cell", "a manifest's `switches` list stands in for the W3 cell table (an empty list switches the guard off)", BOTH_OWN("own-guard-fn"), "? [...new Set([...cell, ...mine])] : null; }", "? (def && Array.isArray(def.switches) ? mine : cell.slice()) : null; }", [DECLARES, "existing selftest of deploy/server/own.cjs"]],
  ["guard-bad-name-dropped", "a name that is not a plain file name is dropped silently", BOTH_OWN("own-guard-fn"), "  if (badSwitchList(def)) return null;\n  const mine = def && Array.isArray(def.switches) ? def.switches.slice() : [];", "  const mine = def && Array.isArray(def.switches) ? def.switches.filter(plainName) : [];", [DECLARES, "existing selftest of deploy/server/own.cjs"]],
  ["guard-undeclared-says-nothing", "a move whose units declare no switch prints no NOT CHECKED line", BOTH_OWN("own-guard-fn"), "  const stray = declared.length ? [] : strayHomeSwitches(homeDir, cellFile),", "  const stray = [],", [DECLARES, "existing selftest of deploy/server/own.cjs"]],
  ["guard-stray-names-everything", "the NOT CHECKED line names the home machine's guard and W3 sleeves' own switches too", BOTH_OWN("own-guard-fn"), " && n !== \"r309-HALT\" && !w3.includes(n)).sort();", ").sort();", [DECLARES, "existing selftest of deploy/server/own.cjs"]],
  // the five mutants the review of 2026-10-12 reported alive in its fourth batch. Two had been killed since (an own.cjs without the guard: w3-open-without-own-guard,
  // above, with a second form of it here; a paused leg that is UNKNOWN named as paused: decay-paused-hides-unknown, above). The other three, and the typed "flat":
  ["w3-guard-skipped-with-from", "the W3 cutover skips the pause guard when --from is given", ["w3d-guard-call"], "if (pg.refuse) throw new Error(pg.refuse);", "if (pg.refuse && !from) throw new Error(pg.refuse);", "existing selftest of docs/server/wave3-sleeves/deploy.cjs"],
  ["own-guard-not-on-resume", "own.cjs skips the guard on a RESUMED cutover (home's map already says server; the map push of an earlier run did not land)", BOTH_OWN("own-guard-call"), "{ const pz = pauseGuard(defs, homeDir, ssh, M.remoteData, { cellFile: deps.cellFile, host: deps.host });", "{ const pz = allServer ? { refuse: null, lines: [] } : pauseGuard(defs, homeDir, ssh, M.remoteData, { cellFile: deps.cellFile, host: deps.host });", ["own.cjs cannot go round", "existing selftest of deploy/server/own.cjs"]],
  ["w3-own-without-guard-not-checked", "the W3 cutover does not look whether own.cjs has the guard at all", ["w3d-guard-fn"], "  if (typeof OWN.pauseGuard !== \"function\") return { refuse:", "  if (false) return { refuse:", ["cutover guard, more than one switch", "existing selftest of docs/server/wave3-sleeves/deploy.cjs"]],
  ["console-halt-json-ok", "a leg's own halt file (-HALT.json) whose leg runs on the server still reads OK: only -OFF names turn ATTENTION", ["cs-away"], "      if (k.unit && units && units[k.unit] === \"server\") {", "      if (k.unit && units && units[k.unit] === \"server\" && !/-HALT\\.json$/.test(n)) {", [CONSOLE_PKG, CONSOLE_SELF]],
  ["activity-r295-flat-typed", "R295's 'flat' is typed again, whatever its ledger says", ["aa-pause-map"], "open: ledgerOpen(\"r295-ledger.jsonl\") },", "open: () => ({ n: 0, until: null }) },", "all-activity-per-day.js"],
  ["activity-r295-unreadable-is-flat", "a ledger whose newest row carries no list of open lots reads 'flat'", ["aa-pause-map"], "if (!last || !Array.isArray(last.openLotsAtClose)) throw new Error(\"the newest ledger row carries no list of lots left open at its close\");", "if (!last || !Array.isArray(last.openLotsAtClose)) return { n: 0, until: null };", "all-activity-per-day.js"],
  ["activity-r295-first-row-read", "the FIRST row of R295's ledger is read, not the newest", ["aa-pause-map"], "(!last || r.date >= last.date)) last = r;", "(!last)) last = r;", "all-activity-per-day.js"],
  ["activity-r295-duplicate-first-wins", "of two rows of one date the earlier one in the file is read", ["aa-pause-map"], "(!last || r.date >= last.date)) last = r;", "(!last || r.date > last.date)) last = r;", "all-activity-per-day.js"],
];
/**
 * Mutants of the ENGINE (lib.cjs: the edit states, the fences, apply and rollback). [id, what it breaks, from, to, the selftest cases that must
 * catch it]. The broken lib.cjs is a temp file; harness/overlay.cjs serves it to the selftest process in place of the real one (nothing here is written).
 */
const DRIFT = "an edit made elsewhere in a file is kept", HALF = "a file that changes while the apply runs", WINDOWS = "the time windows and the running-process fence";
const MARKS = "a line changed INSIDE a block this unit inserted", ROLLBACK = "a rollback is DONE only when";
const LIB_MUTANTS = [
  ["engine-anchor-twice-is-base", "an anchor found twice reads 'base'", "if (nNew === 0 && nOld === 1) return anyMark(text, e) ?", "if (nNew === 0 && nOld >= 1) return anyMark(text, e) ?", DRIFT],
  ["engine-applied-with-stray-old", "'applied' with a stray extra copy of the old block", "if (nNew === 1 && nOld === oldInNew) return \"applied\";", "if (nNew === 1) return \"applied\";", DRIFT],
  ["fence-holiday-lookup-inverted", "the real holiday lookup is inverted: an ordinary weekday is 'not a trading day'", "try { return !require(path.join(REPO, \"backend\", \"lib\", \"run-window.js\")).marketHoliday(mt.date); }", "try { return !!require(path.join(REPO, \"backend\", \"lib\", \"run-window.js\")).marketHoliday(mt.date); }", WINDOWS],
  ["fence-holiday-table-fail-open", "a holiday table that cannot be read counts as NOT a trading day", ".marketHoliday(mt.date); } catch { return true; }", ".marketHoliday(mt.date); } catch { return false; }", WINDOWS],
  ["apply-no-second-sha-check", "the live bytes are not looked at again before the write", "  for (const w of work) if (sha256(fs.readFileSync(w.file)) !== w.beforeSha) return { result: \"refused\", why: [`${w.rel} changed while this was running — nothing written`] };\n", "", HALF],
  ["apply-no-second-fence-check", "the fences are not asked again before the write", "\n  fz = fences({ ms, files, procList, holidays }); if (fz.length) return { result: \"refused\", why: fz };", "", HALF],
  ["apply-failed-write-not-restored", "after a failed write the files already written are left as they are", "const left = []; for (const w of done.reverse()) { try { writeExact(w.file, w.before); if (sha256(fs.readFileSync(w.file)) !== w.beforeSha) left.push(w.rel); } catch { left.push(w.rel); } }", "const left = [];", HALF],
  ["apply-torn-file-not-restored", "a file whose write landed wrong bytes is not among those put back", "write(w.file, w.after); done.push(w); if (sha256(fs.readFileSync(w.file)) !== w.afterSha) throw new Error(`${w.rel} does not verify after the write`); }\n  } catch (e) {", "write(w.file, w.after); if (sha256(fs.readFileSync(w.file)) !== w.afterSha) throw new Error(`${w.rel} does not verify after the write`); done.push(w); }\n  } catch (e) {", HALF],
  ["rollback-failed-write-not-restored", "after a failed rollback write the files already put back are left as they are", "catch (e) { const left = []; for (const w of done.reverse()) { try { writeExact(w.file, w.before); } catch { left.push(w.rel); } } return", "catch (e) { const left = []; return", HALF],
  ["rollback-torn-file-not-restored", "a rollback file whose write landed wrong bytes is not among those put back", "write(w.file, w.after); done.push(w); if (sha256(fs.readFileSync(w.file)) !== w.afterSha) throw new Error(`${w.rel} does not verify after the write`); } }\n  catch (e) {", "write(w.file, w.after); if (sha256(fs.readFileSync(w.file)) !== w.afterSha) throw new Error(`${w.rel} does not verify after the write`); done.push(w); } }\n  catch (e) {", HALF],
  ["apply-restore-failure-hidden", "a restore that itself fails is reported as restored", "    return { result: \"failed\", why: [e.message], restored: !left.length, notRestored: left };\n  }\n", "    return { result: \"failed\", why: [e.message], restored: true, notRestored: [] };\n  }\n", HALF],
  ["rollback-restore-failure-hidden", "a rollback restore that itself fails is reported as restored", "} } return { result: \"failed\", why: [e.message], restored: !left.length, notRestored: left }; }", "} } return { result: \"failed\", why: [e.message], restored: true, notRestored: [] }; }", HALF],
  // the review of 2026-10-12, cycle 2: an applied insert whose block was changed afterwards read "base" (26 of the 50 edits), and a rollback that left a file changed still said "rolled back"
  ["engine-changed-insert-is-base", "an applied insert whose block was changed afterwards reads 'base'", "if (nNew === 0 && nOld === 1) return anyMark(text, e) ? \"drift\" : \"base\";", "if (nNew === 0 && nOld === 1) return \"base\";", MARKS],
  ["engine-insert-needs-no-marks", "an edit list whose inserts carry no marks is accepted", "if (!Array.isArray(e.marks) || !e.marks.length || e.marks.some(", "if (Array.isArray(e.marks) && e.marks.length && e.marks.some(", MARKS],
  ["marks-ignore-the-base-text", "a piece that is already in the base file is taken for a mark", "free = (p) => !baseText.includes(p) && others.every((o) => !o.new.includes(p));", "free = (p) => others.every((o) => !o.new.includes(p));", MARKS],
  ["marks-ignore-other-blocks", "a piece that sits in another block of the same file is taken for a mark", "free = (p) => !baseText.includes(p) && others.every((o) => !o.new.includes(p));", "free = (p) => !baseText.includes(p);", MARKS],
  ["rollback-not-exact-is-a-pass", "a rollback that leaves a file NOT its recorded bytes ends as a pass", "const code = notExact.length ? 1 : noRecord.length || !rows.length ? 3 : 0;", "const code = noRecord.length || !rows.length ? 3 : 0;", ROLLBACK],
  ["rollback-no-record-is-a-pass", "a rollback with no record of the apply to compare with ends as a pass", "const code = notExact.length ? 1 : noRecord.length || !rows.length ? 3 : 0;", "const code = notExact.length ? 1 : 0;", ROLLBACK],
  // the review of 2026-10-12, cycle 3: the write mode said "undone" when the undo itself had been refused
  ["undo-refused-reported-undone", "a refused undo is reported as 'undone'", "result: b.result === \"rolled-back\" ? \"undone\" : \"applied-not-undone\"", "result: \"undone\"", "the write mode start to finish"],
  ["undo-refused-says-restore-by-hand", "the words for a refused undo do not say the files are still the applied text", "  the ${n} files are STILL the applied text. The undo was refused: ${rw}", "  rollback: refused — ${rw} — restore from backups/ by hand", "the write mode start to finish"],
];

const only = process.argv.slice(2), ALL_IDS = [...MUTANTS, ...LIB_MUTANTS].map((m) => m[0]);
const todo = MUTANTS.filter((m) => !only.length || only.includes(m[0])), todoLib = LIB_MUTANTS.filter((m) => !only.length || only.includes(m[0]));
if (only.some((x) => !ALL_IDS.includes(x))) { console.error(`unknown mutant id(s): ${only.filter((x) => !ALL_IDS.includes(x)).join(", ")}`); process.exit(2); }
const E0 = JSON.parse(fs.readFileSync(L.EDITS_FILE, "utf8")), T = L.texts(L.loadEdits()), scratch = L.tempDir("mutants");
let killed = 0, survived = 0, broken = 0;
/** the selftest on one mutant, once per place that must catch it alone: KILLED only when every one of those runs fails */
function judge(id, what, places, env) {
  const runs = [].concat(places).map((cases) => { const r = cp.spawnSync(process.execPath, [path.join(L.PKG, "selftest.cjs")], { encoding: "utf8", cwd: L.REPO, env: { ...env, PAUSE_AWARE_ONLY: cases }, timeout: 1200000, windowsHide: true, maxBuffer: 256 << 20 }); const fails = String(r.stdout || "").split("\n").filter((l) => /^FAIL /.test(l)); return { cases, dead: r.status === 1 && fails.length > 0, fails, status: r.status, last: String(r.stdout || "").trim().split("\n").pop() || "" }; });
  const alive = runs.filter((x) => !x.dead);
  if (!alive.length) { killed++; console.log(`KILLED    ${id.padEnd(34)} ${what} — ${runs.length > 1 ? `by each of ${runs.length} places alone; ` : ""}${runs.reduce((n, x) => n + x.fails.length, 0)} check(s) failed, the first: ${runs[0].fails[0].slice(5, 150)}`); }
  else { survived++; console.log(`SURVIVED  ${id.padEnd(34)} ${what} — ${alive.map((x) => `[${x.cases.slice(0, 60)}] exit ${x.status}: ${x.last.slice(0, 120)}`).join(" | ")}`); }
}
try {
  for (const [id, what, ids, from, to, cases] of todo) {
    const E = JSON.parse(JSON.stringify(E0)); let why = null;
    for (const eid of ids) { const e = E.edits.find((x) => x.id === eid); if (!e) { why = `no edit ${eid}`; break; } if (e.new.split(from).length !== 2) { why = `${eid}: the fragment is there ${e.new.split(from).length - 1} times (need 1)`; break; } e.new = e.new.replace(from, () => to); if (e.marks) e.marks = L.marksOf(e, T[e.file].base, E.edits.filter((x) => x.file === e.file && x !== e)); }
    if (!why) { try { L.validateEdits(E); for (const rel of L.filesOf(E)) { const t = L.applyText(T[rel].base, L.editsFor(E, rel)); if (L.isCode(rel)) { const err = L.nodeCheckText(t, rel); if (err) throw new Error(`${rel} does not parse: ${err}`); } } } catch (e) { why = e.message; } }
    if (why) { broken++; console.log(`NOT BUILT ${id.padEnd(34)} ${why}`); continue; }
    const f = path.join(scratch.dir, id + ".json"); fs.writeFileSync(f, JSON.stringify(E));
    judge(id, what, cases, { ...process.env, PAUSE_AWARE_SELFTEST_EDITS: f });
  }
  const LIB_REL = `${L.PKG_REL}/lib.cjs`, libText = fs.readFileSync(path.join(L.PKG, "lib.cjs"), "utf8");
  for (const [id, what, from, to, cases] of todoLib) {
    let why = null; const n = libText.split(from).length - 1, text = n === 1 ? libText.replace(from, () => to) : null;
    if (n !== 1) why = `lib.cjs: the fragment is there ${n} times (need 1)`; else { const err = L.nodeCheckText(text, "lib.cjs"); if (err) why = `the broken lib.cjs does not parse: ${err}`; }
    if (why) { broken++; console.log(`NOT BUILT ${id.padEnd(34)} ${why}`); continue; }
    judge(id, what, cases, L.overlayEnv(path.join(scratch.dir, id), { [LIB_REL]: text }).env);
  }
} finally { scratch.rm(); }
console.log(`MUTANTS: ${killed} killed, ${survived} survived, ${broken} not built, of ${todo.length + todoLib.length}`);
process.exit(survived || broken ? 1 : 0);
