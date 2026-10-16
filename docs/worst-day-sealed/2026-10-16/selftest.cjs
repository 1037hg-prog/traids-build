#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY SEALED FORECAST LEDGER (2026-10-16) — THE PACKAGE SELFTEST. Offline: no network, no broker, no key, no live file written.
 *
 * It does two things.
 *   1. PACKAGE CHECKS, here: the staged copies parse, the manifest and the staged tree hold the same seven files and nothing else,
 *      base/ holds no copies (every file is new), the fixture in fixtures/ is byte for byte what the shipped generator makes, the
 *      live tree is untouched by the build, and deploy.cjs --plan and rollback.cjs --plan read correctly and write nothing.
 *   2. THE STAGED CODE'S OWN KNOWN ANSWERS, in a SANDBOX: the seven staged files are copied into a throw-away tree under the OS temp
 *      dir, beside byte-exact copies of the three repo files they require (backend/lib/atomic-write.js, backend/lib/run-window.js,
 *      backend/worst-day/lib.js). sealed-selftest.js is then run there, exactly as it will run at home, as a child process. The
 *      sandbox proves the modules reach nothing outside their own tree: no repo path is on their require path at all.
 *
 *   node docs/worst-day-sealed/2026-10-16/selftest.cjs
 * Every case prints as `  ok <case>` or `  FAIL <case> — <why>`. The last line is ALL n CHECKS PASSED, or FAILED — k of n checks.
 * Exit 0 only on the first.
 */
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const L = require("./lib.cjs");

/** the three repo files the staged modules require, copied byte for byte into the sandbox */
const DEPS = ["backend/lib/atomic-write.js", "backend/lib/run-window.js", "backend/worst-day/lib.js"];
/** the two package.json files the sandbox needs to load modules the way home does: the root says "type": "module", and
 *  backend/package.json says nothing, which makes every .js under backend/ CommonJS. Copied, not written, so the sandbox cannot
 *  disagree with the repo about what these files are. */
const MARKERS = ["package.json", "backend/package.json"];

const results = [];
const ok = (name, cond, why = "") => results.push({ name, ok: !!cond, why });
const eq = (name, got, want) => ok(name, Object.is(got, want), `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);

// ── 1. package checks ────────────────────────────────────────────────────────────────────────────────────────────────
let U = null;
try { U = L.unit(); ok("every file in the manifest has a staged copy", true); } catch (e) { ok("every file in the manifest has a staged copy", false, e.message); }

{ const walk = (dir, pre = "") => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name), pre + d.name + "/") : [pre + d.name]));
  const inTree = walk(L.STAGED).sort(), inManifest = L.REL_PATHS.slice().sort();
  eq("staged/ holds exactly the files the manifest names", inTree.join(","), inManifest.join(",")); }

{ const base = path.join(L.PKG, "base");
  const files = fs.existsSync(base) ? fs.readdirSync(base).filter((f) => f !== "README.md") : [];
  eq("base/ holds no copies: every file this package ships is new", files.join(","), "");
  ok("base/README.md says why base/ is empty", fs.existsSync(path.join(base, "README.md")), "base/README.md is missing"); }

if (U) for (const [rel] of L.FILES) {
  const r = cp.spawnSync(process.execPath, ["--check", L.stagedPath(rel)], { encoding: "utf8", windowsHide: true });
  ok(`the staged ${rel} passes node --check`, r.status === 0, String(r.stderr || "").trim().split("\n")[0]);
}
{ const a = Buffer.from("one"), b = Buffer.from("another");
  eq("a path with nothing at it reads as absent", L.stateOf(null, a), "absent");
  eq("the staged bytes, byte for byte, read as applied", L.stateOf(Buffer.from("one"), a), "applied");
  eq("ANYTHING ELSE AT THE PATH READS AS DRIFT, never as applied", L.stateOf(b, a), "drift");
  eq("one byte of difference is already DRIFT", L.stateOf(Buffer.from("onf"), a), "drift");
  eq("a shorter file at the path is DRIFT", L.stateOf(Buffer.from("on"), a), "drift"); }
{ let P = null; try { P = L.plan(); } catch (e) { ok("the package can read its own state", false, e.message); }
  if (P) { ok("no file of this package is at its repo path as something else (no DRIFT)", P.drift.length === 0, P.drift.map((f) => f.problem).join(" | "));
    ok("the package reads one state for the whole unit", ["absent", "applied", "drift"].includes(P.state), `it reads ${P.state}`); } }

// ── 2. the sandbox ───────────────────────────────────────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wd-sealed-pkg-"));
let childOut = "", childCode = null;
try {
  for (const rel of DEPS.concat(MARKERS)) {
    const dst = path.join(TMP, ...rel.split("/"));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, fs.readFileSync(path.join(L.REPO, ...rel.split("/"))));
  }
  for (const [rel] of L.FILES) {
    const dst = path.join(TMP, ...rel.split("/"));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, fs.readFileSync(L.stagedPath(rel)));          // read through fs so a mutation hook reaches the sandbox too
  }
  ok("the sandbox holds the seven staged files and the five repo files they need", DEPS.concat(MARKERS, L.REL_PATHS).every((r) => fs.existsSync(path.join(TMP, ...r.split("/")))), "a file is missing from the sandbox");
  ok("the sandbox loads the staged modules as CommonJS, the way backend/ does at home", JSON.parse(fs.readFileSync(path.join(TMP, "package.json"), "utf8")).type === "module" && !("type" in JSON.parse(fs.readFileSync(path.join(TMP, "backend", "package.json"), "utf8"))), "the two package.json files do not say what home's say");

  // the fixture must be exactly what the shipped generator makes
  { const gen = require(path.join(TMP, "backend", "worst-day", "sealed-fixtures.js"));
    const made = JSON.stringify(gen.syntheticBars(), null, 1) + "\n";
    const fixture = path.join(L.PKG, "fixtures", "synthetic-bars.json");
    const have = fs.existsSync(fixture) ? fs.readFileSync(fixture, "utf8") : null;
    ok("fixtures/synthetic-bars.json is byte for byte what the shipped generator makes", have === made, have === null ? "the fixture is missing — node fixtures/make-bars.cjs writes it" : `the fixture is ${have.length} bytes, the generator makes ${made.length}`);
    eq("the fixture is 340 sessions", gen.syntheticBars().length, 340); }

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/ANTHROPIC|ALPACA|TELEGRAM|SMTP|SCHWAB|TASTY|NTFY|CLAUDE/i.test(k)));
  const r = cp.spawnSync(process.execPath, [path.join(TMP, "backend", "worst-day", "sealed-selftest.js")], { encoding: "utf8", cwd: TMP, env, timeout: 900000, windowsHide: true, maxBuffer: 64 << 20 });
  childOut = String(r.stdout || "") + String(r.stderr || ""); childCode = r.status;
} catch (e) { ok("the sandbox could be built and run", false, (e && e.stack ? e.stack : String(e)).split("\n").slice(0, 3).join(" / ")); }
finally { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* the OS will */ } }

// forward the staged code's own cases as this selftest's cases
{ const lines = childOut.split(/\r?\n/);
  const cases = lines.filter((l) => /^ {2}(ok|FAIL) /.test(l));
  const last = (childOut.trim().split(/\r?\n/).slice(-1)[0] || "").slice(0, 200);
  for (const l of cases) { const isOk = /^ {2}ok /.test(l); const body = l.replace(/^ {2}(ok|FAIL) {2,3}/, ""); const [name, why] = isOk ? [body, ""] : body.split(" — "); results.push({ name, ok: isOk, why: why || "" }); }
  ok("the staged selftest ran in the sandbox and gave a verdict", cases.length > 0 && childCode !== null, `exit ${childCode}: ${last}`);
  ok("the staged selftest's own verdict is that it passed", childCode === 0 && /^ALL \d+ CHECKS PASSED$/.test(last), `exit ${childCode}: ${last}`);
  ok("the staged selftest ran at least 150 cases", cases.length >= 150, `it ran ${cases.length}`); }

// ── 3. the package's two read-only modes ─────────────────────────────────────────────────────────────────────────────
try { const stamp = () => L.REL_PATHS.map((rel) => { const b = L.readOrNull(L.livePath(rel)); return rel + ":" + (b ? L.sha(b) : "-"); }).join(","), before = stamp(), stBefore = L.readOrNull(L.STATE_FILE);
  const P = L.plan();
  const r = cp.spawnSync(process.execPath, [path.join(L.PKG, "deploy.cjs"), "--plan"], { encoding: "utf8", cwd: L.REPO, windowsHide: true });
  const out = String(r.stdout || "") + String(r.stderr || "");
  eq("deploy.cjs --plan exits 0 unless there is DRIFT", r.status, P.drift.length ? 1 : 0);
  eq("deploy.cjs --plan names every file of the package once", (out.match(/backend\/worst-day\/[a-z-]+\.js {2}/g) || []).length, L.FILES.length);
  ok("deploy.cjs --plan reports each file's state as the manifest reads it", L.REL_PATHS.every((rel) => new RegExp(`${rel.replace(/[./]/g, "\\$&")} +(absent|applied|DRIFT) `).test(out)), "a file's state is missing from the plan");
  ok("deploy.cjs --plan says it wrote nothing", /nothing was written\./.test(out), "it did not say so");
  ok("deploy.cjs --plan changed no live file", stamp() === before, "a live file moved");
  ok("deploy.cjs --plan did not touch the package's own record", String(L.readOrNull(L.STATE_FILE)) === String(stBefore), "deploy-state.json moved");
  const r2 = cp.spawnSync(process.execPath, [path.join(L.PKG, "rollback.cjs"), "--plan"], { encoding: "utf8", cwd: L.REPO, windowsHide: true });
  const out2 = String(r2.stdout || "") + String(r2.stderr || "");
  eq("rollback.cjs --plan exits 0 unless there is DRIFT", r2.status, P.drift.length ? 1 : 0);
  ok("rollback.cjs --plan says it wrote nothing", /nothing was written\./.test(out2), out2.split("\n").slice(-2).join(" / "));
  ok("rollback.cjs --plan says the ledger is data it never touches", /is DATA and is never touched here/.test(out2), "it does not say so");
  ok("rollback.cjs --plan changed no live file", stamp() === before, "a live file moved");
} catch (e) { ok("the two read-only modes could be run", false, (e && e.stack ? e.stack : String(e)).split("\n").slice(0, 2).join(" / ")); }
{ const r = cp.spawnSync(process.execPath, [path.join(L.PKG, "deploy.cjs")], { encoding: "utf8", cwd: L.REPO, windowsHide: true });
  eq("deploy.cjs with no mode refuses and exits 2", r.status, 2); }
{ const r = cp.spawnSync(process.execPath, [path.join(L.PKG, "record.cjs"), "--dry"], { encoding: "utf8", cwd: L.REPO, windowsHide: true });
  const out = String(r.stdout || "") + String(r.stderr || "");
  ok("record.cjs --dry prints the record it would write and writes nothing", /DRY — nothing written/.test(out) || /REFUSED/.test(out), (out.trim().split("\n").slice(-1)[0] || "").slice(0, 160));
  ok("record.cjs --dry never touches the registry", !/WRITTEN:/.test(out), "it says it wrote something"); }

// ── the verdict ──────────────────────────────────────────────────────────────────────────────────────────────────────
for (const r of results) console.log(r.ok ? `  ok   ${r.name}` : `  FAIL ${r.name} — ${r.why}`);
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAILED — ${bad.length} of ${results.length} checks` : `ALL ${results.length} CHECKS PASSED`);
process.exitCode = bad.length ? 1 : 0;      // not process.exit(): stdout is a pipe here, and exit() drops what is still in it
