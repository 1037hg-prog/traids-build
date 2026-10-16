"use strict";
/** the files this package adds at home (all NEW: base/ holds none), and its change record's fields (pkg-lib.cjs) */
const FILES = [{ rel: "backend/bt/bt-core.cjs", kind: "new" }, { rel: "backend/bt/bt-run.cjs", kind: "new" }, { rel: "backend/bt/rules/dip-ibs-country-etfs.json", kind: "new" }];
const META = { id: "server-backtest-runner", date: "2026-10-16", package: "docs/server-backtest-runner/2026-10-16",
  what: "new backend/bt/: a no-AI backtest runner for the server (rule JSON over stored daily bars, with costs; sealed result: trades, mean, NW t by entry month, 2x cost, corrected matched placebo, drift floor, leak test, positive control, bar); first rule: R313's IBS dip-buy on 24 single-country ETFs (draft, exploratory until registered at home)",
  tests: [] };
module.exports = { FILES, META };
