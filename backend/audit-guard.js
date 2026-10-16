#!/usr/bin/env node
/**
 * audit-guard.js — may the nightly audit run right now? Prints JSON and exits 0 (run) or 2 (do not run).
 * Rule (operator): nothing runs on Saturday; Sunday evening is still ALLOWED here for a hand-run, but no task fires on Sunday
 * since 2026-09-12 (weekend silence - the all-lens review moved to Friday); otherwise trading days
 * after the close chain. Market holidays come from lib/run-window.js. ET calendar, not the machine clock.
 *   node backend/audit-guard.js            → {"run":true|false,"why":...,"etDate":...,"since":...}
 */
const { marketHoliday } = require("./lib/run-window.js");
const et = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const dow = (d) => new Date(d).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });
const hourET = (d) => +new Date(d).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).slice(0, 2);
const isTradingDay = (ms) => !["Sat", "Sun"].includes(dow(ms)) && !marketHoliday(et(ms));
const now = Date.now(), today = et(now), d = dow(now);
let run = false, why = "";
if (d === "Sat") why = "Saturday — nothing runs (operator rule)";
else if (d === "Sun") { const mon = now + 86400e3; run = isTradingDay(mon) && hourET(now) >= 16; why = run ? "Sunday evening before a trading Monday" : (isTradingDay(mon) ? "Sunday, but before 16:00 ET — wait for the evening" : "Sunday before a holiday Monday — nothing to prepare for"); }
else if (!isTradingDay(now)) why = `market holiday ${today} (${marketHoliday(today)})`;
else if (hourET(now) < 16) { why = "trading day but before 16:00 ET — the close chain has not run"; }
else { run = true; why = "trading day after the close"; }
// since: the previous trading day (so a Sunday run covers Friday and a Tuesday run covers Monday's holiday too)
let back = now - 86400e3; while (!isTradingDay(back)) back -= 86400e3;
const out = { run, why, etDate: today, since: et(back), forcedBy: process.argv.includes("--force") ? "operator --force" : null };
if (out.forcedBy) out.run = true;

/**
 * ONE AUDIT PER NIGHT, MECHANICALLY (2026-09-10). Three headless launches in one evening each stopped their own workflow
 * after scanning for "another audit" and finding one: the previous launch still exiting, then their OWN process. The
 * guard is now the single arbiter of that rule, and the instance running it must never scan processes:
 *   - tonight's findings file exists           -> exit 2 "already recorded tonight"
 *   - a live claim exists (< 3h, same etDate)  -> exit 2 "an audit claimed tonight at ..."; --force overrides
 *   - otherwise the guard WRITES the claim and exits 0 — this call IS the claim; the caller is tonight's audit.
 * --release clears the claim (operator, or the launcher after a run dies without a findings file).
 */
const path = require("path"), fsx = require("fs");
const LOCK = path.join(__dirname, "data", "audit-nightly.lock.json");
const FINDINGS = path.join(__dirname, "data", "audit-nightly", today + ".json");
// --check: evaluate the calendar and the claim WITHOUT claiming — for the launcher (evening.bat) whose pre-check must not consume the
// night before the instance runs the guard itself at step 0.
const CHECK = process.argv.includes("--check");
if (process.argv.includes("--release")) { try { fsx.unlinkSync(LOCK); } catch {} console.log(JSON.stringify({ released: true, etDate: today })); process.exit(0); }
if (out.run) {
  let lock = null; try { lock = JSON.parse(fsx.readFileSync(LOCK, "utf8")); } catch {}
  const live = lock && lock.etDate === today && (Date.now() - Date.parse(lock.claimedAt)) < 3 * 3600e3;
  if (fsx.existsSync(FINDINGS)) { out.run = false; out.why = "already recorded tonight: " + FINDINGS + " exists"; }
  else if (live && !out.forcedBy) { out.run = false; out.why = "an audit claimed tonight at " + lock.claimedAt + " (" + lock.by + "); one audit per night — do not scan for it, do not start another; --release if it died"; }
  else if (CHECK) { out.claimed = false; out.note = "--check: not claimed"; }
  else { fsx.writeFileSync(LOCK, JSON.stringify({ etDate: today, claimedAt: new Date().toISOString(), by: process.argv.includes("--force") ? "operator --force" : "audit-guard", pid: process.pid })); out.claimed = true; }
}
console.log(JSON.stringify(out));
process.exit(out.run ? 0 : 2);
