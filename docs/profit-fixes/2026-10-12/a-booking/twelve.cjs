"use strict";
/**
 * PROFIT FIX 4.2 — THE TWELVE EXPIRED SPREADS, PINNED. 2026-10-12 (docs/profit-fixes/2026-10-12/a-booking).
 *
 * One row per spread that was still open on the board on 2026-10-12 although its options had expired. A module: no side effects on load.
 * Used by settle-expired-twelve.cjs (the one-time settle), lib.cjs (the deploy refuses the settle script's own file while any of these
 * is still open), selftest.cjs and verify-live.cjs.
 *
 * WHERE EACH NUMBER COMES FROM (every one from a script that was run; nothing typed from memory)
 *   ticket fields   backend/data/board_positions.json as read on 2026-10-12 (id, legs, side, contracts, entry at the cross, risk dollars).
 *   regClose        the underlying's Alpaca IEX RAW daily close on the expiry date: the bar backend/options-settle.js reads, taken raw.
 *                   Read 2026-10-12 through backend/lib/alpaca-bars.js fetchBars (feed "iex", adjustment "raw").
 *                   Raw, because the nightly settle asks for adjustment "all": the same thing on the expiry night, but read a month
 *                   late it is moved by every dividend since (DIA 2026-09-11 reads 524.58 adjusted against 525.79 as traded: the
 *                   "adjusted" columns of `node settle-expired-twelve.cjs`, the dry run with the network, print it fresh).
 *   officialClose   the consolidated (SIP) RAW daily close of the same date, same script, same day. Recorded beside (fix 4.7); it does
 *                   not move the booked figure.
 *   pnl             the value of the settle at regClose under RULE below. Hand-checked line by line in NOTES.md.
 *   evidenceUsd     the figure the 2026-10-10 review printed for the same spread (backend/data/profit-program/skeptic-sleeves3.json,
 *                   staleSpreads.rows): mid entry, no commission, consolidated close. Its twelve sum to -2,534.
 *
 * RULE — one half is the nightly settle's own, the other half is NEW
 *   credit vertical (the six R21 wings)   backend/options-settle.js as written, nothing new:
 *        cost = clamp(S - shortK, 0, width) for a call, clamp(shortK - S, 0, width) for a put
 *        pnl  = (credit received at the cross - cost) x 100 x contracts - 0.65 x 2 legs x contracts
 *   debit vertical (the six board option tickets)   NEW WITH THIS PACKAGE, AND THE OPERATOR'S TO ACCEPT. No test registers a settle
 *   rule for these: the nightly settle prints "no registered settle rule; handle by hand" for exactly these positions. The rule is
 *   derived as the mirror image of the wings', with the board's own entry for every option mark (src/App.jsx optMark: entryNet =
 *   optEntryNet, the debit paid at the cross) and the same expiry convention:
 *        value = clamp(S - longK, 0, width) for a call, clamp(longK - S, 0, width) for a put
 *        pnl   = (value - debit paid at the cross) x 100 x contracts - 0.65 x 2 legs x contracts
 *   Risk was sized on the MID, so a debit vertical that expires worthless books a little below -1R (IWM -1.042R, META -1.040R,
 *   GOOGL -1.079R: the dry run prints them).
 *   rMult = pnl / riskDollars, closedAt = the expiry date at 20:00 UTC, reason "expiry" — as every expiry settle.
 */
const SPREADS = [
  { id: "1785851391091-Options-DIA-xvuv",   sym: "DIA",   strategy: "Mean-Reversion", credit: false, call: false, atm: 536,   k2: 509,  expiry: "2026-09-11", contracts: 1, entryNet: 6.64,  riskDollars: 639,  regClose: 525.79, officialClose: 525.79, pnl: 355.70,   pnlOfficial: 355.70,   evidenceUsd: 382 },
  { id: "1785851391092-Options-IWM-hb5t",   sym: "IWM",   strategy: "Ensemble",       credit: false, call: true,  atm: 297.5, k2: 312,  expiry: "2026-09-11", contracts: 1, entryNet: 5.95,  riskDollars: 572,  regClose: 288.89, officialClose: 288.89, pnl: -596.30,  pnlOfficial: -596.30,  evidenceUsd: -572 },
  { id: "1786039760869-Options-QQQ-pn20",   sym: "QQQ",   strategy: "Ensemble",       credit: false, call: true,  atm: 715,   k2: 740,  expiry: "2026-09-04", contracts: 1, entryNet: 11.29, riskDollars: 1100, regClose: 719.1,  officialClose: 718.96, pnl: -720.30,  pnlOfficial: -734.30,  evidenceUsd: -704 },
  { id: "1786973953244-Options-META-sgjx",  sym: "META",  strategy: "Ensemble",       credit: false, call: false, atm: 580,   k2: 550,  expiry: "2026-09-18", contracts: 1, entryNet: 12.41, riskDollars: 1194, regClose: 665.39, officialClose: 665.75, pnl: -1242.30, pnlOfficial: -1242.30, evidenceUsd: -1194 },
  { id: "1786973953245-Options-GOOGL-y522", sym: "GOOGL", strategy: "Ensemble",       credit: false, call: false, atm: 345,   k2: 330,  expiry: "2026-09-18", contracts: 1, entryNet: 6.17,  riskDollars: 573,  regClose: 349.23, officialClose: 349.54, pnl: -618.30,  pnlOfficial: -618.30,  evidenceUsd: -573 },
  { id: "1787924282826-Options-NVDA-f3pk",  sym: "NVDA",  strategy: "Ensemble",       credit: false, call: true,  atm: 230,   k2: 240,  expiry: "2026-10-02", contracts: 1, entryNet: 3.72,  riskDollars: 354,  regClose: 234,    officialClose: 233.95, pnl: 26.70,    pnlOfficial: 21.70,    evidenceUsd: 41 },
  { id: "1788964211286-Options-HOOD-r21p",  sym: "HOOD",  strategy: "R21-premium",    credit: true,  call: false, atm: 111,   k2: 110,  expiry: "2026-09-18", contracts: 1, entryNet: 0.18,  riskDollars: 82,   regClose: 119.83, officialClose: 119.82, pnl: 16.70,    pnlOfficial: 16.70,    evidenceUsd: 18 },
  { id: "1788964211294-Options-LI-r21c",    sym: "LI",    strategy: "R21-premium",    credit: true,  call: true,  atm: 12.5,  k2: 13,   expiry: "2026-09-18", contracts: 1, entryNet: 0.06,  riskDollars: 44,   regClose: 12.135, officialClose: 12.14,  pnl: 4.70,     pnlOfficial: 4.70,     evidenceUsd: 6 },
  { id: "1789050610950-Options-QCOM-r21c",  sym: "QCOM",  strategy: "R21-premium",    credit: true,  call: true,  atm: 182.5, k2: 185,  expiry: "2026-09-18", contracts: 1, entryNet: 0.4,   riskDollars: 210,  regClose: 178.01, officialClose: 177.72, pnl: 38.70,    pnlOfficial: 38.70,    evidenceUsd: 40 },
  { id: "1789137012338-Options-SOXL-r21c",  sym: "SOXL",  strategy: "R21-premium",    credit: true,  call: true,  atm: 132,   k2: 133,  expiry: "2026-09-16", contracts: 1, entryNet: 0.14,  riskDollars: 86,   regClose: 104.08, officialClose: 103.97, pnl: 12.70,    pnlOfficial: 12.70,    evidenceUsd: 14 },
  { id: "1789137012350-Options-VXX-r21c",   sym: "VXX",   strategy: "R21-premium",    credit: true,  call: true,  atm: 20,    k2: 20.5, expiry: "2026-09-18", contracts: 1, entryNet: 0.03,  riskDollars: 47,   regClose: 17.78,  officialClose: 17.76,  pnl: 1.70,     pnlOfficial: 1.70,     evidenceUsd: 3 },
  { id: "1789137012352-Options-VZ-r21c",    sym: "VZ",    strategy: "R21-premium",    credit: true,  call: true,  atm: 52,    k2: 52.5, expiry: "2026-09-18", contracts: 1, entryNet: 0.05,  riskDollars: 45,   regClose: 48.12,  officialClose: 48.09,  pnl: 3.70,     pnlOfficial: 3.70,     evidenceUsd: 5 },
];
const IDS = SPREADS.map((s) => s.id);
/** totals of the pinned table (cents exact) */
const cents = (x) => Math.round(x * 100);
const TOTALS = {
  pnl: cents(SPREADS.reduce((a, s) => a + s.pnl, 0)) / 100,                       // -2716.60: the figure the one-time settle books
  pnlOfficial: cents(SPREADS.reduce((a, s) => a + s.pnlOfficial, 0)) / 100,       // -2735.60: the same rule at the consolidated close (recorded beside)
  evidenceUsd: SPREADS.reduce((a, s) => a + s.evidenceUsd, 0),                    // -2534: the 2026-10-10 review's figure
  riskDollars: SPREADS.reduce((a, s) => a + s.riskDollars, 0),                    // 4946
  byStrategy: Object.fromEntries([...new Set(SPREADS.map((s) => s.strategy))].map((k) => [k, cents(SPREADS.filter((s) => s.strategy === k).reduce((a, s) => a + s.pnl, 0)) / 100])),
};
const CR_ID = "profit-fix-4.2-twelve-expired-spreads-settled-2026-10-12";
const MARKER = "docs/profit-fixes/2026-10-12/a-booking/settle-expired-twelve.cjs";
const PINNED_ON = "2026-10-12";
module.exports = { SPREADS, IDS, TOTALS, CR_ID, MARKER, PINNED_ON };
