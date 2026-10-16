#!/usr/bin/env node
/**
 * W1 RUN — one W1 unit's close-chain steps, on the VPS, exactly as automation/close-chain.cjs runs them at home. 2026-10-07
 * (server migration W1; docs/server/wave1-crypto). Installed at /home/traids/traids/backend/w1-run.cjs (the real tree) and, byte for
 * byte, at /home/traids/w1-shadow/backend/w1-run.cjs (the shadow tree of the dry nights). Repo copy: deploy/server/w1-run.cjs.
 *
 * Same scripts, same order, same per-step timeout (SIGKILL), same allowExit as the chain lines (home-patch.cjs's selftest compares this
 * table with the chain text). The scripts resolve their data as __dirname/data, so the tree this file sits in decides where they
 * write: the real tree writes /home/traids/traids/backend/data, the shadow tree its own data dir — no script is changed.
 *
 *   node w1-run.cjs w1-whales     hyperliquid-whales-record.js, then r323-hl-copy-leaders.js --score (R323 must run after the recorder)
 *   node w1-run.cjs w1-funding    funding-carry-v2.js (#55 collector; reads data/risk-policy.json, pushed read-only from home)
 *   node w1-run.cjs w1-social     social-mentions-record.js
 *   node w1-run.cjs --selftest    fake scripts in a temp tree
 * Writes data/w1-run-<whales|funding|social>.json (atomic): each step's exit, seconds, ok (the chain's own judgement) and the tail of
 * a failed step's output — the unit's last-run stamp that home's lib/w1-health.cjs and compare-w1.cjs read. Switches (never synced):
 * data/TRAIDS_STOP or data/<unit>-OFF -> nothing runs, exit 0, recorded.
 * Exit 0 every step exited 0 (or a quiet code: R323's 4 = feed down, retried tomorrow, nothing half-written) and the unit's OUTPUT
 * CHECK passed · 1 a step FAILED as the chain would record it · 2 every step ok by the chain's allowExit, but a recorder exited nonzero
 * (whales 1 / social 1: that day's snapshot may be a permanent gap) OR the output check failed. Any nonzero exit fails the systemd unit
 * -> OnFailure= pages the ops bot (de-duplicated 3 h).
 * OUTPUT CHECKS (review 2026-10-07: two recorders can exit 0 having recorded nothing usable) — recorded in the stamp as `checks`:
 *   w1-whales   data/hyperliquid-whales/<UTC day of the run>.json exists and is complete === true (hyperliquid-whales-record.js writes
 *               complete:false and exits 0 when more than 5 position fetches fail: R323 then counts that UTC day as a gap)
 *   w1-funding  every coin in data/funding-carry-store.json holds a period less than 9 h old (OKX settles every 8 h; funding-carry-v2.js
 *               turns every HTTP error into "no data", prints "+0 new periods" and exits 0)
 *   w1-social   none needed: social-mentions-record.js exits 1 on any source error (-> exit 2 above)
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");

// [chain step name, script (beside this file), minutes, { args, allowExit, quietExit }] — mirror of automation/close-chain.cjs
const UNITS = {
  "w1-whales": [
    ["hyperliquid whales record", "hyperliquid-whales-record.js", 5, { allowExit: [1] }],
    ["r323 hl copy leaders (score)", "r323-hl-copy-leaders.js", 25, { args: ["--score"], allowExit: [4], quietExit: [4] }],
  ],
  "w1-funding": [["funding carry collector (#55)", "funding-carry-v2.js", 6, {}]],
  "w1-social": [["social mentions record", "social-mentions-record.js", 2, { allowExit: [1] }]],
};
const short = (u) => u.replace(/^w1-/, "");
const FUNDING_MAX_AGE_MS = 9 * 3600000;
const readJson = (f) => { try { return { j: JSON.parse(fs.readFileSync(f, "utf8")) }; } catch (e) { return { err: e.code === "ENOENT" ? "missing" : "unreadable" }; } };
/** per unit: [check name, (dataDir, startMs, endMs) -> null (ok) | why] — what the unit exists to leave behind */
const POST = {
  "w1-whales": [["whales snapshot complete", (data, startMs) => {
    const day = new Date(startMs).toISOString().slice(0, 10), rel = `data/hyperliquid-whales/${day}.json`, r = readJson(path.join(data, "hyperliquid-whales", `${day}.json`));
    if (r.err) return `${rel} ${r.err} — UTC day ${day} has no snapshot (a permanent R323 gap)`;
    return r.j && r.j.complete === true ? null : `${rel} is INCOMPLETE (${Array.isArray(r.j && r.j.errors) ? r.j.errors.length : "?"} position fetches failed; > 5 = incomplete) — R323 counts UTC day ${day} as a gap`;
  }]],
  "w1-funding": [["funding store current", (data, startMs, endMs) => {
    const r = readJson(path.join(data, "funding-carry-store.json"));
    if (r.err || !r.j || !r.j.periods || typeof r.j.periods !== "object") return `data/funding-carry-store.json ${r.err || "has no periods"}`;
    const stale = [];
    for (const [coin, m] of Object.entries(r.j.periods)) { const ts = Object.keys(m || {}).map(Number).filter(Number.isFinite), n = ts.length ? Math.max(...ts) : null; if (n == null || !(endMs - n <= FUNDING_MAX_AGE_MS)) stale.push(`${coin} ${n == null ? "none" : ((endMs - n) / 3600000).toFixed(1) + " h"}`); }
    return stale.length ? `the store's newest period is older than 9 h for ${stale.join(", ")} — OKX gave no new period (funding-carry-v2.js exits 0 on every HTTP error); every period OKX drops after ~91 days is lost` : null;
  }]],
  "w1-social": [],
};

function writeJson(file, obj) {
  let aw = null; try { aw = require(path.join(path.dirname(file), "..", "lib", "atomic-write.js")); } catch { aw = null; }
  if (aw) return aw.writeJsonAtomic(file, obj);
  const tmp = file + ".tmp-" + process.pid; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, file);
}

/** run one unit in tree `dir` (the backend dir holding the scripts and data/). Returns { exit, status }. */
function runUnit(unit, { dir = __dirname, steps = UNITS[unit], checks = POST[unit] || [], log = console.log, now = () => new Date() } = {}) {
  if (!steps) return { exit: 1, status: null, why: `unknown unit ${unit}` };
  const data = path.join(dir, "data"), stampFile = path.join(data, `w1-run-${short(unit)}.json`);
  fs.mkdirSync(data, { recursive: true });
  const startMs = now().getTime();
  const status = { unit, host: os.hostname(), tree: dir, startedAt: new Date(startMs).toISOString(), steps: [] };
  const sw = ["TRAIDS_STOP", `${unit}-OFF`].find((f) => fs.existsSync(path.join(data, f)));
  if (sw) {
    status.finishedAt = now().toISOString(); status.stopped = sw; status.ok = true; status.exit = 0;
    writeJson(stampFile, status); log(`w1-run ${unit}: data/${sw} present — nothing run`); return { exit: 0, status };
  }
  let exit = 0;
  for (const [name, script, mins, opts = {}] of steps) {
    const full = path.join(dir, script), t0 = Date.now();
    if (!fs.existsSync(full)) { status.steps.push({ name, ok: false, exit: null, why: "script missing", secs: 0 }); log(`  FAIL ${name} — ${script} not found`); exit = 1; continue; }
    const r = cp.spawnSync(process.execPath, [full, ...(opts.args || [])], { cwd: path.dirname(dir), timeout: mins * 60000, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const secs = Math.round((Date.now() - t0) / 1000), code = r.error ? null : r.status;
    const ok = !r.error && (code === 0 || (opts.allowExit || []).includes(code));
    const quiet = ok && (code === 0 || (opts.quietExit || []).includes(code));
    const why = r.error ? (r.error.code === "ETIMEDOUT" ? `TIMEOUT after ${mins}m` : r.error.message) : code !== 0 ? `exit ${code}` : null;
    const out = (String(r.stdout || "") + String(r.stderr || "")).trim();
    if (out) log(out.length > 20000 ? "…" + out.slice(-20000) : out);
    status.steps.push({ name, script, ok, exit: code, secs, why, tail: quiet ? undefined : out.slice(-400) });
    log(`  ${ok ? (quiet ? "ok  " : "WARN") : "FAIL"} ${name.padEnd(30)} ${secs}s${why ? " — " + why : ""}`);
    const stepCode = !ok ? 1 : quiet ? 0 : 2;                     // severity: FAIL (1) beats WARN (2) beats clean (0)
    exit = exit === 1 || stepCode === 1 ? 1 : Math.max(exit, stepCode);
  }
  const endMs = now().getTime();
  status.checks = checks.map(([name, fn]) => { let why = null; try { why = fn(data, startMs, endMs); } catch (e) { why = `check crashed: ${e.message}`; } log(`  ${why ? "WARN" : "ok  "} ${("check: " + name).padEnd(30)}${why ? " — " + why : ""}`); return { name, ok: !why, why: why || undefined }; });
  const checkBad = status.checks.filter((c) => !c.ok);
  if (checkBad.length && exit !== 1) exit = 2;                      // a recorder that recorded nothing usable pages, like a nonzero exit
  status.finishedAt = new Date(endMs).toISOString(); status.ok = status.steps.every((s) => s.ok); status.exit = exit;
  writeJson(stampFile, status);
  log(`w1-run ${unit}: ${exit === 0 ? "clean" : exit === 1 ? "a step FAILED" : checkBad.length ? "ok by the chain's rules, but the output check FAILED: " + checkBad.map((c) => c.why).join("; ") : "ok by the chain's rules, but a recorder exited nonzero"} (exit ${exit}) · data/${path.basename(stampFile)}`);
  return { exit, status };
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w1-run-"));
  try {
    const B = path.join(tmp, "backend"); fs.mkdirSync(path.join(B, "data"), { recursive: true });
    const script = (n, body) => fs.writeFileSync(path.join(B, n), body);
    script("rec.js", "require('fs').writeFileSync(require('path').join(__dirname,'data','rec.out'), process.argv.slice(2).join(' ')||'ran'); process.exit(Number(process.env.REC_EXIT||0));");
    script("score.js", "const fs=require('fs'),p=require('path'); fs.writeFileSync(p.join(__dirname,'data','score.out'), fs.existsSync(p.join(__dirname,'data','rec.out'))?'after':'before'); process.exit(Number(process.env.SCORE_EXIT||0));");
    script("hang.js", "setTimeout(()=>{}, 600000);");
    const steps = [["rec", "rec.js", 1, { allowExit: [1] }], ["score", "score.js", 1, { args: ["--score"], allowExit: [4], quietExit: [4] }]];
    const quietLog = () => {};
    const run = (env, st = steps) => { Object.assign(process.env, env); try { return runUnit("w1-whales", { dir: B, steps: st, checks: [], log: quietLog }); } finally { for (const k of Object.keys(env)) delete process.env[k]; } };
    let r = run({});
    const st = JSON.parse(fs.readFileSync(path.join(B, "data", "w1-run-whales.json"), "utf8"));
    ok("clean: both steps run in order (the score sees the recorder's output), exit 0, stamp written", r.exit === 0 && fs.readFileSync(path.join(B, "data", "score.out"), "utf8") === "after" && st.ok && st.steps.length === 2 && st.finishedAt, JSON.stringify(st));
    for (const f of ["rec.out", "score.out"]) fs.unlinkSync(path.join(B, "data", f));
    r = run({ REC_EXIT: "1" });
    ok("recorder exit 1 (allowed by the chain) -> the score still runs; the unit exits 2 (pages: a missed snapshot is a permanent gap)", r.exit === 2 && r.status.ok === true && r.status.steps[0].exit === 1 && fs.existsSync(path.join(B, "data", "score.out")));
    r = run({ SCORE_EXIT: "4" });
    ok("R323 exit 4 (feed down, retried tomorrow) -> ok and quiet, exit 0", r.exit === 0 && r.status.steps[1].exit === 4 && r.status.ok);
    r = run({ SCORE_EXIT: "2" });
    ok("R323 exit 2 (interim kill / refused) -> FAILED as the chain records it, exit 1", r.exit === 1 && r.status.ok === false && r.status.steps[1].ok === false);
    r = run({ REC_EXIT: "1", SCORE_EXIT: "2" });
    ok("a FAIL anywhere wins over a WARN: exit 1", r.exit === 1);
    r = run({}, [["hang", "hang.js", 0.02, {}]]);
    ok("a step past its timeout is killed (SIGKILL) and FAILED", r.exit === 1 && /TIMEOUT/.test(r.status.steps[0].why || ""), JSON.stringify(r.status.steps));
    r = run({}, [["gone", "nope.js", 1, {}]]);
    ok("a missing script is a FAILED step, never a silent skip", r.exit === 1 && r.status.steps[0].why === "script missing");
    fs.writeFileSync(path.join(B, "data", "w1-whales-OFF"), "");
    fs.rmSync(path.join(B, "data", "rec.out"), { force: true }); r = run({});
    ok("data/<unit>-OFF -> nothing runs, exit 0, recorded as stopped", r.exit === 0 && r.status.stopped === "w1-whales-OFF" && !fs.existsSync(path.join(B, "data", "rec.out")));
    fs.unlinkSync(path.join(B, "data", "w1-whales-OFF")); fs.writeFileSync(path.join(B, "data", "TRAIDS_STOP"), ""); r = run({});
    ok("data/TRAIDS_STOP -> nothing runs, exit 0", r.exit === 0 && r.status.stopped === "TRAIDS_STOP" && !fs.existsSync(path.join(B, "data", "rec.out")));
    ok("the table: whales = recorder then R323 --score; funding; social (names, scripts, minutes, allowExit as the chain lines)", UNITS["w1-whales"][0][1] === "hyperliquid-whales-record.js" && UNITS["w1-whales"][1][1] === "r323-hl-copy-leaders.js" && UNITS["w1-whales"][1][3].args[0] === "--score" && UNITS["w1-whales"][1][2] === 25 && UNITS["w1-funding"][0][2] === 6 && UNITS["w1-social"][0][2] === 2);
    ok("an unknown unit is refused", runUnit("w1-nope", { dir: B, log: quietLog }).exit === 1);
    // the OUTPUT CHECKS (the real POST table; a no-op step stands in for the recorder)
    fs.rmSync(path.join(B, "data", "TRAIDS_STOP"), { force: true });
    script("noop.js", "");
    const T0 = new Date("2026-10-10T21:30:00Z"), at = () => T0, noop = [["rec", "noop.js", 1, {}]];
    const W = (o) => { const f = path.join(B, "data", "hyperliquid-whales", "2026-10-10.json"); fs.mkdirSync(path.dirname(f), { recursive: true }); if (o == null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, JSON.stringify(o)); };
    const wh = () => runUnit("w1-whales", { dir: B, steps: noop, log: quietLog, now: at });
    W(null); r = wh();
    ok("whales check: the recorder exited 0 but wrote no snapshot for the UTC day -> exit 2 (pages), named in the stamp", r.exit === 2 && r.status.ok === true && r.status.checks[0].ok === false && /2026-10-10\.json missing/.test(r.status.checks[0].why) && JSON.parse(fs.readFileSync(path.join(B, "data", "w1-run-whales.json"), "utf8")).checks[0].ok === false, JSON.stringify(r.status.checks));
    W({ complete: false, errors: [1, 2, 3, 4, 5, 6] }); r = wh();
    ok("whales check: an INCOMPLETE snapshot (6 failed fetches, the recorder exits 0) -> exit 2", r.exit === 2 && /INCOMPLETE \(6 position fetches failed/.test(r.status.checks[0].why || ""));
    W({ complete: true, errors: [] }); r = wh();
    ok("whales check: a complete snapshot -> exit 0, check ok", r.exit === 0 && r.status.checks[0].ok === true);
    const store = (ages) => fs.writeFileSync(path.join(B, "data", "funding-carry-store.json"), JSON.stringify({ periods: Object.fromEntries(Object.entries(ages).map(([c, h]) => [c, { [T0.getTime() - h * 3600000]: { f: 0, b: 0 }, [T0.getTime() - 400 * 3600000]: { f: 0, b: 0 } }])) }));
    const fu = () => runUnit("w1-funding", { dir: B, steps: noop, log: quietLog, now: at });
    store({ BTC: 4.5, ETH: 4.5 }); r = fu();
    ok("funding check: every coin's newest period 4.5 h old -> exit 0", r.exit === 0 && r.status.checks[0].ok === true, JSON.stringify(r.status.checks));
    store({ BTC: 28.5, ETH: 28.5 }); r = fu();
    ok("funding check: no new period for a day (OKX errors swallowed, '+0 new periods', exit 0) -> exit 2, naming the coins", r.exit === 2 && /BTC 28\.5 h, ETH 28\.5 h/.test(r.status.checks[0].why || ""));
    store({ BTC: 4.5, ETH: 12.5 }); r = fu();
    ok("funding check: one coin stale -> exit 2 naming only it", r.exit === 2 && /for ETH 12\.5 h/.test(r.status.checks[0].why || "") && !/BTC/.test(r.status.checks[0].why || ""));
    fs.rmSync(path.join(B, "data", "funding-carry-store.json")); r = fu();
    ok("funding check: the store missing -> exit 2", r.exit === 2 && /missing/.test(r.status.checks[0].why || ""));
    ok("a FAILED step stays exit 1 when a check also fails", runUnit("w1-funding", { dir: B, steps: [["gone", "nope.js", 1, {}]], log: quietLog, now: at }).exit === 1);
    ok("social has no output check (its recorder exits 1 on any error); the POST table covers exactly the three units", POST["w1-social"].length === 0 && Object.keys(POST).sort().join() === Object.keys(UNITS).sort().join());
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`w1-run selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const u = process.argv[2];
  if (u === "--selftest") process.exitCode = selftest() ? 0 : 1;
  else if (!UNITS[u]) { console.error(`usage: node w1-run.cjs ${Object.keys(UNITS).join(" | ")} | --selftest`); process.exitCode = 1; }
  else { console.log(`w1-run ${u} · ${new Date().toISOString()} · tree ${__dirname}`); process.exitCode = runUnit(u).exit; }
}
module.exports = { UNITS, POST, runUnit };
