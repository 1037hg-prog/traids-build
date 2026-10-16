#!/usr/bin/env node
"use strict";
/**
 * THE COST FAMILY for R25 and R21 (lib/options-cost.js optionsCostR, epoch 2 + the 2026-09-04 fee): six ratios on six denominators.
 * Only "all-in friction / maximum loss" is on the scale of equity costR and may be summed with it; the others answer other questions and
 * are NEVER added to a book total. Definitions (per share, same units as obs.width / obs.creditMid):
 *   entry crossing    = creditMid - creditCross (measured at the ticket, not modelled)
 *   exit crossing     = 0 at expiry (a spread settles, it does not trade); the module ASSUMES the entry value for an early close
 *   commission        = $0.013 a share ($0.65 x 2 legs / 100), charged once at open; the venue's real fee is not yet observed
 *   maximum loss      = width - creditMid (the module's denominator: mid-quoted, known at entry)
 *   net credit        = creditCross (what the ticket booked)       premium at risk = creditMid (the premium being sold, at the mid)
 *   node backend/profit-program/options-cost-family.js
 * Writes backend/data/profit-program/options-cost-family.json
 */
const C = require("./_opt-common.js");
const { optionsCostR } = require("../lib/options-cost.js");
const { $, f } = C;
const L = C.ledger();
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const out = {};
function family(label, T) {
  const rows = [];
  for (const t of T) {
    const c = optionsCostR(t); if (!c) continue;
    const o = t.obs, n = t.contracts || 1, W = o.width, mid = o.creditMid, cr = t.entry, x = c.entryCrossing, e = c.exitCrossing, fee = c.commissionPerShare;
    rows.push({ n, entryOverMax: x / c.maxDefinedLoss, exitOverMax: e / c.maxDefinedLoss, allInOverMax: (x + e + fee) / c.maxDefinedLoss, allInOverNet: (x + e + fee) / cr, pctWidth: (x + e + fee) / W, pctPremium: (x + e + fee) / mid,
      dollars: (x + e + fee) * 100 * n, exitMeasured: c.exitCrossingMeasured });
  }
  const m = (k) => C.mean(rows.map((r) => r[k])), md = (k) => q(rows.map((r) => r[k]), 0.5), p95 = (k) => q(rows.map((r) => r[k]), 0.95);
  const pc = (v) => (f(100 * v, 2) + "%").padStart(7);
  console.log(`${label.padEnd(30)} priced ${rows.length}/${T.length}  ${"mean".padStart(7)} ${"median".padStart(7)} ${"p95".padStart(7)}`);
  const lines = [["entry crossing / maximum loss", "entryOverMax"], ["exit crossing / maximum loss", "exitOverMax"], ["ALL-IN friction / maximum loss  (summable with equity costR)", "allInOverMax"], ["all-in friction / net credit (booked)", "allInOverNet"], ["all-in friction / spread width", "pctWidth"], ["all-in friction / premium at risk (mid credit)", "pctPremium"]];
  const res = {};
  for (const [name, k] of lines) { console.log(`   ${name.padEnd(62)} ${pc(m(k))} ${pc(md(k))} ${pc(p95(k))}`); res[k] = { mean: m(k), median: md(k), p95: p95(k) }; }
  const tot = C.sum(rows.map((r) => r.dollars)), exitMeasured = rows.filter((r) => r.exitMeasured).length;
  console.log(`   dollars: all-in friction ${$(-tot)} on ${rows.length} tickets (${$(-tot / rows.length)} a ticket); exit leg measured on ${exitMeasured}, assumed on ${rows.length - exitMeasured} (reason expiry = 0 by construction)\n`);
  return { priced: rows.length, of: T.length, ratios: res, dollars: tot };
}
console.log("OPTIONS COST FAMILY (ledger signals, in-hours; closed since the dates shown)\n");
const inH = (t) => C.inHours(t);
out.R25_since0925 = family("R25-0dte since 09-25", L.signals.filter((t) => C.isR25(t) && inH(t) && C.mtDay(t.closedAt) >= "2026-09-25"));
out.R21_since0925 = family("R21-premium since 09-25", L.signals.filter((t) => C.isR21(t) && inH(t) && C.mtDay(t.closedAt) >= "2026-09-25"));
out.R25_clean = family("R25-0dte since 07-20", L.signals.filter((t) => C.isR25(t) && inH(t)));
out.R21_clean = family("R21-premium since 07-20", L.signals.filter((t) => C.isR21(t) && inH(t)));
console.log("wrote " + C.writeOut("options-cost-family.json", out));
