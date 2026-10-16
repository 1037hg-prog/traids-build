#!/usr/bin/env node
"use strict";
/**
 * AI-BUBBLE LADDER MONITOR (2026-10-16) — ROLLBACK: put the two files back to what they were before the apply, which
 * is NOT THERE. This package creates files that do not exist at home, so base/ holds nothing and the rollback is to
 * remove them. Byte-exact in this package's sense means: afterwards neither file exists, exactly as before.
 *
 *   node docs/ai-bubble-ladder-monitor/2026-10-16/rollback.cjs --plan     READ-ONLY: what would be removed
 *   node docs/ai-bubble-ladder-monitor/2026-10-16/rollback.cjs --apply    the write mode (the same fences as deploy)
 *
 * A file that is there but is NOT the staged bytes is DRIFT: someone changed it after the apply. The rollback then
 * refuses the whole unit and removes nothing — it never deletes a file it does not recognise. Read the change first.
 *
 * WHAT IT DOES NOT UNDO. backend/data/ai-bubble-ladder-status.json — the dated readings the monitor wrote with
 * --write — is the operator's own record and is LEFT WHERE IT IS. Nothing else was ever written by this package: no
 * registry row (record.cjs writes that, and is undone by hand), no switch, no chain entry, nothing on the server, and
 * no order of any kind at any time.
 *
 * Exit 0 both files gone / nothing to do · 1 a file could not be removed · 2 refused or usage.
 */
const D = require("./deploy.cjs");

const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
if (!MODE) {
  console.log(`usage: node ${D.PKG_REL}/rollback.cjs --plan | --apply
  --plan   read-only: each file's state and what would be removed
  --apply  the write mode: removes the two files this package created (refused on DRIFT, 13:50-15:50 MT on a trading
           weekday, while a process of the unit or the close chain is running, or if the process list cannot be read)
Nothing was done.`);
  process.exit(2);
}

const P = D.plan();
if (MODE === "--plan") {
  let fz; try { fz = D.fences(); } catch (e) { fz = [`the fences could not be read (${e.message})`]; }
  D.printPlan(P, fz, { title: "ROLLBACK" });
  console.log(`  rollback: ${P.files.some((x) => x.state === "DRIFT") ? "REFUSED — a file is DRIFT (it is not the bytes this package wrote): read the change first" : P.created.length ? `would remove ${P.created.map((x) => x.rel).join(", ")} (their base is "not there")` : "nothing to remove"}`);
  console.log(`  ${D.DATA_REL} would be LEFT AS IT IS — the monitor's own record is not part of this package.`);
  process.exit(0);
}

console.log(`ROLLBACK — AI-bubble ladder monitor — ${D.mtWords(Date.now())}`);
const r = D.make().rollback();
if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
if (r.result === "noop") { console.log("nothing to roll back: neither file is there."); process.exit(0); }
if (r.result === "failed") { console.error(`ROLLBACK FAILED: ${r.why.join("; ")}${r.removed.length ? `\n  already removed: ${r.removed.join(", ")}` : ""}`); process.exit(1); }
const left = D.plan().files.filter((x) => x.state !== "absent");
if (left.length) { console.error(`ROLLED BACK, but ${left.map((x) => x.rel).join(", ")} is still there — inspect it.`); process.exit(1); }
console.log(`\nROLLED BACK: ${r.removed.join(", ")} removed; neither file exists, exactly as before the apply.`);
console.log(`  Nothing to restart. ${D.DATA_REL} is where it was (remove it by hand if you want the readings gone too).`);
console.log(`  If record.cjs wrote its registry row, that row is still on record — it is undone by hand, not by this script.`);
process.exit(0);
