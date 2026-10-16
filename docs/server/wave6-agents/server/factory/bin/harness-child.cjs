#!/usr/bin/env node
/**
 * HARNESS CHILD — the one process in which builder-written signal code ever runs. 2026-10-09 (docs/server/wave6-agents).
 * Started only by fcode.cjs (runHarness), always under Node's permission model:
 *   node --permission --allow-fs-read=<factory/lib> --allow-fs-read=<this file> --allow-fs-read=<job> --allow-fs-read=<signal>
 *        [--allow-fs-read=<dataset dir>] harness-child.cjs <job.json>
 * so it can write NO file, start NO process or worker, and read only the harness, the job, the frozen signal and (controls / read
 * only) the dataset. The result is ONE JSON line on stdout; fcode.cjs (plain code, user traids) is the only writer of state.
 * job = { mode: "check" | "controls" | "read", signalPath, reg, dataDir, maxMs }
 */
"use strict";
const fs = require("fs"), path = require("path");
const H = require(path.join(__dirname, "..", "lib", "harness.cjs"));
function main(jobFile) {
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8")), src = fs.readFileSync(job.signalPath, "utf8");
  if (job.mode === "check") return H.checkSignal(src, job.synthetic || {});
  const sig = H.compileSignal(src, path.basename(job.signalPath)), P = H.loadFor(job.reg, job.dataDir, sig.meta.lookbackDays);
  if (job.mode === "controls") return { signalSha: sig.sha, panel: { dataset: P.dataset, S: P.S, D: P.D, from: P.dates[0], to: P.dates[P.D - 1] }, ...H.controls(P, sig, job.reg, { maxMs: job.maxMs }) };
  if (job.mode === "read") return { signalSha: sig.sha, panel: { dataset: P.dataset, S: P.S, D: P.D, from: P.dates[0], to: P.dates[P.D - 1] }, ...H.read(P, sig, job.reg) };
  throw new Error("unknown mode " + job.mode);
}
if (require.main === module) {
  let out;
  try { out = { ok: true, result: main(process.argv[2]) }; }
  catch (e) { out = { ok: false, error: String(e && e.message || e).slice(0, 600), lookAhead: !!(e && e.name === "LookAheadError"), permission: !!(e && e.code === "ERR_ACCESS_DENIED") }; }
  process.stdout.write(JSON.stringify(out) + "\n");
}
module.exports = { main };
