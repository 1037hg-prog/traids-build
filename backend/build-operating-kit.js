#!/usr/bin/env node
/**
 * TRAIDS — OPERATING KIT generator (2026-07-25).
 *
 * Two working documents aimed at the one risk every external review of this platform has
 * independently identified: not that the apparatus is badly built, but that the OPERATOR
 * relaxes its standards under the pressure of wanting a result. Architecture cannot fix that.
 * A checklist and a template can make the relaxation visible at the moment it happens.
 *
 *   1. TRAIDS_Daily_Checklist.html  — one printable page, the daily cadence
 *   2. TRAIDS_Prereg_Template.md    — the header that must exist before a test runs
 *
 * DELIBERATE OMISSIONS. An external reviewer proposed a daily cadence containing three
 * recommendations that this system's own evidence does not support, and they are excluded
 * rather than quietly included because they sounded sensible:
 *   • "Restrict attention to the highest-confidence signals (90–95%+)." The confidence score
 *     has NOT been shown to separate outcomes in this ledger. Acting on it would be trading a
 *     number the platform has not validated, inside a checklist whose purpose is discipline.
 *   • "Respect the 1% risk rule." Never established here; sizing is a declared test parameter,
 *     not a house rule, and inventing one in an operating document would give it false standing.
 *   • "Run the AI assessment panel on the top candidates" as a decision input. The panel is an
 *     unvalidated commentary layer. Using it to choose trades would breach the same firewall
 *     the observation layer respects.
 * Each is listed in the checklist's own "not in this checklist, and why" section, because a
 * silent omission is indistinguishable from an oversight.
 *
 * Regenerate:  node backend/build-operating-kit.js
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const rd = (p, fb) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); } catch { return fb; } };
const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
const reg = rd("backend/data/test-registry.json", { tests: [] });
const nextTestNo = (reg.tests || []).reduce((m, t) => Math.max(m, t.n || 0), 0) + 1;

// ── 1 · DAILY CHECKLIST ──────────────────────────────────────────────────────
const item = (t, why) => `<li><span class="box"></span><div><b>${t}</b>${why ? `<em>${why}</em>` : ""}</div></li>`;

const checklist = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TRAIDS — Daily Operating Checklist</title>
<style>
 :root{--ink:#16181d;--bg:#fff;--mut:#5b6270;--line:#d8dde5;--accent:#1b4d8f;--soft:#f6f8fb;--stop:#a3242b}
 @media (prefers-color-scheme:dark){:root{--ink:#e7eaf0;--bg:#12141a;--mut:#9aa3b2;--line:#2a2f3a;--accent:#7fb0ee;--soft:#191d25;--stop:#f08d8d}}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font:13.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
 .wrap{max-width:920px;margin:0 auto;padding:30px 26px 50px}
 h1{font-size:22px;margin:0 0 3px;letter-spacing:-.02em}
 .sub{color:var(--mut);font-size:12.5px;margin:0 0 18px}
 .cols{display:grid;grid-template-columns:1fr 1fr;gap:22px}
 @media (max-width:720px){.cols{grid-template-columns:1fr}}
 h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin:16px 0 7px;padding-bottom:5px;border-bottom:1px solid var(--line)}
 ul{list-style:none;margin:0 0 12px;padding:0}
 li{display:flex;gap:9px;margin:0 0 8px;align-items:flex-start}
 .box{flex:0 0 13px;height:13px;margin-top:2px;border:1.5px solid var(--mut);border-radius:3px}
 li b{font-weight:600;display:block}
 li em{display:block;color:var(--mut);font-size:12px;font-style:normal;margin-top:1px}
 .stop{border:1px solid var(--line);border-left:3px solid var(--stop);border-radius:0 6px 6px 0;padding:11px 14px;margin:14px 0;background:var(--soft)}
 .stop b{color:var(--stop)}
 .stop ul{margin:7px 0 0}
 .stop li{margin-bottom:5px}
 .note{border:1px solid var(--line);border-radius:6px;padding:11px 14px;margin:14px 0;background:var(--soft);font-size:12.5px;color:var(--mut)}
 .note b{color:var(--ink)}
 .foot{margin-top:26px;padding-top:11px;border-top:1px solid var(--line);font-size:11.5px;color:var(--mut)}
 @media print{.wrap{padding:0;max-width:100%}body{font-size:11.5px}.cols{gap:16px}h1{font-size:19px}}
</style></head><body><div class="wrap">

<h1>Daily Operating Checklist</h1>
<p class="sub">The platform is a measurement instrument. Your contribution is discipline, not discretion. · ${today}</p>

<div class="note"><b>Most of this now runs itself.</b> <code>backend/daily-ops.js</code> executes every item that can be
checked against data, and four scheduled tasks run it pre-market, midday, at the close, and weekly. It exits
non-zero when something needs you, and appends every run to <code>ops-history.jsonl</code> — so a day nobody
reviewed cannot be mistaken for a clean one. Three classes of item behave differently: <b>mechanized</b> checks
pass or fail on their own; <b>invariant</b> checks fingerprint the records and detect a later change rather than
asking you to remember not to make one; <b>assembled</b> items still need your judgement, and the runner verifies
only that the artifact exists. This page is the reference for what is being checked and why — read it once, then
let the runner do it. The items it cannot automate are named at the foot of every run.</div>

<div class="cols"><div>

<h2>Pre-market</h2>
<ul>
${item("Confirm the coverage monitor is green", "node backend/coverage-monitor.js — it exits non-zero if a feed died or an instrument stopped recording. A red monitor means today's data is not yet trustworthy.")}
${item("Wait for the market to settle before reading the board", "Signals pulled before the open are built on stale prints. Give it 5–10 minutes after the open.")}
${item("Write down, before tracking, which signals you will track and why", "The written note is what makes a later review possible. Deciding first and recording afterwards is not a record.")}
${item("Note the near-threshold signals you did NOT track", "These are the control cohort's reason for existing. Without them the hit rate has no baseline.")}
${item("Check any forward experiment reaching its declared review date", "A review date that passes unexamined is how a forward test quietly becomes a permanent hope.")}
</ul>

<h2>During the session</h2>
<ul>
${item("Enter only at a live, timestamp-verified price", "The system refuses unpriceable entries by design. Do not supply a price to get past a refusal.")}
${item("Do not move a stop, target, or size on an open position", "Any change makes the record untestable — the trade no longer measures the rule it was opened under.")}
${item("Use the live watcher for monitoring only", "Watching is not a reason to intervene. If the rule is wrong, change the rule tomorrow, in writing, not the position now.")}
${item("Record unusual conditions the instruments do not capture", "Halts, feed outages, and unusual session structure explain outliers later; unwritten context is lost within a day.")}
</ul>

</div><div>

<h2>After the close</h2>
<ul>
${item("Let the session-close cycle settle the day", "Manual settlement bypasses gap handling and the stop-first convention, which is where honesty lives.")}
${item("Read the digest; change nothing in response to it", "The digest is a report, not a prompt. Reacting to one day's outcome is the fastest route to a fitted system.")}
${item("Never re-label or reclassify a settled record", "Moving a trade between the signal and control populations after the outcome is known invalidates both.")}
${item("Confirm the day's records carry their observation vectors", "A settled trade without its context is a number with no explanatory power — permanently.")}
</ul>

<h2>Weekly and periodic</h2>
<ul>
${item("Run the scheduled monitors on their declared dates", "Not when convenient. A checkup moved to a better week is a checkup selected on its result.")}
${item("Review every open forward experiment against its threshold", "Compare to the number that was written down, not to the number that would be encouraging.")}
${item("Close a file that fails its threshold", "Formally, in the registry. &ldquo;Give it more time&rdquo; is the single most expensive sentence available to you.")}
${item("Re-derive any conclusion approaching a capital decision", "From raw records, with the cost grid, not from a remembered summary.")}
</ul>

<div class="stop"><b>Stop immediately if any of these is true</b>
<ul>
<li><span class="box"></span><div>You are about to change a rule while a position is open.</div></li>
<li><span class="box"></span><div>You are looking for a reason to keep a hypothesis that failed its stated threshold.</div></li>
<li><span class="box"></span><div>You are reporting a number you have not re-derived from raw records.</div></li>
<li><span class="box"></span><div>You are about to size a position on a conclusion the ledger has not established.</div></li>
</ul>
</div>

</div></div>

<div class="note"><b>Not in this checklist, and why.</b> Three plausible-sounding recommendations were deliberately
excluded because this system's own evidence does not support them. <b>Confidence-band filtering</b> (trade only
90–95%+): the confidence score has not been shown to separate outcomes in this ledger, so filtering on it would
mean acting on an unvalidated number. <b>A fixed 1% risk rule</b>: never established here — sizing is a declared
test parameter, and inventing a house rule in an operating document would give it standing it has not earned.
<b>The AI assessment panel as a trade-selection input</b>: it is an unvalidated commentary layer, and using it to
choose positions would breach the same firewall the observation layer respects. Each may be adopted later — through
pre-registration, like anything else.</div>

<div class="foot">Regenerate with <code>node backend/build-operating-kit.js</code> · Paper-only throughout · not investment advice</div>
</div></body></html>`;

fs.writeFileSync(path.join(ROOT, "TRAIDS_Daily_Checklist.html"), checklist);

// ── 2 · PRE-REGISTRATION TEMPLATE ────────────────────────────────────────────
const prereg = `# TRAIDS — Pre-Registration Header

Copy this block into the top of a new analysis program **before writing any test code, and
before looking at any result**. The header is the test's contract with its future self: it is
what makes the difference between a test and a search.

The next unused registry number is **#${nextTestNo}**.

## The rule

A test may run only once every field below is filled in. If a field cannot be filled, the
hypothesis is not yet specific enough to test — that is information, not an obstacle.

Nothing in a filled header may be edited after the first run. If something must change, the
test is abandoned and re-registered under a new number, with the abandoned one kept and the
reason recorded. A header that changes to fit its result is not a pre-registration.

\`\`\`js
/**
 * TEST #${nextTestNo} — <one-line claim, stated so it can be WRONG>
 *
 * PRE-REGISTERED <YYYY-MM-DD>, before any result was examined.
 *
 * HYPOTHESIS
 *   <The claim in one sentence. State the direction and the mechanism. "X predicts Y" is
 *   testable; "X is useful" is not.>
 *
 * WHY IT MIGHT BE TRUE
 *   <The economic or structural reason. A pattern with no mechanism is a coincidence that has
 *   not yet been caught. Write this before testing so you cannot invent it afterwards.>
 *
 * VARIANT FAMILY  (size: N)
 *   <EVERY variant that will be examined — each definition, timeframe, instrument, parameter
 *   value. This number divides the significance threshold, so understating it is
 *   self-defeating: it buys an easier bar and a worthless result.>
 *
 * DATA
 *   Source:        <feed, and whether it is point-in-time>
 *   Universe:      <instruments, and what is EXCLUDED — exclusions are where bias hides>
 *   Period:        <start to end>
 *   In-sample:     <chronological first portion>
 *   Out-of-sample: <chronological remainder — split on session boundaries, never shuffled>
 *
 * COST MODEL
 *   <Explicit per-round-trip cost, per asset class. Then state the BREAKEVEN cost: the level
 *   at which the conclusion would flip. A conclusion that survives only at one assumed cost
 *   is fragile and must be labelled fragile.>
 *
 * SETTLEMENT
 *   Entry:     <exact bar and price convention>
 *   Stop:      <placement rule, and the minimum-distance floor>
 *   Target:    <placement rule>
 *   Ambiguity: <stop-first unless verified on finer data>
 *   Gaps:      <settle at the open, flagged>
 *   Horizon:   <fixed, pre-declared; no silent rolling>
 *
 * INFERENCE
 *   Statistic:      <the ONE number that decides this>
 *   Clustering:     day-level (positions opened the same session are not independent)
 *   Effective N:    <how recurring signals are collapsed into single bets>
 *   Multiplicity:   threshold / <family size>
 *   Benchmark:      <what the strategy must BEAT — passive drift, sector, or control cohort>
 *
 * DECISION RULE  — written before the result exists, and quoted verbatim at adjudication
 *   PASS if:   <specific numeric condition, including out-of-sample>
 *   FAIL if:   <specific numeric condition>
 *   If neither: NOT-ESTABLISHED. This is a real outcome, not a reason to keep testing.
 *
 * KILL-TESTS  — to be run on a PASS, before it is believed
 *   <alternative benchmark · de-overlapping · cost escalation · regime split · outlier
 *   removal · resolution change · placebo variant — list the ones that apply and why>
 *
 * REOPEN TRIPWIRE  — required for a FAIL, so the file stays falsifiable
 *   <the numeric condition and the minimum sample at which it may be evaluated. Nothing else
 *   reopens the file: not a good week, not a persuasive argument, not intuition.>
 *
 * KNOWN-ANSWER CHECK
 *   <the hand-computed case or frozen prior implementation this harness must reproduce before
 *   its output on new data is trusted>
 */
\`\`\`

## After the run

1. Record the outcome in \`backend/data/test-registry.json\` — the claim, the deciding
   statistic, the verdict against the stored rule, and the program that produced it.
2. Log any definitional change in \`backend/change-registry.js\`, flagged if it breaks
   comparability with earlier records.
3. On a FAIL, wire the forward tracker so the tripwire can actually fire. A tripwire nobody
   measures is decoration.
4. Re-derive the deciding statistic from raw records before it informs any capital decision.

## The failure this template exists to prevent

Every field above is a degree of freedom that, left open until after the result is known,
converts a test into a search for something that looks like a finding. The family size, the
sample split, the cost assumption, and the decision rule are the four that do the most damage,
because each can be adjusted very slightly, with an entirely reasonable justification, in the
direction of a more encouraging answer.

Write them down first. Then the answer is whatever it is.
`;

fs.writeFileSync(path.join(ROOT, "TRAIDS_Prereg_Template.md"), prereg);

// ── self-check ───────────────────────────────────────────────────────────────
// The excluded recommendations must be NAMED in the checklist. A silent omission is
// indistinguishable from an oversight, and the whole point is that the reader can see the call.
const mustName = [/confidence/i, /1% risk/i, /assessment panel/i];
const missing = mustName.filter(re => !re.test(checklist));
console.log(`\n  TRAIDS_Daily_Checklist.html   written (${(checklist.length / 1024).toFixed(0)} KB, one printable page)`);
console.log(`  TRAIDS_Prereg_Template.md     written (${(prereg.length / 1024).toFixed(0)} KB, next registry number #${nextTestNo})`);
console.log(missing.length
  ? `  ⚠ excluded-recommendation disclosure MISSING for: ${missing.map(String).join(", ")}`
  : "  ✓ all three excluded recommendations are named and justified in the document");
console.log("");
