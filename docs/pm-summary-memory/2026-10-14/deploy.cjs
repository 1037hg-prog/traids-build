#!/usr/bin/env node
"use strict";
/**
 * PM SUMMARY MEMORY (2026-10-14) — DEPLOY the bounded nightly summary of R352's recorder (W7, docs/server/wave7-pm).
 *
 * WHAT IT SHIPS: ONE file changes, backend/pm-book-recorder.js (seven anchored edits, EDITS below: the coverage of the per-day summary
 * read in bounded memory — coverDayBounded — summarizeDay calling it, the --summarize run's last line saying its memory, and seven
 * selftest cases). backend/lib/pm-feeds.js is NOT changed (its staged copy is its base copy, byte for byte). Nothing that --run uses
 * changes, nor VERSION, so nothing the recorder RECORDS can change. NOTES.md here says why and how it was proven.
 *
 *   node docs/pm-summary-memory/2026-10-14/deploy.cjs --plan    READ-ONLY. For each file: its sha256 at home NOW, the sha256 this
 *                                                               package was BUILT AGAINST (base) and the STAGED one, and its state:
 *                                                               base (to apply) · applied · unchanged · DRIFT (neither: refused).
 *                                                               Every anchored edit, the fences now. No ssh, nothing written.
 *   node docs/pm-summary-memory/2026-10-14/deploy.cjs --apply   the write mode — the main session's command. In order:
 *     1. every file reads base or applied (DRIFT -> refused, nothing written); the package's own base and staged copies are the
 *        bytes it was built with; the anchored edits replay base -> staged exactly
 *     2. fences: not between 00:20 and 01:20 UTC (the nightly unit fires at 00:40 UTC); traids-pm-nightly.service not active on the
 *        VPS (read over ssh, read-only, fail-closed: an ssh failure refuses)
 *     3. this package's selftest must end "ALL ... CHECKS PASSED"; the fences are asked again
 *     4. home's files are written from staged (temp file + rename), each read back by sha256, then node --check
 *     5. node docs/server/wave7-pm/deploy.cjs --step copy — W7's own copy step: the changed file goes to the VPS in verified chunks
 *        and the recorder's selftest runs THERE (it must be green or the step fails). Its "ATTENTION — ... still runs the code it
 *        started with" line is expected and needs nothing (NOTES.md, "No restart"). If the copy step fails, home is put back from the
 *        base copies and the copy step is run once more so that the VPS holds home's bytes again; the headline says what holds.
 *        (rollback.cjs, the other direction: when ITS copy step fails, home KEEPS the base bytes and the copy step runs once more
 *        with them — the staged recorder is never put back by a rollback.)
 * It NEVER restarts anything (no --restart), never starts a unit, never writes test-registry.json, read-seals.json,
 * change-registry.json or agent-ledger.jsonl (record.cjs does that, later), and keeps no state file: home's bytes are the state.
 * Exit 0 applied (or nothing to apply) and the copy step green · 1 failed (the headline says what holds) · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", ".."), PKG_REL = "docs/pm-summary-memory/2026-10-14";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const NIGHTLY = "traids-pm-nightly.service";
/** the files of the unit: the sha256 each was BUILT AGAINST (home's bytes on 2026-10-14, = what W7's copy step put on the VPS on 2026-10-13) and the staged one */
const FILES = Object.freeze([
  Object.freeze({ rel: "backend/pm-book-recorder.js", base: "base/backend/pm-book-recorder.js", staged: "staged/backend/pm-book-recorder.js", baseSha: "482cdf1b25de07c5264cf9873837b13d5e514d41cbf72c4182781d49de0d144c", stagedSha: /*STAGED_SHA*/"1e9b36c8095d7769c1cad14d74c5ed1e50809afc07fae13730fd179105495c80"/*END*/ }),
  Object.freeze({ rel: "backend/lib/pm-feeds.js", base: "base/backend/lib/pm-feeds.js", staged: "staged/backend/lib/pm-feeds.js", baseSha: "e02a9e3bad2adcb2392b3408e1947960181696bb8fe09d668ae440b39c9afe9f", stagedSha: "e02a9e3bad2adcb2392b3408e1947960181696bb8fe09d668ae440b39c9afe9f" }),
]);
/**
 * THE ANCHORED EDITS of backend/pm-book-recorder.js, base -> staged. anchorSha = sha256 of ONE line of the base file (unique in it);
 * kind: insert-after / insert-before that line, or replace it; count = the new lines; sha = sha256 of the new lines joined by "\n".
 * replay() rebuilds the staged file from the base file and these edits alone: anything else that differs is a problem.
 */
const EDITS = Object.freeze(/*EDITS*/[
    {
      "id": "doc-summarize",
      "kind": "insert-after",
      "anchorSha": "038c504bfc97a39b28c169c15f2e4e3208b50a71a7e4abaaa0be51b34a43bf9b",
      "anchorHead": "* archive hashes, COVERAGE as rule[11] defines it — never a ",
      "count": 3,
      "sha": "6824163da8823a44874fa288847e6874751cbeb474d4a9d35931498642758b86",
      "why": "the file's header says --summarize reads its coverage in bounded memory and ends with a memory line"
    },
    {
      "id": "bounded-coverage",
      "kind": "insert-before",
      "anchorSha": "5a9363665e63ffd939161b56eeaf6204ed41dda9acf6cea9bf71517036086648",
      "anchorHead": "/** the small per-day record the home pull carries: counts, ",
      "count": 236,
      "sha": "d33846477ff509b0db8ad513fb165d2acbb7d47fe1ee9bf86ae44dd634863ae2",
      "why": "coverDayBounded (the same coverage, bounded), scanParts, the three helpers copied from the library, memoryWatch / memoryLine"
    },
    {
      "id": "summary-uses-bounded",
      "kind": "replace",
      "anchorSha": "341ad14bc9ab2a6de874442acd27ea691b232e434e70523944b099643aab35d3",
      "anchorHead": "const c = await F.coverDay({ root, venue, date, nowMs }), gr",
      "count": 1,
      "sha": "a40d08d51bf5cd464aa204c2c0aa43e25c0772592cfb09af3f498bb17823d168",
      "why": "summarizeDay reads its coverage with coverDayBounded instead of the library's coverDay"
    },
    {
      "id": "exports",
      "kind": "replace",
      "anchorSha": "67e8f4c3cd2dd473571be7648b7979d8725556708cc93f06cb35a6f6be9d6783",
      "anchorHead": "lastRowTimes, lastRowTimesLater, runRefusal, refRows, scanDa",
      "count": 1,
      "sha": "fc16f284292d3bb8aec2931be924bdd819a7a0733bfc8d229f87fc2e1ef8060b",
      "why": "exports coverDayBounded, scanParts, memoryWatch, memoryLine (for the package's checks)"
    },
    {
      "id": "summarize-memory-start",
      "kind": "replace",
      "anchorSha": "fc015c25abf693e55070236413eabbc475e74a4540636de9a80922e799afa881",
      "anchorHead": "const days = A.value === \"recent\" ? daysToSummarize(ROOT) : ",
      "count": 1,
      "sha": "1a9fa74b2fce98ab962101df5fb36cbd58bf77194c3a6f3993874b094f0d9960",
      "why": "--summarize starts watching its heap"
    },
    {
      "id": "summarize-memory-line",
      "kind": "insert-after",
      "anchorSha": "d4dbb7c5f0e0c72474e2976b97bd6bba0a783d486837c8a31ddb67d4865b2be4",
      "anchorHead": "for (const d of days) { const s = await summarizeDay(ROOT, d",
      "count": 1,
      "sha": "4dc4d48723f2e373e905f085e41df9353931c1bba2ca1f1831ceb7fbef3c2b47",
      "why": "--summarize ends with one 'summarize memory: peak heap …' line (verify-live reads it)"
    },
    {
      "id": "selftest-cases",
      "kind": "insert-before",
      "anchorSha": "a71089e70c7cfc191c859ae310bb2fa19942c22b2cede24c93d99fdfb52ff028",
      "anchorHead": "// every request any case sent to the in-process servers was",
      "count": 97,
      "sha": "8160a1e3c3bf9b0c467b223319b4a483efe0e3ab850341129648df7bf689b0fa",
      "why": "seven selftest cases: bounded = library on every day the selftest records, a day built for it and its edges by hand, scanParts, summarizeDay, the memory line"
    }
  ]/*END*/);
const isCode = (rel) => /\.(c?js)$/.test(rel);

/** replay the anchored edits on the base text and compare with the staged text -> { ok, problems, hunks } */
function replay(baseText, stagedText, edits = EDITS) {
  const B = baseText.split("\n"), S = stagedText.split("\n"), problems = [], hunks = [];
  const placed = [];
  for (const e of edits) {
    const at = []; for (let i = 0; i < B.length; i++) if (sha(B[i]) === e.anchorSha) at.push(i);
    if (at.length !== 1) { problems.push(`${e.id}: its anchor line (${e.anchorHead}…) is in the base file ${at.length} times, not once`); continue; }
    placed.push({ ...e, i: at[0] });
  }
  placed.sort((a, b) => a.i - b.i);
  let i = 0, j = 0;
  const same = (to) => { while (i < to) { if (B[i] !== S[j]) { problems.push(`base line ${i + 1} is not the staged line ${j + 1} and no edit says so`); return false; } i++; j++; } return true; };
  for (const e of placed) {
    if (!same(e.kind === "insert-after" ? e.i + 1 : e.i)) break;
    const blk = S.slice(j, j + e.count), ok = blk.length === e.count && sha(blk.join("\n")) === e.sha;
    hunks.push({ id: e.id, kind: e.kind, baseLine: e.i + 1, stagedLine: j + 1, count: e.count, ok });
    if (!ok) { problems.push(`${e.id}: the ${e.count} staged line(s) at ${j + 1} are not the edit's (sha256 differs)`); break; }
    j += e.count; if (e.kind === "replace") i++;
  }
  if (!problems.length) { same(B.length); if (!problems.length && j !== S.length) problems.push(`the staged file has ${S.length - j} line(s) after the base file's end`); }
  return { ok: problems.length === 0, problems, hunks };
}
/** one file's state: home now, the package's base and staged copies, and what they say */
function fileState(f, { repo = REPO, pkg = PKG } = {}) {
  const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
  const home = read(path.join(repo, ...f.rel.split("/"))), base = read(path.join(pkg, ...f.base.split("/"))), staged = read(path.join(pkg, ...f.staged.split("/")));
  const r = { rel: f.rel, home: home ? sha(home) : null, base: base ? sha(base) : null, staged: staged ? sha(staged) : null, baseSha: f.baseSha, stagedSha: f.stagedSha, changes: f.baseSha !== f.stagedSha, problem: null, state: null };
  if (r.base !== f.baseSha) r.problem = `the package's base copy ${f.base} is ${r.base ? "not the bytes it was built against" : "missing"}`;
  else if (r.staged !== f.stagedSha) r.problem = `the package's staged copy ${f.staged} is ${r.staged ? "not the bytes that were reviewed" : "missing"}`;
  if (!home) r.state = "absent";
  else if (!r.changes) r.state = r.home === f.baseSha ? "unchanged" : "DRIFT";
  else r.state = r.home === f.stagedSha ? "applied" : r.home === f.baseSha ? "base" : "DRIFT";
  return r;
}
/** the plan of the whole unit: files, the replay of the edits, and whether the write mode could go on (problems = refusals) */
function plan({ repo = REPO, pkg = PKG, forRollback = false } = {}) {
  const files = FILES.map((f) => fileState(f, { repo, pkg })), problems = [];
  for (const x of files) { if (x.problem && !(forRollback && /staged copy/.test(x.problem))) problems.push(`${x.rel}: ${x.problem}`); if (x.state === "DRIFT") problems.push(`${x.rel} is DRIFT at home: its sha256 ${String(x.home).slice(0, 12)} is neither the base ${x.baseSha.slice(0, 12)} nor the staged ${x.stagedSha.slice(0, 12)} — someone changed it since this package was built: read the change, then rebuild the package`); if (x.state === "absent") problems.push(`${x.rel} is missing at home`); }
  let rp = { ok: false, problems: ["the base or staged copy could not be read"], hunks: [] };
  try { const f = FILES[0]; rp = replay(fs.readFileSync(path.join(pkg, ...f.base.split("/")), "utf8"), fs.readFileSync(path.join(pkg, ...f.staged.split("/")), "utf8")); } catch { /* the problem above says so */ }
  if (!rp.ok && !forRollback) problems.push(...rp.problems.map((p) => `anchored edits: ${p}`));
  return { files, replay: rp, problems, todo: files.filter((x) => x.state === "base"), applied: files.every((x) => x.state === "applied" || x.state === "unchanged") };
}
/** 00:20-01:20 UTC: the nightly unit fires at 00:40 UTC — no apply, no rollback, no start of it by hand in that hour */
function utcFence(nowMs) { const d = new Date(nowMs), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return m >= 20 && m < 80 ? `it is ${d.toISOString().slice(11, 16)} UTC, inside 00:20-01:20 UTC (the nightly compress + summary fires at 00:40 UTC) — run it after 01:20 UTC` : null; }
const mtWords = (ms) => new Date(ms).toLocaleString("en-US", { timeZone: "America/Denver", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
/** write bytes so that the file is either the old one or the new one, never half (temp file + rename), then read back by sha256 */
function writeExact(file, buf) {
  const tmp = `${file}.tmp-pmsm-${process.pid}`, fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  if (sha(fs.readFileSync(file)) !== sha(buf)) throw new Error(`${file} does not read back as written`);
}

/**
 * The steps, on injected dependencies (the selftest gives a scratch repo, a fake ssh and fake children): repo, pkg, now, log,
 * nightly() -> "active" | other (throws when it cannot be read), run(args) -> { status, out } (node children: the selftest, W7's copy step).
 */
function make(deps = {}) {
  const d = { repo: REPO, pkg: PKG, now: () => Date.now(), log: (s) => console.log(s), nightly: null, run: null, ...deps };
  if (!d.nightly) d.nightly = () => { const L = require(path.join(d.repo, "docs", "server", "wave7-pm", "w7-lib.cjs")), ssh = L.PS.sshReal(L.HOST), r = ssh(L.REMOTE.unitState([NIGHTLY]), { timeout: 60000 }), m = L.parseUnitState(L.must(r, `reading the state of ${NIGHTLY} on the VPS`)); if (!m[NIGHTLY]) throw new Error(`no state for ${NIGHTLY} in the VPS's answer`); return m[NIGHTLY].active; };
  if (!d.run) d.run = (args, timeoutMs = 1800000) => { const r = cp.spawnSync(process.execPath, args, { cwd: d.repo, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 256 << 20 }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") }; };
  /** the fences, now: [] or the refusals */
  function fences() {
    const out = [], u = utcFence(d.now()); if (u) out.push(u);
    let st; try { st = d.nightly(); } catch (e) { out.push(`the state of ${NIGHTLY} on the VPS could not be read (${String(e.message).slice(0, 200)}) — nothing is assumed about it`); return out; }
    if (st === "active" || st === "activating" || st === "reloading" || st === "deactivating") out.push(`${NIGHTLY} is ${st} on the VPS: it reads and writes the files this would replace — run it when the nightly has finished`);
    return out;
  }
  const copyStep = () => d.run([path.join("docs", "server", "wave7-pm", "deploy.cjs"), "--step", "copy"]);
  /** put home's files back to the given bytes (what was there before this run) */
  const putBack = (before) => { const bad = []; for (const [rel, buf] of Object.entries(before)) { try { writeExact(path.join(d.repo, ...rel.split("/")), buf); } catch (e) { bad.push(`${rel}: ${e.message}`); } } return bad; };
  /** the write mode of deploy (to = "staged") and of rollback (to = "base"): the same order, fences and copy step */
  function writeUnit({ to, gate = null }) {
    const P = plan({ repo: d.repo, pkg: d.pkg, forRollback: to === "base" }), lines = [], say = (s) => { lines.push(s); d.log(s); };
    const refuse = (why) => ({ result: "refused", why, lines });
    if (P.problems.length) return refuse(P.problems);
    const wantBase = to === "base", todo = P.files.filter((x) => x.changes && (wantBase ? x.state === "applied" : x.state === "base"));
    let fz = fences(); if (fz.length) return refuse(fz);
    if (gate && todo.length) { say(`  gate: ${gate.what} …`); const g = gate.run(); if (!g.ok) return refuse([`${gate.what} did not pass: ${g.why}`]); say(`  gate: ${g.line}`); fz = fences(); if (fz.length) return refuse(fz); }
    const before = {}, written = [];
    for (const x of todo) {
      const f = FILES.find((y) => y.rel === x.rel), file = path.join(d.repo, ...x.rel.split("/")), now = fs.readFileSync(file);
      if (sha(now) !== x.home) { putBack(before); return { result: "failed", why: [`${x.rel} changed while this ran`], lines, restored: true }; }
      before[x.rel] = now;
      const buf = fs.readFileSync(path.join(d.pkg, ...(wantBase ? f.base : f.staged).split("/")));
      try { writeExact(file, buf); } catch (e) { const bad = putBack(before); return { result: "failed", why: [`writing ${x.rel}: ${e.message}`], lines, restored: !bad.length, notRestored: bad }; }
      written.push(x.rel);
      if (isCode(x.rel)) { const c = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true }); if (c.status !== 0) { const bad = putBack(before); return { result: "failed", why: [`${x.rel} does not parse after the write: ${String(c.stderr).trim().split("\n")[0]}`], lines, restored: !bad.length, notRestored: bad }; } }
      say(`  wrote ${x.rel}  sha256 ${sha(buf).slice(0, 12)} (${wantBase ? "the base bytes" : "the staged bytes"}), read back and node --check ok`);
    }
    if (!todo.length) say(`  home: nothing to write (every file already reads ${wantBase ? "base" : "applied"})`);
    say("  W7's copy step: node docs/server/wave7-pm/deploy.cjs --step copy …");
    const c = copyStep();
    for (const l of String(c.out).trim().split("\n")) if (l.trim()) say("    | " + l);
    if (c.status === 0) return { result: "done", written, lines };
    if (wantBase) {
      // a ROLLBACK whose copy step failed: home KEEPS the base bytes. W7's copy step uploads before its selftest, so the VPS may hold
      // the base recorder already; putting the staged bytes back at home and copying them again would undo the part of the rollback
      // that landed (and the next 00:40 UTC nightly would run the code being rolled back). The copy step is asked once more, with
      // home's base bytes: green, the rollback is done; red again, it fails saying home is base and the VPS may hold either.
      say(`  W7's copy step failed (exit ${c.status}): home keeps the base bytes (this is a rollback) — the copy step once more, with them …`);
      const again = copyStep();
      for (const l of String(again.out).trim().split("\n")) if (l.trim()) say("    | (again) " + l);
      if (again.status === 0) return { result: "done", written, lines, retried: true, firstCopy: c.status };
      return { result: "failed", why: [`W7's copy step failed twice (exit ${c.status}, then exit ${again.status})`], lines, restored: false, homeKept: "base", notRestored: [], copyAgain: again.status, written };
    }
    // the APPLY's copy step failed: the VPS may hold the new bytes already (it uploads before its selftest) — home goes back, and the
    // copy step is asked once more, so that the VPS holds home's bytes again
    if (!written.length) return { result: "failed", why: [`W7's copy step failed (exit ${c.status}) and nothing was written at home by this run`], lines, restored: true, copyAgain: null };
    const bad = putBack(before), again = bad.length ? null : copyStep();
    if (again) for (const l of String(again.out).trim().split("\n")) if (l.trim()) say("    | (again) " + l);
    return { result: "failed", why: [`W7's copy step failed (exit ${c.status})`], lines, restored: !bad.length, notRestored: bad, copyAgain: again ? again.status : null, written };
  }
  /** the package's selftest as the gate (its last line must say ALL ... CHECKS PASSED) */
  const selftestGate = { what: "this package's selftest (selftest.cjs)", run: () => { const r = d.run([path.join(PKG_REL, "selftest.cjs")], 1800000), last = String(r.out).trim().split("\n").pop() || ""; return { ok: r.status === 0 && /^ALL \d+ CHECKS PASSED/.test(last), line: last, why: last || `exit ${r.status}` }; } };
  return { d, fences, writeUnit, selftestGate, copyStep };
}

function printPlan(P, fz) {
  console.log(`PLAN — pm summary memory (R352's nightly summary, bounded) — ${new Date().toISOString().slice(0, 16)}Z (${mtWords(Date.now())} MT) — read-only, nothing is written`);
  for (const x of P.files) {
    console.log(`\n  ${x.rel}`);
    console.log(`      home now   ${x.home || "(missing)"}`);
    console.log(`      base       ${x.baseSha}${x.base === x.baseSha ? "" : "   PACKAGE COPY DIFFERS: " + (x.base || "missing")}   (what this package was built against)`);
    console.log(`      staged     ${x.stagedSha}${x.staged === x.stagedSha ? "" : "   PACKAGE COPY DIFFERS: " + (x.staged || "missing")}${x.changes ? "" : "   (= base: this file is NOT changed)"}`);
    console.log(`      state      ${x.state === "base" ? "base — the write mode would write the staged bytes" : x.state === "applied" ? "applied — home already holds the staged bytes" : x.state === "unchanged" ? "unchanged — home holds the base bytes, which are the staged ones" : x.state}${x.problem ? "   PROBLEM: " + x.problem : ""}`);
  }
  console.log(`\n  anchored edits of backend/pm-book-recorder.js (base -> staged): ${P.replay.ok ? "every one replays exactly; nothing else differs" : "DO NOT REPLAY: " + P.replay.problems.join("; ")}`);
  for (const h of P.replay.hunks) { const e = EDITS.find((x) => x.id === h.id); console.log(`      ${h.ok ? "ok  " : "BAD "} ${h.id.padEnd(24)} ${h.kind.padEnd(13)} base line ${String(h.baseLine).padStart(4)} -> staged line ${String(h.stagedLine).padStart(4)}, ${String(h.count).padStart(3)} new line(s)   ${e ? e.why : ""}`); }
  console.log(`\n  unit: ${P.problems.length ? "REFUSED by the write mode:\n    - " + P.problems.join("\n    - ") : P.todo.length ? `the write mode would write ${P.todo.map((x) => x.rel).join(", ")} and then run W7's copy step` : "home already holds the staged bytes — the write mode would write nothing and run W7's copy step (idempotent: 'already current' when the VPS has them too)"}`);
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "the clock is clear (outside 00:20-01:20 UTC)"}; the write mode also reads ${NIGHTLY}'s state on the VPS over ssh (read-only) and refuses while it is active — --plan makes no ssh call`);
  console.log("  no restart is needed or done (NOTES.md, 'No restart'); the registry is never written here (record.cjs, after verify-live.cjs).");
}

module.exports = { PKG, REPO, PKG_REL, FILES, EDITS, NIGHTLY, sha, replay, fileState, plan, utcFence, writeExact, make, isCode, mtWords };

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) { console.log("usage: node docs/pm-summary-memory/2026-10-14/deploy.cjs --plan | --apply\n  --plan   read-only: every file's sha256 now / base / staged, its state, the anchored edits, the fences (no ssh)\n  --apply  the write mode (refused 00:20-01:20 UTC and while traids-pm-nightly.service is active)\nNothing was done."); process.exit(2); }
  const P = plan();
  if (MODE === "--plan") { const u = utcFence(Date.now()); printPlan(P, u ? [u] : []); process.exit(0); }
  console.log(`APPLY — pm summary memory — ${new Date().toISOString().slice(0, 16)}Z (${mtWords(Date.now())} MT)`);
  const M = make(), r = M.writeUnit({ to: "staged", gate: M.selftestGate });
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") {
    console.error(`APPLY FAILED: ${r.why.join("; ")}`);
    console.error(r.restored ? `  home's files are back to the bytes they had before this run${r.copyAgain === 0 ? ", and W7's copy step ran again green: the VPS holds home's bytes" : r.copyAgain == null ? "" : ` — but W7's copy step FAILED AGAIN (exit ${r.copyAgain}): the VPS may still hold the staged recorder. Look: node docs/server/wave7-pm/deploy.cjs --status; put it back with: node docs/server/wave7-pm/deploy.cjs --step copy`}` : `  NOT RESTORED: ${(r.notRestored || []).join("; ")} — restore by hand from ${PKG_REL}/base/ (node ${PKG_REL}/rollback.cjs --apply)`);
    process.exit(1);
  }
  console.log(`\nAPPLIED: home ${r.written.length ? "now holds the staged " + r.written.join(", ") : "already held the staged bytes"}; W7's copy step put it on the VPS and the recorder's selftest is green there.`);
  console.log("  No restart (NOTES.md, 'No restart'): the nightly unit starts a NEW process each night, which loads the new file; the running recorder keeps");
  console.log("  the code it started with, which records exactly what the new file would (nothing --run uses was changed). The copy step's ATTENTION line about");
  console.log("  --restart is expected; --restart is NOT part of this package.");
  console.log("  NEXT: node docs/pm-summary-memory/2026-10-14/verify-live.cjs --start   (outside 00:20-01:20 UTC: one nightly run, then PASS/FAIL per line)");
  console.log("        node docs/pm-summary-memory/2026-10-14/record.cjs --dry, then without --dry (outside 13:50-15:50 MT on a trading day)");
  process.exit(0);
}
