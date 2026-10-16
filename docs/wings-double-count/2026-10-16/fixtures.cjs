#!/usr/bin/env node
"use strict";
/**
 * WINGS DOUBLE COUNT (2026-10-16) — THE FIXTURES, and the answers worked out by hand.
 *
 * Everything here is synthesized by this file. No data file is read, no network is touched, every symbol
 * and id is plainly fake (SPY/QQQ/IWM wings named w1..w6, a stamped ticket s1, two equities, one control).
 *
 * THE KNOWN DOUBLE-COUNT CASE, built to match what the ledger actually holds:
 *   Six R21 weekly wings (w1..w6) were closed by the loss cap on 2026-09-14 at -$400 each. That close was
 *   VOIDED for evidence (retired "voidcap-2026-09-14" + retireNote + voidForEvidence) and the wings went
 *   back on the board UNDER THE SAME ID. They expired on 2026-09-18 and settled: +$100 for w1..w3,
 *   -$300 for w4..w6. backend/options-settle.js writes a settle by PREPENDING to trade_log.json and never
 *   removes the voided close, so each wing now has TWO rows carrying ONE ticket id.
 *       per ROW  the six wings are 6 x (-400) + 300 - 900 = -$3,000
 *       per TICKET they are 3 x (+100) + 3 x (-300) =       -$600      <- the true number
 *   The whole fixture's signal book (controls out) is -$3,280 per row and -$380 per ticket.
 *
 * s1 — THE SUCCESSOR STAMP, isolated. A ticket whose superseded close is NOT marked voidForEvidence; the
 *   surviving row names it instead (voidedPredecessor + restoredAfter, as the 2026-10-01 settle audit
 *   stamps it). Its surviving close is the EARLIER one, so the latest-close tiebreak alone would pick the
 *   wrong row: only the stamp rule can get this ticket right. That is the point of it.
 *
 * TWO ORDERS, because the ledger has had two kinds of writer:
 *   prepend  the newest close first — what options-settle.js and r24-sleeve.js produce today
 *   append   the voided close first — what any appending repair (recover-lost-settles.js) produces
 *   A reader that dedupes by ARRIVAL ORDER is right on one and wrong on the other. A reader keyed on the
 *   ticket id is right on both, and the selftest asserts exactly that.
 *
 * TWO CHANGE REGISTRIES, because reconcile.js's retired-row rule only counts a tag that is IN the
 * append-only registry (a bare flag "excludes nothing and is reported as ignored"):
 *   registered  holds "voidcap-2026-09-14" — the voided wing rows are excluded by the retire rule, so the
 *               canonical read gets the wings right for the wrong reason, and the per-row reports (which
 *               have no retire filter at all) still count them twice
 *   bare        holds neither tag — the canonical read itself counts every wing TWICE
 *   The fix must give the same answer under both. That is asserted too.
 *
 * THE JOURNAL. data/trade_log.jsonl is keyed on the ticket id and a sealed row never moves, so it holds
 * the close it saw FIRST: for w1..w6 that is the VOIDED close, and for s1 the superseded one. Ten entries
 * against seventeen rows — the ledger said one number and the journal key said another, which is the
 * disagreement that surfaced this defect.
 */
const fs = require("fs"), path = require("path");

const ms = (iso) => Date.parse(iso);
const OPENED = ms("2026-09-08T14:00:00Z");          // 10:00 ET, inside hours
const VOID_CLOSE = ms("2026-09-14T19:30:00Z");      // 15:30 ET 2026-09-14 — the loss cap's close, later voided
const EXPIRY_CLOSE = ms("2026-09-18T20:00:00Z");    // 16:00 ET 2026-09-18 — the expiry settle
const EQ_CLOSE = ms("2026-09-16T20:00:00Z");        // 16:00 ET 2026-09-16
const S1_SUPERSEDED = ms("2026-09-17T20:00:00Z");   // LATER than the surviving close, on purpose
const VOID_TAG = "voidcap-2026-09-14", S1_TAG = "void-s1";

/** the six wings: expiry P&L per wing, in order w1..w6 */
const WING_PNL = [100, 100, 100, -300, -300, -300];
const WING_SYMS = ["SPY", "QQQ", "IWM", "SPY", "QQQ", "IWM"];
const RISK = 400;

/**
 * inheritedTag models the case lib/reconcile.js knownAmbiguities() now surfaces as
 * "void-tag-on-surviving-close": backend/options-settle.js copies retired / retireNote /
 * voidForEvidence from the OPEN board position onto the settle row it writes, so if the board row of a
 * restored wing still carried the void tag, the REAL close inherited it. Under a registry that honours
 * the tag the ticket then counts ZERO times instead of twice, and both are wrong.
 */
const wingSettle = (i, { inheritedTag = false } = {}) => ({
  id: `w${i + 1}`, sym: WING_SYMS[i], cls: "Options", dir: -1, strategy: "R21-premium", sleeve: "R21-premium",
  reason: "expiry", ctrl: false, openedAt: OPENED, closedAt: EXPIRY_CLOSE,
  pnl: WING_PNL[i], rMult: WING_PNL[i] / RISK, riskDollars: RISK, contracts: 1,
  ...(inheritedTag ? { retired: VOID_TAG, retireNote: "the loss cap fired on a stale mark; this close is void for evidence", voidForEvidence: true } : {}),
  obs: { optExpiry: "2026-09-18", width: 5, optCall: false, restoredAfter: VOID_TAG },
});
const wingVoided = (i) => ({
  id: `w${i + 1}`, sym: WING_SYMS[i], cls: "Options", dir: -1, strategy: "R21-premium", sleeve: "R21-premium",
  reason: "loss-cap", ctrl: false, openedAt: OPENED, closedAt: VOID_CLOSE,
  pnl: -RISK, rMult: -1, riskDollars: RISK, contracts: 1,
  retired: VOID_TAG, retireNote: "the loss cap fired on a stale mark; this close is void for evidence", voidForEvidence: true,
  obs: { optExpiry: "2026-09-18", width: 5, optCall: false },
});
const OTHERS = () => [
  { id: "e1", sym: "AAA", cls: "Equity", dir: 1, strategy: "Breakout", ctrl: false, openedAt: ms("2026-09-15T14:00:00Z"), closedAt: EQ_CLOSE, pnl: 200, rMult: 0.5, riskDollars: 400 },
  { id: "e2", sym: "BBB", cls: "Equity", dir: 1, strategy: "Breakout", ctrl: false, openedAt: ms("2026-09-15T14:00:00Z"), closedAt: EQ_CLOSE, pnl: -100, rMult: -0.25, riskDollars: 400 },
  { id: "c1", sym: "CCC", cls: "Equity", dir: 1, strategy: "Breakout", ctrl: true, openedAt: ms("2026-09-15T14:00:00Z"), closedAt: EQ_CLOSE, pnl: 50, rMult: 0.125, riskDollars: 400 },
];
/** s1's surviving close names the row it replaced; that row is NOT marked voidForEvidence and closed LATER */
const s1Survivor = () => ({ id: "s1", sym: "DDD", cls: "Options", dir: -1, strategy: "R21-premium", sleeve: "R21-premium", reason: "expiry",
  ctrl: false, openedAt: ms("2026-09-10T14:00:00Z"), closedAt: EQ_CLOSE, pnl: 120, rMult: 0.3, riskDollars: 400, contracts: 1,
  voidedPredecessor: "s1", restoredAfter: S1_TAG, obs: { optExpiry: "2026-09-16", width: 5, optCall: false } });
const s1Superseded = () => ({ id: "s1", sym: "DDD", cls: "Options", dir: -1, strategy: "R21-premium", sleeve: "R21-premium", reason: "loss-cap",
  ctrl: false, openedAt: ms("2026-09-10T14:00:00Z"), closedAt: S1_SUPERSEDED, pnl: -500, rMult: -1, riskDollars: 400, contracts: 1,
  retired: S1_TAG, retireNote: "closed against a mark that was never real; replaced by the stamped row", obs: { optExpiry: "2026-09-16", width: 5, optCall: false } });

/** order "prepend": every surviving close first (what options-settle.js writes). "append": the superseded ones first. */
function ledger(order, opts = {}) {
  const survivors = [...WING_PNL.map((_, i) => wingSettle(i, opts)), s1Survivor()];
  const superseded = [...WING_PNL.map((_, i) => wingVoided(i)), s1Superseded()];
  return order === "append" ? [...superseded, ...OTHERS(), ...survivors] : [...survivors, ...OTHERS(), ...superseded];
}

/** the journal seals the close it saw FIRST and never moves it: the superseded one for w1..w6 and s1 */
function journal() {
  const sealed = [...WING_PNL.map((_, i) => wingVoided(i)), s1Superseded(), ...OTHERS()];
  return sealed.map((t) => JSON.stringify({ ...t, journaledAt: "2026-09-14T23:59:00.000Z" })).join("\n") + "\n";
}

const changeRegistry = (kind) => ({
  note: "FIXTURE — a plainly fake append-only change registry. Not the real one.",
  changes: kind === "registered"
    ? [{ date: "2026-09-14", area: "accounting", change: `the loss cap's close of six R21 wings is void for evidence (${VOID_TAG})`, breaksComparability: true }]
    : [{ date: "2026-09-14", area: "accounting", change: "nothing about either void tag is recorded here", breaksComparability: false }],
});

const redFolders = () => ({
  coveredFrom: "2026-09-01",
  events: [{ country: "USD", dateEt: "2026-09-15", timeEt: "08:30", title: "FIXTURE CPI (not a real release)" },
    { country: "EUR", dateEt: "2026-09-16", timeEt: "08:30", title: "FIXTURE euro print — not USD, must not count" }],
});

/**
 * THE ANSWERS, worked out by hand from the rows above. Every one of these is asserted by selftest.cjs.
 * `base` is what the files this package starts from produce; `staged` is what the changed files must.
 */
const EXPECT = Object.freeze({
  rowsInFile: 17, tickets: 10, duplicateTicketIds: 7, supersededRows: 7,
  wings: { perRow: -3000, perTicket: -600 },
  signalPnl: { perRow: -3280, perTicket: -380 },
  // cleanEraLedger(), bare registry: nothing is validly retired, so base counts every row
  ledgerBare: { base: { n: 16, meanR: -0.4969, controlMeanR: 0.125, pooledEdgeR: -0.6219, settled: 17, retiredExcluded: 0 },
    staged: { n: 9, meanR: -0.1056, controlMeanR: 0.125, pooledEdgeR: -0.2306, settled: 10, retiredExcluded: 0, tickets: 10, duplicateTicketIds: 7, supersededRowsDropped: 7 } },
  // cleanEraLedger(), registered registry: the retire rule drops the six voided WING rows, and nothing else
  ledgerRegistered: { base: { n: 10, meanR: -0.195, settled: 11, retiredExcluded: 6 },
    staged: { n: 9, meanR: -0.1056, settled: 10, retiredExcluded: 0 } },
  // daily-postmortem.js: the TARGET DAY's realized cash is unchanged (it is one day's rows); the epoch
  // view is what was double counted — a whole session of voided closes, and the curve it sits in
  postmortem: { target: "2026-09-18", todaySettles: 6, todayPnl: -600,
    base: { sessions: 4, curveEnd: -3280, firstSession: "2026-09-14" },
    staged: { sessions: 2, curveEnd: -380, firstSession: "2026-09-16" } },
  // integrity-audit.js section 3 (the too-good tripwire), signals only
  integrity: { base: { cleanN: 16, winRate: 0.3125, meanR: -0.4969, optionsInSignalLedger: 14 },
    staged: { cleanN: 9, winRate: 0.5556, meanR: -0.1056, optionsInSignalLedger: 7, duplicateTicketIds: 7, tickets: 10 } },
  // options-news-shadow.js: all six wings are exposed to the 09-15 USD release (the EUR one must not count).
  // On the APPEND order the arrival-order dedupe picks the VOIDED close; keyed on the ticket id it cannot.
  newsShadow: { exposedTickets: 7, notExposedTickets: 0,
    appendOrder: { base: { sumPnl: -2900, meanR: -1 }, staged: { sumPnl: -480, meanR: -0.1714 } },
    prependOrder: { base: { sumPnl: -480, meanR: -0.1714 }, staged: { sumPnl: -480, meanR: -0.1714 } } },
  // journalLag(): ten sealed entries against seventeen rows. Per ticket the journal is NOT behind at all —
  // and seven tickets are sealed under a close that has since been superseded.
  journal: { entries: 10, settledRowsInCanon: 17, settledTicketsInCanon: 10, missing: 0, sealedUnderSuperseded: 7,
    base: { journalRows: 10, settledInCanon: 17, missing: 0 } },
  /**
   * THE INHERITED VOID TAG. The same ledger, except each surviving wing settle also carries the
   * predecessor's void tag. The collapse still makes each wing ONE ticket — but under a registry that
   * honours the tag, that one ticket is then excluded as retired and the wing counts ZERO times:
   *   staged, registered registry: the six wings are gone from the signal book, which is
   *     e1 200 + e2 (-100) + s1 120 = +220 over 3 signals, with 6 rows excluded as retired
   *   staged, bare registry: the tag is not in the registry, so it excludes nothing and the wings count
   *     once, exactly as in the ordinary fixture (n 9, +(-380))
   * Either way lib/reconcile.js knownAmbiguities() reports all six under "void-tag-on-surviving-close".
   * That is the point of surfacing it: the collapse can make a ticket count once, not decide whether
   * the one row counts at all.
   */
  inheritedTag: { ambiguityAffects: 6,
    stagedRegistered: { n: 3, signalPnl: 220, retiredExcluded: 6, settled: 4, tickets: 10, duplicateTicketIds: 7 },
    stagedBare: { n: 9, signalPnl: -380, retiredExcluded: 0, settled: 10 } },
});

/** write the whole scratch data directory for one variant */
function writeData(dataDir, { order = "prepend", registry = "bare", withJournal = true, inheritedTag = false } = {}) {
  fs.mkdirSync(path.join(dataDir, "ff-calendar"), { recursive: true });
  const w = (f, obj) => fs.writeFileSync(path.join(dataDir, f), JSON.stringify(obj, null, 1));
  w("trade_log.json", ledger(order, { inheritedTag }));
  w("board_positions.json", []);
  w("board_tombstones.json", []);
  w("change-registry.json", changeRegistry(registry));
  w("ff-calendar/red-folders.json", redFolders());
  if (withJournal) fs.writeFileSync(path.join(dataDir, "trade_log.jsonl"), journal());
}

module.exports = { ledger, journal, changeRegistry, redFolders, writeData, EXPECT, WING_PNL, VOID_TAG, S1_TAG,
  OPENED, VOID_CLOSE, EXPIRY_CLOSE, EQ_CLOSE, S1_SUPERSEDED };

if (require.main === module) {
  const out = process.argv[2];
  if (!out) { console.log("usage: node docs/wings-double-count/2026-10-16/fixtures.cjs <dir>\n  writes the scratch data directory (prepend order, bare registry) so the fixture can be read by eye.\n  The expected answers are the EXPECT export; selftest.cjs asserts every one of them."); process.exit(2); }
  writeData(out, {});
  console.log(`fixture data written to ${out}`);
  console.log(`  ${EXPECT.rowsInFile} rows · ${EXPECT.tickets} tickets · ${EXPECT.duplicateTicketIds} ticket id(s) with more than one row`);
  console.log(`  the six wings: ${EXPECT.wings.perRow} per ROW vs ${EXPECT.wings.perTicket} per TICKET`);
}
