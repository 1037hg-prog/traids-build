#!/usr/bin/env node
/**
 * PROFIT FIXES A (booking correctness) — THE MUTATION LIST, RE-RUNNABLE. 2026-10-12 (docs/profit-fixes/2026-10-12/a-booking/mutants).
 *
 *   node docs/profit-fixes/2026-10-12/a-booking/mutants/run.cjs --list         the list, checked (each change's text is in its file
 *                                                                               exactly once, and gone once replaced). Runs nothing.
 *   node docs/profit-fixes/2026-10-12/a-booking/mutants/run.cjs                first the untouched selftest (it must pass), then every
 *                                                                               change, one at a time. Last line:
 *                                                                               ALL n MUTANTS CAUGHT ...   or   MUTANTS NOT ALL CAUGHT ...
 *   node docs/profit-fixes/2026-10-12/a-booking/mutants/run.cjs --jobs 3       the same, three selftests at a time
 *   node docs/profit-fixes/2026-10-12/a-booking/mutants/run.cjs <id> [<id> …]  only those changes (no untouched run)
 *
 * WHAT A "MUTANT" IS HERE. One deliberate wrong change to one line of the package: a staged edit (so the patched live script the
 * selftest runs in its sandboxes is wrong) or one of the package's own tools. The selftest must FAIL on it, and must fail in the
 * known answer written for that rule (`by`), not by accident somewhere else. Verdicts:
 *   CAUGHT    the selftest failed, and one of the failing cases is the one named for this change
 *   WEAK      the selftest failed, but not in the case named for it — the rule's own known answer did not notice
 *   SURVIVED  the selftest passed with the change in: a known answer is missing
 *   ERROR     no result: the selftest crashed, timed out, or never read the changed file
 * Exit 0 only when every change is CAUGHT.
 *
 * NOTHING ON DISK IS CHANGED. The change is made in memory by mutants/hook.cjs as the selftest's own process reads the file; the
 * selftest then does what it always does (throw-away sandboxes under the OS temp dir, no network, nothing live written). No scratch
 * copy of the package and no link to the live tree is made. One run of the selftest takes about a minute.
 *
 * This list is what can be re-run. The earlier rounds of hand-made changes that NOTES.md's history mentions were made on scratch
 * copies that were not kept; the gaps they found are in the selftest as known answers, and the changes below include one for each
 * rule of each fix, one for each gap the review of 2026-10-12 named in this package's third batch, and (its fourth batch) each change
 * that review reported as passing every check, made here as the review made it.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const PKG = path.resolve(__dirname, ".."), HOOK = path.join(__dirname, "hook.cjs"), SELFTEST = path.join(PKG, "selftest.cjs");
const E = (rel) => `staged/${rel}.edits`;
const OS = E("backend/options-settle.js"), DR = E("automation/daily-run.cjs"), EG = E("backend/lib/enforcement-gates.js"), PS = E("backend/proposals-sleeve.js"), SL = E("backend/options-sleeve.js");

/** id · file (relative to the package) · find (exactly once in the file) · replace · by (a failing case must match) · what the change breaks */
const MUTANTS = [
  // ── fix 4.1 ──
  { id: "ps-kill-not-applied", file: PS, find: "props = propsAll.filter((p) => !KILL.by[p.category]);", replace: "props = propsAll;",
    by: /KNOWN ANSWER: with the fix the killed list's ticket \(AAA\) is NOT booked/, what: "a killed list's proposals are booked after all" },
  { id: "ps-look-at-every-count", file: PS, find: "const t = tOf(days.slice(0, look).map((d) => d.m));", replace: "const t = tOf(days.map((d) => d.m));",
    by: /ONE LOOK, NEVER A LATER COUNT/, what: "the kill looks at every session count, not at the first look only" },
  // ── fix 4.2, the cause (the nightly settle) ──
  { id: "os-debit-sign", file: OS, find: "const pnl = (isDebit ? cost - creditKept : creditKept - cost) * 100 * contracts - commissions;", replace: "const pnl = (creditKept - cost) * 100 * contracts - commissions;",
    by: /KNOWN ANSWER \(DIA debit put 536\/509/, what: "a debit vertical is booked with a credit wing's sign" },
  { id: "os-wings-wait-on-debit", file: OS, find: "const syms = [...new Set(wingsTodo.map((p) => p.sym))];", replace: "const syms = [...new Set(todo.map((p) => p.sym))];",
    by: /THE REGISTERED CALL HOLDS THE WINGS AND NOTHING ELSE|A DEBIT VERTICAL WITH NO BAR DOES NOT STOP THE WINGS/, what: "a debit vertical's symbol is put in the wings' price request" },
  { id: "os-void-norestored", file: OS, find: " && t.voidForEvidence === true && p.obs && p.obs.restoredAfter === t.retired);", replace: " && t.voidForEvidence === true);",
    by: /a voided row does not unblock a position that was not restored after it/, what: "any voided close unblocks its id, restored or not (review 2026-10-12: caught only by an unrelated case)" },
  { id: "os-noexp-skip-complete", file: OS, find: "(p.optExpiry || occExpiry(p)) && barComplete(p.optExpiry || occExpiry(p))", replace: "(p.optExpiry ? barComplete(p.optExpiry) : !!occExpiry(p))",
    by: /NOT YET EXPIRED, TO THE MINUTE, WITH A PRICE THERE/, what: "a position with no optExpiry is treated as expired whatever the date (review 2026-10-12: caught only by an unrelated case)" },
  { id: "os-null-entry-tolerated", file: OS, find: "const expired = board.filter((p) => p.cls === \"Options\" && (p.optExpiry || occExpiry(p))", replace: "const expired = board.filter((p) => p && p.cls === \"Options\" && (p.optExpiry || occExpiry(p))",
    by: /A DAMAGED BOARD IS NEVER HALF-WRITTEN/, what: "a null board entry is stepped over at the first filter, so the run writes the ledger and dies at the board write (review 2026-10-12)" },
  // ── fix 4.7 on the settle ──
  { id: "os-official-unbounded", file: OS, find: ", retries: 0, timeoutMs: 10000 }).then", replace: " }).then",
    by: /A HANGING OFFICIAL FEED DOES NOT COST THE SETTLE ITS NIGHT/, what: "the recording-only read keeps the library's 4 retries of 60 s (review 2026-10-12)" },
  { id: "os-official-as-settle-price", file: OS, find: "const offPnl = offCost == null ? null : +((isDebit ? offCost - creditKept : creditKept - offCost) * 100 * contracts - commissions).toFixed(2);", replace: "const offPnl = +pnl.toFixed(2);",
    by: /fix 4\.7 KNOWN ANSWER: the SPY wing booked -\$197\.20/, what: "the official-close P&L is a copy of the booked one" },
  // ── fix 4.2, the one-time settle ──
  { id: "st-apply-with-pinned", file: "settle-expired-twelve.cjs", find: "if (doApply && pinned) {", replace: "if (false) {",
    by: /THE COMMAND REFUSES --apply WITH --pinned/, what: "an apply from the pinned closes is allowed" },
  { id: "st-no-affectedFrom", file: "settle-expired-twelve.cjs", find: " affectedFrom: T.SPREADS.map((s) => s.expiry).sort()[0],", replace: "",
    by: /the change-registry row says FROM WHEN/, what: "the registry row carries no affectedFrom (review 2026-10-12)" },
  { id: "st-raw-reader-dropped", file: "settle-expired-twelve.cjs", find: ", \"backend/coverage-monitor.js\"];", replace: "];",
    by: /WHO COUNTS THE SIX WINGS TWICE/, what: "one of the raw readers is no longer named in the row's side effects (review 2026-10-12)" },
  { id: "st-nightly-read-raw", file: "settle-expired-twelve.cjs", find: "try { out.nightly = table((await fetchBars(syms, { start: earliest, end: today, timeframe: \"1Day\", requireAll: false,", replace: "try { out.nightly = table((await fetchBars(syms, { start: earliest, end: today, timeframe: \"1Day\", adjustment: \"raw\", requireAll: false,",
    by: /THE DRY RUN'S THREE READS/, what: "the 'adjusted' column is read raw, so it would show no difference (review 2026-10-12)" },
  { id: "st-nightly-booked", file: "settle-expired-twelve.cjs", find: "const row = settleRow(p, S, off, offAsOf);", replace: "const row = settleRow(p, closes.nightly && closes.nightly[s.sym] && Number.isFinite(closes.nightly[s.sym][s.expiry]) ? closes.nightly[s.sym][s.expiry] : S, off, offAsOf);",
    by: /it is printed beside and moves NOTHING/, what: "the adjusted close is used as the settle price when it is there" },
  // ── fix 4.3 ──
  { id: "eg-missing-stamp-passes", file: EG, find: "if (v === undefined || v === null) return { ok: false, kind: \"missing\",", replace: "if (v === undefined || v === null) return { ok: true, kind: \"ok\", bps: 0, at: nowMs }; if (false) return { ok: false, kind: \"missing\",",
    by: /MISSING \(obs without spreadBps\)/, what: "a ticket with no stamp passes the gate, as before the fix" },
  { id: "eg-stale-limit-27h", file: EG, find: "const STAMP_MAX_AGE_MS = 20 * 60 * 1000;", replace: "const STAMP_MAX_AGE_MS = 27 * 60 * 60 * 1000;",
    by: /STALE \(a good 50 bps stamp read 21 minutes ago\)/, what: "the staleness limit is 27 hours" },
  { id: "dr-unknown-printed-as-zero", file: DR, find: "if (!fresh.length && tabEq !== 0) log(", replace: "if (false) log(",
    by: /A ZERO THAT IS NOT KNOWN IS NOT PRINTED/, what: "the entry run prints '0 refused' when the server shows none of the run's tickets (review 2026-10-12)" },
  { id: "dr-unread-count-is-zero", file: DR, find: "Number(tracked.byCls.Equity || 0) : NaN;", replace: "Number(tracked.byCls.Equity || 0) : 0;",
    by: /when the run's own count cannot be read either/, what: "a run whose own count cannot be read is taken to track no equity, so a zero is printed" },
  { id: "dr-no-denominator", file: DR, find: "else log(`  ${fresh.length} new equity ticket(s) of this run are on the server (this run is tracking ${Number.isFinite(tabEq) ? tabEq : \"an unread number of\"} equity in all) — SPREAD STAMP GATE:", replace: "else log(`  SPREAD STAMP GATE:",
    by: /THE DENOMINATOR/, what: "the refusal count is printed with no denominator (review 2026-10-12)" },
  { id: "rg-row-not-breaking", file: "record-stamp-gate-row.cjs", find: "category: \"enforcement\", breaksComparability: true,", replace: "category: \"enforcement\", breaksComparability: false,",
    by: /THE ROW'S APPLY/, what: "the 4.3 registry row is not marked as breaking comparability" },
  // ── fix 4.7 on the sleeve ──
  { id: "sl-width-gate-switched-on", file: SL, find: "const snaps = raw.snapshots || {};", replace: "const snaps = raw.snapshots || raw || {};",
    by: /THE WIDTH GATE IS NOT SWITCHED ON/, what: "the snapshot parse is repaired in place, which switches the width gate on" },
  // ── the deploy's fences ──
  { id: "lib-session-window-open", file: "lib.cjs", find: "if (td && mt.mins >= 5 * 60 + 30 && mt.mins < 16 * 60) why.push(", replace: "if (false) why.push(",
    by: /TIME WINDOW/, what: "the apply is allowed inside the trading session" },
  { id: "lib-owed-rows-not-said", file: "lib.cjs", find: "for (const p of plan) if (p.e.afterApply) say(", replace: "for (const p of []) if (p.e.afterApply) say(",
    by: /THE APPLY SAYS WHAT IT LEAVES OWED TO THE REGISTRY/, what: "the apply no longer says which change-registry rows it leaves owed (review 2026-10-12)" },
  // ── the changes the review of 2026-10-12 reported as passing every check (its fourth batch): each one, as the review made it ──
  { id: "ps-look-at-full-read", file: PS, find: "if (look < B.minSessions) for (const [c, days] of Object.entries(series)) {", replace: "for (const [c, days] of Object.entries(series)) {",
    by: /THE LOOK COMES BEFORE THE FULL READ/, what: "the kill is let run when the look's count is the full read's own count (the review's 'past minSessions')" },
  { id: "ps-pre-evidence-counted", file: PS, find: ".filter((s) => s && s.date >= EV && Array.isArray(s.tickets));", replace: ".filter((s) => s && Array.isArray(s.tickets));",
    by: /EVIDENCE SESSIONS ONLY/, what: "sessions dated before the registered evidence start are counted in the look" },
  { id: "os-resettle-dup", file: OS, find: "(rowsById.get(p.id) || []).some((t) => !voidedRestore(t, p));", replace: "(rowsById.get(p.id) || []).length > 0 && (rowsById.get(p.id) || []).every((t) => !voidedRestore(t, p));",
    by: /NEVER SETTLED TWICE/, what: "a wing that has its expiry row beside its voided row is settled a second time" },
  { id: "os-debit-unreal", file: OS, find: "!p.optCredit && p.optReal === true && !!a", replace: "!p.optCredit && !!a",
    by: /a debit vertical that does not verify: optReal is false/, what: "a debit vertical whose legs were never really picked (optReal not true) is settled" },
  { id: "st-ledger-raw-write", file: "settle-expired-twelve.cjs", find: "if (add.length) L.writeJson(f, [...add, ...cur]);", replace: "if (add.length) fs.writeFileSync(f, JSON.stringify([...add, ...cur], null, 1));",
    by: /THE HOUSE WRITER, the one-time settle/, what: "the one-time settle writes trade_log.json with fs.writeFileSync, round the house's atomic writer" },
  { id: "lib-state-raw-write", file: "lib.cjs", find: "try { writeJson(path.join(stateDir, \"deploy-state.json\"), state); } catch (x) {", replace: "try { fs.writeFileSync(path.join(stateDir, \"deploy-state.json\"), JSON.stringify(state, null, 1)); } catch (x) {",
    by: /THE HOUSE WRITER, the deploy's own record/, what: "the apply writes deploy-state.json with fs.writeFileSync, round the house's atomic writer" },
  { id: "lib-rollback-state-raw-write", file: "lib.cjs", find: "try { writeJson(path.join(stateDir, \"deploy-state.json\"), state); } catch {}", replace: "try { fs.writeFileSync(path.join(stateDir, \"deploy-state.json\"), JSON.stringify(state, null, 1)); } catch {}",
    by: /THE HOUSE WRITER, the deploy's own record/, what: "the rollback writes deploy-state.json with fs.writeFileSync, round the house's atomic writer" },
  { id: "lib-friday-not-a-session", file: "lib.cjs", find: "if (p.dow === \"Sat\" || p.dow === \"Sun\") return false;", replace: "if (p.dow === \"Sat\" || p.dow === \"Sun\" || p.dow === \"Fri\") return false;",
    by: /TIME WINDOW, EVERY WEEKDAY/, what: "Friday is taken for a day without a session, so an apply inside Friday's session goes through" },
];

const count = (text, needle) => text.split(needle).length - 1;
/** the list against the files on disk -> [problems] */
function validate(list = MUTANTS) {
  const bad = [], seen = new Set();
  for (const m of list) {
    if (seen.has(m.id)) bad.push(`${m.id}: the id is used twice`); seen.add(m.id);
    let text; try { text = fs.readFileSync(path.join(PKG, ...m.file.split("/")), "utf8"); } catch (e) { bad.push(`${m.id}: ${m.file} cannot be read (${e.code || e.message})`); continue; }
    const n = count(text, m.find);
    if (n !== 1) { bad.push(`${m.id}: its text occurs ${n}x in ${m.file} (it must occur exactly once)`); continue; }
    if (m.find === m.replace) bad.push(`${m.id}: it changes nothing`);
    if (count(text.replace(m.find, () => m.replace), m.find) !== 0) bad.push(`${m.id}: its text is still in ${m.file} once replaced`);
    if (!(m.by instanceof RegExp)) bad.push(`${m.id}: it names no case that must catch it`);
  }
  return bad;
}

/** one selftest run -> { code, out }. spec null = the untouched selftest. */
function selftest(spec) {
  return new Promise((resolve) => {
    const mark = spec ? path.join(os.tmpdir(), `pfa-mutant-${process.pid}-${spec.id}.mark`) : null, args = spec ? ["-r", HOOK, SELFTEST] : [SELFTEST];
    const env = { ...process.env }; delete env.PFA_MUTANT; delete env.PFA_MUTANT_MARK;
    if (spec) { env.PFA_MUTANT = JSON.stringify({ id: spec.id, file: spec.file, find: spec.find, replace: spec.replace }); env.PFA_MUTANT_MARK = mark; try { fs.unlinkSync(mark); } catch {} }
    const t0 = Date.now(), ch = cp.spawn(process.execPath, args, { cwd: PKG, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", done = false; ch.stdout.on("data", (d) => { out += d; }); ch.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { try { ch.kill(); } catch {} }, 15 * 60000);
    const end = (code) => { if (done) return; done = true; clearTimeout(timer); let made = null; if (mark) { try { made = Number(fs.readFileSync(mark, "utf8")); fs.unlinkSync(mark); } catch {} } resolve({ code, out, made, secs: Math.round((Date.now() - t0) / 1000) }); };
    ch.on("error", () => end(null)); ch.on("close", (code) => end(code));
  });
}
function verdictOf(m, r) {
  const fails = r.out.split(/\r?\n/).filter((l) => /^ {2}FAIL /.test(l)).map((l) => l.slice(7));
  if (/^ALL \d+ CHECKS PASSED/m.test(r.out) && r.code === 0) return r.made > 0 ? { verdict: "SURVIVED", why: "the selftest passed with the change in" } : { verdict: "ERROR", why: "the selftest passed, but it never read the changed file" };
  if (!/^FAILED — \d+ of \d+ checks/m.test(r.out)) return { verdict: "ERROR", why: `the selftest gave no verdict (exit ${r.code}): ${r.out.trim().split(/\r?\n/).slice(-1)[0].slice(0, 160)}` };
  if (!(r.made > 0)) return { verdict: "ERROR", why: "the selftest failed, but it never read the changed file" };
  const hit = fails.filter((f) => m.by.test(f));
  return hit.length ? { verdict: "CAUGHT", why: `${fails.length} case(s) failed; the one named for it: ${hit[0].split(" — ")[0].slice(0, 110)}` } : { verdict: "WEAK", why: `${fails.length} case(s) failed, none of them the one named for it (${m.by}): ${fails.slice(0, 3).map((f) => f.slice(0, 70)).join(" | ")}` };
}

async function main(argv) {
  const jobsAt = argv.indexOf("--jobs"), jobs = jobsAt >= 0 ? Math.max(1, Math.min(6, Number(argv[jobsAt + 1]) || 1)) : 1;
  const ids = argv.filter((a, i) => !a.startsWith("--") && !(jobsAt >= 0 && i === jobsAt + 1)), unknown = argv.filter((a) => a.startsWith("--") && !["--list", "--jobs"].includes(a));
  if (unknown.length) { console.error(`usage: run.cjs [--list] [--jobs n] [<id> …] — unknown: ${unknown.join(" ")}`); return 2; }
  const bad = validate();
  if (argv.includes("--list")) {
    for (const m of MUTANTS) console.log(`  ${m.id.padEnd(30)} ${m.file.padEnd(48)} ${m.what}`);
    if (bad.length) { console.log(`MUTATION LIST NOT SOUND — ${bad.join(" | ")}`); return 1; }
    console.log(`MUTATION LIST OK — ${MUTANTS.length} changes, each one's text found exactly once in its file and gone once replaced`);
    return 0;
  }
  if (bad.length) { console.log(`MUTATION LIST NOT SOUND — nothing run: ${bad.join(" | ")}`); return 1; }
  const missing = ids.filter((id) => !MUTANTS.some((m) => m.id === id));
  if (missing.length) { console.error(`no such change: ${missing.join(", ")} (see --list)`); return 2; }
  const todo = ids.length ? MUTANTS.filter((m) => ids.includes(m.id)) : MUTANTS;
  if (!ids.length) {
    const c = await selftest(null), line = (c.out.trim().split(/\r?\n/).slice(-1)[0] || "").slice(0, 120);
    if (c.code !== 0 || !/^ALL \d+ CHECKS PASSED/.test(line)) { console.log(`the UNTOUCHED selftest does not pass (exit ${c.code}: ${line}) — nothing to learn from a change until it does`); return 1; }
    console.log(`untouched: ${line} (${c.secs} s)`);
  }
  const results = new Array(todo.length); let next = 0;
  const worker = async () => { for (;;) { const i = next++; if (i >= todo.length) return; const m = todo[i], r = await selftest(m), v = verdictOf(m, r); results[i] = { m, ...v, secs: r.secs }; console.log(`  ${v.verdict.padEnd(8)} ${m.id.padEnd(30)} ${String(r.secs).padStart(3)} s  ${m.what} — ${v.why}`); } };
  await Promise.all(Array.from({ length: Math.min(jobs, todo.length) }, worker));
  const n = (v) => results.filter((x) => x.verdict === v).length;
  if (n("CAUGHT") === results.length) { console.log(`ALL ${results.length} MUTANTS CAUGHT (each by the known answer written for it)`); return 0; }
  console.log(`MUTANTS NOT ALL CAUGHT — ${n("CAUGHT")} of ${results.length} caught; ${n("WEAK")} weak, ${n("SURVIVED")} survived, ${n("ERROR")} without a result: ${results.filter((x) => x.verdict !== "CAUGHT").map((x) => `${x.m.id} (${x.verdict})`).join(", ")}`);
  return 1;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => { console.error(`mutants/run.cjs failed: ${e.stack || e.message}`); process.exit(1); });
module.exports = { MUTANTS, validate, verdictOf };
