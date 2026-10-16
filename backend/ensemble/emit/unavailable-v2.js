#!/usr/bin/env node
"use strict";
/** Library v2 (2026-09-25): sealed tests since R201 that have no dated net stream in the library yet, and why. READ-ONLY. */
const { writeUnavailable } = require("../lib-entry.js");
const E = "backend/ensemble/emit/unavailable-v2.js";
writeUnavailable({ id: "R202", name: "One-candle exhaustion shorts (15m/1h)", registryId: "R202", script: "backend/r202-one-candle.js", emitter: E,
  reason: "Output persists no dated trade rows; regenerating needs a full 15m/1h intraday re-fetch of the universe (2018-2026). Deferred: sealed t -2.627 (net -0.175R/trade), far below any selection threshold." });
writeUnavailable({ id: "R207", name: "Cross-retest-hold at four intraday levels", registryId: "R207", script: "backend/r207-cross-retest-hold.js", emitter: E,
  reason: "Output persists no dated trade rows (330k trades summarised); regenerating needs the 1-minute re-fetch of 20+ names. Deferred: every level t between -6.5 and -21.7." });
writeUnavailable({ id: "R216", name: "Month-end dollar reversal on spot FX before 2016", registryId: "R216", script: "backend/r216-usd-month-end.js", emitter: E,
  reason: "VOID (scoring artifact: signed position x drift subtraction sharing signal days). Its window is pre-2016 spot FX, which does not overlap the library era; the raw dollar leg over 2003-2026 is in futures-month-end.js ('Dollar 5x only (artifact check)': CAGR -2.9%, Sharpe -0.31)." });
writeUnavailable({ id: "R217", name: "Dollar short-term reversal, H.10 1974-2006", registryId: "R217", script: "backend/r217-dollar-reversal-fred.js", emitter: E,
  reason: "Window 1974-2006 does not overlap the library era (2016-2026); sealed DID NOT PASS (best L=10 t -3.282)." });
writeUnavailable({ id: "R230", name: "Crypto 13-coin trend vote + vol-sizing (holdout year)", registryId: "R230", script: "backend/r230-crypto-vote-sized.js", emitter: E,
  reason: "Output persists summary statistics only (holdout 2025-09-24..2026-09 one year); a daily series needs a 13-coin re-fetch. Its forward twin R231 accrues from 2026-09-25. Sealed DID NOT PASS (alpha t 0.281 vs 1.639)." });
