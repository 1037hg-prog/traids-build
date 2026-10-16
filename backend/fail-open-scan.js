#!/usr/bin/env node
/**
 * FAIL-OPEN SCANNER — hunts checks that cannot fail loudly. (2026-09-09, from the review)
 *
 * WHY. preflight.js ran a CRITICAL check for a secret committed to git by asking git for the whole
 * index. As the repo grew the output passed execFileSync's 1MB default maxBuffer, the call threw
 * ENOBUFS, and the catch recorded "git check failed" as a WARN. It did not report a false green —
 * it reported a softer amber — but it had not actually tested its proposition for as long as the
 * index has been over 1MB, and nobody looked because the surrounding report was already amber.
 *
 * Both reviewers made the same point: that is a CLASS, and grepping for `execFileSync` finds three
 * instances of one shape, not the boundary. The general shape is:
 *
 *     a verification mechanism hits an internal error and reports a lower-severity status
 *     instead of reporting that the verification itself could not run.
 *
 * The invariant they proposed, which this scans for violations of:
 *
 *     A check terminates in exactly one of  PASS | FAIL | UNKNOWN.
 *     ERROR must map to UNKNOWN, and UNKNOWN must be at least as loud as FAIL.
 *     ERROR -> PASS and ERROR -> WARN are both defects.
 *
 * WHAT THIS IS NOT. A heuristic, not a prover. It reads catch blocks and empty-default fallbacks and
 * flags the ones whose recovery looks like a softened verdict. It WILL produce false positives — a
 * catch that returns [] is perfectly correct when the caller genuinely treats absence as data. It is
 * a review queue, deliberately not a gate: making it a gate would create exactly the kind of noisy
 * detector this shop has already shipped once and had to unpick.
 *
 * Usage: node backend/fail-open-scan.js [--all] [--json]
 *        default lists only HIGH confidence; --all includes the speculative tail.
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const ALL = process.argv.includes("--all"), JSON_OUT = process.argv.includes("--json");

// worktrees hold a full second copy of the repo; scanning them doubles every finding for nothing.
const SKIP = /node_modules|[\\/]\.git[\\/]|[\\/]worktrees[\\/]|[\\/]dist[\\/]|[\\/]build[\\/]|[\\/]data[\\/]|\.min\.js$/;
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
};

/**
 * PRECISION OVER RECALL, deliberately. The first cut of this matched the bare WORDS warn/ok/pass
 * anywhere in a catch body and returned 286 rows, including several catches that are exactly right —
 * one of them literally reads "a check that cannot run has not passed". A queue nobody can read is
 * the same failure as no queue. So a softener now has to be a VERDICT: a quoted severity literal, or
 * a returned passing value. And anything whose recovery is already loud is excluded outright.
 */
const SOFTENERS = [
  // "unknown" is deliberately ABSENT: ERROR -> UNKNOWN is the correct mapping, not a defect. Flagging
  // it was this scanner's own bug on 2026-09-09 — it reported coverage-monitor.js, which does the
  // right thing, as its highest-confidence finding. A scanner that punishes correct code is worse
  // than no scanner, because the first thing anyone does with it is stop reading it.
  { re: /["'`](warn|info|notice|ok|pass|passed|skip|skipped|clean)["'`]/i, why: "recovers by ASSERTING a soft verdict" },
  { re: /return\s+(true\b|\{\s*(ok|pass|valid|clean)\s*:\s*true)/, why: "recovers by returning a PASS" },
];
// If the recovery is already loud, it is not fail-open — it is correct, and must not be queued.
const LOUD = /\b(fail|failed|critical|fatal|throw|process\.exit|reject|error|not run|cannot run|could not|unreachable|missing)\b/i;
const EMPTY_DEFAULT = /return\s+(\{\s*\}|\[\s*\]|null|0|""|'')/;   // legitimate for optional reads; --all only
// The operations whose failure genuinely means "I do not know", never "there is nothing".
const RISKY = /execFileSync|execSync|spawnSync|\bfetch\s*\(|readFileSync|statSync|readdirSync|JSON\.parse|require\s*\(/;
// Words that mark the surrounding code as a CHECK rather than an optional read.
const CHECKY = /\b(check|verify|audit|assert|guard|gate|validate|integrity|leak|secret|seal|preflight|health|stale|fresh)\b/i;

const findings = [];
for (const file of walk(ROOT)) {
  let src; try { src = fs.readFileSync(file, "utf8"); } catch { continue; }
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\}?\s*catch\s*(\((\w+)\))?\s*\{(.*)$/);
    if (!m) continue;
    /**
     * The catch body ONLY — brace-matched, not a fixed lookahead. A 5-line window bled into whatever
     * followed the block and produced a finding on evening-report.js from code that was not in the
     * catch at all. A false positive sourced from the scanner's own sloppiness is indistinguishable,
     * to a reader, from one sourced from the code.
     */
    // depth starts at 1: the regex above already consumed the catch block's OPENING brace, so m[3]
    // is the body's first characters, not a "{". Starting at 0 meant the first "}" closed a block
    // that had never opened, `started` stayed false, and body came back EMPTY for every single-line
    // catch — which is most of them here. That is why preflight.js:59, a known live defect, scanned
    // clean. A scanner whose body extractor returns "" cannot match any softener and reports 0 HIGH.
    let body = "", depth = 1;
    outer: for (let k = i; k < Math.min(lines.length, i + 40); k++) {
      const seg = k === i ? (m[3] || "") : lines[k];
      for (const ch of seg) {
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth <= 0) break outer; }
        body += ch;
      }
      body += " ";
      if (body.length > 600) break;
    }
    const before = lines.slice(Math.max(0, i - 12), i + 1).join(" ");
    /**
     * RISKY IS A NOISE FILTER, NOT A PRECONDITION (2026-09-09, second pass). Requiring a risky call
     * within 12 lines above the catch made the scanner miss preflight.js:59 — a live instance where
     * the value being tested was assigned further up than the window reached. A catch that ASSERTS a
     * soft verdict is a finding whatever threw: whatever went wrong, the code is now claiming a
     * verdict it did not establish. So the prefilter applies only to the empty-catch case, where it
     * genuinely is needed to keep the queue readable.
     */
    const riskyNearby = RISKY.test(before);

    const empty = /^\s*\}/.test(m[3] || "") || /^\s*$/.test((m[3] || "").replace(/\/\/.*/, ""));
    const checky = CHECKY.test(before) || CHECKY.test(body);
    /**
     * ORDERING BUG, 2026-09-09 (audit). LOUD was tested FIRST, so any catch that named the failure it
     * was softening got skipped — and a fail-open catch almost always names it. The scanner therefore
     * could not see its own motivating defect:
     *
     *     add("no secrets tracked in git", "warn", false, "git check failed")
     *
     * is LOUD ("failed") *and* SOFT ("warn"). That is not an exemption, it IS the defect — a check
     * that could not run, reported as a mild finding about the thing it was checking. preflight.js
     * appeared ZERO times in the scan even at --all, and the scanner reported 0 HIGH: a clean bill of
     * health from an instrument blind to the exact shape it was built for.
     *
     * LOUD may only excuse a catch that does NOT also assert a soft verdict.
     */
    const soft = SOFTENERS.find((s) => s.re.test(body));
    if (!soft && LOUD.test(body)) continue;                // loud only, asserts no verdict — correct, not a finding
    const swallows = !m[2] && empty && riskyNearby;         // catch {} — the error is not even named
    const emptyDefault = EMPTY_DEFAULT.test(body) && riskyNearby;

    if (!soft && !swallows && !emptyDefault) continue;
    // HIGH: reads like a CHECK and its recovery asserts a verdict. That is the ERROR -> PASS/WARN defect.
    const confidence = checky && soft ? "HIGH" : checky && swallows ? "MEDIUM" : "LOW";
    if (confidence === "LOW" && !ALL) continue;
    findings.push({
      file: path.relative(ROOT, file).replace(/\\/g, "/"), line: i + 1, confidence,
      why: soft ? soft.why : "swallows the error without naming it",
      code: lines[i].trim().slice(0, 130),
    });
  }
}

const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
findings.sort((a, b) => order[a.confidence] - order[b.confidence] || a.file.localeCompare(b.file) || a.line - b.line);

/**
 * ALWAYS WRITE THE ARTIFACT (2026-09-09). A scanner whose only output is a terminal it is not
 * attached to is the same starved-writer defect it exists to hunt. The file is what ops-health reads
 * nightly, so the count of HIGH findings becomes a tracked quantity rather than something noticed
 * whenever somebody happens to run this by hand.
 */
const high = findings.filter((f) => f.confidence === "HIGH");
try {
  require("./lib/atomic-write.js").writeJsonAtomic(path.join(__dirname, "data", "fail-open-scan.json"), {
    spec: "fail-open-scan-v1", asOf: new Date().toISOString(),
    invariant: "a check ends in PASS | FAIL | UNKNOWN; ERROR must map to UNKNOWN, and UNKNOWN must be at least as loud as FAIL",
    counts: { total: findings.length, high: high.length, medium: findings.filter((f) => f.confidence === "MEDIUM").length },
    high, findings,
    note: "HEURISTIC and deliberately a review queue, never a gate. MEDIUM is dominated by benign optional-require and loadEnv shapes; HIGH is the actionable set.",
  });
} catch (e) { console.error("  could not write fail-open-scan.json:", e.message); }

if (JSON_OUT) { console.log(JSON.stringify({ spec: "fail-open-scan-v1", asOf: new Date().toISOString(), findings }, null, 1)); process.exit(0); }

const byConf = findings.reduce((a, f) => ((a[f.confidence] = (a[f.confidence] || 0) + 1), a), {});
console.log(`\n  FAIL-OPEN SCAN — ${findings.length} candidate(s)  ${JSON.stringify(byConf)}`);
console.log(`  Invariant: a check ends in PASS | FAIL | UNKNOWN. ERROR must map to UNKNOWN, and UNKNOWN`);
console.log(`  must be at least as loud as FAIL. Every row below is a place ERROR may become PASS or WARN.`);
console.log(`  HEURISTIC — expect false positives. This is a review queue, never a gate.\n`);
for (const f of findings) console.log(`  ${f.confidence.padEnd(6)} ${(f.file + ":" + f.line).padEnd(46)} ${f.why}\n         ${f.code}`);
if (!ALL) console.log(`\n  (--all also lists the LOW-confidence tail; --json for machine output)`);
