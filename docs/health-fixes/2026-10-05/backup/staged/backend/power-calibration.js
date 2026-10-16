#!/usr/bin/env node
/**
 * POWER & CALIBRATION — can this apparatus SEE an edge if one is there? (2026-09-09)
 *
 * WHY THIS EXISTS. Three independent adversarial reviews of the 2026-09-09 packet agreed that the
 * accumulated evidence favours "no demonstrated net edge". The third one made the sharper point: that
 * conclusion is only worth anything if the measurement stack can DETECT an effect of the size worth
 * having. Two worlds produce identical-looking result tables —
 *
 *     H1  there IS a modest edge and the apparatus is killing it (bars, clustering, cost, N)
 *     H2  there is no sufficient net edge
 *
 * — and no amount of staring at negative results distinguishes them. The reviewer's answer, which I
 * accept: distinguish them with CALIBRATION and POWER, never with intuition, and never by loosening
 * a bar until something survives.
 *
 * WHAT IT COMPUTES, on the canonical ledger only (lib/reconcile.js — analysis code never picks a
 * ledger source), with the house statistic: session-clustered mean R, sessions as the unit.
 *
 *   1. NULL CALIBRATION. Two nulls that actually randomise the statistic (see the long note at the
 *      nulls themselves — the obvious within-day permutation is a NO-OP here and reported a 0.00%
 *      false-positive rate before that was caught). Measures the realised false-positive rate at the
 *      registered bar. If it is not ≈5%, the bar is wrong in a specific, checkable way, and that is
 *      exactly the kind of evidence that should move the capital call.
 *
 *   2. POWER CURVE. For a menu of true effect sizes, resample the OBSERVED session dispersion
 *      recentred on that effect and measure how often it clears. This asks: if the book really did
 *      earn +0.02R per ticket, how often would this apparatus notice?
 *
 *   3. MINIMUM DETECTABLE EFFECT at the current session count, and the SESSIONS REQUIRED to reach
 *      80% power at each effect size. The headline number: if the MDE is far above any plausible
 *      edge, then "no edge demonstrated" is substantially "cannot tell yet", and saying otherwise
 *      overstates what the negative results mean.
 *
 * IT PROVES NOTHING ABOUT ANY STRATEGY. It measures the instrument, not the market. A good result
 * here does not make an edge exist; a bad result here does not make one appear.
 *
 * Usage: node backend/power-calibration.js [--trials 4000] [--json] [--force] [--gate-only [--now <ISO>]]
 */
const path = require("path");
const R = require("./lib/reconcile.js");
const { nullBar } = require("./lib/null-bar.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
const TRIALS = arg("--trials", 4000);
const JSON_OUT = argv.includes("--json");
const EFFECTS = [0.005, 0.01, 0.02, 0.05, 0.10];   // R per ticket; the hurdle in use is ~+0.012R
const TARGET_POWER = 0.80;

/**
 * WEEKLY, NOT NIGHTLY (2026-09-09). This is a bootstrap over every session for every effect size and
 * then again per sleeve; it costs a couple of minutes, and the answer moves only as fast as the
 * session count does — one more session cannot meaningfully change an MDE built on 35. So it self-
 * skips six days a week, the same convention the full backup tier uses. --force runs it any day.
 *
 * FRIDAY, NOT SUNDAY (2026-10-05, health sweep BK4). This gate said Sunday, but the close chain runs Monday-Friday only, so
 * the chain never ran this at all: the last measurement was 09-09 while chain-status showed "power calibration (Sun)" ok
 * every night. Same defect and same fix as the chain's onlyOn:0 -> 5 move on 2026-09-27. The chain now declares onlyOn: 5
 * for this step; this gate is the second lock. The chain takes its weekday once, at its own start, so a Friday chain that
 * ran past midnight ET still counts as Friday until 12:00 ET Saturday. --gate-only [--now <ISO>] prints the decision and
 * exits before reading anything ("will it run tonight?").
 */
function weeklyGateET(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
  return { due: p.weekday === "Fri" || (p.weekday === "Sat" && Number(p.hour) < 12), dow: p.weekday };
}
if (argv.includes("--gate-only")) {
  const ni = argv.indexOf("--now"), now = ni >= 0 ? new Date(argv[ni + 1]) : new Date();
  if (Number.isNaN(now.getTime())) { console.log("power-calibration gate: UNKNOWN — --now is not a date"); process.exit(2); }
  const g = weeklyGateET(now);
  console.log(`power-calibration gate: ${g.due ? "RUN" : "SKIP"} (${g.dow} ET)`);
  process.exit(0);
}
if (!argv.includes("--force") && !JSON_OUT) {
  const g = weeklyGateET(new Date());
  if (!g.due) { console.log(`  power-calibration: ${g.dow} — weekly job, runs Fridays (use --force to run now)`); process.exit(0); }
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => { const s = sd(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : NaN; };
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// ── the population: canonical, settled, signal rows with a finite R ──────────
const L = R.cleanEraLedger();
const rows = (L.signals || []).filter((t) => Number.isFinite(t.rMult) && Number.isFinite(t.openedAt));
// Tests key by OPEN date — the dashboard's close-date view once turned 45 tickets opened in one
// instant into a "best day", and that lesson is why this is explicit here.
for (const t of rows) { t._day = etDay(t.openedAt); t._dir = t.dir >= 0 ? 1 : -1; }

/**
 * NET OF COST, NOT GROSS (2026-09-09, second cost pass).
 *
 * The ledger's rMult is ((exit - entry) * dir) / stopDist. There is NO cost term in it — confirmed
 * at the settle write in src/App.jsx and independently by cost-model.js, which reads that same field
 * and labels it grossAvgR. So every registered test on this board, and the first version of this
 * file, measured a PRE-COST quantity. Worse, this file then graded it against a hurdle derived from
 * a NET dollar target ($500-1000/day). Gross statistic, net hurdle: the two are not comparable and
 * the mismatch flattered the book by the entire cost of trading it.
 *
 * Charging the per-class cost the model already computes moves the whole book from -0.0174R
 * (t -0.84, inside the detection floor, 'cannot tell') to -0.0628R (t -2.94, OUTSIDE the floor,
 * decided). That is not a small correction; it is the difference between an open question and an
 * answered one.
 *
 * OPTIONS ARE UNCOSTED. 327 tickets, 25% of the book, have no entry in netEdgeByClass at all, so
 * they are charged ZERO here. That FAVOURS the book: options carry the widest spreads of anything
 * traded, so the true net is worse than what this prints. Charging them the book's weighted mean
 * instead gives -0.0777R at t -3.68. The zero is the conservative choice and it is disclosed rather
 * than hidden.
 */
const COSTR = (() => { try { return JSON.parse(require("fs").readFileSync(path.join(__dirname, "data", "cost-model.json"), "utf8")).netEdgeByClass || {}; } catch { return {}; } })();
const GROSS = process.argv.includes("--gross");   // escape hatch for comparing against the old reads
const costOf = (t) => (GROSS ? 0 : ((COSTR[t.cls] || {}).meanCostR || 0));
const uncostedClasses = [...new Set(rows.filter((t) => !(COSTR[t.cls] || {}).meanCostR).map((t) => t.cls))];
const uncostedTickets = rows.filter((t) => !(COSTR[t.cls] || {}).meanCostR).length;
// rMult is REPLACED in place so every statistic below - session means, nulls, power, per-sleeve -
// reads the same net quantity. The canonical ledger on disk is untouched.
for (const t of rows) { t._grossR = t.rMult; t.rMult = t.rMult - costOf(t); }
if (!GROSS && uncostedTickets) console.log(`  cost: per-class from cost-model.json · UNCOSTED: ${uncostedTickets} tickets in ${uncostedClasses.join(", ")} charged ZERO (favours the book)`);
if (GROSS) console.log("  --gross: cost NOT charged. This reproduces the pre-2026-09-09 reads and is not the decision statistic.");

// HOUSE RULE (2026-09-09 audit): re-derive against the canonical ledger before computing anything.
// Checked on the GROSS field, because that is what the canonical figure is.
R.assertReconciled("power-calibration signal tickets", rows.length, L.n);
R.assertReconciled("power-calibration mean R per ticket (gross)", +mean(rows.map((t) => t._grossR)).toFixed(4), L.meanR);

const byDay = {};
for (const t of rows) (byDay[t._day] ||= []).push(t);
const days = Object.keys(byDay).sort();
// A session is a CLUSTER, not a datum. Two outage days holding 1 and 2 tickets were driving 57% of
// the dispersion that sets the MDE. Guard them, and say how many were dropped — never silently.
const MIN_TICKETS = 3;
const keptDays = days.filter((d) => byDay[d].length >= MIN_TICKETS);
const droppedDays = days.filter((d) => byDay[d].length < MIN_TICKETS).map((d) => `${d} (n=${byDay[d].length})`);
const sessionMeans = keptDays.map((d) => mean(byDay[d].map((t) => t.rMult)));
const K = sessionMeans.length;
const BAR = nullBar({ variants: 1, n: K, trials: 20000 }).p95;

/**
 * ── 1. NULL CALIBRATION ──────────────────────────────────────────────────────
 *
 * A BUG WORTH KEEPING IN THE COMMENT. The first version of this permuted outcomes WITHIN day x
 * direction — the house rule, correctly quoted from lib docs — and then took each day's MEAN. But
 * reordering numbers inside a day cannot change that day's mean: the null had zero variance, the
 * realised false-positive rate came out 0.00%, and the "null p95" was numerically identical to the
 * observed statistic. The within-day rule exists to protect statistics computed on TICKETS; applied
 * to a statistic computed on SESSION MEANS it is a no-op. The null must randomise the thing the
 * statistic is actually a function of.
 *
 * So two nulls, neither of them a no-op, and they answer different questions:
 *
 *   SIGN-FLIP — flip each session mean's sign at random. The null is "session effects are symmetric
 *   about zero". This is the randomisation test that matches the statistic exactly, and it is the
 *   primary calibration number.
 *
 *   CROSS-DAY — shuffle ticket outcomes across days WITHIN DIRECTION, preserving each day's size and
 *   direction composition, then re-form session means. The null is "there is no day-level structure".
 *   Direction is held because a direction-blind null once certified an effect that was pure long/short
 *   asymmetry, and that lesson stands.
 */
function signFlipT() {
  return tOf(sessionMeans.map((m) => (Math.random() < 0.5 ? -m : m)));
}
const dirPool = { 1: [], "-1": [] };
for (const t of rows) dirPool[t._dir].push(t.rMult);
function crossDayT() {
  const pool = { 1: dirPool[1].slice(), "-1": dirPool["-1"].slice() };
  for (const k of ["1", "-1"]) { const a = pool[k]; for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } }
  const idx = { 1: 0, "-1": 0 };
  return tOf(keptDays.map((d) => mean(byDay[d].map((t) => pool[t._dir][idx[t._dir]++]))));
}
function calibrate(fn) {
  const ts = [];
  for (let i = 0; i < TRIALS; i++) { const t = fn(); if (Number.isFinite(t)) ts.push(t); }
  ts.sort((a, b) => a - b);
  return { trials: ts.length, fpr: ts.filter((t) => t >= BAR).length / ts.length, p95: ts[Math.floor(0.95 * ts.length)] };
}
const signFlip = calibrate(signFlipT), crossDay = calibrate(crossDayT);
const fpr = signFlip.fpr, empiricalP95 = signFlip.p95;

// ── 2. POWER — resample the OBSERVED session dispersion, recentred on a true effect ──
const centred = sessionMeans.map((m) => m - mean(sessionMeans));
function powerAt(effect, n) {
  let clears = 0;
  for (let i = 0; i < TRIALS; i++) {
    const s = [];
    for (let k = 0; k < n; k++) s.push(centred[(Math.random() * K) | 0] + effect);
    if (tOf(s) >= BAR) clears++;
  }
  return clears / TRIALS;
}
const powerNow = EFFECTS.map((e) => ({ effectR: e, powerAtCurrentN: +powerAt(e, K).toFixed(3) }));

// sessions needed for 80% power — coarse search, then refine
function sessionsFor(effect) {
  let lo = 5, hi = 4000;
  if (powerAt(effect, hi) < TARGET_POWER) return null;
  while (hi - lo > 5) { const mid = ((lo + hi) / 2) | 0; if (powerAt(effect, mid) >= TARGET_POWER) hi = mid; else lo = mid; }
  return hi;
}
for (const p of powerNow) p.sessionsFor80pct = sessionsFor(p.effectR);

/**
 * ── 3. MINIMUM DETECTABLE EFFECT ─────────────────────────────────────────────
 * Power is monotone in the effect size, so bisect rather than scanning upward in 0.001 steps: the
 * scan cost ~300 bootstrap sweeps per group, which made the per-sleeve mode unusable. ~14 sweeps.
 */
function mdeFor(centredMeans, n, trials = TRIALS) {
  const p = (e) => { let c = 0; for (let i = 0; i < trials; i++) { const s = []; for (let k = 0; k < n; k++) s.push(centredMeans[(Math.random() * centredMeans.length) | 0] + e); if (tOf(s) >= BAR_FOR(n)) c++; } return c / trials; };
  if (p(0.30) < TARGET_POWER) return null;                 // not detectable anywhere in a sane range
  let lo = 0, hi = 0.30;
  for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (p(mid) >= TARGET_POWER) hi = mid; else lo = mid; }
  return +hi.toFixed(3);
}
const BAR_CACHE = new Map();
function BAR_FOR(n) { if (!BAR_CACHE.has(n)) BAR_CACHE.set(n, nullBar({ variants: 1, n, trials: 8000 }).p95); return BAR_CACHE.get(n); }
BAR_CACHE.set(K, BAR);
const mde = mdeFor(centred, K);

/**
 * ── 3b. WHERE THE DISPERSION LIVES ───────────────────────────────────────────
 *
 * The MDE is set by the standard deviation of the SESSION MEANS, so the only ways to improve it are
 * more sessions or less dispersion. This says which kind of dispersion there is to attack.
 *
 *   var(session means) = within-session ticket variance / tickets-per-session   [sampling]
 *                      + common between-session variance                        [the market]
 *
 * If the sampling term dominates, trading MORE per session sharpens the instrument. If the common
 * term dominates, it does not — those tickets are one bet wearing many hats, and only removing the
 * shared factor helps. This is the same fact the loss-tail work found from the other side, where a
 * -66.85R tail turned out to be 81% correlated exposure rather than selection.
 */
/**
 * JENSEN, 2026-09-09 (audit). The first version computed the sampling term as mean(v_d)/mean(n_d).
 * That is not the sampling contribution to var(session means) — the correct form is mean(v_d / n_d),
 * and with day sizes running 1..87 the difference is not cosmetic: the shipped form reported the
 * sampling term at 14.5% of the variance when it is roughly HALF, and on that basis the tool told
 * the operator that "trading more per session cannot help". It does help. The two terms also used
 * different day sets (withinV excluded n=1 days, nbar included them), which compounded it.
 */
const usableDays = days.filter((d) => byDay[d].length >= MIN_TICKETS);
const nbar = mean(usableDays.map((d) => byDay[d].length));
const samplingV = mean(usableDays.map((d) => { const a = byDay[d].map((t) => t.rMult), m = mean(a); return (a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) / a.length; }));
const totalV = sessionMeans.reduce((s, x) => s + (x - mean(sessionMeans)) ** 2, 0) / (K - 1);
const betweenV = Math.max(0, totalV - samplingV);
const hedgeGain = samplingV > 0 ? Math.sqrt(totalV / samplingV) : null;
/**
 * THE HURDLE WAS AN UNSOURCED LITERAL (2026-09-09, audit). 0.012R appeared nowhere else in the
 * repository: no registry entry, no derivation. The REGISTERED hurdle is test-registry.json
 * standingHurdle — $500-1000 net per trading day, in the operator's own words. Translated at the
 * book's realised deployed risk that is roughly +0.030R to +0.061R per ticket, two to five times
 * the literal it replaced. Grading an MDE against a made-up denominator is how an apparatus talks
 * itself into believing it is blind: against 0.012 the instrument looked 10x short, against the
 * hurdle the operator actually registered it sits inside the band.
 */
const REG = (() => { try { return JSON.parse(require("fs").readFileSync(path.join(__dirname, "data", "test-registry.json"), "utf8")).standingHurdle; } catch { return null; } })();
const riskPerSession = (() => {
  const withRisk = rows.filter((t) => Number.isFinite(t.pnl) && Number.isFinite(t.rMult) && t.rMult !== 0);
  return withRisk.reduce((s, t) => s + Math.abs(t.pnl / t.rMult), 0) / days.length;
})();
const band = (REG && REG.target && REG.target.netProfitPerTradingDayUSD) || [500, 1000];
const HURDLE = {
  source: REG ? "test-registry.json standingHurdle (operator, registered 2026-08-25)" : "FALLBACK — registry unreadable",
  dollarsPerSessionBand: band,
  deployedRiskPerSessionUSD: +riskPerSession.toFixed(0),
  lo: +(band[0] / riskPerSession).toFixed(4),
  hi: +(band[1] / riskPerSession).toFixed(4),
  note: "R per ticket the book must earn to net the registered dollar target per session, at its own realised deployed risk",
};
// sessions needed to resolve a given dollar target; defaults to the EASIER end of the band
const sessionsToHurdle = (currentMde, target) => (currentMde == null ? null : Math.round(K * (currentMde / (target || HURDLE.hi)) ** 2));

/**
 * THE ESTIMATOR, corrected. The headline was an UNWEIGHTED mean of per-day means over day sizes
 * 1..87, labelled "R per ticket". It is not that quantity — it reads -0.03542R where the actual
 * per-ticket mean is -0.01743R — and it let two outage days holding one and two tickets (0.23% of
 * the book) drive the dispersion that sets the MDE from 0.124 to 0.290, inflating the MDE 2.4x.
 * That is the min-day-size defect the Aug-2026 observer checkup already recorded, recurring here.
 *
 * The cluster-robust SE below needs NO discretionary exclusion: it estimates the per-ticket mean and
 * clusters the standard error on the session, so a 1-ticket day contributes its one ticket rather
 * than outvoting an 87-ticket day. It is the primary number. The min-day-size bootstrap is kept
 * beside it as a second route, and the two agree.
 */
const N_TICKETS = rows.length;
const grandMean = mean(rows.map((t) => t.rMult));
const clusterSE = (() => { let sq = 0; for (const d of days) { const s = byDay[d].reduce((a, t) => a + (t.rMult - grandMean), 0); sq += s * s; } return Math.sqrt(sq) / N_TICKETS; })();
const clusterT = grandMean / clusterSE;

const observedT = tOf(sessionMeans);
const out = {
  spec: "power-calibration-v1", asOf: new Date().toISOString(),
  population: { source: L.source, epoch: L.epoch, tickets: rows.length, sessions: K, meanRPerTicket: +mean(rows.map((t) => t.rMult)).toFixed(5), observedSessionClusteredT: +observedT.toFixed(3) },
  bar: { tRequired: +BAR.toFixed(3), source: `lib/null-bar.js nullBar({variants:1, n:${K}, trials:20000}).p95` },
  nullCalibration: { primary: "sign-flip randomisation on session means", trials: signFlip.trials,
    realisedFalsePositiveRate: +fpr.toFixed(4), nominal: 0.05,
    empiricalP95OfNullT: +empiricalP95.toFixed(3),
    crossDayNull: { empiricalP95OfNullT: +crossDay.p95.toFixed(3),
      note: "Tests 'no day-level structure', NOT the bar's false-positive rate. This null shuffles outcomes but never RECENTRES, so it preserves the book's own negative grand mean and its t distribution sits below zero — a positive bar is unreachable by construction. The 0.00% it used to report was arithmetically forced by the book being negative, and had the book been positive the same null would have reported ~100%. Not comparable to the 5% budget; the rate is withdrawn." },
    verdict: Math.abs(fpr - 0.05) <= 0.015 ? "CALIBRATED — the bar delivers about the false-positive rate it claims"
      : fpr > 0.065 ? "TOO LOOSE — the bar lets through more noise than it claims"
      : "TOO STRICT — the bar rejects more than it claims, which would understate real effects" },
  power: powerNow, targetPower: TARGET_POWER,
  minimumDetectableEffectR: mde,
  // Second, independent route to the same quantity: no exclusions, session-clustered SE on the
  // per-ticket mean. Reported beside the bootstrap so the two can be compared rather than trusted.
  clusterRobust: { meanRPerTicket: +grandMean.toFixed(5), se: +clusterSE.toFixed(5), t: +clusterT.toFixed(3), mde: +(clusterSE * (BAR + 0.8416)).toFixed(3) },
  dispersion: { ticketsPerSession: +nbar.toFixed(1), varSessionMeans: +totalV.toFixed(5), withinSessionSamplingPct: +(100 * samplingV / totalV).toFixed(1), commonBetweenSessionPct: +(100 * betweenV / totalV).toFixed(1), mdeIfCommonFactorRemoved: +(mde / hedgeGain).toFixed(3), sessionsToHurdleAsBuilt: sessionsToHurdle(mde), sessionsToHurdleHedged: sessionsToHurdle(mde / hedgeGain) },
  hurdleR: HURDLE.lo, hurdleBand: HURDLE,
  reading: null,
};
out.reading = mde == null ? "No effect in the scanned range reaches 80% power at the current session count — the instrument cannot presently adjudicate ANY plausible edge."
  : mde > out.hurdleR * 2 ? `UNDER-POWERED for the question being asked: the smallest effect this apparatus detects at 80% power is +${mde}R per ticket, against a hurdle of +${out.hurdleR}R. A real edge at the hurdle would be missed most of the time, so "no edge demonstrated" is substantially "cannot tell yet" and must not be reported as evidence of absence.`
  : `ADEQUATELY POWERED at the hurdle: the smallest effect detected at 80% power is +${mde}R per ticket, at or below the +${out.hurdleR}R hurdle. A real edge of the size worth having would usually have been seen, so the accumulated negative results ARE evidence of absence rather than of blindness.`;

writeJsonAtomic(path.join(__dirname, "data", "power-calibration.json"), out);
if (JSON_OUT) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }

console.log(`\n  POWER & CALIBRATION — canonical ledger, session-clustered, ${TRIALS} trials`);
console.log(`  population: ${rows.length} tickets across ${K} sessions · mean ${out.population.meanRPerTicket}R/ticket · observed t ${out.population.observedSessionClusteredT} vs bar ${out.bar.tRequired}\n`);
console.log(`  1. NULL CALIBRATION (sign-flip on session means; cross-day shuffle within direction)`);
console.log(`     sign-flip:  FPR ${(fpr * 100).toFixed(2)}%  vs nominal 5.00%   null p95 t = ${out.nullCalibration.empiricalP95OfNullT}`);
  console.log(`     cross-day:  FPR ${(crossDay.fpr * 100).toFixed(2)}%                        null p95 t = ${out.nullCalibration.crossDayNull.empiricalP95OfNullT}`);
console.log(`     ${out.nullCalibration.verdict}\n`);
console.log(`  2. POWER at the current ${K} sessions`);
console.log(`     ${"effect".padEnd(10)}${"power".padEnd(9)}sessions for ${TARGET_POWER * 100}%`);
for (const p of powerNow) console.log(`     +${String(p.effectR).padEnd(9)}${String(p.powerAtCurrentN).padEnd(9)}${p.sessionsFor80pct ?? ">4000"}`);
console.log(`\n  3. MINIMUM DETECTABLE EFFECT at ${K} sessions: ${mde == null ? "none in range" : "+" + mde + "R per ticket"}  (hurdle +${out.hurdleR}R)`);
console.log(`\n  3b. WHERE THE DISPERSION LIVES  (${nbar.toFixed(1)} tickets per session)`);
console.log(`      var(session means) ${totalV.toFixed(5)}  =  within-session sampling ${(100 * samplingV / totalV).toFixed(0)}%  +  COMMON between-session ${(100 * betweenV / totalV).toFixed(0)}%`);
// Conditional, because the corrected decomposition flipped the answer. The first version hard-coded
// "trading more per session cannot help" off a sampling term computed as mean(v)/mean(n) — Jensen —
// which read 14%. Correctly computed it is ~46%, and at that share the lever DOES work.
console.log(100 * samplingV / totalV >= 30
  ? `      Trading MORE per session helps: ${(100 * samplingV / totalV).toFixed(0)}% of the variance is within-session sampling, which averages away with ticket count.`
  : `      Trading more per session cannot help: that lever is only ${(100 * samplingV / totalV).toFixed(0)}% of the variance and is already averaged ${nbar.toFixed(0)} deep.`);
console.log(`      Remove the common factor entirely and the MDE would sharpen ~${hedgeGain.toFixed(2)}x, to about +${(mde / hedgeGain).toFixed(3)}R.`);
console.log(`      Sessions needed to reach the +${out.hurdleR}R hurdle:  as built ~${sessionsToHurdle(mde)}  ·  fully hedged ~${sessionsToHurdle(mde / hedgeGain)}`);
console.log(`      (Extrapolated on MDE ∝ 1/sqrt(n), assuming a hedge that costs nothing — it does not, and its cost comes straight off the edge.)`);
console.log(`\n  ${out.reading}\n`);
console.log(`  This measures the INSTRUMENT, not the market. It cannot make an edge exist or vanish.`);

/**
 * ── 4. PER-SLEEVE (--per-sleeve) ─────────────────────────────────────────────
 *
 * WHY THIS MATTERS MORE THAN THE HEADLINE. The whole-book MDE pools Equity, Options, Crypto and
 * Futures, whose R distributions are nothing like each other. A pooled session dispersion inflated by
 * mixing them is a fact about a badly-constructed PORTFOLIO, not about the measurement stack — and
 * quoting it as "the apparatus cannot see" would then be wrong in a way that matters, because it
 * would excuse the aggregate null instead of locating where evidence can actually accumulate.
 *
 * A sleeve whose MDE sits near the +0.012R hurdle is the one place a real edge could be ADJUDICATED
 * in a useful number of sessions. That is the concrete form of the "narrow, capacity-limited,
 * execution-aware" redirection three reviewers recommended, and it costs nothing to find.
 *
 * READ THE COLUMNS CORRECTLY. The MDE is an INSTRUMENT property and carries no multiplicity — asking
 * "how small an effect could this population resolve" is not a hypothesis test. The observed t is a
 * different animal: scanning every sleeve and reading the best one IS best-of-N, so a positive t here
 * is a candidate for REGISTRATION, never a discovery. It is printed so the two are not confused.
 */
if (argv.includes("--per-sleeve")) {
  const groups = new Map();
  const keyOf = (t) => `${t.cls || "?"} · ${t.sleeve || t.strategy || "unsleeved"}`;
  for (const t of rows) { const k = keyOf(t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  const MIN_SESSIONS = 8;
  const table = [];
  /**
   * CLUSTER-ROBUST PER SLEEVE (2026-09-09, audit). The first cut reused the unweighted mean-of-session-
   * means here, inheriting the same 2.4x inflation the whole-book headline had — and it printed a
   * TICKET mean (meanR) beside a SESSION-MEAN t, two different estimands in adjacent columns, which on
   * this book disagreed in SIGN on 2 of 11 rows. A reader saw "positive, not yet significant" where the
   * statistic under the t was negative.
   *
   * Both are fixed by estimating the per-ticket mean and clustering the standard error on the session.
   * It needs no min-day-size exclusion at all — a 1-ticket day contributes its one ticket instead of
   * outvoting an 87-ticket day — so it also works for the thin sleeves a size guard would gut.
   * MDE = SE x (bar + z_0.80), the standard one-sided normal form.
   */
  const Z80 = 0.8416;
  for (const [name, g] of groups) {
    const bd = {}; for (const t of g) (bd[t._day] ||= []).push(t);
    const ds = Object.keys(bd).sort();
    if (ds.length < MIN_SESSIONS) continue;
    const gm = mean(g.map((t) => t.rMult));
    let sq = 0; for (const d of ds) { const sdev = bd[d].reduce((a, t) => a + (t.rMult - gm), 0); sq += sdev * sdev; }
    const se = Math.sqrt(sq) / g.length;
    table.push({ sleeve: name, tickets: g.length, sessions: ds.length,
      meanR: +gm.toFixed(4), t: +(se > 0 ? gm / se : NaN).toFixed(2),
      mde: se > 0 ? +(se * (BAR_FOR(ds.length) + Z80)).toFixed(3) : null });
  }
  table.sort((a, b) => (a.mde ?? 9) - (b.mde ?? 9));
  out.perSleeve = { minSessions: MIN_SESSIONS, groups: table,
    note: "MDE is an instrument property and carries no multiplicity. The observed t IS best-of-N across these groups and must be treated as a candidate for registration, never a discovery." };
  writeJsonAtomic(path.join(__dirname, "data", "power-calibration.json"), out);

  console.log(`\n  4. PER-SLEEVE — where could an edge actually be ADJUDICATED?  (>= ${MIN_SESSIONS} sessions)\n`);
  console.log(`     ${"sleeve".padEnd(34)}${"tix".padStart(6)}${"sess".padStart(6)}${"meanR".padStart(10)}${"t".padStart(8)}${"MDE".padStart(9)}`);
  for (const r of table) console.log(`     ${r.sleeve.slice(0, 33).padEnd(34)}${String(r.tickets).padStart(6)}${String(r.sessions).padStart(6)}${String(r.meanR).padStart(10)}${String(r.t).padStart(8)}${(r.mde == null ? ">0.30" : "+" + r.mde).padStart(9)}`);
  const best = table.filter((r) => r.mde != null);
  console.log(`\n     whole book for comparison: MDE +${mde} · hurdle +${out.hurdleR}`);
  console.log(best.length && best[0].mde < mde
    ? `     BEST INSTRUMENT: ${best[0].sleeve} at +${best[0].mde}R — ${(mde / best[0].mde).toFixed(1)}x sharper than the pooled book, which means the pooled\n     number overstates how blind the apparatus is. Evidence accumulates fastest here.`
    : `     No sleeve resolves better than the pooled book, so the pooled MDE is not a mixing artifact.`);
  console.log(`\n     Any positive t above is best-of-N across ${table.length} groups. It is a candidate to REGISTER, not a finding.`);
}
