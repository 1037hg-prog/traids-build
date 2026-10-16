"use strict";
/**
 * r25-twins selftest FIXTURE MARKET — a deterministic same-day option chain per underlying, in the shape Schwab's
 * /marketdata/v1/chains returns (putExpDateMap / callExpDateMap -> "<date>:0" -> "<strike>" -> [contract]). No network, no secrets.
 * |delta| decays with distance from spot in units of 0.3% of spot; mid follows; legs are a cent wide; far legs go bid-less (filtered out
 * by the sleeve, as in a real 0DTE book). DIA returns an empty chain (the sleeve's "no two-sided 0DTE quotes" skip).
 */
const SPOT = { SPY: 773.1, QQQ: 752.3, IWM: 280.4, DIA: 460.2, GLD: 379.6, TLT: 78.9 };
const STEP = { SPY: 1, QQQ: 1, IWM: 1, DIA: 1, GLD: 1, TLT: 0.5 };
const r2 = (x) => Math.round(x * 100) / 100;
function contract(sym, day, right, k) {
  const S = SPOT[sym], unit = S * 0.003, x = right === "P" ? (S - k) / unit : (k - S) / unit;   // > 0 out of the money
  const absDelta = x >= 0 ? 0.5 * Math.exp(-0.9 * x) : 1 - 0.5 * Math.exp(0.9 * x);
  const mid = x >= 0 ? unit * 0.4 * Math.exp(-1.1 * x) : (right === "P" ? k - S : S - k) + unit * 0.4;
  const bid = r2(Math.max(0, mid - 0.005)), ask = r2(Math.max(0.01, mid + 0.005));
  const occ = `${sym.padEnd(6)}${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}${right}${String(Math.round(k * 1000)).padStart(8, "0")}`;
  return { symbol: occ, bid, ask, delta: +(right === "P" ? -absDelta : absDelta).toFixed(4), volatility: 16.5, strikePrice: k };
}
function chainJson(sym, day) {
  if (sym === "DIA" || !SPOT[sym]) return { putExpDateMap: {}, callExpDateMap: {} };
  const S = SPOT[sym], st = STEP[sym], put = {}, call = {};
  const lo = Math.floor((S * 0.97) / st) * st, hi = Math.ceil((S * 1.03) / st) * st;
  for (let k = lo; k <= hi + 1e-9; k = Math.round((k + st) * 100) / 100) {
    const key = k.toFixed(1);
    put[key] = [contract(sym, day, "P", k)];
    call[key] = [contract(sym, day, "C", k)];
  }
  return { putExpDateMap: { [`${day}:0`]: put }, callExpDateMap: { [`${day}:0`]: call } };
}
module.exports = { SPOT, chainJson, contract };
