#!/usr/bin/env node
/**
 * SKEPTIC / lane sleeves-and-sizing, printer 3b (read-only; GET requests only; never prints a key).
 * Follow-up to skeptic-sleeves3.js H1: the R191 + R231 runner states claim more ETH than the main paper account holds.
 * Lists every FILLED main-account order in the named crypto symbols since 2026-09-01, bucketed by client-order-id prefix
 * (r191 / r231 / mx = board-mirror exit / other = board-mirror bracket or manual), net filled quantity per bucket and by day.
 * Quantities and order facts only. Writes only backend/data/profit-program/skeptic-sleeves3b.json.
 *   node backend/profit-program/skeptic-sleeves3b.js [--symbols ETH/USD,BTC/USD] [--no-write]
 */
"use strict";
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SYMS = arg("--symbols", "ETH/USD").split(",");
const API = "https://paper-api.alpaca.markets";
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
const get = async (p) => { const r = await fetch(API + p, { method: "GET", headers: H }); if (!r.ok) throw new Error(`${p.split("?")[0]} ${r.status}`); return r.json(); };
const bucket = (cid) => { const m = /^(r\d{3}|mx|book|r24)/i.exec(cid || ""); return m ? m[1].toUpperCase() : "other (board-mirror bracket / manual)"; };
(async () => {
  const out = { spec: "skeptic-sleeves3b-v1", asOf: new Date().toISOString(), symbols: {} };
  const pos = await get("/v2/positions");
  for (const sym of SYMS) {
    let after = "2026-09-01T00:00:00Z", all = [];
    for (let page = 0; page < 40; page++) {
      const b = await get(`/v2/orders?status=all&limit=500&direction=asc&nested=true&symbols=${encodeURIComponent(sym)}&after=${encodeURIComponent(after)}`);
      if (!b.length) break; all.push(...b.flatMap((o) => [o, ...(o.legs || [])])); after = b[b.length - 1].submitted_at; if (b.length < 500) break;
    }
    const seen = new Set(), fills = all.filter((o) => !seen.has(o.id) && seen.add(o.id) && +o.filled_qty > 0);
    const by = {}, rows = [];
    for (const o of fills) { const k = bucket(o.client_order_id), q = (o.side === "buy" ? 1 : -1) * +o.filled_qty; (by[k] ||= { fills: 0, netQty: 0, bought: 0, sold: 0 }); by[k].fills++; by[k].netQty += q; if (q > 0) by[k].bought += q; else by[k].sold -= q;
      rows.push({ day: String(o.filled_at || o.submitted_at).slice(0, 10), bucket: k, side: o.side, qty: +o.filled_qty, px: +o.filled_avg_price, type: `${o.type}/${o.time_in_force}`, cidHead: String(o.client_order_id || "").slice(0, 22) }); }
    const p = pos.find((x) => x.symbol.replace("/", "") === sym.replace("/", "")), held = p ? +p.qty : 0, net = Object.values(by).reduce((s, v) => s + v.netQty, 0);
    out.symbols[sym] = { filledOrders: fills.length, byBucket: by, netFilledQty: +net.toFixed(6), brokerPositionQty: held, rows };
    console.log(`${sym}: ${fills.length} filled orders since 2026-09-01; net filled qty ${net.toFixed(6)}; broker position ${held}`);
    for (const [k, v] of Object.entries(by)) console.log(`   ${k.padEnd(40)} fills ${String(v.fills).padStart(3)}  bought ${v.bought.toFixed(6).padStart(12)}  sold ${v.sold.toFixed(6).padStart(12)}  net ${v.netQty.toFixed(6).padStart(12)}`);
    for (const r of rows) console.log(`      ${r.day} ${r.bucket.slice(0, 8).padEnd(8)} ${r.side.padEnd(4)} ${String(r.qty).padStart(12)} @ ${String(r.px).padStart(10)}  ${r.type.padEnd(12)} ${r.cidHead}`);
  }
  if (!argv.includes("--no-write")) writeJsonAtomic(path.join(__dirname, "..", "data", "profit-program", "skeptic-sleeves3b.json"), out);
})().catch((e) => { console.log("error:", e.message); process.exitCode = 1; });
