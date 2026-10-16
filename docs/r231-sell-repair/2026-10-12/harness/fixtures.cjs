"use strict";
/**
 * FIXTURES (r231-sell-repair package, 2026-10-12) — the inputs of the known-answer cases. Pure but for `recorded()`, which reads the frozen
 * copies under harness/recorded/ (make-fixtures.cjs). Two kinds, never mixed:
 *
 * A. THE MADE-UP BOOK (nothing in it is a real price or a real position, except the two quantities marked RECORDED). Eight coins get 260
 *    completed daily closes ending on `lastDay`; the other five get none (the runner skips them by name). The closes are built BACKWARDS from a
 *    round last close with two alternating daily ratios (docs/pause-switches/2026-10-12/harness/fixtures.cjs), so every answer is exact:
 *      an "up" coin   +1.2% / -0.8% alternating, the last day up: above its 50, 100 and 200-day averages -> the vote is ON
 *      a "down" coin  -1.2% / +0.8% alternating, the last day down: below all three                      -> the vote is OFF
 *    BTC ETH LINK SOL are "up" with the SAME closes (last close 100): equal volatility -> weight 25% each; the book's daily returns are
 *    +1.2% / -0.8%, 19.1% a year, under the 30% target -> k = 1; so each target is 20,000 x 1 x 0.25 = $5,000.
 *      BTC   counts 30   = $3,000  -> the rule BUYS $2,000
 *      ETH   counts 70   = $7,000  -> the rule SELLS 20                    (a rebalance that reduces: 2,000 / 100)
 *      BCH   "down", last close 300, counts 1.324516485 = $397.35 -> the vote is off: the rule SELLS it all.  RECORDED: 1.324516485 is the
 *            quantity R231 really counted for BCH, and 1.321205193 what the broker said the account held (ledger, 2026-10-09)
 *      LINK  counts 0              -> the rule BUYS $5,000
 *      ADA   "down", last close 0.5,  counts 0       -> target $0, current $0: no change
 *      SOL   counts 51   = $5,100  -> inside the $200 threshold: no change
 *      DOGE  "down", last close 0.25, counts 1234.5 = $308.63 -> the vote is off: the rule SELLS it all
 *      AVAX  "down", last close 20,   counts 10 with an order pending -> "order pending", nothing new
 *    `bars(lastDay, { down: ["ETH"] })` turns ETH "down" (last close 100): then ETH's vote is off and the rule sells ALL of ETH; BTC LINK SOL
 *    are the three "up" coins, weight 1/3 each, target $6,666.67.
 *
 * B. THE RECORDED BOOK (`recorded()`): the frozen copy of R231's own state and ledger as the 2026-10-12 chain left them, R191's state, the
 *    board mirror's crypto rows, and the recorded daily closes to 2026-10-11. `accountModel()` is NOT recorded: it is what the account would
 *    hold if every buy was charged as the two recorded balances show (0.25% of the filled quantity, rounded up at 9 decimals) — the fake
 *    broker's account in the replay. For DOGE and BCH it gives exactly the broker's own two figures.
 */
const fs = require("fs"), path = require("path");
const DAY = 864e5, addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const UNIVERSE = ["BTC", "ETH", "LTC", "BCH", "LINK", "ADA", "SOL", "DOGE", "AVAX", "DOT", "UNI", "AAVE", "XTZ"];
const NANO = 1e9, nano = (x) => Math.round(Number(x) * NANO), s9 = (n) => (n / NANO).toFixed(9);
const BCH_COUNTED = "1.324516485", BCH_HELD = "1.321205193", DOGE_COUNTED = "7051.813000848", DOGE_HELD = "7034.183468345";   // RECORDED (R231's ledger, 2026-10-09)
function series(lastClose, up, lastDay, n = 260) {
  const r = up ? [1.012, 0.992] : [0.988, 1.008], out = []; let c = lastClose;
  for (let i = 0; i < n; i++) { out.unshift({ d: addDays(lastDay, -i), c }); c /= r[i % 2]; }
  return out;
}
const LAST = { BTC: 100, ETH: 100, BCH: 300, LINK: 100, ADA: 0.5, SOL: 100, DOGE: 0.25, AVAX: 20 }, UP = ["BTC", "ETH", "LINK", "SOL"];
const bars = (lastDay, { down = [] } = {}) => Object.fromEntries(Object.keys(LAST).map((c) => [c, series(LAST[c], UP.includes(c) && !down.includes(c), lastDay)]));
/** the made-up book's state; `over` = { COIN: { qty, pending } } changes on top */
function state(over = {}) {
  const coins = Object.fromEntries(UNIVERSE.map((c) => [c, { qty: 0, notional: 0, pending: null }]));
  Object.assign(coins.BTC, { qty: 30, notional: 3000 }); Object.assign(coins.ETH, { qty: 70, notional: 7000 }); Object.assign(coins.SOL, { qty: 51, notional: 5100 });
  Object.assign(coins.BCH, { qty: +BCH_COUNTED, notional: 452.05217826456 }); Object.assign(coins.DOGE, { qty: 1234.5, notional: 308.625 });
  Object.assign(coins.AVAX, { qty: 10, notional: 200, pending: { cid: "r231-AVAX-20261009-sell", side: "sell", signalClose: 21 } });
  for (const [c, v] of Object.entries(over)) Object.assign(coins[c], v);
  return { spec: "r231-state-v1", coins, marks: [], orders: [] };
}
/** what the fake account holds when it holds EXACTLY what the made-up book counts (no fee difference, no other sleeve) */
const accountExact = (over = {}) => ({ BTC: "30.000000000", ETH: "70.000000000", SOL: "51.000000000", BCH: "1.324516485", DOGE: "1234.500000000", AVAX: "10.000000000", ...over });
/** R191's state file with the given counts ({ COIN: qty | { qty, pending } }) */
function r191State(counts = {}) {
  const coins = { BTC: { qty: 0, held: false, pending: null }, ETH: { qty: 0, held: false, pending: null } };
  for (const [c, v] of Object.entries(counts)) coins[c] = typeof v === "object" ? { held: v.qty > 0, pending: null, ...v } : { qty: v, held: v > 0, pending: null };
  return { spec: "r191-state-v1", coins, marks: [], orders: [] };
}
/** the board mirror's two files as text: `open` = [{ sym: "ETH/USD", qty, id, closing }] crypto tickets it holds (closing: a close order not final yet) */
function mirrorFiles(open = [], closed = []) {
  const row = (t) => JSON.stringify({ ts: t.ts || "2026-10-12T13:40:00.000Z", ticketId: t.id, sym: t.sym, cls: "Crypto", side: "buy", live: true, ticketAgeMin: 0, ticketEntry: 100, qty: t.qty, notional: 100, bracket: false, orderId: "o-" + t.id, status: "pending_new" });
  const exit = (t, final) => JSON.stringify({ ts: "2026-10-12T19:00:00.000Z", ticketId: t.id, sym: t.sym, cls: "Crypto", entryOrderId: "o-" + t.id, live: true, action: final ? "closed (exit order filled)" : "close sell sent (pending_new) — final once it fills", final });
  return { entries: [...open, ...closed].map(row).join("\n") + (open.length + closed.length ? "\n" : ""), exits: [...closed.map((t) => exit(t, true)), ...open.filter((t) => t.closing).map((t) => exit(t, false))].join("\n") + (closed.length + open.filter((t) => t.closing).length ? "\n" : "") };
}
/** a CFEE row as the broker lists it (the shape backend/r309-surge-hold48.js reads: created_at, symbol, qty negative in the coin, price) */
const cfeeRow = (coin, feeQty, createdAt, price = "100") => ({ id: `${createdAt.slice(0, 10).replace(/-/g, "")}000000000::${coin}-${createdAt}`, activity_type: "CFEE", date: createdAt.slice(0, 10), created_at: createdAt, symbol: `${coin}USD`, qty: "-" + feeQty, price: String(price), net_amount: "0", description: "Coin Pair Transaction Fee (Non USD)", status: "executed" });
/** a filled order as the fake broker holds it */
const filledOrder = (cid, sym, side, qty, px, at) => ({ id: "held-" + cid, client_order_id: cid, symbol: sym, side, type: "market", time_in_force: "gtc", qty: side === "sell" ? String(qty) : null, notional: null, status: "filled", filled_qty: String(qty), filled_avg_price: String(px), filled_at: at });

// ── B. the recorded book ──
const REC = path.join(__dirname, "recorded"), rec = (f) => path.join(REC, f);
function recorded() {
  const text = (f) => fs.readFileSync(rec(f), "utf8");
  return { dir: REC, stateRaw: text("r231-crypto-vote-sized.json"), ledgerRaw: text("r231-crypto-vote-sized.jsonl"), r191Raw: text("r191-crypto-trend.json"), r191LedgerRaw: text("r191-crypto-trend.jsonl"),
    mirrorRaw: text("alpaca-mirror.jsonl"), mirrorExitsRaw: text("alpaca-mirror-exits.jsonl"), tradesRaw: text("trade-updates-main-crypto.jsonl"), bars: JSON.parse(text("bars.json")), manifest: JSON.parse(text("manifest.json")) };
}
/** the fee of one buy as the two recorded balances show it: 0.25% of the filled quantity, rounded UP at 9 decimals (nano units) */
const modelFee = (qty) => Math.ceil(nano(qty) * 0.0025 - 1e-6);
/** NOT recorded: per coin, the recorded count less the modelled fee of each of R231's own buys -> { COIN: "qty" } (BCH and DOGE come out as the broker's own figures) */
function accountModel(stateObj) {
  const out = {};
  for (const c of UNIVERSE) { const fee = (stateObj.orders || []).filter((o) => o.side === "buy" && new RegExp(`^r231-${c}-`).test(o.cid)).reduce((a, o) => a + modelFee(o.qty), 0); out[c] = s9(nano(stateObj.coins[c].qty) - fee); }
  return out;
}
/** the CFEE rows a broker charging that fee would list for the buys in `orders` (one row per order, created 2.5 s after the fill) */
const modelCfee = (orders, coinRe) => orders.filter((o) => o.side === "buy").map((o) => { const c = coinRe.exec(o.cid)[1]; return cfeeRow(c, s9(modelFee(o.qty)), new Date(Date.parse(o.at) + 2500).toISOString(), o.px); });
module.exports = { UNIVERSE, NANO, nano, s9, addDays, series, bars, state, accountExact, r191State, mirrorFiles, cfeeRow, filledOrder, recorded, modelFee, accountModel, modelCfee, BCH_COUNTED, BCH_HELD, DOGE_COUNTED, DOGE_HELD, LAST };
