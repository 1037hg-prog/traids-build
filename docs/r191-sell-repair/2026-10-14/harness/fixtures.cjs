"use strict";
/**
 * FIXTURES (r191-sell-repair package, 2026-10-14) — the inputs of the known-answer cases. Pure but for `recorded()`, which reads the frozen copies
 * under harness/recorded/ (make-fixtures.cjs). The generic builders are the R231 package's own (docs/r231-sell-repair/2026-10-12/harness/
 * fixtures.cjs: the daily-close series, the mirror's two files, a CFEE row, a filled order). Two kinds, never mixed:
 *
 * A. THE MADE-UP BOOK. Nothing in it is a real price; the quantities marked RECORDED are R191's and R231's real counts.
 *    BTC and ETH get 260 completed daily closes ending on `lastDay`, built BACKWARDS from a round last close with two alternating daily ratios
 *    (R231's `series`): an "up" coin +1.2% / -0.8% (the last close above its 50-day average: IN), a "down" coin -1.2% / +0.8% (below: OUT).
 *    Last closes: BTC 80000, ETH 2500.
 *    R191 counts BTC 0.116651415 (RECORDED: the filled quantity of its buy of 2026-09-25, its one order row here) and ETH 0.
 *    MODEL of the broker's fee: 0.25% of the filled quantity, rounded UP at 9 decimals. On it R191's BTC buy left the account 0.116359786; the
 *    broker's REAL fee rows (harness/recorded/cfee-rows.json, read by restate.cjs --dry) charged 0.000291630, so it received 0.116359785.
 *    R231 counts (RECORDED, its restated state of 2026-10-14) BTC 0.026122644, ETH 0.821653026.
 *
 * B. THE RECORDED BOOK (`recorded()`): the frozen copies of R191's and R231's states and ledgers as the chain of 2026-10-14 left them, the board
 *    mirror's crypto rows, R191's daily closes to 2026-10-13, and the broker's fee rows as read on 2026-10-14 19:50 MT.
 */
const fs = require("fs"), path = require("path");
const R231FX = require(path.join(__dirname, "..", "..", "..", "r231-sell-repair", "2026-10-12", "harness", "fixtures.cjs"));
const { nano, s9, addDays, series, mirrorFiles, cfeeRow, filledOrder } = R231FX;
const COINS = ["BTC", "ETH"], R231_UNIVERSE = R231FX.UNIVERSE;
const LAST = { BTC: 80000, ETH: 2500 };
const BTC_COUNTED = "0.116651415", BTC_RECEIVED_MODEL = "0.116359786", BTC_RECEIVED = "0.116359785", BTC_FEE = "0.000291630";   // RECORDED count; the model's and the broker's receipts
const ETH_COUNTED = "3.639529815", ETH_RECEIVED = "3.630430990", ETH_FEE = "0.009098825";                                          // RECORDED: R191's ETH buy of 2026-09-25 and its real fee
const R231_BTC = "0.026122644", R231_ETH = "0.821653026";                                                                            // RECORDED: R231's restated counts
const BTC_BUY = { cid: "r191-BTC-20260925-buy", side: "buy", qty: 0.116651415, px: 84070.594204933, at: "2026-09-25T20:30:31.127065Z", signalClose: 84385.46 };   // RECORDED (R191's state)
const bars = (lastDay, { down = [] } = {}) => Object.fromEntries(COINS.map((c) => [c, series(LAST[c], !down.includes(c), lastDay)]));
/** R191's made-up state; `over` = { COIN: { qty, held, pending, ... } } on top; `orders` replaces the order rows */
function state(over = {}, orders = [BTC_BUY]) {
  const coins = { BTC: { qty: +BTC_COUNTED, held: true, pending: null, entry: 84070.594204933 }, ETH: { qty: 0, held: false, pending: null, entry: 2693.609 } };
  for (const [c, v] of Object.entries(over)) Object.assign(coins[c], v);
  return { spec: "r191-state-v1", coins, marks: [], orders: orders.map((o) => ({ ...o })) };
}
/** R231's state file with the given counts ({ COIN: qty | { qty, pending } }) over its 13 coins, and order rows if given */
function r231State(counts = {}, orders = []) {
  const coins = Object.fromEntries(R231_UNIVERSE.map((c) => [c, { qty: 0, notional: 0, pending: null }]));
  for (const [c, v] of Object.entries(counts)) coins[c] = typeof v === "object" ? { qty: 0, notional: 0, pending: null, ...v } : { qty: v, notional: v * 100, pending: null };
  return { spec: "r231-state-v1", coins, marks: [], orders };
}
/** what the fake account holds: R191's count plus what R231 counts, unless told otherwise (strings, 9 decimals) */
const account = (o = {}) => ({ BTC: s9(nano(BTC_COUNTED)), ...o });
/** the model fee of one buy: 0.25% of the filled quantity, rounded UP at 9 decimals (nano) */
const modelFee = (qty) => Math.ceil(nano(qty) * 0.0025 - 1e-6);

// ── B. the recorded book ──
const REC = path.join(__dirname, "recorded"), rec = (f) => path.join(REC, f);
function recorded() {
  const text = (f) => fs.readFileSync(rec(f), "utf8");
  return { dir: REC, r191Raw: text("r191-crypto-trend.json"), r191LedgerRaw: text("r191-crypto-trend.jsonl"), r231Raw: text("r231-crypto-vote-sized.json"), r231LedgerRaw: text("r231-crypto-vote-sized.jsonl"),
    mirrorRaw: text("alpaca-mirror.jsonl"), mirrorExitsRaw: text("alpaca-mirror-exits.jsonl"), bars: JSON.parse(text("bars.json")), cfee: JSON.parse(text("cfee-rows.json")), manifest: JSON.parse(text("manifest.json")) };
}
module.exports = { COINS, LAST, nano, s9, addDays, series, bars, state, r231State, account, mirrorFiles, cfeeRow, filledOrder, modelFee, recorded, BTC_BUY,
  BTC_COUNTED, BTC_RECEIVED_MODEL, BTC_RECEIVED, BTC_FEE, ETH_COUNTED, ETH_RECEIVED, ETH_FEE, R231_BTC, R231_ETH, R231_UNIVERSE };
