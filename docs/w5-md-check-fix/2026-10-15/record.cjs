#!/usr/bin/env node
"use strict";
/**
 * W5 MD CHECK FIX (2026-10-15) — RECORD the fix: ONE change-registry row and ONE agent-ledger GOVERNANCE line. No registry entry, rule,
 * bar, population or read condition of any test changes (the fix is in a home-only cutover tool), so test-registry.json is never touched.
 *
 *   node docs/w5-md-check-fix/2026-10-15/record.cjs --dry    print the two records and whether the write would go through; write nothing,
 *                                                            take no lock (exit 0 unless a file cannot be read)
 *   node docs/w5-md-check-fix/2026-10-15/record.cjs          write them — the main session's command, AFTER deploy.cjs --apply
 *
 * REFUSED, nothing written: between 13:50 and 15:50 MT on a trading day (Mon-Fri, not a market holiday: the close chain owns these files
 *   then) · while the live docs/server/wave5-board/deploy.cjs is not the staged copy (deploy.cjs --apply first: a fix is recorded after
 *   it is in) · a PART of the record already there (both there: "already recorded", exit 0) · backend/data/registry-write.lock held by
 *   another writer for more than 120 s (created with flag wx; another writer's lock is never removed).
 * WRITES, under that lock, in this order: change-registry.json through backend/lib/atomic-write.js writeJsonAtomic (read back), then one
 *   line appended to agent-ledger.jsonl (read back). A failure after the first write says what is still owed.
 * Exit 0 written / already recorded / dry · 1 failed after a write · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const D = require("./deploy.cjs");
let HOLIDAYS = {}; try { HOLIDAYS = require(path.join(D.REPO, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS || {}; } catch { HOLIDAYS = {}; }
const CR_ID = "w5-md-check-fix-2026-10-15", LOCK_WAIT_MS = 120000;
/** the nine W5 units (docs/server/wave5-board/manifests.cjs WAVE_UNITS; the selftest holds the two equal): they cut over together */
const UNITS = ["w5-board", "w5-yahoo", "w5-open", "w5-intraday", "w5-zerodte", "w5-options", "w5-preclose", "w5-chain", "w5-evening"];
class Refuse extends Error {}
const refuse = (m) => { throw new Refuse(m); };

/** the MT clock: no write to these files 13:50-15:50 MT on a trading day (Mon-Fri, not a market holiday) */
function mtClock(nowMs, holidays = HOLIDAYS) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hourCycle: "h23", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  const hh = +p.hour % 24, hm = hh * 60 + +p.minute, mtDate = `${p.year}-${p.month}-${p.day}`;
  const dow = new Date(mtDate + "T12:00:00Z").getUTCDay(), tradingDay = dow >= 1 && dow <= 5 && !holidays[mtDate];
  return { mtDate, hhmm: `${String(hh).padStart(2, "0")}:${p.minute}`, tradingDay, inWindow: tradingDay && hm >= 13 * 60 + 50 && hm < 15 * 60 + 50 };
}
/** the two records, from the package's own facts */
function records({ nowMs, mtDate }) {
  const at = new Date(nowMs).toISOString(), files = { [D.LIVE_REL]: { before: D.BASE_SHA, after: D.STAGED_SHA } };
  const row = { id: CR_ID, date: mtDate, recordedAt: at, units: UNITS,
    area: "server — W5 cutover tool (docs/server/wave5-board/deploy.cjs, home only): the Schwab market-data token check of --cutover w5 and its --without-schwab message", category: "defect fix", breaksComparability: false,
    change: `The remote token check that --cutover w5 runs on the VPS (MD_JS, run as \`cd /home/traids/traids/backend && node -e <MD_JS>\`) now passes the real tree's ABSOLUTE path to w5-run.cjs mdTokenState (backend: process.cwd()) instead of ".". The message printed with --without-schwab now says what the VPS units will do: when the reader refuses the token, the steps that read Schwab are REFUSED until it is usable; when the reader accepts a token under the cutover's 24 h floor, they RUN until it expires; when W2b's env file is there but the check cannot read it (EACCES: systemd reads it as root), it cannot be told. When W2b's env file holds a name the reader refuses (a trading-app name), the cutover now REFUSES even with --without-schwab: every fire of the six units that load that file would be refused (w5-run.cjs forbiddenEnv), not only the Schwab steps. Three lines of ${D.LIVE_REL} changed (${D.DOC.line} the header's words on --without-schwab, ${D.FIX.line} the fix, ${D.MSG.line} the message); every other byte is the same. docs/server/wave5-board/backend/w5-run.cjs and every file on the VPS are unchanged.`,
    why: "Found 2026-10-15 by the W3 fix's build (docs/w3-md-check-fix/2026-10-14/NOTES.md, 'Owed (1)'): mdTokenState require()s path.join(backend, 'lib', 'schwab-md.js'), and from '.' that is 'lib/schwab-md.js', which require() resolves as a package name in node_modules, never as the file. So --cutover w5 would have refused on every VPS whatever the token's state ('not installed in this tree'), and with --without-schwab its message said the Schwab steps would be refused while the units, which pass an absolute path, would run them. Reproduced offline (docs/w5-md-check-fix/2026-10-15/selftest.cjs). Not hit in use: the W5 cutover has not been run.",
    doesNotChange: "Any registered rule, bar, population, statistic or read condition; any step a W5 unit runs (the units already pass an absolute path); the cutover's other guards and its 24 h floor; anything on the VPS. The check still refuses a reader that is missing and a token that is missing, issued to another key, expired or under 24 h of refresh life.",
    operator: `assistant (main session), package ${D.PKG_REL}`, files, package: D.PKG_REL, rollback: `node ${D.PKG_REL}/rollback.cjs --plan, then --apply` };
  const line = { at, agent: "assistant", kind: "GOVERNANCE", target: "W5 cutover tool — the Schwab market-data token check (docs/server/wave5-board/deploy.cjs)", what: `The remote token check of --cutover w5 now passes the real tree's absolute path, and the --without-schwab message says what the units will do; a name the reader refuses in W2b's env file refuses the cutover even with --without-schwab (three lines; no test's rule changes). Change-registry row: ${CR_ID}. Rollback: node ${D.PKG_REL}/rollback.cjs --plan.`, changeRegistry: CR_ID };
  return { row, line };
}
function takeLock(lockFile, { waitMs = LOCK_WAIT_MS, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), now = () => Date.now(), log = () => {} } = {}) {
  const token = `${process.pid}-${now()}-${crypto.randomBytes(4).toString("hex")}`, t0 = now(); let told = false;
  for (;;) {
    let fd;
    try { fd = fs.openSync(lockFile, "wx"); }
    catch (e) {
      if (e.code !== "EEXIST") refuse(`cannot create the lock file ${lockFile} (${e.code || e.message}) — nothing written`);
      if (now() - t0 >= waitMs) refuse(`${path.basename(lockFile)} was held by another writer for more than ${Math.round(waitMs / 1000)} s — nothing written; it is never removed here: re-run when it is gone`);
      if (!told) { log(`the registry lock is held by another writer — waiting up to ${Math.round(waitMs / 1000)} s`); told = true; }
      sleep(1000); continue;
    }
    try { fs.writeSync(fd, JSON.stringify({ token, pid: process.pid, by: `${D.PKG_REL}/record.cjs`, id: CR_ID, at: new Date(now()).toISOString() }) + "\n"); } finally { fs.closeSync(fd); }
    return { release() { try { const j = JSON.parse(fs.readFileSync(lockFile, "utf8")); if (j.token === token) fs.unlinkSync(lockFile); } catch { /* gone, or not ours: left alone */ } } };
  }
}
const present = ({ cr, ledgerText }) => ({ row: cr.some((r) => r && r.id === CR_ID), line: ledgerText.split("\n").some((l) => l.includes(`"changeRegistry":"${CR_ID}"`) && l.includes('"kind":"GOVERNANCE"')) });

/** dry or write -> { code, result, lines } (never throws on a refusal). writeJson / appendLedger: the selftest injects stand-ins; the defaults are
 *  backend/lib/atomic-write.js writeJsonAtomic and fs.appendFileSync */
function run({ dataDir = path.join(D.REPO, "backend", "data"), root = D.REPO, pkg = D.PKG, dry = false, now = () => Date.now(), holidays = HOLIDAYS, lockWaitMs = LOCK_WAIT_MS, sleep, log = (s) => console.log(s), writeJson = null, appendLedger = (f, s) => fs.appendFileSync(f, s) } = {}) {
  const lines = [], say = (s) => { lines.push(s); log(s); };
  const crFile = path.join(dataDir, "change-registry.json"), ledgerFile = path.join(dataDir, "agent-ledger.jsonl"), lockFile = path.join(dataDir, "registry-write.lock");
  const load = () => {
    let cr, ledgerText;
    try { cr = JSON.parse(fs.readFileSync(crFile, "utf8")); } catch (e) { refuse(`change-registry.json cannot be read (${e.code || e.message}) — nothing written`); }
    if (!Array.isArray(cr)) refuse("change-registry.json is not a list — nothing written");
    try { ledgerText = fs.readFileSync(ledgerFile, "utf8"); } catch (e) { refuse(`agent-ledger.jsonl cannot be read (${e.code || e.message}) — nothing written`); }
    return { cr, ledgerText };
  };
  try {
    const c0 = mtClock(now(), holidays), P = D.plan({ root, pkg }), R = records({ nowMs: now(), mtDate: c0.mtDate });
    say(`clock: ${c0.mtDate} ${c0.hhmm} MT, ${c0.tradingDay ? "a trading day" : "not a trading day"}${c0.inWindow ? " (INSIDE the 13:50-15:50 MT no-write window)" : ""}${dry ? " — --dry: nothing is written, no lock is taken" : ""}`);
    const f0 = load(), have = present(f0), why = [];
    if (c0.inWindow) why.push("inside the 13:50-15:50 MT no-write window on a trading day (the close chain owns these files then) — run it after 15:50 MT");
    if (P.state !== "applied") why.push(`the live ${D.LIVE_REL} is ${P.state.toUpperCase()}, not the staged copy — the fix is recorded after it is in: node ${D.PKG_REL}/deploy.cjs --apply first`);
    say(`home: ${D.LIVE_REL} ${P.state} (${String(P.liveSha).slice(0, 12)})`);
    say(`already there: change-registry row ${have.row ? "YES" : "no"} · ledger line ${have.line ? "YES" : "no"}`);
    say("change-registry.json row:"); say(JSON.stringify(R.row, null, 1));
    say("agent-ledger.jsonl line:"); say(JSON.stringify(R.line));
    if (have.row && have.line) { say("ALREADY RECORDED — both are there; nothing to do, nothing written"); return { code: 0, result: "already", lines }; }
    if (have.row || have.line) why.push(`a PART of this record is there already (${have.row ? "the row" : "the line"}) — look at the two files before anything is written`);
    if (dry) { say(why.length ? `DRY — nothing written. The write would be REFUSED now:\n  - ${why.join("\n  - ")}` : "DRY — nothing written, no lock taken. The write would add the two records above."); return { code: 0, result: "dry", lines, wouldRefuse: why }; }
    if (why.length) refuse(why.join("; "));

    const lock = takeLock(lockFile, { waitMs: lockWaitMs, sleep, now, log: say });   // the same clock as the rest of the run: the wait bound is measured on it
    let stage = "nothing written";
    try {
      const c = mtClock(now(), holidays); if (c.inWindow) refuse("the clock entered the 13:50-15:50 MT no-write window while this waited for the lock — nothing written");
      const f = load(), h = present(f); if (h.row || h.line) refuse(`a part of this record appeared while this ran (${h.row ? "the row" : "the line"}) — nothing written`);
      const writeJsonAtomic = writeJson || require(path.join(D.REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic;   // the house writer (the files it writes are the ones named above)
      const n0 = f.cr.length; writeJsonAtomic(crFile, [...f.cr, R.row]); stage = "change-registry.json is written";
      { const back = JSON.parse(fs.readFileSync(crFile, "utf8")); if (back.length !== n0 + 1 || back[n0].id !== CR_ID) throw new Error("change-registry.json does not read back as written"); }
      stage = "the change-registry row is written";
      appendLedger(ledgerFile, (f.ledgerText.length && !f.ledgerText.endsWith("\n") ? "\n" : "") + JSON.stringify(R.line) + "\n"); stage = "both are written";
      { const tail = fs.readFileSync(ledgerFile, "utf8").trimEnd().split("\n").pop(); let ok = false; try { ok = JSON.parse(tail).changeRegistry === CR_ID; } catch { ok = false; } if (!ok) throw new Error("the ledger line does not read back as written"); }
      say(`WRITTEN: change-registry.json +1 row (${CR_ID}); agent-ledger.jsonl +1 GOVERNANCE line. Each read back.`);
      return { code: 0, result: "written", lines };
    } catch (e) {
      if (stage === "nothing written" || e instanceof Refuse) throw e;
      const owed = stage === "change-registry.json is written" ? "the change-registry row (change-registry.json did not read back with it as its last entry: look at that file first) and the GOVERNANCE line in agent-ledger.jsonl"
        : stage === "the change-registry row is written" ? "the GOVERNANCE line in agent-ledger.jsonl" : "nothing (check the ledger's last line)";
      say(`${stage}, then FAILED (${e.message}). Still owed by hand: ${owed} — the record printed above is the one to add.`);
      return { code: 1, result: "failed", lines };
    } finally { lock.release(); }
  } catch (e) {
    if (!(e instanceof Refuse)) throw e;
    say(`REFUSED — nothing written: ${e.message}`);
    return { code: 2, result: "refused", lines };
  }
}

module.exports = { run, records, mtClock, present, takeLock, CR_ID, UNITS, Refuse };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (!(a.length === 0 || (a.length === 1 && a[0] === "--dry"))) { console.log(`usage: node ${D.PKG_REL}/record.cjs [--dry]\nNothing was done.`); process.exit(2); }
  let r; try { r = run({ dry: a[0] === "--dry" }); } catch (e) { console.error(`record FAILED: ${e && e.stack ? e.stack : e}`); process.exit(1); }
  process.exit(r.code);
}
