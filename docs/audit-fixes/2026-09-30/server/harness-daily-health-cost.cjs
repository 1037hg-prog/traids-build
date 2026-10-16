#!/usr/bin/env node
// 2026-10-01 audit (cost#1/entry#1): read-only harness for the daily-health cost-sizing stamp line. Slices the check out of
// backend/daily-health.js (no report written, no other section run) and evaluates it against the live board + canonical ledger.
// Also runs it against a synthetic ledger with a NEW undisclosed miss to prove the line still FAILs, and with a throwing reader for UNKNOWN.
// Usage: node docs/audit-fixes/2026-09-30/server/harness-daily-health-cost.cjs
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..", "..", "..", ".."), B = path.join(ROOT, "backend");
const src = fs.readFileSync(path.join(B, "daily-health.js"), "utf8");
const a = src.indexOf("    // COST SIZING DEPLOY CHECK"), bTxt = "read as FAIL until it does`); }", b = src.indexOf(bTxt, a);
if (a < 0 || b < 0) { console.error("UNKNOWN: could not locate the cost-sizing block in daily-health.js"); process.exit(2); }
const block = src.slice(a, b + bTxt.length);
const D = (f) => path.join(B, "data", f);
const rdReal = (f, fb) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return fb; } };
const run = (label, rd, L2) => { const out = []; const say = (s) => out.push(s); new Function("rd", "L2", "say", block)(rd, L2, say); console.log(`[${label}]\n${out.join("\n")}\n`); return out.join("\n"); };
const L2 = require(path.join(B, "lib", "reconcile.js")).cleanEraLedger();
const live = run("live data", rdReal, L2);
// synthetic: one extra unstamped signal on an undisclosed session, with no server stamp that session -> FAIL, cause UNKNOWN
const fake = { id: "harness-1", cls: "Equity", openedAt: Date.parse("2026-10-05T14:00:00Z"), obs: {} };
const syn = run("synthetic new miss (2026-10-05)", rdReal, { ...L2, signals: [...L2.signals, fake] });
// synthetic: same session also has a server vetoAt row -> FAIL, lost after entry
const veto = { id: "harness-2", cls: "Equity", ctrl: true, vetoShadow: true, vetoAt: "2026-10-05T14:00:01Z", openedAt: Date.parse("2026-10-05T14:00:00Z"), obs: {} };
const syn2 = run("synthetic new miss + server vetoAt same session", rdReal, { ...L2, signals: [...L2.signals, fake], controls: [...L2.controls, veto] });
const thr = run("reader throws", rdReal, { get signals() { throw new Error("harness: ledger unreadable"); }, controls: [] });
const ok = /^\s+OK\s+cost sizing stamp/.test(live) && /disclosed unsized sessions: 2026-09-22 \(14, lost after entry/.test(live) && /2026-09-29 \(9, lost after entry/.test(live)
  && /^\s+FAIL cost sizing stamp.*2026-10-05: 1 missing, cause UNKNOWN/.test(syn) && /^\s+FAIL cost sizing stamp.*2026-10-05: 1 missing, lost after entry/.test(syn2) && /UNKNOWN cost sizing stamp check could not run/.test(thr);
console.log(ok ? "PASS — live line is OK with both disclosed sessions classified 'lost after entry'; a new miss FAILs; a reader error is UNKNOWN" : "FAIL — harness expectations not met");
process.exit(ok ? 0 : 1);
