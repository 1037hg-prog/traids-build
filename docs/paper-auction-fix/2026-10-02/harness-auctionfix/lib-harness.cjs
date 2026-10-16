// shared helpers for the scratch harnesses (no network, no writes outside the scratchpad)
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process");
const REAL_BK = process.env.PAF_BACKEND || path.resolve(__dirname, "..", "..", "..", "..", "backend");   // docs/paper-auction-fix/2026-10-02/harness-auctionfix -> backend
const H = __dirname, TMP = process.env.PAF_HARNESS_TMP || path.join(require("os").tmpdir(), "paf-auctionfix-harness");   // env dirs live in TMP, never next to the scripts
let pass = 0, fail = 0;
const ok = (cond, msg, extra) => { if (cond) { pass++; console.log("  ok   " + msg); } else { fail++; console.log("  FAIL " + msg + (extra !== undefined ? " :: " + (typeof extra === "string" ? extra : JSON.stringify(extra)) : "")); } };
const summary = (name) => { console.log(`${name}: ${pass} passed, ${fail} failed`); return fail; };
/** fresh fake backend dir: <H>/<name>/backend with lib/atomic-write.js copied and a data/ folder */
function fakeBackend(name) {
  const bk = path.join(TMP, "env-" + name, "backend");
  fs.rmSync(path.join(TMP, "env-" + name), { recursive: true, force: true });
  fs.mkdirSync(path.join(bk, "lib"), { recursive: true }); fs.mkdirSync(path.join(bk, "data"), { recursive: true });
  fs.copyFileSync(path.join(REAL_BK, "lib", "atomic-write.js"), path.join(bk, "lib", "atomic-write.js"));
  return bk;
}
/** harness copy of a runner: the --live flag is replaced by a harness global (the copy is never run with --live) */
function harnessCopy(srcFile, bk, name, liveExpr) {
  let s = fs.readFileSync(srcFile, "utf8");
  const n = s.split(liveExpr).length - 1; if (n !== 1) throw new Error(`harnessCopy ${name}: live expression found ${n} times`);
  s = s.replace(liveExpr, () => "(globalThis.__H_LIVE === true)");
  if (/process\.argv\.includes\("--live"\)/.test(s)) throw new Error("harnessCopy: a --live read survived");
  const out = path.join(bk, name); fs.writeFileSync(out, s); return out;
}
let runN = 0;
function run(target, spec) {
  const dir = path.dirname(target), sf = path.join(dir, `spec-${++runN}.json`), of = path.join(dir, `out-${runN}.json`);
  fs.writeFileSync(sf, JSON.stringify(spec));
  const r = cp.spawnSync(process.execPath, [path.join(H, "run-scenario.cjs"), target, sf, of], { encoding: "utf8", env: { ...process.env, NODE_PATH: path.join(REAL_BK, "node_modules"), ALPACA_KEY_ID: "", ALPACA_SECRET_KEY: "", ALPACA_TV_KEY_ID: "", ALPACA_TV_SECRET_KEY: "", ALPACA_BOOK_KEY_ID: "", ALPACA_BOOK_SECRET_KEY: "" }, timeout: 60000 });
  const out = fs.existsSync(of) ? JSON.parse(fs.readFileSync(of, "utf8")) : { calls: [], orders: [] };
  out.stdout = r.stdout; out.stderr = r.stderr; out.status = r.status;
  out.mut = out.calls.filter((c) => c.method !== "GET");
  return out;
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);
module.exports = { ok, summary, fakeBackend, harnessCopy, run, readJson, readJsonl, REAL_BK, H, TMP };
