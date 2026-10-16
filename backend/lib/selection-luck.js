"use strict";
/**
 * SELECTION LUCK — separate "picked a hot asset / got lucky timing" from skill, IN ADVANCE. Built 2026-09-24 for R211
 * (data/test-registry.json preregistered[id=R211]); also used descriptively on our own strategy library.
 *
 * Pure functions, seeded (mulberry32), no I/O. NEVER THROWS ON BAD INPUT: a function that cannot answer returns its result shape
 * with null values and a `reason` string (success: reason null). Callers test `x.reason` / `x.z == null`.
 *
 *   randomTimingNull(assetDailyReturns, {inMarketFrac, nSwitches, sims=500, seed, shortFrac=0, exposure=1})
 *       -> { raw[], assetRel[], bh, K, T, sims, reason }
 *     Random-timing paths on the SAME asset over the SAME window with the SAME number of in-market days (round(frac x T)) and the
 *     SAME number of in/out switches. A path is S+1 alternating runs; the start state is drawn among the feasible ones; in-market
 *     and out-of-market day counts are split into runs by uniform random compositions (stars and bars). Each in-market run is short
 *     with probability shortFrac, and carries |exposure| (so a 1.5x long/short strategy is compared with 1.5x long/short luck).
 *     Path return = prod(1 + e_t r_t) - 1; asset-relative = path - buy-and-hold.
 *   skillScore(strategyDailyReturns, assetDailyReturns, {positions?, sims, seed, keepNull})
 *       -> { assetRel, raw, bh, pLuck, z, inMarketFrac, nSwitches, shortFrac, exposure, nullRaw?, reason }
 *     A = strategy compounded return - buy-and-hold. pLuck = share of null paths with asset-relative return >= A, ties split
 *     (mid-p: #(> A) + 0.5 #(= A)) so a degenerate null (never / always in market) gives 0.5, not 1; identical to the plain share when
 *     no path ties A. z = probit(1 - pLuck), capped at +/-3.5. positions = the exposure CARRIED INTO each day (sign = direction);
 *     without it, "in market" falls back to strategy return != 0.
 *   luckLine(universe, N, sims=1000, seed) -> { N, sims, median, p95, mean, reason }
 *     The best raw return among N zero-skill strategies: each sim draws N members (all of them when N = size, without replacement
 *     when smaller, with replacement when larger) and one path from each member's own null raw distribution (member.nullRaw).
 *   storeyQ(pvalues, lambda=0.5) -> { q[], pi0, reason }       Storey (2002) q-values; null entries stay null.
 *   sharpeMaxNull(seriesList, sims=1000, seed, {joint=true}) -> { observed[], median, p95, p99, pBySeries[], dist[], reason }
 *     seriesList = [{ id, r[], d[]?, ann }]. Sign-flip null: each sim flips the sign of every daily return at random — JOINTLY by date
 *     when dates are given (same flip for every series on a date, preserving cross-correlation) — and records the MAX annualised
 *     Sharpe across the list. pBySeries = the per-series sign-flip p (flipped Sharpe >= observed, mid-p).
 *   marketRelative(r[], m[], {nwLag=5}) -> { beta, alphaDaily, alphaAnnPct?, x[], tAlphaNW, n, reason }
 *     OLS r = a + b m; x = r - b m (the series with the market exposure removed, alpha kept), so a long-biased strategy is not
 *     scored as skilled for riding drift. tAlphaNW = Newey-West t of mean(x).
 *   ksUniform(p[]) -> { D, p, n, reason }                          one-sample Kolmogorov-Smirnov against U(0,1).
 *   probit(p), normCdf(x), sharpe(r, ann), mulberry(seed)
 *
 * Unit tests: node backend/lib/selection-luck.test.js
 */
const MAXZ = 3.5;
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const isNumArr = (a, min = 1) => Array.isArray(a) && a.length >= min && a.every((x) => typeof x === "number" && Number.isFinite(x));
const mean = (a) => { let s = 0; for (const x of a) s += x; return s / a.length; };
const sd = (a) => { const m = mean(a); let s = 0; for (const x of a) s += (x - m) ** 2; return Math.sqrt(s / (a.length - 1)); };
const quant = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]; };
const clampZ = (z) => Math.max(-MAXZ, Math.min(MAXZ, z));
const EPS = 1e-12;

/** Acklam's inverse normal CDF (|rel err| < 1.2e-9). probit(0) = -Infinity, probit(1) = +Infinity. */
function probit(p) {
  if (!(p >= 0 && p <= 1)) return NaN; if (p === 0) return -Infinity; if (p === 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
function normCdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)), dd = 0.3989422804014327 * Math.exp(-x * x / 2); const p = dd * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x >= 0 ? 1 - p : p; }
function sharpe(r, ann = 252) { if (!isNumArr(r, 3)) return null; const s = sd(r); return s > 0 ? mean(r) / s * Math.sqrt(ann) : null; }
const compound = (r) => { let v = 1; for (const x of r) v *= 1 + x; return v - 1; };

/** Uniform random composition of n into k positive parts (k = 0 requires n = 0). */
function composition(n, k, rng) {
  if (k === 0) return [];
  if (k === 1) return [n];
  const pool = Array.from({ length: n - 1 }, (_, i) => i + 1);
  for (let i = 0; i < k - 1; i++) { const j = i + Math.floor(rng() * (pool.length - i)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const cuts = pool.slice(0, k - 1).sort((x, y) => x - y), out = []; let prev = 0;
  for (const c of cuts) { out.push(c - prev); prev = c; } out.push(n - prev); return out;
}
function feasibleStarts(T, K, S) {
  const out = [];
  for (const start of [1, 0]) {
    const runs = S + 1, nIn = start ? Math.ceil(runs / 2) : Math.floor(runs / 2), nOut = runs - nIn;
    const okIn = nIn === 0 ? K === 0 : nIn <= K, okOut = nOut === 0 ? T - K === 0 : nOut <= T - K;
    if (okIn && okOut) out.push({ start, nIn, nOut });
  }
  return out;
}

function randomTimingNull(asset, opts = {}) {
  const fail = (reason) => ({ raw: null, assetRel: null, bh: null, K: null, T: null, sims: 0, reason });
  try {
    const { inMarketFrac, nSwitches, sims = 500, seed = 1, shortFrac = 0, exposure = 1, returnPaths = 0 } = opts;
    if (!isNumArr(asset, 2)) return fail("asset returns must be >= 2 finite numbers");
    if (!(inMarketFrac >= 0 && inMarketFrac <= 1)) return fail("inMarketFrac must be in [0,1]");
    if (!Number.isInteger(nSwitches) || nSwitches < 0 || nSwitches > asset.length - 1) return fail("nSwitches must be an integer in [0, T-1]");
    if (!(Number.isInteger(sims) && sims >= 1)) return fail("sims must be a positive integer");
    if (!(shortFrac >= 0 && shortFrac <= 1) || !(exposure >= 0 && Number.isFinite(exposure))) return fail("shortFrac in [0,1], exposure >= 0");
    const T = asset.length, K = Math.round(inMarketFrac * T), starts = feasibleStarts(T, K, nSwitches);
    if (!starts.length) return fail(`infeasible: ${K} in-market days of ${T} cannot hold ${nSwitches} switches`);
    const rng = mulberry(seed), bh = compound(asset), raw = new Array(sims), rel = new Array(sims), paths = [];
    for (let s = 0; s < sims; s++) {
      const st = starts.length === 1 ? starts[0] : starts[rng() < 0.5 ? 0 : 1];
      const ins = composition(K, st.nIn, rng), outs = composition(T - K, st.nOut, rng);
      let t = 0, v = 1, state = st.start, ii = 0, oi = 0; const path = returnPaths > s ? new Array(T) : null;
      while (t < T) {
        if (state) { const len = ins[ii++], e = (rng() < shortFrac ? -1 : 1) * exposure; for (let k = 0; k < len; k++, t++) { v *= 1 + e * asset[t]; if (path) path[t] = e; } }
        else { const len = outs[oi++]; for (let k = 0; k < len; k++, t++) if (path) path[t] = 0; }
        state = 1 - state;
      }
      raw[s] = v - 1; rel[s] = v - 1 - bh; if (path) paths.push(path);
    }
    return { raw, assetRel: rel, bh, K, T, sims, reason: null, ...(returnPaths ? { paths } : {}) };
  } catch (e) { return fail("internal: " + e.message); }
}

function skillScore(strat, asset, opts = {}) {
  const fail = (reason) => ({ assetRel: null, raw: null, bh: null, pLuck: null, z: null, reason });
  try {
    const { positions = null, sims = 500, seed = 1, keepNull = false, assetRel: Aoverride = null } = opts;
    if (!isNumArr(strat, 2) || !isNumArr(asset, 2)) return fail("strategy and asset returns must be >= 2 finite numbers");
    if (strat.length !== asset.length) return fail("strategy and asset series differ in length");
    if (positions && (!isNumArr(positions, 2) || positions.length !== asset.length)) return fail("positions must be finite and the same length");
    const T = asset.length, inm = positions ? positions.map((p) => Math.abs(p) > EPS) : strat.map((r) => Math.abs(r) > EPS);
    let K = 0, S = 0, shorts = 0, expo = 0;
    for (let t = 0; t < T; t++) { if (inm[t]) { K++; if (positions) { expo += Math.abs(positions[t]); if (positions[t] < 0) shorts++; } } if (t && inm[t] !== inm[t - 1]) S++; }
    const exposure = positions ? (K ? expo / K : 1) : 1, shortFrac = positions && K ? shorts / K : 0;
    const raw = compound(strat), bh = compound(asset), A = Aoverride != null && Number.isFinite(Aoverride) ? Aoverride : raw - bh;
    const N = randomTimingNull(asset, { inMarketFrac: K / T, nSwitches: S, sims, seed, shortFrac, exposure });
    if (N.reason) return { ...fail(N.reason), assetRel: A, raw, bh };
    let gt = 0, eq = 0; for (const x of N.assetRel) { if (Math.abs(x - A) <= EPS * Math.max(1, Math.abs(A))) eq++; else if (x > A) gt++; }
    const pLuck = (gt + 0.5 * eq) / sims, z = clampZ(probit(1 - pLuck));
    return { assetRel: A, raw, bh, pLuck, z, inMarketFrac: K / T, nSwitches: S, shortFrac, exposure, sims, reason: null, ...(keepNull ? { nullRaw: N.raw } : {}) };
  } catch (e) { return fail("internal: " + e.message); }
}

function luckLine(universe, N, sims = 1000, seed = 211) {
  const fail = (reason) => ({ N, sims, median: null, p95: null, mean: null, reason });
  try {
    if (!Array.isArray(universe) || !universe.length) return fail("empty universe");
    const mem = universe.map((u) => (Array.isArray(u) ? u : u && u.nullRaw)).filter((a) => isNumArr(a, 1));
    if (!mem.length) return fail("no member carries a null (nullRaw)");
    if (!(Number.isInteger(N) && N >= 1)) return fail("N must be a positive integer");
    const rng = mulberry(seed), best = new Array(sims), M = mem.length, idx = mem.map((_, i) => i);
    for (let s = 0; s < sims; s++) {
      let mx = -Infinity;
      if (N >= M && N === M) { for (const a of mem) { const x = a[Math.floor(rng() * a.length)]; if (x > mx) mx = x; } }
      else if (N < M) { for (let i = 0; i < N; i++) { const j = i + Math.floor(rng() * (M - i)); [idx[i], idx[j]] = [idx[j], idx[i]]; const a = mem[idx[i]], x = a[Math.floor(rng() * a.length)]; if (x > mx) mx = x; } }
      else { for (let i = 0; i < N; i++) { const a = mem[Math.floor(rng() * M)], x = a[Math.floor(rng() * a.length)]; if (x > mx) mx = x; } }
      best[s] = mx;
    }
    return { N, sims, members: M, median: quant(best, 0.5), p95: quant(best, 0.95), mean: mean(best), reason: mem.length < universe.length ? `${universe.length - mem.length} member(s) without a null skipped` : null };
  } catch (e) { return fail("internal: " + e.message); }
}

function storeyQ(p, lambda = 0.5) {
  try {
    if (!Array.isArray(p)) return { q: null, pi0: null, reason: "pvalues must be an array" };
    const ok = p.map((x, i) => ({ x, i })).filter((o) => typeof o.x === "number" && o.x >= 0 && o.x <= 1);
    const q = p.map(() => null); if (!ok.length) return { q, pi0: null, reason: "no valid p-values" };
    const m = ok.length, pi0 = Math.min(1, ok.filter((o) => o.x > lambda).length / (m * (1 - lambda))) || 1 / m;   // pi0 = 0 guard
    ok.sort((a, b) => a.x - b.x); let run = Infinity;
    for (let j = m - 1; j >= 0; j--) { run = Math.min(run, pi0 * m * ok[j].x / (j + 1)); q[ok[j].i] = Math.min(1, run); }
    return { q, pi0, reason: ok.length < p.length ? `${p.length - ok.length} invalid p-value(s) left null` : null };
  } catch (e) { return { q: null, pi0: null, reason: "internal: " + e.message }; }
}

function sharpeMaxNull(list, sims = 1000, seed = 73, opts = {}) {
  const fail = (reason) => ({ observed: null, median: null, p95: null, p99: null, pBySeries: null, dist: null, reason });
  try {
    const { joint = true } = opts;
    if (!Array.isArray(list) || !list.length) return fail("empty series list");
    const S = list.map((s) => ({ id: s.id, r: s.r, d: s.d, ann: s.ann || 252 }));
    if (S.some((s) => !isNumArr(s.r, 3))) return fail("every series needs >= 3 finite returns");
    const useDates = joint && S.every((s) => Array.isArray(s.d) && s.d.length === s.r.length);
    const dateIdx = new Map(); if (useDates) for (const s of S) for (const d of s.d) if (!dateIdx.has(d)) dateIdx.set(d, dateIdx.size);
    const di = useDates ? S.map((s) => Int32Array.from(s.d.map((d) => dateIdx.get(d)))) : null;
    const obs = S.map((s) => sharpe(s.r, s.ann)), ge = new Array(S.length).fill(0), rng = mulberry(seed), dist = new Array(sims);
    const sign = new Int8Array(useDates ? dateIdx.size : 0);
    for (let k = 0; k < sims; k++) {
      if (useDates) for (let j = 0; j < sign.length; j++) sign[j] = rng() < 0.5 ? -1 : 1;
      let mx = -Infinity;
      S.forEach((s, i) => {
        let sm = 0, ss = 0; const n = s.r.length;
        for (let t = 0; t < n; t++) { const x = (useDates ? sign[di[i][t]] : (rng() < 0.5 ? -1 : 1)) * s.r[t]; sm += x; ss += x * x; }
        const m = sm / n, v = (ss - n * m * m) / (n - 1), sh = v > 0 ? m / Math.sqrt(v) * Math.sqrt(s.ann) : 0;
        if (sh > mx) mx = sh;
        if (obs[i] != null) { if (Math.abs(sh - obs[i]) <= 1e-12) ge[i] += 0.5; else if (sh > obs[i]) ge[i] += 1; }
      });
      dist[k] = mx;
    }
    return { observed: obs, median: quant(dist, 0.5), p95: quant(dist, 0.95), p99: quant(dist, 0.99), pBySeries: ge.map((g) => g / sims), dist, joint: useDates, sims, seed, reason: null };
  } catch (e) { return fail("internal: " + e.message); }
}

function marketRelative(r, m, opts = {}) {
  const fail = (reason) => ({ beta: null, alphaDaily: null, x: null, tAlphaNW: null, n: 0, reason });
  try {
    const { nwLag = 5 } = opts;
    if (!isNumArr(r, 10) || !isNumArr(m, 10) || r.length !== m.length) return fail("need two aligned finite series of >= 10 days");
    const mr = mean(r), mm = mean(m); let cov = 0, vm = 0; for (let i = 0; i < r.length; i++) { cov += (r[i] - mr) * (m[i] - mm); vm += (m[i] - mm) ** 2; }
    if (!(vm > 0)) return fail("market series has zero variance");
    const beta = cov / vm, x = r.map((v, i) => v - beta * m[i]), n = x.length, mx = mean(x), e = x.map((v) => v - mx);
    let lrv = e.reduce((s, v) => s + v * v, 0) / n;
    for (let L = 1; L <= nwLag; L++) { let g = 0; for (let i = L; i < n; i++) g += e[i] * e[i - L]; lrv += 2 * (1 - L / (nwLag + 1)) * g / n; }
    return { beta, alphaDaily: mx, x, tAlphaNW: lrv > 0 ? mx / Math.sqrt(lrv / n) : null, n, reason: null };
  } catch (e) { return fail("internal: " + e.message); }
}

function ksUniform(p) {
  try {
    const a = (Array.isArray(p) ? p : []).filter((x) => typeof x === "number" && x >= 0 && x <= 1).sort((x, y) => x - y), n = a.length;
    if (n < 5) return { D: null, p: null, n, reason: "need >= 5 values in [0,1]" };
    let D = 0; for (let i = 0; i < n; i++) D = Math.max(D, (i + 1) / n - a[i], a[i] - i / n);
    const lam = (Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * D; let q = 0;
    for (let k = 1; k <= 100; k++) q += 2 * (k % 2 ? 1 : -1) * Math.exp(-2 * k * k * lam * lam);
    return { D, p: Math.max(0, Math.min(1, q)), n, reason: null };
  } catch (e) { return { D: null, p: null, n: 0, reason: "internal: " + e.message }; }
}

module.exports = { randomTimingNull, skillScore, luckLine, storeyQ, sharpeMaxNull, marketRelative, ksUniform, probit, normCdf, sharpe, mulberry, compound, MAXZ };
