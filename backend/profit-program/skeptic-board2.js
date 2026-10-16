#!/usr/bin/env node
"use strict";
/**
 * SKEPTIC 2 - equity+crypto board lane, second pass. READ-ONLY printer.
 *   node backend/profit-program/skeptic-board2.js
 *  [1] net exposure by close window, and tape vs selection for the equity book since 2026-09-25 (is the recent flat result a short-beta result?)
 *  [2] R49 shadows: are the shadow notionals comparable with executed tickets? value at half spread; recent flow
 *  [3] buying power since MR went quiet: batches above 100k and above 88k since 2026-09-23 (from board-sizing.json)
 *  [4] refusal above 30 bps restricted to the strategies still live on the board (Ensemble + Trend)
 *  [5] mark-no-bar exits: what do they book?
 *  [6] Ensemble Equity short (the one positive slice): concentration by session
 *  [7] broker exit vs ledger exit on mirror-exit rows (robust median only; the timing lag makes the mean useless)
 */
const fs = require("fs"), path = require("path");
const C = require("./_common.js");
const { $, f, pad, lpad, mean, sum, median, clusterT } = C;
const B = C.laneBoard();
const MONTH = 21;
const st = (t) => t.obs && Number.isFinite(t.obs.spreadBps);
const reg = B.sig.filter((t) => t._day >= C.REGIME_START);
const eq = reg.filter((t) => t.cls === "Equity" && Number.isFinite(t._notional) && Number.isFinite(t._risk));
const out = {};
console.log("SKEPTIC 2 - source " + B.source + "; regime equity signals " + eq.length);

// ---------- [1]
console.log("\n[1] NET EXPOSURE of the equity signal book by close window (R24 sleeve apart), and tape vs selection");
{
  const tape = C.tapeByClassDay(B.sig, B.ctl);
  const row = (lab, rows) => {
    if (!rows.length) { console.log("   " + lpad(lab, 34) + " n 0"); return null; }
    const L = rows.filter((t) => t.dir > 0), S = rows.filter((t) => 0 > t.dir);
    const gl = sum(L.map((t) => t._notional)), gs = sum(S.map((t) => t._notional));
    let tp = 0; for (const t of rows) { const b = tape.get(t.cls + "|" + t._day); if (b && Number.isFinite(t._notional)) tp += t.dir * t._notional * b.b; }
    const pnl = sum(rows.map((t) => t.pnl)), G = new Set(rows.map((t) => t._day)).size;
    const selR = clusterT(rows, (t) => { const b = tape.get(t.cls + "|" + t._day); return b ? t.rMult - t.dir * t._notional * b.b / t._risk : NaN; });
    console.log("   " + lpad(lab, 34) + " n " + pad(rows.length, 3) + " (long " + pad(L.length, 3) + " / short " + pad(S.length, 3) + ")  net notional share " + pad(((gl - gs) / (gl + gs) * 100).toFixed(0), 4) + "%  pnl " + pad($(pnl), 7) + "  exposure x tape " + pad($(tp), 7) + "  selection " + pad($(pnl - tp), 7) + "  selection R " + f(selR.mean) + " t " + f(selR.t, 2) + " (" + G + " sessions)");
    return { n: rows.length, pnl, tape: tp, sel: pnl - tp, tSel: selR.t };
  };
  const core = eq.filter((t) => t.strategy !== "R24-13F-clone");
  out.net_regime = row("regime, closed >= 2026-08-25", core);
  out.net_early = row("closed 2026-08-25 .. 09-10", core.filter((t) => "2026-09-11" > t._day));
  out.net_mid = row("closed 2026-09-11 .. 09-24", core.filter((t) => t._day >= "2026-09-11" && "2026-09-25" > t._day));
  out.net_last = row("closed >= 2026-09-25", core.filter((t) => t._day >= "2026-09-25"));
  out.net_last_ens = row("  Ensemble, closed >= 2026-09-25", core.filter((t) => t._day >= "2026-09-25" && t.strategy === "Ensemble"));
  out.net_last_trd = row("  Trend, closed >= 2026-09-25", core.filter((t) => t._day >= "2026-09-25" && t.strategy === "Trend"));
  const last = core.filter((t) => t._day >= "2026-09-25");
  const days = [...new Set(last.map((t) => t._day))].sort();
  const tb = days.map((d) => { const b = tape.get("Equity|" + d); return b ? b.b * 100 : NaN; });
  console.log("   equal-weight equity tape by close day since 2026-09-25 (percent): " + days.map((d, i) => d.slice(5) + " " + f(tb[i], 2)).join(", ") + "; sum " + f(sum(tb.filter(Number.isFinite)), 2) + "%");
  const mk = last.filter((t) => Number.isFinite(t.mktRet));
  const spyD = sum(mk.map((t) => t.dir * t._notional * t.mktRet / 100)), mkP = sum(mk.map((t) => t.pnl));
  console.log("   ledger mktRet (SPY over the hold, percent) on those tickets: n " + mk.length + ", mean " + f(mean(mk.map((t) => t.mktRet)), 3) + "; SPY-tape dollars = sum dir*notional*mktRet/100 = " + $(spyD) + " against their pnl " + $(mkP));
}

// ---------- [2]
console.log("\n[2] R49 SHADOWS (refused above 100 bps): sizing comparability and value");
{
  const sh = B.ctl.filter((t) => t.cls === "Equity" && t.vetoShadow && /R49/.test(t.veto || "") && Number.isFinite(t._notional) && st(t));
  const ex = eq.filter(st);
  const sess = new Set(reg.map((t) => t._day)).size;
  const full = sum(sh.map((t) => t.obs.spreadBps / 1e4 * t._notional)), gross = sum(sh.map((t) => t.pnl));
  const rk = (rows) => mean(rows.map((t) => t._risk).filter(Number.isFinite));
  console.log("   shadows with notional+spread " + sh.length + " over " + new Set(sh.map((t) => t._day)).size + " sessions; mean notional " + $(mean(sh.map((t) => t._notional))) + " vs executed stamped tickets " + $(mean(ex.map((t) => t._notional))) + "; mean 1R shadow " + $(rk(sh)) + " vs executed " + $(rk(ex)));
  const lateSh = sh.filter((t) => t._day >= "2026-09-04"), lateEx = ex.filter((t) => t._day >= "2026-09-04" && t.obs.spreadBps > 60);
  console.log("   closed >= 2026-09-04: shadow mean 1R " + $(rk(lateSh)) + " (n " + lateSh.length + ") vs executed tickets with spread above 60 bps " + $(rk(lateEx)) + " (n " + lateEx.length + "): ratio executed/shadow " + (rk(lateEx) / rk(lateSh)).toFixed(2));
  console.log("   value as the analyst computed it: full-spread cost " + $(full) + " - gross " + $(gross) + " = " + $(full - gross) + " = " + $((full - gross) / sess * MONTH) + "/month; at half spread " + $((full / 2 - gross) / sess * MONTH) + "/month");
  const lastSh = sh.filter((t) => t._day >= "2026-09-25"), ls = new Set(reg.filter((t) => t._day >= "2026-09-25").map((t) => t._day)).size;
  const fl = sum(lastSh.map((t) => t.obs.spreadBps / 1e4 * t._notional));
  console.log("   at the flow since 2026-09-25: " + lastSh.length + " shadows over " + ls + " sessions, full-spread cost " + $(fl) + " = " + $(fl / ls * MONTH) + "/month, half " + $(fl / 2 / ls * MONTH) + "/month; median shadow spread " + (lastSh.length ? median(lastSh.map((t) => t.obs.spreadBps)).toFixed(0) : "n/a") + " bps");
  const g = clusterT(sh, (t) => t.rMult);
  console.log("   shadow gross R mean " + f(g.mean) + " t " + f(g.t, 2) + " (" + g.G + " sessions)");
}

// ---------- [3]
console.log("\n[3] BUYING POWER by entry batch (board-sizing.json bp rows; gross notional open after the batch; account 100,000, mirror cap 88,000)");
{
  try {
    const j = JSON.parse(fs.readFileSync(path.join(C.OUT_DIR, "board-sizing.json"), "utf8"));
    const bp = j.bp.filter((r) => r.n > 0);
    const cnt = (rows, lim) => rows.filter((r) => r.gross > lim).length;
    for (const d0 of ["2026-08-25", "2026-09-11", "2026-09-23", "2026-10-05"]) {
      const r = bp.filter((x) => x.d >= d0);
      console.log("   batches from " + d0 + ": " + r.length + "; above 100k " + cnt(r, 100000) + ", above 88k " + cnt(r, 88000) + ", above 200k " + cnt(r, 200000) + "; median gross " + $(median(r.map((x) => x.gross))) + ", max " + $(Math.max.apply(null, r.map((x) => x.gross))) + "; median NET " + $(median(r.map((x) => x.net))) + ", most short " + $(Math.min.apply(null, r.map((x) => x.net))));
    }
    console.log("   the batches above 100k: " + bp.filter((r) => r.gross > 100000).map((r) => r.d + " " + $(r.gross)).join(", "));
  } catch (e) { console.log("   board-sizing.json unreadable: " + e.message + " (run board-sizing.js first)"); }
}

// ---------- [4]
console.log("\n[4] REFUSAL ABOVE 30 bps, ONLY the strategies still live on the board (Ensemble + Trend), stamped equity, by close window; cost at the STAMP (the NBBO-corrected cost is in skeptic-nbbo.js)");
{
  const live = eq.filter((t) => st(t) && (t.strategy === "Ensemble" || t.strategy === "Trend"));
  for (const d0 of ["2026-08-25", "2026-09-04", "2026-09-25"]) {
    const a = live.filter((t) => t._day >= d0), W = a.filter((t) => t.obs.spreadBps > 30), sl = new Set(eq.filter((t) => t._day >= d0).map((t) => t._day)).size;
    const c = sum(W.map((t) => t.obs.spreadBps / 1e4 * t._notional)), g = sum(W.map((t) => t.pnl));
    const tg = clusterT(W, (t) => t.rMult);
    console.log("   closed >= " + d0 + ": " + a.length + " live-strategy tickets / " + sl + " sessions, refused " + W.length + " (" + (W.length / a.length * 100).toFixed(0) + "%): refused gross " + $(g) + " (gross R " + f(tg.mean) + ", t " + f(tg.t, 2) + "), stamp cost full " + $(c) + " => per month: cost full " + $(c / sl * MONTH) + ", half " + $(c / 2 / sl * MONTH) + ", gross avoided " + $(-g / sl * MONTH));
  }
}

// ---------- [5]
console.log("\n[5] MARK-NO-BAR EXITS (regime equity signals)");
{
  const m = eq.filter((t) => t.reason === "mark-no-bar");
  const flat = m.filter((t) => 0.0002 >= Math.abs(t.exit - t.entry) / t.entry);
  const absR = (rows) => f(mean(rows.map((t) => Math.abs(t.rMult))));
  console.log("   n " + m.length + ", pnl " + $(sum(m.map((t) => t.pnl))) + ", mean R " + f(mean(m.map((t) => t.rMult))) + ", mean |R| " + absR(m) + " (close exits: mean |R| " + absR(eq.filter((t) => t.reason === "close")) + "); exit equal to entry within 2 bps: " + flat.length + "; sessions " + [...new Set(m.map((t) => t._day))].sort().join(" "));
}

// ---------- [6]
console.log("\n[6] ENSEMBLE EQUITY SHORT (the one positive slice): concentration by session");
{
  const s = eq.filter((t) => t.strategy === "Ensemble" && 0 > t.dir), by = new Map();
  for (const t of s) by.set(t._day, (by.get(t._day) || 0) + t.pnl);
  const d = [...by.entries()].sort((a, b) => b[1] - a[1]), tot = sum(d.map((x) => x[1]));
  console.log("   n " + s.length + ", " + d.length + " sessions, total " + $(tot) + "; best 2 sessions " + d.slice(0, 2).map((x) => x[0] + " " + $(x[1])).join(", ") + " = " + ((d[0][1] + d[1][1]) / tot * 100).toFixed(0) + "% of the total; without them " + $(tot - d[0][1] - d[1][1]) + "; sessions positive " + d.filter((x) => x[1] > 0).length + " of " + d.length);
  const k = clusterT(s, (t) => t.rMult); console.log("   mean R " + f(k.mean) + " t " + f(k.t, 2) + " (" + k.G + " sessions); the 683-session replay prints Ensemble short at -0.0198R (t -1.43) (board-replay-gross.js)");
}

// ---------- [7]
console.log("\n[7] BROKER EXIT vs LEDGER EXIT on mirror-exit rows (signed so that positive = the broker exit was worse for the position)");
{
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "alpaca-reconcile.json"), "utf8"));
  const byId = new Map(B.sig.map((t) => [t.id, t]));
  const rows = [];
  for (const p of j.perTicket) {
    const t = byId.get(p.ticketId); if (!t || t.cls !== "Equity") continue;
    if (!/mirror-exit/.test(String(p.brokerExitReason || ""))) continue;
    if (!Number.isFinite(p.brokerExit) || !Number.isFinite(p.ourExit) || !(p.ourExit > 0)) continue;
    rows.push({ d: t.dir * (p.ourExit - p.brokerExit) / p.ourExit * 1e4, half: st(t) ? t.obs.spreadBps / 2 : NaN, reason: p.ourReason });
  }
  const cl = rows.filter((r) => r.reason === "close");
  const q = (a, p) => C.quantile(a, p).toFixed(1);
  const dd = cl.map((r) => r.d), hh = cl.map((r) => r.half).filter(Number.isFinite);
  console.log("   mirror-exit equity rows " + rows.length + " (ledger reason close: " + cl.length + "); signed exit gap bps on the close rows: p25 " + q(dd, 0.25) + ", median " + q(dd, 0.5) + ", p75 " + q(dd, 0.75) + ", mean " + mean(dd).toFixed(1) + "; median entry half-spread on the same rows " + q(hh, 0.5));
  console.log("   reading: the interquartile range is the timing lag between the board close and the mirror order; only the median is informative, and only weakly.");
}
C.write("skeptic-board2.json", Object.assign({ spec: "skeptic-board2-v1", asOf: new Date().toISOString() }, out));
