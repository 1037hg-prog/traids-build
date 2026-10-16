#!/usr/bin/env node
/**
 * ALPACA RECONCILE (2026-09-22) — grade OUR ledger against the BROKER's record. For every ticket alpaca-mirror.js sent, ask Alpaca what
 * actually happened and compare it with what this repo believes:
 *   FILL GAP     broker fill price vs the ticket's claimed entry (the slippage our cost model only models)
 *   FATE GAP     the broker closed it (take-profit, stop, expiry) vs our ledger's exit and P&L for the same ticket
 *   MISSING      a mirrored order the broker has no record of, or a settled ticket whose mirror never filled
 * Reads only. It changes no ledger row and grades no test. Writes data/alpaca-reconcile.json for the nightly email.
 * PAPER-AUCTION-FIX 2026-10-02: quantities are the broker's filled_qty (entry and every exit fill), never the ordered qty or a status alone.
 */
const fs = require("fs"), path = require("path"); require("dotenv").config({ path: path.join(__dirname, ".env") });
const D = (f) => path.join(__dirname, "data", f), LOG = D("alpaca-mirror.jsonl");
const BASE = "https://paper-api.alpaca.markets";
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const api = async (p) => { const r = await fetch(BASE + p, { headers: H }); if (!r.ok) throw new Error(`${r.status} on ${p.split("?")[0]}`); return r.json(); };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

(async () => {
  if (!fs.existsSync(LOG)) { writeJsonAtomic(D("alpaca-reconcile.json"), { spec: "alpaca-reconcile-v1", asOf: new Date().toISOString(), mirrored: 0, note: "nothing mirrored yet" }); console.log("alpaca-reconcile: nothing mirrored yet"); return; }
  const all = fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.orderId);
  // LATE rows (sent long after the ticket's entry — the 2026-09-23 one-off) test the plumbing only: counted, never graded against the ticket.
  const lateRows = all.filter((r) => r.late), rows = all.filter((r) => !r.late);
  const log0 = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8")), ledger = Array.isArray(log0) ? log0 : log0.trades;
  const byId = new Map(ledger.map((t) => [t.id, t]));
  // 2026-10-01: mirror exits (alpaca-mirror.js closes a ticket at market once the board has closed it) are the broker exit when no leg filled
  const EX = D("alpaca-mirror-exits.jsonl"), exitBy = new Map((fs.existsSync(EX) ? fs.readFileSync(EX, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((x) => x.closeOrderId).map((x) => [x.ticketId, x]));
  const out = { spec: "alpaca-reconcile-v1", asOf: new Date().toISOString(), mirrored: rows.length, lateOrdersNotGraded: lateRows.length, filled: 0, unfilled: 0, missingAtBroker: 0, fillGaps: [], fateGaps: [], perTicket: [] };
  for (const r of rows) {
    let o = null; try { o = await api(`/v2/orders/${r.orderId}?nested=true`); } catch { out.missingAtBroker++; out.perTicket.push({ ticketId: r.ticketId, sym: r.sym, issue: "broker has no record of this order" }); continue; }
    const fill = Number(o.filled_avg_price) || null, fq = Number(o.filled_qty) || 0;   // PAPER-AUCTION-FIX 2026-10-02: the filled quantity, not the ordered one
    if (!fill || !(fq > 0)) { out.unfilled++; out.perTicket.push({ ticketId: r.ticketId, sym: r.sym, brokerStatus: o.status, issue: "never filled" }); continue; }
    out.filled++;
    const slipPct = r.ticketEntry ? +(100 * (fill / r.ticketEntry - 1) * (r.side === "buy" ? 1 : -1)).toFixed(4) : null;   // positive = we paid worse than the ticket claimed
    if (slipPct != null) out.fillGaps.push(slipPct);
    // PAPER-AUCTION-FIX 2026-10-02: the exit is every fill that took the ticket out, read from filled_qty — bracket legs with filled_qty > 0 whatever
    // their status (a leg partly filled, then cancelled by the mirror's exit pass, counts) plus the mirror's own close orders (the final exits row
    // carries closeQty / closeFill over all of them; otherwise the close order is read). Before, only a leg whose status was "filled" counted.
    const exits = (o.legs || []).filter((l) => Number(l.filled_qty) > 0 && Number(l.filled_avg_price) > 0).map((l) => ({ q: Number(l.filled_qty), px: Number(l.filled_avg_price), why: l.order_type || l.type }));
    if (exitBy.has(r.ticketId)) { const x = exitBy.get(r.ticketId);
      if (x.final && Number(x.closeQty) > 0 && Number(x.closeFill) > 0) exits.push({ q: Number(x.closeQty), px: Number(x.closeFill), why: "mirror-exit (board closed)" });
      else { try { const c = await api(`/v2/orders/${x.closeOrderId}`); if (Number(c.filled_qty) > 0 && Number(c.filled_avg_price) > 0) exits.push({ q: Number(c.filled_qty), px: Number(c.filled_avg_price), why: "mirror-exit (board closed)" }); } catch {} } }
    const exQ = exits.reduce((a, e) => a + e.q, 0), exPx = exits.length === 1 ? exits[0].px : exQ > 0 ? exits.reduce((a, e) => a + e.q * e.px, 0) / exQ : null;
    const t = byId.get(r.ticketId);
    const row = { ticketId: r.ticketId, sym: r.sym, side: r.side, qty: fq, ...(fq !== Number(r.qty) ? { qtyOrdered: r.qty } : {}), ticketEntry: r.ticketEntry, brokerFill: fill, slippagePct: slipPct,
      brokerExit: exPx, brokerExitReason: exits.length ? [...new Set(exits.map((e) => e.why))].join(" + ") : null, ...(exQ > 0 && Math.abs(exQ - fq) > 1e-9 ? { brokerExitQty: exQ, exitQtyMismatch: true } : {}),
      ourExit: t && Number.isFinite(t.exit) ? t.exit : null, ourPnl: t && Number.isFinite(t.pnl) ? t.pnl : null, ourReason: t ? t.reason : null };
    if (row.brokerExit != null && row.ourExit != null) {
      const brokerPnl = exits.reduce((a, e) => a + (e.px - fill) * (r.side === "buy" ? 1 : -1) * e.q, 0);   // PAPER-AUCTION-FIX 2026-10-02: each exit fill x its own filled quantity
      row.brokerPnl = +brokerPnl.toFixed(2);
      row.pnlGap = +(brokerPnl - (row.ourPnl ?? 0)).toFixed(2);
      if (Math.abs(row.pnlGap) > Math.max(5, Math.abs(row.ourPnl ?? 0) * 0.1)) out.fateGaps.push({ ticketId: r.ticketId, sym: r.sym, ourPnl: row.ourPnl, brokerPnl: row.brokerPnl, gap: row.pnlGap, ourReason: row.ourReason, brokerExitReason: row.brokerExitReason });
    }
    out.perTicket.push(row);
  }
  out.medianSlippagePct = med(out.fillGaps);
  out.reading = !out.filled ? "NOTHING FILLED YET — the mirror has not put a graded order on the broker's book"
    : out.fateGaps.length ? `${out.fateGaps.length} of ${out.filled} filled ticket(s) ended differently at the broker than in our ledger — each one is a defect in our record or in our exit modelling`
    : `broker and ledger agree on every closed ticket so far; median entry slippage ${out.medianSlippagePct}% against the ticket's claimed entry`;
  writeJsonAtomic(D("alpaca-reconcile.json"), out);
  console.log(`alpaca-reconcile — ${out.filled} filled, ${out.unfilled} unfilled, ${out.missingAtBroker} missing · ${out.reading}`);
})().catch((e) => { console.error("alpaca-reconcile FAILED:", e.message); process.exit(1); });
