#!/usr/bin/env node
/** Records OP9 (operator 2026-10-02: "R24 to $250") in the change registry and agent ledger. Refuses if already recorded. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
if (cr.some((c) => /^OP9 /.test(c.area || ""))) { console.error("OP9 already recorded"); process.exit(2); }
cr.push({ date: "2026-10-02", area: "OP9 — R24 13F-clone board sleeve sized at $250 risk ($1,250 a name), was $600 ($3,000)", category: "sizing", breaksComparability: true,
  change: "backend/op9-r24-resize.js (applied through the server, verified): 11 lots held before the 2026-10-02 close closed at the official SIP close (reason resize-OP9, closedAt 16:00 ET, stamped sleeve R24-v1 + ctrl:false, realized +$481.74 that was already unrealized); 7 lots added after the close restated at the official close with no ledger row; all 18 reopened at $1,250 under ids <CLOSE_MS>-Equity-<SYM>-r24. Sleeve risk $10,800 -> $4,500. backend/r24-sleeve.js: new adds $1,250 with a per-lot notional (legacy fallback $3,000), plus a guard that ignores closed/tombstoned lots and refuses on duplicate lots. Backups: docs/paper-auction-fix/2026-10-02/backups/*.pre-op9.*",
  why: "Operator 2026-10-02: 'R24 to $250' — R24 carried 2-4x the risk of any other ticket on the board while its history reads t 1.10; the 5 rotation exits on 10-02 lost -$1,211 at $600 risk. Adversarial review 2026-10-02 (sleeve stamp, server-side apply, deterministic ids, session guard, official-close restatement) applied before the write.",
  doesNotEstablish: "Any change in R24's measured edge — the R24 test (best-ideas-forward.json) is in percent and is untouched; the BOOK mirror ($1,400) is unchanged.", operator: "Josh 2026-10-02" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "operating-decision", op: "OP9", detail: "R24 board sleeve $600 -> $250 risk per name" }) + "\n");
console.log("OP9 recorded");
