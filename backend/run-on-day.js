#!/usr/bin/env node
/**
 * run-on-day.js — run a chain step only on given ET weekdays; otherwise exit 0 quietly.
 *   node backend/run-on-day.js Fri backend/best-ideas-forward.js [args...]
 * Lets a weekly writer live inside the nightly close chain without changing its cadence.
 */
const { spawnSync } = require("child_process"); const path = require("path");
const [days, script, ...rest] = process.argv.slice(2);
if (!days || !script) { console.error("usage: run-on-day.js <Mon,Tue,...> <script> [args]"); process.exit(1); }
const dow = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });
if (!days.split(",").map((d) => d.trim()).includes(dow)) { console.log(`[run-on-day] ${path.basename(script)} runs on ${days}; today is ${dow} — skipped`); process.exit(0); }
const r = spawnSync(process.execPath, [path.resolve(script), ...rest], { stdio: "inherit", cwd: path.resolve(__dirname, "..") });
process.exit(r.status == null ? 1 : r.status);
