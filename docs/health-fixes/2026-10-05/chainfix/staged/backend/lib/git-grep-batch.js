"use strict";
/**
 * GIT GREP, BATCHED — "which tracked files mention each of these names?" in ONE pass over the tree.
 *
 * WHY (2026-10-05 health sweep, BK6). routine-necessity.js asked that question one name at a time:
 * `git grep -l -- "<name>" -- backend src automation`, ~115 calls a run. The pathspec covers
 * backend/data, which now holds ~115k tracked files, so every call paid ~5-8 s of file opens and the
 * step timed out at 10 minutes on Friday 2026-10-02 (its first run in five weeks). The per-name cost is
 * almost all file-open overhead, so the fix is to open the tree once, not to search less of it:
 * narrowing the pathspec would have changed the answer (data files that mention a script are readers
 * as far as the old check was concerned).
 *
 * HOW, with the old semantics kept exactly:
 *   1. UNION PASS. One `git grep -l -z -E -e "a|b|c..."` over the same pathspec. A pattern made only of
 *      [A-Za-z0-9_.-] means the same thing in BRE (what the old single-name call used, git's default)
 *      and in ERE, and a line matches an alternation iff it matches one of its members — so the union
 *      is exactly the set of files the old calls would have listed between them. Any pattern outside
 *      that alphabet is searched on its own, exactly as before (none today).
 *   2. ATTRIBUTION, only over that union (~44k files, ~150 MB today, vs ~115k files for every name):
 *        - a pattern of [A-Za-z0-9_-] only is a fixed string; `git grep -l` lists a file iff some line
 *          contains it, i.e. iff the file's bytes contain it (the pattern holds no newline). That is a
 *          byte search, done here with Buffer.indexOf — identical, not approximate.
 *        - a pattern containing '.' (BRE: any one character, never a newline; one character can be up
 *          to 4 bytes of UTF-8) is first filtered here with a SUPERSET regex ('.' -> [^\n]{1,4} over
 *          the raw bytes), and every surviving file is then confirmed by git itself with the original
 *          pattern, so git's own regex engine has the last word.
 *   3. FAIL CLOSED. Any git error (exit other than 0 = matched / 1 = nothing matched), spawn error or
 *      unreadable file THROWS. The old per-name call swallowed every error as "no readers" — including
 *      execSync's 1 MB maxBuffer overflow (ENOBUFS), which on 2026-10-05 silently zeroed the reader
 *      count for market-legal-scan (43,545 files) and market-news-cycle (24,052 files). The caller
 *      decides how to report a failed search; it must never read as an empty answer.
 *
 * Returns Map(pattern -> array of repo-relative paths, as git prints them with -z: raw, unquoted).
 */
const fs = require("fs"), path = require("path"), cp = require("child_process");

const SAME_IN_BRE_AND_ERE = /^[A-Za-z0-9_.-]+$/;
const FIXED = /^[A-Za-z0-9_-]+$/;
const MAX_ALT_CHARS = 8000;      // one -e alternation stays far below the 32k Windows command-line limit
const MAX_PATH_CHARS = 20000;    // file lists handed back to git for confirmation, per call

function git(cwd, args) {
  const r = cp.spawnSync("git", args, { cwd, maxBuffer: 1 << 30, windowsHide: true });
  if (r.error) throw new Error(`git ${args.join(" ").slice(0, 120)}: ${r.error.code || r.error.message}`);
  if (r.status === 1) return [];                                   // git grep: 1 = nothing matched
  if (r.status !== 0) throw new Error(`git ${args.join(" ").slice(0, 120)} exited ${r.status}: ${String(r.stderr || "").trim().slice(0, 300)}`);
  return r.stdout.toString("utf8").split("\0").filter(Boolean);
}

function chunks(items, maxChars) {
  const out = []; let cur = [], len = 0;
  for (const it of items) {
    if (cur.length && len + it.length + 1 > maxChars) { out.push(cur); cur = []; len = 0; }
    cur.push(it); len += it.length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function readWithRetry(abs) {
  let last;
  for (let i = 0; i < 4; i++) {
    try { return fs.readFileSync(abs); } catch (e) { last = e; if (i < 3) sleepSync(250 * (i + 1)); }
  }
  throw new Error(`cannot read ${abs}: ${last && (last.code || last.message)}`);
}

/**
 * @param {string} root     repo root (git cwd; paths come back relative to it)
 * @param {string[]} patterns  names to look for (git BRE, as the old per-name call passed them)
 * @param {string[]} pathspec  e.g. ["backend", "src", "automation"]
 */
function filesMentioning(root, patterns, pathspec) {
  const uniq = [...new Set(patterns)];
  const out = new Map(uniq.map((p) => [p, []]));
  if (!uniq.length) return out;
  const batch = uniq.filter((p) => SAME_IN_BRE_AND_ERE.test(p));
  for (const p of uniq.filter((p) => !SAME_IN_BRE_AND_ERE.test(p)))      // exact old behaviour, one call each
    out.set(p, git(root, ["grep", "-l", "-z", "-e", p, "--", ...pathspec]));
  if (!batch.length) return out;

  // 1. union pass
  const union = new Set();
  for (const ch of chunks(batch, MAX_ALT_CHARS))
    for (const f of git(root, ["grep", "-l", "-z", "-E", "-e", ch.join("|"), "--", ...pathspec])) union.add(f);

  // 2. attribution over the union only
  const needles = batch.filter((p) => FIXED.test(p)).map((p) => [p, Buffer.from(p, "latin1")]);
  const dotted = batch.filter((p) => !FIXED.test(p));
  const esc = (s) => s.replace(/[\\^$*+?()[\]{}|\/]/g, "\\$&");
  const loose = dotted.map((p) => [p, new RegExp(p.split(".").map(esc).join("[^\\n]{1,4}"))]);
  const looseHits = new Map(dotted.map((p) => [p, []]));
  for (const f of [...union].sort()) {
    const buf = readWithRetry(path.join(root, f));
    for (const [p, nb] of needles) if (buf.indexOf(nb) >= 0) out.get(p).push(f);
    if (loose.length) { const s = buf.toString("latin1"); for (const [p, re] of loose) if (re.test(s)) looseHits.get(p).push(f); }
  }
  // dotted patterns: git confirms every superset candidate with the original pattern
  for (const p of dotted) {
    const confirmed = [];
    for (const ch of chunks(looseHits.get(p), MAX_PATH_CHARS))
      confirmed.push(...git(root, ["--literal-pathspecs", "grep", "-l", "-z", "-e", p, "--", ...ch]));
    out.set(p, confirmed);
  }
  return out;
}

module.exports = { filesMentioning };
