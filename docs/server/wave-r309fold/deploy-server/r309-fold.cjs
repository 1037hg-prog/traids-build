#!/usr/bin/env node
/**
 * R309 FOLD — R309's home copy pulled through W1's pull-server path, and the hourly R309 alarm fed from it. 2026-10-09
 * (docs/server/wave-r309fold). Installed at home as deploy/server/r309-fold.cjs (beside pull-server.cjs, pull-r309.cjs, manifests/).
 *
 * THE PULL. pull-server.cjs pullWave("r309") under deploy/server/manifests/r309.json (pull-r309.cjs's rules as data: cycles an exact
 * byte prefix; ledger ids only grow, immutable fields fixed, fill / close fields fixed once set, twin.net fixed once settled, status only
 * forward; config.evidenceStart and read frozen once set). Same four files, same ustar-over-ssh, same stage / fsync / re-read / atomic
 * rename, same never-sync list (*-HALT, *-OFF, locks, ...), same home r309-HALT check before AND after, one run at a time through
 * backend/data/pull-server.lock. PLUS a runtime PARITY GUARD: the tar the VPS sent is also validated by deploy/server/pull-r309.cjs's own
 * validate() before pull-server may rename anything, so the fold refuses whatever EITHER rule set refuses (it is never looser than the
 * hourly pull it replaces; docs/server/wave-r309fold/parity.cjs lists the six inputs where the two differ — none is written by the
 * R309 runner). r309 runs ONLY on the VPS: a map that gives r309 to home, or that cannot be read, is a refusal here (never a quiet
 * "home-owned — not pulled": that would freeze R309's home copy without a sound).
 *
 * THE ALARM (--alert). After the pull, backend/lib/r309-health.cjs --alert --pull-rc <code> runs exactly as deploy\server\pull-r309.bat
 * ran it: same debounce state (backend/data/r309-health-alert.json), same 75-min bar, same "two failing pulls in a row" rule. A pull
 * skipped because another pull-server run held the home lock passes no --pull-rc (the streak is left as it was: nothing was tried).
 * Its refusal lines keep the "pull-r309 REFUSED" / "pull-r309 FAILED" words r309-health reads from automation\r309-pull.log, tagged
 * "r309 fold" so a reader can tell them from the retired task's lines.
 *
 *   node deploy\server\r309-fold.cjs --alert --from preflight.bat   automation\preflight.bat, every TRAIDS Preflight fire (Mon-Fri hourly,
 *                                                                   about 06:00-17:00 MT, S4U, WakeToRun) >> automation\r309-pull.log
 *   node deploy/server/r309-fold.cjs --pull --from close-chain      the chain's first r309 pull (before every reader)
 *   node deploy/server/r309-fold.cjs --pull --from close-chain-git  the chain's r309 pull right before git snapshot
 *   node deploy/server/r309-fold.cjs --pull --from manual [--dry]   by hand; --dry fetches and validates, writes nothing (no status either)
 *   node deploy/server/r309-fold.cjs --alert --from manual          by hand, with the alarm (it may page: it is the real alarm)
 *   start "R309 keeper" /b cmd /c "node deploy\server\r309-fold.cjs --keeper >> automation\r309-keeper.log 2>&1"
 *                                                                   automation\preflight.bat too, and automation\ensure-servers.bat
 *                                                                   ("TRAIDS Servers": weekdays every 30 min from 05:00 MT, and at every
 *                                                                   BOOT): the KEEPER (below) — one background instance that runs
 *                                                                   `--alert --from keeper` about hourly while the PC is awake outside
 *                                                                   the preflight hours (the task's evening / weekend cadence); a second
 *                                                                   start finds it alive and exits quietly
 *   node deploy/server/r309-fold.cjs --status                       the recorded runs (backend/data/r309-fold-status.json) + the keeper
 *   node deploy/server/r309-fold.cjs --selftest                     temp dirs and a fake ssh only; the alarm is a stub (never pages)
 * Every run except --dry appends one record to backend/data/r309-fold-status.json (node + lib/atomic-write.js; the last 400 runs):
 * from, who ran it (the scheduled task's principal), the pull's result, the guard's verdict and the alarm's exit — what
 * docs/server/wave-r309fold/deploy.cjs --retire reads to certify a clean day before the hourly task is retired.
 * Exit (--pull): 0 pulled / no change (ONLY when the parity guard passed the server's files) · 1 refused or failed (nothing written;
 * also any answer with no tar for the guard, e.g. an exit-75 "busy" while r309's manifest gives it no server lock) · 2 bad arguments ·
 * 3 skipped (the home lock was held, or a server lock in the manifest held: WARN, named on the last stderr line) · 4 home r309-HALT missing. (--alert): the pull's 1 / 4, else 1 when the alarm could not run,
 * else the alarm's own code (0 PASS, 5 WARN, 3 FAIL, 1 UNKNOWN), as pull-r309.bat did.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const findRepo = (from) => { for (let d = from; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, "backend", "data")) && fs.existsSync(path.join(d, "deploy"))) return d; if (path.dirname(d) === d) return null; } };
const REPO = findRepo(__dirname);
const DS = fs.existsSync(path.join(__dirname, "pull-server.cjs")) ? __dirname : path.join(REPO, "deploy", "server");
const PS = require(path.join(DS, "pull-server.cjs"));
const VERSION = "r309-fold 2026-10-09";
const FOUR = ["r309-cycles.jsonl", "r309-interim.json", "r309-ledger.jsonl", "r309-surge-hold48.json"];
const FROM = new Set(["preflight.bat", "close-chain", "close-chain-git", "keeper", "manual"]);
const ALERT_FROM = new Set(["preflight.bat", "keeper", "manual"]);
const KEEP = 400;
const TAR_CMD = /tar --format=ustar -cf - --null --no-recursion -T -/;
/** r309-health.cjs reads automation\r309-pull.log for this (its pullLine); every fold refusal line must match it */
const HEALTH_PULL_LINE = /pull-r309 (FAILED|REFUSED)/;
/** a line of the RETIRED hourly task (deploy/server/pull-r309.cjs): never a fold line */
const OLD_TASK_LINE = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] pull-r309 (ok from |REFUSED|FAILED)/;
const isOldTaskLine = (l) => OLD_TASK_LINE.test(l) && !/r309 fold/.test(l);

/** the parity guard: deploy/server/pull-r309.cjs, loaded fail-closed (it must export validate / untar over exactly the four files) */
function loadGuard(file = path.join(DS, "pull-r309.cjs")) {
  const G = require(file);
  if (!G || typeof G.validate !== "function" || typeof G.untar !== "function" || !Array.isArray(G.FILES)) throw new Error(`${path.basename(file)} does not export validate / untar / FILES`);
  if (JSON.stringify([...G.FILES].sort()) !== JSON.stringify(FOUR)) throw new Error(`${path.basename(file)} pulls ${G.FILES.join(", ")} — not R309's four run files`);
  return G;
}
/**
 * The ssh pullWave gets: exactly ONE call is expected (the tar of the four files). Its bytes are validated by the OLD rules
 * (pull-r309.cjs validate) before pull-server sees them. When the old rules refuse, pull-server's rules are evaluated on the same bytes
 * too, so the record says whether the guard ALONE refused (a parity difference: kind "guard") or both did (kind "refused", with
 * pull-server's own message) — pull-server would have refused it anyway.
 */
function guardedSsh(base, G, def, homeDir, seen) {
  return (script, o = {}) => {
    seen.calls = (seen.calls || 0) + 1;
    if (!TAR_CMD.test(String(script))) { seen.unexpected = String(script).slice(0, 80); return { ok: false, status: 1, out: o.binary ? Buffer.alloc(0) : "", err: "r309 fold: an unexpected ssh call was refused (the r309 pull makes exactly one: the tar of the four run files)" }; }
    const r = base(script, o);
    if (!r || !r.ok) return r;
    const buf = Buffer.isBuffer(r.out) ? r.out : Buffer.from(String(r.out || ""), "latin1");
    try { G.validate(G.untar(buf), homeDir); }
    catch (e) {
      seen.guard = String(e && e.message || e);
      try { const ents = PS.pullEntries(def); PS.checkGrowth(ents, PS.readLocal(ents, homeDir), PS.tarFiles(ents, buf), { mode: "pull" }); seen.psWhy = null; }
      catch (x) { seen.psWhy = String(x && x.message || x); }
      return { ok: false, status: 1, out: Buffer.alloc(0), err: `R309 parity guard: pull-r309.cjs's rules refuse the server's files — ${seen.guard}` };
    }
    seen.guard = null; seen.guardOk = true;
    return r;
  };
}

/**
 * One r309 pull. -> { exit 0|1|3|4, kind, why, changed[], files, guard: "ok"|"refused"|"not reached" }. deps (selftest): homeDir,
 * manifestDir, mapFile, statusFile (pull-server's), ssh (the base ssh), guardFile, dry, lockWait.
 */
function pullR309({ homeDir = PS.HOME_DATA, manifestDir = PS.MANIFEST_DIR, mapFile = null, statusFile = null, ssh = null, guardFile = path.join(DS, "pull-r309.cjs"), dry = false, lockWait = 20 } = {}) {
  const R = (exit, kind, why, extra = {}) => ({ exit, kind, why, changed: [], files: 0, guard: "not reached", ...extra });
  if (!fs.existsSync(path.join(homeDir, "r309-HALT"))) return R(4, "halt", "home backend/data/r309-HALT is missing — restore it before pulling (it keeps the PC from ever sending for R309)");
  let G; try { G = loadGuard(guardFile); } catch (e) { return R(1, "guard-missing", `the parity guard (deploy/server/pull-r309.cjs) cannot be loaded (${String(e.message).slice(0, 160)}) — nothing pulled (fail-closed)`); }
  let def; try { def = PS.loadManifest("r309", manifestDir).units.r309; } catch (e) { return R(1, "manifest", `manifests/r309.json: ${String(e.message).slice(0, 200)}`); }
  const paths = PS.pullEntries(def).map((e) => e.path).sort();
  if (JSON.stringify(paths) !== JSON.stringify(FOUR)) return R(1, "manifest", `manifests/r309.json pulls ${paths.join(", ")} — not R309's four run files; parity with pull-r309.cjs is unknown — nothing pulled`);
  const seen = {}, base = ssh || PS.sshReal("traids");
  const r = PS.pullWave("r309", { homeDir, manifestDir, ssh: guardedSsh(base, G, def, homeDir, seen), dry, lockWait, mapFile, statusFile });
  const u = (r.units || {}).r309 || {}, guard = seen.guard ? "refused" : seen.guardOk ? "ok" : "not reached";
  if (r.exit === 4) return R(4, "halt", String(r.lines.find((l) => /HALT/.test(l)) || "home backend/data/r309-HALT is missing").replace(/^REFUSED \(exit 4\): /, ""), { guard });
  if (r.busy) return R(3, "skipped", "another pull-server run holds backend/data/pull-server.lock — not pulled this run (retried at the next one)", { guard });
  if (u.owner === "home") return R(1, "home-owned", "backend/data/host-ownership.json gives r309 to HOME — R309 runs only on the VPS (fixed since W0; home never takes it over): nothing pulled, so R309's home copy would freeze — fix the map (own.cjs never moves r309)", { guard });
  if (seen.unexpected) return R(1, "refused", `an unexpected ssh call was refused (${seen.unexpected})`, { guard });
  if (seen.guard && seen.psWhy) return R(1, "refused", `${seen.psWhy.slice(0, 300)} (pull-r309.cjs's rules refuse it too)`, { guard });
  if (seen.guard) return R(1, "guard", `the parity guard: pull-r309.cjs's rules refuse what pull-server alone would accept — ${seen.guard.slice(0, 300)}`, { guard });
  if (r.exit !== 0 || !u.result || /^(error|refused)/.test(String(u.result))) {
    const res = String(u.result || r.lines.join(" · ") || "no result");
    return R(1, /^error: ssh: /.test(res) ? "failed" : "refused", res.replace(/^(error|refused): /, "").slice(0, 400), { guard });
  }
  // EXIT 0 ONLY WHEN THE GUARD PASSED THE SERVER'S FILES. pull-server reads an exit-75 answer as "busy" and the wave as exit 0 with nothing
  // pulled; recorded as ok it would also hand the alarm --pull-rc 0 and reset its failure streak. A unit with a server lock in its manifest
  // may legitimately be busy: skipped (3, the streak untouched). r309's manifest has none (lock: null), so no tar validated is a refusal.
  if (!seen.guardOk) {
    const res = String(u.result || "no result").slice(0, 200), busy = /^busy/.test(res);
    if (busy && def.lock) return R(3, "skipped", `the server held r309's lock (${def.lock}) past ${lockWait} s (exit 75) — not pulled this run (retried at the next one)`, { guard });
    return R(1, "refused", `no tar of the four run files reached the parity guard (pull-server: ${res})${busy ? " — an exit-75 'busy' answer, though manifests/r309.json gives r309 no server lock (lock: null)" : ""}; nothing pulled (fail-closed: a pull is clean only when the guard passed the server's files)`, { guard });
  }
  return { exit: 0, kind: "ok", why: null, changed: u.changed || [], files: u.files || 0, guard, dry };
}

/** the log line(s) for a pull result (stdout; the .bat appends it to automation\r309-pull.log, the chain to its own log) */
function pullLine(p, from, ts = new Date().toISOString()) {
  const tag = `r309 fold via pull-server, from ${from}`;
  if (p.exit === 0) return `[${ts}] r309-fold ${p.dry ? "DRY " : ""}ok (pull-server --wave r309 + the pull-r309 rules guard, from ${from}) — ${p.files} server file(s): ${p.changed.length ? p.changed.join("; ") : "no change"} · home r309-HALT present`;
  if (p.exit === 3) return `[${ts}] r309-fold SKIPPED (from ${from}): ${p.why}`;
  if (p.exit === 4) return `[${ts}] pull-r309 REFUSED (exit 4; ${tag}): ${p.why}`;
  return `[${ts}] pull-r309 ${p.kind === "failed" ? "FAILED" : "REFUSED"} (nothing written; ${tag}): ${p.why}`;
}

/** the real alarm: backend/lib/r309-health.cjs --alert [--pull-rc N], output into this process's stdout (the same log) */
function realHealth(pullRc) {
  const r = cp.spawnSync(process.execPath, [path.join(REPO, "backend", "lib", "r309-health.cjs"), "--alert", ...(pullRc == null ? [] : ["--pull-rc", String(pullRc)])], { cwd: REPO, stdio: ["ignore", "inherit", "inherit"], timeout: 240000, windowsHide: true });
  const ran = !r.error && r.status != null && r.signal == null;
  return { ran, exit: r.status, why: ran ? null : (r.error ? r.error.message : `ended by ${r.signal || "?"}`) };
}

function appendRun(file, rec) {
  let st = null; try { st = JSON.parse(fs.readFileSync(file, "utf8")); } catch { st = null; }
  if (!st || st.schema !== "r309-fold-status-v1" || !Array.isArray(st.runs)) st = { schema: "r309-fold-status-v1", note: "One record per deploy/server/r309-fold.cjs run (docs/server/wave-r309fold): the r309 pull through pull-server, the pull-r309 rules guard, and the hourly alarm's exit. Read by deploy.cjs --retire / --status.", runs: [] };
  st.runs = [...st.runs, rec].slice(-KEEP); st.updatedAt = rec.at;
  require(path.join(REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic(file, st);
}

/** one fold run (pull, then the alarm when mode is "alert"); prints its lines, records it (unless dry); -> the process exit code */
function run({ mode, from, dry = false, deps = {}, print = (s) => console.log(s), printErr = (s) => console.error(s), runHealth = realHealth } = {}) {
  const at = new Date().toISOString(), homeDir = deps.homeDir || PS.HOME_DATA;
  const p = pullR309({ ...deps, dry });
  print(pullLine(p, from));
  let alarm = null;
  if (mode === "alert") {
    const pullRc = p.exit === 3 ? null : p.exit;
    let h; try { h = runHealth(pullRc); } catch (e) { h = { ran: false, exit: null, why: String(e.message).slice(0, 160) }; }
    alarm = { ran: !!h.ran, exit: h.exit == null ? null : h.exit, pullRc, why: h.why || null };
    if (!alarm.ran) print(`[${new Date().toISOString()}] r309-fold: the R309 alarm (backend/lib/r309-health.cjs --alert) did NOT run: ${alarm.why || "?"}`);
  }
  let user = null; try { user = os.userInfo().username; } catch { user = null; }
  // a hand run (stdout a terminal) is recorded interactive:true — the retire gate, its cadence parity and register never count it.
  // deps.isTTY (a boolean) stands in for the terminal test in the selftest, whose stdout is always a pipe.
  const interactive = typeof deps.isTTY === "boolean" ? deps.isTTY : !!(process.stdout && process.stdout.isTTY);
  if (!dry) {
    const rec = { at, from, mode, version: VERSION, user, interactive, pull: { exit: p.exit, kind: p.kind, why: p.why ? String(p.why).slice(0, 300) : null, changed: p.changed, files: p.files }, guard: p.guard, alarm };
    try { appendRun(deps.foldStatusFile || path.join(homeDir, "r309-fold-status.json"), rec); } catch (e) { print(`[${new Date().toISOString()}] r309-fold: note — r309-fold-status.json not written (${String(e.message).slice(0, 120)})`); }
  }
  if (mode === "pull") { if (p.exit === 3) printErr(`r309-fold WARN: ${p.why}`); else if (p.exit !== 0) printErr(`r309-fold: ${p.exit === 4 ? "HALT missing" : "refused"} — ${p.why}`); return p.exit; }
  if (p.exit === 1 || p.exit === 4) return p.exit;
  if (!alarm.ran) return 1;
  return alarm.exit;
}

// ── the keeper: the hourly cadence outside the preflight hours ───────────────────────────────────────────────────────────────
/**
 * The hourly task ran the alarm at :08 / :25 every hour the PC was awake and Josh logged on — measured 2026-10-07/08: 05:02 to 23:25 MT
 * on weekdays, beyond TRAIDS Preflight's fires (Mon-Fri 06:00-18:00 MT). The keeper keeps that cadence without a scheduled task of its
 * own: every preflight fire starts it in the background (`start /b`, as R295's session and the fills stream are started), and so does
 * every TRAIDS Servers run (automation\ensure-servers.bat: weekdays every 30 min from 05:00 MT, and AT EVERY BOOT — a reboot outside the
 * preflight hours restarts it at once, without a logon; the task itself needed one); ONE instance
 * lives on (a lock with a heartbeat, CREATED EXCLUSIVELY — of two starts in the same instant one creates it — and read back at the
 * first tick); each minute it asks keeperDue() and, when due, runs `r309-fold.cjs --alert --from keeper` as a
 * child (the same pull + guard + alarm, recorded like every run). Inside the preflight hours (Mon-Fri, MT hour 06-18) it waits for
 * preflight and runs only when no alarm ran for 70 min (a missed or late fire); outside them it runs when none ran for 55 min — about
 * hourly while the PC is awake (evenings, nights and weekends the PC is up), which is what the task did. "The last alarm" is the later
 * of the last recorded alarm run and the keeper's OWN last run (kept in memory: a run whose record did not land never makes it run
 * every minute); a recorded time more than 5 min in the future is no evidence (it never parks the keeper). The PC sleeping suspends it,
 * like the task (neither wakes the PC). It exits only on POSITIVE evidence (an update, a rollback, a second keeper): its own file read
 * whole with another sha, or ABSENT on 2 ticks in a row, or the lock naming another LIVE pid (a later keeper took over; the next preflight
 * fire or TRAIDS Servers run starts the current one). A failed read of its own file (a scanner holding it: UNKNOWN -4094, EBUSY...),
 * a torn or unreadable lock, or a heartbeat that cannot be written is logged and retried at the next tick — never an exit, which
 * would end the off-hours cadence until the next weekday start. Its own few lines go to automation\r309-keeper.log; each child run
 * appends to automation\r309-pull.log through its own O_APPEND handle (never a long-lived `>>` handle that would overwrite other
 * writers' lines).
 */
const KEEPER_LOCK = "r309-keeper.lock", BEAT_EVERY_MS = 4 * 60000, BEAT_STALE_MS = 15 * 60000, TICK_MS = 60000, SELF_GONE_TICKS = 2;
const mtNow = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return { dow: p.weekday, hour: Number(p.hour), minute: Number(p.minute) }; };
/** Pure: is ms inside the preflight hours (Mon-Fri, MT hour 06-18: TRAIDS Preflight's fires, the last one at 18:00 measured up to 18:59)? */
const inPreflightHours = (ms) => { const t = mtNow(ms); return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(t.dow) && t.hour >= 6 && t.hour <= 18; };
/** a recorded time more than this far AHEAD of now is no evidence (a clock stepped back, or a record written under a skewed clock) */
const FUTURE_SLACK_MS = 5 * 60000;
/**
 * Pure: is a keeper run due at nowMs, given the last recorded alarm run (any source) and the keeper's OWN last run (its memory: a run
 * whose record never landed — r309-fold-status.json locked, unwritable or absent — still counts, so a failing write never turns the
 * keeper into an every-minute ssh loop)? A time more than 5 min in the future is unknown (it would park the keeper until the clock
 * passes it); with no credible time at all the run is due.
 */
function keeperDue(nowMs, lastAlertMs, lastRunMs = NaN) {
  const covered = inPreflightHours(nowMs);
  const known = [lastAlertMs, lastRunMs].filter((x) => Number.isFinite(x) && x <= nowMs + FUTURE_SLACK_MS);
  const gap = known.length ? nowMs - Math.max(...known) : Infinity;
  return covered ? gap >= 70 * 60000 : gap >= 55 * 60000;
}
/** the last recorded run whose alarm ran (any source) — ms or NaN */
function lastAlertMs(file) {
  let st = null; try { st = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return NaN; }
  const runs = Array.isArray(st && st.runs) ? st.runs : [];
  for (let i = runs.length - 1; i >= 0; i--) if (runs[i] && runs[i].mode === "alert" && runs[i].alarm && runs[i].alarm.ran) return Date.parse(runs[i].at);
  return NaN;
}
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** { sha } of a file, or { err: its read error's code } — ENOENT is positive evidence the file is gone; any other error is only a failed read */
const readSha = (f) => { try { return { sha: require("crypto").createHash("sha256").update(fs.readFileSync(f)).digest("hex") }; } catch (e) { return { sha: null, err: (e && e.code) || String((e && e.message) || e).slice(0, 80) }; } };
const fileSha = (f) => readSha(f).sha;
/** a lock read empty / torn that is younger than this is another start's exclusive create caught before its write: that start is the keeper */
const LOCK_TORN_FRESH_MS = 10000;
/**
 * take the keeper lock: { ok, replaced } or { ok:false, running } (a live pid with a fresh heartbeat, or another start that won the
 * create) or { ok:false, why } (it could not be created). CREATED EXCLUSIVELY (flag "wx", as pull-server.cjs takeLock does): of two
 * starts in the same instant (preflight.bat and ensure-servers.bat both fire at :00 / :30) exactly one creates it; the other finds it
 * held. A stale one (a dead pid, a beat older than 15 min, torn and older than 10 s, or this very pid) is replaced by unlink + an
 * exclusive create; a start that loses THAT create to another one stands down. The rare start that still believes it holds the lock
 * (two starts replacing the same stale lock) reads it back at its first tick (keeperTick, lastBeat 0) and exits before running anything.
 */
function takeKeeperLock(file, nowMs, pid = process.pid, sha = null) {
  const iso = new Date(nowMs).toISOString(), body = JSON.stringify({ pid, startedAt: iso, beatAt: iso, sha, version: VERSION });
  const create = () => fs.writeFileSync(file, body, { flag: "wx" });
  try { create(); return { ok: true, replaced: null }; }
  catch (e) { if (e.code !== "EEXIST") return { ok: false, why: `${path.basename(file)} could not be created (${e.code || String(e.message).slice(0, 60)})` }; }
  let j = null; try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { j = null; }
  if (!(j && typeof j === "object")) j = null;
  if (j && j.pid !== pid && pidAlive(j.pid) && nowMs - Date.parse(j.beatAt) < BEAT_STALE_MS) return { ok: false, running: j };
  if (!j) { let age = 0; try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { age = 0; } if (age < LOCK_TORN_FRESH_MS) return { ok: false, running: null, why: "the lock is being written by another start (empty or torn, seconds old)" }; }
  try { fs.unlinkSync(file); } catch (x) { if (x.code !== "ENOENT") return { ok: false, why: `the stale ${path.basename(file)} could not be removed (${x.code || String(x.message).slice(0, 60)})` }; }
  try { create(); } catch (x) { return x.code === "EEXIST" ? { ok: false, running: null, why: "another start replaced the stale lock first" } : { ok: false, why: `${path.basename(file)} could not be created (${x.code || String(x.message).slice(0, 60)})` }; }
  return { ok: true, replaced: j && j.pid !== pid ? j : null };
}
/** the keeper's state at start: lastBeat 0, so its first tick reads the lock back (a keeper that lost a start race exits there) */
const keeperStartState = () => ({ lastBeat: 0 });
/** the default child run: the fold with the alarm, appending to automation\r309-pull.log through an O_APPEND handle of its own */
function keeperChild() {
  const fd = fs.openSync(path.join(REPO, "automation", "r309-pull.log"), "a");
  try { const r = cp.spawnSync(process.execPath, [__filename, "--alert", "--from", "keeper"], { cwd: REPO, stdio: ["ignore", fd, fd], timeout: 600000, windowsHide: true }); return r.status; }
  finally { fs.closeSync(fd); }
}
/**
 * One keeper tick (pure on its deps): -> "exit" | "ran" | "idle". deps: nowMs, selfFile, startSha, statusFile, lockFile, pid, runChild,
 * note (optional: a line for the keeper's log). st carries lastBeat (ms; 0 at start, so the FIRST tick already reads the lock back and
 * a keeper that lost a start race exits before it runs anything), lastRunAt (ms: its own last run, the memory keeperDue() also judges
 * by), selfGone (consecutive ticks its file was absent), runs, and exitWhy on an exit. EXIT ONLY ON POSITIVE EVIDENCE:
 *   its own file read whole with a sha other than startSha (an update) · its own file ABSENT (ENOENT) on SELF_GONE_TICKS ticks in a row
 *   (a rollback) · the lock read whole naming ANOTHER pid that is alive (a later keeper took over).
 * Anything else that fails is a failed read or write, not evidence: its own file unreadable (EBUSY / EPERM / UNKNOWN: a scanner) -> no
 * run this tick, retried next tick; the lock torn / unreadable -> no beat this tick, retried next tick; the lock absent or naming a
 * dead pid -> taken back (written with this pid); a heartbeat that cannot be written -> retried next tick.
 */
function keeperTick(st, d) {
  const note = typeof d.note === "function" ? d.note : () => {};
  const s = readSha(d.selfFile);
  if (s.sha != null) { st.selfGone = 0; if (s.sha !== d.startSha) { st.exitWhy = "its own file changed (an update: the next preflight fire or TRAIDS Servers run starts the new one)"; return "exit"; } }
  else if (s.err === "ENOENT") {
    st.selfGone = (st.selfGone || 0) + 1;
    if (st.selfGone >= SELF_GONE_TICKS) { st.exitWhy = `its own file is gone (absent on ${st.selfGone} ticks in a row: a rollback)`; return "exit"; }
    note(`its own file is absent this tick (${st.selfGone} of ${SELF_GONE_TICKS} in a row before it exits) — nothing run; checked again next tick`);
  } else { st.selfGone = 0; note(`its own file could not be read this tick (${s.err}) — not evidence of a change; nothing run, retried next tick`); }
  if (d.nowMs - (st.lastBeat || 0) >= BEAT_EVERY_MS) {
    let j = null, rerr = null;
    try { j = JSON.parse(fs.readFileSync(d.lockFile, "utf8")); } catch (e) { rerr = e; }
    const mine = !!(j && typeof j === "object" && j.pid === d.pid);
    // only a keeper started AFTER this one writes another pid here (takeKeeperLock found this one's beat stale, e.g. after a sleep): alive -> it is the keeper now
    if (j && typeof j === "object" && !mine && pidAlive(j.pid)) { st.exitWhy = `another live keeper (pid ${j.pid}, beat ${j.beatAt}) holds the lock`; return "exit"; }
    if (rerr && rerr.code !== "ENOENT") note(`the lock could not be read this tick (${rerr.code || String(rerr.message).slice(0, 60)}) — no beat this tick, retried next tick`);
    else {
      const at = new Date(d.nowMs).toISOString(), body = mine ? { ...j, beatAt: at } : { pid: d.pid, startedAt: at, beatAt: at, sha: d.startSha, version: VERSION, retaken: rerr ? "the lock was absent" : `from pid ${j && typeof j === "object" ? j.pid : "?"} (dead or stale)` };
      try { require(path.join(REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic(d.lockFile, body); st.lastBeat = d.nowMs; if (!mine) note(`lock taken back (${body.retaken})`); }
      catch (e) { note(`the lock's heartbeat could not be written (${e.code || String(e.message).slice(0, 60)}) — retried next tick`); }
    }
  }
  if (s.sha == null) return "idle";
  if (!keeperDue(d.nowMs, lastAlertMs(d.statusFile), st.lastRunAt)) return "idle";
  // its own memory, set BEFORE the child: a run is an attempt (an ssh pull + probe) whether or not its record lands or the child throws
  st.runs = (st.runs || 0) + 1; st.lastRunAt = d.nowMs; d.runChild(); return "ran";
}
function keeperMain({ homeDir = PS.HOME_DATA, print = (s) => console.log(s) } = {}) {
  const lockFile = path.join(homeDir, KEEPER_LOCK), self = readSha(__filename), startSha = self.sha;
  // its own sha is what an update is told by: without it, a later good read would look like a change. Not started; the next start retries.
  if (!startSha) { print(`[${new Date().toISOString()}] r309-fold keeper: its own file could not be read at start (${self.err}) — not started; the next preflight fire or TRAIDS Servers run retries`); return; }
  const L = takeKeeperLock(lockFile, Date.now(), process.pid, startSha);
  if (!L.ok) {   // the normal case on every preflight fire: one keeper already lives (or another start won the create) — quiet (no second writer on its log)
    if (!("running" in L)) print(`[${new Date().toISOString()}] r309-fold keeper: not started — ${L.why || "the lock could not be taken"}; the next preflight fire or TRAIDS Servers run retries`);
    return;
  }
  print(`[${new Date().toISOString()}] r309-fold keeper: started, pid ${process.pid}${L.replaced ? ` (replaced a stale lock of pid ${L.replaced.pid}, beat ${L.replaced.beatAt})` : ""} — the alarm about hourly while the PC is awake outside the preflight hours`);
  let lastNote = null;
  const st = keeperStartState(), drop = () => { try { const j = JSON.parse(fs.readFileSync(lockFile, "utf8")); if (j.pid === process.pid) fs.unlinkSync(lockFile); } catch {} };
  const note = (s) => { if (s !== lastNote) print(`[${new Date().toISOString()}] r309-fold keeper: ${s}`); lastNote = s; };
  const iv = setInterval(() => {
    let r; try { r = keeperTick(st, { nowMs: Date.now(), selfFile: __filename, startSha, statusFile: path.join(homeDir, "r309-fold-status.json"), lockFile, pid: process.pid, runChild: keeperChild, note }); }
    catch (e) { print(`[${new Date().toISOString()}] r309-fold keeper: tick failed (${String(e.message).slice(0, 160)}) — continuing`); return; }
    if (r === "ran") lastNote = null;   // a repeated note is logged once per stretch (a scanner holding the file for minutes: one line)
    if (r === "exit") { print(`[${new Date().toISOString()}] r309-fold keeper: ${st.exitWhy || "exit"} — exiting after ${st.runs || 0} run(s)`); clearInterval(iv); drop(); }
  }, TICK_MS);
  for (const sig of ["SIGTERM", "SIGINT", "SIGBREAK"]) process.once(sig, () => { clearInterval(iv); drop(); process.exit(0); });
}

function statusText(file, nowMs = Date.now()) {
  let st = null; try { st = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return "no r309-fold-status.json yet (no fold run recorded)"; }
  const runs = Array.isArray(st.runs) ? st.runs : [], day = runs.filter((r) => nowMs - Date.parse(r.at) <= 24 * 3600000);
  const by = {}; for (const r of day) { const k = r.from; by[k] = by[k] || { n: 0, ok: 0, bad: 0, skipped: 0 }; by[k].n++; if (r.pull.exit === 0) by[k].ok++; else if (r.pull.exit === 3) by[k].skipped++; else by[k].bad++; }
  return [`r309-fold: ${runs.length} run(s) recorded; last 24 h: ${Object.entries(by).map(([k, v]) => `${k} ${v.n} (${v.ok} ok, ${v.bad} refused/failed, ${v.skipped} skipped)`).join(" · ") || "none"}`,
    ...runs.slice(-12).map((r) => `  ${r.at} ${String(r.from).padEnd(16)} pull ${r.pull.exit} ${r.pull.kind}${r.pull.why ? " — " + String(r.pull.why).slice(0, 90) : ""} · guard ${r.guard}${r.alarm ? ` · alarm ${r.alarm.ran ? "exit " + r.alarm.exit : "DID NOT RUN"}` : ""}`)].join("\n");
}

// ── selftest ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + String(d).slice(0, 500) : "")); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r309-fold-selftest-"));
  const jl = (rows) => rows.map((x) => JSON.stringify(x)).join("\n") + "\n";
  const T = (files) => PS.tarOf(Object.entries(files).map(([name, data]) => ({ name, data })));
  try {
    console.log("r309-fold selftest (" + tmp + ")");
    const H = path.join(tmp, "home"); fs.mkdirSync(H);
    const w = (n, s) => fs.writeFileSync(path.join(H, n), s), r = (n) => fs.readFileSync(path.join(H, n), "utf8"), ex = (n) => fs.existsSync(path.join(H, n));
    const map = (units) => w("host-ownership.json", JSON.stringify({ schema: "host-ownership-v1", units }));
    w("r309-HALT", "home backstop\n"); w("r309-OFF", "home off\n"); w("TRAIDS_STOP", "stop\n"); map({ r309: "server", "w1-whales": "server" });
    let srv = {}, calls = [];
    const fake = (script, o = {}) => { calls.push(String(script)); if (TAR_CMD.test(script)) return { ok: true, status: 0, out: T(srv), err: "" }; return { ok: false, status: 1, out: o.binary ? Buffer.alloc(0) : "", err: "unexpected" }; };
    const deps = { homeDir: H, ssh: fake, foldStatusFile: path.join(H, "r309-fold-status.json") };
    const out = [], err = [], health = [];
    const R = (mode, from, o = {}) => { out.length = 0; err.length = 0; const code = run({ mode, from, deps: { ...deps, ...(o.deps || {}) }, dry: !!o.dry, print: (s) => out.push(s), printErr: (s) => err.push(s), runHealth: o.health || ((rc) => { health.push(rc); return { ran: true, exit: 0 }; }) }); return code; };
    const lot = (x = {}) => ({ kind: "lot", id: "r309-BTC-2026101213", coin: "BTC", day: "2026-10-12", signalHour: "2026-10-12T13:00:00Z", signalClose: 64000, stats: { ret: 0.02 }, twin: { hour: "2026-10-10T02:00:00Z", seedKey: "k", seed: 7, entryClose: 63000, exitHour: "2026-10-12T02:00:00Z", poolSize: 120, net: null }, shadow: { exitHour: "2026-10-14T13:00:00Z", exitClose: null, net: null }, host: "vps", status: "submitting", entry: { cid: "r309-BTC-2026101213-B", notionalOrdered: 2000, submittedAt: "2026-10-12T14:02:31Z" }, exit: { legs: [] }, fees: {}, notes: [], ...x });
    const cyc1 = jl([{ ts: "2026-10-12T14:02:05Z", live: true }]), cyc2 = cyc1 + jl([{ ts: "2026-10-12T15:02:05Z", live: true }]);
    srv = { "r309-cycles.jsonl": cyc1, "r309-ledger.jsonl": jl([lot()]), "r309-surge-hold48.json": JSON.stringify({ config: { evidenceStart: "2026-10-08" }, read: null }) };
    let c = R("alert", "preflight.bat");
    ok("--alert: the three present files land through pull-server; exactly ONE ssh call (the tar); the alarm gets --pull-rc 0; exit = the alarm's", c === 0 && r("r309-cycles.jsonl") === cyc1 && ex("r309-ledger.jsonl") && !ex("r309-interim.json") && calls.length === 1 && health.join(",") === "0", JSON.stringify({ c, out, calls: calls.length, health }));
    ok("the ok line is a fold line: not the retired task's ok line, not a refusal line r309-health would quote", /r309-fold ok \(pull-server --wave r309 \+ the pull-r309 rules guard, from preflight\.bat\)/.test(out[0]) && !isOldTaskLine(out[0]) && !HEALTH_PULL_LINE.test(out[0]), out[0]);
    ok("switch files never touched: r309-HALT, r309-OFF, TRAIDS_STOP byte-equal after the pull", r("r309-HALT") === "home backstop\n" && r("r309-OFF") === "home off\n" && r("TRAIDS_STOP") === "stop\n");
    const st1 = JSON.parse(r("r309-fold-status.json"));
    ok("the run is recorded (from, pull exit 0, guard ok, alarm ran exit 0, pullRc 0, user, interactive false under a redirect)", st1.schema === "r309-fold-status-v1" && st1.runs.length === 1 && st1.runs[0].from === "preflight.bat" && st1.runs[0].pull.exit === 0 && st1.runs[0].guard === "ok" && st1.runs[0].alarm.ran === true && st1.runs[0].alarm.pullRc === 0 && typeof st1.runs[0].interactive === "boolean", JSON.stringify(st1.runs[0]));
    ok("pull-server recorded the wave too (its own status file: waves.r309 ok)", JSON.parse(r("pull-server-status.json")).waves.r309.ok === true);
    calls.length = 0; health.length = 0;
    srv = { ...srv, "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([lot({ status: "open", entry: { ...lot().entry, avgPx: 64100, filledQty: "0.0312", filledAt: "2026-10-12T14:02:33Z", orderId: "o-1" } })]) };
    c = R("pull", "close-chain");
    ok("--pull (the chain): append + a lot moving forward (submitting -> open) -> pulled, exit 0, NO alarm run", c === 0 && r("r309-cycles.jsonl") === cyc2 && JSON.parse(r("r309-ledger.jsonl").trim()).status === "open" && health.length === 0, JSON.stringify(out));
    // refusals: nothing written, the refusal line is the one r309-health quotes, the alarm hears the code
    const snapH = () => fs.readdirSync(H).filter((f) => !/status\.json$|\.lock$/.test(f)).map((f) => f + ":" + fs.readFileSync(path.join(H, f)).toString("base64")).sort().join("|");
    const refuse = (name, files, re, kind) => { const before = snapH(); health.length = 0; srv = files; const code = R("alert", "preflight.bat"); const after = snapH(); const rec = JSON.parse(r("r309-fold-status.json")).runs.slice(-1)[0]; ok(name, code === 1 && before === after && HEALTH_PULL_LINE.test(out[0]) && /r309 fold/.test(out[0]) && re.test(out[0]) && health.join(",") === "1" && rec.pull.exit === 1 && (!kind || rec.pull.kind === kind), JSON.stringify({ code, out: out[0], health, kind: rec.pull.kind })); };
    const LED = jl([lot({ status: "open", entry: { ...lot().entry, avgPx: 64100, filledQty: "0.0312", filledAt: "2026-10-12T14:02:33Z", orderId: "o-1" } })]);
    refuse("pull-server's rules: the cycles log not an extension of home's -> REFUSED, nothing written, the alarm hears --pull-rc 1", { "r309-cycles.jsonl": cyc1, "r309-ledger.jsonl": LED }, /exact prefix/, "refused");
    refuse("pull-server's rules: a lot's status moving backward (open -> submitted, the fill fields unchanged) -> REFUSED", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([lot({ status: "submitted", entry: { ...lot().entry, avgPx: 64100, filledQty: "0.0312", filledAt: "2026-10-12T14:02:33Z", orderId: "o-1" } })]) }, /status open -> submitted moves backward/, "refused");
    refuse("THE GUARD: a server ledger row with an EMPTY id (pull-server alone would accept it) -> REFUSED by pull-r309's rules, nothing written", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": LED + jl([{ kind: "missed", id: "", day: "2026-10-12" }]) }, /parity guard[^]*has no id/, "guard");
    refuse("THE GUARD: an evidenceStart that is an object equal on both sides (pull-server alone would accept) -> REFUSED", (() => { w("r309-surge-hold48.json", JSON.stringify({ config: { evidenceStart: { d: "2026-10-08" } } })); return { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": LED, "r309-surge-hold48.json": JSON.stringify({ config: { evidenceStart: { d: "2026-10-08" } } }) }; })(), /parity guard[^]*evidenceStart/, "guard");
    w("r309-surge-hold48.json", JSON.stringify({ config: { evidenceStart: 0 } }));
    refuse("pull-server's rules where the OLD rules alone would accept (evidenceStart 0 set at home, changed on the VPS) -> REFUSED (the fold takes the stricter answer)", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": LED, "r309-surge-hold48.json": JSON.stringify({ config: { evidenceStart: "2026-10-08" } }) }, /evidenceStart 0 on home/, "refused");
    w("r309-surge-hold48.json", JSON.stringify({ config: { evidenceStart: "2026-10-08" }, read: null }));
    refuse("never synced: r309-OFF inside the server's tar -> REFUSED; home's r309-OFF untouched", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": LED, "r309-OFF": "server off\n" }, /r309-OFF/, null);
    ok("...and home's r309-OFF / r309-HALT are still home's bytes", r("r309-OFF") === "home off\n" && r("r309-HALT") === "home backstop\n");
    refuse("never synced: r309-HALT inside the server's tar -> REFUSED", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": LED, "r309-HALT": "x" }, /r309-HALT/, null);
    srv = { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": LED, "r309-surge-hold48.json": JSON.stringify({ config: { evidenceStart: "2026-10-08" }, read: null }) };
    // an ssh that cannot connect: FAILED, the alarm hears 1
    { health.length = 0; const code = R("alert", "preflight.bat", { deps: { ssh: () => ({ ok: false, status: 255, out: Buffer.alloc(0), err: "ssh: connect to host traids port 22: Connection timed out" }) } });
      ok("ssh down -> 'pull-r309 FAILED (nothing written; r309 fold ...)' and --pull-rc 1", code === 1 && /pull-r309 FAILED \(nothing written; r309 fold via pull-server, from preflight\.bat\): ssh: exit 255/.test(out[0]) && health.join(",") === "1", JSON.stringify({ code, out })); }
    // an exit-75 answer with NO tar: pull-server reads it as "busy" (the wave exit 0, nothing pulled) — for the fold that is NEVER a clean pull
    { const busySsh = () => ({ ok: false, status: 75, out: Buffer.alloc(0), err: "" }), last = () => JSON.parse(r("r309-fold-status.json")).runs.slice(-1)[0];
      health.length = 0; const before = snapH(), code = R("alert", "preflight.bat", { deps: { ssh: busySsh } }), rec = last();
      ok("an exit-75 ('busy') ssh answer while manifests/r309.json gives r309 NO server lock -> REFUSED: exit 1, the 'pull-r309 REFUSED' line r309-health quotes, guard 'not reached', the alarm hears --pull-rc 1 (never 0: the failure streak is not reset), nothing written", code === 1 && HEALTH_PULL_LINE.test(out[0]) && /r309 fold/.test(out[0]) && /no tar of the four run files reached the parity guard[^]*exit-75 'busy'[^]*lock: null/.test(out[0]) && health.join(",") === "1" && rec.pull.exit === 1 && rec.pull.kind === "refused" && rec.guard === "not reached" && rec.alarm.pullRc === 1 && snapH() === before, JSON.stringify({ code, out, health, rec }));
      const src = JSON.parse(fs.readFileSync(path.join(PS.MANIFEST_DIR, "r309.json"), "utf8")), md = path.join(tmp, "manifest-with-lock"); fs.mkdirSync(md);
      fs.writeFileSync(path.join(md, "r309.json"), JSON.stringify({ ...src, units: { r309: { ...src.units.r309, lock: "r309.flock" } } }));
      health.length = 0; const c1 = R("alert", "preflight.bat", { deps: { ssh: busySsh, manifestDir: md } }), o1 = out[0], rec1 = last(), c2 = R("pull", "close-chain", { deps: { ssh: busySsh, manifestDir: md } }), e2 = err.slice();
      ok("the same exit-75 answer under a manifest that DOES give r309 a server lock (r309.flock; today's has lock: null) -> SKIPPED, never 'ok': --alert runs the alarm WITHOUT --pull-rc (the streak neither counted nor reset), --pull exits 3 (the chain's WARN) naming the lock; guard 'not reached'; nothing written", src.units.r309.lock === null && c1 === 0 && health.length === 1 && health[0] === null && /r309-fold SKIPPED \(from preflight\.bat\): the server held r309's lock \(r309\.flock\)/.test(o1) && rec1.pull.exit === 3 && rec1.pull.kind === "skipped" && rec1.guard === "not reached" && rec1.alarm.pullRc === null && c2 === 3 && /^r309-fold WARN: the server held r309's lock \(r309\.flock\)/.test(e2[e2.length - 1] || "") && snapH() === before, JSON.stringify({ c1, o1, rec1, c2, e2, health })); }
    // the map: r309 is fixed on the VPS; a map giving it to home, or a torn map, is a refusal with NO ssh
    { map({ r309: "home" }); calls.length = 0; health.length = 0; const code = R("alert", "preflight.bat");
      ok("host-ownership gives r309 to HOME -> REFUSED (R309 runs only on the VPS), no ssh, the alarm hears 1", code === 1 && calls.length === 0 && /R309 runs only on the VPS/.test(out[0]) && health.join(",") === "1", JSON.stringify({ code, out, calls })); }
    { w("host-ownership.json", "{ torn"); calls.length = 0; const code = R("pull", "close-chain");
      ok("a torn host-ownership.json -> REFUSED (ownership unknown, never a guess), no ssh", code === 1 && calls.length === 0 && /ownership unknown|does not parse/.test(out[0] + err.join(" ")), JSON.stringify({ code, out, err })); }
    { map({ "w1-whales": "server" }); calls.length = 0; const code = R("pull", "close-chain");
      ok("a map that does not name r309 -> the manifest's fixedOwner (server) -> pulled", code === 0 && calls.length === 1, JSON.stringify({ code, out })); }
    map({ r309: "server" });
    // HALT
    { fs.unlinkSync(path.join(H, "r309-HALT")); calls.length = 0; health.length = 0; const before = fs.readdirSync(H).sort().join(","); const code = R("alert", "preflight.bat");
      ok("home r309-HALT missing -> exit 4 before any ssh, nothing written but the run record, the alarm hears --pull-rc 4 (it names the HALT)", code === 4 && calls.length === 0 && /pull-r309 REFUSED \(exit 4; r309 fold/.test(out[0]) && health.join(",") === "4" && fs.readdirSync(H).sort().join(",") === before, JSON.stringify({ code, out, calls })); w("r309-HALT", "home backstop\n"); }
    // HALT missing AND the guard unloadable / the manifest unreadable: the fold's own HALT pre-check names the HALT (exit 4), never
    // "guard-missing" / "manifest" (the alarm would then say "pull failing" instead of "r309-HALT is missing - restore it")
    { fs.unlinkSync(path.join(H, "r309-HALT")); calls.length = 0; health.length = 0; const before = fs.readdirSync(H).sort().join(","), last = () => JSON.parse(r("r309-fold-status.json")).runs.slice(-1)[0];
      const c1 = R("alert", "preflight.bat", { deps: { guardFile: path.join(tmp, "absent-guard.cjs") } }), o1 = out[0], k1 = last().pull.kind;
      const c2 = R("alert", "preflight.bat", { deps: { manifestDir: path.join(tmp, "absent-manifests") } }), o2 = out[0], k2 = last().pull.kind;
      ok("home r309-HALT missing AND the parity guard absent (or the manifest dir absent) -> still exit 4, kind 'halt', --pull-rc 4, the line names the HALT — never 'guard-missing' / 'manifest'; no ssh, nothing written but the run records", c1 === 4 && c2 === 4 && k1 === "halt" && k2 === "halt" && health.join(",") === "4,4" && /pull-r309 REFUSED \(exit 4; r309 fold[^]*r309-HALT is missing/.test(o1) && /r309-HALT is missing/.test(o2) && calls.length === 0 && fs.readdirSync(H).sort().join(",") === before, JSON.stringify({ c1, c2, k1, k2, o1, o2, health, calls: calls.length }));
      w("r309-HALT", "home backstop\n"); }
    // the home lock held by a live process: skipped, WARN 3 for the chain, no --pull-rc for the alarm
    { fs.writeFileSync(path.join(H, "pull-server.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), what: "other" })); calls.length = 0; health.length = 0;
      const c1 = R("pull", "close-chain"), e1 = err.slice(), c2 = R("alert", "preflight.bat");
      ok("home lock held -> --pull exits 3 (the chain's WARN) with the reason as the LAST stderr line; --alert runs the alarm WITHOUT --pull-rc (streak untouched); no ssh", c1 === 3 && /^r309-fold WARN: another pull-server run holds/.test(e1[e1.length - 1] || "") && c2 === 0 && health.length === 1 && health[0] === null && calls.length === 0, JSON.stringify({ c1, e1, c2, health })); fs.unlinkSync(path.join(H, "pull-server.lock")); }
    // the guard itself missing / wrong -> fail-closed
    { const bad = path.join(tmp, "not-the-guard.cjs"); fs.writeFileSync(bad, "module.exports = { FILES: ['x'] };\n"); calls.length = 0;
      const code = R("pull", "manual", { deps: { guardFile: bad } }), code2 = R("pull", "manual", { deps: { guardFile: path.join(tmp, "absent.cjs") } });
      ok("the parity guard missing or not pull-r309.cjs -> REFUSED before any ssh (never a pull without both rule sets)", code === 1 && code2 === 1 && calls.length === 0 && /parity guard \(deploy\/server\/pull-r309\.cjs\) cannot be loaded/.test(out[0]), JSON.stringify({ code, code2, out })); }
    // a guard that HAS validate / untar but guards other files: refused on its FILES (not on a missing export)
    { const one = path.join(tmp, "guard-one-file.cjs"), four = path.join(tmp, "guard-four-files.cjs"), th = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
      fs.writeFileSync(one, "module.exports = { validate() {}, untar() { return []; }, FILES: ['r309-cycles.jsonl'] };\n");
      fs.writeFileSync(four, "module.exports = { validate() {}, untar() { return []; }, FILES: " + JSON.stringify([...FOUR].reverse()) + " };\n");
      calls.length = 0; const code = R("pull", "manual", { deps: { guardFile: one } }), rec = JSON.parse(r("r309-fold-status.json")).runs.slice(-1)[0], e1 = th(() => loadGuard(one)), e4 = th(() => loadGuard(four));
      ok("a guard exporting validate() and untar() whose FILES are NOT R309's four (only r309-cycles.jsonl) -> REFUSED, kind 'guard-missing', before any ssh; the same stub over the four files (any order) loads", code === 1 && calls.length === 0 && rec.pull.kind === "guard-missing" && /pulls r309-cycles\.jsonl — not R309's four run files/.test(out[0]) && /not R309's four run files/.test(e1 || "") && e4 === null, JSON.stringify({ code, kind: rec.pull.kind, out, e1, e4 })); }
    // manifests/r309.json must pull EXACTLY the four files: 3 (one dropped) or 5 (one added) is refused before any ssh
    { const src = JSON.parse(fs.readFileSync(path.join(PS.MANIFEST_DIR, "r309.json"), "utf8")), last = () => JSON.parse(r("r309-fold-status.json")).runs.slice(-1)[0];
      const mk = (name, entries) => { const d = path.join(tmp, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, "r309.json"), JSON.stringify({ ...src, units: { r309: { ...src.units.r309, entries } } })); return d; };
      const m3 = mk("manifest-3", src.units.r309.entries.filter((e) => e.path !== "r309-interim.json")), m5 = mk("manifest-5", [...src.units.r309.entries, { path: "r309-extra.json", kind: "json", seed: false }]);
      calls.length = 0; health.length = 0;
      const c3 = R("pull", "manual", { deps: { manifestDir: m3 } }), o3 = out[0], k3 = last().pull.kind, c5 = R("pull", "manual", { deps: { manifestDir: m5 } }), o5 = out[0], k5 = last().pull.kind;
      ok("a manifests/r309.json pulling 3 files (r309-interim.json dropped) or 5 (r309-extra.json added) -> REFUSED, kind 'manifest', naming what it pulls, before any ssh", src.units.r309.entries.length === 4 && c3 === 1 && c5 === 1 && k3 === "manifest" && k5 === "manifest" && /pulls r309-cycles\.jsonl, r309-ledger\.jsonl, r309-surge-hold48\.json — not R309's four run files/.test(o3) && /pulls r309-cycles\.jsonl, r309-extra\.json, r309-interim\.json, r309-ledger\.jsonl, r309-surge-hold48\.json — not R309's four/.test(o5) && calls.length === 0, JSON.stringify({ c3, c5, k3, k5, o3, o5, calls: calls.length })); }
    // interactive: a hand run at a terminal is told apart from the scheduled runs (deps.isTTY stands in for process.stdout.isTTY)
    { const last = () => JSON.parse(r("r309-fold-status.json")).runs.slice(-1)[0];
      R("pull", "manual", { deps: { isTTY: true } }); const a = last().interactive; R("pull", "manual", { deps: { isTTY: false } }); const b = last().interactive;
      ok("a run whose stdout is a TERMINAL is recorded interactive:true (the retire gate, cadence parity and register never count it); under a redirect interactive:false", a === true && b === false, JSON.stringify({ a, b })); }
    // an unexpected ssh script is refused by the guard wrapper
    { const seen = {}; const g = guardedSsh(fake, loadGuard(), PS.loadManifest("r309").units.r309, H, seen); const x = g("rm -rf /", {}); ok("the guarded ssh refuses any call that is not the tar (no other ssh can happen through the fold)", !x.ok && /unexpected ssh call/.test(x.err) && seen.unexpected === "rm -rf /"); }
    // the alarm could not run -> recorded, exit 1
    { const code = R("alert", "preflight.bat", { health: () => ({ ran: false, exit: null, why: "spawn ENOENT" }) }); const rec = JSON.parse(r("r309-fold-status.json")).runs.slice(-1)[0];
      ok("the alarm failing to start -> exit 1, the record says alarm ran:false (the retire gate counts it as NOT clean)", code === 1 && rec.alarm.ran === false && /did NOT run/.test(out.join(" ")), JSON.stringify({ code, rec })); }
    { const code = R("alert", "preflight.bat", { health: () => ({ ran: true, exit: 3 }) }); ok("--alert after a good pull returns the alarm's own code (3 FAIL here), as pull-r309.bat did", code === 3); }
    // --dry: no write at all
    { srv = { ...srv, "r309-cycles.jsonl": cyc2 + jl([{ ts: "2026-10-12T16:02:05Z", live: true }]) }; const before = snapH(), stBefore = r("r309-fold-status.json"), psBefore = r("pull-server-status.json"); const code = R("pull", "manual", { dry: true });
      ok("--dry: validates and plans ('would update'), writes NOTHING (no data file, no fold record, no pull-server status)", code === 0 && /r309-fold DRY ok/.test(out[0]) && /would update r309-cycles\.jsonl/.test(out[0]) && snapH() === before && r("r309-fold-status.json") === stBefore && r("pull-server-status.json") === psBefore, JSON.stringify(out)); }
    // the record is capped
    { const f = path.join(tmp, "cap.json"); for (let i = 0; i < KEEP + 5; i++) { const st = { schema: "r309-fold-status-v1", runs: Array.from({ length: i }, (_, k) => ({ at: "x" + k })) }; if (i === KEEP + 4) fs.writeFileSync(f, JSON.stringify(st)); }
      appendRun(f, { at: "last" }); const st = JSON.parse(fs.readFileSync(f, "utf8")); ok(`the record keeps the last ${KEEP} runs`, st.runs.length === KEEP && st.runs[KEEP - 1].at === "last" && st.runs[0].at === "x5"); }
    // the retired task's lines are told apart from the fold's
    ok("old-task lines are recognised ('pull-r309 ok from' / REFUSED / FAILED without 'r309 fold'); fold lines never are", isOldTaskLine("[2026-10-09T19:25:03.864Z] pull-r309 ok from traids:/home/traids/traids/backend/data — server files r309-ledger.jsonl: no change · home r309-HALT present") && isOldTaskLine("[2026-10-09T19:25:03.864Z] pull-r309 REFUSED (nothing written): x") && !isOldTaskLine(pullLine({ exit: 1, kind: "refused", why: "x" }, "preflight.bat", "2026-10-09T19:25:03.864Z")) && !isOldTaskLine(pullLine({ exit: 4, kind: "halt", why: "x" }, "close-chain", "2026-10-09T19:25:03.864Z")));
    ok("every fold refusal / failure / HALT line matches r309-health's pull-line pattern (its page quotes the reason)", [pullLine({ exit: 1, kind: "refused", why: "a" }, "x"), pullLine({ exit: 1, kind: "failed", why: "a" }, "x"), pullLine({ exit: 1, kind: "guard", why: "a" }, "x"), pullLine({ exit: 4, kind: "halt", why: "a" }, "x")].every((l) => HEALTH_PULL_LINE.test(l)));
    // r309-health's own source still reads that pattern from r309-pull.log (text check of the installed alarm)
    { let src = ""; try { src = fs.readFileSync(path.join(REPO, "backend", "lib", "r309-health.cjs"), "utf8"); } catch { src = ""; }
      ok("the installed r309-health.cjs reads automation/r309-pull.log with /pull-r309 (FAILED|REFUSED)/ and takes --alert --pull-rc", src.includes('/pull-r309 (FAILED|REFUSED)/') && src.includes('"r309-pull.log"') && /opt\("pull-rc", null\)/.test(src)); }
    // arguments
    ok("arguments: --alert only from preflight.bat, keeper or manual; --from is required and must be known; --keeper alone", parseArgs(["--alert", "--from", "close-chain"]).error && parseArgs(["--pull"]).error && parseArgs(["--pull", "--from", "x"]).error && !parseArgs(["--pull", "--from", "close-chain-git"]).error && parseArgs(["--alert", "--from", "preflight.bat", "--dry"]).error && parseArgs(["--pull", "--from", "manual", "--live"]).error && !parseArgs(["--alert", "--from", "keeper"]).error && parseArgs(["--keeper", "--dry"]).error && parseArgs(["--keeper"]).mode === "keeper");
    // ── the keeper ──
    const Z = (mt) => Date.parse(mt.replace(" ", "T") + ":00-06:00");   // an MT wall time in October (MDT, UTC-6)
    const due = (now, last) => keeperDue(Z(now), last == null ? NaN : Z(last));
    ok("keeperDue: inside the preflight hours it waits for preflight (Mon 10:25, last alarm 10:00 -> no; last 09:00 -> yes, a missed fire); 18:56 after the 18:00 fire -> no", !due("2026-10-12 10:25", "2026-10-12 10:00") && due("2026-10-12 10:25", "2026-10-12 09:00") && !due("2026-10-12 18:56", "2026-10-12 18:00"));
    ok("keeperDue: outside them about hourly (Mon 19:00 after 18:00 -> yes; 19:54 after 19:00 -> no, 19:55 -> yes); Sat 11:00 after Fri 18:00 -> yes; Mon 05:30 -> yes; no alarm ever -> yes", due("2026-10-12 19:00", "2026-10-12 18:00") && !due("2026-10-12 19:54", "2026-10-12 19:00") && due("2026-10-12 19:55", "2026-10-12 19:00") && due("2026-10-10 11:00", "2026-10-09 18:00") && due("2026-10-12 05:30", "2026-10-11 23:00") && due("2026-10-12 21:00", null));
    ok("keeperDue: inside the preflight hours a late or still-running :00 fire is waited for up to 70 min — Mon 11:05 after an alarm at 10:00:20 -> no; 11:05 / 11:09 after 10:00 (65 / 69 min) -> no; 11:10 (70 min) -> yes", !keeperDue(Z("2026-10-12 11:05"), Z("2026-10-12 10:00") + 20000) && !due("2026-10-12 11:05", "2026-10-12 10:00") && !due("2026-10-12 11:09", "2026-10-12 10:00") && due("2026-10-12 11:10", "2026-10-12 10:00"));
    { const wk = [["Mon", "2026-10-12"], ["Tue", "2026-10-13"], ["Wed", "2026-10-14"], ["Thu", "2026-10-15"], ["Fri", "2026-10-16"]], res = wk.map(([n, d]) => `${n} ${!due(`${d} 10:56`, `${d} 10:00`)}/${due(`${d} 19:00`, `${d} 18:00`)}`);
      ok("keeperDue on EVERY weekday (Mon 10-12 .. Fri 10-16): 10:56 after the 10:00 fire -> no (preflight's hours: the keeper never doubles the cadence); 19:00 after 18:00 -> yes (the evening is the keeper's); Sat 10-17 / Sun 10-18 10:56 after 10:00 -> yes (no fires at weekends)", res.every((x) => /true\/true$/.test(x)) && due("2026-10-17 10:56", "2026-10-17 10:00") && due("2026-10-18 10:56", "2026-10-18 10:00"), res.join(" "));
      ok("inPreflightHours: Mon 05:59 no, 06:00 yes, 18:59 yes, 19:00 no; Fri 18:30 yes; Sat 10:00 no", !inPreflightHours(Z("2026-10-12 05:59")) && inPreflightHours(Z("2026-10-12 06:00")) && inPreflightHours(Z("2026-10-12 18:59")) && !inPreflightHours(Z("2026-10-12 19:00")) && inPreflightHours(Z("2026-10-16 18:30")) && !inPreflightHours(Z("2026-10-17 10:00"))); }
    { const f = path.join(tmp, "st.json"); fs.writeFileSync(f, JSON.stringify({ runs: [{ at: "2026-10-12T16:00:05Z", mode: "alert", alarm: { ran: true } }, { at: "2026-10-12T20:15:00Z", mode: "pull", alarm: null }, { at: "2026-10-12T21:00:05Z", mode: "alert", alarm: { ran: false } }] }));
      ok("lastAlertMs: the last run whose ALARM ran (a chain pull or an alarm that did not run is not one)", lastAlertMs(f) === Date.parse("2026-10-12T16:00:05Z") && Number.isNaN(lastAlertMs(path.join(tmp, "absent.json")))); }
    { const lf = path.join(tmp, "k.lock"), now = Date.now();
      fs.writeFileSync(lf, JSON.stringify({ pid: process.ppid, beatAt: new Date(now - 60000).toISOString() }));
      const a = takeKeeperLock(lf, now, process.pid);
      fs.writeFileSync(lf, JSON.stringify({ pid: process.ppid, beatAt: new Date(now - 20 * 60000).toISOString() }));
      const b = takeKeeperLock(lf, now, process.pid);
      const deadPid = cp.spawnSync(process.execPath, ["-e", "0"]).pid; fs.writeFileSync(lf, JSON.stringify({ pid: deadPid, beatAt: new Date(now).toISOString() }));
      const c = takeKeeperLock(lf, now, process.pid);
      ok("keeper lock: a LIVE pid with a fresh beat -> 'running' (one keeper); a live pid with a 20-min-old beat (pid reuse after a reboot) -> replaced; a dead pid -> replaced", !a.ok && a.running && b.ok && b.replaced && c.ok && JSON.parse(fs.readFileSync(lf, "utf8")).pid === process.pid, JSON.stringify([a, b, c])); }
    { // THE LOCK IS CREATED EXCLUSIVELY ("wx"): two starts in the same instant can never both take it
      const lf = path.join(tmp, "wx.lock"), now = Date.now(), th = (fn) => { try { return fn(); } catch (e) { return { threw: e.message }; } };
      const a = takeKeeperLock(lf, now, process.pid, "s"), body = JSON.parse(fs.readFileSync(lf, "utf8")), b = takeKeeperLock(lf, now, process.ppid, "s");
      ok("keeper lock on an ABSENT file: created (pid, startedAt, beatAt, sha, version); a second start by another live pid right after -> 'running' naming the first, the file untouched", a.ok && a.replaced === null && body.pid === process.pid && body.sha === "s" && body.version === VERSION && Date.parse(body.beatAt) === now && !b.ok && b.running && b.running.pid === process.pid && JSON.parse(fs.readFileSync(lf, "utf8")).pid === process.pid, JSON.stringify([a, b, body]));
      const tf = path.join(tmp, "torn.lock"); fs.writeFileSync(tf, "");
      const c = takeKeeperLock(tf, now, process.pid, null), keptEmpty = fs.readFileSync(tf, "utf8") === "";
      fs.writeFileSync(tf, '{"pid": ' + process.ppid + ', "beat'); const c2 = takeKeeperLock(tf, now, process.pid, null), keptTorn = /"beat$/.test(fs.readFileSync(tf, "utf8"));
      const old = new Date(Date.now() - 60000); fs.utimesSync(tf, old, old); const d = takeKeeperLock(tf, now, process.pid, null);
      ok(`keeper lock read EMPTY or TORN and only seconds old (another start's exclusive create caught before its write) -> NOT taken (running: null), the file left as it is; the same torn file 60 s old (older than ${LOCK_TORN_FRESH_MS / 1000} s: a crash) -> replaced`, LOCK_TORN_FRESH_MS === 10000 && !c.ok && c.running === null && keptEmpty && !c2.ok && c2.running === null && keptTorn && d.ok && d.replaced === null && JSON.parse(fs.readFileSync(tf, "utf8")).pid === process.pid, JSON.stringify([c, c2, d]));
      const e = th(() => takeKeeperLock(path.join(tmp, "no-such-folder", "k.lock"), now, process.pid, null));
      ok("keeper lock that cannot be created (its folder missing) -> { ok:false, why } naming ENOENT — never a throw, never 'running'", e && e.ok === false && !("running" in e) && /could not be created \(ENOENT\)/.test(e.why || ""), JSON.stringify(e));
      const src = fs.readFileSync(__filename, "utf8"), fn = src.slice(src.indexOf("function takeKeeperLock("), src.indexOf("const keeperStartState"));
      ok("takeKeeperLock writes the lock ONLY through an exclusive create (flag \"wx\", like pull-server.cjs takeLock): no check-then-write (no writeJsonAtomic, no plain writeFileSync) in it", /writeFileSync\(file, body, \{ flag: "wx" \}\)/.test(fn) && !/writeJsonAtomic/.test(fn) && (fn.match(/writeFileSync\(/g) || []).length === 1 && /unlinkSync\(file\)/.test(fn), fn.slice(0, 200));
      // SIX real processes take the same absent lock at the same instant; each stays alive until all six have tried
      const N = 6, rl = path.join(tmp, "race.lock"), child = path.join(tmp, "race-child.cjs"), orch = path.join(tmp, "race-orch.cjs");
      fs.writeFileSync(child, 'const [fold, lock, t0] = process.argv.slice(2), RF = require(fold);\nwhile (Date.now() < Number(t0)) {}\nconst r = RF.takeKeeperLock(lock, Date.now(), process.pid, null);\nprocess.stdout.write(JSON.stringify({ pid: process.pid, ok: !!r.ok }) + "\\n");\nprocess.stdin.resume(); process.stdin.on("end", () => process.exit(0));\n');
      fs.writeFileSync(orch, 'const cp = require("child_process"), [child, fold, lock, n, t0] = process.argv.slice(2), kids = [], res = [];\nfor (let i = 0; i < Number(n); i++) { const c = cp.spawn(process.execPath, [child, fold, lock, t0], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true }); let o = "", done = false; c.stdout.on("data", (x) => { o += x; if (!done && o.includes("\\n")) { done = true; res.push(JSON.parse(o)); if (res.length === Number(n)) for (const k of kids) k.stdin.end(); } }); kids.push(c); }\nconst guard = setTimeout(() => { for (const k of kids) { try { k.kill(); } catch {} } }, 45000);\nlet closed = 0; for (const k of kids) k.on("close", () => { if (++closed === kids.length) { clearTimeout(guard); process.stdout.write(JSON.stringify(res)); } });\n');
      const rr = cp.spawnSync(process.execPath, [orch, child, __filename, rl, String(N), String(Date.now() + 2000)], { encoding: "utf8", timeout: 90000, windowsHide: true });
      let got = []; try { got = JSON.parse(rr.stdout); } catch { got = []; }
      const winners = got.filter((x) => x.ok), holder = (() => { try { return JSON.parse(fs.readFileSync(rl, "utf8")).pid; } catch { return null; } })();
      ok(`keeper lock RACE: ${N} processes take the same absent lock at the same instant (all alive until all tried) -> EXACTLY ONE takes it, and the lock names that one (check-then-write let several through)`, got.length === N && winners.length === 1 && holder === winners[0].pid, JSON.stringify({ status: rr.status, got, holder, err: String(rr.stderr || "").slice(0, 200) }));
      // ...and whatever a start race leaves, the FIRST tick settles it: a keeper whose lock names another live keeper exits before it runs anything
      const fl = path.join(tmp, "first-tick.lock"), self = path.join(tmp, "self-first.cjs"); fs.writeFileSync(self, "// v1\n"); fs.writeFileSync(fl, JSON.stringify({ pid: process.ppid, beatAt: new Date().toISOString() }));
      let ran = 0; const s0 = keeperStartState(), t1 = Date.now(), r1 = keeperTick(s0, { nowMs: t1, selfFile: self, startSha: fileSha(self), statusFile: path.join(tmp, "absent-status.json"), lockFile: fl, pid: process.pid, runChild: () => { ran++; } });
      fs.writeFileSync(fl, JSON.stringify({ pid: process.pid, beatAt: new Date(t1).toISOString() }));
      const s1 = keeperStartState(), r2 = keeperTick(s1, { nowMs: t1, selfFile: self, startSha: fileSha(self), statusFile: path.join(tmp, "absent-status.json"), lockFile: fl, pid: process.pid, runChild: () => { ran++; } });
      ok("keeper's FIRST tick reads the lock back (start state lastBeat 0): the lock names ANOTHER live keeper while a run is due -> 'exit' with NOTHING run (no duplicate alarm from a lost start race); the lock its own -> it beats and runs", s0.lastBeat === 0 && r1 === "exit" && /another live keeper/.test(s0.exitWhy || "") && r2 === "ran" && ran === 1 && s1.lastBeat === t1, JSON.stringify({ r1, r2, ran, why: s0.exitWhy })); }
    { // THE KEEPER REMEMBERS ITS OWN RUN: a run whose record never lands (the status file absent, locked or unwritable) is not repeated every minute
      const lf = path.join(tmp, "mem.lock"), self = path.join(tmp, "self-mem.cjs"); fs.writeFileSync(self, "// v1\n");
      const sha0 = fileSha(self), t0 = Z("2026-10-12 20:00"), never = path.join(tmp, "never-written-status.json");
      fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, beatAt: new Date(t0).toISOString() }));
      const st = { lastBeat: t0 }, at = []; let ran = 0;
      for (let m = 0; m <= 110; m++) if (keeperTick(st, { nowMs: t0 + m * 60000, selfFile: self, startSha: sha0, statusFile: never, lockFile: lf, pid: process.pid, runChild: () => { ran++; } }) === "ran") at.push(m);
      ok("keeper memory: 111 ticks (Mon 20:00 -> 21:50 MT) with a status file that NEVER gets a record -> 3 runs, at minute 0, 55 and 110 (its own last run counts) — not one ssh pull + probe every minute", ran === 3 && at.join(",") === "0,55,110" && st.lastRunAt === t0 + 110 * 60000 && !fs.existsSync(never), JSON.stringify({ ran, at }));
      const st2 = { lastBeat: t0 }; let tries = 0, threw = 0;
      for (let m = 0; m < 30; m++) { try { keeperTick(st2, { nowMs: t0 + m * 60000, selfFile: self, startSha: sha0, statusFile: never, lockFile: lf, pid: process.pid, runChild: () => { tries++; throw new Error("spawn EBUSY"); } }); } catch { threw++; } }
      ok("keeper memory: a child that THROWS on every try, 30 ticks -> tried ONCE (the attempt is remembered before the child starts)", tries === 1 && threw === 1 && st2.lastRunAt === t0, JSON.stringify({ tries, threw }));
      const K = (now, rec, own) => keeperDue(Z(now), rec == null ? NaN : Z(rec), own == null ? NaN : Z(own));
      ok("keeperDue on the keeper's OWN last run alone (no record): outside the preflight hours 54 min -> no, 55 -> yes; inside them 69 -> no, 70 -> yes; with both, the LATER one decides (record 19:00 + own 19:30, or the reverse, at 20:00 -> no; both 19:00 at 19:55 -> yes)", !K("2026-10-12 20:54", null, "2026-10-12 20:00") && K("2026-10-12 20:55", null, "2026-10-12 20:00") && !K("2026-10-12 11:09", null, "2026-10-12 10:00") && K("2026-10-12 11:10", null, "2026-10-12 10:00") && !K("2026-10-12 20:00", "2026-10-12 19:00", "2026-10-12 19:30") && !K("2026-10-12 20:00", "2026-10-12 19:30", "2026-10-12 19:00") && K("2026-10-12 19:55", "2026-10-12 19:00", "2026-10-12 19:00"));
      // A RECORDED TIME IN THE FUTURE IS NO EVIDENCE (the clock stepped back, or a record written under a skewed clock): it never parks the keeper
      ok("keeperDue: the last recorded alarm 3 h AHEAD of now (Sun 21:00 MT) -> due (it used to idle until the clock passed it); 6 min ahead -> due; exactly 5 min and 4 min ahead (two processes' clocks) -> not due; 3 h ahead with the keeper's own run 10 min ago -> not due, 55 min ago -> due; its own run 3 h ahead -> due", FUTURE_SLACK_MS === 5 * 60000 && K("2026-10-11 21:00", "2026-10-12 00:00") && K("2026-10-11 21:00", "2026-10-11 21:06") && !K("2026-10-11 21:00", "2026-10-11 21:05") && !K("2026-10-11 21:00", "2026-10-11 21:04") && !K("2026-10-11 21:00", "2026-10-12 00:00", "2026-10-11 20:50") && K("2026-10-11 21:00", "2026-10-12 00:00", "2026-10-11 20:05") && K("2026-10-11 21:00", null, "2026-10-12 00:00"));
      const fut = path.join(tmp, "future-status.json"); fs.writeFileSync(fut, JSON.stringify({ runs: [{ at: new Date(t0 + 3 * 3600000).toISOString(), mode: "alert", alarm: { ran: true } }] }));
      const st3 = { lastBeat: t0 }, res = []; let n3 = 0;
      for (let m = 0; m < 10; m++) res.push(keeperTick(st3, { nowMs: t0 + m * 60000, selfFile: self, startSha: sha0, statusFile: fut, lockFile: lf, pid: process.pid, runChild: () => { n3++; } }));
      ok("keeper tick with the last recorded alarm 3 h in the future: it runs at the first tick (not parked for 3 h), then idles on its own memory — 1 run in 10 ticks", res[0] === "ran" && n3 === 1 && res.slice(1).every((x) => x === "idle"), res.join(",")); }
    { // a simulated evening + night + morning, one tick a minute: preflight fires recorded at :00 in its hours, the keeper fills the rest
      const sf = path.join(tmp, "sim-status.json"), lf = path.join(tmp, "sim.lock"), self = path.join(tmp, "self.cjs"); fs.writeFileSync(self, "// v1\n");
      const recs = [], save = () => fs.writeFileSync(sf, JSON.stringify({ runs: recs })), alarm = (ms, from) => { recs.push({ at: new Date(ms).toISOString(), from, mode: "alert", alarm: { ran: true } }); save(); };
      fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, beatAt: new Date(Z("2026-10-12 17:00")).toISOString() }));
      const st = { lastBeat: Z("2026-10-12 17:00") }, keeperAt = [], fires = new Set(["2026-10-12 17:00", "2026-10-12 18:00", "2026-10-13 06:00", "2026-10-13 07:00", "2026-10-13 08:00"]);
      const fmt = (ms) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
      for (let t = Z("2026-10-12 17:00"); t <= Z("2026-10-13 08:30"); t += 60000) {
        if (fires.has(fmt(t))) alarm(t, "preflight.bat");
        keeperTick(st, { nowMs: t, selfFile: self, startSha: fileSha(self), statusFile: sf, lockFile: lf, pid: process.pid, runChild: () => { keeperAt.push(fmt(t).slice(11)); alarm(t, "keeper"); } });
      }
      const all = recs.map((x) => Date.parse(x.at)), gaps = all.slice(1).map((x, i) => (x - all[i]) / 60000), maxGap = Math.max(...gaps);
      ok(`keeper simulation Mon 17:00 -> Tue 08:30 MT (PC awake): the keeper runs 19:00, then every 55 min until 05:05 (${keeperAt.length} runs), never inside the preflight hours; the longest gap between two alarms is ${maxGap} min`, keeperAt[0] === "19:00" && keeperAt[keeperAt.length - 1] === "05:05" && keeperAt.length === 12 && maxGap <= 60 && !keeperAt.some((h) => h >= "06:00" && h < "19:00"), keeperAt.join(" "));
      ok("keeper heartbeat: the lock's beatAt was renewed during the night (at most every 4 min)", Date.parse(JSON.parse(fs.readFileSync(lf, "utf8")).beatAt) >= Z("2026-10-13 08:26"));
      // the PC asleep Fri 19:30 -> Mon 05:00: no ticks; the first tick on wake runs at once (like the task's StartWhenAvailable)
      recs.length = 0; alarm(Z("2026-10-09 19:00"), "keeper"); const st2 = { lastBeat: Z("2026-10-12 05:00") }; fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, beatAt: new Date(Z("2026-10-12 05:00")).toISOString() })); let woke = null;
      keeperTick(st2, { nowMs: Z("2026-10-12 05:00"), selfFile: self, startSha: fileSha(self), statusFile: sf, lockFile: lf, pid: process.pid, runChild: () => { woke = "ran"; } });
      ok("keeper after a sleeping weekend: the first tick on wake (Mon 05:00) runs the alarm at once", woke === "ran");
      const r1 = keeperTick({ lastBeat: 0 }, { nowMs: Z("2026-10-12 05:01"), selfFile: self, startSha: "0".repeat(64), statusFile: sf, lockFile: lf, pid: process.pid, runChild: () => { throw new Error("must not run"); } });
      fs.writeFileSync(lf, JSON.stringify({ pid: process.ppid, beatAt: new Date().toISOString() }));
      const r2 = keeperTick({ lastBeat: 0 }, { nowMs: Z("2026-10-12 05:01"), selfFile: self, startSha: fileSha(self), statusFile: sf, lockFile: lf, pid: process.pid, runChild: () => { throw new Error("must not run"); } });
      ok("keeper exits (runs nothing) when its file changed / vanished, or another keeper took its lock", r1 === "exit" && r2 === "exit"); }
    { // TRANSIENT I/O IS NEVER AN EXIT: only positive evidence ends the keeper (an exit drops the off-hours cadence until the next start)
      const sf = path.join(tmp, "io-status.json"), lf = path.join(tmp, "io.lock"), self = path.join(tmp, "self-io.cjs"); fs.writeFileSync(self, "// v1\n");
      const sha0 = fileSha(self), t0 = Z("2026-10-12 20:00"), notes = []; let ran = 0;
      const status = (minAgo) => fs.writeFileSync(sf, JSON.stringify({ runs: [{ at: new Date(t0 - minAgo * 60000).toISOString(), mode: "alert", alarm: { ran: true } }] }));
      const D = (o = {}) => ({ nowMs: t0, selfFile: self, startSha: sha0, statusFile: sf, lockFile: lf, pid: process.pid, runChild: () => { ran++; }, note: (s) => notes.push(s), ...o });
      const lockPid = () => JSON.parse(fs.readFileSync(lf, "utf8")).pid;
      status(10);   // the last alarm 10 min ago: not due
      const torn = '{"pid": ' + process.pid + ', "beatAt": "2026-10'; fs.writeFileSync(lf, torn);
      const st1 = { lastBeat: 0 }, a1 = keeperTick(st1, D()), keptTorn = fs.readFileSync(lf, "utf8") === torn && st1.lastBeat === 0;
      fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, beatAt: new Date(t0 - 5 * 60000).toISOString() }));
      const a2 = keeperTick(st1, D({ nowMs: t0 + 60000 }));
      ok("keeper: the lock body TORN on one tick (a read caught mid-write, a scanner) -> 'idle', not 'exit' (no beat that tick, a note logged); the next tick beats again", a1 === "idle" && keptTorn && a2 === "idle" && st1.lastBeat === t0 + 60000 && Date.parse(JSON.parse(fs.readFileSync(lf, "utf8")).beatAt) === t0 + 60000 && notes.some((n) => /the lock could not be read this tick/.test(n)), JSON.stringify({ a1, a2, keptTorn, notes }));
      const ldir = path.join(tmp, "lock-is-a-dir"); fs.mkdirSync(ldir);
      const b1 = keeperTick({ lastBeat: 0 }, D({ lockFile: ldir })), b2 = keeperTick({ lastBeat: 0 }, D({ lockFile: path.join(tmp, "no-such-folder", "k.lock") }));
      ok("keeper: the lock UNREADABLE (EISDIR here) or its heartbeat UNWRITABLE (its folder missing) -> 'idle', not 'exit'; each logged, retried next tick", b1 === "idle" && b2 === "idle" && notes.some((n) => /EISDIR/.test(n)) && notes.some((n) => /heartbeat could not be written/.test(n)), JSON.stringify({ b1, b2, notes }));
      fs.rmSync(lf, { force: true }); const c1 = keeperTick({ lastBeat: 0 }, D()), cl = JSON.parse(fs.readFileSync(lf, "utf8"));
      const deadPid = cp.spawnSync(process.execPath, ["-e", "0"]).pid; fs.writeFileSync(lf, JSON.stringify({ pid: deadPid, beatAt: new Date(t0).toISOString() }));
      const c2 = keeperTick({ lastBeat: 0 }, D());
      ok("keeper: the lock ABSENT (deleted under it) or naming a DEAD pid -> taken back with its own pid ('idle'), not an exit", c1 === "idle" && cl.pid === process.pid && /absent/.test(cl.retaken || "") && c2 === "idle" && lockPid() === process.pid, JSON.stringify({ c1, cl, c2 }));
      status(90); ran = 0; fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, beatAt: new Date(t0).toISOString() }));   // the last alarm 90 min ago: due
      const sdir = path.join(tmp, "self-is-a-dir"); fs.mkdirSync(sdir);
      const st5 = { lastBeat: t0 }, e1 = keeperTick(st5, D({ selfFile: sdir })), ranAfter1 = ran, e2 = keeperTick(st5, D({ nowMs: t0 + 60000 }));
      ok("keeper: its own file UNREADABLE on one tick (EISDIR here; a scanner's hold at home) while a run is due -> 'idle' (nothing run, a note), never 'exit'; the next good read runs the alarm", e1 === "idle" && ranAfter1 === 0 && e2 === "ran" && ran === 1 && notes.some((n) => /its own file could not be read this tick/.test(n)), JSON.stringify({ e1, e2, ran, notes: notes.slice(-3) }));
      const gone = path.join(tmp, "self-gone.cjs"); ran = 0;
      const st6 = { lastBeat: t0 }, f1 = keeperTick(st6, D({ selfFile: gone })), f2 = keeperTick(st6, D({ selfFile: gone, nowMs: t0 + 60000 }));
      const st7 = { lastBeat: t0 }, g1 = keeperTick(st7, D({ selfFile: gone })), g2 = keeperTick(st7, D({ nowMs: t0 + 60000 })), g3 = keeperTick(st7, D({ selfFile: gone, nowMs: t0 + 120000 }));
      ok(`keeper: its own file ABSENT on one tick -> 'idle' (nothing run); absent on ${SELF_GONE_TICKS} ticks IN A ROW -> 'exit' (a rollback); absent, back, absent -> never 'exit' (the count restarts)`, SELF_GONE_TICKS === 2 && f1 === "idle" && f2 === "exit" && /gone/.test(st6.exitWhy || "") && g1 === "idle" && g2 === "ran" && g3 === "idle" && ran === 1, JSON.stringify({ f1, f2, g1, g2, g3, ran, why: st6.exitWhy })); }
    { // a REBOOT on a weekday evening: the keeper dies with the PC at 20:30 MT (its lock left behind, its pid dead); TRAIDS Servers' boot
      // trigger runs ensure-servers.bat at 20:41, which starts a new keeper: it takes over the dead lock and the hourly alarm goes on
      const sf = path.join(tmp, "rb-status.json"), lf = path.join(tmp, "rb.lock"), self = path.join(tmp, "self-rb.cjs"); fs.writeFileSync(self, "// v1\n");
      const fmt = (ms) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Denver", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
      const recs = [], ranAt = [], alarm = (ms, from) => { recs.push({ at: new Date(ms).toISOString(), from, mode: "alert", alarm: { ran: true } }); fs.writeFileSync(sf, JSON.stringify({ runs: recs })); };
      const tick = (st, t) => keeperTick(st, { nowMs: t, selfFile: self, startSha: fileSha(self), statusFile: sf, lockFile: lf, pid: process.pid, runChild: () => { ranAt.push(fmt(t)); alarm(t, "keeper"); } });
      alarm(Z("2026-10-12 18:00"), "preflight.bat"); takeKeeperLock(lf, Z("2026-10-12 18:00"), process.pid, null);
      let st = { lastBeat: Z("2026-10-12 18:00") };
      for (let t = Z("2026-10-12 18:01"); t < Z("2026-10-12 20:30"); t += 60000) tick(st, t);
      const before = ranAt.slice(), deadPid = cp.spawnSync(process.execPath, ["-e", "0"]).pid, j = JSON.parse(fs.readFileSync(lf, "utf8")); j.pid = deadPid; fs.writeFileSync(lf, JSON.stringify(j));
      const boot = Z("2026-10-12 20:41"), L = takeKeeperLock(lf, boot, process.pid, null); st = { lastBeat: boot };
      for (let t = boot; t <= Z("2026-10-12 23:30"); t += 60000) tick(st, t);
      const after = ranAt.slice(before.length), all = recs.map((x) => Date.parse(x.at)), maxGap = Math.max(...all.slice(1).map((x, i) => (x - all[i]) / 60000));
      ok(`keeper across a REBOOT (dead at 20:30 MT, restarted by the boot run of ensure-servers.bat at 20:41): before ${before.join(" ")}; the new keeper takes over the dead pid's lock and runs ${after.join(" ")} — the longest gap between two alarms ${maxGap} min (without the boot start: none until the next weekday preflight fire)`, before.join(" ") === "19:00 19:55" && L.ok && L.replaced && L.replaced.pid === deadPid && after[0] === "20:50" && after.length === 3 && maxGap <= 60, JSON.stringify({ before, after, L, maxGap })); }
    { const src = fs.readFileSync(__filename, "utf8"), body = src.slice(src.indexOf("function keeperChild()"), src.indexOf("function keeperTick("));
      ok("the keeper's child is `r309-fold.cjs --alert --from keeper`, appending to automation/r309-pull.log through its OWN O_APPEND handle ('a'), opened and closed per run", /openSync\(path\.join\(REPO, "automation", "r309-pull\.log"\), "a"\)/.test(body) && /\[__filename, "--alert", "--from", "keeper"\]/.test(body) && /closeSync\(fd\)/.test(body)); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`r309-fold selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

function parseArgs(a) {
  const known = new Set(["--alert", "--pull", "--from", "--dry", "--status", "--selftest", "--keeper"]);
  for (let i = 0; i < a.length; i++) { if (!known.has(a[i])) return { error: `unknown argument ${JSON.stringify(a[i])}` }; if (a[i] === "--from") i++; }
  if (a.includes("--selftest") || a.includes("--status") || a.includes("--keeper")) return a.length === 1 ? { mode: a[0].slice(2) } : { error: `${a[0]} takes no other argument` };
  const modes = ["--alert", "--pull"].filter((m) => a.includes(m));
  if (modes.length !== 1) return { error: "exactly one of --alert / --pull is required" };
  const i = a.indexOf("--from"), from = i >= 0 ? a[i + 1] : null;
  if (!FROM.has(String(from))) return { error: `--from must be one of ${[...FROM].join(", ")}` };
  const mode = modes[0].slice(2), dry = a.includes("--dry");
  if (mode === "alert" && !ALERT_FROM.has(from)) return { error: "--alert runs from preflight.bat (or manual) only — the chain pulls without the alarm" };
  if (dry && mode !== "pull") return { error: "--dry goes with --pull only (the alarm is never dry)" };
  return { mode, from, dry };
}

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (o.error) { console.error(`r309-fold: ${o.error} — nothing done`); process.exitCode = 2; }
  else if (o.mode === "selftest") process.exitCode = selftest() ? 0 : 1;
  else if (o.mode === "status") { console.log(statusText(path.join(PS.HOME_DATA, "r309-fold-status.json"))); console.log(keeperText(PS.HOME_DATA)); process.exitCode = 0; }
  else if (o.mode === "keeper") keeperMain();
  else process.exitCode = run({ mode: o.mode, from: o.from, dry: o.dry });
}
/** the keeper's liveness from its lock (read-only) */
function keeperText(homeDir, nowMs = Date.now()) {
  let j = null; try { j = JSON.parse(fs.readFileSync(path.join(homeDir, KEEPER_LOCK), "utf8")); } catch { return "keeper: no lock (not started yet — the next preflight fire or TRAIDS Servers run starts it — or exited)"; }
  const age = nowMs - Date.parse(j.beatAt), live = pidAlive(j.pid) && age < BEAT_STALE_MS;
  return `keeper: pid ${j.pid} started ${j.startedAt}, last beat ${Math.round(age / 60000)} min ago — ${live ? "ALIVE" : "NOT alive (stale lock: the next preflight fire or TRAIDS Servers run replaces it)"}`;
}
module.exports = { pullR309, run, pullLine, guardedSsh, loadGuard, appendRun, statusText, keeperText, parseArgs, isOldTaskLine, realHealth, keeperDue, inPreflightHours, keeperTick, takeKeeperLock, keeperStartState, lastAlertMs, readSha, SELF_GONE_TICKS, FUTURE_SLACK_MS, LOCK_TORN_FRESH_MS, HEALTH_PULL_LINE, OLD_TASK_LINE, FOUR, FROM, VERSION, KEEP, KEEPER_LOCK };
