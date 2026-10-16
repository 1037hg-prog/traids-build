#!/usr/bin/env node
/**
 * W6 TABLE — the agent jobs as server units, read from ONE place: automation/agent-jobs.json. 2026-10-11 (docs/server/wave6-agents).
 * A job that carries `server: { calendar, tz }` is a unit "w6-<job>" (the name the ownership map and the job's own `unit` field use).
 * Everything the package generates (unit files, manifests) and everything deploy.cjs / rollback.cjs name comes from this table.
 *
 *   node docs/server/wave6-agents/w6.cjs            the table, printed
 *   node docs/server/wave6-agents/w6.cjs --selftest
 */
"use strict";
const fs = require("fs"), path = require("path");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", "..");
const AJ = require(path.join(REPO, "automation", "agent-job.cjs"));

const TREE = "/home/traids/traids", RB = TREE + "/backend", RA = TREE + "/automation", RD = RB + "/data", SYSD = "/etc/systemd/system", ENV_DIR = "/etc/traids", ENV_NAME = "w6-agents", ENV_FILE = `${ENV_DIR}/${ENV_NAME}.env`;
const NODE = "/usr/local/bin/node", FLOCK = "/usr/bin/flock", HOST = "traids";
const TZS = ["America/Denver", "America/New_York"];
const CAL_OK = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:(?:\.\.|,)(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))* )?(?:\*-\*-\* )?\d{2}:\d{2}:\d{2}$/;

/** the units of a jobs document: { "w6-<job>": { unit, job, title, calendar, tz, timeoutMin, lock, output, status, real: {service, timer}, shadow: {service, timer} } } */
function unitsOf(doc) {
  const out = {};
  for (const [job, j] of Object.entries((doc && doc.jobs) || {})) {
    if (!j.server) continue;
    const s = j.server, unit = "w6-" + job;
    if (j.unit !== unit) throw new Error(`job ${job}: unit is ${JSON.stringify(j.unit)}, want ${unit}`);
    if (typeof s.calendar !== "string" || !CAL_OK.test(s.calendar)) throw new Error(`job ${job}: server.calendar ${JSON.stringify(s.calendar)} is not "<days> HH:MM:SS" (e.g. "Mon..Fri 18:45:00")`);
    if (!TZS.includes(s.tz)) throw new Error(`job ${job}: server.tz must be one of ${TZS.join(" | ")}`);
    out[unit] = { unit, job, title: j.title, calendar: s.calendar, tz: s.tz, why: s.why || "", timeoutMin: (j.timeoutMin || 20) + 10, lock: `${unit}.flock`,
      output: j.output.replace(/^backend\/data\//, ""), status: `agent-jobs/${job}.status.json`,
      real: { service: `traids-w6-${job}.service`, timer: `traids-w6-${job}.timer` }, shadow: { service: `traids-w6s-${job}.service`, timer: `traids-w6s-${job}.timer` } };
  }
  return out;
}
const loadDoc = (repo = REPO) => AJ.loadJobs(path.join(repo, ...AJ.JOBS_REL.split("/")));
const DOC = loadDoc(), UNITS = unitsOf(DOC), UNIT_IDS = Object.keys(UNITS);

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d !== undefined ? " — " + String(typeof d === "string" ? d : JSON.stringify(d)).slice(0, 400) : "")); } };
  const err = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const J = (server, over = {}) => ({ jobs: { "lens-x": { unit: "w6-lens-x", title: "T", output: "backend/data/agent-jobs/lens-x.json", timeoutMin: 20, server, ...over } } });
  const u = unitsOf(J({ calendar: "Mon..Fri 18:45:00", tz: "America/Denver" }))["w6-lens-x"];
  ok("a job with a server block is the unit w6-<job>: its lock, its output and status files (relative to backend/data), its four unit file names, its timeout plus 10 minutes", u && u.lock === "w6-lens-x.flock" && u.output === "agent-jobs/lens-x.json" && u.status === "agent-jobs/lens-x.status.json" && u.real.service === "traids-w6-lens-x.service" && u.real.timer === "traids-w6-lens-x.timer" && u.shadow.service === "traids-w6s-lens-x.service" && u.shadow.timer === "traids-w6s-lens-x.timer" && u.timeoutMin === 30, u);
  ok("a job without a server block is not a unit (it stays a home job)", Object.keys(unitsOf(J(undefined))).length === 0);
  ok("a calendar is \"<days> HH:MM:SS\" only: day lists and ranges pass; a free-form string, a missing time, a shell character are refused", ["Mon..Fri 18:45:00", "Mon,Wed,Fri 18:10:00", "Sun 05:00:00", "*-*-* 03:30:00", "Mon..Fri *-*-* 03:30:00", "06:15:00"].every((c) => CAL_OK.test(c)) && ["Mon..Fri", "daily", "Mon..Fri 18:45", "Mon..Fri 18:45:00; rm -rf /", "Mon..Fri 18:45:00 America/Denver", ""].every((c) => !CAL_OK.test(c)));
  ok("a bad calendar, an unknown time zone and a unit name that is not w6-<job> are each refused by name", /server\.calendar/.test(err(() => unitsOf(J({ calendar: "nightly", tz: "America/Denver" }))) || "") && /server\.tz/.test(err(() => unitsOf(J({ calendar: "Mon..Fri 18:45:00", tz: "UTC" }))) || "") && /want w6-lens-x/.test(err(() => unitsOf(J({ calendar: "Mon..Fri 18:45:00", tz: "America/Denver" }, { unit: "w6-other" }))) || ""));
  ok(`the real jobs file gives ${UNIT_IDS.length} unit(s): ${UNIT_IDS.join(", ")} — each named w6-<job>, each job passing agent-job.cjs's own rules`, UNIT_IDS.length >= 2 && UNIT_IDS.every((x) => /^w6-[a-z0-9-]+$/.test(x) && UNITS[x].job === x.slice(3)) && AJ.checkJobs(DOC).length === 0, AJ.checkJobs(DOC));
  ok("paths: the real tree /home/traids/traids, the env file /etc/traids/w6-agents.env, node and flock by absolute path", TREE === "/home/traids/traids" && ENV_FILE === "/etc/traids/w6-agents.env" && NODE === "/usr/local/bin/node" && FLOCK === "/usr/bin/flock" && RD === "/home/traids/traids/backend/data");
  console.log(`w6 table selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}
if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.length === 1 && a[0] === "--selftest") process.exitCode = selftest() ? 0 : 1;
  else if (!a.length) { for (const u of Object.values(UNITS)) console.log(`${u.unit.padEnd(24)} ${u.calendar} ${u.tz}   ${u.real.service} / ${u.shadow.service}   -> backend/data/${u.output}`); process.exitCode = 0; }
  else { console.log("usage: node w6.cjs [--selftest]"); process.exitCode = 2; }
}
module.exports = { unitsOf, loadDoc, DOC, UNITS, UNIT_IDS, TREE, RB, RA, RD, SYSD, ENV_DIR, ENV_NAME, ENV_FILE, NODE, FLOCK, HOST, TZS, CAL_OK, REPO, HERE, AJ };
