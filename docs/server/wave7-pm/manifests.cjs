#!/usr/bin/env node
/**
 * MANIFEST — what the standing home pull (deploy/server/pull-server.cjs, pull-manifest-v1) brings home for W7, R352's recorder.
 * 2026-10-11 (docs/server/wave7-pm). Generated here because JSON is only ever written by node through backend/lib/atomic-write.js.
 * deploy.cjs's units step installs it as deploy/server/manifests/w7-pm.json, where pull-server.cjs reads it:
 *
 *   node docs/server/wave7-pm/manifests.cjs --write     (re)write manifests/w7-pm.json
 *   node docs/server/wave7-pm/manifests.cjs --check     exit 0 when the file equals what this file generates and pull-server accepts it
 *   node deploy/server/pull-server.cjs --wave w7-pm     the pull itself (after the units step; one ssh, a few kB)
 *
 * THE DECISION: A SUMMARY COMES HOME WITH EVERY PULL; THE DAY ARCHIVES ARE FETCHED ON DEMAND (fetch-day.cjs). Why not the archives:
 *   - the pull carries JSON only (its four kinds are json, jsonl-prefix, jsonl-rewritten and dir-of-json, each parsed and checked
 *     against home's copy); a .gz archive is none of them, and pull-server.cjs is shared machinery this package does not change;
 *   - a directory entry is sent WHOLE on every pull (one tar of every file that matches), held in memory on both sides, inside a
 *     close-chain step that is killed after 5 minutes. A recorded day is about 1.1 GiB after gzip (disk-estimate.cjs, measured): one
 *     day alone would pass the pull's 512 MB buffer, and by day 30 every hourly pull would be asked to move about 34 GiB;
 *   - what home needs every day is small: did the day qualify, which windows were not captured and why, is the recorder alive, how
 *     full is its disk. That is the per-day summary (rows, gaps, archive hashes, COVERAGE as R352 rule[11] defines it — never a
 *     result) and the recorder's status file: about 17 kB a day (measured in NOTES.md, "The pull").
 *   The archives stay on the server, each verified by sha256 when it was made (ARCHIVES.json beside it; the same hashes are in the
 *   summary that came home). fetch-day.cjs brings one day's archives when someone needs them, one file per ssh call, and accepts a
 *   file only when its sha256 is the one in the pulled summary and it unpacks to the plain file's sha256.
 *
 * w7-pm   ONE long-running process (traids-pm-book.service), so lock null: there is no run to wait out. Every pulled file is written
 *         by an atomic rename on the server (writeJsonAtomic), so a pull never reads half a file.
 *   pm-book/summary   one <UTC date>.json per day (dir-of-json). frozenWhen "final": once home holds a FINAL summary the server's copy
 *                     must stay byte-equal (the recorder never rewrites a final summary); a summary home holds is never missing on
 *                     the server (retention removes archives only, never a summary).
 *   pm-book/status.json   the recorder's own status as of the pull (feeds, rows today, disk, any block). At home
 *                     `node backend/pm-book-recorder.js --status` reads it and says it is a pulled copy.
 *   pm-book/live.json     written ONCE by deploy.cjs's units step when the unit first went live (liveAt, server clock). frozenOnceSet
 *                     liveAt: a different liveAt on the server is refused by the pull, never taken.
 *   seed false everywhere: nothing is ever pushed from home to this unit (there is no home version of it).
 * steps: []  no close-chain step runs or skips this unit, so own.cjs's chain-tag check has nothing to require for it.
 * fixedOwner "server": THE SHARED MOVER REFUSES THIS UNIT (deploy/server/own.cjs: "has a fixed owner — own.cjs never moves it"), in
 *         both directions. There is nothing to move: no home version, no seed, no shadow. Before this line its `own.cjs w7-pm home`
 *         went through — the maps said home, the recorder (whose gate is read only at a start) kept recording, and the same map made
 *         the health check, the nightly compress and the pull skip themselves (the review of 2026-10-12). The unit's entry in the
 *         map is written ONLY by this package: deploy.cjs's units step ("server") and rollback.cjs --server ("home"), which edit the
 *         map themselves and are not affected. The pull reads it as before: the map's entry decides (server -> pulled, home -> "not
 *         pulled"); only where the map does not name the unit at all (a units step cut short after it installed this file) does
 *         the pull now take the fixed owner and look on the server, where it finds nothing or the unit's own three small files.
 */
"use strict";
const fs = require("fs"), path = require("path");

const DATA = "/home/traids/traids/backend/data", BACKEND = "/home/traids/traids/backend";
const W7 = {
  schema: "pull-manifest-v1", wave: "w7-pm", title: "W7 prediction-market book recorder for R352 (pm-book-recorder.js, one long-running service): per-day summaries and status only — the day archives are fetched on demand",
  remoteData: DATA, remoteBackend: BACKEND,
  units: {
    "w7-pm": {
      lock: null, steps: [], longRunning: true, serverOnly: true, fixedOwner: "server",
      systemd: { service: "traids-pm-book.service", timer: "traids-pm-health.timer" },
      cadenceHours: 24,
      code: ["pm-book-recorder.js", "lib/pm-feeds.js", "lib/atomic-write.js", "own-check.cjs"],
      entries: [
        { path: "pm-book/summary", kind: "dir-of-json", glob: "*.json", pattern: "^\\d{4}-\\d{2}-\\d{2}\\.json$", frozenWhen: "final", seed: false },
        { path: "pm-book/status.json", kind: "json", seed: false },
        { path: "pm-book/live.json", kind: "json", frozenOnceSet: ["liveAt"], seed: false },
      ],
    },
  },
};
const ALL = { "w7-pm": W7 };

/** [] when every staged manifest equals its generator and pull-server.cjs loads it; else what is wrong */
function issues(dir = path.join(__dirname, "manifests")) {
  const bad = [], PS = require(path.resolve(__dirname, "..", "..", "..", "deploy", "server", "pull-server.cjs"));
  for (const [k, v] of Object.entries(ALL)) {
    let cur = null; try { cur = JSON.parse(fs.readFileSync(path.join(dir, k + ".json"), "utf8")); } catch { cur = null; }
    if (!cur || JSON.stringify(cur) !== JSON.stringify(v)) { bad.push(`manifests/${k}.json is not what manifests.cjs generates`); continue; }
    try { PS.loadManifest(k, dir); } catch (e) { bad.push(`pull-server refuses manifests/${k}.json: ${e.message}`); }
    // every unit of this package is server-only: the shared mover must refuse it (it does so on a fixed owner, and on nothing else)
    for (const [u, def] of Object.entries(v.units)) if (def.fixedOwner !== "server") bad.push(`manifests/${k}.json: ${u} has no fixedOwner "server" — deploy/server/own.cjs would move a unit that has no home version`);
  }
  return bad;
}

if (require.main === module) {
  const a = process.argv.slice(2), dir = path.join(__dirname, "manifests");
  if (a.length === 1 && a[0] === "--write") {
    const { writeJsonAtomic } = require(path.resolve(__dirname, "..", "..", "..", "backend", "lib", "atomic-write.js"));
    fs.mkdirSync(dir, { recursive: true });
    for (const [k, v] of Object.entries(ALL)) { writeJsonAtomic(path.join(dir, k + ".json"), v); console.log("written manifests/" + k + ".json"); }
    process.exitCode = 0;
  } else if (a.length === 1 && a[0] === "--check") {
    const bad = issues();
    for (const k of Object.keys(ALL)) console.log(`  ${bad.some((b) => b.includes(`manifests/${k}.json`)) ? "DIFF" : "ok  "} manifests/${k}.json`);
    for (const b of bad) console.log("  FAIL " + b);
    if (!bad.length) console.log("  ok   pull-server.cjs loads the manifest: JSON entries only, no archive, no lock, nothing seeded from home");
    if (!bad.length) console.log("  ok   the unit has a fixed owner (\"server\"): the shared mover, deploy/server/own.cjs, refuses to move it either way");
    console.log(`manifests check: ${bad.length ? bad.length + " problem(s)" : "0 failed"}`);
    process.exitCode = bad.length ? 1 : 0;
  } else { console.log("usage: node manifests.cjs --write | --check"); process.exitCode = 2; }
}
module.exports = { ALL, W7, issues };
