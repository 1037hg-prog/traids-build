#!/usr/bin/env node
/**
 * TRAIDS — ONE-COMMAND AUDIT. 2026-08-06.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 * On 2026-08-06 the operator asked for a full audit and it found that the forward evidence
 * pipeline had been dead for four sessions: 88 positions a day settled and discarded, zero rows
 * reaching the ledger. Every existing diagnostic reported clean the entire time.
 *
 * His response was the correct one: "apparently I have to audit this program daily." He should
 * not. The checks existed and ran on schedule; what did not exist was
 *
 *     (a) a check on whether evidence was GROWING rather than merely well-formed, and
 *     (b) a single place that says PASS or FAIL loudly enough that a green day needs no reading.
 *
 * Five separate tools each printing 30 lines is not an audit. It is five things a human has to
 * remember to run, read and correlate — and correlation is exactly what failed: the position
 * count fell in one tool while the row count stayed flat in another, and nothing compared them.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE STANCE
 *
 * This is ADVERSARIAL. It tries to prove the system is broken and reports PASS only when it
 * cannot. Every check states what would make it fail, so a check that cannot fail is visible as
 * a check that is not doing anything.
 *
 * Exit codes:  0 = PASS   1 = DEGRADED (warnings)   2 = FAIL (something is actually wrong)
 *
 *   node backend/audit.js           full audit, human-readable
 *   node backend/audit.js --quiet   one line + exit code (for the chain / a scheduled task)
 */
const { execFileSync } = require("child_process");
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const rd = (f, fb = null) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return fb; } };
const QUIET = process.argv.includes("--quiet");

const findings = [];
const add = (name, level, ok, detail, wouldFail) => findings.push({ name, level, ok, detail, wouldFail });
const day = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// ── 1. does the system's own preflight pass? ────────────────────────────────────────────────
let pf = null;
try {
  execFileSync(process.execPath, [path.join(__dirname, "preflight.js")], { encoding: "utf8", timeout: 120000 });
  pf = rd("preflight-status.json");
} catch (e) {
  pf = rd("preflight-status.json");                      // non-zero exit is expected on DEGRADED/NO-GO
}
if (pf) {
  const bad = (pf.checks || []).filter(c => !c.ok);
  add("preflight", pf.verdict === "NO-GO" ? "fail" : pf.verdict === "DEGRADED" ? "warn" : "info",
    pf.verdict === "GO", `${(pf.checks || []).length} probes · ${pf.verdict}${bad.length ? " · failing: " + bad.map(c => c.name).join(", ") : ""}`,
    "any probe returns not-ok");
} else add("preflight", "fail", false, "could not run", "preflight cannot execute");

// ── 2. IS EVIDENCE ACCRUING? the check whose absence cost four sessions ─────────────────────
{
  const log = rd("trade_log.json", []);
  const rows = Array.isArray(log) ? log : (log.log || log.trades || []);
  const closedDays = [...new Set(rows.filter(r => r.closedAt).map(r => day(r.closedAt)))].sort();
  const last = closedDays[closedDays.length - 1] || null;
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const today = et.toLocaleDateString("en-CA");
  // MISSED SETTLE MORNINGS, counted honestly (corrected 2026-08-12). R14 banks settles at the
  // OPEN run (~09:47 ET) every trading day, so a missed morning is the unit. Two rules:
  //   · every weekday STRICTLY BETWEEN the last banked settle and today is a missed morning
  //   · today counts too, but only from 11:00 ET — before that the run may simply not have run
  // The first version of this counted the last-settle day ITSELF (weekdays in [last, today)),
  // then added today on top, so one missed morning reported as two and FAILed on the first
  // miss while claiming to WARN. The ladder is: 1 missed morning WARN, 2 FAIL.
  const etHM = et.toTimeString().slice(0, 5);
  const todayIsTrading = et.getDay() >= 1 && et.getDay() <= 5;
  let stale = 0;
  if (last) {
    for (let x = new Date(last + "T12:00:00Z"), n = new Date(today + "T12:00:00Z"); ; ) {
      x.setUTCDate(x.getUTCDate() + 1);
      if (x >= n) break;
      const dw = x.getUTCDay(); if (dw >= 1 && dw <= 5) stale++;
    }
    if (todayIsTrading && etHM >= "11:00" && last < today) stale++;
  }
  add("evidence accruing", stale >= 2 ? "fail" : stale >= 1 ? "warn" : "info", stale < 1,
    `${rows.length} rows · last settle banked ${last || "never"} (${stale} trading session(s) behind, today counted after 11:00 ET)`,
    "no settle banked for >=2 trading sessions (same-day miss counts from 11:00 ET)");
}

// ── 3. does the ledger still re-derive? ─────────────────────────────────────────────────────
{
  try { execFileSync(process.execPath, [path.join(__dirname, "integrity-audit.js")], { encoding: "utf8", timeout: 300000 }); } catch { }
  const ia = rd("integrity-audit.json");
  const bad = ia ? (ia.rMismatches || 0) + (ia.pnlMismatches || 0) : null;
  /**
   * ONE CHECK, ONE VERDICT (fixed 2026-08-29).
   *
   * This line used to append the integrity audit's OVERALL verdict to its own detail, so a run
   * with perfect arithmetic printed:
   *
   *     [INFO] ledger re-derives   2424 rows · 0 R · 0 P&L mismatches · FAIL
   *
   * — a pass and a FAIL on one line, where the FAIL belonged to entirely different checks
   * (impossible values, unverifiable options rows). A reader either believes the numbers and is
   * confused by the verdict, or believes the verdict and distrusts the numbers. Both readings are
   * wrong, and a summary nobody can parse is a summary people learn to skip.
   *
   * The arithmetic check now reports ONLY arithmetic. Everything else the integrity audit failed
   * on gets its own finding below, so it is surfaced rather than smuggled into another line.
   */
  add("ledger re-derives", bad === null ? "fail" : bad > 0 ? "fail" : "info", bad === 0,
    ia ? `${ia.checked} rows re-derived from raw fields · ${ia.rMismatches} rMult · ${ia.pnlMismatches} P&L mismatches (arithmetic only)` : "audit did not run",
    "any stored number disagrees with a re-derivation from its own raw fields");

  if (ia) {
    const imp = ia.impossible || {};
    const hits = Object.entries(imp).filter(([, v]) => Number(v) > 0);
    const unver = Number(ia.optionsUnverifiable || 0);
    const parts = [];
    if (hits.length) parts.push(hits.map(([k, v]) => `${v} × ${k}`).join("; "));
    if (unver) parts.push(`${unver} options row(s) whose stored P&L cannot be re-derived from stored entry/exit (friction-marked pnl vs raw fields — recordkeeping, not a wrong trade; ${ia.optionsInSignalLedger || 0} options rows in the clean signal ledger)`);
    add("ledger integrity — non-arithmetic",
      (hits.length || unver) ? "warn" : "info",
      !(hits.length || unver),
      parts.length ? parts.join(" · ") : "no impossible values, every options row re-derives",
      "any impossible value, or any row whose stored P&L cannot be reproduced from its own fields");
  }
}

// ── 3b. did THIS MORNING'S open cycle succeed? ───────────────────────────────────────────────
// Added 2026-08-12. The close chain had an audit check; the OPEN run — the one that banks every
// settle under R14 — had none. On 08-12 it failed twice over (empty local book, then a FATAL on
// the missing Rebuild button) and nothing said so directly; the breakage surfaced only as a
// second-order "evidence accruing" complaint. Reads the run log's last OPEN block, no new
// plumbing, so it also covers every historical run already on disk.
{
  const p = path.join(__dirname, "..", "automation", "daily-run.log");
  let txt = ""; try { txt = fs.readFileSync(p, "utf8"); } catch {}
  const blocks = txt.split(/={4,}\s*OPEN\s+/i).slice(1);
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const todayIsTrading = et.getDay() >= 1 && et.getDay() <= 5;
  const hm = et.toTimeString().slice(0, 5);
  if (!blocks.length) add("morning open cycle", "warn", false, "no OPEN block in daily-run.log", "the open run has never logged");
  else {
    const b = blocks[blocks.length - 1];
    const when = (b.match(/(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}/) || [])[1] || null;
    const broke = /FATAL|CYCLE FAILED|DAILY RUN FAILED|HYDRATION TIMED OUT|COULD NOT READ/i.test(b);
    const settled = (b.match(/settled (\d+)/) || [])[1] || null;
    const banked = (b.match(/\+(\d+) row\(s\) banked/) || [])[1] || null;
    const isToday = when === et.toLocaleDateString("en-CA");
    const due = todayIsTrading && hm >= "11:00";
    const detail = `last OPEN ${when || "?"}${broke ? " — FAILED" : settled ? ` — settled ${settled}, ${banked ?? "?"} banked` : " — clean"}`;
    if (broke && isToday) add("morning open cycle", "fail", false, detail, "today's open run logged a FATAL/abort");
    else if (due && !isToday) add("morning open cycle", "fail", false, `${detail} — no run logged for today`, "no open run logged on a trading day by 11:00 ET");
    else add("morning open cycle", broke ? "warn" : "info", !broke, detail, "the open run FATAL'd or never ran");
  }
}

// ── 4. did the nightly chain run, and did anything fail? ────────────────────────────────────
{
  const c = rd("chain-status.json");
  if (!c) add("nightly chain", "fail", false, "no chain-status.json", "the chain never ran");
  else {
    const ageH = (Date.now() - new Date(c.started).getTime()) / 36e5;
    const failed = (c.steps || []).filter(s => s.ok === false);
    /**
     * WEEKEND-AWARE STALENESS (2026-08-10). A flat 36h bound fired every Monday morning: the
     * chain runs weekdays at 14:15 MT, so Friday-to-Monday is ~67h of correct silence. The
     * honest question is "has a WEEKDAY close chain been missed?" — count weekday 14:15s that
     * have passed (plus 2h grace) since the last run. Zero missed = current, whatever the hours
     * say. A Monday false alarm every week is how a real Tuesday alarm gets ignored.
     */
    let missed = 0;
    {
      const last = new Date(c.started);
      const probe = new Date(last);
      probe.setHours(0, 0, 0, 0);
      for (let i = 0; i < 30; i++) {
        probe.setDate(probe.getDate() + 1);
        const due = new Date(probe); due.setHours(14, 15, 0, 0);   // the task fires 14:15 LOCAL (MT) and this audit runs on the same machine
        if (due <= last) continue;
        if (due.getDay() >= 1 && due.getDay() <= 5 && Date.now() > due.getTime() + 2 * 3600000) missed++;
        if (probe > new Date()) break;
      }
    }
    add("nightly chain", failed.length || missed ? "fail" : "info", !failed.length && !missed,
      `${(c.steps || []).length} steps · ${failed.length} failed · ran ${ageH.toFixed(0)}h ago · ${missed} weekday run(s) missed${failed.length ? " → " + failed.map(s => s.name).join(", ") : ""}`,
      "any step failed, or a weekday close chain was missed (weekend silence is correct)");
  }
}

// ── 5. are open defects being carried, and are they flattering? ─────────────────────────────
{
  const d = rd("defect-log.json", { audits: [] });
  const all = (d.audits || []).flatMap(a => a.defects || []);
  const open = all.filter(x => !x.fixed);
  const crit = open.filter(x => x.severity === "critical");
  const flat = all.filter(x => x.direction === "flattering").length;
  // "HURDLES" (operator terminology, 2026-08-10) in every displayed string; the underlying
  // fields keep the technical term because the flattering-share metric depends on it.
  add("hurdles", crit.length ? "fail" : open.length > 15 ? "warn" : "info", !crit.length,
    `${all.length - open.length} cleared of ${all.length} · ${open.length} still open · ${crit.length} critical · ${flat} would have flattered results (${(100 * flat / (all.length || 1)).toFixed(0)}%)`,
    "any open hurdle is marked critical");
}

// ── 6. is any registered test ready to read and being ignored? ──────────────────────────────
{
  try { execFileSync(process.execPath, [path.join(__dirname, "adjudicator.js")], { encoding: "utf8", timeout: 120000 }); } catch { }
  const a = rd("adjudicator.json");
  const ready = a ? (a.rows || []).filter(r => r.verdict === "READY TO READ") : [];
  add("tests awaiting a read", ready.length ? "warn" : "info", !ready.length,
    a ? `${ready.length} ready${ready.length ? " (" + ready.map(r => r.id).join(", ") + ")" : ""} · ${a.manualCount} with prose-only bars` : "adjudicator did not run",
    "a test's sample condition is met and nobody has computed the statistic");
}

// ── 7. does the regression suite still pass? ────────────────────────────────────────────────
// Added 2026-08-06 with the suite itself. A test suite nobody runs is documentation, so it is
// wired into the audit that already runs every 3 hours and as the last step of the chain.
{
  const fsx = require("fs");
  const suiteDir = path.join(__dirname, "test");
  if (!fsx.existsSync(suiteDir)) add("regression suite", "warn", false, "no backend/test directory", "the suite is missing");
  else {
    let out = "", code = 0;
    try { out = execFileSync(process.execPath, [path.join(suiteDir, "run.js")], { encoding: "utf8", timeout: 180000 }); }
    catch (e) { out = (e.stdout || "") + (e.stderr || ""); code = e.status ?? 1; }
    const m = out.match(/(\d+) passed, (\d+) failed/);
    const nPass = m ? +m[1] : 0, nFail = m ? +m[2] : (code ? 1 : 0);
    const files = fsx.readdirSync(suiteDir).filter(f => f.endsWith(".test.js")).length;
    add("regression suite", nFail ? "fail" : "info", !nFail,
      `${nPass} passed, ${nFail} failed across ${files} file(s)`,
      "any regression test fails — each one locks down a specific logged defect");
  }
}

// ── 8. secrets ──────────────────────────────────────────────────────────────────────────────
{
  try {
    // ENOBUFS, 2026-09-09 (audit): asking git for the whole index blew execFileSync's 1MB default
    // as the repo grew, so this threw and reported "git check failed" instead of checking. Let git
    // filter with a pathspec and raise the buffer; a failure to RUN stays a failure, not a warn.
    const tracked = execFileSync("git", ["ls-files", "--", "*.env", ".env"], { cwd: path.join(__dirname, ".."), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const leaked = tracked.split("\n").map(s => s.trim()).filter(f => /(^|\/)\.env$/.test(f));
    add("no secrets in git", leaked.length ? "fail" : "info", !leaked.length, leaked.length ? leaked.join(", ") : "clean", "a .env file is tracked");
  } catch (e) { add("no secrets in git", "fail", false, "git check FAILED to run: " + String(e.message).slice(0, 80), "the check could not run"); }
}

// ── verdict ─────────────────────────────────────────────────────────────────────────────────
const fails = findings.filter(f => f.level === "fail" && !f.ok);
const warns = findings.filter(f => f.level === "warn" && !f.ok);
const verdict = fails.length ? "FAIL" : warns.length ? "DEGRADED" : "PASS";
const stamp = new Date().toISOString();
fs.writeFileSync(D("audit.json"), JSON.stringify({ ranAt: stamp, verdict, fails: fails.length, warns: warns.length, findings }, null, 1));

if (QUIET) {
  console.log(`TRAIDS AUDIT ${verdict}${fails.length ? " — " + fails.map(f => f.name).join(", ") : ""}${warns.length ? " (warn: " + warns.map(f => f.name).join(", ") + ")" : ""}`);
} else {
  console.log(`\nTRAIDS AUDIT · ${stamp}`);
  console.log(`Adversarial: this tries to prove the system is broken and reports PASS only when it cannot.\n`);
  for (const f of findings) {
    console.log(`  ${f.ok ? "ok  " : f.level === "fail" ? "FAIL" : "WARN"} ${f.name.padEnd(24)} ${f.detail}`);
    if (!f.ok) console.log(`       ${" ".repeat(24)} fails when: ${f.wouldFail}`);
  }
  console.log(`\n  ===== ${verdict} =====${verdict !== "PASS" ? `  ${fails.length} fail, ${warns.length} warn` : ""}`);
  if (verdict === "PASS") console.log(`  Nothing to read. That is the point — a green audit should cost you no attention.`);
  else console.log(`  Do not trust today's numbers until the FAIL lines are resolved.`);
}
process.exit(fails.length ? 2 : warns.length ? 1 : 0);
