#!/usr/bin/env node
"use strict";
/**
 * WIDE-SPREAD TWIN — SCOUT (2026-10-14). READ-ONLY. No network, no broker call, no write to any live file.
 * Writes only docs/wide-spread-twin/2026-10-14/scout/spread-buckets.out.json (through lib/atomic-write.js) when --out is passed.
 *
 * What it counts, per ENTRY SESSION (ET date of the ticket's openedAt/addedAt):
 *   board  = board equity SIGNAL tickets (not ctrl, not vetoShadow, not sleeve) from trade_log.json (raw, for the obs stamp) + board_positions.json
 *   mirror = rows of data/alpaca-mirror.jsonl for those tickets: sent (orderId), error, skipped (reason), late
 *   filled = the order filled at the broker (data/alpaca-reconcile.json perTicket.brokerFill; cross-checked against data/alpaca-trade-updates.jsonl)
 *   closed = broker exit known (reconcile brokerPnl finite) AND the board ticket settled in lib/reconcile.js cleanEraLedger()
 * by entry-spread bucket of the ticket's own obs.spreadBps: <10, 10-30, 30-100 (30 <= s <= 100), >100, missing.
 * Dollars: broker realised P&L (reconcile brokerPnl, each exit fill x its own filled qty) and the board's paper pnl (canonical ledger) for the SAME tickets.
 *
 *   node docs/wide-spread-twin/2026-10-14/scout/spread-buckets.cjs [--since 2026-09-25] [--out]
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const D = (f) => path.join(ROOT, "backend", "data", f);
const REC = require(path.join(ROOT, "backend", "lib", "reconcile.js"));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SINCE = arg("--since", "2026-09-25");
const jl = (f) => fs.readFileSync(D(f), "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const sum = (a) => a.reduce((s, v) => s + v, 0);
const $ = (v) => (!Number.isFinite(v) ? "n/a" : (v < 0 ? "-$" : "+$") + Math.abs(Math.round(v)).toLocaleString("en-US"));
const pad = (s, n) => String(s).padStart(n), lpad = (s, n) => String(s).padEnd(n);
const BUCKETS = ["<10", "10-30", "30-100", ">100", "missing"];
const spreadOf = (t) => { const v = t && t.obs ? t.obs.spreadBps : undefined; return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null; };
const bucketOf = (s) => (s == null ? "missing" : s < 10 ? "<10" : s < 30 ? "10-30" : s <= 100 ? "30-100" : ">100");

// ---------- tickets: raw trade log (obs stamp, any row) + open board
const tl0 = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8")), tl = Array.isArray(tl0) ? tl0 : tl0.trades;
const board = JSON.parse(fs.readFileSync(D("board_positions.json"), "utf8"));
const tix = new Map();
for (const t of tl) if (t && t.id) tix.set(t.id, { ...t, _src: "trade_log" });
for (const p of board) if (p && p.id && !tix.has(p.id)) tix.set(p.id, { ...p, _src: "board_open" });
const L = REC.cleanEraLedger(), canon = new Map([...L.signals, ...L.controls].map((t) => [t.id, t]));
const entryMs = (t) => Number(t.openedAt || t.addedAt) || (t.id ? Number(String(t.id).split("-")[0]) : NaN);
const isSleeve = (t) => !!t.sleeve;

// ---------- mirror, exits, reconcile, stream
const mir = jl("alpaca-mirror.jsonl").filter((r) => r.cls === "Equity");
const mirBy = new Map(); for (const r of mir) { if (!mirBy.has(r.ticketId)) mirBy.set(r.ticketId, []); mirBy.get(r.ticketId).push(r); }
const exits = jl("alpaca-mirror-exits.jsonl"); const exitFinal = new Map(); for (const x of exits) if (x.final) exitFinal.set(x.ticketId, x);
const recon = JSON.parse(fs.readFileSync(D("alpaca-reconcile.json"), "utf8")); const recBy = new Map(recon.perTicket.map((p) => [p.ticketId, p]));
const stream = jl("alpaca-trade-updates.jsonl").filter((r) => r.account === "main");
const lastByOrder = new Map(); for (const r of stream) if (r.order_id) lastByOrder.set(r.order_id, r);   // file order = event order

// ---------- [0] the stamp, all board equity signals since SINCE
const eqSig = [...tix.values()].filter((t) => t.cls === "Equity" && !t.ctrl && !t.vetoShadow && !isSleeve(t) && etDay(entryMs(t)) >= SINCE);
const eqAll = [...tix.values()].filter((t) => t.cls === "Equity" && !isSleeve(t) && etDay(entryMs(t)) >= SINCE);
const days = [...new Set(eqAll.map((t) => etDay(entryMs(t))))].sort();
console.log(`WIDE-SPREAD SCOUT — read-only; entry sessions >= ${SINCE}; reconcile asOf ${recon.asOf}; ledger ${L.source} (${L.n} signals)`);
console.log(`\n[0] SPREAD STAMP on board EQUITY tickets by entry session (signals = not ctrl/vetoShadow/sleeve; 'noStampShadow' = veto "no usable spread stamp"; 'R49' = refused > 100 bps)`);
console.log(`${lpad("session", 11)} ${pad("signals", 7)} ${pad("stamped", 7)} ${pad("missing", 7)} | ${BUCKETS.map((b) => pad(b, 7)).join(" ")} | ${pad("noStampShadow", 13)} ${pad("R49", 4)} ${pad("R53", 4)}`);
const stampRows = [];
for (const d of days) {
  const s = eqSig.filter((t) => etDay(entryMs(t)) === d), a = eqAll.filter((t) => etDay(entryMs(t)) === d);
  const bk = Object.fromEntries(BUCKETS.map((b) => [b, s.filter((t) => bucketOf(spreadOf(t)) === b).length]));
  const ns = a.filter((t) => t.vetoShadow && t.veto === "no usable spread stamp").length, r49 = a.filter((t) => t.vetoShadow && /^R49/.test(t.veto || "")).length, r53 = a.filter((t) => t.vetoShadow && /^R53/.test(t.veto || "")).length;
  stampRows.push({ d, signals: s.length, missing: bk.missing, ...bk, noStampShadow: ns, r49, r53 });
  console.log(`${lpad(d, 11)} ${pad(s.length, 7)} ${pad(s.length - bk.missing, 7)} ${pad(bk.missing, 7)} | ${BUCKETS.map((b) => pad(bk[b], 7)).join(" ")} | ${pad(ns, 13)} ${pad(r49, 4)} ${pad(r53, 4)}`);
}
{ const tot = (k) => sum(stampRows.map((r) => r[k])); console.log(`${lpad("TOTAL", 11)} ${pad(tot("signals"), 7)} ${pad(tot("signals") - tot("missing"), 7)} ${pad(tot("missing"), 7)} | ${BUCKETS.map((b) => pad(tot(b), 7)).join(" ")} | ${pad(tot("noStampShadow"), 13)} ${pad(tot("r49"), 4)} ${pad(tot("r53"), 4)}`); }
const stampDays = stampRows.filter((r) => r.signals > 0 && r.missing === r.signals).map((r) => r.d);
console.log(`   sessions where EVERY equity signal is unstamped: ${stampDays.join(" ") || "none"}`);

// ---------- [1] mirror disposition of the board's equity signals
console.log(`\n[1] MIRROR DISPOSITION of those signals (alpaca-mirror.jsonl; a ticket can have several rows only in late mode)`);
const disp = (t) => { const rs = mirBy.get(t.id) || []; if (!rs.length) return "no mirror row"; const sent = rs.find((r) => r.orderId && !r.late); if (sent) return "sent"; if (rs.find((r) => r.orderId && r.late)) return "sent LATE (not graded)"; const e = rs.find((r) => r.error); if (e) return "order error: " + String(e.error).slice(0, 60); const sk = rs.find((r) => r.skipped); return "skipped: " + String(sk.skipped).replace(/\d+ min old/, "N min old").replace(/\$\d+/g, "$N").slice(0, 70); };
const dc = {}; for (const t of eqSig) { const k = disp(t); dc[k] = (dc[k] || 0) + 1; }
for (const [k, v] of Object.entries(dc).sort((a, b) => b[1] - a[1])) console.log(`   ${pad(v, 5)}  ${k}`);
console.log(`   by bucket (sent / signals): ${BUCKETS.map((b) => { const s = eqSig.filter((t) => bucketOf(spreadOf(t)) === b); return `${b} ${s.filter((t) => disp(t) === "sent").length}/${s.length}`; }).join(" · ")}`);
// does the mirror treat spread? (it does not read obs at all) — show the ticket-side sizing it inherits
const csm = (t) => (t.obs && Number.isFinite(t.obs.costSizeMult) ? t.obs.costSizeMult : null);
console.log(`   inherited sizing: mean obs.costSizeMult of SENT tickets by bucket: ${BUCKETS.map((b) => { const s = eqSig.filter((t) => bucketOf(spreadOf(t)) === b && disp(t) === "sent").map(csm).filter((v) => v != null); return `${b} ${s.length ? (sum(s) / s.length).toFixed(2) : "n/a"} (n ${s.length})`; }).join(" · ")}`);
const notl = (t) => { const r = (mirBy.get(t.id) || []).find((x) => x.orderId && !x.late); return r && Number.isFinite(r.notional) ? r.notional : null; };
console.log(`   mean mirror notional of SENT tickets by bucket: ${BUCKETS.map((b) => { const s = eqSig.filter((t) => bucketOf(spreadOf(t)) === b).map(notl).filter((v) => v != null); return `${b} $${s.length ? Math.round(sum(s) / s.length) : "n/a"}`; }).join(" · ")}`);

// ---------- [2] per session x bucket: mirrored, filled, closed; broker vs board dollars
console.log(`\n[2] PER ENTRY SESSION x ENTRY-SPREAD BUCKET — mirrored equity signal tickets (sent, not late). filled = broker fill; closed = broker exit priced AND board settled (canonical ledger)`);
console.log(`   era: STALE = mirrored before 2026-10-01 (no exit pass while open; bracket legs DAY until 09-24, hand-flattened 09-24, 37 closed by the 10-01 catch-up); CURRENT = from 10-01`);
const rowsOut = [];
const sentT = eqSig.filter((t) => disp(t) === "sent");
for (const t of sentT) {
  const m = mirBy.get(t.id).find((r) => r.orderId && !r.late), rc = recBy.get(t.id), c = canon.get(t.id);
  const st = m.orderId ? lastByOrder.get(m.orderId) : null;
  const filled = !!(rc && Number.isFinite(rc.brokerFill) && rc.brokerFill > 0);
  const closed = filled && Number.isFinite(rc.brokerPnl) && !!c && Number.isFinite(c.pnl);
  const risk = Number.isFinite(t.units) && Number.isFinite(t.stopDist) && t.units * t.stopDist > 0 ? t.units * t.stopDist : (Number.isFinite(t.riskDollars) ? t.riskDollars : NaN);
  rowsOut.push({ id: t.id, sym: t.sym, strat: t.strategy, dir: t.dir, d: etDay(entryMs(t)), era: String(m.ts) < "2026-10-01" ? "stale" : "current", spr: spreadOf(t), b: bucketOf(spreadOf(t)),
    qtyOrdered: Number(m.qty), qtyFilled: rc ? rc.qty : null, notional: m.notional, filled, closed, brokerPnl: closed ? rc.brokerPnl : null, boardPnl: c && Number.isFinite(c.pnl) ? c.pnl : null,
    boardUnits: t.units, risk, brokerExitReason: rc ? rc.brokerExitReason : null, slipPct: rc ? rc.slippagePct : null, exitQtyMismatch: !!(rc && rc.exitQtyMismatch),
    streamFill: st && Number(st.filled_avg_price) > 0 ? Number(st.filled_avg_price) : null, streamStatus: st ? st.status : null, recFill: rc ? rc.brokerFill : null, exitFinal: exitFinal.has(t.id) });
}
const cell = (rs) => { const cl = rs.filter((r) => r.closed); return { n: rs.length, filled: rs.filter((r) => r.filled).length, closed: cl.length, broker: sum(cl.map((r) => r.brokerPnl)), boardSame: sum(cl.map((r) => r.boardPnl)) }; };
console.log(`${lpad("session", 11)} ${lpad("era", 7)} | ${BUCKETS.map((b) => pad(b + " n/f/c broker board", 34)).join(" | ")}`);
for (const d of [...new Set(rowsOut.map((r) => r.d))].sort()) {
  const rs = rowsOut.filter((r) => r.d === d), era = [...new Set(rs.map((r) => r.era))].join("+");
  console.log(`${lpad(d, 11)} ${lpad(era, 7)} | ${BUCKETS.map((b) => { const c = cell(rs.filter((r) => r.b === b)); return pad(c.n ? `${c.n}/${c.filled}/${c.closed} ${$(c.broker)} ${$(c.boardSame)}` : "-", 34); }).join(" | ")}`);
}
for (const [lab, f] of [["ALL since " + SINCE, () => true], ["STALE era (< 10-01)", (r) => r.era === "stale"], ["CURRENT era (>= 10-01)", (r) => r.era === "current"], ["entries >= 10-02 (partial-close fix)", (r) => r.d >= "2026-10-02"], ["entries >= 10-05 (MR shadowed, OP10)", (r) => r.d >= "2026-10-05"], ["entries >= 10-13 (stamp gate live)", (r) => r.d >= "2026-10-13"]]) {
  const rs = rowsOut.filter(f), ses = new Set(rs.map((r) => r.d)).size;
  console.log(`   ${lpad(lab, 38)} sessions ${pad(ses, 2)} | ${BUCKETS.map((b) => { const c = cell(rs.filter((r) => r.b === b)); return `${b} ${c.n}/${c.filled}/${c.closed} brk ${$(c.broker)} brd ${$(c.boardSame)} gap ${$(c.broker - c.boardSame)}`; }).join(" | ")}`);
}

// ---------- [3] rate of the 30-100 bucket at the mirror, and sessions to 150
console.log(`\n[3] FLOW OF 30-100 bps TICKETS (per entry session with any equity board signal) and sessions to 150`);
const allSessions = (from) => stampRows.filter((r) => r.d >= from && r.signals > 0).map((r) => r.d);
for (const from of ["2026-09-25", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-13"]) {
  const S = allSessions(from), nS = S.length; if (!nS) continue;
  const bd = eqSig.filter((t) => etDay(entryMs(t)) >= from && bucketOf(spreadOf(t)) === "30-100").length;
  const rs = rowsOut.filter((r) => r.d >= from && r.b === "30-100"), sent = rs.length, fil = rs.filter((r) => r.filled).length, cl = rs.filter((r) => r.closed).length;
  const per = (x) => (x / nS).toFixed(2), need = (x) => (x > 0 ? Math.ceil(150 / (x / nS)) : "inf");
  console.log(`   from ${from}: ${pad(nS, 2)} sessions | board signals in 30-100 ${pad(bd, 3)} (${per(bd)}/session -> ${need(bd)} sessions to 150) | mirrored ${pad(sent, 3)} (${per(sent)}/s -> ${need(sent)}) | filled ${pad(fil, 3)} (${per(fil)}/s -> ${need(fil)}) | closed+priced ${pad(cl, 3)} (${per(cl)}/s -> ${need(cl)})`);
}
// sessions with zero equity signals (the board can have empty days)
console.log(`   entry sessions with board equity tickets (any arm): ${days.length} (${days[0]} .. ${days[days.length - 1]}); sessions with >= 1 equity SIGNAL: ${stampRows.filter((r) => r.signals > 0).length}`);

// ---------- [4] cost really paid at the broker, by bucket (current era, closed)
console.log(`\n[4] COST AT THE BROKER by bucket (closed & priced, current era): broker P&L minus board P&L on the same ticket, per ticket and in bps of notional; entry slippage vs the ticket's claimed entry`);
for (const b of BUCKETS) {
  const rs = rowsOut.filter((r) => r.era === "current" && r.b === b && r.closed && Number.isFinite(r.notional) && r.notional > 0);
  if (!rs.length) { console.log(`   ${lpad(b, 8)} n 0`); continue; }
  const gap = sum(rs.map((r) => r.brokerPnl - r.boardPnl)), notion = sum(rs.map((r) => r.notional)), slip = rs.map((r) => r.slipPct).filter(Number.isFinite);
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const sprM = med(rs.map((r) => r.spr).filter((v) => v != null));
  console.log(`   ${lpad(b, 8)} n ${pad(rs.length, 3)} sessions ${pad(new Set(rs.map((r) => r.d)).size, 2)} | broker ${pad($(sum(rs.map((r) => r.brokerPnl))), 7)} board ${pad($(sum(rs.map((r) => r.boardPnl))), 7)} gap ${pad($(gap), 7)} = ${pad((gap / notion * 1e4).toFixed(1), 6)} bps of notional (${$(gap / rs.length)}/ticket) | median entry slippage ${pad((med(slip) * 100).toFixed(1), 6)} bps | median stamped spread ${Number.isFinite(sprM) ? sprM.toFixed(1) : "n/a"} bps | qty-mismatch rows ${rs.filter((r) => r.exitQtyMismatch).length}`);
}

// ---------- [5] data checks
console.log(`\n[5] DATA CHECKS`);
{
  const fil = rowsOut.filter((r) => r.filled), withStream = fil.filter((r) => r.streamFill != null);
  const agree = withStream.filter((r) => Math.abs(r.streamFill - r.recFill) < 1e-6).length;
  console.log(`   filled mirrored equity tickets ${fil.length}; with a stream fill event for the entry order ${withStream.length} (stream starts 2026-09-30); stream fill price equals the reconcile fill on ${agree} of ${withStream.length}`);
  const qd = fil.filter((r) => Number.isFinite(r.qtyFilled) && r.qtyFilled !== r.qtyOrdered).length;
  console.log(`   filled qty differs from ordered qty: ${qd}; exit qty mismatch flagged by reconcile: ${rowsOut.filter((r) => r.exitQtyMismatch).length}`);
  const unitsVsQty = fil.filter((r) => Number.isFinite(r.boardUnits) && Math.abs(r.boardUnits - r.qtyFilled) > 1).length;
  console.log(`   board units differ from the broker filled qty by more than 1 share: ${unitsVsQty} of ${fil.length} (the mirror orders floor(units); the board books fractional units)`);
  const filledNotClosed = fil.filter((r) => !r.closed);
  console.log(`   filled but not yet closed+priced: ${filledNotClosed.length} (${[...new Set(filledNotClosed.map((r) => r.d))].sort().join(" ")}) — open at the board or broker exit not yet read by the nightly reconcile`);
  const reasons = {}; for (const r of rowsOut.filter((x) => x.closed)) { const k = r.brokerExitReason || "none"; reasons[k] = (reasons[k] || 0) + 1; }
  console.log(`   broker exit kinds on closed rows: ${JSON.stringify(reasons)}`);
  const strat = {}; for (const r of rowsOut) { const k = r.strat + "|" + r.b; strat[k] = (strat[k] || 0) + 1; }
  console.log(`   mirrored by strategy|bucket: ${JSON.stringify(strat)}`);
  const dir = {}; for (const r of rowsOut.filter((x) => x.b === "30-100")) { const k = r.d >= "2026-10-01" ? (r.dir > 0 ? "long" : "short") : "stale"; dir[k] = (dir[k] || 0) + 1; }
  console.log(`   30-100 bucket by direction (current era): ${JSON.stringify(dir)}`);
}

if (process.argv.includes("--out")) {
  const { writeJsonAtomic } = require(path.join(ROOT, "backend", "lib", "atomic-write.js"));
  writeJsonAtomic(path.join(__dirname, "spread-buckets.out.json"), { spec: "wide-spread-scout-v1", asOf: new Date().toISOString(), since: SINCE, reconcileAsOf: recon.asOf, stampRows, rows: rowsOut });
  console.log(`\nwrote ${path.join(__dirname, "spread-buckets.out.json")}`);
}
