// alpaca-mirror exit-pass harness: fake MAIN broker. Usage: node test-mirror.cjs <runner file> [--expect-old]
"use strict";
const fs = require("fs"), path = require("path");
const { ok, summary, fakeBackend, harnessCopy, run, readJsonl } = require("./lib-harness.cjs");
const SRC = process.argv[2], OLD = process.argv.includes("--expect-old");
const bk = fakeBackend("mirror" + (OLD ? "-old" : ""));
const target = harnessCopy(SRC, bk, "alpaca-mirror.js", 'process.argv.includes("--live")');
const D = (f) => path.join(bk, "data", f), EX = D("alpaca-mirror-exits.jsonl");
const T = "1790257121881-Equity-CMI-qhlw";
fs.writeFileSync(D("board_positions.json"), "[]");
fs.writeFileSync(D("trade_log.json"), JSON.stringify([{ id: T, exit: 523.67, closedAt: 1790343313147, reason: "close" }]));
fs.writeFileSync(D("alpaca-mirror.jsonl"), JSON.stringify({ ts: "2026-09-30T15:00:00Z", ticketId: T, sym: "CMI", cls: "Equity", side: "sell", live: true, orderId: "E1", qty: 11, ticketEntry: 520 }) + "\n");
const entry = (legStatus = "canceled") => ({ id: "E1", client_order_id: "auto-E1", symbol: "CMI", side: "sell", qty: "11", status: "filled", filled_qty: "11", filled_avg_price: "520.1", order_class: "bracket",
  legs: [{ id: "L1", symbol: "CMI", side: "buy", type: "limit", order_type: "limit", qty: "11", status: legStatus, filled_qty: "0" }, { id: "L2", symbol: "CMI", side: "buy", type: "stop", order_type: "stop", qty: "11", status: legStatus === "canceled" ? "canceled" : "held", filled_qty: "0" }] });
const sentRow = { ts: "2026-10-01T18:12:07.292Z", ticketId: T, sym: "CMI", cls: "Equity", entryOrderId: "E1", live: true, entryFilledQty: 11, qty: 11, side: "buy", closeOrderId: "C1", status: "pending_new", action: "close buy 11 sent (pending_new) — final once it fills", final: false };
const mx = (o) => ({ id: "C1", client_order_id: "mx-" + T, symbol: "CMI", side: "buy", type: "market", time_in_force: "day", qty: "11", ...o });
const OPEN = { is_open: true, next_close: "2026-10-05T20:00:00Z" }, SHUT = { is_open: false };
const reset = (rows) => fs.writeFileSync(EX, rows.map((x) => JSON.stringify(x)).join("\n") + (rows.length ? "\n" : ""));
const last = () => { const r = readJsonl(EX); return r[r.length - 1]; };
console.log(`MIRROR harness on ${path.basename(SRC)}${OLD ? " (ORIGINAL)" : ""}`);
// M1: the 10-01 pattern — close order mx-T FILLED, legs cancelled by the mirror itself
reset([sentRow]);
let r = run(target, { now: "2026-10-01T18:40:00Z", argv: ["--exits-only"], live: true, clock: OPEN, orders: [entry(), mx({ status: "filled", filled_qty: "11", filled_avg_price: "523.5" })] });
let x = last();
if (OLD) ok(x.final && /bracket legs ended unfilled/.test(x.action) && x.closeFill == null, "OLD M1: the mirror's own filled close is finalised as 'closed elsewhere', fill never read (what happened to all 39 on 10-01)", x.action);
else ok(x.final && /^closed \(exit order filled 11\)/.test(x.action) && x.closeQty === 11 && x.closeFill === 523.5 && x.closeOrderId === "C1", "M1 filled close read first: final 'closed', closeQty 11, closeFill 523.5", x);
// M2: close EXPIRED with 6 of 11 filled, market open -> remainder 5 re-sent as mx-T-S2 (DAY market)
reset([sentRow]);
r = run(target, { now: "2026-10-05T14:00:00Z", argv: ["--exits-only"], live: true, clock: OPEN, orders: [entry(), mx({ status: "expired", filled_qty: "6", filled_avg_price: "523.5" })] });
x = last(); const post = r.mut.find((c) => c.method === "POST");
if (OLD) ok(x.final && !post, "OLD M2: partial close finalised, 5 shares left on the shared account, nothing re-sent", x.action);
else { ok(post && post.body.client_order_id === `mx-${T}-S2` && post.body.qty === "5" && post.body.side === "buy" && post.body.type === "market" && post.body.time_in_force === "day", "M2 remainder 5 sent as mx-<ticket>-S2, DAY market", post && post.body);
  ok(!x.final && x.closeQty === 6 && /remainder buy 5 sent/.test(x.action), "M2 row not final, records the 6 filled", x); }
// M3: next run — S2 filled 5 @ 524 -> final with closeQty 11 and fill-weighted closeFill
if (!OLD) {
  r = run(target, { now: "2026-10-05T15:00:00Z", argv: ["--exits-only"], live: true, clock: OPEN, orders: [entry(), mx({ status: "expired", filled_qty: "6", filled_avg_price: "523.5" }), mx({ id: "C2", client_order_id: `mx-${T}-S2`, qty: "5", status: "filled", filled_qty: "5", filled_avg_price: "524" })] });
  x = last(); ok(x.final && x.closeQty === 11 && Math.abs(x.closeFill - (6 * 523.5 + 5 * 524) / 11) < 1e-9 && x.closeCids.length === 2 && r.mut.length === 0, "M3 final: 11 closed over 2 orders, fill-weighted price, nothing new sent", x);
}
// M4: partial + market CLOSED -> waits, nothing sent, not final
reset([sentRow]);
r = run(target, { now: "2026-10-05T22:00:00Z", argv: ["--exits-only"], live: true, clock: SHUT, orders: [entry(), mx({ status: "expired", filled_qty: "6", filled_avg_price: "523.5" })] });
if (!OLD) ok(r.mut.length === 0 && readJsonl(EX).length === 1, "M4 market closed: remainder waits (no order, no row)", r.mut);
// M5: three close orders and still short -> final, left for the operator
reset([sentRow]);
r = run(target, { now: "2026-10-05T15:00:00Z", argv: ["--exits-only"], live: true, clock: OPEN, orders: [entry(), mx({ status: "expired", filled_qty: "6", filled_avg_price: "523.5" }), mx({ id: "C2", client_order_id: `mx-${T}-S2`, qty: "5", status: "expired", filled_qty: "2", filled_avg_price: "524" }), mx({ id: "C3", client_order_id: `mx-${T}-S3`, qty: "3", status: "canceled", filled_qty: "0" })] });
x = last(); if (!OLD) ok(x.final && /left for the operator/.test(x.action) && x.closeQty === 8 && r.mut.length === 0, "M5 3 attempts, 8 of 11 closed: final, left for the operator, no 4th order", x.action);
// M6: first close (no mx order yet, legs LIVE) — unchanged path: legs cancelled, then mx-T for the full 11
reset([]);
r = run(target, { now: "2026-10-05T15:00:00Z", argv: ["--exits-only"], live: true, clock: OPEN, orders: [entry("new")] });
const seq = r.mut.map((c) => `${c.method} ${c.path}${c.body ? " " + c.body.client_order_id + " " + c.body.qty : ""}`);
ok(seq.length === 3 && seq[0] === "DELETE /v2/orders/L1" && seq[1] === "DELETE /v2/orders/L2" && seq[2] === `POST /v2/orders mx-${T} 11` && !last().final, "M6 first close unchanged: cancel live legs, then mx-<ticket> for 11", seq);
// M7: DRY on a partial -> nothing sent
reset([sentRow]);
r = run(target, { now: "2026-10-05T14:00:00Z", argv: ["--exits-only"], live: false, clock: OPEN, orders: [entry(), mx({ status: "expired", filled_qty: "6", filled_avg_price: "523.5" })] });
ok(r.mut.length === 0, "M7 DRY: nothing sent", r.mut);
if (!OLD) ok(/would buy the remainder 5 as mx-/.test(r.stdout), "M7 DRY prints the remainder it would send");
// ---- review 2026-10-02: the mirror cancels the legs ITSELF, then the close POST is refused (403 wash trade) ----
const SHORT11 = [{ symbol: "CMI", side: "short", qty: "-11", qty_available: "-11" }];
const WASH = { "CMI|buy": "potential wash trade detected. use complex orders" };
const muts = (rr) => rr.mut.map((c) => `${c.method} ${c.path}${c.body ? " " + c.body.client_order_id + " " + c.body.qty : ""}`);
// M8 run A: legs live -> DELETE L1, DELETE L2, POST mx-T refused -> non-final FAILED row
reset([]);
r = run(target, { now: "2026-10-05T15:00:00Z", argv: ["--exits-only"], live: true, clock: OPEN, positions: SHORT11, postReject: WASH, orders: [entry("new")] });
x = last(); const rowsA = readJsonl(EX);
ok(muts(r).join(" | ") === `DELETE /v2/orders/L1 | DELETE /v2/orders/L2 | POST /v2/orders mx-${T} 11` && !x.final && /^close order FAILED/.test(x.action), "M8 run A: legs cancelled, close refused (403) -> non-final 'close order FAILED' row", { seq: muts(r), x });
if (!OLD) ok(x.legsCancelledByMirror === true, "M8 run A row says the mirror cancelled the legs", x);
// M8 run B: legs now canceled, no mx order exists -> NOT 'closed elsewhere': mx-T re-sent for 11
r = run(target, { now: "2026-10-05T15:10:00Z", argv: ["--exits-only"], live: true, clock: OPEN, positions: SHORT11, orders: [entry()] });
x = last();
if (OLD) ok(x.final && /bracket legs ended unfilled/.test(x.action) && r.mut.length === 0, "OLD M8 run B: the legs the mirror cancelled itself read as 'closed elsewhere' -> final, 11 shares left with no stop/target and no retry (the reviewer's repro)", x.action);
else ok(muts(r).join(" | ") === `POST /v2/orders mx-${T} 11` && !x.final && /^close buy 11 sent/.test(x.action), "M8 run B: close retried as mx-<ticket> for 11, row not final", { seq: muts(r), x });
if (!OLD) {
  // M9: refused 3 times in all -> final for the operator, no 4th POST
  reset(rowsA);
  r = run(target, { now: "2026-10-05T15:10:00Z", argv: ["--exits-only"], live: true, clock: OPEN, positions: SHORT11, postReject: WASH, orders: [entry()] });
  r = run(target, { now: "2026-10-05T15:20:00Z", argv: ["--exits-only"], live: true, clock: OPEN, positions: SHORT11, postReject: WASH, orders: [entry()] });
  const refusedRows = readJsonl(EX).filter((y) => /^close order FAILED/.test(y.action)).length;
  r = run(target, { now: "2026-10-05T15:30:00Z", argv: ["--exits-only"], live: true, clock: OPEN, positions: SHORT11, orders: [entry()] });
  x = last(); ok(refusedRows === 3 && x.final && /close refused 3 times after the mirror cancelled the legs — 11 left for the operator/.test(x.action) && r.mut.length === 0, "M9 3 refused closes -> final, left for the operator, no 4th order", { refusedRows, x: x.action, mut: r.mut });
  // M10: the broker position no longer covers the ticket (flattened by hand) -> final for the operator, nothing sent
  reset(rowsA);
  r = run(target, { now: "2026-10-05T15:10:00Z", argv: ["--exits-only"], live: true, clock: OPEN, positions: [], orders: [entry()] });
  x = last(); ok(x.final && /no longer covers 11 — left for the operator/.test(x.action) && r.mut.length === 0, "M10 position gone: no order (would have opened a long), final for the operator", { x: x.action, mut: r.mut });
  // M11: legs slow to cancel (pending_cancel for 6 s) -> non-final row flagged; next run (legs canceled) retries the close
  reset([]);
  r = run(target, { now: "2026-10-05T15:00:00Z", argv: ["--exits-only"], live: true, clock: OPEN, positions: SHORT11, deleteLeaves: "pending_cancel", orders: [entry("new")] });
  x = last(); ok(!x.final && x.legsCancelledByMirror === true && /did not cancel in 6 s/.test(x.action) && !r.mut.some((c) => c.method === "POST"), "M11 slow cancel: non-final flagged row (was console only), no close yet", x);
  r = run(target, { now: "2026-10-05T15:10:00Z", argv: ["--exits-only"], live: true, clock: OPEN, positions: SHORT11, orders: [entry()] });
  ok(muts(r).join(" | ") === `POST /v2/orders mx-${T} 11` && !last().final, "M11 next run: legs canceled -> close sent, not 'closed elsewhere'", muts(r));
  // M12: DRY in the self-cut state -> GETs only, prints the close it would send
  reset(rowsA);
  r = run(target, { now: "2026-10-05T15:10:00Z", argv: ["--exits-only"], live: false, clock: OPEN, positions: SHORT11, orders: [entry()] });
  ok(r.mut.length === 0 && /would buy 11 at market to close/.test(r.stdout) && readJsonl(EX).length === rowsA.length, "M12 DRY: nothing sent, nothing written, prints the retry", r.mut);
  // M13: legs that ended unfilled with NO mirror row (the 09-24 flatten) -> still 'closed elsewhere' (unchanged)
  reset([]);
  r = run(target, { now: "2026-10-05T15:10:00Z", argv: ["--exits-only"], live: true, clock: OPEN, positions: SHORT11, orders: [entry()] });
  x = last(); ok(x.final && /bracket legs ended unfilled/.test(x.action) && r.mut.length === 0, "M13 legs ended without the mirror -> 'closed elsewhere' as before", x.action);
  // M14 (runs last: rewrites the mirror log) two self-cut tickets on the same symbol, broker short only 11 -> the first is retried, the second goes to the operator
  const T2 = "1790257121999-Equity-CMI-zzzz";
  fs.writeFileSync(D("trade_log.json"), JSON.stringify([{ id: T, exit: 523.67, closedAt: 1790343313147, reason: "close" }, { id: T2, exit: 523.67, closedAt: 1790343313147, reason: "close" }]));
  fs.appendFileSync(D("alpaca-mirror.jsonl"), JSON.stringify({ ts: "2026-09-30T15:05:00Z", ticketId: T2, sym: "CMI", cls: "Equity", side: "sell", live: true, orderId: "E2", qty: 11, ticketEntry: 520 }) + "\n");
  const entry2 = { ...entry(), id: "E2", client_order_id: "auto-E2", legs: [{ id: "L3", symbol: "CMI", side: "buy", type: "limit", qty: "11", status: "canceled", filled_qty: "0" }, { id: "L4", symbol: "CMI", side: "buy", type: "stop", qty: "11", status: "canceled", filled_qty: "0" }] };
  reset([...rowsA, { ...rowsA[rowsA.length - 1], ticketId: T2, entryOrderId: "E2" }]);
  r = run(target, { now: "2026-10-05T15:10:00Z", argv: ["--exits-only"], live: true, clock: OPEN, positions: SHORT11, orders: [entry(), entry2] });
  const rows14 = readJsonl(EX).slice(-2);
  ok(muts(r).join(" | ") === `POST /v2/orders mx-${T} 11` && !rows14[0].final && rows14[1].ticketId === T2 && rows14[1].final && /no longer covers 11/.test(rows14[1].action), "M14 same symbol, one position of 11: first ticket retried, second left for the operator (no double close)", { seq: muts(r), rows14: rows14.map((y) => y.action) });
}
process.exitCode = summary("mirror") ? 1 : 0;
