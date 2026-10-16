"use strict";
/**
 * RECONCILE-PACING 2026-10-14 — HARNESS PRELOAD (node --require): a FAKE BROKER and a VIRTUAL CLOCK for one run of alpaca-reconcile.js in
 * a scratch tree (harness/tree.cjs). Nothing here touches the network: globalThis.fetch is replaced before the script loads, and any
 * request that is not a GET to paper-api.alpaca.markets is refused (and recorded as refused).
 *
 *   RP_FAKE_CFG  a JSON file: { nowIso, responses: { "<path+query>": outcome | [outcome, ...] }, fallback: outcome | null }
 *                an outcome is { status, json, headers, body } (body: a raw text, e.g. not JSON), { network: "<code>" } (fetch throws, as
 *                undici does with no answer), or { hang: true } (no answer until the request's signal aborts). A list is served in order,
 *                its last outcome again for every later call of the same path. A path with no route and no fallback answers 599.
 *   RP_FAKE_OUT  where the report goes at exit: { calls: [{ at, path }], refused: [...], code, vnow }  (at = virtual ms since the start)
 *
 * THE VIRTUAL CLOCK: performance.now() is virtual milliseconds from 0, Date is frozen at nowIso plus the same virtual milliseconds, and
 * setTimeout / clearTimeout keep a virtual queue: once the event loop has nothing else to do (a setImmediate turn, after every pending
 * promise job), the earliest timer fires and the clock jumps to its time. A reconcile run waits on one thing at a time (a limiter sleep,
 * a backoff, or the call timeout racing a fake answer that settles at once), so a run that would pace for minutes takes milliseconds,
 * and each call's virtual time is exactly when the script started it.
 */
const fs = require("fs"), E = process.env;
const cfg = JSON.parse(fs.readFileSync(E.RP_FAKE_CFG, "utf8"));
const rep = { calls: [], refused: [] };

// ── the virtual clock ─────────────────────────────────────────────────────────────────────────────────────────────────────────
let vnow = 0, seq = 0, pumping = false; const queue = [], realImmediate = setImmediate;
function pump() {
  if (pumping) return; pumping = true;
  realImmediate(() => {
    pumping = false; if (!queue.length) return;
    queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const t = queue.shift(); if (t.at > vnow) vnow = t.at;
    t.fn(...t.args);
    if (queue.length) pump();
  });
}
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = { at: vnow + Math.max(0, Number(ms) || 0), fn, args, seq: ++seq, unref() { return t; }, ref() { return t; }, hasRef() { return true; }, refresh() { return t; } };
  queue.push(t); pump(); return t;
};
globalThis.clearTimeout = (t) => { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1); };
performance.now = () => vnow;
const RealDate = Date, T0 = RealDate.parse(cfg.nowIso || "2026-10-14T20:20:00.000Z");
globalThis.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(T0 + vnow); } static now() { return T0 + vnow; } };

// ── the fake broker ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const served = {};
const abortErr = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError", code: 20 });
function answer(oc) {
  const h = {}; for (const [k, v] of Object.entries(oc.headers || {})) h[String(k).toLowerCase()] = String(v);
  const text = oc.body !== undefined ? String(oc.body) : oc.json === undefined ? "" : JSON.stringify(oc.json);
  return { ok: oc.status >= 200 && oc.status < 300, status: oc.status, headers: { get: (k) => (Object.prototype.hasOwnProperty.call(h, String(k).toLowerCase()) ? h[String(k).toLowerCase()] : null) },
    json: async () => JSON.parse(text), text: async () => text };
}
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)), method = String(init.method || "GET").toUpperCase(), p = u.pathname + u.search;
  if (method !== "GET" || u.host !== "paper-api.alpaca.markets") { rep.refused.push({ method, url: String(url) }); throw new Error(`fake broker: refused ${method} ${u.host}`); }
  rep.calls.push({ at: vnow, path: p });
  const spec = Object.prototype.hasOwnProperty.call(cfg.responses || {}, p) ? cfg.responses[p] : cfg.fallback;
  const n = served[p] = (served[p] || 0) + 1;
  const oc = Array.isArray(spec) ? spec[Math.min(n - 1, spec.length - 1)] : spec;
  if (!oc) return answer({ status: 599, json: { message: `fake broker: no route for ${p}` } });
  if (oc.network) throw Object.assign(new TypeError("fetch failed"), { cause: { code: oc.network } });
  if (oc.hang) return new Promise((_, reject) => { const s = init.signal; if (!s) return; if (s.aborted) reject(abortErr()); else s.addEventListener("abort", () => reject(abortErr()), { once: true }); });
  return answer(oc);
};
process.on("exit", (code) => { try { fs.writeFileSync(E.RP_FAKE_OUT, JSON.stringify({ ...rep, code, vnow })); } catch { /* the harness then reads no report and fails the case */ } });
