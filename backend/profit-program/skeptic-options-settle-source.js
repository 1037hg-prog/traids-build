#!/usr/bin/env node
"use strict";
/**
 * SKEPTIC (options-premium lane): is the price every wing is GRADED at the price an exchange would settle it at?
 * options-settle.js grades a wing at lib/alpaca-bars.js fetchBars() 1Day close with the module defaults: feed "iex", adjustment "all".
 * That is the last IEX print of the day, not the consolidated (SIP) official close a clearing house uses to exercise a short leg.
 * Read-only. For every expiry-settled R25 and R21 signal wing: the recorded obs.settleUnder beside the SIP RAW daily close and the IEX RAW
 * daily close of the expiry date (market-data GETs only, cached under bars-cache/); the ledger P&L re-derived (known-answer: it must
 * reproduce the ledger to the cent at the recorded price) and re-priced at the SIP close.
 *   node backend/profit-program/skeptic-options-settle-source.js
 * Writes backend/data/profit-program/skeptic-options-settle-source.json
 */
const fs = require("fs"), path = require("path");
const C = require("./_opt-common.js");
const B = require("./_opt-bars.js");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const { $, f } = C;
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

async function daily(feed, syms, from, to) {
  const file = path.join(B.CACHE, `skeptic-daily-${feed}-raw-${from}-${to}.json`);
  let have = {}; try { have = JSON.parse(fs.readFileSync(file, "utf8")).closes || {}; } catch {}
  const need = syms.filter((s) => !(s in have));
  for (let i = 0; i < need.length; i += 40) {
    const chunk = need.slice(i, i + 40), got = {}; let token = null;
    do {
      const q = new URLSearchParams({ symbols: chunk.join(","), timeframe: "1Day", start: from, end: to, limit: "10000", feed, adjustment: "raw" }); if (token) q.set("page_token", token);
      const j = await B.getJson(`https://data.alpaca.markets/v2/stocks/bars?${q}`);
      for (const [s, a] of Object.entries(j.bars || {})) for (const b of a) (got[s] ||= {})[b.t.slice(0, 10)] = b.c;
      token = j.next_page_token || null;
    } while (token);
    for (const s of chunk) have[s] = got[s] || {};
  }
  if (need.length) writeJsonAtomic(file, { spec: "skeptic-daily-raw-v1", feed, adjustment: "raw", from, to, fetchedAt: new Date().toISOString(), closes: have }, { pretty: 0 });
  return have;
}
const usd = (v, d = 3) => "$" + v.toFixed(d);

(async () => {
  const L = C.ledger();
  const W = L.signals.filter((t) => (C.isR25(t) || C.isR21(t)) && t.reason === "expiry" && t.obs && Number.isFinite(t.obs.settleUnder));
  const syms = [...new Set(W.map((t) => t.sym))].sort();
  const from = "2026-07-20", to = "2026-10-09";
  const sip = await daily("sip", syms, from, to), iex = await daily("iex", syms, from, to);
  const rows = [];
  let ka = 0;
  for (const t of W) {
    const o = t.obs, n = t.contracts || 1, K = +o.shortK, Wd = o.width, d = String(o.optExpiry);
    const cost = (S) => (o.optCall ? clamp(S - K, 0, Wd) : clamp(K - S, 0, Wd));
    const pnlAt = (S) => (t.entry - cost(S)) * 100 * n - 1.3 * n;
    if (Math.abs(pnlAt(o.settleUnder) - t.pnl) < 0.011) ka++;
    const s = sip[t.sym] ? sip[t.sym][d] : undefined, x = iex[t.sym] ? iex[t.sym][d] : undefined;
    rows.push({ id: t.id, sleeve: t.strategy, sym: t.sym, day: d, n, call: !!o.optCall, K, width: Wd, rec: o.settleUnder, sip: s ?? null, iex: x ?? null,
      pnl: t.pnl, pnlSip: Number.isFinite(s) ? pnlAt(s) : null, entryDay: C.etDay(t.openedAt) });
  }
  console.log("SETTLE SOURCE CHECK: " + W.length + " expiry-settled wings (R25 " + W.filter(C.isR25).length + ", R21 " + W.filter(C.isR21).length + "), " + syms.length + " underlyings");
  console.log("known-answer: (credit - intrinsic at the RECORDED settle price) x 100 x n - 1.30 x n reproduces the ledger P&L on " + ka + " of " + W.length + " wings\n");
  const out = { label: "SKEPTIC instrument check", knownAnswer: { reproduced: ka, of: W.length }, sleeves: {} };
  for (const [lab, pred] of [["R25-0dte", (r) => r.sleeve === "R25-0dte"], ["R21-premium", (r) => r.sleeve === "R21-premium"]]) {
    const R = rows.filter(pred), ok = R.filter((r) => r.sip != null);
    const eqIex = ok.filter((r) => r.iex != null && Math.abs(r.rec - r.iex) < 0.0051).length, eqSip = ok.filter((r) => Math.abs(r.rec - r.sip) < 0.0051).length;
    const ad = ok.map((r) => Math.abs(r.rec - r.sip)).sort((a, b) => a - b), q = (p) => ad[Math.min(ad.length - 1, Math.floor(p * ad.length))];
    const ch = ok.filter((r) => Math.abs(r.pnlSip - r.pnl) > 0.5), flip = ok.filter((r) => (r.pnl > 0) !== (r.pnlSip > 0));
    const dSum = C.sum(ok.map((r) => r.pnlSip - r.pnl));
    const s = C.bySession(ok, (r) => r.pnlSip - r.pnl, (r) => r.day);
    const up = ch.filter((r) => r.pnlSip > r.pnl), dn = ch.filter((r) => r.pnlSip < r.pnl);
    console.log("== " + lab + ": " + R.length + " wings, SIP close found for " + ok.length);
    console.log("   recorded settle price equals the IEX raw close (within half a cent) on " + eqIex + "; equals the SIP official close on " + eqSip);
    console.log("   |recorded - SIP close|: median " + usd(q(0.5)) + ", 90th pct " + usd(q(0.9)) + ", max " + usd(ad[ad.length - 1]) + "; mean signed (recorded - SIP) " + C.mean(ok.map((r) => r.rec - r.sip)).toFixed(4));
    console.log("   wings whose P&L changes at the SIP close: " + ch.length + " (" + up.length + " better " + $(C.sum(up.map((r) => r.pnlSip - r.pnl))) + ", " + dn.length + " worse " + $(C.sum(dn.map((r) => r.pnlSip - r.pnl))) + "); net " + $(dSum) + "; win/loss flips " + flip.length);
    console.log("   by expiry session: " + s.n + " sessions, mean " + $(s.meanPerSession) + "/session, session t " + f(s.t) + "; ledger total " + $(C.sum(ok.map((r) => r.pnl))) + " -> at the SIP close " + $(C.sum(ok.map((r) => r.pnlSip))));
    if (lab === "R25-0dte") {
      const four = ok.filter((r) => r.n === 4 && r.entryDay >= "2026-09-14"), s4 = C.bySession(four, (r) => r.pnlSip - r.pnl, (r) => r.day);
      console.log("   4-contract era: " + four.length + " wings, " + s4.n + " sessions: ledger " + $(C.sum(four.map((r) => r.pnl))) + " -> at the SIP close " + $(C.sum(four.map((r) => r.pnlSip))) + "; difference " + $(C.sum(s4.sums)) + " = " + $(s4.meanPerSession * 21) + "/month (t " + f(s4.t) + ")");
      out.fourContractEra = { wings: four.length, sessions: s4.n, ledger: C.sum(four.map((r) => r.pnl)), atSip: C.sum(four.map((r) => r.pnlSip)), perMonth: s4.meanPerSession * 21, t: s4.t };
    }
    const big = ch.slice().sort((a, b) => Math.abs(b.pnlSip - b.pnl) - Math.abs(a.pnlSip - a.pnl)).slice(0, 8);
    for (const r of big) console.log("      " + r.day + " " + r.sym.padEnd(5) + " " + (r.call ? "C" : "P") + " short " + r.K + " width " + r.width + " x" + r.n + ": recorded " + r.rec + " | SIP " + r.sip + " | IEX " + r.iex + "  ledger " + $(r.pnl) + " -> " + $(r.pnlSip));
    out.sleeves[lab] = { wings: R.length, withSip: ok.length, equalsIex: eqIex, equalsSip: eqSip, medianAbsDiff: q(0.5), p90AbsDiff: q(0.9), maxAbsDiff: ad[ad.length - 1], changed: ch.length, flips: flip.length, netDelta: dSum, sessionT: s.t,
      ledger: C.sum(ok.map((r) => r.pnl)), atSip: C.sum(ok.map((r) => r.pnlSip)) };
    console.log();
  }
  const r25 = rows.filter((r) => r.sleeve === "R25-0dte" && r.sip != null);
  const within = (c) => r25.filter((r) => Math.abs(r.sip - r.K) <= c).length;
  console.log("R25 pin zone: SIP close within 0.10 of the short strike on " + within(0.10) + " of " + r25.length + " wings, within 0.25 on " + within(0.25) + ", within 0.50 on " + within(0.5));
  out.pinZone = { n: r25.length, within10c: within(0.10), within25c: within(0.25), within50c: within(0.5) };
  console.log("\nwrote " + C.writeOut("skeptic-options-settle-source.json", out));
})().catch((e) => { console.error("FAILED: " + e.stack); process.exitCode = 1; });
