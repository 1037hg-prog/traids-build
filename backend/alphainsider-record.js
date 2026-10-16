#!/usr/bin/env node
/**
 * ALPHAINSIDER RECORDER — READ-ONLY, through the official API (2026-09-24, operator: "key added" / "key replaced").
 * AlphaInsider's terms forbid collecting site content by automated means, so this uses ONLY the documented API with the operator's own
 * token (ALPHAINSIDER_KEY in backend/.env; never printed, never logged), at a polite pace, and ONLY the read endpoints in ALLOW below —
 * whatever scopes the token carries, this file cannot place an order, touch a bot, subscribe, post or pay.
 *
 * What it keeps (data/alphainsider/, dated, never rewritten):
 *   strategies-<day>.json   every public strategy (enumerated by sort=newest): name, owner, type, created, price, subscriber_count,
 *                           categories, timeframes (their own performance fields as served that day)
 *   values-<day>.json       each strategy's current normalized value (strategy_value) — our own dated NAV record
 *   ranks-<day>.json        the first 100 of each ranking (top / performance / popular / trending) for month and year — what the
 *                           marketplace was SHOWING that day, so "does the showcase predict?" can be tested without hindsight
 *   timelines/<id>.jsonl    each strategy's timestamped trade events (with strategy_value at the trade) — incremental, deduped by
 *                           timeline_id; the first nights backfill history within a call budget
 *   state.json              cursors
 *   node backend/alphainsider-record.js [--budget=N]     (default 900 calls a night, ~1 call/second)
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const TOKEN = process.env.ALPHAINSIDER_KEY || process.env.ALPHAINSIDER_API_KEY;
const DIR = path.join(__dirname, "data", "alphainsider"), TL = path.join(DIR, "timelines");
for (const d of [DIR, TL]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
const BUDGET = +((process.argv.find((a) => a.startsWith("--budget=")) || "").split("=")[1] || 900);
const ALLOW = new Set(["searchStrategies", "getStrategyValues", "getStrategyTimelines"]);   // read-only, by construction
const day = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
async function call(op, { query = "", body = null } = {}) {
  if (!ALLOW.has(op)) throw new Error(`refused: ${op} is not a read endpoint on the allowlist`);
  if (calls >= BUDGET) throw Object.assign(new Error("budget"), { budget: true });
  calls++; await sleep(1000);
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://alphainsider.com/api/${op}${query}`, { method: body ? "POST" : "GET", headers: { Authorization: TOKEN, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    if (r.status === 429) { await sleep(60000); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(`${op} ${r.status} ${typeof j.response === "string" ? j.response.slice(0, 80) : ""}`);
    return j.response;
  }
  throw new Error(`${op} rate-limited three times — stopping`);
}
const stateF = path.join(DIR, "state.json"), state = fs.existsSync(stateF) ? JSON.parse(fs.readFileSync(stateF, "utf8")) : { backfill: {}, lastTimelineAt: {} };
const saveState = () => { state.asOf = new Date().toISOString(); writeJsonAtomic(stateF, state); };

(async () => {
  if (!TOKEN) throw new Error("ALPHAINSIDER_KEY not set in backend/.env");
  const out = { calls: 0, errors: [] };
  // 1. enumerate every public strategy (once per day)
  const sf = path.join(DIR, `strategies-${day}.json`);
  let strategies = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")).strategies : null;
  if (!strategies) {
    strategies = []; let offset_id; const seen = new Set();
    for (;;) { const page = await call("searchStrategies", { body: { sort: "newest", limit: 100, ...(offset_id ? { offset_id } : {}) } }); const fresh = page.filter((s) => !seen.has(s.strategy_id)); fresh.forEach((s) => seen.add(s.strategy_id)); strategies.push(...fresh.map(({ description, ...s }) => s)); if (page.length < 100 || !fresh.length) break; offset_id = page[page.length - 1].strategy_id; }
    writeJsonAtomic(sf, { day, recordedAt: new Date().toISOString(), n: strategies.length, strategies });
  }
  const ids = strategies.map((s) => s.strategy_id);
  // 2. values for every strategy (the API rejects URLs past ~25 ids)
  const vf = path.join(DIR, `values-${day}.json`);
  if (!fs.existsSync(vf)) { const values = {}; for (let i = 0; i < ids.length; i += 25) { const q = "?" + ids.slice(i, i + 25).map((x) => "strategy_id[]=" + encodeURIComponent(x)).join("&"); for (const v of await call("getStrategyValues", { query: q })) values[v.strategy_id] = +v.strategy_value; } writeJsonAtomic(vf, { day, recordedAt: new Date().toISOString(), values }); }
  // 3. what the marketplace showed today
  const rf = path.join(DIR, `ranks-${day}.json`);
  if (!fs.existsSync(rf)) { const ranks = {}; for (const sort of ["top", "performance", "popular", "trending"]) for (const timeframe of ["month", "year"]) ranks[`${sort}:${timeframe}`] = (await call("searchStrategies", { body: { sort, timeframe, limit: 100 } })).map((s, k) => ({ rank: k + 1, id: s.strategy_id, subs: s.subscriber_count })); writeJsonAtomic(rf, { day, recordedAt: new Date().toISOString(), ranks }); }
  // 4. trade timelines. (a) INCREMENTAL for strategies already backfilled: 25 ids a call, only events since the last run.
  const appendEvents = (events) => { const by = {}; for (const e of events) (by[e.strategy_id] = by[e.strategy_id] || []).push(e);
    for (const [sid, evs] of Object.entries(by)) { const f = path.join(TL, `${sid}.jsonl`), have = new Set(fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).timeline_id) : []);
      const fresh = evs.filter((e) => !have.has(e.timeline_id)); if (fresh.length) fs.appendFileSync(f, fresh.map((e) => JSON.stringify({ timeline_id: e.timeline_id, at: e.created_at, ...e.data })).join("\n") + "\n"); } };
  const since = state.lastIncrementalAt || null, runStart = new Date().toISOString();
  try {
    if (since) {
      const done = ids.filter((id) => state.backfill[id]);
      for (let i = 0; i < done.length; i += 25) {
        let offset_id;
        for (;;) {
          const q = "?" + done.slice(i, i + 25).map((x) => "strategy_id[]=" + encodeURIComponent(x)).join("&") + `&type[]=trade&start_date=${encodeURIComponent(since)}&limit=100${offset_id ? `&offset_id=${encodeURIComponent(offset_id)}` : ""}`;
          const page = await call("getStrategyTimelines", { query: q }); appendEvents(page);
          if (page.length < 100) break; offset_id = page[page.length - 1].timeline_id;
        }
      }
    }
    state.lastIncrementalAt = runStart;
  } catch (e) { if (!e.budget) out.errors.push(e.message); }
  // (b) BACKFILL full history for strategies not yet done, one at a time, within the remaining budget
  try {
    // backfill order: best 1-year performance rank first (the names people would actually follow), then the rest
    const perfRank = (sid) => { const st = strategies.find((x) => x.strategy_id === sid); const y = st && (st.timeframes || []).find((t) => t.timeframe === "year"); return y ? +y.rank_performance : 1e9; };
    for (const id of ids.filter((x) => !state.backfill[x]).sort((p, q) => perfRank(p) - perfRank(q))) {
      const f = path.join(TL, `${id}.jsonl`), have = new Set(fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).timeline_id) : []);
      // FIX 2026-09-24 (R188 builder's finding): a budget stop mid-history used to leave the strategy half-done, and the next night stopped
      // at the first row it already held and marked it complete without its OLDEST trades. Now the pagination cursor is saved after every
      // page (state.backfillCursor) and resumed, and a strategy is marked done only when the API returns a short (final) page.
      state.backfillCursor = state.backfillCursor || {};
      let offset_id = state.backfillCursor[id], added = 0;
      for (;;) {
        const q = `?strategy_id[]=${encodeURIComponent(id)}&type[]=trade&limit=100${offset_id ? `&offset_id=${encodeURIComponent(offset_id)}` : ""}`;
        const page = await call("getStrategyTimelines", { query: q });
        const fresh = page.filter((e) => !have.has(e.timeline_id));
        if (fresh.length) { fs.appendFileSync(f, fresh.map((e) => JSON.stringify({ timeline_id: e.timeline_id, at: e.created_at, ...e.data })).join("\n") + "\n"); fresh.forEach((e) => have.add(e.timeline_id)); added += fresh.length; }
        if (page.length < 100) break;   // the end of history
        offset_id = page[page.length - 1].timeline_id; state.backfillCursor[id] = offset_id; saveState();
      }
      delete state.backfillCursor[id];
      state.backfill[id] = true; if (added) state.lastTimelineAt[id] = new Date().toISOString();
    }
  } catch (e) { if (!e.budget) out.errors.push(e.message); }
  saveState();
  const done = ids.filter((id) => state.backfill[id]).length;
  console.log(`alphainsider ${day}: ${ids.length} public strategies · values recorded · ranks recorded · timelines backfilled ${done}/${ids.length} · ${calls} calls${out.errors.length ? " · ERRORS " + out.errors.join("; ") : ""}`);
  if (out.errors.length) process.exit(1);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
