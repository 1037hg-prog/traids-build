#!/usr/bin/env node
/**
 * R20 — SCHEDULED-PRINT OVERNIGHTS. Registered 2026-08-11; collector built 2026-08-23 (it had none —
 * found in the "what have we forgotten" sweep).
 *
 * RULE (as registered): SPY overnights (close → next open) that SPAN a scheduled US macro release
 * morning vs all other overnights. Dates come ONLY from data/macro-calendar.json, which records its
 * official sources (BLS schedule pages, Fed FOMC calendar); PCE joins when BEA's schedule is captured.
 * HYPOTHESIS (fixed): scheduled-print nights carry a larger mean overnight return (information-arrival
 * risk premium). BAR: >= 60 scheduled nights, mean excess > 0 at t >= 2.0 (Welch; nights are disjoint
 * units). The registry allows a HISTORICAL read because the conditioning variable is exogenous and
 * published in advance; forward nights accrue nightly from 2026-08-24 and are reported separately.
 *
 * Also reported, never the verdict: mean |overnight| (are these nights bigger, whichever way?), each
 * series alone, and — because the FOMC decision lands at 14:00, not overnight — the decision-DAY
 * session (open → close) vs ordinary sessions as a labelled side bucket.
 *
 * Data: SPY daily bars, Alpaca SIP (consolidated), from 2024-01-01 (the calendar's first year).
 * Usage: node backend/macro-overnight.js
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBarsSip } = require("./lib/sip-fetch.js");
const D = (f) => path.join(__dirname, "data", f);
const OUT = D("macro-overnight.json");
const EVIDENCE_START = "2026-08-24", START = "2024-01-01";
const BAR = { minScheduledNights: 60, tRequired: 2.0 };
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : null; };
const welch = (a, b) => { if (a.length < 3 || b.length < 3) return null; const va = sd(a) ** 2 / a.length, vb = sd(b) ** 2 / b.length; return va + vb > 0 ? +((mean(a) - mean(b)) / Math.sqrt(va + vb)).toFixed(3) : null; };
const bp = (x) => x == null ? null : +(1e4 * x).toFixed(1);
const etDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const etHM = () => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

(async () => {
  const cal = JSON.parse(fs.readFileSync(D("macro-calendar.json"), "utf8"));
  const series = ["CPI", "NFP", "FOMC", "PCE"].filter((k) => (cal[k] || []).length);
  const onDate = {}; for (const k of series) for (const d of cal[k]) (onDate[d] ||= []).push(k);
  const today = etDay(), hm = etHM();
  // see lib/sip-fetch.js — same-day SIP is not served on this plan; the end date walks back until accepted
  const { bars, effectiveEnd, walkedBack } = await fetchBarsSip(["SPY"], { start: START, end: today, timeframe: "1Day", quiet: true, requireAll: false });
  if (walkedBack) console.log(`  SIP would not serve through ${today}; graded through ${effectiveEnd} instead`);
  const spy = (bars.SPY || []).filter((b) => String(b.t).slice(0, 10) < today || hm >= "16:10");
  const dOf = (b) => String(b.t).slice(0, 10);
  const nights = [];
  for (let i = 1; i < spy.length; i++) { const d = dOf(spy[i]); nights.push({ d, overnight: spy[i].o / spy[i - 1].c - 1, session: spy[i].c / spy[i].o - 1, types: onDate[d] || [] }); }
  const hist = nights.filter((n) => n.d < EVIDENCE_START), fwd = nights.filter((n) => n.d >= EVIDENCE_START);
  const read = (set) => {
    const sched = set.filter((n) => n.types.length), ordinary = set.filter((n) => !n.types.length);
    const out = { nights: set.length, scheduled: sched.length, ordinary: ordinary.length,
      overnight: { scheduledMeanBp: bp(mean(sched.map((n) => n.overnight))), ordinaryMeanBp: bp(mean(ordinary.map((n) => n.overnight))), excessBp: sched.length && ordinary.length ? bp(mean(sched.map((n) => n.overnight)) - mean(ordinary.map((n) => n.overnight))) : null, t: welch(sched.map((n) => n.overnight), ordinary.map((n) => n.overnight)), scheduledUp: sched.length ? +(100 * sched.filter((n) => n.overnight > 0).length / sched.length).toFixed(1) : null, ordinaryUp: ordinary.length ? +(100 * ordinary.filter((n) => n.overnight > 0).length / ordinary.length).toFixed(1) : null },
      magnitude: { scheduledMeanAbsBp: bp(mean(sched.map((n) => Math.abs(n.overnight)))), ordinaryMeanAbsBp: bp(mean(ordinary.map((n) => Math.abs(n.overnight)))), t: welch(sched.map((n) => Math.abs(n.overnight)), ordinary.map((n) => Math.abs(n.overnight))) },
      bySeries: Object.fromEntries(series.map((k) => { const s = set.filter((n) => n.types.includes(k)); return [k, { nights: s.length, meanBp: bp(mean(s.map((n) => n.overnight))), excessBp: s.length && ordinary.length ? bp(mean(s.map((n) => n.overnight)) - mean(ordinary.map((n) => n.overnight))) : null, t: welch(s.map((n) => n.overnight), ordinary.map((n) => n.overnight)), meanAbsBp: bp(mean(s.map((n) => Math.abs(n.overnight)))) }]; })),
      fomcDecisionSession: (() => { const f = set.filter((n) => n.types.includes("FOMC")), o = set.filter((n) => !n.types.length); return { days: f.length, sessionMeanBp: bp(mean(f.map((n) => n.session))), ordinarySessionMeanBp: bp(mean(o.map((n) => n.session))), t: welch(f.map((n) => n.session), o.map((n) => n.session)), meanAbsBp: bp(mean(f.map((n) => Math.abs(n.session)))), ordinaryMeanAbsBp: bp(mean(o.map((n) => Math.abs(n.session)))) }; })() };
    return out;
  };
  const H = read(hist), F = read(fwd);
  const verdictOf = (R, label) => R.scheduled < BAR.minScheduledNights ? `${label}: ACCRUING — ${R.scheduled}/${BAR.minScheduledNights} scheduled nights` : (R.overnight.excessBp > 0 && R.overnight.t >= BAR.tRequired ? `${label}: CLEARED — scheduled-print nights carry +${R.overnight.excessBp} bp excess at t ${R.overnight.t}` : `${label}: DID NOT PASS — excess ${R.overnight.excessBp} bp at t ${R.overnight.t}`);
  const out = { spec: "R20 macro-overnight v1", registered: "2026-08-11", collectorBuilt: "2026-08-23", evidenceStart: EVIDENCE_START, calendar: { collectedAt: cal.collectedAt, series, sources: cal.sources, notes: cal.notes }, feed: "alpaca-sip-1Day", range: spy.length ? [dOf(spy[0]), dOf(spy[spy.length - 1])] : null, bar: BAR, history: { ...H, read: verdictOf(H, "HISTORY (exogenous dates — a legitimate read per the registry)") }, forward: { ...F, verdict: verdictOf(F, "FORWARD") }, asOf: new Date().toISOString() };
  writeJsonAtomic(OUT, out);
  console.log(`R20 MACRO OVERNIGHTS — SPY ${out.range?.[0]} → ${out.range?.[1]} · series ${series.join("+")} · history: ${H.scheduled} scheduled vs ${H.ordinary} ordinary nights`);
  console.log(`  overnight  scheduled ${H.overnight.scheduledMeanBp} bp (up ${H.overnight.scheduledUp}%) vs ordinary ${H.overnight.ordinaryMeanBp} bp (up ${H.overnight.ordinaryUp}%) · excess ${H.overnight.excessBp} bp · t ${H.overnight.t}`);
  console.log(`  magnitude  |overnight| scheduled ${H.magnitude.scheduledMeanAbsBp} bp vs ordinary ${H.magnitude.ordinaryMeanAbsBp} bp · t ${H.magnitude.t}`);
  for (const [k, v] of Object.entries(H.bySeries)) console.log(`  ${k.padEnd(5)} nights ${v.nights} · mean ${v.meanBp} bp · excess ${v.excessBp} · t ${v.t} · |move| ${v.meanAbsBp} bp`);
  const f = H.fomcDecisionSession; console.log(`  FOMC decision-DAY session (side bucket): ${f.days} days · ${f.sessionMeanBp} bp vs ordinary ${f.ordinarySessionMeanBp} · t ${f.t} · |move| ${f.meanAbsBp} vs ${f.ordinaryMeanAbsBp}`);
  console.log(`  ${out.history.read}\n  ${out.forward.verdict}\nwritten: macro-overnight.json`);
})().catch((e) => { console.error("R20 failed:", e.message); process.exit(1); });
