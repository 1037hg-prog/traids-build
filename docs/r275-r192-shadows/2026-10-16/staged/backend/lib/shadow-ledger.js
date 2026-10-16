"use strict";
/**
 * SHADOW LEDGER — the append-only record a forward SHADOW writes. 2026-10-16 (backlog row 11/27, R275 + R192).
 *
 * A forward shadow records what a registered rule WOULD have done, session by session. It places NO ORDER OF ANY
 * KIND and holds no position: its only output is a JSONL file of its own. This module is the whole writing path,
 * so the properties a shadow's record must have live in one place rather than in each runner:
 *
 *   ONE ROW PER (kind, key)   a row is identified by its kind and its key (a session date, a month, a test id).
 *                             appendRows() drops a row whose key is already in the file, and drops a duplicate
 *                             inside its own batch, so a runner that fires twice in a night adds nothing the
 *                             second time. Re-running is therefore always safe.
 *   APPEND ONLY               nothing here rewrites or deletes a row. A row that was written with a mistake in it
 *                             is corrected by a later row, never by editing the record: the record is evidence.
 *   NEVER A GUESS             a runner that cannot read what it needs writes a gap row ({ gap: true, why }) for
 *                             that session rather than a number it inferred. readRows() throws on a line that is
 *                             not JSON instead of skipping it — a holed record is a fault, not a smaller sample.
 *
 * The JSONL append is fs.appendFileSync, as every other row file in this tree uses (r186-month-end.jsonl,
 * agent-ledger.jsonl): an append of one short line is the one write that cannot leave a half-file behind the way
 * a rewrite can. The JSON summary a runner writes beside its JSONL goes through lib/atomic-write.js, as the house
 * rule requires for JSON.
 *
 * Pure except for readRows/appendRows: no network, no clock of its own (a caller passes the time it is using),
 * no broker, nothing that could place an order.
 */
const fs = require("fs"), path = require("path");

const isYmd = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
const isYm = (m) => typeof m === "string" && /^\d{4}-\d{2}$/.test(m);

/** ET parts of a timestamp — the session clock every runner here uses. */
function etParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const hh = +p.hour % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, hh, mm: +p.minute, hm: hh * 60 + +p.minute, time: `${String(hh).padStart(2, "0")}:${p.minute}` };
}
const etDate = (ms) => etParts(ms).date;

/** the record as it stands. ENOENT is an empty record; a line that is not JSON throws (a holed record is a fault). */
function readRows(file) {
  let txt;
  try { txt = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const rows = [], lines = txt.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { throw new Error(`${file}:${i + 1} is not JSON — a shadow never rewrites its own record; repair the line by hand before the next run`); }
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${file}:${i + 1} is not a row object`);
    rows.push(o);
  }
  return rows;
}

const rowKey = (r) => `${r.kind}|${r.key}`;
/** the (kind, key) pairs already in a row list */
const keysOf = (rows) => new Set((rows || []).filter((r) => r && r.kind != null && r.key != null).map(rowKey));

/**
 * appendRows(file, rows, { now, have }) -> { appended: [...], skipped: [...] }
 * Every row needs a string kind and key; ts is stamped from `now` when the row does not carry one.
 * A row whose key is already in the file — or earlier in this same batch — is skipped, not written twice.
 */
function appendRows(file, rows, { now = Date.now(), have = null } = {}) {
  const list = (rows || []).filter(Boolean);
  for (const r of list) {
    if (typeof r.kind !== "string" || !r.kind) throw new Error(`a shadow row needs a string kind (got ${JSON.stringify(r.kind)})`);
    if (typeof r.key !== "string" || !r.key) throw new Error(`a shadow row needs a string key (got ${JSON.stringify(r.key)})`);
  }
  const seen = have instanceof Set ? new Set(have) : keysOf(readRows(file));
  const appended = [], skipped = [];
  for (const r of list) {
    const k = rowKey(r);
    if (seen.has(k)) { skipped.push(r); continue; }
    seen.add(k);
    appended.push({ ts: new Date(now).toISOString(), ...r });
  }
  if (appended.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, appended.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return { appended, skipped };
}

/** the first row of a record: what rule is being shadowed, from which text, and the session the forward evidence starts on. */
function startRow({ test, evidenceStart, ruleSource, ruleSha, spec, note }) {
  if (!isYmd(evidenceStart)) throw new Error(`startRow: evidenceStart must be YYYY-MM-DD (got ${evidenceStart})`);
  return { kind: "start", key: test, test, spec, evidenceStart, ruleSource, ruleSha, note };
}
/** the start row of a record, or null when the record has not been opened yet */
const startOf = (rows) => (rows || []).find((r) => r && r.kind === "start") || null;

/** sha256 of a file's bytes, or null when it is not there (provenance for the rule text a shadow was built from) */
function shaOf(file) {
  try { return require("crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
}

module.exports = { isYmd, isYm, etParts, etDate, readRows, rowKey, keysOf, appendRows, startRow, startOf, shaOf };
