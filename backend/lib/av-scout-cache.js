"use strict";
/**
 * AV SCOUT CACHE (2026-09-24) — the Alpha Vantage call path for the SCOUT-0924 historical reads (R181, R183).
 *
 *  - Every response is cached under data/training/scout-0924/<fn>/<SYMBOL>.json (gitignored: data/training/) and never re-asked.
 *  - A reply carrying "Information", "Note" or "Error Message" is a NOTICE (plan limit, rate limit, bad key/function): it is NOT
 *    cached, the run stops at once (QuotaStop), and the notice text is never printed (AV quotes the key back inside it).
 *  - An empty-but-valid reply (e.g. {} for a symbol AV does not cover) IS cached, so the name is not re-asked forever; readers
 *    treat it as "Alpha Vantage returns nothing for this name".
 *  - Every network call is appended to data/training/scout-0924/calls.jsonl (fn, symbol, outcome — never the key or URL), which is
 *    how "AV calls used" is counted.
 *  - The key is read from backend/.env (ALPHAVANTAGE_KEY or ALPHA_VANTAGE_KEY) and never printed.
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { writeJsonAtomic } = require("./atomic-write.js");

const ROOT = path.join(__dirname, "..", "data", "training", "scout-0924");
const CALLS = path.join(ROOT, "calls.jsonl");
const KEY = process.env.ALPHAVANTAGE_KEY || process.env.ALPHA_VANTAGE_KEY;
const SPACING_MS = 1500;

class QuotaStop extends Error { constructor(kind, cls) { super(`Alpha Vantage notice (${kind}, ${cls}) — stopping; resume on the next run`); this.kind = kind; this.cls = cls; } }
// classify a notice WITHOUT printing it (the text quotes the key back)
const classify = (t) => /per day|daily/i.test(t) ? "daily-limit" : /premium/i.test(t) ? "premium-endpoint" : /per minute|per second|frequency/i.test(t) ? "rate-limit" : /invalid api|apikey/i.test(t) ? "key" : "other";

const safe = (s) => String(s).replace(/[^A-Za-z0-9.\-_]/g, "_");
const cacheFile = (fn, sym) => path.join(ROOT, fn, safe(sym) + ".json");
const has = (fn, sym) => fs.existsSync(cacheFile(fn, sym));
function read(fn, sym) { const f = cacheFile(fn, sym); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; }
function logCall(row) { fs.mkdirSync(ROOT, { recursive: true }); fs.appendFileSync(CALLS, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n"); }
function callsUsed(filter = () => true) {
  if (!fs.existsSync(CALLS)) return 0;
  return fs.readFileSync(CALLS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter(filter).length;
}

let lastCall = 0;
/** fetch one AV function for one symbol; returns the cached body. Throws QuotaStop on any notice. */
async function get(fn, sym, extra = {}, { caller = "?" } = {}) {
  const hit = read(fn, sym); if (hit) return { cached: true, body: hit };
  if (!KEY) throw new Error("no Alpha Vantage key in backend/.env");
  const wait = lastCall + SPACING_MS - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const p = new URLSearchParams({ function: fn, symbol: sym, ...extra, apikey: KEY });
  let r, j;
  try { r = await fetch(`https://www.alphavantage.co/query?${p}`, { signal: AbortSignal.timeout(60000) }); j = await r.json(); }
  catch (e) { logCall({ caller, fn, symbol: sym, outcome: "network-error" }); throw new Error(`${fn} ${sym}: network/parse error — retry next run`); }
  const kind = j && (j.Information ? "Information" : j.Note ? "Note" : j["Error Message"] ? "Error Message" : null);
  if (kind) { const cls = classify(String(j[kind])); logCall({ caller, fn, symbol: sym, outcome: "notice:" + kind + ":" + cls }); throw new QuotaStop(kind, cls); }
  if (!r.ok) { logCall({ caller, fn, symbol: sym, outcome: "http-" + r.status }); throw new Error(`${fn} ${sym}: HTTP ${r.status} — retry next run`); }
  const body = { fn, symbol: sym, fetchedAt: new Date().toISOString(), source: "alphavantage " + fn, empty: !j || !Object.keys(j).length, response: j };
  fs.mkdirSync(path.dirname(cacheFile(fn, sym)), { recursive: true });
  writeJsonAtomic(cacheFile(fn, sym), body, { pretty: 0 });
  logCall({ caller, fn, symbol: sym, outcome: body.empty ? "empty" : "ok" });
  return { cached: false, body };
}

module.exports = { ROOT, QuotaStop, get, has, read, cacheFile, callsUsed, hasKey: () => !!KEY };
