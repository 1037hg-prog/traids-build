"use strict";
/**
 * NO-NETWORK (insider clusters package, 2026-10-16) — every fetch and every socket of the process it is loaded into is refused.
 * selftest.cjs loads it as its FIRST require, so that even a mistake in the code under test could not reach sec.gov: the fixture
 * fetcher is the only thing that answers, and it reads saved files.
 */
const refuse = (what) => () => { throw new Error(`insider-clusters selftest: network refused (${what})`); };
globalThis.fetch = async (url) => { throw new Error(`insider-clusters selftest: network refused (fetch ${String(url).slice(0, 80)})`); };
for (const [mod, fns] of [["http", ["request", "get"]], ["https", ["request", "get"]], ["net", ["connect", "createConnection"]], ["tls", ["connect"]], ["dgram", ["createSocket"]]]) {
  const m = require(mod);
  for (const f of fns) m[f] = refuse(`${mod}.${f}`);
}
