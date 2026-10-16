"use strict";
/**
 * SEAT-SDK TRIAL — THE SELFTEST'S PRELOAD for a copy of automation/seat-wave.cjs run in a temp tree (NODE_OPTIONS --require). It does two
 * things and nothing else; with neither variable set it does nothing.
 *
 *   SEAT_SDK_TEST_NOW=<epoch ms>      a deterministic clock: every reading of the time is that instant plus one millisecond per reading.
 *                                     Two runs that read the clock the same number of times in the same order write the same bytes, so
 *                                     "the edited wave does exactly what the wave does" can be checked byte for byte.
 *   SEAT_SDK_FAKE_SCRIPT=<file>       the command-line path's executable is never started: a spawnSync of a file named claude.exe is
 *                                     answered here, from the same script and the same result object as the fake SDK (fake-sdk-core.cjs),
 *                                     and recorded. Every other spawnSync goes through untouched.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process");

if (process.env.SEAT_SDK_TEST_NOW) {
  const Real = Date, base = Number(process.env.SEAT_SDK_TEST_NOW); let n = 0; const tick = () => base + n++;
  class TestDate extends Real { constructor(...a) { if (a.length === 0) super(tick()); else super(...a); } static now() { return tick(); } }
  global.Date = TestDate;
}

if (process.env.SEAT_SDK_FAKE_SCRIPT) {
  const core = require(path.join(__dirname, "fake-sdk-core.cjs")), real = cp.spawnSync;
  cp.spawnSync = function (file, args, opts) {
    if (!/[\\/]claude\.exe$/i.test(String(file))) return real.apply(this, arguments);
    const script = JSON.parse(fs.readFileSync(process.env.SEAT_SDK_FAKE_SCRIPT, "utf8")), a = Array.isArray(args) ? args : [];
    const at = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; }, seat = at("--agent"), prompt = at("-p");
    const prior = (() => { try { return fs.readFileSync(script.cliRecord, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
    const n = prior.filter((r) => r.seat === seat).length, B = core.behaviourFor(script, seat, n);
    fs.appendFileSync(script.cliRecord, JSON.stringify({ seat, launch: n, exe: String(file), flags: a.map((x) => (x === prompt ? "<prompt>" : x)), promptSha: core.sha(prompt), promptChars: String(prompt).length, cwd: opts && opts.cwd, timeout: opts && opts.timeout }) + "\n");
    if (B.seal) core.appendClaim(script.claims, seat, script.session);
    const r = core.resultOf(B, seat, n, null), stdout = r ? JSON.stringify(r) : "", status = r && r.is_error !== true ? 0 : 1;
    return { pid: 1, output: [null, stdout, ""], stdout, stderr: "", status, signal: null };
  };
}
