#!/usr/bin/env node
"use strict";
/**
 * SKEPTIC - lane plan-e: the crypto sleeve's per-switch cost has a MEASURED part already in the repo. READ-ONLY; offline.
 *   node backend/profit-program/skeptic-planE-crypto-spread.js
 * Reads backend/data/crypto-spread-log.jsonl (crypto-spread-snapshot.js: quoted bid/ask round-trip bps per symbol per run) for BTC/USD and ETH/USD.
 * A switch crosses HALF the round-trip spread, on top of the venue fee (the fee is NOT in the repo). Days = distinct UTC dates (the cluster), not rows.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const D = (f) => path.join(__dirname, "..", "data", f);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const rows = fs.readFileSync(D("crypto-spread-log.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
const out = { spec: "skeptic-planE-crypto-spread-v1", rowsInLog: rows.length, cells: [] };
console.log(`crypto-spread-log.jsonl: ${rows.length} rows, ${rows[0].runAt.slice(0, 10)}..${rows[rows.length - 1].runAt.slice(0, 10)}`);
console.log("symbol    venue      rows  UTC days  hours seen (UTC)        median rt bps   p90 rt bps   max   -> half-spread per switch (median / p90)");
for (const sym of ["BTC/USD", "ETH/USD"]) for (const venue of ["alpaca", "coinbase"]) {
  const x = rows.filter((r) => r.sym === sym && (r.venue || "alpaca") === venue && Number.isFinite(r.rtBps) && r.rtBps > 0 && (r.quoteAgeS == null || r.quoteAgeS < 120));
  if (!x.length) continue;
  const days = new Set(x.map((r) => r.runAt.slice(0, 10))), hrs = [...new Set(x.map((r) => +r.runAt.slice(11, 13)))].sort((a, b) => a - b), v = x.map((r) => r.rtBps);
  // one value per UTC day (the day's median), so a day with many polls counts once
  const byDay = {}; x.forEach((r) => (byDay[r.runAt.slice(0, 10)] = byDay[r.runAt.slice(0, 10)] || []).push(r.rtBps)); const dm = Object.values(byDay).map((a) => q(a, 0.5));
  const cell = { sym, venue, rows: x.length, utcDays: days.size, hoursUtc: hrs, medianRtBps: +q(dm, 0.5).toFixed(2), p90RtBps: +q(v, 0.9).toFixed(2), maxRtBps: +Math.max(...v).toFixed(2) };
  out.cells.push(cell);
  console.log(`${sym.padEnd(9)} ${venue.padEnd(9)} ${String(x.length).padStart(5)}  ${String(days.size).padStart(6)}    ${(hrs[0] + ".." + hrs[hrs.length - 1]).padEnd(22)} ${String(cell.medianRtBps).padStart(8)}      ${String(cell.p90RtBps).padStart(8)}   ${String(cell.maxRtBps).padStart(6)}      ${(cell.medianRtBps / 2).toFixed(2)} / ${(cell.p90RtBps / 2).toFixed(2)} bps`);
}
// dollars: planE-levers.js E gives -$77/month per +25 bps of per-switch cost (25 -> 50 bps), i.e. $3.08 per bp, per $100k
const lev = JSON.parse(fs.readFileSync(D("profit-program/planE-levers.json"), "utf8")).E.rows, r25 = lev.find((r) => r.feeBps === 25), r50 = lev.find((r) => r.feeBps === 50), r0 = lev.find((r) => r.feeBps === 0);
const perBp = (r25.usd - r50.usd) / 25; out.usdPerBpPerMonth = +perBp.toFixed(2);
const worst = Math.max(...out.cells.map((c) => c.medianRtBps / 2)), worst90 = Math.max(...out.cells.map((c) => c.p90RtBps / 2));
console.log(`\nfee sensitivity from planE-levers.js E: 25 -> 50 bps = ${r50.usd - r25.usd} $/mo per $100k, so ${perBp.toFixed(2)} $/mo per bp of per-switch cost (0 bps would be +$${r0.usd}/mo).`);
console.log(`measured half-spread adds at most ${worst.toFixed(2)} bps (median) / ${worst90.toFixed(2)} bps (p90) per switch = -$${(worst * perBp).toFixed(0)} / -$${(worst90 * perBp).toFixed(0)} per month per $100k on top of whatever the FEE is.`);
console.log("so the spread is not the unknown; the venue FEE is. Caveat: polls are at the hours shown, not at the 00:00 UTC signal close.");
out.halfSpreadCostUsdPerMonth = { median: +(worst * perBp).toFixed(1), p90: +(worst90 * perBp).toFixed(1) };
writeJsonAtomic(D("profit-program/skeptic-planE-crypto-spread.json"), out); console.log("wrote backend/data/profit-program/skeptic-planE-crypto-spread.json");
