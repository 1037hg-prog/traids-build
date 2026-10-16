#!/usr/bin/env node
/**
 * R86 — NOISE-SCALED RATCHET. Registered 2026-09-01, evidence from 2026-09-02.
 * Writes data/r86-noise-ratchet.json. Graded SEPARATELY for equity and crypto, never pooled.
 *
 * THE RULE, frozen at registration: arm the ratchet floor at the first favourable excursion that
 * places the floor at least K x NOISE outside the entry, where NOISE is the median 1-minute bar
 * range over the ticket's hold SO FAR (never the full hold — that would look ahead) and K = 4.
 * Thereafter the floor trails the operator's integer-R ladder. REFUSE to arm on any ticket where
 * more than 20% of its 1-minute bars carry h == l.
 *
 * WHY IT IS EXPRESSED IN NOISE RATHER THAN IN R. A fixed-R floor means something different on every
 * instrument, because R comes from entry logic and has nothing to do with how much the thing wiggles.
 * On 2026-09-01 that showed up as a monotonic harm gradient in exactly this ratio: delta -0.8010 at
 * 1-2x the instrument's noise, -0.1933 at 2-4x, -0.0269 at 4-8x. Crypto sits at a median 5.36 and
 * supplied 11 of the 12 tickets in the worst bucket; equities put the same floor much further out.
 * Same rule, opposite outcomes — which is why this grades the two classes separately.
 *
 * WHY THE LIQUIDITY SCREEN IS PART OF THE RULE, not hygiene. The only bucket where the ratchet
 * turned positive (>8x, +0.0699) is where the degenerate names live: 46% of tickets had a median
 * 1-minute range of ZERO and 44.5% of minutes carried no trade at all. A ratchet "works" on a name
 * that barely trades, which is true and worthless because it could not be filled. The screen removes
 * precisely that population, which means this test runs on ground the motivating sample barely
 * covered — and the honest prior is therefore that it FAILS.
 *
 * BAR: paired t >= 3.125 at >= 30 sessions per class, best-of-20 from lib/null-bar.js. Twenty
 * because the rule came out of a seven-way search run in one sitting (12 fixed-R arms, 5 noise
 * buckets, 3 population splits) and K = 4 was read off that gradient. The family is the whole
 * search, not the one rule that survived it.
 *
 * Nightly in the close chain. Shadow only — proposes nothing, changes no exit, trades nothing.
 */
const fs = require("fs"), path = require("path");
const R = require("./lib/reconcile.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);

const EVIDENCE_START = "2026-09-02";
const K = 4;                       // noise multiples the floor must sit outside entry
const MAX_EMPTY_BAR_FRAC = 0.20;   // liquidity screen: >20% h==l minutes and the ticket is refused
const BAR = { pairedT: 3.125, minSessions: 30, interimT: -2.0, interimSessions: 16 };
const INT = Array.from({ length: 9 }, (_, i) => [i + 1, i]);

const ms = (v) => (typeof v === "number" ? v : Date.parse(v));
const etDay = (v) => new Date(ms(v)).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

/**
 * Replay one ticket under R86. Returns null if the liquidity screen refuses it — refused tickets
 * are EXCLUDED and counted, never scored as if the rule had been neutral on them.
 */
function replay(t, bars) {
  const empty = bars.filter((b) => b.h === b.l).length / bars.length;
  if (empty > MAX_EMPTY_BAR_FRAC) return null;

  const dir = Math.sign(t.dir) || 1, sd = t.stopDist, stop0 = t.entry - dir * sd;
  let floorR = null;
  const seen = [];
  for (const b of bars) {
    seen.push((b.h - b.l) / t.entry);
    if (floorR === null) {
      if (dir > 0 ? b.l <= stop0 : b.h >= stop0) return { r: -1, exit: "stop" };
    } else {
      const fp = t.entry + dir * sd * floorR;
      if (dir > 0 ? b.l <= fp : b.h >= fp) return { r: floorR, exit: "ratchet" };
    }
    // NOISE IS HOLD-TO-DATE, never the full hold — the full-hold median would use bars the decision
    // could not have seen, which is the look-ahead this whole apparatus exists to refuse.
    const noise = median(seen) * t.entry;
    const favR = (((dir > 0 ? b.h : b.l) - t.entry) * dir) / sd;
    let next = floorR;
    for (const [armAt, fl] of INT) {
      if (favR < armAt) continue;
      if (noise > 0 && fl * sd < K * noise) continue;   // floor would sit inside K x noise — refuse this rung
      if (next === null || fl > next) next = fl;
    }
    floorR = next;
  }
  return { r: t.rMult, exit: "actual" };
}

const cache = (() => { try { return JSON.parse(fs.readFileSync(D("equity-ratchet-bars.json"), "utf8")); } catch { return {}; } })();
const s = R.cleanEraLedger();
const tickets = [...(s.signals || [])].filter((r) =>
  (r.cls === "Equity" || r.cls === "Crypto") && Number.isFinite(r.rMult) && Number.isFinite(r.entry) &&
  Number.isFinite(r.stopDist) && r.stopDist > 0 && r.openedAt && r.closedAt && r.sym &&
  etDay(r.closedAt) >= EVIDENCE_START);

/**
 * ARM-REACH ELIGIBILITY (registry amendment 2026-09-01, pre-evidence).
 *
 * A sleeve enters the population only once it has SHOWN it produces runners: >= 10% of its tickets
 * reaching the arm threshold, on >= 30 tickets. Without this, 8 of 10 sleeves contribute tickets on
 * which the rule can never fire — Trend/Equity reaches 1R on 0.9% of 111, Ensemble/Equity on 1.7%
 * of 232 — and a null result becomes uninterpretable: "the ratchet does nothing" and "the ratchet
 * never got the chance" would look identical.
 *
 * MEASURED FORWARD, DELIBERATELY. The clean-era record would qualify exactly one sleeve comfortably,
 * Breakout/Crypto at 88.9% reach — which is the same 18-ticket population whose P&L is 96% two
 * crypto rally days (R44). Fitting eligibility to that history would hand ratchet authority to a
 * regime artifact. Each sleeve therefore earns eligibility on its own accruing forward record.
 */
const MIN_ARM_REACH = 0.10, MIN_REACH_TICKETS = 30;
// DIRECTION IS PART OF THE SLEEVE KEY: longs reach 1R on 8.0% of tickets and shorts on 3.2%,
// so a pooled gate would qualify a sleeve on its longs and admit shorts that can never arm.
const sleeveOf = (t) => (t.strategy || "?") + "|" + (t.cls || "?") + "|" + ((Math.sign(t.dir) || 1) > 0 ? "LONG" : "SHORT");
/**
 * REACH TABLE MOVED TO PRE-EVIDENCE HISTORY (operator instruction, 2026-09-04).
 * It was computed over `tickets` — the EVIDENCE WINDOW ITSELF — which made the gate unsatisfiable
 * by construction: the window held 42 tickets across 8 strategy|class|direction buckets with a
 * LARGEST bucket of n=16 against an n>=30 requirement, so no sleeve could ever qualify and the
 * test read 0 scored / 0 of 30 sessions with no path to ever accruing.
 * It now reads the clean era STRICTLY BEFORE evidenceStart. That is not look-ahead: every row
 * predates the test's own evidence window, so the screen is point-in-time and is frozen the
 * moment evidence begins.
 * MEASURED on that history (733 rows; 8 buckets at n>=30): exactly TWO sleeves qualify —
 * Trend|Crypto|LONG 11.1% (n=81) and Mean-Reversion|Equity|SHORT 10.8% (n=37) — both marginal
 * against the 10.0% threshold. The other six run 7.0% down to 0.0%. Whole-book reach to +1R is
 * 5.9% (longs 7.7%, shorts 3.1%).
 * DISCLOSED: this CHANGES R86's population from empty to two sleeves. Made BEFORE the test had
 * accrued any evidence (0 scored to date), so no accrued result is restated. K, the noise
 * definition, the liquidity screen, the ladder and the bar are ALL untouched. Registrar review
 * requested — if this reads as amending a registered rule rather than repairing an input, revert
 * to the prior line (`for (const t of tickets)`) and leave R86 dormant.
 */
const reachPop = [...(s.signals || [])].filter((r) =>
  (r.cls === "Equity" || r.cls === "Crypto") && Number.isFinite(r.mfe) &&
  r.closedAt && etDay(r.closedAt) < EVIDENCE_START);
const reach = {};
for (const t of reachPop) {
  const k = sleeveOf(t);
  (reach[k] ||= { n: 0, hit: 0 });
  reach[k].n++;
  if (Number.isFinite(t.mfe) && t.mfe >= 1) reach[k].hit++;
}
const eligible = (k) => {
  const r = reach[k];
  return !!r && r.n >= MIN_REACH_TICKETS && r.hit / r.n >= MIN_ARM_REACH;
};

const byClass = { Equity: [], Crypto: [] };
let noPath = 0, refused = 0, ineligible = 0;
for (const t of tickets) {
  // 2026-09-03 (vintage lens): the entry MINUTE's own bar can hold prints from before the fill; start the path at the
  // first bar strictly after the entry timestamp so a pre-entry excursion cannot register a phantom instant stop.
  const bars = (cache[t.sym] || []).filter((b) => b.t > ms(t.openedAt) && b.t <= ms(t.closedAt));
  if (bars.length < 20) { noPath++; continue; }
  if (!eligible(sleeveOf(t))) { ineligible++; continue; }
  const res = replay(t, bars);
  if (!res) { refused++; continue; }
  byClass[t.cls].push({ day: etDay(t.openedAt), actual: t.rMult, arm: res.r, exit: res.exit });
}

const readClass = (rows) => {
  const by = {};
  for (const r of rows) (by[r.day] ||= []).push(r);
  const days = Object.keys(by).sort();
  const deltas = days.map((d) => mean(by[d].map((r) => r.arm - r.actual)));
  if (deltas.length < 2) return { sessions: deltas.length, tickets: rows.length, delta: null, t: null, deltas: deltas.map((x) => +x.toFixed(4)) };
  const mu = mean(deltas);
  const sd = Math.sqrt(deltas.reduce((x, y) => x + (y - mu) ** 2, 0) / (deltas.length - 1));
  return { sessions: deltas.length, tickets: rows.length, delta: +mu.toFixed(4),
    t: sd > 0 ? +(mu / (sd / Math.sqrt(deltas.length))).toFixed(3) : null,
    sessionsBetter: deltas.filter((x) => x > 0).length,
    armMeanR: +mean(rows.map((r) => r.arm)).toFixed(4), baselineR: +mean(rows.map((r) => r.actual)).toFixed(4),
    deltas: deltas.map((x) => +x.toFixed(4)) };
};

const verdict = (r) => {
  if (r.sessions >= BAR.minSessions)
    return r.t != null && r.t >= BAR.pairedT
      ? `CLEARS — paired t ${r.t} >= ${BAR.pairedT} at ${r.sessions} sessions; PROPOSED to the operator, never auto-applied and never generalised to the other class`
      : `DID NOT PASS — paired t ${r.t} at ${r.sessions} sessions against ${BAR.pairedT}`;
  if (r.sessions >= BAR.interimSessions && r.t != null && r.t <= BAR.interimT) return `KILLED at interim — t ${r.t}`;
  return `ACCRUING — ${r.sessions}/${BAR.minSessions} sessions`;
};

const eq = readClass(byClass.Equity), cr = readClass(byClass.Crypto);
const out = {
  spec: "r86-noise-ratchet-v1", testId: "R86", asOf: new Date().toISOString(),
  registered: "2026-09-01", evidenceStart: EVIDENCE_START, K, maxEmptyBarFrac: MAX_EMPTY_BAR_FRAC, bar: BAR,
  rule: `Arm the floor at the first excursion placing it >= ${K}x the ticket's hold-to-date median 1-minute range outside entry, then trail the integer-R ladder. Refuse tickets with >${MAX_EMPTY_BAR_FRAC * 100}% empty minutes.`,
  coverage: { inWindow: tickets.length, scored: byClass.Equity.length + byClass.Crypto.length,
    refusedByLiquidityScreen: refused, noPath, ineligibleSleeve: ineligible,
    armReachBySleeve: Object.fromEntries(Object.entries(reach).map(([k, v]) => [k, { n: v.n, reachPct: +(100 * v.hit / v.n).toFixed(1), eligible: eligible(k) }])), note: "refused and unpathed tickets are EXCLUDED and counted — never scored as neutral" },
  equity: { ...eq, verdict: verdict(eq) },
  crypto: { ...cr, verdict: verdict(cr) },
  // 2026-09-10 (coverage-mechanic): graded PER CLASS (never pooled -- see neverPooled below), so the
  // clock's single "sessions" is the BOTTLENECK class -- the test cannot clear until BOTH classes
  // reach BAR.minSessions. estimate is left null (there are two t-values, not one); both are named.
  dailyClock: { sessions: Math.min(eq.sessions, cr.sessions), estimate: null,
    unit: `sessions per class (graded separately; bar requires paired t >= ${BAR.pairedT} at ${BAR.minSessions} sessions EACH)`,
    byClass: { equity: { sessions: eq.sessions, estimate: eq.t }, crypto: { sessions: cr.sessions, estimate: cr.t } },
    sessionMeans: { equity: eq.deltas || [], crypto: cr.deltas || [] } },
  neverPooled: "Equity and crypto are read separately. Pooling them is the defect that inverted the 2026-09-01 retrospective before the class split exposed it.",
  status: "REGISTERED FORWARD TEST — shadow only; changes no exit, proposes nothing until a class clears its bar.",
};
writeJsonAtomic(D("r86-noise-ratchet.json"), out);

console.log(`\nR86 NOISE-SCALED RATCHET — K=${K} · evidence from ${EVIDENCE_START} · bar paired t >= ${BAR.pairedT} at ${BAR.minSessions} sessions/class`);
console.log(`  in window ${tickets.length} · scored ${out.coverage.scored} · ineligible sleeve ${ineligible} · refused by liquidity ${refused} · no 1m path ${noPath}`);
// print the screen itself: a starved gate must never again be mistaken for a missing-path problem
console.log(`  reach screen (pre-${EVIDENCE_START} history, n=${reachPop.length}) — * = arms: ` +
  (Object.entries(reach).filter(([, r]) => r.n >= MIN_REACH_TICKETS)
    .sort((a, b) => b[1].hit / b[1].n - a[1].hit / a[1].n)
    .map(([k, r]) => `${k} ${(100 * r.hit / r.n).toFixed(1)}%${r.hit / r.n >= MIN_ARM_REACH ? "*" : ""}`)
    .join(" · ") || `(no bucket reaches n>=${MIN_REACH_TICKETS})`));
for (const [k, r] of [["EQUITY", eq], ["CRYPTO", cr]])
  console.log(`  ${k.padEnd(7)} ${String(r.tickets).padStart(4)} tickets / ${String(r.sessions).padStart(3)} sessions · delta ${r.delta == null ? "n/a" : (r.delta >= 0 ? "+" : "") + r.delta} · t ${r.t ?? "n/a"}\n          ${verdict(r)}`);
console.log("  SHADOW ONLY — changes no exit.\nwritten: data/r86-noise-ratchet.json\n");
