// payne-picks harness: fake MAIN broker. Usage: node test-payne.cjs <runner file> [--expect-old]
"use strict";
const fs = require("fs"), path = require("path");
const { ok, summary, fakeBackend, harnessCopy, run, readJson, readJsonl } = require("./lib-harness.cjs");
const SRC = process.argv[2], OLD = process.argv.includes("--expect-old");
const bk = fakeBackend("payne" + (OLD ? "-old" : ""));
const target = harnessCopy(SRC, bk, "payne-picks.js", 'has("--live")');
fs.writeFileSync(path.join(bk, "lib", "alpaca-bars.js"), `exports.fetchBars = async (syms) => ({ bars: Object.fromEntries(syms.map((s) => [s, [{ t: "2026-10-01T04:00:00Z", c: 100 }, { t: "2026-10-05T04:00:00Z", c: 101 }, { t: "2026-10-06T04:00:00Z", c: 102 }]])) });`);
const STATE = path.join(bk, "data", "payne-picks-state.json"), LEDGER = path.join(bk, "data", "payne-picks-ledger.jsonl");
const pick0 = { id: "NVDA-2026-10-01-1", sym: "NVDA", dir: 1, statedEntry: 180, receivedAt: "2026-10-01T14:00:00Z", qty: 10, entryCid: "payne-NVDA-20261001-1-B", status: "pending" };
const reset = (picks) => { fs.writeFileSync(STATE, JSON.stringify({ spec: "payne-picks-v1", picks })); if (fs.existsSync(LEDGER)) fs.unlinkSync(LEDGER); };
const P = () => readJson(STATE).picks[0];
const ord = (o) => ({ symbol: "NVDA", type: "market", time_in_force: "day", ...o });
console.log(`PAYNE harness on ${path.basename(SRC)}${OLD ? " (ORIGINAL)" : ""}`);
// P7 normal: entry filled -> open; exit filled -> closed at the fill (unchanged)
reset([{ ...pick0 }]);
run(target, { now: "2026-10-05T20:30:00Z", argv: ["--reconcile"], live: false, orders: [ord({ id: "e1", client_order_id: pick0.entryCid, side: "buy", qty: "10", status: "filled", filled_qty: "10", filled_avg_price: "181", filled_at: "2026-10-02T13:30:00Z" })] });
ok(P().status === "open" && P().qty === 10 && P().entryFill === 181, "P7a full entry fill -> open, qty 10", P());
const st7 = readJson(STATE); st7.picks[0].status = "exiting"; st7.picks[0].exitCid = "payne-NVDA-20261001-1-S"; fs.writeFileSync(STATE, JSON.stringify(st7));
run(target, { now: "2026-10-06T20:30:00Z", argv: ["--reconcile"], live: false, orders: [ord({ id: "x1", client_order_id: "payne-NVDA-20261001-1-S", side: "sell", qty: "10", status: "filled", filled_qty: "10", filled_avg_price: "190", filled_at: "2026-10-06T13:30:00Z" })] });
ok(P().status === "closed" && P().exitFill === 190 && P().exitFilledAt === "2026-10-06T13:30:00Z" && P().ret != null, "P7b full exit fill -> closed at 190 (benchmarked)", P());
// P1 entry EXPIRED with 4 of 10 filled
reset([{ ...pick0 }]);
run(target, { now: "2026-10-05T20:30:00Z", argv: ["--reconcile"], live: false, orders: [ord({ id: "e1", client_order_id: pick0.entryCid, side: "buy", qty: "10", status: "expired", filled_qty: "4", filled_avg_price: "181", filled_at: "2026-10-02T13:30:00Z" })] });
if (OLD) ok(P().status === "unfilled", "OLD P1: a partial entry (4 of 10 at the broker) is marked UNFILLED", P().status);
else ok(P().status === "open" && P().qty === 4 && P().entryFill === 181, "P1 partial entry: open, qty = filled_qty 4", P());
// P2 exit EXPIRED with 6 of 10 sold, reconcile --live -> remainder 4 re-sent as -S2
reset([{ ...pick0, status: "exiting", entryFill: 181, entryFilledAt: "2026-10-02T13:30:00Z", exitCid: "payne-NVDA-20261001-1-S" }]);
let r = run(target, { now: "2026-10-05T20:30:00Z", argv: ["--reconcile"], live: true, orders: [ord({ id: "x1", client_order_id: "payne-NVDA-20261001-1-S", side: "sell", qty: "10", status: "expired", filled_qty: "6", filled_avg_price: "190", filled_at: "2026-10-05T13:30:00Z" })] });
let post = r.mut.find((c) => c.method === "POST");
if (OLD) ok(P().status === "open" && !post && !P().exitFills, "OLD P2: 6 sold shares unrecorded, pick back to open for the full 10, nothing re-sent", P());
else { ok(post && post.body.client_order_id === "payne-NVDA-20261001-1-S2" && post.body.qty === "4" && post.body.time_in_force === "day" && post.body.type === "market", "P2 remainder 4 re-sent as -S2 (DAY market)", post && post.body);
  ok(P().status === "exiting" && P().exitFills.length === 1 && P().exitFills[0].qty === 6, "P2 the 6 sold are recorded", P());
  // P3 the -S2 fills -> closed, fill-weighted exit
  r = run(target, { now: "2026-10-06T20:30:00Z", argv: ["--reconcile"], live: false, orders: [ord({ id: "x1", client_order_id: "payne-NVDA-20261001-1-S", side: "sell", qty: "10", status: "expired", filled_qty: "6", filled_avg_price: "190" }), ord({ id: "x2", client_order_id: "payne-NVDA-20261001-1-S2", side: "sell", qty: "4", status: "filled", filled_qty: "4", filled_avg_price: "195", filled_at: "2026-10-06T13:30:00Z" })] });
  ok(P().status === "closed" && Math.abs(P().exitFill - (6 * 190 + 4 * 195) / 10) < 1e-9, "P3 remainder filled: closed at the fill-weighted 192", P()); }
// P4 operator's second sell alert after an unfilled exit -> NEW client id, remaining qty
reset([{ ...pick0, status: "open", entryFill: 181, entryFilledAt: "2026-10-02T13:30:00Z", exitCid: "payne-NVDA-20261001-1-S" }]);
r = run(target, { now: "2026-10-06T15:00:00Z", argv: ["--add", "--sym", "NVDA", "--action", "sell", "--stated", "200", "--raw", "exit again"], live: true, orders: [ord({ id: "x1", client_order_id: "payne-NVDA-20261001-1-S", side: "sell", qty: "10", status: "expired", filled_qty: "0" })] });
post = r.calls.find((c) => c.method === "POST");
if (OLD) ok(post && post.body.client_order_id === "payne-NVDA-20261001-1-S" && readJsonl(LEDGER).some((x) => x.kind === "order-rejected"), "OLD P4: re-uses -S -> Alpaca 422, REJECTED; the pick can never exit", post && post.body);
else ok(post && post.body.client_order_id === "payne-NVDA-20261001-1-S2" && post.body.qty === "10" && r.orders.length === 2, "P4 second exit attempt goes out as -S2 for the 10 held", post && post.body);
// P5 exit alert while state still says 'pending' but the broker FILLED the entry -> sell, not cancel-before-fill
reset([{ ...pick0 }]);
r = run(target, { now: "2026-10-02T15:00:00Z", argv: ["--add", "--sym", "NVDA", "--action", "sell", "--stated", "200", "--raw", "exit"], live: true, orders: [ord({ id: "e1", client_order_id: pick0.entryCid, side: "buy", qty: "10", status: "filled", filled_qty: "10", filled_avg_price: "181", filled_at: "2026-10-02T13:30:00Z" })] });
post = r.calls.find((c) => c.method === "POST");
if (OLD) ok(P().status === "cancel-before-fill" && !post, "OLD P5: entry filled at the broker but the exit is skipped ('cancel-before-fill'); 10 sh orphaned", P().status);
else ok(post && post.body.side === "sell" && post.body.qty === "10" && P().status === "exiting", "P5 broker says filled -> exit sent for 10", post && post.body);
// P6 cancel-before-fill pick whose entry filled later -> reconcile --live sends the owed exit
reset([{ ...pick0, status: "cancel-before-fill", exitCid: "payne-NVDA-20261001-1-S", exitCids: ["payne-NVDA-20261001-1-S"] }]);
r = run(target, { now: "2026-10-02T20:30:00Z", argv: ["--reconcile"], live: true, orders: [ord({ id: "e1", client_order_id: pick0.entryCid, side: "buy", qty: "10", status: "filled", filled_qty: "10", filled_avg_price: "181", filled_at: "2026-10-02T13:30:00Z" })] });
post = r.mut.find((c) => c.method === "POST");
if (!OLD) ok(post && post.body.qty === "10" && post.body.client_order_id === "payne-NVDA-20261001-1-S2" && readJsonl(LEDGER).some((x) => x.kind === "entry-filled-after-exit-alert"), "P6 entry filled after the exit alert: flagged and the exit sent (-S2)", post && post.body);
// P8 reconcile WITHOUT --live never sends
reset([{ ...pick0, status: "exiting", entryFill: 181, exitCid: "payne-NVDA-20261001-1-S" }]);
r = run(target, { now: "2026-10-05T20:30:00Z", argv: ["--reconcile"], live: false, orders: [ord({ id: "x1", client_order_id: "payne-NVDA-20261001-1-S", side: "sell", qty: "10", status: "expired", filled_qty: "6", filled_avg_price: "190" })] });
ok(r.mut.length === 0, "P8 reconcile without --live sends nothing", r.mut);
if (!OLD) ok(r.status === 1 && /exit owed \(run with --live to re-send\)/.test(r.stdout), "P8 ...but an owed exit left unsent exits 1 (a chain step without --live is loud)", { status: r.status });
process.exitCode = summary("payne") ? 1 : 0;
