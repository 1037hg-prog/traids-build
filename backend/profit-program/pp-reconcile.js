"use strict";
/**
 * PROFIT PROGRAM / the one way these printers read the board: lib/reconcile.js cleanEraLedger() after a REAL assertReconciled().
 * assertReconciled(quantity, computed, expected) compares a value an analysis computed against the canonical one; calling it with no arguments
 * compares undefined with undefined and always passes (a vacuous check, which an earlier draft of these printers did by mistake). Here it is given
 * three real comparisons - the signal count, the signal mean R and the control mean R, each recomputed from the rows and held against the canonical
 * summary fields (the canonical means are rounded to 4 decimals, so the recomputed means are rounded the same way). A mismatch throws.
 */
const rc = require("../lib/reconcile.js");
function loadLedger() {
  const L = rc.cleanEraLedger();
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  rc.assertReconciled("signal count", L.signals.length, L.n, { log: false });
  rc.assertReconciled("signal mean R (4dp)", +mean(L.signals.map((t) => t.rMult)).toFixed(4), L.meanR, { log: false, tolerance: 1e-9 });
  rc.assertReconciled("control mean R (4dp)", +mean(L.controls.map((t) => t.rMult)).toFixed(4), L.controlMeanR, { log: false, tolerance: 1e-9 });
  console.log(`  RECONCILED  canonical ledger ${L.source}, epoch ${L.epoch}: ${L.signals.length} signals at ${L.meanR}R, ${L.controls.length} controls at ${L.controlMeanR}R (recomputed from the rows)`);
  return L;
}
module.exports = { loadLedger };
