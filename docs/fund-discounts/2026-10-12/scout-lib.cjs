"use strict";
// DATA SCOUT (pre-registration) shared helper. Plain public GETs only, no key, no login. Enforces the fence of this scout:
// at most 2 requests a second to any host and a hard total cap per agent, counted in a file so the cap holds across scripts.
// NOTHING here computes a return, a discount, or any outcome. Callers print counts, dates and field names only.
const fs = require("fs"), path = require("path"), os = require("os");
const CACHE = process.env.CEF_SCOUT_CACHE || path.join(os.tmpdir(), "traids-cef-scout");
const CAP = Number(process.env.CEF_SCOUT_CAP || 290), MIN_GAP_MS = 650;
fs.mkdirSync(CACHE, { recursive: true });
const COUNT_FILE = path.join(CACHE, "requests.json");
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const lastAt = new Map();
function readCount() { try { return JSON.parse(fs.readFileSync(COUNT_FILE, "utf8")); } catch { return { count: 0, byHost: {} }; } }
function bump(host) { const c = readCount(); c.count++; c.byHost[host] = (c.byHost[host] || 0) + 1; fs.writeFileSync(COUNT_FILE, JSON.stringify(c)); return c.count; }
/** One counted, rate-limited GET. Returns { status, text, headers }. Never retries on its own (a retry is another counted request). */
async function get(url, { headers = {}, timeoutMs = 45000 } = {}) {
  const host = new URL(url).host, c = readCount();
  if (c.count >= CAP) throw new Error(`request cap reached (${c.count}/${CAP}) - stopping, by the scout's fence`);
  const wait = (lastAt.get(host) || 0) + MIN_GAP_MS - Date.now(); if (wait > 0) await nap(wait);
  lastAt.set(host, Date.now()); bump(host);
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  return { status: r.status, text, contentType: r.headers.get("content-type") || "" };
}
/** GET with an on-disk cache keyed by name, so a re-run costs no request. */
async function cachedGet(name, url, opts) {
  const f = path.join(CACHE, name);
  if (fs.existsSync(f)) return { status: 200, text: fs.readFileSync(f, "utf8"), cached: true };
  const r = await get(url, opts);
  if (r.status === 200 && r.text.length > 0) fs.writeFileSync(f, r.text);
  return r;
}
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
module.exports = { get, cachedGet, readCount, CACHE, CAP, nap, day };
