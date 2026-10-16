"use strict";
/**
 * KELLY LINE — the Kelly fraction of a read, from its returns PER CLUSTERING UNIT. Built 2026-10-16 (backlog row 23).
 *
 * WHAT IT IS. For a sequence of returns the Kelly fraction is mean / variance: the share of capital that maximises the long-run
 * growth rate of a repeated bet. It is DESCRIPTIVE here and nothing else — it grades nothing, it moves no bar, and no registered
 * rule, population or read condition reads it. Where it is printed (the sealed-read table in backend/progress-tests.js) it is an
 * extra column beside the sealed verdict, never part of it.
 *
 * THE UNIT IS THE CLUSTERING UNIT, NEVER THE TICKET. Every read in this project states its unit of inference — sessions, months,
 * auctions, meetings, event-days — and computes its statistic over the per-unit means, because tickets inside a unit are not
 * independent. This function takes the SAME per-unit numbers the read's own t is computed from. Hand it per-ticket returns and it
 * will answer, but the answer is then as overstated as a per-ticket t would be: the caller owns the unit, as everywhere else here.
 *
 *   kellyLine(returns, { conf = 0.80, round = 3 })
 *     -> { n, mean, variance, sd, se, meanLo, full, half, shrunkFull, shrunkHalf, rawFull, rawShrunk, conf, z, text, reason }
 *
 *     full        mean / variance, CAPPED AT 1.0 AND FLOORED AT 0 (no leverage, no shorting the read)
 *     half        full / 2 — half of the CAPPED fraction, so it is always in [0, 0.5]
 *     shrunkFull  the same arithmetic on the LOWER END of the mean's two-sided 80% confidence interval,
 *                 meanLo = mean - z * sd / sqrt(n) with z = probit(0.90) = 1.2815515655446..., then capped and floored the same way.
 *                 The variance is NOT shrunk: only the mean is uncertain here, and a shrunk variance would raise the fraction.
 *     shrunkHalf  shrunkFull / 2
 *     rawFull / rawShrunk   the same two before the cap and the floor — kept so a capped 1.000 can be told from a 1.000 that is
 *                 exactly at the cap, and so the selftest can check the cap rather than assume it.
 *     variance    the SAMPLE variance (n - 1 in the denominator), as lib/progress-score.js ci95 and lib/selection-luck.js sd use.
 *     text        the printable line: "full 0.412 / half 0.206 · shrunk 0.137 / 0.069 · n 42"
 *
 * NEVER THROWS ON BAD INPUT, the lib/selection-luck.js contract: a call that cannot answer returns the result shape with null
 * values and a `reason` string; on success `reason` is null. Callers test `x.reason`. A read with fewer than two units, with a
 * non-finite number among its returns, or with no variance at all gets a reason, not a number and not an exception — the printer
 * that calls this must never be the reason an email fails to build.
 *
 *   clusterReturnsOf(obj) -> { returns, key, reason }
 *     Pure, no I/O. Finds the per-clustering-unit returns an object carries, under one of CLUSTER_KEYS, at the top level or inside
 *     one of CONTAINERS. Both lists are closed and ordered: a new name is added here, on purpose, never guessed at by shape.
 *
 * Unit tests: the package selftest, docs/kelly-column/2026-10-16/selftest.cjs (section B).
 */
const { probit } = require("./selection-luck.js");

/** the return keys this recognises, in the order they are tried */
const CLUSTER_KEYS = Object.freeze(["clusterReturns", "clusterMeans", "unitMeans", "sessionMeans", "dayMeans", "weekMeans", "monthMeans"]);
/** the sub-objects a read's output file keeps them in, in the order they are tried */
const CONTAINERS = Object.freeze(["latest", "primary", "result", "summary"]);
/** z for a two-sided 80% interval of the mean = probit(0.90) */
const Z80 = probit(0.9);
const DEFAULT_CONF = 0.8;

const isFiniteNum = (x) => typeof x === "number" && Number.isFinite(x);
const isNumArr = (a, min = 1) => Array.isArray(a) && a.length >= min && a.every(isFiniteNum);
/** capped at 1.0, floored at 0 — NaN stays NaN so the caller's finite check catches it */
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const meanOf = (a) => { let s = 0; for (const x of a) s += x; return s / a.length; };
/** sample variance, n - 1 denominator */
const varianceOf = (a) => { const m = meanOf(a); let s = 0; for (const x of a) s += (x - m) ** 2; return s / (a.length - 1); };

function kellyLine(returns, opts = {}) {
  const conf = opts && opts.conf !== undefined ? opts.conf : DEFAULT_CONF;
  const fail = (reason) => ({ n: Array.isArray(returns) ? returns.length : 0, mean: null, variance: null, sd: null, se: null, meanLo: null,
    full: null, half: null, shrunkFull: null, shrunkHalf: null, rawFull: null, rawShrunk: null, conf, z: null, text: null, reason });
  try {
    const round = opts && opts.round !== undefined ? opts.round : 3;
    if (!Array.isArray(returns)) return fail("returns must be an array of finite numbers, one per clustering unit");
    if (returns.length < 2) return fail(`need >= 2 clustering units, got ${returns.length}`);
    if (!returns.every(isFiniteNum)) return fail("every return must be a finite number");
    if (!(isFiniteNum(conf) && conf > 0 && conf < 1)) return fail("conf must be a number in (0,1)");
    if (!(Number.isInteger(round) && round >= 0 && round <= 12)) return fail("round must be an integer in [0,12]");
    const n = returns.length, m = meanOf(returns), v = varianceOf(returns);
    if (!(v > 0) || !Number.isFinite(v)) return fail("the returns have no variance: Kelly is mean over variance and is undefined");
    const sd = Math.sqrt(v), se = sd / Math.sqrt(n), z = conf === DEFAULT_CONF ? Z80 : probit(0.5 + conf / 2);
    if (!isFiniteNum(z)) return fail("the confidence level has no finite z");
    const meanLo = m - z * se, rawFull = m / v, rawShrunk = meanLo / v;
    const full = clamp01(rawFull), shrunkFull = clamp01(rawShrunk);
    if (!(Number.isFinite(full) && Number.isFinite(shrunkFull))) return fail("the Kelly fraction is not finite");
    const half = full / 2, shrunkHalf = shrunkFull / 2;
    const f = (x) => x.toFixed(round);
    const text = `full ${f(full)} / half ${f(half)} · shrunk ${f(shrunkFull)} / ${f(shrunkHalf)} · n ${n}`;
    return { n, mean: m, variance: v, sd, se, meanLo, full, half, shrunkFull, shrunkHalf, rawFull, rawShrunk, conf, z, text, reason: null };
  } catch (e) { return fail("internal: " + (e && e.message)); }
}

/** the per-clustering-unit returns an object carries, by name — never by shape. { returns, key, reason } */
function clusterReturnsOf(obj) {
  const fail = (reason) => ({ returns: null, key: null, reason });
  try {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return fail("no object to read returns from");
    for (const k of CLUSTER_KEYS) if (isNumArr(obj[k], 2)) return { returns: obj[k], key: k, reason: null };
    for (const c of CONTAINERS) {
      const sub = obj[c];
      if (!sub || typeof sub !== "object" || Array.isArray(sub)) continue;
      for (const k of CLUSTER_KEYS) if (isNumArr(sub[k], 2)) return { returns: sub[k], key: `${c}.${k}`, reason: null };
    }
    return fail(`no per-unit returns: none of ${CLUSTER_KEYS.join(", ")} at the top level or under ${CONTAINERS.join(", ")}`);
  } catch (e) { return fail("internal: " + (e && e.message)); }
}

module.exports = { kellyLine, clusterReturnsOf, clamp01, meanOf, varianceOf, CLUSTER_KEYS, CONTAINERS, Z80, DEFAULT_CONF };
