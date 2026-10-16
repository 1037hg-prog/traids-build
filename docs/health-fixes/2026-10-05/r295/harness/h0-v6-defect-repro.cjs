#!/usr/bin/env node
// R295-V7 H0: reproduce the 10-05 defect with v6's OWN syncOne logic, copied out of the live file's text (the runner is never require()d
// or run) and driven by a mocked broker holding today's NU / CVE / UMC orders exactly as the 3 s list returned them after the leg filled.
// Expected: v6 sends a second exit for each (NU: STOP1 refused as through the price -> XSTOP market sell 284; CVE: same, buy 150;
// UMC: STOP1 buy 153 accepted, which then fired). The staged v7 gives none — see its --selftest ("v7 10-05 NU/CVE/UMC").
"use strict";
const fs = require("fs"), path = require("path");
const V6 = process.argv[2] || path.resolve(__dirname, "..", "..", "..", "..", "..", "backend", "r295-orb-forward.js");
const src = fs.readFileSync(V6, "utf8"), a = src.indexOf('  const LIVE_LEG = ["new"'), b = src.indexOf("  const syncStops = async");
if (a < 0 || b < a) throw new Error("v6 syncOne block not found (is the live file still v6?)");
const make = new Function("byId", "cancel", "submit", "S", "cidOf", "date", src.slice(a, b) + "\nreturn syncOne;");
const cidOf = (date, sym, kind) => `r295-${sym}-${date.replace(/-/g, "")}-${kind}`;
let fails = 0;
(async () => {
for (const [sym, dir, q, avg, legPx, stop, through] of [["NU", 1, 284, 15.32, 15.26, 15.27, true], ["CVE", -1, 150, 31.3118, 31.420667, 31.37, true], ["UMC", -1, 153, 23.76, 23.83, 23.83, false]]) {
  const leg = { id: `leg-${sym}`, symbol: sym, side: dir > 0 ? "sell" : "buy", type: "stop", qty: String(q), stop_price: String(stop), status: "filled", filled_qty: String(q), filled_avg_price: String(legPx) };
  const entry = { id: `e-${sym}`, client_order_id: cidOf("2026-10-05", sym, dir > 0 ? "L" : "S"), symbol: sym, side: dir > 0 ? "buy" : "sell", qty: String(q), status: "filled", filled_qty: String(q), filled_avg_price: String(avg), legs: [leg] };
  const posts = [], S = { notes: [] };
  const submit = async (o) => { posts.push(o); if (through && o.type === "stop") { const e = new Error("alpaca 422 /v2/orders: stop price must be below the current price"); e.status = 422; throw e; } return { id: "x" + posts.length, status: "accepted" }; };
  const syncOne = make(async (id) => (id === entry.id ? entry : id === leg.id ? leg : null), async () => {}, submit, S, cidOf, "2026-10-05");
  const p = { sym, dir, qty: q, stopDist: 0.06, legStopPx: stop, entryId: entry.id, stopIds: [leg.id] };
  await syncOne(p, entry);
  const second = posts.map((o) => `${o.client_order_id} ${o.side} ${o.type} ${o.qty}`);
  const reproduced = posts.length > 0 && posts.every((o) => o.qty === String(q) && o.side === leg.side);
  if (!reproduced) fails++;
  console.log(`${reproduced ? "REPRODUCED" : "NOT reproduced"}  v6 ${sym}: leg already FILLED ${q} @ ${legPx}, yet v6 sent: ${second.join(" ; ") || "(nothing)"}`);
}
console.log(fails ? "H0: the v6 defect did NOT reproduce for every lot" : "H0: v6 defect reproduced for NU, CVE and UMC (a second exit for the whole lot on top of a filled leg)");
process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error("H0 error:", e.message); process.exitCode = 1; });
