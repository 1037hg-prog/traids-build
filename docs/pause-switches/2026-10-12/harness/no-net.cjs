"use strict";
/**
 * NO-NETWORK PRELOAD (pause-switches package, 2026-10-12): every fetch and every socket of the process it is loaded into is refused.
 * verify-live.cjs loads it into the one run of the live R231 runner it makes, in that runner's own sandbox (R231_STATE_DIR: a copy of the
 * state, no broker call; R231_BARS_FILE: a bars fixture instead of Coinbase) — so that run could not reach anything even if a guard failed.
 */
const refuse = (what) => () => { throw new Error(`pause-switches verify: network refused (${what})`); };
globalThis.fetch = async (url) => { throw new Error(`pause-switches verify: network refused (fetch ${String(url).slice(0, 60)})`); };
for (const [mod, fns] of [["http", ["request", "get"]], ["https", ["request", "get"]], ["net", ["connect", "createConnection"]], ["tls", ["connect"]], ["dgram", ["createSocket"]]]) { const m = require(mod); for (const f of fns) m[f] = refuse(`${mod}.${f}`); }
