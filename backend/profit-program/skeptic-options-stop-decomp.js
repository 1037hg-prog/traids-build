#!/usr/bin/env node
"use strict";
/**
 * SKEPTIC (options-premium lane): what is the "stops lose $X" number made of? Read-only, in-sample, exploratory.
 * Same population, same r25-twins.js stopTwin(), same cached 1-minute bars as r25-retro-stop-replay.js. The difference of each
 * stop against holding is split EXACTLY into
 *    path     = (intrinsic at expiry - the print spread that fired the stop) x 100 x n   (zero in expectation for a fair price)
 *    crossing = -(crossing added to the fill) x 100 x n                                  (friction)
 *    fee      = -2 x $0.65 x n                                                           (friction: the two extra legs)
 * and checked to the cent against the D$ stopTwin reports. Also: the Doob bound (a fair price started at the entry MID touches a
 * line L with probability at most mid / L); trigger quality (time gap between the two legs at the trigger; the spread over the next
 * five minutes); two diagnostic triggers (NOT proposals; 2 variants): both legs printed in the SAME minute, and a line that must
 * hold on the next fresh observation; and the same split on the 501-session R116 archive (its capped field = the 2x rule).
 *   node backend/profit-program/skeptic-options-stop-decomp.js
 * Writes backend/data/profit-program/skeptic-options-stop-decomp.json
 */
const fs = require("fs"), path = require("path");
const C = require("./_opt-common.js");
const B = require("./_opt-bars.js");
const T = require("../r25-twins.js");
const { $, f } = C;
const KS = [1.5, 2.0, 2.5, 3.0];
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const lastIdx = (a, v) => { let i = -1; for (let q = 0; q < a.ms.length && a.ms[q] <= v; q++) i = q; return i; };

async function build() {
  const L = C.ledger();
  const withRisk = (t) => {
    if (t.riskDollars > 0) return t;
    const lab = String(t.sizeLabel || ""), i = lab.indexOf("max loss $"), v = i >= 0 ? parseFloat(lab.slice(i + 10)) : NaN;
    return v > 0 ? { ...t, riskDollars: v } : t;
  };
  const pop = L.signals.filter(C.isR25).map(withRisk).filter((t) => T.isPopulation(t, "2026-08-19") && C.etDay(t.openedAt) < T.EVIDENCE_FROM);
  const marks = T.loadMarks();
  const byDay = new Map();
  for (const t of pop) { const d = C.etDay(t.openedAt); (byDay.get(d) || byDay.set(d, []).get(d)).push(t); }
  const rows = [];
  for (const day of [...byDay.keys()].sort()) {
    const W = byDay.get(day);
    const legs = (t) => { const r = t.obs.optCall ? "C" : "P"; return [T.occOf(t.sym, t.obs.optExpiry, r, +t.obs.shortK), T.occOf(t.sym, t.obs.optExpiry, r, +t.obs.longK)]; };
    const occs = [...new Set(W.flatMap(legs))];
    const raw = await B.optionBars(day, occs);
    const bars = {};
    for (const o of occs) bars[o] = T.colOf((raw[o] || []).map((b) => ({ ms: b[0] * 1000, c: b[1] })));
    for (const t of W) rows.push(wingRow(t, day, bars, marks.byWing.get(t.id) || []));
  }
  return rows;
}

function wingRow(t, day, bars, path_) {
  const o = t.obs, n = t.contracts || 1, Wd = o.width, S = o.settleUnder, K = +o.shortK;
  const intr = o.optCall ? clamp(S - K, 0, Wd) : clamp(K - S, 0, Wd);
  const r = { id: t.id, day, sym: t.sym, n, credit: t.entry, mid: o.creditMid, width: Wd, intr, hold: t.pnl, k: {} };
  const closeMs = B.utcOf(o.optExpiry, "16:00");
  const entryCross = Math.max(0, (o.creditMid ?? t.entry) - (o.creditCross ?? t.entry));
  const mk = path_.filter((m) => m.ms >= t.openedAt && m.ms <= closeMs);
  const pnlAt = (sp, ms) => (t.entry - Math.min(Wd, sp + T.crossingAt(mk, ms, entryCross))) * 100 * n - 2.6 * n;
  for (const k of KS) {
    const x = T.stopTwin(t, path_, bars, k, { beside: false }), p = x.primary, line = k * t.entry;
    const sb = bars[x.shortOcc], lb = bars[x.longOcc];
    const e = { trig: !!p.triggered, d: p.triggered ? p.pnl - t.pnl : 0, line };
    if (p.triggered && p.fillSrc === "1m") {
      const capped = Math.min(Wd, p.minuteSpread + p.crossing);
      e.spread = p.minuteSpread;
      e.path$ = (intr - p.minuteSpread) * 100 * n; e.cross$ = -(capped - p.minuteSpread) * 100 * n; e.fee$ = -1.3 * n;
      e.checkErr = Math.abs(e.path$ + e.cross$ + e.fee$ - e.d);
      const st = p.ms - 60000;
      e.legGapMin = Math.abs(sb.ms[lastIdx(sb, st)] - lb.ms[lastIdx(lb, st)]) / 60000;
      const nxt = [];
      for (let m = 1; m <= 5; m++) { const ob = T.minuteObsAt(bars, x.shortOcc, x.longOcc, p.ms + m * 60000, t.openedAt); if (ob && ob.ms > p.ms) nxt.push(ob.spread); }
      e.nextMed = nxt.length ? nxt.slice().sort((a, b) => a - b)[Math.floor(nxt.length / 2)] : null;
    }
    // diagnostic A: both legs printed in the same minute
    const lmap = new Map(lb.ms.map((m, i) => [m, lb.c[i]]));
    let sync = null;
    for (let i = 0; i < sb.ms.length && !sync; i++) {
      const m = sb.ms[i]; if (m < t.openedAt || m + 60000 > closeMs) continue;
      const lc = lmap.get(m); if (!(lc > 0)) continue;
      if (sb.c[i] - lc + 1e-9 >= line) sync = { ms: m + 60000, spread: sb.c[i] - lc };
    }
    e.sync = sync ? { trig: true, d: pnlAt(sync.spread, sync.ms) - t.pnl } : { trig: false, d: 0 };
    // diagnostic B: the next fresh observation (a later bar) must be through the line too; filled at that later observation
    let conf = null, lo = t.openedAt;
    for (let guard = 0; guard < 400 && !conf; guard++) {
      const m1 = T.minuteTrigger(bars, x.shortOcc, x.longOcc, lo, closeMs, line); if (!m1) break;
      let ob2 = null;
      for (let m = 1; m <= 5 && !ob2; m++) { const ob = T.minuteObsAt(bars, x.shortOcc, x.longOcc, m1.ms + m * 60000, t.openedAt); if (ob && ob.ms > m1.ms) ob2 = ob; }
      if (ob2 && ob2.spread + 1e-9 >= line && ob2.ms <= closeMs) conf = ob2; else lo = m1.ms;
    }
    e.conf = conf ? { trig: true, d: pnlAt(conf.spread, conf.ms) - t.pnl } : { trig: false, d: 0 };
    r.k["K" + k] = e;
  }
  return r;
}

function report(rows) {
  const sessions = [...new Set(rows.map((r) => r.day))].sort(), nS = sessions.length;
  const sessT = (fn, R = rows) => { const s = C.bySession(R, fn, (r) => r.day); return { sum: C.sum(s.sums), t: s.t, perSession: s.meanPerSession }; };
  const per4 = (fn, R = rows) => C.bySession(R, (r) => fn(r) / r.n * 4, (r) => r.day).meanPerSession * 21;
  const P = (s, w) => String(s).padStart(w);
  const out = { label: "SKEPTIC, in-sample exploratory", wings: rows.length, sessions: nS, byK: {} };
  console.log(`SKEPTIC: R25 stop replay split into path / crossing / fee (${rows.length} wings, ${nS} sessions; same stopTwin and bars as the analyst)\n`);
  console.log(`K     stops   rate  Doob max |  vs hold      t  @4ct/mo |     PATH      t  @4ct/mo | crossing     fee  FRICTION @4ct/mo | split err`);
  for (const k of KS) {
    const key = "K" + k, X = rows.filter((r) => r.k[key].trig), all = sessT((r) => r.k[key].d);
    const pth = sessT((r) => r.k[key].path$ || 0), cr = sessT((r) => r.k[key].cross$ || 0), fe = sessT((r) => r.k[key].fee$ || 0);
    const doob = C.mean(rows.map((r) => Math.min(1, r.mid / (k * r.credit))));
    const err = Math.max(0, ...X.map((r) => r.k[key].checkErr || 0));
    const fr4 = per4((r) => (r.k[key].cross$ || 0) + (r.k[key].fee$ || 0)), p4 = per4((r) => r.k[key].path$ || 0), t4 = per4((r) => r.k[key].d);
    console.log(`${String(k).padEnd(5)} ${P(X.length, 5)} ${P(f(100 * X.length / rows.length, 1) + "%", 6)} ${P(f(100 * doob, 1) + "%", 9)} | ${P($(all.sum), 8)} ${P(f(all.t), 6)} ${P($(t4), 8)} | ${P($(pth.sum), 8)} ${P(f(pth.t), 6)} ${P($(p4), 8)} | ${P($(cr.sum), 8)} ${P($(fe.sum), 7)} ${P($(fr4), 17)} | ${err.toFixed(3)}`);
    out.byK[key] = { stops: X.length, rate: X.length / rows.length, doobMax: doob, vsHold: all, path: pth, crossing: cr.sum, fee: fe.sum, pathPerMonth4ct: p4, frictionPerMonth4ct: fr4, totalPerMonth4ct: t4 };
  }
  console.log("\n  Doob max = the largest share of wings a FAIR price started at the entry mid can carry to the line (mid / line, averaged over wings).");
  console.log("\nPATH term at K 2.0 by half of the sample (a real effect keeps its sign; luck need not):");
  const half = Math.floor(nS / 2), h1 = new Set(sessions.slice(0, half));
  out.pathHalvesK2 = {};
  for (const [lab, pred] of [["first " + half + " sessions", (r) => h1.has(r.day)], ["last " + (nS - half) + " sessions", (r) => !h1.has(r.day)]]) {
    const R = rows.filter(pred), s = sessT((r) => r.k.K2.path$ || 0, R), p4 = per4((r) => r.k.K2.path$ || 0, R);
    console.log(`  ${lab.padEnd(20)} path ${P($(s.sum), 8)}  t ${f(s.t)}  at 4 contracts ${$(p4)}/month  stops ${R.filter((r) => r.k.K2.trig).length} of ${R.length}`);
    out.pathHalvesK2[lab] = { path: s.sum, t: s.t, perMonth4ct: p4 };
  }
  {
    const s = C.bySession(rows, (r) => r.k.K2.d, (r) => r.day), sorted = s.sums.map((v, i) => [s.days[i], v]).sort((a, b) => a[1] - b[1]);
    const neg = s.sums.filter((v) => v < 0).length, share = (sorted[0][1] + sorted[1][1]) / C.sum(s.sums);
    console.log(`\nK 2.0 vs hold by session: ${neg} of ${s.n} sessions negative; worst two ${sorted.slice(0, 2).map((x) => x[0] + " " + $(x[1])).join(", ")} = ${f(100 * share, 0)}% of the total; best two ${sorted.slice(-2).map((x) => x[0] + " " + $(x[1])).join(", ")}`);
    out.k2Concentration = { negSessions: neg, sessions: s.n, worstTwoShare: share };
  }
  {
    const X = rows.filter((r) => r.k.K2.trig && r.k.K2.spread != null).map((r) => r.k.K2);
    const gap0 = X.filter((e) => e.legGapMin === 0).length, gap2 = X.filter((e) => e.legGapMin >= 2).length;
    const wn = X.filter((e) => e.nextMed != null), back = wn.filter((e) => e.nextMed + 1e-9 < e.line).length;
    const over = C.mean(X.map((e) => e.spread - e.line)), drop = C.mean(wn.map((e) => e.spread - e.nextMed));
    console.log(`\nTRIGGER QUALITY at K 2.0 (${X.length} stops): the two legs printed in the same minute on ${gap0} (${f(100 * gap0 / X.length, 0)}%), two or more minutes apart on ${gap2} (${f(100 * gap2 / X.length, 0)}%)`);
    console.log(`   the firing print spread is a mean $${over.toFixed(3)} a share above the line; the median print spread over the NEXT five minutes is back UNDER the line on ${back} of ${wn.length} (${f(100 * back / wn.length, 0)}%), a mean $${drop.toFixed(3)} a share below the firing print`);
    out.triggerQualityK2 = { stops: X.length, sameMinute: gap0, twoPlusMinApart: gap2, meanOvershoot: over, backUnderLineNext5: back, withNext: wn.length, meanDropNext5: drop };
  }
  console.log("\nDIAGNOSTIC TRIGGERS (2 variants, not proposals): the same line, a cleaner signal");
  console.log("K     | as coded: stops  vs hold      t  @4ct/mo | same-minute: stops  vs hold      t  @4ct/mo | confirmed: stops  vs hold      t  @4ct/mo");
  out.diagnostic = {};
  for (const k of KS) {
    const key = "K" + k, cell = (pick, w) => {
      const n = rows.filter((r) => pick(r).trig).length, s = sessT((r) => pick(r).d), m = per4((r) => pick(r).d);
      return { txt: `${P(n, w)} ${P($(s.sum), 8)} ${P(f(s.t), 6)} ${P($(m), 8)}`, obj: { stops: n, sum: s.sum, t: s.t, perMonth4ct: m } };
    };
    const a = cell((r) => r.k[key], 15), s = cell((r) => r.k[key].sync, 18), c = cell((r) => r.k[key].conf, 16);
    console.log(`${String(k).padEnd(5)} | ${a.txt} | ${s.txt} | ${c.txt}`);
    out.diagnostic[key] = { asCoded: a.obj, sameMinute: s.obj, confirmed: c.obj };
  }
  return out;
}

function archive(out) {
  const A = JSON.parse(fs.readFileSync(path.join(C.DATA, "r116-zero-dte-replay-wings.json"), "utf8"));
  const ar = [];
  for (const w of A) {
    const Wd = w.width, intr = w.right === "C" ? clamp(w.settle - w.shortStrike, 0, Wd) : clamp(w.shortStrike - w.settle, 0, Wd);
    const cross = Math.max(0, w.credit - w.creditCross);
    const e = { day: w.day, capped: !!w.capped, d: 0, path$: 0, fr$: 0, mid: w.credit, credit: w.creditCross };
    if (w.capped) {
      const sp = Math.max(0, w.capped.debit - cross);
      e.d = w.capped.pnl - w.pnl; e.fr$ = -(w.capped.debit - sp) * 100 - 1.3; e.path$ = (intr - sp) * 100; e.err = Math.abs(e.path$ + e.fr$ - e.d);
    }
    ar.push(e);
  }
  const aS = (fn, R = ar) => { const s = C.bySession(R, fn, (r) => r.day); return { sum: C.sum(s.sums), t: s.t, perSession: s.meanPerSession, n: s.n }; };
  const aAll = aS((r) => r.d), aP = aS((r) => r.path$), aX = aS((r) => r.fr$), nCap = ar.filter((r) => r.capped).length;
  const wps = 7.84, scale = (v, n = ar.length) => v / n * 4 * wps * 21;
  const doobA = C.mean(ar.map((r) => Math.min(1, r.mid / (2 * r.credit))));
  console.log(`\nARCHIVE (R116, ${ar.length} wings, ${aAll.n} sessions, per CONTRACT; the 2x cap as that replay recorded it; crossing = the borrowed entry crossing):`);
  console.log(`   capped ${nCap} (${f(100 * nCap / ar.length, 1)}%; Doob max ${f(100 * doobA, 1)}%)   cap vs hold ${$(aAll.sum)} (t ${f(aAll.t)})  =  PATH ${$(aP.sum)} (t ${f(aP.t)})  +  crossing and fee ${$(aX.sum)}   [max split err ${Math.max(0, ...ar.map((r) => r.err || 0)).toFixed(3)}]`);
  console.log(`   at 4 contracts, ${wps} wings a session, 21 sessions: total ${$(scale(aAll.sum))}/month = path ${$(scale(aP.sum))} + friction ${$(scale(aX.sum))}`);
  out.archive = { wings: ar.length, sessions: aAll.n, capped: nCap, doobMax: doobA, vsHold: aAll, path: aP, friction: aX, perMonth4ct: { total: scale(aAll.sum), path: scale(aP.sum), friction: scale(aX.sum) }, byYear: {} };
  for (const y of [...new Set(ar.map((r) => r.day.slice(0, 4)))].sort()) {
    const R = ar.filter((r) => r.day.startsWith(y)), p = aS((r) => r.path$, R), a = aS((r) => r.d, R);
    console.log(`   ${y}: ${R.length} wings, ${p.n} sessions, capped ${R.filter((r) => r.capped).length}; cap vs hold ${$(a.sum)} (t ${f(a.t)}); PATH ${$(p.sum)} (t ${f(p.t)}), ${$(scale(p.sum, R.length))}/month at 4 contracts`);
    out.archive.byYear[y] = { wings: R.length, sessions: p.n, vsHold: a, path: p };
  }
}

(async () => {
  const rows = await build();
  const out = report(rows);
  archive(out);
  console.log("\nwrote " + C.writeOut("skeptic-options-stop-decomp.json", out));
})().catch((e) => { console.error("FAILED: " + e.stack); process.exitCode = 1; });
