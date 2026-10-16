"use strict";
/**
 * SELFTEST FIXTURE MODEL (profit fixes A). Pure functions shared by the preload and the two library stubs: a deterministic toy option
 * market. No network, no clock, no file but the fixture named in PFA_FIXTURE. Nothing here is evidence of anything.
 *
 *   price(sym)                 the underlying's last trade: the fixture's own figure, else a number made from the symbol's letters
 *   legs(sym, exp)             six strikes each side of the price, one point apart; the 25-delta strike is the third out, quoted
 *                              0.49 / 0.51, the next strike out (0.18 delta) 0.35 / 0.37 — so a short vertical at the cross is a
 *                              0.12 credit on a 1-point wing (mid 0.14), which clears every gate of both sleeves
 */
const fs = require("fs");
const FX = (() => { try { return JSON.parse(fs.readFileSync(process.env.PFA_FIXTURE, "utf8")); } catch { return {}; } })();
const price = (sym) => {
  const s = (FX.spots || {})[sym]; if (Number.isFinite(s)) return s;
  let h = 0; for (const ch of String(sym)) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return +(60 + (h % 400) + 0.37).toFixed(2);
};
const occOf = (sym, exp, right, strike) => `${sym}${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${right}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
const DELTAS = [0.40, 0.33, 0.25, 0.18, 0.12, 0.08];
function legs(sym, exp) {
  const c = Math.round(price(sym)), out = [];
  DELTAS.forEach((d, i) => {
    for (const [right, strike, delta] of [["P", c - (i + 1), -d], ["C", c + (i + 1), d]]) {
      const mid = +(d * 2).toFixed(2);
      out.push({ occ: occOf(sym, exp, right, strike), exp, right, strike, bid: +(mid - 0.01).toFixed(2), ask: +(mid + 0.01).toFixed(2), mid, delta, iv: 0.3 });
    }
  });
  return out;
}
module.exports = { FX, price, occOf, legs, DELTAS };
