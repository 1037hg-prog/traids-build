"use strict";
/**
 * THE FIXTURES (options-vanished-settles 2026-10-16) — small, hand-written, and every number in them is checkable by hand.
 *
 * Five board positions, all expired on 2026-09-18 (a date that is past for good, so no check depends on when it is run):
 *
 *   W1  AAPL  a CREDIT PUT wing, 220/215, 2 contracts, credit 1.20     the rule this file has always had; a daily bar prices it
 *             AAPL closed 222 -> breach 0 -> (1.20 - 0) x 100 x 2 - 0.65 x 2 x 2 = $237.40
 *   V1  MSFT  a DEBIT CALL spread, long 500 / short 510, 1 contract, debit 3.00, optReal NOT set, so fix 4.2's verified-debit rule
 *             does not take it and nothing else ever closes it. The broker's snapshot of 2026-09-21 reports neither leg.
 *             MSFT closed 506 (underlying-closes.json) -> value clamp(506-500, 0, 10) = 6 -> (6 - 3) x 100 - 1.30 = $298.70
 *   V2  NVDA  the same shape, but NO stored close of NVDA on the expiry date exists anywhere -> UNKNOWN, flagged, never guessed
 *   V3  AMD   a DEBIT CALL spread 100/105, debit 2.00, with AMD at 200 — FAR through the spread. The value is the width, 5, never the
 *             raw 100 the breach would be without the cap -> (5 - 2) x 100 - 1.30 = $298.70
 *   S1  TSLA  expired, and the broker's snapshot STILL reports both its legs -> left exactly as it was
 *   X1  AMZN  expired with no OCC leg symbols at all -> outside this rule; left exactly as it was (as before the rule existed)
 *
 * The mirror log holds five lines: two option orders still "sent" whose expiry has passed (one naming its legs as occAtm/occK2, one as
 * a legs[] list), one "sent" that expires in 2099, one "filled", and one line that is not JSON at all.
 */
const EXP = "2026-09-18";
const occ = (sym, yymmdd, cp, strike) => `${sym}${yymmdd}${cp}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
const E = "260918";

const POS = {
  W1: { id: "w1-aapl", sym: "AAPL", cls: "Options", dir: -1, sizeLabel: "1R", addedAt: Date.parse("2026-09-11T14:00:00Z"),
    optCredit: 1.2, optEntryNet: 1.2, optAtm: 220, optK2: 215, optCall: false, optExpiry: EXP, contracts: 2, riskDollars: 760,
    optStruct: "put credit spread", strategy: "R21-premium", sleeve: "R21", optReal: true,
    occAtm: occ("AAPL", E, "P", 220), occK2: occ("AAPL", E, "P", 215) },
  V1: { id: "v1-msft", sym: "MSFT", cls: "Options", dir: 1, sizeLabel: "1R", addedAt: Date.parse("2026-09-11T14:05:00Z"),
    optEntryNet: 3, optAtm: 500, optK2: 510, optCall: true, optExpiry: EXP, contracts: 1, riskDollars: 300,
    optStruct: "call debit spread", strategy: "board-ticket", rr: 2.1, score: 0.44,
    occAtm: occ("MSFT", E, "C", 500), occK2: occ("MSFT", E, "C", 510) },
  V2: { id: "v2-nvda", sym: "NVDA", cls: "Options", dir: 1, sizeLabel: "1R", addedAt: Date.parse("2026-09-11T14:06:00Z"),
    optEntryNet: 4, optAtm: 900, optK2: 910, optCall: true, optExpiry: EXP, contracts: 1, riskDollars: 400,
    optStruct: "call debit spread", strategy: "board-ticket",
    occAtm: occ("NVDA", E, "C", 900), occK2: occ("NVDA", E, "C", 910) },
  S1: { id: "s1-tsla", sym: "TSLA", cls: "Options", dir: -1, sizeLabel: "1R", addedAt: Date.parse("2026-09-11T14:07:00Z"),
    optEntryNet: 2, optAtm: 400, optK2: 390, optCall: false, optExpiry: EXP, contracts: 1, riskDollars: 200,
    optStruct: "put debit spread", strategy: "board-ticket",
    occAtm: occ("TSLA", E, "P", 400), occK2: occ("TSLA", E, "P", 390) },
  V3: { id: "v3-amd", sym: "AMD", cls: "Options", dir: 1, sizeLabel: "1R", addedAt: Date.parse("2026-09-11T14:09:00Z"),
    optEntryNet: 2, optAtm: 100, optK2: 105, optCall: true, optExpiry: EXP, contracts: 1, riskDollars: 300,
    optStruct: "call debit spread", strategy: "board-ticket",
    occAtm: occ("AMD", E, "C", 100), occK2: occ("AMD", E, "C", 105) },
  X1: { id: "x1-amzn", sym: "AMZN", cls: "Options", dir: 1, sizeLabel: "1R", addedAt: Date.parse("2026-09-11T14:08:00Z"),
    optEntryNet: 1.5, optExpiry: EXP, contracts: 1, riskDollars: 150, optStruct: "something else", strategy: "board-ticket" },
};

/** the broker's stored snapshot: taken 2026-09-21 (after the expiry) and reporting TSLA's two legs only */
const SNAPSHOT = { spec: "alpaca-options-positions-v1", asOf: "2026-09-21T13:05:00Z", source: "alpaca paper /v2/positions (option legs)",
  positions: [{ symbol: POS.S1.occAtm, qty: "-1" }, { symbol: POS.S1.occK2, qty: "1" }] };

const CLOSES = { MSFT: { [EXP]: 506 }, TSLA: { [EXP]: 395 }, AMD: { [EXP]: 200 } };   // AMD at 200 is far beyond the 100/105 width: the cap must bind
const BARS = { reg: { AAPL: { [EXP]: 222 } }, sip: { AAPL: { [EXP]: 222.05 } } };

const MIRROR_LINES = [
  JSON.stringify({ ts: "2026-09-11T14:05:00Z", ticketId: "v1-msft", sym: "MSFT", cls: "Options", side: "buy", status: "sent", orderId: "o-msft-1", live: true, occAtm: POS.V1.occAtm, occK2: POS.V1.occK2 }),
  JSON.stringify({ ts: "2026-09-11T14:06:00Z", ticketId: "v2-nvda", sym: "NVDA", cls: "Options", side: "buy", status: "sent", orderId: "o-nvda-1", live: true, legs: [{ symbol: POS.V2.occAtm }, { symbol: POS.V2.occK2 }] }),
  JSON.stringify({ ts: "2026-10-15T14:00:00Z", ticketId: "future-1", sym: "AAPL", cls: "Options", side: "buy", status: "sent", orderId: "o-fut-1", live: true, optExpiry: "2099-01-15" }),
  JSON.stringify({ ts: "2026-09-11T14:07:00Z", ticketId: "s1-tsla", sym: "TSLA", cls: "Options", side: "sell", status: "filled", orderId: "o-tsla-1", live: true, occAtm: POS.S1.occAtm, occK2: POS.S1.occK2 }),
  "{ this line is not JSON",
];

/** the data folder for a run. keys: which board positions; opts turn the side files on and off */
function data(keys = ["W1", "V1", "V2", "S1", "X1"], { snapshot = SNAPSHOT, closes = CLOSES, mirror = true, tradeLog = [], tombs = [] } = {}) {
  const d = { "board_positions.json": keys.map((k) => JSON.parse(JSON.stringify(POS[k]))), "trade_log.json": tradeLog, "board_tombstones.json": tombs };
  if (snapshot) d["alpaca-options-positions.json"] = snapshot;
  if (closes) d["underlying-closes.json"] = closes;
  if (mirror) d["alpaca-options-mirror.jsonl"] = MIRROR_LINES.join("\n") + "\n";
  return d;
}

module.exports = { EXP, POS, SNAPSHOT, CLOSES, BARS, MIRROR_LINES, data, occ };
