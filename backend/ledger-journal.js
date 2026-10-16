#!/usr/bin/env node
/**
 * LEDGER JOURNAL (manifest B1, scoped for 2026-08-21): an append-only JSONL shadow of trade_log.json.
 *
 * trade_log.json is rewritten whole on every settle; at the breadth book's rate it reaches ~70 MB a
 * year and every writer pays the parse/stringify. The full migration (every reader onto JSONL) is
 * weekend surgery; THIS step is the safe half that can ship tonight: every row, the first time it
 * is seen settled, is appended to data/trade_log.jsonl with a journaledAt stamp — and never again.
 * The journal is the immutable history; the JSON remains the working view. A nightly integrity
 * line reports any settled JSON row missing from the journal (should be zero) and any journaled
 * row whose settled fields later changed in the JSON (should be zero — a sealed row never moves).
 * Readers migrate to the journal later, one at a time, each with its own commit.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const JSON_PATH = D("trade_log.json"), JL = D("trade_log.jsonl");
const log = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
const settled = log.filter((t) => t && t.id && t.closedAt && Number.isFinite(t.pnl));
const have = new Map();
if (fs.existsSync(JL)) for (const line of fs.readFileSync(JL, "utf8").split("\n")) { if (!line.trim()) continue; try { const r = JSON.parse(line); have.set(r.id, r); } catch {} }
const fresh = settled.filter((t) => !have.has(t.id));
const now = new Date().toISOString();
if (fresh.length) fs.appendFileSync(JL, fresh.map((t) => JSON.stringify({ ...t, journaledAt: now })).join("\n") + "\n");
let drift = 0; const driftIds = [];
for (const t of settled) { const j = have.get(t.id); if (!j) continue; if (Math.abs((j.pnl ?? 0) - (t.pnl ?? 0)) > 0.005 || Math.abs((j.rMult ?? 0) - (t.rMult ?? 0)) > 1e-6 || (j.closedAt !== t.closedAt)) { drift++; if (driftIds.length < 5) driftIds.push(t.id); } }
const missing = settled.filter((t) => !have.has(t.id) && !fresh.some((f) => f.id === t.id)).length;
console.log(`LEDGER JOURNAL — ${settled.length} settled rows in JSON · journal held ${have.size} · appended ${fresh.length} · now ${have.size + fresh.length} rows (${(fs.statSync(JL).size / 1e6).toFixed(1)} MB append-only)`);
console.log(`  integrity: ${missing} settled rows missing from the journal · ${drift} journaled rows whose settled fields changed in the JSON${drift ? " — INVESTIGATE: " + driftIds.join(", ") : ""}`);
if (drift) process.exit(1);
