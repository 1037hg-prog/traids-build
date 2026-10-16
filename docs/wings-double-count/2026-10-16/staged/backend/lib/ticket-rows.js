/**
 * ONE ROW PER TICKET — the single definition of how many times a ticket counts.
 *
 * WHY THIS FILE EXISTS. Found 2026-10-12, in the same evening as the booking repair.
 *
 * data/trade_log.json is a list of ROWS, and every reader has always treated a row as a ticket.
 * That held until a ticket could be closed twice under one id. It can:
 *
 *   Six R21 weekly wings were closed by the first live fire of the loss cap on 2026-09-14. That
 *   close was VOIDED (a retire tag and voidForEvidence) and the wings were put back on the board
 *   UNDER THE SAME ID (obs.restoredAfter). They then expired, and backend/options-settle.js wrote
 *   their settles with `writeJsonAtomic(TLOG, [...settled, ...tlog])` — a PREPEND. The voided close
 *   was never removed, so each of those six wings now has TWO rows in the ledger carrying ONE
 *   ticket id, with different closedAt and different pnl.
 *
 * Every reader that sums rows therefore counted each of those wings TWICE. The append-only journal
 * data/trade_log.jsonl did not: it is keyed on the ticket id (`have.set(r.id, r)` in
 * ledger-journal.js, `have.add(...id)` in reconcile.js journalLag()), so it holds one entry per
 * ticket. The ledger said one number, the journal key said another, and the gap was exactly the
 * number of revoided wings. That disagreement is what surfaced this.
 *
 * THE RULE, keyed on the ticket id:
 *   - A row with no id is not a ticket and is never collapsed; it passes through untouched.
 *   - A ticket with one row keeps that row, byte for byte. On a ledger with no revoided ticket this
 *     function is an exact no-op, which is the property that makes it safe to put under the
 *     canonical read.
 *   - A ticket with several rows keeps exactly ONE: the row none of its siblings supersedes. A row
 *     `a` supersedes a row `b` of the same ticket when either
 *       (1) `a` names `b` as the row it replaced — a.voidedPredecessor === b.id and
 *           a.restoredAfter === b.retired (the successor stamp), or
 *       (2) `b` was voided for evidence (b.voidForEvidence === true) and `a` closed later.
 *     Of what survives, the LATEST closedAt is the ticket's row.
 *   - A duplicate the two rules above do not explain is REPORTED in `ambiguous`, whether or not the
 *     latest close happens to break it. A tiebreak is not an explanation, so it is said out loud and the
 *     ticket still counts once. Nothing here is silent: duplicates, the rows dropped and every
 *     unexplained id come back with the rows, for the caller to print. A ledger defect that is quietly
 *     tidied away is the defect twice.
 *
 * WHAT THIS DOES NOT DO. It does not edit, merge or re-sum a row, and it does not decide whether
 * the surviving row BELONGS in a population — `retired`, `ctrl`, the clean epoch and the finite-pnl
 * rule are lib/reconcile.js's, applied after this and unchanged by it. This answers one question
 * only: which row IS the ticket.
 */
"use strict";

/**
 * A ROW HAS A TICKET ID when it has one at all — `0` and `false` are ids, `undefined`, `null` and `""`
 * are not. Written out because `!r.id` is the obvious test and the wrong one: under it a row with
 * `id: 0` or `id: ""` is "not a ticket", so two such rows BOTH pass through and the ticket counts twice,
 * silently, which is the exact defect this file exists to stop. An empty-string id is not a ticket id —
 * it identifies nothing — and is counted as id-less and reported.
 */
const hasId = (r) => r.id !== undefined && r.id !== null && r.id !== "";

/**
 * `a` supersedes `b`: both are rows of ONE ticket and `a` is the row that replaced `b`.
 * The same-ticket requirement is checked, not assumed — this is exported, and a predicate whose
 * contract says "one ticket" must refuse rows of two.
 */
function supersedes(a, b) {
  if (!a || !b || a === b || !hasId(a) || !hasId(b) || a.id !== b.id) return false;
  // (1) the successor stamp: the replacing row names the row it replaced and the tag it was restored after
  if (a.voidedPredecessor && a.voidedPredecessor === b.id && b.retired && a.restoredAfter === b.retired) return true;
  // (2) a close that was voided for evidence, replaced by a later close of the same ticket
  if (b.voidForEvidence === true && Number.isFinite(a.closedAt) && Number.isFinite(b.closedAt) && a.closedAt > b.closedAt) return true;
  return false;
}

/**
 * the rows of one ticket, in file order -> { row, at, dropped, ambiguous }. Chooses by POSITION, never by
 * object identity: two rows of a ticket may be the same object (an aliased list), and each still counts once.
 *
 * LINEAR IN THE GROUP, deliberately. Asking supersedes(a, b) for every pair is O(k^2), and a malformed
 * ledger with one id repeated at scale would appear to hang (32k rows under one id took 2.5 s; 200k would
 * take about 100). Both rules can be answered with one pass each, and give exactly the same answer as the
 * pairwise form — which the selftest holds down by comparing the two on randomized groups, not by assertion:
 *   rule (2)  b is superseded when b is voidForEvidence and SOME row of the ticket closed later, i.e. when
 *             b.closedAt is finite and less than the greatest finite closedAt in the group.
 *   rule (1)  inside a group every id is the ticket's own, so "a names b" is "a.voidedPredecessor is this
 *             ticket and a.restoredAfter is b.retired". Count the restoredAfter tags of the rows that
 *             stamp this ticket, and subtract b's own contribution so a row can never supersede itself.
 */
function pickRow(group) {
  if (group.length === 1) return { row: group[0], at: 0, dropped: [], ambiguous: false };
  let maxClose = -Infinity;
  const stampTags = new Map();                       // restoredAfter -> how many rows of this ticket stamp it
  for (const r of group) {
    if (Number.isFinite(r.closedAt) && r.closedAt > maxClose) maxClose = r.closedAt;
    if (r.voidedPredecessor && hasId(r) && r.voidedPredecessor === r.id) stampTags.set(r.restoredAfter, (stampTags.get(r.restoredAfter) || 0) + 1);
  }
  const isSuperseded = (b) => {
    // (1) another row of this ticket names b as the row it replaced
    if (b.retired) { const n = stampTags.get(b.retired) || 0; const self = b.voidedPredecessor && hasId(b) && b.voidedPredecessor === b.id && b.restoredAfter === b.retired ? 1 : 0; if (n - self > 0) return true; }
    // (2) b's close was voided for evidence and a later close of this ticket exists
    if (b.voidForEvidence === true && Number.isFinite(b.closedAt) && maxClose > b.closedAt) return true;
    return false;
  };
  const live = group.map((_, i) => i).filter((i) => !isSuperseded(group[i]));
  const pool = live.length ? live : group.map((_, i) => i);   // a rule that eliminated everything decides nothing
  let at = pool[0];
  for (const i of pool) { const r = group[i]; if (Number.isFinite(r.closedAt) && (!Number.isFinite(group[at].closedAt) || r.closedAt > group[at].closedAt)) at = i; }
  // AMBIGUOUS means the RULE did not explain the duplicate. More than one row surviving the supersede
  // rules is exactly that: the latest close then decided it, and a tiebreak is not an explanation.
  return { row: group[at], at, dropped: group.filter((_, i) => i !== at), ambiguous: live.length !== 1 };
}

/** the pairwise form of pickRow's rules, kept as the REFERENCE the selftest compares the linear one against */
function pickRowPairwise(group) {
  if (group.length === 1) return { row: group[0], at: 0, dropped: [], ambiguous: false };
  const live = group.map((_, i) => i).filter((i) => !group.some((a) => supersedes(a, group[i])));
  const pool = live.length ? live : group.map((_, i) => i);
  let at = pool[0];
  for (const i of pool) { const r = group[i]; if (Number.isFinite(r.closedAt) && (!Number.isFinite(group[at].closedAt) || r.closedAt > group[at].closedAt)) at = i; }
  return { row: group[at], at, dropped: group.filter((_, i) => i !== at), ambiguous: live.length !== 1 };
}

/**
 * Collapse ledger rows to one row per ticket id.
 *   rows        the kept rows, in the order they appeared, one per ticket id (ids are never merged)
 *   duplicates  [{ id, rows, keptClosedAt, droppedClosedAt }] every ticket id that had more than one row
 *   dropped     the superseded rows themselves, so a caller can print or audit them
 *   ambiguous   the ticket ids whose extra rows the rule could not explain — REPORT THESE
 *   idless      how many rows carried no ticket id (passed through, never collapsed)
 *   notRows     how many entries were not objects at all (null, a number, a string) — dropped and COUNTED,
 *               because a ledger holding one of those is a damaged file and nobody should learn it from a
 *               silently shorter list
 */
function collapseByTicket(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const groups = new Map();                      // id -> the row INDEXES of that ticket, in file order
  let idless = 0, notRows = 0;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r || typeof r !== "object") { notRows++; continue; }
    if (!hasId(r)) { idless++; continue; }
    const g = groups.get(r.id); if (g) g.push(i); else groups.set(r.id, [i]);
  }
  const keep = new Set(), duplicates = [], dropped = [], ambiguous = [];
  for (const [id, idx] of groups) {
    const p = pickRow(idx.map((i) => list[i]));
    keep.add(idx[p.at]);
    if (idx.length > 1) {
      duplicates.push({ id, rows: idx.length, keptClosedAt: p.row.closedAt ?? null, droppedClosedAt: p.dropped.map((r) => r.closedAt ?? null) });
      for (const r of p.dropped) dropped.push(r);
      if (p.ambiguous) ambiguous.push(id);
    }
  }
  const out = list.filter((r, i) => r && typeof r === "object" && (!hasId(r) || keep.has(i)));
  return { rows: out, duplicates, dropped, ambiguous, idless, notRows, tickets: groups.size };
}

/** one line for a report: what the collapse did, or that it did nothing. Never silent. */
function collapseLine(c) {
  const damaged = c.notRows ? ` · ${c.notRows} entr${c.notRows === 1 ? "y" : "ies"} in the file is not a row at all (DAMAGED FILE)` : "";
  if (!c.duplicates.length) return `tickets ${c.tickets} = rows (no ticket id appears twice)${damaged}`;
  const n = c.dropped.length;
  return `tickets ${c.tickets} · ${c.duplicates.length} ticket id(s) held ${n + c.duplicates.length} rows: ${n} superseded row(s) are NOT counted (ids ${c.duplicates.slice(0, 6).map((d) => d.id).join(", ")}${c.duplicates.length > 6 ? ", …" : ""})`
    + (c.ambiguous.length ? ` · ${c.ambiguous.length} UNEXPLAINED duplicate ticket id(s): ${c.ambiguous.slice(0, 6).join(", ")} — the rule kept the latest close; look at them` : "")
    + damaged;
}

module.exports = { hasId, supersedes, pickRow, pickRowPairwise, collapseByTicket, collapseLine };
