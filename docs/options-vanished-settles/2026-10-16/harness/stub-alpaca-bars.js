"use strict";
/**
 * SELFTEST STUB for backend/lib/alpaca-bars.js inside a scratch tree (options-vanished-settles 2026-10-16). It makes NO network call of
 * any kind — the closes come from the fixture named by OVS_BARS, a JSON file:
 *   { "reg": { SYM: { "YYYY-MM-DD": close } },        answered when the caller names no feed (the settle's own wing / debit calls)
 *     "sip": { SYM: { "YYYY-MM-DD": close } },        answered for feed "sip" (fix 4.7's recording call)
 *     "failFor": [SYM, ...],                          a call that names no feed and asks for one of these throws
 *     "sipFail": "message" }                          the "sip" call throws this
 *
 * IT KEEPS THE REAL LIBRARY'S CONTRACT WHERE THIS SETTLE DEPENDS ON IT (the same points the 2026-10-12 package's stub keeps):
 *   · start and end are required — a call without them throws, and nothing is asked;
 *   · a call for no symbol returns no bars and asks nothing;
 *   · only bars inside [start, end] by date come back;
 *   · requireAll defaults to TRUE: one requested symbol with no bar throws, and that call's other symbols get nothing.
 * Every call is appended to <tree>/bars-calls.jsonl so a check can read exactly what was asked (and that nothing was).
 */
const fs = require("fs"), path = require("path");
class AlpacaCoverageError extends Error {}
class AlpacaFetchError extends Error {}
const FX = (() => { try { return JSON.parse(fs.readFileSync(process.env.OVS_BARS, "utf8")); } catch { return {}; } })();

async function fetchBars(syms, opts = {}) {
  const asked = [...new Set([].concat(syms || []).filter(Boolean))];
  try { fs.appendFileSync(path.join(process.env.OVS_TREE, "bars-calls.jsonl"), JSON.stringify({ syms: asked, feed: opts.feed || "(default)", adjustment: opts.adjustment || "(default)", start: opts.start ?? null, end: opts.end ?? null, requireAll: opts.requireAll ?? null }) + "\n"); } catch { /* none */ }
  if (!opts.start || !opts.end) throw new AlpacaFetchError("fetchBars requires { start, end }");
  if (!asked.length) return { bars: {} };
  if (opts.feed === "sip" && FX.sipFail) throw new AlpacaFetchError(FX.sipFail);
  if (opts.feed !== "sip" && Array.isArray(FX.failFor) && asked.some((s) => FX.failFor.includes(s))) throw new AlpacaFetchError(FX.failMsg || "Alpaca 500 after 4 retries");
  const table = (opts.feed === "sip" ? FX.sip : FX.reg) || {}, bars = {}, from = String(opts.start).slice(0, 10), to = String(opts.end).slice(0, 10);
  for (const s of asked) {
    const d = table[s]; if (!d) continue;
    const days = Object.keys(d).sort().filter((day) => day >= from && day <= to);
    if (days.length) bars[s] = days.map((day) => ({ t: day + "T04:00:00Z", o: d[day], h: d[day], l: d[day], c: d[day], v: 1000 }));
  }
  if (opts.requireAll !== false) {
    const missing = asked.filter((s) => !bars[s] || !bars[s].length);
    if (missing.length) throw new AlpacaCoverageError(`Alpaca returned no bars for ${missing.length} required symbol(s): ${missing.join(", ")}`);
  }
  return { bars };
}
module.exports = { fetchBars, fetchBarsWithBenchmark: fetchBars, AlpacaCoverageError, AlpacaFetchError };
