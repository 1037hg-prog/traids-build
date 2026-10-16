"use strict";
/**
 * Staged-package machinery shared by deploy.cjs, rollback.cjs and selftest.cjs of THIS folder. Node built-ins only.
 *
 * FILES lists every live file the package touches, by repo path. base/<rel> is the byte copy it starts from; a live file that does
 * not exist at base time is recorded as base/<rel>.absent (an empty marker), and rollback then removes the file again.
 * staged/<rel> is the changed copy. A live file reads one of: "base" (matches base/), "applied" (matches staged/), "drift" (neither).
 *
 * The fence: --apply and --rollback refuse on a trading weekday 05:30-16:00 MT (lib/run-window.js MARKET_HOLIDAYS; if that list
 * cannot be read, every weekday counts as trading). Nothing here starts, stops or restarts anything, sends anything or calls a host.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { execFileSync } = require("child_process");

const PKG = __dirname;
const REPO = path.resolve(PKG, "..", "..", "..");
const FILES = require("./files.cjs");
const { loadCjs } = require("./loadcjs.cjs");

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const readOrNull = (f) => { try { return fs.readFileSync(f); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const baseOf = (rel) => { const marker = path.join(PKG, "base", rel + ".absent"); if (fs.existsSync(marker)) return null; const b = readOrNull(path.join(PKG, "base", rel)); if (b === null) throw new Error(`package incomplete: neither base/${rel} nor base/${rel}.absent`); return b; };
const stagedOf = (rel) => { const s = readOrNull(path.join(PKG, "staged", rel)); if (s === null) throw new Error(`package incomplete: staged/${rel} missing`); return s; };

function stateOf(rel, root = REPO) {
  const live = readOrNull(path.join(root, rel)), base = baseOf(rel), staged = stagedOf(rel);
  const same = (a, b) => (a === null ? b === null : b !== null && a.equals(b));
  if (same(live, staged)) return { state: "applied", live, base, staged };
  if (same(live, base)) return { state: "base", live, base, staged };
  return { state: "drift", live, base, staged, why: live === null ? "the live file is missing but base/ has it" : `live sha ${sha(live).slice(0, 12)} matches neither base ${base === null ? "(absent)" : sha(base).slice(0, 12)} nor staged ${sha(staged).slice(0, 12)}` };
}

function holidays(root) { try { return loadCjs(path.join(root, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS || null; } catch { return null; } }
/** fence(nowMs, root) -> null when writes are allowed, else the reason. */
function fence(nowMs, root = REPO) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`, hm = (+p.hour % 24) * 60 + +p.minute, dow = new Date(day + "T12:00:00Z").getUTCDay();
  const H = holidays(root), trading = dow >= 1 && dow <= 5 && !(H && H[day]);
  if (trading && hm >= 5 * 60 + 30 && hm < 16 * 60) return `${day} ${p.hour}:${p.minute} MT is inside the trading-day fence (05:30-16:00 MT); run it after 16:00 MT or on a non-trading day`;
  return null;
}

function writeBytes(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid; fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file);
}
const nodeCheck = (file) => { if (!/\.(c|m)?js$/.test(file)) return null; try { execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }); return null; } catch (e) { return String(e.stderr || e.message).split("\n").slice(0, 3).join(" "); } };

/** run({ mode: "plan"|"apply"|"rollback-plan"|"rollback", root, nowMs, log, checkImpl }) -> exit code. The two plans write nothing. */
function run({ mode, root = REPO, nowMs = Date.now(), log = console.log, checkImpl = nodeCheck } = {}) {
  const rows = FILES.map((rel) => ({ rel, ...stateOf(rel, root) }));
  for (const r of rows) log(`  ${r.state.padEnd(8)} ${r.rel}${r.why ? " — " + r.why : ""}${r.base === null ? " (new file; base is absent)" : ""}`);
  const drift = rows.filter((r) => r.state === "drift");
  if (drift.length) { log(`REFUSED: ${drift.length} file(s) drifted from base/ — nothing changed`); return 2; }
  if (mode === "plan" || mode === "rollback-plan") {
    const back = mode === "rollback-plan", todo = rows.filter((r) => r.state === (back ? "applied" : "base"));
    if (back) log(todo.length ? `plan: --rollback would restore base/ for ${todo.map((r) => r.rel + (r.base === null ? " (remove it)" : "")).join(", ")}` : "plan: nothing to roll back (every file is at base)");
    else log(todo.length ? `plan: --apply would write ${todo.map((r) => r.rel).join(", ")}` : "plan: nothing to apply (every file already applied)");
    const f = fence(nowMs, root); log(f ? `plan: a --${back ? "rollback" : "apply"} now would be refused by the fence: ${f}` : `plan: the fence allows a --${back ? "rollback" : "apply"} now`);
    return 0;
  }
  if (mode !== "apply" && mode !== "rollback") throw new Error("unknown mode " + mode);
  const f = fence(nowMs, root); if (f) { log(`REFUSED: ${f} — nothing changed`); return 2; }
  const todo = rows.filter((r) => (mode === "apply" ? r.state === "base" : r.state === "applied"));
  if (!todo.length) { log(`${mode}: nothing to do`); return 0; }
  const done = [];
  try {
    for (const r of todo) {
      const target = path.join(root, r.rel), want = mode === "apply" ? r.staged : r.base;
      if (want === null) fs.unlinkSync(target); else writeBytes(target, want);
      done.push(r);
      const back = readOrNull(target);
      if (want === null ? back !== null : !(back && back.equals(want))) throw new Error(`read-back of ${r.rel} differs`);
      const bad = want === null ? null : checkImpl(target); if (bad) throw new Error(`node --check ${r.rel}: ${bad}`);
      log(`  ${mode === "apply" ? "wrote  " : "restored"} ${r.rel}${want === null ? " (removed: base is absent)" : ` sha ${sha(want).slice(0, 12)}`}`);
    }
  } catch (e) {
    for (const r of done.reverse()) { const target = path.join(root, r.rel), prev = r.live; if (prev === null) { try { fs.unlinkSync(target); } catch {} } else writeBytes(target, prev); }
    log(`FAILED: ${e.message} — every file written was put back`); return 1;
  }
  log(`${mode}: done (${todo.length} file(s))`);
  return 0;
}

module.exports = { PKG, REPO, FILES, sha, stateOf, fence, run };
