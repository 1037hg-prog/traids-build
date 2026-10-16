/**
 * THE CRYPTO WEEKEND, EVERY MONDAY. (2026-09-09, operator: "add the weekend crypto trades to the
 * progress report on mondays")
 *
 * WHY MONDAY. A Friday-to-Monday hold resolves at the Monday close, so Monday evening is the first
 * moment the weekend is a fact rather than a position. Any other night it would be a forecast.
 *
 * WHAT THIS IS AND IS NOT. The book's entire clean-era profit turned out to be a weekend artifact:
 * crypto trades 24/7 while the settle chain runs an equity calendar, so a Friday crypto entry gets
 * roughly three times the holding window of any other weekday. 60 weekend-spanning crypto tickets
 * made +$16,661 while 245 weekday-only ones lost $5,800. That is exposure time, not selection.
 *
 * SO THE QUESTION WAS TESTED, AND IT FAILED. Across 289 weeks of independent history — 5.7 years,
 * clustered on the week, net of the measured 31.7bp round trip charged to both legs — the Friday-to-
 * Monday hold returned +0.077% against +0.276% for a DURATION-MATCHED weekday hold. The weekend is
 * worse than a matched hold, by 0.199 points, at t -0.445. There is no weekend edge.
 *
 * This section therefore reports the weekend as an OBSERVATION, never as a trade, and it prints the
 * 289-week answer beside every reading. Without that anchor a good weekend reads as vindication, and
 * this shop has already spent an evening discovering that its best number was a calendar accident.
 *
 * Usage: require("./progress-weekend.js").build()   — returns {html, line, due}
 *        node backend/progress-weekend.js --force
 */
const fs = require("fs"), path = require("path");
const { fetchCryptoBars } = require("./lib/crypto-bars.js");
const R = require("./lib/reconcile.js");

const D = (f) => path.join(__dirname, "data", f);
const SYMS = ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "ADA/USD", "DOGE/USD", "LINK/USD", "LTC/USD"];
const RT_COST_PCT = 0.317;                       // measured crypto round trip, not the declared 0.2%
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const n2 = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(3) : "—");
const money = (v) => (v < 0 ? "-$" : "+$") + Math.abs(v).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const etParts = () => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date());

async function build({ force = false } = {}) {
  if (etParts() !== "Mon" && !force) return { html: "", line: null, due: false };

  // --force on a non-Monday walks back 3 days from TODAY, so the window is not a weekend at all.
  // Say so in the section rather than letting it render a Sunday-to-Wednesday move under a
  // "Friday to Monday" heading — the same lie-about-context the watcher alarm was fixed for.
  const forcedOffDay = force && etParts() !== "Mon";
  const study = (() => { try { return JSON.parse(fs.readFileSync(D("crypto-weekend-study.json"), "utf8")); } catch { return null; } })();
  const m = study && study.main;

  // ── the weekend that just resolved ────────────────────────────────────────
  const utc = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  const fri = new Date(today); fri.setUTCDate(fri.getUTCDate() - 3);
  let rows = [];
  try {
    const start = utc(new Date(today.getTime() - 20 * 86400000));
    const data = await fetchCryptoBars(SYMS, "1Day", start, utc(today));
    for (const s of SYMS) {
      const idx = {}; for (const b of (data[s] || [])) idx[String(b.t).slice(0, 10)] = b.c;
      const a = idx[utc(fri)], b = idx[utc(today)];
      if (a && b) rows.push({ sym: s.replace("/USD", ""), pct: 100 * (b / a - 1) - RT_COST_PCT });
    }
  } catch { /* the section degrades to the standing result rather than failing the report */ }

  // ── what OUR OWN weekend-spanning crypto tickets did ──────────────────────
  let ours = null;
  try {
    const L = R.cleanEraLedger();
    const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const span = (L.signals || []).filter((t) => t.cls === "Crypto" && Number.isFinite(t.pnl) && Number.isFinite(t.closedAt) &&
      etDay(t.closedAt) >= utc(fri) && etDay(t.openedAt) <= utc(fri));
    if (span.length) ours = { n: span.length, pnl: span.reduce((s, t) => s + t.pnl, 0), meanR: mean(span.map((t) => t.rMult).filter(Number.isFinite)) };
  } catch { /* leave null */ }

  const live = rows.length ? mean(rows.map((r) => r.pct)) : null;
  const html = `
  <h2><span>Monday</span>The crypto weekend, measured</h2>
  ${forcedOffDay ? `<p class="sub" style="color:#b42318"><b>FORCED on a ${etParts()} — the window below is the last 3 days, NOT a Friday-to-Monday weekend. Diagnostic only.</b></p>` : ""}
  <p class="sub">A Friday-to-Monday hold resolves at tonight's close, so this is the first moment the weekend is a fact.
  It is reported as an <b>observation, not a trade</b> — see the standing result below.</p>
  ${rows.length ? `
  <div class="tablewrap"><table>
    <tr><td class="k">Friday close → Monday close, net of the measured 31.7bp round trip</td><td class="n">${n2(live)}%</td><td class="note">${rows.length} majors, equal-weighted</td></tr>
    ${rows.map((r) => `<tr><td class="k">${r.sym}</td><td class="n" style="color:${r.pct >= 0 ? "#1a7f37" : "#b42318"}">${n2(r.pct)}%</td><td class="note"></td></tr>`).join("")}
  </table></div>` : `<p class="sub">Bars for this weekend were not available at report time — the standing result below is unaffected.</p>`}
  ${ours ? `<p class="sub">Our own book held <b>${ours.n}</b> crypto ticket(s) across this weekend: <b>${money(ours.pnl)}</b>, mean ${n2(ours.meanR)}R. That exposure is a
  scheduling artifact — the settle chain runs an equity calendar against a 24/7 market — not a chosen position.</p>` : ""}
  ${m ? `
  <div class="tablewrap"><table>
    <tr><td class="k"><b>THE STANDING RESULT — ${m.weeks} weeks, ${study.heldOut ? "excluding the window that generated the hypothesis" : ""}</b></td><td class="n"></td><td class="note">clustered on the WEEK; cost charged to both legs so it cancels in the difference</td></tr>
    <tr><td class="k">Friday → Monday</td><td class="n">${n2(m.weekendNetPct)}%</td><td class="note">the weekend hold, net</td></tr>
    <tr><td class="k">Duration-matched weekday hold</td><td class="n">${n2(m.controlNetPct)}%</td><td class="note">the same 3 days started any other weekday — this is the honest comparison</td></tr>
    <tr><td class="k">Difference</td><td class="n" style="font-weight:600;color:${m.diffPct >= 0 ? "#1a7f37" : "#b42318"}">${n2(m.diffPct)}%</td><td class="note">t ${m.t} against a ${m.bar} bar — <b>${m.clears ? "clears" : "does not clear, and points the wrong way"}</b></td></tr>
  </table></div>
  <p class="sub"><b>There is no weekend edge.</b> Over ${m.weeks} weeks the weekend hold is <i>worse</i> than a duration-matched
  weekday hold. Whatever tonight's number says, it is one week against ${m.weeks}, and the ${m.weeks}-week answer is the one that
  counts. Holding longer is exposure, and exposure is not edge.</p>` :
  `<p class="sub">The 289-week standing result could not be read (data/crypto-weekend-study.json missing). Do not read tonight's
  number on its own — one weekend says nothing.</p>`}`;

  const line = `Monday weekend read: ${live == null ? "bars unavailable" : n2(live) + "% net across the majors"}${m ? ` · standing result ${m.weeks} weeks: weekend ${n2(m.weekendNetPct)}% vs matched ${n2(m.controlNetPct)}%, NO edge` : ""}.`;
  return { html, line, due: true };
}

module.exports = { build };

if (require.main === module) build({ force: process.argv.includes("--force") }).then((o) => {
  if (!o.due) return console.log("  not Monday — use --force");
  console.log("\n  " + o.line + "\n");
  console.log(o.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 900));
});
