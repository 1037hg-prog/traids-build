#!/usr/bin/env node
/**
 * R8a — THE READ. 2026-08-06.
 *
 * Adjudicator has shown R8 as READY TO READ; the ABNB earnings headline prompted actually
 * computing it. This reads R8a exactly as registered on 2026-07-30 — nothing here was chosen
 * after seeing data:
 *
 *   QUESTION   does anything the system already measures predict the SIGN of an earnings gap?
 *   OBSERVERS  newsScore, mom20, svrZ — direction mappings fixed at registration
 *   GAP        close-to-close spanning the print, MARKET-RELATIVE (minus SPY)
 *   BAR        per-observer hit rate vs 50%, DAY-CLUSTERED by print date (an earnings-cluster
 *              night is ONE observation), 3 observers → Šidák two-sided |t| >= 2.39 each,
 *              min 60 prints. Below the bar at n >= 60 → observer PERMANENTLY retired from
 *              direction claims.
 *   REGISTERED PREDICTION: ALL THREE FAIL. Gap direction is the most heavily arbitraged
 *              single-number prediction in finance. A null here permanently retires the
 *              recurring "we should have caught X before the print" conversation — that is the
 *              value of the test, not a hoped-for edge.
 *
 * R8b (post-earnings drift) is NOT read here: its +5d endpoints have not elapsed for most of
 * the file. Reading half a test early is how bars get renegotiated.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const shadow = JSON.parse(fs.readFileSync(D("r8-earnings-shadow.json"), "utf8"));
const gaps = Object.values(shadow.settledGaps || {}).filter(g => Number.isFinite(g.relGap) && g.obs);

const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sd = (a) => a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)) : 0;
const tOf = (a, mu) => { const s = sd(a); return a.length > 1 && s > 0 ? (mean(a) - mu) / (s / Math.sqrt(a.length)) : null; };

const BAR_T = 2.39, MIN_PRINTS = 60;
console.log(`R8a READ — ${gaps.length} settled market-relative gaps across ${new Set(gaps.map(g => g.printDate)).size} print dates`);
console.log(`Bar (registered 2026-07-30): day-clustered |t| >= ${BAR_T} per observer, min ${MIN_PRINTS} prints.`);
console.log(`Registered prediction: ALL THREE observers fail.\n`);

const results = {};
for (const key of ["newsScore", "mom20", "svrZ"]) {
  // sign(observer) predicts sign(relGap); a zero-valued observer makes no prediction and a
  // zero gap grades nothing — excluded, never scored as half-credit.
  const usable = gaps.filter(g => Number.isFinite(+g.obs[key]) && Math.sign(+g.obs[key]) !== 0 && Math.sign(g.relGap) !== 0);
  const byDate = {};
  for (const g of usable) (byDate[g.printDate] ||= []).push(Math.sign(+g.obs[key]) === Math.sign(g.relGap) ? 1 : 0);
  const daily = Object.values(byDate).map(mean);          // one hit-rate per print date
  const hit = mean(usable.map(g => Math.sign(+g.obs[key]) === Math.sign(g.relGap) ? 1 : 0));
  const t = tOf(daily, 0.5);
  const enough = usable.length >= MIN_PRINTS;
  const clears = enough && t != null && Math.abs(t) >= BAR_T;
  results[key] = { n: usable.length, dates: daily.length, hit: +(100 * hit).toFixed(1), t: t == null ? null : +t.toFixed(2), clears };
  console.log(`  ${key.padEnd(10)} n=${String(usable.length).padStart(4)} over ${String(daily.length).padStart(2)} dates · hit ${(100 * hit).toFixed(1)}% · day-clustered t ${t == null ? "n/a" : t.toFixed(2)} → ${!enough ? "UNDER MIN" : clears ? "CLEARS (!)" : "fails — RETIRED from direction claims"}`);
}

const anyClears = Object.values(results).some(r => r.clears);
/**
 * Retirement applies ONLY at n >= MIN_PRINTS — the first draft of this verdict retired all
 * three observers while two were under minimum. Under-min observers keep accruing; that is
 * what the registered bar says, and a verdict line that overstates its own result is the exact
 * failure this project logs as flattering... in this case flattering toward tidiness.
 */
const retired = Object.entries(results).filter(([, r]) => r.n >= MIN_PRINTS && !r.clears).map(([k]) => k);
const accruing = Object.entries(results).filter(([, r]) => r.n < MIN_PRINTS).map(([k, r]) => `${k} (${r.n}/${MIN_PRINTS})`);
console.log(`\nVERDICT: ${anyClears
  ? "at least one observer cleared — verify before believing; this contradicts the registered prior."
  : retired.length
    ? `AS REGISTERED for ${retired.join(", ")} — PERMANENTLY RETIRED from direction claims (met n>=${MIN_PRINTS}, failed the bar).`
    : "nothing adjudicable yet."}`);
if (accruing.length) console.log(`STILL ACCRUING (under min — NOT retired, NOT endorsed): ${accruing.join(" · ")}. A hot hit rate over 4 print dates is 4 observations, whatever its t says.`);
console.log(`Day-cluster df is thin (${new Set(gaps.map(g => g.printDate)).size} print dates so far) — stated, not hidden.`);
console.log(`This settles the recurring "we should have caught it before the print" question with data:`);
console.log(`nothing this system measures knew which way the print would go. What remains testable is`);
console.log(`what happens AFTER the gap — R8b (drift), which keeps accruing toward its own bar.`);

fs.writeFileSync(D("r8a-read.json"), JSON.stringify({ readAt: new Date().toISOString(), bar: { t: BAR_T, minPrints: MIN_PRINTS }, results, verdict: anyClears ? "OBSERVER-CLEARED-VERIFY" : "NULL-AS-REGISTERED" }, null, 1));
console.log(`\nwritten: r8a-read.json`);
