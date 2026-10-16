#!/usr/bin/env node
/**
 * SKEPTIC / lane sleeves-and-sizing, printer 3c (read-only; GET requests only; never prints a key).
 * Is the order history that pp-broker-attrib.js builds its FIFO from complete? That printer pages /v2/orders with nested=true, limit=500,
 * direction=desc and STOPS when a page returns fewer than 500 top-level orders. This check repeats its paging per account (same logic),
 * then builds the full set by paging forward from --since (direction=asc, de-duplicated by order id, stop when a page adds nothing new),
 * and counts the orders - and the filled orders, by client-id bucket - that the printer never saw.
 * Order counts, ids and timestamps only. Writes only backend/data/profit-program/skeptic-sleeves3c.json.
 *   node backend/profit-program/skeptic-sleeves3c.js [--since 2026-09-10] [--no-write]
 */
"use strict";
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SINCE = arg("--since", "2026-09-10"), API = "https://paper-api.alpaca.markets";
const ACCTS = [["main", "ALPACA_KEY_ID", "ALPACA_SECRET_KEY"], ["BOOK", "ALPACA_BOOK_KEY_ID", "ALPACA_BOOK_SECRET_KEY"], ["TV", "ALPACA_TV_KEY_ID", "ALPACA_TV_SECRET_KEY"]];
const bucket = (cid) => { const m = /^(r\d{3}|mx|book|r24)/i.exec(cid || ""); return m ? m[1].toUpperCase() : "unlabelled"; };
(async () => {
  const out = { spec: "skeptic-sleeves3c-v2", asOf: new Date().toISOString(), since: SINCE, accounts: {} };
  for (const [name, k, s] of ACCTS) {
    const H = { "APCA-API-KEY-ID": process.env[k], "APCA-API-SECRET-KEY": process.env[s] }; if (!H["APCA-API-KEY-ID"]) continue;
    const get = async (p) => { const r = await fetch(API + p, { method: "GET", headers: H }); if (!r.ok) throw new Error(`${p.split("?")[0]} ${r.status}`); return r.json(); };
    const flat = (b) => b.flatMap((o) => [o, ...(o.legs || [])]);
    // the printer under test: its paging loop (same stop rule), keeping every order and leg it would see
    let until = null, pages = 0, firstPageParents = null; const kept = new Map();
    for (let page = 0; page < 60; page++) {
      const batch = await get(`/v2/orders?status=all&limit=500&direction=desc&after=${SINCE}T00:00:00Z${until ? `&until=${encodeURIComponent(until)}` : ""}&nested=true`);
      if (!batch.length) break; pages++; if (page === 0) firstPageParents = batch.length;
      for (const o of flat(batch)) kept.set(o.id, o); until = batch[batch.length - 1].submitted_at; if (batch.length < 500) break;
    }
    // the full set: forward paging, de-duplicated, stop when a page adds no new id
    let after = `${SINCE}T00:00:00Z`; const all = new Map();
    for (let page = 0; page < 300; page++) {
      const b = await get(`/v2/orders?status=all&limit=500&direction=asc&nested=true&after=${encodeURIComponent(after)}`); if (!b.length) break;
      let added = 0; for (const o of flat(b)) if (!all.has(o.id)) { all.set(o.id, o); added++; }
      if (!added) break; after = b[b.length - 1].submitted_at;
    }
    const isFill = (o) => +o.filled_qty > 0 && o.filled_avg_price, missed = [...all.values()].filter((o) => !kept.has(o.id)), missedFills = missed.filter(isFill), by = {};
    for (const o of missedFills) by[bucket(o.client_order_id)] = (by[bucket(o.client_order_id)] || 0) + 1;
    const ts = (a) => a.map((o) => o.submitted_at).sort(), keptTs = ts([...kept.values()]), allTs = ts([...all.values()]);
    const A = out.accounts[name] = { printerPages: pages, firstPageParents, printerOrdersAndLegs: kept.size, printerFills: [...kept.values()].filter(isFill).length, printerOldest: keptTs[0], allOrdersAndLegs: all.size, allFills: [...all.values()].filter(isFill).length, allOldest: allTs[0],
      missedOrdersAndLegs: missed.length, missedFills: missedFills.length, missedFillsByBucket: by };
    console.log(`${name}: pp-broker-attrib paging stops after ${pages} page(s) (first page ${firstPageParents} parent orders < 500): it sees ${kept.size} orders+legs, ${A.printerFills} fills, oldest ${A.printerOldest}`);
    console.log(`      full history since ${SINCE}: ${all.size} orders+legs, ${A.allFills} fills, oldest ${A.allOldest} -> the printer never saw ${missed.length} orders+legs, of which ${missedFills.length} FILLS: ${JSON.stringify(by)}`);
  }
  if (!argv.includes("--no-write")) writeJsonAtomic(path.join(__dirname, "..", "data", "profit-program", "skeptic-sleeves3c.json"), out);
})().catch((e) => { console.log("error:", e.message); process.exitCode = 1; });
