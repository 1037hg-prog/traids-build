"use strict";
/**
 * SCRATCH TREE (insider clusters package, 2026-10-16) — the staged collector and cluster finder, loadable without touching the repo.
 *
 * The staged files sit at docs/.../staged/backend/… and require `./lib/atomic-write.js` and `./lib/run-window.js`, which live in the
 * repo's own backend/lib. So the selftest builds a tree in the OS temp folder that looks like the repo's backend/: the two helpers
 * COPIED from the repo (byte for byte: the staged code must work against the real ones, not against a stub), and the package's own
 * staged files on top. Nothing in the repository is written, and nothing in it is loaded from this tree.
 *
 *   const T = require("./harness/tree.cjs");
 *   const t = T.makeTree();                      // { dir, bk, dataDir, cleanup() }
 *   const collect = require(t.path("backend/insider-buys-collect.js"));
 *
 * `mutate` is for the mutation checks: the same tree with one exact text replacement in one staged file (and a replacement that does
 * not match exactly once THROWS, so a mutant that silently changed nothing can never read as "the check survived it").
 */
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const PKG = path.resolve(__dirname, ".."), REPO = path.resolve(PKG, "..", "..", "..");
const STAGED = path.join(PKG, "staged");
/** the repo helpers the staged code uses, copied in as they really are */
const FROM_REPO = Object.freeze(["backend/lib/atomic-write.js", "backend/lib/run-window.js"]);
/** every file this package stages, at its repo path */
const STAGED_FILES = Object.freeze([
  "backend/lib/sec-fetch.js",
  "backend/lib/form4-parse.js",
  "backend/lib/insider-buys-lib.js",
  "backend/lib/insider-cluster-lib.js",
  "backend/insider-buys-collect.js",
  "backend/insider-clusters.js",
]);
const P = (root, rel) => path.join(root, ...rel.split("/"));

/** one exact text replacement that must match once (a mutant, or a scratch edit) */
function mutate(text, from, to) {
  const n = String(text).split(from).length - 1;
  if (n !== 1) throw new Error(`mutation anchor found ${n} times, not once: ${String(from).slice(0, 90)}`);
  return String(text).replace(from, () => to);
}

/**
 * makeTree({ edits }) -> { dir, bk, dataDir, path(rel), cleanup() }
 * `edits` is { "<staged rel path>": (text) => text } — used by the mutation checks.
 */
function makeTree({ edits = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-tree-"));
  for (const rel of FROM_REPO) {
    const p = P(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.copyFileSync(P(REPO, rel), p);
  }
  for (const rel of STAGED_FILES) {
    const p = P(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let text = fs.readFileSync(P(STAGED, rel), "utf8");
    if (edits[rel]) text = edits[rel](text);
    fs.writeFileSync(p, text);
  }
  const dataDir = P(dir, "backend/data/insider-buys");
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    dir, bk: P(dir, "backend"), dataDir,
    path: (rel) => P(dir, rel),
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a temp folder left behind is not a failure */ } },
  };
}

/** load a tree's module fresh (no require cache from another tree) */
function load(t, rel) {
  const p = t.path(rel);
  delete require.cache[require.resolve(p)];
  return require(p);
}

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

module.exports = { makeTree, load, mutate, sha, PKG, REPO, STAGED, STAGED_FILES, FROM_REPO, P };
