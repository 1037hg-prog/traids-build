"use strict";
/**
 * SANDBOX PRELOAD (health-fixes 2026-10-05, package "testmachinery").
 *
 * Loaded with `node --require sandbox-preload.cjs <live script path> [args]`. It lets a STAGED copy of a backend script run against
 * the LIVE data directory without being able to change anything in the repo:
 *
 *   1. SWAP     when SANDBOX_SWAP_FROM / SANDBOX_SWAP_TO are set, the source of the live file is replaced by the staged file at
 *               load time, so the staged code runs with the live file's __dirname and require() resolution (lib/, data/).
 *   2. REDIRECT every filesystem WRITE whose path resolves inside SANDBOX_REPO is rewritten to SANDBOX_OUT/<rel path with \ and /
 *               replaced by __>. Reads are untouched (they see live data). Each redirected write is logged to
 *               SANDBOX_OUT/_sandbox-writes.log so the caller can prove what the script tried to write.
 *   3. NO CHILD PROCESSES except a read-only `schtasks /query` (the staged test-triage asks Task Scheduler what it runs).
 *
 * It never require()s the target itself — node runs the target as the main module; this file only installs hooks.
 */
const fs = require("fs"), path = require("path"), Module = require("module"), cp = require("child_process");

const REPO = path.resolve(process.env.SANDBOX_REPO || "");
const OUT = path.resolve(process.env.SANDBOX_OUT || "");
if (!process.env.SANDBOX_REPO || !process.env.SANDBOX_OUT) { process.stderr.write("sandbox-preload: SANDBOX_REPO and SANDBOX_OUT are required\n"); process.exit(97); }
const SWAP_FROM = process.env.SANDBOX_SWAP_FROM ? path.resolve(process.env.SANDBOX_SWAP_FROM) : null;
const SWAP_TO = process.env.SANDBOX_SWAP_TO ? path.resolve(process.env.SANDBOX_SWAP_TO) : null;

const real = {
  writeFileSync: fs.writeFileSync, appendFileSync: fs.appendFileSync, openSync: fs.openSync, renameSync: fs.renameSync,
  copyFileSync: fs.copyFileSync, unlinkSync: fs.unlinkSync, rmSync: fs.rmSync, rmdirSync: fs.rmdirSync, mkdirSync: fs.mkdirSync,
  truncateSync: fs.truncateSync, createWriteStream: fs.createWriteStream, utimesSync: fs.utimesSync,
};
real.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, "_sandbox-writes.log");
const lc = (p) => path.resolve(String(p)).toLowerCase();
const REPO_LC = lc(REPO);
const OUT_LC = lc(OUT);
const isPathLike = (p) => typeof p === "string" || Buffer.isBuffer(p) || p instanceof URL;
const toStr = (p) => (p instanceof URL ? require("url").fileURLToPath(p) : String(p));
function redirect(p, op) {
  if (!isPathLike(p)) return p;                                    // a file descriptor (number) — it came from a redirected open
  const abs = path.resolve(toStr(p));
  const a = abs.toLowerCase();
  if (a.startsWith(OUT_LC + path.sep) || a === OUT_LC) return abs;  // already inside the sandbox
  if (!(a.startsWith(REPO_LC + path.sep) || a === REPO_LC)) return p;
  const target = path.join(OUT, path.relative(REPO, abs).replace(/[\\/]/g, "__"));
  try { real.appendFileSync(LOG, `${new Date().toISOString()} ${op} ${path.relative(REPO, abs)} -> ${path.basename(target)}\n`); } catch {}
  return target;
}
const writeFlag = (flags) => {
  if (flags == null) return false;
  if (typeof flags === "number") return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC)) !== 0;
  return /[wa+]/.test(String(flags));
};

fs.writeFileSync = function (p, ...rest) { return real.writeFileSync.call(fs, redirect(p, "writeFileSync"), ...rest); };
fs.appendFileSync = function (p, ...rest) { return real.appendFileSync.call(fs, redirect(p, "appendFileSync"), ...rest); };
fs.openSync = function (p, flags, ...rest) { return real.openSync.call(fs, writeFlag(flags) ? redirect(p, "openSync:" + flags) : p, flags, ...rest); };
fs.renameSync = function (a, b) { return real.renameSync.call(fs, redirect(a, "rename-from"), redirect(b, "renameSync")); };
fs.copyFileSync = function (a, b, ...rest) { return real.copyFileSync.call(fs, a, redirect(b, "copyFileSync"), ...rest); };
fs.unlinkSync = function (p) { const r = redirect(p, "unlinkSync"); try { return real.unlinkSync.call(fs, r); } catch (e) { if (e.code !== "ENOENT") throw e; } };
fs.rmSync = function (p, ...rest) { const r = redirect(p, "rmSync"); return real.rmSync.call(fs, r, ...rest); };
fs.rmdirSync = function (p, ...rest) { const r = redirect(p, "rmdirSync"); try { return real.rmdirSync.call(fs, r, ...rest); } catch (e) { if (e.code !== "ENOENT") throw e; } };
fs.mkdirSync = function (p, ...rest) { const r = redirect(p, "mkdirSync"); if (r !== p) return undefined; return real.mkdirSync.call(fs, p, ...rest); };
fs.truncateSync = function (p, ...rest) { return real.truncateSync.call(fs, redirect(p, "truncateSync"), ...rest); };
fs.utimesSync = function (p, ...rest) { return real.utimesSync.call(fs, redirect(p, "utimesSync"), ...rest); };
fs.createWriteStream = function (p, ...rest) { return real.createWriteStream.call(fs, redirect(p, "createWriteStream"), ...rest); };
const rp = fs.promises;
const realP = { writeFile: rp.writeFile, appendFile: rp.appendFile, rename: rp.rename, unlink: rp.unlink, rm: rp.rm, mkdir: rp.mkdir, copyFile: rp.copyFile };
rp.writeFile = (p, ...rest) => realP.writeFile.call(rp, redirect(p, "promises.writeFile"), ...rest);
rp.appendFile = (p, ...rest) => realP.appendFile.call(rp, redirect(p, "promises.appendFile"), ...rest);
rp.rename = (a, b) => realP.rename.call(rp, redirect(a, "promises.rename-from"), redirect(b, "promises.rename"));
rp.unlink = (p) => realP.unlink.call(rp, redirect(p, "promises.unlink"));
rp.rm = (p, ...rest) => realP.rm.call(rp, redirect(p, "promises.rm"), ...rest);
rp.mkdir = (p, ...rest) => { const r = redirect(p, "promises.mkdir"); return r !== p ? Promise.resolve(undefined) : realP.mkdir.call(rp, p, ...rest); };
rp.copyFile = (a, b, ...rest) => realP.copyFile.call(rp, a, redirect(b, "promises.copyFile"), ...rest);
// async callback forms used by older code paths
for (const name of ["writeFile", "appendFile"]) { const orig = fs[name]; fs[name] = function (p, ...rest) { return orig.call(fs, redirect(p, name), ...rest); }; }

// ── child processes: only a read-only Task Scheduler query is allowed ───────────────────────────────────────────────────────
const allowed = (cmd, args) => /(^|[\\/])schtasks(\.exe)?$/i.test(String(cmd)) && Array.isArray(args) && args.some((a) => /^\/query$/i.test(String(a))) && !args.some((a) => /^\/(run|end|create|delete|change)$/i.test(String(a)));
for (const name of ["execFileSync", "spawnSync", "execFile", "spawn"]) {
  const orig = cp[name];
  cp[name] = function (cmd, args, ...rest) {
    if (!allowed(cmd, args)) throw new Error(`sandbox: child process refused (${cmd} ${Array.isArray(args) ? args.join(" ") : ""})`);
    return orig.call(cp, cmd, args, ...rest);
  };
}
for (const name of ["execSync", "exec"]) cp[name] = function (cmd) { throw new Error(`sandbox: shell child process refused (${String(cmd).slice(0, 80)})`); };

// ── swap the staged source in for the live file ─────────────────────────────────────────────────────────────────────────────
if (SWAP_FROM && SWAP_TO) {
  const origJs = Module._extensions[".js"];
  Module._extensions[".js"] = function (module, filename) {
    if (path.resolve(filename).toLowerCase() === SWAP_FROM.toLowerCase()) {
      let src = fs.readFileSync(SWAP_TO, "utf8");
      if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
      try { real.appendFileSync(LOG, `${new Date().toISOString()} SWAP ${path.relative(REPO, filename)} <- ${SWAP_TO}\n`); } catch {}
      return module._compile(src, filename);
    }
    return origJs(module, filename);
  };
}
