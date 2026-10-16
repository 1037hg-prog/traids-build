#!/usr/bin/env node
"use strict";
/**
 * SKEPTIC (options-premium lane): checks on the baseline and on the two positive claims. Read-only, in-sample, exploratory.
 *  A. R21 is a multi-day wing: wings opened on different days settle on the SAME expiry, so "entry sessions" are not independent draws.
 *     The R21 baseline and the R21 stop replay are re-clustered by EXPIRY date.
 *  B. "Gross premium at the mid is real": the live t by era (1-contract era / 4-contract era), its two best sessions, and the archive by half-year.
 *  C. The base rate for R25 dollars: the 501-session archive at 4 contracts and today's wings a session, beside the 19-session live anchor.
 *  D. "Work the credit": what the crossing is made of, in ticks and by underlying, and how much of it sits on the wings the mirror can send (non-SPY).
 *  E. "ITM-only at 15:55 removes all the assignment exposure": how many between-the-strikes finishes each look and each flag set catches.
 *   node backend/profit-program/skeptic-options-baseline-checks.js
 * Writes backend/data/profit-program/skeptic-options-baseline-checks.json
 */
const fs = require("fs"), path = require("path");
const C = require("./_opt-common.js");
const B = require("./_opt-bars.js");
const { $, f } = C;
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const P = (s, w) => String(s).padStart(w);
const L = C.ledger(), out = { label: "SKEPTIC, in-sample exploratory" };
const tBy = (R, val, key) => { const s = C.bySession(R, val, key); return { clusters: s.n, sum: C.sum(s.sums), t: s.t, sums: s.sums, days: s.days }; };
const top2 = (s) => { const a = s.sums.slice().sort((x, y) => y - x); return { best2: a[0] + a[1], rest: s.sum - a[0] - a[1], share: (a[0] + a[1]) / s.sum }; };

function partA() {
  console.log("A. R21: entry sessions are not independent (multi-day wings share an expiry). Re-clustered by expiry date.");
  out.A = {};
  const inTable = (t) => C.isR21(t) && !t.ctrl && C.inHours(t);
  for (const [lab, since] of [["closed since 2026-09-25", "2026-09-25"], ["closed since 2026-07-20", "2026-07-20"]]) {
    const R = L.signals.filter((t) => inTable(t) && C.mtDay(t.closedAt) >= since);
    const e = tBy(R, (t) => t.pnl, (t) => C.etDay(t.openedAt)), x = tBy(R, (t) => t.pnl, (t) => String(t.obs.optExpiry)), k = top2(x);
    console.log(`   ${lab}: ${R.length} tickets, net ${$(e.sum)}; by ENTRY session ${e.clusters} clusters t ${f(e.t)}; by EXPIRY ${x.clusters} clusters t ${f(x.t)}; best two expiries ${$(k.best2)}, the other ${x.clusters - 2} sum ${$(k.rest)}`);
    console.log(`      by expiry: ${x.days.map((d, i) => d.slice(5) + " " + $(x.sums[i])).join(" | ")}`);
    out.A[lab] = { n: R.length, net: e.sum, byEntry: { clusters: e.clusters, t: e.t }, byExpiry: { clusters: x.clusters, t: x.t, sums: Object.fromEntries(x.days.map((d, i) => [d, x.sums[i]])) }, bestTwoExpiries: k };
  }
  let rep = null; try { rep = JSON.parse(fs.readFileSync(path.join(C.OUT_DIR, "r21-retro-stop-replay.json"), "utf8")); } catch {}
  if (rep && rep.rows) {
    const exp = new Map(L.signals.filter(C.isR21).map((t) => [t.id, String(t.obs.optExpiry)]));
    const R = rep.rows.filter((r) => exp.has(r.id));
    for (const [lab, pred] of [["ALL R21", () => true], ["SPY/QQQ/IWM", (r) => r.etf]]) {
      const S = R.filter(pred), d = (r) => r.K2.pnl - r.hold, e = tBy(S, d, (r) => r.day), x = tBy(S, d, (r) => exp.get(r.id));
      console.log(`   R21 stop replay K 2.0 vs hold, ${lab}: ${S.length} wings, ${$(e.sum)}; by ENTRY session ${e.clusters} clusters t ${f(e.t)}; by EXPIRY ${x.clusters} clusters t ${f(x.t)} (${x.sums.filter((v) => v < 0).length} of ${x.clusters} expiries negative)`);
      out.A["stopReplay " + lab] = { n: S.length, sum: e.sum, byEntry: { clusters: e.clusters, t: e.t }, byExpiry: { clusters: x.clusters, t: x.t, negative: x.sums.filter((v) => v < 0).length } };
    }
  }
}

function r25rows() {
  return L.signals.filter(C.isR25).map((t) => {
    const o = t.obs, n = t.contracts || 1, K = +o.shortK, W = o.width, S = o.settleUnder;
    const intr = o.optCall ? clamp(S - K, 0, W) : clamp(K - S, 0, W);
    return { t, day: C.etDay(t.openedAt), sym: t.sym, n, K, W, call: !!o.optCall, intr, gross: (o.creditMid - intr) * 100, net: t.pnl / n, cross: Math.max(0, o.creditMid - o.creditCross), mid: o.creditMid,
      between: intr > 0 && intr < W * 0.999 };
  });
}

function partB(R) {
  console.log("\nB. GROSS PREMIUM AT THE MID (live R25, $ per contract-wing, session-clustered): is the t 3.03 one regime?");
  out.B = { live: {}, archiveHalves: {} };
  for (const [lab, pred] of [["all 35 sessions", () => true], ["1- and 3-contract era (before 09-14)", (r) => r.day < "2026-09-14"], ["4-contract era (09-14 on)", (r) => r.day >= "2026-09-14"]]) {
    const S = R.filter(pred), g = tBy(S, (r) => r.gross, (r) => r.day), k = top2(g), nt = tBy(S, (r) => r.net, (r) => r.day);
    console.log(`   ${lab.padEnd(38)} ${P(S.length, 4)} wings ${P(g.clusters, 3)} sessions: gross ${$(g.sum)} (${(g.sum / S.length).toFixed(2)} a wing) t ${f(g.t)}; best two sessions ${$(k.best2)} = ${f(100 * k.share, 0)}% of it; net after crossing and fee ${(nt.sum / S.length).toFixed(2)} a wing, t ${f(nt.t)}`);
    out.B.live[lab] = { wings: S.length, sessions: g.clusters, grossSum: g.sum, grossPerWing: g.sum / S.length, t: g.t, bestTwoShare: k.share, netPerWing: nt.sum / S.length, netT: nt.t };
  }
}

function partC() {
  const A = JSON.parse(fs.readFileSync(path.join(C.DATA, "r116-zero-dte-replay-wings.json"), "utf8")).map((w) => {
    const intr = w.right === "C" ? clamp(w.settle - w.shortStrike, 0, w.width) : clamp(w.shortStrike - w.settle, 0, w.width);
    return { day: w.day, sym: w.u, net: w.pnl, gross: (w.credit - intr) * 100 };
  });
  const WPS = 7.84;
  console.log(`\nC. BASE RATE for R25 dollars: the frozen rule on the archive, at 4 contracts and today's ${WPS} wings a session x 21 sessions`);
  out.C = {};
  for (const [lab, pred] of [["all six underlyings", () => true], ["SPY/QQQ/IWM (the population R116 read)", (r) => ["SPY", "QQQ", "IWM"].includes(r.sym)], ["last 12 full months 2025-07..2026-06", (r) => r.day >= "2025-07-01" && r.day <= "2026-06-30"]]) {
    const S = A.filter(pred), n = tBy(S, (r) => r.net, (r) => r.day), g = tBy(S, (r) => r.gross, (r) => r.day), per = (v) => v / S.length * 4 * WPS * 21;
    console.log(`   ${lab.padEnd(40)} ${P(S.length, 5)} wings ${P(n.clusters, 4)} sessions: NET ${(n.sum / S.length).toFixed(2)} a contract-wing (t ${f(n.t)}) = ${$(per(n.sum))}/month; gross at the print credit ${(g.sum / S.length).toFixed(2)} (t ${f(g.t)}) = ${$(per(g.sum))}/month`);
    out.C[lab] = { wings: S.length, sessions: n.clusters, netPerWing: n.sum / S.length, netT: n.t, netPerMonth4ct: per(n.sum), grossPerWing: g.sum / S.length, grossT: g.t, grossPerMonth4ct: per(g.sum) };
  }
  let ka = null; try { ka = JSON.parse(fs.readFileSync(path.join(C.DATA, "r116-zero-dte-replay.json"), "utf8")).knownAnswer; } catch {}
  if (ka) { console.log(`   the archive credit is a trade print, not a quote mid. Its own known-answer against ${ka.replayed} live wings: median |credit difference| $${ka.medianCreditDiff} a share, mean signed $${ka.meanSignedCreditDiff} a share = $${(100 * ka.meanSignedCreditDiff).toFixed(2)} a contract (the gross premium it reports is $${(out.C["all six underlyings"].grossPerWing).toFixed(2)} a contract)`); out.C.knownAnswer = ka; }
}

function partD(R) {
  const S = R.filter((r) => r.day >= "2026-09-14" && r.n === 4), nS = new Set(S.map((r) => r.day)).size;
  console.log(`\nD. WHAT THE CROSSING IS MADE OF (R25, 4-contract era: ${S.length} wings, ${nS} sessions; crossing = mid credit - booked cross credit, $ a share)`);
  const tot = C.sum(S.map((r) => r.cross * 400)), perMo = (v) => v / nS * 21;
  const bands = [["under 1 cent", (c) => c < 0.0095], ["1 to under 2 cents", (c) => c >= 0.0095 && c < 0.0195], ["2 cents or more", (c) => c >= 0.0195]];
  out.D = { wings: S.length, sessions: nS, totalPerMonth: perMo(tot), bands: {}, bySym: {} };
  for (const [lab, pred] of bands) { const X = S.filter((r) => pred(r.cross)), d = C.sum(X.map((r) => r.cross * 400)); console.log(`   ${lab.padEnd(20)} ${P(X.length, 4)} wings (${f(100 * X.length / S.length, 0)}%)  crossing ${$(-perMo(d))}/month (${f(100 * d / tot, 0)}% of it)`); out.D.bands[lab] = { wings: X.length, perMonth: perMo(d) }; }
  for (const s of [...new Set(S.map((r) => r.sym))].sort()) { const X = S.filter((r) => r.sym === s), d = C.sum(X.map((r) => r.cross * 400)); console.log(`   ${s.padEnd(5)} ${P(X.length, 4)} wings  mean crossing $${C.mean(X.map((r) => r.cross)).toFixed(4)}  = ${f(100 * C.mean(X.map((r) => r.cross / r.mid)), 1)}% of mid  ${$(-perMo(d))}/month (${f(100 * d / tot, 0)}%)`); out.D.bySym[s] = { wings: X.length, meanCross: C.mean(X.map((r) => r.cross)), perMonth: perMo(d) }; }
  const nonSpy = C.sum(S.filter((r) => r.sym !== "SPY").map((r) => r.cross * 400)), oneTick = C.sum(S.map((r) => (r.cross >= 0.0095 ? 0.01 : 0) * 400)), oneTickNS = C.sum(S.filter((r) => r.sym !== "SPY").map((r) => (r.cross >= 0.0095 ? 0.01 : 0) * 400));
  console.log(`   ceiling, every wing filled AT THE MID: ${$(perMo(tot))}/month on the board; on the wings the mirror can send (non-SPY) ${$(perMo(nonSpy))}/month`);
  console.log(`   one penny better than the cross where the mid leaves room for a penny (crossing >= 1 cent), every such order filled: ${$(perMo(oneTick))}/month on the board, ${$(perMo(oneTickNS))}/month non-SPY`);
  Object.assign(out.D, { ceilingBoard: perMo(tot), ceilingNonSpy: perMo(nonSpy), oneTickBoard: perMo(oneTick), oneTickNonSpy: perMo(oneTickNS) });
}

async function partE(R) {
  console.log("\nE. BETWEEN-THE-STRIKES FINISHES (the assignment case) caught by each close-day flag set");
  out.E = {};
  for (const look of ["15:45", "15:55"]) {
    for (const r of R) {
      const sb = await B.stockBars(r.sym, r.day), at = B.utcOf(r.day, look); let px = null;
      for (const b of sb) { if (b[0] * 1000 <= at - 60000) px = b[4]; else break; }
      r.itm = px == null ? null : (r.call ? px > r.K : px < r.K);
      r.near = px == null ? null : (r.call ? (r.K - px) / px <= 0.0025 : (px - r.K) / px <= 0.0025);
    }
    for (const [lab, pred] of [["all wings", () => true], ["non-SPY (the mirror)", (r) => r.sym !== "SPY"]]) {
      const S = R.filter(pred), bt = S.filter((r) => r.between), byItm = bt.filter((r) => r.itm).length, byAny = bt.filter((r) => r.itm || r.near).length;
      console.log(`   look ${look}, ${lab.padEnd(21)} ${bt.length} between-the-strikes finishes of ${S.length}: ITM-only catches ${byItm} (${f(100 * byItm / bt.length, 0)}%), ITM-or-within-0.25% catches ${byAny} (${f(100 * byAny / bt.length, 0)}%)`);
      out.E[look + " " + lab] = { wings: S.length, between: bt.length, itmOnly: byItm, itmOrNear: byAny };
    }
  }
}

(async () => {
  partA(); const R = r25rows(); partB(R); partC(); partD(R); await partE(R);
  console.log("\nwrote " + C.writeOut("skeptic-options-baseline-checks.json", out));
})().catch((e) => { console.error("FAILED: " + e.stack); process.exitCode = 1; });
