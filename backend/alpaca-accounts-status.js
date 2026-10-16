#!/usr/bin/env node
/**
 * ALPACA PAPER ACCOUNTS STATUS (2026-10-06, operator: "how are the alpaca paper accounts going"). Read-only: GETs only.
 * For each of the three paper accounts (main = board mirror, BOOK, TV): equity now, last close, today's change, equity at the
 * first point of the 1-month portfolio history and the change since, open positions with unrealized P&L. Every figure is the
 * broker's own number; the arithmetic is printed. Never prints keys.
 *
 *   node backend/alpaca-accounts-status.js
 */
"use strict";
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const API = "https://paper-api.alpaca.markets";
const ACCTS = [["main (board mirror)", "ALPACA_KEY_ID", "ALPACA_SECRET_KEY"], ["BOOK", "ALPACA_BOOK_KEY_ID", "ALPACA_BOOK_SECRET_KEY"], ["TV", "ALPACA_TV_KEY_ID", "ALPACA_TV_SECRET_KEY"]];
const usd = (x) => (x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 });
const sgn = (x) => (x >= 0 ? "+" : "-") + usd(Math.abs(x)).replace("-", "");
(async () => {
  for (const [name, k, s] of ACCTS) {
    const H = { "APCA-API-KEY-ID": process.env[k], "APCA-API-SECRET-KEY": process.env[s] };
    if (!H["APCA-API-KEY-ID"]) { console.log(`${name}: no keys configured`); continue; }
    const get = async (p) => { const r = await fetch(API + p, { headers: H }); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };
    try {
      const a = await get("/v2/account"), pos = await get("/v2/positions"), h = await get("/v2/account/portfolio/history?period=1M&timeframe=1D");
      const eq = +a.equity, last = +a.last_equity, eqs = (h.equity || []).filter((x) => x != null && x > 0), ts = h.timestamp || [];
      const i0 = (h.equity || []).findIndex((x) => x != null && x > 0), first = eqs[0], firstDate = i0 >= 0 ? new Date(ts[i0] * 1000).toISOString().slice(0, 10) : "?";
      const upl = pos.reduce((t, p) => t + +p.unrealized_pl, 0), mv = pos.reduce((t, p) => t + Math.abs(+p.market_value), 0);
      console.log(`\n${name}`);
      console.log(`  equity ${usd(eq)} | last close ${usd(last)} | today ${sgn(eq - last)} (${usd(eq)} - ${usd(last)})`);
      console.log(`  since ${firstDate}: ${usd(first)} -> ${usd(eq)} = ${sgn(eq - first)} (${(100 * (eq - first) / first).toFixed(2)}%)`);
      console.log(`  cash ${usd(+a.cash)} | buying power ${usd(+a.buying_power)} | ${pos.length} open positions, gross ${usd(mv)}, unrealized ${sgn(upl)}`);
      for (const p of pos.sort((x, y) => +x.unrealized_pl - +y.unrealized_pl).slice(0, 3)) console.log(`    worst: ${p.symbol} ${p.side} ${p.qty} unrealized ${sgn(+p.unrealized_pl)}`);
      for (const p of pos.sort((x, y) => +y.unrealized_pl - +x.unrealized_pl).slice(0, 3)) console.log(`    best:  ${p.symbol} ${p.side} ${p.qty} unrealized ${sgn(+p.unrealized_pl)}`);
    } catch (e) { console.log(`${name}: error ${e.message}`); }
  }
})().catch((e) => { console.log("error:", e.message); process.exitCode = 1; });
