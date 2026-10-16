#!/usr/bin/env node
"use strict";
/** ATTACK 1, step 2. READ-ONLY. The noise floor of the GRADED statistic under the mirror's own data shape.
 *  Session sums X_s of k band tickets (k drawn from the preview's band sessions), each ticket a CENTRED resample (zero edge,
 *  zero cost), then t_loss = -t over n sessions. Prints the one-sided size at the single-variant, six-variant and drafted bars,
 *  and the quantile the drafted bar stands for (the 1 - 0.95^(1/11) tail of ONE t), against lib/null-bar.js's uniform draw.
 *  Models: (A) per-dollar returns of all 78 closed mirrored tickets x a band notional; (B) current-era broker dollars as recorded.
 *    node docs/wide-spread-twin/2026-10-14/attack-1-sims/2-null-size.cjs [trials=100000]                                      */
const fs = require("fs"), path = require("path");
const { mulberry, tOf } = require("./_root.cjs");
const H = JSON.parse(fs.readFileSync(path.join(__dirname, "holds.json"), "utf8"));
const TR = +process.argv[2] || 100000, rng = mulberry(777), pick = (a) => a[Math.floor(rng() * a.length)];
const ret = H.map((h) => h.pnl / h.notional), mret = ret.reduce((a, b) => a + b, 0) / ret.length, cret = ret.map((r) => r - mret);
const usd = H.filter((h) => h.era === "current").map((h) => h.pnl), mu = usd.reduce((a, b) => a + b, 0) / usd.length, cusd = usd.map((x) => x - mu);
const bandNot = H.filter((h) => h.b === "30-100").map((h) => h.notional), K = [2, 3, 4, 1, 3, 2];
const sess = (model) => { const k = pick(K); let s = 0; for (let i = 0; i < k; i++) s += model === "A" ? pick(cret) * pick(bandNot) : pick(cusd); return s; };
const tail = 1 - Math.pow(0.95, 1 / 11);
for (const [model, lab] of [["A", "(A) per-dollar x band notional"], ["B", "(B) current-era dollars as recorded"]]) for (const n of [60, 100]) {
  const ts = new Float64Array(TR); for (let t = 0; t < TR; t++) { const x = new Array(n); for (let i = 0; i < n; i++) x[i] = sess(model); ts[t] = -tOf(x); }
  const s = Float64Array.from(ts).sort(), P = (b) => (100 * ts.filter((v) => v >= b).length / TR).toFixed(2), Q = (p) => s[Math.floor(p * TR)].toFixed(3);
  console.log(`${lab}, n ${n}: size at 1.657 ${P(1.657)}% (nominal 5) | at 2.468 ${P(2.468)}% | at 2.708 ${P(2.708)}% (nominal ${(100 * tail).toFixed(2)}) | p95 of one t ${Q(0.95)} | the ${(100 * tail).toFixed(3)}% tail of one t ${Q(1 - tail)} (null-bar's uniform draw gives 2.708 for it)`);
}
