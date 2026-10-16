#!/usr/bin/env node
"use strict";
/**
 * SKEPTIC (options-premium lane): what does R25 earn if the fee and then the crossing are taken away, and how many sessions would it
 * take to tell? Read-only, exploratory. Three layers per contract-wing (the same layers as options-premium-pricing.js):
 *    net = the ledger pnl;  zero fee = (cross credit - intrinsic) x 100;  zero fee and zero crossing = (mid credit - intrinsic) x 100
 * scaled to 4 contracts x 7.84 wings a session x 21 sessions. "sessions to t 2" = n x (2 / t)^2 at the same mean and spread:
 * how long the same result would have to keep arriving before it clears a bar of 2. Live 4-contract era beside the 501-session archive.
 *   node backend/profit-program/skeptic-options-zero-fee.js
 * Writes backend/data/profit-program/skeptic-options-zero-fee.json
 */
const fs = require("fs"), path = require("path");
const C = require("./_opt-common.js");
const { $, f } = C;
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const WPS = 7.84, SCALE = 4 * WPS * 21;
const L = C.ledger(), out = { label: "SKEPTIC, exploratory", scale: "4 contracts x 7.84 wings x 21 sessions" };
const live = L.signals.filter((t) => C.isR25(t) && C.etDay(t.openedAt) >= "2026-09-14" && (t.contracts || 1) === 4).map((t) => {
  const o = t.obs, K = +o.shortK, W = o.width, intr = o.optCall ? clamp(o.settleUnder - K, 0, W) : clamp(K - o.settleUnder, 0, W);
  return { day: C.etDay(t.openedAt), sym: t.sym, net: t.pnl / 4, zeroFee: (t.entry - intr) * 100, zeroBoth: (o.creditMid - intr) * 100, cross: o.creditMid - o.creditCross };
});
const arch = JSON.parse(fs.readFileSync(path.join(C.DATA, "r116-zero-dte-replay-wings.json"), "utf8")).map((w) => {
  const intr = w.right === "C" ? clamp(w.settle - w.shortStrike, 0, w.width) : clamp(w.shortStrike - w.settle, 0, w.width);
  return { day: w.day, sym: w.u, net: w.pnl, zeroFee: (w.creditCross - intr) * 100, zeroBoth: (w.credit - intr) * 100 };
});
function block(label, R) {
  const n = new Set(R.map((r) => r.day)).size;
  console.log(`\n${label}: ${R.length} wings, ${n} sessions`);
  out[label] = {};
  for (const [lab, key] of [["net (as booked)", "net"], ["zero fee", "zeroFee"], ["zero fee and zero crossing", "zeroBoth"]]) {
    const s = C.bySession(R, (r) => r[key], (r) => r.day), per = C.mean(R.map((r) => r[key])), need = s.t > 0 ? Math.ceil(n * (2 / s.t) ** 2) : null;
    console.log(`   ${lab.padEnd(28)} ${(per >= 0 ? "+" : "-") + "$" + Math.abs(per).toFixed(2)} a contract-wing  =  ${$(per * SCALE).padStart(7)}/month   session t ${f(s.t).padStart(5)}   sessions to t 2 at this mean and spread: ${need == null ? "never (the mean is not positive)" : need + " (" + f(need / 21, 0) + " months)"}`);
    out[label][key] = { perContractWing: per, perMonth: per * SCALE, t: s.t, sessions: n, sessionsToT2: need };
  }
}
console.log("R25: what is left when the fee, then the crossing, is removed (per month at 4 contracts, 7.84 wings a session, 21 sessions)");
block("LIVE, 4-contract era (09-14 on)", live);
block("ARCHIVE, all six underlyings (2024-08-19..2026-08-18)", arch);
block("ARCHIVE, last 12 full months (2025-07..2026-06)", arch.filter((r) => r.day >= "2025-07-01" && r.day <= "2026-06-30"));
console.log("\ncrossing a share by underlying, live 4-contract era (min / median / max):");
out.crossing = {};
for (const s of [...new Set(live.map((r) => r.sym))].sort()) {
  const c = live.filter((r) => r.sym === s).map((r) => r.cross).sort((a, b) => a - b);
  console.log(`   ${s.padEnd(4)} ${String(c.length).padStart(3)} wings  $${c[0].toFixed(4)} / $${c[Math.floor(c.length / 2)].toFixed(4)} / $${c[c.length - 1].toFixed(4)}`);
  out.crossing[s] = { wings: c.length, min: c[0], median: c[Math.floor(c.length / 2)], max: c[c.length - 1] };
}
console.log("\nwrote " + C.writeOut("skeptic-options-zero-fee.json", out));
