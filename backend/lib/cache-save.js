"use strict";
/**
 * SAVE A SHARED JSON CACHE — atomic, retried on a sharing violation, merged per key (2026-10-05, BK7).
 *
 * WHY. ats-cache-warm.js died on 2026-10-02 at its first checkpoint: a bare fs.writeFileSync on
 * data/ats-cache.json — a file the running :3001 server also rewrites whole, and that scanners hold
 * open for a moment after each write — threw UNKNOWN (-4094) on open; uncaught, it ended the run and
 * lost every name fetched since the last good write. The same failure class is documented on
 * lib/atomic-write.js writeTextAtomic (2026-09-04).
 *
 * WHAT.
 *   1. writeJsonAtomic (temp + fsync + rename): no reader ever sees a half-written file and nothing
 *      truncates the live file in place. `pretty` passes through (0 = compact, the warm cache's format).
 *   2. EBUSY / EPERM / EACCES / UNKNOWN (how -4094 surfaces) are retried with exponential backoff
 *      (baseMs, 2x, 4x, ...). Any other error is not a sharing violation and is thrown at once.
 *   3. Before every attempt the file on disk is re-read and merged PER KEY: an entry whose numeric `at`
 *      is newer on disk than in memory is kept, and keys only on disk are kept — so a concurrent writer's
 *      fresher entries are not overwritten by this process's older snapshot. Keys this process holds
 *      with an equal or newer `at` win. The merged object is returned. An on-disk copy that is locked or
 *      half-written is retried too (EPARTIAL); only the last attempt overwrites an unreadable copy.
 *   4. After the last failed attempt the temp file is removed and the error is THROWN, carrying the
 *      code — the caller decides whether that is fatal (a final save) or survivable (a checkpoint).
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./atomic-write.js");

const RETRY_CODES = new Set(["EBUSY", "EPERM", "EACCES", "UNKNOWN"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * The on-disk copy to merge with. A copy that exists but cannot be read or parsed right now (locked, or
 * caught mid-write by the server's in-place writeFileSync) is a RETRY — writing without it would drop the
 * other writer's entries. On the LAST attempt an unreadable copy is overwritten (said so in the log): the
 * old warm did exactly that with a corrupt cache, and a permanently corrupt file must not block every save.
 */
function readForMerge(file, lastTry, log, label) {
  if (!fs.existsSync(file)) return {};
  try { const v = JSON.parse(fs.readFileSync(file, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
  catch (e) {
    if (lastTry) { log(`  ${label}: on-disk copy unreadable (${e.code || "parse error"}) — written WITHOUT merge`); return {}; }
    const err = new Error(`on-disk copy unreadable (${e.code || "parse error"})`); err.code = RETRY_CODES.has(e.code) ? e.code : "EPARTIAL"; throw err;
  }
}

function mergeNewerByAt(onDisk, mine) {
  const out = { ...(mine || {}) };
  for (const [k, d] of Object.entries(onDisk && typeof onDisk === "object" ? onDisk : {})) {
    const m = out[k];
    if (!(k in out)) { out[k] = d; continue; }
    const dAt = d && Number.isFinite(d.at) ? d.at : null, mAt = m && Number.isFinite(m.at) ? m.at : null;
    if (dAt !== null && (mAt === null || dAt > mAt)) out[k] = d;
  }
  return out;
}

async function saveMergedJson(file, obj, { tries = 6, baseMs = 250, pretty = 0, label = "save", log = console.log } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const merged = mergeNewerByAt(readForMerge(file, i === tries - 1, log, label), obj);
      writeJsonAtomic(file, merged, { pretty });
      if (i > 0) log(`  ${label}: written on attempt ${i + 1} (after ${last && last.code})`);
      return merged;
    } catch (e) {
      last = e;
      if (!(RETRY_CODES.has(e && e.code) || (e && e.code === "EPARTIAL")) || i === tries - 1) break;
      await sleep(baseMs * 2 ** i);
    }
  }
  try { fs.unlinkSync(path.join(path.dirname(file), path.basename(file) + ".tmp-" + process.pid)); } catch {}   // the name atomic-write.js uses
  const err = new Error(`${label}: could not write ${file} — ${last && (last.code || last.message)}`);
  err.code = last && last.code;
  throw err;
}

module.exports = { saveMergedJson, mergeNewerByAt, RETRY_CODES };
