"use strict";
/** PROFIT FIXES B — preload for harness children that must stay offline: any fetch is a loud error. Never loaded by a live runner. */
globalThis.fetch = async (url) => { throw new Error(`NETWORK BLOCKED in the offline harness: ${String(url).split("?")[0]}`); };
