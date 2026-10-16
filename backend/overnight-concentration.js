#!/usr/bin/env node
/**
 * OVERNIGHT CONCENTRATION — how much of SPY's overnight return lives in its best nights, and whether
 * the biggest of them were scheduled prints. Written 2026-09-05 on the operator's read ("the best 20
 * nights of five years carried 101% of all overnight gains, and 2 of the top 7 were scheduled CPI
 * mornings") and his instruction to put it in the calendar and keep it updating.
 *
 * What it reports, every night, from the same SIP daily feed R20 uses:
 *   - share of the summed overnight return carried by the top 7 / 20 / 50 nights
 *   - the SAME for the worst nights, because a fat tail is symmetric and the top-20 number alone
 *     reads as "20 nights made all the money" when the middle 1,200 nights made it too
 *   - the top-7 list, each night tagged from the OFFICIAL calendar (data/macro-calendar.json:
 *     CPI covers 2021+, NFP/FOMC 2024+; a night outside a series' coverage is tagged pre-calendar,
 *     never guessed — R20 rule: release dates are never reconstructed from memory)
 *   - scheduled (CPI+NFP) vs ordinary mean overnight, calendar-covered window
 *
 * Writes data/overnight-concentration.json and refreshes the marked block in the operating calendar
 * (docs/TRAIDS_Operating_Calendar_2026-08-22.html) so the repo copy stays current; the published
 * artifact updates when the calendar is next republished.
 *
 * This is a description of the return distribution, not a test. It has no bar and moves nothing.
 */
const fs = require("fs"), path = require("path");
const { fetchBarsSip } = require("./lib/sip-fetch.js");
const D = (f) => path.join(__dirname, "data", f);
const CAL_HTML = path.join(__dirname, "..", "docs", "TRAIDS_Operating_Calendar_2026-08-22.html");
const YEARS = 5;

const pct = (x, d = 1) => `${(100 * x).toFixed(d)}%`;
const bp = (x) => `${(1e4 * x).toFixed(1)}bp`;
const sum = (a) => a.reduce((s, n) => s + n.ret, 0);

(async () => {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const start = `${+today.slice(0, 4) - YEARS}${today.slice(4)}`;
  const cal = JSON.parse(fs.readFileSync(D("macro-calendar.json"), "utf8"));
  const { bars, effectiveEnd } = await fetchBarsSip(["SPY"], { start, end: today, timeframe: "1Day", quiet: true, requireAll: false });
  const spy = (bars.SPY || []).slice().sort((a, b) => String(a.t).localeCompare(String(b.t)));
  if (spy.length < 500) throw new Error(`SPY daily bars: ${spy.length} — refusing to describe a distribution on a short feed`);

  const nights = [];
  for (let i = 1; i < spy.length; i++) nights.push({ date: String(spy[i].t).slice(0, 10), ret: spy[i].o / spy[i - 1].c - 1 });
  const total = sum(nights);
  const desc = nights.slice().sort((a, b) => b.ret - a.ret);

  // calendar coverage per series: the first year each series' official schedule was captured
  const coverage = {}; for (const s of ["CPI", "NFP", "FOMC"]) coverage[s] = (cal[s] || []).length ? cal[s].slice().sort()[0].slice(0, 4) : null;
  const inSeries = (s, d) => coverage[s] && d.slice(0, 4) >= coverage[s] ? (cal[s].includes(d) ? s : "") : null; // null = not covered
  const tag = (d) => {
    const hits = ["CPI", "NFP", "FOMC"].map((s) => inSeries(s, d));
    const named = hits.filter(Boolean).join("+");
    if (named) return named;
    return hits.every((h) => h === null) ? "pre-calendar" : hits.some((h) => h === null) ? "ordinary (CPI-checked only)" : "ordinary";
  };

  const share = (k) => ({ k, sum: sum(desc.slice(0, k)), share: sum(desc.slice(0, k)) / total, scheduled: desc.slice(0, k).filter((n) => /CPI|NFP|FOMC/.test(tag(n.date))).length });
  const top = [7, 20, 50].map(share);
  const bottom20 = sum(desc.slice(-20)), top20 = top[1].sum;
  const covFrom = [coverage.CPI, coverage.NFP].filter(Boolean).sort().pop(); // year both CPI and NFP are official
  const cov = nights.filter((n) => covFrom && n.date.slice(0, 4) >= covFrom);
  const sched = cov.filter((n) => /CPI|NFP/.test(tag(n.date))), ord = cov.filter((n) => tag(n.date) === "ordinary");
  const m = (a) => (a.length ? sum(a) / a.length : null);

  const out = {
    ranAt: new Date().toISOString(), feed: "alpaca-sip-1Day SPY", window: [nights[0].date, nights.at(-1).date], effectiveEnd, nights: nights.length,
    allNightsSummed: total, top, bottom20Summed: bottom20, middleSummed: total - top20 - bottom20,
    top7: desc.slice(0, 7).map((n) => ({ date: n.date, ret: n.ret, tag: tag(n.date) })),
    calendarCoverageFromYear: coverage,
    scheduledVsOrdinary: covFrom ? { fromYear: covFrom, scheduledMean: m(sched), scheduledN: sched.length, ordinaryMean: m(ord), ordinaryN: ord.length } : null,
    reading: "a fat-tailed series whose good and bad tails nearly cancel over a steady positive middle; the top-20 share is a distribution fact, not a forecastable premium — R14 holds every night for this reason, R20 tests whether scheduled nights carry more",
  };
  fs.writeFileSync(D("overnight-concentration.json"), JSON.stringify(out, null, 1));

  const t7 = out.top7.map((n, i) => `${i + 1}. ${n.date} ${pct(n.ret, 2)} ${n.tag}`);
  console.log(`OVERNIGHT CONCENTRATION · SPY ${out.window[0]} → ${out.window[1]} · ${nights.length} nights (${YEARS}y)`);
  console.log(`  all nights summed ${pct(total)} · top 7 ${pct(top[0].sum)} (${pct(top[0].share, 0)} of total) · top 20 ${pct(top[1].sum)} (${pct(top[1].share, 0)}) · top 50 ${pct(top[2].sum)} (${pct(top[2].share, 0)})`);
  console.log(`  worst 20 summed ${pct(bottom20)} · middle ${nights.length - 40} nights summed ${pct(out.middleSummed)}  ← the premium lives here`);
  console.log(`  top 7: ${t7.join(" · ")}`);
  if (out.scheduledVsOrdinary) console.log(`  ${covFrom}→ CPI+NFP nights ${bp(out.scheduledVsOrdinary.scheduledMean)} (n ${sched.length}) vs ordinary ${bp(out.scheduledVsOrdinary.ordinaryMean)} (n ${ord.length})`);

  // refresh the calendar's marked block (repo copy); silently skip if the calendar or markers are absent
  try {
    const html = fs.readFileSync(CAL_HTML, "utf8");
    const S = "<!-- OVERNIGHT-CONCENTRATION:start -->", E = "<!-- OVERNIGHT-CONCENTRATION:end -->";
    const a = html.indexOf(S), b = html.indexOf(E);
    if (a >= 0 && b > a) {
      const sched = out.scheduledVsOrdinary;
      const block = `${S}<b>${out.window[0]} &rarr; ${out.window[1]}</b>, ${nights.length} nights, updated ${out.ranAt.slice(0, 10)}. All nights summed <b>${pct(total)}</b>; best 20 <b>${pct(top[1].sum)} = ${pct(top[1].share, 0)}</b> of it; best 7 ${pct(top[0].share, 0)}. Worst 20 summed <b>${pct(bottom20)}</b>; the middle ${nights.length - 40} nights <b>${pct(out.middleSummed)}</b> &mdash; the premium is the middle, the tails cancel. Top 7: ${out.top7.map((n) => `${n.date} ${pct(n.ret, 2)}${/CPI|NFP|FOMC/.test(n.tag) ? ` <b>${n.tag}</b>` : ""}`).join("; ")}. ${sched ? `Scheduled CPI+NFP nights ${bp(sched.scheduledMean)} vs ordinary ${bp(sched.ordinaryMean)} (${sched.fromYear}&rarr;, n ${sched.scheduledN}/${sched.ordinaryN})` : ""}. Official BLS/Fed dates only (CPI from ${coverage.CPI}, NFP/FOMC from ${coverage.NFP}).${E}`;
      fs.writeFileSync(CAL_HTML, html.slice(0, a) + block + html.slice(b + E.length));
      console.log(`  calendar block refreshed: ${path.relative(process.cwd(), CAL_HTML)}`);
    }
  } catch (e) { console.log(`  calendar not refreshed: ${e.message}`); }
  console.log(`written: overnight-concentration.json`);
})().catch((e) => { console.error(`OVERNIGHT CONCENTRATION FAILED: ${e.message}`); process.exit(1); });
