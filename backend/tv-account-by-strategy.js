#!/usr/bin/env node
/**
 * TV PAPER ACCOUNT P&L BY STRATEGY (2026-10-07, operator: "-3.4%"). Read-only.
 * Every FILLED order on the Alpaca TV paper account since --since (default 2026-09-29), grouped by the strategy prefix of its
 * client_order_id (r236-, r237-, r283-, r295-, r316-, r309-, ...; anything else = "other/manual"). Per (strategy, symbol), fills are
 * matched FIFO: realized = closed round trips at the broker's fill prices; open remainder marked at the broker's current_price.
 * The script prints each strategy's realized + unrealized and reconciles the grand total against the account's equity change.
 *   node backend/tv-account-by-strategy.js [--since 2026-09-29]
 */
"use strict";
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const API = "https://paper-api.alpaca.markets", H = { "APCA-API-KEY-ID": process.env.ALPACA_TV_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_TV_SECRET_KEY };
const SINCE = (() => { const i = process.argv.indexOf("--since"); return i > 0 ? process.argv[i + 1] : "2026-09-29"; })();
const get = async (p) => { const r = await fetch(API + p, { headers: H }); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };
const usd = (x) => (x < 0 ? "-$" : "+$") + Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 });
const strat = (cid) => { const m = /^(r\d{3})/i.exec(cid || ""); return m ? m[1].toUpperCase() : "other/manual"; };
// --merge-other: an unlabelled fill on a symbol a strategy traded is booked to the strategy that most recently traded that symbol
// (e.g. the 2026-10-06 FLATTEN of R295's reversed lots, sent under non-r295 client ids). Off by default; the header says which way it ran.
const MERGE = process.argv.includes("--merge-other");
(async () => {
  // all orders since SINCE, paged backwards by submitted_at
  let until = null, orders = [];
  for (let page = 0; page < 40; page++) {
    const q = `/v2/orders?status=all&limit=500&direction=desc&after=${SINCE}T00:00:00Z${until ? `&until=${encodeURIComponent(until)}` : ""}&nested=true`;
    const batch = await get(q); if (!batch.length) break;
    const flat = batch.flatMap((o) => [o, ...(o.legs || [])]);
    orders.push(...flat); until = batch[batch.length - 1].submitted_at; if (batch.length < 500) break;
  }
  const seen = new Set(); orders = orders.filter((o) => !seen.has(o.id) && seen.add(o.id) && +o.filled_qty > 0 && o.filled_avg_price);
  orders.sort((a, b) => Date.parse(a.filled_at || a.submitted_at) - Date.parse(b.filled_at || b.submitted_at));
  const pos = await get("/v2/positions"), px = Object.fromEntries(pos.map((p) => [p.symbol, +p.current_price]));
  const book = {}; // strat -> sym -> { lots:[{q,p}], realized }
  for (const o of orders) {
    let s = strat(o.client_order_id); const sym = o.symbol, q = +o.filled_qty, p = +o.filled_avg_price, side = o.side === "buy" ? 1 : -1;
    if (MERGE && s === "other/manual") { const owner = Object.keys(book).filter((k) => k !== "other/manual" && book[k][sym]).sort((x, y) => book[y][sym].lastAt - book[x][sym].lastAt)[0]; if (owner) s = owner; }
    const b = ((book[s] = book[s] || {})[sym] = book[s][sym] || { lots: [], realized: 0, n: 0 }); b.n++; b.lastAt = Date.parse(o.filled_at || o.submitted_at);
    let rem = q * side;
    while (rem !== 0 && b.lots.length && Math.sign(b.lots[0].q) !== Math.sign(rem)) {   // closing against the oldest opposite lot
      const l = b.lots[0], take = Math.min(Math.abs(l.q), Math.abs(rem)) * Math.sign(l.q);
      b.realized += take * (p - l.p); l.q -= take; rem += take; if (Math.abs(l.q) < 1e-9) b.lots.shift();
    }
    if (Math.abs(rem) > 1e-9) b.lots.push({ q: rem, p });
  }
  let G = 0;
  const rows = Object.entries(book).map(([s, syms]) => {
    let real = 0, unr = 0, open = 0, fills = 0, nomark = [];
    for (const [sym, b] of Object.entries(syms)) { real += b.realized; fills += b.n;
      for (const l of b.lots) { const c = px[sym]; if (c == null) { nomark.push(sym); continue; } unr += l.q * (c - l.p); open++; } }
    G += real + unr; return { s, real, unr, tot: real + unr, open, fills, nomark };
  }).sort((a, b) => a.tot - b.tot);
  console.log(`TV paper account, filled orders since ${SINCE}: ${orders.length} fills${MERGE ? " (unlabelled fills booked to the strategy that last traded the symbol)" : ""}\n`);
  console.log("strategy       | fills | realized | open lots | unrealized | total");
  for (const r of rows) console.log(`${r.s.padEnd(14)} | ${String(r.fills).padStart(5)} | ${usd(r.real).padStart(8)} | ${String(r.open).padStart(9)} | ${usd(r.unr).padStart(10)} | ${usd(r.tot).padStart(7)}${r.nomark.length ? "  (no mark: " + r.nomark.join(",") + ")" : ""}`);
  const a = await get("/v2/account"), h = await get("/v2/account/portfolio/history?period=1M&timeframe=1D");
  const i0 = (h.equity || []).findIndex((x) => x > 0), e0 = h.equity[i0];
  console.log(`\nsum of strategies ${usd(G)} | account equity ${usd(+a.equity - e0)} since ${new Date(h.timestamp[i0] * 1000).toISOString().slice(0, 10)} ($${e0.toFixed(0)} -> $${(+a.equity).toFixed(0)}); difference ${usd(+a.equity - e0 - G)} = fees/other not in fills`);
})().catch((e) => { console.log("error:", e.message); process.exitCode = 1; });
