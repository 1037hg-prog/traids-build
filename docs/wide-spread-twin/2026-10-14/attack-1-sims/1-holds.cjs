#!/usr/bin/env node
"use strict";
/** ATTACK 1 (skeptic 1, statistics), step 1. READ-ONLY on house files; writes only holds.json in this folder (lib/atomic-write.js).
 *  Joins the scout's 82 mirrored rows (scout/spread-buckets.out.json) to the canonical ledger for hold times, then prints:
 *  hold-time quantiles, the band tickets with entry -> exit day, same-symbol repeats, and the shape (skew, kurtosis) of the
 *  broker dollars and per-dollar returns of the closed current-era tickets.
 *    node docs/wide-spread-twin/2026-10-14/attack-1-sims/1-holds.cjs                                                      */
const path = require("path");
const { ROOT } = require("./_root.cjs");
const o = require(path.join(ROOT, "docs/wide-spread-twin/2026-10-14/scout/spread-buckets.out.json"));
const REC = require(path.join(ROOT, "backend/lib/reconcile.js"));
const { writeJsonAtomic } = require(path.join(ROOT, "backend/lib/atomic-write.js"));
const L = REC.cleanEraLedger(), canon = new Map([...L.signals, ...L.controls].map((t) => [t.id, t]));
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const holds = [];
for (const r of o.rows.filter((x) => x.closed)) { const c = canon.get(r.id); if (!c) continue; const op = Number(c.openedAt || c.addedAt), cl = Number(c.closedAt); holds.push({ r, op, cl, hd: (cl - op) / 864e5, cd: etDay(cl) }); }
const hs = [...holds].sort((a, b) => a.hd - b.hd), q = (p) => hs[Math.floor(p * (hs.length - 1))].hd.toFixed(2);
console.log(`closed mirrored rows joined to the canonical ledger: ${holds.length}; hold in days p10 ${q(0.1)} p50 ${q(0.5)} p75 ${q(0.75)} p90 ${q(0.9)} max ${hs[hs.length - 1].hd.toFixed(2)}`);
const band = holds.filter((h) => h.r.b === "30-100").sort((a, b) => a.op - b.op);
for (const h of band) console.log(`  ${h.r.era.padEnd(7)} ${h.r.d} -> ${h.cd} ${h.r.sym.padEnd(6)} ${h.hd.toFixed(2)}d broker ${h.r.brokerPnl.toFixed(1)}`);
const bySym = {}; for (const h of band) (bySym[h.r.sym] = bySym[h.r.sym] || []).push(h);
console.log("band symbols with more than one ticket: " + Object.entries(bySym).filter(([, a]) => a.length > 1).map(([s, a]) => `${s} x${a.length} (${a.map((h) => h.r.d.slice(5)).join(", ")})`).join("; "));
const shape = (lab, a) => { const n = a.length, m = a.reduce((x, y) => x + y, 0) / n, sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1)); const sk = a.reduce((x, y) => x + ((y - m) / sd) ** 3, 0) / n, ku = a.reduce((x, y) => x + ((y - m) / sd) ** 4, 0) / n - 3; console.log(`${lab}: n ${n} mean ${m.toFixed(1)} sd ${sd.toFixed(1)} skew ${sk.toFixed(2)} excess kurtosis ${ku.toFixed(2)}`); };
const cur = holds.filter((h) => h.r.era === "current");
shape("current-era closed, broker dollars a ticket", cur.map((h) => h.r.brokerPnl));
shape("current-era closed, broker bps of notional a ticket", cur.map((h) => 1e4 * h.r.brokerPnl / h.r.notional));
shape("current-era closed BAND, broker bps of notional a ticket", cur.filter((h) => h.r.b === "30-100").map((h) => 1e4 * h.r.brokerPnl / h.r.notional));
shape("current-era closed REST, broker bps of notional a ticket", cur.filter((h) => h.r.b !== "30-100").map((h) => 1e4 * h.r.brokerPnl / h.r.notional));
writeJsonAtomic(path.join(__dirname, "holds.json"), holds.map((h) => ({ id: h.r.id, sym: h.r.sym, b: h.r.b, era: h.r.era, d: h.r.d, cd: h.cd, hd: h.hd, pnl: h.r.brokerPnl, board: h.r.boardPnl, notional: h.r.notional, spr: h.r.spr })));
console.log("wrote holds.json (input to 2-null-size.cjs and 3-g4-conditional.cjs)");
