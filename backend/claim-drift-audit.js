#!/usr/bin/env node
/**
 * CLAIM DRIFT AUDIT — do the numbers hard-coded in our prompts still match their source?
 *
 * WHY THIS EXISTS. On 2026-08-26 the trade-autopsy population bug was found and fixed in code:
 * direction and cost had been summed over 871 rows and printed against a 965-row total, inventing
 * a 5.54R residual that read as unexplained execution loss. Fixing the code was not enough. The
 * wrong figures — "+43.85R direction against 54.89R of cost paid, for a net of -16.58R across 965
 * trades" — were already written into all three agent wave prompts, and had been briefing every
 * agent, every day, since those prompts were authored.
 *
 * A change registry records THAT a number changed. It does not record everywhere the old value was
 * already quoted. Prose is a cache with no invalidation, and it is the cache the agents actually
 * read. This is the invalidation.
 *
 * WHAT IT DOES. A declarative table of CLAIMS. Each names a figure that appears in prose, a regex
 * that finds it, and a resolver that recomputes the live value from the source of truth. Every
 * .md under .claude/agents and .claude/scheduled-tasks is scanned; a captured number that no longer
 * matches its source is flagged with file, line and both values.
 *
 * WHAT IT DOES NOT DO. It only checks REGISTERED claims — it cannot know that an arbitrary number
 * in prose was meant to track something. That is a real limit and it is stated rather than hidden:
 * `unregisteredNumerics` reports how many numeric tokens sit in scanned prose without a claim
 * covering them, so the coverage gap is visible instead of implied. Adding a claim is four lines.
 *
 * Exit code 1 when anything has drifted, so the chain can surface it. Output: data/claim-drift.json
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");

const ROOT = path.join(__dirname, "..");
const D = (f) => path.join(__dirname, "data", f);
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return d; } };

const autopsy = readJson("trade-autopsy.json");
const pooling = readJson("pooling-audit.json");
const learner = readJson("daily-learner.json");
const registry = readJson("test-registry.json");
const riskRows = (() => { try { return fs.readFileSync(D("portfolio-risk.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } })();
const ledger = (() => { try { return require("./lib/reconcile.js").cleanEraLedger(); } catch { return null; } })();

const num = (v) => (Number.isFinite(v) ? v : null);
const A = autopsy && autopsy.attribution;

/**
 * claims: id · what it is · regex (ONE capture group = the number as written) · live value · tolerance
 * Regexes are deliberately anchored on surrounding words so a bare number elsewhere is not matched.
 */
/**
 * `volatile: true` means the source advances on its own as trades settle. For those, a mismatch is
 * NOT evidence the prose was wrong when written — it is evidence the figure should never have been
 * hard-coded. Discovered by running this tool: it flagged the autopsy numbers I had corrected hours
 * earlier, because the book had booked more trades in between. A tool that cries wolf on every live
 * counter would be ignored inside a week, which is worse than not having it.
 *
 * So volatile claims get a different verdict and a different fix: replace the number with an
 * instruction to read it. Stable claims (a registry count, a policy ceiling) genuinely are wrong
 * when they disagree and get fixed in place.
 */
const CLAIMS = [
  { id: "autopsy.direction", desc: "direction before cost", volatile: true,
    re: /\+?(\d+\.\d+)R\s*(?:of\s*)?direction|direction[^.\n]{0,30}?\+(\d+\.\d+)R/gi,
    live: A ? num(A.directionR_beforeCost) : null, tol: 0.01 },
  { id: "autopsy.cost", desc: "cost paid", volatile: true,
    re: /against\s*[-−]?(\d+\.\d+)R\s*of\s*cost|cost\s*paid[^.\n]{0,20}?[-−]?(\d+\.\d+)R/gi,
    live: A ? num(A.costR_paid) : null, tol: 0.01 },
  { id: "autopsy.net", desc: "net on the attributed population", volatile: true,
    re: /net\s*of\s*[-−](\d+\.\d+)R/gi,
    live: A ? Math.abs(num(A.attributedR)) : null, tol: 0.01 },
  { id: "autopsy.attributedTrades", desc: "rows carrying a cost estimate", volatile: true,
    re: /(\d{3,4})\s*(?:rows|trades)\s*that\s*carry\s*a\s*cost|on\s*the\s*(\d{3,4})\s*rows\s*that\s*carry/gi,
    live: A ? num(A.attributedTrades) : null, tol: 0 },
  { id: "autopsy.clusteredTrades", desc: "clustered trade count", volatile: true,
    re: /(\d{3,4})\s*of\s*\d{3,4}\s*trades\s*shared\s*an\s*open|clustered[^.\n]{0,20}?(\d{3,4})\s*of\s*\d{3,4}/gi,
    live: autopsy && autopsy.clustering ? num(autopsy.clustering.clusteredTrades) : null, tol: 0 },
  { id: "autopsy.clusteredR", desc: "R carried by clustered trades", volatile: true,
    re: /carrying\s*[-−](\d+\.\d+)R/gi,
    live: autopsy && autopsy.clustering ? Math.abs(num(autopsy.clustering.clusteredR)) : null, tol: 0.01 },
  { id: "pooling.flagged", desc: "aggregates flagged by the pooling audit", volatile: true,
    re: /flagged\s*\*?\*?(\d+)\s*of\s*\d+\*?\*?|(\d+)\s*of\s*12\s*aggregates/gi,
    live: pooling ? num(pooling.flagged) : null, tol: 0 },
  { id: "registry.total", desc: "registered test count",
    re: /(\d{2,3})\s*registered\s*tests|all\s*(\d{2,3})\s*registered\s*tests/gi,
    live: registry ? [...(registry.tests || []), ...(registry.preregistered || [])].length : null, tol: 0 },
  { id: "ledger.signals", desc: "signals in the canonical clean-era ledger", volatile: true,
    re: /signals\s*n=(\d{3,4})|(\d{3,4})\s*settled\s*signals/gi,
    live: ledger ? ledger.signals.length : null, tol: 0 },
  { id: "risk.grossMin", desc: "minimum gross planned risk %", volatile: true,
    re: /never\s*(?:been\s*)?below\s*(\d+\.\d+)%/gi,
    live: riskRows.length ? Math.min(...riskRows.map((r) => r.gross1RPct)) : null, tol: 0.05 },
  { id: "learner.folds", desc: "graded walk-forward folds", volatile: true,
    re: /(\d+)\s*graded\s*fold|fold\s*count[^.\n]{0,10}?(\d+)/gi,
    live: learner && learner.effectiveN ? num(learner.effectiveN.folds) : null, tol: 0 },
];

// ── scan every prose surface the agents actually read ──────────────────────────────────────────
const targets = [];
const addDir = (dir, pattern) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) addDir(p, pattern);
    else if (pattern.test(e.name)) targets.push(p);
  }
};
addDir(path.join(ROOT, ".claude", "agents"), /\.md$/);
addDir(path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "scheduled-tasks"), /^SKILL\.md$/);

const drifts = [], ok = [];
let numericTokens = 0, coveredTokens = 0;

for (const file of targets) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  numericTokens += (text.match(/[-−+]?\d+(?:\.\d+)?[R%]?/g) || []).length;

  for (const c of CLAIMS) {
    if (c.live === null) continue;
    c.re.lastIndex = 0;
    let m;
    while ((m = c.re.exec(text)) !== null) {
      const raw = m.slice(1).find((x) => x !== undefined);
      if (raw === undefined) continue;
      // A QUOTED figure is not a live claim. Prose that documents a past error — `this line said
      // "never below 30.1%" and was falsified` — must not be flagged as asserting 30.1% today, or
      // the audit punishes exactly the writing that records why a number changed. Caught by this
      // tool flagging its own fix note on the first pass after that fix.
      const span = text.slice(Math.max(0, m.index - 2), m.index + m[0].length + 2);
      if (/["“”'']/.test(span.slice(0, 3)) && /["“”'']/.test(span.slice(-3))) continue;
      coveredTokens++;
      const written = parseFloat(raw);
      const delta = Math.abs(written - c.live);
      const lineNo = text.slice(0, m.index).split(/\r?\n/).length;
      const rec = { claim: c.id, desc: c.desc, file: path.relative(ROOT, file).replace(/\\/g, "/"), line: lineNo,
        written, live: c.live, quoted: m[0].trim().slice(0, 70) };
      if (delta > c.tol) {
        rec.severity = c.volatile ? "VOLATILE" : "WRONG";
        rec.recommendation = c.volatile
          ? "Do not hard-code this — it advances as trades settle. Replace the number with an instruction to read it from the source at run time."
          : "Stale and wrong. Update the number in place.";
        drifts.push(rec);
      } else ok.push(rec);
    }
  }
}

const out = {
  spec: "claim-drift-audit-v1", asOf: new Date().toISOString(),
  filesScanned: targets.length, claimsRegistered: CLAIMS.filter((c) => c.live !== null).length,
  claimsUnresolvable: CLAIMS.filter((c) => c.live === null).map((c) => c.id),
  matchesChecked: drifts.length + ok.length, drifted: drifts.length,
  bySeverity: { WRONG: drifts.filter(d => d.severity === "WRONG").length, VOLATILE: drifts.filter(d => d.severity === "VOLATILE").length },
  drifts,
  coverage: { numericTokensInProse: numericTokens, tokensCoveredByAClaim: coveredTokens,
    note: "Only REGISTERED claims are checked. An uncovered number is not verified — it is unexamined. Adding a claim is four lines in CLAIMS." },
};
writeJsonAtomic(D("claim-drift.json"), out);

console.log(`CLAIM DRIFT AUDIT — ${targets.length} prose files · ${out.claimsRegistered} claims registered · ${out.matchesChecked} figure(s) checked\n`);
if (!drifts.length) console.log("  no registered claim has drifted from its source.");
const wrong = drifts.filter(d => d.severity === "WRONG"), vol = drifts.filter(d => d.severity === "VOLATILE");
console.log(`  WRONG (stale, fix in place): ${wrong.length}      VOLATILE (should not be hard-coded at all): ${vol.length}
`);
for (const d of wrong) {
  console.log(`  WRONG  ${d.claim}  (${d.desc})`);
  console.log(`     ${d.file}:${d.line}`);
  console.log(`     prose says ${d.written} · source says ${d.live}   "${d.quoted}"`);
  console.log("");
}
if (vol.length) {
  const byFile = {};
  for (const d of vol) (byFile[d.file] ||= []).push(d.claim);
  console.log("  VOLATILE — live counters embedded as literals. These were probably right when written");
  console.log("  and will drift again tomorrow. The fix is to stop quoting them, not to update them:");
  for (const [f, ids] of Object.entries(byFile)) console.log(`     ${f}  ->  ${[...new Set(ids)].join(", ")}`);
  console.log("");
}
if (out.claimsUnresolvable.length) console.log(`  unresolvable (source file missing): ${out.claimsUnresolvable.join(", ")}`);
console.log(`  coverage: ${coveredTokens} of ${numericTokens} numeric tokens in scanned prose are covered by a claim.`);
console.log("written: data/claim-drift.json");
process.exit(drifts.length ? 1 : 0);
