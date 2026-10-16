#!/usr/bin/env node
/**
 * RETIRE-APPLY (2026-09-22) — stamps an agreed data-defect tag onto named ledger rows, once they settle.
 *
 * Retiring a row EXCLUDES it from the book, which is the most abusable edit in this ledger (lib/reconcile.js says so at length). So:
 *   · this script only ever touches ids listed in data/retire-requests.json, each with the operator's word recorded beside it;
 *   · it never selects rows by outcome, symbol or P&L;
 *   · the tag counts only if it also appears in the append-only change registry (reconcile.js enforces that, not this file);
 *   · it writes what it did, and prints the book's edge WITH and WITHOUT the tagged rows so the direction of the edit is visible.
 * Runs inside the close chain after the settle, so it never races the server's own writes.
 */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), REQ = D("retire-requests.json");
if (!fs.existsSync(REQ)) { console.log("retire-apply: no requests"); process.exit(0); }
const reqs = JSON.parse(fs.readFileSync(REQ, "utf8")).requests || [];
const pending = reqs.filter((r) => !r.appliedAt);
if (!pending.length) { console.log(`retire-apply: nothing pending (${reqs.length} historical request(s))`); process.exit(0); }
const logPath = D("trade_log.json"); const raw = JSON.parse(fs.readFileSync(logPath, "utf8")); const rows = Array.isArray(raw) ? raw : raw.trades;
let stamped = 0, stillOpen = 0;
for (const req of pending) {
  const hits = [];
  for (const id of req.ids) { const t = rows.find((x) => x && x.id === id); if (!t) { stillOpen++; continue; }
    if (t.retired) continue;
    if (!(Number.isFinite(t.rMult) && Number.isFinite(t.pnl))) { stillOpen++; continue; }
    t.retired = req.tag; t.retireNote = req.note; stamped++; hits.push(id); }
  if (hits.length) req.stamped = [...(req.stamped || []), ...hits];
  if ((req.stamped || []).length === req.ids.length) req.appliedAt = new Date().toISOString();
}
if (stamped) { writeJsonAtomic(logPath, Array.isArray(raw) ? rows : raw); writeJsonAtomic(REQ, { note: "Each request carries the operator's word. retire-apply.js stamps ONLY these ids, and only once they have settled.", requests: reqs }); }
try { const led = require("./lib/reconcile.js").cleanEraLedger(); console.log(`retire-apply: stamped ${stamped}, still open/unsettled ${stillOpen} · clean-era signal edge now ${led.meanR != null ? (+led.meanR).toFixed(4) : "?"}R on ${led.n} (retired rows excluded: ${led.retiredExcluded ?? "?"})`); }
catch (e) { console.log(`retire-apply: stamped ${stamped}, still open ${stillOpen} · ledger read failed: ${e.message}`); }
