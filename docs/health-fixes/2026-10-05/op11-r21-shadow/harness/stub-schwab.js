"use strict";
/** OP11 selftest STUB for backend/lib/schwab.js inside a sandbox — the fixture market, no network, no token, no secrets. */
const path = require("path");
const M = require(process.env.OP11_FIXTURE_MODEL || path.join(__dirname, "..", "..", "fixture-model.cjs"));
async function token() { throw new Error("stub: no token in the selftest sandbox"); }
async function chain(sym, fromDate, toDate) { return M.legs(sym, fromDate, toDate); }
async function quotesByOcc(occList) { const out = {}; for (const o of occList || []) { const q = M.quote(o); if (q) out[o] = q; } return out; }
async function quotesBySymbol() { return {}; }
module.exports = { token, chain, quotesByOcc, quotesBySymbol };
