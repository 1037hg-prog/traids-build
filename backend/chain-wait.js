#!/usr/bin/env node
/**
 * chain-wait.js — block until today's close chain has recorded a finish, or a deadline passes.
 *
 * 2026-09-08. The nightly progress email moved to its own 18:00 MT task (automation/progress-email.bat) and reports what the
 * close chain wrote. The chain starts at 14:15 MT and its finish time moves: on 2026-09-08 it ran 3h37m and finished at 17:52 MT,
 * eight minutes before 18:00, because two steps burned their timeouts. So the email waits on the DATA, not on the clock.
 *
 *   node backend/chain-wait.js [--deadline HH:MM] [--poll 300]
 *     exit 0 — data/chain-status.json carries a finish stamped today (ET session date)
 *     exit 1 — the deadline passed first; the caller should proceed and disclose
 *
 * It never starts anything. It only reads chain-status.json, which close-chain.cjs writes.
 */
const fs = require("fs"), path = require("path");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DEADLINE = String(arg("--deadline", "19:30")).slice(0, 5);
const POLL = Math.max(30, parseInt(arg("--poll", "300"), 10) || 300) * 1000;
const F = path.join(__dirname, "data", "chain-status.json");
const etNow = () => new Intl.DateTimeFormat("en-GB", { timeZone: "America/Denver", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
const mtDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date());

const finishedToday = () => {
  let j; try { j = JSON.parse(fs.readFileSync(F, "utf8")); } catch { return null; }
  if (!j.finished) return null;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date(j.finished));
  return day === mtDay() ? j : null;
};

(async () => {
  const started = Date.now();
  for (;;) {
    const j = finishedToday();
    if (j) {
      const mins = ((Date.parse(j.finished) - Date.parse(j.started)) / 60000).toFixed(0);
      console.log(`chain-wait: today's chain finished ${j.finished} (${mins} min, ${(j.failed || []).length} failed step(s)) — proceeding after ${((Date.now() - started) / 60000).toFixed(0)} min of waiting`);
      process.exit(0);
    }
    if (etNow() >= DEADLINE) {
      console.log(`chain-wait: ${DEADLINE} MT deadline passed with no finish recorded for ${mtDay()} — proceeding without it`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, POLL));
  }
})();
