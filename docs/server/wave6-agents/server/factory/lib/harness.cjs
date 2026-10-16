"use strict";
/**
 * HARNESS — the research server's one test lane: DAILY bars, a builder-written signal(), the registered statistic, outcome-blind
 * controls on scrambles, and the one sealed read. 2026-10-09 (docs/server/wave6-agents; research engine stages 3-4).
 *
 * WHO WRITES WHAT. The builder (an agent) writes ONLY work/<F>/signal.cjs: `module.exports = { meta: { lookbackDays }, signal(ctx) }`.
 * Everything else — loading, the as-of view, returns, costs, the statistic and its clustering unit, the scrambles, the controls and
 * the read — is this file (plain code). The builder never sees real outcomes: it can only run its signal on SYNTHETIC data
 * (fcode.cjs check-signal). Real bars reach the signal in two places, both run by plain code as user traids in a child process with
 * Node's permission model (no writes, no child processes, reads limited to the data, the harness and the frozen signal):
 *   controls  scrambled copies of the real panel ONLY (outcome-blind: no statistic on real data is computed or stored);
 *   read      the real panel, ONCE per F id, after the controls passed and home acknowledged the registration (fcode.cjs).
 *
 * DATASETS
 *   eq-daily   backend/data/anomaly-cache-v2 pushed as a seed (meta.json + open/close/vol .f32, symbol-major, point-in-time listings
 *              incl. delisted names, adjustment=all; 2016-01-04 .. 2026-09-22; frozen since 09-24)
 *   fut-daily  backend/data/futures-daily/<ROOT>.json (futures-daily-v1: Schwab daily continuous bars)
 *   synthetic  seeded random walks (optionally AR(1)) — the builder's check and the selftests
 *
 * THE AS-OF VIEW (ctx). At decision index t: ctx.t, ctx.date, ctx.n (symbols), ctx.symbol(i), ctx.listed(i), ctx.universe() (indices
 * listed at t), ctx.close(i, lag), ctx.open(i, lag), ctx.volume(i, lag), ctx.history(i, field, n) (oldest first, up to t), ctx.state (the
 * signal's own object, kept across days). lag must be an integer >= 0: a negative / non-integer lag THROWS LookAheadError. Before the
 * first bar -> NaN. The signal returns [[i, weight], ...] (or {i: weight}); weights are normalised to gross 1 (sum |w| = 1).
 *
 * THE STATISTIC (registration.statistic.kind "daily-portfolio"). Decision at the close of t; entry "close" earns close(t+1)/close(t)-1,
 * "nextOpen" earns close(t+1)/open(t+1)-1; a missing price earns 0. Rebalance every `rebalanceDays`; between rebalances the weights
 * carry. Cost = costBps/1e4 x turnover (sum |w_t - w_t-1|), charged on the day. Net daily return series over INVESTED days (gross > 0);
 * t = Newey-West HAC t of its mean (lag statistic.nwLag, Bartlett weights). Clustering unit: days.
 * DECISION GATES (the registered rule, applied identically to scrambles and to the read):
 *   t >= bar · both halves' t > 0 · t at 2x cost > 0 · random-timing placebo t < bar (each symbol's weight series cyclically shifted
 *   by a seeded offset) · invested days >= minN.
 * CONTROLS (before any read; scrambles of the real panel only):
 *   calibration  K scrambles (drift-kept within-symbol block shuffles of daily returns, blockDays from the registration; the listing
 *                pattern kept): the share of scrambles on which the WHOLE decision rule passes must be <= falsePassMax
 *   power        P scrambles with an edge planted in the signal's own direction (+ mdeDailyBps per position-day): the share that pass
 *                must be >= plantedPowerMin (an underpowered design is not read)
 *   leak         L cut points on a scramble: the positions up to the cut must not change when everything after it is replaced
 * Seeds come from the registration sha, so controls and placebo are fixed at registration.
 * LIMIT (stated, not hidden): node:vm is not a security boundary against a model that deliberately escapes it. The fences are the
 * static screen, the vm context (no eval / Function from strings), the child's permission model, the leak test, the reviewer and the
 * three refuters — against accidental look-ahead and side effects, not against sabotage.
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), crypto = require("crypto");
const { mulberry32 } = require("./nullbar.cjs");
const seedOf = (s) => crypto.createHash("sha256").update(String(s)).digest().readUInt32BE(0);
class LookAheadError extends Error { constructor(m) { super(m); this.name = "LookAheadError"; } }

// ── panels ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const f32view = (buf) => (buf.byteOffset % 4 === 0 ? new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4) : new Float32Array(new Uint8Array(buf).buffer));
function windowIdx(dates, from, to) { let a = 0; while (a < dates.length && dates[a] < from) a++; let b = dates.length; while (b > a && dates[b - 1] > to) b--; return [a, b]; }
/** anomaly-cache-v2 -> panel over [from, to] (inclusive), optionally a symbol list */
function loadEqDaily(dir, { from = "0000-00-00", to = "9999-99-99", symbols = null } = {}) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  if (meta.spec !== "anomaly-cache-v2" || !Array.isArray(meta.dates) || !Array.isArray(meta.symbols)) throw new Error("eq-daily: meta.json is not anomaly-cache-v2");
  const D0 = meta.dates.length, S0 = meta.symbols.length, [a, b] = windowIdx(meta.dates, from, to), D = b - a;
  if (D < 2) throw new Error(`eq-daily: no dates in ${from}..${to}`);
  let pick = meta.symbols.map((_, i) => i);
  if (symbols) { pick = symbols.map((s) => meta.symbols.indexOf(s)); const miss = symbols.filter((s, k) => pick[k] < 0); if (miss.length) throw new Error(`eq-daily: unknown symbol(s) ${miss.slice(0, 5).join(", ")}`); }
  const read = (f) => { const buf = fs.readFileSync(path.join(dir, f)); if (buf.length !== S0 * D0 * 4) throw new Error(`eq-daily: ${f} has ${buf.length} bytes, want ${S0 * D0 * 4}`); const src = f32view(buf), out = new Float32Array(pick.length * D); pick.forEach((s, k) => out.set(src.subarray(s * D0 + a, s * D0 + b), k * D)); return out; };
  return { dataset: "eq-daily", dates: meta.dates.slice(a, b), symbols: pick.map((i) => meta.symbols[i]), S: pick.length, D, open: read("open.f32"), close: read("close.f32"), vol: read("vol.f32") };
}
/** futures-daily/<ROOT>.json -> panel on the union of dates */
function loadFutDaily(dir, { from = "0000-00-00", to = "9999-99-99", symbols = null } = {}) {
  const files = fs.readdirSync(dir).filter((f) => /^[A-Z0-9]{1,6}\.json$/.test(f)).sort();
  const docs = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))).filter((d) => d && d.spec === "futures-daily-v1" && Array.isArray(d.bars) && (!symbols || symbols.includes(d.root)));
  if (symbols && docs.length !== symbols.length) throw new Error("fut-daily: unknown root(s) " + symbols.filter((s) => !docs.some((d) => d.root === s)).join(", "));
  const dates = [...new Set(docs.flatMap((d) => d.bars.map((x) => x.d)))].filter((d) => d >= from && d <= to).sort(), D = dates.length, S = docs.length, at = new Map(dates.map((d, i) => [d, i]));
  if (D < 2 || !S) throw new Error(`fut-daily: no bars in ${from}..${to}`);
  const open = new Float32Array(S * D).fill(NaN), close = new Float32Array(S * D).fill(NaN), vol = new Float32Array(S * D).fill(NaN);
  docs.forEach((d, s) => { for (const x of d.bars) { const i = at.get(x.d); if (i == null) continue; open[s * D + i] = x.o; close[s * D + i] = x.c; vol[s * D + i] = x.v; } });
  return { dataset: "fut-daily", dates, symbols: docs.map((d) => d.root), S, D, open, close, vol };
}
/** seeded synthetic panel: S symbols, D days, daily vol sigma, drift mu, AR(1) coefficient ar (a real, detectable edge when != 0) */
function synthetic({ S = 30, D = 500, seed = 1, mu = 0.0002, sigma = 0.02, ar = 0, gaps = true, start = "2020-01-01" } = {}) {
  const rng = mulberry32(seed), gauss = () => { let u = 0, v = 0; while (u === 0) u = rng(); v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const dates = []; for (let d = new Date(start + "T00:00:00Z"); dates.length < D; d = new Date(d.getTime() + 86400000)) { const w = d.getUTCDay(); if (w !== 0 && w !== 6) dates.push(d.toISOString().slice(0, 10)); }
  const open = new Float32Array(S * D).fill(NaN), close = new Float32Array(S * D).fill(NaN), vol = new Float32Array(S * D).fill(NaN);
  for (let s = 0; s < S; s++) {
    const a = gaps && s % 7 === 3 ? Math.floor(D * 0.2) : 0, b = gaps && s % 11 === 5 ? Math.floor(D * 0.8) : D;
    let px = 50 + 50 * rng(), prev = 0;
    for (let t = a; t < b; t++) {
      const r = mu + ar * prev + sigma * gauss(); prev = r;
      const o = px * (1 + 0.2 * sigma * gauss()); px = px * Math.exp(r);
      open[s * D + t] = o; close[s * D + t] = px; vol[s * D + t] = 1e5 * (1 + rng());
    }
  }
  return { dataset: "synthetic", dates, symbols: Array.from({ length: S }, (_, i) => "SYN" + i), S, D, open, close, vol };
}
/**
 * Drift-kept within-symbol block shuffle: each symbol's day-to-day log returns (between consecutive listed days), with that day's
 * open gap and volume, are shuffled in blocks of `blockDays` and the path is rebuilt from the first listed close. The listing pattern
 * (which days are NaN), the multiset of returns and the endpoint are kept; any link between the past and the next day's return
 * beyond a block, and every cross-sectional alignment, is destroyed.
 */
function scramble(P, seed, blockDays = 5) {
  const rng = mulberry32(seed >>> 0), D = P.D, open = new Float32Array(P.open.length).fill(NaN), close = new Float32Array(P.close.length).fill(NaN), vol = new Float32Array(P.vol.length).fill(NaN);
  const B = Math.max(1, Math.floor(blockDays));
  for (let s = 0; s < P.S; s++) {
    const o = s * D, F = []; for (let t = 0; t < D; t++) if (Number.isFinite(P.close[o + t]) && P.close[o + t] > 0) F.push(t);
    if (!F.length) continue;
    const m = F.length - 1, lr = new Float64Array(m + 1), g = new Float64Array(m + 1), v = new Float64Array(m + 1);
    for (let k = 1; k <= m; k++) { const c0 = P.close[o + F[k - 1]], c1 = P.close[o + F[k]], op = P.open[o + F[k]]; lr[k] = Math.log(c1 / c0); g[k] = Number.isFinite(op) ? op / c0 : NaN; v[k] = P.vol[o + F[k]]; }
    const blocks = []; for (let k = 1; k <= m; k += B) blocks.push([k, Math.min(m, k + B - 1)]);
    for (let i = blocks.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const x = blocks[i]; blocks[i] = blocks[j]; blocks[j] = x; }
    const perm = []; for (const [a, b] of blocks) for (let k = a; k <= b; k++) perm.push(k);
    close[o + F[0]] = P.close[o + F[0]]; open[o + F[0]] = P.open[o + F[0]]; vol[o + F[0]] = P.vol[o + F[0]];
    let prev = P.close[o + F[0]];
    for (let j = 1; j <= m; j++) { const k = perm[j - 1], c = prev * Math.exp(lr[k]); close[o + F[j]] = c; open[o + F[j]] = Number.isFinite(g[k]) ? prev * g[k] : NaN; vol[o + F[j]] = v[k]; prev = c; }
  }
  return { ...P, open, close, vol, scrambledWith: { seed, blockDays: B } };
}
/** replace everything AFTER index cut with another scramble's values (the leak test) */
function withFutureReplaced(P, cut, seed, blockDays) {
  const Q = scramble(P, seed, blockDays), out = { ...P, open: new Float32Array(P.open), close: new Float32Array(P.close), vol: new Float32Array(P.vol) };
  for (let s = 0; s < P.S; s++) for (let t = cut + 1; t < P.D; t++) { const i = s * P.D + t; out.open[i] = Q.open[i]; out.close[i] = Q.close[i] * (Number.isFinite(P.close[s * P.D + cut]) && Number.isFinite(Q.close[s * P.D + cut]) ? P.close[s * P.D + cut] / Q.close[s * P.D + cut] : 1); out.vol[i] = Q.vol[i]; }
  return out;
}

// ── the signal: static screen + vm context ─────────────────────────────────────────────────────────────────────────────────
const FORBID = [
  [/\brequire\s*\(/, "require()"], [/\bimport\s*[\s({*]/, "import"], [/\bprocess\b/, "process"], [/\bglobalThis\b|\bglobal\b(?!\s*:)/, "global"],
  [/\beval\b/, "eval"], [/\bFunction\b/, "Function"], [/\.\s*constructor\b|\[\s*["'`]constructor|\b__proto__\b|\bprototype\b|\bgetPrototypeOf\b|\bsetPrototypeOf\b/, "prototype access"],
  [/\bReflect\b|\bProxy\b/, "Reflect/Proxy"], [/\bfetch\b|\bXMLHttpRequest\b|\bWebSocket\b/, "network"], [/\bset(?:Timeout|Interval|Immediate)\b|\bqueueMicrotask\b/, "timers"],
  [/\bWebAssembly\b|\bAtomics\b|\bSharedArrayBuffer\b|\bBuffer\b/, "low-level memory"], [/\b__dirname\b|\b__filename\b/, "file paths"], [/\bchild_process\b|\bworker_threads\b/, "processes"],
];
/** Pure: why this signal source may not run, or null */
function screenSignal(src) {
  const code = String(src).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  if (!/module\.exports\s*=/.test(code)) return "signal.cjs must assign module.exports = { meta, signal }";
  for (const [re, what] of FORBID) if (re.test(code)) return `signal.cjs uses ${what} — not allowed in a signal (it gets everything through ctx)`;
  if (code.length > 200000) return "signal.cjs is over 200 kB";
  return null;
}
function compileSignal(src, name = "signal.cjs") {
  const why = screenSignal(src); if (why) throw new Error(why);
  const box = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, name: "signal-sandbox" });
  const fn = vm.runInContext(`(function (module, exports) {\n${src}\n})`, box, { filename: name, timeout: 5000 });
  const mod = vm.runInContext("({ exports: {} })", box); fn(mod, mod.exports);
  const ex = mod.exports;
  if (!ex || typeof ex.signal !== "function") throw new Error("signal.cjs does not export signal(ctx)");
  const meta = ex.meta && typeof ex.meta === "object" ? ex.meta : {};
  const lookback = Number.isInteger(meta.lookbackDays) && meta.lookbackDays >= 0 && meta.lookbackDays <= 2000 ? meta.lookbackDays : 260;
  return { signal: ex.signal, meta: { ...meta, lookbackDays: lookback }, sha: crypto.createHash("sha256").update(String(src)).digest("hex") };
}
/** the as-of view; one object reused across days (holder.t moves) */
function makeCtx(P, holder) {
  const D = P.D;
  const lagOk = (lag) => { const l = lag === undefined ? 0 : lag; if (!Number.isInteger(l) || l < 0) throw new LookAheadError(`lag ${String(lag)} at t=${holder.t} (${P.dates[holder.t]}) — a signal may read only bars at or before t`); return l; };
  const get = (arr) => (i, lag) => { const l = lagOk(lag), t = holder.t - l; if (!Number.isInteger(i) || i < 0 || i >= P.S) throw new RangeError(`symbol index ${i}`); return t < 0 ? NaN : arr[i * D + t]; };
  let uniT = -1, uni = null;
  const ctx = {
    get t() { return holder.t; }, get date() { return P.dates[holder.t]; }, n: P.S, state: {},
    symbol: (i) => P.symbols[i], listed: (i) => Number.isFinite(P.close[i * D + holder.t]),
    universe: () => { if (uniT !== holder.t) { uni = []; for (let i = 0; i < P.S; i++) if (Number.isFinite(P.close[i * D + holder.t])) uni.push(i); uniT = holder.t; } return uni.slice(); },
    close: get(P.close), open: get(P.open), volume: get(P.vol),
    history: (i, field, n) => { const arr = field === "open" ? P.open : field === "volume" ? P.vol : P.close; const m = Math.max(0, Math.min(5000, Math.floor(n))), out = new Float64Array(m); for (let k = 0; k < m; k++) { const t = holder.t - (m - 1 - k); out[k] = t < 0 ? NaN : arr[i * D + t]; } return out; },
  };
  return ctx;
}
/** normalise a signal's return value -> { idx: Int32Array, w: Float64Array } (gross 1), dropping unlisted names; throws on garbage */
function normalise(P, t, out) {
  const pairs = Array.isArray(out) ? out : out && typeof out === "object" ? Object.entries(out).map(([k, v]) => [Number(k), v]) : out == null ? [] : null;
  if (!pairs) throw new Error(`signal returned ${typeof out} at t=${t}; want [[i, weight], ...]`);
  const m = new Map();
  for (const p of pairs) {
    if (!Array.isArray(p) || p.length !== 2) throw new Error(`signal returned a malformed pair at t=${t}`);
    const [i, w] = p; if (!Number.isInteger(i) || i < 0 || i >= P.S) throw new Error(`signal returned symbol index ${i} at t=${t}`);
    if (!Number.isFinite(w)) throw new Error(`signal returned a non-finite weight at t=${t}`);
    if (w !== 0 && Number.isFinite(P.close[i * P.D + t])) m.set(i, (m.get(i) || 0) + w);
  }
  let g = 0; for (const w of m.values()) g += Math.abs(w);
  const idx = new Int32Array(m.size), w = new Float64Array(m.size); let k = 0;
  for (const [i, x] of [...m.entries()].sort((a, b) => a[0] - b[0])) { idx[k] = i; w[k] = g > 0 ? x / g : 0; k++; }
  return g > 0 ? { idx, w } : { idx: new Int32Array(0), w: new Float64Array(0) };
}
/** run the signal over decision indices [start, end) -> days[k] = { t, idx, w } */
function runSignal(P, sig, { start, end, rebalanceDays = 1, stopAt = null } = {}) {
  const holder = { t: 0 }, ctx = makeCtx(P, holder), days = [];
  let cur = { idx: new Int32Array(0), w: new Float64Array(0) };
  const last = stopAt == null ? end : Math.min(end, stopAt + 1);
  for (let t = start; t < last; t++) {
    holder.t = t;
    if ((t - start) % Math.max(1, rebalanceDays) === 0) cur = normalise(P, t, sig.signal(ctx));
    else { const keep = []; for (let k = 0; k < cur.idx.length; k++) if (Number.isFinite(P.close[cur.idx[k] * P.D + t])) keep.push(k); if (keep.length !== cur.idx.length) { const idx = Int32Array.from(keep.map((k) => cur.idx[k])), w0 = keep.map((k) => cur.w[k]), g = w0.reduce((a, x) => a + Math.abs(x), 0); cur = { idx, w: Float64Array.from(w0.map((x) => (g > 0 ? x / g : 0))) }; } }
    days.push({ t, idx: cur.idx, w: cur.w });
  }
  return days;
}
/**
 * The planted edge of the power control, as a property of the DATA: asset i's return from t to t+1 is shifted by plantBps in the
 * direction of the signal's own weight at t. Built once from the signal's real positions, then applied to every return computed on
 * that panel — so the placebo (shifted timing) does NOT inherit the edge, exactly as a real timing edge would behave.
 */
function plantOf(P, days, plantBps) {
  const m = new Map(); if (!plantBps) return m;
  for (const d of days) for (let j = 0; j < d.idx.length; j++) m.set(d.idx[j] * P.D + d.t, (plantBps / 1e4) * Math.sign(d.w[j]));
  return m;
}
/** daily returns from positions. plant: Map (i*D+t) -> added return (the power control) */
function returnsOf(P, days, { entry = "close", costBps = 0, plant = null } = {}) {
  const n = days.length, gross = new Float64Array(n), turn = new Float64Array(n), invested = new Uint8Array(n);
  let prev = new Map();
  for (let k = 0; k < n; k++) {
    const { t, idx, w } = days[k], next = new Map();
    let g = 0, tv = 0;
    for (let j = 0; j < idx.length; j++) {
      const i = idx[j], o = i * P.D; let r = 0;
      if (t + 1 < P.D) { const c1 = P.close[o + t + 1], base = entry === "nextOpen" ? P.open[o + t + 1] : P.close[o + t]; if (Number.isFinite(c1) && Number.isFinite(base) && base > 0) r = c1 / base - 1; }
      if (plant && plant.size) r += plant.get(o + t) || 0;
      g += w[j] * r; next.set(i, w[j]); tv += Math.abs(w[j] - (prev.get(i) || 0));
    }
    for (const [i, x] of prev) if (!next.has(i)) tv += Math.abs(x);
    gross[k] = g; turn[k] = tv; invested[k] = idx.length ? 1 : 0; prev = next;
  }
  const net = (mult) => { const a = []; for (let k = 0; k < n; k++) if (invested[k]) a.push(gross[k] - mult * (costBps / 1e4) * turn[k]); return a; };
  return { net: net(1), net2x: net(2), investedDays: invested.reduce((a, x) => a + x, 0) };
}
/** Newey-West HAC t of the mean (Bartlett weights, lag L) */
function nwT(x, L = 5) {
  const n = x.length; if (n < 3) return { t: 0, mean: n ? x.reduce((a, b) => a + b, 0) / n : 0, se: null, n };
  const m = x.reduce((a, b) => a + b, 0) / n; let g0 = 0; for (let i = 0; i < n; i++) g0 += (x[i] - m) ** 2; g0 /= n;
  let s = g0; for (let k = 1; k <= Math.min(L, n - 1); k++) { let gk = 0; for (let i = k; i < n; i++) gk += (x[i] - m) * (x[i - k] - m); gk /= n; s += 2 * (1 - k / (L + 1)) * gk; }
  const v = s / n; return { t: v > 0 ? m / Math.sqrt(v) : 0, mean: m, se: v > 0 ? Math.sqrt(v) : null, n };
}
/** each symbol's weight series cyclically shifted by a seeded offset (the random-timing placebo) */
function placeboDays(P, days, seed, minShift = 20) {
  const n = days.length, rng = mulberry32(seed >>> 0), series = new Map();
  days.forEach((d, k) => { for (let j = 0; j < d.idx.length; j++) { const i = d.idx[j]; if (!series.has(i)) series.set(i, new Float64Array(n)); series.get(i)[k] = d.w[j]; } });
  const lo = Math.min(minShift, Math.floor(n / 3)), span = Math.max(1, n - 2 * lo), shifted = new Map();
  for (const [i, s] of [...series.entries()].sort((a, b) => a[0] - b[0])) { const u = lo + Math.floor(rng() * span), z = new Float64Array(n); for (let k = 0; k < n; k++) z[(k + u) % n] = s[k]; shifted.set(i, z); }
  return days.map((d, k) => {
    const pairs = []; for (const [i, z] of shifted) if (z[k] !== 0 && Number.isFinite(P.close[i * P.D + d.t])) pairs.push([i, z[k]]);
    const g = pairs.reduce((a, p) => a + Math.abs(p[1]), 0);
    return { t: d.t, idx: Int32Array.from(pairs.map((p) => p[0])), w: Float64Array.from(pairs.map((p) => (g > 0 ? p[1] / g : 0))) };
  });
}
/** every number the decision rule needs, from one set of positions */
function evaluate(P, days, reg, { plantBps = 0, placeboSeed = 1 } = {}) {
  const st = reg.statistic || {}, L = Number.isInteger(st.nwLag) ? st.nwLag : 5, opt = { entry: reg.entry, costBps: reg.costBps, plant: plantOf(P, days, plantBps) };
  const r = returnsOf(P, days, opt), main = nwT(r.net, L), h = Math.floor(r.net.length / 2);
  const pr = returnsOf(P, placeboDays(P, days, placeboSeed, Math.max(20, 2 * (reg.rebalanceDays || 1))), opt);
  return { n: r.investedDays, t: +main.t.toFixed(4), meanDailyBps: +(main.mean * 1e4).toFixed(4), halvesT: [+nwT(r.net.slice(0, h), L).t.toFixed(4), +nwT(r.net.slice(h), L).t.toFixed(4)], cost2xT: +nwT(r.net2x, L).t.toFixed(4), placeboT: +nwT(pr.net, L).t.toFixed(4) };
}
/** the registered decision rule */
function decide(s, reg) {
  const gates = { tClearsBar: s.t >= reg.bar.bar, halvesPositive: s.halvesT[0] > 0 && s.halvesT[1] > 0, cost2xPositive: s.cost2xT > 0, placeboBelowBar: s.placeboT < reg.bar.bar, enoughDays: s.n >= reg.minN };
  return { pass: Object.values(gates).every(Boolean), gates };
}
/** the decision index range of a registration on a loaded panel */
function rangeOf(P, reg, sig) {
  let start = 0; while (start < P.D && P.dates[start] < reg.window.from) start++;
  start = Math.max(start, Math.min(P.D - 2, sig.meta.lookbackDays));
  let end = P.D - 1; while (end > start && P.dates[end] > reg.window.to) end--;
  return { start, end };
}
/** load a registration's panel: the window plus the signal's lookback before it, plus one day after for the last return */
function loadFor(reg, dataDir, lookbackDays) {
  const back = new Date(Date.parse(reg.window.from + "T00:00:00Z") - Math.ceil(lookbackDays * 1.6 + 10) * 86400000).toISOString().slice(0, 10);
  const fwd = new Date(Date.parse(reg.window.to + "T00:00:00Z") + 10 * 86400000).toISOString().slice(0, 10);
  const u = reg.universe || {}, syms = u.kind === "list" ? u.symbols : null;
  if (reg.dataset === "eq-daily") return loadEqDaily(path.join(dataDir, "eq-daily"), { from: back, to: fwd, symbols: syms });
  if (reg.dataset === "fut-daily") return loadFutDaily(path.join(dataDir, "fut-daily"), { from: back, to: fwd, symbols: syms });
  throw new Error(`dataset ${reg.dataset} is not served on the research server (eq-daily | fut-daily)`);
}
/** CONTROLS on scrambles only. -> { ok, falsePass, falsePassRate, power, leak, reasons, ms } */
function controls(P, sig, reg, { K, Pw, Lc, maxMs = 3 * 3600000 } = {}) {
  const c = reg.controls, t0 = Date.now(), base = seedOf(reg.regSha256 || reg.id), { start, end } = rangeOf(P, reg, sig), reasons = [];
  K = K || c.scrambles; Pw = Pw || c.powerRuns; Lc = Lc || c.leakCuts;
  let fp = 0, ran = 0;
  for (let k = 0; k < K; k++) {
    if (Date.now() - t0 > maxMs) { reasons.push(`time budget: ${ran} of ${K} scrambles in ${Math.round((Date.now() - t0) / 60000)} min`); break; }
    const Q = scramble(P, base + 1 + k, c.blockDays), days = runSignal(Q, sig, { start, end, rebalanceDays: reg.rebalanceDays });
    if (decide(evaluate(Q, days, reg, { placeboSeed: base + 7 }), reg).pass) fp++; ran++;
  }
  let pw = 0, pran = 0;
  for (let k = 0; k < Pw && !reasons.length; k++) {
    if (Date.now() - t0 > maxMs) { reasons.push(`time budget: ${pran} of ${Pw} power runs`); break; }
    const Q = scramble(P, base + 5000 + k, c.blockDays), days = runSignal(Q, sig, { start, end, rebalanceDays: reg.rebalanceDays });
    if (decide(evaluate(Q, days, reg, { plantBps: reg.mdeDailyBps, placeboSeed: base + 7 }), reg).pass) pw++; pran++;
  }
  const leaks = [];
  if (!reasons.length) {
    const Q = scramble(P, base + 9000, c.blockDays), full = runSignal(Q, sig, { start, end, rebalanceDays: reg.rebalanceDays }), rng = mulberry32(base + 9001);
    for (let k = 0; k < Lc; k++) {
      const cut = start + Math.floor((0.3 + 0.5 * rng()) * (end - start)), R = withFutureReplaced(Q, cut, base + 9100 + k, c.blockDays), part = runSignal(R, sig, { start, end, rebalanceDays: reg.rebalanceDays, stopAt: cut });
      for (let j = 0; j < part.length; j++) { const a = part[j], b = full[j]; if (a.idx.length !== b.idx.length || a.idx.some((x, q) => x !== b.idx[q] || Math.abs(a.w[q] - b.w[q]) > 1e-12)) { leaks.push({ cut: Q.dates[cut], at: Q.dates[a.t] }); break; } }
    }
  }
  const out = { ok: false, scrambles: ran, falsePass: fp, falsePassRate: ran ? +(fp / ran).toFixed(4) : null, powerRuns: pran, power: pran ? +(pw / pran).toFixed(4) : null, leakCuts: Lc, leaks, reasons, ms: Date.now() - t0, range: { from: P.dates[start], to: P.dates[end - 1] } };
  if (!reasons.length && ran < K) reasons.push(`only ${ran} of ${K} scrambles ran`);
  if (out.falsePassRate != null && out.falsePassRate > c.falsePassMax) reasons.push(`false-pass rate ${out.falsePassRate} > ${c.falsePassMax} — the decision rule passes on scrambled data too often (the bar is not honest for this signal)`);
  if (out.power != null && out.power < c.plantedPowerMin) reasons.push(`power ${out.power} < ${c.plantedPowerMin} at the registered MDE (${reg.mdeDailyBps} bps/position-day) — underpowered, not read`);
  if (leaks.length) reasons.push(`LOOK-AHEAD: positions before a cut changed when the data after it was replaced (${leaks.map((l) => l.at).join(", ")})`);
  out.ok = reasons.length === 0;
  out.reasons = reasons;
  return out;
}
/** THE READ: the real panel, once. -> { verdict, stats, gates } */
function read(P, sig, reg) {
  const { start, end } = rangeOf(P, reg, sig);
  if (end - start < reg.minN) return { verdict: "CANNOT MEASURE", why: `only ${end - start} decision days in the window (< minN ${reg.minN})`, stats: null, gates: null };
  const days = runSignal(P, sig, { start, end, rebalanceDays: reg.rebalanceDays }), s = evaluate(P, days, reg, { placeboSeed: seedOf(reg.regSha256 || reg.id) + 7 }), d = decide(s, reg);
  if (!d.gates.enoughDays) return { verdict: "CANNOT MEASURE", why: `${s.n} invested days < minN ${reg.minN}`, stats: s, gates: d.gates };
  return { verdict: d.pass ? "PASS" : "DID NOT PASS", stats: s, gates: d.gates, range: { from: P.dates[start], to: P.dates[end - 1] } };
}
/** the builder's check: the signal on SYNTHETIC data only — shape, determinism, the as-of view, speed. Never a real bar. */
function checkSignal(src, { S = 40, D = 400, seed = 11 } = {}) {
  const sig = compileSignal(src), P = synthetic({ S, D, seed }), t0 = Date.now();
  const a = runSignal(P, sig, { start: Math.min(D - 50, sig.meta.lookbackDays), end: D - 1 }), sig2 = compileSignal(src), b = runSignal(P, sig2, { start: Math.min(D - 50, sig.meta.lookbackDays), end: D - 1 });
  const same = a.length === b.length && a.every((x, k) => x.idx.length === b[k].idx.length && x.idx.every((v, q) => v === b[k].idx[q] && Math.abs(x.w[q] - b[k].w[q]) < 1e-12));
  const invested = a.filter((d) => d.idx.length).length;
  return { ok: same && invested > 0, deterministic: same, investedDays: invested, days: a.length, ms: Date.now() - t0, lookbackDays: sig.meta.lookbackDays, signalSha: sig.sha, note: invested ? "ran on synthetic data only" : "the signal never took a position on synthetic data" };
}
module.exports = { loadEqDaily, loadFutDaily, synthetic, scramble, withFutureReplaced, screenSignal, compileSignal, makeCtx, normalise, runSignal, plantOf, returnsOf, nwT, placeboDays, evaluate, decide, rangeOf, loadFor, controls, read, checkSignal, seedOf, LookAheadError, FORBID };
