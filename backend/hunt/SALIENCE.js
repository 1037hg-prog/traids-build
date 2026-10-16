#!/usr/bin/env node
/**
 * SALIENCE — SALIENCE THEORY VALUE (ST) PREDICTS LOWER RETURNS. Pre-registered hunt test, written 2026-09-23, BEFORE any statistic.
 *
 * HYPOTHESIS. Investors overweight a stock's salient past daily returns (Bordalo-Gennaioli-Shleifer salience theory). Stocks whose salient
 * days were upside moves (high ST) are overvalued and earn LOW subsequent returns; salient-downside stocks (low ST) earn HIGH returns.
 * SOURCES. Cosemans, M. & Frehen, R. (2021), "Salience theory and stock prices: Empirical evidence", Journal of Financial Economics 140(2),
 *   460-483. Salience function and parameters (theta = 0.1, delta = 0.7) from Bordalo, Gennaioli & Shleifer (2012), "Salience theory of
 *   choice under risk", QJE 127(3), 1243-1285, as adopted by Cosemans-Frehen.
 *
 * EXACT MECHANICAL RULE (single variant).
 *   Panel: data/anomaly-cache-v2 (survivorship-reduced: active + delisted US common stocks, Alpaca SIP daily, adjustment=all; v2 keeps a
 *     name with a >+300% one-day jump up to the day BEFORE its first such jump instead of dropping it -- point-in-time; the name then
 *     leaves the panel like a delisting; meta.info[i].truncatedBefore gives the cut date).
 *   Daily return r_i,d = close_d / close_{d-1} - 1 (NaN if either close missing).
 *   rbar_d = equal-weight mean of r_i,d over EVERY stock in the panel with a finite return that day and |r| < 0.5 (R161's guard against
 *     bad prints; applied to the market mean only, never to the stock's own return).
 *   Formation at each month-end t (last trading day of the month; only data through t's close):
 *     eligibility (split-invariant liquidity screen, amended 2026-09-23): a close on day t, >= 252 closes in the 260 days to t, >= 40
 *     dollar-volume days in the 60 to t, and 60-day MEDIAN dollar volume (close x volume; both adjusted, so the product is invariant to
 *     later split adjustment) >= $5,000,000; then top 1,500 by 60-day mean dollar volume. NO price floor: the panel is adjustment=all, so
 *     a price level at t depends on splits after t (look-ahead) -- the old close_t >= $5 floor was removed for that reason.
 *     Window = the 21 trading days t-20..t; S = number of those days with a finite r_i,d AND finite rbar_d (need S >= 15).
 *     salience sigma_d = |r_i,d - rbar_d| / (|r_i,d| + |rbar_d| + 0.1).
 *     rank k_d: 1 = most salient (descending sigma). Exact ties share the mean of delta^k over their tied positions (order-invariant).
 *     w_d = delta^k_d / sum_d' delta^k_d', delta = 0.7.      ST_i = sum_d (w_d - 1/S) * r_i,d   (= Cov(omega, r) in the paper's notation).
 *   Quintiles on ST among eligible stocks with finite ST (need >= 100). LONG the lowest-ST quintile, SHORT the highest, equal weight.
 *   Holding: entry at the NEXT available price = first open after t (day t+1; if a name has no open in the month it is dropped), exit at
 *     the close of the next month-end t1; a name that stops trading mid-month is held at its last close (delisting loss counts).
 *   Monthly long-short gross spread = mean(long leg) - mean(short leg).
 * COST MODEL (R161's): 0.25% x (long-leg turnover + short-leg turnover) per month; turnover = share of each leg's names not in last
 *   month's leg (first month = 2, i.e. full build of both legs).
 * STATISTIC. Monthly NET long-short spread; Newey-West t (lag 3); report mean (gross and net), NW t (gross and net), both halves' net means.
 * WINDOWS. Holding months: DISCOVERY 2017-01-01..2021-12-31; HOLDOUT 2022-01-01..2026-09-22 (the last month is partial, to 2026-09-22).
 * PROTOCOL.
 *   --selftest   synthetic known-answer checks only (formula, tie invariance, sign, no look-ahead, planted effect, null). Exit 1 on FAIL.
 *   --controls   discovery window only. (a) leak test: iid BOOTSTRAP panel (each stock's daily gross returns resampled WITH replacement inside
 *                its listed span, arithmetic drift removed, closes rebuilt, rbar recomputed from the bootstrapped returns) -> GROSS |NW t| < 2.
 *                The bootstrap pool AND the drift estimate use only returns dated <= 2021-12-31 (NULL_THROUGH); every return / close after
 *                that date is blanked in the null, so no holdout-period return can enter the discovery-window controls.
 *                (b) positive control: signal = the realised holding return itself (peek) -> GROSS NW t >= 5 (sign handled: peek sorts so the
 *                long leg is the high-forward-return quintile). Writes data/hunt/SALIENCE-controls.json.
 *   --discovery  refuses unless controls passed AND backend/data/test-registry.json has a preregistered entry with script ===
 *                "backend/hunt/SALIENCE.js". Discovery months only. Writes data/hunt/SALIENCE-discovery.json once; refuses to overwrite.
 *                Discovery is informational: the holdout is read for the frozen rule regardless of the discovery sign.
 *   --holdout    refuses unless discovery exists; holdout months only, once; writes data/hunt/SALIENCE-holdout.json; refuses to overwrite.
 *                PASS: net mean > 0 AND net NW t >= 1.70 AND both holdout halves' net means > 0. Otherwise DID NOT PASS.
 *   --status     file states only, no statistics.
 *   The holdout months are unreachable from every mode except --holdout: run() throws on the real panel if asked for any holding month
 *   after 2021-12 without the holdout token.
 *   Every PASS/verdict and bar comparison uses UNROUNDED values (summarize().raw); rounded fields are for display only.
 *   require()-ing this file never runs a mode (main is guarded by require.main === module); the pure functions are exported.
 * NULL-MODE NOTE. In the bootstrap null the entry price is the bootstrapped close at t (no overnight step): the real opens belong to the real
 *   path and would splice two price paths together. The leak test is about the signal, so the entry convention does not matter to it.
 */
"use strict";
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("../lib/atomic-write.js");
const DATA = path.join(__dirname, "..", "data"), DIR = path.join(DATA, "anomaly-cache-v2"), HD = path.join(DATA, "hunt");
const KEY = "SALIENCE", SCRIPT = "backend/hunt/SALIENCE.js";
const CTRL = path.join(HD, `${KEY}-controls.json`), OUTD = path.join(HD, `${KEY}-discovery.json`), OUTH = path.join(HD, `${KEY}-holdout.json`);
const COST = 0.0025, TOPN = 1500, MINMEDDV = 5e6, WIN = 21, MINS = 15, THETA = 0.1, DELTA = 0.7, BAR = 1.70;
const DISC = ["2017-01", "2021-12"], HOLD = ["2022-01", "2026-09"], HOLDOUT_TOKEN = Symbol("holdout"), NULL_THROUGH = "2021-12-31";

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const median = (a) => { const b = Float64Array.from(a).sort(), n = b.length; return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2; };
function nwT(a, L = 3) { const n = a.length; if (n < 6) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let k = 1; k <= L; k++) { let c = 0; for (let i = k; i < n; i++) c += d[i] * d[i - k]; v += 2 * (1 - k / (L + 1)) * c / n; } return v > 0 ? m / Math.sqrt(v / n) : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r5 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(5)), r3 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(3));

// ---------- the salience theory value (one stock, one window) ----------
function stValue(r, rb) {   // r, rb: equal-length arrays of the stock's and the market's daily returns (finite only)
  const S = r.length; if (S < MINS) return NaN;
  const sal = r.map((x, i) => Math.abs(x - rb[i]) / (Math.abs(x) + Math.abs(rb[i]) + THETA));
  const ord = sal.map((v, i) => i).sort((a, b) => sal[b] - sal[a]), w = new Array(S);
  for (let p = 0; p < S;) { let q = p; while (q + 1 < S && sal[ord[q + 1]] === sal[ord[p]]) q++; let sw = 0; for (let k = p; k <= q; k++) sw += DELTA ** (k + 1); for (let k = p; k <= q; k++) w[ord[k]] = sw / (q - p + 1); p = q + 1; }
  const Z = w.reduce((s, x) => s + x, 0); let st = 0; for (let i = 0; i < S; i++) st += (w[i] / Z - 1 / S) * r[i]; return st;
}

// ---------- panel ----------
function loadPanel() {
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, "meta.json"), "utf8")), T = meta.dates.length, N = meta.symbols.length;
  const rd = (f) => { const b = fs.readFileSync(path.join(DIR, f)); return new Float32Array(b.buffer, b.byteOffset, N * T); };
  return { meta, T, N, C: rd("close.f32"), O: rd("open.f32"), V: rd("vol.f32"), real: true };
}
function prepare(P, scrambleSeed = 0, nullThrough = NULL_THROUGH) {    // R161's prepare (same iid bootstrap), plus rbar; the null flag switches entry to the close path
  const { T, N, C, V } = P, R = new Float32Array(N * T).fill(NaN), DV = new Float32Array(N * T).fill(NaN);
  for (let s = 0; s < N; s++) { const o = s * T; for (let t = 1; t < T; t++) { const a = C[o + t - 1], b = C[o + t]; if (a > 0 && b > 0) R[o + t] = b / a - 1; if (b > 0 && V[o + t] >= 0) DV[o + t] = b * V[o + t]; } }
  let Cx = C;
  if (scrambleSeed) {
    // P3 (2026-09-23): the bootstrap pool and the drift estimate use ONLY returns dated <= nullThrough; every cell after it is blanked
    // (R, Cx, DV = NaN), so no post-2021 return can reach the discovery-window null. Names with < 20 pre-cut returns are blanked too
    // (previously they kept their REAL returns inside the null).
    const dates = P.meta.dates; let tEnd = -1; for (let t = 0; t < T; t++) if (dates[t] <= nullThrough) tEnd = t;
    const rng = mulberry(scrambleSeed); Cx = new Float32Array(C);
    for (let s = 0; s < N; s++) { const o = s * T, idx = []; for (let t = 1; t <= tEnd; t++) if (!isNaN(R[o + t])) idx.push(t);
      for (let t = tEnd + 1; t < T; t++) { R[o + t] = NaN; Cx[o + t] = NaN; DV[o + t] = NaN; }
      if (idx.length < 20) { for (const t of idx) R[o + t] = NaN; continue; }
      const g = idx.map((t) => 1 + R[o + t]), mu = mean(g), vals = g.map((x) => x / mu - 1);
      const draw = idx.map(() => vals[Math.floor(rng() * vals.length)]); idx.forEach((t, k) => { R[o + t] = draw[k]; });
      const first = idx[0] - 1; let px = C[o + first]; for (let t = first + 1; t <= tEnd; t++) { if (!(C[o + t] > 0)) continue; if (!isNaN(R[o + t])) px = px * (1 + R[o + t]); Cx[o + t] = px; } }
  }
  const RB = new Float64Array(T).fill(NaN);
  for (let t = 1; t < T; t++) { let s = 0, n = 0; for (let i = 0; i < N; i++) { const r = R[i * T + t]; if (!isNaN(r) && Math.abs(r) < 0.5) { s += r; n++; } } if (n) RB[t] = s / n; }
  return { ...P, R, DV, Cx, RB, isNull: !!scrambleSeed };
}
const monthEnds = (dates) => { const e = []; for (let t = 0; t < dates.length; t++) if (t === dates.length - 1 || dates[t + 1].slice(0, 7) !== dates[t].slice(0, 7)) e.push(t); return e; };

function stAt(Q, s, t) { const { T, R, RB } = Q, o = s * T, r = [], rb = []; for (let k = t - WIN + 1; k <= t; k++) { if (k < 1) continue; const x = R[o + k], m = RB[k]; if (!isNaN(x) && Number.isFinite(m)) { r.push(x); rb.push(m); } } return stValue(r, rb); }
function formAt(Q, t) {                    // eligible universe with ST at formation day t (only data <= t)
  const { T, N, DV, Cx } = Q, out = [];
  for (let s = 0; s < N; s++) {
    // P2 (2026-09-23): no price floor (adjusted price levels at t depend on later splits); split-invariant dollar-volume screen instead
    const o = s * T; if (!(Cx[o + t] > 0)) continue;
    let hist = 0; for (let k = t; k >= 0 && k > t - 260; k--) if (Cx[o + k] > 0) hist++; if (hist < 252) continue;
    const dvs = []; for (let k = Math.max(0, t - 59); k <= t; k++) { const x = DV[o + k]; if (x >= 0) dvs.push(x); } if (dvs.length < 40) continue;
    if (median(dvs) < MINMEDDV) continue;
    out.push({ s, dv: mean(dvs), st: stAt(Q, s, t) });
  }
  out.sort((a, b) => b.dv - a.dv); return out.slice(0, TOPN);
}
function holdReturn(Q, s, t0, t1) {        // entry = next available price after t0; exit = last close <= t1
  const { T, Cx, O, isNull } = Q, o = s * T; let entry = NaN, k0 = t0;
  if (isNull) { entry = Cx[o + t0]; } else { for (let k = t0 + 1; k <= t1; k++) if (O[o + k] > 0) { entry = O[o + k]; k0 = k - 1; break; } }
  if (!(entry > 0)) return NaN; let last = isNull ? entry : NaN;
  for (let k = k0 + 1; k <= t1; k++) { const x = Cx[o + k]; if (x > 0) last = x; }
  return last > 0 ? last / entry - 1 : NaN;
}

function run(Q, fromYm, toYm, { peek = false, token = null } = {}) {
  if (Q.real && toYm > DISC[1] && token !== HOLDOUT_TOKEN) throw new Error("holdout months are unreachable outside --holdout");
  if (Q.real && fromYm <= DISC[1] && token === HOLDOUT_TOKEN) throw new Error("holdout run must not include discovery months");
  const dates = Q.meta.dates, me = monthEnds(dates), rows = []; let prev = null;
  for (let mi = 0; mi < me.length - 1; mi++) {
    const t = me[mi], t1 = me[mi + 1], ym = dates[t1].slice(0, 7); if (ym < fromYm || ym > toYm) continue;
    const U = formAt(Q, t), fwd = new Map(U.map((u) => [u.s, holdReturn(Q, u.s, t, t1)]));
    const xs = U.filter((u) => Number.isFinite(fwd.get(u.s)) && Number.isFinite(peek ? 0 : u.st)).map((u) => ({ s: u.s, v: peek ? -fwd.get(u.s) : u.st }));
    if (xs.length < 100) continue;
    xs.sort((a, b) => a.v - b.v); const q = Math.floor(xs.length / 5), L = xs.slice(0, q), S = xs.slice(xs.length - q);   // LONG low ST, SHORT high ST
    const avg = (g) => mean(g.map((x) => fwd.get(x.s))), gross = avg(L) - avg(S);
    const turn = prev ? (L.filter((x) => !prev.L.has(x.s)).length / L.length + S.filter((x) => !prev.S.has(x.s)).length / S.length) : 2;
    prev = { L: new Set(L.map((x) => x.s)), S: new Set(S.map((x) => x.s)) };
    rows.push({ ym, gross, net: gross - COST * turn, turn, n: xs.length });
    if (!Q.synthetic) process.stdout.write(`  ${KEY} ${ym}\r`);
  }
  if (!Q.synthetic) process.stdout.write("\n");
  return summarize(rows);
}
function summarize(rows) {       // F1 (2026-09-23): `raw` holds the UNROUNDED numbers every bar reads; the rounded fields are display only
  const net = rows.map((x) => x.net), g = rows.map((x) => x.gross), h = Math.floor(net.length / 2);
  const raw = { gross: mean(g), tGross: nwT(g), net: mean(net), tNet: nwT(net), firstHalf: mean(net.slice(0, h)), secondHalf: mean(net.slice(h)) };
  return { months: rows.length, grossPctPerMonth: r3(100 * raw.gross), tGrossNW: r3(raw.tGross), netPctPerMonth: r3(100 * raw.net), tNW: r3(raw.tNet),
    firstHalfPct: r3(100 * raw.firstHalf), secondHalfPct: r3(100 * raw.secondHalf), meanTurnover: r3(mean(rows.map((x) => x.turn))),
    meanNames: Math.round(mean(rows.map((x) => x.n))), raw, series: rows.map((x) => ({ ym: x.ym, gross: r5(x.gross), net: r5(x.net) })) };
}
const fin = (x) => typeof x === "number" && Number.isFinite(x);
function holdoutVerdict(raw) {   // unrounded: net mean > 0 AND net NW t >= BAR AND both halves' net means > 0
  return fin(raw.net) && raw.net > 0 && fin(raw.tNet) && raw.tNet >= BAR && fin(raw.firstHalf) && raw.firstHalf > 0 && fin(raw.secondHalf) && raw.secondHalf > 0;
}
function controlsVerdict(nulRaw, pkRaw) {   // unrounded: bootstrap-null |gross t| < 2 AND peek gross t >= 5
  const leakOk = fin(nulRaw.tGross) && Math.abs(nulRaw.tGross) < 2, peekOk = fin(pkRaw.tGross) && pkRaw.tGross >= 5;
  return { leakOk, peekOk, pass: leakOk && peekOk };
}

// ---------- synthetic panel for --selftest ----------
function synthPanel({ N = 600, months = 40, plant = 0, seed = 7 }) {
  const rng = mulberry(seed), gauss = () => { let u = 0; while (!u) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); };
  const dates = []; let d = Date.UTC(2014, 0, 1); const T0 = 260, target = T0 + months * 21 + 5;
  while (dates.length < target) { const dt = new Date(d), wd = dt.getUTCDay(); if (wd > 0 && wd < 6) dates.push(dt.toISOString().slice(0, 10)); d += 864e5; }
  const T = dates.length, C = new Float32Array(N * T), O = new Float32Array(N * T), V = new Float32Array(N * T), me = monthEnds(dates);
  const R = new Float64Array(N * T), vol = Array.from({ length: N }, () => 0.01 + 0.03 * rng()), drift = new Float64Array(N);
  let nextMe = 0;
  for (let t = 0; t < T; t++) {
    // market factor + idiosyncratic noise + occasional jump days (to make salience bite)
    const mk = 0.008 * gauss();
    for (let s = 0; s < N; s++) { const o = s * T; if (t === 0) { C[o] = 50; O[o] = 50; V[o] = 1e5 + 1e6 * ((s * 7919) % 1000) / 1000; continue; }
      const jump = rng() < 0.03 ? (rng() < 0.5 ? -1 : 1) * (0.05 + 0.1 * rng()) : 0;
      const r = drift[s] + mk + vol[s] * gauss() + jump; R[o + t] = r; C[o + t] = C[o + t - 1] * (1 + r); O[o + t] = C[o + t - 1]; V[o + t] = V[o]; }
    if (nextMe < me.length && t === me[nextMe]) {   // month-end: plant next month's drift = -plant x ST (computed from data <= t)
      if (plant && t >= T0) { const Q = prepare({ meta: { dates }, T, N, C, O, V }); for (let s = 0; s < N; s++) { const st = stAt(Q, s, t); drift[s] = Number.isFinite(st) ? -plant * st / 21 : 0; } }
      nextMe++; }
  }
  return { meta: { dates, symbols: Array.from({ length: N }, (_, i) => "S" + i) }, T, N, C, O, V, synthetic: true };
}

function selftest() {
  const res = []; const ok = (name, pass, detail) => { res.push({ name, pass }); console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };
  // 1. formula vs an independent brute-force implementation of Cov(omega, r) with omega_s = delta^k / (sum delta^k pi), pi = 1/S
  const rng = mulberry(11); let maxErr = 0;
  for (let rep = 0; rep < 200; rep++) { const S = 15 + Math.floor(rng() * 7), r = [], rb = []; for (let i = 0; i < S; i++) { r.push((rng() - 0.5) * 0.1); rb.push((rng() - 0.5) * 0.03); }
    const sal = r.map((x, i) => Math.abs(x - rb[i]) / (Math.abs(x) + Math.abs(rb[i]) + 0.1)); const rank = sal.map((v) => 1 + sal.filter((u) => u > v).length);
    const den = rank.reduce((s, k) => s + Math.pow(0.7, k) / S, 0), om = rank.map((k) => Math.pow(0.7, k) / den);
    const mo = mean(om), mr = mean(r); let cov = 0; for (let i = 0; i < S; i++) cov += (om[i] - mo) * (r[i] - mr) / S;
    maxErr = Math.max(maxErr, Math.abs(cov - stValue(r, rb))); }
  ok("ST equals Cov(omega, r) brute force (200 random windows)", maxErr < 1e-12, `max abs err ${maxErr.toExponential(2)}`);
  // 2. hand example: S=15, one +10% day (market 0), fourteen 0% days on 0% market -> ties among the zeros
  { const r = Array(15).fill(0), rb = Array(15).fill(0); r[3] = 0.10; const st = stValue(r, rb), Z = [...Array(15)].reduce((s, _, k) => s + 0.7 ** (k + 1), 0), want = (0.7 / Z - 1 / 15) * 0.10;
    ok("hand example (one salient +10% day)", Math.abs(st - want) < 1e-12, `ST ${st.toFixed(6)} vs ${want.toFixed(6)}`); }
  // 3. sign: salient upside -> ST > 0, salient downside -> ST < 0
  { const base = Array.from({ length: 21 }, (_, i) => 0.002 * Math.sin(i)), rb = Array(21).fill(0.001), up = base.slice(), dn = base.slice(); up[5] = 0.12; dn[5] = -0.12;
    ok("salient upside ST>0, salient downside ST<0", stValue(up, rb) > 0 && stValue(dn, rb) < 0, `${stValue(up, rb).toFixed(5)} / ${stValue(dn, rb).toFixed(5)}`); }
  // 4. all days equally salient -> ST = 0 (tie invariance)
  { const r = Array(21).fill(0.01), rb = Array(21).fill(0.01); ok("fully tied salience gives ST = 0", Math.abs(stValue(r, rb)) < 1e-15); }
  // 5. too few days -> NaN
  ok("S < 15 gives NaN", Number.isNaN(stValue(Array(14).fill(0.01), Array(14).fill(0))));
  // 6. no look-ahead: perturbing every price after t leaves the formation (universe + ST) unchanged
  { const P = synthPanel({ N: 200, months: 14, seed: 3 }), me = monthEnds(P.meta.dates), t = me[me.length - 3], A = formAt(prepare(P), t);
    const P2 = { ...P, C: new Float32Array(P.C), O: new Float32Array(P.O) }; for (let s = 0; s < P.N; s++) for (let k = t + 1; k < P.T; k++) { P2.C[s * P.T + k] *= 1 + 0.5 * Math.sin(s + k); P2.O[s * P.T + k] *= 1.3; }
    const B = formAt(prepare(P2), t), same = A.length === B.length && A.every((a, i) => a.s === B[i].s && (a.st === B[i].st || (Number.isNaN(a.st) && Number.isNaN(B[i].st))));
    ok("formation unchanged when all post-t prices are perturbed", same && A.length > 100, `${A.length} names`); }
  // 7. planted effect (next-month drift = -2 x ST): long-low/short-high GROSS t must be >= 5 and positive
  { const P = synthPanel({ N: 600, months: 40, plant: 2.0, seed: 5 }), d = P.meta.dates, r = run(prepare(P), d[300].slice(0, 7), d[d.length - 1].slice(0, 7));
    ok("planted salience effect recovered (gross NW t >= 5)", fin(r.raw.tGross) && r.raw.tGross >= 5 && r.raw.gross > 0, `${r.months} months, gross ${r.grossPctPerMonth}%/mo, t ${r.tGrossNW}`); }
  // 8. no effect planted: gross |t| < 2.5 (noise), net mean below gross by the cost
  { const P = synthPanel({ N: 600, months: 40, plant: 0, seed: 9 }), d = P.meta.dates, r = run(prepare(P), d[300].slice(0, 7), d[d.length - 1].slice(0, 7));
    ok("no planted effect -> |gross t| < 2.5", fin(r.raw.tGross) && Math.abs(r.raw.tGross) < 2.5 && r.raw.net < r.raw.gross, `gross ${r.grossPctPerMonth}%/mo t ${r.tGrossNW}, net ${r.netPctPerMonth}`); }
  // 9. peek positive control on synthetic data
  { const P = synthPanel({ N: 600, months: 30, plant: 0, seed: 13 }), d = P.meta.dates, r = run(prepare(P), d[300].slice(0, 7), d[d.length - 1].slice(0, 7), { peek: true });
    ok("peek control on synthetic data (gross t >= 5)", fin(r.raw.tGross) && r.raw.tGross >= 5, `t ${r.tGrossNW}`); }
  // 10. delisted name is held at its last close
  { const P = synthPanel({ N: 120, months: 14, seed: 17 }), me = monthEnds(P.meta.dates), t0 = me[me.length - 3], t1 = me[me.length - 2], s = 4, o = s * P.T;
    for (let k = t0 + 6; k < P.T; k++) { P.C[o + k] = 0; P.O[o + k] = 0; }
    const want = P.C[o + t0 + 5] / P.O[o + t0 + 1] - 1, got = holdReturn(prepare(P), s, t0, t1); ok("delisted name held at last close", Math.abs(got - want) < 1e-6, `${got.toFixed(5)} vs ${want.toFixed(5)}`); }
  // 11. holdout guard
  { let threw = false; try { run({ real: true, meta: { dates: [] } }, "2017-01", "2022-01"); } catch (e) { threw = /unreachable/.test(e.message); } ok("holdout months unreachable without the holdout token", threw); }
  // 12. F1: holdout verdict reads UNROUNDED values (t 1.6995 displays as 1.7 but must FAIL; a tiny positive net that displays 0.000 must count)
  { const base = { net: 0.004, tNet: 2.1, firstHalf: 0.003, secondHalf: 0.005 };
    const a = holdoutVerdict({ ...base, tNet: 1.6995 }), b = holdoutVerdict({ ...base, tNet: 1.70 }), c = holdoutVerdict({ ...base, net: 4e-7 }), dd = holdoutVerdict({ ...base, secondHalf: -4e-7 });
    ok("holdout verdict unrounded (t 1.6995 FAILS 1.70; t 1.70 passes; net 4e-7 counts > 0; half -4e-7 fails)", !a && b && c && !dd, `r3(1.6995) displays ${r3(1.6995)}; r3(100*4e-7) displays ${r3(100 * 4e-7)}`); }
  // 13. F1: controls verdict reads UNROUNDED t (null 1.9996 displays 2 but passes |t| < 2; peek 4.9996 displays 5 but FAILS t >= 5)
  { const v1 = controlsVerdict({ tGross: 1.9996 }, { tGross: 6 }), v2 = controlsVerdict({ tGross: 0.5 }, { tGross: 4.9996 }), v3 = controlsVerdict({ tGross: null }, { tGross: 6 });
    ok("controls verdict unrounded (null t 1.9996 passes, peek t 4.9996 fails, null t missing fails)", v1.leakOk && v1.pass && !v2.peekOk && !v2.pass && !v3.leakOk); }
  // 14. P2: split-invariant liquidity screen. (a) rescaling a name's whole history as a later split adjustment would (price x 0.05,
  //     volume x 20) leaves the universe unchanged -- the old $5 floor would have dropped those names; (b) a name with a huge 60-day MEAN
  //     but a MEDIAN dollar volume below $5M is excluded.
  { const P = synthPanel({ N: 200, months: 14, seed: 3 }), me = monthEnds(P.meta.dates), t = me[me.length - 3], A = formAt(prepare(P), t);
    const P2 = { ...P, C: new Float32Array(P.C), O: new Float32Array(P.O), V: new Float32Array(P.V) };
    for (let s = 0; s < 20; s++) for (let k = 0; k < P.T; k++) { const i = s * P.T + k; P2.C[i] *= 0.05; P2.O[i] *= 0.05; P2.V[i] *= 20; }
    const B = formAt(prepare(P2), t), key = (U) => U.map((u) => u.s).sort((x, y) => x - y).join(","), stA = new Map(A.map((u) => [u.s, u.st]));
    const stErr = Math.max(0, ...B.map((u) => (Number.isFinite(u.st) ? Math.abs(u.st - stA.get(u.s)) : 0)));
    const lowPx = B.filter((u) => u.s < 20 && P2.C[u.s * P.T + t] < 5).length;
    ok("P2 universe invariant to split-style rescale; sub-$5 adjusted names stay eligible", key(A) === key(B) && stErr < 1e-6 && lowPx > 0 && A.length > 100, `${A.length} names, ${lowPx} rescaled names under $5 kept, max ST diff ${stErr.toExponential(1)}`);
    const P3 = { ...P, V: new Float32Array(P.V) }, s1 = A[0].s; for (let k = t - 59; k <= t; k++) P3.V[s1 * P.T + k] = (k - t) % 6 === 0 ? 1e9 : 1;
    const Cq = formAt(prepare(P3), t), inA = A.some((u) => u.s === s1), inC = Cq.some((u) => u.s === s1);
    ok("P2 median dollar-volume screen excludes a spiky name (high mean, median < $5M)", inA && !inC, `name S${s1}: before ${inA}, after ${inC}`); }
  // 15. P3: the bootstrap null uses only returns dated <= nullThrough -- perturbing every price after the cut leaves the null identical,
  //     and every post-cut return / close is blank in the null
  { const P = synthPanel({ N: 120, months: 14, seed: 21 }), d = P.meta.dates, cut = d[Math.floor(P.T * 0.6)];
    const P2 = { ...P, C: new Float32Array(P.C), O: new Float32Array(P.O) }; for (let s = 0; s < P.N; s++) for (let k = 0; k < P.T; k++) if (d[k] > cut) { P2.C[s * P.T + k] *= 1 + 0.4 * Math.sin(3 * s + k); P2.O[s * P.T + k] *= 1.2; }
    const Qa = prepare(P, 99, cut), Qb = prepare(P2, 99, cut); let same = true, postBlank = true, preFinite = 0;
    for (let i = 0; i < P.N * P.T; i++) { const k = i % P.T, ra = Qa.R[i], rb2 = Qb.R[i], ca = Qa.Cx[i], cb = Qb.Cx[i];
      if (!((ra === rb2 || (isNaN(ra) && isNaN(rb2))) && (ca === cb || (isNaN(ca) && isNaN(cb))))) same = false;
      if (d[k] > cut) { if (!isNaN(ra) || !isNaN(ca)) postBlank = false; } else if (!isNaN(ra)) preFinite++; }
    const rbSame = Array.from(Qa.RB).every((x, k) => x === Qb.RB[k] || (isNaN(x) && isNaN(Qb.RB[k])));
    ok("P3 bootstrap null blind to post-cut prices (pool, drift, rbar) and blanks post-cut cells", same && rbSame && postBlank && preFinite > 1000, `cut ${cut}, ${preFinite} pre-cut null returns`); }
  // 16. F2: require() never runs a mode; the pure functions are exported
  { const cp = require("child_process"), out = cp.spawnSync(process.execPath, ["-e", `const m = require(${JSON.stringify(__filename)}); console.log("LOADED_OK", typeof m.stValue, typeof m.holdoutVerdict, typeof m.run)`], { encoding: "utf8", timeout: 60000 });
    const txt = (out.stdout || "").trim(); ok("require() runs no mode; exports present", txt === "LOADED_OK function function function", JSON.stringify(txt.slice(0, 80))); }
  const pass = res.every((x) => x.pass); console.log(`${KEY} SELFTEST ${pass ? "PASS" : "FAIL"} (${res.filter((x) => x.pass).length}/${res.length})`); return pass;
}

module.exports = { stValue, prepare, formAt, holdReturn, run, summarize, holdoutVerdict, controlsVerdict, monthEnds, synthPanel, selftest, median };

if (require.main === module) (async () => {   // F2 (2026-09-23): require() never runs a mode
  const mode =["--selftest", "--controls", "--discovery", "--holdout", "--status"].find((m) => process.argv.includes(m)) || "--status";
  if (mode === "--selftest") { process.exit(selftest() ? 0 : 1); }
  fs.mkdirSync(HD, { recursive: true });
  if (mode === "--status") { console.log(`${KEY}: controls ${fs.existsSync(CTRL) ? "done" : "pending"} · discovery ${fs.existsSync(OUTD) ? "sealed" : "pending"} · holdout ${fs.existsSync(OUTH) ? "READ" : "sealed/unopened"}`); return; }
  if (mode === "--discovery" && fs.existsSync(OUTD)) { console.error("discovery already sealed — refusing"); process.exit(2); }
  if (mode === "--holdout" && fs.existsSync(OUTH)) { console.error("holdout already read — refusing"); process.exit(2); }
  if (mode === "--holdout" && !fs.existsSync(OUTD)) { console.error("discovery not sealed — refusing"); process.exit(2); }
  if (mode === "--discovery") {
    const ctrl = fs.existsSync(CTRL) ? JSON.parse(fs.readFileSync(CTRL, "utf8")) : null; if (!ctrl || !ctrl.pass) { console.error("controls have not passed — refusing"); process.exit(2); }
    const reg = JSON.parse(fs.readFileSync(path.join(DATA, "test-registry.json"), "utf8"));
    if (!(reg.preregistered || []).some((x) => x && x.script === SCRIPT)) { console.error(`no preregistered entry with script ${SCRIPT} — refusing`); process.exit(2); }
  }
  const P = loadPanel(); console.log(`panel ${P.N} symbols x ${P.T} days`);
  if (mode === "--controls") {
    const nul = run(prepare(P, 1601, NULL_THROUGH), DISC[0], DISC[1]), pk = run(prepare(P), DISC[0], DISC[1], { peek: true });
    const { leakOk, peekOk, pass } = controlsVerdict(nul.raw, pk.raw);   // unrounded
    writeJsonAtomic(CTRL, { spec: `${KEY}-controls-v2`, asOf: new Date().toISOString(), window: DISC, panel: "anomaly-cache-v2", nullThrough: NULL_THROUGH, leakBootstrapGrossT: nul.tGrossNW, leakBootstrapGrossTRaw: nul.raw.tGross, leakMonths: nul.months, leakOk, peekGrossT: pk.tGrossNW, peekGrossTRaw: pk.raw.tGross, peekOk, pass });
    console.log(`${KEY} controls — bootstrap null |gross t| < 2: ${leakOk ? "PASS" : "FAIL"} (t ${nul.tGrossNW}) · positive control gross t ${pk.tGrossNW} ${peekOk ? "PASS" : "FAIL"}`); return;
  }
  if (mode === "--discovery") {
    const r = run(prepare(P), DISC[0], DISC[1]);
    writeJsonAtomic(OUTD, { spec: `${KEY}-discovery-v2`, sealedAt: new Date().toISOString(), window: DISC, panel: "anomaly-cache-v2", rule: "long lowest-ST quintile, short highest; ST delta 0.7 theta 0.1 over 21 days; universe = median 60d $vol >= $5M, top 1,500 by mean 60d $vol, no price floor", result: r });
    console.log(`${KEY} DISCOVERY ${DISC.join("..")} (sealed) — net ${r.netPctPerMonth}%/mo (gross ${r.grossPctPerMonth}) · NW t ${r.tNW} (gross t ${r.tGrossNW}) · halves ${r.firstHalfPct}/${r.secondHalfPct} · turnover ${r.meanTurnover} · ${r.months} months`); return;
  }
  if (mode === "--holdout") {
    const r = run(prepare(P), HOLD[0], HOLD[1], { token: HOLDOUT_TOKEN });
    const clears = holdoutVerdict(r.raw), verdict = clears ? "PASS" : "DID NOT PASS";   // unrounded
    writeJsonAtomic(OUTH, { spec: `${KEY}-holdout-v2`, read: true, asOf: new Date().toISOString(), window: HOLD, panel: "anomaly-cache-v2", bar: BAR, result: r, verdict });
    console.log(`${KEY} HOLDOUT ${HOLD.join("..")} — ${verdict} (bar t >= ${BAR}) · net ${r.netPctPerMonth}%/mo (gross ${r.grossPctPerMonth}) · NW t ${r.tNW} · halves ${r.firstHalfPct}/${r.secondHalfPct} · ${r.months} months`);
  }
})().catch((e) => { console.error(`${KEY} FAILED:`, e.message); process.exit(1); });
