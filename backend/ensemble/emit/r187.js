#!/usr/bin/env node
"use strict";
/**
 * Emitter — R187 AlphaInsider crypto TradingView scripts (5 verified translations) -> R187-MULTIOSC, R187-TRIPLE, R187-DMIDPO,
 * R187-STEALTHY7, R187-LOHAS.
 * backend/r187-ai-crypto-scripts.js IS require-safe: its main is wrapped in `if (require.main === module)` (line 293) and the
 * top level only defines functions/constants; module.exports (line 345) gives SCRIPTS, hourly, agg, TF, account, assetDays, stat.
 * hourly() reads the cached Coinbase hourly files (it would fetch only if data/r187-*.json were missing — they exist; checked below).
 * recorded() (lines 213-222) is not exported: COPIED verbatim to recompute AlphaInsider's median leverage from the trade logs,
 * and checked against the leverageUsed persisted in data/r187-ai-crypto-scripts.json.
 */
const fs = require("fs"), path = require("path");
const { writeEntry, writeUnavailable } = require("../lib-entry.js");
const DATA = path.join(__dirname, "..", "..", "data"), D = (f) => path.join(DATA, f);
for (const f of ["r187-eth-coinbase-hourly.json", "r187-btc-coinbase-hourly-ext.json", "r153-btc-coinbase-hourly.json", "r155-btc-coinbase-hourly-ext.json"]) if (!fs.existsSync(D(f))) throw new Error(`missing ${f} — refusing (the module would fetch)`);
const R = require("../../r187-ai-crypto-scripts.js");
const OOS_END = "2025-09-23";

// ---- copied verbatim from backend/r187-ai-crypto-scripts.js lines 213-222 ----
function recorded(id) {
  const L = fs.readFileSync(D(`alphainsider/timelines/${id}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .sort((a, b) => a.at.localeCompare(b.at) || (+a.timeline_id) - (+b.timeline_id));
  const groups = []; for (const e of L) { const g = groups[groups.length - 1]; if (g && Date.parse(e.at) - Date.parse(g.last.at) <= 120e3) { g.events.push(e); g.last = e; } else groups.push({ at: e.at, events: [e], last: e }); }
  const lev = [], changes = []; let prev = 0;
  for (const g of groups) { const e = g.last, notional = +e.new_holdings * +e.price, val = +e.strategy_value, side = Math.abs(notional) >= 0.01 * val ? Math.sign(notional) : 0;
    if (side) lev.push(Math.abs(notional) / val); if (side !== prev) changes.push({ at: g.at, t: Date.parse(g.at), side, price: +e.price }); prev = side; }
  lev.sort((a, b) => a - b);
  return { events: L.length, groups: groups.length, changes, leverage: lev.length ? +lev[Math.floor(lev.length / 2)].toFixed(3) : null, first: L[0].at, last: L[L.length - 1].at, firstValue: +L[0].strategy_value, lastValue: +L[L.length - 1].strategy_value };
}

const SLUG = { "0zkSY2gJ414DuTZIXkIb6": "MULTIOSC", "pBlhFtpNU86BofGLGPwvH": "TRIPLE", "a0XGqoYvpO32d_KOWiBm3": "DMIDPO", "bzxOJiXGHRVKvs-_T9zmk": "STEALTHY7", "OZKJvQzBe94tyDZGSGTJ0": "LOHAS" };
const persisted = JSON.parse(fs.readFileSync(D("r187-ai-crypto-scripts.json"), "utf8"));
(async () => {
  const H = { BTC: await R.hourly("BTC"), ETH: await R.hourly("ETH") };
  for (const row of persisted.scripts) {
    const S = R.SCRIPTS.find((x) => x.id === row.id), id = `R187-${SLUG[row.id]}`, short = S.name.split(" by ")[0];
    const base = { id, name: `${short} (${S.asset} ${row.gate.timeframe})`, registryId: "R187", script: "backend/r187-ai-crypto-scripts.js", emitter: "backend/ensemble/emit/r187.js" };
    if (!row.gate.pass) { writeUnavailable({ ...base, reason: `R187 gate excluded this script (trade-log match ${row.gate.matchPct}% < 80%)` }); continue; }
    const rec = recorded(S.id), L = rec.leverage || 1.5;
    const levNote = L === row.leverageUsed ? `leverage ${L} recomputed from the AlphaInsider log = persisted leverageUsed` : `WARNING leverage recomputed ${L} vs persisted ${row.leverageUsed}`;
    const b = R.agg(H[S.asset], R.TF[row.gate.timeframe]), ev = S.run(b), ad = R.assetDays(b, S.pub, OOS_END);
    const sd = R.account(b, ev, L, S.pub, OOS_END), st = R.stat(sd, ad), sealed = row.oos.tNW;
    const series = [...sd.keys()].sort().filter((d) => sd.get(d) !== 0).map((d) => ({ d, r: sd.get(d) }));
    writeEntry({ ...base, unit: "daily", net: true,
      costModel: `10 bps per side on traded notional (x${L} leverage), charged in the bar of each fill; a reversal pays on 2x notional`,
      window: [S.pub, OOS_END], calendar: "crypto-24x7", series,
      reproduction: { statistic: "OOS alpha t (NW Bartlett lag 5, daily strategy net on asset daily return), publication..2025-09-23", sealed, emitted: st.tNW, tolerance: 0.02, match: Math.abs(st.tNW - sealed) <= 0.02 },
      construction: `R187's own account(): the verified ${row.gate.timeframe} translation's fills (closed-bar signal, next-bar-open fill) on UTC-aligned Coinbase ${S.asset} bars, constant ${L}x exposure rebalanced per bar, bar returns compounded within each UTC day (position carried in from warm-up). Flat days (return exactly 0) omitted.`,
      notes: `${levNote}. OOS window starts on the TradingView publication date ${S.pub}. Returns are at AlphaInsider's ${L}x account leverage (R187's registered sizing), not 1x. Sealed alpha ${row.oos.alphaAnnPct}%/yr vs emitted ${st.alphaAnnPct}%/yr; ${st.days} days in the statistic.` });
  }
})().catch((e) => { console.error("R187 emitter FAILED:", e.stack || e.message); process.exit(1); });
