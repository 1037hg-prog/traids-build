"use strict";
/**
 * the files this package changes at home, and its change record's fields (pkg-lib.cjs).
 * pull-server.cjs: BOTH copies (the installed deploy/server/pull-server.cjs and W1's staged docs/server/wave1-crypto/pull-server.cjs) start from
 * the same bytes (base/ holds the clean copy's docs/server/wave1-crypto/pull-server.cjs for each; deploy.cjs refuses if home's installed copy
 * is not those bytes). own.cjs: only once make-own-stage.cjs --write has put its base/ and staged/ copies here AT HOME (it is not in the cloud copy).
 */
const fs = require("fs"), path = require("path");
const FILES = [{ rel: "docs/server/wave1-crypto/pull-server.cjs", kind: "edit" }, { rel: "deploy/server/pull-server.cjs", kind: "edit" },
  ...["deploy/server/own.cjs", "docs/server/wave1-crypto/own.cjs"].filter((t) => fs.existsSync(path.join(__dirname, "base", t))).map((rel) => ({ rel, kind: "edit" }))];
const META = { id: "r260-seed-push-fix", date: "2026-10-16", package: "docs/r260-seed-push-fix/2026-10-16",
  what: "pull-server.cjs gains pushChunked / remoteShasChunked (every script under 5,000 characters, each chunk read back by sha256); own.cjs's seed push uses them (lines named at home with make-own-stage.cjs) — the w3-r260 seed push's single script was cut on the way (here-document EOF_SHA)",
  tests: [] };
module.exports = { FILES, META };
