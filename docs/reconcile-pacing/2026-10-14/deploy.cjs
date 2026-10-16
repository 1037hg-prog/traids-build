#!/usr/bin/env node
"use strict";
/**
 * RECONCILE PACING (2026-10-14) — DEPLOY the paced backend/alpaca-reconcile.js: every broker call through one limiter, a failed call
 * retried with backoff inside a time budget, and a call that still fails written as UNKNOWN for its ticket, never "no record".
 *
 * WHAT IT SHIPS: ONE file, backend/alpaca-reconcile.js, from staged/ (base/ holds the bytes it replaces). NOTES.md says what changed and
 * how it was proven; selftest.cjs proves it (the replay of the recorded night: every answered row byte for byte the same).
 *
 *   node docs/reconcile-pacing/2026-10-14/deploy.cjs --plan    READ-ONLY. The file's sha256 at home NOW, the one this package was BUILT
 *                                                              AGAINST (base) and the STAGED one, its state (base = to apply · applied ·
 *                                                              DRIFT = neither: refused), the fences now (the clock, chain-status.json and
 *                                                              the node process list, all read-only), and tonight's call forecast from
 *                                                              the mirror's logs. Nothing is written.
 *   node docs/reconcile-pacing/2026-10-14/deploy.cjs --apply   the write mode — the main session's command. In order:
 *     1. the file reads base or applied (DRIFT -> refused, nothing written); the package's own base and staged copies are the bytes it
 *        was built with
 *     2. the fences (any one refuses, nothing written): a trading weekday (Mon-Fri, not a market holiday) between 05:30 and 16:00 MT;
 *        tonight's close chain due or running (a session day past 16:00 ET whose chain-status.json is not a finished run started today,
 *        or a node process running automation/close-chain.cjs); backend/alpaca-reconcile.js running (a node process running it); a
 *        process list that cannot be read (fail-closed)
 *     3. this package's selftest must end "ALL ... CHECKS PASSED"; then the fences are asked again
 *     4. the file is written from staged (temp file + rename), read back by sha256, then node --check; any failure puts the bytes that
 *        were there back
 * It never restarts anything (the close chain starts a new process for the step each night), never touches the VPS (the reconcile runs
 * at home only: its chain line is W3's anchor and W5's split keeps it home), never writes change-registry.json or agent-ledger.jsonl
 * (record.cjs does that, after verify-live.cjs), and keeps no state file: home's bytes are the state.
 * Exit 0 applied (or nothing to apply) · 1 failed (the headline says what holds) · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", ".."), PKG_REL = "docs/reconcile-pacing/2026-10-14";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let HOLIDAYS = {}; try { HOLIDAYS = require(path.join(REPO, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS || {}; } catch { HOLIDAYS = {}; }
/** the file: the sha256 it was BUILT AGAINST (home's bytes on 2026-10-14: the W5 fix-4 edit applied, W5's judge reads "applied") and the staged one */
const FILES = Object.freeze([
  Object.freeze({ rel: "backend/alpaca-reconcile.js", base: "base/backend/alpaca-reconcile.js", staged: "staged/backend/alpaca-reconcile.js",
    baseSha: "b0265e52c80585d135f9ac4dcff4eb61786b4e3c2ee8f3ebbfaa8a467c5ab709", stagedSha: /*STAGED_SHA*/"47f453cdfa7687a99ca9c765b69487508d480991c14e261c782a14125c467a65"/*END*/ }),
]);
const isCode = (rel) => /\.(c?js)$/.test(rel);
const P = (root, rel) => path.join(root, ...rel.split("/"));

/** one file's state: home now, the package's base and staged copies, and what they say */
function fileState(f, { repo = REPO, pkg = PKG } = {}) {
  const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
  const home = read(P(repo, f.rel)), base = read(P(pkg, f.base)), staged = read(P(pkg, f.staged));
  const r = { rel: f.rel, home: home ? sha(home) : null, base: base ? sha(base) : null, staged: staged ? sha(staged) : null, baseSha: f.baseSha, stagedSha: f.stagedSha, problem: null, state: null };
  if (r.base !== f.baseSha) r.problem = `the package's base copy ${f.base} is ${r.base ? "not the bytes it was built against" : "missing"}`;
  else if (r.staged !== f.stagedSha) r.problem = `the package's staged copy ${f.staged} is ${r.staged ? "not the bytes that were reviewed" : "missing"}`;
  r.state = !home ? "absent" : r.home === f.stagedSha ? "applied" : r.home === f.baseSha ? "base" : "DRIFT";
  return r;
}
/** the plan: the file states and whether a write mode could go on (problems = refusals). forRollback: a changed STAGED copy does not stop it */
function plan({ repo = REPO, pkg = PKG, forRollback = false } = {}) {
  const files = FILES.map((f) => fileState(f, { repo, pkg })), problems = [];
  for (const x of files) {
    if (x.problem && !(forRollback && /staged copy/.test(x.problem))) problems.push(`${x.rel}: ${x.problem}`);
    if (x.state === "DRIFT") problems.push(`${x.rel} is DRIFT at home: its sha256 ${String(x.home).slice(0, 12)} is neither the base ${x.baseSha.slice(0, 12)} nor the staged ${x.stagedSha.slice(0, 12)} — someone changed it since this package was built: read the change, then rebuild the package`);
    if (x.state === "absent") problems.push(`${x.rel} is missing at home`);
  }
  return { files, problems, todo: files.filter((x) => x.state === "base"), applied: files.every((x) => x.state === "applied") };
}

// ── the clocks (node Intl only; the shell's date is never used) ───────────────────────────────────────────────────────────────
function zoneParts(ms, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`, hh = +p.hour % 24, mm = +p.minute;
  return { date, hh, mm, hm: hh * 60 + mm, hhmm: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, dow: new Date(date + "T12:00:00Z").getUTCDay() };
}
const tradingDay = (z, holidays) => z.dow >= 1 && z.dow <= 5 && !holidays[z.date];
const mtWords = (ms) => { const z = zoneParts(ms, "America/Denver"); return `${z.date} ${z.hhmm}`; };
/** no write 05:30-16:00 MT on a trading weekday (the session, the pre-open runners and the close chain's own hour) */
function clockFence(nowMs, holidays = HOLIDAYS) {
  const z = zoneParts(nowMs, "America/Denver");
  return tradingDay(z, holidays) && z.hm >= 5 * 60 + 30 && z.hm < 16 * 60 ? `it is ${z.date} ${z.hhmm} MT, a trading day, inside 05:30-16:00 MT — run it after 16:00 MT, once tonight's close chain has finished` : null;
}
/** tonight's chain due: a session day (ET) past 16:00 ET whose chain-status.json is not a FINISHED run started on that ET date */
function chainFence(nowMs, chainStatus, holidays = HOLIDAYS) {
  const z = zoneParts(nowMs, "America/New_York"); if (!tradingDay(z, holidays) || z.hm < 16 * 60) return null;
  const s = chainStatus && Date.parse(chainStatus.started), d = Number.isFinite(s) ? zoneParts(s, "America/New_York").date : null;
  if (d === z.date && chainStatus.finished) return null;
  return `tonight's close chain is due or running: ${z.date} is a session day, it is ${z.hhmm} ET, and chain-status.json ${d === z.date ? "has no finished stamp yet" : `is from ${d || "no readable run"}`} — run it once the chain has finished`;
}
/** the node processes now -> [{ pid, cmd }] (read-only: Win32_Process on Windows, ps elsewhere); throws when the list cannot be read */
function listNodeProcs() {
  const win = process.platform === "win32";
  const r = win ? cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { [string]$_.ProcessId + \"`t\" + [string]$_.CommandLine }"], { encoding: "utf8", windowsHide: true, timeout: 60000 })
    : cp.spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 30000 });
  if (r.error || r.status !== 0) throw new Error(`${win ? "Get-CimInstance Win32_Process" : "ps"} ${r.error ? r.error.message : `exit ${r.status}: ${String(r.stderr || "").trim().slice(0, 160)}`}`);
  return String(r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const m = win ? /^(\d+)\t?(.*)$/.exec(l) : /^(\d+)\s+(.*)$/.exec(l); return m ? { pid: +m[1], cmd: m[2] } : null; }).filter(Boolean);
}
const norm = (s) => String(s || "").replace(/\\/g, "/").toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** does this command line run <rel> of THIS repo? (the repo's absolute path + rel, or rel as a word of its own: `node automation\close-chain.cjs`
 *  from the repo; a scratch tree's .../Temp/rp-tree-x/backend/alpaca-reconcile.js is neither) */
function runsRepoScript(cmd, rel, repo = REPO) { const c = norm(cmd), r = norm(rel); return c.includes(`${norm(repo)}/${r}`) || new RegExp(`(^|[\\s"'])(\\./)?${esc(r)}($|[\\s"'])`).test(c); }
function procFence(listProcs, repo = REPO) {
  let procs; try { procs = listProcs(); } catch (e) { return [`the node process list could not be read (${String(e.message).slice(0, 200)}) — nothing is assumed about the close chain or the reconcile: refused`]; }
  const out = [], chain = procs.filter((p) => p.pid !== process.pid && runsRepoScript(p.cmd, "automation/close-chain.cjs", repo)), rec = procs.filter((p) => p.pid !== process.pid && runsRepoScript(p.cmd, "backend/alpaca-reconcile.js", repo));
  if (chain.length) out.push(`the close chain is running (node pid ${chain.map((p) => p.pid).join(", ")}) — run it when the chain has finished`);
  if (rec.length) out.push(`backend/alpaca-reconcile.js is running (node pid ${rec.map((p) => p.pid).join(", ")}) — the file must not change under a run`);
  return out;
}
const readChainStatus = (repo = REPO) => { try { return JSON.parse(fs.readFileSync(path.join(repo, "backend", "data", "chain-status.json"), "utf8")); } catch { return null; } };

/** write bytes so that the file is either the old one or the new one, never half (temp file + rename), then read back by sha256 */
function writeExact(file, buf) {
  const tmp = `${file}.tmp-rpace-${process.pid}`, fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  if (sha(fs.readFileSync(file)) !== sha(buf)) throw new Error(`${file} does not read back as written`);
}

/** PACE as the staged text states it (the selftest holds this to the module's own PACE) -> object or null */
function paceOf(text) { const m = /const PACE = Object\.freeze\((\{[^}]*\})\);/.exec(String(text)); if (!m) return null; try { return JSON.parse(m[1].replace(/([{,]\s*)([A-Za-z]\w*)\s*:/g, '$1"$2":')); } catch { return null; } }
/** tonight's calls, from the mirror's logs (read-only, no broker): entry orders + close lookups (an upper bound: a close order is read only
 *  for a filled ticket), how long the limiter takes for them, how many the budget allows, and when the flow reaches that */
function forecast({ repo = REPO, pace = paceOf(fs.readFileSync(P(PKG, FILES[0].staged), "utf8")), holidays = HOLIDAYS } = {}) {
  const D = (f) => path.join(repo, "backend", "data", f), jl = (f) => { try { return fs.readFileSync(D(f), "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return null; } };
  const mir = jl("alpaca-mirror.jsonl"), ex = jl("alpaca-mirror-exits.jsonl"); if (!mir || !ex || !pace) return null;
  const rows = mir.filter((r) => r.orderId && !r.late), exitBy = new Map(ex.filter((x) => x.closeOrderId).map((x) => [x.ticketId, x]));
  const close = rows.filter((r) => { const x = exitBy.get(r.ticketId); return x && !(x.final && Number(x.closeQty) > 0 && Number(x.closeFill) > 0); }).length, calls = rows.length + close;
  const capacity = pace.burst + Math.floor(pace.perMinute * (pace.budgetMs - pace.minCallMs) / 60000), secs = calls <= pace.burst ? 0 : (calls - pace.burst) * 60 / pace.perMinute;
  const byDay = {}; for (const r of rows) { const d = r.ts ? zoneParts(Date.parse(r.ts), "America/New_York").date : null; if (d) byDay[d] = (byDay[d] || 0) + 1; }
  const days = Object.keys(byDay).sort().slice(-10), perSession = days.length ? days.reduce((a, d) => a + byDay[d], 0) / days.length : 0, perTicket = rows.length ? calls / rows.length : 1;
  const growth = perSession * perTicket, sessions = growth > 0 ? Math.max(0, Math.floor((capacity - calls) / growth)) : null;
  let when = null; if (sessions != null) { let t = Date.now(), n = 0; while (n < sessions) { t += 864e5; const z = zoneParts(t, "America/New_York"); if (tradingDay(z, holidays)) n++; } when = zoneParts(t, "America/New_York").date; }
  return { entry: rows.length, close, calls, secs: Math.round(secs), capacity, budgetSec: pace.budgetMs / 1000, perSession: +perSession.toFixed(2), sessionsUsed: days.length, perTicket: +perTicket.toFixed(2), growth: +growth.toFixed(1), sessions, when };
}

/**
 * The write steps, on injected dependencies (the selftest gives a scratch repo, a fake clock, a fake process list, a fake gate):
 * repo, pkg, now, log, listProcs() -> [{ pid, cmd }] (throws when unreadable), chainStatus() -> object | null, holidays, run(args) -> { status, out }.
 */
function make(deps = {}) {
  const d = { repo: REPO, pkg: PKG, now: () => Date.now(), log: (s) => console.log(s), listProcs: listNodeProcs, chainStatus: null, holidays: HOLIDAYS, run: null, ...deps };
  if (!d.chainStatus) d.chainStatus = () => readChainStatus(d.repo);
  if (!d.run) d.run = (args, timeoutMs = 1800000) => { const r = cp.spawnSync(process.execPath, args, { cwd: d.repo, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 256 << 20 }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") }; };
  /** the fences, now: [] or the refusals */
  function fences() {
    const out = [], n = d.now(), c = clockFence(n, d.holidays); if (c) out.push(c);
    const ch = chainFence(n, d.chainStatus(), d.holidays); if (ch) out.push(ch);
    out.push(...procFence(d.listProcs, d.repo));
    return out;
  }
  /** the write mode of deploy (to = "staged") and of rollback (to = "base") */
  function writeUnit({ to, gate = null }) {
    const wantBase = to === "base", Pl = plan({ repo: d.repo, pkg: d.pkg, forRollback: wantBase }), lines = [], say = (s) => { lines.push(s); d.log(s); };
    const refuse = (why) => ({ result: "refused", why, lines, written: [] });
    if (Pl.problems.length) return refuse(Pl.problems);
    const todo = Pl.files.filter((x) => (wantBase ? x.state === "applied" : x.state === "base"));
    let fz = fences(); if (fz.length) return refuse(fz);
    if (gate && todo.length) { say(`  gate: ${gate.what} …`); const g = gate.run(); if (!g.ok) return refuse([`${gate.what} did not pass: ${g.why}`]); say(`  gate: ${g.line}`); fz = fences(); if (fz.length) return refuse(fz); }
    const before = {}, written = [];
    const putBack = () => { const bad = []; for (const [rel, buf] of Object.entries(before)) { try { writeExact(P(d.repo, rel), buf); } catch (e) { bad.push(`${rel}: ${e.message}`); } } return bad; };
    for (const x of todo) {
      const f = FILES.find((y) => y.rel === x.rel), file = P(d.repo, x.rel), now = fs.readFileSync(file);
      if (sha(now) !== x.home) { const bad = putBack(); return { result: "failed", why: [`${x.rel} changed while this ran`], lines, restored: !bad.length, notRestored: bad, written }; }
      before[x.rel] = now;
      const buf = fs.readFileSync(P(d.pkg, wantBase ? f.base : f.staged));
      try { writeExact(file, buf); } catch (e) { const bad = putBack(); return { result: "failed", why: [`writing ${x.rel}: ${e.message}`], lines, restored: !bad.length, notRestored: bad, written }; }
      written.push(x.rel);
      if (isCode(x.rel)) { const c = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true }); if (c.status !== 0) { const bad = putBack(); return { result: "failed", why: [`${x.rel} does not parse after the write: ${String(c.stderr).trim().split("\n")[0]}`], lines, restored: !bad.length, notRestored: bad, written }; } }
      say(`  wrote ${x.rel}  sha256 ${sha(buf).slice(0, 12)} (${wantBase ? "the base bytes" : "the staged bytes"}), read back and node --check ok`);
    }
    if (!todo.length) say(`  home: nothing to write (the file already reads ${wantBase ? "base" : "applied"})`);
    return { result: "done", written, lines };
  }
  /** the package's selftest as the gate (its last line must say ALL ... CHECKS PASSED) */
  const selftestGate = { what: "this package's selftest (selftest.cjs)", run: () => { const r = d.run([path.join(PKG_REL, "selftest.cjs")], 1800000), last = String(r.out).trim().split("\n").pop() || ""; return { ok: r.status === 0 && /^ALL \d+ CHECKS PASSED/.test(last), line: last, why: last || `exit ${r.status}` }; } };
  return { d, fences, writeUnit, selftestGate };
}

function printPlan(Pl, fz, fc) {
  console.log(`PLAN — reconcile pacing (backend/alpaca-reconcile.js) — ${new Date().toISOString().slice(0, 16)}Z (${mtWords(Date.now())} MT) — read-only, nothing is written`);
  for (const x of Pl.files) {
    console.log(`\n  ${x.rel}`);
    console.log(`      home now   ${x.home || "(missing)"}`);
    console.log(`      base       ${x.baseSha}${x.base === x.baseSha ? "" : "   PACKAGE COPY DIFFERS: " + (x.base || "missing")}   (what this package was built against)`);
    console.log(`      staged     ${x.stagedSha}${x.staged === x.stagedSha ? "" : "   PACKAGE COPY DIFFERS: " + (x.staged || "missing")}`);
    console.log(`      state      ${x.state === "base" ? "base — the write mode would write the staged bytes" : x.state === "applied" ? "applied — home already holds the staged bytes" : x.state}${x.problem ? "   PROBLEM: " + x.problem : ""}`);
  }
  console.log(`\n  unit: ${Pl.problems.length ? "REFUSED by the write mode:\n    - " + Pl.problems.join("\n    - ") : Pl.todo.length ? `the write mode would write ${Pl.todo.map((x) => x.rel).join(", ")} (after the selftest gate)` : "home already holds the staged bytes — the write mode would write nothing"}`);
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear (the clock, chain-status.json and the node process list)"}`);
  if (fc) {
    console.log(`\n  tonight's broker calls (from the mirror's logs, no broker asked): ${fc.calls} = ${fc.entry} entry orders + up to ${fc.close} close orders`);
    console.log(`      at the limiter's pace that is about ${fc.secs} s (was about 8 s unpaced); the ${fc.budgetSec} s budget allows ${fc.capacity} calls`);
    console.log(`      new order rows ${fc.perSession} a session (the last ${fc.sessionsUsed} sessions with rows), ${fc.perTicket} calls a row: about ${fc.growth} more calls a session`);
    console.log(`      ${fc.sessions == null ? "no growth measured" : `the budget is reached in about ${fc.sessions} sessions (near ${fc.when}); from then the OLDEST tickets are UNKNOWN "not asked" each night (NOTES.md, "The budget")`}`);
  } else console.log("\n  tonight's broker calls: the mirror's logs could not be read — no forecast");
  console.log("  no restart is needed or done; change-registry.json and agent-ledger.jsonl are written only by record.cjs (after verify-live.cjs).");
}

module.exports = { PKG, REPO, PKG_REL, FILES, sha, fileState, plan, zoneParts, tradingDay, clockFence, chainFence, listNodeProcs, runsRepoScript, procFence, readChainStatus, writeExact, paceOf, forecast, make, mtWords, isCode, HOLIDAYS };

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) { console.log("usage: node docs/reconcile-pacing/2026-10-14/deploy.cjs --plan | --apply\n  --plan   read-only: the file's sha256 now / base / staged, its state, the fences now, tonight's call forecast\n  --apply  the write mode (refused on a trading weekday 05:30-16:00 MT, while the close chain is due or running, while the reconcile runs)\nNothing was done."); process.exit(2); }
  const Pl = plan();
  if (MODE === "--plan") { const M = make(); let fz; try { fz = M.fences(); } catch (e) { fz = [`the fences could not be read (${e.message})`]; } let fc = null; try { fc = forecast(); } catch { fc = null; } printPlan(Pl, fz, fc); process.exit(0); }
  console.log(`APPLY — reconcile pacing — ${new Date().toISOString().slice(0, 16)}Z (${mtWords(Date.now())} MT)`);
  const M = make(), r = M.writeUnit({ to: "staged", gate: M.selftestGate });
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") { console.error(`APPLY FAILED: ${r.why.join("; ")}`); console.error(r.restored ? "  home's file is back to the bytes it had before this run" : `  NOT RESTORED: ${(r.notRestored || []).join("; ")} — restore by hand: node ${PKG_REL}/rollback.cjs --apply`); process.exit(1); }
  console.log(`\nAPPLIED: home ${r.written.length ? "now holds the staged " + r.written.join(", ") : "already held the staged bytes"}. No restart: the close chain starts a new process for the step each night.`);
  console.log(`  NEXT: node ${PKG_REL}/verify-live.cjs   (read-only; outside 05:30-16:00 MT on a trading day and after the chain: one --dry-print run, GETs only)`);
  console.log(`        node ${PKG_REL}/record.cjs --dry, then without --dry (outside 13:50-15:50 MT on a trading day)`);
  process.exit(0);
}
