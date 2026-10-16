"use strict";
/**
 * OP11 selftest — one deterministic synthetic option market, shared by the preload and the stubs.
 *   spot(sym)            the stock print (100 for every name: the R21 width/loss gates are relative to it)
 *   legs(sym, lo, hi)    a weekly chain in the 5-12 DTE window (the first Friday in [lo, hi]): puts 90-100, calls 100-110, $1 strikes,
 *                        |delta| = 0.5 exp(-|K-100|/4) (short = 97P / 103C at 0.236, long = 96P / 104C), mids scaled per name so the
 *                        OP4a credit/risk ranking is not a tie, $0.04-wide two-sided quotes (inside the leg filter, ~12-19% cross cost)
 *   quote(occ)           the same leg's bid/ask (wing marks, twins)
 *   settleClose(sym)     the expiry close: 96..104 by name, so some wings breach and some expire worthless
 */
const h = (s) => { let x = 7; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) % 9973; return x; };
const r2 = (x) => Math.round(x * 100) / 100;
const spot = () => 100;
const mult = (sym, right) => 1 + (h(sym + right) % 7) / 10;
function legPrice(sym, right, K) {
  const dist = right === "P" ? 100 - K : K - 100;
  const mid0 = 2 * mult(sym, right) * Math.exp(-dist / 3);
  const bid = r2(Math.max(0.01, mid0 - 0.02)), ask = r2(mid0 + 0.02);
  return { bid, ask, mid: (bid + ask) / 2, delta: (right === "P" ? -1 : 1) * 0.5 * Math.exp(-dist / 4) };
}
const occ = (sym, exp, right, K) => `${sym}${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${right}${String(Math.round(K * 1000)).padStart(8, "0")}`;
function firstFriday(lo, hi) {
  for (let d = new Date(lo + "T12:00:00Z"), i = 0; i < 14; i++, d = new Date(d.getTime() + 864e5)) { const s = d.toISOString().slice(0, 10); if (s > hi) break; if (d.getUTCDay() === 5) return s; }
  return lo;
}
function legs(sym, lo, hi) {
  const exp = firstFriday(lo, hi), out = [];
  for (let K = 90; K <= 100; K++) { const p = legPrice(sym, "P", K); out.push({ occ: occ(sym, exp, "P", K), exp, right: "P", strike: K, bid: p.bid, ask: p.ask, mid: p.mid, delta: p.delta, iv: 0.3 }); }
  for (let K = 100; K <= 110; K++) { const p = legPrice(sym, "C", K); out.push({ occ: occ(sym, exp, "C", K), exp, right: "C", strike: K, bid: p.bid, ask: p.ask, mid: p.mid, delta: p.delta, iv: 0.3 }); }
  return out;
}
function quote(o) {
  const m = /^([A-Z.]{1,6})(\d{6})([CP])(\d{8})$/.exec(String(o)); if (!m) return null;
  const p = legPrice(m[1], m[3], Number(m[4]) / 1000); return { bid: p.bid, ask: p.ask, at: new Date().toISOString() };
}
const settleClose = (sym) => 100 + ((h(sym + "S") % 9) - 4);
module.exports = { spot, legs, quote, settleClose, occ, firstFriday };
