/**
 * THE FORTNIGHTLY READ — everything, once every two weeks, for a decision. (2026-09-09)
 *
 * Operator: "read everything every two weeks and add it to the progress report to make a decision on."
 *
 * WHY A CADENCE RATHER THAN NIGHTLY. The nightly report answers "did today go well". This answers a
 * different question — "has anything changed that should move the standing decision" — and that
 * question has no useful daily answer. A registered test moves at the speed of its own accrual; on
 * this board the whole-book detection floor needs roughly 39 more sessions, so checking it every
 * night invites reading noise as news. Fourteen days is long enough that something can actually have
 * happened and short enough that a KILL or a READ cannot sit unnoticed for a month.
 *
 * WHAT IT READS
 *   data/adjudicator.json   the house's own verdict per registered test (READY / WAIT / FROZEN /
 *                           MANUAL / sealed reads). This file already answers "what is decidable",
 *                           so the digest AGGREGATES it rather than re-deriving it — one source.
 *   data/test-registry.json read conditions and evidence starts.
 *   each test's own output   to catch the thing the adjudicator structurally cannot see: a test that
 *                           is nominally ACCRUING while its writer has stopped. A starved test looks
 *                           identical to a patient one from the registry alone, and this shop has
 *                           already lost weeks that way — the seat wave, the funding-carry collector,
 *                           and 48 of 50 agent seats all died quietly with their entries intact.
 *
 * WHAT IT WILL NOT DO. It does not adjudicate. Reading a test at its bar is a sealed ritual with its
 * own script and its own record; this digest points at what is ready and stops there. It also states
 * the standing decision rather than recomputing it, so the digest cannot become a second, softer
 * place where the capital question gets answered.
 *
 * Usage: require("./progress-fortnight.js").build()   — returns {html, line, due}
 *        node backend/progress-fortnight.js --force   — print it any day
 */
const fs = require("fs"), path = require("path");

const D = (f) => path.join(__dirname, "data", f);
const rd = (f) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return null; } };
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const ANCHOR = "2026-09-09";                       // fortnight boundaries are anchored, not drifting
const DAY = 86400000;

function isDue(today = etDay(Date.now())) {
  const d = Math.round((Date.parse(today) - Date.parse(ANCHOR)) / DAY);
  return d >= 0 && d % 14 === 0;
}

function build({ force = false } = {}) {
  const today = etDay(Date.now());
  if (!isDue(today) && !force) return { html: "", line: null, due: false };

  const adj = rd("adjudicator.json");
  if (!adj || !Array.isArray(adj.rows)) {
    return { due: true, line: "FORTNIGHTLY READ: adjudicator.json unreadable — the read could not run, which is not the same as nothing being ready.",
      html: `<h2><span>Fortnightly</span>Read everything</h2><p class="sub"><b>COULD NOT RUN.</b> data/adjudicator.json is missing or unreadable, so no verdict is available. That is UNKNOWN, not "nothing is ready".</p>` };
  }
  const adjAgeH = (Date.now() - fs.statSync(D("adjudicator.json")).mtimeMs) / 3600000;

  const reg = rd("test-registry.json") || {};
  const entries = [].concat(...Object.values(reg).filter(Array.isArray)).filter((t) => t && t.id);
  const byId = Object.fromEntries(entries.map((t) => [t.id, t]));

  const bucket = (v) => /READY|READ NOW/i.test(v) ? "READY"
    : /KILL/i.test(v) ? "KILLED"
    : /^MANUAL/i.test(v) ? "MANUAL"
    : /^FROZEN/i.test(v) ? "FROZEN"
    : /READ SEALED|DID NOT PASS|^PASS|INCONCLUSIVE|READ-PARTIAL|SURVIVES|VOID/i.test(v) ? "DECIDED"
    : "WAITING";
  const groups = {};
  for (const r of adj.rows) (groups[bucket(r.verdict)] ||= []).push(r);
  const n = (k) => (groups[k] || []).length;

  /**
   * STARVED — the check the adjudicator cannot make. A test whose registry entry names an output
   * file that has not been written in over a week is not accruing, whatever its status says. This is
   * the single failure mode that has cost this shop the most time, so it leads the digest when it
   * fires and says nothing at all when it does not.
   */
  const starved = [];
  for (const r of groups.WAITING || []) {
    const t = byId[r.id];
    const m = String(t && t.script || "").match(/data\/([\w.-]+\.json)/);
    const f = m ? m[1] : null;
    if (!f) continue;
    try {
      const age = (Date.now() - fs.statSync(D(f)).mtimeMs) / DAY;
      if (age > 7) starved.push({ id: r.id, file: f, days: +age.toFixed(0) });
    } catch { starved.push({ id: r.id, file: f, days: null }); }
  }

  const row = (label, k, note) => `<tr><td class="k">${label}</td><td class="n">${n(k)}</td><td class="note">${note}${n(k) && n(k) <= 12 ? " — " + (groups[k] || []).map((r) => r.id).join(", ") : ""}</td></tr>`;

  // THE CLOCK, from backend/test-triage.js. It answers a different question from the adjudicator:
  // not "is this decidable today" but "will it EVER be, at the rate it is actually accruing".
  const tri = rd("test-triage.json");
  const tc = (tri && tri.counts) || {};
  const cant = (tc["NO WRITER"] || 0) + (tc.STALLED || 0);
  const unreadable = (tc["COUNT NOT EXPOSED"] || 0) + (tc["COUNT AMBIGUOUS"] || 0) + (tc["NO COUNTABLE BAR"] || 0);

  const html = `
  <h2><span>Fortnightly</span>Read everything — the decision page</h2>
  <p class="sub">Every registered test, once a fortnight, for one purpose: <b>has anything changed that should move the
  standing decision?</b> This page points at what is decidable. It does not adjudicate — reading a test at its bar is a
  sealed ritual with its own script and its own record.</p>
  <div class="tablewrap"><table>
    ${row("READY to read now", "READY", "at their bar — these are the only ones decidable today")}
    ${row("Killed at interim", "KILLED", "the bar's early-exit fired")}
    ${row("Already decided", "DECIDED", "read, sealed, or void — no further accrual changes them")}
    ${row("Waiting on accrual", "WAITING", "registered, bar not yet reached")}
    ${row("Frozen", "FROZEN", "superseded or suspended; accruing nothing on purpose")}
    ${row("Manual", "MANUAL", "no countable gate — a human decides when they are ready")}
  </table></div>
  ${tri ? `<div class="tablewrap"><table>
    <tr><td class="k"><b>THE CLOCK — can each test ever reach its bar?</b></td><td class="n"></td><td class="note">at each test's own observed accrual rate since its evidence start</td></tr>
    <tr><td class="k">Reaches its bar within a year</td><td class="n">${tc["ON TRACK"] || 0}</td><td class="note">the only ones on a clock worth waiting on</td></tr>
    <tr><td class="k" style="color:#b42318">Cannot accrue at all</td><td class="n" style="color:#b42318;font-weight:600">${cant}</td><td class="note">${tc["NO WRITER"] || 0} carry a bar and have NO output file; ${tc.STALLED || 0} started and never moved off zero</td></tr>
    <tr><td class="k">Accrual not readable</td><td class="n">${unreadable}</td><td class="note">the artifact exposes no evidence count, or one that outruns the calendar — UNKNOWN, never read as zero</td></tr>
  </table></div>
  <p class="sub">A test with a bar and no writer is not waiting, it is stopped — and it looks identical to a patient one from the registry alone. That distinction is the whole point of this row.</p>` : ""}
  ${starved.length ? `
  <div class="tablewrap"><table>
    <tr><td class="k" style="color:#b42318"><b>STARVED — nominally accruing, writer stopped</b></td><td class="n" style="color:#b42318;font-weight:600">${starved.length}</td><td class="note">A test whose output has not been written in over a week is not accruing, whatever its status says. This is the failure mode that has cost this shop the most time.</td></tr>
    ${starved.map((s) => `<tr><td class="k">${s.id}</td><td class="n">${s.days == null ? "never" : s.days + "d"}</td><td class="note">${s.file}</td></tr>`).join("")}
  </table></div>` : `<p class="sub">No registered test has a stalled writer — every waiting test's output was written within the last week.</p>`}
  <p class="sub"><b>THE STANDING DECISION, unchanged unless something above moves it:</b> no real capital. The whole book is
  <b>−0.063R per ticket net of known cost</b>, session-clustered t −3.5, at a profit factor of <b>0.76</b> — 76 cents back for
  every dollar lost. That is decided, not undecided: the effect is larger than the ±0.056R the apparatus can resolve. What
  would move it is a registered test clearing its own bar, not a better fortnight.
  ${n("READY") === 0 ? "<b>Nothing is ready to read today.</b>" : `<b>${n("READY")} test(s) are at their bar and can be adjudicated now.</b>`}</p>
  <p class="sub">Adjudicator ran ${adjAgeH < 48 ? adjAgeH.toFixed(0) + "h ago" : `<b style="color:#b42318">${(adjAgeH / 24).toFixed(0)} DAYS ago — these verdicts are stale</b>`} over ${adj.rows.length} registered tests. Next fortnightly read: ${etDay(Date.parse(today) + 14 * DAY)}.</p>`;

  const line = `FORTNIGHTLY: ${n("READY")} ready to read · ${n("WAITING")} waiting · ${n("DECIDED")} decided · ${cant} CANNOT ACCRUE · ${starved.length} starved. Standing decision unchanged: no capital (−0.063R net, PF 0.76).`;
  return { html, line, due: true, counts: { ready: n("READY"), waiting: n("WAITING"), decided: n("DECIDED"), frozen: n("FROZEN"), manual: n("MANUAL"), starved: starved.length } };
}

module.exports = { build, isDue };

if (require.main === module) {
  const out = build({ force: process.argv.includes("--force") });
  if (!out.due) { console.log(`  not a fortnight boundary (anchor ${ANCHOR}, every 14 days) — use --force`); process.exit(0); }
  console.log("\n  " + out.line + "\n");
  console.log(out.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1400));
}
