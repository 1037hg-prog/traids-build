#!/usr/bin/env node
/** Registers R325 — R214 gold overnight, FORWARD (operator 2026-10-05: "go 1-3", item 1 "give R214 a forward paper test"). Written at
 *  10:30 ET 2026-10-05, before the first forward night (tonight's close). The 2016-2026 history used below for the bar's calibration and
 *  the power figure is the window R214 already measured and sealed; no night on or after 2026-10-05 exists yet. Refuses if R325 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { nullBar } = require("./lib/null-bar.js");
const { fetchBars } = require("./lib/alpaca-bars.js"); const { nightsOf, nwT } = require("./r325-gold-overnight-forward.js");
const D = (f) => path.join(__dirname, "data", f), TODAY = "2026-10-05", N = 750, KILL_N = 250;
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R325")) { console.error("R325 exists — refusing"); process.exit(2); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
(async () => {
  // 1. bar: NW lag-5 p95 on iid noise at n = 750, beside the house nullBar; the larger governs
  const rng = mulberry(325), T = 20000, mx = []; for (let k = 0; k < T; k++) { const s = []; for (let i = 0; i < N; i++) s.push(rng() * 2 - 1); mx.push(nwT(s, 5)); }
  mx.sort((a, b) => a - b); const nw = +mx[Math.floor(0.95 * T)].toFixed(3), iid = +nullBar({ variants: 1, n: N, trials: 20000 }).p95.toFixed(3), BAR = Math.max(nw, iid);
  // 2. whole-rule calibration and power on R214's own sealed window (2016-01..2026-10-02), 20-night blocks
  const { bars } = await fetchBars(["GLD"], { start: "2016-01-01", end: "2026-10-03", feed: "sip", adjustment: "all", quiet: true });
  const H = nightsOf(bars.GLD.map((b) => ({ d: String(b.t).slice(0, 10), o: b.o, c: b.c })), "2016-01-01");
  const mOn = mean(H.map((h) => h.net)), mId = mean(H.map((h) => h.intraday));
  const rule = (rows) => { const sp = rows.map((r) => r.spread), t = nwT(sp), h = N / 2; return mean(sp) > 0 && t >= BAR && mean(sp.slice(0, h)) > 0 && mean(sp.slice(h)) > 0 && mean(rows.map((r) => r.net)) > 0; };
  const draw = (r2, demean) => { const out = []; while (out.length < N) { const s = Math.floor(r2() * (H.length - 20)); for (let j = 0; j < 20 && out.length < N; j++) { const h = H[s + j]; const net = demean ? h.net - mOn : h.net, intr = demean ? h.intraday - mId : h.intraday; out.push({ net, spread: net - intr }); } } return out; };
  const r2 = mulberry(3250); let fpNull = 0, pw = 0; const W = 4000;
  for (let k = 0; k < W; k++) { if (rule(draw(r2, true))) fpNull++; if (rule(draw(r2, false))) pw++; }
  const calib = { worlds: W, falsePassPct: +(100 * fpNull / W).toFixed(2), powerAtHistoryPct: +(100 * pw / W).toFixed(1), historyNights: H.length,
    historySpreadBps: +(mean(H.map((h) => h.spread)) * 1e4).toFixed(2), historySpreadT: +nwT(H.map((h) => h.spread)).toFixed(2), historyOvernightNetBps: +(mOn * 1e4).toFixed(2), historyIntradayBps: +(mId * 1e4).toFixed(2) };
  if (calib.falsePassPct > 5) { console.error(`R325 whole-rule false pass ${calib.falsePassPct}% > 5% — not registering`); process.exit(3); }
  reg.preregistered.push({
    id: "R325", registered: TODAY,
    name: "Gold overnight, forward — GLD's overnight leg (close to next open, 2 bps a night) minus its next intraday leg, quote-priced nightly from 2026-10-05",
    status: `REGISTERED ${TODAY} — forward, quote-priced; writer backend/r325-gold-overnight-forward.js (close chain); read at ${N} nights (~2029-09)`, script: "backend/r325-gold-overnight-forward.js",
    parent: "R214 (sealed PASS 2026-09-25, monthly t 2.919 vs 2.288). Its audit the same day (data/r212-r214-audit.json): alpha on GLD t 0.84, beta 0.53; overnight CAGR 9.1% vs holding GLD 13.8% — the overnight leg is mostly gold's own direction. Operator 2026-10-05 'go 1-3' after the assistant listed R214 among the best results (the audit caveat was missed in that list and is corrected here).",
    multiplicityFamily: "GOLD-OVERNIGHT — R325 alone; the rule is R214's verbatim; the statistic changes from R214's overnight return to the overnight-minus-intraday spread, chosen before evidence because of R214's audit. Single variant.",
    evidenceStart: "the night that begins at the 2026-10-05 close (scored on the 2026-10-07 evening, once the 10-06 bar is final)",
    rule: "Each night d from 2026-10-05: OVERNIGHT net = open(next session)/close(d) - 1 - 0.0002 (R214's 1 bp a side); INTRADAY = close(next session)/open(next session) - 1; SPREAD = OVERNIGHT net - INTRADAY. Prices: Alpaca SIP daily bars, adjustment all (R214's source). A weekend/holiday gap is one night. A session's bar is used only from a later ET date (final). Quote-priced; no orders.",
    statistic: "Unit: NIGHT. Mean nightly SPREAD; Newey-West t (lag 5). Reported: overnight net alone (R214's quantity), the intraday leg, win rate, SPY and SLV overnight legs, and the anytime-valid e-value of the spread (lib/evalue.js bettingE; reported, never gates).",
    unit: "nights", nExpected: N,
    controls: {
      calibration: `Whole decision rule on ${W} no-edge worlds (R214's 2016-2026 nights in 20-night blocks with both legs demeaned): false pass ${calib.falsePassPct}% (<= 5% required).`,
      history: `R214's window as seen at registration: spread ${calib.historySpreadBps} bps/night NW t ${calib.historySpreadT}; overnight net ${calib.historyOvernightNetBps} bps; intraday ${calib.historyIntradayBps} bps over ${calib.historyNights} nights.`,
      placebo: "the intraday leg is the in-test control (same instrument, same days); SPY's overnight leg is reported as the known equity overnight premium, not a gate.",
    },
    bar: { fixedInAdvance: true, unit: "nights", tRequired: BAR, variants: 1, statistic: "Newey-West t, lag 5", source: `max(NW lag-5 sim n=${N} seed 325 p95 ${nw}, nullBar n=${N} p95 ${iid})` },
    interimKill: `ONE look at the first run with >= ${KILL_N} nights (~2027-10): spread NW t <= -2.0 -> the record stops and the operator is alerted. Kill only; adjudicates nothing.`,
    decisionRule: {
      pass: `PASS only if >= ${N} nights AND spread mean > 0 AND spread NW t >= ${BAR} AND both halves' spread means > 0 AND overnight net mean > 0. A PASS proposes a paper GLD overnight sleeve (DAY orders, buy near the close, sell at the open) whose first registered question is execution shortfall; nothing is funded or sized by this test.`,
      fail: "DID NOT PASS: the overnight-over-intraday gold effect is not confirmed out of sample. Low power is the expected reason (see knownWeaknesses); the result is recorded as not confirmed, not as disproven, and R214 stays a sealed historical PASS whose audit says it is mostly gold beta.",
      cannotMeasure: `CANNOT MEASURE if fewer than ${N} scored nights exist by 2030-03-31 (the writer stopped).`,
    },
    knownWeaknesses: [
      `UNDER-POWERED BY DESIGN: at R214's own historical rate the whole rule passes in ${calib.powerAtHistoryPct}% of block draws at ${N} nights; at 250 nights the expected t is ~0.66. A year of forward data cannot confirm a 4 bps/night effect with ~97 bps nightly spread volatility. The interim look can only catch a clearly reversed effect.`,
      "Quote-priced at official open and close prints; a paper or real execution buys before the close and sells into the open auction, and that shortfall is not measured here (a PASS's first follow-up).",
      "The spread is a statistic, not a held position: shorting GLD intraday is not proposed; it removes gold's direction from the comparison.",
      "Rule and data source are R214's; the 2016-2026 window is spent and only calibrates the bar and the power figure.",
      "Gold's 2024-2026 run carried most of R214's recent overnight return (2025 +14.5 bps/night); a calmer gold tape forward will read near zero on the overnight leg whatever the spread does.",
    ],
    readCondition: `--read once at >= ${N} nights after the selftest.`,
    writerExists: true, writerNote: "backend/r325-gold-overnight-forward.js --score in the close chain, nightly; ledger data/r325-ledger.jsonl",
    ip: "Ours: public market data; R214's rule.",
    calibration: calib,
  });
  reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
  cr.push({ date: TODAY, area: "registry — R325 gold overnight forward", category: "registration", breaksComparability: false, change: `Registered R325: R214's GLD close-to-open rule forward from 2026-10-05, quote-priced; primary = overnight net minus next intraday leg (R214's audit found the overnight leg mostly gold beta); NW lag-5 t bar ${BAR} at ${N} nights; one interim kill look at ${KILL_N}; whole-rule false pass ${calib.falsePassPct}%, power at history ${calib.powerAtHistoryPct}%.`, why: "Operator 2026-10-05: 'go 1-3'.", doesNotEstablish: "Any forward result; R214's historical PASS is unchanged.", operator: "Josh 2026-10-05" });
  writeJsonAtomic(D("change-registry.json"), cr);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R325"], family: "GOLD-OVERNIGHT" }) + "\n");
  console.log(`R325 registered · bar ${BAR} (NW ${nw}, iid ${iid}) · ${JSON.stringify(calib)}`);
})().catch((e) => { console.error("R325 registration FAILED: " + e.message); process.exit(1); });
