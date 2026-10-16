"use strict";
/** the files this package changes at home, and its change record's fields (pkg-lib.cjs) */
const FILES = [{ rel: "deploy/server/r191-r231-carry.cjs", kind: "new" }];
const META = { id: "r191-r231-carry-job", date: "2026-10-16", package: "docs/r191-r231-carry-job/2026-10-16",
  what: "new home job deploy/server/r191-r231-carry.cjs: carries R191's and R231's state files and the board mirror's two files to the VPS's real and shadow data folders while W3's units move one at a time and the board stays home",
  tests: [] };
module.exports = { FILES, META };
