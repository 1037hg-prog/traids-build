#!/usr/bin/env node
"use strict";
/**
 * THE OPTIONS MIRROR (backend/alpaca-options-mirror.js) — costs and risks the board's R25 record does not carry. Read-only; no broker call.
 * The mirror has sent NO order yet (first watched 1-lot is Monday 2026-10-12), so every number here is a RETRO on the board's own 245
 * R25 wings and Alpaca 1-minute trade bars, not a broker fill. Pieces:
 *  A. wings that finish BETWEEN the strikes: the short leg is assigned, the wing expires, shares are left (the board books intrinsic and
 *     stops there). Overnight gap on those shares, swept at the next regular open as the mirror's --nta-sweep does.
 *  B. the mirror's --close-day pass (ITM or within 0.25% of spot, 15:45-15:59 ET, limit = natural debit + $0.05) replayed on 1-minute bars
 *     at 15:45 and at 15:55 (2 looks), vs the board's R25 rule, hold to expiry. Fill bracket: natural debit .. natural + $0.05.
 *  C. the entry concession (limit credit = board credit - $0.01) and SPY's exclusion from the mirror (BRIDGE_SWEEP_ROOTS).
 *  D. fees: the board models $0.65 x 2 legs at open; the broker's real fee activities are not yet observed.
 *   node backend/profit-program/options-mirror-costs.js
 * Writes backend/data/profit-program/options-mirror-costs.json
 */
const C = require("./_opt-common.js");
const B = require("./_opt-bars.js");
const T = require("../r25-twins.js");
const { $, u$, f } = C;
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
(async () => {
  const L = C.ledger();
  const R25 = L.signals.filter(C.isR25);
  const withRisk = (t) => { if (t.riskDollars > 0) return t; const lab = String(t.sizeLabel || ""), i = lab.indexOf("max loss $"); const v = i >= 0 ? parseFloat(lab.slice(i + 10)) : NaN; return v > 0 ? { ...t, riskDollars: v } : t; };
  const wings = R25.map(withRisk);
  const marks = T.loadMarks();
  const out = { note: "RETRO on board tickets; no broker fill exists yet" };
  // underlying daily bars for the overnight sweep
  const syms = [...new Set(wings.map((t) => t.sym))], daily = {};
  for (const s of syms) daily[s] = await B.stockDaily(s, "2026-07-01", "2026-10-09");
  const nextOpen = (s, d) => { const a = daily[s].find((x) => x.d > d); return a ? { d: a.d, o: a.o } : null; };

  // ── A. between-strikes finishes
  const rowsA = [];
  for (const t of wings) {
    const o = t.obs, W = o.width, S = o.settleUnder, K = +o.shortK, n = t.contracts || 1;
    const intr = o.optCall ? clamp(S - K, 0, W) : clamp(K - S, 0, W);
    rowsA.push({ id: t.id, day: C.etDay(t.openedAt), sym: t.sym, n, intr, W, between: intr > 0 && intr < W * 0.999, full: intr >= W * 0.999, call: !!o.optCall, S, K, pnl: t.pnl });
  }
  const btw = rowsA.filter((r) => r.between), full = rowsA.filter((r) => r.full);
  console.log(`A. FINISH BETWEEN THE STRIKES (the short leg assigned, the wing worthless): ${btw.length} of ${rowsA.length} wings (${f(100 * btw.length / rowsA.length, 1)}%); finish beyond both strikes (both legs exercised, net no shares): ${full.length} (${f(100 * full.length / rowsA.length, 1)}%)`);
  const gaps = [];
  for (const r of btw) {
    const no = nextOpen(r.sym, r.day); if (!no) continue;
    // put assigned -> long 100 x n shares bought at K, marked at the settle S, swept at the next open O: extra = (O - S) x 100 x n ; call assigned -> short shares: extra = (S - O) x 100 x n
    const extra = (r.call ? (r.S - no.o) : (no.o - r.S)) * 100 * r.n;
    gaps.push({ ...r, nextOpen: no.o, extra, shares: 100 * r.n, notional: r.S * 100 * r.n });
  }
  const g$ = gaps.map((g) => g.extra);
  const gapOut = { events: gaps.length, sum: C.sum(g$), mean: C.mean(g$), sd: C.sd(g$), worst: Math.min(...g$), best: Math.max(...g$), meanAbs: C.mean(g$.map(Math.abs)), notionalMedian: gaps.map((g) => g.notional).sort((a, b) => a - b)[Math.floor(gaps.length / 2)] };
  console.log(`   overnight sweep of the leftover shares at the next regular open: ${gaps.length} events, sum ${$(gapOut.sum)}, mean ${$(gapOut.mean)} (sd ${u$(gapOut.sd)}), mean |gap $| ${u$(gapOut.meanAbs)}, worst ${$(gapOut.worst)}, best ${$(gapOut.best)}; median notional carried overnight ${u$(gapOut.notionalMedian)}`);
  console.log(`   the board books none of this. Expected value is ~0 (a gap has no sign) but the VARIANCE is real: one event moves the day by a mean ${u$(gapOut.meanAbs)}.`);
  out.betweenStrikes = { wings: rowsA.length, between: btw.length, full: full.length, gap: gapOut };

  // ── B. close-day pass replay
  const byDay = new Map(); for (const t of wings) (byDay.get(C.etDay(t.openedAt)) || byDay.set(C.etDay(t.openedAt), []).get(C.etDay(t.openedAt))).push(t);
  const looks = ["15:45", "15:55"], resB = Object.fromEntries(looks.map((l) => [l, []]));
  let unpriced = 0;
  for (const day of [...byDay.keys()].sort()) {
    const W = byDay.get(day);
    const occs = [...new Set(W.flatMap((t) => { const r = t.obs.optCall ? "C" : "P"; return [T.occOf(t.sym, t.obs.optExpiry, r, +t.obs.shortK), T.occOf(t.sym, t.obs.optExpiry, r, +t.obs.longK)]; }))];
    const raw = await B.optionBars(day, occs);
    const bars = {}; for (const o of occs) bars[o] = T.colOf((raw[o] || []).map((b) => ({ ms: b[0] * 1000, c: b[1] })));
    for (const t of W) {
      const o = t.obs, r = o.optCall ? "C" : "P", n = t.contracts || 1, K = +o.shortK, W_ = o.width;
      const sOcc = T.occOf(t.sym, o.optExpiry, r, K), lOcc = T.occOf(t.sym, o.optExpiry, r, +o.longK);
      const sb = await B.stockBars(t.sym, day);
      const path_ = marks.byWing.get(t.id) || [];
      const entryCross = Math.max(0, (o.creditMid ?? t.entry) - (o.creditCross ?? t.entry));
      for (const look of looks) {
        const at = B.utcOf(day, look); let px = null; for (const b of sb) { if (b[0] * 1000 <= at - 60000) px = b[4]; else break; }
        if (px == null) { unpriced++; continue; }
        const itm = r === "P" ? px < K : px > K, near = r === "P" ? (px - K) / px <= 0.0025 : (K - px) / px <= 0.0025;
        if (!(itm || near)) continue;
        const ob = T.minuteObsAt(bars, sOcc, lOcc, at, t.openedAt);
        const fresh = ob && at - ob.ms <= 5 * 60 * 1000;
        const cross = T.crossingAt(path_, at, entryCross);
        const natural = fresh ? clamp(ob.spread + cross, 0, W_) : W_;   // no fresh print pair: the mirror would also have no quote basis; the width is the bound it falls back to
        const lo = natural, hi = Math.min(W_, natural + 0.05);
        const pnlAt = (fill) => (t.entry - fill) * 100 * n - 4 * 0.65 * n;
        resB[look].push({ id: t.id, day, sym: t.sym, n, itm, fresh: !!fresh, natural, hold: t.pnl, closeLo: pnlAt(hi), closeHi: pnlAt(lo), dLo: pnlAt(hi) - t.pnl, dHi: pnlAt(lo) - t.pnl });
      }
    }
  }
  console.log(`\nB. MIRROR --close-day PASS replayed on 1-minute bars (n=${wings.length} wings; ${unpriced} wing-looks had no underlying price)`);
  out.closeDay = {};
  for (const look of looks) {
    const X = resB[look], d = X.map((x) => x.dHi), dl = X.map((x) => x.dLo);
    const sess = C.bySession(X, (x) => x.dLo, (x) => x.day);
    const ds = [...new Set(X.map((x) => x.day))].length;
    console.log(`   look ${look}: flagged ${X.length} wings (${X.filter((x) => x.itm).length} ITM, ${X.filter((x) => !x.itm).length} within 0.25%) on ${ds} sessions; hold P&L of those wings ${$(C.sum(X.map((x) => x.hold)))}; closing them: best fill (natural) ${$(C.sum(X.map((x) => x.closeHi)))} to worst fill (natural+$0.05) ${$(C.sum(X.map((x) => x.closeLo)))}`);
    console.log(`      vs hold: ${$(C.sum(d))} (natural) to ${$(C.sum(dl))} (limit); per flagged wing ${$(C.mean(d))} to ${$(C.mean(dl))}; per session-clustered t of the limit-fill delta ${f(sess.t)} over ${sess.n} sessions; fresh print pair at the look on ${X.filter((x) => x.fresh).length} of ${X.length}`);
    for (const [lab, sub] of [["ITM at the look", X.filter((x) => x.itm)], ["near (within 0.25%, not ITM)", X.filter((x) => !x.itm)]]) {
      const btwIds = new Set(btw.map((r) => r.id)), ended = sub.filter((x) => btwIds.has(x.id)).length;
      console.log("      " + lab.padEnd(30) + " " + String(sub.length).padStart(3) + " wings: hold " + $(C.sum(sub.map((x) => x.hold))).padStart(7) + ", close " + $(C.sum(sub.map((x) => x.closeHi))).padStart(7) + " to " + $(C.sum(sub.map((x) => x.closeLo))).padStart(7) + ", delta " + $(C.sum(sub.map((x) => x.dHi))).padStart(7) + " to " + $(C.sum(sub.map((x) => x.dLo))).padStart(7) + "; of these " + ended + " finished between the strikes (the assignment case)");
    }
    out.closeDay[look] = { flagged: X.length, itm: X.filter((x) => x.itm).length, holdSum: C.sum(X.map((x) => x.hold)), closeBest: C.sum(X.map((x) => x.closeHi)), closeWorst: C.sum(X.map((x) => x.closeLo)), deltaBest: C.sum(d), deltaWorst: C.sum(dl), sessions: ds, tLimitFill: sess.t, freshPairs: X.filter((x) => x.fresh).length };
  }
  const nSess = new Set(wings.map((t) => C.etDay(t.openedAt))).size;
  for (const look of looks) {
    const X = resB[look], p4 = (key, sub = X) => C.sum(sub.map((x) => x[key] / x.n * 4)) / nSess * 21;
    const itmOnly = X.filter((x) => x.itm);
    out.closeDay[look].perMonth4ct = { all: [p4("dHi"), p4("dLo")], itmOnly: [p4("dHi", itmOnly), p4("dLo", itmOnly)] };
    console.log(`   ${look}: scaled to 4 contracts a wing, 21 sessions a month: ALL flagged ${$(p4("dHi"))} (natural fill) to ${$(p4("dLo"))} (limit fill); ITM-only ${$(p4("dHi", itmOnly))} to ${$(p4("dLo", itmOnly))}; assignment-case wings (finished between the strikes) avoided: ${X.filter((x) => btw.some((r) => r.id === x.id)).length} of ${btw.length}`);
  }

  // ── C. concession and SPY exclusion
  const c4 = wings.filter((t) => (t.contracts || 1) === 4), nonSpy = c4.filter((t) => t.sym !== "SPY");
  const concPer = 0.01 * 100 * 4, sess4 = new Set(c4.map((t) => C.etDay(t.openedAt))).size;
  console.log(`\nC. ENTRY CONCESSION: the limit is the board credit minus $0.01 = $${concPer.toFixed(0)} a 4-contract wing at most (if the broker fills exactly at the limit; a marketable limit fills at or better). Non-SPY wings per session (4-ct era): ${f(nonSpy.length / sess4, 2)} -> at most ${$(-concPer * nonSpy.length / sess4)} a session, ${$(-concPer * nonSpy.length / sess4 * 21)} a month; mean board credit ${f(C.mean(nonSpy.map((t) => t.entry)), 3)} so the cent is ${f(100 * 0.01 / C.mean(nonSpy.map((t) => t.entry)), 1)}% of the credit.`);
  const spy = wings.filter((t) => t.sym === "SPY");
  console.log(`   SPY IS EXCLUDED from the mirror (BRIDGE_SWEEP_ROOTS): ${spy.length} of ${wings.length} R25 wings (${f(100 * spy.length / wings.length, 0)}%), board P&L ${$(C.sum(spy.map((t) => t.pnl)))} of ${$(C.sum(wings.map((t) => t.pnl)))}; the broker record will cover ${wings.length - spy.length} wings of this population, so mirror-vs-board comparisons must be on the non-SPY set.`);
  out.concession = { perWing4ct: concPer, nonSpyPerSession: nonSpy.length / sess4, maxPerMonth: -concPer * nonSpy.length / sess4 * 21 };
  out.spyShare = { spy: spy.length, all: wings.length, spyPnl: C.sum(spy.map((t) => t.pnl)), allPnl: C.sum(wings.map((t) => t.pnl)) };

  // ── D. fees
  const feeBoard = 0.65 * 2, perSess = c4.length / sess4;
  console.log(`\nD. FEES: the board charges $${feeBoard.toFixed(2)} per contract-wing at open (2 legs x $0.65), none at expiry = ${$(-feeBoard * 4 * perSess * 21)}/month at 4 contracts. The broker's own fee lines (ORF, OCC clearing, OPT TAF; no commission is modelled by the grader) are per-account-day activities not yet observed because no order has been sent; backend/alpaca-options-reconcile.js reports gapFees per ticket from Monday. Until then the board's fee is a modelled number, not a measured one.`);
  out.fees = { boardPerContractWing: feeBoard, boardPerMonth4ct: -feeBoard * 4 * perSess * 21 };
  console.log("\nwrote " + C.writeOut("options-mirror-costs.json", out));
})().catch((e) => { console.error("FAILED: " + e.message); process.exitCode = 1; });
