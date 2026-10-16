#!/usr/bin/env node
"use strict";
/** FIXTURE REPLAY (attack 2, D9). READ-ONLY; writes nothing. Rebuilds the scout's per-ticket rows and its stamp table from
 *  scout/fixture-2026-10-14/ ONLY (the same logic as scout/spread-buckets.cjs, which read the live files) and compares them, row by row,
 *  with the scout's saved output scout/spread-buckets.out.json. It first checks every fixture file against MANIFEST.json's sha256.
 *  Ends "FIXTURE REPLAY MATCHES THE SCOUT" or lists every difference (exit 1).
 *    node docs/wide-spread-twin/2026-10-14/registrar/fixture-replay.cjs                                                             */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const FX = path.join(__dirname, "..", "scout", "fixture-2026-10-14"), OUT = path.join(__dirname, "..", "scout", "spread-buckets.out.json");
const M = JSON.parse(fs.readFileSync(path.join(FX, "MANIFEST.json"), "utf8")), bad = [];
for (const [f, m] of Object.entries(M.files)) { const h = crypto.createHash("sha256").update(fs.readFileSync(path.join(FX, f))).digest("hex"); if (h !== m.sha256) bad.push(`${f}: sha256 ${h.slice(0, 12)} is not the manifest's ${m.sha256.slice(0, 12)}`); }
const J = (f) => JSON.parse(fs.readFileSync(path.join(FX, f), "utf8"));
const tickets = J("tickets.json"), canon0 = J("canon.json"), mir = J("mirror.json"), exits = J("mirror-exits.json"), recon = J("reconcile.json"), stream = J("trade-updates.json");
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const entryMs = (t) => Number(t.openedAt || t.addedAt) || (t.id ? Number(String(t.id).split("-")[0]) : NaN);
const spreadOf = (t) => { const v = t && t.obs ? t.obs.spreadBps : undefined; return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null; };
const bucketOf = (s) => (s == null ? "missing" : s < 10 ? "<10" : s < 30 ? "10-30" : s <= 100 ? "30-100" : ">100");
const BUCKETS = ["<10", "10-30", "30-100", ">100", "missing"];
const canon = new Map([...canon0.signals, ...canon0.controls].map((t) => [t.id, t]));
const mirBy = new Map(); for (const r of mir) { if (!mirBy.has(r.ticketId)) mirBy.set(r.ticketId, []); mirBy.get(r.ticketId).push(r); }
const exitFinal = new Map(); for (const x of exits) if (x.final) exitFinal.set(x.ticketId, x);
const recBy = new Map(recon.perTicket.map((p) => [p.ticketId, p]));
const lastByOrder = new Map(); for (const r of stream) if (r.order_id) lastByOrder.set(r.order_id, r);
const eqSig = tickets.filter((t) => t.cls === "Equity" && !t.ctrl && !t.vetoShadow && !t.sleeve), eqAll = tickets.filter((t) => t.cls === "Equity" && !t.sleeve);
const days = [...new Set(eqAll.map((t) => etDay(entryMs(t))))].sort();
const stampRows = days.map((d) => { const s = eqSig.filter((t) => etDay(entryMs(t)) === d), a = eqAll.filter((t) => etDay(entryMs(t)) === d); const bk = Object.fromEntries(BUCKETS.map((b) => [b, s.filter((t) => bucketOf(spreadOf(t)) === b).length]));
  return { d, signals: s.length, missing: bk.missing, ...bk, noStampShadow: a.filter((t) => t.vetoShadow && t.veto === "no usable spread stamp").length, r49: a.filter((t) => t.vetoShadow && /^R49/.test(t.veto || "")).length, r53: a.filter((t) => t.vetoShadow && /^R53/.test(t.veto || "")).length }; });
const disp = (t) => { const rs = mirBy.get(t.id) || []; if (!rs.length) return "none"; return rs.find((r) => r.orderId && !r.late) ? "sent" : "other"; };
const rows = eqSig.filter((t) => disp(t) === "sent").map((t) => { const m = mirBy.get(t.id).find((r) => r.orderId && !r.late), rc = recBy.get(t.id), c = canon.get(t.id), st = lastByOrder.get(m.orderId);
  const filled = !!(rc && Number.isFinite(rc.brokerFill) && rc.brokerFill > 0), closed = filled && Number.isFinite(rc.brokerPnl) && !!c && Number.isFinite(c.pnl);
  return { id: t.id, sym: t.sym, d: etDay(entryMs(t)), era: String(m.ts) < "2026-10-01" ? "stale" : "current", spr: spreadOf(t), b: bucketOf(spreadOf(t)), qtyOrdered: Number(m.qty), qtyFilled: rc ? rc.qty : null, notional: m.notional,
    filled, closed, brokerPnl: closed ? rc.brokerPnl : null, boardPnl: c && Number.isFinite(c.pnl) ? c.pnl : null, streamFill: st && Number(st.filled_avg_price) > 0 ? Number(st.filled_avg_price) : null, exitFinal: exitFinal.has(t.id) }; });
const saved = JSON.parse(fs.readFileSync(OUT, "utf8"));
const K = ["id", "sym", "d", "era", "spr", "b", "qtyOrdered", "qtyFilled", "notional", "filled", "closed", "brokerPnl", "boardPnl", "streamFill", "exitFinal"];
const sById = new Map(saved.rows.map((r) => [r.id, r]));
if (rows.length !== saved.rows.length) bad.push(`rows: ${rows.length} rebuilt, ${saved.rows.length} saved`);
for (const r of rows) { const s = sById.get(r.id); if (!s) { bad.push(`row ${r.id} not in the saved output`); continue; } for (const k of K) if (JSON.stringify(r[k]) !== JSON.stringify(s[k])) bad.push(`row ${r.id} ${k}: ${JSON.stringify(r[k])} rebuilt, ${JSON.stringify(s[k])} saved`); }
if (JSON.stringify(stampRows) !== JSON.stringify(saved.stampRows)) bad.push("the stamp table differs from the saved one");
const sum = (a) => a.reduce((x, y) => x + y, 0), cur = rows.filter((r) => r.era === "current" && r.closed);
const line = ["<10", "10-30", "30-100"].map((b) => { const c = cur.filter((r) => r.b === b); return `${b}: ${c.length} closed on ${new Set(c.map((r) => r.d)).size} sessions, broker ${Math.round(sum(c.map((r) => r.brokerPnl)))}, board ${Math.round(sum(c.map((r) => r.boardPnl)))}`; }).join(" | ");
console.log(`fixture rows ${rows.length}, stamp days ${stampRows.length}; current era closed — ${line}`);
if (bad.length) { console.log(`FIXTURE REPLAY DIFFERS (${bad.length}):\n  ` + bad.slice(0, 40).join("\n  ")); process.exit(1); }
console.log("FIXTURE REPLAY MATCHES THE SCOUT");
