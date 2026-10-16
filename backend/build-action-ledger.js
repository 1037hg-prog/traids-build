#!/usr/bin/env node
/**
 * TRAIDS — ACTION LEDGER: what every test, observer, agent and feed actually CHANGED.
 *
 * WHY THIS REPORT EXISTS. The operator asked the one question nobody had run on this project:
 * "all 50 should prove some action positive or negative." Every other report here answers
 * "what did we learn". None answered "what did we DO about it".
 *
 * The answer turned out to be uncomfortable and is the point of the document: as of 2026-07-27,
 * 47 adjudicated tests and 25 observers had produced exactly ONE change to what the board trades,
 * and that one was made the same day this report was written. Everything else is either a
 * correctly-avoided loss (real value, invisible in the P&L) or a finding sitting in a JSON file
 * that no trading decision reads.
 *
 * HOW "WIRED" IS DETERMINED — mechanically, not by opinion. A finding counts as WIRED only if a
 * code path in the live board reads it and changes selection, sizing, or whether a ticket is
 * opened. The audit for observers is a grep for conditionals that READ obs.*: all 7 hits are
 * assignments (t.obs.x = ...), so no observer gates anything. That is a fact about the source,
 * reproducible by anyone.
 *
 * WHAT "ACTION" MEANS HERE. A negative result is an action, and the largest category. Proving
 * trend-following dead is what stops $25-50k going into trend-following. That value is real and
 * permanently invisible on a P&L statement, which is exactly why it needs its own ledger — a
 * project judged only on realised P&L would conclude 47 tests produced nothing.
 *
 * Usage:  node backend/build-action-ledger.js
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const OUT = path.join(__dirname, "..", "TRAIDS_Action_Ledger.html");
const rd = (f, fb) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return fb; } };
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const reg = rd("test-registry.json", { tests: [], green: [], defended: [], tally: {} });
const defects = rd("defect-log.json", { audits: [] });
const fwd = rd("forward-candidates.json", { candidates: [] });
const SRC = (() => { try { return fs.readFileSync(path.join(__dirname, "..", "src", "App.jsx"), "utf8"); } catch { return ""; } })();

/* ── the wiring audit, computed from source rather than asserted ───────────────
 * reads  = a conditional that BRANCHES on an observer  → would gate a decision
 * writes = an assignment into obs.*                    → recording only
 * If reads is 0, no observer influences any trade, however many are collected. */
const obsWrites = (SRC.match(/\bobs\.[a-zA-Z0-9_]+\s*=/g) || []).length;
const obsReadsInConditionals = (SRC.match(/if \([^)]*\bobs\.[a-zA-Z0-9_]+[^=)]*\)/g) || [])
  .filter(s => !/obs\.[a-zA-Z0-9_]+\s*=[^=]/.test(s)).length;
const gateWired = /const OPTIONS_DEBIT_GATE = true/.test(SRC) && /if \(t\.gated\)/.test(SRC);

/**
 * ACTION CLASSIFICATION. Derived from the registry verdict wherever the verdict determines it,
 * with per-test overrides ONLY where the verdict is ambiguous about what was done. Categories:
 *   AVOIDED       a strategy we would plausibly have traded, proven not to work → we don't
 *   RULE-DECLINED a proposed board rule tested and rejected → board left unchanged, deliberately
 *   WIRED         changed live board behaviour
 *   IDLE          an actionable filter/rule exists and is NOT wired  ← the backlog
 *   COLLECTING    forward evidence accruing against a pre-registered bar
 *   OBSERVER      recorded by design, not intended to gate
 *   CORE          actionable outside the trading board (portfolio-level)
 */
const OVERRIDE = {
  7:  ["WIRED",     "ENFORCED in board selection 2026-07-27: no equity longs when SPY is below its 50-day MA, no shorts when above. On the 6-session forward record this cuts 38% of tickets and moves the board from 48.8% win / −0.0057R / −$1,010 to 52.2% / +0.0012R / −$127. Registry had called it a 200MA filter; the tested period is 50 (defect D17)."],
  18: ["OBSERVER",  "COMPUTED AND FLAGGED, NOT ENFORCED. Its tested spec removed the board's single best cohort on the forward record (+0.1027R, n=32, +$2,735), and its high-vol branch has never fired because all 6 sessions were low-vol. Withheld from enforcement while evidence accrues. Registry had called it a VIX switch; no VIX series is used (defect D18)."],
  22: ["COLLECTING","Structural premium confirmed; retail-net ≈ breakeven with a crash tail. No sleeve opened."],
  24: ["COLLECTING","Premium confirmed (t=8.04). Three harvest attempts (#41–#43) all failed their risk gates."],
  30: ["RULE-DECLINED", "Take-profit at 1R was PROPOSED and tested on 52,325 paired trades: it loses (t=−4.60). Board left to ride. A rule not adopted on evidence is an action."],
  31: ["RULE-DECLINED", "Skip-after-5-day-run-up proposed; wrong sign (+0.0079R). Rule not adopted."],
  33: ["OBSERVER",  "Bias real but priced inside fees. No position; monitored."],
  34: ["COLLECTING","CI contains zero. Wired as observer obs.shortPct only."],
  35: ["OBSERVER",  "Survives correction and OOS but cost-locked at measured 59.4% turnover. Rides as obs.svrZ, alters nothing."],
  36: ["AVOIDED",   "Collaborator's system graded on his own materials before any capital or reliance. Tripwire standing."],
  38: ["COLLECTING","t=1.67 below the t≥2 bar. Forward cohort forming."],
  41: ["WIRED",     "THE ONE. Measured the vol premium accruing to the SELLER; the board was buying it every day. As of 2026-07-27 the options debit gate refuses those tickets on both the automated and manual paths."],
  44: ["OBSERVER",  "Corrected my own 3× overstatement of churn; measured turnover 59.4%, breakeven 9.5bp. Kept as observer."],
  45: ["COLLECTING","91% win, t=3.57 out of sample over 10.5 years. Paper sleeve + forward registry only; strikes are Black-Scholes approximations of contracts never priced."],
  47: ["AVOIDED",   "Filter tested for drawdown reduction and delivered exactly zero. Not adopted — drawdown is a path property."],
};
const classify = (t) => {
  if (OVERRIDE[t.n]) return OVERRIDE[t.n];
  if (/^STAGNANT/.test(t.verdict)) return ["AVOIDED", "Proven not to work. The action is that we do not trade it."];
  if (t.verdict === "REJECTED") return ["RULE-DECLINED", "Proposed rule tested and rejected; board deliberately left unchanged."];
  if (t.verdict === "RISK-FILTER") return ["IDLE", "A usable filter exists and nothing reads it."];
  if (t.verdict === "COST-LOCKED") return ["OBSERVER", "Real but not harvestable after costs."];
  if (t.verdict === "PREMIUM") return ["COLLECTING", "Premium confirmed; no sleeve opened."];
  if (/NO-SKILL|NO-EDGE/.test(t.verdict)) return ["AVOIDED", "Built, measured, found to have no skill. The action is that it does not size trades."];
  return ["COLLECTING", "Evidence accruing against a pre-registered bar."];
};

const rows = reg.tests.map(t => { const [cat, why] = classify(t); return { ...t, cat, why }; });
const CATS = ["WIRED", "IDLE", "RULE-DECLINED", "AVOIDED", "COLLECTING", "OBSERVER", "CORE"];
const count = (c) => rows.filter(r => r.cat === c).length;

const OBSERVERS = [
  ["momPctile", 297, "12-month momentum percentile"], ["revRet5", 297, "5-day reversal return"],
  ["squeeze", 268, "Bollinger/Keltner compression"], ["sigAge", 214, "bars since the signal fired"],
  ["regimeAlign", 181, "is the trade WITH the prevailing regime"], ["rvol", 181, "relative volume"],
  ["vix", 130, "VIX level"], ["oil20", 130, "20-day crude change"], ["gold20", 130, "20-day gold change"],
  ["btc20", 130, "20-day bitcoin change"], ["y10", 130, "10-year yield"], ["y10chg20", 130, "20-day yield change"],
  ["curve", 130, "2s10s slope"], ["polNews", 130, "political news volume"], ["polSent", 130, "political sentiment"],
  ["econNews", 130, "economic news volume"], ["svrZ", 128, "daily short-volume z-score"],
  ["shortPct", 125, "short interest as % of float"], ["econSent", 90, "economic sentiment"],
  ["sbCorr", 71, "stock/bond correlation"], ["sectorRS", 70, "sector relative strength vs SPY"],
  ["erDays", 68, "days to next earnings"], ["newsScore", 66, "headline sentiment"],
  ["atsPct", 47, "dark-pool share of weekly volume"], ["insiderNet90", 18, "net insider buying, 90d"],
];
const AGENTS = [
  ["quant-validator", "Referees any number: sample size, effective-N, multiplicity, IS/OOS, survivorship. Returns REAL SIGNAL / NOISE / BIASED.", "Used on the board replay, pocket sweep, svrZ, 13F — every promotion decision"],
  ["strategy-skeptic", "Red-teams any POSITIVE finding before it is believed.", "Killed the +30%/yr long-leg claim (#28→#29) and the congressional-trade t=12 (#20)"],
  ["data-integrity-auditor", "Survivorship, look-ahead, point-in-time, split/dividend, timezone.", "Found the training-data survivorship (62 delisted), the odd-lot extractor, and the merger-arb population bias"],
  ["backtest-auditor", "Does the harness faithfully replicate the live board? Look-ahead, cost model, settle logic.", "Signal-replay look-ahead audit 400/400; caught the pooled-n tripwire"],
  ["edge-hunter", "Tests ONE pre-registered hypothesis with strict OOS and effective-N. Default conclusion: no edge.", "The disciplined path for #32 pocket sweep and the conditional searches"],
];
const FEEDS = [
  ["Yahoo (:3002)", "daily + intraday bars, 977 instruments", "WIRED — every backtest and the board's own prices"],
  ["Alpaca", "IEX intraday bars, paper execution", "WIRED — board fills, paper OMS"],
  ["Finnhub", "real-time equities, earnings calendar", "WIRED prices · earnings DISPLAY-ONLY"],
  ["Coinbase", "crypto spot", "WIRED — crypto class"],
  ["FINRA", "short interest, daily short volume", "OBSERVER ONLY (obs.shortPct, obs.svrZ)"],
  ["SEC EDGAR", "13F, DEFM14A proxies, odd-lot tenders", "Feeds #38 cohort and the merger-arb watcher"],
  ["Kalshi", "event-contract prices", "Tested (#33), cost-locked, no position"],
  ["Schwab", "option chains", "NOT CONNECTED — OAuth incomplete, blocks VRP chain series"],
  ["AlphaVantage / FRED / newsapi", "macro, sentiment", "OBSERVER ONLY — and 8 of these slots collapse to 1 test (defect D16)"],
];

const openDefects = (defects.audits || []).flatMap(a => (a.defects || []).map(d => ({ ...d, date: a.date })));
const flat = openDefects.filter(d => d.direction === "flattering").length;

const CATCLASS = { WIRED: "good", IDLE: "bad", "RULE-DECLINED": "", AVOIDED: "", COLLECTING: "", OBSERVER: "", CORE: "" };

fs.writeFileSync(OUT, `<!doctype html><meta charset="utf-8"><title>TRAIDS — Action Ledger</title>
<style>
 :root{--ink:#16181d;--bg:#fff;--mut:#5b6270;--line:#dfe3ea;--accent:#1b4d8f;--soft:#f6f8fb;--good:#146c43;--bad:#a3242b}
 @media (prefers-color-scheme:dark){:root{--ink:#e7eaf0;--bg:#12141a;--mut:#9aa3b2;--line:#2a2f3a;--accent:#7fb0ee;--soft:#191d25;--good:#4ade80;--bad:#f08d8d}}
 :root[data-theme="dark"]{--ink:#e7eaf0;--bg:#12141a;--mut:#9aa3b2;--line:#2a2f3a;--accent:#7fb0ee;--soft:#191d25;--good:#4ade80;--bad:#f08d8d}
 :root[data-theme="light"]{--ink:#16181d;--bg:#fff;--mut:#5b6270;--line:#dfe3ea;--accent:#1b4d8f;--soft:#f6f8fb;--good:#146c43;--bad:#a3242b}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
 .wrap{max-width:1000px;margin:0 auto;padding:52px 26px 80px}
 h1{font-size:31px;margin:0 0 6px;letter-spacing:-.02em}
 .sub{color:var(--mut);font-size:15px;margin:0 0 30px}
 h2{font-size:20px;margin:48px 0 12px;padding-bottom:7px;border-bottom:1px solid var(--line)}
 p{margin:0 0 13px} ul{margin:0 0 13px;padding-left:20px} li{margin:5px 0}
 .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
 table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13px;min-width:640px}
 th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
 th{font-size:11px;text-transform:uppercase;letter-spacing:.055em;color:var(--mut);font-weight:600;position:sticky;top:0;background:var(--bg)}
 .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
 .good{color:var(--good);font-weight:700}.bad{color:var(--bad);font-weight:700}
 .box{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:0 7px 7px 0;padding:14px 17px;margin:18px 0;background:var(--soft)}
 .box p:last-child{margin:0} .warn{border-left-color:var(--bad)}
 .kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:11px;margin:18px 0}
 .kv div{border:1px solid var(--line);border-radius:7px;padding:11px 13px}
 .kv b{display:block;font-size:25px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
 .kv span{font-size:11.5px;color:var(--mut)}
 code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);padding:1px 5px;border-radius:4px}
 .tag{font-size:10px;font-weight:700;letter-spacing:.04em;padding:2px 6px;border-radius:3px;border:1px solid var(--line);white-space:nowrap}
 .foot{margin-top:50px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--mut)}
</style><div class="wrap">
<h1>Action Ledger</h1>
<p class="sub">Every test, observer, agent and feed &mdash; and what each one actually <em>changed</em>. ${reg.asOf || "2026-07-27"}</p>

<div class="box warn"><p><b>The finding this report was built to produce.</b> 47 adjudicated tests, 25 observers, 5 audit agents and
~17 data feeds have between them produced <b>one</b> change to what the board trades &mdash; and that one was made
the day this report was written. Every observer is write-only: the source contains <b>${obsWrites} assignments</b> into
<code>obs.*</code> and <b>${obsReadsInConditionals} conditionals that branch on one</b>. The apparatus has been measuring
the trading without being connected to it.</p></div>

<div class="kv">
<div><b class="${count("WIRED") ? "good" : "bad"}">${count("WIRED")}</b><span>findings WIRED to live behaviour</span></div>
<div><b class="bad">${count("IDLE")}</b><span>actionable and NOT wired</span></div>
<div><b>${count("AVOIDED")}</b><span>losses avoided (real, invisible in P&amp;L)</span></div>
<div><b>${count("COLLECTING")}</b><span>evidence still accruing</span></div>
<div><b>${OBSERVERS.length}</b><span>observers, ${obsReadsInConditionals} of which gate anything</span></div>
<div><b>${openDefects.length}</b><span>defects logged (${flat} flattering)</span></div>
</div>

<h2>1 &middot; What a "negative" test is worth</h2>
<p>Most of this ledger is negative results, and that is not a failure of the ledger. Proving trend-following dead is
what stops $25&ndash;50k going into trend-following. Declining the collaborator's Apex evaluation, the $197&ndash;447/mo
QuantVue subscription, and the Agent&nbsp;M waitlist are all cash not spent. <b>None of that value can ever appear on a
P&amp;L statement</b> &mdash; which is precisely why it needs its own record. A project judged only on realised P&amp;L would
conclude these 47 tests produced nothing, and would be wrong.</p>
<p>What the ledger <em>does</em> expose is the opposite problem: findings that should have changed behaviour and didn't.
Those are the ${count("IDLE")} rows marked <span class="tag bad">IDLE</span> below, and they are the actual backlog.</p>

<h2>2 &middot; All ${rows.length} tests, by action taken</h2>
<div class="scroll"><table><tr><th>#</th><th>Test</th><th>Verdict</th><th>Action</th><th>What was done about it</th></tr>
${CATS.filter(c => count(c)).map(c => rows.filter(r => r.cat === c).map(r => `<tr>
<td class="num">${r.n}</td><td>${esc(r.name)}</td><td style="color:var(--mut)">${esc(r.verdict)}</td>
<td><span class="tag ${CATCLASS[r.cat]}">${r.cat}</span></td><td>${esc(r.why)}</td></tr>`).join("")).join("")}
</table></div>

<h2>3 &middot; The findings not yet wired</h2>
${count("IDLE") ? rows.filter(r => r.cat === "IDLE").map(r => `<div class="box warn"><p><b>#${r.n} &mdash; ${esc(r.name)}</b></p>
<p style="color:var(--mut);font-size:13.5px">${esc(r.key)}</p><p>${esc(r.why)}</p></div>`).join("")
  : `<div class="box"><p><b>None outstanding.</b> The two that were idle &mdash; #7 and #18 &mdash; were both taken up on 2026-07-27.
One is enforced, one is deliberately not, and the asymmetry is the point:</p>
<p style="margin-top:9px"><b>#7 is enforced</b> because its own backtest and the forward record agree. Cutting 38% of tickets moved
the board from 48.8% win / &minus;0.0057R / &minus;$1,010 to <b>52.2% / +0.0012R / &minus;$127</b>. It removed a bleed; it did not
create profit, which is exactly what a risk filter is for.</p>
<p style="margin-top:9px"><b>#18 is not enforced</b> because they disagree. Its tested spec would have removed the board's single best
cohort (+0.1027R on 32 trades, +$2,735), and half of it &mdash; the "block Trend in high vol" branch &mdash; has never fired, because
realized vol was low in all six sessions. It computes and tags; it blocks nothing.</p>
<p style="margin-top:9px"><b>The caveat that belongs on both.</b> The enforce/withhold split was decided on the same 6 sessions it was
measured against, so it is not out-of-sample for that decision. #7 has independent multi-year support, which is why enforcing it is
defensible. Withholding #18 is the conservative direction &mdash; it changes nothing &mdash; but it is still a choice fitted to a
6-session window, and it should be revisited once a high-vol regime has appeared.</p></div>`}

<h2>4 &middot; The 25 observers &mdash; all recording, none deciding</h2>
<p>Every one is captured on the ticket and written to the ledger. <b>None gates selection, sizing, or entry.</b> That was a
deliberate design choice &mdash; an observer that steers trades before it has been adjudicated is a curve-fit &mdash; but it means
the answer to "what did the observers change" is currently <b>nothing</b>.</p>
<div class="scroll"><table><tr><th>Observer</th><th>Measures</th><th class="num">Trades</th><th>Role</th></tr>
${OBSERVERS.map(([k, n, d]) => `<tr><td><code>${k}</code></td><td>${esc(d)}</td><td class="num">${n}</td><td style="color:var(--mut)">record only</td></tr>`).join("")}
</table></div>
<div class="box warn"><p><b>And the count is inflated.</b> Defect D16: eight of these slots
(<code>vix oil20 gold20 y10 y10chg20 curve polNews polSent</code>) resolve to one identical partition, and seven are
constant within a session &mdash; so their 130 trades carry an effective sample of <b>2 sessions</b>, not 130.
24 splittable observers collapse to <b>10 distinct testable lenses</b>.</p></div>

<h2>5 &middot; The 5 agents &mdash; the only part that has consistently changed outcomes</h2>
<p>These are audit agents, not trading agents. They do not generate signals; they attack claims. On the evidence
they have been the most productive component in the project, because every finding they killed was a finding that
would otherwise have been believed.</p>
<div class="scroll"><table><tr><th>Agent</th><th>Job</th><th>What it actually caught</th></tr>
${AGENTS.map(([n, j, c]) => `<tr><td><code>${n}</code></td><td>${esc(j)}</td><td>${esc(c)}</td></tr>`).join("")}
</table></div>

<h2>6 &middot; Data feeds</h2>
<div class="scroll"><table><tr><th>Feed</th><th>Provides</th><th>Wired?</th></tr>
${FEEDS.map(([n, p, w]) => `<tr><td>${esc(n)}</td><td>${esc(p)}</td><td>${esc(w)}</td></tr>`).join("")}
</table></div>

<h2>7 &middot; Money and decisions actually protected</h2>
<div class="scroll"><table><tr><th>Decision</th><th>Basis</th></tr>
${(reg.defended || []).map(d => `<tr><td><b>${esc(d.what)}</b></td><td>${esc(d.detail)}</td></tr>`).join("")}
</table></div>

<h2>8 &middot; What to wire next, in order</h2>
<ol>
<li><b>#7 SPY-200MA regime filter</b> &mdash; measured to lift trend from &minus;0.12 to +0.11 Sharpe and cut drawdown. Read it in selection.</li>
<li><b>#18 VIX-regime switch</b> &mdash; measured to remove the bleed (PF 1.00). Read it in selection.</li>
<li><b>Close defect D16</b> &mdash; dedupe the macro observer block so the evidence count stops overstating itself ~2.4&times;.</li>
<li><b>Grade the gate</b> &mdash; the options debit tickets are still built and tagged. In ~30 days, ask whether skipping them saved money or cost it. A rule nobody grades is a guess.</li>
<li><b>The 14 open debit spreads</b> &mdash; ~$12,577 of committed max loss in the structure the gate now refuses. The gate does not touch positions already open.</li>
</ol>

<p class="foot">Generated by <code>backend/build-action-ledger.js</code> from <code>test-registry.json</code>,
<code>defect-log.json</code> and a source audit of <code>src/App.jsx</code>. The wiring counts
(${obsWrites} writes / ${obsReadsInConditionals} branching reads) are computed from source, not asserted.
Paper-only research record &middot; not investment advice.</p>
</div>`);

console.log(`\n  ACTION LEDGER`);
console.log(`  ${rows.length} tests classified by what was DONE about them:`);
for (const c of CATS) if (count(c)) console.log(`    ${c.padEnd(15)} ${String(count(c)).padStart(2)}   ${rows.filter(r => r.cat === c).map(r => "#" + r.n).join(" ")}`);
console.log(`\n  wiring audit from source: ${obsWrites} assignments into obs.* · ${obsReadsInConditionals} conditionals branching on one`);
console.log(`  options debit gate present: ${gateWired ? "YES" : "NO"}`);
console.log(`\n  written: TRAIDS_Action_Ledger.html\n`);
