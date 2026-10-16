"use strict";
/**
 * ATOMIC JSON WRITES — 2026-08-06.
 *
 * `fs.writeFileSync(path, data)` TRUNCATES the target to zero bytes and then writes. If the
 * process dies in between — crash, Ctrl+C, power loss, a scheduled task killed mid-run — the
 * file is left empty or half-written and the original is already gone.
 *
 * 108 files in this repo call it directly, several of them on APPEND-ONLY LEDGERS: trade_log,
 * the test registry, marks-forward. Losing one of those is not losing a day's work, it is
 * losing the entire evidence base the funding decision rests on. A backup does not close the
 * hole either — a truncated write that happens before the nightly backup gets backed up
 * truncated.
 *
 * The fix is one extra step. `rename` is atomic at the filesystem level: a reader sees either
 * the whole old file or the whole new one, never a hybrid.
 *
 *     writeJsonAtomic(path, obj)   // temp file -> fsync -> rename
 *
 * ALSO GUARDS THE ENCODING TRAP. Every write is UTF-8 with no BOM, and the result is read back
 * and re-parsed before the rename is allowed to land. On 2026-08-05 a PowerShell edit mojibaked
 * the entire test registry and the adjudicator then resolved zero tests while reporting success,
 * so "it parses and round-trips" is checked here rather than assumed.
 */
const fs = require("fs"), path = require("path");

/**
 * @param {string} file   destination path
 * @param {any}    data   object to serialise, or a pre-serialised string
 * @param {object} [opts] { spaces = 1, minBytes = 2 }
 */
function writeJsonAtomic(file, data, opts = {}) {
  const { spaces = 1, minBytes = 2 } = opts;
  const body = typeof data === "string" ? data : JSON.stringify(data, null, spaces);

  // A zero-length or absurdly small payload is almost always a bug upstream (an empty array
  // where a ledger should be). Refuse rather than atomically replacing good data with nothing.
  if (body.length < minBytes) {
    throw new Error(`writeJsonAtomic refused: payload is ${body.length} bytes for ${path.basename(file)} — refusing to replace a file with nothing`);
  }
  // Must be valid JSON before it goes anywhere near the destination.
  try { JSON.parse(body); } catch (e) {
    throw new Error(`writeJsonAtomic refused: payload is not valid JSON (${e.message})`);
  }
  if (body.charCodeAt(0) === 0xfeff) {
    throw new Error("writeJsonAtomic refused: payload starts with a BOM");
  }

  const tmp = file + ".tmp-" + process.pid;
  let fd;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, body, 0, "utf8");
    fs.fsyncSync(fd);            // force to disk before the swap, or the rename can beat the data
    fs.closeSync(fd); fd = null;

    // read back and re-parse: proves the bytes on disk are what we meant
    const back = fs.readFileSync(tmp, "utf8");
    JSON.parse(back);
    if (back.length !== body.length) throw new Error(`short write: ${back.length} of ${body.length} bytes`);

    fs.renameSync(tmp, file);    // atomic swap
  } catch (e) {
    if (fd != null) { try { fs.closeSync(fd); } catch { } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { }
    throw new Error(`writeJsonAtomic failed for ${path.basename(file)}: ${e.message}`);
  }
  return body.length;
}

/** Read JSON tolerantly of a BOM, returning a fallback rather than throwing. */
function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return fallback; }
}

module.exports = { writeJsonAtomic, readJsonSafe };
