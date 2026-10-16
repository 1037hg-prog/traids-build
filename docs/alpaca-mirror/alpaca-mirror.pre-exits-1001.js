#!/usr/bin/env node
/**
 * ALPACA PAPER MIRROR (2026-09-22, operator: "do it all" after the watched one-share test). Sends each new SIGNAL ticket from the board to
 * the Alpaca PAPER account as a real order, so the broker — not this repo — keeps the record. Alpaca's statement then grades our ledger.
 *
 * WHAT IS MIRRORED. Equity signal tickets: a bracket order (market entry + take-profit limit + stop-loss), quantity from the ticket's own
 * size, direction from the ticket. Crypto tickets: a market entry only (Alpaca does not bracket crypto) with the exit left to the nightly
 * reconcile to flag. FX, futures and option spreads are NOT mirrored and are logged with the reason. Controls, vetoed shadows and sleeve
 * rows are never mirrored — only what the board actually claims as a signal.
 *
 * GUARDS, all fail-closed:
 *   · PAPER ONLY — the base URL must contain "paper-api"; anything else and the run refuses.
 *   · OFF SWITCH — data/alpaca-mirror-OFF (any file) stops the run immediately.
 *   · CAPS — at most MAX_PER_RUN orders a run, MAX_NOTIONAL per order; a ticket over the cap is skipped and logged, never trimmed.
 *   · ONCE — a ticket id already in data/alpaca-mirror.jsonl is never sent twice.
 *   · MARKET HOURS — equities only while Alpaca says the market is open.
 *   · --live is required to place anything. Without it the run prints what it would send and writes nothing.
 *
 *   node backend/alpaca-mirror.js            dry run
 *   node backend/alpaca-mirror.js --live     place the orders
 */
const fs = require("fs"), path = require("path"); require("dotenv").config({ path: path.join(__dirname, ".env") });
const D = (f) => path.join(__dirname, "data", f), LOG = D("alpaca-mirror.jsonl"), OFF = D("alpaca-mirror-OFF");
const BASE = "https://paper-api.alpaca.markets";
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, "content-type": "application/json" };
const LIVE = process.argv.includes("--live"), MAX_PER_RUN = 25, MAX_NOTIONAL = 25000, MAX_AGE_MIN = 45;
// LATE_MODE (2026-09-23, operator: "push them now flagged as late"): a one-off for tickets that were skipped ONLY for age. Every such order is
// stamped late:true, and alpaca-reconcile.js reports late rows apart — they test the plumbing and never grade a ticket's entry.
const LATE_MODE = process.argv.includes("--late");
// A ticket the operator has queued as a data defect (data/retire-requests.json) is never mirrored: the JUP dry run on 2026-09-22 would
// have bought a dead token with a real-looking price. A ticket older than MAX_AGE_MIN is also skipped — mirroring it would fill hours
// away from the price the ticket claims, which corrupts the very comparison this mirror exists to make.
const RETIRED_IDS = (() => { try { return new Set((JSON.parse(fs.readFileSync(D("retire-requests.json"), "utf8")).requests || []).flatMap((r) => r.ids || [])); } catch { return new Set(); } })();
if (!/paper-api/.test(BASE)) { console.error("refusing: base URL is not the paper endpoint"); process.exit(2); }
if (fs.existsSync(OFF)) { console.log("alpaca-mirror: OFF switch present (data/alpaca-mirror-OFF) — nothing sent"); process.exit(0); }
if (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET_KEY) { console.error("refusing: no Alpaca keys"); process.exit(2); }
const etDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const api = async (p, init) => { const r = await fetch(BASE + p, { headers: H, ...init }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 200)}`); return j; };
const r2 = (x) => Math.round(x * 100) / 100;

(async () => {
  const logRows = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  // in late mode a ticket skipped only for its age is eligible again; one that has an order, or was skipped for any other reason, is not
  const done = new Set(logRows.filter((r) => !LATE_MODE || r.orderId || !/min old/.test(r.skipped || "")).map((r) => r.ticketId));
  const board = JSON.parse(fs.readFileSync(D("board_positions.json"), "utf8"));
  const today = etDay(), startOfDayET = Date.parse(today + "T00:00:00-04:00");
  const fresh = board.filter((p) => p && !p.ctrl && !p.vetoShadow && p.addedAt >= startOfDayET && !done.has(p.id) && Number.isFinite(p.entry) && p.dir);
  const clock = await api("/v2/clock").catch(() => ({ is_open: false }));
  console.log(`alpaca-mirror ${LIVE ? "LIVE" : "DRY"} — ${fresh.length} new signal ticket(s) today (${today}); market ${clock.is_open ? "open" : "closed"}`);
  let sent = 0;
  for (const t of fresh) {
    const side = t.dir > 0 ? "buy" : "sell", row = { ts: new Date().toISOString(), ticketId: t.id, sym: t.sym, cls: t.cls, side, live: LIVE };
    const skip = (why) => { row.skipped = why; console.log(`  skip ${String(t.sym).padEnd(10)} ${why}`); if (LIVE) fs.appendFileSync(LOG, JSON.stringify(row) + "\n"); };
    if (sent >= MAX_PER_RUN) { skip(`run cap ${MAX_PER_RUN} reached`); continue; }
    if (RETIRED_IDS.has(t.id)) { skip("queued as a data defect by the operator — never mirrored"); continue; }
    const ageMin = (Date.now() - t.addedAt) / 60000;
    if (ageMin > MAX_AGE_MIN && !LATE_MODE) { skip(`ticket is ${Math.round(ageMin)} min old (cap ${MAX_AGE_MIN}) — a fill now would not match its entry`); continue; }
    row.ticketAgeMin = Math.round(ageMin); row.ticketEntry = t.entry; if (LATE_MODE && ageMin > MAX_AGE_MIN) row.late = true;
    if (t.cls === "Options" || t.cls === "FX" || t.cls === "Futures") { skip(`${t.cls} not mirrored (Alpaca paper: no FX/futures; option spreads are a separate build)`); continue; }
    if (t.cls === "Equity") {
      if (!clock.is_open) { skip("market closed"); continue; }
      const qty = Math.floor(Number(t.units) || 0); if (!(qty >= 1)) { skip("no whole-share size"); continue; }
      const notional = qty * t.entry; if (notional > MAX_NOTIONAL) { skip(`notional $${Math.round(notional)} over the $${MAX_NOTIONAL} cap`); continue; }
      const tp = Number(t.target), sl = Number(t.stop);
      const hasBracket = Number.isFinite(tp) && Number.isFinite(sl);
      // 2026-09-24 weekly-audit fix (safety + combinations lenses): bracket legs inherit the parent TIF — "day" killed every stop and target at the
      // close and left 16 positions unprotected overnight. Brackets go GTC so the exits live until one fills; an unbracketed order stays DAY.
      const body = { symbol: t.sym, qty: String(qty), side, type: "market", time_in_force: hasBracket ? "gtc" : "day",
        ...(Number.isFinite(tp) && Number.isFinite(sl) ? { order_class: "bracket", take_profit: { limit_price: String(r2(tp)) }, stop_loss: { stop_price: String(r2(sl)) } } : {}) };
      row.qty = qty; row.notional = Math.round(notional); row.bracket = !!body.order_class; row.takeProfit = Number.isFinite(tp) ? r2(tp) : null; row.stopLoss = Number.isFinite(sl) ? r2(sl) : null;
      if (!LIVE) { console.log(`  would ${side} ${qty} ${t.sym} ~$${Math.round(notional)}${body.order_class ? ` (bracket tp ${r2(tp)} / sl ${r2(sl)})` : " (no bracket: ticket has no target/stop)"}`); continue; }
      try { const o = await api("/v2/orders", { method: "POST", body: JSON.stringify(body) }); row.orderId = o.id; row.status = o.status; sent++; console.log(`  sent ${side} ${qty} ${t.sym} → ${o.id} (${o.status})`); }
      catch (e) { row.error = String(e.message).slice(0, 200); console.log(`  FAILED ${t.sym}: ${row.error}`); }
      fs.appendFileSync(LOG, JSON.stringify(row) + "\n"); continue;
    }
    if (t.cls === "Crypto") {
      const sym = String(t.sym).replace("/", "") .replace(/USD$/, "/USD");   // board "BTC/USD" -> Alpaca "BTC/USD"
      const qty = Number(t.units); if (!(qty > 0)) { skip("no size"); continue; }
      const notional = qty * t.entry; if (notional > MAX_NOTIONAL) { skip(`notional $${Math.round(notional)} over the cap`); continue; }
      if (t.dir < 0) { skip("crypto shorts are not available on Alpaca paper"); continue; }
      row.qty = qty; row.notional = Math.round(notional); row.bracket = false;
      if (!LIVE) { console.log(`  would buy ${qty} ${sym} ~$${Math.round(notional)} (no bracket on crypto; exits tracked by the reconcile)`); continue; }
      try { const o = await api("/v2/orders", { method: "POST", body: JSON.stringify({ symbol: sym, qty: String(qty), side: "buy", type: "market", time_in_force: "gtc" }) }); row.orderId = o.id; row.status = o.status; sent++; console.log(`  sent buy ${qty} ${sym} → ${o.id}`); }
      catch (e) { row.error = String(e.message).slice(0, 200); console.log(`  FAILED ${sym}: ${row.error}`); }
      fs.appendFileSync(LOG, JSON.stringify(row) + "\n"); continue;
    }
    skip(`class ${t.cls} not handled`);
  }
  console.log(`alpaca-mirror done — ${sent} order(s) ${LIVE ? "placed" : "(dry run: none placed)"}`);
})().catch((e) => { console.error("alpaca-mirror FAILED:", e.message); process.exit(1); });
