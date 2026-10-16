#!/usr/bin/env node
/**
 * OPTIONS MIRROR TO THE BOOK ACCOUNT — ROLLBACK. Puts base/ back byte for byte: the new guard file is removed (its base is absent).
 *
 *   node docs/options-to-book-account/2026-10-16/rollback.cjs --plan       read-only
 *   node docs/options-to-book-account/2026-10-16/rollback.cjs --rollback   restores base/; refuses on drift or inside the fence
 *
 * Undo the mirror's wiring edit (NOTES.md) FIRST, or the options mirror will fail to load at its next run.
 */
"use strict";
const P = require("./pkg.cjs");
const argv = process.argv.slice(2), mode = argv.includes("--rollback") ? "rollback" : "rollback-plan";
if (argv.some((a) => a !== "--rollback" && a !== "--plan")) { console.error("usage: rollback.cjs --plan | --rollback"); process.exit(2); }
console.log(`options-to-book-account rollback --${mode === "rollback" ? "rollback" : "plan"}`);
process.exit(P.run({ mode }));
