#!/usr/bin/env node
/**
 * BOOK REBALANCER — Plan E's ETF sleeves run as ONE book on the Alpaca PAPER account (built 2026-09-26; rebuilt the same day on the
 * operator's word: "build the full rebalancer; more correctly executed automation is welcome"). Known allocation rules, not a
 * registered test (operator 09-25).
 *
 * THE BOOK. A sub-book with its own cash and holdings inside the shared paper account: starting capital BOOK_CAPITAL, cash moves with
 *   every fill, NAV = cash + sum(holdings x last close). Weights are fractions of the book's NAV, so gains compound and losses shrink
 *   positions. Trend sleeves (10-month rule, adjustment=all, month-end closes incl. the current one): QQQ, SPY, GLD, EFA — IN when the
 *   month-end close is above the average of the last 10 month-end closes, else that sleeve's weight parks in SGOV (since 09-28; was cash). DBMF and JAAA (the cash buffer, since 09-28) are always held.
 * SCHEDULE (after the close, from the close chain, every trading day):
 *   - reconcile yesterday's fills into the book (cash and holdings from filled qty x filled price);
 *   - on the LAST trading day of the month: recompute the trend signals and rebalance every sleeve to target;
 *   - on other days: rebalance only sleeves that drifted outside the band (|held$ - target$| > max(10% of target, $500)), so trading
 *     costs stay low and nothing churns.
 * EXECUTION. Decisions use completed closes only (the last daily bar must be today's). Orders are DAY market orders queued after the close for the next (opg dropped 2026-09-28: rejected after 09:28 ET and expiring unfilled on paper)
 *   session, whole shares, client_order_id "book-<date>-<sym>-<side>", sells before buys in the plan; buys are scaled down pro rata if
 *   they exceed the book's cash plus same-batch sell proceeds or 85% of the account's buying power. Paper endpoint only, asserted.
 *   OFF switch data/book-etf-OFF -> signals and targets are reported, no orders.
 *   PAPER-AUCTION-FIX 2026-10-02: fills were already read from filled_qty (a partial lands in holdings/cash as filled); now each POST stands
 *   alone — a refused order is recorded, the orders already sent stay in pending, a re-sent client id is adopted, and the day is not marked
 *   done (exit 1) until every order went through. See docs/paper-auction-fix/2026-10-02/.
 *   node backend/book-etf-rebalancer.js --after-close [--live]   the daily run (close chain passes --live)
 *   node backend/book-etf-rebalancer.js --plan [YYYY-MM-DD]      targets from the last completed session, no orders
 *   node backend/book-etf-rebalancer.js --reconcile | --status
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f), STATE = D("book-etf-state.json"), LEDGER = D("book-etf-ledger.jsonl"), OFF = D("book-etf-OFF");
const BASE = "https://paper-api.alpaca.markets";
// 2026-09-29 (operator set up a dedicated paper account): the Plan E book trades in ITS OWN Alpaca paper account, so its capital and
// record are not squeezed by the test lanes (the shared account's buying power had fallen to ~$6.7k). No fallback to the shared
// account: without the book keys the orders are refused (the api() guard below), never sent elsewhere. Market DATA still comes
// through lib/alpaca-bars.js on the main keys — data is account-independent.
if (!process.env.ALPACA_BOOK_KEY_ID || !process.env.ALPACA_BOOK_SECRET_KEY) console.warn("book: ALPACA_BOOK_KEY_ID / ALPACA_BOOK_SECRET_KEY missing — broker calls will be refused");
const H = { "APCA-API-KEY-ID": process.env.ALPACA_BOOK_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_BOOK_SECRET_KEY, "content-type": "application/json" };
// Plan E on a $100k book: $65k ETF sleeves + $8k JAAA cash buffer = $73k here (ZN and crypto run elsewhere; ~$12k stays as cash/SGOV
// at the futures broker for margin). 2026-09-28 (operator: "yes" to JAAA/SGOV): JAAA (AAA CLO, floating) holds the permanent buffer;
// a trend sleeve that is OUT parks its weight in SGOV (0-3 month Treasuries) instead of uninvested cash — OUT money must stay truly safe.
const BOOK_CAPITAL = 73000;
const SLEEVES = { QQQ: { w: 15 / 73, rule: "trend10m" }, SPY: { w: 15 / 73, rule: "trend10m" }, GLD: { w: 10 / 73, rule: "trend10m" }, EFA: { w: 10 / 73, rule: "trend10m" }, DBMF: { w: 15 / 73, rule: "hold" }, JAAA: { w: 8 / 73, rule: "hold" }, SGOV: { w: 0, rule: "park" } };
const BAND_FRAC = 0.10, BAND_MIN_USD = 500;
const mode = ["--plan", "--after-close", "--reconcile", "--status"].find((m) => process.argv.includes(m)) || "--status", LIVE = process.argv.includes("--live");
const api = async (p, init) => { if (!/paper-api/.test(BASE)) throw new Error("not the paper endpoint"); if (!H["APCA-API-KEY-ID"]) throw new Error("no book account keys — refusing (no fallback to the shared account)"); const r = await fetch(BASE + p, { headers: H, ...init }); const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(`${r.status} ${JSON.stringify(j).slice(0, 160)}`); e.status = r.status; throw e; } return j; };
const load = () => { const s = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {}; return { spec: "book-state-v2", cash: BOOK_CAPITAL, holdings: {}, signals: {}, signalsAsOf: null, runs: {}, pending: [], navHistory: [], ...s }; };
const save = (s) => { s.asOf = new Date().toISOString(); writeJsonAtomic(STATE, s); };
const ledger = (o) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
const etNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, mins: (+p.hour % 24) * 60 + +p.minute }; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const monthCal = async (ym) => { const [y, m] = ym.split("-").map(Number); return api(`/v2/calendar?start=${ym}-01&end=${new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)}`); };

/** closes as of `asOfDate` (must be a completed session) + 10-month trend signals */
async function market(asOfDate) {
  const start = new Date(Date.parse(asOfDate) - 420 * 864e5).toISOString().slice(0, 10);
  const endIso = new Date(Math.min(Date.parse(asOfDate + "T23:00:00Z"), Date.now() - 20 * 60e3)).toISOString();   /* 2026-09-29: SIP refuses (403) any window ending within ~15 min of now; 23:00Z was still in the future at the 16:15 ET run */
  const r = await fetchBars(Object.keys(SLEEVES), { start, end: endIso, feed: "sip", adjustment: "all", quiet: true });
  if ((r.truncatedStart || []).length) throw new Error("history truncated — refusing");
  const px = {}, sig = {};
  for (const [sym, cfg] of Object.entries(SLEEVES)) {
    const bars = r.bars[sym] || []; if (!bars.length) throw new Error(`no bars for ${sym}`);
    const last = bars[bars.length - 1]; if (last.t.slice(0, 10) !== asOfDate) throw new Error(`${sym}: last bar ${last.t.slice(0, 10)} is not ${asOfDate} — refusing (forming or missing)`);
    px[sym] = last.c;
    if (cfg.rule === "trend10m") { const me = {}; for (const b of bars) me[b.t.slice(0, 7)] = b.c; const c = Object.keys(me).sort().map((k) => me[k]); if (c.length < 10) throw new Error(`${sym}: fewer than 10 month-ends`); const avg = mean(c.slice(-10)); sig[sym] = { on: c[c.length - 1] > avg, close: +c[c.length - 1].toFixed(2), avg10: +avg.toFixed(2) }; }
    else if (cfg.rule === "park") sig[sym] = { on: true, park: true };
    else sig[sym] = { on: true, hold: true };
  }
  return { px, sig };
}
function book(s, px) { const pos = {}; let inv = 0; for (const sym of Object.keys(SLEEVES)) { const q = s.holdings[sym] || 0; pos[sym] = q * px[sym]; inv += pos[sym]; } return { nav: s.cash + inv, pos }; }
function plan(s, px, sig, full) {
  const { nav, pos } = book(s, px), orders = [], lines = [];
  const parkW = Object.entries(SLEEVES).filter(([k, c]) => c.rule === "trend10m" && !sig[k].on).reduce((a, [, c]) => a + c.w, 0);   // OUT sleeves -> SGOV
  for (const [sym, cfg] of Object.entries(SLEEVES)) {
    const tgtUsd = cfg.rule === "park" ? parkW * nav : sig[sym].on ? cfg.w * nav : 0, heldUsd = pos[sym], gap = tgtUsd - heldUsd, band = Math.max(BAND_FRAC * Math.max(tgtUsd, heldUsd), BAND_MIN_USD);
    const act = full ? Math.abs(gap) >= px[sym] : Math.abs(gap) > band || (tgtUsd === 0 && heldUsd > 0);
    const qty = act ? Math.trunc(gap / px[sym]) : 0;
    lines.push({ sym, signal: SLEEVES[sym].rule === "hold" ? "HOLD" : SLEEVES[sym].rule === "park" ? "PARK" : sig[sym].on ? "IN" : "OUT", targetUsd: Math.round(tgtUsd), heldUsd: Math.round(heldUsd), qty });
    if (qty) orders.push({ sym, side: qty > 0 ? "buy" : "sell", qty: Math.abs(qty), px: px[sym] });
  }
  orders.sort((a, b) => (a.side === b.side ? 0 : a.side === "sell" ? -1 : 1));   // sells first
  return { nav, orders, lines };
}
async function afterClose() {
  const now = etNow(), ym = now.date.slice(0, 7), cal = await monthCal(ym), today = cal.find((c) => c.date === now.date);
  if (!today) return console.log("book: not a trading day");
  const [ch, cm] = today.close.split(":").map(Number); if (now.mins < ch * 60 + cm + 5) return console.log("book: before the close — waiting for final closes");
  await reconcile(true);
  const s = load(); if (s.runs[now.date]) return console.log(`book: ${now.date} already ran`);
  const monthEnd = now.date === cal[cal.length - 1].date, { px, sig } = await market(now.date);
  if (monthEnd || !s.signalsAsOf) { s.signals = sig; s.signalsAsOf = now.date; }   // signals change only at month-end (or on the first run)
  const useSig = Object.fromEntries(Object.keys(SLEEVES).map((k) => [k, s.signals[k] || sig[k]]));
  const full = monthEnd || Object.keys(s.holdings).length === 0;
  const p = plan(s, px, useSig, full);
  s.navHistory = s.navHistory.filter((x) => x.date !== now.date);   // PAPER-AUCTION-FIX 2026-10-02: a re-run of an unfinished day replaces its NAV row, never duplicates it
  s.navHistory.push({ date: now.date, nav: +p.nav.toFixed(2) }); if (s.navHistory.length > 400) s.navHistory.shift();
  const off = fs.existsSync(OFF);
  // cash check: buys limited to book cash + this batch's sell proceeds, and to 85% of account buying power
  const sellUsd = p.orders.filter((o) => o.side === "sell").reduce((a, o) => a + o.qty * o.px, 0), buyUsd = p.orders.filter((o) => o.side === "buy").reduce((a, o) => a + o.qty * o.px, 0);
  let cap = s.cash + sellUsd; if (!off && LIVE && buyUsd > 0) { const acct = await api("/v2/account"); cap = Math.min(cap, 0.85 * +acct.buying_power); }
  let scale = 1; if (buyUsd > cap && buyUsd > 0) { scale = Math.max(0, cap / buyUsd); for (const o of p.orders) if (o.side === "buy") o.qty = Math.floor(o.qty * scale); }
  const sent = [], refused = [];   // PAPER-AUCTION-FIX 2026-10-02
  for (const o of p.orders.filter((x) => x.qty > 0)) {
    const cid = `book-${now.date.replace(/-/g, "")}-${o.sym}-${o.side}`;
    // 2026-09-28: "day" market orders, not "opg". Alpaca REJECTS opg orders submitted 09:28-19:00 ET (this runs ~16:15 ET), and on this
    // paper account 60 of 71 pre-open opg orders expired unfilled at 09:31. A day market order sent after the close is queued for the next open.
    if (LIVE && !off) {
      // PAPER-AUCTION-FIX 2026-10-02: a refused POST no longer throws away the record of the orders already sent. Each order is POSTed on its own;
      // a failed POST (or a same-day re-run, which re-sends the same client id — Alpaca refuses a reused one) is read back by client id and the
      // existing order adopted; pending is saved after every order. A refused SELL refuses the batch's buys (they were sized on its proceeds).
      if (o.side === "buy" && refused.some((x) => x.side === "sell")) { refused.push({ cid, side: o.side, why: "a sell of this batch was refused" }); ledger({ kind: "order-refused", date: now.date, cid, ...o, why: "a sell of this batch was refused — buys sized on its proceeds are not sent" }); console.log(`  NOT SENT ${cid}: a sell of this batch was refused`); continue; }
      let ord = null, err = null;
      try { ord = await api("/v2/orders", { method: "POST", body: JSON.stringify({ symbol: o.sym, qty: String(o.qty), side: o.side, type: "market", time_in_force: "day", client_order_id: cid }) }); }
      catch (e) { err = e; ord = await api(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(cid)}`).catch(() => null); }
      if (!ord || !ord.id) { refused.push({ cid, side: o.side, why: String(err && err.message).slice(0, 160) }); ledger({ kind: "order-rejected", date: now.date, cid, ...o, error: String(err && err.message).slice(0, 160) }); console.log(`  REJECTED ${cid}: ${String(err && err.message).slice(0, 160)}`); continue; }
      if (!s.pending.some((x) => x.cid === cid)) s.pending.push({ cid, sym: o.sym, side: o.side, qty: o.qty });
      ledger({ kind: err ? "order-adopted" : "order-sent", date: now.date, cid, ...o, ...(err ? { brokerStatus: ord.status } : {}) }); save(s);
    }
    sent.push(`${o.side.toUpperCase()} ${o.qty} ${o.sym}`);
  }
  // PAPER-AUCTION-FIX 2026-10-02: a day with a refused order is saved (pending kept) but NOT marked done, and the step exits non-zero as it did
  // when the POST threw — a re-run the same evening re-plans and adopts the orders already sent by client id instead of duplicating them
  if (LIVE && refused.length) { save(s); process.exitCode = 1; console.log(`BOOK ${now.date}: ${refused.length} order(s) refused (${refused.map((x) => x.cid).join(", ")}) — day NOT marked done; re-run after the cause is fixed`); }
  else if (LIVE) { s.runs[now.date] = { monthEnd, full, nav: +p.nav.toFixed(2), scale: +scale.toFixed(3), orders: sent, off }; save(s); ledger({ kind: monthEnd ? "month-end" : "daily", date: now.date, nav: p.nav, lines: p.lines, scale, off }); }
  console.log(`BOOK ${now.date}${monthEnd ? " (MONTH-END)" : ""} NAV $${Math.round(p.nav).toLocaleString()} · ${off ? "SIGNAL-ONLY (OFF switch)" : LIVE ? "orders for the next open" : "DRY"}: ${sent.join(", ") || "no trades (all sleeves inside their bands)"}${scale < 1 ? ` · buys scaled x${scale.toFixed(2)}` : ""}`);
  for (const l of p.lines) console.log(`  ${l.sym.padEnd(5)} ${l.signal.padEnd(4)} target $${l.targetUsd.toLocaleString()} · held $${l.heldUsd.toLocaleString()}${l.qty ? ` · ${l.qty > 0 ? "+" : ""}${l.qty} sh` : ""}`);
}
async function reconcile(quiet) {
  const s = load(), still = [];
  for (const p of s.pending) {
    let o; try { o = await api(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(p.cid)}`); } catch (e) { if (e.status === 404) { ledger({ kind: "order-missing", ...p }); continue; } throw e; }
    const done = ["filled", "canceled", "expired", "rejected", "done_for_day"].includes(o.status);
    if (!done) { still.push(p); continue; }
    const q = +o.filled_qty || 0, fp = +o.filled_avg_price || 0;
    if (q) { const sgn = p.side === "buy" ? 1 : -1; s.holdings[p.sym] = (s.holdings[p.sym] || 0) + sgn * q; s.cash -= sgn * q * fp; }
    ledger({ kind: `fill-${o.status}`, ...p, filledQty: q, px: fp, cashAfter: +s.cash.toFixed(2) });
  }
  s.pending = still; save(s); if (!quiet) status(s);
}
function status(s = load()) { const n = s.navHistory[s.navHistory.length - 1]; console.log(`book — NAV ${n ? "$" + Math.round(n.nav).toLocaleString() + " (" + n.date + ")" : "n/a"} · cash $${Math.round(s.cash).toLocaleString()} · holdings ${JSON.stringify(s.holdings)} · pending ${s.pending.length} · signals ${s.signalsAsOf || "none"} ${Object.entries(s.signals).map(([k, v]) => `${k}:${v.hold ? "HOLD" : v.on ? "IN" : "OUT"}`).join(" ")}`); }
(async () => {
  if (mode === "--plan") {
    const arg = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)); let d = arg;
    if (!d) { const t = etNow().date, cal = await api(`/v2/calendar?start=${new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10)}&end=${t}`); d = cal.map((c) => c.date).filter((x) => x < t).pop(); }
    const s = load(), { px, sig } = await market(d), p = plan(s, px, sig, true); console.log(`PLAN as of ${d} · book NAV $${Math.round(p.nav).toLocaleString()}`); for (const l of p.lines) console.log(`  ${l.sym.padEnd(5)} ${l.signal.padEnd(4)} target $${l.targetUsd.toLocaleString()} · held $${l.heldUsd.toLocaleString()} · ${l.qty ? (l.qty > 0 ? "+" : "") + l.qty + " sh" : "—"}`); return;
  }
  if (mode === "--after-close") return afterClose();
  if (mode === "--reconcile") return reconcile(false);
  status();
})().catch((e) => { console.error("book FAILED:", e.message); process.exit(1); });
