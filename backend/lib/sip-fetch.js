/**
 * SIP FETCH — get consolidated-tape bars without guessing when today's session becomes available.
 *
 * WHY THIS EXISTS. Three scripts written on 2026-08-24 (R20 macro-overnight, R42 calendar-flow,
 * #76 fear-greed-cohort) each guessed at the rule with `end = (now >= 16:15 ET) ? today : yesterday`.
 * All three failed in that night's close chain with "Alpaca 403 (not retryable)". Testing at 18:44 ET
 * — nearly three hours after the close — showed `end=today` STILL 403s on this plan, so the guess was
 * not merely mistimed, it was the wrong shape: same-day SIP bars are not served, and no threshold
 * would have fixed it.
 *
 * So this does not guess. It asks for today, and when the plan refuses, walks the end date back one
 * calendar day at a time (up to MAX_BACK) until the request is accepted — then reports which end date
 * actually worked, so a caller can record what it graded rather than assume.
 *
 * A 403 here means "this plan will not serve a window ending that recently". Any other error is
 * re-thrown: a credentials or network failure must not be silently degraded into an older window.
 */
const { fetchBars } = require("./alpaca-bars");

const MAX_BACK = 5;   // a long holiday weekend is 4 days; 5 covers it without masking a real outage
const dayBefore = (iso) => new Date(Date.parse(iso + "T12:00:00Z") - 864e5).toISOString().slice(0, 10);
const is403 = (e) => /\b403\b/.test(String(e && e.message));

/**
 * fetchBarsSip(symbols, opts) -> { bars, effectiveEnd, walkedBack, requestedEnd }
 * opts is passed through to fetchBars; `feed` is forced to "sip" and `end` is required.
 */
async function fetchBarsSip(symbols, opts = {}) {
  const requestedEnd = opts.end;
  if (!requestedEnd) throw new Error("fetchBarsSip requires { end }");
  let end = requestedEnd;
  for (let back = 0; back <= MAX_BACK; back++) {
    try {
      const r = await fetchBars(symbols, { ...opts, end, feed: "sip" });
      return { ...r, effectiveEnd: end, walkedBack: back, requestedEnd };
    } catch (e) {
      if (!is403(e) || back === MAX_BACK) throw e;
      end = dayBefore(end);
    }
  }
  throw new Error("unreachable");
}

module.exports = { fetchBarsSip };
