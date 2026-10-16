#!/usr/bin/env node
// R295-V7R: guard.cjs (deploy.cjs / rollback.cjs) must apply the SAME rule as the staged runner's --resolve-overexit --apply guard.
// 1) et(), offset, etMs and chainSettled() in guard.cjs are byte-identical to the staged runner's (read as TEXT; the runner is never required);
// 2) the rule's case table on guard.cjs; 3) chainGuardNow() on scratch backend dirs with an injected process scan (no PowerShell, no network).
// Usage: node guard-parity.cjs [--staged-file <path>]
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const H = __dirname, PKG = path.resolve(H, ".."), arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const RUNNER = arg("--staged-file", path.join(PKG, "staged", "backend", "r295-orb-forward.js")), G = require(path.join(PKG, "guard.cjs"));
let pass = 0, fail = 0; const ok = (c, m, x) => { if (c) { pass++; console.log("  ok   " + m); } else { fail++; console.log("  FAIL " + m + (x !== undefined ? " :: " + JSON.stringify(x).slice(0, 400) : "")); } };
const grab = (s, start) => { const i = s.indexOf(start); if (i < 0) return null; if (start.startsWith("function")) return s.slice(i, s.indexOf("\n}\n", i) + 3); return s.slice(i, s.indexOf("\n", i) + 1); };
const rs = fs.readFileSync(RUNNER, "utf8"), gs = fs.readFileSync(path.join(PKG, "guard.cjs"), "utf8");
for (const k of ["function et(ms", "const offset = ", "const etMs = ", "function chainSettled("]) { const a = grab(rs, k), b = grab(gs, k); ok(a && a === b, `guard.cjs ${k.trim()}… is byte-identical to the staged runner's`); }
const at = (s) => Date.parse(s), ch = { started: "2026-10-05T20:15:00Z", finished: "2026-10-05T21:40:00Z" }, ch2 = { started: "2026-10-02T20:15:47Z", finished: "2026-10-02T21:37:31Z" };
const L5 = { date: "2026-10-05", reconciled: true }, C = (o) => G.chainSettled({ chain: ch, latest: L5, procs: [], nowMs: at("2026-10-05T22:00:00Z"), ...o }).ok;
ok(C({}), "Mon 18:00 ET, tonight's chain finished, R295 10-05 reconciled -> ok");
ok(!C({ procs: new Error("x") }) && !C({ procs: null }) && !C({ procs: ["node automation/close-chain.cjs"] }) && !C({ procs: ["node backend/r295-orb-forward.js --after-close --live"] }) && C({ procs: ["node backend/mnq-quote-paper.js"] }), "refuses: scan failed / close-chain.cjs / r295 --after-close visible; unrelated processes pass");
ok(!C({ chain: ch2 }) && !C({ latest: { date: "2026-10-05", reconciled: false } }) && !C({ chain: { started: ch.started } }) && !C({ chain: null }), "refuses: chain-status still the 10-02 run / 10-05 not reconciled / no finish / no file");
ok(!C({ chain: ch2, latest: { date: "2026-10-02", reconciled: true } }) && C({ nowMs: at("2026-10-06T09:00:00Z") }) && G.chainSettled({ chain: ch2, latest: { date: "2026-10-02", reconciled: true }, procs: [], nowMs: at("2026-10-03T16:00:00Z") }).ok, "weekday >= 16:00 ET needs today's chain; Tue 05:00 ET and Saturday pass on the last finished chain");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r295-guard-")), mkbk = (name, states, chain) => { const bk = path.join(tmp, name, "backend"), c = path.join(bk, "data", "training", "r295"); fs.mkdirSync(c, { recursive: true }); for (const [d, rec] of states) fs.writeFileSync(path.join(c, `session-${d}.json`), JSON.stringify(rec ? { date: d, reconciled: { date: d } } : { date: d })); if (chain) fs.writeFileSync(path.join(bk, "data", "chain-status.json"), JSON.stringify(chain)); return bk; };
{ const bk = mkbk("a", [["2026-10-02", true], ["2026-10-05", true], ["2026-10-06", false]], ch), r = G.chainGuardNow(bk, at("2026-10-05T22:00:00Z"), () => []);
  ok(r.ok && r.latest.date === "2026-10-05" && r.latest.reconciled, "chainGuardNow: newest session at or before today (a later-dated file ignored), reconciled -> ok", r); }
{ const bk = mkbk("b", [["2026-10-02", true], ["2026-10-05", false]], ch), r = G.chainGuardNow(bk, at("2026-10-05T22:00:00Z"), () => []);
  ok(!r.ok && /not reconciled/.test(r.why), "chainGuardNow: today's session not reconciled -> refused", r); }
{ const bk = mkbk("c", [["2026-10-05", true]], ch), r = G.chainGuardNow(bk, at("2026-10-05T22:00:00Z"), () => { throw new Error("powershell missing"); });
  ok(!r.ok && /process scan failed \(powershell missing\)/.test(r.why), "chainGuardNow: the scan throws -> refused (fail closed)", r); }
{ const bk = mkbk("d", [["2026-10-05", true]], null), r = G.chainGuardNow(bk, at("2026-10-05T22:00:00Z"), () => []);
  ok(!r.ok && /no finished run/.test(r.why), "chainGuardNow: no chain-status.json -> refused", r); }
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`r295 guard parity: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
