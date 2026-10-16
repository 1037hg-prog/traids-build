#!/usr/bin/env node
"use strict";
/**
 * PAR (pause-aware package, 2026-10-12) — run several node commands AT THE SAME TIME and hand back what each printed. The selftest uses
 * it for the touched files' own selftests on today's text and on the patched text (twelve runs that do not depend on each other), so they
 * take the time of the longest one, not the sum. It starts only what the jobs file names; it writes nothing itself.
 *
 *   node harness/par.cjs <jobs.json>      jobs = [{ id, args: [script, ...], env: { NAME: value, ... }, cwd }]
 *   -> one line: "@@PAR " + JSON [{ id, status, stdout, stderr, seconds }]
 */
const fs = require("fs"), cp = require("child_process");
const jobs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
Promise.all(jobs.map((j) => new Promise((done) => {
  const t0 = Date.now(), out = [], err = [];
  let c; try { c = cp.spawn(process.execPath, j.args, { env: { ...process.env, ...(j.env || {}) }, cwd: j.cwd || process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { return done({ id: j.id, status: null, stdout: "", stderr: String(e && e.message), seconds: 0 }); }
  c.stdout.on("data", (d) => out.push(d)); c.stderr.on("data", (d) => err.push(d));
  const kill = setTimeout(() => { try { c.kill(); } catch {} }, j.timeoutMs || 900000);
  c.on("error", (e) => { clearTimeout(kill); done({ id: j.id, status: null, stdout: Buffer.concat(out).toString("utf8"), stderr: String(e && e.message), seconds: (Date.now() - t0) / 1000 }); });
  c.on("close", (code) => { clearTimeout(kill); done({ id: j.id, status: code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), seconds: (Date.now() - t0) / 1000 }); });
}))).then((res) => { process.stdout.write("@@PAR " + JSON.stringify(res) + "\n"); });
