#!/usr/bin/env node
"use strict";
/**
 * MASSIVE EXIT — src/App.jsx board label + comments (2026-10-02). Client source: takes effect only through a rebuild/deploy, so it
 * ships TOGETHER with the server patch (patch-traids-server.cjs) — a label that says Schwab while :3001 still serves Massive is wrong.
 *
 *   node "docs/massive-exit/patch-app-label.cjs"           write src/App.pending-massive.jsx (no node -c for JSX; the build checks it)
 *   node "docs/massive-exit/patch-app-label.cjs" --check   anchors only
 *   node "docs/massive-exit/patch-app-label.cjs" --apply   overwrite src/App.jsx (refused 06:45-14:15 MT weekdays), then /deploy
 */
const { run, MARK } = require("./_patch-lib.cjs");
run({
  live: "src/App.jsx",
  edits: [
    ["    // Futures: real CME continuous contracts WITH VOLUME via Massive (re-enables Breakout/RVOL\n    // for futures). Falls back to Yahoo per-root if Massive isn't configured or has no data.",
     `    // Futures: real CME continuous contracts WITH VOLUME (${MARK}: Schwab daily continuous, nightly cache; was Massive) —\n    // re-enables Breakout/RVOL for futures. Falls back to Yahoo per-root when the cache has no data for a root.`],
    ["      // Futures → Massive continuous bars (with volume); everything else as before.",
     "      // Futures → Schwab continuous daily bars (with volume); everything else as before."],
    ["futures via Massive (CME, w/ volume)", "futures via Schwab daily (CME continuous, w/ volume)"],
  ],
});
