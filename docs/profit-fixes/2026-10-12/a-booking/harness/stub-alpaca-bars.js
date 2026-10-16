"use strict";
/**
 * SELFTEST STUB for backend/lib/alpaca-bars.js inside a sandbox (profit fixes A). Daily closes come from the fixture, by feed:
 *   bars.reg  { SYM: { "YYYY-MM-DD": close } }   answered when the caller names no feed (the settle's own calls)
 *   bars.sip  { SYM: { "YYYY-MM-DD": close } }   answered for feed "sip" (the official close, recorded beside by fix 4.7)
 *   bars.sipFail  a message: the "sip" call throws it (the recording must fail soft; the settle itself must not notice)
 *   bars.failFor  [SYM, ...]: a call that names no feed and asks for one of these symbols throws (a request that fails outright)
 *   bars.sipHang  true: the "sip" endpoint HANGS (it never answers). The stub then does what the real library does with the CALLER'S OWN
 *                 retries and timeoutMs (its defaults are 4 and 60000): every attempt waits timeoutMs, a backoff of min(30000, 500 x 2^attempt)
 *                 follows each attempt but the last, and after the last it throws "Alpaca request failed after N retries: The operation
 *                 was aborted due to timeout". The wait is MODELLED, not slept, and written to <sandbox>/bars-hang.json. When it is longer
 *                 than bars.stepLimitMs (the close chain's limit for the step that runs the script) the process ends on the spot, exit
 *                 137, with nothing more written — what the chain's SIGKILL does to a step that is still waiting.
 *
 * IT KEEPS THE REAL LIBRARY'S CONTRACT WHERE THE SETTLE DEPENDS ON IT (backend/lib/alpaca-bars.js fetchBars):
 *   - start and end are required (a call without them throws);
 *   - a call for no symbol returns no bars and asks nothing;
 *   - only the bars inside [start, end] (by date) are returned;
 *   - requireAll defaults to TRUE: when any requested symbol returns no bar the call THROWS (AlpacaCoverageError, the library's own
 *     words) — so a symbol with no bar in a call that did not say requireAll: false costs every other symbol of that call its bar.
 * Every call's options are appended to <sandbox>/bars-calls.jsonl so a test can read what was asked.
 */
const fs = require("fs"), path = require("path");
const M = require(path.join(process.env.PFA_HARNESS, "model.cjs"));
class AlpacaCoverageError extends Error {} class AlpacaFetchError extends Error {}
async function fetchBars(syms, opts = {}) {
  const B = M.FX.bars || {}, feed = opts.feed || "(default)", asked = [...new Set([].concat(syms || []).filter(Boolean))];
  try { fs.appendFileSync(path.join(process.env.PFA_SANDBOX, "bars-calls.jsonl"), JSON.stringify({ syms: [].concat(syms || []), feed, adjustment: opts.adjustment || "(default)", start: opts.start, end: opts.end, requireAll: opts.requireAll, retries: opts.retries, timeoutMs: opts.timeoutMs }) + "\n"); } catch {}
  if (!opts.start || !opts.end) throw new AlpacaFetchError("fetchBars requires { start, end }");
  if (!asked.length) return { bars: {} };
  if (opts.feed === "sip" && B.sipFail) throw new AlpacaFetchError(B.sipFail);
  if (opts.feed === "sip" && B.sipHang) {
    // the real library's own arithmetic (getJson): attempts 0..retries, each timeoutMs long, a backoff after every attempt but the last
    const retries = opts.retries === undefined ? 4 : opts.retries, timeoutMs = opts.timeoutMs === undefined ? 60000 : opts.timeoutMs;
    let waitMs = 0; for (let a = 0; a <= retries; a++) { waitMs += timeoutMs; if (a < retries) waitMs += Math.min(30000, 500 * 2 ** a); }
    const killed = Number.isFinite(B.stepLimitMs) && waitMs > B.stepLimitMs;
    fs.writeFileSync(path.join(process.env.PFA_SANDBOX, "bars-hang.json"), JSON.stringify({ retries, timeoutMs, modelledWaitMs: waitMs, stepLimitMs: B.stepLimitMs ?? null, killed }));
    if (killed) process.exit(137);
    throw new AlpacaFetchError(`Alpaca request failed after ${retries} retries: The operation was aborted due to timeout`);
  }
  if (opts.feed !== "sip" && Array.isArray(B.failFor) && asked.some((s) => B.failFor.includes(s))) throw new AlpacaFetchError(B.failMsg || "Alpaca 500 after 4 retries");
  const table = opts.feed === "sip" ? B.sip || {} : B.reg || {}, bars = {}, from = String(opts.start).slice(0, 10), to = String(opts.end).slice(0, 10);
  for (const s of asked) { const d = table[s]; if (!d) continue; const days = Object.keys(d).sort().filter((day) => day >= from && day <= to); if (days.length) bars[s] = days.map((day) => ({ t: day + "T04:00:00Z", o: d[day], h: d[day], l: d[day], c: d[day], v: 1000 })); }
  if (opts.requireAll !== false) {
    const missing = asked.filter((s) => !bars[s] || !bars[s].length);
    if (missing.length) throw new AlpacaCoverageError(`Alpaca returned no bars for ${missing.length} required symbol(s): ${missing.slice(0, 12).join(", ")}`);
  }
  return { bars };
}
module.exports = { fetchBars, fetchBarsWithBenchmark: fetchBars, AlpacaCoverageError, AlpacaFetchError };
