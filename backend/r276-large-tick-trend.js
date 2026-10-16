#!/usr/bin/env node
/**
 * R276 — Fast trend on LARGE-TICK futures only (Kurth, Eisler, Rej & Bouchaud 2026). Registered 2026-09-28 in
 * backend/register-r276-r280.js (the registry wins).
 *   Cells tau in {5,10,20} x {BONDS, LARGE-ALL}; primary tau=10 LARGE-ALL; bar 2.423 (best-of-6), months. Falsifier: every cell re-run
 *   on the SMALL-TICK set. Shift null: circular shift of the cell's daily position vectors (1,000 draws); PASS needs mean > p95.
 *
 *   node backend/r276-large-tick-trend.js --selftest   known answer: constant +1 position on IEF = IEF excess return minus roll cost
 *   node backend/r276-large-tick-trend.js --read       the one registered read (refuses if sealed)
 *
 * NOTES (fixed before any outcome): N1 Alpaca SIP daily adjustment=all closes 2016-01-04..2026-08-31. N2 daily rf = last DTB3 of the
 * prior calendar month /100/365 x calendar days since the previous session. N3 EWMA decay: alpha = 1/tau (fast), 1/(4 tau) (slow),
 * seeded at the first index value. N4 sigma_d = sd of the 60 daily excess returns ending at t. N5 z uses the sd of raw over t-252..t-1
 * (252 values required). N6 the position set at close t earns e(t+1); an instrument without a z holds 0. N7 costs per day =
 * c_i x |w_t - w_{t-1}| + c_i x |w_t| x rolls_i / 252. N8 evidence months = from the first calendar month in which EVERY instrument of
 * the largest set has a position all month, through 2026-08 (months before are warm-up, not zeros). N9 statistic month = sum of daily
 * net P&L inside the month.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { fetchBars } = require("./lib/alpaca-bars.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), OUT = D("r276-large-tick-trend.json");
const BAR = 2.423, END = "2026-08-31", DRAWS = 1000, TARGET = 0.10;
const INST = {   // etf, cost bps per unit |dw|, rolls per year, tier
  ZT: ["SHY", 0.5, 4, "BOND"], ZF: ["IEI", 0.95, 4, "BOND"], ZN: ["IEF", 1.6, 4, "BOND"], ZB: ["TLT", 2.9, 4, "BOND"],
  ZC: ["CORN", 7.1, 5, "LARGE"], ZS: ["SOYB", 2.9, 5, "LARGE"], ZW: ["WEAT", 5.5, 5, "LARGE"],
  ES: ["SPY", 0.46, 4, "SMALL"], NQ: ["QQQ", 0.16, 4, "SMALL"], GC: ["GLD", 0.36, 12, "SMALL"], SI: ["SLV", 1.4, 12, "SMALL"],
  "6E": ["FXE", 0.64, 4, "SMALL"], CL: ["USO", 1.9, 12, "SMALL"], NG: ["UNG", 3.6, 12, "SMALL"], HG: ["CPER", 1.3, 12, "SMALL"],
};
const SETS = { BONDS: ["ZT", "ZF", "ZN", "ZB"], LARGE_ALL: ["ZT", "ZF", "ZN", "ZB", "ZC", "ZS", "ZW"], SMALL: ["ES", "NQ", "GC", "SI", "6E", "CL", "NG", "HG"] };
const mode = ["--selftest", "--read"].find((m) => process.argv.includes(m)) || "--selftest";
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);

async function load() {
  const etfs = Object.values(INST).map((x) => x[0]);
  const r = await fetchBars(etfs, { start: "2016-01-01", end: END + "T23:00:00Z", feed: "sip", adjustment: "all", quiet: true, requireAll: true });
  const cal = r.bars.SPY.map((b) => b.t.slice(0, 10));
  const px = {}; for (const s of etfs) { const m = new Map(r.bars[s].map((b) => [b.t.slice(0, 10), b.c])); px[s] = cal.map((d) => m.get(d) ?? null); }
  const tb = {}; for (const l of fs.readFileSync(D("training/fred/DTB3.csv"), "utf8").trim().split(/\r?\n/).slice(1)) { const [d, v] = l.split(","); if (v && v !== ".") tb[d.slice(0, 7)] = +v; }
  const prevYm = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
  const rf = cal.map((d, i) => i === 0 ? 0 : ((tb[prevYm(d.slice(0, 7))] ?? 0) / 100 / 365) * ((Date.parse(d) - Date.parse(cal[i - 1])) / 864e5));
  const ex = {}; for (const [k, [s]] of Object.entries(INST)) ex[k] = cal.map((_, i) => (i && px[s][i] != null && px[s][i - 1] != null ? px[s][i] / px[s][i - 1] - 1 - rf[i] : null));
  return { cal, ex };
}

/** z-signal per instrument per day (null until warm). */
function signals(e, tau) {
  const n = e.length, z = new Array(n).fill(null), raw = new Array(n).fill(null); let p = 1, f = null, s = null;
  for (let i = 0; i < n; i++) {
    if (e[i] != null) p *= 1 + e[i];
    if (f == null) { f = p; s = p; } else { f += (p - f) / tau; s += (p - s) / (4 * tau); }
    if (i >= 60) { const w = e.slice(i - 59, i + 1); if (w.every((x) => x != null)) { const sdd = sd(w); if (sdd > 0) raw[i] = (f - s) / (p * sdd); } }
    if (i >= 252 && raw[i] != null) { const h = raw.slice(i - 252, i); if (h.every((x) => x != null)) { const q = sd(h); if (q > 0) z[i] = Math.max(-2, Math.min(2, raw[i] / q)); } }
  }
  return z;
}
function sigmaAt(e, i) { const w = e.slice(i - 59, i + 1); return w.length === 60 && w.every((x) => x != null) ? sd(w) : null; }

/** positions[k][i] held from close i to close i+1. */
function positions(ex, set, tau, zOverride = null) {
  const N = set.length, P = {};
  for (const k of set) { const z = zOverride ? zOverride(k) : signals(ex[k], tau); P[k] = z.map((zi, i) => { if (zi == null) return 0; const sg = sigmaAt(ex[k], i); return sg ? (zi / 2) * (TARGET / Math.sqrt(N)) / (sg * Math.sqrt(252)) : 0; }); }
  return P;
}
function dailyPnl(ex, set, P, shift = 0) {
  const n = ex[set[0]].length, gross = new Array(n).fill(0), net = new Array(n).fill(0);
  const pos = (k, i) => { if (!shift) return P[k][i]; const L = n; return P[k][((i - shift) % L + L) % L]; };
  for (let i = 1; i < n; i++) for (const k of set) {
    const w = pos(k, i - 1), wPrev = i >= 2 ? pos(k, i - 2) : 0, [, c, rolls] = INST[k], e = ex[k][i] ?? 0;
    const cost = (c / 1e4) * (Math.abs(w - wPrev) + Math.abs(w) * rolls / 252);
    gross[i] += w * e; net[i] += w * e - cost;
  }
  return { gross, net };
}
function monthly(cal, daily, fromYm) { const M = new Map(); for (let i = 1; i < cal.length; i++) { const ym = cal[i].slice(0, 7); if (ym < fromYm) continue; M.set(ym, (M.get(ym) || 0) + daily[i]); } return [...M.values()]; }

(async () => {
  const { cal, ex } = await load();
  if (mode === "--selftest") {
    const P = { ZN: cal.map(() => 1) }, d = dailyPnl(ex, ["ZN"], P);
    let maxErr = 0; for (let i = 2; i < cal.length; i++) { const expect = (ex.ZN[i] ?? 0) - (1.6 / 1e4) * (4 / 252); maxErr = Math.max(maxErr, Math.abs(d.net[i] - expect)); }
    const nulls = Object.fromEntries(Object.entries(ex).map(([k, v]) => [k, v.filter((x) => x == null).length]));
    console.log(`selftest: ${cal.length} sessions ${cal[0]}..${cal.at(-1)}; constant-long IEF max error ${maxErr.toExponential(2)} (${maxErr < 1e-12 ? "OK" : "FAIL"}); null returns per instrument ${JSON.stringify(nulls)}`);
    process.exit(maxErr < 1e-12 ? 0 : 1);
  }
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests.R276) throw new Error("R276 already sealed — read-once");
  // N8: first month where every instrument of every set has a z for all of the month (use tau=20, the slowest warm-up is identical: z needs 312 sessions regardless of tau)
  const allK = Object.keys(INST), zAll = Object.fromEntries(allK.map((k) => [k, signals(ex[k], 10)]));
  let fromYm = null; for (const ym of [...new Set(cal.map((d) => d.slice(0, 7)))]) { const idx = cal.map((d, i) => [d, i]).filter(([d]) => d.startsWith(ym)).map(([, i]) => i); if (idx.every((i) => allK.every((k) => zAll[k][i] != null))) { fromYm = ym; break; } }
  const cell = (setName, tau, draws) => {
    const set = SETS[setName], P = positions(ex, set, tau), d = dailyPnl(ex, set, P), mNet = monthly(cal, d.net, fromYm), mGross = monthly(cal, d.gross, fromYm);
    const res = { set: setName, tau, months: mNet.length, netMonthlyPct: +(100 * mean(mNet)).toFixed(4), t: +tOf(mNet).toFixed(3), grossMonthlyPct: +(100 * mean(mGross)).toFixed(4), tGross: +tOf(mGross).toFixed(3),
      sharpeNet: +((mean(mNet) / sd(mNet)) * Math.sqrt(12)).toFixed(2), annVolPct: +(100 * sd(mNet) * Math.sqrt(12)).toFixed(2) };
    if (draws) { let seed = 276276 + tau; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648); const n = cal.length, sh = [];
      for (let k = 0; k < DRAWS; k++) { const off = 21 + Math.floor(rnd() * (n - 42)); sh.push(mean(monthly(cal, dailyPnl(ex, set, P, off).net, fromYm))); }
      sh.sort((a, b) => a - b); res.shiftP95MonthlyPct = +(100 * sh[Math.floor(0.95 * DRAWS)]).toFixed(4); res.beatsShift = mean(mNet) > sh[Math.floor(0.95 * DRAWS)]; }
    return res;
  };
  const cells = [], small = [];
  for (const tau of [5, 10, 20]) for (const s of ["BONDS", "LARGE_ALL"]) cells.push(cell(s, tau, true));
  for (const tau of [5, 10, 20]) small.push(cell("SMALL", tau, false));
  const passing = cells.filter((c) => c.t >= BAR && c.beatsShift), prim = cells.find((c) => c.set === "LARGE_ALL" && c.tau === 10), smallPrim = small.find((c) => c.tau === 10);
  const mechanism = smallPrim.t >= prim.t ? "MECHANISM-UNCONFIRMED (small-tick primary t >= large-tick primary t)" : "tick ordering as predicted (large > small)";
  const line = (c) => `${c.set} tau${c.tau} ${c.netMonthlyPct}%/mo t ${c.t}`;
  const verdict = `${passing.length ? "PASSED" : "DID NOT PASS"} — bar ${BAR}, ${prim.months} months from ${fromYm}: ${cells.map(line).join("; ")} · falsifier SMALL: ${small.map((c) => `tau${c.tau} t ${c.t}`).join(", ")} · ${mechanism}`;
  const out = { test: "R276", readAt: new Date().toISOString(), verdict, bar: BAR, fromYm, cells, smallTickFalsifier: small, mechanism, passingCells: passing.map(line) };
  writeJsonAtomic(OUT, out);
  seals.tests = seals.tests || {}; seals.tests.R276 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "months, one-sample t on net monthly cell return; best-of-6 bar", verdict, output: "data/r276-large-tick-trend.json" };
  writeJsonAtomic(D("read-seals.json"), seals);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", tests: ["R276"], detail: verdict }) + "\n");
  console.log(verdict); console.log(JSON.stringify({ cells, small }, null, 1));
})().catch((e) => { console.error("R276 FAILED:", e.message); process.exit(1); });
