"use strict";
/**
 * SEC FETCH — the one way this desk asks sec.gov for anything. 2026-10-16.
 *
 * WHY IT TAKES AN INJECTED FETCHER. Every collector that wrote its own `await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })`
 * is a collector whose tests either hit the network or are not written. This layer takes `fetchFn` as a REQUIRED argument and never
 * reaches for `globalThis.fetch`: a test that forgets to inject one gets a refusal, not a request to the SEC. The server entry point
 * passes `globalThis.fetch` itself, in one place, where it can be read.
 *
 * THE SEC'S OWN RULES, as the SEC states them (https://www.sec.gov/os/webmaster-faq#developers):
 *   - declare yourself in the User-Agent header (a product name and a way to reach the operator);
 *   - no more than TEN requests a second.
 * Both are enforced here rather than hoped for:
 *   - `userAgent` is REQUIRED and checked (see checkUserAgent): no default, no placeholder, no header injection. There is no contact
 *     string in this repository — the operator sets one at home (SEC_USER_AGENT, or --user-agent). A missing or still-placeholder
 *     setting refuses the run instead of asking the SEC anonymously and getting the whole desk blocked.
 *   - `perSecond` is capped at 10 and defaults to 10. A caller asking for more is refused; a caller asking for less is obeyed.
 *     The limiter counts a ROLLING second, not a bucket that empties on the clock's second boundary, so 10 a second is 10 in ANY
 *     second — never 10 at :00.999 and 10 more at :01.001.
 *
 * WHAT ELSE IT REFUSES rather than guesses:
 *   - a URL that is not https on www.sec.gov or data.sec.gov (nothing here may be pointed at another host: a filing's own content can
 *     never redirect this desk's reads somewhere else);
 *   - a 403 — on sec.gov that is the UA block, not a transient failure: retrying it is what earns a longer block, so it stops at once
 *     and says what to fix;
 *   - a budget overrun: a slot that would come after the deadline is refused there and then, so a caller's run has a bounded length.
 * A 404 is an ANSWER (`{ ok: false, notFound: true }`), not a failure: a filing index with a path that no longer exists is a fact.
 * A 429, a 5xx, a timeout, a network error and an unreadable answer are RETRIED with backoff (and a 429's / 503's Retry-After is
 * obeyed, holding every call, not only the one that was refused). A call that still fails returns `{ ok: false, failed: true, why }` —
 * the caller decides, and its own rule (insider-buys-collect.js: an unfetched filing is named in the run line and exits non-zero)
 * keeps a failed read from reading as "no insider bought anything".
 *
 * Pure parts (checkUserAgent, checkUrl, retryAfterMs, makeLimiter on an injected clock) are what the package's selftest holds to known
 * answers; nothing here opens a socket of its own.
 */

const SEC_HOSTS = Object.freeze(["www.sec.gov", "data.sec.gov"]);
const MAX_PER_SECOND = 10;              // the SEC's own limit; never raised from a caller
const DEFAULT_TRIES = 4, DEFAULT_BUDGET_MS = 180000, DEFAULT_TIMEOUT_MS = 20000, MAX_HOLD_MS = 120000;
const PLACEHOLDER = /REPLACE[_ -]?ME|YOUR[_ -]?(NAME|EMAIL|CONTACT)|TODO|FIXME|<[^>]*>|example\.com|changeme/i;

/**
 * The User-Agent the SEC asks for. Returns the trimmed string, or THROWS saying what is wrong.
 * It must be a plain one-line string of 10..200 printable characters that declares who is asking. A placeholder
 * ("REPLACE_ME", "<your email>", "example.com") is refused: an un-set setting must not read as a set one.
 * A newline or a control character is refused outright — a header value carrying CR/LF is header injection.
 * A bare browser string ("Mozilla/5.0...") is refused: it declares nothing, which is the thing the SEC asks against.
 */
function checkUserAgent(ua) {
  if (typeof ua !== "string" || !ua.trim()) throw new Error("SEC fetch: a User-Agent is REQUIRED (the SEC asks every caller to declare itself). Set SEC_USER_AGENT at home, or pass --user-agent; nothing in this repository holds a contact string.");
  const s = ua.trim();
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error("SEC fetch: the User-Agent holds a control character or a line break — refused (a header value must be one line).");
  if (s.length < 10) throw new Error(`SEC fetch: the User-Agent "${s}" is too short to declare anything (10 characters at least) — refused.`);
  if (s.length > 200) throw new Error(`SEC fetch: the User-Agent is ${s.length} characters (200 at most) — refused.`);
  if (PLACEHOLDER.test(s)) throw new Error(`SEC fetch: the User-Agent "${s}" still reads as a placeholder — set the real one at home; an un-set setting must never read as a set one.`);
  if (/^Mozilla\//i.test(s)) throw new Error(`SEC fetch: the User-Agent "${s.slice(0, 40)}…" is a browser string: it declares nobody, which is what the SEC asks against — give a product name and a way to reach the operator.`);
  return s;
}

/** The URL, or THROWS. https only, and only the SEC's own two hosts. */
function checkUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error(`SEC fetch: "${String(url).slice(0, 80)}" is not a URL — refused.`); }
  if (u.protocol !== "https:") throw new Error(`SEC fetch: ${u.protocol}//${u.host} is not https — refused.`);
  if (!SEC_HOSTS.includes(u.host)) throw new Error(`SEC fetch: ${u.host} is not an SEC host (${SEC_HOSTS.join(", ")}) — refused. This layer reads sec.gov and nothing else.`);
  return u.toString();
}

/**
 * Retry-After (RFC 9110) -> ms to hold, or null when there is none to read.
 * Accepts delay-seconds ("120") and an HTTP date ("Wed, 21 Oct 2026 07:28:00 GMT"), measured against `nowMs`.
 * A negative or absurd value is clamped to [0, MAX_HOLD_MS]: a header asking for an hour must not hang a nightly step.
 */
function retryAfterMs(value, nowMs) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  let ms = null;
  if (/^\d+(\.\d+)?$/.test(s)) ms = Math.round(Number(s) * 1000);
  else { const t = Date.parse(s); if (Number.isFinite(t)) ms = t - nowMs; }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.max(0, Math.min(MAX_HOLD_MS, ms));
}

/**
 * The limiter: never more than `perSecond` calls in ANY rolling second, plus a hold every caller obeys.
 * `take(deadlineMs)` resolves when a slot is free and records it; it THROWS when the next free slot is past the deadline
 * (a bounded run is the point of the budget). `hold(untilMs)` is what a 429 / Retry-After does: every call waits, and the
 * calls already counted in the rolling second stay counted (emptying the window on a hold is how a short hold turns into
 * 20 calls in one second).
 */
function makeLimiter({ perSecond = MAX_PER_SECOND, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!Number.isFinite(perSecond) || perSecond <= 0) throw new Error(`SEC fetch: perSecond must be a positive number, not ${perSecond}.`);
  if (perSecond > MAX_PER_SECOND) throw new Error(`SEC fetch: perSecond ${perSecond} is above the SEC's own limit of ${MAX_PER_SECOND} a second — refused.`);
  const stamps = [];                    // the ms of the calls inside the last second, oldest first
  let holdUntil = 0, taken = 0, waitedMs = 0, peak = 0, holds = 0;
  const prune = (t) => { while (stamps.length && stamps[0] <= t - 1000) stamps.shift(); };
  return {
    perSecond,
    /** when a slot would be free, given the window and the hold (pure: no waiting) */
    nextFreeAt(t = now()) { prune(t); return Math.max(holdUntil, stamps.length >= perSecond ? stamps[0] + 1000 : t); },
    async take(deadlineMs = Infinity) {
      for (;;) {
        const t = now(), free = this.nextFreeAt(t);
        if (free <= t) { stamps.push(t); taken++; peak = Math.max(peak, stamps.length); return t; }
        if (free > deadlineMs) throw new Error(`SEC fetch: the next request slot is ${Math.round((free - t) / 100) / 10}s away, past this run's budget — refused (nothing was asked).`);
        waitedMs += free - t;
        await sleep(free - t);
      }
    },
    hold(untilMs) { if (Number.isFinite(untilMs) && untilMs > holdUntil) { holdUntil = untilMs; holds++; } },
    stats: () => ({ taken, waitedMs, peakPerSecond: peak, holds, holdUntil, perSecond }),
  };
}

/** a header bag that reads the same whether the fetcher gives a Headers object, a Map or a plain object */
function headerOf(res, name) {
  const h = res && res.headers;
  if (!h) return null;
  try { if (typeof h.get === "function") { const v = h.get(name); return v === undefined ? null : v; } } catch { /* fall through to the plain read */ }
  const lower = String(name).toLowerCase();
  for (const k of Object.keys(h)) if (String(k).toLowerCase() === lower) return h[k];
  return null;
}

/**
 * makeSecFetcher({ fetchFn, userAgent, ... }) -> { get(url, opts) -> answer, stats(), limiter }
 *
 * `fetchFn(url, init)` must resolve to `{ ok, status, headers, text() }` (the shape of the platform fetch). It is REQUIRED.
 * An answer is one of:
 *   { ok: true,  status: 200, text, url, tries, ms }
 *   { ok: false, notFound: true, status: 404, url, tries }                  — an answer, not a failure
 *   { ok: false, failed: true, status, why, url, tries }                    — every try used, or the budget ran out
 * A 403 and a refused URL / UA THROW: they are settings to fix, not conditions to retry.
 */
function makeSecFetcher(opts = {}) {
  const {
    fetchFn, userAgent, perSecond = MAX_PER_SECOND, tries = DEFAULT_TRIES, budgetMs = DEFAULT_BUDGET_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    backoffMs = (attempt) => Math.min(8000, 500 * 2 ** attempt), log = () => {}, limiter: injected = null,
  } = opts;
  if (typeof fetchFn !== "function") throw new Error("SEC fetch: a fetcher must be injected (fetchFn). This layer never reaches for a global fetch, so a test can never make a network call by forgetting one.");
  if (!Number.isFinite(tries) || tries < 1) throw new Error(`SEC fetch: tries must be 1 or more, not ${tries}.`);
  const ua = checkUserAgent(userAgent);
  const limiter = injected || makeLimiter({ perSecond, now, sleep });
  const started = now(), deadline = started + budgetMs;
  const counts = { requests: 0, retried: 0, rateLimited: 0, serverErrors: 0, networkErrors: 0, notFound: 0, failed: 0 };

  async function get(url, { label = "" } = {}) {
    const u = checkUrl(url), t0 = now();
    let last = { status: null, why: "not asked" };
    for (let attempt = 0; attempt < tries; attempt++) {
      try { await limiter.take(deadline); }
      catch (e) { counts.failed++; return { ok: false, failed: true, status: last.status, why: `${e.message} (${last.why})`, url: u, tries: attempt }; }
      let res = null, err = null;
      counts.requests++;
      try {
        res = await fetchFn(u, {
          method: "GET",
          headers: { "User-Agent": ua, "Accept-Encoding": "gzip, deflate", Accept: "*/*", "Accept-Language": "en-US,en;q=0.9" },
          redirect: "follow",
          signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
        });
      } catch (e) { err = e; }

      if (err) { counts.networkErrors++; last = { status: null, why: `no answer (${String(err && err.message || err).slice(0, 120)})` }; }
      else {
        const status = Number(res.status);
        if (status === 403) throw new Error(`SEC fetch: 403 for ${u}. On sec.gov that is the User-Agent block, not a transient failure — retrying it earns a longer one. Check the declared User-Agent (now "${ua}") and the request rate, then run again.`);
        if (status === 404) { counts.notFound++; return { ok: false, notFound: true, status, url: u, tries: attempt + 1 }; }
        if (status === 429 || status >= 500) {
          if (status === 429) counts.rateLimited++; else counts.serverErrors++;
          const ra = retryAfterMs(headerOf(res, "retry-after"), now());
          if (ra !== null) { limiter.hold(now() + ra); log(`${label || u}: ${status}, Retry-After ${Math.round(ra / 100) / 10}s — every call holds`); }
          last = { status, why: `HTTP ${status}` };
        } else if (status < 200 || status >= 300) { counts.failed++; return { ok: false, failed: true, status, why: `HTTP ${status}`, url: u, tries: attempt + 1 }; }
        else {
          let text = null, readErr = null;
          try { text = await res.text(); } catch (e) { readErr = e; }
          if (readErr || typeof text !== "string") { last = { status, why: `the answer could not be read (${String(readErr && readErr.message || "not text").slice(0, 120)})` }; }
          else return { ok: true, status, text, url: u, tries: attempt + 1, ms: now() - t0 };
        }
      }
      if (attempt + 1 < tries) {
        counts.retried++;
        const wait = Math.max(0, backoffMs(attempt));
        if (now() + wait > deadline) { counts.failed++; return { ok: false, failed: true, status: last.status, why: `${last.why}; the backoff would run past this run's budget`, url: u, tries: attempt + 1 }; }
        log(`${label || u}: ${last.why} — try ${attempt + 2} of ${tries} in ${wait}ms`);
        await sleep(wait);
      }
    }
    counts.failed++;
    return { ok: false, failed: true, status: last.status, why: `${last.why} after ${tries} tries`, url: u, tries };
  }

  return {
    get, limiter, userAgent: ua,
    stats: () => ({ ...counts, ...limiter.stats(), budgetMs, spentMs: now() - started, budgetLeftMs: Math.max(0, deadline - now()) }),
  };
}

module.exports = { makeSecFetcher, makeLimiter, checkUserAgent, checkUrl, retryAfterMs, headerOf, SEC_HOSTS, MAX_PER_SECOND, DEFAULT_TRIES, DEFAULT_BUDGET_MS, DEFAULT_TIMEOUT_MS, MAX_HOLD_MS };
