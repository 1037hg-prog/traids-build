#!/usr/bin/env node
/**
 * PROFIT FIX 4.2 — THE ONE-TIME SETTLE OF THE TWELVE EXPIRED SPREADS. 2026-10-12 (docs/profit-fixes/2026-10-12/a-booking).
 *
 *   node docs/profit-fixes/2026-10-12/a-booking/settle-expired-twelve.cjs             DRY: reads the closes, prints every row, the
 *                                                                                      before/after totals, the change-registry row and
 *                                                                                      what an apply would do now. Writes nothing.
 *   node docs/profit-fixes/2026-10-12/a-booking/settle-expired-twelve.cjs --pinned    DRY, offline: the same from the closes pinned in
 *                                                                                      twelve.cjs (read 2026-10-12). Writes nothing.
 *   node docs/profit-fixes/2026-10-12/a-booking/settle-expired-twelve.cjs --apply     the settle. Run by the main loop after the dry run.
 *
 * WHAT THE APPLY WRITES (JSON only through backend/lib/atomic-write.js; the order of the nightly settle):
 *   backend/data/trade_log.json         twelve rows, reason "expiry", each dated at its own expiry (closedAt = expiry 20:00 UTC)
 *   backend/data/board_positions.json   the twelve positions leave the board
 *   backend/data/board_tombstones.json  twelve tombstones, so no tab can put them back
 *   backend/data/change-registry.json   ONE row, breaksComparability true, with every ticket's figure and the before/after totals
 * A copy of all four files as they were is taken first (backups/<stamp>-settle/ in this folder).
 *
 * THE RULE (twelve.cjs has it in full). The six R21 wings settle exactly as backend/options-settle.js settles any wing: that rule is
 * the nightly settle's own, as written. The six debit verticals had NO settle rule: for exactly these positions the nightly settle
 * prints "no registered settle rule; handle by hand". The rule used here is NEW, derived as the mirror image of the wings' rule on the
 * entry the board has always used for an option (optEntryNet, the debit paid at the cross), and it is THE OPERATOR'S TO ACCEPT: the dry
 * run is where he reads it. Three of the six book below -1R, because their risk was sized on the mid and the entry is the cross; the dry
 * run names them. The settle price is the underlying's IEX RAW daily close of the expiry date — the bar the nightly settle reads, taken
 * raw because the nightly's own "adjusted" bar, read a month late, is moved by every dividend paid since (the dry run prints what the
 * nightly's own call would read today, beside). The consolidated close and the P&L it would give are recorded beside (fix 4.7); they
 * do not move the booked figure.
 *
 * THE GUARDS (an apply that fails any of them writes nothing and exits 2):
 *   - a trading weekday 05:30-16:00 MT; 13:50-15:50 MT on a trading day (the change registry is the close chain's then)
 *   - the close chain, the nightly settle, the wing cap, the entry run or board discipline running; an unreadable process list
 *   - the close chain of the most recent session not on record as finished in backend/data/chain-status.json (after 16:00 MT on a
 *     trading day: today's chain). The process list is not what proves it: a process the Task Scheduler launched shows no command
 *     line to an ordinary session here, so a chain still running after 16:00 MT would not be seen. A record that is missing,
 *     unreadable or dated after this machine's clock refuses too
 *   - a spread that is not as pinned (other legs, side, size, entry or risk), is quarantined, tombstoned, or already closed by
 *     something else while still on the board; a spread that left the board with no settle
 *   - a close that could not be read, or that differs from the pinned close; a P&L that differs from the pinned figure by a cent
 * The command line reaches the write through ONE function, run(), and the fences stand in it: there is no other way from the command
 * line to apply(). --apply with --pinned is refused there too (an apply always re-reads the closes).
 * Run twice it does nothing the second time. A run that stopped half-way is completed by the next one.
 * No order, no message, no restart, no process touched. automation/close-chain.cjs is never loaded.
 */
"use strict";
const fs = require("fs"), path = require("path");
const L = require("./lib.cjs"), T = require("./twelve.cjs");
const COMMISSION_PER_LEG = 0.65, LEGS_AT_ENTRY = 2;   // backend/options-settle.js: two legs in at $0.65; expiry itself is commission-free
const SINCE = "2026-08-25";                            // the window the 2026-10-10 review quoted ("board gross since 08-25")
const BUSY = [/close-chain\.cjs/i, /options-settle\.js/i, /wing-loss-cap\.js/i, /wing-cap-grade\.js/i, /daily-run\.cjs/i, /board-discipline\.(js|bat)/i, /intraday\.bat/i, /daily-(open|close)\.bat/i, /retire-apply\.js/i];
const WRITES = ["backend/data/trade_log.json", "backend/data/board_positions.json", "backend/data/board_tombstones.json", "backend/data/change-registry.json"];
// readers of backend/data/trade_log.json that take it RAW (no lib/reconcile.js, no retired filter): each counts a voided row and its
// re-settle as two tickets (review of 2026-10-12; the selftest checks each file still reads the ledger that way)
const RAW_READERS = ["backend/r98-credit-size-twin.js", "backend/r50-limit-twin.js", "backend/r21-halfprofit.js", "backend/options-news-shadow.js", "backend/coverage-monitor.js"];
const D = (root, f) => path.join(root, "backend", "data", f);
const readJ = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const cents = (x) => Math.round(x * 100);
const usd = (v) => (v == null || !Number.isFinite(v) ? "n/a" : (v < 0 ? "-$" : "+$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const occLeg = (s) => { const m = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(s || "").replace(/\s+/g, "")); return m ? { exp: `20${m[2]}-${m[3]}-${m[4]}`, call: m[5] === "C", k: +m[6] / 1000 } : null; };
const occExpiry = (p) => { const a = occLeg(p.occAtm), b = occLeg(p.occK2); return a && b && a.exp === b.exp ? a.exp : null; };
const voidedRestore = (t, p) => !!(t && p && t.id === p.id && t.retired && t.voidForEvidence === true && p.obs && p.obs.restoredAfter === t.retired);
const isOurs = (t) => !!(t && t.reason === "expiry" && t.obs && t.obs.lateSettle && t.obs.lateSettle.by === T.MARKER);
const mtDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Denver" });

/** the row backend/options-settle.js (with this package's edit in) writes for position p at close S — field for field, in its order */
function settleRow(p0, S, off, offEndIso) {
  const p = p0.optExpiry ? p0 : { ...p0, optExpiry: occExpiry(p0), optExpiryFrom: "occ" };
  const contracts = p.contracts || 1, width = Math.abs(p.optK2 - p.optAtm);
  const cost = p.optCall ? Math.min(Math.max(S - p.optAtm, 0), width) : Math.min(Math.max(p.optAtm - S, 0), width);
  const creditKept = p.optEntryNet ?? p.debit, commissions = COMMISSION_PER_LEG * LEGS_AT_ENTRY * contracts;
  const isDebit = !p.optCredit;
  const pnl = (isDebit ? cost - creditKept : creditKept - cost) * 100 * contracts - commissions;
  const offCost = off.c == null ? null : (p.optCall ? Math.min(Math.max(off.c - p.optAtm, 0), width) : Math.min(Math.max(p.optAtm - off.c, 0), width));
  const offPnl = offCost == null ? null : +((isDebit ? offCost - creditKept : creditKept - offCost) * 100 * contracts - commissions).toFixed(2);
  const rMult = p.riskDollars ? pnl / p.riskDollars : null;
  return {
    ...(p.retired ? { retired: p.retired, retireNote: p.retireNote, voidForEvidence: p.voidForEvidence } : {}),
    id: p.id, sym: p.sym, cls: "Options", dir: p.dir, sizeLabel: p.sizeLabel,
    ctrl: !!p.ctrl, vetoShadow: !!p.vetoShadow, veto: p.veto ?? null, ctrlRand: !!p.ctrlRand, ...(p.vetoWhy ? { vetoWhy: p.vetoWhy, vetoAt: p.vetoAt } : {}),
    entry: creditKept, exit: +cost.toFixed(4), rMult, pnl: +pnl.toFixed(2),
    reason: "expiry", openedAt: p.addedAt, closedAt: Date.parse(p.optExpiry + "T20:00:00Z"),
    conf: p.conf ?? null, strategy: p.strategy ?? "R21-premium", rr: isDebit ? (p.rr ?? null) : null, score: isDebit ? (p.score ?? null) : null,
    nBull: isDebit ? (p.nBull ?? null) : null, nBear: isDebit ? (p.nBear ?? null) : null, total: isDebit ? (p.total ?? null) : null,
    riskDollars: p.riskDollars ?? null,
    optStruct: p.optStruct ?? null,
    contracts: p.contracts ?? contracts ?? null,
    optEntryNet: p.optEntryNet ?? null,
    debit: p.debit ?? null,
    stopDist: p.stopDist ?? null,
    sleeve: p.sleeve ?? null,
    obs: { ...(p.obs || {}), settleUnder: S, width, optCall: !!p.optCall, shortK: isDebit ? p.optK2 : p.optAtm, longK: isDebit ? p.optAtm : p.optK2, optExpiry: p.optExpiry, sleeve: p.sleeve ?? null,
      ...(isDebit ? { settleKind: "debit-vertical", entryBasis: "optEntryNet (the debit paid at the cross)", ...(p.optExpiryFrom ? { optExpiryFrom: p.optExpiryFrom } : {}) } : {}),
      settleUnderOfficial: off.c, settleOfficialSrc: "alpaca sip raw 1Day close", settleOfficialAsOf: offEndIso, pnlOfficial: offPnl,
      rMultOfficial: offPnl == null || !p.riskDollars ? null : +(offPnl / p.riskDollars).toFixed(4), ...(off.note ? { settleOfficialNote: off.note } : {}) },
  };
}

/** does the open board row still match the pinned spread? -> [differences] */
function pinDiffs(p, s) {
  const a = occLeg(p.occAtm), b = occLeg(p.occK2), d = [];
  const eq = (name, got, want) => { if (got !== want) d.push(`${name} ${JSON.stringify(got)} (pinned ${JSON.stringify(want)})`); };
  eq("sym", p.sym, s.sym); eq("strategy", p.strategy, s.strategy); eq("cls", p.cls, "Options"); eq("credit", !!p.optCredit, s.credit); eq("call", !!p.optCall, s.call);
  eq("optAtm", p.optAtm, s.atm); eq("optK2", p.optK2, s.k2); eq("contracts", p.contracts || 1, s.contracts); eq("entry at the cross", p.optEntryNet ?? p.debit, s.entryNet); eq("riskDollars", p.riskDollars, s.riskDollars);
  eq("expiry", p.optExpiry || occExpiry(p), s.expiry); eq("ctrl", !!p.ctrl, false); eq("vetoShadow", !!p.vetoShadow, false);
  if (!a || !b || a.exp !== s.expiry || b.exp !== s.expiry || a.call !== s.call || b.call !== s.call || a.k !== s.atm || b.k !== s.k2) d.push("the two OCC symbols do not name the pinned legs");
  return d;
}

/** the canonical totals of a root's ledger (lib/reconcile.js cleanEraLedger) and its board, as this settle reports them */
function totalsOf(root, board) {
  const rc = require(path.join(root, "backend", "lib", "reconcile.js")), G = rc.cleanEraLedger();
  const sum = (a) => a.reduce((s, t) => s + t.pnl, 0), sumR = (a) => a.reduce((s, t) => s + t.rMult, 0);
  const sig = G.signals, opt = sig.filter((t) => t.cls === "Options"), since = sig.filter((t) => mtDay(t.closedAt) >= SINCE);
  const openOpt = board.filter((p) => p && p.cls === "Options" && !p.ctrl && !p.vetoShadow);
  return { signals: sig.length, signalsUsd: sum(sig), signalsSumR: sumR(sig), optionSignals: opt.length, optionSignalsUsd: sum(opt), sinceSignals: since.length, sinceUsd: sum(since), openNonControlOptions: openOpt.length, openNonControlOptionsRiskUsd: openOpt.reduce((s, p) => s + (p.riskDollars || 0), 0),
    byStrategyOptionsUsd: Object.fromEntries([...new Set(T.SPREADS.map((s) => s.strategy))].map((k) => [k, sum(opt.filter((t) => t.strategy === k))])) };
}
const roundTotals = (t) => ({ signals: t.signals, signalsUsd: cents(t.signalsUsd) / 100, meanR: t.signals ? +(t.signalsSumR / t.signals).toFixed(4) : null, optionSignals: t.optionSignals, optionSignalsUsd: cents(t.optionSignalsUsd) / 100,
  [`signalsClosedSince_${SINCE}_DenverCloseDay`]: t.sinceSignals, [`signalsUsdSince_${SINCE}`]: cents(t.sinceUsd) / 100, openNonControlOptionsOnBoard: t.openNonControlOptions, openNonControlOptionsRiskUsd: cents(t.openNonControlOptionsRiskUsd) / 100,
  optionSignalsUsdByStrategy: Object.fromEntries(Object.entries(t.byStrategyOptionsUsd).map(([k, v]) => [k, cents(v) / 100])) });

/**
 * plan({ root, closes, nowMs }) -> everything an apply would do, computed and checked, nothing written.
 *   closes = { reg: { SYM: { "YYYY-MM-DD": close } }, official: { ... }, officialNote, officialAsOf, source }
 *   pins   = the pinned table (twelve.cjs SPREADS). Only the selftest passes another one, to reach the guards that compare with it;
 *            run(), the one function the command line calls, never does.
 */
function plan({ root = L.REPO, closes, nowMs = Date.now(), pins = T.SPREADS } = {}) {
  const board = readJ(D(root, "board_positions.json")), tlog = readJ(D(root, "trade_log.json")), tombsRaw = readJ(D(root, "board_tombstones.json")), cr = readJ(D(root, "change-registry.json"));
  const issues = [];
  if (!Array.isArray(board) || !Array.isArray(tlog) || !Array.isArray(tombsRaw) || !Array.isArray(cr)) return { issues: ["board_positions.json, trade_log.json, board_tombstones.json and change-registry.json must each be an array"], rows: [], items: [] };
  let quarantine = new Set(); try { quarantine = new Set(readJ(D(root, "trade_log.quarantine-ids.json")).ids || []); } catch {}
  const tombs = new Set(tombsRaw.map((t) => (t && t.id) ?? t)), rowsById = new Map();
  for (const t of tlog) if (t && T.IDS.includes(t.id)) { if (!rowsById.has(t.id)) rowsById.set(t.id, []); rowsById.get(t.id).push(t); }
  const offAsOf = (closes && closes.officialAsOf) || new Date(nowMs - 16 * 60 * 1000).toISOString();
  const items = [];
  for (const s of pins) {
    const p = board.find((x) => x && x.id === s.id) || null, rows = rowsById.get(s.id) || [];
    const ours = rows.filter(isOurs), foreign = rows.filter((t) => !isOurs(t) && !(p ? voidedRestore(t, p) : (t.retired && t.voidForEvidence === true)));
    const it = { s, p, onBoard: !!p, tombstoned: tombs.has(s.id), ours: ours.length, foreign: foreign.length, state: null, row: null };
    if (quarantine.has(s.id)) issues.push(`${s.sym} ${s.id}: its id is on the trade log's quarantine list — a row for it would be dropped at the next ledger merge`);
    if (ours.length > 1) issues.push(`${s.sym}: ${ours.length} rows of this settle already in the ledger (expected at most one)`);
    if (foreign.length) { it.state = p ? "closed-elsewhere-still-on-board" : "closed-elsewhere"; if (p) issues.push(`${s.sym} ${s.id}: the ledger already holds a close of it that is not this settle's (${foreign.map((t) => t.reason).join(", ")}) and it is still on the board — a person must look`); }
    else if (ours.length) it.state = p || !it.tombstoned ? "half-done" : "done";
    else if (!p) { it.state = "gone"; issues.push(`${s.sym} ${s.id}: not on the board and not settled — it left the board without a settle; a person must look`); }
    else {
      it.state = "open";
      const d = pinDiffs(p, s); if (d.length) issues.push(`${s.sym} ${s.id}: the open position is not as pinned — ${d.join("; ")}`);
      if (it.tombstoned) issues.push(`${s.sym} ${s.id}: already tombstoned while still on the board`);
      const S = closes && closes.reg && closes.reg[s.sym] ? closes.reg[s.sym][s.expiry] : undefined;
      if (!Number.isFinite(S)) issues.push(`${s.sym}: no IEX raw daily close for ${s.expiry} — cannot settle${closes && closes.regNote ? ` (${closes.regNote})` : ""}`);
      else {
        if (S !== s.regClose) issues.push(`${s.sym}: the close of ${s.expiry} reads ${S} now, pinned ${s.regClose} on ${T.PINNED_ON} — the figures in NOTES.md would no longer be the figures booked`);
        const oc = closes.officialNote ? null : (closes.official && closes.official[s.sym] ? closes.official[s.sym][s.expiry] : undefined);
        const off = closes.officialNote ? { c: null, note: closes.officialNote } : Number.isFinite(oc) ? { c: oc, note: null } : { c: null, note: `no consolidated daily bar for ${s.sym} on ${s.expiry}` };
        const row = settleRow(p, S, off, offAsOf);
        row.obs.lateSettle = { settledAt: new Date(nowMs).toISOString(), by: T.MARKER, changeRegistryId: T.CR_ID, daysLate: Math.round((nowMs - row.closedAt) / 864e5),
          settlePrice: "the underlying's Alpaca IEX raw daily close of the expiry date (the bar the nightly settle reads; raw, because a late read of the adjusted bar is moved by later dividends)" };
        if (cents(row.pnl) !== cents(s.pnl)) issues.push(`${s.sym}: the settle computes ${usd(row.pnl)}, pinned ${usd(s.pnl)}`);
        if (!Number.isFinite(row.rMult)) issues.push(`${s.sym}: no finite R (riskDollars ${p.riskDollars})`);
        it.row = row; it.S = S; it.off = off;
        // beside, never booked: what the NIGHTLY settle's own call (the dividend-adjusted bar) would book for this spread if it settled it today
        const nc = closes.nightly && closes.nightly[s.sym] ? closes.nightly[s.sym][s.expiry] : undefined;
        it.nightly = Number.isFinite(nc) ? { c: nc, pnl: settleRow(p, nc, off, offAsOf).pnl } : null;
      }
    }
    items.push(it);
  }
  const newRows = items.filter((x) => x.row).map((x) => x.row);
  const removeIds = items.filter((x) => x.onBoard && (x.state === "open" || x.state === "half-done")).map((x) => x.s.id);
  const tombIds = items.filter((x) => !x.tombstoned && (x.state === "open" || x.state === "half-done")).map((x) => x.s.id);
  const crHas = cr.some((x) => x && x.id === T.CR_ID);
  // before / after on the canonical ledger: the new rows are all signals (finite R and P&L, not controls, not retired, inside the clean era)
  let before = null, after = null;
  try {
    const b = totalsOf(root, board); before = roundTotals(b);
    const add = (f) => newRows.reduce((s, r) => s + f(r), 0), a = { ...b, byStrategyOptionsUsd: { ...b.byStrategyOptionsUsd } };
    a.signals += newRows.length; a.signalsUsd += add((r) => r.pnl); a.signalsSumR += add((r) => r.rMult); a.optionSignals += newRows.length; a.optionSignalsUsd += add((r) => r.pnl);
    const inWin = newRows.filter((r) => mtDay(r.closedAt) >= SINCE); a.sinceSignals += inWin.length; a.sinceUsd += inWin.reduce((s, r) => s + r.pnl, 0);
    const rm = new Set(removeIds), gone = board.filter((p) => p && rm.has(p.id) && p.cls === "Options" && !p.ctrl && !p.vetoShadow);
    a.openNonControlOptions -= gone.length; a.openNonControlOptionsRiskUsd -= gone.reduce((s, p) => s + (p.riskDollars || 0), 0);
    for (const r of newRows) a.byStrategyOptionsUsd[r.strategy] = (a.byStrategyOptionsUsd[r.strategy] || 0) + r.pnl;
    after = roundTotals(a);
  } catch (e) { issues.push(`the canonical ledger could not be read for the before/after totals (${String(e.message).slice(0, 120)})`); }
  const booked = cents(newRows.reduce((s, r) => s + r.pnl, 0)) / 100;
  const byStrategy = Object.fromEntries([...new Set(newRows.map((r) => r.strategy))].map((k) => [k, cents(newRows.filter((r) => r.strategy === k).reduce((s, r) => s + r.pnl, 0)) / 100]));
  const offKnown = newRows.every((r) => r.obs.pnlOfficial != null), atOfficial = offKnown ? cents(newRows.reduce((s, r) => s + r.obs.pnlOfficial, 0)) / 100 : null;
  // beside, never booked and not in the registry row: the same rows at the close the nightly settle's own call would read today
  const priced = items.filter((x) => x.row), atNightly = priced.length && priced.every((x) => x.nightly) ? cents(priced.reduce((s, x) => s + x.nightly.pnl, 0)) / 100 : null;
  // a debit vertical's risk was sized on the mid and its entry is the cross, so a total loss books a little below -1R
  const underMinus1R = newRows.filter((r) => r.rMult < -1).map((r) => ({ sym: r.sym, rMult: +r.rMult.toFixed(3) }));
  const etDate = L.etNow(nowMs).date;
  const crRecord = {
    // affectedFrom: the earliest of the twelve expiry dates — the first PAST date a row lands on (backend/change-registry.js prints it for every comparability boundary)
    id: T.CR_ID, date: etDate, recordedAt: nowMs, affectedFrom: T.SPREADS.map((s) => s.expiry).sort()[0], area: "board option tickets — twelve expired spreads settled late (profit fix 4.2)", category: "settlement", breaksComparability: true,
    change: `${newRows.length} option spread(s) that were still open on the board after their options had expired were settled at their expiry intrinsic, removed from the board and tombstoned: six debit verticals from the board's own option tickets (five Ensemble, one Mean-Reversion; expiries 2026-09-04 to 2026-10-02) and six R21 credit wings (expiries 2026-09-16 and 2026-09-18). Each row is dated at its own expiry (closedAt = expiry 20:00 UTC, reason "expiry") and carries obs.lateSettle. Booked: ${usd(booked)}.`,
    why: "They never settled for two reasons, both repaired in backend/options-settle.js by the same package. (a) The six R21 wings were closed by the first live fire of the wing loss cap on 2026-09-14; that close was voided (retire tag wing-cap-quote-defect-2026-09-14) and the wings were restored to the board under the same id, so the voided row made the nightly settle read each of them as already settled. (b) The six debit verticals carry no optExpiry, and the nightly settle handled credit verticals only. Profit program 2026-10-10 item A.2; work order 4.2.",
    method: "Credit wings: backend/options-settle.js as written — (credit received at the cross - clamp of the breach to the width) x 100 x contracts - $0.65 x 2 legs x contracts. Debit verticals: the mirror image on the board's own option entry (optEntryNet, the debit paid at the cross) — (expiry value - debit paid) x 100 x contracts - the same commissions. R = P&L / riskDollars. Settle price: the underlying's Alpaca IEX raw daily close of the expiry date (the bar the nightly settle reads, taken raw: read this late, the adjusted bar is moved by every dividend since). The consolidated (SIP) raw close and the P&L it gives are recorded beside on each row (obs.settleUnderOfficial, obs.pnlOfficial) and move nothing.",
    newRule: "The credit wings' rule is the nightly settle's own, as written. The DEBIT-VERTICAL rule is NEW with this package and no test registers it: until now the nightly settle reported such a position as \"no registered settle rule; handle by hand\". It was derived as the mirror image of the wings' rule and is the operator's to accept. A debit vertical's risk was sized on the mid while its entry is the debit paid at the cross, so a total loss books below -1R (result.underMinus1R).",
    result: { settled: newRows.length, bookedUsd: booked, byStrategy, atOfficialCloseUsd: atOfficial, underMinus1R, reviewFigureUsd: T.TOTALS.evidenceUsd,
      reviewFigureNote: "the 2026-10-10 review printed -$2,534 for these twelve: mid entry, no commission, consolidated close. The booked figure uses the entry at the cross (the six debit spreads paid $186 more than their mids), $1.30 a spread in commissions ($15.60), and the IEX closes ($19 better than the consolidated ones on QQQ and NVDA).",
      rows: newRows.map((r) => ({ id: r.id, sym: r.sym, strategy: r.strategy, expiry: r.obs.optExpiry, close: r.obs.settleUnder, entry: r.entry, exit: r.exit, pnl: r.pnl, rMult: +r.rMult.toFixed(4), officialClose: r.obs.settleUnderOfficial, pnlOfficial: r.obs.pnlOfficial })),
      before, after },
    comparabilityNote: "Twelve rows enter the canonical signal ledger on PAST dates (2026-09-04 to 2026-10-02). Any figure computed from the ledger before this row that covers those dates differs by these rows when recomputed: daily and monthly board P&L, the Options class row, the option tickets of Ensemble and Mean-Reversion, R21's settled-wing count and mean. Reads sealed before this row stand as sealed.",
    sideEffects: `Six ids (the R21 wings) now have two ledger rows each: the voided cap close of 2026-09-14 (retired; lib/reconcile.js excludes it, so the canonical ledger counts each wing once) and the expiry settle. A READER THAT READS trade_log.json RAW, without lib/reconcile.js and without a retired filter, COUNTS EACH OF THE SIX WINGS TWICE from this row on: ${RAW_READERS.join(", ")}. No sealed read moves; the nightly output files of those readers do. Making them honour retired rows is a follow-up outside this package.`,
    doesNotEstablish: "Anything about a strategy. It completes the record; it does not change what any rule earned.",
    operator: "Josh 2026-10-12 (\"why not run the profit fixes now\"); 2026-10-10 (\"i want our profit to go up for all trading activities including plan e\")",
    files: [T.MARKER, ...WRITES.slice(0, 3)],
  };
  return { issues, items, newRows, removeIds, tombIds, crHas, crRecord, before, after, booked, byStrategy, atOfficial, atNightly, underMinus1R, allDone: items.every((x) => x.state === "done" || x.state === "closed-elsewhere") && crHas,
    nothingLeft: !newRows.length && !removeIds.length && !tombIds.length, counts: { board: board.length, tlog: tlog.length, tombs: tombsRaw.length, cr: cr.length } };
}

/**
 * the apply's fences -> [reasons]. The process list alone cannot show the close chain here (lib.cjs, fence 6), so the chain's own record
 * under root is asked too: these four files are the chain's, and nothing is written until the chain of the most recent session is on
 * record as finished. chain: the parsed record (the selftest passes one); left out, backend/data/chain-status.json under root is read.
 */
function guards({ root = L.REPO, nowMs = Date.now(), procs = undefined, holiday = L.houseHoliday, chain = undefined } = {}) {
  const why = L.windowRefusals(WRITES, nowMs, { holiday });
  let P = procs; if (P === undefined) { try { P = L.scanProcs(); } catch (e) { P = { error: e.message }; } }
  const target = [{ rel: "the board, the ledger and the change registry", busy: BUSY }];
  why.push(...L.procRefusals(target, P), ...L.idleRefusals(target, P, L.chainDone({ root, nowMs, holiday, chain })));
  return why;
}

/** write a checked plan -> { exit, lines }. Each file is re-read just before it is written, so nothing the server wrote meanwhile is lost. */
function apply(pl, { root = L.REPO, stateDir = L.PKG, nowMs = Date.now(), log = console.log } = {}) {
  const lines = [], say = (l) => { lines.push(l); log(l); };
  if (pl.issues.length) { say("REFUSED — nothing written:"); for (const w of pl.issues) say(`  - ${w}`); return { exit: 2, lines }; }
  if (pl.nothingLeft && pl.crHas) { say("nothing to do — the twelve are settled, off the board, tombstoned, and the change-registry row exists."); return { exit: 0, lines }; }
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-"), bdir = path.join(stateDir, "backups", `${stamp}-settle`);
  fs.mkdirSync(bdir, { recursive: true });
  for (const rel of WRITES) { const src = L.abs(root, rel), dst = path.join(bdir, path.basename(rel)); fs.copyFileSync(src, dst); if (L.sha256(fs.readFileSync(dst)) !== L.sha256(fs.readFileSync(src))) { say(`REFUSED — nothing written: the copy of ${rel} does not verify`); return { exit: 2, lines }; } }
  say(`  copies of the four files as they were: ${bdir}`);
  const ids = new Set(pl.newRows.map((r) => r.id));
  // 1 the ledger (new rows first, as the nightly settle writes them); a row already there is never added twice
  { const f = D(root, "trade_log.json"), cur = readJ(f), have = new Set(cur.filter(isOurs).map((t) => t.id)), add = pl.newRows.filter((r) => !have.has(r.id));
    if (add.length) L.writeJson(f, [...add, ...cur]); say(`  trade_log.json          +${add.length} row(s) (${cur.length} -> ${cur.length + add.length})`); }
  // 2 the board
  { const f = D(root, "board_positions.json"), cur = readJ(f), rm = new Set(pl.removeIds), next = cur.filter((p) => !(p && rm.has(p.id)));
    if (next.length !== cur.length) L.writeJson(f, next); say(`  board_positions.json    -${cur.length - next.length} position(s) (${cur.length} -> ${next.length})`); }
  // 3 the tombstones
  { const f = D(root, "board_tombstones.json"), cur = readJ(f), have = new Set(cur.map((t) => (t && t.id) ?? t)), add = pl.tombIds.filter((id) => !have.has(id));
    if (add.length) L.writeJson(f, [...cur, ...add.map((id) => ({ id, ts: nowMs }))]); say(`  board_tombstones.json   +${add.length} tombstone(s)`); }
  // 4 the change registry (one row, once)
  { const f = D(root, "change-registry.json"), cur = readJ(f);
    if (!cur.some((x) => x && x.id === T.CR_ID)) { cur.push(pl.crRecord); L.writeJson(f, cur); say(`  change-registry.json    +1 row (${T.CR_ID}, breaksComparability true)`); } else say("  change-registry.json    the row is already there"); }
  // 5 read back
  const bad = [];
  try {
    const board = readJ(D(root, "board_positions.json")), tlog = readJ(D(root, "trade_log.json")), tombs = new Set(readJ(D(root, "board_tombstones.json")).map((t) => (t && t.id) ?? t)), cr = readJ(D(root, "change-registry.json"));
    for (const id of ids) {
      if (board.some((p) => p && p.id === id)) bad.push(`${id} is still on the board`);
      if (!tombs.has(id)) bad.push(`${id} has no tombstone`);
      if (tlog.filter((t) => t && t.id === id && isOurs(t)).length !== 1) bad.push(`${id} does not have exactly one row of this settle`);
    }
    if (cr.filter((x) => x && x.id === T.CR_ID).length !== 1) bad.push("the change registry does not hold exactly one row of this settle");
    if (pl.after) { const now = roundTotals(totalsOf(root, board)); for (const k of ["signals", "signalsUsd", "optionSignals", "optionSignalsUsd", "openNonControlOptionsOnBoard"]) if (now[k] !== pl.after[k]) bad.push(`after the write the canonical ledger reads ${k} ${now[k]}, the plan said ${pl.after[k]}`); }
  } catch (e) { bad.push(`the read-back failed (${String(e.message).slice(0, 120)})`); }
  try { fs.appendFileSync(path.join(stateDir, "deploy-log.jsonl"), JSON.stringify({ at: new Date().toISOString(), script: "settle-expired-twelve", result: bad.length ? "problems" : "settled", rows: pl.newRows.length, bookedUsd: pl.booked, problems: bad, backups: bdir }) + "\n"); } catch {}
  if (bad.length) { say("SETTLE WRITTEN, BUT THE READ-BACK DISAGREES:"); for (const b of bad) say(`  - ${b}`); say(`  the files as they were are in ${bdir}`); return { exit: 1, lines }; }
  say(`SETTLED ${pl.newRows.length} spread(s): ${usd(pl.booked)} booked on their expiry dates; read back and verified. No order, no message, no restart.`);
  return { exit: 0, lines };
}

/**
 * the expiry-day closes, read now: the IEX raw bar (the settle price), the consolidated raw bar (recorded beside), and — printed beside,
 * never booked — the bar the NIGHTLY settle's own call would read today for the same dates (backend/options-settle.js names no feed and
 * no adjustment, so the library's defaults: iex, dividend-adjusted). That third read is where NOTES.md's adjusted figures come from.
 */
async function fetchCloses({ root = L.REPO, nowMs = Date.now() } = {}) {
  const { fetchBars } = require(path.join(root, "backend", "lib", "alpaca-bars.js"));
  const syms = [...new Set(T.SPREADS.map((s) => s.sym))], earliest = T.SPREADS.map((s) => s.expiry).sort()[0], today = L.etNow(nowMs).date;
  const table = (bars) => Object.fromEntries(Object.entries(bars || {}).map(([s, a]) => [s, Object.fromEntries((a || []).map((b) => [String(b.t).slice(0, 10), b.c]))]));
  const out = { reg: {}, official: {}, nightly: null, regNote: null, officialNote: null, nightlyNote: null, officialAsOf: new Date(nowMs - 16 * 60 * 1000).toISOString(), source: "alpaca-bars.js fetchBars: iex raw 1Day (settle price); sip raw 1Day ending 16 minutes ago (recorded beside); the nightly settle's own call, iex dividend-adjusted (printed beside)" };
  try { out.reg = table((await fetchBars(syms, { start: earliest, end: today, timeframe: "1Day", feed: "iex", adjustment: "raw", minBars: 1, quiet: true })).bars); } catch (e) { out.regNote = String((e && e.message) || e).slice(0, 160); }
  try { out.official = table((await fetchBars(syms, { start: earliest, end: out.officialAsOf, timeframe: "1Day", feed: "sip", adjustment: "raw", requireAll: false, minBars: 1, quiet: true })).bars); } catch (e) { out.officialNote = `official close not fetched (${String((e && e.message) || e).slice(0, 80)})`; }
  try { out.nightly = table((await fetchBars(syms, { start: earliest, end: today, timeframe: "1Day", requireAll: false, minBars: 1, quiet: true })).bars); } catch (e) { out.nightlyNote = `not read (${String((e && e.message) || e).slice(0, 80)})`; }
  return out;
}
const pinnedCloses = (nowMs = Date.now()) => ({ reg: Object.fromEntries(T.SPREADS.map((s) => [s.sym, { [s.expiry]: s.regClose }])), official: Object.fromEntries(T.SPREADS.map((s) => [s.sym, { [s.expiry]: s.officialClose }])), nightly: null, regNote: null, officialNote: null, nightlyNote: "not read offline (it moves with every dividend, so it is never pinned): run without --pinned", officialAsOf: new Date(nowMs - 16 * 60 * 1000).toISOString(), source: `the closes pinned in twelve.cjs (read ${T.PINNED_ON})` });

function report(pl, closes, log = console.log) {
  log(`THE TWELVE EXPIRED SPREADS — closes from ${closes.source}`);
  log(`  ${"sym".padEnd(6)}${"strategy".padEnd(16)}${"legs".padEnd(15)}${"expiry".padEnd(12)}${"close".padStart(8)}${"entry".padStart(8)}${"exit".padStart(8)}${"booked".padStart(12)}${"R".padStart(8)}   ${"official".padStart(8)}${"there".padStart(12)}${"review".padStart(9)}   ${"adjusted".padStart(8)}${"there".padStart(12)}  state`);
  for (const it of pl.items) {
    const s = it.s, r = it.row, n = it.nightly;
    log(`  ${s.sym.padEnd(6)}${s.strategy.padEnd(16)}${`${s.call ? "C" : "P"} ${s.atm}/${s.k2} ${s.credit ? "cr" : "db"}`.padEnd(15)}${s.expiry.padEnd(12)}${String(r ? r.obs.settleUnder : "-").padStart(8)}${String(r ? r.entry : s.entryNet).padStart(8)}${String(r ? r.exit : "-").padStart(8)}${(r ? usd(r.pnl) : "-").padStart(12)}${(r ? r.rMult.toFixed(3) : "-").padStart(8)}   ${String(r && r.obs.settleUnderOfficial != null ? r.obs.settleUnderOfficial : "n/a").padStart(8)}${(r ? usd(r.obs.pnlOfficial) : "-").padStart(12)}${("$" + s.evidenceUsd).padStart(9)}   ${String(n ? n.c : "n/a").padStart(8)}${(n ? usd(n.pnl) : "n/a").padStart(12)}  ${it.state}`);
  }
  log(`  booked by this settle: ${usd(pl.booked)}   (${Object.entries(pl.byStrategy).map(([k, v]) => `${k} ${usd(v)}`).join(", ") || "nothing to book"})`);
  log(`  the same rule at the official (consolidated) close: ${usd(pl.atOfficial)}   ·   the 2026-10-10 review's figure (mid entry, no commission, consolidated close): $${T.TOTALS.evidenceUsd.toLocaleString("en-US")}`);
  // "adjusted": what the nightly settle's OWN call reads for the same dates today (iex, dividend-adjusted). Never booked; it is why this settle reads raw and runs before the deploy.
  const moved = pl.items.filter((x) => x.row && x.nightly && cents(x.nightly.pnl) !== cents(x.row.pnl));
  if (pl.atNightly != null) log(`  the same rule at the close the NIGHTLY settle's own call reads today (the "adjusted" columns: iex, dividend-adjusted): ${usd(pl.atNightly)} — ${usd(cents(pl.atNightly - pl.booked) / 100)} from the booked figure${moved.length ? ` (${moved.map((x) => `${x.s.sym} ${x.s.expiry} reads ${x.nightly.c} against ${x.row.obs.settleUnder} as traded: ${usd(cents(x.nightly.pnl - x.row.pnl) / 100)}`).join("; ")})` : " (no spread moves)"}. Not booked.`);
  else log(`  the same rule at the close the NIGHTLY settle's own call would read today (the "adjusted" columns): n/a — ${closes.nightlyNote || ((pl.newRows || []).length ? "one of the adjusted closes is missing" : "nothing left to price")}`);
  if ((pl.underMinus1R || []).length) log(`  below -1R (a debit vertical's risk was sized on the mid, its entry is the debit paid at the cross): ${pl.underMinus1R.map((x) => `${x.sym} ${x.rMult.toFixed(3)}R`).join(", ")}`);
  if ((pl.newRows || []).some((r) => r.obs.settleKind === "debit-vertical")) log("  NOTE: the debit-vertical rule is NEW with this package (the nightly settle prints \"no registered settle rule; handle by hand\" for these today). It is the operator's to accept.");
  if (pl.before && pl.after) {
    log("  BEFORE -> AFTER (canonical ledger, lib/reconcile.js; signal tickets only):");
    for (const k of Object.keys(pl.before)) if (typeof pl.before[k] !== "object") log(`    ${k.padEnd(44)} ${String(pl.before[k]).padStart(12)} -> ${String(pl.after[k]).padStart(12)}`);
    for (const k of Object.keys(pl.before.optionSignalsUsdByStrategy)) log(`    ${("option tickets, " + k).padEnd(44)} ${String(pl.before.optionSignalsUsdByStrategy[k]).padStart(12)} -> ${String(pl.after.optionSignalsUsdByStrategy[k]).padStart(12)}`);
  }
}

/**
 * run({ apply, pinned }) -> { exit, status, lines } — THE WHOLE COMMAND, and the only way the command line reaches apply(). The fences
 * (guards) stand here, in front of the write, so the script a person runs cannot write inside the session, with the chain running or
 * on an unreadable process list, whatever the plan says. The command line passes the two flags and nothing else; root, stateDir, the
 * clock, the process list, the calendar and the closes are for the selftest, which has no network and no real board.
 *   exit 0  dry run with no data issue / settled / nothing left to do        exit 1  dry run that found a data issue, or a read-back that disagrees
 *   exit 2  REFUSED, nothing written: --apply with --pinned (an apply always re-reads the closes), a fence, or a data guard
 */
async function run({ apply: doApply = false, pinned = false, root = L.REPO, stateDir = L.PKG, nowMs = Date.now(), procs = undefined, holiday = L.houseHoliday, chain = undefined, closes = undefined, log = console.log } = {}) {
  const lines = [], say = (l) => { lines.push(l); log(l); };
  if (doApply && pinned) { say("REFUSED — nothing written: an apply always re-reads the closes, so --apply and --pinned cannot be given together (--pinned is the offline dry run)."); return { exit: 2, status: "refused", lines }; }
  const c = closes !== undefined ? closes : pinned ? pinnedCloses(nowMs) : await fetchCloses({ root, nowMs });
  if (c.regNote) say(`THE CLOSES COULD NOT BE READ (${c.regNote}) — nothing can be priced; an apply would refuse.`);
  const pl = plan({ root, closes: c, nowMs });
  report(pl, c, say);
  const gz = guards({ root, nowMs, procs, holiday, chain });
  if (!doApply) {
    say(`\nthe change-registry row an apply would write:\n${JSON.stringify(pl.crRecord, null, 1)}`);
    if (pl.issues.length) { say("\nAN APPLY WOULD REFUSE — the data:"); for (const w of pl.issues) say(`  - ${w}`); }
    if (gz.length) { say("\nAN APPLY NOW WOULD REFUSE — the fences:"); for (const w of gz) say(`  - ${w}`); }
    if (!pl.issues.length && !gz.length) say(pl.nothingLeft && pl.crHas ? "\nnothing left to do — already settled and recorded." : "\nan apply NOW would pass every guard.");
    say("DRY RUN — nothing was written.");
    return { exit: pl.issues.length ? 1 : 0, status: "dry", lines, plan: pl };
  }
  if (gz.length) { say("REFUSED — nothing written:"); for (const w of gz) say(`  - ${w}`); return { exit: 2, status: "refused", lines, plan: pl }; }
  const r = apply(pl, { root, stateDir, nowMs, log: say });
  return { exit: r.exit, status: r.exit === 0 ? "settled" : r.exit === 2 ? "refused" : "problems", lines, plan: pl };
}

if (require.main === module) {
  const argv = process.argv.slice(2), unknown = argv.filter((a) => !["--apply", "--pinned"].includes(a));
  if (unknown.length) { console.error(`usage: settle-expired-twelve.cjs [--pinned | --apply]   (an apply always re-reads the closes) — unknown: ${unknown.join(" ")}`); process.exit(2); }
  run({ apply: argv.includes("--apply"), pinned: argv.includes("--pinned") }).then((r) => process.exit(r.exit)).catch((e) => { console.error(`settle-expired-twelve failed: ${e.stack || e.message}`); process.exit(1); });
}
module.exports = { plan, apply, run, guards, fetchCloses, pinnedCloses, settleRow, pinDiffs, totalsOf, roundTotals, report, isOurs, voidedRestore, BUSY, WRITES, SINCE, RAW_READERS };
