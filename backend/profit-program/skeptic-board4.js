#!/usr/bin/env node
"use strict";
/**
 * SKEPTIC 4 - what did the unstamped entry days let through? READ-ONLY.
 * The stamp gap is all-or-nothing by entry day (skeptic-board3.js [12]); automation/daily-run.log prints "NBBO coverage: 0 of N" on those days and tracks anyway.
 * This prices the UNSTAMPED regime equity signals (R24 sleeve apart) at the consolidated NBBO at openedAt, pulled as HISTORICAL quotes
 * (market data GET only; no orders, no broker writes), into the same cache skeptic-nbbo.js uses. Re-runs are offline.
 *   node backend/profit-program/skeptic-board4.js
 */
const path = require("path"), fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const C = require("./_common.js");
const { $, f, pad, lpad, mean, sum, median } = C;
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const CACHE = path.join(C.OUT_DIR, "skeptic-nbbo-cache.json");
let cache = {}; try { cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch (e) { cache = {}; }
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const HEAD = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
let calls = 0, fails = 0;
async function lastQuote(sym, atMs, feed, backMs) {
  const key = sym + "|" + atMs + "|" + feed;
  if (cache[key] !== undefined) return cache[key];
  const qs = new URLSearchParams({ start: new Date(atMs - backMs).toISOString(), end: new Date(atMs).toISOString(), feed, limit: "1", sort: "desc" });
  for (let k = 0; k !== 4; k++) {
    try {
      await nap(330); calls++;
      const r = await fetch("https://data.alpaca.markets/v2/stocks/" + encodeURIComponent(sym) + "/quotes?" + qs.toString(), { headers: HEAD });
      if (r.status === 429) { await nap(4000 * (k + 1)); continue; }
      if (!r.ok) { fails++; cache[key] = { err: r.status }; return cache[key]; }
      const j = await r.json(); const q = (j.quotes || [])[0];
      cache[key] = q ? { bp: q.bp, ap: q.ap, t: q.t } : { none: true };
      return cache[key];
    } catch (e) { await nap(1500); }
  }
  fails++; return { err: "net" };
}
const bps = (q) => (q && q.bp > 0 && q.ap > q.bp ? (q.ap - q.bp) / ((q.ap + q.bp) / 2) * 1e4 : NaN);
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
(async () => {
  const B = C.laneBoard(), MONTH = 21;
  const st = (t) => t.obs && Number.isFinite(t.obs.spreadBps);
  const reg = B.sig.filter((t) => t._day >= C.REGIME_START);
  const sessions = new Set(reg.map((t) => t._day)).size;
  const un = reg.filter((t) => t.cls === "Equity" && t.strategy !== "R24-13F-clone" && !st(t));
  console.log("SKEPTIC 4 - unstamped regime equity signals (ex R24): " + un.length + "; regime sessions " + sessions);
  for (const t of un) t._sip = bps(await lastQuote(t.sym, t.openedAt, "sip", 120e3));
  writeJsonAtomic(CACHE, cache);
  console.log("   network calls this run " + calls + ", failures " + fails);
  const ok = un.filter((t) => Number.isFinite(t._sip)), pr = ok.filter((t) => Number.isFinite(t._notional));
  console.log("\n[1] consolidated NBBO at openedAt recovered for " + ok.length + " of " + un.length + " (with a notional " + pr.length + "); median " + median(ok.map((t) => t._sip)).toFixed(1) + " bps, mean " + mean(ok.map((t) => t._sip)).toFixed(1));
  const band = (lab, rs) => {
    const p = rs.filter((t) => Number.isFinite(t._notional));
    const c = sum(p.map((t) => t._sip / 1e4 * t._notional)), g = sum(p.map((t) => t.pnl));
    console.log("   " + lpad(lab, 34) + " n " + pad(rs.length, 3) + " (priced " + pad(p.length, 3) + ")  gross " + pad($(g), 7) + "  full-spread cost " + pad($(-c), 7) + "  net " + pad($(g - c), 7) + "  | per month over " + sessions + " sessions: cost " + pad($(c / sessions * MONTH), 6) + " full, " + pad($(c / 2 / sessions * MONTH), 6) + " half; gross " + pad($(g / sessions * MONTH), 6));
    return { n: rs.length, cost: c, gross: g };
  };
  console.log("\n[2] WHAT R49 WOULD HAVE REFUSED (NBBO above 100 bps at entry) AND WHAT THE 30 bps LINE WOULD HAVE REFUSED, among tickets that went through unstamped");
  const a = band("NBBO above 100 bps (R49 line)", ok.filter((t) => t._sip > 100));
  const b = band("NBBO above 30 bps", ok.filter((t) => t._sip > 30));
  band("NBBO at or below 30 bps", ok.filter((t) => 30 >= t._sip));
  band("all recovered", ok);
  const w = ok.filter((t) => t._sip > 100).sort((x, y) => y._sip - x._sip);
  console.log("   the above-100 tickets: " + w.map((t) => etDay(t.openedAt).slice(5) + " " + t.sym + " " + t.strategy.slice(0, 3) + " " + t._sip.toFixed(0) + "bps " + $(t.pnl)).join("; "));
  console.log("\n[3] BY ENTRY DAY");
  const days = [...new Set(ok.map((t) => etDay(t.openedAt)))].sort();
  for (const d of days) { const r = ok.filter((t) => etDay(t.openedAt) === d); console.log("   " + d + " (" + new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }) + ") n " + pad(r.length, 3) + "  median NBBO " + pad(median(r.map((t) => t._sip)).toFixed(0), 4) + " bps  above 100: " + pad(r.filter((t) => t._sip > 100).length, 2) + "  above 30: " + pad(r.filter((t) => t._sip > 30).length, 2) + "  gross " + pad($(sum(r.map((t) => t.pnl))), 7)); }
  C.write("skeptic-board4.json", { spec: "skeptic-board4-v1", asOf: new Date().toISOString(), unstamped: un.length, recovered: ok.length, above100: a, above30: b, sessions });
})().catch((e) => { console.error("FAILED", e.message); process.exit(1); });
