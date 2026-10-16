#!/usr/bin/env node
/**
 * MANIFESTS — the source of the per-wave pull manifests (docs/server/wave1-crypto/manifests/<wave>.json). 2026-10-07, server
 * migration M3. JSON is only ever written by node through backend/lib/atomic-write.js, so the manifests are generated here:
 *
 *   node docs/server/wave1-crypto/manifests.cjs --write     (re)write manifests/r309.json and manifests/w1.json
 *   node docs/server/wave1-crypto/manifests.cjs --check     exit 0 when both files equal what this file generates
 *
 * A manifest lists, per UNIT (the key in backend/data/host-ownership.json), the files that unit writes on the server and how a
 * pull validates them before anything is renamed in at home:
 *   json             parses; frozenOnceSet paths never change once set on the older side; grows = the older side's subtree at that
 *                    path is a subset of the newer side's (every leaf present and equal: an append-only keyed store)
 *   jsonl-prefix     every line parses, the last ends with "\n", the older copy is an exact BYTE prefix (append-only log)
 *   jsonl-rewritten  rewritten in place (R309's ledger): ids only grow, immutable fields stay, status only moves forward
 *   dir-of-json      a directory of dated JSON files: names match the pattern, each parses, no file the older side holds is missing,
 *                    and a file whose frozenWhen field is true on the older side is never rewritten
 * Entry flags: pull (default true) = pulled home while server-owned · seed (default true) = pushed home -> server at the cutover
 * (own.cjs) and into the shadow tree (deploy step seeds) · input = home-owned, pushed read-only (0444) to the server by every pull
 * and by the seeds, never pulled · cache = seed-only, files missing on the target are added, nothing is validated or overwritten.
 * "older side" = home for a pull (the server's copy must extend home's), the server for a seed (home's must extend the server's).
 */
"use strict";
const fs = require("fs"), path = require("path");

const DATA = "/home/traids/traids/backend/data", BACKEND = "/home/traids/traids/backend";
const DATED = { glob: "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json", pattern: "^\\d{4}-\\d{2}-\\d{2}\\.json$" };

/** R309 (W0): exactly what deploy/server/pull-r309.cjs validates, as data, so pull-r309 can be retired for `pull-server --wave r309`.
 *  NOT wired anywhere yet: the hourly "TRAIDS R309 Pull" task keeps running pull-r309 until Josh switches it. */
const R309 = {
  schema: "pull-manifest-v1", wave: "r309", title: "R309 hourly runner (W0): the four run files, as deploy/server/pull-r309.cjs pulls them",
  note: "Not wired: the scheduled task 'TRAIDS R309 Pull' still runs pull-r309.cjs. Retiring it = point deploy\\server\\pull-r309.bat at pull-server.cjs --wave r309 (Josh).",
  remoteData: DATA, remoteBackend: BACKEND,
  units: {
    r309: {
      fixedOwner: "server", lock: null, steps: [], systemd: { service: "traids-r309.service", timer: "traids-r309.timer" }, code: [],
      haltBackstop: true,
      entries: [
        { path: "r309-ledger.jsonl", kind: "jsonl-rewritten", seed: false, rules: {
          idField: "id", kindField: "kind", mutableKind: "lot", statusField: "status",
          immutable: ["kind", "id", "coin", "signalHour", "day", "signalClose", "stats", "twin.hour", "twin.seedKey", "twin.seed", "twin.entryClose", "twin.exitHour", "twin.poolSize", "shadow.exitHour", "entry.cid", "entry.notionalOrdered", "entry.submittedAt"],
          onceWhenStatus: [
            { statuses: ["open", "exiting", "closed", "error"], fields: ["entry.avgPx", "entry.filledQty", "entry.filledAt", "entry.orderId"], what: "entry fill" },
            { statuses: ["closed"], fields: ["net", "gross", "holdHours", "exit.avgPx", "exit.soldQty", "exit.filledAt"], what: "closed-lot" },
          ],
          onceSet: ["twin.net"],
          next: {
            "submitting": ["submitting", "submit-error", "submitted", "open", "unfilled", "not-sent", "missed"],
            "submit-error": ["submit-error", "submitted", "open", "unfilled", "not-sent"],
            "submitted": ["submitted", "open", "unfilled", "not-sent"],
            "open": ["open", "exiting", "closed", "error"],
            "exiting": ["exiting", "closed", "error"],
            "error": ["error", "exiting", "closed"],
            "closed": ["closed"], "unfilled": ["unfilled"], "not-sent": ["not-sent"], "missed": ["missed"],
          },
        } },
        { path: "r309-cycles.jsonl", kind: "jsonl-prefix", seed: false },
        { path: "r309-surge-hold48.json", kind: "json", seed: false, frozenOnceSet: ["config.evidenceStart", "read"] },
        { path: "r309-interim.json", kind: "json", seed: false },
      ],
    },
  },
};

/** W1: the crypto 24/7 recorders (plan v2 §W1). Units = host-ownership keys; steps = the close-chain step names each unit replaces. */
const W1 = {
  schema: "pull-manifest-v1", wave: "w1", title: "W1 crypto 24/7 recorders (hyperliquid whales + R323 score, funding carry #55, social mentions)",
  remoteData: DATA, remoteBackend: BACKEND,
  shadow: { backend: "/home/traids/w1-shadow/backend", data: "/home/traids/w1-shadow/backend/data" },
  units: {
    "w1-whales": {
      lock: "w1-whales.flock", steps: ["hyperliquid whales record", "r323 hl copy leaders (score)"],
      slotUtc: "21:30",   // = traids-w1-whales.timer's OnCalendar (deploy.cjs selftest); own.cjs's rollback guard waits for this slot's run
      systemd: { service: "traids-w1-whales.service", timer: "traids-w1-whales.timer", shadowService: "traids-w1s-whales.service", shadowTimer: "traids-w1s-whales.timer" },
      cadenceHours: 24,
      code: ["hyperliquid-whales-record.js", "r323-hl-copy-leaders.js", "lib/atomic-write.js", "w1-run.cjs", "own-check.cjs", "w1-probe.cjs"],
      entries: [
        { path: "hyperliquid-whales", kind: "dir-of-json", ...DATED, frozenWhen: "complete" },
        { path: "r323-ledger.jsonl", kind: "jsonl-prefix" },
        { path: "r323-state.json", kind: "json" },
        { path: "w1-run-whales.json", kind: "json", seed: false },
        { path: "training/r323/hl-cache", kind: "dir-of-json", glob: "*.json", pattern: "^[A-Za-z0-9._-]+\\.json$", pull: false, cache: true },
      ],
    },
    "w1-funding": {
      lock: "w1-funding.flock", steps: ["funding carry collector (#55)"],
      systemd: { service: "traids-w1-funding.service", timer: "traids-w1-funding.timer", shadowService: "traids-w1s-funding.service", shadowTimer: "traids-w1s-funding.timer" },
      cadenceHours: 24,
      code: ["funding-carry-v2.js", "w1-run.cjs", "own-check.cjs", "w1-probe.cjs"],
      entries: [
        { path: "funding-carry-store.json", kind: "json", grows: "periods" },
        { path: "w1-run-funding.json", kind: "json", seed: false },
        { path: "risk-policy.json", kind: "json", input: true, pull: false, mode: "0444" },
      ],
    },
    "w1-social": {
      lock: "w1-social.flock", steps: ["social mentions record"],
      systemd: { service: "traids-w1-social.service", timer: "traids-w1-social.timer", shadowService: "traids-w1s-social.service", shadowTimer: "traids-w1s-social.timer" },
      cadenceHours: 24,
      code: ["social-mentions-record.js", "lib/atomic-write.js", "w1-run.cjs", "own-check.cjs", "w1-probe.cjs"],
      entries: [
        { path: "social-mentions", kind: "dir-of-json", ...DATED, frozenWhen: "complete" },
        { path: "w1-run-social.json", kind: "json", seed: false },
      ],
    },
  },
};

const ALL = { r309: R309, w1: W1 };

if (require.main === module) {
  const a = process.argv.slice(2), dir = path.join(__dirname, "manifests");
  if (a.includes("--write")) {
    const REPO = path.resolve(__dirname, "..", "..", "..");
    const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
    fs.mkdirSync(dir, { recursive: true });
    for (const [k, v] of Object.entries(ALL)) { writeJsonAtomic(path.join(dir, k + ".json"), v); console.log("written manifests/" + k + ".json"); }
    process.exitCode = 0;
  } else if (a.includes("--check")) {
    let bad = 0;
    for (const [k, v] of Object.entries(ALL)) {
      let cur = null; try { cur = JSON.parse(fs.readFileSync(path.join(dir, k + ".json"), "utf8")); } catch { cur = null; }
      const same = cur && JSON.stringify(cur) === JSON.stringify(v);
      console.log(`${same ? "ok  " : "DIFF"} manifests/${k}.json`); if (!same) bad++;
    }
    process.exitCode = bad ? 1 : 0;
  } else { console.log("usage: node manifests.cjs --write | --check"); process.exitCode = 2; }
}
module.exports = { ALL, R309, W1 };
