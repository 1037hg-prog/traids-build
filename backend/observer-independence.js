#!/usr/bin/env node
/**
 * OBSERVER INDEPENDENCE — how many LENSES are there really? (D16 fix, 2026-08-06)
 *
 * The board records 30+ observers per ticket and the intelligence panel presents them as that
 * many independent readings. They are not. Eight of the macro slots (vix, oil20, gold20, y10,
 * y10chg20, curve, polNews, polSent) are SESSION-LEVEL: they take one value for the whole day
 * and are therefore identical across every ticket in that session. A hundred trades carrying the
 * same VIX reading is ONE observation of VIX, not a hundred.
 *
 * Why it matters, concretely: apparent evidence breadth on the macro block is overstated by
 * roughly the average tickets-per-session, and any multiplicity correction computed from the raw
 * observer count is too LENIENT — it prices a search across 30 independent lenses when the real
 * search is much narrower and much more correlated. That is the flattering direction.
 *
 * This measures it rather than asserting it:
 *   1. EFFECTIVE N — for each observer, how many distinct values exist per session? An observer
 *      that is constant within a session has effective n = SESSIONS, not TRADES.
 *   2. DEGENERACY — an observer whose tercile split collapses to a single value cannot separate
 *      anything and should not be counted as a lens at all.
 *   3. REDUNDANCY — observers that produce the SAME tercile partition are one lens wearing
 *      several names. Reported as clusters.
 *
 * Nothing here changes a result. It changes what the observer COUNT is allowed to claim.
 *
 * NULL-COERCION BUG (found + fixed 2026-08-29, wave-2 coverage audit). The finite-check used to
 * read `Number.isFinite(+r.obs[k])`. The unary `+` COERCES before the check, and `+null === 0`,
 * which IS finite — so every observer stamped `null` (the codebase's deliberate convention for
 * "genuinely unknown", e.g. erDays/newsCycle/skewRR before a name qualifies — see src/App.jsx's
 * LITE-SCAN map comment: "silence is NOT neutral sentiment") was silently counted as a real
 * reading of ZERO. `undefined` (key truly absent) was correctly excluded — `+undefined` is NaN —
 * so only the deliberately-null fields were corrupted, which are exactly the starved observers
 * this file exists to characterize.
 *
 * Measured impact on the clean-era ledger before this fix: erDays reported n=1766 against a true
 * finite count of 120 (14.7x inflated by 1,646 phantom zeros); dayMove n=1313 vs true 62 (21x);
 * newsCycle n=1368 vs true 113 (12x); newsScore n=1762 vs true 414 (4.3x); skewRR/insiderXP/
 * macdCrossAge ~2x each. Every "DEGENERATE" verdict on a nullable field was computed mostly from
 * fake zeros, not from the real readings — dayMove's degeneracy, for one example, has never
 * actually been tested on its 62 genuine values. Fixed by checking Number.isFinite on the RAW
 * value (no coercion) everywhere this file reads an observer.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const log = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8"));
const day = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Denver" });

const CLEAN = new Date("2026-07-20").getTime();
const rows = log.filter(r => r.openedAt >= CLEAN && r.obs && typeof r.obs === "object");
const sessions = [...new Set(rows.map(r => day(r.openedAt)))].sort();
console.log(`OBSERVER INDEPENDENCE — ${rows.length} clean-era tickets over ${sessions.length} sessions\n`);

const keys = [...new Set(rows.flatMap(r => Object.keys(r.obs)))].sort();
const report = [];

for (const k of keys) {
  const have = rows.filter(r => Number.isFinite(r.obs[k]));
  if (have.length < 20) { report.push({ k, n: have.length, verdict: "too sparse" }); continue; }

  // distinct values WITHIN each session — 1 means the observer is a session constant
  const bySess = {};
  for (const r of have) (bySess[day(r.openedAt)] ||= []).push(r.obs[k]);
  const perSession = Object.values(bySess).map(v => new Set(v.map(x => x.toFixed(6))).size);
  const constantSessions = perSession.filter(x => x === 1).length;
  const sessionConstant = constantSessions === perSession.length;

  // effective n: session-level observers carry one observation per session, not per trade
  const effN = sessionConstant ? Object.keys(bySess).length : have.length;

  // tercile degeneracy
  const vals = have.map(r => r.obs[k]).sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length / 3)], hi = vals[Math.floor(vals.length * 2 / 3)];
  const degenerate = hi === lo;

  report.push({ k, n: have.length, effN, sessionConstant, degenerate, inflation: have.length / effN,
    verdict: degenerate ? "DEGENERATE — terciles collapse; not a lens"
      : sessionConstant ? `session-constant — effective n ${effN}, not ${have.length}`
        : "per-ticket" });
}

const usable = report.filter(r => r.verdict === "per-ticket");
const constant = report.filter(r => r.sessionConstant && !r.degenerate);
const dead = report.filter(r => r.degenerate);
const sparse = report.filter(r => r.verdict === "too sparse");

const w = (s, n) => String(s).padEnd(n);
console.log(`  ${w("observer", 16)} ${w("rows", 6)} ${w("eff n", 7)} verdict`);
for (const r of report.sort((a, b) => (a.verdict > b.verdict ? 1 : -1))) {
  console.log(`  ${w(r.k, 16)} ${w(r.n, 6)} ${w(r.effN ?? "—", 7)} ${r.verdict}`);
}

console.log(`\n  SUMMARY`);
console.log(`    per-ticket lenses (real)      : ${usable.length}`);
console.log(`    session-constant (inflated)   : ${constant.length}`);
console.log(`    degenerate (not lenses at all): ${dead.length}${dead.length ? " — " + dead.map(r => r.k).join(", ") : ""}`);
console.log(`    too sparse to judge           : ${sparse.length}`);
const claimed = report.length;
const real = usable.length + (constant.length ? 1 : 0);   // the macro block collapses toward one
console.log(`\n    the board presents ${claimed} observers. On this evidence roughly ${usable.length} separate a ticket from`);
console.log(`    its neighbour within a session; the session-constant block is at most a handful of`);
console.log(`    independent readings no matter how many names it carries.`);
console.log(`    ANY multiplicity correction computed from ${claimed} is TOO LENIENT for the per-ticket search`);
console.log(`    and TOO STRICT for the session-level one. They are different searches and must be`);
console.log(`    corrected separately. (D16)`);

// redundancy clusters among the per-ticket observers
if (usable.length > 1) {
  const part = {};
  for (const r of usable) {
    const have = rows.filter(x => Number.isFinite(x.obs[r.k]));
    const vals = have.map(x => x.obs[r.k]).sort((a, b) => a - b);
    const lo = vals[Math.floor(vals.length / 3)], hi = vals[Math.floor(vals.length * 2 / 3)];
    part[r.k] = have.map(x => (x.obs[r.k] >= hi ? 2 : x.obs[r.k] <= lo ? 0 : 1)).join("");
  }
  const seen = new Map();
  for (const k in part) { const sig = part[k]; if (!seen.has(sig)) seen.set(sig, []); seen.get(sig).push(k); }
  const dupes = [...seen.values()].filter(g => g.length > 1);
  console.log(`\n    identical tercile partitions among per-ticket observers: ${dupes.length ? dupes.map(g => "{" + g.join(", ") + "}").join(" ") : "none"}`);
}

fs.writeFileSync(D("observer-independence.json"), JSON.stringify({ ranAt: new Date().toISOString(), sessions: sessions.length, tickets: rows.length, report }, null, 1));
console.log(`\nwritten: observer-independence.json`);
