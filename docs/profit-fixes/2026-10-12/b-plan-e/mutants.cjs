#!/usr/bin/env node
"use strict";
/**
 * PROFIT FIXES B — MUTANTS: does the selftest bite? Each run breaks ONE thing and runs selftest.cjs on it:
 *   - a staged edit, in a temp copy of edits.json (os.tmpdir; the selftest reads it through PFB_SELFTEST_EDITS), or
 *   - the apply / rollback engine, by compiling lib.cjs with one fragment replaced in that one selftest process (harness/mutate-lib.cjs;
 *     the file on disk is not touched).
 * A mutant is CAUGHT when the selftest exits non-zero with at least one FAIL line. READ-ONLY on the repo and on this package. Three selftests
 * run at a time; about twenty minutes for the 73. Ends "n of n mutants caught" (exit 0) or names the ones that got through.
 *   node docs/profit-fixes/2026-10-12/b-plan-e/mutants.cjs
 *   node docs/profit-fixes/2026-10-12/b-plan-e/mutants.cjs <text>   only the mutants whose name contains <text>
 */
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const PKG = __dirname, E0 = JSON.parse(fs.readFileSync(path.join(PKG, "edits.json"), "utf8")), LIB = fs.readFileSync(path.join(PKG, "lib.cjs"), "utf8");
/** [what is broken, the edit, the fragment of its new block, what it becomes] — a second fragment and what it becomes may follow (both in the same edit) */
const M = [
  // (a) the month-end window
  ["the calendar asked but ignored (the old window)", "rm-window", "allDays.concat(await sessionsToCome(allDays[allDays.length - 1])).forEach(", "(await sessionsToCome(allDays[allDays.length - 1]), allDays).forEach("],
  ["the window anchored on the clock's date, not on the last bar's day", "rm-window", "await sessionsToCome(allDays[allDays.length - 1])", "await sessionsToCome(today)"],
  ["a calendar failure swallowed (quiet fallback)", "rm-sessions-fn", "if (!r.ok) throw bad(`HTTP ${r.status}`); const a = await r.json(); if (!Array.isArray(a)) throw bad(\"the answer is not a list\");", "if (!r.ok) return []; const a = await r.json(); if (!Array.isArray(a)) return [];"],
  ["December's month end computed as last year's (mo % 12)", "rm-sessions-fn", "new Date(Date.UTC(y, mo, 0))", "new Date(Date.UTC(y, mo % 12, 0))"],
  ["a calendar row that cannot be read is dropped, not refused", "rm-sessions-fn", "if (ds.some((d) =>", "if (false && ds.some((d) =>"],
  ["the calendar request made with no timeout", "rm-sessions-fn", ", signal: AbortSignal.timeout(20000) });", " });"],
  ["a cut calendar answer is accepted (the check on the list's last session lifted)", "rm-sessions-fn", "/ 864e5 > 4) throw bad(", "/ 864e5 > 4000) throw bad("],
  ["the bound on the list's last session one day looser (5 days)", "rm-sessions-fn", "/ 864e5 > 4) throw bad(", "/ 864e5 > 5) throw bad("],
  ["the bound on the list's last session one day tighter (3 days)", "rm-sessions-fn", "/ 864e5 > 4) throw bad(", "/ 864e5 > 3) throw bad("],
  // (b) the Coinbase fetch
  ["the missing-day check switched off", "rm-coinbase", "if (missing.length) throw bad(", "if (false) throw bad("],
  ["the HTTP status not checked, a non-list ends the loop quietly", "rm-coinbase", "if (r.ok) return await r.json(); why = `HTTP ${r.status}`;", "return await r.json(); why = `HTTP ${r.status}`;", "if (!Array.isArray(a)) throw bad(\"the answer is not a candle list\");", "if (!Array.isArray(a)) break;"],
  ["the HTTP status not checked (an error body is taken for the answer)", "rm-coinbase", "if (r.ok) return await r.json(); why = `HTTP ${r.status}`;", "return await r.json(); why = `HTTP ${r.status}`;"],
  ["an answer that is not a candle list ends the loop quietly", "rm-coinbase", "if (!Array.isArray(a)) throw bad(\"the answer is not a candle list\");", "if (!Array.isArray(a)) break;"],
  ["a rate-limited request is not asked again (no retry)", "rm-coinbase", "if (n >= 3 || repeats >= 3) throw bad(", "if (n >= 1 || repeats >= 3) throw bad("],
  ["a failing request is asked a fourth time (no limit per request)", "rm-coinbase", "if (n >= 3 || repeats >= 3) throw bad(", "if (repeats >= 3) throw bad("],
  ["no cap on the repeats a coin may use", "rm-coinbase", "if (n >= 3 || repeats >= 3) throw bad(", "if (n >= 3) throw bad("],
  ["a request asked again at once (no back-off)", "rm-coinbase", "await sleep(n === 1 ? 2000 : 5000);", "await sleep(0);"],
  ["a request that does not answer is not asked again", "rm-coinbase", "if (!(e && e.name === \"TimeoutError\")) throw e;", "throw e;"],
  ["requests start at noon, not midnight", "rm-coinbase", "for (let s = Date.parse(from + \"T00:00:00Z\"); s < now;)", "for (let s = Date.parse(from + \"T12:00:00Z\"); s < now;)"],
  ["a candle that cannot be read is taken for a price", "rm-coinbase", "if (!Number.isFinite(t) || !(px > 0)) throw bad(", "if (false) throw bad("],
  ["the candle requests made with no timeout", "rm-coinbase", ", signal: AbortSignal.timeout(20000) });", " });"],
  ["the candle requests' timeout 200 seconds, not 20", "rm-coinbase", "AbortSignal.timeout(20000)", "AbortSignal.timeout(200000)"],
  ["the candle of the last bar's day not asked for", "rm-crypto-day", "if (lack.length) throw new Error(", "if (false) throw new Error("],
  ["the last bar's candle asked of BTC only", "rm-crypto-day", "[[\"BTC\", btc], [\"ETH\", eth]]", "[[\"BTC\", btc]]"],
  ["the last bar's candle asked of ETH only", "rm-crypto-day", "[[\"BTC\", btc], [\"ETH\", eth]]", "[[\"ETH\", eth]]"],
  ["the clock's day asked for instead of the last bar's", "rm-crypto-day", "const lastDay = allDays[allDays.length - 1], lack", "const lastDay = today, lack"],
  ["an UNKNOWN run exits 0", "rm-unknown", "process.exit(1); });", "process.exit(0); });"],
  ["an UNKNOWN run leaves the stored snapshot unmarked", "rm-unknown", "status: \"UNKNOWN\", unknown:", "unknown:"],
  ["an UNKNOWN run does not end its stderr with the reason (the chain's record shows stack frames)", "rm-unknown", " console.error(`RISK MANAGER UNKNOWN (shadow): ${why}`);", ""],
  ["an UNKNOWN run writes the reason to stderr before the stack, not after it", "rm-unknown", "console.error(\"risk-manager FAILED:\", e && e.stack); console.error(`RISK MANAGER UNKNOWN (shadow): ${why}`);", "console.error(`RISK MANAGER UNKNOWN (shadow): ${why}`); console.error(\"risk-manager FAILED:\", e && e.stack);"],
  ["the reason not cut to 300 characters (a long one runs past the chain's 400)", "rm-unknown", ".slice(0, 300);", ".slice(0, 3000);"],
  // (c) the headline rate
  ["the stated rate typed when the file is unreadable", "rm-stated-fn", "return { status: \"UNKNOWN\", annualReturnPct: null,", "return { status: \"UNKNOWN\", annualReturnPct: 24.26,"],
  ["an absurd stated rate accepted (no range check)", "rm-stated-fn", " && a > -100 && a < 1000", ""],
  ["a model run of under a year accepted", "rm-stated-fn", "e.months >= 12", "e.months >= 1"],
  ["a model run of any length accepted (months >= 0)", "rm-stated-fn", "e.months >= 12", "e.months >= 0"],
  ["a model run of 11 months accepted", "rm-stated-fn", "e.months >= 12", "e.months >= 11"],
  ["a model run of exactly 12 months refused", "rm-stated-fn", "e.months >= 12", "e.months > 12"],
  ["the old figure printed again", "rm-console", "`  Plan E stated model return: ${st.annualReturnPct}% a year", "`  Plan E headline 27.36% · stated model return: ${st.annualReturnPct}% a year"],
  ["the proxy book's level printed again", "rm-console", "managed minus unmanaged ${(pv.managed.cagrPct - pv.unmanaged.cagrPct).toFixed(1)} pt a year", "unmanaged ${pv.unmanaged.cagrPct}% a year"],
  ["the preview difference with its sign flipped", "rm-console", "(pv.managed.cagrPct - pv.unmanaged.cagrPct).toFixed(1)", "(pv.unmanaged.cagrPct - pv.managed.cagrPct).toFixed(1)"],
  ["the preview's two drawdowns swapped", "rm-console", "max drawdown ${pv.managed.maxDDPct}% against ${pv.unmanaged.maxDDPct}%", "max drawdown ${pv.unmanaged.maxDDPct}% against ${pv.managed.maxDDPct}%"],
  ["the preview's two Sharpe ratios swapped", "rm-console", "Sharpe ${pv.managed.sharpe} against ${pv.unmanaged.sharpe}", "Sharpe ${pv.unmanaged.sharpe} against ${pv.managed.sharpe}"],
  ["the financing added instead of charged", "sb-model-zn", "(x - rfAnnual(D) / 100 / 252)", "(x + rfAnnual(D) / 100 / 252)"],
  ["the financing charged at a typed 4% bill, not the T-bill read", "sb-model-zn", "(x - rfAnnual(D) / 100 / 252)", "(x - 4.0 / 100 / 252)"],
  ["the financing charged at the bill of the record's last month, not the window day's", "sb-model-zn", "(x - rfAnnual(D) / 100 / 252)", "(x - rfAnnual(lastDay) / 100 / 252)"],
  ["the scoreboard's record does not say its model basis changed", "sb-model-note", "  notes.push(\"model basis:", "  void (\"model basis:"],
  ["the scoreboard's stored record carries no modelBasis field", "sb-model-note", "res.modelBasis = \"zn-proxy-financed-at-tbill\";", "void \"zn-proxy-financed-at-tbill\";"],
  ["the report's base rate typed", "aa-rates", "PE_BASE = PEM.base,", "PE_BASE = 0.2426,"],
  ["the report prints a number where the file is unreadable", "aa-rates", "perDay = (r) => (r == null ? \"UNKNOWN\" : $(pe(r)))", "perDay = (r) => (r == null ? $(96) : $(pe(r)))"],
  ["the report remembers the month-end drawdown (-$8,710)", "aa-rates", "baseDD: n(e.maxDDmonthEndPct),", "baseDD: n(e.maxDDmonthEndPct) ?? -0.0871,"],
  ["the report remembers the drawdown inside a month (-$12,100)", "aa-rates", "baseDDdaily: n(fin.maxDDdailyPct),", "baseDDdaily: n(fin.maxDDdailyPct) ?? -0.121,"],
  ["the report remembers the MAX row's drawdown (-$10,970)", "aa-rates", "maxDD: n(d.maxDDmonthEndPct),", "maxDD: n(d.maxDDmonthEndPct) ?? -0.1097,"],
  ["the report's max rate typed whenever the file can be read", "aa-rates", "PE_MAX = PEM.max,", "PE_MAX = PEM.max == null ? null : 0.2874,"],
  ["the report's low rate typed whenever the file can be read", "aa-rates", "PE_LOW = PEM.low;", "PE_LOW = PEM.low == null ? null : 0.0908;"],
  ["the report's drawdown inside a month typed (-$12,090)", "aa-rows", "${perYear(PEM.baseDDdaily)} inside a month", "-$12,090 inside a month"],
  ["the report's MAX-row drawdown typed (-$10,970)", "aa-rows", "${perYear(PEM.maxDD)} month-end", "-$10,970 month-end"],
  ["the report's drawdown inside a month typed whenever the file can be read", "aa-rows", "${perYear(PEM.baseDDdaily)} inside a month", "${PEM.baseDDdaily == null ? \"UNKNOWN\" : \"-$12,090\"} inside a month"],
  ["the report's MAX-row drawdown typed whenever the file can be read", "aa-rows", "${perYear(PEM.maxDD)} month-end", "${PEM.maxDD == null ? \"UNKNOWN\" : \"-$10,970\"} month-end"],
  ["the model library ignores the cached calendar", "pm-window", "async function sessionsToCome(lastDay) { return __future; }", "async function sessionsToCome(lastDay) { return []; }"],
];
/** [what is broken in lib.cjs (the apply / rollback engine), the fragment, what it becomes] */
const ML = [
  ["apply: no second fence check just before the write", "\n  fz = fences({ ms, files, procList, holiday }); if (fz.length) return { result: \"refused\", why: fz };", "\n  fz = [];"],
  ["apply: a backup already in the folder with other bytes is trusted", "if (sha256(fs.readFileSync(b)) !== w.beforeSha) return { result: \"refused\", why: [`the backup of", "if (false) return { result: \"refused\", why: [`the backup of"],
  ["fences: an unreadable holiday table counts as NOT a trading day (fail open)", "try { return !holiday(mt.date); } catch { return true; }", "try { return !holiday(mt.date); } catch { return false; }"],
  ["fences: a run started by a bare file name from inside the tree is not seen", " || argsOf(p.cmd).some((a) => B.arg.test(a))", ""],
  ["deploy: its two gates run with the shell's harness switches", "env: gateEnv(env), windowsHide", "env, windowsHide"],
  ["verify: a night that ended UNKNOWN since the apply is reported as 'has not run yet'", "if (snap.status === \"UNKNOWN\" && !(unkAt < appliedAt)) say(", "if (false) say("],
  ["verify: a session without a forward row is not named", "else if (missing.length) say(", "else if (false) say("],
  ["verify: an OK snapshot whose day has no forward row is taken for accrual", "if (ranFor && !have.has(ranFor) && !named.includes(ranFor)) say(", "if (false) say("],
  ["verify: a session already named as missing is named a second time for the snapshot", " && !named.includes(ranFor)) say(", ") say("],
  ["deploy: the write mode starts from a shell that carries a harness switch", "if (shellVars.length) return { code: 2,", "if (false) return { code: 2,"],
  ["apply: a file that changed while it was building is overwritten", "for (const w of work) if (sha256(fs.readFileSync(w.file)) !== w.beforeSha) return { result: \"refused\", why: [", "for (const w of work) if (false) return { result: \"refused\", why: ["],
  ["apply: a failed write leaves the files already written", "const left = []; for (const w of done.reverse()) { try { writeExact(w.file, w.before); if (sha256(", "const left = []; for (const w of []) { try { writeExact(w.file, w.before); if (sha256("],
  ["rollback: a failed write leaves the files already put back", "const left = []; for (const w of done.reverse()) { try { writeExact(w.file, w.before); } catch {", "const left = []; for (const w of []) { try { writeExact(w.file, w.before); } catch {"],
  ["deploy: a verify run that ended abnormally is taken as applied", "if (!v || (v.status !== 0 && v.status !== 3)) return undo(", "if (v && v.status === 1) return undo("],
];
const only = process.argv[2], dir = fs.mkdtempSync(path.join(os.tmpdir(), "pfb-mutants-")), SELFTEST = path.join(PKG, "selftest.cjs"), jobs = [];
M.forEach(([name, id, ...pairs], i) => jobs.push({ name, prepare: () => {   // one fragment and what it becomes, or two such pairs in the same edit
  const E = JSON.parse(JSON.stringify(E0)), e = E.edits.find((x) => x.id === id);
  for (let j = 0; j < pairs.length; j += 2) { const from = pairs[j], to = pairs[j + 1];
    if (!e || e.new.split(from).length !== 2) return `its fragment is in edit ${id} ${e ? e.new.split(from).length - 1 : 0} times (need 1) — the edit changed; update this list`;
    e.new = e.new.replace(from, () => to); }
  const f = path.join(dir, `edits-${i}.json`); fs.writeFileSync(f, JSON.stringify(E)); return { args: [SELFTEST], env: { PFB_SELFTEST_EDITS: f } }; } }));
ML.forEach(([name, from, to], i) => jobs.push({ name, prepare: () => {
  if (LIB.split(from).length !== 2) return `its fragment is in lib.cjs ${LIB.split(from).length - 1} times (need 1) — lib.cjs changed; update this list`;
  const f = path.join(dir, `lib-${i}.json`); fs.writeFileSync(f, JSON.stringify({ from, to })); return { args: ["-r", path.join(PKG, "harness", "mutate-lib.cjs"), SELFTEST], env: { PFB_LIB_MUTANT: f } }; } }));
const todo = jobs.filter((j) => !only || j.name.includes(only)), missed = [];
const selftest = ({ args, env }) => new Promise((res) => { const c = cp.spawn(process.execPath, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }); let out = ""; c.stdout.on("data", (d) => (out += d)); const t = setTimeout(() => c.kill(), 900000); c.on("close", (status) => { clearTimeout(t); res({ status, out }); }); c.on("error", () => { clearTimeout(t); res({ status: null, out }); }); });
const one = async (j) => {
  const p = j.prepare(); if (typeof p === "string") { missed.push(j.name); return `SETUP   ${j.name}: ${p}`; }
  const r = await selftest(p), fails = r.out.split("\n").filter((l) => /^FAIL/.test(l)), caught = r.status !== null && r.status !== 0 && fails.length > 0; if (!caught) missed.push(j.name);
  return `${caught ? "CAUGHT " : "MISSED "} ${j.name.padEnd(64)} ${fails.length} FAIL line(s); first: ${(fails[0] || "").slice(5, 120)}`;
};
(async () => {
  try { for (let i = 0; i < todo.length; i += 3) for (const line of await Promise.all(todo.slice(i, i + 3).map(one))) console.log(line); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  console.log(missed.length ? `${todo.length - missed.length} of ${todo.length} mutants caught — NOT CAUGHT: ${missed.join("; ")}` : `${todo.length} of ${todo.length} mutants caught${only ? ` (only those named "${only}"; the list holds ${jobs.length})` : ""}`);
  process.exit(missed.length ? 1 : 0);
})();
