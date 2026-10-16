#!/usr/bin/env node
/**
 * MANIFESTS — one pull manifest per W6 unit (wave id = unit id, as W3 does it), generated from w6.cjs. 2026-10-11
 * (docs/server/wave6-agents). The format is deploy/server/pull-server.cjs's own (pull-manifest-v1): once a job is server-owned, home
 * pulls its output and its status file with `node deploy/server/pull-server.cjs --wave w6-<job>`, and deploy/server/own.cjs reads the
 * same manifest to move the unit (its systemd names, its lock, the code whose parity it checks).
 *
 *   node docs/server/wave6-agents/manifests.cjs --write    (re)write manifests/w6-*.json (through backend/lib/atomic-write.js)
 *   node docs/server/wave6-agents/manifests.cjs --check    exit 0 when every file equals its generator, no stray file, and
 *                                                          pull-server.cjs's own loader accepts each one
 * What a manifest lists:
 *   entries   the job's OUTPUT and STATUS files under backend/data/agent-jobs/ (kind json; never seeded: the server writes them, home
 *             only reads them). A job writes nothing else on the server.
 *   code      the backend files own.cjs compares before a cutover: lib/agent-cli.js, lib/atomic-write.js, own-check.cjs. The files under
 *             automation/ (agent-job.cjs, the server jobs view, the screened instructions) are compared by deploy.cjs --cutover itself.
 *   steps     none: no close-chain step runs an agent job at home (nothing calls agent-job.cjs yet).
 */
"use strict";
const fs = require("fs"), path = require("path");
const W = require("./w6.cjs");
const PS = require(path.join(W.REPO, "deploy", "server", "pull-server.cjs"));
const MD = path.join(__dirname, "manifests");
const CODE = ["lib/agent-cli.js", "lib/atomic-write.js", "own-check.cjs"];

function manifestOf(u) {
  return {
    schema: "pull-manifest-v1", wave: u.unit, title: `W6 agent job ${u.job} (automation/agent-job.cjs; any model, or none)`,
    remoteData: W.RD, remoteBackend: W.RB,
    units: { [u.unit]: {
      lock: u.lock, steps: [], group: "agents",
      systemd: { service: u.real.service, timer: u.real.timer, shadowService: u.shadow.service, shadowTimer: u.shadow.timer },
      services: [u.real.service], cadenceHours: 24 * 7,
      code: CODE,
      entries: [{ path: u.output, kind: "json", seed: false }, { path: u.status, kind: "json", seed: false }],
    } },
  };
}
const ALL = Object.fromEntries(Object.values(W.UNITS).map((u) => [u.unit, manifestOf(u)]));
const WAVES = Object.keys(ALL).join(",");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function check(log = console.log) {
  let bad = 0;
  for (const [k, v] of Object.entries(ALL)) {
    let cur = null; try { cur = JSON.parse(fs.readFileSync(path.join(MD, k + ".json"), "utf8")); } catch { cur = null; }
    if (cur && same(cur, v)) log(`ok   manifests/${k}.json`); else { bad++; log(`DIFF manifests/${k}.json`); }
    try { const m = PS.loadManifest(k, MD), d = m.units[k]; if (PS.pullEntries(d).length !== 2 || PS.seedEntries(d).length !== 0 || PS.inputEntries(d).length !== 0) throw new Error("it must pull exactly its output and its status file, seed nothing, push no input"); log(`ok   pull-server.cjs accepts manifests/${k}.json (2 pulled files, nothing seeded, no input)`); }
    catch (e) { bad++; log(`DIFF pull-server.cjs refuses manifests/${k}.json: ${e.message}`); }
  }
  for (const f of fs.existsSync(MD) ? fs.readdirSync(MD) : []) if (!(f.replace(/\.json$/, "") in ALL)) { bad++; log(`DIFF manifests/${f} (not generated)`); }
  // KNOWN ANSWERS on the generator: what a manifest must and must never name
  const all = Object.values(ALL), ents = all.flatMap((m) => Object.values(m.units).flatMap((d) => d.entries.map((e) => e.path)));
  if (all.length === W.UNIT_IDS.length && all.every((m) => Object.keys(m.units).length === 1 && Object.keys(m.units)[0] === m.wave && m.remoteData === "/home/traids/traids/backend/data") && ents.every((p) => /^agent-jobs\/[a-z0-9-]+(\.status)?\.json$/.test(p)) && new Set(ents).size === ents.length)
    log(`ok   ${all.length} manifest(s), one unit each (wave id = unit id); every entry is a job's own output or status file under agent-jobs/, none shared`);
  else { bad++; log("DIFF a manifest names something other than its own output / status file under agent-jobs/"); }
  const refused = (m) => { try { PS.checkManifest(JSON.parse(JSON.stringify(m)), m.wave); return false; } catch { return true; } }, first = all[0];
  const withEntry = (p) => ({ ...first, units: { [first.wave]: { ...first.units[first.wave], entries: [{ path: p, kind: "json", seed: false }] } } });
  if (first && !refused(first) && [".env", "host-ownership.json", "test-registry.json", "trade_log.json", "r309-HALT", "../x.json", "w6-x.flock"].every((p) => refused(withEntry(p))))
    log("ok   pull-server.cjs's loader would refuse a manifest naming a secret, a switch, a lock, a governance file or a path outside the data folder (.env, host-ownership.json, test-registry.json, trade_log.json, r309-HALT, ../x.json, a .flock)");
  else { bad++; log("DIFF the loader did not refuse a manifest naming a forbidden file"); }
  return bad;
}
if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.length === 1 && a[0] === "--write") {
    const { writeJsonAtomic } = require(path.join(W.REPO, "backend", "lib", "atomic-write.js"));
    fs.mkdirSync(MD, { recursive: true });
    for (const f of fs.readdirSync(MD)) if (!(f.replace(/\.json$/, "") in ALL)) fs.rmSync(path.join(MD, f));
    for (const [k, v] of Object.entries(ALL)) writeJsonAtomic(path.join(MD, k + ".json"), v);
    console.log(`written ${Object.keys(ALL).length} manifests in manifests/`); process.exitCode = 0;
  } else if (a.length === 1 && a[0] === "--check") process.exitCode = check() ? 1 : 0;
  else { console.log("usage: node manifests.cjs --write | --check"); process.exitCode = 2; }
}
module.exports = { ALL, WAVES, CODE, manifestOf, check, MD };
