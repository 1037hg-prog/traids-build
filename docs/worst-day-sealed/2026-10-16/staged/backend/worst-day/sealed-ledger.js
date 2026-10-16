"use strict";
/**
 * WORST-DAY SEALED LEDGER — the append-only record of tomorrow's forecast, written BEFORE the open.
 *
 * WHAT A ROW IS. One line of JSON per forecast session. It states, in advance and in public, the probability that the NEXT session is a
 * worst-5% day and the storm state that goes with it. Its honesty rests on three things and nothing else:
 *
 *   1. THE SEAL.   createdAt is the instant the row was written. A row is sealed only when createdAt is strictly before 09:30 ET of
 *                  forDate — the open of the session it forecasts. sealed-check.js refuses the whole ledger when any row fails this,
 *                  and appendRow() below refuses to write such a row in the first place. 09:30 ET is a WALL CLOCK: SEAL_ET_HH/MM are
 *                  turned into an instant through America/New_York, so the deadline moves with daylight saving by itself.
 *   2. THE CHAIN.  Every row carries prevHash, the sha256 of the row before it (the first row carries GENESIS, 64 zeros), and hash,
 *                  the sha256 of its own body INCLUDING prevHash. Change one byte of one old row and every hash after it stops
 *                  matching. The chain proves ORDER and CONTENT; it cannot by itself prove that rows were not DELETED FROM THE END,
 *                  which is what the tip file is for.
 *   3. THE TIP.    A small JSON file beside the ledger holding the seq and hash of the last row written. A truncated ledger no longer
 *                  matches its tip. A hand that edits both is not caught by this: the tip is a second thing to forge, not a proof.
 *                  The honest statement is that the ledger is tamper-EVIDENT, not tamper-proof. Nothing here is a signature.
 *
 * THE LINE'S BYTES. Each line is canonicalJson(row): object keys sorted, no spaces. The body that is hashed is the row without `hash`,
 * serialised the same way, so re-hashing a line read back from disk needs no guessing about key order or whitespace.
 *
 * The row is a FORECAST and never a result: nothing here reads a price of forDate, and nothing here is graded. sealed-grade.js does the
 * grading, later, from the same rows.
 *
 * Read-only on the repo except the two files it is handed. No network. No orders.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic } = require("../lib/atomic-write.js");

const SPEC = "worst-day-sealed-v1";
const GENESIS = "0".repeat(64);
const SEAL_ET_HH = 9, SEAL_ET_MM = 30;                       // 09:30 ET, the open of the session a row forecasts
const ET_ZONE = "America/New_York";
const STORM_STATES = ["calm", "watch", "storm"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
/** the row's keys, in full: a row with any other key, or without one of these, is refused — nothing may hide outside the hash */
const BODY_KEYS = ["asOfAdj", "asOfDate", "createdAt", "flagModel", "flagRule", "forDate", "model", "p", "prevHash", "score", "seq", "spec", "storm", "stormThr", "thr"];
const MODEL_KEYS = ["features", "id", "lambda", "minHistory", "nBars", "nTrain", "tail", "win"];

// ── the ET wall clock ────────────────────────────────────────────────────────────────────────────────────────────────
const ET_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: ET_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
/** the ET wall-clock reading of an instant */
function etParts(ms) {
  const p = Object.create(null);
  for (const x of ET_FMT.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hh: +p.hour, mm: +p.minute, ss: +p.second };
}
/** ms to ADD to an instant to get the UTC instant whose UTC reading equals that instant's ET reading (i.e. -offset) */
function etShift(ms) { const q = etParts(ms), [y, m, d] = q.day.split("-").map(Number); return Date.UTC(y, m - 1, d, q.hh, q.mm, q.ss) - Math.floor(ms / 1000) * 1000; }
/** the instant at which the ET wall clock reads `day hh:mm:00`. Two passes settle the daylight-saving step (09:30 is never in the gap). */
function etWallMs(day, hh, mm) {
  if (!validDate(day)) throw new Error(`etWallMs: ${day} is not a date`);
  const [y, m, d] = day.split("-").map(Number), wall = Date.UTC(y, m - 1, d, hh, mm, 0);
  let ms = wall - etShift(wall);
  ms = wall - etShift(ms);
  return ms;
}
/** the instant the seal closes for a row that forecasts `forDate`: 09:30 ET of that day */
const sealDeadlineMs = (forDate) => etWallMs(forDate, SEAL_ET_HH, SEAL_ET_MM);
/** the ET calendar day of an instant */
const etDay = (ms) => etParts(ms).day;

// ── small helpers ────────────────────────────────────────────────────────────────────────────────────────────────────
function validDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number), dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const isWeekendDay = (s) => { const g = new Date(s + "T12:00:00Z").getUTCDay(); return g === 0 || g === 6; };
/** sorted-key, no-space JSON. Throws on anything that would not survive a round trip (undefined, NaN, Infinity, a function). */
function canonicalJson(v) {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "number") { if (!Number.isFinite(v)) throw new Error(`canonicalJson: ${String(v)} is not a finite number`); return JSON.stringify(v); }
  if (t === "string" || t === "boolean") return JSON.stringify(v);
  if (t !== "object") throw new Error(`canonicalJson: a ${t} cannot be written`);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
/** the hash of a row BODY (the row without `hash`); prevHash is inside it, which is what chains the rows */
function hashBody(body) {
  const b = Object.create(null);
  for (const k of BODY_KEYS) b[k] = body[k];
  return sha256(canonicalJson(b));
}
const bodyOf = (row) => { const b = Object.create(null); for (const k of BODY_KEYS) b[k] = row[k]; return b; };
const tipPathFor = (ledgerFile) => ledgerFile.replace(/\.jsonl$/, "") + ".tip.json";
/**
 * The default appender. A row is appended, never rewritten: the file is opened for append, the line is written, and the file is
 * FSYNCED before the handle is closed, so a row that this call returns from is on the disk. backend/lib/atomic-write.js's
 * writeJsonAtomic is not the writer here and must not be: it replaces a whole file through a rename, which is the right thing for a
 * canonical store and the wrong thing for an append-only one — a crash mid-rename would swap the whole ledger for a partial copy.
 * The tip file beside it IS written with writeJsonAtomic, because it is a whole-file store.
 */
function appendLine(file, line) {
  const fd = fs.openSync(file, "a");
  try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// ── the row's own shape ──────────────────────────────────────────────────────────────────────────────────────────────
/** shape only: what a row must look like on its own, before anything about its neighbours. Returns a list of problems. */
function rowProblems(row, { withHash = true } = {}) {
  const bad = [];
  if (!row || typeof row !== "object" || Array.isArray(row)) return ["the row is not an object"];
  const want = withHash ? [...BODY_KEYS, "hash"].sort() : [...BODY_KEYS].sort(), got = Object.keys(row).sort();
  for (const k of want) if (!got.includes(k)) bad.push(`the key ${k} is missing`);
  for (const k of got) if (!want.includes(k)) bad.push(`the key ${k} is not part of a row (nothing may sit outside the hash)`);
  if (bad.length) return bad;
  const num = (k, lo, hi) => { const v = row[k]; if (!Number.isFinite(v)) bad.push(`${k} is not a finite number`); else if (v < lo || v > hi) bad.push(`${k} is ${v}, outside [${lo}, ${hi}]`); };
  if (row.spec !== SPEC) bad.push(`spec is ${JSON.stringify(row.spec)}, not ${JSON.stringify(SPEC)}`);
  if (!Number.isInteger(row.seq) || row.seq < 1) bad.push(`seq is ${JSON.stringify(row.seq)}, not a whole number from 1`);
  if (!validDate(row.forDate)) bad.push(`forDate is ${JSON.stringify(row.forDate)}, not a date`);
  if (!validDate(row.asOfDate)) bad.push(`asOfDate is ${JSON.stringify(row.asOfDate)}, not a date`);
  if (validDate(row.forDate) && validDate(row.asOfDate) && !(row.asOfDate < row.forDate)) bad.push(`asOfDate ${row.asOfDate} is not before forDate ${row.forDate}`);
  if (typeof row.createdAt !== "string" || !ISO_RE.test(row.createdAt) || new Date(row.createdAt).toISOString() !== row.createdAt) bad.push(`createdAt is ${JSON.stringify(row.createdAt)}, not an ISO instant in Z with milliseconds`);
  num("p", 0, 1); num("score", -1e9, 1e9); num("stormThr", -1e9, 1e9); num("thr", -1, 1); num("asOfAdj", 0, 1e9);
  if (row.flagModel !== 0 && row.flagModel !== 1) bad.push(`flagModel is ${JSON.stringify(row.flagModel)}, not 0 or 1`);
  if (row.flagRule !== 0 && row.flagRule !== 1) bad.push(`flagRule is ${JSON.stringify(row.flagRule)}, not 0 or 1`);
  if (!STORM_STATES.includes(row.storm)) bad.push(`storm is ${JSON.stringify(row.storm)}, not one of ${STORM_STATES.join(" / ")}`);
  if (row.storm !== stormStateOf(row.flagModel, row.flagRule)) bad.push(`storm is ${JSON.stringify(row.storm)} but the two flags (${row.flagModel}/${row.flagRule}) say ${JSON.stringify(stormStateOf(row.flagModel, row.flagRule))}`);
  if (typeof row.prevHash !== "string" || !HEX64_RE.test(row.prevHash)) bad.push("prevHash is not 64 lower-case hex characters");
  if (withHash && (typeof row.hash !== "string" || !HEX64_RE.test(row.hash))) bad.push("hash is not 64 lower-case hex characters");
  const m = row.model;
  if (!m || typeof m !== "object" || Array.isArray(m)) bad.push("model is not an object");
  else {
    const mw = [...MODEL_KEYS], mg = Object.keys(m).sort();
    for (const k of mw) if (!mg.includes(k)) bad.push(`model.${k} is missing`);
    for (const k of mg) if (!mw.includes(k)) bad.push(`model.${k} is not part of a row`);
    if (typeof m.id !== "string" || !m.id) bad.push("model.id is not a name");
    if (!Array.isArray(m.features) || !m.features.length || m.features.some((f) => typeof f !== "string")) bad.push("model.features is not a list of names");
    for (const k of ["win", "minHistory", "nTrain", "nBars"]) if (!Number.isInteger(m[k]) || m[k] < 0) bad.push(`model.${k} is not a whole number from 0`);
    for (const k of ["tail", "lambda"]) if (!Number.isFinite(m[k])) bad.push(`model.${k} is not a finite number`);
  }
  return bad;
}
/** the storm state the two flags state. Fixed here, used by the forecaster and checked on every row. */
const stormStateOf = (flagModel, flagRule) => (flagModel && flagRule ? "storm" : flagModel || flagRule ? "watch" : "calm");

// ── reading ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** the ledger as it is on disk: every line parsed, nothing judged. A missing file reads as an empty ledger. */
function readLedger(file) {
  let text = null;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return { exists: false, rows: [], lines: [], parseProblems: [] }; throw e; }
  const lines = text.length ? text.split("\n") : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();                 // the trailing newline of the last row
  const rows = [], parseProblems = [];
  lines.forEach((l, i) => {
    let j = null;
    try { j = JSON.parse(l); } catch (e) { parseProblems.push(`line ${i + 1} is not JSON (${e.message})`); rows.push(null); return; }
    if (!j || typeof j !== "object" || Array.isArray(j)) { parseProblems.push(`line ${i + 1} is not a JSON object`); rows.push(null); return; }
    rows.push(j);
  });
  return { exists: true, rows, lines, parseProblems };
}
function readTip(tipFile) {
  try { return JSON.parse(fs.readFileSync(tipFile, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

// ── writing: the only way a row is ever added ────────────────────────────────────────────────────────────────────────
class SealRefusal extends Error { constructor(why) { super(why); this.name = "SealRefusal"; } }

/**
 * Append ONE row. Fail-closed at every step: it refuses rather than write when anything about the ledger, the row or the clock is
 * not right, and it never rewrites, reorders or removes a line.
 *   body       the row's fields EXCEPT seq, createdAt, prevHash and hash, which are filled here
 *   now        the instant of writing (ms). The seal is judged on it.
 *   check      the whole-ledger checker (sealed-check.js check()), injected so this file does not require its own caller
 * Returns { row, line, seq }.
 */
function appendRow(ledgerFile, body, { now = Date.now(), tipFile = tipPathFor(ledgerFile), check = null, append = appendLine, writeJson = writeJsonAtomic } = {}) {
  const refuse = (w) => { throw new SealRefusal(w); };
  if (!body || typeof body !== "object") refuse("no row was handed to appendRow");
  for (const k of ["seq", "createdAt", "prevHash", "hash"]) if (k in body) refuse(`${k} is filled in by appendRow, never by its caller`);
  const L = readLedger(ledgerFile);
  if (L.parseProblems.length) refuse(`the ledger does not read as rows, so nothing is added to it: ${L.parseProblems.slice(0, 3).join("; ")}`);
  const rows = L.rows, last = rows.length ? rows[rows.length - 1] : null;
  if (check) { const v = check({ rows, now, tip: readTip(tipFile) }); if (!v.ok) refuse(`the ledger as it stands does not pass its own check, so nothing is added to it: ${v.failed.map((c) => c.id + " (" + c.detail + ")").join("; ")}`); }
  const row = Object.create(null);
  for (const k of Object.keys(body)) row[k] = body[k];
  row.spec = SPEC;
  row.seq = rows.length + 1;
  row.prevHash = last ? last.hash : GENESIS;
  row.createdAt = new Date(now).toISOString();
  const shape = rowProblems(row, { withHash: false });
  if (shape.length) refuse(`the row is not a row: ${shape.join("; ")}`);
  if (last && !(row.forDate > last.forDate)) refuse(`forDate ${row.forDate} is not after the last row's ${last.forDate} — the ledger only ever moves forward`);
  if (isWeekendDay(row.forDate)) refuse(`forDate ${row.forDate} is a weekend, not a session`);
  const deadline = sealDeadlineMs(row.forDate);
  if (!(now < deadline)) refuse(`THE SEAL IS CLOSED: ${row.createdAt} is at or after 09:30 ET of ${row.forDate} (${new Date(deadline).toISOString()}). A forecast for a session is written before that session opens, or not at all.`);
  row.hash = hashBody(row);
  const line = canonicalJson(row) + "\n";
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  append(ledgerFile, line);
  const back = readLedger(ledgerFile);
  if (back.parseProblems.length || back.rows.length !== rows.length + 1) throw new Error(`the ledger does not read back with the new row (${back.rows.length} rows, ${back.parseProblems.length} parse problems) — look at ${ledgerFile} by hand`);
  const wrote = back.rows[back.rows.length - 1];
  if (wrote.hash !== row.hash || back.lines[back.lines.length - 1] !== line.slice(0, -1)) throw new Error(`the row that was written is not the row that was built (${String(wrote.hash).slice(0, 12)} vs ${row.hash.slice(0, 12)}) — look at ${ledgerFile} by hand`);
  writeJson(tipFile, { spec: SPEC, seq: row.seq, hash: row.hash, forDate: row.forDate, at: row.createdAt });
  return { row, line, seq: row.seq };
}

module.exports = {
  SPEC, GENESIS, SEAL_ET_HH, SEAL_ET_MM, ET_ZONE, STORM_STATES, BODY_KEYS, MODEL_KEYS, DATE_RE, ISO_RE, HEX64_RE,
  etParts, etShift, etWallMs, etDay, sealDeadlineMs, validDate, isWeekendDay, canonicalJson, sha256, hashBody, bodyOf,
  tipPathFor, rowProblems, stormStateOf, readLedger, readTip, appendRow, SealRefusal,
};
