"use strict";
/**
 * PROFIT FIXES B — preload for the offline harness (node -r harness/preload.cjs <temp copy of a runner>). Reads the scenario named by
 * PFB_SCENARIO and, before the runner's first line: fixes the clock, replaces `fetch` by the package's API emulators (Coinbase candles and
 * the Alpaca calendar on the frozen inputs; anything else throws "NETWORK BLOCKED"), serves the recorded bars to the stub alpaca-bars.js,
 * and lets the runner's own sleeps pass at once: the 350 ms politeness pause and the two retry back-offs (2,000 and 5,000 ms). Each such sleep is RECORDED as asked.
 * It is never loaded by a live runner.
 *
 * Request timeouts: every AbortSignal.timeout(ms) the runner asks for is RECORDED as asked, and served scaled by scenario.timeoutScale
 * (default 1 = unchanged), so a request the emulator never answers is ended by the runner's OWN timeout within milliseconds. A runner that
 * passes no timeout is ended by the watchdog instead (scenario.watchdogMs, exit 97) — never by luck. On exit the child writes what it
 * asked for (scenario.callsFile): every request to the two emulators, with whether it carried a signal, every timeout in milliseconds, and every sleep.
 */
const fs = require("fs");
const S = JSON.parse(fs.readFileSync(process.env.PFB_SCENARIO, "utf8"));
const L = require(S.lib), fix = JSON.parse(fs.readFileSync(S.fixture, "utf8"));
const cb = L.coinbaseServer(L.cryptoUpTo(fix, L.iso(S.nowMs)), S.coinbaseFault || {}), cal = L.calendarServer(L.sessionsByMonth(fix), S.calendarFault || {});
globalThis.fetch = L.makeFetch({ coinbase: cb, calendar: cal });
globalThis.__PFB = { fetchBars: async () => { if (S.barsError) throw new Error(S.barsError); return { bars: L.barsOf(fix, S.asOf), truncatedStart: [] }; } };   // barsError: the bar fetch fails with that message
const realSetTimeout = globalThis.setTimeout, FAST = new Set([350, 2000, 5000]), sleeps = [];
globalThis.setTimeout = (f, ms, ...a) => { if (!FAST.has(ms)) return realSetTimeout(f, ms, ...a); sleeps.push(ms); return realSetTimeout(f, 0, ...a); };
const RealAbortSignal = globalThis.AbortSignal, timeouts = [], scale = S.timeoutScale > 0 ? S.timeoutScale : 1;
globalThis.AbortSignal = new Proxy(RealAbortSignal, { get: (t, k) => (k === "timeout" ? (ms) => { timeouts.push(ms); return t.timeout(Math.max(1, Math.round(ms * scale))); } : Reflect.get(t, k)) });
if (S.watchdogMs > 0) realSetTimeout(() => { process.stdout.write(`HARNESS WATCHDOG: still waiting after ${S.watchdogMs} ms - a request never answered and no timeout ended it\n`); process.exit(97); }, S.watchdogMs).unref();
if (S.callsFile) process.on("exit", () => { try { fs.writeFileSync(S.callsFile, JSON.stringify({ coinbase: cb.calls, calendar: cal.calls, timeouts, sleeps })); } catch {} });
globalThis.Date = L.fakeDate(S.nowMs);
