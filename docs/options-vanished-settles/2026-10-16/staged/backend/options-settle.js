#!/usr/bin/env node
/**
 * OPTIONS EXPIRY SETTLE — server-side. Written 2026-08-19, the day the gap was found.
 *
 * WHY. R21's first wings expired Monday 08-17 and by Wednesday ZERO had settled: the app marks
 * open wings from live OCC quotes, and an expired contract has no quotes, so optMark returns
 * null and the fail-closed rule (correct for marking!) left every expired wing frozen on the
 * board forever. The premium-harvest test reads at n>=200 SETTLED wings — with no settlement
 * path it would have read at n=0 in perpetuity. This is also the top item from the hardening
 * list: settlement is evidence, and evidence cannot depend on a browser tab being open.
 *
 * WHAT IT DOES. For every board Option past expiry (credit verticals only — the only structure
 * R21 writes), fetch the underlying's completed daily close on the expiry date and settle at
 * intrinsic:
 *     short put spread  (sell K1, buy K2 < K1): cost = clamp(K1 - S, 0, K1 - K2)
 *     short call spread (sell K1, buy K2 > K1): cost = clamp(S - K1, 0, K2 - K1)
 *     pnl = (creditKept - cost) * 100 * contracts - commissions
 * Commissions: 2 legs in at $0.65 (Schwab); expiry itself is commission-free (worthless legs
 * just die, ITM legs cash out via exercise/assignment at no per-leg fee). The app's live mark
 * charges 4 legs because closing early crosses the spread twice — expiry does not.
 *
 * Settled wings land in trade_log.json (reason "expiry") and the wing is removed from
 * board_positions.json with a tombstone, exactly like any other close. Idempotent by trade id.
 *
 * FAIL-CLOSED RULES (the D37/D48 family):
 *   - a wing settles only when its expiry date's daily bar EXISTS and is complete
 *     (expiry < today ET, or == today and past 16:10 ET)
 *   - a non-credit expired option is REPORTED, never guessed at
 *   - if expired wings exist and none could be settled, exit 2 so the chain surfaces it
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const { fetchBars } = require("./lib/alpaca-bars");

const BOARD = D("board_positions.json");
const TOMBS = D("board_tombstones.json");
const TLOG = D("trade_log.json");
const COMMISSION_PER_LEG = 0.65, LEGS_AT_ENTRY = 2;
/**
 * PROFIT FIXES 4.2 and 4.7 (2026-10-12).
 *
 * 4.2 — WHY TWELVE EXPIRED SPREADS SAT ON THE BOARD, AND THE REPAIR. Two causes.
 *   (a) Six R21 wings were closed by the first live fire of the loss cap on 2026-09-14. That close was voided (a retire tag and
 *       voidForEvidence) and the wings were put back on the board UNDER THE SAME ID. The "already settled" test below asked only "is
 *       this id in the ledger", so the voided row hid each wing from its own expiry settle for good. A voided row no longer counts when
 *       the open position says it was restored after exactly that tag (obs.restoredAfter).
 *   (b) Six debit verticals from the board's own option tickets carry no optExpiry (only a day count), and this script settled credit
 *       verticals only. The expiry is now read from the two OCC symbols when the field is absent, and a debit vertical whose two legs
 *       verify (same expiry, same side, strikes equal to the ticket's own) settles at the same expiry intrinsic: what the spread is
 *       worth at the close, less what it cost at the cross (optEntryNet, the board's own entry for every option mark), less the entry
 *       commissions. Anything else that is not a credit vertical is still REPORTED and never guessed at.
 *       THE DEBIT RULE IS NEW WITH THIS FIX. No test registers it: until now this script said "no registered settle rule; handle by
 *       hand" for such a position. It is the mirror image of the wings' rule, a standing rule from the night this file is applied, and
 *       the operator's to accept (docs/profit-fixes/2026-10-12/a-booking/NOTES.md). Risk was sized on the mid and the entry is the
 *       cross, so a debit vertical that expires worthless books a little below -1R.
 *   THE WINGS NEVER WAIT ON A DEBIT VERTICAL. The registered bar call throws when any symbol it asks for returns no bar, and then no
 *       wing settles that night. So it still asks for the credit wings' symbols and nothing else, with the options it has always had.
 *       The debit verticals' closes are read by a second call of their own, which requires no symbol and has its own catch: a debit
 *       vertical whose underlying has no bar is said on a line of its own and stays on the board, and every wing settles as before.
 *
 * 4.7 — THE OFFICIAL CLOSE, RECORDED BESIDE. The settle price is unchanged: the daily bar this script has always read. Each settled row
 *   also carries the consolidated (SIP) raw daily close of its expiry date and the P&L that close would give, as new obs fields. SIP
 *   data is 15 minutes delayed on this account, so a same-day close is recorded only once that delay has passed the bell, and is null
 *   with the reason before. Nothing registered reads the new fields.
 */
const occLeg = (s) => { const m = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(s || "").replace(/\s+/g, "")); return m ? { exp: `20${m[2]}-${m[3]}-${m[4]}`, call: m[5] === "C", k: +m[6] / 1000 } : null; };
/** the expiry both OCC legs name, or null */
const occExpiry = (p) => { const a = occLeg(p.occAtm), b = occLeg(p.occK2); return a && b && a.exp === b.exp ? a.exp : null; };
/** a debit vertical this script may settle: real legs that verify against the ticket's own strikes and side, long the dearer strike */
const isDebitVertical = (p) => {
  const a = occLeg(p.occAtm), b = occLeg(p.occK2), paid = p.optEntryNet ?? p.debit;
  return !p.optCredit && p.optReal === true && !!a && !!b && a.exp === b.exp && a.call === b.call && a.call === !!p.optCall && a.k === p.optAtm && b.k === p.optK2
    && (a.call ? p.optAtm < p.optK2 : p.optAtm > p.optK2) && Number.isFinite(paid) && paid > 0;
};
/** a ledger row that is the VOIDED close of a wing that was then restored to the board under the same id */
const voidedRestore = (t, p) => !!(t && p && t.id === p.id && t.retired && t.voidForEvidence === true && p.obs && p.obs.restoredAfter === t.retired);

const etToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const etHM = () => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

/**
 * OPTIONS-VANISHED-SETTLES (2026-10-16) — THE EXPIRED SPREAD THE BROKER SIMPLY STOPS REPORTING.
 *
 * THE DEFECT. This sweep closes an expired spread only where it holds a rule that can PRICE it: a credit vertical (the wings) or a
 * verified debit vertical (fix 4.2). Every other expired option is printed on the "NOT SETTLING" line and left on the board, and so is
 * a vertical whose underlying returned no completed bar. NOTHING DOWNSTREAM CLOSES IT EITHER, because an expiry is not a fill: the
 * broker reports no closing trade for an expired contract — the position simply STOPS BEING REPORTED the next morning. There is no fill
 * to mirror and no exit to reconcile, so the row sits open on the board for good, marked at nothing and counted in no population.
 *
 * THE RULE ADDED HERE. A spread PAST ITS EXPIRY whose two OCC legs the broker NO LONGER REPORTS is settled at its intrinsic value at the
 * expiry close and written to the ledger as a settle row with a tag of its own: reason "expiry-vanished", obs.settleKind "vanished-legs",
 * obs.settleTag "vanished-legs-2026-10-16". THIS RULE IS NEW. No registered test asks for it; it is a standing rule from the night this
 * file is applied and the operator's to accept (docs/options-vanished-settles/2026-10-16/NOTES.md, "The standing rule").
 *
 * WHAT MAY BE BELIEVED AND WHAT MAY NOT — fail-closed in every direction; nothing below is ever guessed:
 *   · "the broker no longer reports the legs" is read ONLY from the options mirror's STORED snapshot of the option legs the broker
 *     reports (backend/data/alpaca-options-positions.json). NO BROKER CALL IS MADE HERE, by this file or by its tests. A snapshot that
 *     is absent, unreadable, undated, or taken on or before the expiry date proves nothing and settles nothing.
 *   · the price is the underlying's close ON THE EXPIRY DATE, taken from what is STORED: the position's own recorded expiry close, then
 *     backend/data/underlying-closes.json, then the completed daily bar this run has already read for its wings. Never another day's
 *     close, never a last price, a mid or an estimate.
 *   · a spread whose two legs do not verify as one vertical, whose entry price was never recorded, or for which no stored close exists
 *     is NOT settled and NOT guessed: it is marked UNKNOWN on the board (vanishedUnknown — the reason, the expiry and the date it was
 *     first seen), said on a line of its own, and the run ends 2 so the chain surfaces it. It settles by itself on a later night once
 *     the missing close is stored. A spread the snapshot STILL reports is left exactly as it was before this rule existed.
 *
 * AND THE MIRROR'S OWN ORDERS. An option order the mirror sent and the broker never filled is not cancelled when the contract expires:
 * it is dropped, so the mirror's log can read "sent" for ever. Every such row whose expiry has passed is marked EXPIRED in a record of
 * this sweep's own (backend/data/options-mirror-expired.json, idempotent — a mark keeps the date it was first made). The mirror's
 * append-only log is read and never rewritten.
 */
const SNAP = D("alpaca-options-positions.json"), OMIR = D("alpaca-options-mirror.jsonl"), CLOSES = D("underlying-closes.json"), MARKS = D("options-mirror-expired.json");
const VANISHED_TAG = "vanished-legs-2026-10-16", VANISHED_REASON = "expiry-vanished";
/** a JSON file, or null when it is absent or unreadable — a missing side file never stops a wing from settling */
const readJsonOr = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
/** a .jsonl file -> { rows, bad } (bad = lines that would not parse, counted and reported, never silently dropped); null when the file cannot be read at all */
function readJsonlOr(f) { let t; try { t = fs.readFileSync(f, "utf8"); } catch { return null; } const rows = []; let bad = 0; for (const l of t.split("\n")) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch { bad++; } } return { rows, bad }; }
const occNorm = (s) => String(s == null ? "" : s).replace(/\s+/g, "").toUpperCase();
const etDateOf = (ms) => (Number.isFinite(ms) ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms)) : null);
/**
 * THE ONE PIECE OF ARITHMETIC. The value of a vertical at its expiry close, anchored on the ticket's own optAtm leg (the money side:
 * the short leg of a credit vertical, the long leg of a debit one): what the breach is worth, floored at 0 and capped at the width.
 * It is the same expression the wings have always settled at, written once so the two rules cannot drift apart (the selftest holds them
 * to each other on a grid).
 */
const verticalIntrinsic = (call, anchorK, otherK, S) => Math.min(Math.max(call ? S - anchorK : anchorK - S, 0), Math.abs(otherK - anchorK));
/** the two OCC legs of a board option verified as ONE vertical — both parse, one expiry, one side, two strikes, the optAtm leg on the money side -> { legs } | { why } */
function vanLegs(p) {
  const a = occLeg(p && p.occAtm), b = occLeg(p && p.occK2);
  if (!a || !b) return { why: "its two OCC leg symbols (occAtm, occK2) do not both parse" };
  if (a.exp !== b.exp) return { why: `its two OCC legs name different expiries (${a.exp} and ${b.exp})` };
  if (a.call !== b.call) return { why: "its two OCC legs are not the same side (one call, one put)" };
  if (a.k === b.k) return { why: `its two OCC legs name the same strike (${a.k})` };
  if (a.call ? !(a.k < b.k) : !(a.k > b.k)) return { why: `its optAtm leg (${a.k}) is not the money side of a ${a.call ? "call" : "put"} vertical against ${b.k}` };
  return { legs: { a: { ...a, occ: occNorm(p.occAtm) }, b: { ...b, occ: occNorm(p.occK2) } } };
}
/** every OCC symbol a stored broker snapshot reports -> a Set, or null when it holds no readable list of positions */
function snapshotLegs(snap) {
  const list = Array.isArray(snap) ? snap : snap && typeof snap === "object" ? (Array.isArray(snap.positions) ? snap.positions : Array.isArray(snap.legs) ? snap.legs : null) : null;
  if (!list) return null;
  const out = new Set();
  for (const x of list) { const s = typeof x === "string" ? x : x && typeof x === "object" ? x.symbol || x.occ || x.sym : null; if (s) out.add(occNorm(s)); }
  return out;
}
/**
 * Has the broker stopped reporting both legs? FAIL-CLOSED: the answer is "cannot tell" ({ ok: false, why }) unless a snapshot dated on
 * an ET date strictly AFTER the expiry names NEITHER leg. An absent, unreadable, undated or not-yet-late-enough snapshot settles nothing.
 */
function vanishedCheck(legs, expiry, snap) {
  const set = snapshotLegs(snap);
  if (!set) return { ok: false, why: `there is no readable broker snapshot (backend/data/alpaca-options-positions.json) — nothing is assumed about the broker` };
  const d = etDateOf(Date.parse(snap && !Array.isArray(snap) ? snap.asOf : null));
  if (!d) return { ok: false, why: "the broker snapshot carries no readable asOf — its age cannot be told" };
  if (!(d > expiry)) return { ok: false, why: `the broker snapshot is of ${d}, not of a date after the expiry ${expiry} — the legs would still be reported` };
  const still = [legs.a.occ, legs.b.occ].filter((s) => set.has(s));
  if (still.length) return { ok: false, why: `the broker snapshot of ${d} still reports ${still.join(" and ")}` };
  return { ok: true, asOf: snap.asOf, asOfDate: d };
}
/** the underlying's close on `date`, from what is STORED only -> { c, src }, or { c: null, src: null } when nothing stored has it */
function storedCloseFor(p, date, closes, runClose) {
  const own = p && Number.isFinite(p.optExpiryClose) ? p.optExpiryClose : p && p.obs && Number.isFinite(p.obs.optExpiryClose) ? p.obs.optExpiryClose : null;
  if (own != null) return { c: own, src: "the expiry close recorded on the position itself" };
  const t = closes && typeof closes === "object" ? closes[p.sym] : null, c = t && typeof t === "object" ? t[date] : null;
  if (Number.isFinite(c)) return { c, src: "backend/data/underlying-closes.json" };
  const r = typeof runClose === "function" ? runClose(p.sym, date) : null;
  if (Number.isFinite(r)) return { c: r, src: "the completed daily bar this run read" };
  return { c: null, src: null };
}
/** the settle row for a spread whose legs have vanished, or the reason it cannot be priced -> { row } | { why } */
function vanishedRow(p, { legs, exp, S, src, snapAsOf }) {
  const { a, b } = legs, contracts = p.contracts || 1, width = Math.abs(b.k - a.k), isDebit = !p.optCredit, basis = p.optEntryNet ?? p.debit;
  if (!Number.isFinite(basis)) return { why: "no entry price is recorded on it (optEntryNet / debit), so its P&L cannot be computed" };
  if (!(basis > 0)) return { why: `the entry price recorded on it is ${basis}, not a ${isDebit ? "debit paid" : "credit received"} — its P&L cannot be computed` };
  const value = verticalIntrinsic(a.call, a.k, b.k, S);
  const commissions = COMMISSION_PER_LEG * LEGS_AT_ENTRY * contracts;   // two legs in; the expiry itself is commission-free, exactly as the wings
  const pnl = (isDebit ? value - basis : basis - value) * 100 * contracts - commissions;
  return { row: {
    ...(p.retired ? { retired: p.retired, retireNote: p.retireNote, voidForEvidence: p.voidForEvidence } : {}),
    id: p.id, sym: p.sym, cls: "Options", dir: p.dir, sizeLabel: p.sizeLabel,
    ctrl: !!p.ctrl, vetoShadow: !!p.vetoShadow, veto: p.veto ?? null, ctrlRand: !!p.ctrlRand, ...(p.vetoWhy ? { vetoWhy: p.vetoWhy, vetoAt: p.vetoAt } : {}),
    entry: basis, exit: +value.toFixed(4), rMult: p.riskDollars ? pnl / p.riskDollars : null, pnl: +pnl.toFixed(2),
    reason: VANISHED_REASON, openedAt: p.addedAt, closedAt: Date.parse(exp + "T20:00:00Z"),
    // a spread this rule settles may come from anywhere on the board, so its strategy is the one it carries and NEVER a default: labelling
    // an unknown spread "R21-premium" would put a row the premium-harvest population never earned into it.
    conf: p.conf ?? null, strategy: p.strategy ?? null, rr: p.rr ?? null, score: p.score ?? null,
    nBull: p.nBull ?? null, nBear: p.nBear ?? null, total: p.total ?? null,
    riskDollars: p.riskDollars ?? null, optStruct: p.optStruct ?? null, contracts, optEntryNet: p.optEntryNet ?? null, debit: p.debit ?? null,
    stopDist: p.stopDist ?? null, sleeve: p.sleeve ?? null,
    obs: { ...(p.obs || {}), settleUnder: S, width, optCall: !!a.call, shortK: isDebit ? b.k : a.k, longK: isDebit ? a.k : b.k, optExpiry: exp, sleeve: p.sleeve ?? null,
      settleKind: "vanished-legs", settleTag: VANISHED_TAG,
      entryBasis: isDebit ? "optEntryNet (the debit paid at the cross)" : "optEntryNet (the credit received at the cross)",
      settleCloseSource: src, brokerSnapshotAsOf: snapAsOf, brokerLegs: [a.occ, b.occ],
      ...(p.optExpiryFrom ? { optExpiryFrom: p.optExpiryFrom } : {}) },
  } };
}
/** the OCC symbols a mirror-log row names, in the shapes the options mirror writes them (occAtm / occK2, legs[], occ[]) */
function mirrorLegsOf(r) {
  const raw = [r && r.occAtm, r && r.occK2].concat([].concat((r && (r.legs || r.occ)) || []));
  const syms = raw.map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? x.symbol || x.occ || x.sym : null)).filter((x) => typeof x === "string").map(occNorm);
  return [...new Set(syms.filter((s) => occLeg(s)))];
}
/** the expiry a mirror-log row names — its own field, or the one date both its OCC legs agree on; null when it names none */
function rowExpiry(r) {
  if (r && typeof r.optExpiry === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.optExpiry)) return r.optExpiry.slice(0, 10);
  const exps = [...new Set(mirrorLegsOf(r).map((s) => occLeg(s).exp))];
  return exps.length === 1 ? exps[0] : null;
}
/** the mirror-log rows still shown as "sent" whose expiry close has passed: the order can never fill again */
function expiredMirrorRows(rows, isPast) {
  const out = [];
  for (const r of rows || []) {
    if (!r || typeof r !== "object" || String(r.status) !== "sent") continue;
    const exp = rowExpiry(r); if (!exp || !isPast(exp)) continue;
    out.push({ key: `${r.ticketId ?? ""}|${r.orderId ?? r.clientOrderId ?? r.cid ?? ""}|${exp}`, ticketId: r.ticketId ?? null, sym: r.sym ?? null,
      orderId: r.orderId ?? null, optExpiry: exp, legs: mirrorLegsOf(r), sentAt: r.ts ?? null, was: "sent", status: "expired" });
  }
  return out;
}
/** the marks document, idempotent: a row already marked keeps the date it was first marked -> { added, marked, doc } */
function markExpiredMirror(prev, rows, bad, isPast, nowIso) {
  const by = new Map((prev && Array.isArray(prev.marked) ? prev.marked : []).filter((m) => m && m.key).map((m) => [m.key, m]));
  let added = 0;
  for (const h of expiredMirrorRows(rows, isPast)) if (!by.has(h.key)) { by.set(h.key, { ...h, markedAt: nowIso }); added++; }
  const marked = [...by.values()].sort((x, y) => String(x.key).localeCompare(String(y.key)));
  return { added, marked, doc: { spec: "options-mirror-expired-v1", asOf: nowIso, tag: VANISHED_TAG,
    rule: "a row of the options mirror's log still shown as \"sent\" past its expiry close is marked expired here: the contract is gone and the order can never fill. The mirror's append-only log is read and never rewritten; a mark keeps the date it was first made.",
    unparsableLogLines: bad, marked } };
}

module.exports = { occLeg, occExpiry, isDebitVertical, voidedRestore, verticalIntrinsic, vanLegs, snapshotLegs, vanishedCheck, storedCloseFor, vanishedRow,
  mirrorLegsOf, rowExpiry, expiredMirrorRows, markExpiredMirror, readJsonOr, readJsonlOr, occNorm, etDateOf, VANISHED_TAG, VANISHED_REASON, COMMISSION_PER_LEG, LEGS_AT_ENTRY };
// OPTIONS-VANISHED-SETTLES 2026-10-16: required by a test, this file is its rules and nothing else — the sweep below runs only as a
// script (`if (require.main === module)` at the foot), and the selftest proves that requiring it reads no file and writes nothing.

const main = async () => {
  const board = JSON.parse(fs.readFileSync(BOARD, "utf8"));
  const today = etToday(), hm = etHM();
  const barComplete = (d) => d < today || (d === today && hm >= "16:10");

  // OPTIONS-VANISHED-SETTLES 2026-10-16: the mirror's own orders first, because this pass needs no board and no bar. A row still shown as
  // "sent" past its expiry close can never fill — the broker drops an unfilled option order at expiry, it does not cancel it — so it is
  // marked expired in this sweep's own record. The mirror's log is read, never rewritten, and no broker is asked.
  {
    const mir = readJsonlOr(OMIR);
    if (!mir) console.log(`  options mirror log absent (backend/data/${path.basename(OMIR)}) — no mirror order to mark expired.`);
    else {
      const prev = readJsonOr(MARKS), M = markExpiredMirror(prev, mir.rows, mir.bad, barComplete, new Date().toISOString());
      if (M.marked.length || prev) writeJsonAtomic(MARKS, M.doc);
      console.log(`  mirror orders still "sent" past expiry: ${M.added} newly marked expired, ${M.marked.length} marked in all${mir.bad ? `; ${mir.bad} unparsable log line(s)` : ""} → backend/data/${path.basename(MARKS)}`);
      for (const m of M.marked.filter((x) => x.markedAt && x.markedAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).slice(0, 20)) console.log(`      EXPIRED  ${String(m.sym || "?").padEnd(5)} ${m.optExpiry}  ticket ${m.ticketId || "?"}  order ${m.orderId || "(none)"}  was "sent"`);
    }
  }

  // 4.2: an option whose record has no optExpiry takes the expiry its two OCC symbols name (a copy carries it; the board row is not edited).
  // A board entry that is not an object (a damaged file) stops the run HERE, before anything is read or written, exactly as it always has.
  const expired = board.filter((p) => p.cls === "Options" && (p.optExpiry || occExpiry(p)) && barComplete(p.optExpiry || occExpiry(p))).map((p) => (p.optExpiry ? p : { ...p, optExpiry: occExpiry(p), optExpiryFrom: "occ" }));
  if (!expired.length) { console.log("OPTIONS SETTLE — no wings past expiry. Nothing to do."); return; }

  const credit = expired.filter((p) => (p.optCredit && p.optAtm != null && p.optK2 != null) || isDebitVertical(p));   // 4.2: "credit" now holds every vertical this script settles — credit ones as always, and a verified debit vertical
  const other = expired.filter((p) => !credit.includes(p));
  if (other.length) console.log(`  NOT SETTLING ${other.length} expired option(s) that are neither a credit vertical nor a verified debit vertical: ${other.map((p) => p.sym).join(", ")} — no settle rule; handle by hand.`);

  const tlog = (() => { try { const t = JSON.parse(fs.readFileSync(TLOG, "utf8")); return Array.isArray(t) ? t : []; } catch { return []; } })();
  // 4.2: an id counts as settled when the ledger holds a row for it that is not the voided close of a wing restored under that id
  const rowsById = new Map(); for (const t of tlog) if (t && t.id) { if (!rowsById.has(t.id)) rowsById.set(t.id, []); rowsById.get(t.id).push(t); }
  const settledBefore = (p) => (rowsById.get(p.id) || []).some((t) => !voidedRestore(t, p));
  const todo = credit.filter((p) => !settledBefore(p));
  // OPTIONS-VANISHED-SETTLES 2026-10-16: the vanished-legs pass below is this script's only rule for an expired spread no rule above can
  // price, so a run may stop here only when that pass has nothing either. A CANDIDATE is an expired position not already in the ledger
  // whose two legs verify AND whose legs the stored broker snapshot says are gone — the same test the pass itself applies, asked here on
  // the snapshot alone (no bar, no broker), so a night with no wing and no vanished spread stops exactly where it always stopped.
  const snap = readJsonOr(SNAP);
  const vanCand = new Set(expired.filter((p) => { if (settledBefore(p)) return false; const L = vanLegs(p); return !!L.legs && vanishedCheck(L.legs, p.optExpiry, snap).ok; }).map((p) => p.id));
  {
    // a flag is LIFTED here, before any early return, from every expired position this run cannot find unknown any more — its legs no
    // longer verify, the snapshot no longer says they are gone, or the ledger now holds it. The board never keeps an answered reason.
    let dirty = false;
    for (const p of expired) { if (vanCand.has(p.id)) continue; const b = board.find((x) => x && x.id === p.id); if (b && b.vanishedUnknown) { delete b.vanishedUnknown; dirty = true; } }
    if (dirty) { writeJsonAtomic(BOARD, board); console.log(`  the vanishedUnknown flag was lifted from the expired position(s) this run no longer finds unknown.`); }
  }
  const vanAny = vanCand.size > 0;
  if (!todo.length && !vanAny) { console.log(`OPTIONS SETTLE — ${credit.length} expired wing(s) already settled. Idempotent no-op.`); return; }
  if (!todo.length) console.log(`  no wing is due a settle tonight (${credit.length} expired vertical(s) priced by the rules above) — the vanished-legs pass runs on its own.`);

  // one bar fetch covering every expiry involved
  // 4.2: the registered call asks for the CREDIT WINGS only — their symbols, their earliest expiry, the options it has always had. It
  // throws when any symbol it asks for returns no bar, so a debit vertical's underlying is never put in it (and with no wing due, it is not made).
  const wingsTodo = todo.filter((p) => p.optCredit), debitTodo = todo.filter((p) => !p.optCredit);
  const syms = [...new Set(wingsTodo.map((p) => p.sym))];
  const earliest = wingsTodo.map((p) => p.optExpiry).sort()[0];
  const bars = !wingsTodo.length ? {} : await fetchBars(syms, { start: earliest, end: today, timeframe: "1Day", minBars: 1, quiet: true }).then((r) => r.bars || r).catch((e) => { console.error(`  bars fetch failed: ${e.message}`); return {}; });
  const closeOn = (s, d) => { const b = (bars[s] || []).find((x) => String(x.t).slice(0, 10) === d); return b ? b.c : null; };
  // 4.2: the debit verticals' closes, by a call of their OWN — the same daily bar, no symbol required, its own catch. A debit vertical
  // whose underlying has no bar (a thin day, a ticker change, a delisting) is stuck by itself; it cannot stop a wing from settling.
  let debitNote = null;
  const debitBars = !debitTodo.length ? {} : await fetchBars([...new Set(debitTodo.map((p) => p.sym))], { start: debitTodo.map((p) => p.optExpiry).sort()[0], end: today, timeframe: "1Day", requireAll: false, minBars: 1, quiet: true }).then((r) => r.bars || r).catch((e) => { debitNote = String((e && e.message) || e).slice(0, 120); return {}; });
  const closeOnDebit = (s, d) => { const b = (debitBars[s] || []).find((x) => String(x.t).slice(0, 10) === d); return b && Number.isFinite(b.c) ? b.c : null; };
  const stuckDebit = [];
  // 4.7 (recording only): the consolidated raw daily close of each expiry date, beside the bars above. SIP is 15 minutes delayed on this
  // account (a query that ends inside the delay is refused), so this one ends 16 minutes ago; a same-day close counts only past 16:01 ET.
  // IT MAY NOT COST THE SETTLE ITS NIGHT: it runs before the ledger write, and the close chain kills this step at five minutes. With the
  // library's own defaults (4 retries, 60 s each) an endpoint that hangs would take about 5 min 7 s. So it is asked ONCE and waits ten
  // seconds (retries 0, timeoutMs 10000): a slow or failed read leaves the official fields null with the reason, and the settle is written.
  const offEnd = new Date(Date.now() - 16 * 60 * 1000);
  const offHM = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(offEnd);
  const offDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(offEnd);
  let offNote = null;
  // OPTIONS-VANISHED-SETTLES 2026-10-16: `!todo.length ? {} :` — with no wing and no debit vertical due, this run reaches here only for the
  // vanished-legs pass, which prices from stored closes alone. The recording call is not made at all rather than made with no symbol.
  const offBars = !todo.length ? {} : await fetchBars([...new Set(todo.map((p) => p.sym))], { start: todo.map((p) => p.optExpiry).sort()[0], end: offEnd.toISOString(), timeframe: "1Day", feed: "sip", adjustment: "raw", requireAll: false, minBars: 1, quiet: true, retries: 0, timeoutMs: 10000 }).then((r) => r.bars || r).catch((e) => { offNote = `official close not fetched (${String((e && e.message) || e).slice(0, 80)})`; return {}; });
  const officialOn = (s, d) => {
    if (offNote) return { c: null, note: offNote };
    if (!(d < offDay || (d === offDay && offHM >= "16:01"))) return { c: null, note: `the official close of ${d} was not yet published to this account at settle time (15-minute delay)` };
    const b = (offBars[s] || []).find((x) => String(x.t).slice(0, 10) === d);
    return b && Number.isFinite(b.c) ? { c: b.c, note: null } : { c: null, note: `no consolidated daily bar for ${s} on ${d}` };
  };

  const settled = [], stuck = [];
  for (const p of todo) {
    const S = p.optCredit ? closeOn(p.sym, p.optExpiry) : closeOnDebit(p.sym, p.optExpiry);   // 4.2: a debit vertical is priced from its own call, never from the wings'
    if (S == null && !p.optCredit) { stuckDebit.push(`${p.sym} ${p.optExpiry} (debit vertical: ${debitNote ? `its bars fetch failed — ${debitNote}` : "no completed bar"})`); continue; }
    if (S == null) { stuck.push(`${p.sym} ${p.optExpiry} (no completed bar)`); continue; }
    const contracts = p.contracts || 1;
    const width = Math.abs(p.optK2 - p.optAtm);
    const cost = p.optCall
      ? Math.min(Math.max(S - p.optAtm, 0), width)   // short call spread breached from below
      : Math.min(Math.max(p.optAtm - S, 0), width);  // short put spread breached from above
    const creditKept = p.optEntryNet ?? p.debit;
    const commissions = COMMISSION_PER_LEG * LEGS_AT_ENTRY * contracts;
    const isDebit = !p.optCredit;   // 4.2: a debit vertical is the mirror image — the same intrinsic is what the spread is WORTH at expiry, and creditKept holds what it COST at the cross
    const pnl = (isDebit ? cost - creditKept : creditKept - cost) * 100 * contracts - commissions;
    // 4.7 (recording only): the same arithmetic at the official close; null when that close could not be read (officialOn above)
    const off = officialOn(p.sym, p.optExpiry);
    const offCost = off.c == null ? null : (p.optCall ? Math.min(Math.max(off.c - p.optAtm, 0), width) : Math.min(Math.max(p.optAtm - off.c, 0), width));
    const offPnl = offCost == null ? null : +((isDebit ? offCost - creditKept : creditKept - offCost) * 100 * contracts - commissions).toFixed(2);
    const rMult = p.riskDollars ? pnl / p.riskDollars : null;
    settled.push({
      // 2026-09-07: a retire tag stamped on the OPEN position (holiday-entry-2026-09-07 and any later tag) must reach the ledger row, or lib/reconcile.js can never honour it
      ...(p.retired ? { retired: p.retired, retireNote: p.retireNote, voidForEvidence: p.voidForEvidence } : {}),
      id: p.id, sym: p.sym, cls: "Options", dir: p.dir, sizeLabel: p.sizeLabel,
      // OP4a (2026-09-13): a put wing posted as a veto shadow must settle AS a shadow, or the control arm leaks into the signal book
      ctrl: !!p.ctrl, vetoShadow: !!p.vetoShadow, veto: p.veto ?? null, ctrlRand: !!p.ctrlRand, ...(p.vetoWhy ? { vetoWhy: p.vetoWhy, vetoAt: p.vetoAt } : {}),
      entry: creditKept, exit: +cost.toFixed(4), rMult, pnl: +pnl.toFixed(2),
      reason: "expiry", openedAt: p.addedAt, closedAt: Date.parse(p.optExpiry + "T20:00:00Z"),
      conf: p.conf ?? null, strategy: p.strategy ?? "R21-premium", rr: isDebit ? (p.rr ?? null) : null, score: isDebit ? (p.score ?? null) : null,   // 4.2: a board option ticket keeps its own signal features; a sleeve wing has none (null, as before)
      nBull: isDebit ? (p.nBull ?? null) : null, nBear: isDebit ? (p.nBear ?? null) : null, total: isDebit ? (p.total ?? null) : null,
      /**
       * THE RISK DENOMINATOR AND THE STRUCTURE, CARRIED THROUGH (fixed 2026-08-28).
       *
       * This row was built field-by-field and simply never copied them, so 42 of 42 settled
       * R25-0dte tickets reached the ledger with `strategy` and `entry` and nothing else —
       * no riskDollars, no optStruct, no contracts, no debit, no stopDist. Line 79 above
       * READS p.riskDollars to compute rMult and then dropped it, which is why the ledger has
       * an R-multiple for these tickets and no idea what one R is worth.
       *
       * The cost was concrete: R25-0dte is the only positive program on the board (+$302 over
       * 42 tickets, 86% win) and the operator could not be told whether it was safe to size up,
       * because the maximum loss per ticket had never reached the ledger. You cannot size what
       * you did not record. maxLoss = (width - credit) x 100 x contracts is computed at entry
       * in zero-dte-sleeve.js and is the number that belongs here.
       *
       * Third instance of this same defect class found today — after veto shadows and news
       * stamps — all of them state that exists at entry and is lost on the way to the ledger.
       */
      riskDollars: p.riskDollars ?? null,
      optStruct: p.optStruct ?? null,
      contracts: p.contracts ?? contracts ?? null,
      optEntryNet: p.optEntryNet ?? null,
      debit: p.debit ?? null,
      stopDist: p.stopDist ?? null,
      sleeve: p.sleeve ?? null,
      obs: { ...(p.obs || {}), settleUnder: S, width, optCall: !!p.optCall, shortK: isDebit ? p.optK2 : p.optAtm, longK: isDebit ? p.optAtm : p.optK2, optExpiry: p.optExpiry, sleeve: p.sleeve ?? null,
        ...(isDebit ? { settleKind: "debit-vertical", entryBasis: "optEntryNet (the debit paid at the cross)", ...(p.optExpiryFrom ? { optExpiryFrom: p.optExpiryFrom } : {}) } : {}),
        // 4.7 (recording only): new fields beside settleUnder / pnl / rMult, never in place of them
        settleUnderOfficial: off.c, settleOfficialSrc: "alpaca sip raw 1Day close", settleOfficialAsOf: offEnd.toISOString(), pnlOfficial: offPnl,
        rMultOfficial: offPnl == null || !p.riskDollars ? null : +(offPnl / p.riskDollars).toFixed(4), ...(off.note ? { settleOfficialNote: off.note } : {}) },
    });
  }

  /**
   * ── THE VANISHED-LEGS PASS (OPTIONS-VANISHED-SETTLES 2026-10-16) ──────────────────────────────────────────────────────────────
   * Every expired position this run did not settle and the ledger does not already hold. For each one, in this order and no other:
   *   1. its two OCC legs must verify as one vertical            else UNKNOWN, flagged, nothing guessed
   *   2. the STORED broker snapshot must be dated after the expiry and name neither leg   else left exactly as it was (not vanished)
   *   3. a STORED close of its underlying on the expiry date must exist                   else UNKNOWN, flagged, nothing guessed
   *   4. an entry price must be recorded on it                                            else UNKNOWN, flagged, nothing guessed
   * Only then is a settle row written, at the expiry intrinsic, tagged "vanished-legs". No broker is asked anywhere in this pass.
   */
  const closes = readJsonOr(CLOSES);
  const vanished = [], vanUnknown = [], vanLeft = [];
  const dropStuck = (arr, p) => { const i = arr.findIndex((s) => String(s).startsWith(`${p.sym} ${p.optExpiry} `)); if (i >= 0) arr.splice(i, 1); };
  for (const p of expired) {
    if (settledBefore(p) || settled.some((s) => s.id === p.id)) continue;
    const L = vanLegs(p);
    // legs that do not verify as one vertical put the position OUTSIDE this rule, not inside it as an unknown: without its legs nothing
    // can be asked of the snapshot, so nothing is claimed about the broker and the position is left exactly as it was before this rule.
    if (!L.legs) { vanLeft.push(`${p.sym} ${p.optExpiry} (${L.why})`); continue; }
    const V = vanishedCheck(L.legs, p.optExpiry, snap);
    if (!V.ok) { vanLeft.push(`${p.sym} ${p.optExpiry} (${V.why})`); continue; }
    const seen = `the broker no longer reports its legs (snapshot of ${V.asOfDate})`;
    const C = storedCloseFor(p, p.optExpiry, closes, (sym, d) => { const c = closeOn(sym, d); return Number.isFinite(c) ? c : closeOnDebit(sym, d); });
    if (C.c == null) { vanUnknown.push({ p, why: `${seen}, but no stored close of ${p.sym} on ${p.optExpiry} exists — the settle price is not guessed` }); continue; }
    const R = vanishedRow(p, { legs: L.legs, exp: p.optExpiry, S: C.c, src: C.src, snapAsOf: V.asOf });
    if (R.why) { vanUnknown.push({ p, why: `${seen}, but ${R.why}` }); continue; }
    vanished.push(R.row); settled.push(R.row); dropStuck(stuck, p); dropStuck(stuckDebit, p);
  }
  if (vanLeft.length) console.log(`  VANISHED-LEGS PASS — ${vanLeft.length} expired position(s) it did not take: ${vanLeft.join("; ")}`);
  {
    // THE FLAG IS WRITTEN FIRST, before anything else below, so that it survives even the "NONE settleable" exit. A flag is idempotent
    // (it keeps the date it was first raised) and is LIFTED from an expired position this run no longer finds unknown, so the board never
    // carries a reason that has since been answered.
    const nowIso = new Date().toISOString(), unknownNow = new Map(vanUnknown.map((u) => [u.p.id, u]));
    let dirty = false;
    for (const p of expired) {
      if (!vanCand.has(p.id)) continue;   // the others had their flag lifted above, before the early returns
      const b = board.find((x) => x && x.id === p.id); if (!b) continue;
      const u = unknownNow.get(p.id);
      if (u) { const since = b.vanishedUnknown && b.vanishedUnknown.since ? b.vanishedUnknown.since : nowIso;
        b.vanishedUnknown = { tag: VANISHED_TAG, optExpiry: p.optExpiry, why: u.why, since, seen: nowIso }; dirty = true; }
      else if (b.vanishedUnknown) { delete b.vanishedUnknown; dirty = true; }
    }
    if (dirty) writeJsonAtomic(BOARD, board);
    for (const u of vanUnknown) console.error(`  VANISHED, NOT PRICED — ${u.p.sym} ${u.p.optExpiry}: ${u.why}. It stays on the board, flagged (vanishedUnknown); nothing is guessed.`);
    // said HERE, and the exit code set HERE, so that both survive the "NONE settleable" exit a few lines below
    if (vanUnknown.length) { console.error(`OPTIONS SETTLE — ${vanUnknown.length} expired spread(s) the broker no longer reports could NOT be priced from a stored close: each stays on the board flagged (vanishedUnknown), and NOTHING was guessed. They settle by themselves once the missing close is stored.`); process.exitCode = 2; }
  }

  // 4.2: a debit vertical that could not be priced is said on a line of its own and stays on the board; no wing waits for it
  for (const d of stuckDebit) console.error(`  DEBIT VERTICAL NOT SETTLED — it stays on the board, and no wing waits for it: ${d}`);
  if (!settled.length) { console.error(`OPTIONS SETTLE — ${todo.length} wing(s) expired, NONE settleable: ${stuck.concat(stuckDebit).join("; ")}`); process.exit(2); }

  // append to the ledger, drop from the board, tombstone the ids — same order a manual close uses
  writeJsonAtomic(TLOG, [...settled, ...tlog]);
  const settledIds = new Set(settled.map((s) => s.id));
  writeJsonAtomic(BOARD, board.filter((p) => !settledIds.has(p.id)));
  const tombs = (() => { try { const t = JSON.parse(fs.readFileSync(TOMBS, "utf8")); return Array.isArray(t) ? t : []; } catch { return []; } })();
  writeJsonAtomic(TOMBS, [...tombs, ...settled.map((s) => ({ id: s.id, ts: Date.now() }))]);

  const wins = settled.filter((s) => s.pnl > 0).length, total = settled.reduce((a, s) => a + s.pnl, 0);
  console.log(`OPTIONS SETTLE — ${settled.length} wing(s) settled at expiry intrinsic${stuck.length ? `; ${stuck.length} stuck: ${stuck.join("; ")}` : ""}`);
  for (const s of settled) console.log(`    ${s.sym.padEnd(5)} ${s.obs.optExpiry} ${s.obs.optCall ? "C" : "P"} ${s.obs.shortK}/${s.obs.longK}  under ${s.obs.settleUnder}  ${s.obs.settleKind === "vanished-legs" ? `entry ${s.entry}  value ${s.exit}` : s.obs.settleKind ? `debit ${s.entry}  worth ${s.exit}` : `credit ${s.entry}  cost ${s.exit}`}  $${s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(2)}  (official close ${s.obs.settleUnderOfficial ?? "n/a"}: $${s.obs.pnlOfficial ?? "n/a"})`);
  console.log(`    ${wins}/${settled.length} kept their premium · net $${total >= 0 ? "+" : ""}${total.toFixed(2)} · R21 settled count now feeds the n>=200 bar`);
  // 4.2: this script's own rule for the wings, kept now that a debit vertical can settle beside them — "if expired wings exist and
  // none could be settled, exit 2 so the chain surfaces it". The rows above are written; the exit code still says the wings are stuck.
  if (wingsTodo.length && !settled.some((s) => !s.obs.settleKind)) { console.error(`OPTIONS SETTLE — ${wingsTodo.length} credit wing(s) expired, NONE settleable (only debit verticals settled): ${stuck.join("; ")}`); process.exitCode = 2; }
  // OPTIONS-VANISHED-SETTLES 2026-10-16: the vanished-legs rows, said apart from the wings — they are a different rule on a different
  // trigger (the broker's silence), and the tag on each row is what an analysis includes or excludes them by.
  if (vanished.length) {
    console.log(`OPTIONS SETTLE — ${vanished.length} expired spread(s) settled by the VANISHED-LEGS rule (reason "${VANISHED_REASON}", tag ${VANISHED_TAG}); net $${vanished.reduce((a, s) => a + s.pnl, 0) >= 0 ? "+" : ""}${vanished.reduce((a, s) => a + s.pnl, 0).toFixed(2)}`);
    for (const s of vanished) console.log(`    ${String(s.sym).padEnd(5)} ${s.obs.optExpiry} ${s.obs.optCall ? "C" : "P"} ${s.obs.shortK}/${s.obs.longK}  under ${s.obs.settleUnder} (${s.obs.settleCloseSource})  entry ${s.entry}  value ${s.exit}  $${s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(2)}  · broker snapshot ${s.obs.brokerSnapshotAsOf} reports neither ${s.obs.brokerLegs.join(" nor ")}`);
  }
};

if (require.main === module) main();
