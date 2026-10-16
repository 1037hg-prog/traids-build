"use strict";
/**
 * RECONCILE-PACING 2026-10-14 — GET-ONLY GUARD (node --require), for verify-live.cjs's one --dry-print run of the LIVE reconcile against the
 * real paper account. It wraps the real fetch BEFORE the script loads:
 *   - a request that is not a GET over https to paper-api.alpaca.markets is REFUSED before anything leaves the process (and recorded);
 *   - every GET passed on is recorded as { at (ms since the guard loaded, monotonic), path } — the path only: no header, no key, no query.
 * GET_ONLY_OUT names the report file, written at exit: { calls, refused, code }. The guard never reads .env and prints nothing.
 */
const fs = require("fs");
const real = globalThis.fetch, t0 = performance.now(), rep = { calls: [], refused: [] };
globalThis.fetch = async (url, init = {}) => {
  let u = null; try { u = new URL(typeof url === "string" ? url : String(url && url.href ? url.href : "")); } catch { u = null; }
  const method = String((init && init.method) || "GET").toUpperCase();
  if (!u || method !== "GET" || u.protocol !== "https:" || u.host !== "paper-api.alpaca.markets") {
    rep.refused.push({ method, host: u ? u.host : null, path: u ? u.pathname : null });
    throw new Error(`get-only guard: refused ${method} ${u ? u.host + u.pathname : "(not a URL string)"} — only GETs to the paper API may leave this run`);
  }
  rep.calls.push({ at: performance.now() - t0, path: u.pathname });
  return real(url, init);
};
process.on("exit", (code) => { try { fs.writeFileSync(process.env.GET_ONLY_OUT, JSON.stringify({ ...rep, code })); } catch { /* verify-live then reads no report: UNKNOWN */ } });
