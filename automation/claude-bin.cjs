#!/usr/bin/env node
/**
 * CLAUDE-BIN — find the Claude Code CLI on any host, or refuse. 2026-10-02.
 *
 * WHY. automation/seat-wave.cjs carries a Windows-only resolver (claudeExe, 2026-09-09/10): the desktop app's
 * version-pinned claude-code folders under %APPDATA% / %LOCALAPPDATA% (and the same folders from os.homedir(), because
 * the scheduled task runs without a loaded profile), then four fixed claude.exe locations. The always-on Linux droplet
 * has none of those. This module keeps the Windows search EXACTLY as seat-wave.cjs does it today (same candidates, same
 * order, same filter, same newest-version sort, same refusal text) and adds a Linux/macOS search, so every headless
 * runner asks one place.
 *
 * RESOLVE OR REFUSE (the 2026-09-09 rule). A search returns a real file or throws an error naming every place it
 * looked. It never answers with a bare "claude" guess — that guess is what made six seats "run" in 8 ms on 2026-09-09.
 *
 * Linux / macOS order:
 *   1. CLAUDE_BIN env      if set it MUST be an executable file; a wrong override throws, it never falls through
 *   2. `command -v claude` via /bin/sh, with the caller's PATH (under systemd the unit sets PATH)
 *   3. ~/.local/bin/claude          the official native installer
 *   4. ~/.claude/local/claude       the older "local" install
 *   5. <npm prefix -g>/bin/claude   npm i -g @anthropic-ai/claude-code
 *
 * VERSION. resolve() runs `<bin> --version`: a local call that prints the version and exits. No model call, no usage.
 *
 * API   const { find, resolve } = require("./claude-bin.cjs")
 *         find(opts)    -> { path, how, tried }             no spawn on Windows; may run `sh -c "command -v claude"` and
 *                                                           `npm prefix -g` on Linux/macOS
 *         resolve(opts) -> { path, how, tried, version, versionLine }   find() + `<bin> --version`
 *       opts (all optional, for tests): { platform, env, homedir, fs, exec }
 * CLI   node automation/claude-bin.cjs             JSON {platform, path, version, how}; exit 1 with the reason if not found
 *       node automation/claude-bin.cjs --path      the path only (for shell scripts); exit 1 if not found
 *       node automation/claude-bin.cjs --selftest  known answers with an injected platform / fs / exec; plus, when
 *                                                  automation/seat-wave.cjs is present, a parity check of the Windows
 *                                                  search against that file's own claudeExe() run in a sandbox
 */
"use strict";
const realFs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");

const refuse = (msg, tried) => Object.assign(new Error(msg), { refusal: true, tried });

function ctx(o = {}) {
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  return {
    platform, env,
    P: platform === "win32" ? path.win32 : path.posix,
    home: o.homedir != null ? o.homedir : os.homedir(),
    fs: o.fs || realFs,
    exec: o.exec || ((file, args) => cp.execFileSync(file, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 20000, windowsHide: true })),
  };
}

// ── Windows: seat-wave.cjs claudeExe(), unchanged — candidates, order, filter, sort and refusal text ─────────────────
function findWin32(c) {
  const { P, env, home, fs } = c;
  const roots = [P.join(env.APPDATA || "", "Claude", "claude-code"),
                 P.join(env.LOCALAPPDATA || "", "Claude", "claude-code"),
                 P.join(home, "AppData", "Roaming", "Claude", "claude-code"),
                 P.join(home, "AppData", "Local", "Claude", "claude-code")].filter((p) => p && !p.startsWith(P.sep));
  const tried = [];
  for (const dir of roots) {
    tried.push(dir);
    try {
      const vers = fs.readdirSync(dir).filter((v) => fs.existsSync(P.join(dir, v, "claude.exe")))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      if (vers.length) return { path: P.join(dir, vers[0], "claude.exe"), how: "desktop-app folder " + dir, tried };
    } catch { /* next root */ }
  }
  for (const p of [P.join(env.APPDATA || "", "npm", "claude.exe"), P.join(env.LOCALAPPDATA || "", "Programs", "claude", "claude.exe"),
                   P.join(home, ".local", "bin", "claude.exe"), P.join(home, "AppData", "Roaming", "npm", "claude.exe")]) {
    tried.push(p);
    if (p && fs.existsSync(p)) return { path: p, how: "fixed location", tried };
  }
  throw refuse("cannot find claude.exe — refusing to run the wave rather than spawning a guess. Looked in: " + tried.join(" | "), tried);
}

// ── Linux / macOS ─────────────────────────────────────────────────────────────────────────────────────────────────────
function isExecFile(fs, p) {
  try {
    if (!fs.statSync(p).isFile()) return false;          // statSync follows symlinks: ~/.local/bin/claude is a link to versions/<v>
    fs.accessSync(p, (fs.constants || realFs.constants).X_OK);
    return true;
  } catch { return false; }
}

function findPosix(c) {
  const { P, env, home, fs, exec } = c, tried = [];
  const ok = (p) => !!p && P.isAbsolute(p) && isExecFile(fs, p);
  if (env.CLAUDE_BIN) {
    tried.push("CLAUDE_BIN=" + env.CLAUDE_BIN);
    if (ok(env.CLAUDE_BIN)) return { path: env.CLAUDE_BIN, how: "CLAUDE_BIN", tried };
    throw refuse(`CLAUDE_BIN is set to "${env.CLAUDE_BIN}" but that is not an absolute path to an executable file — refusing (an explicit override never falls through to a search)`, tried);
  }
  let cv = null;
  try { cv = String(exec("/bin/sh", ["-c", "command -v claude"]) || "").trim().split(/\r?\n/)[0] || null; } catch { /* not on PATH */ }
  tried.push("command -v claude" + (cv ? " -> " + cv : " (not on PATH)"));
  if (ok(cv)) return { path: cv, how: "command -v", tried };
  for (const [p, how] of [[home ? P.join(home, ".local", "bin", "claude") : null, "~/.local/bin"],
                          [home ? P.join(home, ".claude", "local", "claude") : null, "~/.claude/local"]]) {
    if (!p) continue;
    tried.push(p);
    if (ok(p)) return { path: p, how, tried };
  }
  let prefix = null;
  try { prefix = String(exec("npm", ["prefix", "-g"]) || "").trim().split(/\r?\n/)[0] || null; } catch { /* npm absent */ }
  const np = prefix && P.isAbsolute(prefix) ? P.join(prefix, "bin", "claude") : null;
  tried.push(np || "npm prefix -g (npm not available)");
  if (ok(np)) return { path: np, how: "npm global", tried };
  throw refuse("cannot find the claude CLI — refusing rather than spawning a guess. Looked in: " + tried.join(" | ") +
    ". Install it as this user (deploy/server/install-claude.md) or set CLAUDE_BIN.", tried);
}

function find(o = {}) {
  const c = ctx(o);
  return c.platform === "win32" ? findWin32(c) : findPosix(c);
}

function resolve(o = {}) {
  const c = ctx(o), f = c.platform === "win32" ? findWin32(c) : findPosix(c);
  let out;
  try { out = String(c.exec(f.path, ["--version"]) || ""); }
  catch (e) {
    const why = (e && (e.code || (e.stderr && String(e.stderr).trim().slice(0, 200)) || e.message)) || "unknown";
    throw refuse(`found ${f.path} (${f.how}) but "${f.path} --version" failed: ${why}`, f.tried);
  }
  const line = out.trim().split(/\r?\n/)[0] || "";
  const m = /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(line);
  if (!m) throw refuse(`found ${f.path} (${f.how}) but "--version" printed no version: ${JSON.stringify(line.slice(0, 120))}`, f.tried);
  return { ...f, version: m[1], versionLine: line };
}

module.exports = { find, resolve };

// ── selftest ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A tiny in-memory filesystem: { "<path>": "dir" | { file: true, mode } }. Paths compared exactly as written. */
function fakeFs(platform, entries) {
  const P = platform === "win32" ? path.win32 : path.posix;
  const map = new Map(Object.entries(entries));
  const norm = (p) => P.normalize(String(p));
  const get = (p) => { for (const [k, v] of map) if (norm(k) === norm(p)) return v; return undefined; };
  return {
    constants: { X_OK: 1 },
    existsSync: (p) => get(p) !== undefined,
    readdirSync: (d) => {
      if (get(d) !== "dir") { const e = new Error("ENOENT " + d); e.code = "ENOENT"; throw e; }
      const kids = new Set();
      for (const k of map.keys()) { const rel = P.relative(norm(d), norm(k)); if (rel && !rel.startsWith("..") && !P.isAbsolute(rel)) kids.add(rel.split(P.sep)[0]); }
      return [...kids];
    },
    statSync: (p) => { const v = get(p); if (v === undefined) { const e = new Error("ENOENT " + p); e.code = "ENOENT"; throw e; } return { isFile: () => v !== "dir", isDirectory: () => v === "dir" }; },
    accessSync: (p) => { const v = get(p); if (!v || v === "dir" || !(v.mode & 1)) { const e = new Error("EACCES " + p); e.code = "EACCES"; throw e; } },
  };
}
const X = { file: true, mode: 0o755 }, NX = { file: true, mode: 0o644 };

/** seat-wave.cjs source -> { skip } (absent, or the promoted port that calls this module) | { fnSrc } | {} (not found). */
function parityTarget(src) {
  if (src == null) return { skip: "automation/seat-wave.cjs not present" };
  if (/require\(\s*["']\.\/claude-bin\.cjs["']\s*\)/.test(src)) return { skip: "automation/seat-wave.cjs is the promoted port (it calls this module)" };
  const a = src.indexOf("function claudeExe()"), m = a < 0 ? null : /\r?\n\}\r?\n/.exec(src.slice(a));
  return m ? { fnSrc: src.slice(a, a + m.index + m[0].length) + "\nclaudeExe" } : {};
}

function selftest() {
  let pass = 0, fail = 0;
  const eq = (name, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + "\n       got  " + g + "\n       want " + w); } };
  const throwsLike = (name, fn, re) => { try { const r = fn(); fail++; console.log("  FAIL " + name + " — did not throw, returned " + JSON.stringify(r)); } catch (e) { if (re.test(e.message)) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + " — threw the wrong error: " + e.message); } } };
  const noExec = () => { throw Object.assign(new Error("not found"), { code: "ENOENT" }); };

  console.log("claude-bin selftest");
  // ── Windows ──
  const WH = "C:\\Users\\op", AP = WH + "\\AppData\\Roaming", LAP = WH + "\\AppData\\Local";
  const winEnv = { APPDATA: AP, LOCALAPPDATA: LAP };
  const winFs1 = fakeFs("win32", {
    [AP + "\\Claude\\claude-code"]: "dir",
    [AP + "\\Claude\\claude-code\\2.0.9"]: "dir", [AP + "\\Claude\\claude-code\\2.0.9\\claude.exe"]: X,
    [AP + "\\Claude\\claude-code\\2.0.10"]: "dir", [AP + "\\Claude\\claude-code\\2.0.10\\claude.exe"]: X,
    [AP + "\\Claude\\claude-code\\2.1.0-broken"]: "dir",                     // no claude.exe inside: skipped
  });
  eq("win32: newest version folder by numeric sort (2.0.10 > 2.0.9; a folder without claude.exe is skipped)",
    find({ platform: "win32", env: winEnv, homedir: WH, fs: winFs1, exec: noExec }).path, AP + "\\Claude\\claude-code\\2.0.10\\claude.exe");
  const winFs2 = fakeFs("win32", { [AP + "\\Claude\\claude-code"]: "dir", [AP + "\\Claude\\claude-code\\1.0.0"]: "dir", [AP + "\\Claude\\claude-code\\1.0.0\\claude.exe"]: X });
  eq("win32: scheduled task with no profile (APPDATA/LOCALAPPDATA empty) finds the same folder from homedir",
    find({ platform: "win32", env: {}, homedir: WH, fs: winFs2, exec: noExec }).path, AP + "\\Claude\\claude-code\\1.0.0\\claude.exe");
  eq("win32: falls back to the fixed ~/.local/bin/claude.exe",
    find({ platform: "win32", env: winEnv, homedir: WH, fs: fakeFs("win32", { [WH + "\\.local\\bin\\claude.exe"]: X }), exec: noExec }).path, WH + "\\.local\\bin\\claude.exe");
  let tried = null;
  try { find({ platform: "win32", env: winEnv, homedir: WH, fs: fakeFs("win32", {}), exec: noExec }); } catch (e) { tried = e.tried; }
  eq("win32: nothing found -> refuses, listing all 8 places in the seat-wave order", tried, [
    AP + "\\Claude\\claude-code", LAP + "\\Claude\\claude-code", AP + "\\Claude\\claude-code", LAP + "\\Claude\\claude-code",
    AP + "\\npm\\claude.exe", LAP + "\\Programs\\claude\\claude.exe", WH + "\\.local\\bin\\claude.exe", WH + "\\AppData\\Roaming\\npm\\claude.exe"]);
  throwsLike("win32: refusal text is the seat wave's own", () => find({ platform: "win32", env: winEnv, homedir: WH, fs: fakeFs("win32", {}), exec: noExec }),
    /^cannot find claude\.exe — refusing to run the wave rather than spawning a guess\. Looked in: /);
  eq("win32: CLAUDE_BIN is NOT consulted on Windows (the search stays exactly as seat-wave.cjs has it)",
    find({ platform: "win32", env: { ...winEnv, CLAUDE_BIN: "D:\\x\\claude.exe" }, homedir: WH, fs: winFs1, exec: noExec }).path, AP + "\\Claude\\claude-code\\2.0.10\\claude.exe");

  // ── Linux / macOS ──
  const LH = "/home/traids";
  const execWith = (map) => (file, args) => { const k = [file, ...args].join(" "); if (k in map) { const v = map[k]; if (v instanceof Error) throw v; return v; } throw Object.assign(new Error("ENOENT " + k), { code: "ENOENT" }); };
  const allFs = fakeFs("linux", { [LH + "/.local/bin/claude"]: X, [LH + "/.claude/local/claude"]: X, "/usr/local/bin/claude": X, "/opt/claude": X });
  eq("linux: CLAUDE_BIN wins when it is an executable file",
    find({ platform: "linux", env: { CLAUDE_BIN: "/opt/claude" }, homedir: LH, fs: allFs, exec: execWith({ "/bin/sh -c command -v claude": "/usr/local/bin/claude\n" }) }).path, "/opt/claude");
  throwsLike("linux: a wrong CLAUDE_BIN refuses and does NOT fall through", () => find({ platform: "linux", env: { CLAUDE_BIN: "/nope/claude" }, homedir: LH, fs: allFs, exec: noExec }), /CLAUDE_BIN is set .* refusing/);
  throwsLike("linux: a relative CLAUDE_BIN refuses", () => find({ platform: "linux", env: { CLAUDE_BIN: "claude" }, homedir: LH, fs: allFs, exec: noExec }), /not an absolute path/);
  eq("linux: `command -v claude` second",
    find({ platform: "linux", env: {}, homedir: LH, fs: allFs, exec: execWith({ "/bin/sh -c command -v claude": "/usr/local/bin/claude\n" }) }).how, "command -v");
  eq("linux: ~/.local/bin/claude third (systemd PATH has no ~/.local/bin)",
    find({ platform: "linux", env: {}, homedir: LH, fs: allFs, exec: noExec }).path, LH + "/.local/bin/claude");
  eq("linux: a non-executable ~/.local/bin/claude is skipped -> ~/.claude/local/claude",
    find({ platform: "linux", env: {}, homedir: LH, fs: fakeFs("linux", { [LH + "/.local/bin/claude"]: NX, [LH + "/.claude/local/claude"]: X }), exec: noExec }).path, LH + "/.claude/local/claude");
  eq("linux: npm global prefix last",
    find({ platform: "linux", env: {}, homedir: LH, fs: fakeFs("linux", { "/usr/local/bin/claude": X }), exec: execWith({ "npm prefix -g": "/usr/local\n" }) }).path, "/usr/local/bin/claude");
  eq("linux: `command -v` answering an alias name (not a path) is not trusted",
    find({ platform: "linux", env: {}, homedir: LH, fs: allFs, exec: execWith({ "/bin/sh -c command -v claude": "claude\n" }) }).path, LH + "/.local/bin/claude");
  tried = null;
  try { find({ platform: "linux", env: {}, homedir: LH, fs: fakeFs("linux", {}), exec: noExec }); } catch (e) { tried = e.tried; }
  eq("linux: nothing found -> refuses, listing the 4 places tried in order", tried,
    ["command -v claude (not on PATH)", LH + "/.local/bin/claude", LH + "/.claude/local/claude", "npm prefix -g (npm not available)"]);
  eq("darwin uses the POSIX search",
    find({ platform: "darwin", env: {}, homedir: "/Users/op", fs: fakeFs("darwin", { "/Users/op/.local/bin/claude": X }), exec: noExec }).path, "/Users/op/.local/bin/claude");

  // ── resolve (version) ──
  const vFs = fakeFs("linux", { [LH + "/.local/bin/claude"]: X });
  eq("resolve: parses `--version` (no model call)",
    resolve({ platform: "linux", env: {}, homedir: LH, fs: vFs, exec: execWith({ [LH + "/.local/bin/claude --version"]: "2.1.3 (Claude Code)\n" }) }).version, "2.1.3");
  throwsLike("resolve: a binary whose --version fails is refused", () => resolve({ platform: "linux", env: {}, homedir: LH, fs: vFs, exec: noExec }), /--version" failed/);
  throwsLike("resolve: a --version with no version number is refused", () => resolve({ platform: "linux", env: {}, homedir: LH, fs: vFs, exec: execWith({ [LH + "/.local/bin/claude --version"]: "hello\n" }) }), /printed no version/);

  // ── parity with the live seat-wave.cjs claudeExe() (read as text and run in a sandbox; never require()d) ──
  // Skipped, not failed, once automation/seat-wave.cjs IS the promoted port (it calls this module instead of carrying
  // claudeExe), so the smoke test's "0 FAIL" gate does not go permanently red after phase-2 promotion. CRLF-tolerant: with
  // core.autocrlf=true a `git checkout` rewrites the file with CRLF line ends.
  const live = path.join(__dirname, "seat-wave.cjs");
  const src = realFs.existsSync(live) ? realFs.readFileSync(live, "utf8") : null;
  if (src != null) {   // the extractor itself, on LF, CRLF and promoted-port shapes of the real file
    const t = parityTarget(src);
    if (t.fnSrc) eq("parity extractor: the same function from the LF and the CRLF form of seat-wave.cjs",
      (parityTarget(src.replace(/\r?\n/g, "\r\n")).fnSrc || "").replace(/\r/g, ""), t.fnSrc.replace(/\r/g, ""));
    const port = path.join(__dirname, "seat-wave.pending-server.cjs");
    if (realFs.existsSync(port)) eq("parity extractor: the promoted port is a skip, not a FAIL", !!parityTarget(realFs.readFileSync(port, "utf8")).skip, true);
  }
  const target = parityTarget(src);
  if (target.skip) console.log("  skip parity: " + target.skip);
  else {
    const vm = require("vm");
    if (!target.fnSrc) { fail++; console.log("  FAIL parity: claudeExe() not found in automation/seat-wave.cjs"); }
    else {
      const fnSrc = target.fnSrc;
      const cases = [["two versions", winEnv, winFs1], ["no profile", {}, winFs2], ["fixed location", winEnv, fakeFs("win32", { [WH + "\\.local\\bin\\claude.exe"]: X })],
                     ["nothing", winEnv, fakeFs("win32", {})], ["only LOCALAPPDATA npm-less", { LOCALAPPDATA: LAP }, fakeFs("win32", { [LAP + "\\Programs\\claude\\claude.exe"]: X })]];
      for (const [name, env, ffs] of cases) {
        const sandbox = { process: { env }, require: (m) => (m === "os" ? { homedir: () => WH } : null), fs: ffs, path: path.win32 };
        const liveFn = vm.runInNewContext(fnSrc, sandbox);
        const run = (fn) => { try { return { path: fn() }; } catch (e) { return { error: e.message }; } };
        const L = run(() => liveFn()), M = run(() => find({ platform: "win32", env, homedir: WH, fs: ffs, exec: noExec }).path);
        eq("parity with seat-wave.cjs claudeExe(): " + name, M, L);
      }
    }
  }

  console.log(`claude-bin selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes("--selftest")) process.exit(selftest() ? 0 : 1);
  try {
    const r = resolve();
    if (a.includes("--path")) process.stdout.write(r.path + "\n");
    else console.log(JSON.stringify({ platform: process.platform, path: r.path, version: r.version, how: r.how }, null, 1));
  } catch (e) {
    console.error("claude-bin: " + e.message);
    process.exit(1);
  }
}
