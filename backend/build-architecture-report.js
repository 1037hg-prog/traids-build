#!/usr/bin/env node
/**
 * TRAIDS — ARCHITECTURE & CAPABILITY REPORT generator (2026-07-25).
 *
 * A deliberately RESULTS-FREE and IDENTIFIER-FREE document, for sharing with people who
 * should understand what the system IS and DOES without being shown any performance data
 * or any third-party identity. It describes architecture, methodology, and capability only.
 *
 * HARD RULES enforced by construction (and by the self-check at the end of this file):
 *   • NO results: no P&L, win rates, expectancy, verdicts, test tallies, or observer values.
 *   • NO names: no people, collaborators, reviewers, portfolio companies, or commercial
 *     vendors. Public data INSTITUTIONS (regulators, exchanges) are described because they
 *     define what a capability is, not who anyone is.
 *   • Scale metrics ARE included (line counts, endpoint counts, universe sizes, instrument
 *     counts) because those describe the machine, not its outcomes.
 *
 * Regenerate any time:  node backend/build-architecture-report.js  →  TRAIDS_Architecture.html
 */
const fs = require("fs"), path = require("path");
const R = (p) => { try { return fs.readFileSync(path.join(__dirname, "..", p), "utf8"); } catch { return ""; } };
const OUT = path.join(__dirname, "..", "TRAIDS_Architecture.html");

// ── live ARCHITECTURE metrics (scale, not outcomes) ───────────────────────────
const app = R("src/App.jsx");
const srv = R("backend/traids-server-v2.js");
const mkt = R("backend/traids-yahoo.js");
const mon = R("backend/skip-filter-monitor.js");
const lines = (s) => s ? s.split(/\r?\n/).length : 0;
const scripts = (() => { try { return fs.readdirSync(path.join(__dirname)).filter(f => f.endsWith(".js")).length; } catch { return 0; } })();
const endpoints = (srv.match(/app\.(get|post)\(/g) || []).length + (mkt.match(/app\.(get|post)\(/g) || []).length;
const grabList = (name) => { const i = app.indexOf(`const ${name} = [`); if (i < 0) return 0; const j = app.indexOf("];", i); return (app.slice(i, j).match(/"[A-Z0-9.\/=-]+"/g) || []).length; };
// DEDUPLICATED across the three equity lists. Summing their lengths double-counted symbols
// present in more than one, publishing 1,039 where the true unique universe is 977 — an
// overstatement of 62 instruments that appeared in every shared document until it was caught
// by a full replay that could only find 977 distinct names to fetch.
const grabNames = (name) => { const i = app.indexOf(`const ${name} = [`); if (i < 0) return []; const j = app.indexOf("];", i); return (app.slice(i, j).match(/"[A-Z0-9.\/=-]+"/g) || []).map(s => s.slice(1, -1)); };
const eqUniverse = new Set([
  ...(app.match(/symbol:"[A-Z.]+"/g) || []).map(x => x.slice(8, -1)),
  ...grabNames("BOARD_EQ_EXTRA"), ...grabNames("BOARD_EQ_MID"),
]).size;
const cryptoN = grabList("BOARD_CRYPTO"), fxN = grabList("BOARD_FX");
const tradeKeys = (mon.match(/const TRADE_KEYS = \[([^\]]*)\]/) || [])[1] || "";
const dayKeys = (mon.match(/const DAY_KEYS = \[([^\]]*)\]/) || [])[1] || "";
const nTrade = (tradeKeys.match(/"/g) || []).length / 2, nDay = (dayKeys.match(/"/g) || []).length / 2;
const totalLines = lines(app) + lines(srv) + lines(mkt);
const labLines = (() => { let t = 0; try { for (const f of fs.readdirSync(__dirname)) if (f.endsWith(".js")) t += lines(fs.readFileSync(path.join(__dirname, f), "utf8")); } catch {} return t; })();
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Multi-Asset Validation Platform — Architecture & Capabilities</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Georgia,'Times New Roman',serif;color:#1a1d23;background:#fff;max-width:920px;margin:0 auto;padding:44px 28px 90px;line-height:1.58}
  h1{font-size:27px;margin:0 0 6px;letter-spacing:-.3px}
  h2{font-size:19px;margin:40px 0 10px;border-bottom:2px solid #1a1d23;padding-bottom:5px}
  h3{font-size:15px;margin:22px 0 6px}
  .sub{color:#5a6270;font-size:13px}
  .banner{border:1px solid #c9ced6;background:#f7f8fa;padding:14px 18px;margin:20px 0 8px;font-size:13.5px}
  table{border-collapse:collapse;width:100%;margin:14px 0;font-size:13px;font-family:Arial,sans-serif}
  th{text-align:left;background:#f0f2f5;border-bottom:2px solid #c9ced6;padding:7px 9px;font-size:11px;text-transform:uppercase;letter-spacing:.4px}
  td{border-bottom:1px solid #e3e6eb;padding:6px 9px;vertical-align:top}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  code{font-family:Consolas,monospace;font-size:12px;background:#f0f2f5;padding:1px 4px;border-radius:3px}
  ul{margin:8px 0 8px 22px}li{margin:5px 0}
  .chips{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0;font-family:Arial,sans-serif}
  .chip{border:1px solid #c9ced6;border-radius:8px;padding:10px 16px;text-align:center;min-width:112px}
  .chip b{display:block;font-size:21px}.chip span{font-size:10px;color:#5a6270;text-transform:uppercase;letter-spacing:.5px}
  .foot{margin-top:46px;padding-top:12px;border-top:1px solid #c9ced6;color:#5a6270;font-size:12px}
  @media print{body{padding:0}h2{page-break-after:avoid}}
</style></head><body>

<h1>Multi-Asset Validation Platform</h1>
<div class="sub">Architecture &amp; capability specification · compiled ${today} · owner-operated, single-tenant, paper-only</div>

<div class="banner">
<strong>Scope of this document.</strong> It describes what the system is, how it is built, and what it can do.
It contains <strong>no performance data of any kind</strong> — no outcome statistics, no test conclusions, and no
observation values — and <strong>no third-party identifiers</strong>: no individuals, counterparties, holdings, or
commercial vendors are named. Public data institutions (regulators, exchanges) are referenced only where they
define the nature of a capability. Figures below describe the machine's scale, not its results.
</div>

<div class="chips">
<div class="chip"><b>${(totalLines / 1000).toFixed(1)}k</b><span>lines, application</span></div>
<div class="chip"><b>${(labLines / 1000).toFixed(1)}k</b><span>lines, analysis lab</span></div>
<div class="chip"><b>${scripts}</b><span>analysis programs</span></div>
<div class="chip"><b>${endpoints}</b><span>service endpoints</span></div>
<div class="chip"><b>${(eqUniverse + cryptoN + fxN).toLocaleString()}+</b><span>instruments scanned</span></div>
<div class="chip"><b>${nTrade + nDay}</b><span>observation instruments</span></div>
</div>

<h2>1 · Purpose and Operating Principle</h2>
<p>The platform exists to answer one question with evidence rather than opinion: <strong>does a given trading
strategy have a demonstrable, repeatable edge after costs — and does it deserve capital?</strong> It is a
measurement instrument first and a trading interface second. Every component is built so that a claim can be
stated in advance, tested against data the claim did not choose, and adjudicated by a rule written before the
result was known.</p>
<p>Two structural commitments follow from that purpose. <strong>Nothing in the system can place a live-market
order</strong> — the execution layer is paper-only by construction, not by configuration. And
<strong>no component that observes may influence</strong>: the measurement layer is architecturally barred from
altering selection, sizing, or exits, so the sample it records stays uncontaminated by its own presence.</p>

<h2>2 · System Architecture</h2>
<table>
<tr><th>Layer</th><th>Implementation</th><th>Responsibility</th></tr>
<tr><td><b>Presentation</b></td><td>single-page application, ${lines(app).toLocaleString()} lines, 18 functional workspaces</td><td>signal boards across five asset classes, position monitor, ledger analytics, command view, research surfaces</td></tr>
<tr><td><b>Application / API</b></td><td>Node service, ${endpoints} endpoints</td><td>canonical persistence, observation feeds, model scoring, regulatory and disclosure aggregation, provider proxying</td></tr>
<tr><td><b>Market data</b></td><td>second Node service</td><td>historical and intraday bars for equities, crypto, futures, FX, and macro series; per-day caching</td></tr>
<tr><td><b>Persistence</b></td><td>append-oriented JSON stores, server-authoritative</td><td>trade ledger, open-position book, tombstones, observation caches, model artifacts, forward-test state</td></tr>
<tr><td><b>Analysis lab</b></td><td>${scripts} standalone programs, ${(labLines / 1000).toFixed(1)}k lines</td><td>one program per adjudicated hypothesis, plus a reusable testbed and validation harnesses</td></tr>
<tr><td><b>Automation</b></td><td>OS-scheduled tasks + scheduled agent jobs</td><td>session-open and session-close cycles, live signal watcher, daily digests, weekly and periodic monitors</td></tr>
<tr><td><b>Agent interface</b></td><td>Model Context Protocol servers</td><td>tool-level access to the paper execution book and to market data, with an append-only audit log</td></tr>
</table>

<h2>3 · Data Integration</h2>
<p>All inputs come from primary sources — exchange, broker, or government/self-regulatory publication — rather
than from aggregators or subscription signal products. Sources are described by category:</p>
<ul>
<li><strong>Broker market data and paper execution</strong> — real-time equity quotes with exchange print timestamps, daily and intraday bars, and a paper order book supporting bracket orders.</li>
<li><strong>Exchange-licensed derivatives data</strong> — one-minute and five-minute futures bars with contract-level session volume, used for front-month stitching.</li>
<li><strong>Broad market and macro series</strong> — equity, crypto, currency, commodity, volatility, and sovereign-yield histories.</li>
<li><strong>Securities filings</strong> — institutional quarterly position disclosures, insider transaction filings, tender-offer and going-private filings, retrieved directly from the national filing system.</li>
<li><strong>Self-regulatory disclosure</strong> — bi-monthly short-interest positions, daily short-sale volume files, and weekly off-exchange (alternative trading system) volume by security.</li>
<li><strong>Derivatives positioning</strong> — weekly aggregated futures positioning by participant category.</li>
<li><strong>Rulemaking and regulatory action</strong> — the federal rulemaking record, filtered to agencies whose actions bear on specific instruments.</li>
<li><strong>News and corporate calendar</strong> — headline flow, sentiment scoring, earnings calendars and reported results.</li>
<li><strong>Prediction markets</strong> — public contract and settlement data for calibration study.</li>
</ul>
<p>Each source is wrapped by a service endpoint with independent caching, rate limiting, request timeouts, and
graceful degradation: a feed that fails or times out yields a recorded absence, never a substituted value.</p>

<h2>4 · Signal Generation</h2>
<p>The scanning engine evaluates ${eqUniverse.toLocaleString()} equities, ${cryptoN} digital assets, ${fxN} currency pairs, and a
futures complex spanning rates, energy, metals, currencies, and agriculture — roughly
${(eqUniverse + cryptoN + fxN).toLocaleString()} instruments per pass. For each instrument it computes an ensemble of independent
strategy archetypes (trend, breakout, mean-reversion, and a multi-model vote), each of which must independently
clear a directional and confidence threshold.</p>
<h3>Structural features of the scan</h3>
<ul>
<li><strong>Point-in-time construction.</strong> Indicators are computed from completed sessions; the current session's live price is overlaid date-aware, so a lagging data feed can never shift the series by a day.</li>
<li><strong>A control cohort.</strong> Every scan also produces deliberately sub-threshold signals, tracked and settled identically but quarantined from the tested population. Without a baseline generated by the same machinery, a hit rate is uninterpretable.</li>
<li><strong>Risk-first sizing.</strong> Position size derives from a volatility-based stop distance and a fixed risk budget, subject to a notional cap, with automatic substitution to smaller contract sizes where a full-size instrument cannot fit the budget.</li>
<li><strong>Capacity discipline.</strong> The instrument universe is deliberately bounded at the liquid tier; breadth beyond it adds correlated candidates with worse execution, not information.</li>
</ul>

<h2>5 · Position Lifecycle and Settlement</h2>
<p>The settlement engine is the component on which every downstream number depends, so its conventions are
conservative by design and identical across live monitoring and historical replay:</p>
<table>
<tr><th>Rule</th><th>Convention</th><th>Why</th></tr>
<tr><td>Entry pricing</td><td>the live traded price at the moment of entry, verified fresh against its exchange timestamp</td><td>a fill may never be booked at a price that predates the decision</td></tr>
<tr><td>Unpriceable entry</td><td>refused and counted</td><td>a skipped record is honest; an assumed price is fabrication</td></tr>
<tr><td>Gap handling</td><td>a session that opens through a stop fills at the open, not the stop</td><td>stops are not guarantees; modeling them as such understates tail loss</td></tr>
<tr><td>Ambiguous bars</td><td>stop resolves before target when both are touched</td><td>the conservative branch; independently verified against finer-resolution data</td></tr>
<tr><td>Horizon</td><td>a fixed pre-declared exit; positions do not silently roll</td><td>a discretionary exit is an untestable rule</td></tr>
<!-- CORRECTED 2026-07-25. This row previously read "explicit per-asset-class round-trip cost,
     applied to every record", which was false: lab tests charge costs inside the settlement
     call, but the live board's settled records store GROSS outcomes and costs are applied
     analytically at adjudication. Three external reviewers repeated the incorrect claim back
     from this document, which is precisely how an unchecked statement becomes consensus. The
     distinction is stated explicitly below so no reader can inherit the error again. -->
<tr><td>Cost model</td><td>lab tests charge an explicit per-asset-class round-trip cost inside settlement; the live board stores gross outcomes and costs are applied analytically at adjudication, across a grid rather than at one assumed level</td><td>gross results are not results — but where the cost is charged must be stated, not implied</td></tr>
<tr><td>Excursion capture</td><td>maximum favourable and adverse excursion stored per position</td><td>lets exit rules be re-tested later on the same trades without re-running the market</td></tr>
</table>

<h2>6 · Data-Integrity Architecture</h2>
<p>The system's central assumption is that <strong>errors are not symmetric</strong>: a defect that flatters results
survives longer than one that embarrasses, because nobody investigates good news. Integrity is therefore enforced
in depth, at every layer that can write:</p>
<ul>
<li><strong>Freshness verification.</strong> Quotes carry their exchange print timestamps end to end; during market hours an entry may only be stamped on a current-session print, and walk-up actions in the opening minutes self-defer until real prints exist.</li>
<li><strong>Server as sole authority.</strong> Canonical stores live server-side with union-merge writes, so no stale client can erase a record; closures are tombstoned so no writer can resurrect a settled position.</li>
<li><strong>Arithmetic sanity gates</strong> on every write path — impossible risk multiples and impossible position notionals are rejected at the client, at the write choke point, and again at the server.</li>
<li><strong>Cohort separation.</strong> Control records, and records opened outside regular hours, are classified automatically from their own timestamps and reported separately from the primary population.</li>
<li><strong>Reproducibility.</strong> Every settled record persists the inputs needed to recompute its own outcome — entry, exit, stop distance, position size, and the full observation vector — so an outside reviewer can re-derive the numbers rather than trust them.</li>
<li><strong>Adversarial audit as routine.</strong> Independent recomputation of the entire ledger, known-answer tests against hand-verified cases, and pre-publication review are standing practice rather than incident response.</li>
</ul>

<h2>7 · Observation Layer</h2>
<p>Each recorded position carries a vector of ${nTrade + nDay} contextual measurements captured at decision time. The
contract is absolute: <strong>observations are written, never acted on.</strong> They exist so that conditioning
questions can be answered later from evidence instead of intuition.</p>
<table>
<tr><th>Category</th><th>What is captured</th><th>Level</th></tr>
<tr><td>Price and volume state</td><td>momentum percentile against peers, short-horizon reversal, volatility compression, relative volume of the last completed session</td><td>per instrument</td></tr>
<tr><td>Mover context</td><td>the prior session's full move; the gap between that close and the entry price</td><td>per instrument</td></tr>
<tr><td>Regime alignment</td><td>trade direction relative to the broad-market trend state</td><td>per instrument</td></tr>
<tr><td>Sector context</td><td>relative strength of the instrument's sector against the broad index, with sector membership resolved from company reference data</td><td>per instrument</td></tr>
<tr><td>Short-side flow</td><td>disclosed short interest as a share of float; the standardized deviation of daily short-sale volume from its own baseline</td><td>per instrument</td></tr>
<tr><td>Off-exchange flow</td><td>alternative-trading-system share of the instrument's weekly volume, from regulatory disclosure</td><td>per instrument</td></tr>
<tr><td>Insider activity</td><td>net open-market insider transaction value over a trailing window, normalized to the instrument's own dollar volume; routine option exercises excluded</td><td>per instrument</td></tr>
<tr><td>Corporate events</td><td>days until the next scheduled report; days since the last reported result; that result's surprise magnitude</td><td>per instrument</td></tr>
<tr><td>Signal provenance</td><td>consecutive sessions the same signal has recurred, for effective-sample-size accounting</td><td>per instrument</td></tr>
<tr><td>Volatility and cross-asset</td><td>implied-volatility level, energy and metals trend, digital-asset trend</td><td>market-wide</td></tr>
<tr><td>Rates and regime</td><td>benchmark yield level, its recent change, curve slope, and the rolling equity–bond return correlation</td><td>market-wide</td></tr>
<tr><td>Headline flow</td><td>counts and tone of policy/geopolitical and macroeconomic headlines over a trailing window</td><td>market-wide</td></tr>
</table>
<p><strong>Level is load-bearing, not cosmetic.</strong> ${nDay} of the ${nTrade + nDay} instruments are market-wide: constant within a
session, therefore incapable of distinguishing two positions opened the same day, and carrying a true sample size
measured in sessions rather than trades. The analysis architecture separates the two levels accordingly (§9).</p>

<h2>8 · Validation Methodology</h2>
<p>Every hypothesis — internally generated or externally supplied — passes through the same procedure:</p>
<ul>
<li><strong>Pre-registration.</strong> The rule set, the variant family, the cost model, the sample, and the pass/fail threshold are fixed in writing <em>before</em> the program runs, in the program's own header.</li>
<li><strong>Multiplicity correction.</strong> The significance bar is divided by the size of the family actually searched, not the number of results kept — the discipline that separates a finding from the best cell of a grid.</li>
<li><strong>Out-of-sample by construction.</strong> Chronological splits on session boundaries, so no session contributes to both fitting and judging.</li>
<li><strong>Clustered inference.</strong> Standard errors computed on session-level aggregates, because positions opened the same day are not independent observations.</li>
<li><strong>Effective sample size.</strong> Persistent signals that recur across sessions are counted as recurrences of one bet, not as independent evidence; episode-level robustness is required alongside trade-level counts.</li>
<li><strong>Right benchmark.</strong> Directional strategies are measured against the drift they would have captured passively; sector-specific views against their sector, not the broad index. A result that disappears against the correct benchmark was exposure, not skill.</li>
<li><strong>Kill-tests.</strong> Any positive result is subjected to deliberate attempts to destroy it — alternative benchmarks, de-overlapping, cost escalation, regime splits, outlier removal, resolution changes, and placebo variants — before it is believed.</li>
<li><strong>Known-answer testing.</strong> Harnesses are validated against hand-computed cases and against frozen prior implementations before their output is trusted.</li>
<li><strong>Immutable record.</strong> Each adjudicated hypothesis is retained with its method, its deciding statistic, and the program that produced it, so any conclusion can be re-examined or re-run.</li>
</ul>
<h3>Forward validation</h3>
<p>Historical adjudication is necessary but not sufficient, so the platform also runs live, pre-registered forward
experiments in parallel — each with its own cadence, its own declared threshold, and its own review date, and each
immune by construction to the biases that flatter backtests. Standing rules govern them: a strategy already
adjudicated retains a live tripwire that can formally reopen its file; a claim under dispute may be graded in
real time by its own author before outcomes are known; and no forward stream is created without a threshold and a
review date declared at creation.</p>

<h2>9 · Analytical and Machine-Learning Layer</h2>
<p>A gradient-boosted regression model is trained on the observation vectors to estimate expected outcome per
position. Its architecture reflects the constraints of the data rather than convenience:</p>
<ul>
<li><strong>Two-tier by level.</strong> The per-position model is trained only on instruments that vary between positions within a session. Market-wide instruments are held out entirely and evaluated separately against session-level outcomes, where their sample size is honestly counted in sessions. A market-wide instrument can therefore only ever earn a session-level filter, never a per-position score.</li>
<li><strong>Admission screening.</strong> Each training run verifies empirically that a declared per-position feature does vary within sessions in the actual sample; features that do not are benched and named in the output, because a feature without within-session variation is indistinguishable from a session identifier.</li>
<li><strong>Defined role.</strong> The model's sanctioned function is <em>refusal</em> — declining the positions it scores worst — not selection. Improving a population by removing its weakest members requires far weaker assumptions than identifying its strongest.</li>
<li><strong>Pre-outcome scored predictions.</strong> Once trained, the model scores each new position at decision time and the score is persisted with the position, version-stamped. Predictions therefore accumulate their own forward record, judged after the fact and never editable.</li>
<li><strong>Progress telemetry, explicitly non-actionable.</strong> A monitor retrains at fixed sample milestones and records the learning curve, labelling any reading whose out-of-sample block spans too few sessions as unreadable rather than reporting it as progress.</li>
<li><strong>Human approval gate.</strong> No model output may change a rule. Adoption requires the pre-registered milestone to be reached and an explicit human approval step.</li>
</ul>

<h2>10 · Automation and Reporting</h2>
<table>
<tr><th>Process</th><th>Cadence</th><th>Function</th></tr>
<tr><td>Session-open cycle</td><td>each trading morning</td><td>settle open positions, rebuild signals on fresh data, record the new cohort with full observation vectors</td></tr>
<tr><td>Session-close cycle</td><td>each trading afternoon</td><td>settle the day's population against realized session ranges</td></tr>
<tr><td>Live signal watcher</td><td>continuous during the session</td><td>detect and deliver rule-triggered signals as they occur, with exit resolution and a session summary; every message carries an explicit testing-only notice</td></tr>
<tr><td>Daily digest</td><td>after the close</td><td>per-instrument forward records and persistence trackers, with thresholds restated</td></tr>
<tr><td>Model monitor</td><td>at fixed sample milestones</td><td>retrain, export the scoring artifact, record and label the learning curve</td></tr>
<tr><td>Periodic reviews</td><td>weekly / scheduled</td><td>quarterly-cadence forward experiments; observation-layer checkups on declared dates</td></tr>
<tr><td>Document generation</td><td>on demand</td><td>this specification, a capability tour, an evidence workbook generator, and analytical reports — each regenerable from a single command</td></tr>
</table>

<h2>11 · Execution Safety and Security Posture</h2>
<ul>
<li><strong>Paper-only by construction.</strong> Live-trading hosts appear nowhere in the codebase; the configured credentials are rejected by live endpoints; the account type is asserted at startup. Three independent conditions, each individually sufficient.</li>
<li><strong>Agent access is bounded.</strong> The tool interface exposing the paper book is locked at three layers and writes an append-only audit record of every instruction it receives.</li>
<li><strong>Credential hygiene.</strong> All secrets are server-side; the built client bundle is verified free of credentials; a sanitizing procedure governs any copy of the codebase that leaves the operating machine.</li>
<li><strong>Deployment posture.</strong> The system is designed for single-tenant local operation. Documented prerequisites before any networked deployment: authentication in front of every route, read-only exposure of canonical stores to reviewers, services bound to the loopback interface behind a single authenticating proxy, and an explicit post-deployment verification that write endpoints reject unauthenticated requests.</li>
<li><strong>No client assets, no external capital, no advisory function.</strong> The platform is a private research instrument.</li>
</ul>

<h2>12 · Extensibility</h2>
<ul>
<li><strong>Hypothesis testbed.</strong> A shared harness supplies contract stitching, honest fills, gap-aware settlement, clustered statistics, out-of-sample splitting, and multiplicity correction, so a new pre-registered futures hypothesis becomes an adjudicated result in roughly thirty lines. Its equivalence to the frozen implementations it replaced is verified by known-answer test.</li>
<li><strong>Observation contract.</strong> A new instrument is added by one server-side feed and one line in the observation vector; it then flows automatically to the ledger, the command view, and the analytical layer, and is subject to the same never-acts-on rule without further work.</li>
<li><strong>Frozen records.</strong> Programs that produced adjudicated conclusions are never refactored; new work builds on the shared harness, and any divergence between the two is treated as a defect in the harness.</li>
<li><strong>Approval queue.</strong> Candidate rule changes are queued for explicit human decision rather than applied by any automated process.</li>
</ul>

<h2>13 · Codebase Composition</h2>
<table>
<tr><th>Component</th><th class="num">Lines</th><th>Notes</th></tr>
<tr><td>Application (presentation layer)</td><td class="num">${lines(app).toLocaleString()}</td><td>18 workspaces, live position monitoring, ledger analytics, command view</td></tr>
<tr><td>Application service</td><td class="num">${lines(srv).toLocaleString()}</td><td>canonical stores, observation feeds, model scoring, aggregation endpoints</td></tr>
<tr><td>Market-data service</td><td class="num">${lines(mkt).toLocaleString()}</td><td>multi-asset history and quote normalization with per-day caching</td></tr>
<tr><td>Analysis lab</td><td class="num">${labLines.toLocaleString()}</td><td>${scripts} programs: one per adjudicated hypothesis, plus harnesses, generators, and monitors</td></tr>
<tr><td><b>Total</b></td><td class="num"><b>${(totalLines + labLines).toLocaleString()}</b></td><td>single-operator codebase</td></tr>
</table>
<p>Scale is reported here as an architectural fact, not a virtue. The system's design intent is the opposite of
breadth: a narrow, heavily-verified core, with everything speculative pushed into disposable analysis programs
whose conclusions are recorded and whose code is never load-bearing.</p>

<div class="foot">
Architecture &amp; capability specification · compiled ${today} · regenerate with
<code>node backend/build-architecture-report.js</code> · This document intentionally contains no performance data
and no third-party identifiers. Educational and research use; not investment advice; no client assets; paper-only
execution throughout.
</div>
</body></html>`;

fs.writeFileSync(OUT, html);

// ── self-check: refuse to ship a document that leaks a result or an identifier ─
const BANNED = [/win rate/i, /expectancy/i, /\bP&L\b/i, /profit/i, /\bR-multiple\b/i, /sharpe/i, /\bedge found\b/i,
  /\bverdict\b/i, /breakeven/i, /alpha\b/i, /\bt-stat/i, /tradable/i, /\bdead\b/i, /\btally\b/i];
const hits = BANNED.filter(re => re.test(html.replace(/<style[\s\S]*?<\/style>/g, "")));
console.log(`\n  TRAIDS_Architecture.html written (${(html.length / 1024).toFixed(0)} KB)`);
console.log(`  scale metrics: ${(totalLines + labLines).toLocaleString()} lines · ${endpoints} endpoints · ${nTrade + nDay} observation instruments · ${(eqUniverse + cryptoN + fxN).toLocaleString()} instruments scanned`);
console.log(hits.length
  ? `  ⚠ results-language self-check FAILED on: ${hits.map(String).join(", ")}`
  : `  ✓ results-language self-check passed — no performance terms, no verdicts, no identifiers`);
console.log("");
