#!/usr/bin/env node
/**
 * COST BAND REFUSAL — SELFTEST. Small fixtures in a temp folder only: no network, no broker, no live data file is read or written.
 *   node docs/cost-band-refusal/2026-10-16/selftest.cjs
 * Ends with "SELFTEST PASSED (n checks)" or exits 1 naming each failure.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");
const { loadCjs } = require("./loadcjs.cjs");
const G = loadCjs(path.join(PKG, "staged", "backend", "lib", "cost-band-gate.js"));
const P = require("./pkg.cjs"), R = require("./record.cjs");

let n = 0; const fails = [];
const ok = (name, cond, detail) => { n++; if (!cond) fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };
const temps = [], tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "cost-band-st-")); temps.push(d); return d; };
const mt = (iso) => Date.parse(iso + "-06:00");   // an MT wall-clock time in October / November 2026 (MDT -6 until 11-01; the November checks use -07:00 explicitly)
const ON = { exists: () => false }, OFF = { exists: () => true };
const tk = (bps, extra = {}) => ({ id: "fx-1", cls: "Equity", sym: "FAKE", dir: 1, entry: 50, stop: 48, stopDist: 2, addedAt: 1, strategy: "Ensemble", obs: bps === undefined ? {} : { spreadBps: bps, clientStamp: "kept" }, ...extra });
// a 13:00 MT Saturday and a 10:00 / 14:00 MT Wednesday (2026-10-17 is a Saturday; 2026-10-14 a Wednesday). MT is UTC-6 in October.
const SAT = Date.parse("2026-10-17T19:00:00Z"), WED10 = Date.parse("2026-10-14T16:00:00Z"), WED14 = Date.parse("2026-10-14T20:00:00Z"), WED17 = Date.parse("2026-10-14T23:00:00Z");

// ---- 1. the band, at its edges --------------------------------------------------------------------------------------------
const verdict = (bps, extra, o = ON) => G.evaluate(tk(bps, extra), o);
ok("29.99 bps passes (below the band)", verdict(29.99) === null);
ok("30 bps is refused (lower edge inclusive)", verdict(30) && verdict(30).test === "COSTBAND");
ok("65 bps is refused", verdict(65) && verdict(65).veto === "COSTBAND spread 30-100bps");
ok("100 bps is refused (upper edge inclusive; R49 refuses only > 100)", verdict(100) && verdict(100).test === "COSTBAND");
ok("100.01 bps is NOT this gate's (R49's)", verdict(100.01) === null);
ok("no stamp passes (the STAMP gate owns it)", verdict(undefined) === null && G.evaluate({ ...tk(50), obs: undefined }, ON) === null);
ok("a non-number stamp passes", verdict("50") === null && verdict(NaN) === null && verdict(Infinity) === null && verdict(null) === null);
ok("the why rounds the spread to one decimal", /42\.5 bps/.test(verdict(42.46).why), verdict(42.46).why);
ok("the why names the spread and the switch", /50 bps .*30-100 bps.*cost-band-OFF/.test(verdict(50).why), verdict(50).why);

// ---- 2. scope ---------------------------------------------------------------------------------------------------------------
for (const cls of ["Crypto", "FX", "Futures", "Options"]) ok(`${cls} at 50 bps passes`, verdict(50, { cls }) === null);
ok("a control twin passes", verdict(50, { ctrl: true }) === null && verdict(50, { ctrlRand: true }) === null);
ok("an existing veto shadow passes", verdict(50, { vetoShadow: true, ctrl: true }) === null && verdict(50, { vetoShadow: true }) === null);
ok("a sleeve ticket passes", verdict(50, { sleeve: "r316" }) === null);
ok("null / undefined ticket passes", G.evaluate(null, ON) === null && G.evaluate(undefined, ON) === null);

// ---- 3. the OFF switch ----------------------------------------------------------------------------------------------------
ok("OFF file present: everything passes", verdict(50, {}, OFF) === null && verdict(30, {}, OFF) === null);
{
  const d = tmp(), f = path.join(d, "cost-band-OFF");
  ok("real file: absent -> on", G.evaluate(tk(50), { offFile: f }) !== null && G.isOn({ offFile: f }) === true);
  fs.writeFileSync(f, ""); ok("real file: present (empty) -> off", G.evaluate(tk(50), { offFile: f }) === null && G.isOn({ offFile: f }) === false);
  fs.unlinkSync(f); ok("real file: deleted again -> on, no restart", G.evaluate(tk(50), { offFile: f }) !== null);
}
ok("the default OFF path is backend/data/cost-band-OFF beside the installed lib", G.OFF_FILE === path.join(PKG, "staged", "backend", "data", "cost-band-OFF"), G.OFF_FILE);

// ---- 4. the shadow ----------------------------------------------------------------------------------------------------------
{
  const t = tk(42.5), before = JSON.stringify(t), v = G.evaluate(t, ON), s = G.toShadow(t, v, Date.parse("2026-10-19T14:00:00Z"));
  ok("toShadow does not mutate the ticket", JSON.stringify(t) === before);
  ok("the shadow keeps the ticket's own fields", ["id", "cls", "sym", "dir", "entry", "stop", "stopDist", "addedAt", "strategy"].every((k) => s[k] === t[k]) && s.obs.clientStamp === "kept" && s.obs.spreadBps === 42.5);
  ok("the shadow is marked: ctrl, vetoShadow, veto, vetoWhy, vetoAt", s.ctrl === true && s.vetoShadow === true && s.veto === G.VETO && s.vetoWhy === v.why && s.vetoAt === "2026-10-19T14:00:00.000Z");
  ok("the shadow carries the band", s.costBand && s.costBand.loBps === 30 && s.costBand.hiBps === 100 && s.costBand.spreadBps === 42.5);
  ok("the shadow's obs is a copy", s.obs !== t.obs);
  let threw = false; try { G.toShadow(t, { test: "R49", veto: "R49 spread-gate 100bps" }); } catch { threw = true; }
  ok("toShadow refuses a verdict that is not COSTBAND", threw);
  // what the registered readers would make of it (r49-spread-gate.js shadow filter; lib/reconcile.js split on ctrl; r28-shadow-read.js)
  ok("R49's reader does not count it as an R49 shadow", !(s.vetoShadow && /R49/.test(s.veto || "")));
  ok("no other registered veto pattern matches it", !/R53|R28|STAMP/.test(s.veto) && !/\bR\d+\b/.test(s.veto));
  ok("lib/reconcile.js files it under controls, not signals", s.ctrl === true);
  ok("alpaca-mirror.js would not mirror it (filters ctrl and vetoShadow)", !( !s.ctrl && !s.vetoShadow));
}

// ---- 5. the documented wiring order: registered gates first, then the band -------------------------------------------------
{
  const registered = (t) => (t.cls === "Equity" && t.obs && Number.isFinite(t.obs.spreadBps) && t.obs.spreadBps > 100 ? { test: "R49", veto: "R49 spread-gate 100bps" } : (t.cls === "Equity" && !(t.obs && Number.isFinite(t.obs.spreadBps)) ? { test: "STAMP", veto: "STAMP" } : null));
  const wired = (t, o) => registered(t) || G.evaluate(t, o);
  ok("150 bps -> R49 (unchanged)", wired(tk(150), ON).test === "R49");
  ok("no stamp -> STAMP (unchanged)", wired(tk(undefined), ON).test === "STAMP");
  ok("50 bps -> COSTBAND", wired(tk(50), ON).test === "COSTBAND");
  ok("10 bps -> passes", wired(tk(10), ON) === null);
  ok("50 bps with the OFF file -> passes", wired(tk(50), OFF) === null);
  ok("150 bps with the OFF file -> still R49", wired(tk(150), OFF).test === "R49");
}

// ---- 6. deploy / rollback on a temp root ------------------------------------------------------------------------------------
{
  const root = tmp(), rel = "backend/lib/cost-band-gate.js", live = path.join(root, rel), quiet = () => {};
  fs.mkdirSync(path.join(root, "backend", "lib"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "backend", "lib", "run-window.js"), path.join(root, "backend", "lib", "run-window.js"));
  ok("plan on a fresh root reads base (absent)", P.stateOf(rel, root).state === "base" && P.run({ mode: "plan", root, nowMs: SAT, log: quiet }) === 0 && !fs.existsSync(live));
  ok("apply inside the fence (Wed 10:00 MT) is refused, nothing written", P.run({ mode: "apply", root, nowMs: WED10, log: quiet }) === 2 && !fs.existsSync(live));
  ok("apply on Saturday writes staged byte for byte", P.run({ mode: "apply", root, nowMs: SAT, log: quiet }) === 0 && fs.readFileSync(live).equals(fs.readFileSync(path.join(PKG, "staged", rel))));
  ok("apply after 16:00 MT on a weekday is allowed (second apply: nothing to do)", P.run({ mode: "apply", root, nowMs: WED17, log: quiet }) === 0 && P.stateOf(rel, root).state === "applied");
  const applied = loadCjs(live); ok("the applied file loads and refuses 50 bps", applied.evaluate(tk(50), ON).test === "COSTBAND");
  fs.appendFileSync(live, "// edited at home\n");
  ok("a drifted live file refuses apply and rollback, unchanged", P.run({ mode: "apply", root, nowMs: SAT, log: quiet }) === 2 && P.run({ mode: "rollback", root, nowMs: SAT, log: quiet }) === 2 && /edited at home/.test(fs.readFileSync(live, "utf8")));
  fs.writeFileSync(live, fs.readFileSync(path.join(PKG, "staged", rel)));
  ok("rollback inside the fence is refused", P.run({ mode: "rollback", root, nowMs: WED10, log: quiet }) === 2 && fs.existsSync(live));
  ok("rollback restores base: the new file is removed", P.run({ mode: "rollback", root, nowMs: SAT, log: quiet }) === 0 && !fs.existsSync(live) && P.stateOf(rel, root).state === "base");
  // fence edges (Wed 2026-10-14) and a holiday (Thanksgiving 2026-11-26, MST = UTC-7)
  ok("fence: 05:29 MT allowed, 05:30 refused, 15:59 refused, 16:00 allowed", P.fence(mt("2026-10-14T05:29:00"), root) === null && P.fence(mt("2026-10-14T05:30:00"), root) !== null && P.fence(mt("2026-10-14T15:59:00"), root) !== null && P.fence(mt("2026-10-14T16:00:00"), root) === null);
  ok("fence: a market holiday at 10:00 MT is allowed; the weekday after is not", P.fence(Date.parse("2026-11-26T10:00:00-07:00"), root) === null && P.fence(Date.parse("2026-11-27T10:00:00-07:00"), root) !== null);
  ok("fence: Saturday and Sunday allowed", P.fence(mt("2026-10-17T10:00:00"), root) === null && P.fence(mt("2026-10-18T10:00:00"), root) === null);
  ok("a failed check after the write puts the file back (exit 1, absent again)", P.run({ mode: "apply", root, nowMs: SAT, log: quiet, checkImpl: () => "fake syntax error" }) === 1 && !fs.existsSync(live) && P.stateOf(rel, root).state === "base");
  { const bad = path.join(root, "broken.js"), good = path.join(root, "good.js"); fs.writeFileSync(bad, "const = ;\n"); fs.writeFileSync(good, "module.exports = 1;\n");
    ok("the default node --check rejects a broken file and accepts a good one", P.nodeCheck(bad) !== null && P.nodeCheck(good) === null); }
  { // a copy of this package whose staged file is broken: run() with NO checkImpl must use node --check, fail and put the file back
    const pk = path.join(tmp(), "pkg"), broken = path.join(pk, "staged", rel);
    for (const f of ["pkg.cjs", "files.cjs", "loadcjs.cjs"]) { fs.mkdirSync(pk, { recursive: true }); fs.copyFileSync(path.join(PKG, f), path.join(pk, f)); }
    fs.mkdirSync(path.join(pk, "base", "backend", "lib"), { recursive: true }); fs.writeFileSync(path.join(pk, "base", rel + ".absent"), "");
    fs.mkdirSync(path.dirname(broken), { recursive: true }); fs.writeFileSync(broken, "const = ;\n");
    const P2 = require(path.join(pk, "pkg.cjs"));
    ok("apply with the default check refuses a broken staged file and leaves nothing behind", P2.run({ mode: "apply", root, nowMs: SAT, log: quiet }) === 1 && !fs.existsSync(live));
  }
  ok("apply with the default check succeeds on the staged file; rollback removes it", P.run({ mode: "apply", root, nowMs: SAT, log: quiet }) === 0 && P.run({ mode: "rollback", root, nowMs: SAT, log: quiet }) === 0 && !fs.existsSync(live));
  ok("the live repo itself is untouched by the selftest", !fs.existsSync(path.join(REPO, rel)));
}

// ---- 7. record.cjs on a temp root --------------------------------------------------------------------------------------------
{
  const root = tmp(), data = path.join(root, "backend", "data"), cr = path.join(data, "change-registry.json"), out = [];
  fs.mkdirSync(path.join(root, "backend", "lib"), { recursive: true }); fs.mkdirSync(data, { recursive: true });
  fs.copyFileSync(path.join(REPO, "backend", "lib", "run-window.js"), path.join(root, "backend", "lib", "run-window.js"));
  // atomic-write in the temp root: the real one, wrapped so the selftest can see that record.cjs used it
  fs.copyFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"), path.join(root, "backend", "lib", "atomic-write-real.js"));
  fs.writeFileSync(path.join(root, "backend", "lib", "atomic-write.js"), 'const R = require("./atomic-write-real.js"); module.exports = { ...R, writeJsonAtomic: (f, o, x) => { (globalThis.__CB_ATOMIC ||= []).push(f); return R.writeJsonAtomic(f, o, x); } };\n');
  loadCjs(path.join(REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic(cr, [{ id: "older-row", date: "2026-10-01" }]);
  const log = (s) => out.push(String(s)), rc = (argv, nowMs = SAT, o = {}) => R.main(argv, { root, nowMs, log, lockWaitMs: 1, lockTries: 2, ...o });
  ok("--dry prints the row and writes nothing", rc(["--dry"]) === 0 && /breaksComparability": true/.test(out.join("\n")) && JSON.parse(fs.readFileSync(cr, "utf8")).length === 1);
  ok("--apply without --restarted is refused", rc(["--apply"]) === 2);
  ok("--restarted must be a real date", rc(["--restarted", "2026-02-30", "--apply"]) === 2 && rc(["--restarted", "10/19/2026", "--dry"]) === 2);
  ok("--apply inside 13:50-15:50 MT on a trading day is refused", rc(["--restarted", "2026-10-14", "--apply"], WED14) === 2 && JSON.parse(fs.readFileSync(cr, "utf8")).length === 1);
  const said = (argv, nowMs) => { out.length = 0; const code = rc(argv, nowMs); return { code, text: out.join(" ") }; };
  const inWin = (r) => r.code === 2 && /no-registry-write window/.test(r.text) && !/after today/.test(r.text);
  const passedWin = (r) => r.code === 2 && /after today/.test(r.text) && !/no-registry-write window/.test(r.text);
  ok("window edges: 13:50 and 15:49 MT refuse for the window", inWin(said(["--restarted", "2026-10-21", "--apply"], mt("2026-10-14T13:50:00"))) && inWin(said(["--restarted", "2026-10-21", "--apply"], mt("2026-10-14T15:49:00"))));
  ok("window edges: 13:49 and 15:50 MT pass the window check", passedWin(said(["--restarted", "2026-10-21", "--apply"], mt("2026-10-14T13:49:00"))) && passedWin(said(["--restarted", "2026-10-21", "--apply"], mt("2026-10-14T15:50:00"))));
  ok("a market holiday at 14:00 MT is outside the window", passedWin(said(["--restarted", "2026-12-01", "--apply"], Date.parse("2026-11-26T14:00:00-07:00"))));
  ok("--restarted in the future is refused", rc(["--restarted", "2026-10-20", "--apply"]) === 2);
  fs.writeFileSync(path.join(data, "registry-write.lock"), "{}");
  ok("a held registry lock refuses and is left in place", rc(["--restarted", "2026-10-16", "--apply"]) === 2 && fs.existsSync(path.join(data, "registry-write.lock")));
  fs.unlinkSync(path.join(data, "registry-write.lock"));
  ok("--apply outside the window appends one row", rc(["--restarted", "2026-10-14", "--apply"], WED17) === 0);
  const c1 = JSON.parse(fs.readFileSync(cr, "utf8"));
  ok("the row: id, dates, breaksComparability, no test id", c1.length === 2 && c1[0].id === "older-row" && c1[1].id === "cost-band-refusal-2026-10-14" && c1[1].date === "2026-10-14" && c1[1].affectedFrom === "2026-10-14" && c1[1].breaksComparability === true && !/"testId"|"R\d+":/.test(JSON.stringify(c1[1])));
  ok("the row was written through atomic-write", (globalThis.__CB_ATOMIC || []).length === 1 && globalThis.__CB_ATOMIC[0] === cr);
  ok("a second --apply adds nothing", rc(["--restarted", "2026-10-17", "--apply"]) === 0 && JSON.parse(fs.readFileSync(cr, "utf8")).length === 2);
  ok("the lock is released", !fs.existsSync(path.join(data, "registry-write.lock")));
  ok("test-registry.json is never written", !fs.existsSync(path.join(data, "test-registry.json")));
}

// ---- 8. the package files ---------------------------------------------------------------------------------------------------
ok("base/ marks the gate file as absent", fs.existsSync(path.join(PKG, "base", "backend", "lib", "cost-band-gate.js.absent")));
ok("the live repo has no cost-band-gate.js yet (nothing was applied here)", !fs.existsSync(path.join(REPO, "backend", "lib", "cost-band-gate.js")));
ok("the gate makes no network or broker call", !/require\(["'](https?|net|tls|dns|child_process)["']\)|fetch\(|alpaca|broker/i.test(fs.readFileSync(path.join(PKG, "staged", "backend", "lib", "cost-band-gate.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")));

for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
if (fails.length) { console.log(`\nSELFTEST FAILED: ${fails.length} of ${n}\n  ` + fails.join("\n  ")); process.exit(1); }
console.log(`\nSELFTEST PASSED (${n} checks)`);
