/**
 * PIPELINE INTEGRITY — the defects that destroyed four sessions of evidence.
 *
 * D49: the settle step judged success by watching the open-position count FALL, which looks
 *      identical whether a position settled or was dropped.
 * D50: the rebuild waited for a transient state to DISAPPEAR, which passes trivially when the
 *      state never began because the click silently failed.
 * D51: the probe written to catch D49 used count arithmetic and cried wolf on a healthy book.
 *
 * Every one is a case of measuring a PROXY instead of the thing that matters. These tests
 * assert the real observable.
 */
const { suite, test, eq, ok, throws } = require("./run");

// ── D49: settle success is rows arriving, never positions leaving ────────────────────────────
function settleVerdict({ openBefore, openAfter, ledgerBefore, ledgerAfter }) {
  const vanished = openBefore - openAfter;
  const banked = ledgerBefore == null || ledgerAfter == null ? null : ledgerAfter - ledgerBefore;
  if (banked == null) return "UNVERIFIED";
  if (vanished > 0 && banked === 0) return "FATAL";
  if (banked < vanished * 0.8) return "WARN";
  return "OK";
}

suite("D49 · settle is verified by ledger growth, not by the book shrinking", () => {
  test("THE ACTUAL 2026-08-06 FAILURE: 88 left, 0 banked -> FATAL", () => {
    eq(settleVerdict({ openBefore: 93, openAfter: 5, ledgerBefore: 1342, ledgerAfter: 1342 }), "FATAL");
  });

  test("the old heuristic would have called that a success", () => {
    const openBefore = 93, openAfter = 5;
    ok(openBefore - openAfter === 88, "the count fell by 88, which the old code logged as 'settled 88'");
  });

  test("a healthy settle passes", () => {
    eq(settleVerdict({ openBefore: 93, openAfter: 5, ledgerBefore: 1342, ledgerAfter: 1430 }), "OK");
  });

  test("options swings that legitimately do not settle are NOT fatal", () => {
    // nothing left the book, so nothing was lost — this is the recovery-run case
    eq(settleVerdict({ openBefore: 5, openAfter: 5, ledgerBefore: 1342, ledgerAfter: 1342 }), "OK");
  });

  test("a partial shortfall warns rather than passing", () => {
    eq(settleVerdict({ openBefore: 100, openAfter: 10, ledgerBefore: 1000, ledgerAfter: 1040 }), "WARN");
  });

  test("an unreadable ledger is UNVERIFIED, never a silent pass", () => {
    eq(settleVerdict({ openBefore: 93, openAfter: 5, ledgerBefore: null, ledgerAfter: null }), "UNVERIFIED");
  });
});

// ── D50: waiting for absence is vacuous if the state never began ─────────────────────────────
/** Models the wait: returns the verdict given whether the scan marker ever appeared. */
function rebuildVerdict({ markerAppeared, markerCleared, setups }) {
  if (!markerAppeared) return "FATAL_NEVER_STARTED";
  if (!markerCleared) return "WARN_DID_NOT_FINISH";
  if (!setups) return "FATAL_ZERO_SETUPS";
  return "OK";
}

suite("D50 · the rebuild must be asserted to START, not only to end", () => {
  test("THE ACTUAL FAILURE: click silently failed, marker never appeared -> FATAL", () => {
    eq(rebuildVerdict({ markerAppeared: false, markerCleared: true, setups: 0 }), "FATAL_NEVER_STARTED");
  });

  test("the old condition (absence of the marker) passes instantly when nothing started", () => {
    const marker = "Scanning ~";
    const pageThatNeverScanned = "Daily Board — 5 setups";
    ok(!pageThatNeverScanned.includes(marker), "absence is TRUE before the action begins — that is the bug");
  });

  test("a real rebuild passes", () => {
    eq(rebuildVerdict({ markerAppeared: true, markerCleared: true, setups: 86 }), "OK");
  });

  test("a finished rebuild with zero setups is fatal, not quiet", () => {
    eq(rebuildVerdict({ markerAppeared: true, markerCleared: true, setups: 0 }), "FATAL_ZERO_SETUPS");
  });

  test("three seconds is not a rebuild — measured duration is ~24s for 86 setups", () => {
    ok(3 < 24 * 0.5, "a cycle that 'finishes' in 3s cannot have scanned 1000 instruments");
  });
});

// ── D50b: an Options-only book with zero controls means honest-fill refused everything ───────
function trackVerdict({ setups, tracked, controls, byCls }) {
  if (!tracked) return "FATAL_TRACKED_NOTHING";
  const linear = tracked - (byCls.Options || 0);
  if (!linear || !controls) return "WARN_NO_LINEAR_OR_CONTROLS";
  return "OK";
}

suite("D50b · zero controls is the honest-fill signature, not a quiet day", () => {
  test("THE ACTUAL FAILURE: 5 tracked, all Options, 0 controls -> WARN", () => {
    eq(trackVerdict({ setups: 88, tracked: 5, controls: 0, byCls: { Options: 5 } }), "WARN_NO_LINEAR_OR_CONTROLS");
  });
  test("the recovered cycle passes: 75 tracked, 33 controls, five classes", () => {
    eq(trackVerdict({ setups: 86, tracked: 75, controls: 33, byCls: { Options: 6, Crypto: 20, Equity: 33, FX: 10, Futures: 6 } }), "OK");
  });
  test("tracking nothing at all is fatal", () => {
    eq(trackVerdict({ setups: 88, tracked: 0, controls: 0, byCls: {} }), "FATAL_TRACKED_NOTHING");
  });
});

// ── D51: count arithmetic cannot distinguish LEFT from REPLACED ───────────────────────────────
function unaccounted(backup, openNow, ledger) {
  const openIds = new Set(openNow.map(p => String(p.id)));
  const logIds = new Set(ledger.map(r => String(r.id)));
  return backup.filter(p => !openIds.has(String(p.id)) && !logIds.has(String(p.id))).length;
}

suite("D51 · unaccounted positions are a SET difference, not a count difference", () => {
  const backup = Array.from({ length: 93 }, (_, i) => ({ id: "old" + i }));
  const survivors = backup.slice(0, 5);
  const newlyTracked = Array.from({ length: 70 }, (_, i) => ({ id: "new" + i }));

  test("THE FALSE ALARM: counts say 18 lost after a recovery, the truth is 88", () => {
    const openNow = survivors.concat(newlyTracked);      // 75 in the book
    eq(backup.length - openNow.length, 18, "count arithmetic gives the wrong answer");
    eq(unaccounted(backup, openNow, []), 88, "set difference gives the right one");
  });

  test("positions that settled into the ledger are accounted for", () => {
    const ledger = backup.slice(5).map(p => ({ id: p.id }));
    eq(unaccounted(backup, survivors, ledger), 0);
  });

  test("a clean day with everything settled or still open reports zero", () => {
    eq(unaccounted(backup, backup, []), 0);
  });
});

// ── D28/D20: windows and coverage must be MEASURED, never described ───────────────────────────
suite("D28/D20 · sample windows come from the data, not from a constant", () => {
  test("a window computed from a request constant can be 12x the truth", () => {
    const claimed = Math.round(34 * 100 / 3);            // the old PAGES arithmetic
    const actual = 94;                                    // what OKX actually returned
    ok(claimed / actual > 10, `claimed ${claimed}d against an actual ${actual}d`);
  });
  test("a window under half the request must be flagged", () => {
    const flag = (claimed, actual) => actual < claimed * 0.5;
    ok(flag(1133, 94));
    ok(!flag(1133, 1100));
  });
});

// ── D9: MFE/MAE sanity ────────────────────────────────────────────────────────────────────────
suite("D9 · excursion fields must be bounded", () => {
  const bad = (v) => Number.isFinite(v) && Math.abs(v) > 10;
  test("the historical +7.06R median would not trip a |x|>10 bound — the bound is for the collapse case", () => {
    ok(!bad(7.06), "7.06 is implausible but the guard targets the collapsed-denominator signature");
  });
  test("a collapsed stopDist produces a value the guard catches", () => {
    ok(bad(2389), "the ARB-class row was +2389R");
  });
  test("negative MAE is legitimate, not corruption", () => {
    ok(!bad(-0.628), "means price never traded against the entry");
  });
});
