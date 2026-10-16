#!/usr/bin/env node
/**
 * R42 — CALENDAR FLOW: do the days institutions buy on pay? Registered 2026-08-23.
 *
 * Operator: "what days do they buy" → "register it". Institutions move money on a public calendar
 * (pension/401k inflows at the turn of the month, quarter-end rebalancing, index reconstitution in
 * the closing auction, option expiration hedging). Known is not tradable: the turn-of-month effect is
 * the oldest documented calendar anomaly and has shrunk as it was learned. This measures whether any
 * of it survives on our feed, net of cost, with the buckets fixed BEFORE the read.
 *
 * BUCKETS (disjoint days; a day takes the first bucket that matches, in this order):
 *   indexDay   S&P quarterly rebalance = 3rd Friday of Mar/Jun/Sep/Dec; Russell reconstitution = last
 *              Friday of June; MSCI semi-annual = last trading day of May and November
 *   opex       3rd Friday of every other month
 *   tom        turn of the month: the last trading day of a month and the first three of the next
 *   qePre      quarter-end pressure: sessions −5..−2 before the last trading day of Mar/Jun/Sep/Dec
 *   mePre      month-end pressure: sessions −5..−2 before the last trading day of other months
 *   other      everything else (the control)
 *
 * DATA: SPY and the top-300 roster names, daily bars from 2016 on Alpaca's SIP (consolidated) feed — IEX daily history only begins July 2020 (total
 * return). Survivorship on the roster is declared (today's names applied to the past); SPY has none.
 * RETURN: close(t−1) → close(t) for SPY, and the equal-weight mean of the roster names with a bar.
 *
 * STATISTIC per bucket: mean daily return vs the control, Welch t (days are the unit; buckets are
 * disjoint), the fraction of calendar years in which the bucket beat the control, and the best-of-6
 * null bar (six buckets were looked at). Net of cost: a "hold only on bucket days" policy pays one
 * round trip per contiguous window — SPY declared 1 bp/side, roster 10 bps/side (cost model).
 *
 * BAR (fixed now). HISTORY is exploration, labelled: a bucket is "promising" if its SPY excess over
 * the control is > 0 with t >= the best-of-6 null bar AND it beat the control in >= 70% of years.
 * FORWARD verdict only, from 2026-08-24: >= 60 forward bucket-days in that bucket with mean excess
 * > 0 at t >= the best-of-6 bar; interim kill-only at 30 (t <= −2). CLEARED → proposal for a
 * calendar sleeve on SPY (never a roster sleeve until its cost is measured). Otherwise DID NOT PASS.
 *
 * Usage: node backend/calendar-flow.js           (history read + append forward days; nightly)
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBarsSip } = require("./lib/sip-fetch.js");
const NB = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f);
const OUT = D("calendar-flow.json");
const START = "2016-01-01", EVIDENCE_START = "2026-08-24", ROSTER = 300;
const BUCKETS = ["indexDay", "opex", "tom", "qePre", "mePre"];
const BAR = { minForwardDays: 60, interimDays: 30, interimKillT: -2.0, yearsFrac: 0.7, buckets: BUCKETS.length };
const COST_SIDE = { SPY: 0.0001, roster: (() => { try { return JSON.parse(fs.readFileSync(D("cost-model.json"), "utf8")).perClass.Equity.spreadPctSide / 100; } catch { return 0.001; } })() };
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : null; };
const welch = (a, b) => { if (a.length < 3 || b.length < 3) return null; const va = sd(a) ** 2 / a.length, vb = sd(b) ** 2 / b.length; return va + vb > 0 ? +((mean(a) - mean(b)) / Math.sqrt(va + vb)).toFixed(3) : null; };
const etDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const etHM = () => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

/* ── bucket every session from the session list itself (no holiday table needed) ── */
function bucketize(days) {   // days: sorted ISO dates of actual sessions
  const out = {}; const ym = (d) => d.slice(0, 7);
  const byMonth = {}; days.forEach((d, i) => (byMonth[ym(d)] ||= []).push(i));
  const months = Object.keys(byMonth).sort();
  const lastIdx = Object.fromEntries(months.map((m) => [m, byMonth[m][byMonth[m].length - 1]]));
  const dow = (d) => new Date(d + "T12:00:00Z").getUTCDay();
  const nthFriday = (m, n) => { const idx = byMonth[m].filter((i) => dow(days[i]) === 5); return idx[n - 1]; };
  const lastFriday = (m) => { const idx = byMonth[m].filter((i) => dow(days[i]) === 5); return idx[idx.length - 1]; };
  const set = (i, b) => { if (i != null && i >= 0 && i < days.length && !out[days[i]]) out[days[i]] = b; };
  for (const m of months) {
    const mo = +m.slice(5, 7), quarter = [3, 6, 9, 12].includes(mo);
    if (quarter) set(nthFriday(m, 3), "indexDay");
    if (mo === 6) set(lastFriday(m), "indexDay");
    if (mo === 5 || mo === 11) set(lastIdx[m], "indexDay");
  }
  for (const m of months) { const mo = +m.slice(5, 7); if (![3, 6, 9, 12].includes(mo)) set(nthFriday(m, 3), "opex"); }
  for (const m of months) { const L = lastIdx[m]; set(L, "tom"); set(L + 1, "tom"); set(L + 2, "tom"); set(L + 3, "tom"); }
  for (const m of months) { const mo = +m.slice(5, 7), L = lastIdx[m], b = [3, 6, 9, 12].includes(mo) ? "qePre" : "mePre"; for (let k = 2; k <= 5; k++) set(L - k, b); }
  for (const d of days) out[d] ||= "other";
  return out;
}

(async () => {
  const today = etDay(), hm = etHM();
  const uni = JSON.parse(fs.readFileSync(D("universe-expanded.json"), "utf8"));
  const roster = uni.names.slice(0, ROSTER).map((n) => n.sym).filter((s) => s !== "SPY");
  const t0 = Date.now();
  // Ask for today; lib/sip-fetch walks the end date back if this plan refuses it (2026-08-24: it
  // refuses same-day SIP entirely, which the previous 16:15 ET guess could never have satisfied).
  const { bars, effectiveEnd, walkedBack } = await fetchBarsSip(["SPY", ...roster], { start: START, end: today, timeframe: "1Day", chunkSize: 25, requireAll: false, requireSymbols: ["SPY"], quiet: true });
  if (walkedBack) console.log(`  SIP would not serve through ${today}; graded through ${effectiveEnd} instead`);
  const dOf = (b) => String(b.t).slice(0, 10);
  const spy = (bars.SPY || []).filter((b) => dOf(b) < today || hm >= "16:10");
  const days = spy.map(dOf);
  const buckets = bucketize(days);
  // returns: SPY close-to-close; roster equal-weight close-to-close over names with both bars
  const closeMap = {}; for (const s of roster) { const m = {}; for (const b of bars[s] || []) m[dOf(b)] = b.c; closeMap[s] = m; }
  const rows = [];
  for (let i = 1; i < spy.length; i++) {
    const d = days[i], p = days[i - 1];
    const rs = []; for (const s of roster) { const a = closeMap[s][d], b = closeMap[s][p]; if (a > 0 && b > 0) rs.push(a / b - 1); }
    rows.push({ d, bucket: buckets[d], spy: spy[i].c / spy[i - 1].c - 1, roster: rs.length >= 50 ? mean(rs) : null, n: rs.length, year: d.slice(0, 4) });
  }
  const hist = rows.filter((r) => r.d < EVIDENCE_START), fwd = rows.filter((r) => r.d >= EVIDENCE_START);
  const ctrl = hist.filter((r) => r.bucket === "other");
  const nullBar = NB.nullBar({ variants: BUCKETS.length, n: 250, trials: 2000 });   // six buckets looked at; bar stated at a 250-day scale
  const stats = {};
  for (const b of BUCKETS) {
    const rs = hist.filter((r) => r.bucket === b);
    const yrs = [...new Set(rs.map((r) => r.year))];
    const beat = yrs.filter((y) => mean(rs.filter((r) => r.year === y).map((r) => r.spy)) > mean(ctrl.filter((r) => r.year === y).map((r) => r.spy))).length;
    // windows: contiguous bucket-days → one round trip each (cost per window, spread over its days)
    let windows = 0; for (let i = 0; i < hist.length; i++) if (hist[i].bucket === b && (i === 0 || hist[i - 1].bucket !== b)) windows++;
    const spyNet = mean(rs.map((r) => r.spy)) - (2 * COST_SIDE.SPY * windows) / (rs.length || 1);
    const rr = rs.filter((r) => r.roster != null), cr = ctrl.filter((r) => r.roster != null);
    const rosterNet = rr.length ? mean(rr.map((r) => r.roster)) - (2 * COST_SIDE.roster * windows) / rr.length : null;
    stats[b] = { days: rs.length, windows, spy: { mean: +(1e4 * mean(rs.map((r) => r.spy))).toFixed(1), ctrl: +(1e4 * mean(ctrl.map((r) => r.spy))).toFixed(1), excess: +(1e4 * (mean(rs.map((r) => r.spy)) - mean(ctrl.map((r) => r.spy)))).toFixed(1), t: welch(rs.map((r) => r.spy), ctrl.map((r) => r.spy)), netMean: +(1e4 * spyNet).toFixed(1), yearsBeat: `${beat}/${yrs.length}` },
      roster: rr.length ? { mean: +(1e4 * mean(rr.map((r) => r.roster))).toFixed(1), ctrl: +(1e4 * mean(cr.map((r) => r.roster))).toFixed(1), excess: +(1e4 * (mean(rr.map((r) => r.roster)) - mean(cr.map((r) => r.roster)))).toFixed(1), t: welch(rr.map((r) => r.roster), cr.map((r) => r.roster)), netMean: +(1e4 * rosterNet).toFixed(1) } : null,
      promising: mean(rs.map((r) => r.spy)) > mean(ctrl.map((r) => r.spy)) && welch(rs.map((r) => r.spy), ctrl.map((r) => r.spy)) >= nullBar.p95 && beat / yrs.length >= BAR.yearsFrac };
  }
  // forward (the registered statistic): per bucket, excess over forward control days; accrues nightly
  const fctrl = fwd.filter((r) => r.bucket === "other");
  const forward = { days: fwd.length, controlDays: fctrl.length, buckets: {} };
  for (const b of BUCKETS) { const rs = fwd.filter((r) => r.bucket === b); forward.buckets[b] = { days: rs.length, spyExcess: rs.length && fctrl.length ? +(1e4 * (mean(rs.map((r) => r.spy)) - mean(fctrl.map((r) => r.spy)))).toFixed(1) : null, t: welch(rs.map((r) => r.spy), fctrl.map((r) => r.spy)) }; }
  const fv = []; for (const b of BUCKETS) { const f = forward.buckets[b]; if (f.days >= BAR.minForwardDays && f.t != null) fv.push(`${b}: ${f.spyExcess > 0 && f.t >= nullBar.p95 ? "CLEARED" : "DID NOT PASS"} (t ${f.t})`); else if (f.days >= BAR.interimDays && f.t != null && f.t <= BAR.interimKillT) fv.push(`${b}: KILLED at interim`); }
  forward.verdict = fv.length ? fv.join(" · ") : `ACCRUING — forward bucket-days: ${BUCKETS.map((b) => b + " " + forward.buckets[b].days).join(", ")} (read at ${BAR.minForwardDays})`;
  // THE BIGGEST DAYS (operator 2026-08-23: "5-7 days a year are the biggest gains of the year"): where do each year's
  // top-7 SPY days fall on the calendar, vs each bucket's share of all days? And how many sit within 5 sessions of a
  // bottom-7 day — the textbook finding that the best days cluster inside the worst stretches.
  const years = [...new Set(hist.map((r) => r.year))].sort();
  const share = {}; for (const b of [...BUCKETS, "other"]) share[b] = hist.filter((r) => r.bucket === b).length / hist.length;
  const bestRows = [], worstSet = new Set();
  for (const y of years) { const yr = hist.filter((r) => r.year === y).slice().sort((a, b) => b.spy - a.spy); bestRows.push(...yr.slice(0, 7)); yr.slice(-7).forEach((r) => worstSet.add(r.d)); }
  const idxOf = Object.fromEntries(hist.map((r, i) => [r.d, i]));
  const nearWorst = bestRows.filter((r) => { const i = idxOf[r.d]; for (let k = Math.max(0, i - 5); k <= Math.min(hist.length - 1, i + 5); k++) if (worstSet.has(hist[k].d)) return true; return false; }).length;
  const bestByBucket = {}; for (const b of [...BUCKETS, "other"]) { const n = bestRows.filter((r) => r.bucket === b).length; bestByBucket[b] = { bestDays: n, expected: +(share[b] * bestRows.length).toFixed(1), ratio: share[b] ? +(n / (share[b] * bestRows.length)).toFixed(2) : null }; }
  const bestDays = { perYear: 7, years: years.length, n: bestRows.length, meanRetBp: +(1e4 * mean(bestRows.map((r) => r.spy))).toFixed(0), shareOfAnnualReturn: +(mean(years.map((y) => { const yr = hist.filter((r) => r.year === y); const tot = yr.reduce((s, r) => s + r.spy, 0); const top = yr.slice().sort((a, b) => b.spy - a.spy).slice(0, 7).reduce((s, r) => s + r.spy, 0); return tot ? top / tot : null; }).filter((x) => x != null))).toFixed(2), withinFiveSessionsOfAWorstDay: nearWorst, byBucket: bestByBucket };
  const promising = BUCKETS.filter((b) => stats[b].promising);
  const out = { spec: "R42 calendar-flow v1", registered: "2026-08-23", evidenceStart: EVIDENCE_START, asOf: new Date().toISOString(), range: [days[0], days[days.length - 1]], sessions: days.length, roster: roster.length, survivorship: "roster = today's top 300 applied to the past (declared); SPY has none", costSidePct: { SPY: 100 * COST_SIDE.SPY, roster: +(100 * COST_SIDE.roster).toFixed(3) }, nullBar: { honestBar: nullBar.p95, variants: BUCKETS.length }, history: { inSample: true, controlDays: ctrl.length, stats, promising, bestDays, read: promising.length ? `PROMISING in-sample: ${promising.join(", ")} — forward-only verdict` : "NOT PROMISING — no bucket beats the control at the best-of-6 bar with 70% of years" }, forward, bar: BAR, fetchSecs: +((Date.now() - t0) / 1000).toFixed(0),
    // dailyClock added 2026-09-11 (writer-wiring pass). R42 registers FIVE independent forward
    // bucket-day counts (indexDay/opex/tom/qePre/mePre), each needing 60 on its own — there is no
    // single scalar bar count, so test-triage.js correctly reads this as NO COUNTABLE BAR rather
    // than a false single number. sessions below is the MAX of the five so a reader sees the
    // fastest-accruing bucket at a glance; forward.buckets carries the honest per-bucket detail.
    dailyClock: { sessions: Math.max(...BUCKETS.map((b) => forward.buckets[b].days)), estimate: null, unit: "forward bucket-days (max of 5 independent buckets; see forward.buckets)" } };
  writeJsonAtomic(OUT, out);
  console.log(`R42 CALENDAR FLOW — ${days.length} sessions ${days[0]} → ${days[days.length - 1]} · SPY + ${roster.length} roster names · control ${ctrl.length} days · best-of-6 bar ${nullBar.p95} · ${out.fetchSecs}s`);
  console.log("  bucket     days  win  SPY bp/day  ctrl  excess   t     net   years-beat | roster bp/day ctrl excess t net");
  for (const b of BUCKETS) { const s = stats[b]; console.log(`  ${b.padEnd(9)} ${String(s.days).padStart(5)} ${String(s.windows).padStart(4)}  ${String(s.spy.mean).padStart(9)} ${String(s.spy.ctrl).padStart(5)} ${String(s.spy.excess).padStart(7)} ${String(s.spy.t).padStart(6)} ${String(s.spy.netMean).padStart(6)}   ${s.spy.yearsBeat.padStart(6)}     | ${s.roster ? `${String(s.roster.mean).padStart(6)} ${String(s.roster.ctrl).padStart(5)} ${String(s.roster.excess).padStart(6)} ${String(s.roster.t).padStart(6)} ${String(s.roster.netMean).padStart(6)}` : "n/a"}${s.promising ? "   ← promising (in-sample)" : ""}`); }
  console.log(`  ${out.history.read}\n  forward: ${forward.verdict}\nwritten: calendar-flow.json`);
})().catch((e) => { console.error("R42 failed:", e.message); process.exit(1); });
