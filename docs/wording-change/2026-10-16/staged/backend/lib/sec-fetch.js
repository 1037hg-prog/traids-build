"use strict";
/**
 * SEC FETCH — the FETCH LAYER of the wording-change collector (backlog row 25), 2026-10-16.
 *
 * It is the only file of the collector that knows EDGAR exists, and it STILL makes no call of its own: the caller passes the
 * function that does the transport. Nothing here reaches for global fetch, http or https, so requiring this file cannot open a
 * socket and a test that forgets to pass a fetcher fails loudly instead of quietly calling sec.gov.
 *
 *   makeLimiter({ maxPerSecond, now, sleep })      -> { take(), used(nowMs), maxPerSecond }
 *   makeSecFetcher({ fetcher, userAgent, ... })    -> { get(url), getJson(url), limiter, stats() }
 *   listFilings(sub, { forms, since, until })      -> the 10-K / 10-Q rows of a submissions document, newest last
 *   fetchSubmissions(sec, cik) / fetchFilingText(sec, row)
 *
 * ── SEC'S RATE LIMIT ───────────────────────────────────────────────────────────────────────────────────────────────────────
 * SEC's fair-access rule is NO MORE THAN 10 REQUESTS A SECOND from one source, and a declared User-Agent on every request; go over
 * and the whole host is blocked, not the one request. So:
 *   - every call, retries included, takes a slot from a sliding one-second window of at most `maxPerSecond` (default 10). When the
 *     window is full the fetcher WAITS — it never drops a request and never runs ahead;
 *   - the User-Agent must be given. There is no default and no built-in value: this repository holds no personal details, so the
 *     operator sets SEC_USER_AGENT in the server's environment and the collector passes it through. Without it the fetcher refuses
 *     to be built, which is why a run that cannot identify itself stops instead of being blocked at the other end;
 *   - 429 and 5xx are retried with the Retry-After header when the server sends one, otherwise doubling backoff with jitter, up to
 *     `maxRetries` times. 403 is NOT retried: on EDGAR it means the User-Agent was refused, and repeating it is what gets a host
 *     banned. 404 is returned to the caller, not retried;
 *   - only sec.gov hosts are allowed, so a wrong URL cannot send this repository's traffic somewhere else.
 *
 * ── THE INJECTED FETCHER ───────────────────────────────────────────────────────────────────────────────────────────────────
 *   fetcher(url, { headers, timeoutMs }) -> Promise<{ status, headers, text }>
 *     status   the HTTP status as a number
 *     headers  an object or a Map of response headers; names are read case-insensitively
 *     text     the body as a string
 * `nodeFetcher()` builds one over the runtime's global fetch. It is NOT the default: a caller asks for it by name, which keeps the
 * network out of every path that did not ask.
 *
 *   node backend/lib/sec-fetch.js --selftest        a fake clock and a fake fetcher; no network
 */

const SEC_HOSTS = Object.freeze(["www.sec.gov", "sec.gov", "data.sec.gov"]);
const DEFAULT_MAX_PER_SECOND = 10;      // SEC fair access: 10 requests a second
const WINDOW_MS = 1000;

const sleepReal = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
/** a header value by name, case-insensitively, from an object, a Map or a Headers */
function header(headers, name) {
  if (!headers) return null;
  const want = String(name).toLowerCase();
  if (typeof headers.get === "function") {                     // a fetch Headers is already case-insensitive; a Map is not
    const v = headers.get(name);
    if (v != null) return String(v);
    const v2 = headers.get(want);
    if (v2 != null) return String(v2);
  }
  if (typeof headers.entries === "function") {                  // a Map (or anything iterable the same way): compare the keys
    for (const [k, v] of headers.entries()) if (String(k).toLowerCase() === want) return String(v);
    return null;
  }
  if (typeof headers === "object") for (const k of Object.keys(headers)) if (k.toLowerCase() === want) return String(headers[k]);
  return null;
}

/**
 * The sliding-window limiter. take() resolves when a slot in the last WINDOW_MS is free, and records the slot. Deterministic: the
 * clock and the wait are injected, so a test drives it with a fake clock and no real time passes.
 */
function makeLimiter({ maxPerSecond = DEFAULT_MAX_PER_SECOND, now = Date.now, sleep = sleepReal } = {}) {
  const max = Math.floor(maxPerSecond);
  if (!Number.isFinite(max) || max < 1) throw new Error(`sec-fetch: maxPerSecond must be a whole number of at least 1 (got ${JSON.stringify(maxPerSecond)})`);
  if (max > DEFAULT_MAX_PER_SECOND) throw new Error(`sec-fetch: maxPerSecond ${max} is above SEC's fair-access limit of ${DEFAULT_MAX_PER_SECOND} a second — REFUSED`);
  const hits = [];
  const drop = (t) => { while (hits.length && hits[0] <= t - WINDOW_MS) hits.shift(); };
  async function take() {
    // the guard is for an injected sleep that does not advance the injected clock: that would spin forever, so it throws instead
    for (let spins = 0; spins < 10000; spins++) {
      const t = now();
      drop(t);
      if (hits.length < max) { hits.push(t); return t; }
      await sleep(hits[0] + WINDOW_MS - t);
    }
    throw new Error("sec-fetch: the rate limiter waited 10000 times without a free slot — the injected sleep does not advance the injected clock");
  }
  return { take, maxPerSecond: max, used: (t = now()) => { drop(t); return hits.length; } };
}

/** the one user-agent rule: it must be given, and it must not be a placeholder */
function checkUserAgent(ua) {
  const s = String(ua == null ? "" : ua).trim();
  if (!s) return "SEC requires every request to declare a User-Agent. Set SEC_USER_AGENT in the server's environment (the operator's own contact line) and pass it in — REFUSED, nothing was fetched";
  if (s.length < 5) return `the User-Agent ${JSON.stringify(s)} is too short to identify anyone — REFUSED`;
  if (/^(?:test|example|changeme|your[-_ ]?name|todo|xxx+)\b/i.test(s)) return `the User-Agent ${JSON.stringify(s)} is a placeholder — REFUSED`;
  return null;
}
/** sec.gov only; anything else is refused before a request is made */
function checkUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return `${JSON.stringify(String(url))} is not a URL — REFUSED`; }
  if (u.protocol !== "https:") return `${u.href} is not https — REFUSED`;
  if (!SEC_HOSTS.includes(u.hostname.toLowerCase())) return `${u.hostname} is not an SEC host (${SEC_HOSTS.join(", ")}) — REFUSED`;
  return null;
}
/** Retry-After as milliseconds: a number of seconds, or an HTTP date. null when it is absent or unreadable. */
function retryAfterMs(value, nowMs) {
  if (value == null) return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Math.min(+s, 3600) * 1000;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(0, Math.min(t - nowMs, 3600000));
  return null;
}
/** doubling backoff with jitter, bounded: attempt 0 -> base, 1 -> 2*base, … never above maxBackoffMs */
const backoffMs = (attempt, { baseBackoffMs, maxBackoffMs, rng }) => Math.min(maxBackoffMs, Math.round(baseBackoffMs * Math.pow(2, attempt) * (1 + rng())));

/**
 * The fetcher the collector uses.
 *   get(url)     -> { status, headers, text, attempts }   (200 and 404 come back; everything else has already been retried)
 *   getJson(url) -> the parsed body of a 200, or throws
 * THROWS when: no fetcher is injected, the User-Agent is missing or a placeholder, the URL is not an SEC https URL, or the retries
 * ran out. It never swallows a failure into a made-up answer.
 */
function makeSecFetcher({ fetcher, userAgent, maxPerSecond = DEFAULT_MAX_PER_SECOND, now = Date.now, sleep = sleepReal, rng = Math.random, maxRetries = 4, timeoutMs = 30000, baseBackoffMs = 1000, maxBackoffMs = 32000, limiter = null } = {}) {
  if (typeof fetcher !== "function") throw new Error("sec-fetch: a fetcher must be injected — makeSecFetcher({ fetcher }). nodeFetcher() builds one over global fetch; tests pass a fake");
  const uaProblem = checkUserAgent(userAgent);
  if (uaProblem) throw new Error("sec-fetch: " + uaProblem);
  const lim = limiter || makeLimiter({ maxPerSecond, now, sleep });
  const counts = { requests: 0, retries: 0, waitedMs: 0 };

  async function get(url) {
    const bad = checkUrl(url);
    if (bad) throw new Error("sec-fetch: " + bad);
    let lastWhy = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await lim.take();                                   // every attempt costs a slot: a retry is a request like any other
      counts.requests++;
      if (attempt > 0) counts.retries++;
      let res;
      try {
        res = await fetcher(String(url), { headers: { "User-Agent": String(userAgent), "Accept-Encoding": "gzip, deflate" }, timeoutMs });
      } catch (e) {
        lastWhy = `the fetcher threw: ${String(e && e.message ? e.message : e).slice(0, 200)}`;
        if (attempt === maxRetries) break;
        const w = backoffMs(attempt, { baseBackoffMs, maxBackoffMs, rng }); counts.waitedMs += w; await sleep(w);
        continue;
      }
      const status = Number(res && res.status);
      if (status === 200 || status === 404) return { status, headers: (res && res.headers) || {}, text: String((res && res.text) || ""), attempts: attempt + 1 };
      if (status === 403) throw new Error(`sec-fetch: ${url} -> 403. EDGAR refuses a request whose User-Agent it does not accept; retrying a 403 is what gets a host blocked, so this run stops. Check SEC_USER_AGENT.`);
      if (status === 429 || (status >= 500 && status < 600)) {
        lastWhy = `HTTP ${status}`;
        if (attempt === maxRetries) break;
        const ra = retryAfterMs(header(res.headers, "retry-after"), now());
        const w = ra == null ? backoffMs(attempt, { baseBackoffMs, maxBackoffMs, rng }) : ra;
        counts.waitedMs += w;
        await sleep(w);
        continue;
      }
      throw new Error(`sec-fetch: ${url} -> HTTP ${status} (not retried)`);
    }
    throw new Error(`sec-fetch: ${url} failed after ${maxRetries + 1} attempts — ${lastWhy}`);
  }
  async function getJson(url) {
    const r = await get(url);
    if (r.status !== 200) throw new Error(`sec-fetch: ${url} -> HTTP ${r.status}`);
    try { return JSON.parse(r.text); } catch (e) { throw new Error(`sec-fetch: ${url} did not return JSON (${String(e.message).slice(0, 120)})`); }
  }
  return { get, getJson, limiter: lim, stats: () => ({ ...counts }) };
}

/** a fetcher over the runtime's global fetch. Asked for by name; nothing here calls it on its own. */
function nodeFetcher() {
  const f = globalThis.fetch;
  if (typeof f !== "function") throw new Error("sec-fetch: this runtime has no global fetch — inject a fetcher instead");
  return async (url, { headers, timeoutMs } = {}) => {
    const res = await f(url, { headers, redirect: "follow", signal: AbortSignal.timeout(timeoutMs || 30000) });
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
}

// ── EDGAR addresses and shapes ─────────────────────────────────────────────────────────────────────────────────────────────
/** "320193", 320193, "CIK0000320193" -> "0000320193" */
function cik10(cik) {
  const d = String(cik == null ? "" : cik).replace(/^cik/i, "").replace(/\D/g, "");
  if (!d || d.length > 10) throw new Error(`sec-fetch: ${JSON.stringify(String(cik))} is not a CIK`);
  return d.padStart(10, "0");
}
const submissionsUrl = (cik) => `https://data.sec.gov/submissions/CIK${cik10(cik)}.json`;
const extraSubmissionsUrl = (name) => `https://data.sec.gov/submissions/${String(name).replace(/[^A-Za-z0-9._-]/g, "")}`;
/** the folder EDGAR keeps one filing's documents in: the CIK without leading zeros, then the accession without dashes */
const filingDirUrl = (cik, accession) => `https://www.sec.gov/Archives/edgar/data/${String(Number(cik10(cik)))}/${String(accession).replace(/-/g, "")}`;
const documentUrl = (cik, accession, document) => `${filingDirUrl(cik, accession)}/${String(document).replace(/^\/+/, "")}`;

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
/**
 * The 10-K and 10-Q rows of a submissions document. EDGAR stores `filings.recent` as PARALLEL ARRAYS (one array per field, read by
 * the same index), and older filings in further files listed under `filings.files`; pass those extra documents in `extra` and they
 * are read the same way. Rows come back oldest first, which is the order the collector needs: each filing is scored against the one
 * before it.
 */
function listFilings(sub, { forms = ["10-K", "10-Q"], since = null, until = null, extra = [] } = {}) {
  const want = new Set(forms.map((f) => String(f).toUpperCase()));
  const cik = cik10((sub && sub.cik) || 0);
  const out = [];
  const take = (blk) => {
    if (!blk || !Array.isArray(blk.accessionNumber)) return;
    const n = blk.accessionNumber.length;
    for (let i = 0; i < n; i++) {
      const form = String((blk.form || [])[i] || "").toUpperCase();
      if (!want.has(form)) continue;
      const filingDate = String((blk.filingDate || [])[i] || "");
      if (!isDate(filingDate)) continue;
      if (since && filingDate < since) continue;
      if (until && filingDate > until) continue;
      const accession = String(blk.accessionNumber[i] || "");
      const primaryDocument = String((blk.primaryDocument || [])[i] || "");
      if (!accession || !primaryDocument) continue;
      out.push({
        cik, symbol: (sub && Array.isArray(sub.tickers) && sub.tickers[0]) || null, companyName: (sub && sub.name) || null,
        form, filingDate, reportDate: String((blk.reportDate || [])[i] || "") || null,
        accession, primaryDocument, url: documentUrl(cik, accession, primaryDocument),
      });
    }
  };
  take(sub && sub.filings && sub.filings.recent);
  for (const e of extra) take(e);
  out.sort((a, b) => (a.filingDate < b.filingDate ? -1 : a.filingDate > b.filingDate ? 1 : a.accession < b.accession ? -1 : a.accession > b.accession ? 1 : 0));
  // one accession can be listed twice when an extra document overlaps `recent`
  const seen = new Set();
  return out.filter((r) => (seen.has(r.accession) ? false : (seen.add(r.accession), true)));
}
/** the names of the further submission documents EDGAR lists for a company with a long history */
const extraSubmissionFiles = (sub) => ((sub && sub.filings && Array.isArray(sub.filings.files) ? sub.filings.files : []).map((f) => String(f && f.name || "")).filter(Boolean));

async function fetchSubmissions(sec, cik, { includeOlder = false } = {}) {
  const sub = await sec.getJson(submissionsUrl(cik));
  const extra = [];
  if (includeOlder) for (const name of extraSubmissionFiles(sub)) extra.push(await sec.getJson(extraSubmissionsUrl(name)));
  return { sub, extra };
}
/** one filing's primary document as text. A 404 comes back as null rather than as a throw: a missing document is a fact to record. */
async function fetchFilingText(sec, row) {
  const r = await sec.get(row.url);
  if (r.status === 404) return { url: row.url, text: null, status: 404 };
  return { url: row.url, text: r.text, status: r.status, bytes: Buffer.byteLength(r.text, "utf8") };
}

// ── selftest ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** a clock and a sleep that move only when the code asks them to — no real time passes in any check below */
function fakeClock(startMs = 1760000000000) {
  let t = startMs;
  return { now: () => t, sleep: async (ms) => { t += Math.max(0, Math.round(ms)); }, set: (v) => { t = v; }, advance: (ms) => { t += ms; } };
}
async function selftest() {
  let pass = 0, fail = 0;
  const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : " — " + detail)); } };
  const threw = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
  const UA = "TRAIDS research collector (operator contact in the server environment)";

  // ── the rate limit ──
  {
    const clk = fakeClock();
    const lim = makeLimiter({ maxPerSecond: 10, now: clk.now, sleep: clk.sleep });
    const stamps = [];
    for (let i = 0; i < 25; i++) stamps.push(await lim.take());
    const inWindow = (t) => stamps.filter((u) => u > t - WINDOW_MS && u <= t).length;
    ok("the limiter lets all 25 requests through and never more than 10 start in any one second",
      stamps.length === 25 && stamps.every((t) => inWindow(t) <= 10) && stamps.filter((t) => t < stamps[0] + WINDOW_MS).length === 10,
      JSON.stringify(stamps.map((t) => t - stamps[0])));
    ok("25 requests at 10 a second take at least two whole seconds of the injected clock", stamps[24] - stamps[0] >= 2000, String(stamps[24] - stamps[0]));
    ok("the limiter refuses a rate above SEC's 10 a second, and a rate below 1", threw(() => makeLimiter({ maxPerSecond: 50 }), /above SEC's fair-access limit/) && threw(() => makeLimiter({ maxPerSecond: 0 }), /at least 1/) && threw(() => makeLimiter({ maxPerSecond: "ten" }), /at least 1/));
    const spin = makeLimiter({ maxPerSecond: 1, now: () => 5000, sleep: async () => { } });
    await spin.take();
    let spinWhy = null; await spin.take().catch((e) => { spinWhy = e.message; });
    ok("a sleep that does not advance the clock is reported, not spun on for ever", /does not advance the injected clock/.test(spinWhy || ""), String(spinWhy));
  }
  {
    const c2 = fakeClock();
    const l2 = makeLimiter({ maxPerSecond: 10, now: c2.now, sleep: c2.sleep });
    for (let i = 0; i < 10; i++) await l2.take();
    c2.advance(1001);
    const before = c2.now();
    await l2.take();
    ok("after a whole second has passed the window is empty again and the next request does not wait", c2.now() === before && l2.used() === 1, `${c2.now() - before} ms, used ${l2.used()}`);
  }
  await rest(ok, UA, threw);
  console.log(`sec-fetch selftest: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASSED" : "FAILED"}`);
  return fail === 0;
}
/** the rest of the checks, split out so the function above stays readable */
async function rest(ok, UA, threw) {
  // what it refuses to do
  ok("a fetcher must be injected: there is no default transport", threw(() => makeSecFetcher({ userAgent: UA }), /a fetcher must be injected/));
  ok("a missing, too-short or placeholder User-Agent refuses the whole fetcher",
    threw(() => makeSecFetcher({ fetcher: async () => ({}) }), /requires every request to declare a User-Agent/) &&
    threw(() => makeSecFetcher({ fetcher: async () => ({}), userAgent: "ab" }), /too short/) &&
    threw(() => makeSecFetcher({ fetcher: async () => ({}), userAgent: "example contact here" }), /placeholder/));
  {
    const src = require("fs").readFileSync(__filename, "utf8");
    const outsideNodeFetcher = src.replace(/\nfunction nodeFetcher\(\) \{[\s\S]*?\n\}\n/, "\n");
    ok("this file never reaches for the network on its own: global fetch is named only inside nodeFetcher(), and nothing requires http, https, net or tls",
      /globalThis\.fetch/.test(src) && !/globalThis\.fetch/.test(outsideNodeFetcher) && !/require\((["'])(?:node:)?(?:https?|net|tls|dgram)\1\)/.test(src),
      `nodeFetcher ${src.length - outsideNodeFetcher.length} characters`);
  }

  const clk = fakeClock();
  const calls = [];
  const fake = (plan) => async (url, opt) => { calls.push({ url, at: clk.now(), ua: opt.headers["User-Agent"] }); const r = plan.shift(); if (!r) throw new Error("the fake fetcher ran out of planned answers"); if (r.throwIt) throw new Error(r.throwIt); return r; };

  // a plain 200
  {
    calls.length = 0;
    const sec = makeSecFetcher({ fetcher: fake([{ status: 200, headers: {}, text: '{"a":1}' }]), userAgent: UA, now: clk.now, sleep: clk.sleep, rng: () => 0 });
    const j = await sec.getJson("https://data.sec.gov/submissions/CIK0000000001.json");
    ok("a 200 comes back parsed, with the User-Agent on the request", j.a === 1 && calls[0].ua === UA && sec.stats().requests === 1);
  }
  // only sec.gov
  {
    const sec = makeSecFetcher({ fetcher: fake([]), userAgent: UA, now: clk.now, sleep: clk.sleep });
    let why = null; await sec.get("https://example.com/x").catch((e) => { why = e.message; });
    let why2 = null; await sec.get("http://www.sec.gov/x").catch((e) => { why2 = e.message; });
    ok("a host that is not sec.gov, and plain http, are refused before any request", /is not an SEC host/.test(why || "") && /is not https/.test(why2 || "") && sec.stats().requests === 0, String(why) + " | " + String(why2));
  }
  // 429 with Retry-After, then 200
  {
    calls.length = 0;
    const t0 = clk.now();
    const sec = makeSecFetcher({ fetcher: fake([{ status: 429, headers: { "Retry-After": "2" }, text: "" }, { status: 200, headers: {}, text: "ok" }]), userAgent: UA, now: clk.now, sleep: clk.sleep, rng: () => 0 });
    const r = await sec.get("https://www.sec.gov/Archives/edgar/data/1/x.htm");
    ok("a 429 waits exactly the Retry-After it was given, then succeeds, and both attempts cost a slot", r.text === "ok" && r.attempts === 2 && clk.now() - t0 >= 2000 && sec.stats().requests === 2 && sec.stats().retries === 1, `${clk.now() - t0} ms, ${JSON.stringify(sec.stats())}`);
  }
  // 503 without Retry-After: doubling backoff
  {
    const t0 = clk.now();
    const sec = makeSecFetcher({ fetcher: fake([{ status: 503, headers: {}, text: "" }, { status: 503, headers: {}, text: "" }, { status: 200, headers: {}, text: "ok" }]), userAgent: UA, now: clk.now, sleep: clk.sleep, rng: () => 0, baseBackoffMs: 1000 });
    const r = await sec.get("https://www.sec.gov/x");
    ok("a 5xx without Retry-After backs off 1s then 2s and then succeeds", r.text === "ok" && clk.now() - t0 === 3000, String(clk.now() - t0));
  }
  // retries run out
  {
    const sec = makeSecFetcher({ fetcher: fake([{ status: 500, headers: {}, text: "" }, { status: 500, headers: {}, text: "" }]), userAgent: UA, now: clk.now, sleep: clk.sleep, rng: () => 0, maxRetries: 1 });
    let why = null; await sec.get("https://www.sec.gov/x").catch((e) => { why = e.message; });
    ok("when the retries run out it throws, saying how many attempts and why — it never returns a made-up body", /failed after 2 attempts — HTTP 500/.test(why || ""), String(why));
  }
  // 403 is never retried
  {
    calls.length = 0;
    const sec = makeSecFetcher({ fetcher: fake([{ status: 403, headers: {}, text: "" }, { status: 200, headers: {}, text: "ok" }]), userAgent: UA, now: clk.now, sleep: clk.sleep });
    let why = null; await sec.get("https://www.sec.gov/x").catch((e) => { why = e.message; });
    ok("a 403 stops the run at once and is never retried (retrying it is what gets a host blocked)", /403/.test(why || "") && calls.length === 1, `${why} after ${calls.length} call(s)`);
  }
  // 404 is an answer, not a failure
  {
    const sec = makeSecFetcher({ fetcher: fake([{ status: 404, headers: {}, text: "" }]), userAgent: UA, now: clk.now, sleep: clk.sleep });
    const r = await fetchFilingText(sec, { url: "https://www.sec.gov/Archives/edgar/data/1/gone.htm" });
    ok("a 404 document comes back as text null, for the collector to record as missing", r.status === 404 && r.text === null);
  }
  // a fetcher that throws is retried like a 5xx
  {
    const sec = makeSecFetcher({ fetcher: fake([{ throwIt: "socket hang up" }, { status: 200, headers: {}, text: "ok" }]), userAgent: UA, now: clk.now, sleep: clk.sleep, rng: () => 0 });
    const r = await sec.get("https://www.sec.gov/x");
    ok("a transport error is retried like a 5xx", r.text === "ok" && r.attempts === 2);
  }
  // Retry-After shapes
  ok("Retry-After reads seconds and an HTTP date, and is bounded at an hour", retryAfterMs("2", 0) === 2000 && retryAfterMs("Thu, 16 Oct 2026 00:00:30 GMT", Date.parse("2026-10-16T00:00:00Z")) === 30000 && retryAfterMs("999999", 0) === 3600000 && retryAfterMs(null, 0) === null && retryAfterMs("soon", 0) === null);
  ok("header() reads a name case-insensitively, from an object or a Map", header({ "Retry-After": "7" }, "retry-after") === "7" && header(new Map([["retry-after", "7"]]), "Retry-After") === "7" && header(new Map([["Retry-After", "7"]]), "retry-after") === "7" && header({}, "x") === null && header(null, "x") === null);
  {
    const clk2 = fakeClock();
    const sec = makeSecFetcher({ fetcher: async () => ({ status: 429, headers: new Map([["Retry-After", "3"]]), text: "" }), userAgent: UA, now: clk2.now, sleep: clk2.sleep, maxRetries: 1, rng: () => 0 });
    const t0 = clk2.now();
    await sec.get("https://www.sec.gov/x").catch(() => { });
    ok("a Retry-After sent in a Map of headers is honoured too (3 s, not the 1 s default backoff)", clk2.now() - t0 === 3000, String(clk2.now() - t0));
  }

  // EDGAR addresses
  ok("cik10 pads, strips a CIK prefix, and refuses what is not a CIK", cik10("320193") === "0000320193" && cik10(320193) === "0000320193" && cik10("CIK0000320193") === "0000320193" && threw(() => cik10("12345678901"), /is not a CIK/) && threw(() => cik10(""), /is not a CIK/));
  ok("the EDGAR addresses are the documented ones (submissions by padded CIK; the archive folder by unpadded CIK and the accession without dashes)",
    submissionsUrl("320193") === "https://data.sec.gov/submissions/CIK0000320193.json" &&
    documentUrl("0000000001", "0000000001-25-000003", "sample-10k.htm") === "https://www.sec.gov/Archives/edgar/data/1/000000000125000003/sample-10k.htm");

  // submissions -> rows
  const SUB = {
    cik: "1", name: "SAMPLE WIDGETS INC", tickers: ["ZZZZ"],
    filings: {
      recent: {
        form: ["10-Q", "8-K", "10-K", "10-Q"],
        filingDate: ["2025-05-06", "2025-03-02", "2025-02-18", "2024-11-04"],
        reportDate: ["2025-03-31", "2025-03-01", "2024-12-31", "2024-09-30"],
        accessionNumber: ["0000000001-25-000009", "0000000001-25-000005", "0000000001-25-000003", "0000000001-24-000011"],
        primaryDocument: ["q2.htm", "ev.htm", "k2024.htm", "q3.htm"],
      },
      files: [{ name: "CIK0000000001-submissions-001.json" }],
    },
  };
  const rows = listFilings(SUB);
  ok("listFilings keeps only 10-K and 10-Q, reads the parallel arrays by index, and returns them oldest first",
    rows.length === 3 && rows.map((r) => r.filingDate).join(",") === "2024-11-04,2025-02-18,2025-05-06" && rows.map((r) => r.form).join(",") === "10-Q,10-K,10-Q" &&
    rows[1].url === "https://www.sec.gov/Archives/edgar/data/1/000000000125000003/k2024.htm" && rows[1].symbol === "ZZZZ" && rows[1].reportDate === "2024-12-31",
    JSON.stringify(rows.map((r) => [r.form, r.filingDate])));
  ok("listFilings honours --since / --until and a narrower form list", listFilings(SUB, { since: "2025-01-01" }).length === 2 && listFilings(SUB, { until: "2024-12-31" }).length === 1 && listFilings(SUB, { forms: ["10-K"] }).map((r) => r.form).join() === "10-K");
  ok("an older submissions document is merged in, and an accession listed twice is kept once",
    listFilings(SUB, { extra: [{ form: ["10-K", "10-K"], filingDate: ["2024-02-20", "2025-02-18"], accessionNumber: ["0000000001-24-000002", "0000000001-25-000003"], primaryDocument: ["k2023.htm", "k2024.htm"], reportDate: ["2023-12-31", "2024-12-31"] }] }).map((r) => r.filingDate).join(",") === "2024-02-20,2024-11-04,2025-02-18,2025-05-06");
  ok("a row with no primary document, or an impossible filing date, is left out rather than guessed",
    listFilings({ cik: "1", filings: { recent: { form: ["10-K", "10-K"], filingDate: ["2025-02-30", "2025-02-18"], accessionNumber: ["a", "b"], primaryDocument: ["x.htm", ""] } } }).length === 0);
  ok("extraSubmissionFiles lists the further documents, and the address is built from the name alone", extraSubmissionFiles(SUB).join() === "CIK0000000001-submissions-001.json" && extraSubmissionsUrl("CIK0000000001-submissions-001.json") === "https://data.sec.gov/submissions/CIK0000000001-submissions-001.json");

  // the whole fetch path, over the fake
  {
    const docs = { "https://data.sec.gov/submissions/CIK0000000001.json": JSON.stringify(SUB), "https://www.sec.gov/Archives/edgar/data/1/000000000125000003/k2024.htm": "<p>Item 1. Business</p>" };
    const seen = [];
    const sec = makeSecFetcher({ fetcher: async (url) => { seen.push(url); return docs[url] === undefined ? { status: 404, headers: {}, text: "" } : { status: 200, headers: {}, text: docs[url] }; }, userAgent: UA, now: clk.now, sleep: clk.sleep });
    const { sub } = await fetchSubmissions(sec, "1");
    const k = listFilings(sub, { forms: ["10-K"] })[0];
    const got = await fetchFilingText(sec, k);
    ok("end to end over a fake EDGAR: submissions, then the 10-K's primary document, in two requests", got.text === "<p>Item 1. Business</p>" && got.bytes === 23 && seen.length === 2 && sec.stats().requests === 2, JSON.stringify(seen));
  }
}

module.exports = {
  SEC_HOSTS, DEFAULT_MAX_PER_SECOND, WINDOW_MS,
  header, makeLimiter, checkUserAgent, checkUrl, retryAfterMs, backoffMs, makeSecFetcher, nodeFetcher,
  cik10, submissionsUrl, extraSubmissionsUrl, extraSubmissionFiles, filingDirUrl, documentUrl,
  listFilings, fetchSubmissions, fetchFilingText, fakeClock, selftest,
};

if (require.main === module) {
  if (process.argv.includes("--selftest")) selftest().then((okAll) => { process.exitCode = okAll ? 0 : 1; }, (e) => { console.error("sec-fetch selftest threw: " + e.stack); process.exitCode = 1; });
  else { console.log("sec-fetch.js: the fetch layer of the wording-change collector (injected fetcher, SEC's 10-a-second limit). --selftest runs its checks."); process.exitCode = 2; }
}
