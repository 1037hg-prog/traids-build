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
 * EXITS (2026-10-01, operator "fix"). Each run FIRST follows the board out: a mirrored ticket that the trade log shows CLOSED and that is
 * still open at the broker has its bracket legs cancelled and its OWN quantity closed at market (client id mx-<ticket>; once per ticket;
 * data/alpaca-mirror-exits.jsonl). Never a whole symbol — the main paper account is shared with other strategies. Fail-closed: a ticket in
 * neither the board nor the trade log is left for the operator; equity exits only while the market is open. Why: the board closes most
 * tickets within hours, the bracket legs did not, and by 10-01 the account held $221k of stale positions with no buying power left.
 * PAPER-AUCTION-FIX 2026-10-02: the ticket's own close orders are read before the attribution check, from filled_qty; a close that ends
 * expired/canceled/done_for_day with filled_qty > 0 is partial and its remainder is re-sent as mx-<ticket>-S2, -S3 (then the operator).
 * The final row carries closeQty / closeFill (fill-weighted over the close orders) for alpaca-reconcile.js. Legs the mirror cancelled ITSELF
 * before a close the broker refused are not "closed elsewhere": the close is retried (broker position checked first), 3 refusals -> the operator.
 *
 *   node backend/alpaca-mirror.js               dry run (exits + entries)
 *   node backend/alpaca-mirror.js --live        place the orders
 *   node backend/alpaca-mirror.js --exits-only  [--live]  only the exit pass
 *   node backend/alpaca-mirror.js --live --htb-day   W5 (server migration 2026-10, docs/server/wave5-board; fix 3 of the 10-09 mirror review; the VPS
 *        units pass it, home never does): an equity entry Alpaca refuses with 422 "only day orders are allowed for hard-to-borrow asset" is
 *        re-sent ONCE as the same order with time_in_force "day" (row htbDay: true, firstError kept; a 422 is never an accepted order). Its
 *        bracket legs then end at the close, so the exit pass treats such a row like legs the mirror cut itself: the broker position must
 *        still cover the ticket's quantity in its direction, else the operator. Without the flag nothing changes.
 */
const fs = require("fs"), path = require("path"); require("dotenv").config({ path: path.join(__dirname, ".env") });
const D = (f) => path.join(__dirname, "data", f), LOG = D("alpaca-mirror.jsonl"), OFF = D("alpaca-mirror-OFF");
const BASE = "https://paper-api.alpaca.markets";
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, "content-type": "application/json" };
const LIVE = process.argv.includes("--live"), MAX_PER_RUN = 25, MAX_NOTIONAL = 25000, MAX_AGE_MIN = 45;
const HTB_DAY = process.argv.includes("--htb-day");   // W5 fix 3 (2026-10, docs/server/wave5-board): the VPS units only
const htbDayRefusal = (m) => /^422 /.test(String(m)) && /only day orders are allowed for hard-to-borrow/i.test(String(m));
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
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const EXITS = D("alpaca-mirror-exits.jsonl"), MAX_EXITS_PER_RUN = 100, TERM = ["filled", "canceled", "expired", "rejected", "replaced"];
// the main paper account is shared and busy (200 req/min across every runner): pace the exit pass and retry 429s (a 429 is never an accepted order)
const apiR = async (p, init) => { for (let i = 0; ; i++) { try { return await api(p, init); } catch (e) { if (!/^429/.test(e.message) || i >= 5) throw e; await sleep(1500 * 2 ** i); } } };
const legFilled = (o) => (o.legs || []).reduce((s, l) => s + (Number(l.filled_qty) || 0), 0);
// PAPER-AUCTION-FIX 2026-10-02: a ticket's close orders are mx-<ticket> (attempt 1, as before), then mx-<ticket>-S2, -S3 for a remainder —
// Alpaca refuses a reused client_order_id. An exit that ends expired/canceled/done_for_day with filled_qty > 0 is a PARTIAL close.
const MAX_EXIT_ATTEMPTS = 3, EXIT_DONE = [...TERM, "done_for_day"];
const mxCid = (ticketId, n) => (n > 1 ? `${("mx-" + ticketId).slice(0, 124)}-S${n}` : ("mx-" + ticketId).slice(0, 128));
async function closeAttempts(ticketId) {   // every close order this mirror sent for the ticket, attempt order; null when a lookup failed (retry next run)
  const out = [];
  for (let n = 1; n <= MAX_EXIT_ATTEMPTS; n++) {
    let e; try { e = await apiR(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(mxCid(ticketId, n))}`); } catch (err) { if (/^404/.test(err.message)) break; return null; }
    if (!e || !e.id) break; out.push(e);
  }
  return out;
}
async function exitPhase(clock, logRows) {   // 2026-10-01: the broker follows the board out (see the header)
  const prior = fs.existsSync(EXITS) ? fs.readFileSync(EXITS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const done = new Set(prior.filter((x) => x.final).map((x) => x.ticketId));
  const board = JSON.parse(fs.readFileSync(D("board_positions.json"), "utf8")); if (!Array.isArray(board)) throw new Error("board_positions.json is not an array — exit pass refuses");
  const onBoard = new Set(board.filter(Boolean).map((p) => p.id));
  const tl = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8")), closed = new Map((Array.isArray(tl) ? tl : tl.trades || []).filter((t) => t && t.id).map((t) => [t.id, t]));
  const cands = logRows.filter((x) => x.orderId && x.live && !done.has(x.ticketId) && !onBoard.has(x.ticketId));
  console.log(`alpaca-mirror exits — ${cands.length} mirrored ticket(s) no longer on the board`);
  let n = 0; const avail = {};
  for (const x of cands) {
    if (n >= MAX_EXITS_PER_RUN) { console.log(`  exit cap ${MAX_EXITS_PER_RUN} reached — the rest next run`); break; }
    await sleep(300); const row = { ts: new Date().toISOString(), ticketId: x.ticketId, sym: x.sym, cls: x.cls, entryOrderId: x.orderId, live: LIVE };
    const say = (why) => console.log(`  exit ${String(x.sym).padEnd(10)} ${why}`);
    const rec = (why, final) => { row.action = why; row.final = !!final; say(why); if (LIVE) fs.appendFileSync(EXITS, JSON.stringify(row) + "\n"); };
    const t = closed.get(x.ticketId); if (!t) { say("not on the board and not in the trade log — left for the operator"); continue; }
    row.boardExit = Number.isFinite(t.exit) ? t.exit : null; row.boardClosedAt = t.closedAt || null; row.boardReason = t.reason || null;
    let o; try { o = await apiR(`/v2/orders/${x.orderId}?nested=true`); } catch (e) { say("entry order lookup failed: " + String(e.message).slice(0, 80)); continue; }
    const q = Number(o.filled_qty) || 0;
    if (!(q > 0)) { if (TERM.includes(o.status)) rec(`entry never filled (${o.status}) — nothing to close`, true); else say(`entry still ${o.status} — waiting`); continue; }
    let rem = q - legFilled(o); row.entryFilledQty = q;
    if (rem <= 1e-9) { const l = (o.legs || []).find((y) => y.status === "filled"); row.legExit = l ? Number(l.filled_avg_price) : null; rec("already closed at the broker by its bracket leg", true); continue; }
    const crypto = x.cls === "Crypto";
    // PAPER-AUCTION-FIX 2026-10-02: this mirror's OWN close orders are read FIRST, from filled_qty. Before, the bracket legs this pass had cancelled
    // to send the close made the ticket look "closed elsewhere" on the next run (all 39 closes of 10-01 were finalised that way, their fills
    // never read), and an exit that expired with filled_qty > 0 was called "without a fill". A partial close re-sends the remainder (new id).
    const mx = await closeAttempts(x.ticketId);
    if (mx === null) { say("close-order lookup failed — retry next run"); continue; }
    if (mx.length) {
      const last = mx[mx.length - 1], target = Number(mx[0].qty) || 0, got = mx.reduce((a, e) => a + (Number(e.filled_qty) || 0), 0);
      Object.assign(row, { closeOrderId: last.id, status: last.status, closeCids: mx.map((e) => e.client_order_id), closeTarget: target, closeQty: got, closeFill: got > 0 ? mx.reduce((a, e) => a + (Number(e.filled_qty) || 0) * (Number(e.filled_avg_price) || 0), 0) / got : null });
      if (!EXIT_DONE.includes(last.status)) { say(`exit order ${last.client_order_id} working (${last.status}, filled ${last.filled_qty || 0})`); continue; }
      const left = crypto ? +(target - got).toFixed(9) : Math.round(target - got);
      if (!(left > 1e-9)) { row.qty = got; rec(`closed (exit order${mx.length > 1 ? "s" : ""} filled ${got}${mx.length > 1 ? ` over ${mx.length} orders` : ""})`, true); continue; }
      if (mx.length >= MAX_EXIT_ATTEMPTS) { rec(`exit filled ${got} of ${target} over ${mx.length} orders (${last.status}) — ${left} left for the operator`, true); continue; }
      if (!crypto && !clock.is_open) { say(`exit filled ${got} of ${target} (${last.status}) — the remainder ${left} waits for the market open`); continue; }
      const side = x.side === "buy" ? "sell" : "buy", cidN = mxCid(x.ticketId, mx.length + 1); let qtyN = left;
      if (crypto) { const ps = String(x.sym).replace("/", ""); if (avail[ps] == null) { const p = await apiR(`/v2/positions/${encodeURIComponent(ps)}`).catch(() => null); avail[ps] = p ? Number(p.qty_available) || 0 : 0; }
        qtyN = Math.min(qtyN, avail[ps]); if (!(qtyN > 0)) { rec(`exit filled ${got} of ${target} — no crypto quantity left at the broker for the remainder`, true); continue; } avail[ps] -= qtyN; }
      row.qty = qtyN; row.side = side;
      if (!LIVE) { say(`would ${side} the remainder ${qtyN} as ${cidN} (exit filled ${got} of ${target}, ${last.status})`); continue; }
      try { const c = await apiR("/v2/orders", { method: "POST", body: JSON.stringify({ symbol: x.sym, qty: String(qtyN), side, type: "market", time_in_force: crypto ? "gtc" : "day", client_order_id: cidN }) });
        row.closeOrderId = c.id; row.status = c.status; n++; rec(`exit filled ${got} of ${target} (${last.status}) — remainder ${side} ${qtyN} sent as ${cidN} (${c.status}); final once it fills`, false); }
      catch (e) { row.error = String(e.message).slice(0, 200); rec("remainder close order FAILED: " + row.error, false); }
      continue;
    }
    // ATTRIBUTION (fail-closed): only a ticket whose bracket legs are still LIVE at the broker provably still holds its quantity (the legs reserve it).
    // Legs that expired/cancelled unfilled (the pre-09-24 DAY brackets, flattened by hand on 09-24) and crypto mirrored before 10-01 (no legs; the
    // account's crypto is shared with R191/R231) are not attributable: recorded once and left alone.
    const liveLegs = (o.legs || []).filter((l) => !TERM.includes(l.status));
    // PAPER-AUCTION-FIX 2026-10-02: legs THIS mirror cancelled before a close the broker then refused (403 wash trade, 429s out of retries) or that were
    // slow to cancel leave no mx order, and they are not "closed elsewhere": the quantity is still the ticket's. Those runs wrote a non-final row
    // (legsCancelledByMirror, or "close order FAILED"); the close is retried under mx-<ticket> (never created) — after MAX_EXIT_ATTEMPTS refusals, the operator.
    const selfCut = prior.filter((p) => p.ticketId === x.ticketId && !p.final && (p.legsCancelledByMirror || /^close order FAILED/.test(p.action || "")));   // PAPER-AUCTION-FIX 2026-10-02
    const refused = selfCut.filter((p) => /^close order FAILED/.test(p.action || "")).length;   // PAPER-AUCTION-FIX 2026-10-02: only a refused close counts as an attempt (a slow cancel does not)
    if (!crypto && !liveLegs.length && selfCut.length && refused >= MAX_EXIT_ATTEMPTS) { rec(`close refused ${refused} times after the mirror cancelled the legs — ${Math.round(rem)} left for the operator`, true); continue; }   // PAPER-AUCTION-FIX 2026-10-02
    if (!crypto && !liveLegs.length && !selfCut.length && !(HTB_DAY && x.htbDay === true)) { rec("bracket legs ended unfilled — the position was closed elsewhere (09-24 flatten) or is not attributable; left alone", true); continue; }   // PAPER-AUCTION-FIX 2026-10-02: only when the mirror did not cancel them itself   // W5 fix 3: an --htb-day DAY bracket's legs END at the close — never 'closed elsewhere'
    if (crypto && String(x.ts) < "2026-10-01") { rec("crypto mirrored before 10-01 — not attributable on the shared account; left for the operator", true); continue; }
    if (!crypto && !clock.is_open) { say("board closed it — waits for the market open"); continue; }
    if (!crypto && !liveLegs.length) {   // PAPER-AUCTION-FIX 2026-10-02: a retry after the mirror cut the legs itself — no leg reserves the quantity now, so the broker position must still cover it in the ticket direction, else the operator
      const want = x.side === "buy" ? "long" : "short", need = Math.round(rem), k = `eq:${x.sym}:${want}`;   // PAPER-AUCTION-FIX 2026-10-02: per-run allowance, so two such tickets on one symbol cannot both claim the same shares
      if (avail[k] == null) { let pos = null; try { pos = await apiR(`/v2/positions/${encodeURIComponent(x.sym)}`); } catch (e) { if (!/^404/.test(e.message)) { say("position lookup failed — retry next run"); continue; } }   // PAPER-AUCTION-FIX 2026-10-02
        avail[k] = pos && pos.side === want ? Math.abs(Number(pos.qty_available ?? pos.qty)) || 0 : 0; }   // PAPER-AUCTION-FIX 2026-10-02
      if (avail[k] < need) { rec(`the mirror cancelled the legs, but the ${want} position at the broker (${avail[k]}) no longer covers ${need} — left for the operator`, true); continue; }   // PAPER-AUCTION-FIX 2026-10-02
      avail[k] -= need;   // PAPER-AUCTION-FIX 2026-10-02
    }
    const cid = mxCid(x.ticketId, 1);   // PAPER-AUCTION-FIX 2026-10-02: no close order exists yet (read above, before the attribution check)
    const open = (o.legs || []).filter((l) => !TERM.includes(l.status));
    if (LIVE && open.length) {
      row.legsCancelledByMirror = true;   // PAPER-AUCTION-FIX 2026-10-02: from here on the legs are this mirror's doing — every row below says so, so a later run never reads them as "closed elsewhere"
      let settled = false;
      try {   // PAPER-AUCTION-FIX 2026-10-02: a failed cancel/settle read writes a non-final row and moves on (before: the throw ended the whole exit pass with no row)
        for (const l of open) await apiR(`/v2/orders/${l.id}`, { method: "DELETE" }).catch((e) => { if (!/^(404|422)/.test(e.message)) throw e; });
        for (let i = 0; i < 12 && !settled; i++) { await sleep(500); const o2 = await apiR(`/v2/orders/${x.orderId}?nested=true`); if ((o2.legs || []).every((l) => TERM.includes(l.status))) { settled = true; rem = q - legFilled(o2); } }
      } catch (e) { row.error = String(e.message).slice(0, 200); process.exitCode = 1; rec("bracket-leg cancel FAILED: " + row.error + " — retry next run", false); continue; }   // PAPER-AUCTION-FIX 2026-10-02
      if (!settled) { rec("bracket legs did not cancel in 6 s — retry next run", false); continue; }   // PAPER-AUCTION-FIX 2026-10-02: a non-final row (was console only), so the next run knows these legs were cancelled here
      if (rem <= 1e-9) { rec("a leg filled while cancelling — closed by its bracket", true); continue; }
    }
    const side = x.side === "buy" ? "sell" : "buy"; let qty = crypto ? rem : Math.round(rem);
    if (crypto) { const ps = String(x.sym).replace("/", ""); if (avail[ps] == null) { const p = await apiR(`/v2/positions/${encodeURIComponent(ps)}`).catch(() => null); avail[ps] = p ? Number(p.qty_available) || 0 : 0; }
      qty = Math.min(qty, avail[ps]); if (!(qty > 0)) { rec("no crypto quantity left at the broker to sell", true); continue; } avail[ps] -= qty; }
    row.qty = qty; row.side = side;
    if (!LIVE) { say(`would ${side} ${qty} at market to close (board closed it ${t.closedAt ? new Date(t.closedAt).toISOString().slice(0, 16) + "Z" : ""}, ${t.reason || ""}); open legs ${open.length}`); continue; }
    try { const c = await apiR("/v2/orders", { method: "POST", body: JSON.stringify({ symbol: x.sym, qty: String(qty), side, type: "market", time_in_force: crypto ? "gtc" : "day", client_order_id: cid }) });
      row.closeOrderId = c.id; row.status = c.status; n++; rec(`close ${side} ${qty} sent (${c.status}) — final once it fills`, false); }
    catch (e) { row.error = String(e.message).slice(0, 200); rec("close order FAILED: " + row.error, false); }
  }
  console.log(`alpaca-mirror exits done — ${n} close order(s) ${LIVE ? "placed" : "(dry run: none placed)"}`);
}

(async () => {
  const logRows = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  // in late mode a ticket skipped only for its age is eligible again; one that has an order, or was skipped for any other reason, is not
  const done = new Set(logRows.filter((r) => !LATE_MODE || r.orderId || !/min old/.test(r.skipped || "")).map((r) => r.ticketId));
  const board = JSON.parse(fs.readFileSync(D("board_positions.json"), "utf8"));
  const today = etDay(), startOfDayET = Date.parse(today + "T00:00:00-04:00");
  const fresh = board.filter((p) => p && !p.ctrl && !p.vetoShadow && p.addedAt >= startOfDayET && !done.has(p.id) && Number.isFinite(p.entry) && p.dir);
  const clock = await api("/v2/clock").catch(() => ({ is_open: false }));
  try { await exitPhase(clock, logRows); } catch (e) { console.error("alpaca-mirror exit pass FAILED:", e.message); process.exitCode = 1; }   // exits first: they free the buying power the entries need
  if (process.argv.includes("--exits-only")) return;
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
      catch (e) {
        // W5 fix 3 (2026-10, docs/server/wave5-board; --htb-day only): Alpaca refuses a GTC short of a hard-to-borrow name (422 "only day
        // orders are allowed for hard-to-borrow asset"); a 422 is never an accepted order, so the same order is re-sent ONCE as DAY.
        if (HTB_DAY && htbDayRefusal(e.message) && body.time_in_force !== "day") {
          row.firstError = String(e.message).slice(0, 200); row.htbDay = true; row.tif = "day";
          try { const o = await api("/v2/orders", { method: "POST", body: JSON.stringify({ ...body, time_in_force: "day" }) }); row.orderId = o.id; row.status = o.status; sent++; console.log(`  sent ${side} ${qty} ${t.sym} as DAY (hard-to-borrow: GTC refused) → ${o.id} (${o.status})`); }
          catch (e2) { row.error = String(e2.message).slice(0, 200); console.log(`  FAILED ${t.sym} (DAY re-send): ${row.error}`); }
        } else { row.error = String(e.message).slice(0, 200); console.log(`  FAILED ${t.sym}: ${row.error}`); }
      }
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
