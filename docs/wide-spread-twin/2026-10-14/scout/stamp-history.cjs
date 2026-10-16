#!/usr/bin/env node
"use strict";
/**
 * WIDE-SPREAD TWIN — SCOUT (2026-10-14). READ-ONLY, no network, writes nothing.
 * How often is the entry spread stamp (obs.spreadBps) missing on board EQUITY tickets, since the stamp was added (manifest D1, 2026-08-21)?
 * Per ET entry session: signals (not ctrl / vetoShadow / sleeve), stamped, missing; the sleeve tickets (R24 etc.) apart; and the
 * "no usable spread stamp" refusals since profit fix 4.3 (server restarted with it 2026-10-12 ~18:53 MT).
 *   node docs/wide-spread-twin/2026-10-14/scout/stamp-history.cjs [--since 2026-08-21]
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const D = (f) => path.join(ROOT, "backend", "data", f);
const i = process.argv.indexOf("--since"), SINCE = i > 0 ? process.argv[i + 1] : "2026-08-21";
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const dow = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const tl0 = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8")), tl = Array.isArray(tl0) ? tl0 : tl0.trades;
const board = JSON.parse(fs.readFileSync(D("board_positions.json"), "utf8"));
const tix = new Map(); for (const t of tl) if (t && t.id) tix.set(t.id, t); for (const p of board) if (p && p.id && !tix.has(p.id)) tix.set(p.id, p);
const entryMs = (t) => Number(t.openedAt || t.addedAt) || Number(String(t.id).split("-")[0]);
const ok = (t) => { const v = t.obs ? t.obs.spreadBps : undefined; return typeof v === "number" && Number.isFinite(v) && v > 0; };
const eq = [...tix.values()].filter((t) => t.cls === "Equity" && etDay(entryMs(t)) >= SINCE);
const by = new Map();
for (const t of eq) {
  const d = etDay(entryMs(t)); const o = by.get(d) || { sig: 0, sigMiss: 0, sleeve: 0, sleeveMiss: 0, shadow: 0, shadowMiss: 0, noStamp: 0 }; by.set(d, o);
  if (t.sleeve) { o.sleeve++; if (!ok(t)) o.sleeveMiss++; }
  else if (t.ctrl || t.vetoShadow) { o.shadow++; if (!ok(t)) o.shadowMiss++; if (t.veto === "no usable spread stamp") o.noStamp++; }
  else { o.sig++; if (!ok(t)) o.sigMiss++; }
}
let S = 0, M = 0, full = [];
console.log(`session     dow | signals missing | ctrl+shadow missing | sleeve missing | 'no usable spread stamp' refusals`);
for (const d of [...by.keys()].sort()) {
  const o = by.get(d); S += o.sig; M += o.sigMiss; if (o.sig && o.sig === o.sigMiss) full.push(d + " " + dow(d));
  console.log(`${d}  ${dow(d)} | ${String(o.sig).padStart(7)} ${String(o.sigMiss).padStart(7)} | ${String(o.shadow).padStart(11)} ${String(o.shadowMiss).padStart(7)} | ${String(o.sleeve).padStart(6)} ${String(o.sleeveMiss).padStart(7)} | ${o.noStamp}`);
}
console.log(`TOTAL equity signals since ${SINCE}: ${S}, stamp missing ${M} (${(M / S * 100).toFixed(1)}%); sessions with EVERY signal unstamped: ${full.join(", ") || "none"}`);
const sl = eq.filter((t) => t.sleeve); const kinds = {}; for (const t of sl) { const k = t.strategy || t.sleeve; kinds[k] = (kinds[k] || 0) + 1; }
console.log(`sleeve equity tickets by strategy (never reach the board mirror's signal filter? see report): ${JSON.stringify(kinds)}`);
