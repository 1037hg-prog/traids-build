"use strict";
/**
 * THE SELFTEST'S FIXTURES — synthetic daily closes, written as specs so the whole population of every test is on one
 * screen and cannot drift. make.cjs turns a spec into the store the monitor reads (one <SYM>.json per symbol, rows
 * { d, c, a }, exactly the shape docs/ai-bubble-2026-10/bust/fetch.js writes).
 *
 * Nothing here is market data. Every number is made up, and each row's PRICE close `c` is deliberately twice its
 * ADJUSTED close `a` — nothing like a real series — so that a reading of the wrong field cannot pass a known answer.
 *
 * Sessions are every Monday-to-Friday date from `from` to `end` inclusive; holidays are not modelled (a fixture needs
 * a calendar of month boundaries, not a real one). The last calendar month of a series is the forming month, and the
 * month before it holds the last completed month-end — which is what the B2 rung reads.
 *
 * WHY THE B1 FIXTURES START LOW. The band rule's FIRST reading, before the band has a state to hold, is the plain
 * test close > 200-day mean (bust/triggers.js:54). On a series that is flat for ever that reading is `100 > 100` =
 * false, so such a series is ARMED from its first reading and never leaves — and a "crossing day" built on it would
 * prove nothing, because the rung was already armed the day before. So every B1 fixture starts with 199 sessions at a
 * LOWER level: the first reading is then plainly above the mean (not armed), the band holds it there through the flat
 * run that follows, and the last session is the one under test.
 *
 * SHAPES
 *   { flat: v }                            every session v
 *   { step: { low, high, last } }          the first `lowSessions` (199) sessions at `low`, the rest at `high`, and the
 *                                          LAST session at `last`. The 200 closes behind that last session are then
 *                                          199 x high + last, which is where the designed B1 arithmetic comes from.
 *   { ramp: { start, step, last, forming } }  every session of the j-th calendar month (j = 0 oldest) takes
 *                                          start + j x step; the LAST COMPLETED month takes `last` when given, and the
 *                                          forming month takes `forming`, or `last`, or its ramp value.
 *   end: "YYYY-MM-DD"                      this symbol's series stops early (the others run to the spec's end)
 *   drop: ["YYYY-MM-DD", ...]              these sessions are missing from this symbol's series (a gap, not an end)
 *
 * THE DESIGNED ARITHMETIC — the selftest asserts these exact numbers (NOTES.md carries the derivations).
 * The B1 rungs (QQQ, SPY, SMH) read the daily band; B2-QQQ and B2-SPY read the monthly flip; B2-CREDIT reads the
 * VWEHX/VFITX ratio, which is a plain ramp in every fixture (VWEHX ramps, VFITX is flat), so it is never armed.
 *
 *   b1-cross     QQQ 90 x199 then 100, last session 97      200-day mean (199x100 + 97)/200 = 99.985; arm level
 *                                                           0.98 x 99.985 = 97.9853 -> 97 is BELOW it: B1-QQQ ARMS on
 *                                                           that session, having been not armed the day before (every
 *                                                           close in that window is 100, mean 100, arm level 98)
 *   b1-no-cross  QQQ 90 x199 then 100, last session 98       mean 99.99; arm level 97.9902 -> 98 is above it by
 *                                                           0.0098: NO arm, on the same series one tick higher
 *   b1-equal     QQQ 9000 x199 then 9951, last 9751          mean (199x9951 + 9751)/200 = 9950 exactly; arm level
 *                                                           0.98 x 9950 = 9751 exactly -> a close EQUAL to the arm
 *                                                           level does NOT arm (the rule needs STRICTLY below)
 *   b2-cross     QQQ months 100,101,..,122 then 100          last 10 month-ends incl. the current one =
 *                                                           (114+..+122 + 100)/10 = 116.2 -> 100 <= 116.2: B2-QQQ ARMS
 *                                                           at that month-end, and the month-end before it did not
 *                                                           (122 vs (113+..+122)/10 = 117.5)
 *                SPY months 100,..,122 then 140              (1062 + 140)/10 = 120.2 -> 140 is above it: no arm
 *   b2-no-cross  QQQ months 100,..,122 then 119              (1062 + 119)/10 = 118.1 -> 119 is above it by 0.9: no arm
 *   b2-equal     QQQ months 100,..,122 then 118              (1062 + 118)/10 = 118.0 exactly -> a month-end EQUAL to
 *                                                           the mean ARMS (the rule is IN only when STRICTLY above)
 *   short        113 sessions over 6 calendar months         neither rule can be read: every rung is NOT READ — none
 *                                                           of them is reported "not armed"
 *   lag          b1-cross, but VFITX stops 2026-09-25        the whole ladder is read as of 2026-09-25, the one day
 *                                                           every series reaches, and B1-QQQ is then NOT armed (the
 *                                                           arming close of 2026-10-06 is not in the read window)
 *   credit-gap   VFITX is missing 2026-05-29 and 2026-06-10  the ratio is taken only on dates BOTH series have, so its
 *                                                           May month-end is 2026-05-28 — the same monthly value, and
 *                                                           no session is ever divided by a price that is not there
 */
const LOW_SESSIONS = 199;
/** 2024-10-01..2026-10-06: 526 sessions (>= 199 low + 199 high + 1) and 25 calendar months (24 completed month-ends) */
const FULL = { from: "2024-10-01", end: "2026-10-06" };
const STEP = (last, { low = 90, high = 100 } = {}) => ({ step: { low, high, last } });
const FLAT = { flat: 100 };
const CREDIT = { VWEHX: { ramp: { start: 100, step: 1 } }, VFITX: FLAT };     // a ramping ratio: B2-CREDIT is never armed
const B1 = (last, o) => ({ ...FULL, symbols: { QQQ: STEP(last, o), SPY: STEP(o ? o.high : 100, o), SMH: STEP(o ? o.high : 100, o), ...CREDIT } });
const B2 = (qqq, spy = null) => ({ ...FULL, symbols: { QQQ: { ramp: { start: 100, step: 1, last: qqq } },
  SPY: spy == null ? STEP(100) : { ramp: { start: 100, step: 1, last: spy } }, SMH: STEP(100), ...CREDIT } });

const SPECS = Object.freeze({
  "b1-cross": B1(97),
  "b1-no-cross": B1(98),
  "b1-equal": B1(9751, { low: 9000, high: 9951 }),
  "b2-cross": B2(100, 140),
  "b2-no-cross": B2(119),
  "b2-equal": B2(118),
  short: { from: "2026-05-01", end: "2026-10-06", symbols: { QQQ: FLAT, SPY: FLAT, SMH: FLAT, VWEHX: FLAT, VFITX: FLAT } },
  lag: { ...FULL, symbols: { QQQ: STEP(97), SPY: STEP(100), SMH: STEP(100), VWEHX: { ramp: { start: 100, step: 1 } }, VFITX: { flat: 100, end: "2026-09-25" } } },
  "credit-gap": { ...FULL, symbols: { QQQ: STEP(100), SPY: STEP(100), SMH: STEP(100), VWEHX: { ramp: { start: 100, step: 1 } },
    VFITX: { flat: 100, drop: ["2026-05-29", "2026-06-10"] } } },
});

/** every Monday-to-Friday date from `from` to `end` inclusive, ascending */
function sessions(from, end) {
  const out = [];
  for (let t = Date.parse(from + "T00:00:00Z"), z = Date.parse(end + "T00:00:00Z"); t <= z; t += 864e5) {
    const dow = new Date(t).getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** one symbol's rows from its shape: [{ d, c, a }], c = 2 x a so a reading of the price close cannot pass */
function rows(shape, from, end) {
  const drop = new Set(shape.drop || []);
  const dates = sessions(from, shape.end || end).filter((d) => !drop.has(d));
  if (!dates.length) throw new Error(`no sessions between ${from} and ${shape.end || end}`);
  const last = dates.length - 1, months = [...new Set(dates.map((d) => d.slice(0, 7)))];
  const val = (d, i) => {
    if (shape.flat != null) return shape.last != null && i === last ? shape.last : shape.flat;
    if (shape.step) { const s = shape.step; return i === last ? s.last : i < LOW_SESSIONS ? s.low : s.high; }
    if (shape.ramp) {
      const r = shape.ramp, j = months.indexOf(d.slice(0, 7)), ramped = r.start + j * r.step;
      if (j === months.length - 1) return r.forming != null ? r.forming : r.last != null ? r.last : ramped;   // the forming month
      if (j === months.length - 2 && r.last != null) return r.last;                                          // the last completed month-end
      return ramped;
    }
    throw new Error("a shape must give flat, step or ramp");
  };
  return dates.map((d, i) => { const a = val(d, i); return { d, c: +(a * 2).toFixed(4), a: +a.toFixed(4) }; });
}

/** a whole spec -> { [sym]: rows } */
function store(name) {
  const spec = SPECS[name];
  if (!spec) throw new Error(`no fixture named ${name} (have: ${Object.keys(SPECS).join(", ")})`);
  const out = {};
  for (const [sym, shape] of Object.entries(spec.symbols)) {
    const r = rows(shape, spec.from, spec.end);
    if (shape.step && r.length < 2 * LOW_SESSIONS + 1) throw new Error(`${name}/${sym}: a step shape needs at least ${2 * LOW_SESSIONS + 1} sessions, has ${r.length}`);
    out[sym] = r;
  }
  return out;
}

module.exports = { SPECS, LOW_SESSIONS, FULL, sessions, rows, store };
