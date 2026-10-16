"use strict";
/**
 * SCRATCH TREES for the selftest (options-vanished-settles 2026-10-16). A tree is a throwaway folder in the OS temp folder holding only
 * what backend/options-settle.js touches:
 *
 *   <tree>/backend/options-settle.js      the script text under test (base or staged, or a mutant of it)
 *   <tree>/backend/lib/atomic-write.js    the REAL house writer, copied from the repo (the write path is not stubbed)
 *   <tree>/backend/lib/alpaca-bars.js     this package's stub (no network; closes from a fixture)
 *   <tree>/backend/data/...               the fixture data files
 *
 * runTree() starts node with harness/no-network.cjs preloaded, so any fetch / http / net / dns attempt throws AND is recorded. Nothing
 * is written inside the repository, and no broker is asked anywhere.
 */
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const PKG = path.resolve(__dirname, ".."), REPO = path.resolve(PKG, "..", "..", "..");

/** make a scratch tree. data: { "<file>.json": object|string } written into backend/data; bars: the stub's fixture */
function makeTree({ scriptText, data = {}, bars = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ovs-tree-"));
  const bk = path.join(dir, "backend"), lib = path.join(bk, "lib"), dd = path.join(bk, "data");
  fs.mkdirSync(dd, { recursive: true }); fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(bk, "options-settle.js"), scriptText);
  fs.copyFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"), path.join(lib, "atomic-write.js"));
  fs.copyFileSync(path.join(PKG, "harness", "stub-alpaca-bars.js"), path.join(lib, "alpaca-bars.js"));
  const barsFile = path.join(dir, "bars.json");
  fs.writeFileSync(barsFile, JSON.stringify(bars));
  for (const [name, body] of Object.entries(data)) fs.writeFileSync(path.join(dd, name), typeof body === "string" ? body : JSON.stringify(body, null, 1));
  return { dir, bk, dd, barsFile, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** every file of backend/data, parsed when it is JSON */
function dataOf(tree) {
  const out = {};
  for (const f of fs.readdirSync(tree.dd)) {
    const t = fs.readFileSync(path.join(tree.dd, f), "utf8");
    out[f] = f.endsWith(".json") ? (() => { try { return JSON.parse(t); } catch { return t; } })() : t;
  }
  return out;
}

/** run the tree's options-settle.js -> { status, out, lastLine, data, barCalls, netAttempts } */
function runTree(tree, { args = [], env = {} } = {}) {
  const netlog = path.join(tree.dir, "net-attempts.jsonl");
  const r = cp.spawnSync(process.execPath, ["-r", path.join(PKG, "harness", "no-network.cjs"), path.join(tree.bk, "options-settle.js"), ...args], {
    encoding: "utf8", windowsHide: true, timeout: 120000,
    env: { ...process.env, OVS_BARS: tree.barsFile, OVS_TREE: tree.dir, OVS_NETLOG: netlog, ...env },
  });
  const out = String(r.stdout || "") + String(r.stderr || "");
  const lines = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { return []; } };
  return { status: r.status, out, stdout: String(r.stdout || ""), stderr: String(r.stderr || ""),
    lastLine: out.trim().split("\n").filter(Boolean).pop() || "", data: dataOf(tree),
    barCalls: lines(path.join(tree.dir, "bars-calls.jsonl")), netAttempts: lines(netlog) };
}

/** timestamps a run makes are real-time: replace them so two runs can be compared byte for byte */
function normalize(x) {
  return JSON.parse(JSON.stringify(x, (k, v) => (["markedAt", "seen", "asOf", "since", "ts", "settleOfficialAsOf"].includes(k) ? "<ts>" : v)));
}

module.exports = { PKG, REPO, makeTree, runTree, dataOf, normalize };
