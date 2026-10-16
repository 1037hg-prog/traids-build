"use strict";
/**
 * NO-NETWORK PRELOAD (r231-sell-repair package, 2026-10-12): every fetch and every socket of the process it is loaded into is refused.
 * verify-live.cjs and restate.cjs's --rows form load it into the runs they make of the R231 runner in that runner's own sandbox
 * (R231_STATE_DIR: a copy of the state, no broker call; R231_BARS_FILE: a bars fixture instead of Coinbase; R231_POSITIONS_FILE: a positions
 * fixture instead of the account) — so such a run could not reach anything even if a guard failed.
 */
const refuse = (what) => () => { throw new Error(`r231-sell-repair: network refused (${what})`); };
globalThis.fetch = async (url) => { throw new Error(`r231-sell-repair: network refused (fetch ${String(url).slice(0, 60)})`); };
for (const [mod, fns] of [["http", ["request", "get"]], ["https", ["request", "get"]], ["net", ["connect", "createConnection"]], ["tls", ["connect"]], ["dgram", ["createSocket"]]]) { const m = require(mod); for (const f of fns) m[f] = refuse(`${mod}.${f}`); }
