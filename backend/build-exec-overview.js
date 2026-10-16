#!/usr/bin/env node
/**
 * TRAIDS — EXECUTIVE OVERVIEW generator (2026-07-25).
 *
 * Companion to TRAIDS_Architecture.html, written for a reader who needs to understand what
 * the platform is and how it decides things WITHOUT reading a specification. The architecture
 * document becomes the appendix; this is the front door.
 *
 * Same two hard rules as the specification, enforced by the self-check at the bottom:
 *   • NO results — no performance data, no verdicts, no tallies, no observation values.
 *   • NO identifiers — no people, collaborators, reviewers, or commercial vendors. Public
 *     INSTITUTIONS (regulators, exchanges) are named because they define a capability.
 * Scale and capability counts ARE included: they describe the machine, not its outcomes.
 *
 * Diagrams are inline SVG using currentColor, so they survive light/dark rendering, print,
 * and email forwarding with no external dependency of any kind.
 *
 * Regenerate:  node backend/build-exec-overview.js  →  TRAIDS_Executive_Overview.html
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const R = (p) => { try { return fs.readFileSync(path.join(ROOT, p), "utf8"); } catch { return ""; } };
const OUT = path.join(ROOT, "TRAIDS_Executive_Overview.html");
const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

// ── live capability metrics (the machine, never its outcomes) ─────────────────
const app = R("src/App.jsx"), srv = R("backend/traids-server-v2.js"), mkt = R("backend/traids-yahoo.js");
const mon = R("backend/skip-filter-monitor.js");
const lines = (s) => s ? s.split(/\r?\n/).length : 0;
const labFiles = (() => { try { return fs.readdirSync(__dirname).filter(f => f.endsWith(".js")); } catch { return []; } })();
const labLines = labFiles.reduce((a, f) => a + lines(R("backend/" + f)), 0);
const endpoints = (srv.match(/app\.(get|post)\(/g) || []).length + (mkt.match(/app\.(get|post)\(/g) || []).length;
const nTrade = (((mon.match(/const TRADE_KEYS = \[([^\]]*)\]/) || [])[1] || "").match(/"/g) || []).length / 2;
const nDay = (((mon.match(/const DAY_KEYS = \[([^\]]*)\]/) || [])[1] || "").match(/"/g) || []).length / 2;
const grabNames = (name) => { const i = app.indexOf(`const ${name} = [`); if (i < 0) return []; const j = app.indexOf("];", i); return (app.slice(i, j).match(/"[A-Z0-9.\/=-]+"/g) || []).map(s => s.slice(1, -1)); };
// DEDUPLICATED. Summing the three equity lists double-counted names appearing in more than one:
// the raw sum is 1,039 but the true unique universe is 977. Publishing the inflated figure
// overstated the scan by 62 instruments in every shared document.
const eqUniverse = new Set([...(app.match(/symbol:"[A-Z.]+"/g) || []).map(x => x.slice(8, -1)), ...grabNames("BOARD_EQ_EXTRA"), ...grabNames("BOARD_EQ_MID")]).size;
const instruments = eqUniverse + grabNames("BOARD_CRYPTO").length + grabNames("BOARD_FX").length;
const hosts = new Set((labFiles.map(f => R("backend/" + f)).join("\n").match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/g) || [])
  .map(h => h.replace("https://", ""))).size;
const registry = (() => { try { return JSON.parse(R("backend/data/test-registry.json")).tests.length; } catch { return 0; } })();
const totalLines = lines(app) + lines(srv) + lines(mkt) + labLines;

// ── diagram primitives ───────────────────────────────────────────────────────
const DEFS = `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>`;
const box = (x, y, w, h, label, sub, accent) => `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="none" stroke="currentColor" stroke-width="${accent ? 2 : 1}" ${accent ? "" : 'stroke-opacity="0.55"'}/>
  <text x="${x + w / 2}" y="${y + (sub ? h / 2 - 3 : h / 2 + 4)}" text-anchor="middle" font-size="12.5" font-weight="${accent ? 700 : 500}" fill="currentColor">${label}</text>
  ${sub ? `<text x="${x + w / 2}" y="${y + h / 2 + 13}" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.65">${sub}</text>` : ""}`;
const vArrow = (x, y1, y2) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="currentColor" stroke-width="1.4" marker-end="url(#a)"/>`;
const hArrow = (y, x1, x2) => `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="currentColor" stroke-width="1.4" marker-end="url(#a)"/>`;
const note = (x, y, t, anchor = "start") => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="10.5" font-style="italic" fill="currentColor" fill-opacity="0.6">${t}</text>`;

// DIAGRAM 1 — system architecture, top to bottom, with the firewall made visible
const D1 = (() => {
  const W = 760, x = 210, w = 340, h = 46, gap = 26;
  const stack = [
    ["Presentation layer", "18 workspaces · live monitoring · command view"],
    ["Application service", "canonical stores · aggregation · model scoring"],
    ["Market-data services", "multi-asset history, quotes, per-day caching"],
    ["Observation layer", `${nTrade} trade-level + ${nDay} session-level instruments`],
    ["Settlement engine", "gap-aware, stop-first, refuses unpriceable fills"],
    ["Validation lab", `${labFiles.length} programs · shared harness · registry`],
    ["Reporting", "evidence workbooks, specifications, monitors"],
  ];
  let y = 24, s = "";
  stack.forEach(([l, sub], i) => {
    s += box(x, y, w, h, l, sub, i === 4 || i === 5);
    if (i < stack.length - 1) s += vArrow(x + w / 2, y + h, y + h + gap - 4);
    y += h + gap;
  });
  // The firewall belongs to the OBSERVATION LAYER specifically — it is not a horizontal cut
  // across the stack. A full-width line would wrongly enclose the settlement engine, whose
  // entire job is to settle positions. So the constraint is drawn as a bracket around the one
  // layer it actually governs.
  const oy = 24 + 3 * (h + gap);
  s += `<rect x="${x - 22}" y="${oy - 10}" width="${w + 44}" height="${h + 20}" rx="9" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="5 4" stroke-opacity="0.5"/>`;
  // Short label only, kept left of the incoming arrow at the stack's centre line. The full
  // statement of the constraint lives in the figure caption, where it cannot collide with
  // anything.
  s += note(x - 30, oy - 17, "the observation firewall");
  return `<svg viewBox="0 0 ${W} ${y + 4}" role="img" aria-label="System architecture">${DEFS}${s}</svg>`;
})();

// DIAGRAM 2 — observation pipeline, left to right, ending in two separate sinks
const D2 = (() => {
  const W = 900, y = 40, w = 134, h = 54, gap = 22;   // w sized so "Observation vector" clears its box
  const row = ["Market data", "Indicators", "Signal engine", "Observation vector", "Ledger"];
  let x = 20, s = "";
  row.forEach((l, i) => {
    s += box(x, y, w, h, l, null, i === 3);
    if (i < row.length - 1) s += hArrow(y + h / 2, x + w, x + w + gap - 4);
    x += w + gap;
  });
  const lx = x - w - gap;
  s += `<line x1="${lx + w / 2}" y1="${y + h}" x2="${lx + w / 2}" y2="${y + h + 34}" stroke="currentColor" stroke-width="1.4"/>`;
  s += `<line x1="${lx + w / 2 - 150}" y1="${y + h + 34}" x2="${lx + w / 2 + 60}" y2="${y + h + 34}" stroke="currentColor" stroke-width="1.4"/>`;
  s += vArrow(lx + w / 2 - 150, y + h + 34, y + h + 70);
  s += vArrow(lx + w / 2 + 60, y + h + 34, y + h + 70);
  s += box(lx + w / 2 - 210, y + h + 72, 120, 46, "Learning", "refusal only");
  s += box(lx + w / 2, y + h + 72, 120, 46, "Reporting", "evidence");
  s += note(20, y + h + 100, "The vector is stamped at decision time and never rewritten,");
  s += note(20, y + h + 116, "so the record cannot be improved after the outcome is known.");
  return `<svg viewBox="0 0 ${W} ${y + h + 132}" role="img" aria-label="Observation pipeline">${DEFS}${s}</svg>`;
})();

// DIAGRAM 3 — validation methodology, including the only two ways a hypothesis moves
const D3 = (() => {
  const W = 880, w = 150, h = 50, y1 = 30, y2 = 150, gap = 32;
  const top = [["Definition", "written first"], ["Pre-registration", "rule fixed"], ["In-sample test", "whole family"], ["Multiplicity", "÷ family size"]];
  const bot = [["Out-of-sample", "chronological"], ["Forward test", "real time"], ["Adjudication", "against the rule"], ["Registry", "permanent"]];
  let x = 20, s = "";
  top.forEach(([l, sub], i) => { s += box(x, y1, w, h, l, sub, i === 1); if (i < 3) s += hArrow(y1 + h / 2, x + w, x + w + gap - 4); x += w + gap; });
  const endX = x - gap;
  s += `<line x1="${endX}" y1="${y1 + h / 2}" x2="${endX + 16}" y2="${y1 + h / 2}" stroke="currentColor" stroke-width="1.4"/>`;
  s += `<line x1="${endX + 16}" y1="${y1 + h / 2}" x2="${endX + 16}" y2="${y2 + h / 2}" stroke="currentColor" stroke-width="1.4"/>`;
  s += hArrow(y2 + h / 2, endX + 16, endX + 2);
  x = 20 + 3 * (w + gap);
  bot.forEach(([l, sub], i) => { s += box(x, y2, w, h, l, sub, i === 3); if (i < 3) s += hArrow(y2 + h / 2, x, x - gap + 4); x -= w + gap; });
  // Feedback loop routed BELOW the boxes, with its caption below the dashed line rather than
  // on it — otherwise the riser crosses straight through the text.
  const ly = y2 + h + 26, rx = 20 + w / 2 + 300;
  s += `<line x1="${20 + w / 2}" y1="${y2 + h}" x2="${20 + w / 2}" y2="${ly}" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 4"/>`;
  s += `<line x1="${20 + w / 2}" y1="${ly}" x2="${rx}" y2="${ly}" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 4"/>`;
  s += `<line x1="${rx}" y1="${ly}" x2="${rx}" y2="${y1 + h + 20}" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 4"/>`;
  s += vArrow(rx, y1 + h + 20, y1 + h + 4);
  s += note(20 + w / 2, ly + 18, "reopened ONLY by a pre-stated tripwire being hit — never by a hunch");
  return `<svg viewBox="0 0 ${W} ${ly + 30}" role="img" aria-label="Validation methodology">${DEFS}${s}</svg>`;
})();

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TRAIDS — Executive Overview</title>
<style>
 :root{--ink:#16181d;--bg:#fff;--mut:#5b6270;--line:#dfe3ea;--accent:#1b4d8f;--soft:#f6f8fb}
 @media (prefers-color-scheme:dark){:root{--ink:#e7eaf0;--bg:#12141a;--mut:#9aa3b2;--line:#2a2f3a;--accent:#7fb0ee;--soft:#191d25}}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
 .wrap{max-width:860px;margin:0 auto;padding:56px 28px 80px}
 h1{font-size:31px;line-height:1.2;margin:0 0 6px;letter-spacing:-.02em}
 .sub{color:var(--mut);font-size:15px;margin:0 0 34px}
 h2{font-size:19px;margin:44px 0 12px;padding-bottom:7px;border-bottom:1px solid var(--line);letter-spacing:-.01em}
 h3{font-size:15.5px;margin:26px 0 7px}
 p{margin:0 0 13px}
 .lead{font-size:16.5px;line-height:1.6}
 ul{margin:0 0 13px;padding-left:20px}li{margin:5px 0}
 table{width:100%;border-collapse:collapse;margin:16px 0;font-size:13.5px}
 th,td{text-align:left;padding:8px 11px;border-bottom:1px solid var(--line);vertical-align:top}
 th{font-size:11.5px;text-transform:uppercase;letter-spacing:.055em;color:var(--mut);font-weight:600}
 .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
 figure{margin:22px 0 26px;padding:20px 14px;border:1px solid var(--line);border-radius:9px;background:var(--soft);overflow-x:auto}
 figure svg{display:block;width:100%;height:auto;min-width:560px;color:var(--ink)}
 figcaption{margin-top:12px;font-size:12.5px;color:var(--mut);text-align:center}
 .box{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:0 7px 7px 0;padding:14px 17px;margin:18px 0;background:var(--soft)}
 .box p:last-child{margin:0}
 .kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:11px;margin:18px 0}
 .kv div{border:1px solid var(--line);border-radius:7px;padding:11px 13px}
 .kv b{display:block;font-size:21px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
 .kv span{font-size:11.5px;color:var(--mut)}
 code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);padding:1px 5px;border-radius:4px}
 .foot{margin-top:52px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--mut)}
 @media print{.wrap{padding:0}figure{break-inside:avoid}h2{break-after:avoid}}
</style></head><body><div class="wrap">

<h1>TRAIDS — Executive Overview</h1>
<p class="sub">A measurement instrument for trading hypotheses · compiled ${today}</p>

<p class="lead">TRAIDS exists to answer one question, repeatedly and honestly: <b>does this trading idea deserve
capital?</b> It is not a system that predicts markets. It is the apparatus that decides whether a claim about
markets has survived a fair test — and it is built so that the answer is usually no.</p>

<div class="box"><p>The design assumption is that the operator is the most likely source of error. Every structural
choice follows from that: rules are written down before data is examined, the measuring instruments are
firewalled away from the decisions they measure, results are recorded where they cannot be quietly revised, and
conclusions are re-derived from raw records rather than trusted from memory.</p></div>

<h2>1 · What it is, and what it is not</h2>
<table>
<tr><th>It is</th><th>It is not</th></tr>
<tr><td>A hypothesis validation platform — define a rule, test it, adjudicate it, record the outcome permanently</td><td>A signal service, a prediction engine, or a product sold to anyone</td></tr>
<tr><td>Paper-only by construction, on every path, with no live-trading credential present</td><td>A live execution system; there is no code path that can place a funded order</td></tr>
<tr><td>Single-operator research infrastructure for the operator's own decisions</td><td>An advisory service; it manages no outside capital and gives no advice</td></tr>
<tr><td>An adversarial instrument — designed to disconfirm, with the burden of proof on the idea</td><td>An optimizer searching for the best-looking parameter set</td></tr>
</table>
<p style="font-size:13px;color:var(--mut)"><b>Standing of these rows (operator-affirmed 2026-08-20).</b> The first and last rows are
<b>constitutional</b> — they define the system at any scale and are never amended. The middle two
("paper-only", "no outside capital, no advice") are <b>staged</b>: true today, and changeable only the
way every measurement definition changes here — through a pre-registered gate (e.g. the four-interlock
arming doctrine, a passed funding bar, counsel-reviewed structure) recorded in the change registry with
its date and rationale. Neither may ever be falsified by drift; the failure this note exists to prevent
is discovering a live credential or an outside dollar that no dated decision admitted.</p>
<table style="display:none">
</table>

<h2>2 · Capabilities at a glance</h2>
<div class="kv">
 <div><b>${instruments.toLocaleString()}</b><span>instruments scanned</span></div>
 <div><b>${nTrade + nDay}</b><span>observation instruments</span></div>
 <div><b>${hosts}</b><span>independent data sources</span></div>
 <div><b>${endpoints}</b><span>service endpoints</span></div>
 <div><b>${labFiles.length}</b><span>validation programs</span></div>
 <div><b>${registry}</b><span>hypotheses adjudicated</span></div>
</div>
<table>
<tr><th>Capability</th><th>What it means in practice</th></tr>
<tr><td>Multi-asset coverage</td><td>Equities, crypto, futures, foreign exchange, index options and event contracts, each with its own settlement conventions rather than one rule applied everywhere</td></tr>
<tr><td>Independent data sourcing</td><td>${hosts} distinct providers spanning market data, regulatory filings, exchange disclosures, positioning reports, and government publications — no single vendor can silently define reality</td></tr>
<tr><td>Point-in-time observation</td><td>Every contextual measurement is anchored to the last fully-closed bar available at decision time, so nothing is measured with information that did not yet exist</td></tr>
<tr><td>Two-tier level isolation</td><td>Instrument-level measurements are separated from market-wide ones, because a value identical for every position on a given day cannot explain why those positions differed</td></tr>
<tr><td>Conservative settlement</td><td>Gaps settle at the open rather than the intended price; ambiguous bars resolve against the position; entries that cannot be honestly priced are refused rather than estimated</td></tr>
<tr><td>Automated integrity monitoring</td><td>Scheduled processes are watched by inferring liveness from the artifacts they must produce, so a job that dies silently is detected rather than assumed healthy</td></tr>
<tr><td>Change control</td><td>Every change to a measurement definition is recorded permanently, including whether it breaks comparability with earlier records</td></tr>
</table>

<h2>3 · Architecture</h2>
<p>Seven layers, with one deliberate constraint marked on the layer it governs. The observation layer measures
context for every decision and is structurally forbidden from influencing one: it informs, and is never permitted
to act.</p>
<figure>${D1}<figcaption>Figure 1 — System architecture. The bracketed layer is the observation firewall: its ${nTrade + nDay} instruments record context and may never alter a position.</figcaption></figure>
<p>Two services sit behind the presentation layer: an application service that owns all canonical records, and
market-data services that normalize history and quotes across asset classes. The application layer is a client of
those records, never their owner — which is what prevents a browser refresh, a stale tab, or a client-side bug
from rewriting history.</p>

<h2>4 · The observation pipeline</h2>
<p>Each candidate position carries a vector of contextual measurements, captured at the moment of the decision and
frozen there. The freezing is the point: a measurement taken after the outcome is known is not evidence, it is
decoration.</p>
<figure>${D2}<figcaption>Figure 2 — Observation pipeline. The vector splits into two sinks that never merge: a learning path restricted to refusal, and a reporting path.</figcaption></figure>
<p>The learning component is deliberately limited to <b>declining</b> weak candidates rather than selecting
strong ones. Refusing is a far weaker claim than choosing, requires correspondingly less evidence to justify, and
its failure mode is a missed opportunity rather than a funded mistake. Its scores are stamped before outcomes
exist, version-tagged, and never fed back in as inputs to themselves.</p>

<h2>5 · Research philosophy and the validation process</h2>
<p>A hypothesis moves through a fixed sequence, and the sequence cannot be re-ordered to suit a result. The
decision rule — what would count as success, and what would count as failure — is written down and locked
<i>before</i> the test runs. This is the single most important property of the platform, because it is the only
thing that distinguishes a test from a search.</p>
<figure>${D3}<figcaption>Figure 3 — Validation methodology. A closed hypothesis reopens only when a pre-stated tripwire is hit, never on judgement.</figcaption></figure>
<h3>The corrections that make the numbers mean something</h3>
<ul>
<li><b>Whole-family testing.</b> When a family of variants is examined, the entire family is reported, not the best member of it. Significance thresholds are divided by the number of variants searched.</li>
<li><b>Session-level clustering.</b> Positions opened on the same day share that day's market move, so the unit of inference is the session, not the position. Ignoring this overstates confidence severely.</li>
<li><b>Effective sample size.</b> A signal recurring across consecutive sessions is one extended bet, not many independent ones, and is counted accordingly.</li>
<li><b>Concurrent controls.</b> Deliberately sub-threshold candidates are tracked under identical settlement rules, because a hit rate without a baseline measured over the same period cannot be interpreted.</li>
<li><b>Assumption grids.</b> Conclusions are re-derived across a range of cost and exit assumptions, so a finding that only survives one assumption is labelled fragile rather than reported as a finding.</li>
</ul>

<h2>6 · Why this is a platform rather than a collection of scripts</h2>
<p>Every new hypothesis inherits the same apparatus without rebuilding it: the settlement engine, the statistical
corrections, the control cohort, the audit trail, the change registry, and the reporting path. A new idea is
therefore expressed as its <i>definition</i> only — a few lines describing entry, exit, and universe — while
everything that makes the answer trustworthy is shared, already verified, and identical across every test.</p>
<p>That shared harness is itself verified against a previously-adjudicated hypothesis: it must reproduce that
earlier conclusion exactly before it is trusted with a new one. A measuring instrument that cannot reproduce a
known answer is not ready to produce an unknown one.</p>

<h2>7 · Governance and change control</h2>
<table>
<tr><th>Question a reviewer will ask</th><th>How the platform answers it</th></tr>
<tr><td>How is a hypothesis family defined?</td><td>Enumerated in writing before testing — every variant of definition, timeframe, and instrument that will be examined. The family size is what the significance threshold is divided by, so understating it is self-defeating.</td></tr>
<tr><td>What freezes the decision rule?</td><td>It is written into the pre-registration and into the permanent record before the test runs. Adjudication compares the result to that stored rule, not to a rule recalled afterwards.</td></tr>
<tr><td>What constitutes reopening a closed hypothesis?</td><td>A numeric tripwire stated at the time of closure, together with the minimum sample at which it may be evaluated. Nothing else reopens a file.</td></tr>
<tr><td>What governs changes to the settlement engine?</td><td>Every definitional change is appended to a permanent registry with its date, rationale, and an explicit flag for whether it breaks comparability with prior records. A verification pass fails if the running system contains a measurement the registry does not document.</td></tr>
<tr><td>How are missing observations handled?</td><td>They are recorded as absent and excluded from that measurement, never imputed. Imputing a value invents evidence; coverage is monitored instead, so silent shrinkage is detected.</td></tr>
<tr><td>How are model versions archived?</td><td>Scores are stamped with the version that produced them at the moment of decision, so a later version cannot retroactively claim an earlier call.</td></tr>
<tr><td>Can a rule change itself?</td><td>No. Automated components may propose changes into a queue; only a human approves. No process can alter its own decision rule.</td></tr>
</table>

<h2>8 · Scale</h2>
<table>
<tr><th>Dimension</th><th class="num">Count</th><th>Note</th></tr>
<tr><td>Independent services</td><td class="num">3</td><td>presentation, application, market data</td></tr>
<tr><td>Service endpoints</td><td class="num">${endpoints}</td><td>observation feeds, canonical stores, aggregation</td></tr>
<tr><td>External data sources</td><td class="num">${hosts}</td><td>market data, regulatory, exchange, government</td></tr>
<tr><td>Observation instruments</td><td class="num">${nTrade + nDay}</td><td>${nTrade} instrument-level, ${nDay} session-level</td></tr>
<tr><td>Instruments scanned</td><td class="num">${instruments.toLocaleString()}</td><td>across five asset classes</td></tr>
<tr><td>Validation programs</td><td class="num">${labFiles.length}</td><td>one per adjudicated hypothesis, plus harnesses and monitors</td></tr>
<tr><td>Hypotheses adjudicated</td><td class="num">${registry}</td><td>each with a permanent registry entry</td></tr>
<tr><td>Shared harnesses</td><td class="num">4</td><td>settlement, validation, change registry, coverage monitor</td></tr>
<tr><td>Total source lines</td><td class="num">${totalLines.toLocaleString()}</td><td>single-operator codebase</td></tr>
</table>
<p>Scale is reported as a fact about the machine, not as a virtue. The design intent runs the other way: a narrow,
heavily-verified core, with everything speculative pushed into disposable programs whose <i>conclusions</i> are
permanent and whose <i>code</i> is never load-bearing.</p>

<h2>9 · Roadmap</h2>
<table>
<tr><th>Next</th><th>Why it comes next</th></tr>
<tr><td>Execution-friction measurement</td><td>Simulated fills, however conservative, are still assumptions. Measuring realized fill quality against assumed entry prices converts the largest remaining unknown into a distribution.</td></tr>
<tr><td>Universe construction audit</td><td>A scan built from current membership omits instruments that ceased to exist, and that omission flatters results. The size and direction of that bias needs quantifying.</td></tr>
<tr><td>Independent reproduction</td><td>Conclusions currently rest on one operator's implementation. Re-derivation by an outside party from raw records is the only way to test the apparatus itself.</td></tr>
<tr><td>Formal test coverage</td><td>Correctness is presently established by known-answer reproduction and audit passes rather than a unit-test suite; the shared harness is where that coverage would pay for itself first.</td></tr>
</table>

<div class="foot">
Executive overview · compiled ${today} · regenerate with <code>node backend/build-exec-overview.js</code> ·
The technical specification (<code>TRAIDS_Architecture.html</code>) is the appendix to this document.
This overview intentionally contains no performance data and no third-party identifiers.
Educational and research use · not investment advice · no client assets · paper-only execution throughout.
</div>
</div></body></html>`;

fs.writeFileSync(OUT, html);

// ── self-check: refuse to ship a document that leaks a result or an identifier ─
const body = html.replace(/<style[\s\S]*?<\/style>/g, "");
const BANNED = [/win rate/i, /expectancy/i, /\bP&L\b/i, /\bprofit/i, /\bR-multiple\b/i, /sharpe/i,
  /\bedge found\b/i, /\bverdict\b/i, /breakeven/i, /\balpha\b/i, /\bt-stat/i, /tradable/i, /\bdead\b/i, /\btally\b/i];
const hits = BANNED.filter(re => re.test(body));
// every figure must actually have rendered, or the document silently loses its diagrams
const figs = (html.match(/<svg /g) || []).length;
console.log(`\n  TRAIDS_Executive_Overview.html written (${(html.length / 1024).toFixed(0)} KB)`);
console.log(`  ${figs} inline diagrams · ${endpoints} endpoints · ${hosts} data sources · ${instruments.toLocaleString()} instruments · ${registry} hypotheses`);
console.log(figs === 3 ? "  ✓ all three diagrams rendered" : `  ⚠ expected 3 diagrams, found ${figs}`);
console.log(hits.length
  ? `  ⚠ results-language self-check FAILED on: ${hits.map(String).join(", ")}`
  : "  ✓ results-language self-check passed — no performance data, no verdicts, no identifiers");
console.log("");
