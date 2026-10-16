#!/usr/bin/env node
/**
 * COST BAND REFUSAL — ROLLBACK. Puts base/ back byte for byte: the new gate file is removed (its base is absent).
 *
 *   node docs/cost-band-refusal/2026-10-16/rollback.cjs --plan       read-only
 *   node docs/cost-band-refusal/2026-10-16/rollback.cjs --rollback   restores base/; refuses on drift or inside the fence
 *
 * Undo the two wiring edits (NOTES.md) FIRST, or the board server will fail to load the gate at its next restart.
 * The quicker off switch needs no rollback: create backend/data/cost-band-OFF.
 */
"use strict";
const P = require("./pkg.cjs");
const argv = process.argv.slice(2), mode = argv.includes("--rollback") ? "rollback" : "rollback-plan";
if (argv.some((a) => a !== "--rollback" && a !== "--plan")) { console.error("usage: rollback.cjs --plan | --rollback"); process.exit(2); }
console.log(`cost-band-refusal rollback --${mode === "rollback" ? "rollback" : "plan"}`);
process.exit(P.run({ mode }));
