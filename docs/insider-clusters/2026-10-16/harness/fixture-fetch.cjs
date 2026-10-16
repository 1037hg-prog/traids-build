"use strict";
/**
 * FIXTURE FETCHER (insider clusters package, 2026-10-16) — the one door out of the collector, held shut.
 *
 * sec-fetch.js takes its fetcher as a required argument and never reaches for a global fetch, so a test that injects this one cannot
 * make a network call even by accident. It serves the SAVED fixture filings and daily indexes from fixtures/, on a VIRTUAL CLOCK, and
 * REFUSES any URL it was not given a file for — an unexpected URL is a failed check, never a request to the SEC.
 *
 *   const F = require("./harness/fixture-fetch.cjs");
 *   const f = F.make({ now: () => clock.ms, answers: { "<accession>": { status: 503 } } });
 *   f.fetchFn(url, init) -> { ok, status, headers, text() }      and f.calls / f.byUrl record exactly what was asked
 *
 * `answers` overrides one accession or one URL path: { status, retryAfter, body, throw, text } — that is how the 429 / 5xx / 404 /
 * timeout / torn-answer checks are written without a server. Nothing here opens a socket; `no-net.cjs` is loaded beside it in the
 * selftest so the process could not even if something tried.
 */
const fs = require("fs"), path = require("path");
const FIX = path.join(path.resolve(__dirname, ".."), "fixtures");

/** a Headers-like bag, so the code under test is exercised on the shape the platform fetch really gives */
function headers(obj) {
  const m = new Map(Object.entries(obj || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { get: (k) => (m.has(String(k).toLowerCase()) ? m.get(String(k).toLowerCase()) : null) };
}

/**
 * make({ now, answers, fixturesDir, latencyMs }) -> { fetchFn, calls, byUrl, reset() }
 * `now` is the virtual clock the limiter and the budget are measured on; each served call advances it by `latencyMs`.
 */
function make({ now = () => Date.now(), tick = null, answers = {}, fixturesDir = FIX, latencyMs = 5 } = {}) {
  const calls = [], byUrl = new Map();
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    const at = now();
    calls.push({ at, url: u.toString(), path: u.pathname, ua: (init.headers || {})["User-Agent"] || null, method: init.method || "GET" });
    byUrl.set(u.toString(), (byUrl.get(u.toString()) || 0) + 1);
    if (tick) tick(latencyMs);
    const name = path.posix.basename(u.pathname);
    const key = /^master\.\d{8}\.idx$/.test(name) ? name : name.replace(/\.txt$/, "");
    const over = answers[key] || answers[u.pathname] || answers[u.toString()] || null;
    if (over) {
      if (over.throw) throw new Error(over.throw === true ? "fixture: no answer (simulated timeout)" : String(over.throw));
      if (over.status && over.status !== 200) {
        return { ok: false, status: over.status, headers: headers(over.retryAfter === undefined ? {} : { "Retry-After": over.retryAfter }), async text() { return String(over.body || ""); } };
      }
      if (over.unreadable) return { ok: true, status: 200, headers: headers({}), async text() { throw new Error("fixture: the answer could not be read"); } };
      if (over.text !== undefined) return { ok: true, status: 200, headers: headers({}), async text() { return String(over.text); } };
    }
    const file = /^master\.\d{8}\.idx$/.test(name) ? path.join(fixturesDir, "daily-index", name) : path.join(fixturesDir, "filings", name);
    let text = null;
    try { text = fs.readFileSync(file, "utf8"); } catch { text = null; }
    if (text === null) {
      if (/^master\.\d{8}\.idx$/.test(name) || /^[\d-]+\.txt$/.test(name)) return { ok: false, status: 404, headers: headers({}), async text() { return "Not Found"; } };
      throw new Error(`fixture fetcher: nothing saved for ${u.toString()} — a test asked for a URL this harness has no file for (it never reaches the network)`);
    }
    return { ok: true, status: 200, headers: headers({ "Content-Type": name.endsWith(".idx") ? "text/plain" : "text/plain" }), async text() { return text; } };
  };
  return { fetchFn, calls, byUrl, reset() { calls.length = 0; byUrl.clear(); } };
}

/** a virtual clock: ms advances only when the code under test sleeps or the fetcher serves a call */
function makeClock(start = Date.parse("2026-12-01T22:00:00Z")) {
  let ms = start;
  return {
    get ms() { return ms; },
    now: () => ms,
    tick: (d) => { ms += Math.max(0, Number(d) || 0); },
    sleep: async (d) => { ms += Math.max(0, Number(d) || 0); },
  };
}

module.exports = { make, makeClock, headers, FIX };
