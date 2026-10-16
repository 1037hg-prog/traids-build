#!/usr/bin/env node
/**
 * SLEEVE SILENT-DEATH ALERT — DEPLOY. 2026-10-16 (docs/sleeve-silent-death-alert/2026-10-16). Built in a cloud session; never applied there.
 *
 *   node docs/sleeve-silent-death-alert/2026-10-16/deploy.cjs --plan     read-only: each file's state and what --apply would write
 *   node docs/sleeve-silent-death-alert/2026-10-16/deploy.cjs --apply    writes staged/ over base; refuses on drift or inside the fence
 *
 * Refuses (exit 2, nothing changed) when any live file matches neither base/ nor staged/, or on a trading weekday 05:30-16:00 MT.
 * It restarts nothing and schedules nothing: the operator adds the scheduled run at home (NOTES.md).
 */
"use strict";
const P = require("./pkg.cjs");
const argv = process.argv.slice(2), mode = argv.includes("--apply") ? "apply" : "plan";
if (argv.some((a) => a !== "--apply" && a !== "--plan")) { console.error("usage: deploy.cjs --plan | --apply"); process.exit(2); }
console.log(`sleeve-silent-death-alert deploy --${mode}`);
process.exit(P.run({ mode }));
