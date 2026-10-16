#!/usr/bin/env node
/**
 * COST CHECK FROM REAL FILLS (2026-10-05, operator: "how do I believe any of your numbers; that's simple math").
 * Every board stock ticket the Alpaca paper mirror sent (data/alpaca-mirror.jsonl), matched to its broker fill
 * (data/alpaca-trade-updates.jsonl). Cost per ticket = shares x (fill - board price) for a buy, (board price - fill) for a sell.
 * Prints every row and the totals, so each number can be checked by hand. Read-only.
 *
 *   node backend/cost-check-fills.js            all matched fills
 *   node backend/cost-check-fills.js --since 2026-10-01
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const since = (() => { const i = process.argv.indexOf("--since"); return i > 0 ? process.argv[i + 1] : "0000"; })();
const M = fs.readFileSync(D("alpaca-mirror.jsonl"), "utf8").trim().split(/\n/).map((l) => JSON.parse(l))
  .filter((r) => !r.skipped && r.cls === "Equity" && r.orderId && r.ts.slice(0, 10) >= since);
const fill = {};
for (const l of fs.readFileSync(D("alpaca-trade-updates.jsonl"), "utf8").trim().split(/\n/)) {
  const u = JSON.parse(l); if (u.order_id && u.filled_avg_price && +u.filled_qty > 0) fill[u.order_id] = { px: +u.filled_avg_price, q: +u.filled_qty };
}
let notional = 0, cost = 0, n = 0;
console.log("date  | sym   | side | shares | board price | fill price | notional | cost $ | cents per $100");
for (const m of M) {
  const f = fill[m.orderId]; if (!f || !m.ticketEntry) continue;
  const s = m.side === "buy" ? 1 : -1, usd = s * (f.px - m.ticketEntry) * f.q, nt = f.px * f.q;
  notional += nt; cost += usd; n++;
  console.log(`${m.ts.slice(5, 10)} | ${m.sym.padEnd(5)} | ${m.side.padEnd(4)} | ${String(f.q).padStart(6)} | ${m.ticketEntry.toFixed(2).padStart(11)} | ${f.px.toFixed(2).padStart(10)} | ${("$" + nt.toFixed(0)).padStart(8)} | ${(usd >= 0 ? " $" : "-$") + Math.abs(usd).toFixed(2)} | ${(usd / nt * 1e4).toFixed(1)}`);
}
if (!n) { console.log("no matched fills"); process.exit(0); }
console.log(`\n${n} fills · traded $${notional.toFixed(0)} · entry cost $${cost.toFixed(2)} · ${(cost / notional * 1e4).toFixed(1)} cents per $100 (dollar-weighted) · $${(cost / n).toFixed(2)} per ticket on an average ticket of $${(notional / n).toFixed(0)}`);
console.log(`check: ${(cost / notional * 100).toFixed(3)}% x $${(notional / n).toFixed(0)} = $${(cost / notional * notional / n).toFixed(2)} per ticket. Entries only — exits are not matched here.`);
