/**
 * SESSION KEY — the single definition of "what day did this trade belong to".
 *
 * WHY THIS FILE EXISTS. Found 2026-09-04. The operator's daily report keyed every statistic on
 * `closedAt` in America/Denver. Every registered test — the adjudicator, FD1's paired days, W1,
 * R14, the decomposition sweep — keys on `openedAt` in America/New_York. Two independent splits
 * stacked on the same book, so the number Josh read each evening and the number the adjudicator
 * graded were computed on different days and could never reconcile.
 *
 * The damage was not cosmetic. daily-health.js was computing FD1's OWN statistic — signal minus
 * its same-symbol coin-flip twin, day-clustered — on the close/Denver key, so the report's PAIRED
 * gap and the adjudicator's FD1 were the same quantity clustered two different ways.
 *
 * It also produced a phantom result. 2026-08-24 looked like the best session in a ten-day run at
 * +$18,780. On the canonical key it was +$101: 45 of its 69 tickets were OPENED on 2026-08-21 and
 * 41 of those shared one open+close instant. The "best day in the record" was one correlated
 * basket harvested three days later, and the close-date view hid that completely.
 *
 * THE RULE.
 *   - A GRADED statistic — anything day-clustered, paired, or compared against a registered bar —
 *     keys on the OPEN session. The decision was made when the position was opened; that is the
 *     unit of the thing being tested.
 *   - A REALIZED-CASH statistic — what money actually landed today — keys on the CLOSE session.
 *     This is legitimate and not a defect, but it must be LABELLED, never mixed with the above.
 *   - Both use America/New_York. The market's day, not the operator's.
 *
 * Never inline `toLocaleDateString` with a timezone in analysis code again. Import from here.
 */
const TZ = "America/New_York";

/** Canonical session key for a timestamp (ms). Returns "YYYY-MM-DD" in market time. */
const sessionOf = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });

/** The session a trade BELONGS to for grading. Use this for every day-clustered statistic. */
const openSession = (t) => sessionOf(t.openedAt);

/** The session a trade's cash landed in. Use only for realized-P&L views, and label it. */
const closeSession = (t) => sessionOf(t.closedAt);

/** Today's session in market time. */
const todaySession = () => sessionOf(Date.now());

/**
 * Diagnostic: how far apart the two views are for a set of rows. Returns the count of rows whose
 * open and close sessions differ, which is the size of the population the split can move.
 */
function splitSize(rows) {
  let differ = 0, total = 0;
  for (const t of rows) {
    if (!t || !t.openedAt || !t.closedAt) continue;
    total++;
    if (openSession(t) !== closeSession(t)) differ++;
  }
  return { total, differ, pct: total ? differ / total : null };
}

module.exports = { TZ, sessionOf, openSession, closeSession, todaySession, splitSize };
