#!/usr/bin/env node
"use strict";
/**
 * MASSIVE EXIT — backend/traids-server-v2.js (2026-10-02). PREPARED, NOT APPLIED: :3001 is the operator's to restart.
 *
 *   node "docs/massive-exit/patch-traids-server.cjs"           write backend/traids-server-v2.pending-massive.js (+ node -c)
 *   node "docs/massive-exit/patch-traids-server.cjs" --check   anchors only
 *   node "docs/massive-exit/patch-traids-server.cjs" --apply   overwrite the live file (refused 06:45-14:15 MT weekdays); then the
 *                                                              operator restarts :3001 (elevated, the house /deploy way)
 *
 * WHAT CHANGES (POST /api/futures/bars only):
 *   - the source is lib/futures-daily.js (Schwab daily continuous /ROOT, cached nightly by backend/futures-daily-cache.js after the
 *     watcher exits) instead of massive-futures.js (Massive 1session aggs, max-volume contract per day). Same response shape
 *     { data: { ROOT: [{c,h,l,v}] }, absent }. The ICE roots (KC SB CC CT OJ) stay absent -> Yahoo fallback, as under Massive.
 *   - the 503 gate tests that the daily cache exists, not MASSIVE_API_KEY (without this patch, removing the key = HTTP 503 and the
 *     daily-health "futures bars" probe FAILs).
 *   - known difference: during a session the newest daily bar is the previous session (Massive carried today's forming session).
 *     Board futures are veto shadows since OP8 — no ticket moves on them.
 * NOT CHANGED: refreshMarksForward() still calls futures-testbed.loadBars — it reads the store once futures-testbed.pending-massive.js
 * is applied (same restart). Apply both, then restart :3001 once.
 * ALSO: docs/audit-fixes/2026-09-30/unreviewed/backend__traids-server-v2.pending-0930.js carries the same endpoint; if that copy is
 * ever adopted, run this patch again against the adopted file.
 */
const { run, MARK } = require("./_patch-lib.cjs");
run({
  live: "backend/traids-server-v2.js",
  edits: [
    ["// Keep the API/app server ALIVE — a stray async error from Alpaca, Finnhub, Massive, or a",
     "// Keep the API/app server ALIVE — a stray async error from Alpaca, Finnhub, Schwab, or a"],
    [` *  → { data: { ROOT: [{c,h,l,v}, ...] } }  — continuous CME futures (Massive) WITH volume,`,
     ` *  → { data: { ROOT: [{c,h,l,v}, ...] } }  — continuous CME futures WITH volume (${MARK}: Schwab daily continuous from the
 *  nightly cache lib/futures-daily.js — was Massive; during a session the newest bar is the previous session),`],
    ['const massiveFutures = require("./massive-futures");', 'const futuresDaily = require("./lib/futures-daily.js");'],
    ['  if (!isRealKey(process.env.MASSIVE_API_KEY)) return res.status(503).json({ error: "Massive futures not configured — add MASSIVE_API_KEY to backend/.env." });',
     '  if (!futuresDaily.cacheAge("ES")) return res.status(503).json({ error: "Futures daily cache missing — run backend/futures-daily-cache.js after the session." });'],
    ["  const data = await massiveFutures.getFuturesBars(roots);", "  const data = await futuresDaily.getFuturesBars(roots);"],
    ["  // Name the roots Massive has no data for, instead of leaving them as indistinguishable nulls.",
     "  // Name the roots the Schwab daily cache has no data for, instead of leaving them as indistinguishable nulls."],
    ["console.warn(`[futures/bars] no Massive data for: ${absent.join(\", \")}`);", "console.warn(`[futures/bars] no Schwab daily data for: ${absent.join(\", \")}`);"],
  ],
});
