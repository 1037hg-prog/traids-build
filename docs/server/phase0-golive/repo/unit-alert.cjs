#!/usr/bin/env node
/**
 * RETIRED 2026-10-06 (R309 go-live package, docs/server/phase0-golive). This file assumed the old server layout
 * (/home/traids/traids-bundle, a server-side deploy/ directory, /etc/traids/alerts.env) that was never deployed.
 * The alert that is deployed: backend/traids-alert.cjs on the VPS (repo copy: deploy/server/traids-alert.cjs), started by
 * traids-alert@.service through OnFailure= and sending through backend/notify.js on the ops-only bot.
 */
"use strict";
console.error("unit-alert.cjs is retired (2026-10-06): the VPS runs /home/traids/traids/backend/traids-alert.cjs — see deploy/server/traids-alert.cjs");
process.exitCode = 2;
