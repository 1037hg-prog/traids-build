/**
 * RUN WINDOW — one place that answers "should this run now?". 2026-08-29.
 *
 * OPERATOR RULE, 2026-08-29: "nothing should run on Saturday unless we're trading on Saturday;
 * things should only run on Sunday evening in prep for Monday's trading — or I ask for it."
 *
 * Every scheduled entry point asks this module rather than deciding for itself, because a rule
 * re-implemented in nine .bat files is nine rules that will drift.
 *
 * ═══ THE WINDOWS ═══
 *
 *   Mon-Fri            open. The trading week runs as before.
 *   SATURDAY           CLOSED. Nothing automated runs.
 *   SUNDAY             CLOSED until PREP_HOUR ET, then open — the Monday prep run.
 *   any day, forced    open, and the reason is recorded as an explicit operator request.
 *
 * ═══ THE ONE EXPOSURE THIS CREATES, STATED RATHER THAN BURIED ═══
 *
 * Crypto trades 24/7 and the board currently holds 25 crypto positions. With nothing running on
 * Saturday, a crypto stop touched on Saturday is not acted on until the Sunday prep run — and the
 * loss-anatomy pass on 2026-08-29 already found that crypto "gap-stops" in this ledger are largely
 * a MONITORING-FREQUENCY artifact: a once-daily settle missing an intraday touch a continuously
 * watched stop would have caught. This rule widens that window from a day to a weekend.
 *
 * That is a real cost and it is the operator's call to accept. The measured size of it so far is
 * small: exactly ONE weekend settle exists in the entire clean era (a Sunday crypto close, -$1,073)
 * against 1,037 weekday settles. `weekendCryptoExposure()` below reports the current open count so
 * the trade-off is visible every time the guard fires, rather than discovered after a bad Saturday.
 *
 * ═══ HOW TO OVERRIDE ═══
 *
 *   TRAIDS_RUN=1            env var — "I asked for it"
 *   --force                 argv flag, same meaning
 *   TRAIDS_TRADING_SAT=1    Saturday is a trading day (e.g. a crypto-only session by design)
 *
 * The override is recorded in the returned reason so a forced run is never mistaken for a
 * scheduled one when someone reads the logs later.
 */
const fs = require("fs"), path = require("path");

const PREP_HOUR = Number(process.env.TRAIDS_PREP_HOUR || 17);   // 17:00 ET Sunday — evening, before Monday

/**
 * MARKET HOLIDAYS (added 2026-09-04, operator: "there's no market on Monday, Labor Day"). NYSE full-closure days; CME equity
 * futures keep a truncated holiday session but nobody on this desk trades it, and the operator's rule is the trading day, not
 * the tape. A holiday is treated like Saturday: nothing runs, except the evening prep window (>= PREP_HOUR ET) before the next
 * trading day, exactly as Sunday evening preps Monday. Early-close days (day after Thanksgiving, Christmas Eve) are NOT here —
 * the market is open. Extend this list each December; a date missing here means a holiday runs as a weekday and every
 * collector finds a dead tape (schwab-data.js already refuses stale prints, so the damage is noise, not fabrication).
 */
const MARKET_HOLIDAYS = {
  "2026-09-07": "Labor Day", "2026-11-26": "Thanksgiving Day", "2026-12-25": "Christmas Day",
  "2027-01-01": "New Year's Day", "2027-01-18": "Martin Luther King Jr. Day", "2027-02-15": "Presidents' Day", "2027-03-26": "Good Friday",
  "2027-05-31": "Memorial Day", "2027-06-18": "Juneteenth (observed)", "2027-07-05": "Independence Day (observed)", "2027-09-06": "Labor Day",
  "2027-11-25": "Thanksgiving Day", "2027-12-24": "Christmas Day (observed)",
};
/** ET calendar date "YYYY-MM-DD" -> holiday name, or null. */
function marketHoliday(dayET) { return MARKET_HOLIDAYS[dayET] || null; }
function isMarketHoliday(now = new Date()) { return marketHoliday(etParts(now).day); }

/**
 * DAILY HARD STOP — 17:00 MOUNTAIN, the operator's clock. Added 2026-08-29.
 *
 * OPERATOR RULE, in his words: "stop all tasks if it goes past 5 pm mtn time today; can restart
 * later or tomorrow" — then, when it had run to 22:00 anyway, "at 5pm" — then, when the servers
 * were taken down with it, "just the background tasks" and "traids never stops".
 *
 * ═══ WHAT THIS DOES AND DOES NOT STOP ═══
 *
 *   STOPS      background and scheduled JOBS — the close chain, audits, collectors, backfills,
 *              observer sweeps, any long analysis run. Work that can be restarted tomorrow with
 *              nothing lost but time.
 *   NEVER      the servers. traids-server-v2 (:3001) and the yahoo proxy (:3002) are the
 *   STOPS      apparatus itself, not a task. TRAIDS NEVER STOPS. They do not call this module
 *              and must not be made to — on 2026-08-29 they were killed under a broad reading of
 *              "all tasks" and had to be brought straight back up. A job asks permission to
 *              start; a server is the thing that was already there.
 *
 * WHY IT IS HERE AND NOT IN A PROMPT. The cutoff previously existed only as an intention held by
 * whoever was at the keyboard, so it could only be enforced while someone was awake to enforce
 * it. The session went idle at 15:22 MT and a background job was still alive at 21:55 MT — nearly
 * five hours past the stop — because nothing in the apparatus could act while nobody was looking.
 * A rule that depends on attention is not a rule.
 *
 * MOUNTAIN, NOT ET. Every other clock in this file is market time; this one is the OPERATOR's own
 * time, because it is about his evening rather than the session. 17:00 MT is 19:00 ET, comfortably
 * after the close and after the settle, so no trading-day work is cut short by it.
 */
const STOP_HOUR_MT = Number(process.env.TRAIDS_STOP_HOUR_MT || 17);

/** The operator's wall clock, which is not the market's. */
function mtParts(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const g = (t) => +(p.find((x) => x.type === t) || {}).value;
  return { hh: g("hour"), mm: g("minute") };
}

function etParts(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  }).formatToParts(now);
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return { day: `${g("year")}-${g("month")}-${g("day")}`, hh: +g("hour"), mm: +g("minute"), dow: g("weekday") };
}

/** How much 24/7 exposure is sitting unwatched while the guard is closed. */
function weekendCryptoExposure() {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "board_positions.json"), "utf8"));
    const live = b.filter((p) => p && !p.vetoShadow && (p.cls === "Crypto" || p.cls === "FX"));
    return { open: live.length, crypto: live.filter((p) => p.cls === "Crypto").length, fx: live.filter((p) => p.cls === "FX").length };
  } catch { return { open: null, crypto: null, fx: null }; }
}

/**
 * Should an automated job run right now?
 * Returns { open, why, window, forced, exposure } — never throws, so a guard can never be the
 * thing that breaks a chain.
 */
/**
 * STOP FILE (2026-09-04, safety lens). One documented way to stop every scheduled JOB: create backend/data/TRAIDS_STOP (contents
 * ignored). runWindow() reports closed while it exists; delete it to resume. It beats --force and TRAIDS_RUN=1 — a stop is the operator's
 * last word. Servers (:3001, :3002) never consult this module and never stop: TRAIDS NEVER STOPS. The live watcher checks the same file
 * once a minute and exits quietly (no message is sent).
 */
const STOP_FILE = path.join(__dirname, "..", "data", "TRAIDS_STOP");
function stopRequested() { try { return fs.existsSync(STOP_FILE); } catch { return false; } }
function runWindow(now = new Date()) {
  const t = etParts(now);
  if (stopRequested()) return { open: false, forced: false, window: "STOPPED", why: "backend/data/TRAIDS_STOP exists — the operator stopped all background jobs; delete the file to resume (servers unaffected)", et: t, exposure: weekendCryptoExposure() };
  const forced = process.env.TRAIDS_RUN === "1" || process.argv.includes("--force");
  const satTrading = process.env.TRAIDS_TRADING_SAT === "1";
  const exposure = weekendCryptoExposure();

  if (forced) return { open: true, forced: true, window: "OPERATOR", why: "explicit operator request (TRAIDS_RUN=1 or --force)", et: t, exposure };

  if (t.dow === "Sat") {
    if (satTrading) return { open: true, forced: false, window: "SAT-TRADING", why: "Saturday declared a trading day (TRAIDS_TRADING_SAT=1)", et: t, exposure };
    return { open: false, forced: false, window: "SAT-CLOSED", why: "Saturday — nothing runs unless we are trading Saturday or the operator asks", et: t, exposure };
  }
  const hol = marketHoliday(t.day);
  if (hol) {
    if (t.hh < PREP_HOUR) return { open: false, forced: false, window: "HOLIDAY-CLOSED", why: `${t.day} is ${hol} — market closed; nothing runs until the ${PREP_HOUR}:00 ET prep window`, et: t, exposure };
    return { open: true, forced: false, window: "HOLIDAY-PREP", why: `${hol} evening (${t.hh}:${String(t.mm).padStart(2, "0")} ET) — prep window for the next trading day`, et: t, exposure };
  }
  if (t.dow === "Sun") {
    if (t.hh < PREP_HOUR) return { open: false, forced: false, window: "SUN-EARLY", why: `Sunday before ${PREP_HOUR}:00 ET — the prep run is the evening one`, et: t, exposure };
    return { open: true, forced: false, window: "SUN-PREP", why: `Sunday ${t.hh}:${String(t.mm).padStart(2, "0")} ET — Monday prep window`, et: t, exposure };
  }
  // DAILY 17:00 MT STOP. Last, so the weekend rules above still take precedence and so a forced
  // run (checked first) always overrides it. Applies to JOBS only — servers never ask.
  const mt = mtParts(now);
  if (mt.hh >= STOP_HOUR_MT) {
    return { open: false, forced: false, window: "AFTER-HOURS-MT",
      why: `${String(mt.hh).padStart(2, "0")}:${String(mt.mm).padStart(2, "0")} MT — past the ${STOP_HOUR_MT}:00 Mountain stop; background jobs resume tomorrow`,
      et: t, mt, exposure };
  }
  return { open: true, forced: false, window: "WEEKDAY", why: t.dow + " — trading week", et: t, mt, exposure };
}

/**
 * Guard for a script's top line. Prints the reason and exits 2 when closed — 2, not 1, so a
 * scheduler reads "correctly declined" rather than "failed", the same convention the RTH guards
 * on r68-live.js and tr1-seal.js already use.
 */
function guardOrExit(label) {
  const w = runWindow();
  if (w.open) {
    if (w.forced) console.log(`[run-window] ${label}: FORCED — ${w.why}`);
    return w;
  }
  console.error(`[run-window] ${label}: NOT RUNNING — ${w.why}`);
  if (w.exposure && w.exposure.open) {
    console.error(`[run-window]   note: ${w.exposure.crypto} crypto and ${w.exposure.fx} FX position(s) are open and those markets do not close.`);
    console.error(`[run-window]   a stop touched while this guard is shut is acted on at the next open window. Override with TRAIDS_RUN=1.`);
  }
  process.exit(2);
}

module.exports = { runWindow, guardOrExit, weekendCryptoExposure, PREP_HOUR, MARKET_HOLIDAYS, marketHoliday, isMarketHoliday, STOP_FILE, stopRequested };
