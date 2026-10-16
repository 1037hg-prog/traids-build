#!/usr/bin/env node
/** Library v1 entries that cannot (or may not) be emitted this run, each with its reason (ensemble-architect, 2026-09-24). */
"use strict";
const { writeUnavailable } = require("../lib-entry.js");
writeUnavailable({ id: "R151", name: "RSI-2 forward on the broker (paper)", registryId: "R151", script: "backend/r151-rsi2-forward.js",
  reason: "Forward paper test; first orders on the 2026-09-24 session, so no realised return stream exists yet. Its historical rule is in the library as R150-RSI2. The script places broker (paper) orders and is never executed by an emitter." });
writeUnavailable({ id: "R197", name: "S&P 500 index changes", registryId: "R197", script: "backend/r197-sp500-changes.js",
  reason: "Deferred by the operator's run instruction: another agent was reading R197 when library v1 started (it has since sealed). Emit in v2." });
writeUnavailable({ id: "R199", name: "Quarter-end window dressing", registryId: "R199", script: "backend/r199-window-dressing.js",
  reason: "Deferred by the operator's run instruction: another agent was reading R199 when library v1 started (it has since sealed). Emit in v2." });
