#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY SEALED FORECAST LEDGER — THE MUTATION LIST, RE-RUNNABLE. 2026-10-16.
 *
 *   node docs/worst-day-sealed/2026-10-16/mutants/run.cjs --list        the list, checked (each change's text is in its file exactly
 *                                                                       once, and gone once replaced). Runs nothing.
 *   node docs/worst-day-sealed/2026-10-16/mutants/run.cjs               first the untouched selftest (it must pass), then every
 *                                                                       change, one at a time.
 *   node docs/worst-day-sealed/2026-10-16/mutants/run.cjs --jobs 4      the same, four selftests at a time
 *   node docs/worst-day-sealed/2026-10-16/mutants/run.cjs <id> [<id> …] only those changes (no untouched run)
 *
 * WHAT A "MUTANT" IS HERE. One deliberate wrong change to one line of one staged file (or of one of the package's own tools). The
 * selftest must FAIL on it, and must fail in the known answer written for that rule (`by`), not by accident somewhere else:
 *   CAUGHT    the selftest failed, and one of the failing cases is the one named for this change
 *   WEAK      the selftest failed, but not in the case named for it — that rule's own known answer did not notice
 *   SURVIVED  the selftest passed with the change in: a known answer is missing
 *   ERROR     no result: the selftest crashed, timed out, or never read the changed file
 * Exit 0 only when every change is CAUGHT.
 *
 * NOTHING ON DISK IS CHANGED. The change is made in memory by mutants/hook.cjs as selftest.cjs reads the staged file, before it
 * copies it into its sandbox. No live file is touched, nothing is written outside the OS temp dir, and no network call is made.
 *
 * WHAT THIS LIST DOES NOT COVER, said rather than left to be found: the DRIFT branch of lib.cjs plan() and of rollback.cjs, because
 * the selftest may not write into the live tree and so cannot make a drifted file to be caught on. Those two branches were proven
 * by hand in a throw-away copy of the repository (NOTES.md, 'What was proven by hand').
 */
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const PKG = path.resolve(__dirname, ".."), HOOK = path.join(__dirname, "hook.cjs"), SELFTEST = path.join(PKG, "selftest.cjs");
const S = (n) => `staged/backend/worst-day/${n}`;
const LEDGER = S("sealed-ledger.js"), CHECK = S("sealed-check.js"), MODEL = S("nightly-model.js"), JOB = S("nightly-forecast.js"), GRADE = S("sealed-grade.js"), FIX = S("sealed-fixtures.js");

/** id · file · find (exactly once) · replace · by (a failing case must match) · what the change breaks */
const MUTANTS = [
  // ── the seal: the one refusal this ledger exists for ──
  { id: "seal-at-open-allowed", file: CHECK, find: "if (!(made < dl)) bad.push(", replace: "if (!(made <= dl)) bad.push(",
    by: /a row written AT the open exactly is not sealed/, what: "a row written at 09:30 ET exactly counts as sealed" },
  { id: "seal-check-never-fails", file: CHECK, find: 'add("seal", bad.length === 0,', replace: 'add("seal", true,',
    by: /A ROW WRITTEN AFTER 09:30 ET OF THE DAY IT FORECASTS REFUSES THE WHOLE LEDGER/, what: "the seal check reports pass whatever it found" },
  { id: "seal-deadline-is-utc", file: LEDGER, find: "const sealDeadlineMs = (forDate) => etWallMs(forDate, SEAL_ET_HH, SEAL_ET_MM);", replace: 'const sealDeadlineMs = (forDate) => Date.parse(forDate + "T09:30:00.000Z");',
    by: /the seal is 14:30 UTC in winter/, what: "09:30 is read as UTC, not as the New York wall clock" },
  // NOTE: flipping the sign of the FIRST pass alone is an equivalent mutant — the second pass puts it right again. The second
  // pass is the one that carries the answer, so that is the line this change breaks (NOTES.md, 'What the mutants found').
  { id: "seal-offset-sign", file: LEDGER, find: "  ms = wall - etShift(ms);", replace: "  ms = wall + etShift(ms);",
    by: /the seal is 14:30 UTC in winter|the seal is 13:30 UTC in summer/, what: "the ET offset is added instead of subtracted on the pass that settles the answer" },
  { id: "append-writes-after-seal", file: LEDGER, find: "if (!(now < deadline)) refuse(", replace: "if (false) refuse(",
    by: /AT 09:30 ET exactly the seal is closed/, what: "the writer no longer refuses a row written after the open" },
  { id: "job-plan-ignores-seal", file: JOB, find: "if (!(now < deadline)) refusals.push(", replace: "if (false) refusals.push(",
    by: /the refusal says the seal is closed/, what: "the job's plan stops saying the seal is closed" },

  // ── the chain and the tip ──
  { id: "hash-drops-prevhash", file: LEDGER, find: "  for (const k of BODY_KEYS) b[k] = body[k];\n  return sha256(canonicalJson(b));", replace: '  for (const k of BODY_KEYS) if (k !== "prevHash") b[k] = body[k];\n  return sha256(canonicalJson(b));',
    by: /prevHash is inside the hash, so a relinked row hashes differently/, what: "prevHash is left out of the hash, so relinking a row is invisible" },
  { id: "canonical-unsorted", file: LEDGER, find: 'return "{" + Object.keys(v).sort().map(', replace: 'return "{" + Object.keys(v).map(',
    by: /canonicalJson sorts every object's keys/, what: "the hashed bytes depend on the order the keys happen to be in" },
  { id: "chain-links-not-checked", file: CHECK, find: "const want = i === 0 ? S.GENESIS : rows[i - 1].hash;", replace: "const want = i === 0 ? S.GENESIS : r.prevHash;",
    by: /an edited row whose own hash was redone still refuses \(chain\)|two rows swapped/, what: "each row's prevHash is compared with itself, so no link is ever checked" },
  { id: "tip-truncation-not-seen", file: CHECK, find: "      if (tip.seq !== last.seq) bad.push(", replace: "      if (false) bad.push(",
    by: /a ledger cut short no longer matches its tip|the tip refusal says rows are missing from the end/, what: "a ledger cut short at a row boundary is no longer noticed by seq" },
  { id: "tip-missing-allowed", file: CHECK, find: "    else if (!tip) add(\"tip\", false,", replace: "    else if (!tip) add(\"tip\", true,",
    by: /a ledger with no tip file at all is refused/, what: "a ledger with no tip file at all passes" },
  { id: "tip-not-written", file: LEDGER, find: "  writeJson(tipFile, { spec: SPEC, seq: row.seq, hash: row.hash, forDate: row.forDate, at: row.createdAt });", replace: "  void writeJson;",
    by: /the tip file names the row just written/, what: "the writer stops writing the tip, so nothing records where the ledger ends" },
  { id: "ledger-overwritten", file: LEDGER, find: "  append(ledgerFile, line);", replace: "  fs.writeFileSync(ledgerFile, line);",
    by: /the ledger now holds two lines|appending two rows in order/, what: "the ledger is overwritten instead of appended to" },

  // ── the row's shape ──
  { id: "extra-keys-allowed", file: LEDGER, find: "  for (const k of got) if (!want.includes(k)) bad.push(", replace: "  for (const k of []) if (!want.includes(k)) bad.push(",
    by: /a key that is not part of a row is refused/, what: "a row may carry keys that are not hashed" },
  { id: "storm-mismatch-allowed", file: LEDGER, find: "if (row.storm !== stormStateOf(row.flagModel, row.flagRule)) bad.push(", replace: "if (false) bad.push(",
    by: /a storm state the two flags do not agree with is refused/, what: "a row may state a storm state its own flags do not support" },
  { id: "forward-only-dropped", file: LEDGER, find: "if (last && !(row.forDate > last.forDate)) refuse(", replace: "if (false) refuse(",
    by: /a forDate that is not after the last row is refused/, what: "the ledger may be written backwards or twice for one session" },
  { id: "append-onto-broken-ledger", file: LEDGER, find: "if (check) { const v = check({ rows, now, tip: readTip(tipFile) });", replace: "if (false) { const v = check({ rows, now, tip: readTip(tipFile) });",
    by: /nothing is appended to a ledger that does not pass its own checker/, what: "rows are added to a ledger that is already refused" },
  { id: "holidays-ignored", file: CHECK, find: "else if (holidays[r.forDate]) bad.push(", replace: "else if (false) bad.push(",
    by: /a forDate on a market holiday is refused/, what: "a forecast for a day the market is shut is accepted" },
  { id: "future-rows-allowed", file: CHECK, find: "rows.forEach((r, i) => { const made = Date.parse(r.createdAt); if (made > now) bad.push(", replace: "rows.forEach((r, i) => { const made = Date.parse(r.createdAt); if (false) bad.push(",
    by: /a row dated after the moment of the check is refused/, what: "a row written by a clock that ran ahead is accepted" },

  // ── the forecaster ──
  { id: "model-trains-on-tomorrow", file: MODEL, find: "    if (i < need || i + 1 > t) continue;", replace: "    if (i < need || i + 1 > t + 1) continue;",
    by: /SCRAMBLING EVERY BAR AFTER THE DECISION CLOSE CHANGES NOTHING IN THE FORECAST|the fit one bar back sees one row fewer/, what: "the fit is given the label of the session being forecast" },
  { id: "model-feature-reads-ahead", file: MODEL, find: "  row[3] = 100 * S.r[i]; row[4] =", replace: "  row[3] = 100 * S.r[i + 1]; row[4] =",
    by: /SCRAMBLING EVERY BAR AFTER THE DECISION CLOSE CHANGES NOTHING IN THE FORECAST/, what: "one input reads the next session's return" },
  { id: "threshold-takes-the-best", file: MODEL, find: "  return L.qLow(Array.from(S.r.subarray(i - win + 1, i + 1)), tail);", replace: "  return L.qHigh(Array.from(S.r.subarray(i - win + 1, i + 1)), tail);",
    by: /the 5% threshold is the 3rd smallest of the 60 returns ending at the decision close/, what: "the worst-day threshold is taken from the best tail, not the worst" },
  { id: "rule-flag-wrong-side", file: MODEL, find: "  return S.close[i] < S.sma200[i] && S.rv20[i] >= L.qLow(rw, volQ) ? 1 : 0;", replace: "  return S.close[i] > S.sma200[i] && S.rv20[i] >= L.qLow(rw, volQ) ? 1 : 0;",
    by: /rule of thumb \(a\) matches a straight-loop recomputation/, what: "rule (a) fires above the 200-session mean instead of below it" },
  { id: "storm-flag-always-up", file: MODEL, find: "  const stormThr = L.qHigh(train.map((i) => L.logitPredict(m, X[i])), topDecile);", replace: "  const stormThr = 0;",
    by: /a calm fixture with no drawdown reads as calm/, what: "the causal flag is always up, so every session is at least a watch" },
  { id: "model-answers-without-a-fit", file: MODEL, find: "  if (train.length < minTrain) throw new Error(", replace: "  if (false) throw new Error(",
    by: /too few labelled sessions is refused rather than answered/, what: "a number is stated from almost no training rows" },
  { id: "job-ignores-stale-bars", file: JOB, find: "if (want < today) refusals.push(", replace: "if (false) refusals.push(",
    by: /stale bars are refused rather than forecast into the past|the refusal says the bars are stale/, what: "the job forecasts a session that is already in the past" },

  // ── the grader ──
  { id: "grade-runs-on-refused-ledger", file: GRADE, find: "  if (!v.ok) { say(\"GRADED NOTHING", replace: "  if (false) { say(\"GRADED NOTHING",
    by: /A LEDGER THE CHECKER REFUSES IS NOT GRADED/, what: "rows that may not have been sealed are scored anyway" },
  { id: "grade-label-flipped", file: GRADE, find: "y: S.r[i] <= row.thr ? 1 : 0", replace: "y: S.r[i] >= row.thr ? 1 : 0",
    by: /the straight loop counts the same worst days/, what: "a worst day is read as a return at or ABOVE the threshold" },
  { id: "grade-disputed-row-scored", file: GRADE, find: "    if (Math.abs(S.adj[j] - row.asOfAdj) > tol * Math.max(1, Math.abs(row.asOfAdj)))", replace: "    if (false)",
    by: /a row whose stated decision close no longer matches the bars is disputed/, what: "a row the bars disagree with is scored instead of set aside" },
  { id: "grade-brier-not-squared", file: GRADE, find: "b += (m.row.p - m.y) ** 2;", replace: "b += Math.abs(m.row.p - m.y);",
    by: /the Brier score is the arithmetic|a forecaster that always says a half scores a quarter/, what: "the Brier score adds absolute misses instead of squared ones" },
  { id: "grade-bin-edges-overlap", file: GRADE, find: "if (p >= lo && (p < hi || (k === BINS.length - 1 && p <= hi))) return k;", replace: "if (p >= lo && p <= hi) return k;",
    by: /a probability on a bin's lower edge falls in that bin/, what: "a probability on a bin boundary falls in the lower bin as well" },
  { id: "grade-calls-it-a-read", file: GRADE, find: "  const enough = S.n >= MIN_MATURED && S.worst >= MIN_WORST;", replace: "  const enough = true;",
    by: /forty matured rows is below the bar set in advance/, what: "a few dozen rows are called enough to read" },

  // ── the fixture the known answers stand on ──
  { id: "fixture-generator-moved", file: FIX, find: "const vol = stormy ? 0.024 : 0.006", replace: "const vol = stormy ? 0.025 : 0.006",
    by: /fixtures\/synthetic-bars\.json is byte for byte what the shipped generator makes/, what: "the bar generator moves without the committed fixture moving with it" },

  // ── the package's own tools ──
  { id: "manifest-drops-a-file", file: "lib.cjs", find: '  ["backend/worst-day/sealed-grade.js", "the grader:', replace: '  ["backend/worst-day/sealed-grade.jsSKIP", "the grader:',
    by: /every file in the manifest has a staged copy|staged\/ holds exactly the files the manifest names/, what: "the manifest and the staged tree stop agreeing" },
  { id: "state-reads-drift-as-applied", file: "lib.cjs", find: 'function stateOf(live, staged) { return live === null ? "absent" : live.equals(staged) ? "applied" : "drift"; }', replace: 'function stateOf(live, staged) { return live === null ? "absent" : "applied"; }',
    by: /ANYTHING ELSE AT THE PATH READS AS DRIFT, never as applied/, what: "a file that is there but is something else reads as applied (DRIFT is never seen)" },
  { id: "state-ignores-a-byte", file: "lib.cjs", find: 'return live === null ? "absent" : live.equals(staged) ? "applied" : "drift";', replace: 'return live === null ? "absent" : live.length === staged.length ? "applied" : "drift";',
    by: /one byte of difference is already DRIFT/, what: "a file of the right length counts as the staged copy whatever is in it" },
];

const count = (text, needle) => text.split(needle).length - 1;
function validate(list = MUTANTS) {
  const bad = [], seen = new Set();
  for (const m of list) {
    if (seen.has(m.id)) bad.push(`${m.id}: the id is used twice`);
    seen.add(m.id);
    let text;
    try { text = fs.readFileSync(path.join(PKG, ...m.file.split("/")), "utf8"); } catch (e) { bad.push(`${m.id}: ${m.file} cannot be read (${e.code || e.message})`); continue; }
    const n = count(text, m.find);
    if (n !== 1) { bad.push(`${m.id}: its text occurs ${n}x in ${m.file} (it must occur exactly once)`); continue; }
    if (m.find === m.replace) bad.push(`${m.id}: it changes nothing`);
    if (count(text.replace(m.find, () => m.replace), m.find) !== 0) bad.push(`${m.id}: its text is still in ${m.file} once replaced`);
    if (!(m.by instanceof RegExp)) bad.push(`${m.id}: it names no case that must catch it`);
  }
  return bad;
}
/** one selftest run -> { code, out, made, secs }. spec null = the untouched selftest. */
function selftest(spec) {
  return new Promise((resolve) => {
    const mark = spec ? path.join(os.tmpdir(), `wds-mutant-${process.pid}-${spec.id}.mark`) : null, args = spec ? ["-r", HOOK, SELFTEST] : [SELFTEST];
    const env = { ...process.env }; delete env.WDS_MUTANT; delete env.WDS_MUTANT_MARK;
    if (spec) { env.WDS_MUTANT = JSON.stringify({ id: spec.id, file: spec.file, find: spec.find, replace: spec.replace }); env.WDS_MUTANT_MARK = mark; try { fs.unlinkSync(mark); } catch { /* not there */ } }
    const t0 = Date.now(), ch = cp.spawn(process.execPath, args, { cwd: PKG, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", done = false;
    ch.stdout.on("data", (d) => { out += d; }); ch.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { try { ch.kill(); } catch { /* gone */ } }, 10 * 60000);
    const end = (code) => { if (done) return; done = true; clearTimeout(timer); let made = null; if (mark) { try { made = Number(fs.readFileSync(mark, "utf8")); fs.unlinkSync(mark); } catch { /* no mark */ } } resolve({ code, out, made, secs: Math.round((Date.now() - t0) / 1000) }); };
    ch.on("error", () => end(null)); ch.on("close", (code) => end(code));
  });
}
function verdictOf(m, r) {
  const fails = r.out.split(/\r?\n/).filter((l) => /^ {2}FAIL /.test(l)).map((l) => l.slice(7));
  if (/^ALL \d+ CHECKS PASSED/m.test(r.out) && r.code === 0) return r.made > 0 ? { verdict: "SURVIVED", why: "the selftest passed with the change in" } : { verdict: "ERROR", why: "the selftest passed, but it never read the changed file" };
  if (!/^FAILED — \d+ of \d+ checks/m.test(r.out)) return { verdict: "ERROR", why: `the selftest gave no verdict (exit ${r.code}): ${(r.out.trim().split(/\r?\n/).slice(-1)[0] || "").slice(0, 160)}` };
  if (!(r.made > 0)) return { verdict: "ERROR", why: "the selftest failed, but it never read the changed file" };
  const hit = fails.filter((f) => m.by.test(f));
  return hit.length ? { verdict: "CAUGHT", why: `${fails.length} case(s) failed; the one named for it: ${hit[0].split(" — ")[0].slice(0, 110)}` } : { verdict: "WEAK", why: `${fails.length} case(s) failed, none of them the one named for it (${m.by}): ${fails.slice(0, 3).map((f) => f.slice(0, 70)).join(" | ")}` };
}

async function main(argv) {
  const jobsAt = argv.indexOf("--jobs"), jobs = jobsAt >= 0 ? Math.max(1, Math.min(8, Number(argv[jobsAt + 1]) || 1)) : 1;
  const ids = argv.filter((a, i) => !a.startsWith("--") && !(jobsAt >= 0 && i === jobsAt + 1));
  const unknownFlags = argv.filter((a) => a.startsWith("--") && !["--list", "--jobs"].includes(a));
  if (unknownFlags.length) { console.error(`usage: run.cjs [--list] [--jobs n] [<id> …] — unknown: ${unknownFlags.join(" ")}`); return 2; }
  const bad = validate();
  if (argv.includes("--list")) {
    for (const m of MUTANTS) console.log(`  ${m.id.padEnd(30)} ${m.file.padEnd(42)} ${m.what}`);
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
  const n = (v) => results.filter((x) => x && x.verdict === v).length;
  if (n("CAUGHT") === results.length) { console.log(`ALL ${results.length} MUTANTS CAUGHT (each by the known answer written for it)`); return 0; }
  console.log(`MUTANTS NOT ALL CAUGHT — ${n("CAUGHT")} of ${results.length} caught; ${n("WEAK")} weak, ${n("SURVIVED")} survived, ${n("ERROR")} without a result: ${results.filter((x) => x && x.verdict !== "CAUGHT").map((x) => `${x.m.id} (${x.verdict})`).join(", ")}`);
  return 1;
}

module.exports = { MUTANTS, validate, verdictOf, selftest };
if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => { console.error(`mutants/run.cjs failed: ${e.stack || e.message}`); process.exit(1); });
