// r191 / r231 harness: fake MAIN broker + fake Coinbase candles. Usage: node test-crypto.cjs <r191 file> <r231 file> [--expect-old]
"use strict";
const fs = require("fs"), path = require("path");
const { ok, summary, fakeBackend, harnessCopy, run, readJson, readJsonl } = require("./lib-harness.cjs");
const [S191, S231] = process.argv.slice(2), OLD = process.argv.includes("--expect-old");
const NOW = "2026-10-05T20:20:00Z", DAY = "20261005";
// ---------- R191 ----------
{
  const bk = fakeBackend("r191" + (OLD ? "-old" : "")), target = harnessCopy(S191, bk, "r191-crypto-trend-forward.js", 'process.argv.includes("--live")');
  const STATE = path.join(bk, "data", "r191-crypto-trend.json"), LEDGER = path.join(bk, "data", "r191-crypto-trend.jsonl");
  const reset = (coins, ledgerRows = []) => { fs.writeFileSync(STATE, JSON.stringify({ spec: "r191-state-v1", coins, marks: [], orders: [] })); fs.writeFileSync(LEDGER, ledgerRows.map((x) => JSON.stringify(x)).join("\n") + (ledgerRows.length ? "\n" : "")); };
  const C = () => readJson(STATE).coins;
  console.log(`R191 harness on ${path.basename(S191)}${OLD ? " (ORIGINAL)" : ""}`);
  // C5 normal: pending buy filled -> held, qty = filled_qty (unchanged)
  reset({ BTC: { qty: 0, held: false, pending: { cid: "r191-BTC-20261002-buy", side: "buy", signalClose: 100 } }, ETH: { qty: 0, held: false, pending: null } });
  let r = run(target, { now: NOW, argv: ["--run"], live: true, cb: { BTC: { dir: "up", base: 100 }, ETH: { dir: "down", base: 100 } }, orders: [{ id: "o1", client_order_id: "r191-BTC-20261002-buy", symbol: "BTC/USD", side: "buy", notional: "10000", status: "filled", filled_qty: "0.116651415", filled_avg_price: "85726" }] });
  ok(C().BTC.held && C().BTC.qty === 0.116651415 && !C().BTC.pending && readJsonl(LEDGER).some((x) => x.kind === "filled"), "C5 full fill: held, qty = filled_qty", C().BTC);
  // C1 buy CANCELED with a partial fill
  reset({ BTC: { qty: 0, held: false, pending: { cid: "r191-BTC-20261002-buy", side: "buy", signalClose: 100 } }, ETH: { qty: 0, held: false, pending: null } });
  r = run(target, { now: NOW, argv: ["--run"], live: true, cb: { BTC: { dir: "up", base: 100 }, ETH: { dir: "down", base: 100 } }, orders: [{ id: "o1", client_order_id: "r191-BTC-20261002-buy", symbol: "BTC/USD", side: "buy", notional: "10000", status: "canceled", filled_qty: "0.05", filled_avg_price: "85726" }] });
  if (OLD) ok(!C().BTC.held && C().BTC.qty === 0, "OLD C1: canceled buy with 0.05 BTC filled -> 'not-filled'; the 0.05 is held at the broker but not in the test", C().BTC);
  else ok(C().BTC.held && C().BTC.qty === 0.05 && readJsonl(LEDGER).some((x) => x.kind === "partial-filled"), "C1 partial buy: held 0.05 (filled_qty)", C().BTC);
  // C2 sell CANCELED with a partial fill
  reset({ BTC: { qty: 0.116651415, held: true, pending: { cid: "r191-BTC-20261002-sell", side: "sell", signalClose: 100 } }, ETH: { qty: 0, held: false, pending: null } });
  r = run(target, { now: NOW, argv: ["--run"], live: true, cb: { BTC: { dir: "up", base: 100 }, ETH: { dir: "down", base: 100 } }, orders: [{ id: "o2", client_order_id: "r191-BTC-20261002-sell", symbol: "BTC/USD", side: "sell", qty: "0.116651415", status: "canceled", filled_qty: "0.06", filled_avg_price: "85000" }] });
  if (OLD) ok(C().BTC.qty === 0.116651415, "OLD C2: canceled sell with 0.06 filled -> qty unchanged (0.116651415) though the broker sold 0.06", C().BTC);
  else ok(C().BTC.held && C().BTC.qty === 0.056651415, "C2 partial sell: 0.056651415 still held (sold next OUT run)", C().BTC);
  // C3 ETH buy refused at POST after BTC's went out -> BTC pending kept, run continues, exit 1
  reset({ BTC: { qty: 0, held: false, pending: null }, ETH: { qty: 0, held: false, pending: null } });
  r = run(target, { now: NOW, argv: ["--run"], live: true, cb: { BTC: { dir: "up", base: 100 }, ETH: { dir: "up", base: 100 } }, postReject: { "ETH/USD": "insufficient balance" } });
  if (OLD) ok(r.orders.length === 1 && !C().BTC.pending && r.status === 1, "OLD C3: run throws at the ETH refusal; the BTC order at the broker is in no pending (state never saved)", { pend: C().BTC.pending, status: r.status });
  else ok(r.orders.length === 1 && C().BTC.pending && C().BTC.pending.cid === `r191-BTC-${DAY}-buy` && !C().ETH.pending && r.status === 1 && readJsonl(LEDGER).some((x) => x.kind === "order-rejected"), "C3 BTC pending kept, ETH refusal recorded, exit 1", { C: C(), status: r.status });
  // C4 same-day re-send: the day's client id was already used (in the ledger) -> -2
  reset({ BTC: { qty: 0, held: false, pending: null }, ETH: { qty: 0, held: false, pending: null } }, [{ kind: "sent", coin: "BTC", cid: `r191-BTC-${DAY}-buy`, side: "buy" }, { kind: "not-filled", coin: "BTC", cid: `r191-BTC-${DAY}-buy`, status: "canceled" }]);
  r = run(target, { now: NOW, argv: ["--run"], live: true, cb: { BTC: { dir: "up", base: 100 }, ETH: { dir: "down", base: 100 } }, orders: [{ id: "o9", client_order_id: `r191-BTC-${DAY}-buy`, symbol: "BTC/USD", side: "buy", status: "canceled", filled_qty: "0" }] });
  const p4 = r.mut.find((c) => c.method === "POST");
  if (OLD) ok(p4 && p4.body.client_order_id === `r191-BTC-${DAY}-buy` && r.status === 1, "OLD C4: re-sends the used client id -> 422 -> run throws", p4 && p4.body);
  else ok(p4 && p4.body.client_order_id === `r191-BTC-${DAY}-buy-2` && C().BTC.pending.cid === `r191-BTC-${DAY}-buy-2`, "C4 used client id -> fresh one (-2)", p4 && p4.body);
  ok(r.mut.every((c) => c.body.time_in_force === "gtc" && c.body.type === "market"), "R191 orders are gtc market (crypto), no opg/cls");
  // ---- review 2026-10-02: a POST that timed out AFTER Alpaca created the order, read-back also failed -> order-rejected, no pending. Same-evening re-run: ----
  const rejRow = [{ kind: "order-rejected", cid: `r191-BTC-${DAY}-buy`, side: "buy", error: "fetch failed (timeout)" }];
  const liveBuy = { id: "o7", client_order_id: `r191-BTC-${DAY}-buy`, symbol: "BTC/USD", side: "buy", notional: "10000", status: "accepted", filled_qty: "0" };
  // C6 the order is at the broker (working) -> ADOPTED, no POST at all (the old pending file POSTed -2 = a second $10k buy)
  reset({ BTC: { qty: 0, held: false, pending: null }, ETH: { qty: 0, held: false, pending: null } }, rejRow);
  r = run(target, { now: NOW, argv: ["--run"], live: true, cb: { BTC: { dir: "up", base: 100 }, ETH: { dir: "down", base: 100 } }, orders: [liveBuy] });
  if (OLD) ok(r.mut.some((c) => c.method === "POST" && c.body.client_order_id === `r191-BTC-${DAY}-buy`) && r.status === 1, "OLD C6: re-sends the same id -> 422 -> run stops (no duplicate, no pending)", r.mut.map((c) => c.body && c.body.client_order_id));
  else ok(!r.mut.some((c) => c.method === "POST") && C().BTC.pending && C().BTC.pending.cid === `r191-BTC-${DAY}-buy` && readJsonl(LEDGER).some((x) => x.kind === "sent" && x.adopted === true && x.brokerStatus === "accepted"), "C6 existing order adopted by its id: no POST, pending = the original id", { mut: r.mut, BTC: C().BTC });
  // C7 the adopted order already FILLED -> adopted; the next run books the fill (held)
  reset({ BTC: { qty: 0, held: false, pending: null }, ETH: { qty: 0, held: false, pending: null } }, rejRow);
  const filledBuy = { ...liveBuy, status: "filled", filled_qty: "0.1", filled_avg_price: "100000", filled_at: "2026-10-05T20:00:01Z" };
  r = run(target, { now: NOW, argv: ["--run"], live: true, cb: { BTC: { dir: "up", base: 100 }, ETH: { dir: "down", base: 100 } }, orders: [filledBuy] });
  if (!OLD) { const noPost = !r.mut.some((c) => c.method === "POST");
    r = run(target, { now: "2026-10-05T21:20:00Z", argv: ["--run"], live: true, cb: { BTC: { dir: "up", base: 100 }, ETH: { dir: "down", base: 100 } }, orders: [filledBuy] });
    ok(noPost && !r.mut.some((c) => c.method === "POST") && C().BTC.held && C().BTC.qty === 0.1 && !C().BTC.pending, "C7 filled order adopted, next run books it (held 0.1), never a second buy", C().BTC); }
  // C8 the id lookup itself fails (503) -> nothing sent, exit 1, the day's mark still written
  reset({ BTC: { qty: 0, held: false, pending: null }, ETH: { qty: 0, held: false, pending: null } }, rejRow);
  r = run(target, { now: NOW, argv: ["--run"], live: true, cb: { BTC: { dir: "up", base: 100 }, ETH: { dir: "down", base: 100 } }, orders: [liveBuy], cidLookupFail: [`r191-BTC-${DAY}-buy`] });
  if (!OLD) ok(!r.mut.some((c) => c.method === "POST") && r.status === 1 && !C().BTC.pending && readJson(STATE).marks.some((m) => m.coin === "BTC") && readJson(STATE).marks.some((m) => m.coin === "ETH"), "C8 lookup error: no order, exit 1, BTC and ETH still marked", { mut: r.mut, status: r.status, marks: readJson(STATE).marks.length });
  summary("r191");
}
// ---------- R231 ----------
{
  const bk = fakeBackend("r231" + (OLD ? "-old" : "")), target = harnessCopy(S231, bk, "r231-crypto-vote-sized-forward.js", 'process.argv.includes("--live")');
  const STATE = path.join(bk, "data", "r231-crypto-vote-sized.json"), LEDGER = path.join(bk, "data", "r231-crypto-vote-sized.jsonl");
  const U = ["BTC", "ETH", "LTC", "BCH", "LINK", "ADA", "SOL", "DOGE", "AVAX", "DOT", "UNI", "AAVE", "XTZ"];
  const coins = (o = {}) => Object.fromEntries(U.map((c) => [c, { qty: 0, notional: 0, pending: null, ...(o[c] || {}) }]));
  const reset = (c) => { fs.writeFileSync(STATE, JSON.stringify({ spec: "r231-state-v1", coins: c, marks: [], orders: [] })); if (fs.existsSync(LEDGER)) fs.unlinkSync(LEDGER); };
  const C = () => readJson(STATE).coins;
  const down = Object.fromEntries(U.map((c) => [c, { dir: "down", base: 100 }]));
  console.log(`R231 harness on ${path.basename(S231)}${OLD ? " (ORIGINAL)" : ""}`);
  // D1 pending sell expired with a partial fill
  reset(coins({ ETH: { qty: 0.471380983, pending: { cid: "r231-ETH-20261002-sell", side: "sell", signalClose: 100 } } }));
  let r = run(target, { now: NOW, argv: ["--run"], live: false, cb: down, orders: [{ id: "o1", client_order_id: "r231-ETH-20261002-sell", symbol: "ETH/USD", side: "sell", qty: "0.471380983", status: "expired", filled_qty: "0.2", filled_avg_price: "2500" }] });
  const st = readJson(STATE);   // dry run: state not saved -> read the ledger
  const L = readJsonl(LEDGER);
  if (OLD) ok(L.some((x) => x.kind === "not-filled" && x.coin === "ETH"), "OLD D1: expired sell with 0.2 ETH sold -> 'not-filled'", L);
  else ok(L.some((x) => x.kind === "partial-filled" && x.coin === "ETH" && x.qty === 0.2), "D1 partial sell recorded from filled_qty", L);
  // D2 full exit of a held coin (all signals down): sell qty sent with at most 9 decimals, never more than held
  reset(coins({ DOGE: { qty: 7051.813000848 }, ADA: { qty: 2994.44994848 } }));
  r = run(target, { now: NOW, argv: ["--run"], live: true, cb: down, orders: [] });
  const sells = r.mut.filter((c) => c.method === "POST").map((c) => c.body.qty);
  ok(sells.length === 2 && sells.every((q) => /^\d+(\.\d{1,9})?$/.test(q)), "D2 sell quantities are plain decimals with <= 9 places", sells);
  if (!OLD) ok(sells.includes("7051.813000848") && sells.includes("2994.449948480"), "D2 a full exit sells exactly the held quantity", sells);
  // D3 a refused buy does not abort the run (others go, pending saved), exit 1
  reset(coins());
  r = run(target, { now: NOW, argv: ["--run"], live: true, cb: Object.fromEntries(U.map((c) => [c, { dir: "up", base: 100 }])), postReject: { "SOL/USD": "insufficient balance" } });
  const pend = Object.values(C()).filter((x) => x.pending).length;
  if (OLD) ok(r.status === 1 && pend === 0, "OLD D3: one refusal throws; every order already sent is in no pending list", { pend, sent: r.orders.length });
  else ok(r.status === 1 && pend === r.orders.length && r.orders.length >= 10 && !C().SOL.pending, "D3 refusal recorded, the other buys sent and pending", { pend, sent: r.orders.length });
  // D4 (review 2026-10-02): BTC's buy timed out after Alpaca created it, read-back failed (ledger order-rejected, no pending) -> re-run adopts, no BTC POST
  reset(coins()); fs.writeFileSync(LEDGER, JSON.stringify({ kind: "order-rejected", cid: `r231-BTC-${DAY}-buy`, side: "buy", error: "fetch failed (timeout)" }) + "\n");
  r = run(target, { now: NOW, argv: ["--run"], live: true, cb: Object.fromEntries(U.map((c) => [c, { dir: "up", base: 100 }])), orders: [{ id: "b7", client_order_id: `r231-BTC-${DAY}-buy`, symbol: "BTC/USD", side: "buy", notional: "1500", status: "accepted", filled_qty: "0" }] });
  const btcPosts = r.mut.filter((c) => c.method === "POST" && c.body.symbol === "BTC/USD");
  if (OLD) ok(btcPosts.length === 1 && btcPosts[0].body.client_order_id === `r231-BTC-${DAY}-buy`, "OLD D4: re-sends the same id (422) — no duplicate but the run throws", btcPosts.map((c) => c.body.client_order_id));
  else ok(btcPosts.length === 0 && C().BTC.pending && C().BTC.pending.cid === `r231-BTC-${DAY}-buy` && r.mut.filter((c) => c.method === "POST").length >= 10, "D4 BTC order adopted (no POST, no -2); the other coins sent as usual", { btcPosts: btcPosts.length, pend: C().BTC.pending });
  process.exitCode = summary("crypto") ? 1 : 0;
}
