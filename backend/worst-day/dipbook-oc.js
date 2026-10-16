"use strict";
/**
 * WORST-DAY ATTACK: the sister study's dip-buy book and S2 short rebuilt with each day's profit split into OVERNIGHT (prior close to
 * open) and INTRADAY (open to close), so a gate decided at the close of day t can be applied at the NEXT OPEN instead of the same close.
 * This is dipbook.js's leg engine copied with one change: the per-day profit is returned as three series (ov, id, cst) instead of their sum.
 * Check: ov + id + cst must equal dipbook.js's daily series to the cent (the caller asserts it). Read-only; no network.
 *   exports buildBooksOC() -> { dip, s2 } each { dates, ov, id, cst, expo, badOpens }
 */
const fs = require("fs"), path = require("path");
const R28 = require("../r328-qs-rsi2-etfs.js"), R13 = require("../r313-ibs-etfs.js");
const START = "2000-01-03", END = "2026-09-30", STAKE = 100000;
const isWeekend = (d) => { const g = new Date(d + "T12:00:00Z").getUTCDay(); return g === 0 || g === 6; };
const dayNum = (d) => Math.round(Date.parse(d + "T12:00:00Z") / 86400000);

function buildBooksOC() {
  const C13 = JSON.parse(fs.readFileSync(R13.CACHE, "utf8")), C28 = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "training", "r328", "bars-schwab-daily-19930101-20261002.json"), "utf8"));
  const withDn = (A) => ({ ...A, dn: Int32Array.from(A.d, dayNum) });
  const toArr = (rows) => { const r = rows.filter((x) => !isWeekend(x[0])), n = r.length, d = r.map((x) => x[0]); return { n, d, c: Float64Array.from(r, (x) => x[4]) }; };
  const SPY = toArr(C28.rows.SPY);
  const CAL = []; for (let i = 0; i < SPY.n; i++) if (SPY.d[i] >= START && SPY.d[i] <= END) CAL.push(i);
  const NC = CAL.length, CALD = CAL.map((i) => SPY.d[i]), CALMAP = new Map(CALD.map((d, i) => [d, i]));
  function calIdx(d) { const m = CALMAP.get(d); if (m !== undefined) return m; if (d < START || d > END) return -1; let lo = 0, hi = NC; while (lo < hi) { const mid = (lo + hi) >> 1; if (CALD[mid] < d) lo = mid + 1; else hi = mid; } return lo < NC ? lo : -1; }
  let badOpens = 0;
  function book(legs, carryRate = 0) {
    const ov = new Float64Array(NC), id = new Float64Array(NC), cst = new Float64Array(NC), expo = new Float64Array(NC);
    for (const L of legs) {
      const { A, t, dir, slot } = L, d = A.d, c = A.c, o = A.o, dn = A.dn;
      if (d[t] < START || d[t] > END) continue;
      let u = L.u, open = u < 0, e = open ? A.n - 1 : u;
      while (e > t && d[e] > END) { e--; open = true; }
      if (e <= t) continue;
      const shares = slot / c[t], ps = L.perSide;
      const eI = calIdx(d[t]);
      { const cs = slot * ps; if (eI >= 0) cst[eI] -= cs; }
      for (let k = t + 1; k <= e; k++) {
        const gi = calIdx(d[k]); const days = dn[k] - dn[k - 1]; const cr = (dir < 0 && carryRate > 0) ? carryRate * shares * c[k - 1] * days / 365 : 0;
        const okO = Number.isFinite(o[k]) && o[k] > 0; if (!okO) badOpens++;
        const ovP = okO ? dir * shares * (o[k] - c[k - 1]) : 0, idP = okO ? dir * shares * (c[k] - o[k]) : dir * shares * (c[k] - c[k - 1]);
        if (gi >= 0) { ov[gi] += ovP - cr; id[gi] += idP; }
      }
      for (let k = t; k < e; k++) { const gi = calIdx(d[k]); if (gi >= 0) expo[gi] += dir * shares * c[k]; }
      if (!open) { const cs = shares * c[e] * ps; const gi = calIdx(d[e]); if (gi >= 0) cst[gi] -= cs; }
    }
    return { ov, id, cst, expo };
  }
  // NEXT-OPEN legs: signal at the close of t, entry filled at o[t+1], exit signal at the close of u, exit filled at o[u+1]. Same slot dollars, cost, carry.
  function bookNO(legs, carryRate = 0) {
    const ov = new Float64Array(NC), id = new Float64Array(NC), cst = new Float64Array(NC), expo = new Float64Array(NC);
    for (const L of legs) {
      const { A, t, dir, slot } = L, d = A.d, c = A.c, o = A.o, dn = A.dn;
      if (d[t] < START || d[t] > END) continue;
      const en = t + 1; if (en > A.n - 1 || !(o[en] > 0) || d[en] > END) continue;
      let open = L.u < 0 || L.u + 1 > A.n - 1, x = open ? A.n - 1 : L.u + 1;
      while (x > en && d[x] > END) { x--; open = true; }
      if (x < en) continue;
      const shares = slot / o[en], ps = L.perSide;
      { const gi = calIdx(d[en]); if (gi >= 0) cst[gi] -= slot * ps; }
      for (let k = en; k <= x; k++) {
        const gi = calIdx(d[k]); if (gi < 0) continue; const days = dn[k] - dn[k - 1]; const cr = (k > en && dir < 0 && carryRate > 0) ? carryRate * shares * c[k - 1] * days / 365 : 0;
        if (k === en) { id[gi] += dir * shares * (c[k] - o[k]); continue; }
        if (k === x && !open) { ov[gi] += dir * shares * (o[k] - c[k - 1]) - cr; continue; }
        ov[gi] += dir * shares * (o[k] - c[k - 1]) - cr; id[gi] += dir * shares * (c[k] - o[k]);
      }
      const lastHold = open ? x : x - 1; for (let k = en; k <= lastHold; k++) { const gi = calIdx(d[k]); if (gi >= 0) expo[gi] += dir * shares * c[k]; }
      if (!open) { const gi = calIdx(d[x]); if (gi >= 0) cst[gi] -= shares * o[x] * ps; }
    }
    return { ov, id, cst, expo };
  }
  const slotFnOf = (eligDates) => { const s = [...eligDates].sort(); return (d) => { let n = 0; for (const x of s) if (x <= d) n++; return STAKE / Math.max(1, n); }; };
  const U13 = R13.UNIVERSE, PS13 = {}, A13 = {};
  for (const s of U13) { const bars = R13.unpack(C13.rows[s]); PS13[s] = R13.prep(bars, { from: C13.coverage[s].entryFrom, to: R13.ENTRY_TO }); A13[s] = withDn({ n: PS13[s].n, d: PS13[s].d, c: Float64Array.from(PS13[s].c), o: Float64Array.from(PS13[s].o) }); }
  const slot13 = slotFnOf(U13.map((s) => C13.coverage[s].entryFrom));
  const U28 = R28.UNIVERSE, W28 = R28.loadPanel(C28.rows, U28, R28.REPORTED_ONLY), ELIG28 = U28.map((s) => W28.firstElig[s]);
  const PS28 = U28.map((s, e) => { const B = W28.bases[s]; return R28.prepArrays(B.sym, { d: B.d, o: B.o, h: B.h, l: B.l, c: B.c }, ELIG28[e], R28.costBpsOf(B.sym)); });
  const A28 = {}; PS28.forEach((P) => { A28[P.sym] = withDn({ n: P.n, d: P.d, c: Float64Array.from(P.c), o: Float64Array.from(P.o) }); });
  const slot28 = slotFnOf(PS28.filter((P) => P.e0 < P.n).map((P) => P.d[P.e0]));
  const legs13 = [], legs28 = [];
  for (const s of U13) { const P = PS13[s], sim = R13.simulate(P, s); for (const x of [...sim.closed, ...sim.open]) legs13.push({ sym: s, A: A13[s], t: x.t, u: x.u === null ? -1 : x.u, dir: 1, slot: slot13(P.d[x.t]), perSide: R13.COST / 2 }); }
  PS28.forEach((P) => { const bk = R28.ruleBook(P, false); for (let j = 0; j < bk.T.length; j++) { const t = bk.T[j], u = bk.U[j]; legs28.push({ sym: P.sym, A: A28[P.sym], t, u: u < 0 ? -1 : u, dir: 1, slot: slot28(P.d[t]), perSide: P.perSide }); } });
  const legsS2 = [];
  for (const sym of U13) { const P = PS13[sym], nn = P.n; let pos = null; const inWin = (i) => P.d[i] >= P.from && P.d[i] <= P.to;
    for (let i = 0; i < nn; i++) {
      if (pos !== null) { if (R13.fin(P.ibs[i]) && P.ibs[i] < 0.1) { legsS2.push({ sym, A: A13[sym], t: pos, u: i, dir: -1, slot: slot13(P.d[pos]), perSide: R13.COST / 2 }); pos = null; } continue; }
      if (R13.fin(P.ibs[i]) && P.ibs[i] > 0.9 && inWin(i)) pos = i; }
    if (pos !== null) legsS2.push({ sym, A: A13[sym], t: pos, u: -1, dir: -1, slot: slot13(P.d[pos]), perSide: R13.COST / 2 }); }
  const bS2 = book(legsS2, 0.025), b13 = book(legs13), b28 = book(legs28);
  const nS2 = bookNO(legsS2, 0.025), n13 = bookNO(legs13), n28 = bookNO(legs28);
  const avgN = (k) => Float64Array.from(n13[k], (v, i) => 0.5 * (v + n28[k][i]));
  const avg = (k) => Float64Array.from(b13[k], (v, i) => 0.5 * (v + b28[k][i]));
  return { dip: { dates: CALD, ov: avg("ov"), id: avg("id"), cst: avg("cst"), expo: avg("expo") }, s2: { dates: CALD, ov: bS2.ov, id: bS2.id, cst: bS2.cst, expo: bS2.expo }, dipNO: { dates: CALD, ov: avgN("ov"), id: avgN("id"), cst: avgN("cst"), expo: avgN("expo") }, s2NO: { dates: CALD, ov: nS2.ov, id: nS2.id, cst: nS2.cst, expo: nS2.expo }, badOpens };
}
module.exports = { buildBooksOC };
