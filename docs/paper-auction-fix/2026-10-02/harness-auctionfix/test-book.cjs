// book-etf-rebalancer harness: fake BOOK broker. Usage: node test-book.cjs <runner file> [--expect-old]
"use strict";
const fs = require("fs"), path = require("path");
const { ok, summary, fakeBackend, harnessCopy, run, readJson, readJsonl } = require("./lib-harness.cjs");
const SRC = process.argv[2], OLD = process.argv.includes("--expect-old");
const bk = fakeBackend("book" + (OLD ? "-old" : ""));
const target = harnessCopy(SRC, bk, "book-etf-rebalancer.js", 'process.argv.includes("--live")');
fs.writeFileSync(path.join(bk, "lib", "alpaca-bars.js"), `exports.fetchBars = async (syms, o) => { const end = globalThis.__H_SPEC.barDate, n = 420, t0 = Date.parse(end + "T04:00:00Z") - (n - 1) * 864e5; const px = globalThis.__H_SPEC.px || {}; return { bars: Object.fromEntries(syms.map((s) => [s, Array.from({ length: n }, (_, i) => ({ t: new Date(t0 + i * 864e5).toISOString(), c: (px[s] || 100) * (0.8 + 0.2 * i / (n - 1)) }))])), truncatedStart: [] }; };`);
const STATE = path.join(bk, "data", "book-etf-state.json"), LEDGER = path.join(bk, "data", "book-etf-ledger.jsonl");
const CAL = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-30"].map((date) => ({ date, open: "09:30", close: "16:00" }));
const NOW = "2026-10-05T20:20:00Z", PX = { QQQ: 600, SPY: 650, GLD: 300, EFA: 90, DBMF: 30, JAAA: 50, SGOV: 100 };
const reset = (s) => { fs.writeFileSync(STATE, JSON.stringify(s)); if (fs.existsSync(LEDGER)) fs.unlinkSync(LEDGER); };
const base = { now: NOW, argv: ["--after-close"], live: true, barDate: "2026-10-05", px: PX, calendar: CAL, account: { buying_power: "500000", cash: "100000" } };
console.log(`BOOK harness on ${path.basename(SRC)}${OLD ? " (ORIGINAL)" : ""}`);
// B1 normal: empty book -> full rebalance, every order accepted
reset({ cash: 73000, holdings: {}, pending: [], runs: {}, navHistory: [] });
let r = run(target, { ...base });
let st = readJson(STATE), L = readJsonl(LEDGER);
const nBuys = r.mut.filter((c) => c.method === "POST").length;
ok(nBuys >= 5 && st.pending.length === nBuys && st.runs["2026-10-05"] && r.status === 0, "B1 all orders sent, all pending, day marked done, exit 0", { nBuys, pending: st.pending.length, status: r.status });
ok(r.mut.every((c) => c.body.type === "market" && c.body.time_in_force === "day"), "B1 every order is a DAY market order (no opg/cls)");
// B2 the 3rd order is refused (403 insufficient buying power)
reset({ cash: 73000, holdings: {}, pending: [], runs: {}, navHistory: [] });
const third = r.mut.filter((c) => c.method === "POST")[2].body.symbol;
r = run(target, { ...base, postReject: { [third]: "insufficient buying power" } });
st = readJson(STATE); L = readJsonl(LEDGER);
const posted = r.calls.filter((c) => c.method === "POST").length, accepted = r.orders.length;
if (OLD) ok(st.pending.length === 0 && accepted === 2 && r.status === 1, "OLD B2: run throws at the refused order — the 2 orders already at the broker are in NO pending list (their fills will never reach the book)", { pending: st.pending.length, accepted, status: r.status });
else { ok(st.pending.length === accepted && accepted === nBuys - 1 && st.pending.every((p) => r.orders.some((o) => o.client_order_id === p.cid)), "B2 every order the broker accepted is in pending (the refusal does not lose them); the other buys still go", { pending: st.pending.length, accepted, posted });
  ok(L.some((x) => x.kind === "order-rejected" && x.sym === third) && !st.runs["2026-10-05"] && r.status === 1, "B2 refusal recorded, day NOT marked done, exit 1 (as before)", { runs: st.runs, status: r.status }); }
// B4 same-evening re-run after B2 (broker still holds the accepted orders; the refusal cause is gone) -> adopted, no duplicates
if (!OLD) {
  const prevOrders = r.orders;
  r = run(target, { ...base, orders: prevOrders });
  st = readJson(STATE); L = readJsonl(LEDGER);
  const cids = st.pending.map((p) => p.cid);
  ok(new Set(cids).size === cids.length && cids.length === nBuys && st.runs["2026-10-05"] && r.status === 0, "B4 re-run: earlier orders adopted by client id (no duplicate pending), the refused one sent, day done", { cids, status: r.status });
  ok(L.filter((x) => x.kind === "order-adopted").length === nBuys - 1 && st.navHistory.filter((x) => x.date === "2026-10-05").length === 1, "B4 adopted rows logged; one NAV row for the day", st.navHistory);
}
// B3 a SELL is refused -> the batch's buys are refused too (they were sized on its proceeds)
reset({ cash: 1000, holdings: { SGOV: 700 }, pending: [], runs: {}, navHistory: [], signalsAsOf: null });
r = run(target, { ...base, postReject: { "SGOV|sell": "insufficient qty available for order" } });
st = readJson(STATE); L = readJsonl(LEDGER);
if (OLD) ok(r.status === 1 && r.orders.length === 0, "OLD B3: refused sell throws; nothing else sent", r.status);
else ok(r.orders.length === 0 && L.filter((x) => x.kind === "order-refused").length >= 1 && r.status === 1 && !st.runs["2026-10-05"], "B3 refused sell: no buy sent (sized on its proceeds), recorded, exit 1", { orders: r.orders.length, L: L.map((x) => x.kind) });
// B5 reconcile: a queued order expired with 7 of 10 filled -> holdings +7, cash - 7 x px (behaviour unchanged)
reset({ cash: 5000, holdings: { QQQ: 0 }, pending: [{ cid: "book-20261002-QQQ-buy", sym: "QQQ", side: "buy", qty: 10 }], runs: {}, navHistory: [] });
r = run(target, { ...base, argv: ["--reconcile"], orders: [{ id: "q1", client_order_id: "book-20261002-QQQ-buy", symbol: "QQQ", side: "buy", qty: "10", status: "expired", filled_qty: "7", filled_avg_price: "600" }] });
st = readJson(STATE);
ok(st.holdings.QQQ === 7 && Math.abs(st.cash - (5000 - 4200)) < 1e-9 && st.pending.length === 0, "B5 partial (expired, 7 of 10): holdings +7, cash -4200 — from filled_qty", st);
// B6 a still-working order stays pending
reset({ cash: 5000, holdings: {}, pending: [{ cid: "book-20261002-QQQ-buy", sym: "QQQ", side: "buy", qty: 10 }], runs: {}, navHistory: [] });
r = run(target, { ...base, argv: ["--reconcile"], orders: [{ id: "q1", client_order_id: "book-20261002-QQQ-buy", symbol: "QQQ", side: "buy", qty: "10", status: "partially_filled", filled_qty: "3", filled_avg_price: "600" }] });
st = readJson(STATE); ok(st.pending.length === 1 && !st.holdings.QQQ, "B6 partially_filled (still working) left pending", st);
process.exitCode = summary("book") ? 1 : 0;
