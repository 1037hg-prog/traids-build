// PAPER-AUCTION-FIX 2026-10-02 harness: every scenario against the PENDING files (fake broker, fake clock, fake keys; no network; scratch
// state under the OS temp dir; backend/data is only READ, by test-compat.cjs, to copy today's state). Add --original to watch the live
// runners fail the same scenarios (documents the defects). Usage: node docs/paper-auction-fix/2026-10-02/harness-auctionfix/run-all.cjs
"use strict";
const path = require("path"), cp = require("child_process");
const { REAL_BK } = require("./lib-harness.cjs");
const ORIG = process.argv.includes("--original");
const f = (n) => path.join(REAL_BK, ORIG ? `${n}.js` : `${n}.pending-auctionfix.js`), x = ORIG ? ["--expect-old"] : [];
const jobs = [["test-r236.cjs", f("r236-tv-forward"), ...x], ["test-book.cjs", f("book-etf-rebalancer"), ...x], ["test-mirror.cjs", f("alpaca-mirror"), ...x],
  ["test-reconcile.cjs", f("alpaca-reconcile"), path.join(REAL_BK, "alpaca-reconcile.js")], ["test-payne.cjs", f("payne-picks"), ...x],
  ["test-crypto.cjs", f("r191-crypto-trend-forward"), f("r231-crypto-vote-sized-forward"), ...x], ...(ORIG ? [] : [["test-compat.cjs"]])];
let bad = 0;
for (const [t, ...a] of jobs) { const r = cp.spawnSync(process.execPath, [path.join(__dirname, t), ...a], { encoding: "utf8" }); process.stdout.write(r.stdout + r.stderr); if (r.status) bad++; }
console.log(bad ? `${bad} harness file(s) reported failures` : "ALL HARNESSES PASSED");
process.exitCode = bad ? 1 : 0;
