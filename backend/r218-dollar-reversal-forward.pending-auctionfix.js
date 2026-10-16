#!/usr/bin/env node
/**
 * R218 — MONTH-END DOLLAR REVERSAL, FORWARD on the Alpaca PAPER account (registered 2026-09-24, amended pre-evidence the same day to
 * R216 variant B; rule frozen in data/test-registry.json). On the 4th-to-last session of each month, by a DAY MARKET order sent in the
 * close-arm window (25..12 min before the close): take $10,000 of UUP AGAINST its month-to-date move (short if UUP rose since the previous
 * month's last close, long if it fell); flatten the same way on the month's last session. Whole shares. Paper endpoint only; OFF switch
 * data/r218-OFF. Pattern: r186.
 * PAPER-AUCTION-FIX 2026-10-02 (pre-evidence amendment; operator "yes" 2026-10-02): the orders were market-on-close (time_in_force "cls").
 *   Alpaca paper barely fills auction orders (cls buys since 08-01: 5 full / 4 partial / 16 none), and a partly filled auction order ends
 *   "expired" with filled_qty > 0. Now: (1) type "market", time_in_force "day", sent at the same moment; the clock is re-checked right before
 *   every POST (a day order sent after the close would queue for the next open). (2) Reconcile reads filled_qty / filled_avg_price, never
 *   status alone: an entry lot is filled_qty shares; an exit that fills short leaves a remainder that is re-sent at the next close-arm with a
 *   new client_order_id (-S2, -S3 ...); the exit price is the quantity-weighted filled_avg_price of its orders. (3) A client_order_id the
 *   broker already knows is adopted, never re-sent. State written by the v1 code (entryCid/exitCid/entryFill/exitFill) reads unchanged.
 *   (4) Paper calls retry an HTTP 429, ~22 s at most (the main paper account is shared with the mirror).
 *
 *   node backend/r218-dollar-reversal-forward.js --close-arm [--live]   25..12 min before the close (automation/intraday.bat; once a day)
 *   node backend/r218-dollar-reversal-forward.js --after-close          reconcile fills, score completed months (close chain)
 *   node backend/r218-dollar-reversal-forward.js --status | --read      status / the one registered read (24 months, read-once)
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f), STATE = D("r218-dollar-reversal.json"), LEDGER = D("r218-dollar-reversal.jsonl"), OFF = D("r218-OFF");
const BASE = "https://paper-api.alpaca.markets", SYM = "UUP", NOTIONAL = 10000, FIRST_MONTH = "2026-10", READ_N = 24;
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, "content-type": "application/json" };
const LIVE = process.argv.includes("--live"), mode = ["--close-arm", "--after-close", "--status", "--read"].find((m) => process.argv.includes(m)) || "--status";
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, tOf = (a) => (a.length >= 3 ? mean(a) / (Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)) / Math.sqrt(a.length)) : null);
const api = async (p, init) => { if (!/paper-api/.test(BASE)) throw new Error("not the paper endpoint"); for (let i = 0; ; i++) { const r = await fetch(BASE + p, { headers: H, ...init }); const j = await r.json().catch(() => ({})); if (r.status === 429 && i < 4) { await new Promise((res) => setTimeout(res, 1500 * 2 ** i)); continue; } if (!r.ok) { const e = new Error(`${r.status} ${JSON.stringify(j).slice(0, 160)}`); e.status = r.status; throw e; } return j; } };   // PAPER-AUCTION-FIX 2026-10-02: shared main paper account - a 429 is retried 4 times (1.5+3+6+12 s); a 429 is never an accepted order and the cid blocks duplicates
const etNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, mins: (+p.hour % 24) * 60 + +p.minute }; };
const load = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { spec: "r218-state-v1", months: {}, lastRun: {} });
const save = (s) => { s.asOf = new Date().toISOString(); writeJsonAtomic(STATE, s); };
const ledger = (o) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
const prevYm = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };
async function monthSessions(ym) { const [y, m] = ym.split("-").map(Number); const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); return api(`/v2/calendar?start=${ym}-01&end=${end}`); }
// PAPER-AUCTION-FIX 2026-10-02: order plumbing. An order in any status outside TERMINAL is still working: left alone, re-checked next run.
const TERMINAL = ["filled", "canceled", "expired", "rejected", "done_for_day"];   // PAPER-AUCTION-FIX 2026-10-02
const byCid = async (cid) => { try { return await api(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(cid)}`); } catch (e) { if (e.status === 404) return null; throw e; } };   // PAPER-AUCTION-FIX 2026-10-02
const exitCidN = (w, n) => `r218-exit-${w.ym.replace("-", "")}${n > 1 ? "-S" + n : ""}`;   // PAPER-AUCTION-FIX 2026-10-02: 1st exit keeps the v1 cid; a remainder gets -S2, -S3 (Alpaca rejects a reused client_order_id)
const stuck = (w) => { const t = (w.exitOrders || []).slice(-3); return t.length === 3 && t.every((x) => x.done && !(x.filledQty > 0)); };   // PAPER-AUCTION-FIX 2026-10-02: 3 zero-fill exits in a row
const hhmm = (mins) => `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;   // PAPER-AUCTION-FIX 2026-10-02
const etD = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });   // PAPER-AUCTION-FIX 2026-10-02: a broker timestamp's ET session date
// PAPER-AUCTION-FIX 2026-10-02: every order is a DAY MARKET order. A cid the broker already knows is adopted, never re-sent (a crash between
// the POST and the state save). A day market order that reaches the broker after the close would queue for the NEXT open, so the ET clock
// and Alpaca's own clock are both re-checked immediately before the POST; either one failing refuses the send (logged, nothing sent).
async function sendDay(cid, order, date, closeMins) {
  const prior = await byCid(cid); if (prior) return { order: prior, adopted: true };
  const n = etNow(); if (n.date !== date || n.mins >= closeMins - 2) return { refused: `ET ${n.date} ${hhmm(n.mins)} is not before ${hhmm(closeMins - 2)}` };
  const ck = await api("/v2/clock"); if (!ck.is_open) return { refused: "Alpaca clock says the market is closed" };
  return { order: await api("/v2/orders", { method: "POST", body: JSON.stringify({ ...order, type: "market", time_in_force: "day", client_order_id: cid }) }) };   // PAPER-AUCTION-FIX 2026-10-02: was time_in_force "cls"
}
// PAPER-AUCTION-FIX 2026-10-02: entry reconcile. filled_qty decides, never status alone: a terminal order with filled_qty > 0 is a position
// of filled_qty shares (an "expired" partial included); filled_qty 0 is not-filled. A lost or v1-nulled entryCid is looked up by its
// deterministic cid once, after the entry session (the side of the order it finds gives the direction if the state never recorded it).
async function refreshEntry(w) {
  if (w.entryFill != null || w.entryDone) return;
  if (!w.entryCid) {
    if (w.entryChecked || !(etNow().date > w.entryDay)) return;
    const o = await byCid(`r218-entry-${w.ym.replace("-", "")}`); w.entryChecked = true; if (!o) return;
    w.entryCid = o.client_order_id; if (w.qtyOrdered == null) w.qtyOrdered = +o.qty; ledger({ kind: "entry-adopted", ym: w.ym, cid: w.entryCid, side: o.side, status: o.status });
  }
  const o = await byCid(w.entryCid); if (!o) return console.log(`r218 ${w.ym}: entry ${w.entryCid} not found at the broker — re-checked next run`);
  if (w.dir == null) w.dir = o.side === "buy" ? 1 : -1;
  if (!TERMINAL.includes(o.status)) return;                                                    // still working: re-checked next run
  const fq = +o.filled_qty || 0; w.entryStatus = o.status; w.entryDone = true;
  if (fq > 0) {
    w.entryFill = +o.filled_avg_price; w.qty = fq; w.entryFilledAt = o.filled_at; if (fq < +o.qty) w.entryPartial = { ordered: +o.qty, filled: fq, status: o.status };
    ledger({ kind: fq < +o.qty ? "entry-partial" : "entry-filled", ym: w.ym, side: o.side, px: w.entryFill, qty: fq, ordered: +o.qty, status: o.status });
  } else ledger({ kind: "entry-not-filled", ym: w.ym, status: o.status });
}
// PAPER-AUCTION-FIX 2026-10-02: exit reconcile over every exit order of the month (a v1 month's exitCid becomes order #1). The exit is
// complete when the filled quantity reaches the position; its price is the quantity-weighted filled_avg_price of the orders that filled.
async function refreshExits(w) {
  if (!w.exitOrders) w.exitOrders = w.exitCid ? [{ cid: w.exitCid, qty: w.qty }] : [];
  for (const x of w.exitOrders) {
    if (x.done) continue;
    const o = await byCid(x.cid); if (!o) { console.log(`r218 ${w.ym}: exit ${x.cid} not found at the broker — re-checked next run`); continue; }
    if (!TERMINAL.includes(o.status)) continue;                                                // still working: re-checked next run
    const fq = +o.filled_qty || 0;
    Object.assign(x, { done: true, status: o.status, qty: +o.qty, filledQty: fq, avgPx: fq > 0 ? +o.filled_avg_price : null, filledAt: o.filled_at || null });
    ledger({ kind: fq === 0 ? "exit-not-filled" : fq < x.qty ? "exit-partial" : "exit-filled", ym: w.ym, cid: x.cid, side: o.side, status: o.status, qty: x.qty, filledQty: fq, px: x.avgPx });
  }
  const got = w.exitOrders.filter((x) => x.filledQty > 0), fq = got.reduce((a, x) => a + x.filledQty, 0);
  w.exitFilledQty = fq; w.exitRemaining = Math.max(0, w.qty - fq);
  if (fq >= w.qty && w.exitFill == null) {
    w.exitFill = got.length === 1 ? got[0].avgPx : +(got.reduce((a, x) => a + x.filledQty * x.avgPx, 0) / fq).toFixed(6);
    w.exitFilledAt = got.map((x) => x.filledAt).filter(Boolean).sort().pop() || null;
    ledger({ kind: "exit-complete", ym: w.ym, px: w.exitFill, qty: fq, orders: got.length, ...(fq > w.qty ? { overfilled: fq - w.qty } : {}) });
  }
}
// PAPER-AUCTION-FIX 2026-10-02: one exit path for the scheduled flatten, a partial-fill remainder and a missed exit fire: whatever is still
// open is closed by a DAY MARKET order at the next close-arm, each order with a new cid. Three zero-fill exit orders in a row stop the resends.
async function sendExit(w, date, closeMins) {
  for (let pass = 0; pass < 6; pass++) {
    await refreshExits(w); if (w.exitFill != null) return console.log(`r218 ${w.ym}: exit complete (${w.exitFilledQty} @ ${w.exitFill})`);
    if (w.exitOrders.some((x) => !x.done)) return console.log(`r218 ${w.ym}: an exit order is still open at the broker — re-checked next run`);
    if (stuck(w)) return console.log(`r218 ${w.ym}: EXIT STUCK — the last 3 exit orders filled nothing; ${w.exitRemaining} ${SYM} still open; not re-sending (operator)`);
    const remaining = w.qty - w.exitFilledQty, n = w.exitOrders.length + 1, cid = exitCidN(w, n), late = date > w.exitDay, side = w.dir === -1 ? "buy" : "sell";
    if (!LIVE) return console.log(`r218 DRY ${side.toUpperCase()} ${remaining} ${SYM} day market order to flatten (${cid})${late ? " — late exit" : ""}`);
    const r = await sendDay(cid, { symbol: SYM, qty: String(remaining), side }, date, closeMins);
    if (r.refused) { ledger({ kind: "exit-refused", ym: w.ym, cid, why: r.refused }); return console.log(`r218 ${w.ym}: exit NOT sent — ${r.refused}`); }
    const sentOn = r.adopted && r.order.submitted_at ? etD(r.order.submitted_at) : date;   // PAPER-AUCTION-FIX 2026-10-02: an adopted order was sent when the broker says, not today
    w.exitOrders.push({ cid, qty: +r.order.qty, sentOn, late: sentOn > w.exitDay, tif: r.order.time_in_force, ...(r.adopted ? { adopted: true } : {}) }); if (!w.exitCid) w.exitCid = cid;
    ledger({ kind: r.adopted ? "exit-adopted" : "exit-sent", ym: w.ym, cid, side: r.order.side, qty: +r.order.qty, sentOn, late: sentOn > w.exitDay, tif: r.order.time_in_force });
    if (!r.adopted) return console.log(`r218 SENT ${side.toUpperCase()} ${remaining} ${SYM} day market order to flatten (${cid})${late ? " — late exit" : ""}`);
  }
}

async function closeArm() {
  const now = etNow(), ym = now.date.slice(0, 7);
  if (ym < FIRST_MONTH) return console.log(`r218 close-arm: before the first month (${FIRST_MONTH})`);
  const cal = await monthSessions(ym), today = cal.find((c) => c.date === now.date); if (!today) return console.log("r218 close-arm: not a trading day");
  const [h, m] = today.close.split(":").map(Number), closeMins = h * 60 + m;
  // PAPER-AUCTION-FIX 2026-10-02: window unchanged (25..12 min before the close). It was cut at -12 for Alpaca's 15:50 ET market-on-close
  // cutoff; a day market order has no cutoff but must reach the broker BEFORE the close or it queues for the next open — sendDay re-checks
  if (now.mins < closeMins - 25 || now.mins > closeMins - 12) return console.log(`r218 close-arm: outside window (ET ${Math.floor(now.mins / 60)}:${String(now.mins % 60).padStart(2, "0")})`);
  const s = load(); if (s.lastRun.closeArm === now.date) return console.log("r218 close-arm: already ran today");
  const days = cal.map((c) => c.date), entryDay = days[days.length - 4], exitDay = days[days.length - 1], key = ym.replace("-", "");
  const w = (s.months[ym] = s.months[ym] || { ym, entryDay, exitDay });
  // PAPER-AUCTION-FIX 2026-10-02: a month whose exit is due has its entry reconciled here too, so a missed after-close never strands a position
  for (const x of Object.values(s.months)) if (x.entryFill == null && now.date >= x.exitDay) await refreshEntry(x);
  let due = false;   // PAPER-AUCTION-FIX 2026-10-02
  if (now.date === entryDay && !w.entryCid) {
    due = true;   // PAPER-AUCTION-FIX 2026-10-02
    if (fs.existsSync(OFF)) { ledger({ kind: "skipped", ym, why: "OFF switch" }); console.log("r218: OFF switch present — no entry"); }
    else {
      const pc = await monthSessions(prevYm(ym)), prevLast = pc[pc.length - 1].date;
      const pb = (await fetchBars([SYM], { start: prevLast, end: prevLast + "T23:00:00Z", feed: "sip", adjustment: "raw", quiet: true })).bars[SYM] || [];
      const prevClose = pb.find((b) => b.t.slice(0, 10) === prevLast)?.c; if (!(prevClose > 0)) throw new Error(`no UUP close for ${prevLast}`);
      const q = await (await fetch(`https://data.alpaca.markets/v2/stocks/${SYM}/trades/latest?feed=sip`, { headers: H })).json(); const px = q?.trade?.p; if (!(px > 0)) throw new Error("no UUP price");
      const signal = px / prevClose - 1;
      if (signal === 0) { ledger({ kind: "skipped", ym, why: "zero month-to-date signal" }); console.log("r218: zero signal — no entry"); }
      else {
        const side = signal > 0 ? "sell" : "buy", dir = signal > 0 ? -1 : 1, qty = Math.floor(NOTIONAL / px), cid = `r218-entry-${key}`;
        if (!LIVE) console.log(`r218 DRY ${side.toUpperCase()} ${qty} ${SYM} day market order (${cid}) · month-to-date ${(100 * signal).toFixed(2)}%`);   // PAPER-AUCTION-FIX 2026-10-02
        else {   // PAPER-AUCTION-FIX 2026-10-02: a DAY MARKET order sent now, in the close-arm window (was market-on-close: paper does not fill auction orders)
          const r = await sendDay(cid, { symbol: SYM, qty: String(qty), side }, now.date, closeMins);
          if (r.refused) { ledger({ kind: "entry-refused", ym, cid, why: r.refused }); console.log(`r218 entry NOT sent — ${r.refused}`); }
          else {
            const d = r.adopted ? (r.order.side === "buy" ? 1 : -1) : dir;   // an adopted order keeps the side it was sent with
            Object.assign(w, { entryCid: cid, dir: d, qtyOrdered: +r.order.qty, priceAtArm: px, prevClose, signal: +signal.toFixed(6), entryTif: r.order.time_in_force });
            ledger({ kind: r.adopted ? "entry-adopted" : "entry-sent", ym, cid, side: r.order.side, qty: +r.order.qty, px, prevClose, signal, tif: r.order.time_in_force });
            console.log(`r218 ${r.adopted ? "ADOPTED (already at the broker)" : "SENT"} ${r.order.side.toUpperCase()} ${r.order.qty} ${SYM} ${r.order.time_in_force} market order (${cid}) · month-to-date ${(100 * signal).toFixed(2)}%`);
          }
        }
      }
    }
  }
  // PAPER-AUCTION-FIX 2026-10-02: the scheduled flatten, a partial-fill remainder or a missed exit — every month still open on or after its exit day
  for (const x of Object.values(s.months)) if (x.entryFill != null && x.exitFill == null && now.date >= x.exitDay) { due = true; await sendExit(x, now.date, closeMins); }
  if (!due) console.log(`r218 close-arm: nothing due today (entry ${entryDay}, exit ${exitDay})`);   // PAPER-AUCTION-FIX 2026-10-02
  if (LIVE) s.lastRun.closeArm = now.date; save(s);
}
async function afterClose() {
  const s = load();
  for (const w of Object.values(s.months)) {
    // PAPER-AUCTION-FIX 2026-10-02: reconcile from filled_qty / filled_avg_price, never from status alone (was: "filled" only, and an expired
    // partial was logged not-filled with its cid nulled, so the position drifted from the broker)
    await refreshEntry(w);
    if (w.entryFill != null && w.exitFill == null && (w.exitCid || (w.exitOrders || []).length)) {   // PAPER-AUCTION-FIX 2026-10-02
      await refreshExits(w);
      if (w.exitFill == null && w.exitOrders.every((x) => x.done)) console.log(`r218 ${w.ym}: exit remainder ${w.exitRemaining} of ${w.qty} ${SYM} — ${stuck(w) ? "EXIT STUCK (3 zero-fill exit orders in a row; not re-sent; operator)" : `re-sent at the next close-arm (${exitCidN(w, w.exitOrders.length + 1)})`}`);
    }
    if (w.entryFill != null && w.exitFill != null && w.score == null) {
      const pnl = w.dir * (w.exitFill - w.entryFill) * w.qty;
      w.score = { ret: +(pnl / NOTIONAL).toFixed(6), signedFillReturn: +(w.dir * (w.exitFill / w.entryFill - 1)).toFixed(6), pnl: +pnl.toFixed(2), hit: pnl > 0 };
      const xo = (w.exitOrders || []).filter((x) => x.filledQty > 0);   // PAPER-AUCTION-FIX 2026-10-02: execution facts beside the score (the statistic is unchanged)
      Object.assign(w.score, { exitOrders: xo.length || 1, lateExit: xo.some((x) => x.late), partialEntry: !!w.entryPartial });   // PAPER-AUCTION-FIX 2026-10-02
      ledger({ kind: "month-scored", ym: w.ym, ...w.score });
    }
  }
  save(s); status(s);
}
function status(s = load()) {
  const done = Object.values(s.months).filter((w) => w.score), r = done.map((w) => w.score.ret), t = tOf(r);
  console.log(`R218 — ${done.length}/${READ_N} months scored${done.length ? ` · mean ${(100 * mean(r)).toFixed(3)}%/month${t != null ? ` t ${t.toFixed(2)}` : ""} · hits ${done.filter((w) => w.score.hit).length}/${done.length} · P&L $${done.reduce((a, w) => a + w.score.pnl, 0).toFixed(0)}` : ""}`);
  return { done, r, t };
}
async function read() {
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests || seals).R218) return console.error("R218 already sealed — refusing");
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((x) => x.id === "R218"), { done, r, t } = status();
  if (done.length < READ_N) return console.error(`R218 read condition not met (${done.length}/${READ_N})`);
  // random-sign books on the same months and fills (200 draws, seeded)
  let a = 218000 >>> 0; const rng = () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const draws = []; for (let k = 0; k < 200; k++) draws.push(tOf(r.map((x) => (rng() < 0.5 ? 1 : -1) * Math.abs(x)))); draws.sort((x, y) => x - y); const p95 = draws[190];
  const verdict = t >= E.bar.tRequired && t > p95 ? `PASS — t ${t.toFixed(3)} >= ${E.bar.tRequired} over ${done.length} months, placebo p95 ${p95.toFixed(3)}` : `DID NOT PASS — t ${t.toFixed(3)} vs ${E.bar.tRequired}, placebo p95 ${p95.toFixed(3)}`;
  (seals.tests || seals).R218 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "months", verdict }; writeJsonAtomic(D("read-seals.json"), seals);
  E.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R218", verdict }) + "\n"); console.log(`R218 READ — ${verdict}`);
}
(async () => { if (mode === "--close-arm") return closeArm(); if (mode === "--after-close") return afterClose(); if (mode === "--read") return read(); status(); })().catch((e) => { console.error("r218 FAILED:", e.message); process.exit(1); });
