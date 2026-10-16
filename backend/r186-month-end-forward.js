#!/usr/bin/env node
/**
 * R186 — MONTH-END TREASURIES, FORWARD on the Alpaca PAPER account (registered 2026-09-24; rule frozen in data/test-registry.json).
 * R180's historical pass traded for real fills: BUY IEF on the 6th-to-last session of each month, SELL on the last session, each a DAY
 * MARKET order sent in the close-arm window (25..10 min before the close). $20,000 notional, whole shares. Paper endpoint only; OFF switch
 * data/r186-OFF.
 * PAPER-AUCTION-FIX 2026-10-02 (pre-evidence amendment; operator "yes" 2026-10-02): the orders were market-on-close (time_in_force "cls").
 *   Alpaca paper barely fills auction orders (cls buys since 08-01: 5 full / 4 partial / 16 none), and a partly filled auction order ends
 *   "expired" with filled_qty > 0. Now: (1) type "market", time_in_force "day", sent at the same moment; the clock is re-checked right before
 *   every POST (a day order sent after the close would queue for the next open). (2) Reconcile reads filled_qty / filled_avg_price, never
 *   status alone: an entry lot is filled_qty shares; an exit that fills short leaves a remainder that is re-sent at the next close-arm with a
 *   new client_order_id (-S2, -S3 ...); the exit price is the quantity-weighted filled_avg_price of its orders. (3) A client_order_id the
 *   broker already knows is adopted, never re-sent. State written by the v1 code (entryCid/exitCid/entryFill/exitFill) reads unchanged.
 *   (4) Shares sold after the month's last session are credited IEF's distribution when its ex-date falls between that session and the fill
 *   (IEF goes ex on the first session of each month); a window is scored at the first after-close after the month end and its last exit
 *   fill (Alpaca refuses SIP daily bars ending inside the last 15 minutes). (5) Paper calls retry an HTTP 429, ~22 s at most.
 *
 *   node backend/r186-month-end-forward.js --close-arm [--live]   25..10 min before the close (automation/intraday.bat, every fire; once a day)
 *   node backend/r186-month-end-forward.js --after-close          reconcile fills, score completed windows (close chain)
 *   node backend/r186-month-end-forward.js --status | --read      status / the one registered read (12 windows, read-once)
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f), STATE = D("r186-month-end.json"), LEDGER = D("r186-month-end.jsonl"), OFF = D("r186-OFF");
const BASE = "https://paper-api.alpaca.markets", SYM = "IEF", NOTIONAL = 20000, FIRST_MONTH = "2026-10";
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, "content-type": "application/json" };
const LIVE = process.argv.includes("--live"), mode = ["--close-arm", "--after-close", "--status", "--read"].find((m) => process.argv.includes(m)) || "--status";
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const api = async (p, init) => { if (!/paper-api/.test(BASE)) throw new Error("not the paper endpoint"); for (let i = 0; ; i++) { const r = await fetch(BASE + p, { headers: H, ...init }); const j = await r.json().catch(() => ({})); if (r.status === 429 && i < 4) { await new Promise((res) => setTimeout(res, 1500 * 2 ** i)); continue; } if (!r.ok) { const e = new Error(`${r.status} ${JSON.stringify(j).slice(0, 160)}`); e.status = r.status; throw e; } return j; } };   // PAPER-AUCTION-FIX 2026-10-02: shared main paper account - a 429 is retried 4 times (1.5+3+6+12 s); a 429 is never an accepted order and the cid blocks duplicates
const etNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, mins: (+p.hour % 24) * 60 + +p.minute }; };
const load = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { spec: "r186-state-v1", windows: {}, lastRun: {} });
const save = (s) => { s.asOf = new Date().toISOString(); writeJsonAtomic(STATE, s); };
const ledger = (o) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
async function monthSessions(ym) { const [y, m] = ym.split("-").map(Number); const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); return api(`/v2/calendar?start=${ym}-01&end=${end}`); }
// PAPER-AUCTION-FIX 2026-10-02: order plumbing. An order in any status outside TERMINAL is still working: left alone, re-checked next run.
const TERMINAL = ["filled", "canceled", "expired", "rejected", "done_for_day"];   // PAPER-AUCTION-FIX 2026-10-02
const byCid = async (cid) => { try { return await api(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(cid)}`); } catch (e) { if (e.status === 404) return null; throw e; } };   // PAPER-AUCTION-FIX 2026-10-02
const exitCidN = (w, n) => `r186-exit-${w.ym.replace("-", "")}${n > 1 ? "-S" + n : ""}`;   // PAPER-AUCTION-FIX 2026-10-02: 1st exit keeps the v1 cid; a remainder gets -S2, -S3 (Alpaca rejects a reused client_order_id)
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
// PAPER-AUCTION-FIX 2026-10-02: entry reconcile. filled_qty decides, never status alone: a terminal order with filled_qty > 0 is a lot of
// filled_qty shares (an "expired" partial included); filled_qty 0 is not-filled (its cid is then nulled as v1 did, kept as entryCidUnfilled:
// R235 waits on entryCid && entryFill == null). A lost or v1-nulled entryCid is looked up by its deterministic cid once, after the entry session.
async function refreshEntry(w) {
  if (w.entryFill != null || w.entryDone) return;
  if (!w.entryCid) {
    if (w.entryChecked || !(etNow().date > w.entryDay)) return;
    const o = await byCid(`r186-entry-${w.ym.replace("-", "")}`); w.entryChecked = true; if (!o) return;
    w.entryCid = o.client_order_id; if (w.qtyOrdered == null) w.qtyOrdered = +o.qty; ledger({ kind: "entry-adopted", ym: w.ym, cid: w.entryCid, status: o.status });
  }
  const o = await byCid(w.entryCid); if (!o) return console.log(`r186 ${w.ym}: entry ${w.entryCid} not found at the broker — re-checked next run`);
  if (!TERMINAL.includes(o.status)) return;                                                    // still working: re-checked next run
  const fq = +o.filled_qty || 0; w.entryStatus = o.status; w.entryDone = true;
  if (fq > 0) {
    w.entryFill = +o.filled_avg_price; w.qty = fq; w.entryFilledAt = o.filled_at; if (fq < +o.qty) w.entryPartial = { ordered: +o.qty, filled: fq, status: o.status };
    ledger({ kind: fq < +o.qty ? "entry-partial" : "entry-filled", ym: w.ym, px: w.entryFill, qty: fq, ordered: +o.qty, status: o.status });
  } else { ledger({ kind: "entry-not-filled", ym: w.ym, status: o.status, cid: w.entryCid }); w.entryCidUnfilled = w.entryCid; w.entryCid = null; }   // PAPER-AUCTION-FIX 2026-10-02: v1 semantics for consumers (R235 waits on entryCid && !entryFill); entryDone stops any re-lookup
}
// PAPER-AUCTION-FIX 2026-10-02: exit reconcile over every exit order of the window (a v1 window's exitCid becomes order #1). The exit is
// complete when the filled quantity reaches the lot; its price is the quantity-weighted filled_avg_price of the orders that filled.
async function refreshExits(w) {
  if (!w.exitOrders) w.exitOrders = w.exitCid ? [{ cid: w.exitCid, qty: w.qty }] : [];
  for (const x of w.exitOrders) {
    if (x.done) continue;
    const o = await byCid(x.cid); if (!o) { console.log(`r186 ${w.ym}: exit ${x.cid} not found at the broker — re-checked next run`); continue; }
    if (!TERMINAL.includes(o.status)) continue;                                                // still working: re-checked next run
    const fq = +o.filled_qty || 0;
    Object.assign(x, { done: true, status: o.status, qty: +o.qty, filledQty: fq, avgPx: fq > 0 ? +o.filled_avg_price : null, filledAt: o.filled_at || null });
    ledger({ kind: fq === 0 ? "exit-not-filled" : fq < x.qty ? "exit-partial" : "exit-filled", ym: w.ym, cid: x.cid, status: o.status, qty: x.qty, filledQty: fq, px: x.avgPx });
  }
  const got = w.exitOrders.filter((x) => x.filledQty > 0), fq = got.reduce((a, x) => a + x.filledQty, 0);
  w.exitFilledQty = fq; w.exitRemaining = Math.max(0, w.qty - fq);
  if (fq >= w.qty && w.exitFill == null) {
    w.exitFill = got.length === 1 ? got[0].avgPx : +(got.reduce((a, x) => a + x.filledQty * x.avgPx, 0) / fq).toFixed(6);
    w.exitFilledAt = got.map((x) => x.filledAt).filter(Boolean).sort().pop() || null;
    ledger({ kind: "exit-complete", ym: w.ym, px: w.exitFill, qty: fq, orders: got.length, ...(fq > w.qty ? { overfilled: fq - w.qty } : {}) });
  }
}
// PAPER-AUCTION-FIX 2026-10-02: one exit path for the scheduled exit, a partial-fill remainder and a missed exit fire: whatever is still
// held is sold by a DAY MARKET order at the next close-arm, each order with a new cid. Three zero-fill exit orders in a row stop the resends.
async function sendExit(w, date, closeMins) {
  for (let pass = 0; pass < 6; pass++) {
    await refreshExits(w); if (w.exitFill != null) return console.log(`r186 ${w.ym}: exit complete (${w.exitFilledQty} @ ${w.exitFill})`);
    if (w.exitOrders.some((x) => !x.done)) return console.log(`r186 ${w.ym}: an exit order is still open at the broker — re-checked next run`);
    if (stuck(w)) return console.log(`r186 ${w.ym}: EXIT STUCK — the last 3 exit orders filled nothing; ${w.exitRemaining} ${SYM} still held; not re-sending (operator)`);
    const remaining = w.qty - w.exitFilledQty, n = w.exitOrders.length + 1, cid = exitCidN(w, n), late = date > w.exitDay;
    if (!LIVE) return console.log(`r186 DRY SELL ${remaining} ${SYM} day market order (${cid})${late ? " — late exit" : ""}`);
    const r = await sendDay(cid, { symbol: SYM, qty: String(remaining), side: "sell" }, date, closeMins);
    if (r.refused) { ledger({ kind: "exit-refused", ym: w.ym, cid, why: r.refused }); return console.log(`r186 ${w.ym}: exit NOT sent — ${r.refused}`); }
    const sentOn = r.adopted && r.order.submitted_at ? etD(r.order.submitted_at) : date;   // PAPER-AUCTION-FIX 2026-10-02: an adopted order was sent when the broker says, not today
    w.exitOrders.push({ cid, qty: +r.order.qty, sentOn, late: sentOn > w.exitDay, tif: r.order.time_in_force, ...(r.adopted ? { adopted: true } : {}) }); if (!w.exitCid) w.exitCid = cid;
    ledger({ kind: r.adopted ? "exit-adopted" : "exit-sent", ym: w.ym, cid, qty: +r.order.qty, sentOn, late: sentOn > w.exitDay, tif: r.order.time_in_force });
    if (!r.adopted) return console.log(`r186 SENT SELL ${remaining} ${SYM} day market order (${cid})${late ? " — late exit" : ""}`);
  }
}

async function closeArm() {
  const now = etNow(), ym = now.date.slice(0, 7);
  if (ym < FIRST_MONTH) return console.log(`r186 close-arm: before the first window (${FIRST_MONTH})`);
  const cal = await monthSessions(ym), today = cal.find((c) => c.date === now.date); if (!today) return console.log("r186 close-arm: not a trading day");
  const [h, m] = today.close.split(":").map(Number), closeMins = h * 60 + m;
  if (now.mins < closeMins - 25 || now.mins > closeMins - 10) return console.log(`r186 close-arm: outside window (ET ${Math.floor(now.mins / 60)}:${String(now.mins % 60).padStart(2, "0")})`);
  const s = load(); if (s.lastRun.closeArm === now.date) return console.log("r186 close-arm: already ran today");
  const days = cal.map((c) => c.date), entryDay = days[days.length - 6], exitDay = days[days.length - 1], key = ym.replace("-", "");
  const w = (s.windows[ym] = s.windows[ym] || { ym, entryDay, exitDay });
  // PAPER-AUCTION-FIX 2026-10-02: a window whose exit is due has its entry reconciled here too, so a missed after-close never strands a lot
  for (const x of Object.values(s.windows)) if (x.entryFill == null && now.date >= x.exitDay) await refreshEntry(x);
  let due = false;   // PAPER-AUCTION-FIX 2026-10-02
  if (now.date === entryDay && !w.entryCid) {
    due = true;   // PAPER-AUCTION-FIX 2026-10-02
    if (fs.existsSync(OFF)) { ledger({ kind: "skipped", ym, why: "OFF switch" }); console.log("r186: OFF switch present — no entry"); }
    else {
      const q = await (await fetch(`https://data.alpaca.markets/v2/stocks/${SYM}/trades/latest?feed=sip`, { headers: H })).json(); const px = q?.trade?.p; if (!(px > 0)) throw new Error("no IEF price");
      const qty = Math.floor(NOTIONAL / px), cid = `r186-entry-${key}`;
      if (!LIVE) console.log(`r186 DRY BUY ${qty} ${SYM} day market order (${cid})`);   // PAPER-AUCTION-FIX 2026-10-02
      else {   // PAPER-AUCTION-FIX 2026-10-02: a DAY MARKET order sent now, in the close-arm window (was market-on-close: paper does not fill auction orders)
        const r = await sendDay(cid, { symbol: SYM, qty: String(qty), side: "buy" }, now.date, closeMins);
        if (r.refused) { ledger({ kind: "entry-refused", ym, cid, why: r.refused }); console.log(`r186 entry NOT sent — ${r.refused}`); }
        else {
          Object.assign(w, { entryCid: cid, qtyOrdered: +r.order.qty, priceAtArm: px, entryTif: r.order.time_in_force });
          ledger({ kind: r.adopted ? "entry-adopted" : "entry-sent", ym, cid, qty: +r.order.qty, px, tif: r.order.time_in_force });
          console.log(`r186 ${r.adopted ? "ADOPTED (already at the broker)" : "SENT"} BUY ${r.order.qty} ${SYM} ${r.order.time_in_force} market order (${cid})`);
        }
      }
    }
  }
  // PAPER-AUCTION-FIX 2026-10-02: the scheduled exit, a partial-fill remainder or a missed exit — every window still holding shares on or after its exit day
  for (const x of Object.values(s.windows)) if (x.entryFill != null && x.exitFill == null && now.date >= x.exitDay) { due = true; await sendExit(x, now.date, closeMins); }
  if (!due) console.log(`r186 close-arm: nothing due today (entry ${entryDay}, exit ${exitDay})`);   // PAPER-AUCTION-FIX 2026-10-02
  if (LIVE) s.lastRun.closeArm = now.date; save(s);
}
async function afterClose() {
  const s = load();
  for (const w of Object.values(s.windows)) {
    // PAPER-AUCTION-FIX 2026-10-02: reconcile from filled_qty / filled_avg_price, never from status alone (was: "filled" only, and an expired
    // partial was logged not-filled with its cid nulled, so the lot drifted from the broker)
    await refreshEntry(w);
    if (w.entryFill != null && w.exitFill == null && (w.exitCid || (w.exitOrders || []).length)) {   // PAPER-AUCTION-FIX 2026-10-02
      await refreshExits(w);
      if (w.exitFill == null && w.exitOrders.every((x) => x.done)) console.log(`r186 ${w.ym}: exit remainder ${w.exitRemaining} of ${w.qty} ${SYM} — ${stuck(w) ? "EXIT STUCK (3 zero-fill exit orders in a row; not re-sent; operator)" : `re-sent at the next close-arm (${exitCidN(w, w.exitOrders.length + 1)})`}`);
    }
    if (w.entryFill != null && w.exitFill != null && w.score == null) {
      const [y, m] = w.ym.split("-").map(Number), start = `${w.ym}-01`, end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      // PAPER-AUCTION-FIX 2026-10-02: scored at the first after-close after the month's last calendar day and the last exit fill. Alpaca refuses
      // SIP daily bars whose end is inside the last 15 minutes (403 measured 2026-10-02 16:40 ET for an end of today T23:00Z), which threw here
      // on the exit day before the reconcile was saved; by the next session that day's bar is also final.
      const scoreAfter = [end, w.exitFilledAt ? etD(w.exitFilledAt) : end].sort().pop();   // PAPER-AUCTION-FIX 2026-10-02
      if (!(etNow().date > scoreAfter)) { console.log(`r186 ${w.ym}: exit complete — scored at the first after-close after ${scoreAfter} (SIP daily bars)`); continue; }   // PAPER-AUCTION-FIX 2026-10-02
      const all = (await fetchBars([SYM], { start: new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10), end: end + "T23:00:00Z", feed: "sip", adjustment: "all", quiet: true })).bars[SYM] || [];
      const raw = (await fetchBars([SYM], { start, end: end + "T23:00:00Z", feed: "sip", adjustment: "raw", quiet: true })).bars[SYM] || [];
      const rets = []; for (let i = 1; i < all.length; i++) if (all[i].t.slice(0, 7) === w.ym) rets.push({ d: all[i].t.slice(0, 10), r: all[i].c / all[i - 1].c - 1 });
      const inWin = rets.filter((x) => x.d > w.entryDay && x.d <= w.exitDay), other = rets.filter((x) => !(x.d > w.entryDay && x.d <= w.exitDay));
      const modelWindow = inWin.reduce((p, x) => p * (1 + x.r), 1) - 1, drift = 5 * mean(other.map((x) => x.r));
      // distributions inside the window: total-return minus price return over the same days
      const rc = (d) => raw.find((b) => b.t.slice(0, 10) === d)?.c, pxWin = rc(w.exitDay) / rc(w.entryDay) - 1, dist = Number.isFinite(pxWin) ? modelWindow - pxWin : 0;
      // PAPER-AUCTION-FIX 2026-10-02: shares sold after exitDay (a remainder or a missed exit fire) were held through IEF's ex-date - the first
      // session of every month - so they are credited that distribution: the registered "any IEF distribution with an ex-date inside the
      // window". Keyed on the broker's filled_at. Per share = raw close at exitDay x (1 - adjustment factor at exitDay / factor at the fill day).
      let lateDist = 0, lateGap = null;   // PAPER-AUCTION-FIX 2026-10-02
      for (const x of (w.exitOrders || []).filter((x) => x.filledQty > 0 && x.filledAt && etD(x.filledAt) > w.exitDay)) {   // PAPER-AUCTION-FIX 2026-10-02
        const d = etD(x.filledAt), q = { start: w.exitDay, end: d + "T23:00:00Z", feed: "sip", quiet: true };   // PAPER-AUCTION-FIX 2026-10-02
        const A = (await fetchBars([SYM], { ...q, adjustment: "all" })).bars[SYM] || [], R = (await fetchBars([SYM], { ...q, adjustment: "raw" })).bars[SYM] || [];   // PAPER-AUCTION-FIX 2026-10-02
        const c = (bs, dd) => bs.find((k) => k.t.slice(0, 10) === dd)?.c, fac = (dd) => c(A, dd) / c(R, dd);   // PAPER-AUCTION-FIX 2026-10-02
        const perShare = c(R, w.exitDay) * (1 - fac(w.exitDay) / fac(d));   // PAPER-AUCTION-FIX 2026-10-02: $ distributed per share with an ex-date in (exitDay, d]
        if (!Number.isFinite(perShare)) { lateGap = `${x.cid} (${d})`; break; }   // PAPER-AUCTION-FIX 2026-10-02
        lateDist += (perShare / w.entryFill) * (x.filledQty / w.qty);   // PAPER-AUCTION-FIX 2026-10-02
      }
      if (lateGap) { console.error(`r186 ${w.ym}: NOT SCORED — no IEF bars for the late exit ${lateGap}; re-tried next run`); process.exitCode = 1; continue; }   // PAPER-AUCTION-FIX 2026-10-02: loud; never a score without the credit
      const fillRet = w.exitFill / w.entryFill - 1 + dist + lateDist;   // PAPER-AUCTION-FIX 2026-10-02: + lateDist (0 unless shares were sold after exitDay)
      w.score = { fillToFill: +fillRet.toFixed(6), modelWindow: +modelWindow.toFixed(6), distributionAdj: +dist.toFixed(6), drift: +drift.toFixed(6), excess: +(fillRet - drift).toFixed(6), slippage: +(fillRet - modelWindow).toFixed(6), pnl: +((w.exitFill - w.entryFill) * w.qty).toFixed(2) };
      const xo = (w.exitOrders || []).filter((x) => x.filledQty > 0);   // PAPER-AUCTION-FIX 2026-10-02: execution facts beside the score (the statistic is unchanged)
      Object.assign(w.score, { exitOrders: xo.length || 1, lateExit: xo.some((x) => x.late), lateDist: +lateDist.toFixed(6), partialEntry: !!w.entryPartial });   // PAPER-AUCTION-FIX 2026-10-02
      ledger({ kind: "window-scored", ym: w.ym, ...w.score });
    }
  }
  save(s); status(s);
}
function status(s = load()) {
  const done = Object.values(s.windows).filter((w) => w.score), ex = done.map((w) => w.score.excess);
  const t = ex.length >= 3 ? mean(ex) / (Math.sqrt(ex.reduce((a, x) => a + (x - mean(ex)) ** 2, 0) / (ex.length - 1)) / Math.sqrt(ex.length)) : null;
  console.log(`R186 — ${done.length}/12 windows scored${done.length ? ` · mean excess ${(100 * mean(ex)).toFixed(3)}%/window${t != null ? ` t ${t.toFixed(2)}` : ""} · mean slippage ${(100 * mean(done.map((w) => w.score.slippage))).toFixed(3)}% · P&L $${done.reduce((a, w) => a + w.score.pnl, 0).toFixed(0)}` : ""}`);
  return { done, t };
}
async function read() {
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests || seals).R186) return console.error("R186 already sealed — refusing");
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((x) => x.id === "R186"), { done, t } = status();
  if (done.length < 12) return console.error(`R186 read condition not met (${done.length}/12)`);
  const verdict = t >= E.bar.tRequired ? `PASS — t ${t.toFixed(3)} >= ${E.bar.tRequired} over ${done.length} windows` : `DID NOT PASS — t ${t.toFixed(3)} vs ${E.bar.tRequired}`;
  (seals.tests || seals).R186 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "monthly windows", verdict }; writeJsonAtomic(D("read-seals.json"), seals);
  E.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R186", verdict }) + "\n"); console.log(`R186 READ — ${verdict}`);
}
(async () => { if (mode === "--close-arm") return closeArm(); if (mode === "--after-close") return afterClose(); if (mode === "--read") return read(); status(); })().catch((e) => { console.error("r186 FAILED:", e.message); process.exit(1); });
