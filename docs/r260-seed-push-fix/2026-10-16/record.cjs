#!/usr/bin/env node
/**
 * RECORD — node record.cjs --dry [--repo <dir>]
 * Prints the change record this package would add at home (the file shas come from base/ and staged/). Only --dry exists here: the operator
 * enters the record at home with the home repository's own recorder, after --apply.
 */
"use strict";
const path = require("path"), L = require("./pkg-lib.cjs"), { FILES, META } = require("./files.cjs");
const a = process.argv.slice(2), i = a.indexOf("--repo"), repo = i >= 0 ? path.resolve(a[i + 1]) : L.findRepo(__dirname), rest = i >= 0 ? a.filter((x, k) => k !== i && k !== i + 1) : a;
if (rest.length !== 1 || rest[0] !== "--dry" || !repo) { console.error("usage: node record.cjs --dry [--repo <dir>]"); process.exitCode = 2; }
else { console.log(JSON.stringify(L.record(repo, FILES, META), null, 1)); console.log("DRY: nothing written"); process.exitCode = 0; }
