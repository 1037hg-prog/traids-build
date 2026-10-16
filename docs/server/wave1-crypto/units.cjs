#!/usr/bin/env node
/**
 * UNITS — the W1 SHADOW units are derived mechanically from the real ones, so the two can never drift. 2026-10-07.
 *
 *   node docs/server/wave1-crypto/units.cjs --write    (re)write systemd/traids-w1s-*.{service,timer} from systemd/traids-w1-*
 *   node docs/server/wave1-crypto/units.cjs --check    exit 0 when the shadow files equal what shadowOf() makes
 *
 * A shadow unit (the dry nights 10-08 / 10-09) differs from its real unit in exactly these lines:
 *   WorkingDirectory / the flock file / the w1-run.cjs path -> the shadow tree /home/traids/w1-shadow/backend (its scripts are the same
 *     bytes; they resolve data as __dirname/data, so they write /home/traids/w1-shadow/backend/data — nothing pulled, nothing counted)
 *   ExecCondition ... own-check.cjs <unit> home; ...   (the same /bin/sh wrapper; runs only while HOME still owns the unit: it shadows home, and stops by itself at
 *     the cutover, with no edit; the real tree's own-check.cjs and map are read)
 *   SyslogIdentifier traids-w1s-<x> · Description / header "SHADOW" · the timer's Unit=.
 */
"use strict";
const fs = require("fs"), path = require("path");
const SD = path.join(__dirname, "systemd"), REAL_B = "/home/traids/traids/backend", SHADOW_B = "/home/traids/w1-shadow/backend";
const NAMES = ["whales", "funding", "social"];

function shadowOf(text, kind, x) {
  const lines = text.split("\n"), out = [];
  let header = true;
  for (const l of lines) {
    if (header && l.startsWith("#")) continue;                                // the real header is replaced below
    header = false;
    let m = l;
    if (/^Description=/.test(m)) m = m.replace(/^Description=TRAIDS W1 /, "Description=TRAIDS W1 SHADOW ").replace(/\(runs only while server-owned\)/, "(dry nights; runs only while home-owned)");
    if (/^WorkingDirectory=/.test(m)) m = `WorkingDirectory=${SHADOW_B}`;
    if (/^ExecCondition=/.test(m)) { const n = m.replace(/(own-check\.cjs w1-[a-z]+) server;/, "$1 home;"); if (n === m) throw new Error(`units.cjs: the ExecCondition of traids-w1-${x}.${kind} has no "own-check.cjs w1-<x> server;" to turn into "home"`); m = n; }
    if (/^ExecStart=/.test(m)) m = m.split(`${REAL_B}/data/`).join(`${SHADOW_B}/data/`).split(`${REAL_B}/w1-run.cjs`).join(`${SHADOW_B}/w1-run.cjs`);
    if (/^SyslogIdentifier=/.test(m)) m = `SyslogIdentifier=traids-w1s-${x}`;
    if (/^Unit=/.test(m)) m = `Unit=traids-w1s-${x}.service`;
    out.push(m);
  }
  const head = kind === "service"
    ? [`# TRAIDS W1 SHADOW (dry nights 2026-10-08 / 10-09, docs/server/wave1-crypto) — derived by units.cjs from traids-w1-${x}.service.`,
      `# Same scripts (same bytes) from the shadow tree ${SHADOW_B}; they write ${SHADOW_B}/data only, which is never pulled`,
      `# or counted; compare-w1.cjs compares it with home's same-night files. ExecCondition "home": it runs only while home still owns the`,
      `# unit, so it stops by itself at the cutover (own.cjs w1 server). OnFailure stays on: a failing shadow pages, which is the point.`]
    : [`# TRAIDS W1 SHADOW timer — derived by units.cjs from traids-w1-${x}.timer: the same calendar as the real unit.`];
  return [...head, ...out].join("\n");
}
function expected() {
  const m = {};
  for (const x of NAMES) for (const kind of ["service", "timer"]) m[`traids-w1s-${x}.${kind}`] = shadowOf(fs.readFileSync(path.join(SD, `traids-w1-${x}.${kind}`), "utf8"), kind, x);
  return m;
}
const ALL_UNITS = NAMES.flatMap((x) => [`traids-w1-${x}.service`, `traids-w1-${x}.timer`, `traids-w1s-${x}.service`, `traids-w1s-${x}.timer`]);

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes("--write")) { for (const [f, t] of Object.entries(expected())) { fs.writeFileSync(path.join(SD, f), t); console.log("written systemd/" + f); } process.exitCode = 0; }
  else if (a.includes("--check")) { let bad = 0; for (const [f, t] of Object.entries(expected())) { let cur = null; try { cur = fs.readFileSync(path.join(SD, f), "utf8"); } catch { cur = null; } const ok = cur === t; if (!ok) bad++; console.log(`${ok ? "ok  " : "DIFF"} systemd/${f}`); } process.exitCode = bad ? 1 : 0; }
  else { console.log("usage: node units.cjs --write | --check"); process.exitCode = 2; }
}
module.exports = { shadowOf, expected, NAMES, ALL_UNITS, REAL_B, SHADOW_B };
