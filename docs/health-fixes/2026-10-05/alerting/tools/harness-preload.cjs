"use strict";
/**
 * HARNESS PRELOAD — package "alerting", health-fixes 2026-10-05. Loaded with:
 *     node --require <this> "<repo>\backend\preflight.js" [args]
 * It lets the STAGED package run as if deployed, against the LIVE data directory, without being able to change anything:
 *
 *   OVERLAY  a module whose staged copy exists (<pkg>\staged\<rel>) is compiled from the staged source under its LIVE path, so it gets
 *            the live __dirname and live require() resolution; a staged-only file (a new lib) resolves at its live path too.
 *   WRITES   every filesystem write whose path is inside the repo THROWS (the probe is read-only; --no-write keeps preflight from
 *            even trying). Writes outside the repo (the selftest's os.tmpdir() fixtures) pass.
 *   NETWORK  fetch: GET anywhere and any method to localhost pass; any other non-GET (e.g. the Schwab OAuth POST of the existing
 *            "schwab feed" probe) is refused, so the run touches no broker with anything but a GET. Every external call is logged.
 *   CHILDREN only `git ls-files` (preflight's secrets probe) may run; everything else throws.
 * A summary of external calls and refused actions is printed to stderr at exit.
 */
const fs = require("fs"), path = require("path"), Module = require("module"), cp = require("child_process");
const REPO = path.resolve(process.env.ALERTING_REPO || "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle");
const STAGED = path.resolve(process.env.ALERTING_STAGED || path.join(__dirname, "..", "staged"));
const lc = (p) => path.resolve(String(p)).toLowerCase();
const inside = (p, root) => { const a = lc(p), r = lc(root); return a === r || a.startsWith(r + path.sep); };
const stagedOf = (live) => (inside(live, REPO) && !inside(live, STAGED) ? path.join(STAGED, path.relative(REPO, live)) : null);
const log = { external: [], refused: [], overlaid: new Set() };

// ── OVERLAY ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  try { return origResolve.call(this, request, parent, ...rest); }
  catch (e) {
    const abs = path.isAbsolute(request);
    if (e.code !== "MODULE_NOT_FOUND" || (!abs && (!parent || !parent.filename || !/^\.\.?[\\/]/.test(request)))) throw e;
    const cand = abs ? path.resolve(request) : path.resolve(path.dirname(parent.filename), request), tries = [cand, cand + ".js"];
    for (const live of tries) { const s = stagedOf(live); if (s && fs.existsSync(s) && fs.statSync(s).isFile()) return live; }
    throw e;
  }
};
const origJs = Module._extensions[".js"];
Module._extensions[".js"] = function (module, filename) {
  const s = stagedOf(filename);
  if (s && fs.existsSync(s)) { log.overlaid.add(path.relative(REPO, filename)); return module._compile(fs.readFileSync(s, "utf8").replace(/^#!.*/, ""), filename); }
  return origJs.call(this, module, filename);
};

// ── WRITES ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const refuse = (what, p) => { const m = `harness: ${what} refused inside the repo: ${path.relative(REPO, path.resolve(String(p)))}`; log.refused.push(m); throw new Error(m); };
const writeFlag = (f) => (f == null ? false : typeof f === "number" ? (f & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC)) !== 0 : /[wa+]/.test(String(f)));
const guard1 = (name) => { const o = fs[name]; fs[name] = function (p, ...r) { if (typeof p !== "number" && inside(p, REPO)) refuse(name, p); return o.call(fs, p, ...r); }; };
const guard2 = (name) => { const o = fs[name]; fs[name] = function (a, b, ...r) { if (inside(b, REPO) || (name === "renameSync" && inside(a, REPO))) refuse(name, inside(b, REPO) ? b : a); return o.call(fs, a, b, ...r); }; };
["writeFileSync", "appendFileSync", "unlinkSync", "rmSync", "rmdirSync", "mkdirSync", "truncateSync", "utimesSync", "createWriteStream", "writeFile", "appendFile", "unlink", "rm", "mkdir"].forEach(guard1);
["renameSync", "copyFileSync", "rename", "copyFile"].forEach(guard2);
{ const o = fs.openSync; fs.openSync = function (p, flags, ...r) { if (writeFlag(flags) && inside(p, REPO)) refuse("openSync(" + flags + ")", p); return o.call(fs, p, flags, ...r); }; }
{ const P = fs.promises; for (const n of ["writeFile", "appendFile", "unlink", "rm", "mkdir", "rename", "copyFile", "open"]) { const o = P[n]; P[n] = function (p, ...r) { if (inside(n === "rename" || n === "copyFile" ? r[0] : p, REPO) && (n !== "open" || writeFlag(r[0]))) return Promise.reject(new Error(`harness: fs.promises.${n} refused inside the repo`)); return o.call(P, p, ...r); }; } }

// ── NETWORK ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const origFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (!local && method !== "GET") { const m = `harness: ${method} ${url.hostname}${url.pathname} refused (GET only off-box)`; log.refused.push(m); throw new TypeError(m); }
  if (!local) log.external.push(`${method} ${url.hostname}${url.pathname}`);
  return origFetch.call(this, input, init);
};

// ── CHILD PROCESSES ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const gitLs = (file, args) => /(^|[\\/])git(\.exe)?$/i.test(String(file)) && Array.isArray(args) && args[0] === "ls-files";
for (const n of ["execFileSync", "execFile", "spawnSync", "spawn"]) { const o = cp[n]; cp[n] = function (file, args, ...r) { if (!gitLs(file, args)) { const m = `harness: child process refused: ${file} ${Array.isArray(args) ? args.join(" ") : ""}`.slice(0, 160); log.refused.push(m); throw new Error(m); } return o.call(cp, file, args, ...r); }; }
for (const n of ["exec", "execSync", "fork"]) { cp[n] = function (c) { const m = `harness: child process refused: ${String(c).slice(0, 120)}`; log.refused.push(m); throw new Error(m); }; }

process.on("exit", () => {
  const count = (a) => Object.entries(a.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {})).map(([k, v]) => `${k}${v > 1 ? " x" + v : ""}`);
  process.stderr.write(`\n[harness] overlaid from staged: ${[...log.overlaid].join(", ") || "none"}\n[harness] external calls: ${count(log.external).join("; ") || "none"}\n[harness] refused: ${count(log.refused).join("; ") || "none"}\n`);
});
