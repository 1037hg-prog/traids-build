#!/usr/bin/env node
/**
 * R36 — does the reader as FIRST committed (2026-08-21, git 0c29f43a5) give the same row as the reader as it stands?
 * The only difference that touches R36 between the two versions is the row filter: the first version took every graded
 * veto shadow with a finite rMult; from 2026-08-25 the reader also requires a finite pnl (the house rule of that date).
 * Read-only; writes only r36-reader-version-check.json beside itself.
 *
 *   node docs/reads/2026-10-11/R36/r36-reader-version-check.cjs
 */
const { execFileSync } = require("child_process");
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const git = (args) => execFileSync("git", args, { cwd: ROOT, maxBuffer: 1 << 29 }).toString();
const et = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const tOf = (rows) => { const by = {}; for (const r of rows) (by[et(r.openedAt)] ||= []).push(r.rMult); const m = Object.values(by).map(mean), k = m.length; if (k < 2) return { t: null, sessions: k }; const g = mean(m), sd = Math.sqrt(m.reduce((s, x) => s + (x - g) ** 2, 0) / (k - 1)); return { t: sd > 0 ? +(g / (sd / Math.sqrt(k))).toFixed(3) : null, sessions: k }; };
const row = (rows) => ({ n: rows.length, avgR: rows.length ? +mean(rows.map((r) => r.rMult)).toFixed(4) : null, ...tOf(rows) });
const asFirstCommitted = (log) => log.filter((r) => Number.isFinite(r.rMult) && r.closedAt && r.vetoShadow && et(r.openedAt) >= "2026-08-24").filter((r) => /R36/.test(r.veto || ""));
const asItStands = (log) => log.filter((r) => Number.isFinite(r.rMult) && Number.isFinite(r.pnl) && r.closedAt && r.vetoShadow).filter((r) => /R36/.test(r.veto || "") && et(r.openedAt) >= "2026-08-24");
const check = (log) => { const a = asFirstCommitted(log), b = asItStands(log); return { firstCommittedReader: row(a), readerAsItStands: row(b), rowsWithoutAFinitePnl: a.length - b.length, sameRow: JSON.stringify(row(a)) === JSON.stringify(row(b)) }; };
const out = {
  spec: "r36-reader-version-check", madeAt: new Date().toISOString(),
  readNight: { commit: "a732d72c8", ...check(JSON.parse(git(["show", "a732d72c8:backend/data/trade_log.json"]))) },
  tonight: check(JSON.parse(fs.readFileSync(path.join(ROOT, "backend", "data", "trade_log.json"), "utf8"))),
};
fs.writeFileSync(path.join(__dirname, "r36-reader-version-check.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
