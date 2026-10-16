"use strict";
/** SELFTEST STUB for backend/lib/schwab.js inside a sandbox (profit fixes A): the fixture market, no network, no token, no secret. */
const path = require("path");
const M = require(path.join(process.env.PFA_HARNESS, "model.cjs"));
async function token() { throw new Error("stub: no token in the selftest sandbox"); }
async function chain(sym, fromDate) { return M.legs(sym, fromDate); }
async function quotesByOcc(occList) { const Q = M.FX.occQuotes || {}, out = {}; for (const o of occList || []) if (Q[o]) out[o] = { ...Q[o] }; return out; }
async function quotesBySymbol() { return {}; }
module.exports = { token, chain, quotesByOcc, quotesBySymbol };
