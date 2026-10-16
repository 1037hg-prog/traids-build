#!/usr/bin/env node
/**
 * ALPACA RECONCILE (2026-09-22) — grade OUR ledger against the BROKER's record. For every ticket alpaca-mirror.js sent, ask Alpaca what
 * actually happened and compare it with what this repo believes:
 *   FILL GAP     broker fill price vs the ticket's claimed entry (the slippage our cost model only models)
 *   FATE GAP     the broker closed it (take-profit, stop, expiry) vs our ledger's exit and P&L for the same ticket
 *   MISSING      a mirrored order the broker has no record of, or a settled ticket whose mirror never filled
 * Reads only. It changes no ledger row and grades no test. Writes data/alpaca-reconcile.json for the nightly email.
 * PAPER-AUCTION-FIX 2026-10-02: quantities are the broker's filled_qty (entry and every exit fill), never the ordered qty or a status alone.
 * --split-eras (W5, server migration 2026-10, docs/server/wave5-board; fix 4 of the 10-09 review): out.eras reports the STALE era (mirrored
 *   before 2026-10-01: no exit pass existed while those tickets were open, and the 10-01 catch-up closed them) apart from the current one —
 *   never pooled — and the reading speaks for the current era; out.r24 counts R24 under ITS OWN mirror (r24-alpaca-mirror.js, BOOK account,
 *   graded in percent by data/r24-mirror.json): R24's 16:00 ET entries never pass through this mirror. It is ALSO on, without the flag, once
 *   data/host-ownership.json gives w5-chain to the server (this step's chain line is another package's anchor and cannot carry the flag).
 *   Without the flag and with W5 home-owned the output is unchanged.
 */
const fs = require("fs"), path = require("path"); require("dotenv").config({ path: path.join(__dirname, ".env") });
const D = (f) => path.join(__dirname, "data", f), LOG = D("alpaca-mirror.jsonl");
const BASE = "https://paper-api.alpaca.markets";
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const api = async (p) => { const r = await fetch(BASE + p, { headers: H }); if (!r.ok) throw new Error(`${r.status} on ${p.split("?")[0]}`); return r.json(); };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const SPLIT = process.argv.includes("--split-eras") || (() => { try { return JSON.parse(fs.readFileSync(D("host-ownership.json"), "utf8")).units["w5-chain"] === "server"; } catch { return false; } })(), STALE_BEFORE = "2026-10-01";   // W5 fix 4 (2026-10): the flag, or the board cell server-owned
/** W5 fix 4: R24 under its own mirror (counts only; files read, no broker call, no BOOK key) */
function r24Summary() {
  const jl = (f) => { try { return fs.readFileSync(D(f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { return null; } };
  const led = jl("r24-mirror-ledger.jsonl"); let status = null; try { status = JSON.parse(fs.readFileSync(D("r24-mirror.json"), "utf8")); } catch { status = null; }
  let tl = null; try { const t = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8")); tl = Array.isArray(t) ? t : t.trades; } catch { tl = null; }
  const board = Array.isArray(tl) ? tl.filter((t) => t && t.strategy === "R24-13F-clone") : [], closed = board.filter((t) => Number.isFinite(t.pnl) && t.closedAt);
  const o = { mirror: "backend/r24-alpaca-mirror.js (BOOK paper account; graded in percent by its own data/r24-mirror.json, never by this main-account reconcile)",
    ledgerRows: led ? led.length : null, orderRows: led ? led.filter((r) => r.kind === "order").length : null, fillRows: led ? led.filter((r) => r.kind === "fill").length : null,
    symbols: led ? [...new Set(led.map((r) => r.sym).filter(Boolean))].length : null, boardTickets: board.length, boardClosed: closed.length,
    boardClosedPnl: +closed.reduce((a, t) => a + t.pnl, 0).toFixed(2), statusAsOf: (status && (status.asOf || status.updatedAt)) || null };
  o.reading = led == null ? "no r24-mirror-ledger.jsonl" : `${o.orderRows} order row(s), ${o.fillRows} fill row(s) on ${o.symbols} name(s); the board holds ${board.length} R24 ticket(s), ${closed.length} closed ($${o.boardClosedPnl})`;
  return o;
}

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
  if (SPLIT) {   // W5 fix 4 of the 10-09 review (docs/server/wave5-board): the stale era apart, R24 counted under its own mirror
    const tsBy = new Map(rows.map((r) => [r.ticketId, String(r.ts || "")])), era = (id) => ((tsBy.get(id) || "") < STALE_BEFORE ? "stale" : "current");
    const agg = (name) => { const pt = out.perTicket.filter((p) => era(p.ticketId) === name), both = pt.filter((p) => Number.isFinite(p.brokerPnl) && Number.isFinite(p.ourPnl));
      return { mirrored: pt.length, filled: pt.filter((p) => p.brokerFill != null).length, unfilled: pt.filter((p) => p.issue === "never filled").length, fateGaps: out.fateGaps.filter((g) => era(g.ticketId) === name).length,
        paired: both.length, brokerPnl: +both.reduce((a, p) => a + p.brokerPnl, 0).toFixed(2), ourPnl: +both.reduce((a, p) => a + p.ourPnl, 0).toFixed(2) }; };
    out.eras = { rule: `stale = mirrored before ${STALE_BEFORE} (no exit pass existed while it was open; the 10-01 catch-up closed them); current = from ${STALE_BEFORE}`, stale: agg("stale"), current: agg("current") };
    out.r24 = r24Summary();
    const c = out.eras.current;
    out.reading = (!c.filled ? "current era: NOTHING FILLED YET" : c.fateGaps ? `current era: ${c.fateGaps} of ${c.filled} filled ticket(s) ended differently at the broker than in our ledger` : `current era: broker and ledger agree on every closed ticket (${c.paired} paired)`)
      + ` · stale era (before ${STALE_BEFORE}): ${out.eras.stale.paired} paired, broker $${out.eras.stale.brokerPnl} vs ours $${out.eras.stale.ourPnl} — reported apart, never pooled · R24 (own mirror): ${out.r24.reading}`;
  }
  writeJsonAtomic(D("alpaca-reconcile.json"), out);
  console.log(`alpaca-reconcile — ${out.filled} filled, ${out.unfilled} unfilled, ${out.missingAtBroker} missing · ${out.reading}`);
})().catch((e) => { console.error("alpaca-reconcile FAILED:", e.message); process.exit(1); });
