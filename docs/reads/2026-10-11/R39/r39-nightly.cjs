#!/usr/bin/env node
/**
 * R39 — every committed version of the registered reader's output (backend/data/intraday-family.json), oldest first.
 * READ-ONLY on the repo: git show only. Writes r39-nightly.json beside this file.
 *   node docs/reads/2026-10-11/R39/r39-nightly.cjs [repo root]
 * For each nightly snapshot: asOf, evidence sessions, the reader's own stats per variant (sessions, signals, mean daily R, t), the
 * cost per side it used, its verdict line, and whether every session it had already sealed still carries the same numbers in
 * today's file (a sealed session is never re-graded). Then: the registered interim look (16 evidence sessions), the first night the
 * registered sample condition held (30 evidence sessions and >= 200 signals per variant), the night before, and every night since.
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process");
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, "..", "..", "..", ".."));
const STATE = "backend/data/intraday-family.json";
const { writeJsonAtomic } = require(path.join(ROOT, "backend", "lib", "atomic-write.js"));
const git = (args) => cp.execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
const BAR = { minSessions: 30, minSignals: 200, interimSessions: 16, interimKillT: -2.0 };
const NOW = JSON.parse(fs.readFileSync(path.join(ROOT, STATE), "utf8"));
const log = git(["log", "--format=%h|%ad|%cI|%s", "--date=short", "--", STATE]).trim().split("\n").reverse();
const barOf = (v) => { const m = /best-of-2 bar ([\d.]+)/.exec(String(v || "")); return m ? +m[1] : null; };
const nights = [];
for (const line of log) {
  const [commit, day, committedAt, subject] = line.split("|");
  let m; try { m = JSON.parse(git(["show", `${commit}:${STATE}`])); } catch (e) { nights.push({ commit, day, subject, unreadable: e.message.slice(0, 80) }); continue; }
  const ev = Object.keys(m.days || {}).filter((d) => d >= m.evidenceStart).sort();
  // every session sealed in this snapshot against the same session in today's file: n / win / avgR per variant
  const moved = [];
  for (const d of Object.keys(m.days || {})) {
    const a = m.days[d], b = (NOW.days || {})[d];
    if (!b) { moved.push(d + ": absent today"); continue; }
    for (const v of ["orb30", "vwapr"]) if (a[v].n !== b[v].n || a[v].win !== b[v].win || a[v].avgR !== b[v].avgR) moved.push(`${d} ${v}: ${a[v].n}/${a[v].win}/${a[v].avgR} then, ${b[v].n}/${b[v].win}/${b[v].avgR} today`);
    if (a.sealedAt !== b.sealedAt) moved.push(`${d}: sealedAt ${a.sealedAt} then, ${b.sealedAt} today`);
  }
  const s = m.stats || {};
  nights.push({ commit, day, committedAt, asOf: m.asOf, lastSession: ev[ev.length - 1] || null, evidenceSessions: m.evidenceSessions ?? ev.length, evidenceSessionsCounted: ev.length, costSidePct: m.costSidePct ?? null,
    orb30: s.orb30 || null, vwapr: s.vwapr || null, bar: barOf(m.verdict), verdict: m.verdict || null, sealedSessionsUnchangedToday: moved.length === 0, moved: moved.slice(0, 6) });
}
const ok = nights.filter((x) => !x.unreadable);
const cond = (x) => x.evidenceSessionsCounted >= BAR.minSessions && x.orb30 && x.vwapr && x.orb30.n >= BAR.minSignals && x.vwapr.n >= BAR.minSignals;
const iInterim = ok.findIndex((x) => x.evidenceSessionsCounted >= BAR.interimSessions);
const iFirst = ok.findIndex(cond);
const pick = (x) => x && { day: x.day, commit: x.commit, asOf: x.asOf, lastSession: x.lastSession, evidenceSessions: x.evidenceSessionsCounted, costSidePct: x.costSidePct, orb30: x.orb30, vwapr: x.vwapr, bar: x.bar, verdict: x.verdict };
const since = iFirst >= 0 ? ok.slice(iFirst) : [];
const between = iInterim >= 0 && iFirst >= 0 ? ok.slice(iInterim, iFirst) : [];
const rng = (a) => (a.length ? { min: Math.min(...a), max: Math.max(...a) } : null);
const out = {
  generatedAt: new Date().toISOString(), by: "docs/reads/2026-10-11/R39/r39-nightly.cjs", state: STATE, snapshots: nights.length, unreadable: nights.filter((x) => x.unreadable).length,
  everySealedSessionUnchangedToday: ok.every((x) => x.sealedSessionsUnchangedToday),
  interimLook: iInterim >= 0 ? { ...pick(ok[iInterim]), exactlyAtTheRegisteredLook: ok[iInterim].evidenceSessionsCounted === BAR.interimSessions,
    killed: ["orb30", "vwapr"].filter((v) => ok[iInterim][v] && ok[iInterim][v].t != null && ok[iInterim][v].t <= BAR.interimKillT) } : null,
  nightBeforeInterim: iInterim > 0 ? pick(ok[iInterim - 1]) : null,
  interimToRead: { nights: between.length, orb30T: rng(between.map((x) => x.orb30.t)), vwaprT: rng(between.map((x) => x.vwapr.t)), everyNightBothAtOrBelowKill: between.every((x) => x.orb30.t <= BAR.interimKillT && x.vwapr.t <= BAR.interimKillT) },
  firstMet: iFirst >= 0 ? { ...pick(ok[iFirst]), exactlyAtTheRegisteredSample: ok[iFirst].evidenceSessionsCounted === BAR.minSessions } : null,
  nightBefore: iFirst > 0 ? pick(ok[iFirst - 1]) : null,
  sinceFirstMet: { nights: since.length, orb30T: rng(since.map((x) => x.orb30.t)), vwaprT: rng(since.map((x) => x.vwapr.t)), bar: rng(since.map((x) => x.bar).filter((b) => b != null)),
    anyNightAVariantClears: since.some((x) => ["orb30", "vwapr"].some((v) => x[v].meanDailyR > 0 && x.bar != null && x[v].t >= x.bar && x[v].n >= BAR.minSignals)),
    anyNightAVariantPositive: since.some((x) => ["orb30", "vwapr"].some((v) => x[v].meanDailyR > 0)) },
  costSidePctByNight: ok.map((x) => [x.day, x.costSidePct]),
  nights,
};
writeJsonAtomic(path.join(__dirname, "r39-nightly.json"), out);
for (const x of nights) console.log(x.unreadable ? `${x.day} ${x.commit} UNREADABLE ${x.unreadable}` : `${x.day} ${x.commit} last ${x.lastSession || "—"} ev ${String(x.evidenceSessionsCounted).padStart(2)} cost ${x.costSidePct}% | orb30 n ${x.orb30 && x.orb30.n} mR ${x.orb30 && x.orb30.meanDailyR} t ${x.orb30 && x.orb30.t} | vwapr n ${x.vwapr && x.vwapr.n} mR ${x.vwapr && x.vwapr.meanDailyR} t ${x.vwapr && x.vwapr.t} | ${x.sealedSessionsUnchangedToday ? "sealed=today" : "MOVED " + x.moved.join("; ")} | ${String(x.verdict).slice(0, 90)}`);
console.log("\ninterim look:", JSON.stringify(out.interimLook, null, 1), "\nnight before interim:", JSON.stringify(out.nightBeforeInterim), "\ninterim -> read:", JSON.stringify(out.interimToRead),
  "\nfirst met:", JSON.stringify(out.firstMet, null, 1), "\nnight before:", JSON.stringify(out.nightBefore), "\nsince:", JSON.stringify(out.sinceFirstMet), "\nevery sealed session unchanged today:", out.everySealedSessionUnchangedToday);
