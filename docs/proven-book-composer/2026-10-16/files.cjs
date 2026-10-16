"use strict";
/** the file this package adds at home (NEW: base/ holds none), and its change record's fields (pkg-lib.cjs) */
const FILES = [{ rel: "backend/proven-book/book-composer.cjs", kind: "new" }];
const META = { id: "proven-book-composer", date: "2026-10-16", package: "docs/proven-book-composer/2026-10-16",
  what: "new backend/proven-book/book-composer.cjs: composes R180 (month-end IEF), R313 and R328 (dip-buys at full slot) nightly on one account with an exposure cap and no margin; idle cash offered to the second layer (the Stacker). Composer only: no rule registered, no order sent",
  tests: [] };
module.exports = { FILES, META };
