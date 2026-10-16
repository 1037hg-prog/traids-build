#!/usr/bin/env node
"use strict";
/**
 * AI-BUBBLE LADDER MONITOR — the daily reading of the contingency plan's B1 and B2 rungs. READ-ONLY on the market data
 * and on everything else: it reads stored daily closes, computes each rung, prints a plain summary, and — only with
 * --write — puts the day's status into ONE file of its own. It places NO ORDERS of any kind: it makes no broker call,
 * no network call and no HTTP request at all (it holds no client and no URL), it reads no account and no position, and
 * it writes nothing but its own status file. Nothing it prints is an instruction; the operator reads it and decides.
 *
 *   node backend/ai-bubble-ladder-monitor.js                      read-only: compute and print. NOTHING is written.
 *   node backend/ai-bubble-ladder-monitor.js --write              the same, and the day's status is put into
 *                                                                 backend/data/ai-bubble-ladder-status.json under its
 *                                                                 own date key (backend/lib/atomic-write.js
 *                                                                 writeJsonAtomic; every other date is kept as it is,
 *                                                                 so a second run of the same day replaces that day
 *                                                                 and nothing else)
 *   --as-of YYYY-MM-DD   read the stored closes as if that were the last session (the lenses' CUT)
 *   --data <dir>         the store to read (default docs/ai-bubble-2026-10/bust/data, the cache bust/fetch.js writes)
 *   --out <file>         the status file --write writes (default backend/data/ai-bubble-ladder-status.json)
 *   --json               print the status document instead of the summary (still read-only without --write)
 *
 * The rungs and their arithmetic are in backend/ai-bubble-ladder.js, each with the line of docs/ai-bubble-2026-10/ it
 * comes from. ARMED means the rung's rule reads OUT; it is a reading of the data, nothing more.
 *
 * Exit 0 the status was computed (and written, with --write) · 1 a series could not be read, or the write failed
 * (nothing half-written: writeJsonAtomic replaces the file by rename or not at all) · 2 usage.
 */
const path = require("path"), fs = require("fs");
const LAD = require("./ai-bubble-ladder.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");

const REPO = path.resolve(__dirname, "..");
const DEFAULT_DATA = path.join(REPO, "docs", "ai-bubble-2026-10", "bust", "data");
const DEFAULT_OUT = path.join(__dirname, "data", "ai-bubble-ladder-status.json");
const USAGE = [
  "usage: node backend/ai-bubble-ladder-monitor.js [--write] [--as-of YYYY-MM-DD] [--data <dir>] [--out <file>] [--json]",
  "  (no flag)            read-only: compute the ladder's status and print it. Nothing is written.",
  "  --write              also put the day's status into backend/data/ai-bubble-ladder-status.json (that date's key only).",
  "  --as-of YYYY-MM-DD   read the stored closes as if that were the last session.",
  "  --data <dir>         the store of daily closes (default docs/ai-bubble-2026-10/bust/data).",
  "  --out <file>         the status file --write writes.",
  "  --json               print the status document instead of the summary.",
  "No order is ever placed and nothing but the status file is ever written.",
].join("\n");

/** argv -> { write, asOf, data, out, json } or { usage: why } */
function parseArgs(argv) {
  const o = { write: false, asOf: null, data: DEFAULT_DATA, out: DEFAULT_OUT, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") o.write = true;
    else if (a === "--json") o.json = true;
    else if (a === "--as-of") { const v = argv[++i]; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return { usage: `--as-of needs a YYYY-MM-DD date, got ${v === undefined ? "nothing" : v}` }; o.asOf = v; }
    else if (a === "--data") { const v = argv[++i]; if (!v) return { usage: "--data needs a directory" }; o.data = path.resolve(v); }
    else if (a === "--out") { const v = argv[++i]; if (!v) return { usage: "--out needs a file" }; o.out = path.resolve(v); }
    else return { usage: `unknown argument ${a}` };
  }
  return o;
}

/** the status file as it is now, or null when it is not there. A file that does not parse is a problem, not an empty one. */
function readOut(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw new Error(`the status file ${file} cannot be read (${e.code || e.message})`); }
  try { return JSON.parse(text); } catch (e) { throw new Error(`the status file ${file} does not parse (${e.message}) — refusing to replace it`); }
}

/**
 * the whole run on injected dependencies, so the selftest drives it without a process:
 *   { argv, log, now, readOut, write }  ->  { code, status, wrote, lines }
 * `write` is called at most once, with (file, document); the default is writeJsonAtomic.
 */
function run({ argv = [], log = (s) => console.log(s), now = () => new Date().toISOString(),
  readOut: rd = readOut, write = writeJsonAtomic } = {}) {
  const lines = [], say = (s) => { lines.push(s); log(s); };
  const o = parseArgs(argv);
  if (o.usage) { say(`${o.usage}\n${USAGE}`); return { code: 2, status: null, wrote: null, lines }; }

  let store;
  try { store = LAD.readStore(o.data, o.asOf); }
  catch (e) {
    say(`CANNOT READ THE STORED CLOSES: ${e.message}`);
    say(`  the store is ${o.data} — one file per symbol (${LAD.SYMBOLS.join(", ")}), rows { d, c, a } as docs/ai-bubble-2026-10/bust/fetch.js writes them.`);
    say("  Nothing was computed and nothing was written. This monitor never fetches: the store is filled by that fetcher, at home.");
    return { code: 1, status: null, wrote: null, lines };
  }

  const status = LAD.computeStatus({ store, dataDir: o.data, cut: o.asOf, computedAt: now() });
  if (o.json) say(JSON.stringify(status, null, 1));
  else for (const l of status.summary) say(l);

  if (!o.write) { say("  read-only run: nothing was written (add --write to put this day's status in the status file)."); return { code: 0, status, wrote: null, lines }; }

  let doc;
  try { doc = rd(o.out); } catch (e) { say(`NOT WRITTEN: ${e.message}`); return { code: 1, status, wrote: null, lines }; }
  let merged;
  try { merged = LAD.mergeStatus(doc, status); } catch (e) { say(`NOT WRITTEN: ${e.message}`); return { code: 1, status, wrote: null, lines }; }
  try { write(o.out, merged); }
  catch (e) { say(`NOT WRITTEN: ${o.out} (${e.message}) — the file is as it was (it is replaced by rename, or not at all)`); return { code: 1, status, wrote: null, lines }; }
  const kept = merged.dates.filter((d) => d !== status.date);
  say(`  written: ${o.out} — the key ${status.date}${kept.length ? `; ${kept.length} other date(s) kept unchanged (${kept[0]}..${kept[kept.length - 1]})` : " (the first date in the file)"}`);
  say("  that file is the only thing this run wrote. No order was placed.");
  return { code: 0, status, wrote: o.out, lines };
}

module.exports = { run, parseArgs, readOut, REPO, DEFAULT_DATA, DEFAULT_OUT, USAGE };

if (require.main === module) process.exit(run({ argv: process.argv.slice(2) }).code);
