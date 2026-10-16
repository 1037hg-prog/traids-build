#!/usr/bin/env node
/**
 * DAILY TRUTH TABLE (2026-10-05, operator: "you should be able to compile data"). One script, one definition per number, every input
 * printed, so each figure can be re-derived by hand. Read-only.
 *
 * POPULATION  board SIGNAL tickets as they trade from 2026-10-06: strategy Trend / Ensemble / Breakout, class Equity or Crypto,
 *             not a sleeve, not a control/shadow (canonical ledger: lib/reconcile.js cleanEraLedger().signals). Keyed by the
 *             MT close date (the dashboard's convention).
 * GROSS $     the ledger's own pnl (paper marks, no cost deducted — cost-model.js never edits the ledger).
 * SIZE        units = risk$ / stopDist with risk$ = |pnl / rMult| (when rMult != 0, else the policy stake: $250 equity, $75 crypto);
 *             notional = units x entry price. A consistency check prints how many rows have |units x (exit-entry)| != |pnl| by > 1%.
 * COST $      per side, per ticket:
 *               Equity  the ticket's OWN Alpaca fill when the mirror filled it (entry side); otherwise the measured dollar-weighted
 *                       rate from those fills (backend/cost-check-fills.js) x notional. Exit side = the same rate x exit notional
 *                       (exits are not matched yet — ASSUMPTION, labelled).
 *               Crypto  Alpaca crypto taker fee 0.25% per side (tier 1 schedule) + 7.6 bps measured slippage (capital model, 10-05)
 *                       = 0.326% per side x notional — ASSUMPTION, labelled.
 * NET $       gross - cost.
 *
 *   node backend/daily-truth-table.js [--from 2026-09-11] [--to 2026-10-05]
 */
const fs = require("fs"), path = require("path");
const R = require("./lib/reconcile.js");
const D = (f) => path.join(__dirname, "data", f);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const FROM = arg("--from", "2026-09-11"), TO = arg("--to", "2026-10-05");
const mt = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
// measured equity entry rate from real fills (same arithmetic as cost-check-fills.js)
const M = fs.readFileSync(D("alpaca-mirror.jsonl"), "utf8").trim().split(/\n/).map((l) => JSON.parse(l)).filter((r) => !r.skipped && r.cls === "Equity" && r.orderId);
const fill = {}; for (const l of fs.readFileSync(D("alpaca-trade-updates.jsonl"), "utf8").trim().split(/\n/)) { const u = JSON.parse(l); if (u.order_id && u.filled_avg_price && +u.filled_qty > 0) fill[u.order_id] = { px: +u.filled_avg_price, q: +u.filled_qty }; }
const ownFill = {}; let fN = 0, fC = 0;
for (const m of M) { const f = fill[m.orderId]; if (!f || !m.ticketEntry) continue; const s = m.side === "buy" ? 1 : -1, usd = s * (f.px - m.ticketEntry) * f.q; ownFill[m.ticketId] = usd; fN += f.px * f.q; fC += usd; }
const EQ_RATE = fC / fN, CRYPTO_RATE = 0.0025 + 0.00076;
const rows = R.cleanEraLedger().signals.filter((r) => !r.sleeve && ["Trend", "Ensemble", "Breakout"].includes(r.strategy) && ["Equity", "Crypto"].includes(r.cls))
  .filter((r) => { const d = mt(r.closedAt); return d >= FROM && d <= TO; });
let badSize = 0;
const day = {};
for (const r of rows) {
  const risk = r.rMult ? Math.abs(r.pnl / r.rMult) : (r.cls === "Crypto" ? 75 : 250);
  const units = r.stopDist > 0 ? risk / r.stopDist : 0, nIn = units * r.entry, nOut = units * (r.exit || r.entry);
  if (Math.abs(r.pnl) > 1 && Math.abs(Math.abs(units * (r.exit - r.entry)) - Math.abs(r.pnl)) > 0.01 * Math.abs(r.pnl)) badSize++;
  let cost;
  if (r.cls === "Equity") cost = (ownFill[r.id] != null ? ownFill[r.id] : EQ_RATE * nIn) + EQ_RATE * nOut;
  else cost = CRYPTO_RATE * (nIn + nOut);
  const d = mt(r.closedAt), x = (day[d] = day[d] || { n: 0, w: 0, gross: 0, cost: 0, notional: 0, own: 0 });
  x.n++; if (r.pnl > 0) x.w++; x.gross += r.pnl; x.cost += cost; x.notional += nIn; if (ownFill[r.id] != null) x.own++;
}
console.log(`Board signals (Trend/Ensemble/Breakout, Equity+Crypto) closed ${FROM}..${TO}, MT close date. Equity cost rate ${(EQ_RATE * 1e4).toFixed(1)} cents per $100 per side (from ${Object.keys(ownFill).length} real fills); crypto ${(CRYPTO_RATE * 1e4).toFixed(1)} cents per $100 per side (fee schedule + slippage, assumption).`);
console.log("day        | tickets | wins | win %  | avg ticket | gross $  | cost $  | net $   | own fills");
const T = { n: 0, w: 0, gross: 0, cost: 0, notional: 0, days: 0 };
for (const d of Object.keys(day).sort()) { const x = day[d]; T.n += x.n; T.w += x.w; T.gross += x.gross; T.cost += x.cost; T.notional += x.notional; T.days++;
  console.log(`${d} | ${String(x.n).padStart(7)} | ${String(x.w).padStart(4)} | ${(100 * x.w / x.n).toFixed(1).padStart(5)}% | ${("$" + (x.notional / x.n).toFixed(0)).padStart(10)} | ${((x.gross >= 0 ? "+" : "") + x.gross.toFixed(0)).padStart(8)} | ${("-" + x.cost.toFixed(0)).padStart(7)} | ${(((x.gross - x.cost) >= 0 ? "+" : "") + (x.gross - x.cost).toFixed(0)).padStart(7)} | ${x.own}`); }
console.log(`TOTAL ${T.days} days | ${T.n} tickets | win ${(100 * T.w / T.n).toFixed(1)}% | gross ${T.gross.toFixed(0)} | cost ${T.cost.toFixed(0)} | net ${(T.gross - T.cost).toFixed(0)}`);
console.log(`PER DAY  gross ${(T.gross / T.days).toFixed(0)} | cost ${(T.cost / T.days).toFixed(0)} | net ${((T.gross - T.cost) / T.days).toFixed(0)}`);
console.log(`PER TICKET  gross ${(T.gross / T.n).toFixed(2)} | cost ${(T.cost / T.n).toFixed(2)} | net ${((T.gross - T.cost) / T.n).toFixed(2)} | avg ticket size $${(T.notional / T.n).toFixed(0)}`);
console.log(`size check: ${badSize} of ${rows.length} rows where units x (exit - entry) differs from the ledger pnl by > 1% (0 = sizes reconcile).`);
