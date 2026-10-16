"use strict";
/**
 * chainfix manifest — generated 2026-10-05T16:34:01.267Z by the packaging step (do not hand-edit shas).
 * baseSha  = sha256 of the LIVE file before this package (null = the file must not exist yet).
 * stagedSha = sha256 of staged/<rel>; deploy copies it byte-exact and verifies this sha on the live path.
 */
module.exports = {
  PACKAGE: "chainfix",
  FILES: [
    {
      "rel": "backend/routine-necessity.js",
      "baseSha": "4d3ab97946411c4c3b0b39e487677a705baa55dfcc77580f81d2e57b491997cd",
      "stagedSha": "1777a5085fefe547531f03cb3253bf57a2610239b9314a1315e56b36c3c70344",
      "bytes": 13349,
      "eol": "LF",
      "why": "BK6 reader search + output history batched; fail-closed on search failure"
    },
    {
      "rel": "backend/lib/git-grep-batch.js",
      "baseSha": null,
      "stagedSha": "37f21954054a6b7fe0e0c9a71a0bf9d83f1bbf730dd5f4fd5bd81dc7f9bbc5ec",
      "bytes": 6251,
      "eol": "LF",
      "why": "BK6 new lib: one union git grep + exact attribution"
    },
    {
      "rel": "backend/ats-cache-warm.js",
      "baseSha": "d72829f9a65d533dc57eebcc139b42491f5bc15777caf770df86c8a70f1a2ed5",
      "stagedSha": "5a8f687ef73f7f3c1caf334145346e8485c96d583d04283dd4266c7fc15d47a1",
      "bytes": 10837,
      "eol": "LF",
      "why": "BK7 saves via lib/cache-save.js (atomic, retried, merged)"
    },
    {
      "rel": "backend/lib/cache-save.js",
      "baseSha": null,
      "stagedSha": "5ad64340adac53bfbc246b5688b7a642f2f2c2d8a8558ee08de91694bb31d56a",
      "bytes": 4342,
      "eol": "LF",
      "why": "BK7 new lib: writeJsonAtomic + EBUSY/EPERM/EACCES/UNKNOWN retry + per-key merge"
    },
    {
      "rel": "backend/crypto-spread-snapshot.js",
      "baseSha": "dadb0e8592c256cab6c86332d73ebfcdb33ad787bb0d34b419c082a832ddeb97",
      "stagedSha": "5ec99c665ee5df6f7675741fde8a6aeeb2b8a2e4f6c89b28ba84480e328be30f",
      "bytes": 13799,
      "eol": "LF",
      "why": "FR-6 every symbol attempted: Alpaca first, Coinbase L1 for names Alpaca has no live book for; venue tagged; --dry"
    },
    {
      "rel": "backend/data/macro-calendar.json",
      "baseSha": "ad371170e965cb8c4e558fb19b8913d87d4108e5825df046f7ceca998b476e13",
      "stagedSha": "225e69aee403d003c235de9d23955342caf7a88c909acea2abda7e7a92ed875c",
      "bytes": 4837,
      "eol": "LF",
      "why": "FR-5 PCE dates 2026-10-29, 2026-11-25, 2026-12-23 (BEA); dated note"
    }
  ],
};
