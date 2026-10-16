#!/usr/bin/env node
"use strict";
/**
 * SKEPTIC (options-premium lane): the mirror close-day pass and the take-profit, split into what is friction and what is the sample.
 * Read-only, in-sample, exploratory. Same wings, same cached bars and the same flag / fill rules as options-mirror-costs.js and
 * r25-retro-takeprofit.js. Each early exit against holding is split EXACTLY into
 *    path     = (intrinsic at expiry - the print spread at the exit) x 100 x n      zero in expectation for a fair price
 *    crossing = -(crossing added to the fill) x 100 x n                             friction
 *    fee      = -2 x $0.65 x n                                                      friction
 *    pad      = -$0.05 x 100 x n (close-day limit only; the worst case of that limit)
 * The friction terms recur every month. The path term is what these sessions happened to do after the exit; its own session t is shown.
 *   node backend/profit-program/skeptic-options-exit-decomp.js
 * Writes backend/data/profit-program/skeptic-options-exit-decomp.json
 */
const C = require("./_opt-common.js");
const B = require("./_opt-bars.js");
const T = require("../r25-twins.js");
const { $, f } = C;
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const FRESH = 5 * 60 * 1000;

function firstAtOrBelow(bars, sOcc, lOcc, loMs, hiMs, line) {   // r25-retro-takeprofit.js triggerLE, unchanged
  const S = bars[sOcc], L = bars[lOcc]; if (!S || !L || !S.ms.length || !L.ms.length) return null;
  let i = 0, j = 0;
  while (i < S.ms.length || j < L.ms.length) {
    const t = Math.min(i < S.ms.length ? S.ms[i] : Infinity, j < L.ms.length ? L.ms[j] : Infinity);
    while (i < S.ms.length && S.ms[i] <= t) i++;
    while (j < L.ms.length && L.ms[j] <= t) j++;
    if (t + 60000 > hiMs) break;
    if (t < loMs || !i || !j) continue;
    if (t - S.ms[i - 1] > FRESH || t - L.ms[j - 1] > FRESH) continue;
    const lc = L.c[j - 1]; if (!(lc > 0)) continue;
    if (S.c[i - 1] - lc <= line + 1e-9) return { ms: t + 60000, spread: S.c[i - 1] - lc };
  }
  return null;
}

async function build() {
  const L = C.ledger(), wings = L.signals.filter(C.isR25), marks = T.loadMarks();
  const byDay = new Map();
  for (const t of wings) { const d = C.etDay(t.openedAt); (byDay.get(d) || byDay.set(d, []).get(d)).push(t); }
  const close = { "15:45": [], "15:55": [] }, tp = [];
  for (const day of [...byDay.keys()].sort()) {
    const W = byDay.get(day);
    const legs = (t) => { const r = t.obs.optCall ? "C" : "P"; return [T.occOf(t.sym, t.obs.optExpiry, r, +t.obs.shortK), T.occOf(t.sym, t.obs.optExpiry, r, +t.obs.longK)]; };
    const raw = await B.optionBars(day, [...new Set(W.flatMap(legs))]);
    const bars = {};
    for (const o of Object.keys(raw)) bars[o] = T.colOf((raw[o] || []).map((b) => ({ ms: b[0] * 1000, c: b[1] })));
    for (const t of W) {
      const o = t.obs, r = o.optCall ? "C" : "P", n = t.contracts || 1, K = +o.shortK, Wd = o.width, [sOcc, lOcc] = legs(t);
      const intr = o.optCall ? clamp(o.settleUnder - K, 0, Wd) : clamp(K - o.settleUnder, 0, Wd);
      const path_ = marks.byWing.get(t.id) || [];
      const entryCross = Math.max(0, (o.creditMid ?? t.entry) - (o.creditCross ?? t.entry));
      const sb = await B.stockBars(t.sym, day);
      for (const look of Object.keys(close)) {
        const at = B.utcOf(day, look); let px = null;
        for (const b of sb) { if (b[0] * 1000 <= at - 60000) px = b[4]; else break; }
        if (px == null) continue;
        const itm = r === "P" ? px < K : px > K, near = r === "P" ? (px - K) / px <= 0.0025 : (K - px) / px <= 0.0025;
        if (!(itm || near)) continue;
        const ob = T.minuteObsAt(bars, sOcc, lOcc, at, t.openedAt), fresh = ob && at - ob.ms <= FRESH;
        if (!fresh) { close[look].push({ day, sym: t.sym, n, itm, fresh: false, d: (t.entry - Wd) * 100 * n - 2.6 * n - t.pnl, path$: 0, cross$: 0, fee$: 0, unsplit: true }); continue; }
        const cross = T.crossingAt(path_, at, entryCross), natural = clamp(ob.spread + cross, 0, Wd);
        const d = (t.entry - natural) * 100 * n - 2.6 * n - t.pnl;
        close[look].push({ day, sym: t.sym, n, itm, fresh: true, d, path$: (intr - ob.spread) * 100 * n, cross$: -(natural - ob.spread) * 100 * n, fee$: -1.3 * n, pad$: -(Math.min(Wd, natural + 0.05) - natural) * 100 * n });
      }
      if (C.etDay(t.openedAt) < T.EVIDENCE_FROM) {
        const mk = path_.filter((m) => m.ms >= t.openedAt), closeMs = B.utcOf(o.optExpiry, "16:00"), row = { day, sym: t.sym, n };
        for (const p of [0.5, 0.75]) {
          const x = firstAtOrBelow(bars, sOcc, lOcc, t.openedAt, closeMs, (1 - p) * t.entry);
          if (!x) { row["P" + p] = { trig: false, d: 0, path$: 0, cross$: 0, fee$: 0 }; continue; }
          const fill = clamp(Math.max(0.01, x.spread + T.crossingAt(mk, x.ms, entryCross)), 0, Wd);
          row["P" + p] = { trig: true, d: (t.entry - fill) * 100 * n - 2.6 * n - t.pnl, path$: (intr - x.spread) * 100 * n, cross$: -(fill - x.spread) * 100 * n, fee$: -1.3 * n };
        }
        tp.push(row);
      }
    }
  }
  return { close, tp, nWings: wings.length, nSess: byDay.size };
}
module.exports = { build };

if (require.main === module) (async () => {
  const { close, tp, nWings, nSess } = await build();
  const out = { label: "SKEPTIC, in-sample exploratory", wings: nWings, sessions: nSess, closeDay: {}, takeProfit: {} };
  const P = (s, w) => String(s).padStart(w);
  const sT = (R, fn) => { const s = C.bySession(R, fn, (r) => r.day); return { sum: C.sum(s.sums), t: s.t, n: s.n }; };
  // per month at 4 contracts over ALL sessions of the book (a session with no flagged wing counts as zero)
  const m4 = (R, fn) => C.sum(R.map((r) => fn(r) / r.n * 4)) / nSess * 21;
  console.log(`SKEPTIC: mirror close-day pass, split (R25 ${nWings} wings, ${nSess} sessions; flag and fill rules as options-mirror-costs.js)`);
  console.log("look   set        flagged | natural vs hold      t | PATH (sample)      t | crossing     fee | per month at 4 contracts: path / friction / limit pad (worst case)");
  for (const look of Object.keys(close)) {
    out.closeDay[look] = {};
    const sets = [["all", close[look]], ["non-SPY", close[look].filter((x) => x.sym !== "SPY")], ["ITM only", close[look].filter((x) => x.itm)], ["ITM nonSPY", close[look].filter((x) => x.itm && x.sym !== "SPY")]];
    for (const [lab, X] of sets) {
      const a = sT(X, (x) => x.d), p = sT(X, (x) => x.path$), cr = C.sum(X.map((x) => x.cross$)), fe = C.sum(X.map((x) => x.fee$));
      const pm = m4(X, (x) => x.path$), fm = m4(X, (x) => x.cross$ + x.fee$), dm = m4(X, (x) => x.pad$ || 0), un = X.filter((x) => x.unsplit);
      console.log(`${look}  ${lab.padEnd(10)} ${P(X.length, 7)} | ${P($(a.sum), 15)} ${P(f(a.t), 6)} | ${P($(p.sum), 13)} ${P(f(p.t), 6)} | ${P($(cr), 8)} ${P($(fe), 7)} | ${$(pm)} / ${$(fm)} / ${$(dm)}${un.length ? `   (${un.length} wing without a fresh print, ${$(C.sum(un.map((x) => x.d)))}, left out of the split)` : ""}`);
      out.closeDay[look][lab] = { flagged: X.length, naturalVsHold: a, path: p, crossing: cr, fee: fe, perMonth4ct: { path: pm, friction: fm, pad: dm, naturalTotal: m4(X, (x) => x.d) } };
    }
    // does the path term keep its sign across halves of the sample?
    const days = [...new Set(close[look].map((x) => x.day))].sort(), h = new Set(days.slice(0, Math.floor(days.length / 2)));
    const a1 = sT(close[look].filter((x) => h.has(x.day)), (x) => x.path$), a2 = sT(close[look].filter((x) => !h.has(x.day)), (x) => x.path$);
    console.log(`       path term by half: first ${a1.n} sessions ${$(a1.sum)} (t ${f(a1.t)}), last ${a2.n} sessions ${$(a2.sum)} (t ${f(a2.t)})`);
    out.closeDay[look].pathHalves = [a1, a2];
  }
  console.log("\n  friction recurs: it is paid on every flagged wing. The path term is what the last minutes did in these sessions; a fair price gives it mean zero.");
  const nT = new Set(tp.map((r) => r.day)).size;
  console.log(`\nSKEPTIC: R25 take-profit, split (${tp.length} wings, ${nT} sessions; rule and fill as r25-retro-takeprofit.js)`);
  console.log("variant  exits | vs hold      t | PATH (sample)      t | crossing     fee | per month at 4 contracts: total / path / friction");
  for (const v of ["P0.5", "P0.75"]) {
    const X = tp.filter((r) => r[v].trig), pick = (k) => (r) => r[v][k];
    const a = sT(tp, pick("d")), p = sT(tp, pick("path$")), cr = C.sum(tp.map(pick("cross$"))), fe = C.sum(tp.map(pick("fee$")));
    const per = (k) => C.bySession(tp, (r) => r[v][k] / r.n * 4, (r) => r.day).meanPerSession * 21;
    const fr = per("cross$") + per("fee$");
    console.log(`${v.padEnd(8)} ${P(X.length, 5)} | ${P($(a.sum), 7)} ${P(f(a.t), 6)} | ${P($(p.sum), 13)} ${P(f(p.t), 6)} | ${P($(cr), 8)} ${P($(fe), 7)} | ${$(per("d"))} / ${$(per("path$"))} / ${$(fr)}`);
    out.takeProfit[v] = { exits: X.length, vsHold: a, path: p, crossing: cr, fee: fe, perMonth4ct: { total: per("d"), path: per("path$"), friction: fr } };
  }
  console.log("\nwrote " + C.writeOut("skeptic-options-exit-decomp.json", out));
})().catch((e) => { console.error("FAILED: " + e.stack); process.exitCode = 1; });
