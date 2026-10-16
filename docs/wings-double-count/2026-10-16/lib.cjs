#!/usr/bin/env node
"use strict";
/**
 * WINGS DOUBLE COUNT (2026-10-16) — the shared part of deploy.cjs and rollback.cjs.
 *
 * FIVE FILES, all under backend/, all read-only analysis and reporting code. Nothing here sends an
 * order, touches a broker, writes a ledger row, or changes a registered rule, bar, population or read
 * condition. One file is NEW (backend/lib/ticket-rows.js): it has no base copy, because at base it does
 * not exist, and a rollback deletes it — which IS its base state, byte for byte.
 *
 * `--plan` is read-only. The write modes refuse on DRIFT: a file at home whose sha256 is neither the
 * bytes this package was built against nor the bytes it stages. Read the change, then rebuild the package.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");
const PKG_REL = "docs/wings-double-count/2026-10-16";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/**
 * baseSha null = the file does not exist at base (it is new with this package).
 * `why` is the one line --plan prints for it.
 */
const FILES = Object.freeze([
  Object.freeze({ rel: "backend/lib/ticket-rows.js", isNew: true,
    baseSha: null,
    stagedSha: "bf41b698b222270865fc45bbe5f674f19cdd8d303eabe4b4760cb4cc2fcc048b",
    why: "NEW. The one definition of which row IS a ticket (collapseByTicket, keyed on the ticket id). No caller of it existed before." }),
  Object.freeze({ rel: "backend/lib/reconcile.js", isNew: false,
    baseSha: "ab2ceac62380bb2fbcf9a976a13d509c26920f62097aaa6001d9498826c521d0",
    stagedSha: "23042e9288748ac27e65da494a2e65d674fb3105c65052224529a8bc1b0aa58f",
    why: "the canonical read collapses to one row per ticket BEFORE any filter, and reports what that collapsed; journalLag() counts tickets on both sides; a third known ambiguity is surfaced. BREAKS COMPARABILITY where a duplicate ticket id existed." }),
  Object.freeze({ rel: "backend/daily-postmortem.js", isNew: false,
    baseSha: "e1e7cc7290d55fba964d4afecbafde5ff9d2d90eb78bee89e9c810836b41238e",
    stagedSha: "5b550ec34532fb6d46fd6cb0099a597817f9acc875438d153362fd27bf5d78c4",
    why: "reads trade_log.json directly (the day's realized cash) and had no per-ticket collapse: the epoch cohort scan, the equity curve and the sd counted a revoided wing twice. Now collapses first and says so on its own second line." }),
  Object.freeze({ rel: "backend/options-news-shadow.js", isNew: false,
    baseSha: "02dc43c69bf53f610459a346ad977811efbc7eaeb90b40e42a38dcd31c1c91c8",
    stagedSha: "9d11b1e22d21ed852f4bf7936bd81ca70c75c6d95acd986ff8f7b1f78015ca38",
    why: "deduplicated by ARRIVAL ORDER, which is right only while the newest close of a ticket happens to be written first. Now keyed on the ticket id, so its answer does not depend on the write order." }),
  Object.freeze({ rel: "backend/trade-postmortem.js", isNew: false,
    baseSha: "22e87d48469531f0425ae6618b1660439fdffe8c16593dd707f2bbf4a5a213ac",
    stagedSha: "61fbcb2e32b86e703a0b48bf5eeb65e9ae41d4f83d97c126c2086847efa5dce5",
    why: "reads trade_log.json directly and summed ROWS in every section — era split, exit anatomy, exit-rule A/B, class x direction, strategy, confidence quartiles, day clustering, totR. On the fixture it printed R21-premium n 14 / tot -8.2R where the truth is n 7 / -1.2R. Now collapses first." }),
  Object.freeze({ rel: "backend/skip-filter-monitor.js", isNew: false,
    baseSha: "0319769e588a9d916ca2ca6cfc69ba3867cf896f9a7a308cd8f850c826d3a9dd",
    stagedSha: "6f7787ebb45246a86b295360a9ce6b0ce17bd95b7aa7f14465336a998b9cbd2e",
    why: "the learning-curve monitor's training sample, its day-level mean R and its 100-boundary gate all counted ROWS, and a wing carries obs, so each revoided wing entered twice. Now one row per ticket. TELEMETRY, NOT THE ADJUDICATION: the registered n>=2000 run is a different script and is not touched." }),
  Object.freeze({ rel: "backend/integrity-audit.js", isNew: false,
    baseSha: "f9c2264866267cf8748652cf79f1d804457a0654261166973c50ac49e77bf991",
    stagedSha: "ca198514748b8e13282f8f8e9a087c577221bee83b4e7939f31f994426d907fc",
    why: "sections 1-2 stay per ROW (an arithmetic audit must re-derive every row). Section 2b REPORTS duplicate ticket ids — reported, never an impossibility, so the nightly chain cannot go red for it. The too-good tripwire counts tickets." }),
]);

const isCode = (rel) => /\.(c?js)$/.test(rel);
const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
const pkgPath = (pkg, rel, which) => path.join(pkg, which, ...rel.split("/"));

/** one file's state: home now, the package's own copies, and what they say */
function fileState(f, { repo = REPO, pkg = PKG } = {}) {
  const home = read(path.join(repo, ...f.rel.split("/")));
  const base = f.isNew ? null : read(pkgPath(pkg, f.rel, "base"));
  const staged = read(pkgPath(pkg, f.rel, "staged"));
  const r = { rel: f.rel, isNew: !!f.isNew, baseSha: f.baseSha, stagedSha: f.stagedSha, why: f.why,
    home: home ? sha(home) : null, base: base ? sha(base) : null, staged: staged ? sha(staged) : null,
    problem: null, state: null };
  if (f.isNew) { if (fs.existsSync(pkgPath(pkg, f.rel, "base"))) r.problem = `${PKG_REL}/base/${f.rel} exists, but this file is NEW — base must not hold it`; }
  else if (r.base !== f.baseSha) r.problem = `the package's base copy base/${f.rel} is ${r.base ? "not the bytes it was built against" : "missing"}`;
  if (!r.problem && r.staged !== f.stagedSha) r.problem = `the package's staged copy staged/${f.rel} is ${r.staged ? "not the bytes that were reviewed" : "missing"}`;
  if (f.isNew) r.state = !home ? "new" : r.home === f.stagedSha ? "applied" : "DRIFT";
  else if (!home) r.state = "absent";
  else if (f.baseSha === f.stagedSha) r.state = r.home === f.baseSha ? "unchanged" : "DRIFT";
  else r.state = r.home === f.stagedSha ? "applied" : r.home === f.baseSha ? "base" : "DRIFT";
  return r;
}

/** the whole unit: every file's state and the refusals the write modes would raise */
function plan({ repo = REPO, pkg = PKG, forRollback = false } = {}) {
  const files = FILES.map((f) => fileState(f, { repo, pkg })), problems = [];
  for (const x of files) {
    if (x.problem && !(forRollback && /staged copy/.test(x.problem))) problems.push(`${x.rel}: ${x.problem}`);
    if (x.state === "DRIFT") problems.push(`${x.rel} is DRIFT at home: its sha256 ${String(x.home).slice(0, 12)} is neither the base ${x.isNew ? "(absent)" : String(x.baseSha).slice(0, 12)} nor the staged ${String(x.stagedSha).slice(0, 12)} — someone changed it since this package was built: read the change, then rebuild the package`);
    if (x.state === "absent") problems.push(`${x.rel} is missing at home (this package changes it; it is not new)`);
  }
  const todoApply = files.filter((x) => x.state === "base" || x.state === "new");
  const todoRollback = files.filter((x) => x.state === "applied");
  return { files, problems, todoApply, todoRollback,
    applied: files.every((x) => x.state === "applied" || x.state === "unchanged"),
    atBase: files.every((x) => x.state === "base" || x.state === "new" || x.state === "unchanged") };
}

/** write bytes so the file is either the old one or the new one, never half; then read it back by sha256 */
function writeExact(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-wdc-${process.pid}`, fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  if (sha(fs.readFileSync(file)) !== sha(buf)) throw new Error(`${file} does not read back as written`);
}

const mtWords = (ms) => new Date(ms).toLocaleString("en-US", { timeZone: "America/Denver", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * The write unit, on injected dependencies so the selftest can give it a scratch repo.
 *   to = "staged" (deploy) | "base" (rollback). A NEW file is written on apply and DELETED on rollback,
 *   which is its base state byte for byte.
 */
function make(deps = {}) {
  const d = { repo: REPO, pkg: PKG, now: () => Date.now(), log: (s) => console.log(s), run: null, ...deps };
  if (!d.run) d.run = (args, timeoutMs = 900000) => { const r = cp.spawnSync(process.execPath, args, { cwd: d.repo, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 64 << 20 }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") }; };

  /** this package's selftest as the gate; its last line must say ALL <n> CHECKS PASSED */
  const selftestGate = { what: "this package's selftest (selftest.cjs, known-answer tests on fixtures)",
    run: () => { const r = d.run([path.join(d.pkg, "selftest.cjs")]), last = String(r.out).trim().split("\n").pop() || "";
      return { ok: r.status === 0 && /^ALL \d+ CHECKS PASSED/.test(last), line: last, why: last || `exit ${r.status}` }; } };

  function writeUnit({ to, gate = null }) {
    const wantBase = to === "base";
    const P = plan({ repo: d.repo, pkg: d.pkg, forRollback: wantBase });
    const lines = [], say = (s) => { lines.push(s); d.log(s); };
    if (P.problems.length) return { result: "refused", why: P.problems, lines };
    const todo = wantBase ? P.todoRollback : P.todoApply;
    if (gate && todo.length) {
      say(`  gate: ${gate.what} …`);
      const g = gate.run();
      if (!g.ok) return { result: "refused", why: [`${gate.what} did not pass: ${g.why}`], lines };
      say(`  gate: ${g.line}`);
    }
    const before = new Map(), written = [];
    const putBack = () => { const bad = []; for (const [rel, buf] of before) { const file = path.join(d.repo, ...rel.split("/")); try { if (buf === null) { if (fs.existsSync(file)) fs.unlinkSync(file); } else writeExact(file, buf); } catch (e) { bad.push(`${rel}: ${e.message}`); } } return bad; };
    for (const x of todo) {
      const f = FILES.find((y) => y.rel === x.rel), file = path.join(d.repo, ...x.rel.split("/"));
      const now = read(file);
      if ((now ? sha(now) : null) !== x.home) { putBack(); return { result: "failed", why: [`${x.rel} changed while this ran`], lines, restored: true }; }
      before.set(x.rel, now);
      if (wantBase && f.isNew) {
        try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) { const bad = putBack(); return { result: "failed", why: [`deleting ${x.rel}: ${e.message}`], lines, restored: !bad.length, notRestored: bad }; }
        written.push(x.rel); say(`  deleted ${x.rel}  (it does not exist at base — that IS its base state)`);
        continue;
      }
      const buf = read(pkgPath(d.pkg, x.rel, wantBase ? "base" : "staged"));
      if (!buf) { const bad = putBack(); return { result: "failed", why: [`${wantBase ? "base" : "staged"}/${x.rel} could not be read`], lines, restored: !bad.length, notRestored: bad }; }
      try { writeExact(file, buf); } catch (e) { const bad = putBack(); return { result: "failed", why: [`writing ${x.rel}: ${e.message}`], lines, restored: !bad.length, notRestored: bad }; }
      written.push(x.rel);
      if (isCode(x.rel)) {
        const c = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true });
        if (c.status !== 0) { const bad = putBack(); return { result: "failed", why: [`${x.rel} does not parse after the write: ${String(c.stderr).trim().split("\n")[0]}`], lines, restored: !bad.length, notRestored: bad }; }
      }
      say(`  wrote ${x.rel}  sha256 ${sha(buf).slice(0, 12)} (${wantBase ? "the base bytes" : "the staged bytes"}), read back and node --check ok`);
    }
    if (!todo.length) say(`  home: nothing to write (every file already reads ${wantBase ? "base" : "applied"})`);
    return { result: "done", written, lines };
  }
  return { d, writeUnit, selftestGate };
}

function printPlan(P, { title, mode }) {
  console.log(`${title} — ${new Date().toISOString().slice(0, 16)}Z (${mtWords(Date.now())} MT) — read-only, nothing is written`);
  for (const x of P.files) {
    console.log(`\n  ${x.rel}${x.isNew ? "   [NEW with this package]" : ""}`);
    console.log(`      home now   ${x.home || "(absent)"}`);
    console.log(`      base       ${x.baseSha || "(absent — the file does not exist at base)"}${x.isNew || x.base === x.baseSha ? "" : "   PACKAGE COPY DIFFERS: " + (x.base || "missing")}`);
    console.log(`      staged     ${x.stagedSha}${x.staged === x.stagedSha ? "" : "   PACKAGE COPY DIFFERS: " + (x.staged || "missing")}`);
    console.log(`      state      ${({ base: "base — apply would write the staged bytes", new: "new — apply would create it", applied: "applied — home already holds the staged bytes", unchanged: "unchanged — home holds the base bytes, which are the staged ones", absent: "ABSENT at home", DRIFT: "DRIFT" })[x.state] || x.state}${x.problem ? "   PROBLEM: " + x.problem : ""}`);
    console.log(`      why        ${x.why}`);
  }
  const todo = mode === "rollback" ? P.todoRollback : P.todoApply;
  console.log(`\n  unit: ${P.problems.length ? "REFUSED by the write mode:\n    - " + P.problems.join("\n    - ")
    : todo.length ? `the write mode would ${mode === "rollback" ? "put back" : "write"} ${todo.map((x) => x.rel).join(", ")}`
    : `nothing to ${mode === "rollback" ? "put back" : "write"} — home already reads ${mode === "rollback" ? "base" : "applied"}`}`);
  console.log(`  gate: the write mode runs ${PKG_REL}/selftest.cjs first and refuses unless its last line says ALL <n> CHECKS PASSED.`);
  console.log(`  no fence is needed: all five files are read-only analysis code. Nothing here is a broker call, an order, a ledger write or a registered rule.`);
  console.log(`  the registry is never written here — record.cjs does that, after the operator has looked at the output.`);
}

module.exports = { PKG, REPO, PKG_REL, FILES, sha, isCode, read, pkgPath, fileState, plan, writeExact, mtWords, make, printPlan };
