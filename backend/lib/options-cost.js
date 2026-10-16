/**
 * OPTIONS COST NORMALISATION — a denominator for defined-risk structures.
 *
 * WHY THIS EXISTS. The autopsy prices equity/futures cost as
 *
 *     costR = (spreadBps / 100) / stopPct          // spread as a fraction of capital at risk
 *
 * which is meaningful because the stop IS the capital at risk: hitting it loses exactly 1R. A
 * defined-risk option structure has no stop — it is bounded by its strikes — so stopPct is null and
 * costR has no denominator. The consequence, found on 2026-08-26, was that 94 settled options
 * tickets carrying -5.53R of real P&L were silently absent from the direction-versus-cost
 * decomposition, and the whole-book economics were therefore unresolved rather than merely soft.
 *
 * THE FIX is to use the structure's own capital at risk, which for a credit spread is exactly:
 *
 *     maxDefinedLoss = width - creditReceived        (per share, x100 per contract)
 *
 * Losing the full width net of the credit taken in is the structural equivalent of hitting a stop:
 * it is the most the position can lose, and it is known at entry. Dividing crossing cost by it
 * yields a number on the SAME scale as equity costR — cost as a fraction of capital at risk — so
 * the two can legitimately be added into one book total. That last property is the whole point;
 * without it the classes cannot be summed and the whole-book number stays unattributable.
 *
 * WHAT IS MEASURED, AND WHAT IS NOT. The entry crossing is measured directly from the ticket:
 * |creditMid - creditCross| is the real distance between the mid we quoted and the price we
 * actually got filled at. It is not modelled.
 *
 * The exit is the interesting part. Every settled wing in the book to date exits at EXPIRY, where
 * a defined-risk spread settles rather than trades — there is no second crossing to pay. So the
 * round trip here is genuinely one-way, and assuming a symmetric exit cost would roughly DOUBLE
 * the true figure. `exitCrossing` is therefore 0 for expiry exits and is charged only when a wing
 * is actually bought back before expiration. If that mix changes, this recomputes on its own; it
 * does not bake in today's expiry-only pattern as an assumption.
 *
 * SCOPE. Credit spreads with a known width and a known entry credit. A ticket missing any of those
 * returns null and stays explicitly unattributed rather than receiving a guessed denominator —
 * an unattributed row is honest, an invented one is not.
 *
 * EPOCH 2 (2026-08-28) — DEBIT SPREADS ARE A DIFFERENT STRUCTURE, NOT A MISSING FIELD.
 * Investigating the 3 tickets left unpriced after epoch 1 (-3.02R: AMZN PEAD-manual, PLTR and NVDA
 * Ensemble) found they are not malformed credit-spread rows — they are long (debit) verticals from
 * the D37/D48 real-chain architecture, which is a structurally different position: max loss is the
 * DEBIT PAID, not width-minus-credit, because you pay to enter rather than receive. R21-premium and
 * R25-0dte are short-premium sleeves that pre-populate obs.width/creditMid/creditCross at TRACK
 * time (see backend/options-sleeve.js, backend/zero-dte-sleeve.js); the generic Options
 * track-and-settle path in src/App.jsx computes the debit-spread equivalents (pick.debit as the
 * mid, `pick.atm.ask - pick.k2.bid` as the worst-case cross, and the strikes) but never wrote them
 * into `obs` — they lived as top-level position fields (`debit`, `optEntryNet`, `optAtm`, `optK2`)
 * that the settle-time writer (recordOf() in src/App.jsx) drops, keeping only what was already in
 * obs. That is why R21/R25 survive settlement fully priced and the generic path does not: not a
 * shared bug that happened to miss 3 rows, but an entire structure class the schema never covered.
 * It WILL recur on every future Options ticket tagged "Ensemble" (the class default) or entered by
 * hand outside the sleeve scripts, until the writer is fixed at the source (tracked separately;
 * src/App.jsx obs assembly at the two Options-track call sites).
 *
 * The debit-spread branch below mirrors the credit-spread math on the opposite sign: maxDefinedLoss
 * is the mid-quoted debit itself (parallel to using the MID-based width-minus-credit for the credit
 * branch — both are the quoted, not realized-worst-case, capital at risk), and entryCrossing is the
 * measured gap between that mid and the worst-case bankable cross. It requires NEW field names
 * (obs.debitMid, obs.debitCross) rather than overloading creditMid/creditCross, so a row can never
 * be silently priced by the wrong formula. It activates ONLY where those fields are present, so it
 * changes zero existing R21/R25 rows.
 */
function optionsCostR(t) {
  const o = t && t.obs;
  if (!o) return null;
  const width = num(o.width);
  // 2026-09-04 (cost lens): options-settle.js subtracts $0.65 x 2 legs x contracts from pnl, so rMult is net of the fee but costR priced
  // the crossing only; directionR = rMult + costR then under-added by the fee (~0.0155R per wing, ~32% of the options cost side). Per share:
  // 0.65 x 2 / 100 = $0.013, independent of contract count.
  const COMMISSION_PER_SHARE = 0.013;

  // ── Branch 1: credit spread (short premium) — R21-premium, R25-0dte. Unchanged since epoch 1. ──
  const mid = num(o.creditMid), cross = num(o.creditCross);
  if (width != null && mid != null) {
    const maxDefinedLoss = width - mid;                 // capital genuinely at risk, per share
    if (maxDefinedLoss > 0) {
      const entryCrossing = cross == null ? null : Math.abs(mid - cross);
      if (entryCrossing != null) {
        const heldToExpiry = String(t.reason || "").toLowerCase() === "expiry";
        const exitCrossing = heldToExpiry ? 0 : entryCrossing;
        return {
          structure: "credit",
          costR: +((entryCrossing + exitCrossing + COMMISSION_PER_SHARE) / maxDefinedLoss).toFixed(4),   // 2026-09-04: fee added (options-settle.js charges it into pnl)
          commissionPerShare: COMMISSION_PER_SHARE,
          maxDefinedLoss: +maxDefinedLoss.toFixed(4),
          entryCrossing: +entryCrossing.toFixed(4),
          exitCrossing: +exitCrossing.toFixed(4),
          exitCrossingMeasured: heldToExpiry,
          basis: "crossing / (width - credit)",
        };
      }
    }
    // width+mid present but not priceable as a credit spread (inverted, or no cross) — fall through
    // to the debit branch ONLY if debit fields exist; otherwise stays unattributed below.
  }

  // ── Branch 2: debit spread (long premium) — generic Options track path. Added epoch 2. ──
  const debitMid = num(o.debitMid), debitCross = num(o.debitCross);
  if (debitMid != null && debitMid > 0) {
    const maxDefinedLoss = debitMid;                    // capital at risk = the debit paid (mid-quoted)
    const entryCrossing = debitCross == null ? null : Math.abs(debitMid - debitCross);
    if (entryCrossing != null) {
      const heldToExpiry = String(t.reason || "").toLowerCase() === "expiry";
      // Unlike the credit branch, no debit-spread ticket in the book to date has exercised the
      // held-to-expiry path (all 3 recovered rows closed on "stop", i.e. EARLY) — the exit crossing
      // for those rows is therefore the SYMMETRIC ASSUMPTION below, flagged unmeasured, not a
      // measured zero. There is no recorded exit-mid to compare a real exit cross against.
      const exitCrossing = heldToExpiry ? 0 : entryCrossing;
      return {
        structure: "debit",
        costR: +((entryCrossing + exitCrossing + COMMISSION_PER_SHARE) / maxDefinedLoss).toFixed(4),   // 2026-09-04: fee added
        commissionPerShare: COMMISSION_PER_SHARE,
        maxDefinedLoss: +maxDefinedLoss.toFixed(4),
        entryCrossing: +entryCrossing.toFixed(4),
        exitCrossing: +exitCrossing.toFixed(4),
        exitCrossingMeasured: heldToExpiry,   // false here means ASSUMED, not measured — see note above
        basis: "crossing / debitMid",
      };
    }
  }

  return null;   // missing whatever this structure needs — stays explicitly unattributed
}

const num = (v) => (Number.isFinite(v) ? v : null);

module.exports = { optionsCostR };
