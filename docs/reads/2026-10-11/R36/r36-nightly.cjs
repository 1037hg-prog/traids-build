#!/usr/bin/env node
/**
 * R36 — the registered reader's own row (data/filter-shadows.json, filters.R36) on every nightly snapshot in git,
 * and the working file. Read-only; writes only r36-nightly.json beside itself.
 *
 * What it settles:
 *   - the registered interim look (kill-only: t >= +2.0 from 16 sessions) — did it ever fire?
 *   - the READ NIGHT: the first night the reader's row held the whole registered sample (>= 30 sessions AND >= 60 shadows)
 *   - every night since (post-seal, weightless), and whether the choice of night could move the verdict
 *
 *   node docs/reads/2026-10-11/R36/r36-nightly.cjs
 */
const { execFileSync } = require("child_process");
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const ID = "R36", MIN_SESSIONS = 30, MIN_SHADOWS = 60, INTERIM_SESSIONS = 16, INTERIM_KILL_T = 2.0, T_CONFIRM = -2.0;
const git = (args) => execFileSync("git", args, { cwd: ROOT, maxBuffer: 1 << 28 }).toString();
const commits = git(["log", "--format=%h|%ad|%s", "--date=iso-strict", "--", "backend/data/filter-shadows.json"]).trim().split("\n")
  .map((l) => { const [h, d, s] = l.split("|"); return { h, d, s }; }).reverse();
const rows = [];
for (const c of commits) {
  let j; try { j = JSON.parse(git(["show", `${c.h}:backend/data/filter-shadows.json`])); } catch { continue; }
  const f = (j.filters || {})[ID]; if (!f) continue;
  rows.push({ commit: c.h, committed: c.d, snapshot: (c.s.match(/\d{4}-\d{2}-\d{2}/) || [null])[0], asOf: j.asOf, sessions: f.sessions, n: f.n, avgR: f.avgR, t: f.t, win: f.win, pnl: f.pnl, readerLine: String(f.verdict || "") });
}
const cur = JSON.parse(fs.readFileSync(path.join(ROOT, "backend", "data", "filter-shadows.json"), "utf8")), cf = cur.filters[ID];
const worktree = { commit: "WORKTREE", committed: null, snapshot: "tonight", asOf: cur.asOf, sessions: cf.sessions, n: cf.n, avgR: cf.avgR, t: cf.t, win: cf.win, pnl: cf.pnl, readerLine: String(cf.verdict || "") };
const lastCommitted = rows[rows.length - 1];
const worktreeSameAsLastSnapshot = !!lastCommitted && lastCommitted.asOf === worktree.asOf;
if (!worktreeSameAsLastSnapshot) rows.push(worktree);

const met = (r) => r.sessions >= MIN_SESSIONS && r.n >= MIN_SHADOWS;
const branch = (r) => !met(r) ? "sample not met" : (r.avgR < 0 && r.t <= T_CONFIRM) ? "CONFIRMED (avgR < 0 and t <= -2.0)" : r.t > 0 ? "RETIRE (t > 0 at >= 30 sessions)" : "neither registered branch (-2.0 < t <= 0)";
const interimWindow = rows.filter((r) => r.sessions >= INTERIM_SESSIONS && r.sessions < MIN_SESSIONS);
const readNight = rows.find(met) || null, ri = readNight ? rows.indexOf(readNight) : -1;
const since = ri >= 0 ? rows.slice(ri + 1) : [];
const metNights = ri >= 0 ? rows.slice(ri) : [];
const out = {
  spec: "r36-nightly", madeAt: new Date().toISOString(),
  source: "git show <commit>:backend/data/filter-shadows.json (filters.R36), one row per nightly snapshot" + (worktreeSameAsLastSnapshot ? "; the working file is the last snapshot (same asOf)" : "; then the working file"),
  bar: { minSessions: MIN_SESSIONS, minShadows: MIN_SHADOWS, confirm: "avgR < 0 AND t <= -2.0", retire: "t > 0 at >= 30 sessions", interim: "kill-only: t >= +2.0 from 16 sessions" },
  interim: {
    firstNightAt16: rows.find((r) => r.sessions >= INTERIM_SESSIONS) || null, nights: interimWindow.length,
    minT: interimWindow.length ? Math.min(...interimWindow.map((r) => r.t)) : null, maxT: interimWindow.length ? Math.max(...interimWindow.map((r) => r.t)) : null,
    fired: interimWindow.some((r) => r.t >= INTERIM_KILL_T),
  },
  readNight: readNight ? { ...readNight, branch: branch(readNight) } : null,
  nightBefore: ri > 0 ? { ...rows[ri - 1], conditionMet: met(rows[ri - 1]) } : null,
  everyNightWithTheSample: metNights.map((r) => ({ snapshot: r.snapshot, commit: r.commit, sessions: r.sessions, n: r.n, avgR: r.avgR, t: r.t, pnl: r.pnl, branch: branch(r), readerLine: r.readerLine })),
  nightsSince: since.length,
  anyNightConfirms: metNights.some((r) => r.avgR < 0 && r.t <= T_CONFIRM),
  everyNightRetires: metNights.every((r) => r.t > 0),
  theChoiceOfNightCanMoveTheBranch: new Set(metNights.map(branch)).size > 1,
  worktree, worktreeSameAsLastSnapshot,
  rows,
};
fs.writeFileSync(path.join(__dirname, "r36-nightly.json"), JSON.stringify(out, null, 1));
for (const r of rows) console.log([r.commit.padEnd(9), String(r.snapshot).padEnd(10), "S", String(r.sessions).padStart(2), "n", String(r.n).padStart(3), "avgR", String(r.avgR).padStart(7), "t", String(r.t).padStart(6), "$", String(r.pnl).padStart(6), "|", r.readerLine.slice(0, 72)].join(" "));
console.log("interim (kill-only, t >= +2 from 16 sessions): nights", out.interim.nights, "t", out.interim.minT, "to", out.interim.maxT, "fired", out.interim.fired);
console.log("READ NIGHT (first night with >= 30 sessions and >= 60 shadows):", JSON.stringify(out.readNight));
console.log("night before:", JSON.stringify(out.nightBefore && { snapshot: out.nightBefore.snapshot, sessions: out.nightBefore.sessions, n: out.nightBefore.n, t: out.nightBefore.t, conditionMet: out.nightBefore.conditionMet }));
for (const r of out.everyNightWithTheSample) console.log("  with the sample:", r.snapshot, "S", r.sessions, "n", r.n, "t", r.t, "->", r.branch);
console.log("any night confirms:", out.anyNightConfirms, "| every night retires:", out.everyNightRetires, "| choice of night can move the branch:", out.theChoiceOfNightCanMoveTheBranch);
console.log("written: docs/reads/2026-10-11/R36/r36-nightly.json");
