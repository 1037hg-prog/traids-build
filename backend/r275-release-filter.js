#!/usr/bin/env node
/** R275 — release-day filter for the short-premium option sleeves (registered 2026-09-28 in register-r275.js; the registry wins).
 *  V1 0DTE: release sessions vs other sessions (session mean R, Welch t). V2 weekly wings: within-session exposed minus unexposed.
 *  One-sided: PASS needs t <= -2.006. Read once, sealed.   node backend/r275-release-filter.js */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), OUT = D("r275-release-filter.json");
const LO = "2024-08-19", HI = "2026-08-18", BAR = 2.006;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const vr = (a) => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); };
const tOne = (a) => (a.length > 2 ? mean(a) / Math.sqrt(vr(a) / a.length) : null);
const welch = (a, b) => (a.length > 1 && b.length > 1 ? (mean(a) - mean(b)) / Math.sqrt(vr(a) / a.length + vr(b) / b.length) : null);
const f = (x, d = 4) => (x == null ? null : +x.toFixed(d));

const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests.R275) { console.error("R275 already sealed — read-once"); process.exit(2); }
const cal = JSON.parse(fs.readFileSync(D("macro-calendar.json"), "utf8"));
const dates = (k) => new Set((cal[k] || []).map((x) => (typeof x === "string" ? x : x.date || x.d)).filter((d) => d && d >= LO && d <= HI));
const EV = { CPI: dates("CPI"), NFP: dates("NFP"), FOMC: dates("FOMC") };
const anyRelease = (d, types = ["CPI", "NFP", "FOMC"]) => types.some((k) => EV[k].has(d));

// ---- V1: 0DTE -------------------------------------------------------------------------------------------------
const z = JSON.parse(fs.readFileSync(D("r116-zero-dte-replay-wings.json"), "utf8"));
const zRows = (Array.isArray(z) ? z : Object.values(z)).filter((r) => r && r.day >= LO && r.day <= HI && Number.isFinite(r.R));
const bySess = new Map(); for (const r of zRows) { if (!bySess.has(r.day)) bySess.set(r.day, []); bySess.get(r.day).push(r); }
const sess = [...bySess.entries()].map(([d, rs]) => ({ d, R: mean(rs.map((r) => r.R)), pnl: rs.reduce((a, r) => a + (r.pnl || 0), 0), n: rs.length }));
const v1 = (types) => { const rel = sess.filter((s) => anyRelease(s.d, types)), oth = sess.filter((s) => !anyRelease(s.d, types));
  return { releaseSessions: rel.length, otherSessions: oth.length, releaseMeanR: f(mean(rel.map((s) => s.R))), otherMeanR: f(mean(oth.map((s) => s.R))), diff: f(mean(rel.map((s) => s.R)) - mean(oth.map((s) => s.R))), t: f(welch(rel.map((s) => s.R), oth.map((s) => s.R)), 3),
    releasePnl: Math.round(rel.reduce((a, s) => a + s.pnl, 0)), otherPnl: Math.round(oth.reduce((a, s) => a + s.pnl, 0)), sleeveMeanR_all: f(mean(sess.map((s) => s.R))), sleeveMeanR_skippingRelease: f(mean(oth.map((s) => s.R))) }; };
const V1 = v1(["CPI", "NFP", "FOMC"]);

// ---- V2: weekly wings -----------------------------------------------------------------------------------------
const wRows = fs.readFileSync(D("r21-archive-replay-wings.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.d >= LO && r.d <= HI && r.maxLoss > 0 && Number.isFinite(r.pnl) && r.expiry);
const exposedTo = (r, types) => { for (const k of types) for (const d of EV[k]) { if ((d > r.d || (k === "FOMC" && d === r.d)) && d <= r.expiry) return true; } return false; };
const v2 = (types) => { const bs = new Map(); for (const r of wRows) { const R = r.pnl / r.maxLoss, e = exposedTo(r, types); if (!bs.has(r.d)) bs.set(r.d, { e: [], u: [] }); bs.get(r.d)[e ? "e" : "u"].push({ R, pnl: r.pnl }); }
  const diffs = [], all = [], unexp = []; let ePnl = 0, uPnl = 0, eN = 0, uN = 0;
  for (const [, g] of bs) { if (g.e.length && g.u.length) diffs.push(mean(g.e.map((x) => x.R)) - mean(g.u.map((x) => x.R))); for (const x of g.e) { ePnl += x.pnl; eN++; all.push(x.R); } for (const x of g.u) { uPnl += x.pnl; uN++; all.push(x.R); unexp.push(x.R); } }
  return { exposedWings: eN, unexposedWings: uN, sessionsWithBoth: diffs.length, meanDiff: f(diffs.length ? mean(diffs) : null), t: f(tOne(diffs), 3), exposedPnl: Math.round(ePnl), unexposedPnl: Math.round(uPnl),
    wingMeanR_all: f(mean(all)), wingMeanR_unexposedOnly: f(unexp.length ? mean(unexp) : null) }; };
const V2 = v2(["CPI", "NFP", "FOMC"]);

const secondary = { V1_byType: { CPI: v1(["CPI"]), NFP: v1(["NFP"]), FOMC: v1(["FOMC"]) }, V2_byType: { CPI: v2(["CPI"]), NFP: v2(["NFP"]), FOMC: v2(["FOMC"]) } };
const pass1 = V1.t != null && V1.t <= -BAR, pass2 = V2.t != null && V2.t <= -BAR;
const verdict = `${pass1 || pass2 ? "PASSED" : "DID NOT PASS"} — one-sided bar t <= -${BAR}: V1 0DTE release minus other ${V1.diff}R/session, t ${V1.t} (${V1.releaseSessions} vs ${V1.otherSessions} sessions); V2 wings exposed minus unexposed ${V2.meanDiff}R, t ${V2.t} (${V2.sessionsWithBoth} sessions)`;
writeJsonAtomic(OUT, { test: "R275", readAt: new Date().toISOString(), window: [LO, HI], events: { CPI: EV.CPI.size, NFP: EV.NFP.size, FOMC: EV.FOMC.size }, verdict, V1, V2, secondary });
seals.tests = seals.tests || {}; seals.tests.R275 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "sessions; one-sided (release worse); best-of-2", verdict, output: "data/r275-release-filter.json" };
writeJsonAtomic(D("read-seals.json"), seals);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", tests: ["R275"], detail: verdict }) + "\n");
console.log(verdict); console.log(JSON.stringify({ V1, V2, secondary }, null, 1));
