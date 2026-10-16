"use strict";
/**
 * SEAL MERGE — 2026-10-01 audit (registry lens, finding registry#1).
 *
 * THE DEFECT. Every seal writer read data/read-seals.json and data/test-registry.json at START-UP and wrote its whole copy back
 * at the END. On 2026-09-25 r230-crypto-vote-sized.js loaded both files at ~04:30:40Z, spent a minute fetching candles, and wrote
 * them back at 04:31:44Z — erasing the five DID NOT PASS seals and READ statuses r220-r224-mine7.js had written at 04:31:16Z.
 * writeJsonAtomic stops TORN files; it does not stop LOST UPDATES. "A seal is never removed by code" was false.
 *
 * THE FIX. Writers hand this module the ONE change they mean to make. Under a lock file it re-reads the CURRENT file, applies only
 * that change, verifies no other seal disappeared or changed, and writes atomically. The read-modify-write window shrinks from a
 * minute to milliseconds, and between helper users it is closed outright. Writers that still do the old read-early/write-late
 * (most r*.js scripts) are NOT protected by the lock — they should be routed through here as they are touched.
 *
 *   sealOnce(id, seal)              add one seal; refuses (returns {sealed:false, existing}) if the key already exists
 *   mergeSeals(mutate, {allowEdit}) mutate(tests, state) on a FRESH copy; throws if any pre-existing seal vanished, or changed
 *                                   without its id in allowEdit
 *   patchRegistryEntry(id, patch)   Object.assign(entry, patch) on a FRESH registry; only that one entry changes
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./atomic-write");
const DATA = path.join(__dirname, "..", "data");
const SEALS = path.join(DATA, "read-seals.json"), REGISTRY = path.join(DATA, "test-registry.json");
const LOCK = path.join(DATA, ".seal-write.lock");
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withLock(fn, { waitMs = 20000, staleMs = 120000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    try { const fd = fs.openSync(LOCK, "wx"); fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), script: process.argv[1] || null })); fs.closeSync(fd); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = 0; try { age = Date.now() - fs.statSync(LOCK).mtimeMs; } catch { continue; }   // released between the open and the stat
      if (age > staleMs) { try { fs.unlinkSync(LOCK); } catch {} continue; }                     // a crashed holder never blocks forever
      if (Date.now() - t0 > waitMs) throw new Error(`seal-merge: ${path.basename(LOCK)} held ${Math.round(age / 1000)}s by another writer — refusing to write without it`);
      sleepSync(100);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(LOCK); } catch {} }
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));   // throws — never merge into a file that could not be read
const indentOf = (f) => { try { const m = /\n( +)"/.exec(fs.readFileSync(f, "utf8").slice(0, 400)); return m ? m[1].length : 1; } catch { return 1; } };

function mergeSeals(mutate, { file = SEALS, allowEdit = [] } = {}) {
  return withLock(() => {
    const s = readJson(file), T = s.tests || s;
    const before = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, JSON.stringify(v)]));
    const r = mutate(T, s);
    const lost = Object.keys(before).filter((k) => !(k in T));
    if (lost.length) throw new Error(`seal-merge: refusing — the change would REMOVE seal(s) ${lost.join(", ")}`);
    const edited = Object.keys(before).filter((k) => JSON.stringify(T[k]) !== before[k] && !allowEdit.includes(k));
    if (edited.length) throw new Error(`seal-merge: refusing — the change would EDIT existing seal(s) ${edited.join(", ")} (pass allowEdit to annotate on purpose)`);
    writeJsonAtomic(file, s, { pretty: indentOf(file) });
    return r;
  });
}

function sealOnce(id, seal, opts = {}) {
  let existing = null;
  mergeSeals((T) => { if (T[id]) { existing = T[id]; return; } T[id] = seal; }, opts);
  return existing ? { sealed: false, existing } : { sealed: true };
}

function patchRegistryEntry(id, patch, { file = REGISTRY } = {}) {
  return withLock(() => {
    const reg = readJson(file), e = (reg.preregistered || []).find((t) => t.id === id);
    if (!e) throw new Error(`seal-merge: ${id} is not in ${path.basename(file)}`);
    const n = (reg.preregistered || []).length;
    Object.assign(e, typeof patch === "function" ? patch(e) : patch);
    if ((reg.preregistered || []).length !== n) throw new Error("seal-merge: refusing — the patch changed the number of registry entries");
    reg.asOf = new Date().toISOString();
    writeJsonAtomic(file, reg, { pretty: indentOf(file) });
    return e;
  });
}

/** The verdict a seal DISPLAYS. A dated `correction` (never a rewrite of the sealed text) wins; the sealed text stays on the record beside it. */
function shownVerdict(s) {
  if (!s) return "";
  if (s.correction && s.correction.verdict) return `${s.correction.verdict} [dated correction ${s.correction.date}; the ${s.sealedOn} seal's own text, kept on record: "${String(s.verdict || "").slice(0, 48)}…"]`;
  return String(s.verdict || "");
}

module.exports = { withLock, mergeSeals, sealOnce, patchRegistryEntry, shownVerdict, LOCK, SEALS, REGISTRY };
