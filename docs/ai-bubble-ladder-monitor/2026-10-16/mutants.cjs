#!/usr/bin/env node
"use strict";
/**
 * AI-BUBBLE LADDER MONITOR (2026-10-16) — MUTATION CHECK of the selftest. Read-only on the repository and on this
 * package: each mutant is a deliberately broken COPY of a staged file in a temp directory, served to the selftest
 * through AI_BUBBLE_LADDER_SELFTEST_STAGED. staged/ is never touched, and deploy.cjs never sets that variable.
 *
 *   node docs/ai-bubble-ladder-monitor/2026-10-16/mutants.cjs            every mutant
 *   node docs/ai-bubble-ladder-monitor/2026-10-16/mutants.cjs <id> ...   the named mutants only
 *   node docs/ai-bubble-ladder-monitor/2026-10-16/mutants.cjs --list     what each one breaks
 *
 * A mutant is KILLED when the selftest fails AND at least one of the checks that must catch it is among the failures
 * (`kills`, a regex on check names) — a mutant that merely makes some unrelated check fall over is not killed, it is
 * reported as caught by the wrong check. A mutant that SURVIVES is a hole in the selftest.
 *
 * Exit 0 every mutant killed · 1 a survivor, a wrongly-caught mutant, or a mutation that could not be applied.
 */
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");

const PKG = __dirname, SRC = path.join(PKG, "staged", "backend");
const LIB = "ai-bubble-ladder.js", MON = "ai-bubble-ladder-monitor.js";

/** [id, what it breaks, file, from, to, the check names that must catch it] */
const MUTANTS = [
  // ── the B1 band rule ──
  ["band-arms-on-equal", "a close EQUAL to the arm level arms the rung", LIB,
    "r = v < m * (1 - band) ? 0 : 1;", "r = v <= m * (1 - band) ? 0 : 1;", /b1-equal B1-QQQ|ARMED agrees with the re-derivation/],
  ["band-wrong-side", "the arm level is 1.02 x the mean, not 0.98 x", LIB,
    "r = v < m * (1 - band) ? 0 : 1;", "r = v < m * (1 + band) ? 0 : 1;", /b1-no-cross B1-QQQ|the arm level is 0\.98/],
  ["band-no-band", "the band is dropped: the rung flips on the plain close-vs-mean test", LIB,
    "    else if (prev === 1) r = v < m * (1 - band) ? 0 : 1;\n    else r = v > m * (1 + band) ? 1 : 0;", "    else r = v > m ? 1 : 0;", /hysteresis|ARMED agrees with the re-derivation/],
  ["band-first-reading", "the first reading arms when the close merely equals the mean", LIB,
    "if (band === 0 || prev == null) r = v > m ? 1 : 0;", "if (band === 0 || prev == null) r = v >= m ? 1 : 0;", /the FIRST reading of a flat series is ARMED/],
  ["band-disarms-too-easily", "any close above the mean disarms an armed rung", LIB,
    "else r = v > m * (1 + band) ? 1 : 0;", "else r = v > m ? 1 : 0;", /still does not disarm|the band rule agrees with the independent re-derivation/],
  ["sma-199", "the band's mean is taken over 199 sessions", LIB, 'sym: "QQQ", n: 200, band: 0.02', 'sym: "QQQ", n: 199, band: 0.02',
    /b1-cross B1-QQQ|the value is the last adjusted close and the mean/],
  ["b1-availability-ignored", "a rung with fewer than 200 closes is read anyway", LIB,
    "if (reading == null || m == null) { out.note =", "if (false) { out.note =", /short: every rung is NOT READ|a 200-day mean is not taken over fewer than 200 closes/],
  ["b2-availability-ignored", "a rung with fewer than 10 month-ends is read anyway", LIB,
    "if (me.length < rung.n) { out.note =", "if (false) { out.note =", /short: every rung is NOT READ/],
  ["threshold-always-arm", "an armed rung is shown the arm level, not the disarm level it is judged against", LIB,
    "out.threshold = out.armed ? out.disarmThreshold : out.armThreshold;", "out.threshold = out.armThreshold;", /the threshold shown is the one its current reading is judged against/],

  // ── the B2 ten-month rule ──
  ["tenmonth-not-strict", "a month-end EQUAL to the 10-month mean counts as IN (the carried-forward reading, so armedSince lies)", LIB,
    "cur = values[i] > win.reduce((a, b) => a + b, 0) / n ? 1 : 0;", "cur = values[i] >= win.reduce((a, b) => a + b, 0) / n ? 1 : 0;",
    /it arms AT that month-end, 2026-09-30, and not before|exactly one of armedSince/],
  ["tenmonth-armed-not-strict", "the rung's own armed test flips at equality", LIB,
    "out.armed = out.value <= out.threshold;", "out.armed = out.value < out.threshold;", /b2-equal B2-QQQ/],
  ["tenmonth-excludes-current", "the 10-month mean leaves the current month-end out", LIB,
    "const last = me[me.length - 1], win = me.slice(-rung.n).map((k) => s.values[k])", "const last = me[me.length - 1], win = me.slice(-rung.n - 1, -1).map((k) => s.values[k])",
    /b2-cross B2-QQQ|the threshold is the mean of the last 10 month-ends including it/],
  ["tenmonth-nine", "the mean is taken over 9 month-ends", LIB, 'sym: "QQQ", n: 10,\n    what: "QQQ month-end', 'sym: "QQQ", n: 9,\n    what: "QQQ month-end',
    /b2-cross B2-QQQ|the threshold is the mean of the last 10 month-ends including it/],
  ["monthend-takes-forming", "the last session counts as a month-end, so the forming month is read", LIB,
    "for (let i = 0; i < dates.length - 1; i++) if (String(dates[i]).slice(0, 7) !== String(dates[i + 1]).slice(0, 7)) out.push(i);",
    "for (let i = 0; i < dates.length - 1; i++) if (String(dates[i]).slice(0, 7) !== String(dates[i + 1]).slice(0, 7)) out.push(i);\n  if (dates.length) out.push(dates.length - 1);",
    /the last session of the series is never a month-end|a month-end is a session whose next session|the value is the last completed month-end/],
  ["provisional-ten", "the flip level X* is the mean of 10 month-ends, not the 9 completed ones", LIB,
    "const prior = me.slice(-(rung.n - 1)).map((k) => s.values[k]), star = prior.reduce((a, b) => a + b, 0) / (rung.n - 1);",
    "const prior = me.slice(-rung.n).map((k) => s.values[k]), star = prior.reduce((a, b) => a + b, 0) / rung.n;",
    /the provisional threshold is the flip level X\*/],

  // ── reading the store ──
  ["reads-price-close", "the price close is read instead of the dividend-adjusted one", LIB,
    "rows.push({ d: r.d, a: r.a });", "rows.push({ d: r.d, a: r.c });", /the value is the last adjusted close and the mean|b1-cross B1-QQQ: ARMED, close 97/],
  ["cut-ignored", "--as-of is ignored: rows past the cut are read anyway", LIB,
    "if (cut && r.d > cut) continue;", "if (false) continue;", /the day BEFORE the crossing day|the month-end BEFORE it did not arm/],
  ["dupes-allowed", "two rows for one date are taken twice", LIB,
    'if (rows[i].d === rows[i - 1].d) throw new Error(`${sym}: ${file} holds two rows for ${rows[i].d}`);', "if (false) throw new Error();",
    /two rows for one date is refused/],
  ["nulls-kept", "a row with no adjusted close is kept as it is", LIB, "if (!Number.isFinite(r.a)) continue;", "if (false) continue;",
    /rows with no adjusted close are dropped/],
  ["unsorted-kept", "rows are read in the order the file happens to hold them", LIB,
    'rows.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0));', "if (false) rows.sort();", /rows out of order are put in order/],
  ["ratio-unaligned", "the ratio is taken on dates the denominator does not have", LIB,
    "if (!Number.isFinite(q) || q === 0) continue;", "if (false) continue;", /credit-gap/],
  ["missing-series-ignored", "a missing series is skipped and the rest of the ladder is read anyway", LIB,
    "for (const s of symbols) out[s] = readSeries(dir, s, cut);", "for (const s of symbols) { try { out[s] = readSeries(dir, s, cut); } catch { /* skipped */ } }",
    /one missing series/],

  // ── the dated status ──
  ["date-is-newest", "the status is dated the newest session any series reaches", LIB,
    "const date = tos.length ? tos.slice().sort()[0] : null;", "const date = tos.length ? tos.slice().sort().pop() : null;",
    /the status is dated the one day EVERY series reaches/],
  ["no-trim", "a series that runs past the status's date is read to its own end", LIB,
    "const read = Object.fromEntries(Object.entries(store).map(([k, s]) => [k, trimSeries(s, date)]));", "const read = store;",
    /B1-QQQ is NOT armed|every rung was read as of the same day/],
  ["unavailable-is-not-armed", "a rung that could not be read is reported 'not armed'", LIB,
    "available: false, armed: null, value: null, threshold: null, note: null };", "available: false, armed: false, value: null, threshold: null, note: null };",
    /every rung is NOT READ/],
  ["lag-not-said", "a lagging series is not named", LIB, "const behind = Object.values(store).filter((s) => s.to && s.to < newest).map((s) => `${s.sym} ends ${s.to}`);",
    "const behind = [];", /the lagging series is named/],
  ["merge-drops-other-days", "writing a day throws away every other day in the file", LIB,
    "const days = { ...prev, [st.date]: st };", "const days = { [st.date]: st };", /a second day is added and the first is kept/],
  ["merge-keeps-stale-day", "writing a day keeps the day already there", LIB,
    "const days = { ...prev, [st.date]: st };", "const days = { [st.date]: st, ...prev };", /re-running a day replaces that day/],

  // ── the monitor: what it writes and what it must not ──
  ["writes-without-write", "the status file is written on a read-only run", MON,
    'if (!o.write) { say("  read-only run', 'if (false) { say("  read-only run', /a run with no --write/],
  ["write-over-unparseable", "a status file that does not parse is replaced", MON,
    "try { doc = rd(o.out); } catch (e) { say(`NOT WRITTEN: ${e.message}`); return { code: 1, status, wrote: null, lines }; }", "doc = null;",
    /a status file that does not parse is NOT replaced|a second day is added and the first is kept/],
  ["failed-write-reported-ok", "a failed write is reported as a success", MON,
    'catch (e) { say(`NOT WRITTEN: ${o.out} (${e.message}) — the file is as it was (it is replaced by rename, or not at all)`); return { code: 1, status, wrote: null, lines }; }',
    "catch (e) { /* ignored */ }", /a failed write ends 1/],
  ["bad-store-exits-0", "a store that cannot be read ends 0 with no status", MON,
    'return { code: 1, status: null, wrote: null, lines };\n  }', "return { code: 0, status: null, wrote: null, lines };\n  }",
    /a store that is not there: exit 1/],
  ["bad-asof-accepted", "a nonsense --as-of is taken as a date", MON,
    'if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(String(v))) return { usage: `--as-of needs a YYYY-MM-DD date, got ${v === undefined ? "nothing" : v}` };',
    "if (false) return { usage: `` };", /a bad --as-of is usage/],
  ["raw-write", "the status file is written with a bare writeFileSync instead of writeJsonAtomic", MON,
    'const { writeJsonAtomic } = require("./lib/atomic-write.js");',
    'const writeJsonAtomic = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 1));',
    /the staged files do no writing of their own|the monitor's one write goes through/],
  ["summary-no-threshold", "a rung's line gives the value but not the threshold it is judged against", LIB,
    "close ${num(r.value)} vs ${r.armed ? \"disarm\" : \"arm\"} level ${num(r.threshold)}", "close ${num(r.value)} vs the level",
    /each read rung's line carries ARMED or not armed, its value and its threshold/],
  ["summary-no-armed-word", "a rung's line does not say whether it is armed", LIB,
    '${r.armed ? "ARMED    " : "not armed"}', '"         "', /each read rung's line carries ARMED or not armed|exactly B1-QQQ, B2-QQQ and B2-SPY are armed/],
];

const args = process.argv.slice(2);
if (args.includes("--list")) { for (const [id, what, file] of MUTANTS) console.log(`${id.padEnd(26)} ${file.padEnd(30)} ${what}`); process.exit(0); }
const want = args.filter((a) => !a.startsWith("--"));
for (const id of want) if (!MUTANTS.some((m) => m[0] === id)) { console.error(`no mutant named ${id} (--list shows them)`); process.exit(1); }
const list = want.length ? MUTANTS.filter((m) => want.includes(m[0])) : MUTANTS;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bubble-ladder-mutants-"));
process.on("exit", () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* harmless */ } });
const SOURCE = Object.fromEntries([LIB, MON].map((f) => [f, fs.readFileSync(path.join(SRC, f), "utf8")]));

/** the names of the checks a selftest run reported as FAIL */
const failedChecks = (stdout) => String(stdout).split(/\r?\n/).filter((l) => l.startsWith("FAIL  ")).map((l) => l.slice(6).trim());

console.log(`MUTATION CHECK — ${list.length} mutant(s) of ${MUTANTS.length}, each against docs/ai-bubble-ladder-monitor/2026-10-16/selftest.cjs`);
let survived = 0, wrong = 0, broken = 0;
for (const [id, what, file, from, to, kills] of list) {
  const dir = path.join(ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const n = SOURCE[file].split(from).length - 1;
  if (n !== 1) { broken++; console.log(`  ${id.padEnd(26)} COULD NOT BE BUILT — its anchor appears ${n} time(s) in ${file}`); continue; }
  for (const f of [LIB, MON]) fs.writeFileSync(path.join(dir, f), f === file ? SOURCE[f].replace(from, to) : SOURCE[f]);
  const chk = cp.spawnSync(process.execPath, ["--check", path.join(dir, file)], { encoding: "utf8" });
  if (chk.status !== 0) { broken++; console.log(`  ${id.padEnd(26)} COULD NOT BE BUILT — the mutant does not parse: ${String(chk.stderr).trim().split("\n")[0]}`); continue; }
  const r = cp.spawnSync(process.execPath, [path.join(PKG, "selftest.cjs")],
    { encoding: "utf8", timeout: 600000, maxBuffer: 64 << 20, env: { ...process.env, AI_BUBBLE_LADDER_SELFTEST_STAGED: dir } });
  const fails = failedChecks(r.stdout);
  if (r.status === 0) { survived++; console.log(`  ${id.padEnd(26)} SURVIVED — ${what}: the selftest still passed`); continue; }
  const hit = kills ? fails.filter((f) => kills.test(f)) : fails;
  if (!hit.length) { wrong++; console.log(`  ${id.padEnd(26)} CAUGHT BY THE WRONG CHECK — ${what}\n${" ".repeat(30)}failed: ${fails.slice(0, 4).join(" | ") || `(exit ${r.status}, no FAIL line: ${String(r.stderr).trim().split("\n")[0]})`}`); continue; }
  console.log(`  ${id.padEnd(26)} killed by ${hit.length} check(s): ${hit[0]}${hit.length > 1 ? ` (+${hit.length - 1} more)` : ""}`);
}
const bad = survived + wrong + broken;
console.log(bad
  ? `\n${bad} MUTANT(S) NOT KILLED: ${survived} survived, ${wrong} caught by the wrong check, ${broken} could not be built — the selftest has a hole`
  : `\nALL ${list.length} MUTANTS KILLED`);
process.exit(bad ? 1 : 0);
