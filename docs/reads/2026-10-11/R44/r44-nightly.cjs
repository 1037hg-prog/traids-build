#!/usr/bin/env node
/**
 * R44 — every committed version of the registered reader's output (backend/data/exposure-alpha.json), oldest first.
 * READ-ONLY on the repo: git show only. Writes r44-nightly.json beside this file.
 *   node docs/reads/2026-10-11/R44/r44-nightly.cjs [repo root]
 * For each nightly snapshot: asOf, cells tracked, the READABLE cells (>= 30 signal-days and >= 60 tickets) with the reader's own
 * alpha, t and Benjamini-Hochberg flag, the reader's best-of-N bar and verdict. Then: the first night the registered per-cell
 * sample condition held for any cell, the night before, and whether any night since reads differently.
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process");
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, "..", "..", "..", ".."));
const STATE = "backend/data/exposure-alpha.json";
const { writeJsonAtomic } = require(path.join(ROOT, "backend", "lib", "atomic-write.js"));
const git = (args) => cp.execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const log = git(["log", "--format=%h|%ad|%s", "--date=short", "--", STATE]).trim().split("\n").reverse();
const BAR = { minDays: 30, minN: 60 };
const nights = [];
for (const line of log) {
  const [commit, day, subject] = line.split("|");
  let m; try { m = JSON.parse(git(["show", `${commit}:${STATE}`])); } catch (e) { nights.push({ commit, day, subject, unreadable: e.message.slice(0, 80) }); continue; }
  const cells = m.cells || [];
  const readable = cells.filter((c) => c.readable).map((c) => ({ cell: c.cell, n: c.n, days: c.days, meanR: c.meanR, netExposure: c.netExposure, alpha: c.alpha, beta: c.beta, tAlpha: c.tAlpha, p: c.p == null ? null : +c.p.toFixed(4), bhPass: !!c.bhPass, concentrated: !!c.concentrated, top2DayShareOfAbsRPct: c.top2DayShareOfAbsRPct }));
  // the condition recomputed from the cell rows, independently of the reader's own flag
  const mine = cells.filter((c) => c.days >= BAR.minDays && c.n >= BAR.minN).map((c) => c.cell).sort();
  const flagAgrees = JSON.stringify(mine) === JSON.stringify(readable.map((c) => c.cell).sort());
  const honestBar = m.honestBar ?? null;
  const clears = readable.filter((c) => c.bhPass && c.alpha > 0 && honestBar != null && Math.abs(c.tAlpha) >= honestBar).map((c) => c.cell);
  nights.push({ commit, day, asOf: m.asOf, inEvidence: m.inEvidence, cellsTracked: m.cellsTracked ?? cells.length, readableCells: m.readableCells ?? readable.length, readableByMyCount: mine.length, flagAgrees,
    honestBar, readable, survivors: m.survivors || [], clearsRecomputed: clears, verdict: m.verdict,
    maxAbsT: readable.length ? Math.max(...readable.map((c) => Math.abs(c.tAlpha))) : null, maxPositiveAlphaT: readable.filter((c) => c.alpha > 0).length ? Math.max(...readable.filter((c) => c.alpha > 0).map((c) => c.tAlpha)) : null });
}
const ok = nights.filter((x) => !x.unreadable);
const firstIdx = ok.findIndex((x) => x.inEvidence && x.readableByMyCount >= 1);
const first = firstIdx >= 0 ? ok[firstIdx] : null, before = firstIdx > 0 ? ok[firstIdx - 1] : null, since = firstIdx >= 0 ? ok.slice(firstIdx) : [];
const out = {
  generatedAt: new Date().toISOString(), by: "docs/reads/2026-10-11/R44/r44-nightly.cjs", state: STATE, snapshots: nights.length, unreadable: nights.filter((x) => x.unreadable).length,
  everyReaderFlagAgreesWithTheCellRows: ok.every((x) => x.flagAgrees),
  firstMet: first ? { day: first.day, commit: first.commit, asOf: first.asOf, readableCells: first.readableByMyCount, honestBar: first.honestBar, readable: first.readable, survivors: first.survivors, verdict: first.verdict } : null,
  nightBefore: before ? { day: before.day, commit: before.commit, asOf: before.asOf, readableCells: before.readableByMyCount, verdict: before.verdict, closest: null } : null,
  sinceFirstMet: { nights: since.length, anyNightWithASurvivor: since.some((x) => (x.survivors || []).length > 0 || x.clearsRecomputed.length > 0), readableCellsMin: Math.min(...since.map((x) => x.readableByMyCount)), readableCellsMax: Math.max(...since.map((x) => x.readableByMyCount)),
    honestBarMin: Math.min(...since.map((x) => x.honestBar)), honestBarMax: Math.max(...since.map((x) => x.honestBar)), maxPositiveAlphaT: Math.max(...since.map((x) => x.maxPositiveAlphaT ?? -Infinity)), maxAbsT: Math.max(...since.map((x) => x.maxAbsT ?? 0)),
    anyBhPass: since.some((x) => x.readable.some((c) => c.bhPass)) },
  nights,
};
writeJsonAtomic(path.join(__dirname, "r44-nightly.json"), out);
for (const x of nights) console.log(x.unreadable ? `${x.day} ${x.commit} UNREADABLE ${x.unreadable}` : `${x.day} ${x.commit} inEv ${x.inEvidence ? "Y" : "n"} tracked ${String(x.cellsTracked).padStart(2)} readable ${x.readableByMyCount} bar ${x.honestBar ?? "—"} | ${x.readable.map((c) => `${c.cell} n${c.n} d${c.days} a${c.alpha} t${c.tAlpha}${c.bhPass ? " BH" : ""}`).join(" ; ")} | ${x.verdict}`);
console.log("\nfirst met:", JSON.stringify(out.firstMet, null, 1), "\nnight before:", JSON.stringify(out.nightBefore), "\nsince:", JSON.stringify(out.sinceFirstMet), "\nflags agree:", out.everyReaderFlagAgreesWithTheCellRows);
