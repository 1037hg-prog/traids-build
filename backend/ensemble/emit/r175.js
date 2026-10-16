#!/usr/bin/env node
"use strict";
/**
 * Library emitter — R175 Payne replica rule (40-slot momentum-on-pause book). READ-ONLY.
 *
 * Source: backend/r175-payne-replica.js is NOT require()-safe (top-level code refuses/seals, and its IIFE writes the sealed output,
 * read-seals, the registry and the ledger) and is never executed here. Copied VERBATIM: panel load + constants (lines 15-23), weekly
 * signal days and universe()/passes() (26-49), the weekly candidate build (51-56), simulate() (60-84), the SPY fetch and stats()
 * (87-97). The 200-run random-selection and peek controls and the Payne-book correlation are not run (they are not the strategy).
 *
 * The sealed script already produces a DAILY book: simulate().daily[t].r = equity_t / equity_{t-1} - 1 on the whole 40-slot book
 * (cash included, 10 bps a side inside the fills). The library series is that daily list, days with no position and r = 0 omitted.
 *
 * Reproduction: stats(rule).alphaTnw — daily alpha vs SPY after beta, Newey-West lag 5 — over 2017-01-03..2026-08-31.
 */
const fs = require("fs"), path = require("path");
const { fetchBars } = require("../../lib/alpaca-bars.js");
const { writeEntry } = require("../lib-entry.js");
const D = (f) => path.join(__dirname, "..", "..", "data", f), PANEL = D("anomaly-cache-v2");

// ── verbatim lines 15-23 ─────────────────────────────────────────────────────────────────────────────────────────────────
const meta = JSON.parse(fs.readFileSync(path.join(PANEL, "meta.json"), "utf8")), DATES = meta.dates, SYMS = meta.symbols, T = DATES.length, N = SYMS.length;
const rd = (f) => { const b = fs.readFileSync(path.join(PANEL, f)); return new Float32Array(b.buffer, b.byteOffset, N * T); };
const C = rd("close.f32"), O = rd("open.f32"), V = rd("vol.f32");
const c = (s, t) => C[s * T + t], o = (s, t) => O[s * T + t], v = (s, t) => V[s * T + t];
const START = "2017-01-03", END = "2026-08-31", COST = 0.001, SLOTS = 40, PER_WEEK = 3, TP = 1.15, MAXHOLD_MS = 365 * 86400000;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
function nwT(a, L = 5) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let g0 = d.reduce((s, x) => s + x * x, 0) / n, v = g0; for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * g / n; } return m / Math.sqrt(v / n); }

// ── verbatim lines 26-56 ─────────────────────────────────────────────────────────────────────────────────────────────────
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
console.log(`R175 emit — building weekly candidate lists over ${entryDays.length} weeks ...`);
const weeks = entryDays.map((te) => {
  const ts = te - 1, U = universe(ts); if (!U.length) return { te, sig: [], uni: [] };
  const sorted = U.map((x) => x.mom).sort((a, b) => a - b), cut = sorted[Math.floor(0.7 * sorted.length)];
  const sig = U.filter((x) => x.mom >= cut && passes(x.s, ts)).sort((a, b) => b.mom - a.mom).map((x) => x.s);
  return { te, sig, uni: U.map((x) => x.s) };
});

// ── verbatim lines 60-84 ─────────────────────────────────────────────────────────────────────────────────────────────────
const weekAt = new Map(weeks.map((w) => [w.te, w]));
function simulate(pick) {   // pick(week, heldSet) -> ordered candidate symbol list
  let cash = 1, pos = [], eqPrev = 1; const daily = [], trades = [];
  for (let t = t0; t <= tEnd; t++) {
    for (const p of pos) if (p.exitNext) { const px = o(p.s, t) > 0 ? o(p.s, t) : c(p.s, t - 1); cash += p.sh * px * (1 - COST); trades.push({ s: p.s, e: p.ti, x: t, r: (px * (1 - COST)) / (p.px / (1 - COST)) - 1 }); p.done = true; }
    pos = pos.filter((p) => !p.done);
    const w = weekAt.get(t);
    if (w) { const held = new Set(pos.map((p) => p.s)); let n = 0;
      for (const s of pick(w, held)) { if (n >= PER_WEEK || pos.length >= SLOTS) break; if (held.has(s)) continue; const px = o(s, t); if (!(px > 0)) continue;
        const alloc = Math.min(cash, eqPrev / SLOTS); if (alloc <= 1e-9) break; const sh = (alloc * (1 - COST)) / px; cash -= alloc; pos.push({ s, ti: t, px, sh, t0ms: Date.parse(DATES[t]) }); held.add(s); n++; } }
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
  // ── verbatim lines 87-97 ──
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
  const rule = simulate((w) => w.sig), full = stats(rule), sealed = JSON.parse(fs.readFileSync(D("r175-payne-replica.json"), "utf8")).rule.full;
  const series = rule.daily.filter((x) => x.n > 0 || x.r !== 0).map((x) => ({ d: DATES[x.t], r: x.r }));
  const match = Math.abs(full.alphaTnw - sealed.alphaTnw) <= 0.02;
  writeEntry({
    id: "R175", name: "Payne replica rule (momentum leaders on a post-earnings pause, +15% TP, 40 slots)", registryId: "R175",
    script: "backend/r175-payne-replica.js", emitter: "backend/ensemble/emit/r175.js", unit: "daily", net: true,
    costModel: "10 bps per side inside every fill (entry and exit), as sealed",
    window: [DATES[t0], DATES[tEnd]], calendar: "us-equity", series,
    reproduction: { statistic: "daily alpha vs SPY after beta, Newey-West lag-5 t (alphaTnw), 2017-01-03..2026-08-31", sealed: sealed.alphaTnw, emitted: full.alphaTnw, tolerance: 0.02, match },
    construction: "The sealed simulator's own daily book: 40 equal slots (1/40 of prior equity each), 3 new names a week bought at Monday's open, exits at the next open after a close >= +15% or 365 days, "
      + "marked at each close; the day's return is the whole book's equity change (cash at 0%), 10 bps a side in the fills. Days with no position and zero return are omitted.",
    notes: `Emitted: alpha ${full.alphaAnnualPct}%/yr (sealed ${sealed.alphaAnnualPct}), beta ${full.beta} (sealed ${sealed.beta}), CAGR ${full.cagrPct}% (sealed ${sealed.cagrPct}), ${full.days} days (sealed ${sealed.days}), avg positions ${full.avgPositions} (sealed ${sealed.avgPositions}). `
      + "Panel data/anomaly-cache-v2 (unchanged since the read); SPY re-fetched from Alpaca SIP adjustment=all (dividend restatements can move beta/alpha by a hair). The book is ~1.0 beta long-only equity.",
  });
})().catch((e) => { console.error("R175 emit FAILED:", e.stack); process.exit(1); });
