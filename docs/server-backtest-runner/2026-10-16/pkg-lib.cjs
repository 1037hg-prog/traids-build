"use strict";
/**
 * PKG-LIB — the staged-package mechanics shared by this package's deploy.cjs, rollback.cjs, record.cjs and selftest.cjs (2026-10-16).
 * The package's FILES (package.json-free, in files.cjs): [{ rel, kind: "edit" | "new" }]
 *   edit  base/<rel> is a byte copy of the live file the change starts from; staged/<rel> is the changed file
 *   new   the live file must not exist before the change; staged/<rel> is the new file (base/ holds nothing for it)
 * State of one file in a repo:  "base" (live == base, or absent for a new file) · "applied" (live == staged) · "drift" (anything else)
 * deploy --apply refuses unless EVERY file is base or applied; rollback refuses unless every file is applied or base. Writes are temp + fsync +
 * rename in the same folder; every write is read back.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const PKG = __dirname;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const read = (f) => { try { return fs.readFileSync(f); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const findRepo = (from) => { for (let d = from; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, "AGENTS.md")) && fs.existsSync(path.join(d, "backend"))) return d; if (path.dirname(d) === d) return null; } };

function stateOf(repo, f) {
  const live = read(path.join(repo, f.rel)), staged = read(path.join(PKG, "staged", f.rel)), base = f.kind === "edit" ? read(path.join(PKG, "base", f.rel)) : null;
  if (!staged) throw new Error(`package broken: staged/${f.rel} missing`);
  if (f.kind === "edit" && !base) throw new Error(`package broken: base/${f.rel} missing`);
  const st = live && live.equals(staged) ? "applied" : f.kind === "new" ? (live ? "drift" : "base") : live && live.equals(base) ? "base" : "drift";
  return { rel: f.rel, kind: f.kind, state: st, live: live ? sha(live).slice(0, 16) : "absent", base: base ? sha(base).slice(0, 16) : "absent", staged: sha(staged).slice(0, 16), stagedBuf: staged, baseBuf: base };
}
function putAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".pkg-tmp-" + process.pid, fd = fs.openSync(tmp, "w");
  try { fs.writeFileSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  if (!fs.readFileSync(file).equals(buf)) throw new Error(`${file}: read back differs`);
}
function plan(repo, FILES) { return FILES.map((f) => stateOf(repo, f)); }
function show(rows, log) { for (const r of rows) log(`${r.state.padEnd(8)} ${r.rel}  live ${r.live} · base ${r.base} · staged ${r.staged}`); }
/** deploy: { mode: "plan"|"apply" } -> exit code */
function deploy(repo, FILES, { mode = "plan", log = console.log } = {}) {
  const rows = plan(repo, FILES); show(rows, log);
  const drift = rows.filter((r) => r.state === "drift");
  if (drift.length) { log(`REFUSED: ${drift.map((r) => r.rel).join(", ")} no longer match${drift.length === 1 ? "es" : ""} base/ (or staged/) — nothing changed`); return 1; }
  const todo = rows.filter((r) => r.state === "base");
  if (mode !== "apply") { log(todo.length ? `PLAN: --apply would write ${todo.length} file(s): ${todo.map((r) => r.rel).join(", ")}` : "PLAN: already applied — nothing to do"); return 0; }
  for (const r of todo) { putAtomic(path.join(repo, r.rel), r.stagedBuf); log(`applied  ${r.rel}`); }
  const after = plan(repo, FILES), notOk = after.filter((r) => r.state !== "applied");
  if (notOk.length) { log(`FAILED: not applied after the write: ${notOk.map((r) => r.rel).join(", ")}`); return 1; }
  log(`APPLIED: ${todo.length} written, ${rows.length - todo.length} already applied`); return 0;
}
/** rollback: puts base/ back byte for byte (a new file is removed) -> exit code */
function rollback(repo, FILES, { dry = false, log = console.log } = {}) {
  const rows = plan(repo, FILES); show(rows, log);
  const drift = rows.filter((r) => r.state === "drift");
  if (drift.length) { log(`REFUSED: ${drift.map((r) => r.rel).join(", ")} match neither staged/ nor base/ — changed since the deploy; nothing rolled back`); return 1; }
  const todo = rows.filter((r) => r.state === "applied");
  if (dry) { log(todo.length ? `DRY: would roll back ${todo.map((r) => r.rel).join(", ")}` : "DRY: nothing applied — nothing to roll back"); return 0; }
  for (const r of todo) { const f = path.join(repo, r.rel); if (r.kind === "new") fs.unlinkSync(f); else putAtomic(f, r.baseBuf); log(`restored ${r.rel}${r.kind === "new" ? " (removed: a new file)" : ""}`); }
  const after = plan(repo, FILES), notOk = after.filter((r) => r.state !== "base");
  if (notOk.length) { log(`FAILED: not at base after the rollback: ${notOk.map((r) => r.rel).join(", ")}`); return 1; }
  log(`ROLLED BACK: ${todo.length} restored`); return 0;
}
/** the change record this package would write (record.cjs) */
function record(repo, FILES, meta) {
  return { id: meta.id, date: meta.date, package: meta.package, what: meta.what, tests: meta.tests || [], files: plan(repo, FILES).map((r) => ({ rel: r.rel, kind: r.kind, base: r.base, staged: r.staged })) };
}
module.exports = { PKG, sha, read, findRepo, stateOf, plan, deploy, rollback, record, putAtomic };
