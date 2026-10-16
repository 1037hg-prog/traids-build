#!/usr/bin/env node
/**
 * ALPACA RECONCILE (2026-09-22) — grade OUR ledger against the BROKER's record. For every ticket alpaca-mirror.js sent, ask Alpaca what
 * actually happened and compare it with what this repo believes:
 *   FILL GAP     broker fill price vs the ticket's claimed entry (the slippage our cost model only models)
 *   FATE GAP     the broker closed it (take-profit, stop, expiry) vs our ledger's exit and P&L for the same ticket
 *   MISSING      a mirrored order the broker has no record of, or a settled ticket whose mirror never filled
 * Reads only. It changes no ledger row and grades no test. Writes data/alpaca-reconcile.json for the nightly email.
 * PAPER-AUCTION-FIX 2026-10-02: quantities are the broker's filled_qty (entry and every exit fill), never the ordered qty or a status alone.
 * --split-eras (W5, server migration 2026-10, docs/server/wave5-board; fix 4 of the 10-09 review): out.eras reports the STALE era (mirrored
 *   before 2026-10-01: no exit pass existed while those tickets were open, and the 10-01 catch-up closed them) apart from the current one —
 *   never pooled — and the reading speaks for the current era; out.r24 counts R24 under ITS OWN mirror (r24-alpaca-mirror.js, BOOK account,
 *   graded in percent by data/r24-mirror.json): R24's 16:00 ET entries never pass through this mirror. It is ALSO on, without the flag, once
 *   data/host-ownership.json gives w5-chain to the server (this step's chain line is another package's anchor and cannot carry the flag).
 *   Without the flag and with W5 home-owned the output is unchanged.
 * RECONCILE-PACING 2026-10-14 (docs/reconcile-pacing/2026-10-14): a failed broker call is never "no record".
 *   PACED   every broker call goes through ONE limiter: at most 110 a minute with a burst of 10, so never more than 120 in any minute
 *           (the main paper account allows 200 a minute across every runner). A 429's Retry-After holds every later call; so does the
 *           account's own window when X-RateLimit-Remaining is at or under 20 (until X-RateLimit-Reset).
 *   RETRIED a 429, a 5xx, a timeout, no answer at all, or an answer that is not a JSON object is tried again with backoff (1, 2, 4 s; 4
 *           tries at most), every call inside a 180 s budget (the close chain gives this step 4 minutes, then kills it).
 *   UNKNOWN a call that still fails, or is never made because the budget ran out or the account refused the key (401/403), makes its
 *           ticket UNKNOWN as a whole: reconcileStatus "UNKNOWN", unknownReason, httpStatus, call, tries — never "broker has no record",
 *           never unfilled, never missing, in no gap list. Nothing is carried over: the next run asks again. A 404 is the broker's own
 *           answer: "broker has no record of this order" as before, now with httpStatus 404 (never retried).
 *   OUTPUT  every row whose calls were answered is the row the code before this one wrote, byte for byte. New: out.failedCalls (the
 *           rows that carry httpStatus), out.unknown, out.calls (made, retried, rate-limited, peak in any minute); on a night with any
 *           UNKNOWN ticket the reading STARTS "UNKNOWN: ..." and the run exits 3 (the chain records it, self-heal replays it once).
 *           The last line gives the UNKNOWN count and the calls. The newest mirror row is asked first, so a spent budget leaves the
 *           oldest (long-settled) tickets UNKNOWN, never tonight's; the rows are still graded and written in file order.
 *   --dry-print <file>  the same run, its output written to <file> (refused inside backend/data); nothing else is written.
 */
const fs = require("fs"), path = require("path"); require("dotenv").config({ path: path.join(__dirname, ".env") });
const D = (f) => path.join(__dirname, "data", f), LOG = D("alpaca-mirror.jsonl");
const BASE = "https://paper-api.alpaca.markets";
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
const { writeJsonAtomic: writeAtomic } = require("./lib/atomic-write.js");
// RECONCILE-PACING 2026-10-14: `api` (one unpaced fetch whose every failure the loop wrote as "broker has no record") is replaced by
// brokerGet below. PACE is the whole policy; the selftest of docs/reconcile-pacing/2026-10-14 holds each number to its behaviour.
const PACE = Object.freeze({ perMinute: 110, burst: 10, maxInAnyMinute: 120, tries: 4, backoffMs: 1000, backoffCapMs: 8000, callTimeoutMs: 10000, budgetMs: 180000, minCallMs: 2000, reserve: 20, reserveHoldCapMs: 60000 });
const UNKNOWN_ISSUE = "UNKNOWN: no broker answer tonight (a failed call, not a broker answer; the next run asks again)";
// --dry-print <file> (verify-live.cjs): the run's output goes to <file>, which must lie outside backend/data; nothing else is written
const DRY_AT = process.argv.indexOf("--dry-print"), DRY_ARG = DRY_AT >= 0 ? process.argv[DRY_AT + 1] : null;
const DRY_OUT = DRY_ARG && !DRY_ARG.startsWith("--") ? path.resolve(DRY_ARG) : null;
const dryOutOk = () => { if (!DRY_OUT) return false; const rel = path.relative(path.join(__dirname, "data"), DRY_OUT); return rel.startsWith("..") || path.isAbsolute(rel); };
const writeJsonAtomic = (f, o) => writeAtomic(DRY_OUT || f, o);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const SPLIT = process.argv.includes("--split-eras") || (() => { try { return JSON.parse(fs.readFileSync(D("host-ownership.json"), "utf8")).units["w5-chain"] === "server"; } catch { return false; } })(), STALE_BEFORE = "2026-10-01";   // W5 fix 4 (2026-10): the flag, or the board cell server-owned
/** W5 fix 4: R24 under its own mirror (counts only; files read, no broker call, no BOOK key) */
function r24Summary() {
  const jl = (f) => { try { return fs.readFileSync(D(f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { return null; } };
  const led = jl("r24-mirror-ledger.jsonl"); let status = null; try { status = JSON.parse(fs.readFileSync(D("r24-mirror.json"), "utf8")); } catch { status = null; }
  let tl = null; try { const t = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8")); tl = Array.isArray(t) ? t : t.trades; } catch { tl = null; }
  const board = Array.isArray(tl) ? tl.filter((t) => t && t.strategy === "R24-13F-clone") : [], closed = board.filter((t) => Number.isFinite(t.pnl) && t.closedAt);
  const o = { mirror: "backend/r24-alpaca-mirror.js (BOOK paper account; graded in percent by its own data/r24-mirror.json, never by this main-account reconcile)",
    ledgerRows: led ? led.length : null, orderRows: led ? led.filter((r) => r.kind === "order").length : null, fillRows: led ? led.filter((r) => r.kind === "fill").length : null,
    symbols: led ? [...new Set(led.map((r) => r.sym).filter(Boolean))].length : null, boardTickets: board.length, boardClosed: closed.length,
    boardClosedPnl: +closed.reduce((a, t) => a + t.pnl, 0).toFixed(2), statusAsOf: (status && (status.asOf || status.updatedAt)) || null };
  o.reading = led == null ? "no r24-mirror-ledger.jsonl" : `${o.orderRows} order row(s), ${o.fillRows} fill row(s) on ${o.symbols} name(s); the board holds ${board.length} R24 ticket(s), ${closed.length} closed ($${o.boardClosedPnl})`;
  return o;
}

/**
 * RECONCILE-PACING 2026-10-14 — ONE limiter for every broker call of the run: a token bucket of `burst` tokens refilled at `perMinute`
 * (in any minute at most burst + perMinute calls start), and a hold that stops every call until a time: a 429's Retry-After, or the
 * account's own window when it is nearly spent. A hold also empties the bucket, so calls restart at the plain rate, not in a burst.
 * take(latest) waits for a token and resolves true, or resolves false at once when the call would start after `latest` (none is made).
 * The clock and the sleep are injected: the run gives performance.now() and setTimeout, the selftest a fake clock.
 */
function makeLimiter({ perMinute = PACE.perMinute, burst = PACE.burst, now, sleep }) {
  const msPer = 60000 / perMinute; let tokens = burst, at = now(), holdUntil = -Infinity;
  const refill = () => { const t = now(); if (t > at) { tokens = Math.min(burst, tokens + (t - at) / msPer); at = t; } };
  return {
    async take(latest = Infinity) {
      for (;;) {
        refill();
        const t = now(), wait = Math.max(holdUntil - t, tokens >= 1 ? 0 : (1 - tokens) * msPer);
        if (t + Math.max(0, wait) > latest) return false;   // no call starts after latest, with or without a wait
        if (wait <= 0) { tokens -= 1; return true; }
        await sleep(Math.max(1, Math.ceil(wait)));
      }
    },
    hold(ms) { const until = now() + Math.max(0, Number(ms) || 0); if (until > holdUntil) { refill(); holdUntil = until; tokens = Math.min(tokens, 0); at = until; } },
  };
}
/** Retry-After as a broker sends it (delay-seconds, or an HTTP date) -> milliseconds, or null when absent or unreadable */
function retryAfterMs(v, wallNow = Date.now()) {
  if (v == null) return null; const s = String(v).trim(); if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const d = Date.parse(s); return Number.isFinite(d) ? Math.max(0, d - wallNow) : null;
}
const header = (res, k) => { try { return res && res.headers && typeof res.headers.get === "function" ? res.headers.get(k) : null; } catch { return null; } };
/** the account's own window as the broker reports it: at or under PACE.reserve calls left, every call waits until it resets (at most 60 s) */
function noteWindow(res, limiter, stats) {
  const leftH = header(res, "x-ratelimit-remaining"); if (leftH == null || String(leftH).trim() === "") return;
  const left = Number(leftH); if (!Number.isFinite(left) || left > PACE.reserve) return;
  const resetH = header(res, "x-ratelimit-reset"), reset = resetH == null || String(resetH).trim() === "" ? NaN : Number(resetH);
  stats.reserveHolds++; limiter.hold(Number.isFinite(reset) ? Math.min(PACE.reserveHoldCapMs, Math.max(0, reset * 1000 - Date.now())) : PACE.reserveHoldCapMs);
}
const errWhy = (e) => String((e && ((e.cause && (e.cause.code || e.cause.message)) || e.code || e.message)) || e).replace(/\s+/g, " ").slice(0, 120);
/**
 * RECONCILE-PACING 2026-10-14 — ONE broker read, paced and retried; it never throws. -> { ok: true, json, tries } on an answer, else
 * { ok: false, httpStatus, why, tries }. httpStatus: the status number (404 = the broker's own "no such order"; a 4xx other than 429 is the
 * broker's answer and is not retried; 401 / 403 also stops every later call of the run), "network" (no answer, or none in time),
 * "unreadable" (a 2xx whose body is not a JSON object), or "not asked" (the budget or the key ran out before a try could start).
 */
async function brokerGet(p, ctx) {
  const { limiter, now, sleep, fetchFn, deadline, stats } = ctx, latest = deadline - PACE.minCallMs, secs = PACE.budgetMs / 1000;
  let last = null;
  for (let i = 1; i <= PACE.tries; i++) {
    if (ctx.stop) return { ok: false, httpStatus: last ? last.httpStatus : "not asked", why: last ? `${last.why}; then ${ctx.stop}` : ctx.stop, tries: i - 1 };
    if (!(await limiter.take(latest))) return { ok: false, httpStatus: last ? last.httpStatus : "not asked", why: last ? `${last.why}; no time left in the run's ${secs} s budget for try ${i}` : `not asked: the run's ${secs} s budget for broker calls was spent`, tries: i - 1 };
    stats.starts.push(now()); if (i > 1) stats.retried++;
    const ms = Math.max(1, Math.min(PACE.callTimeoutMs, Math.ceil(deadline - now()))), ac = new AbortController(), timer = setTimeout(() => ac.abort(), ms);
    let res = null, json, err = null;
    try { res = await fetchFn(BASE + p, { headers: H, signal: ac.signal }); if (res && res.ok) json = await res.json(); }
    catch (e) { err = e; } finally { clearTimeout(timer); }
    if (res) noteWindow(res, limiter, stats);
    const status = res ? Number(res.status) : null;
    let wait = Math.min(PACE.backoffCapMs, PACE.backoffMs * 2 ** (i - 1));
    if (!res) last = { httpStatus: "network", why: ac.signal.aborted ? `no answer within ${Math.round(ms / 1000)} s` : `no answer (${errWhy(err)})` };
    else if (res.ok) {
      if (!err && json && typeof json === "object" && !Array.isArray(json)) return { ok: true, json, tries: i };
      last = ac.signal.aborted ? { httpStatus: "network", why: `${status}, but the answer did not finish within ${Math.round(ms / 1000)} s` } : { httpStatus: "unreadable", why: `${status}, but the answer is not a JSON object` };
    } else if (status === 429) {
      stats.rateLimited++; const ra = retryAfterMs(header(res, "retry-after"));
      limiter.hold(Math.max(wait, ra == null ? 0 : ra)); wait = 0;   // every call waits, not only this one: the account is rate-limited
      last = { httpStatus: 429, why: `429 rate limited${ra == null ? "" : ` (Retry-After ${Math.round(ra / 1000)} s)`}` };
    } else if (status >= 500) last = { httpStatus: status, why: `${status} from the broker` };
    else {   // a 4xx other than 429: the broker's own answer, not retried
      if (status === 401 || status === 403) ctx.stop = `not asked: the account refused the key on an earlier call tonight (${status})`;
      return { ok: false, httpStatus: Number.isFinite(status) ? status : "network", why: status === 404 ? "404: the broker has no order with this id" : `${status} from the broker (not retried)`, tries: i };
    }
    if (i < PACE.tries && wait > 0) { if (now() + wait > latest) return { ok: false, ...last, why: `${last.why}; no time left in the run's ${secs} s budget to try again`, tries: i }; await sleep(wait); }
  }
  return { ok: false, ...last, why: `${last.why} on all ${PACE.tries} tries`, tries: PACE.tries };
}
/** the most call starts inside any 60-second window (half-open) */
function peakPerMinute(ts) { const s = [...ts].sort((a, b) => a - b); let best = 0; for (let i = 0, j = 0; i < s.length; i++) { while (s[i] - s[j] >= 60000) j++; best = Math.max(best, i - j + 1); } return best; }
/**
 * RECONCILE-PACING 2026-10-14 — every broker read of the run, NEWEST mirror row first, each through brokerGet: the entry order and then,
 * only when it filled and the exits log's last row for the ticket is not final with a close quantity and fill, that close order — the
 * calls the loop made before, no more. -> { answers: Map(row -> { entry, close }), calls }
 */
async function askBroker(rows, exitBy, deps = {}) {
  const now = deps.now || (() => performance.now()), sleep = deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms))), fetchFn = deps.fetch || ((u, init) => fetch(u, init));
  const limiter = deps.limiter || makeLimiter({ now, sleep }), t0 = now(), answers = new Map();
  const stats = { starts: [], retried: 0, rateLimited: 0, reserveHolds: 0 }, ctx = { limiter, now, sleep, fetchFn, deadline: t0 + PACE.budgetMs, stats, stop: null };
  let failed = 0, notAsked = 0;
  for (let k = rows.length - 1; k >= 0; k--) {
    const r = rows[k], a = { entry: await brokerGet(`/v2/orders/${r.orderId}?nested=true`, ctx), close: null };
    if (a.entry.ok) {
      const o = a.entry.json, fillPx = Number(o.filled_avg_price) || null, fillQ = Number(o.filled_qty) || 0, x = exitBy.get(r.ticketId);
      if (fillPx && fillQ > 0 && x && !(x.final && Number(x.closeQty) > 0 && Number(x.closeFill) > 0)) a.close = await brokerGet(`/v2/orders/${x.closeOrderId}`, ctx);
    }
    for (const c of [a.entry, a.close]) if (c && !c.ok) { if (c.httpStatus === "not asked") notAsked++; else failed++; }
    answers.set(r, a);
  }
  return { answers, calls: { made: stats.starts.length, retried: stats.retried, rateLimited: stats.rateLimited, reserveHolds: stats.reserveHolds, failed, notAsked, peakPerMinute: peakPerMinute(stats.starts),
    spentSec: +((now() - t0) / 1000).toFixed(1), limit: { perMinute: PACE.perMinute, burst: PACE.burst, maxInAnyMinute: PACE.maxInAnyMinute, tries: PACE.tries, budgetSec: PACE.budgetMs / 1000 } } };
}
/** RECONCILE-PACING 2026-10-14 — on a night with UNKNOWN tickets the reading STARTS with them, whichever line writes it (the W5 era block
 *  writes its own reading): out.reading becomes a property that puts `head` before whatever is assigned to it. */
function sayUnknownFirst(out, head) { let said; Object.defineProperty(out, "reading", { enumerable: true, configurable: true, get: () => head + said, set: (v) => { said = v; } }); }

async function main() {
  if (DRY_AT >= 0 && !dryOutOk()) { console.error("alpaca-reconcile: refusing --dry-print — give it a file OUTSIDE backend/data (the run writes that file and nothing else). Nothing was asked or written."); process.exitCode = 2; return; }
  if (!fs.existsSync(LOG)) { writeJsonAtomic(D("alpaca-reconcile.json"), { spec: "alpaca-reconcile-v1", asOf: new Date().toISOString(), mirrored: 0, note: "nothing mirrored yet" }); console.log("alpaca-reconcile: nothing mirrored yet"); return; }
  const all = fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.orderId);
  // LATE rows (sent long after the ticket's entry — the 2026-09-23 one-off) test the plumbing only: counted, never graded against the ticket.
  const lateRows = all.filter((r) => r.late), rows = all.filter((r) => !r.late);
  const log0 = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8")), ledger = Array.isArray(log0) ? log0 : log0.trades;
  const byId = new Map(ledger.map((t) => [t.id, t]));
  // 2026-10-01: mirror exits (alpaca-mirror.js closes a ticket at market once the board has closed it) are the broker exit when no leg filled
  const EX = D("alpaca-mirror-exits.jsonl"), exitBy = new Map((fs.existsSync(EX) ? fs.readFileSync(EX, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((x) => x.closeOrderId).map((x) => [x.ticketId, x]));
  const out = { spec: "alpaca-reconcile-v1", asOf: new Date().toISOString(), mirrored: rows.length, lateOrdersNotGraded: lateRows.length, filled: 0, unfilled: 0, missingAtBroker: 0, fillGaps: [], fateGaps: [], perTicket: [] };
  // RECONCILE-PACING 2026-10-14: ASK first (askBroker: paced, retried, newest first), then GRADE every row in file order exactly as before.
  // A ticket with a failed call is UNKNOWN as a whole: not filled, not unfilled, not missing, in no gap list.
  const asked = await askBroker(rows, exitBy), U = { unknown: 0, failedCalls: 0 };
  const unknownRow = (r, a, call) => { U.unknown++; U.failedCalls++; out.perTicket.push({ ticketId: r.ticketId, sym: r.sym, reconcileStatus: "UNKNOWN", issue: UNKNOWN_ISSUE, unknownReason: `${call}: ${a.why}`, httpStatus: a.httpStatus, call, tries: a.tries }); };
  for (const r of rows) {
    const A = asked.answers.get(r);
    if (!A || !A.entry.ok) { if (A && A.entry.httpStatus === 404) { U.failedCalls++; out.missingAtBroker++; out.perTicket.push({ ticketId: r.ticketId, sym: r.sym, issue: "broker has no record of this order", httpStatus: 404 }); } else unknownRow(r, A ? A.entry : { why: "internal: no answer kept for this row", httpStatus: "not asked", tries: 0 }, "entry order"); continue; }
    const o = A.entry.json;
    const fill = Number(o.filled_avg_price) || null, fq = Number(o.filled_qty) || 0;   // PAPER-AUCTION-FIX 2026-10-02: the filled quantity, not the ordered one
    if (!fill || !(fq > 0)) { out.unfilled++; out.perTicket.push({ ticketId: r.ticketId, sym: r.sym, brokerStatus: o.status, issue: "never filled" }); continue; }
    if (A.close && !A.close.ok) { unknownRow(r, A.close, "close order"); continue; }   // RECONCILE-PACING 2026-10-14: its exit cannot be priced tonight
    out.filled++;
    const slipPct = r.ticketEntry ? +(100 * (fill / r.ticketEntry - 1) * (r.side === "buy" ? 1 : -1)).toFixed(4) : null;   // positive = we paid worse than the ticket claimed
    if (slipPct != null) out.fillGaps.push(slipPct);
    // PAPER-AUCTION-FIX 2026-10-02: the exit is every fill that took the ticket out, read from filled_qty — bracket legs with filled_qty > 0 whatever
    // their status (a leg partly filled, then cancelled by the mirror's exit pass, counts) plus the mirror's own close orders (the final exits row
    // carries closeQty / closeFill over all of them; otherwise the close order is read). Before, only a leg whose status was "filled" counted.
    const exits = (o.legs || []).filter((l) => Number(l.filled_qty) > 0 && Number(l.filled_avg_price) > 0).map((l) => ({ q: Number(l.filled_qty), px: Number(l.filled_avg_price), why: l.order_type || l.type }));
    if (exitBy.has(r.ticketId)) { const x = exitBy.get(r.ticketId);
      if (x.final && Number(x.closeQty) > 0 && Number(x.closeFill) > 0) exits.push({ q: Number(x.closeQty), px: Number(x.closeFill), why: "mirror-exit (board closed)" });
      else { if (!A.close) throw new Error(`internal: no close-order answer kept for ticket ${r.ticketId}`); const c = A.close.json; if (Number(c.filled_qty) > 0 && Number(c.filled_avg_price) > 0) exits.push({ q: Number(c.filled_qty), px: Number(c.filled_avg_price), why: "mirror-exit (board closed)" }); } }   // RECONCILE-PACING 2026-10-14: the answer askBroker read
    const exQ = exits.reduce((a, e) => a + e.q, 0), exPx = exits.length === 1 ? exits[0].px : exQ > 0 ? exits.reduce((a, e) => a + e.q * e.px, 0) / exQ : null;
    const t = byId.get(r.ticketId);
    const row = { ticketId: r.ticketId, sym: r.sym, side: r.side, qty: fq, ...(fq !== Number(r.qty) ? { qtyOrdered: r.qty } : {}), ticketEntry: r.ticketEntry, brokerFill: fill, slippagePct: slipPct,
      brokerExit: exPx, brokerExitReason: exits.length ? [...new Set(exits.map((e) => e.why))].join(" + ") : null, ...(exQ > 0 && Math.abs(exQ - fq) > 1e-9 ? { brokerExitQty: exQ, exitQtyMismatch: true } : {}),
      ourExit: t && Number.isFinite(t.exit) ? t.exit : null, ourPnl: t && Number.isFinite(t.pnl) ? t.pnl : null, ourReason: t ? t.reason : null };
    if (row.brokerExit != null && row.ourExit != null) {
      const brokerPnl = exits.reduce((a, e) => a + (e.px - fill) * (r.side === "buy" ? 1 : -1) * e.q, 0);   // PAPER-AUCTION-FIX 2026-10-02: each exit fill x its own filled quantity
      row.brokerPnl = +brokerPnl.toFixed(2);
      row.pnlGap = +(brokerPnl - (row.ourPnl ?? 0)).toFixed(2);
      if (Math.abs(row.pnlGap) > Math.max(5, Math.abs(row.ourPnl ?? 0) * 0.1)) out.fateGaps.push({ ticketId: r.ticketId, sym: r.sym, ourPnl: row.ourPnl, brokerPnl: row.brokerPnl, gap: row.pnlGap, ourReason: row.ourReason, brokerExitReason: row.brokerExitReason });
    }
    out.perTicket.push(row);
  }
  out.medianSlippagePct = med(out.fillGaps);
  if (U.unknown) {   // RECONCILE-PACING 2026-10-14: the reading starts with the UNKNOWN tickets (sayUnknownFirst), whichever line writes it
    const by = {}; for (const p of out.perTicket) if (p.reconcileStatus === "UNKNOWN") by[p.httpStatus] = (by[p.httpStatus] || 0) + 1;
    sayUnknownFirst(out, `UNKNOWN: ${U.unknown} of ${rows.length} mirrored ticket(s) have no broker answer tonight (${Object.entries(by).map(([k, v]) => `${k} x${v}`).join(", ")}) — every count here is of the tickets the broker answered for; the next run asks again · `);
  }
  out.reading = !out.filled ? "NOTHING FILLED YET — the mirror has not put a graded order on the broker's book"
    : out.fateGaps.length ? `${out.fateGaps.length} of ${out.filled} filled ticket(s) ended differently at the broker than in our ledger — each one is a defect in our record or in our exit modelling`
    : `broker and ledger agree on every closed ticket so far; median entry slippage ${out.medianSlippagePct}% against the ticket's claimed entry`;
  out.failedCalls = U.failedCalls; out.unknown = U.unknown; out.calls = asked.calls;   // RECONCILE-PACING 2026-10-14: rows with httpStatus, UNKNOWN tickets, the calls
  if (SPLIT) {   // W5 fix 4 of the 10-09 review (docs/server/wave5-board): the stale era apart, R24 counted under its own mirror
    const tsBy = new Map(rows.map((r) => [r.ticketId, String(r.ts || "")])), era = (id) => ((tsBy.get(id) || "") < STALE_BEFORE ? "stale" : "current");
    const agg = (name) => { const pt = out.perTicket.filter((p) => era(p.ticketId) === name), both = pt.filter((p) => Number.isFinite(p.brokerPnl) && Number.isFinite(p.ourPnl));
      return { mirrored: pt.length, filled: pt.filter((p) => p.brokerFill != null).length, unfilled: pt.filter((p) => p.issue === "never filled").length, fateGaps: out.fateGaps.filter((g) => era(g.ticketId) === name).length,
        paired: both.length, brokerPnl: +both.reduce((a, p) => a + p.brokerPnl, 0).toFixed(2), ourPnl: +both.reduce((a, p) => a + p.ourPnl, 0).toFixed(2) }; };
    out.eras = { rule: `stale = mirrored before ${STALE_BEFORE} (no exit pass existed while it was open; the 10-01 catch-up closed them); current = from ${STALE_BEFORE}`, stale: agg("stale"), current: agg("current") };
    out.r24 = r24Summary();
    const c = out.eras.current;
    out.reading = (!c.filled ? "current era: NOTHING FILLED YET" : c.fateGaps ? `current era: ${c.fateGaps} of ${c.filled} filled ticket(s) ended differently at the broker than in our ledger` : `current era: broker and ledger agree on every closed ticket (${c.paired} paired)`)
      + ` · stale era (before ${STALE_BEFORE}): ${out.eras.stale.paired} paired, broker $${out.eras.stale.brokerPnl} vs ours $${out.eras.stale.ourPnl} — reported apart, never pooled · R24 (own mirror): ${out.r24.reading}`;
  }
  writeJsonAtomic(D("alpaca-reconcile.json"), out);
  console.log(`alpaca-reconcile — ${out.filled} filled, ${out.unfilled} unfilled, ${out.missingAtBroker} missing, ${out.unknown} UNKNOWN · ${out.calls.made} broker call(s), ${out.calls.retried} retried, ${out.calls.rateLimited} rate-limited, peak ${out.calls.peakPerMinute} in a minute (limit ${PACE.maxInAnyMinute})${DRY_OUT ? ` · DRY: written to ${DRY_OUT} only` : ""} · ${out.reading}`);
  if (out.unknown) process.exitCode = 3;   // RECONCILE-PACING 2026-10-14: UNKNOWN is never a quiet ok (the chain records exit 3 as a failure; self-heal replays it once)
}
module.exports = { PACE, UNKNOWN_ISSUE, makeLimiter, retryAfterMs, brokerGet, askBroker, peakPerMinute, sayUnknownFirst, noteWindow };
if (require.main === module) main().catch((e) => { console.error("alpaca-reconcile FAILED:", e.message); process.exit(1); });
