"use strict";
/**
 * ATOMIC JSON WRITE — the external review's #1 finding, adopted 2026-08-20.
 *
 * Every canonical store was written with a bare writeFileSync: a crash, kill, or disk-full
 * mid-write leaves trade_log.json half-serialized IN PLACE — the one corruption class that
 * backups mitigate but nothing prevented. This helper closes it:
 *
 *   1. serialize + parse-validate BEFORE touching disk (a non-round-trippable object never
 *      replaces a good file)
 *   2. write to <file>.tmp-<pid> in the same directory
 *   3. fsync the temp file
 *   4. atomically rename over the target (same-volume rename is atomic on NTFS and POSIX)
 *
 * Crash before the rename: the old file is intact, a stray .tmp remains (harmless, ignored
 * by every reader). Crash after: the new file is complete. There is no in-between state.
 *
 * Deliberately NOT adopted from the same review: hash-chained records (the integrity audit
 * re-derives every number from raw fields nightly, which catches tampering AND arithmetic
 * drift), and a SQLite migration (churn risk to a working instrument exceeds the marginal
 * benefit once writes are atomic and backups are nightly).
 */
const fs = require("fs"), path = require("path");

function writeJsonAtomic(file, obj, { pretty = 1 } = {}) {
  const json = JSON.stringify(obj, null, pretty);
  JSON.parse(json);                                        // round-trip gate — throws before disk is touched
  const tmp = path.join(path.dirname(file), path.basename(file) + ".tmp-" + process.pid);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * writeTextAtomic — same temp+fsync+rename path for non-JSON text (JSONL row files). 2026-09-04: bare writeFileSync on a file
 * written seconds earlier fails intermittently on this machine with UNKNOWN (-4094) — a scanner holds the just-written file open;
 * truncating in place fails, renaming over it does not.
 */
function writeTextAtomic(file, text) {
  const tmp = path.join(path.dirname(file), path.basename(file) + ".tmp-" + process.pid);
  const fd = fs.openSync(tmp, "w");
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (e) { fs.unlinkSync(file); fs.renameSync(tmp, file); }
}

module.exports = { writeJsonAtomic, writeTextAtomic };
