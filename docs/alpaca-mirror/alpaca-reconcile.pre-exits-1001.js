#!/usr/bin/env node
/**
 * ALPACA RECONCILE (2026-09-22) — grade OUR ledger against the BROKER's record. For every ticket alpaca-mirror.js sent, ask Alpaca what
 * actually happened and compare it with what this repo believes:
 *   FILL GAP     broker fill price vs the ticket's claimed entry (the slippage our cost model only models)
 *   FATE GAP     the broker closed it (take-profit, stop, expiry) vs our ledger's exit and P&L for the same ticket
 *   MISSING      a mirrored order the broker has no record of, or a settled ticket whose mirror never filled
 * Reads only. It changes no ledger row and grades no test. Writes data/alpaca-reconcile.json for the nightly email.
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
  const out = { spec: "alpaca-reconcile-v1", asOf: new Date().toISOString(), mirrored: rows.length, lateOrdersNotGraded: lateRows.length, filled: 0, unfilled: 0, missingAtBroker: 0, fillGaps: [], fateGaps: [], perTicket: [] };
  for (const r of rows) {
    let o = null; try { o = await api(`/v2/orders/${r.orderId}?nested=true`); } catch { out.missingAtBroker++; out.perTicket.push({ ticketId: r.ticketId, sym: r.sym, issue: "broker has no record of this order" }); continue; }
    const fill = Number(o.filled_avg_price) || null;
    if (!fill) { out.unfilled++; out.perTicket.push({ ticketId: r.ticketId, sym: r.sym, brokerStatus: o.status, issue: "never filled" }); continue; }
    out.filled++;
    const slipPct = r.ticketEntry ? +(100 * (fill / r.ticketEntry - 1) * (r.side === "buy" ? 1 : -1)).toFixed(4) : null;   // positive = we paid worse than the ticket claimed
    if (slipPct != null) out.fillGaps.push(slipPct);
    const legs = (o.legs || []).filter((l) => Number(l.filled_avg_price) > 0);
    const exitLeg = legs.find((l) => l.status === "filled");
    const t = byId.get(r.ticketId);
    const row = { ticketId: r.ticketId, sym: r.sym, side: r.side, qty: r.qty, ticketEntry: r.ticketEntry, brokerFill: fill, slippagePct: slipPct,
      brokerExit: exitLeg ? Number(exitLeg.filled_avg_price) : null, brokerExitReason: exitLeg ? exitLeg.order_type : null,
      ourExit: t && Number.isFinite(t.exit) ? t.exit : null, ourPnl: t && Number.isFinite(t.pnl) ? t.pnl : null, ourReason: t ? t.reason : null };
    if (row.brokerExit != null && row.ourExit != null) {
      const brokerPnl = (row.brokerExit - fill) * (r.side === "buy" ? 1 : -1) * r.qty;
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
