#!/usr/bin/env node
"use strict";
/**
 * SKEPTIC NBBO - is the stamped obs.spreadBps the consolidated NBBO a real order would cross, or a single-venue (IEX) book?
 * READ-ONLY. Pulls HISTORICAL quotes (market data GET only; no orders, no broker writes) from Alpaca for every stamped regime equity signal:
 *   sip@open  = last consolidated quote at or before the ticket openedAt
 *   iex@open  = last IEX quote at or before openedAt
 *   sip@close = last consolidated quote at or before closedAt (prices the exit crossing, which the ledger and the analyst never measured)
 * Cache: backend/data/profit-program/skeptic-nbbo-cache.json (re-runs are offline). Output: skeptic-nbbo.json.
 *   node backend/profit-program/skeptic-nbbo.js
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
(async () => {
  const B = C.laneBoard();
  const st = (t) => t.obs && Number.isFinite(t.obs.spreadBps);
  const eq = B.sig.filter((t) => t._day >= C.REGIME_START && t.cls === "Equity" && Number.isFinite(t._notional) && Number.isFinite(t._risk) && st(t));
  if (process.env.SK_LIMIT) eq.splice(0, Math.max(0, eq.length - Number(process.env.SK_LIMIT)));   // probe mode: last N tickets only
  console.log(`SKEPTIC NBBO - ${eq.length} stamped regime equity signals; pulling sip@open, iex@open, sip@close (cached calls are free)`);
  let i = 0;
  for (const t of eq) {
    t._sipO = await lastQuote(t.sym, t.openedAt, "sip", 120e3);
    t._iexO = await lastQuote(t.sym, t.openedAt, "iex", 900e3);
    t._sipC = await lastQuote(t.sym, t.closedAt, "sip", 120e3);
    i++; if (i % 50 === 0) { writeJsonAtomic(CACHE, cache); console.error("   ..." + i + " tickets, " + calls + " calls, " + fails + " fails"); }
  }
  writeJsonAtomic(CACHE, cache);
  console.log(`   network calls this run ${calls}, failures ${fails}`);
  for (const t of eq) { t._stamp = t.obs.spreadBps; t._sip = bps(t._sipO); t._iex = bps(t._iexO); t._sipX = bps(t._sipC); }
  const ok = eq.filter((t) => Number.isFinite(t._sip));
  const okI = eq.filter((t) => Number.isFinite(t._iex));
  const okX = eq.filter((t) => Number.isFinite(t._sipX));
  console.log(`\n[1] COVERAGE: sip@open ${ok.length}/${eq.length}, iex@open ${okI.length}/${eq.length}, sip@close ${okX.length}/${eq.length}`);
  const both = eq.filter((t) => Number.isFinite(t._sip) && Number.isFinite(t._iex));
  const med = (rows, fn) => median(rows.map(fn)).toFixed(1), avg = (rows, fn) => mean(rows.map(fn)).toFixed(1);
  const fS = (t) => t._stamp, fI = (t) => t._iex, fP = (t) => t._sip, fX = (t) => t._sipX;
  console.log(`\n[2] WHICH BOOK IS THE STAMP? (tickets with both feeds: ${both.length})`);
  console.log(`   median spread bps: stamp ${med(both, fS)} | IEX quote ${med(both, fI)} | consolidated (SIP) NBBO ${med(both, fP)}`);
  console.log(`   mean   spread bps: stamp ${avg(both, fS)} | IEX quote ${avg(both, fI)} | consolidated (SIP) NBBO ${avg(both, fP)}`);
  const near = (a, b) => Math.abs(a - b) / Math.max(a, b, 0.5) - 0.25 > 0 ? false : true;
  const exact = (t, q) => q && Math.abs(q.bp - t.obs.bidAtEntry) + Math.abs(q.ap - t.obs.askAtEntry) === 0;
  const nNearI = both.filter((t) => near(t._stamp, t._iex)).length, nNearS = both.filter((t) => near(t._stamp, t._sip)).length;
  const nExI = both.filter((t) => exact(t, t._iexO)).length, nExS = both.filter((t) => exact(t, t._sipO)).length;
  console.log(`   stamp within 25% of the IEX quote: ${nNearI}; within 25% of the SIP NBBO: ${nNearS}; exact bid+ask match IEX: ${nExI}, exact match SIP: ${nExS}`);
  console.log(`   median ratio stamp / SIP NBBO: ${median(both.map((t) => t._stamp / t._sip)).toFixed(2)}; median ratio IEX / SIP: ${median(both.map((t) => t._iex / t._sip)).toFixed(2)}`);
  console.log(`\n[3] THE 30 bps LINE ON THE REAL NBBO (tickets with sip@open: ${ok.length})`);
  const wide = ok.filter((t) => t._stamp > 30), nar = ok.filter((t) => 30 >= t._stamp);
  const wS = wide.filter((t) => t._sip > 30).length, nS = nar.filter((t) => t._sip > 30).length;
  console.log(`   stamped above 30 bps: ${wide.length} tickets; their SIP NBBO at entry: median ${med(wide, fP)} bps, mean ${avg(wide, fP)}; of them SIP above 30 bps: ${wS} (${(wS / wide.length * 100).toFixed(0)}%)`);
  console.log(`   stamped at or below 30 bps: ${nar.length} tickets; their SIP NBBO at entry: median ${med(nar, fP)} bps, mean ${avg(nar, fP)}; of them SIP above 30 bps: ${nS}`);
  const sess = new Set(eq.map((t) => t._day)).size, MONTH = 21;
  const cost = (rows, fn) => sum(rows.map((t) => fn(t) / 1e4 * t._notional));
  const mo = (v, s) => $(v / s * MONTH);
  console.log(`\n[4] DOLLARS: cost of the regime stamped equity book priced three ways (${ok.length} tickets with sip@open, ${sess} sessions; month = ${MONTH} sessions)`);
  const cSa = -cost(ok, fS), cSw = -cost(wide, fS), cPa = -cost(ok, fP), cPw = -cost(wide, fP);
  console.log(`   full round trip at the STAMP (analyst):       all ${$(cSa)} (${mo(cSa, sess)}/month); the stamped-above-30 set ${$(cSw)} (${mo(cSw, sess)}/month)`);
  console.log(`   full round trip at the SIP NBBO at entry:     all ${$(cPa)} (${mo(cPa, sess)}/month); the stamped-above-30 set ${$(cPw)} (${mo(cPw, sess)}/month)`);
  const rt = ok.filter((t) => Number.isFinite(t._sipX));
  const rtCost = (rows) => -sum(rows.map((t) => (t._sip / 2 + t._sipX / 2) / 1e4 * t._notional));
  const rtW = rt.filter((t) => t._stamp > 30);
  console.log(`   MEASURED round trip = half SIP spread at entry + half SIP spread at exit (${rt.length} tickets with both): all ${$(rtCost(rt))} (${mo(rtCost(rt), sess)}/month); the stamped-above-30 set (${rtW.length}) ${$(rtCost(rtW))} (${mo(rtCost(rtW), sess)}/month); same tickets at the stamp: all ${$(-cost(rt, fS))}, above-30 set ${$(-cost(rtW, fS))}`);
  console.log(`   SIP spread at exit: median ${med(rt, fX)} bps, mean ${avg(rt, fX)} (entry: median ${med(rt, fP)}, mean ${avg(rt, fP)})`);
  for (const d0 of ["2026-09-04", "2026-09-25"]) {
    const r2 = rt.filter((t) => t._day >= d0), w2 = r2.filter((t) => t._stamp > 30), s2 = new Set(eq.filter((t) => t._day >= d0).map((t) => t._day)).size;
    const sipWide = r2.filter((t) => t._sip > 30);
    console.log(`   closed >= ${d0} (${r2.length} tickets, ${s2} sessions): measured SIP round trip all ${$(rtCost(r2))} = ${mo(rtCost(r2), s2)}/month; stamped-above-30 set (${w2.length}) ${$(rtCost(w2))} = ${mo(rtCost(w2), s2)}/month vs at the stamp ${mo(-cost(w2, fS), s2)}/month; tickets with SIP NBBO above 30 bps at entry: ${sipWide.length}, their SIP round trip ${mo(rtCost(sipWide), s2)}/month`);
  }
  console.log(`\n[5] BY SESSION: median stamp vs median IEX vs median SIP NBBO at entry (a day where the stamp sits on the SIP is a day the quote source was a consolidated one)`);
  const dOf = (t) => new Date(t.openedAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const days = [...new Set(both.map(dOf))].sort();
  for (const d of days) { const r = both.filter((t) => dOf(t) === d); console.log("   " + d + " n " + pad(r.length, 3) + "  stamp " + pad(med(r, fS), 6) + "  IEX " + pad(med(r, fI), 6) + "  SIP " + pad(med(r, fP), 6)); }
  C.write("skeptic-nbbo.json", { spec: "skeptic-nbbo-v1", asOf: new Date().toISOString(), n: eq.length, sipOpen: ok.length, iexOpen: okI.length, sipClose: okX.length, medStamp: median(both.map(fS)), medIex: median(both.map(fI)), medSip: median(both.map(fP)), costStampAll: cSa, costSipAll: cPa, rtSipAll: rtCost(rt), rtSipWide: rtCost(rtW), costStampWide: cSw });
})().catch((e) => { console.error("FAILED", e.message); process.exit(1); });
