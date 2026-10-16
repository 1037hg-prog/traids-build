#!/usr/bin/env node
"use strict";
/**
 * SEAT-SDK TRIAL — THE MORNING'S KEY CHECK. READ-ONLY: it reads files and prints file names and counts. It writes nothing, starts
 * nothing, makes no network call, and never prints the key, a part of it, or a line that holds it.
 *
 *   node docs/seat-sdk-trial/2026-10-12/key-check.cjs                        the last night the SDK ledger holds a launch for
 *   node docs/seat-sdk-trial/2026-10-12/key-check.cjs --session YYYY-MM-DD   another night
 *
 * WHY. On the SDK path the launcher holds the API key in its environment, and the seat runs commands with its permissions bypassed.
 * The runner asks the launcher to keep the key out of those commands; this build could not verify that it does. Everything the RUNNER
 * returns or records has the key replaced by its name — but the files a SEAT writes itself (its claim, its output files, the agent
 * ledger, its memo) never pass through the runner, and backend/data is committed every night.
 *
 * WHAT IT DOES. It loads the key exactly as the runner does (run-seat.cjs loadKey: the environment, else backend/.env, that one name)
 * into a COPY of the environment, and counts the occurrences of that exact value in:
 *   1. backend/data/seat-claims.jsonl — the night's rows, and the whole file
 *   2. the SDK ledger, and the wave's own status file, history and log
 *   3. the files the wave's charges tell the seats to write, and the agent ledger (NAMED below)
 *   4. every other file directly in backend/data (not its subfolders) that changed since the night's first SDK launch began
 * A seat can write anywhere in the repo: this covers where the seats are told to write and what changed beside it, not every file.
 *
 * Exit 0 the value is in none of them · 1 FOUND (the file names and counts are printed) · 3 UNKNOWN, the check could not be made:
 * no key to look for, no SDK launch on record for the night, a file that is there and cannot be read. Never a pass by default.
 */
const fs = require("fs"), path = require("path");
const REPO = path.resolve(__dirname, "..", "..", ".."), SDKDIR = path.join(REPO, "automation", "seat-sdk");
const CLAIMS = "backend/data/seat-claims.jsonl";
/** always read: the seats' claims, the SDK path's and the wave's own records, the files the wave's charges name, the agent ledger */
const NAMED = [CLAIMS, "backend/data/seat-sdk-ledger.jsonl", "backend/data/seat-wave-status.json", "backend/data/seat-wave-history.jsonl", "automation/seat-wave.log",
  "backend/data/agent-ledger.jsonl", "backend/data/risk-governor.json", "backend/data/portfolio-manager-plans.jsonl", "backend/data/ht-memo-seal.json", "backend/data/ht-memo-history.jsonl", "backend/data/agent-book.json"];
const SINCE_MARGIN_MS = 60000;   // a file's time may be a little behind the ledger's clock

/** occurrences of `needle` (a Buffer) in a file, read in pieces that overlap by less than one needle -> { hits, bytes } (throws when it cannot be read) */
function countIn(file, needle, chunkBytes = 4 << 20) {
  const fd = fs.openSync(file, "r"), buf = Buffer.alloc(Math.max(chunkBytes, 1));
  let hits = 0, bytes = 0, carry = Buffer.alloc(0);
  try {
    for (let got; (got = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) {
      bytes += got;
      const piece = carry.length ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
      for (let i = piece.indexOf(needle); i >= 0; i = piece.indexOf(needle, i + 1)) hits++;
      carry = Buffer.from(piece.subarray(Math.max(0, piece.length - (needle.length - 1))));   // shorter than a needle: nothing is counted twice
    }
  } finally { fs.closeSync(fd); }
  return { hits, bytes };
}
/** the files directly in backend/data changed at or after `sinceMs` -> { files: [rel], problem } (their names only: nothing is read here) */
function changedSince(root, sinceMs) {
  const dir = path.join(root, "backend", "data"), files = [];
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return { files, problem: `backend/data cannot be listed (${(e && e.code) || "error"})` }; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    let st; try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }   // gone between the listing and the look
    if (st.mtimeMs >= sinceMs) files.push("backend/data/" + e.name);
  }
  return { files: files.sort(), problem: null };
}

/**
 * The whole check. -> { verdict: "PASS" | "FAIL" | "UNKNOWN", code: 0 | 1 | 3, lines, session, keyLength, read: [{ rel, bytes, hits }], found: [{ rel, hits }], unknown: [why] }
 * root: the tree to read · env: where a key may already be (never changed: a copy is used) · session: the night (default: the last one
 * the ledger holds a launch for) · sinceMs: from when a file of backend/data counts as changed (default: that night's first launch)
 */
function scan({ root = REPO, env = process.env, session = null, sinceMs = null } = {}) {
  const RUN = require(path.join(SDKDIR, "run-seat.cjs")), LEDGER = require(path.join(SDKDIR, "ledger.cjs"));
  const lines = [], read = [], found = [], unknown = [];
  const say = (verdict, name, detail) => lines.push(`${verdict.padEnd(7)} ${name}${detail ? " — " + detail : ""}`);
  const done = (verdict, last) => { lines.push(last); return { verdict, code: verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 3, lines, session, keyLength, read, found, unknown }; };
  let keyLength = null;
  // 1. the key, as the runner loads it — into a copy; only its length is ever said
  const copy = { ...env }, k = RUN.loadKey(root, copy);
  if (!k.ok) { unknown.push("no key"); say("UNKNOWN", "the key to look for", `none could be loaded, so nothing can be looked for (${String(k.reason).replace(/\s+/g, " ").slice(0, 160)})`); return done("UNKNOWN", "KEY CHECK: UNKNOWN — no key to look for; nothing was read."); }
  const value = String(copy[RUN.KEY_NAME]), needle = Buffer.from(value, "utf8"); keyLength = k.length;
  const safe = (s) => String(s).split(value).join(`<${RUN.KEY_NAME}>`);   // a file NAME is printed: never the value inside one
  say("INFO", "the key to look for", `loaded as the runner loads it (${k.source}), length ${k.length}; its value is never printed`);
  // 2. the night: the last session the ledger holds a launch for, and when its first launch began
  const led = LEDGER.read(root), starts = led.state === "ok" ? led.rows.filter((r) => r.kind === "start") : [];
  if (session == null && starts.length) session = starts.map((r) => r.session).sort().pop();
  const ofNight = starts.filter((r) => r.session === session), firstAt = Math.min(...ofNight.map((r) => Date.parse(r.at)).filter(Number.isFinite));
  if (led.state !== "ok" || !ofNight.length) {
    unknown.push("no SDK launch on record");
    say("UNKNOWN", "the SDK night to check", led.state === "absent" ? "backend/data/seat-sdk-ledger.jsonl is not there: no SDK launch is on record" : led.state === "unreadable" ? `the SDK ledger cannot be read (${led.why})` : session == null ? "the SDK ledger holds no launch" : `the SDK ledger holds no launch for session ${safe(session)}`);
  } else say("INFO", "the SDK night to check", safe(`session ${session}: ${ofNight.length} launch(es) by ${[...new Set(ofNight.map((r) => r.seat))].join(", ")}; the first began ${Number.isFinite(firstAt) ? new Date(firstAt).toISOString() : "at a time that cannot be read"}`));
  const since = sinceMs != null ? sinceMs : Number.isFinite(firstAt) ? firstAt - SINCE_MARGIN_MS : null;
  // 3. the named files, then what else changed in backend/data since the night began
  const list = [...NAMED];
  if (since == null) { if (ofNight.length) { unknown.push("no start time"); say("UNKNOWN", "the other files of backend/data", "the night's first launch has no time that can be read, so what changed since cannot be told"); } }
  else { const c = changedSince(root, since); if (c.problem) { unknown.push(c.problem); say("UNKNOWN", "the other files of backend/data", c.problem); } for (const f of c.files) if (!list.includes(f)) list.push(f); }
  for (const rel of list) {
    const file = path.join(root, ...rel.split("/")), nameHit = rel.includes(value);
    let c; try { c = countIn(file, needle); }
    catch (e) { if (e && e.code === "ENOENT") { if (NAMED.includes(rel)) say("INFO", safe(rel), "not there"); continue; } unknown.push(safe(rel)); say("UNKNOWN", safe(rel), `it is there and cannot be read (${(e && e.code) || "error"})`); continue; }
    read.push({ rel: safe(rel), bytes: c.bytes, hits: c.hits + (nameHit ? 1 : 0) });
    let detail = `${c.bytes} bytes`;
    if (rel === CLAIMS && session != null) {
      let rows = 0, hold = 0;
      for (const l of fs.readFileSync(file, "utf8").split(/\r?\n/)) { if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch { continue; } if (r && r.session === session) { rows++; if (l.includes(value)) hold++; } }
      detail = `${rows} row(s) of session ${safe(session)}, ${hold} of them hold the value; ${detail}`;
    }
    if (c.hits || nameHit) { found.push({ rel: safe(rel), hits: c.hits + (nameHit ? 1 : 0) }); say("FAIL", safe(rel), `THE KEY'S VALUE IS IN IT ${c.hits} time(s)${nameHit ? ", and in its name" : ""}; ${detail}`); }
    else say("PASS", safe(rel), `the value is not in it; ${detail}`);
  }
  if (found.length) return done("FAIL", `KEY CHECK: FOUND — the key's value is in ${found.length} of the ${read.length} file(s) read (${found.map((f) => `${f.rel} x${f.hits}`).join(", ")}). Go back with: node automation/seat-sdk/set-provider.cjs cli — and give these lines to the main session.`);
  if (unknown.length) return done("UNKNOWN", `KEY CHECK: UNKNOWN — the value is in none of the ${read.length} file(s) read, but the check is not whole (${unknown.length} line(s) above read UNKNOWN).`);
  return done("PASS", `KEY CHECK: the key's value (length ${keyLength}) is in none of the ${read.length} file(s) read for session ${safe(session)}.`);
}

module.exports = { scan, countIn, changedSince, NAMED, CLAIMS, SINCE_MARGIN_MS };

if (require.main === module) {
  const a = process.argv.slice(2), val = (k) => { const i = a.indexOf(k); return i >= 0 && i + 1 < a.length ? a[i + 1] : null; };
  const known = a.every((x, i) => x === "--session" || x === "--root" || (i > 0 && (a[i - 1] === "--session" || a[i - 1] === "--root")));
  if (!known || (a.includes("--session") && !/^\d{4}-\d{2}-\d{2}$/.test(String(val("--session"))))) { console.log("usage: node docs/seat-sdk-trial/2026-10-12/key-check.cjs [--session YYYY-MM-DD]\nRead-only. Nothing was done."); process.exit(2); }
  let r;
  try { r = scan({ root: val("--root") ? path.resolve(val("--root")) : REPO, session: val("--session") }); }
  catch (e) { console.log(`UNKNOWN the check itself could not be made (${String((e && e.code) || (e && e.name) || "error").slice(0, 60)})\nKEY CHECK: UNKNOWN — it did not finish.`); process.exit(3); }
  console.log("KEY CHECK — seat-SDK trial — read-only; file names and counts only");
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
