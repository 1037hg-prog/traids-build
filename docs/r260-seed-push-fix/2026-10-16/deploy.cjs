#!/usr/bin/env node
/**
 * DEPLOY — node deploy.cjs --plan | --apply [--repo <dir>]
 * --plan shows each file's state (base / applied / drift) and what --apply would write; --apply writes staged/ over the live files, REFUSING if any
 * live file no longer matches base/ (drift). Run at home by the operator; a cloud session never runs --apply on the real tree.
 */
"use strict";
const path = require("path"), L = require("./pkg-lib.cjs"), { FILES } = require("./files.cjs");
const a = process.argv.slice(2), i = a.indexOf("--repo"), repo = i >= 0 ? path.resolve(a[i + 1]) : L.findRepo(__dirname), rest = i >= 0 ? a.filter((x, k) => k !== i && k !== i + 1) : a;
if (rest.length !== 1 || !["--plan", "--apply"].includes(rest[0]) || !repo) { console.error("usage: node deploy.cjs --plan | --apply [--repo <dir>]"); process.exitCode = 2; }
else process.exitCode = L.deploy(repo, FILES, { mode: rest[0] === "--apply" ? "apply" : "plan" });
