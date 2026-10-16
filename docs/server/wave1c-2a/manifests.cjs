#!/usr/bin/env node
/**
 * MANIFESTS — the W1c and W2a pull manifests (server migration plan v2 §W1c / §W2a), in the format W1's deploy/server/pull-server.cjs
 * reads (pull-manifest-v1; see docs/server/wave1-crypto/manifests.cjs for the entry kinds). Generated here because JSON is only ever
 * written by node through backend/lib/atomic-write.js. The home step installs them as deploy/server/manifests/{w1c,w2a}.json, where
 * the standing pull-server.cjs and own.cjs (installed by W1) read them. 2026-10-08 (docs/server/wave1c-2a).
 *
 *   node docs/server/wave1c-2a/manifests.cjs --write     (re)write manifests/w1c.json and manifests/w2a.json
 *   node docs/server/wave1c-2a/manifests.cjs --check     exit 0 when both files equal what this file generates
 *
 * w1c-spread  crypto-spread-log.jsonl is append-only (jsonl-prefix: home's copy must be an exact byte prefix of the VPS's);
 *             crypto-symbols.json is an INPUT (built nightly at home, pushed read-only 0444 by every pull, never pulled). Its flock is
 *             held by the unit only while a snapshot runs (seconds), so pulls wait for it (--lock-wait 120 on the home lines).
 * w2a-fills   alpaca-trade-updates.jsonl is append-only. lock null: the unit is ONE long-running websocket process that holds no pull
 *             lock; a pull that catches an append mid-read is refused (nothing written) and retried at the next pull.
 * steps: []   neither unit is a close-chain step (they run from automation\board-discipline.bat and automation\preflight.bat, gated by
 *             deploy/server/home-gate.cjs), so own.cjs's chain-tag check has nothing to require for them.
 */
"use strict";
const fs = require("fs"), path = require("path");

const DATA = "/home/traids/traids/backend/data", BACKEND = "/home/traids/traids/backend", SHADOW_B = "/home/traids/w1c2a-shadow/backend";

const W1C = {
  schema: "pull-manifest-v1", wave: "w1c", title: "W1c crypto spread snapshot (crypto-spread-snapshot.js --symbols-file, every 15 min, 24/7)",
  remoteData: DATA, remoteBackend: BACKEND, shadow: { backend: SHADOW_B, data: SHADOW_B + "/data" },
  units: {
    "w1c-spread": {
      lock: "w1c-spread.flock", steps: [],
      systemd: { service: "traids-spread.service", timer: "traids-spread.timer", shadowService: "traids-spread-shadow.service", shadowTimer: "traids-spread-shadow.timer" },
      cadenceHours: 0.25,
      code: ["crypto-spread-snapshot.js", "own-check.cjs"],
      entries: [
        { path: "crypto-spread-log.jsonl", kind: "jsonl-prefix" },
        { path: "crypto-symbols.json", kind: "json", input: true, pull: false, mode: "0444" },
      ],
    },
  },
};

const W2A = {
  schema: "pull-manifest-v1", wave: "w2a", title: "W2a Alpaca fills stream (alpaca-fills-stream.js --tv-24x7, one long-running service)",
  remoteData: DATA, remoteBackend: BACKEND, shadow: { backend: SHADOW_B, data: SHADOW_B + "/data" },
  units: {
    "w2a-fills": {
      lock: null, steps: [], longRunning: true,
      systemd: { service: "traids-fills.service", timer: "traids-fills.timer", shadowService: "traids-fills-shadow.service", shadowTimer: "traids-fills-shadow.timer" },
      cadenceHours: 24,
      code: ["alpaca-fills-stream.js", "lib/atomic-write.js", "own-check.cjs"],
      entries: [
        { path: "alpaca-trade-updates.jsonl", kind: "jsonl-prefix" },
      ],
    },
  },
};

const ALL = { w1c: W1C, w2a: W2A };

if (require.main === module) {
  const a = process.argv.slice(2), dir = path.join(__dirname, "manifests");
  if (a.length === 1 && a[0] === "--write") {
    const REPO = path.resolve(__dirname, "..", "..", "..");
    const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
    fs.mkdirSync(dir, { recursive: true });
    for (const [k, v] of Object.entries(ALL)) { writeJsonAtomic(path.join(dir, k + ".json"), v); console.log("written manifests/" + k + ".json"); }
    process.exitCode = 0;
  } else if (a.length === 1 && a[0] === "--check") {
    let bad = 0;
    for (const [k, v] of Object.entries(ALL)) {
      let cur = null; try { cur = JSON.parse(fs.readFileSync(path.join(dir, k + ".json"), "utf8")); } catch { cur = null; }
      const same = cur && JSON.stringify(cur) === JSON.stringify(v);
      console.log(`${same ? "ok  " : "DIFF"} manifests/${k}.json`); if (!same) bad++;
    }
    process.exitCode = bad ? 1 : 0;
  } else { console.log("usage: node manifests.cjs --write | --check"); process.exitCode = 2; }
}
module.exports = { ALL, W1C, W2A, SHADOW_B, DATA, BACKEND };
