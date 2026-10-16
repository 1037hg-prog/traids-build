#!/usr/bin/env node
"use strict";
/** ATTACK 1, step 4. READ-ONLY. Symbol persistence in the board's own band tickets (canonical ledger, stamped 30-100 bps,
 *  equity signals, not sleeves): distinct names, top-name share, band sessions sharing a name with the previous band session,
 *  and the lag-1 autocorrelation of the per-session board P&L. Board P&L only (the mirror's history is too short).
 *    node docs/wide-spread-twin/2026-10-14/attack-1-sims/4-symbol-concentration.cjs                                          */
const fs = require("fs"), path = require("path");
const { ROOT } = require("./_root.cjs");
const REC = require(path.join(ROOT, "backend/lib/reconcile.js"));
const L = REC.cleanEraLedger();
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const tl0 = JSON.parse(fs.readFileSync(path.join(ROOT, "backend/data/trade_log.json"), "utf8")), tl = Array.isArray(tl0) ? tl0 : tl0.trades;
const raw = new Map(tl.map((t) => [t.id, t]));
const band = [];
for (const t of L.signals.filter((x) => x.cls === "Equity" && !x.sleeve)) { const r = raw.get(t.id) || t, s = r.obs && r.obs.spreadBps; if (typeof s === "number" && s >= 30 && s <= 100) band.push({ sym: t.sym, d: etDay(Number(t.openedAt || t.addedAt)), pnl: t.pnl }); }
const ses = [...new Set(band.map((r) => r.d))].sort(), cnt = {}; for (const r of band) cnt[r.sym] = (cnt[r.sym] || 0) + 1;
const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]), share = (k) => (100 * top.slice(0, k).reduce((a, x) => a + x[1], 0) / band.length).toFixed(0);
console.log(`board band tickets ${band.length} over ${ses.length} sessions (${ses[0]} .. ${ses[ses.length - 1]}), ${top.length} names; top: ${top.slice(0, 8).map(([s, c]) => s + " " + c).join(", ")}; top-5 share ${share(5)}%, top-10 ${share(10)}%`);
let shared = 0; for (let i = 1; i < ses.length; i++) { const prev = new Set(band.filter((r) => r.d === ses[i - 1]).map((r) => r.sym)); if (band.some((r) => r.d === ses[i] && prev.has(r.sym))) shared++; }
console.log(`band sessions sharing a name with the previous band session: ${shared} of ${ses.length - 1}`);
const X = ses.map((d) => band.filter((r) => r.d === d).reduce((a, r) => a + r.pnl, 0)), m = X.reduce((a, b) => a + b, 0) / X.length;
let num = 0, den = 0; for (let i = 0; i < X.length; i++) { den += (X[i] - m) ** 2; if (i) num += (X[i] - m) * (X[i - 1] - m); }
console.log(`lag-1 autocorrelation of the per-session board P&L of the band: ${(num / den).toFixed(3)} (n ${X.length}; se about ${(1 / Math.sqrt(X.length)).toFixed(2)})`);
