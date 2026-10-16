#!/usr/bin/env node
/**
 * settle#2 selftest — exercises the PURE intradayScan() of backend/board-discipline.pending-0930.js (extracted between its
 * <intradayScan> markers, with the file's own ratchetArmStep and the live RISK_POLICY) on synthetic bars. No I/O, no board, no ledger.
 *   node docs/audit-fixes/2026-09-30/settle/selftest-r5-intraday.cjs [path-to-board-discipline file]
 * Exit 0 = every case PASS; 1 = a case FAILED; 2 = could not run (UNKNOWN), as loud as a FAIL.
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const FILE = process.argv[2] || path.join(ROOT, "backend", "board-discipline.pending-0930.js");
let intradayScan;
try {
  const src = fs.readFileSync(FILE, "utf8");
  const scan = src.split("// <intradayScan>")[1]?.split("// </intradayScan>")[0];
  const ras = /const ratchetArmStep = \(favR, targetR, cls\) => \{[\s\S]*?\n\};/.exec(src)?.[0];
  if (!scan || !ras) throw new Error("markers or ratchetArmStep not found");
  const RP = require(path.join(ROOT, "backend", "lib", "risk-policy.js"));
  const etDate = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));
  intradayScan = new Function("RP", "etDate", `${ras}\n${scan.replace(/^[^\n]*\n/, "")}\nreturn intradayScan;`)(RP, etDate);
} catch (e) { console.error(`SELFTEST UNKNOWN — ${e.message}`); process.exit(2); }

const T0 = Date.parse("2026-10-02T14:00:00Z"), bar = (i, high, low) => ({ ts: T0 + i * 60000, high, low });
const crypto = { cls: "Crypto", dir: 1, entry: 100, stop: 90, target: 120 };
const cases = [
  ["crypto long reaches +1.1R -> harvest at +1R (110)", intradayScan([bar(0, 105, 99), bar(1, 111, 104)], crypto, "5m-intraday", 1, "2026-09-08"), (r) => r.reason === "harvest-r5" && r.px === 110],
  ["same bars, policy not acting -> unchanged (clean)", intradayScan([bar(0, 105, 99), bar(1, 111, 104)], crypto, "5m-intraday", null, null), (r) => r.clean === true],
  ["hold arm after a harvest: later bar takes the stop", intradayScan([bar(0, 111, 104), bar(1, 105, 89)], crypto, "5m-intraday", null, null), (r) => r.reason === "stop" && r.px === 90],
  ["stop and +1R on the same bar -> STOP wins", intradayScan([bar(0, 112, 89)], crypto, "5m-intraday", 1, "2026-09-08"), (r) => r.reason === "stop"],
  ["short crypto falls 1.2R -> harvest at 90", intradayScan([bar(0, 101, 95), bar(1, 99, 88)], { cls: "Crypto", dir: -1, entry: 100, stop: 110, target: 80 }, "5m-intraday", 1, "2026-09-08"), (r) => r.reason === "harvest-r5" && r.px === 90],
  ["harvestFrom after the bar date -> no harvest", intradayScan([bar(0, 111, 104)], crypto, "5m-intraday", 1, "2026-10-05"), (r) => r.clean === true],
  ["equity: prior trail floor checked BEFORE the harvest", intradayScan([bar(0, 100.5, 100.4), bar(1, 101.2, 100.2)], { cls: "Equity", dir: 1, entry: 100, stop: 99, target: 102 }, "1m-intraday", 1, "2026-09-08"), (r) => r.reason === "ratchet"],
  ["equity: clean run to +1R harvests at 101", intradayScan([bar(0, 100.5, 100.4), bar(1, 101.2, 100.45)], { cls: "Equity", dir: 1, entry: 100, stop: 99, target: 102 }, "1m-intraday", 1, "2026-09-08"), (r) => r.reason === "harvest-r5" && Math.abs(r.px - 101) < 1e-9],
];
let fail = 0;
for (const [name, got, ok] of cases) { const pass = !!ok(got); if (!pass) fail++; console.log(`${pass ? "PASS" : "FAIL"}  ${name}  -> ${JSON.stringify(got)}`); }
console.log(`ratchet policy in force: ${JSON.stringify(require(path.join(ROOT, "backend", "lib", "risk-policy.js")).RISK_POLICY.ratchet)}`);
console.log(fail ? `SELFTEST FAIL — ${fail} case(s)` : `SELFTEST PASS — ${cases.length} cases`);
process.exit(fail ? 1 : 0);
