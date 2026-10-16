#!/usr/bin/env node
/**
 * SLEEVE SILENT-DEATH ALERT — ROLLBACK. Puts base/ back byte for byte: the new alert script is removed (its base is absent).
 *
 *   node docs/sleeve-silent-death-alert/2026-10-16/rollback.cjs --plan       read-only
 *   node docs/sleeve-silent-death-alert/2026-10-16/rollback.cjs --rollback   restores base/; refuses on drift or inside the fence
 *
 * Remove the scheduled run (NOTES.md) FIRST, or it will fail to find the script. The quicker off switch: backend/data/sleeve-silence-OFF.
 */
"use strict";
const P = require("./pkg.cjs");
const argv = process.argv.slice(2), mode = argv.includes("--rollback") ? "rollback" : "rollback-plan";
if (argv.some((a) => a !== "--rollback" && a !== "--plan")) { console.error("usage: rollback.cjs --plan | --rollback"); process.exit(2); }
console.log(`sleeve-silent-death-alert rollback --${mode === "rollback" ? "rollback" : "plan"}`);
process.exit(P.run({ mode }));
