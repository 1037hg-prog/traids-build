#!/usr/bin/env node
/**
 * WHAT THE CRYPTO BOOK ACTUALLY COST. (2026-09-09)
 *
 * cost-model.json declares Crypto at 20.0 bps round trip, tagged "DECLARED — Coinbase majors; stamp
 * the quote spread at track to measure". The stamping was in fact done: data/crypto-spread-log.jsonl
 * holds 1,087 real quote stamps with a round-trip bps on each. Nobody fed them back into the model.
 *
 * MEASURED:  p10 3.5 · p25 19.1 · MEDIAN 31.7 · p75 50.7 · p90 60.6 bps
 * DECLARED:  20.0 bps flat
 *
 * Two separate errors, and the second is larger than the first:
 *
 *   1. THE LEVEL is understated 1.59x at the median.
 *   2. THE FLATNESS is the real defect. Measured spreads run from 2.4 bps (ETH) to 60.6 bps (XTZ) —
 *      a 25x range inside one "class". A single class-wide number cannot be right for both, and the
 *      book did not trade them equally: the majors are cheap and the alts are expensive, so a flat
 *      20 bps quietly subsidises exactly the names where the book was most active.
 *
 * This matters more than any other cost line because Crypto is where the paper book's entire profit
 * sits, and that profit already turned out to be a weekend-scheduling artifact rather than selection.
 * If the class is also undercharged, the artifact is smaller still.
 *
 * WHAT THIS DOES. Re-prices every crypto ticket at ITS OWN measured median spread and reports the
 * difference. It changes NO ledger row and registers nothing — the ledger is canonical and a cost
 * restatement is an analysis, not an edit.
 *
 * Usage: node backend/crypto-cost-restate.js [--json]
 */
const fs = require("fs"), path = require("path");
const R = require("./lib/reconcile.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");

const D = (f) => path.join(__dirname, "data", f);
const JSON_OUT = process.argv.includes("--json");
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const money = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// ── measured spread per symbol ───────────────────────────────────────────────
const stamps = fs.readFileSync(D("crypto-spread-log.jsonl"), "utf8").split(/\r?\n/).filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && Number.isFinite(r.rtBps));
const bySym = {};
for (const r of stamps) (bySym[r.sym] ||= []).push(r.rtBps);
const medBps = {};
for (const s of Object.keys(bySym)) { const a = bySym[s].sort((x, y) => x - y); medBps[s] = a[Math.floor(a.length / 2)]; }
const allBps = stamps.map((r) => r.rtBps).sort((a, b) => a - b);
const CLASS_MEDIAN = allBps[Math.floor(allBps.length / 2)];

const model = JSON.parse(fs.readFileSync(D("cost-model.json"), "utf8"));
const DECLARED_BPS = ((model.perClass || {}).Crypto || {}).roundTripPct * 100;

// ── the book ─────────────────────────────────────────────────────────────────
const L = R.cleanEraLedger();
const crypto = (L.signals || []).filter((t) => t.cls === "Crypto" && Number.isFinite(t.pnl));
const priced = crypto.filter((t) => Number.isFinite(t.units) && Number.isFinite(t.entry));

let extra = 0, covered = 0, uncovered = 0, notional = 0;
const perSym = {};
for (const t of priced) {
  const n = Math.abs(t.units * t.entry);
  const m = medBps[t.sym];
  notional += n;
  if (m == null) { uncovered++; continue; }
  covered++;
  const d = (n * (m - DECLARED_BPS)) / 10000;          // extra dollars the book should have paid
  extra += d;
  (perSym[t.sym] ||= { n: 0, notional: 0, measBps: m, extra: 0 });
  perSym[t.sym].n++; perSym[t.sym].notional += n; perSym[t.sym].extra += d;
}
// names with no stamp: charge the class median rather than pretending they are free
const unstampedExtra = priced.filter((t) => medBps[t.sym] == null)
  .reduce((s, t) => s + (Math.abs(t.units * t.entry) * (CLASS_MEDIAN - DECLARED_BPS)) / 10000, 0);

const cryptoPnl = crypto.reduce((s, t) => s + t.pnl, 0);
const bookPnl = (L.signals || []).filter((t) => Number.isFinite(t.pnl)).reduce((s, t) => s + t.pnl, 0);
const rows = Object.entries(perSym).map(([sym, v]) => ({ sym, ...v })).sort((a, b) => b.extra - a.extra);

const out = {
  spec: "crypto-cost-restate-v1", asOf: new Date().toISOString(),
  status: "ANALYSIS — no ledger row is changed and nothing is registered",
  measured: { stamps: stamps.length, symbols: Object.keys(medBps).length, classMedianBps: +CLASS_MEDIAN.toFixed(1), declaredBps: DECLARED_BPS, understatedBy: +(CLASS_MEDIAN / DECLARED_BPS).toFixed(2) },
  book: { cryptoTickets: crypto.length, pricedTickets: priced.length, stampCovered: covered, notStamped: uncovered, notionalUSD: Math.round(notional) },
  restatement: { extraCostStampedNamesUSD: Math.round(extra), extraCostUnstampedAtClassMedianUSD: Math.round(unstampedExtra),
    cryptoPnlAsRecorded: Math.round(cryptoPnl), cryptoPnlRestated: Math.round(cryptoPnl - extra - unstampedExtra),
    bookPnlAsRecorded: Math.round(bookPnl), bookPnlRestated: Math.round(bookPnl - extra - unstampedExtra) },
  worstNames: rows.slice(0, 8),
};
writeJsonAtomic(D("crypto-cost-restate.json"), out);
if (JSON_OUT) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }

console.log(`\n  CRYPTO COST, RESTATED AT MEASURED SPREADS`);
console.log(`  ${stamps.length} quote stamps across ${Object.keys(medBps).length} symbols · class median ${CLASS_MEDIAN.toFixed(1)} bps vs ${DECLARED_BPS} declared (${(CLASS_MEDIAN / DECLARED_BPS).toFixed(2)}x)\n`);
console.log(`  book crypto notional              ${money(notional).padStart(12)}`);
console.log(`  extra cost, stamped names         ${money(-extra).padStart(12)}`);
console.log(`  extra cost, unstamped at median   ${money(-unstampedExtra).padStart(12)}`);
console.log(`  ${"".padEnd(34, "-")}`);
console.log(`  crypto P&L as recorded            ${money(cryptoPnl).padStart(12)}`);
console.log(`  crypto P&L restated               ${money(cryptoPnl - extra - unstampedExtra).padStart(12)}`);
console.log(`  WHOLE BOOK as recorded            ${money(bookPnl).padStart(12)}`);
console.log(`  WHOLE BOOK restated               ${money(bookPnl - extra - unstampedExtra).padStart(12)}`);
console.log(`\n  where the subsidy went (flat 20bp vs each name's own measured spread):`);
console.log(`  ${"symbol".padEnd(11)}${"tix".padStart(5)}${"notional".padStart(12)}${"measured".padStart(11)}${"undercharged".padStart(14)}`);
for (const r of rows.slice(0, 8)) console.log(`  ${r.sym.padEnd(11)}${String(r.n).padStart(5)}${money(r.notional).padStart(12)}${(r.measBps.toFixed(1) + " bp").padStart(11)}${money(r.extra).padStart(14)}`);
console.log(`\n  The ledger is unchanged. This is what the same trades would have cost at the spreads`);
console.log(`  the apparatus actually stamped, which have been sitting unused in crypto-spread-log.jsonl.`);
