#!/usr/bin/env node
/**
 * R175 — PAYNE REPLICA RULE (registered 2026-09-24 before this file ran; rule text frozen in data/test-registry.json).
 * Momentum leaders on a post-earnings pause, 3 new names a week, +15% take-profit on a close (sold next open), 365-day time exit, no stop,
 * 40 equal slots, 10 bps a side. Panel: data/anomaly-cache-v2 (adjusted close/open/volume, symbol-major Float32, look-ahead-safe).
 *
 *   node backend/r175-payne-replica.js     -> data/r175-payne-replica.json (one read; refuses if R175 is already sealed)
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f), PANEL = D("anomaly-cache-v2");
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R175) { console.error("R175 already sealed — refusing"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), ENTRY = reg.preregistered.find((t) => t.id === "R175"); if (!ENTRY) { console.error("R175 not registered"); process.exit(2); }
const BAR = ENTRY.bar.tRequired;
const meta = JSON.parse(fs.readFileSync(path.join(PANEL, "meta.json"), "utf8")), DATES = meta.dates, SYMS = meta.symbols, T = DATES.length, N = SYMS.length;
const rd = (f) => { const b = fs.readFileSync(path.join(PANEL, f)); return new Float32Array(b.buffer, b.byteOffset, N * T); };
const C = rd("close.f32"), O = rd("open.f32"), V = rd("vol.f32");
const c = (s, t) => C[s * T + t], o = (s, t) => O[s * T + t], v = (s, t) => V[s * T + t];
const START = "2017-01-03", END = "2026-08-31", COST = 0.001, SLOTS = 40, PER_WEEK = 3, TP = 1.15, MAXHOLD_MS = 365 * 86400000;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
function nwT(a, L = 5) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let g0 = d.reduce((s, x) => s + x * x, 0) / n, v = g0; for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * g / n; } return m / Math.sqrt(v / n); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---- signal days: the session before the first trading day of each week --------------------------------------------------
const t0 = DATES.findIndex((d) => d >= START), tEnd = DATES.findIndex((d) => d > END) - 1 < 0 ? T - 1 : DATES.findIndex((d) => d > END) - 1;
const wk = (d) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
const entryDays = []; for (let t = t0; t <= tEnd; t++) if (t > 0 && wk(DATES[t]) !== wk(DATES[t - 1])) entryDays.push(t);
function universe(t) {   // returns [{s, mom}] of names in the universe at close t (>=260 closes, 20d median $vol >= 25M)
  const out = [];
  for (let s = 0; s < N; s++) {
    if (!(c(s, t) > 0) || !(c(s, t - 259) > 0)) continue;
    const dv = []; for (let k = t - 19; k <= t; k++) { const x = c(s, k) * v(s, k); if (Number.isFinite(x)) dv.push(x); }
    if (dv.length < 15) continue; dv.sort((a, b) => a - b); if (!(dv[dv.length >> 1] >= 25e6)) continue;
    const a = c(s, t - 21), b = c(s, t - 252); if (!(a > 0) || !(b > 0)) continue;
    out.push({ s, mom: a / b - 1 });
  }
  return out;
}
function passes(s, t) {   // filters (b)-(e); (a) is applied cross-sectionally by the caller
  let s50 = 0, s200 = 0, mx = 0;
  for (let k = t - 199; k <= t; k++) { const x = c(s, k); if (!(x > 0)) return false; s200 += x; if (k > t - 50) s50 += x; }
  const cl = c(s, t); if (!(cl > s50 / 50 && cl > s200 / 200)) return false;
  for (let k = t - 251; k <= t; k++) { const x = c(s, k); if (x > mx) mx = x; }
  const dd = cl / mx - 1; if (!(dd <= -0.05 && dd >= -0.20)) return false;
  let pop = false; for (let k = t - 9; k <= t; k++) if (c(s, k) / c(s, k - 1) - 1 >= 0.05) { pop = true; break; } if (!pop) return false;
  let g = 0, l = 0; for (let k = t - 13; k <= t; k++) { const d = c(s, k) - c(s, k - 1); if (d > 0) g += d; else l -= d; }
  const rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l); return rsi >= 45 && rsi <= 70;
}
console.log(`R175 — building weekly candidate lists over ${entryDays.length} weeks ...`);
const weeks = entryDays.map((te) => {
  const ts = te - 1, U = universe(ts); if (!U.length) return { te, sig: [], uni: [] };
  const sorted = U.map((x) => x.mom).sort((a, b) => a - b), cut = sorted[Math.floor(0.7 * sorted.length)];
  const sig = U.filter((x) => x.mom >= cut && passes(x.s, ts)).sort((a, b) => b.mom - a.mom).map((x) => x.s);
  return { te, sig, uni: U.map((x) => x.s) };
});
console.log(`  mean signals/week ${mean(weeks.map((w) => w.sig.length)).toFixed(1)} · universe ${mean(weeks.map((w) => w.uni.length)).toFixed(0)} names`);

// ---- book simulator --------------------------------------------------------------------------------------------------------
const weekAt = new Map(weeks.map((w) => [w.te, w]));
function simulate(pick) {   // pick(week, heldSet) -> ordered candidate symbol list
  let cash = 1, pos = [], eqPrev = 1; const daily = [], trades = [];
  for (let t = t0; t <= tEnd; t++) {
    // exits at the open (flagged the prior close)
    for (const p of pos) if (p.exitNext) { const px = o(p.s, t) > 0 ? o(p.s, t) : c(p.s, t - 1); cash += p.sh * px * (1 - COST); trades.push({ s: p.s, e: p.ti, x: t, r: (px * (1 - COST)) / (p.px / (1 - COST)) - 1 }); p.done = true; }
    pos = pos.filter((p) => !p.done);
    // entries at the open
    const w = weekAt.get(t);
    if (w) { const held = new Set(pos.map((p) => p.s)); let n = 0;
      for (const s of pick(w, held)) { if (n >= PER_WEEK || pos.length >= SLOTS) break; if (held.has(s)) continue; const px = o(s, t); if (!(px > 0)) continue;
        const alloc = Math.min(cash, eqPrev / SLOTS); if (alloc <= 1e-9) break; const sh = (alloc * (1 - COST)) / px; cash -= alloc; pos.push({ s, ti: t, px, sh, t0ms: Date.parse(DATES[t]) }); held.add(s); n++; } }
    // mark at the close; flag exits
    let val = 0;
    for (const p of pos) {
      const cl = c(p.s, t);
      if (!(cl > 0)) { const last = p.lastC || p.px; cash += p.sh * last * (1 - COST); trades.push({ s: p.s, e: p.ti, x: t, r: (last * (1 - COST)) / (p.px / (1 - COST)) - 1, delisted: true }); p.done = true; continue; }
      p.lastC = cl; val += p.sh * cl;
      if (cl >= p.px * TP || Date.parse(DATES[t]) - p.t0ms >= MAXHOLD_MS) p.exitNext = true;
    }
    pos = pos.filter((p) => !p.done);
    const eq = cash + val; daily.push({ t, r: eq / eqPrev - 1, n: pos.length }); eqPrev = eq;
  }
  return { daily, trades, final: eqPrev };
}

(async () => {
  const { bars } = await fetchBars(["SPY"], { start: "2016-01-01", end: "2026-09-22T21:00:00Z", feed: "sip", adjustment: "all", quiet: true });
  const spyC = new Map((bars.SPY || []).map((b) => [b.t.slice(0, 10), b.c]));
  const spyR = (t) => { const a = spyC.get(DATES[t - 1]), b = spyC.get(DATES[t]); return a > 0 && b > 0 ? b / a - 1 : 0; };
  function stats(sim, from = START, to = END) {
    const d = sim.daily.filter((x) => DATES[x.t] >= from && DATES[x.t] <= to), r = d.map((x) => x.r), m = d.map((x) => spyR(x.t));
    const mr = mean(r), mm = mean(m); let cov = 0, vm = 0; for (let i = 0; i < r.length; i++) { cov += (r[i] - mr) * (m[i] - mm); vm += (m[i] - mm) ** 2; }
    const beta = cov / vm, res = r.map((x, i) => x - beta * m[i]);
    let eq = 1, pk = 1, dd = 0; for (const x of r) { eq *= 1 + x; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
    let es = 1; for (const x of m) es *= 1 + x; const yrs = r.length / 252;
    return { days: r.length, cagrPct: +((eq ** (1 / yrs) - 1) * 100).toFixed(2), spyCagrPct: +((es ** (1 / yrs) - 1) * 100).toFixed(2), maxDDPct: +(dd * 100).toFixed(1), beta: +beta.toFixed(3), alphaAnnualPct: +(mean(res) * 252 * 100).toFixed(2), alphaTnw: +nwT(res, 5).toFixed(3), avgPositions: +mean(d.map((x) => x.n)).toFixed(1) };
  }
  function tradeStats(sim) {
    const rows = sim.trades.filter((x) => DATES[x.e] >= START).map((x) => { let sp = 1; for (let t = x.e + 1; t <= x.x; t++) sp *= 1 + spyR(t); return { ...x, ex: x.r - (sp - 1), mo: DATES[x.e].slice(0, 7) }; });
    const byM = {}; rows.forEach((x) => (byM[x.mo] = byM[x.mo] || []).push(x.ex)); const mm = Object.values(byM).map(mean);
    return { trades: rows.length, winPct: +(100 * rows.filter((x) => x.r > 0).length / rows.length).toFixed(1), meanTradePct: +(100 * mean(rows.map((x) => x.r))).toFixed(2), meanExcessPct: +(100 * mean(rows.map((x) => x.ex))).toFixed(2), tExcessByMonth: +(mean(mm) / (sd(mm) / Math.sqrt(mm.length))).toFixed(2), medianHoldDays: (() => { const h = rows.map((x) => (Date.parse(DATES[x.x]) - Date.parse(DATES[x.e])) / 86400000).sort((a, b) => a - b); return h[h.length >> 1]; })(), tpExitPct: +(100 * rows.filter((x) => x.r >= TP - 1 - 0.02).length / rows.length).toFixed(1) };
  }
  // the rule
  const rule = simulate((w) => w.sig);
  // controls
  const rand = []; for (let k = 0; k < 200; k++) { const rng = mulberry(175 + k); rand.push(stats(simulate((w) => { const a = [...w.uni]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, 50); })).alphaAnnualPct); }
  rand.sort((a, b) => a - b); const rand95 = rand[Math.floor(0.95 * rand.length)], randMed = rand[rand.length >> 1];
  const peek = stats(simulate((w) => w.uni.map((s) => ({ s, f: c(s, Math.min(T - 1, w.te + 60)) / o(s, w.te) })).filter((x) => Number.isFinite(x.f)).sort((a, b) => b.f - a.f).map((x) => x.s)));
  // Payne's own equal-weight book (2021-2026 overlap) for the correlation
  let corr = null;
  try {
    const P = JSON.parse(fs.readFileSync(D("payne-model-portfolio.json"), "utf8")), cache = (s) => { try { return JSON.parse(fs.readFileSync(D(`payne-audit-cache/${s.replace(/[^A-Z0-9.]/gi, "_")}-split.json`), "utf8")); } catch { return null; } };
    const pos = [...P.closed.map((r) => ({ s: r.ticker, e: r.entryDate, x: r.exitDate })), ...P.open.map((o2) => ({ s: o2.markAs || o2.ticker, e: o2.entryDate, x: null }))];
    const idx = {}; for (const p of pos) if (!idx[p.s]) { const b = cache(p.s); if (b) idx[p.s] = new Map(b.map((x) => [x.d, x.c])); }
    const ruleByDate = new Map(rule.daily.map((x) => [DATES[x.t], x.r])), a = [], b = [];
    for (let t = DATES.indexOf("2021-01-04"); t <= tEnd; t++) { const d0 = DATES[t - 1], d1 = DATES[t], rs = [];
      for (const p of pos) { if (!(p.e <= d0) || (p.x && p.x < d1) || !idx[p.s]) continue; const c0 = idx[p.s].get(d0), c1 = idx[p.s].get(d1); if (c0 > 0 && c1 > 0) rs.push(c1 / c0 - 1); }
      if (rs.length && ruleByDate.has(d1)) { a.push(mean(rs)); b.push(ruleByDate.get(d1)); } }
    const ma = mean(a), mb = mean(b); let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    corr = { days: a.length, dailyCorrWithPayneBook: +(sab / Math.sqrt(saa * sbb)).toFixed(3) };
  } catch (e) { corr = { error: e.message }; }
  const full = stats(rule), oos = stats(rule, "2017-01-03", "2020-12-31"), overlap = stats(rule, "2021-01-04", END), tr = tradeStats(rule);
  const peekOk = peek.alphaTnw >= BAR && peek.alphaAnnualPct > 0;
  const verdict = !peekOk ? `CONTROLS FAILED — peek alpha t ${peek.alphaTnw}` : full.alphaTnw >= BAR && full.alphaAnnualPct > rand95 ? `PASS — alpha ${full.alphaAnnualPct}%/yr, t ${full.alphaTnw} >= ${BAR}, above the random-selection 95th pct (${rand95}%)` : `DID NOT PASS — alpha ${full.alphaAnnualPct}%/yr after beta ${full.beta}, t ${full.alphaTnw} vs bar ${BAR}; random-selection control median ${randMed}%/yr, 95th pct ${rand95}%/yr`;
  const out = { spec: "r175-payne-replica-v1", test: "R175", ranAt: new Date().toISOString(), window: [START, END], weeks: entryDays.length, meanSignalsPerWeek: +mean(weeks.map((w) => w.sig.length)).toFixed(1),
    rule: { full, oos2017_2020: oos, overlap2021_2026: overlap, trades: tr, payneCorrelation: corr }, controls: { randomSelection: { runs: rand.length, alphaMedian: randMed, alpha95: rand95 }, peek: { ...peek, pass: peekOk } }, bar: BAR, verdict };
  writeJsonAtomic(D("r175-payne-replica.json"), out);
  if (!peekOk) { console.log(JSON.stringify(out, null, 1)); console.error("controls failed — NOT sealed; fix the pipeline, not the rule"); process.exit(3); }
  seals.tests.R175 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "days (NW) / months", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  ENTRY.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R175", verdict }) + "\n");
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
