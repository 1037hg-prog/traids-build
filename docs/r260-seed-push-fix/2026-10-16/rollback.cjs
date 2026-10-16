#!/usr/bin/env node
/**
 * ROLLBACK — node rollback.cjs [--dry] [--repo <dir>]
 * Puts base/ back byte for byte over every live file this package changed (a NEW file is removed). Refuses when a live file matches neither
 * staged/ nor base/ (changed after the deploy): nothing is rolled back then.
 */
"use strict";
const path = require("path"), L = require("./pkg-lib.cjs"), { FILES } = require("./files.cjs");
const a = process.argv.slice(2), i = a.indexOf("--repo"), repo = i >= 0 ? path.resolve(a[i + 1]) : L.findRepo(__dirname), rest = i >= 0 ? a.filter((x, k) => k !== i && k !== i + 1) : a;
if (rest.some((x) => x !== "--dry") || !repo) { console.error("usage: node rollback.cjs [--dry] [--repo <dir>]"); process.exitCode = 2; }
else process.exitCode = L.rollback(repo, FILES, { dry: rest.includes("--dry") });
