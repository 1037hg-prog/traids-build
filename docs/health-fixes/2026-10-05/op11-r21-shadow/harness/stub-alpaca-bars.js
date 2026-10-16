"use strict";
/** OP11 selftest STUB for backend/lib/alpaca-bars.js inside a sandbox — one completed daily bar per calendar day per symbol, close from the fixture. */
const path = require("path");
const M = require(process.env.OP11_FIXTURE_MODEL || path.join(__dirname, "..", "..", "fixture-model.cjs"));
async function fetchBars(syms, opts = {}) {
  const bars = {};
  for (const s of [].concat(syms || [])) {
    bars[s] = [];
    for (let d = new Date(String(opts.start).slice(0, 10) + "T12:00:00Z"); d.toISOString().slice(0, 10) <= String(opts.end).slice(0, 10); d = new Date(d.getTime() + 864e5)) {
      const c = M.settleClose(s); bars[s].push({ t: d.toISOString().slice(0, 10) + "T04:00:00Z", o: c, h: c, l: c, c, v: 1000 });
    }
  }
  return { bars };
}
class AlpacaCoverageError extends Error {} class AlpacaFetchError extends Error {}
module.exports = { fetchBars, fetchBarsWithBenchmark: fetchBars, AlpacaCoverageError, AlpacaFetchError };
