#!/usr/bin/env node
"use strict";
/**
 * OPTIONS-LANE DEFECT AUDIT (read-only). Four findings, each with its count:
 *  1. spot is NULL on every wing both sleeves ever priced (zero-dte-sleeve.js and options-sleeve.js read `.snapshots` from Alpaca's
 *     /v2/stocks/snapshots answer, which is keyed by symbol at the top level) -> the "width <= 3% of spot" adjacent-wing gate never ran and
 *     optEntryUnder was never recorded. Shape verified by one market-data GET (keys, not values, are inspected; no secret is printed).
 *  2. What that gate would have done on R21: wings wider than 3% of the underlying (prior daily close as the spot proxy), their count and P&L.
 *  3. lib/options-cost.js charges an early exit the SAME crossing as the entry; the 19 live OP4b caps recorded the real one (obs.capCrossing).
 *  4. rows with no riskDollars (the earliest R25 and R21 tickets), which silently drop out of every risk-weighted average.
 *   node backend/profit-program/options-defects-audit.js
 * Writes backend/data/profit-program/options-defects-audit.json
 */
const fs = require("fs"), path = require("path");
const C = require("./_opt-common.js");
const B = require("./_opt-bars.js");
const { optionsCostR } = require("../lib/options-cost.js");
const { $, f } = C;
(async () => {
  const out = {};
  // 1
  const r25 = JSON.parse(fs.readFileSync(path.join(C.DATA, "zero-dte-sleeve.json"), "utf8")), r21 = JSON.parse(fs.readFileSync(path.join(C.DATA, "options-sleeve.json"), "utf8"));
  const cnt = (S) => { let n = 0, z = 0; for (const e of S.entries) for (const w of e.wings || []) { n++; if (w.spot == null) z++; } return [n, z]; };
  const [n25, z25] = cnt(r25), [n21, z21] = cnt(r21);
  console.log(`1. spot recorded on the sleeves' own stores: R25 ${n25 - z25} of ${n25} wings, R21 ${n21 - z21} of ${n21} wings (null on ${z25 + z21} of ${n25 + n21}); every position posted with optEntryUnder = null`);
  let shape = "not checked";
  try {
    const j = await B.getJson("https://data.alpaca.markets/v2/stocks/snapshots?symbols=SPY,QQQ&feed=iex");
    shape = { topLevelKeys: Object.keys(j).slice(0, 4), hasSnapshotsWrapper: "snapshots" in j, hasSymbolKeys: "SPY" in j };
  } catch (e) { shape = "GET failed: " + e.message; }
  console.log(`   Alpaca /v2/stocks/snapshots answer shape: ${JSON.stringify(shape)} -> the sleeves' (await r.json()).snapshots is undefined, spotOf() returns {}`);
  out.spotNull = { r25: [n25, z25], r21: [n21, z21], shape };
  // 2
  const L = C.ledger();
  const R21 = L.signals.filter(C.isR21);
  const syms = [...new Set(R21.map((t) => t.sym))], dly = {};
  for (const s of syms) { try { dly[s] = await B.stockDaily(s, "2026-07-20", "2026-10-09"); } catch { dly[s] = null; } }
  const priorClose = (s, d) => { const a = (dly[s] || []).filter((x) => x.d < d); return a.length ? a[a.length - 1].c : null; };
  const rows = R21.map((t) => { const d = C.etDay(t.openedAt), pc = priorClose(t.sym, d); return { id: t.id, sym: t.sym, day: d, w: t.obs.width, pc, pct: pc ? t.obs.width / pc : null, pnl: t.pnl, full: t.rMult <= -0.9 }; });
  const priced = rows.filter((r) => r.pct != null), wide = priced.filter((r) => r.pct > 0.03);
  console.log(`2. R21 wings the dead gate (width > 3% of spot; prior close as the spot proxy) would have refused: ${wide.length} of ${priced.length} priced wings (${f(100 * wide.length / priced.length, 1)}%), their P&L ${$(C.sum(wide.map((r) => r.pnl)))} vs the rest ${$(C.sum(priced.filter((r) => r.pct <= 0.03).map((r) => r.pnl)))}; full losses among them ${wide.filter((r) => r.full).length}`);
  const d = C.clusterDiff(priced, (r) => r.pct > 0.03, (r) => r.pnl, (r) => r.day);
  console.log(`   wide minus rest: ${$(d.diff)} per wing, session-clustered t ${f(d.t)} over ${d.clusters} sessions (one slice, exploratory; R21 new wings are shadows under OP11 so this is history, not a live dollar)`);
  const bySym = {}; for (const r of wide) (bySym[r.sym] ||= { n: 0, pnl: 0 }), bySym[r.sym].n++, bySym[r.sym].pnl += r.pnl;
  console.log("   by underlying: " + Object.entries(bySym).sort((a, b) => b[1].n - a[1].n).slice(0, 8).map(([k, v]) => `${k} ${v.n} (${$(v.pnl)})`).join(", "));
  out.widthGate = { priced: priced.length, wouldRefuse: wide.length, refusedPnl: C.sum(wide.map((r) => r.pnl)), restPnl: C.sum(priced.filter((r) => r.pct <= 0.03).map((r) => r.pnl)), diffPerWing: d.diff, t: d.t, clusters: d.clusters };
  // 3  (cost-to-close is capped at the width, as the live cap itself repairs it: 3 of the 19 were quoted ABOVE the width - MU 9.25 on a 5.00 wing, SOXL 3.05 on 1.00 - and obs.capCrossing keeps the raw gap)
  const caps = L.signals.filter((t) => t.reason === "wing-cap" && t.obs && Number.isFinite(t.obs.capDebit) && Number.isFinite(t.obs.capMid));
  const entryX = caps.map((t) => Math.max(0, t.obs.creditMid - t.obs.creditCross)), capX = caps.map((t) => Math.max(0, Math.min(t.obs.capDebit, t.obs.width) - t.obs.capMid));
  const mdl = caps.map((t) => t.obs.width - t.obs.creditMid), n = (t) => t.contracts || 1;
  const perR = (xs) => C.mean(xs.map((x, i) => x / mdl[i]));
  console.log(`3. EXIT CROSSING, assumed vs measured on the ${caps.length} live OP4b caps (cost-to-close capped at the width; ${caps.filter((t) => t.obs.capDebit > t.obs.width).length} were quoted above it): lib/options-cost.js charges an early exit the ENTRY crossing; the cap recorded the real mid and cross.`);
  console.log(`   per share: entry crossing mean $${f(C.mean(entryX), 4)}, exit crossing mean $${f(C.mean(capX), 4)} (${f(C.mean(capX) / C.mean(entryX), 2)}x); as a share of max defined loss (width - mid credit): entry ${f(100 * perR(entryX), 2)}%, exit ${f(100 * perR(capX), 2)}% -> the symmetric assumption under-states the exit leg by ${f(100 * (perR(capX) - perR(entryX)), 2)} points of max loss (${f(perR(capX) / perR(entryX), 2)}x). Dollars on these ${C.sum(caps.map(n))} contracts: $${f(C.sum(caps.map((t, i) => (capX[i] - entryX[i]) * 100 * n(t))), 2)} under-charged.`);
  const costRows = caps.map((t) => optionsCostR(t)).filter(Boolean);
  console.log(`   optionsCostR on these rows: exitCrossingMeasured=${[...new Set(costRows.map((c) => c.exitCrossingMeasured))].join("/")} (ASSUMED); mean costR ${f(C.mean(costRows.map((c) => c.costR)), 4)}R vs ${f(C.mean(caps.map((t, i) => (entryX[i] + capX[i] + 0.013) / mdl[i])), 4)}R if the measured exit crossing were used`);
  out.exitCrossing = { caps: caps.length, aboveWidth: caps.filter((t) => t.obs.capDebit > t.obs.width).length, entryMeanPerShare: C.mean(entryX), exitMeanPerShare: C.mean(capX), ratio: C.mean(capX) / C.mean(entryX), entryShareOfMaxLoss: perR(entryX), exitShareOfMaxLoss: perR(capX), underchargedDollars: C.sum(caps.map((t, i) => (capX[i] - entryX[i]) * 100 * n(t))) };
  // 4
  const optAll = L.signals.filter((t) => t.cls === "Options");
  const noRisk = optAll.filter((t) => !(t.riskDollars > 0));
  const by = {}; for (const t of noRisk) by[t.strategy] = (by[t.strategy] || 0) + 1;
  console.log(`4. Options tickets without riskDollars: ${noRisk.length} of ${optAll.length} ${JSON.stringify(by)} (they fall out of every risk-weighted average; sizeLabel still carries "max loss $N")`);
  out.noRiskDollars = { n: noRisk.length, of: optAll.length, by };
  console.log("\nwrote " + C.writeOut("options-defects-audit.json", out));
})().catch((e) => { console.error("FAILED: " + e.message); process.exitCode = 1; });
