/**
 * TRACK-RECORD VERIFICATION — known answers on frozen fixtures (2026-09-22). No network: fixtures in test/fixtures, built once by
 * test/build-fixtures.js. Each test locks down a behaviour a buyer of the check would rely on.
 */
const { suite, test, eq, close, ok } = require("./run");
const fs = require("fs"), path = require("path");
const V = require("../lib/verify");
const FX = (f) => path.join(__dirname, "fixtures", f);
const nq = JSON.parse(fs.readFileSync(FX("nq-1m-2026-09-21.json"), "utf8")).rows, aapl = JSON.parse(fs.readFileSync(FX("aapl-1m-2026-07-01.json"), "utf8")).rows;
const c2 = fs.readFileSync(FX("c2-sample.csv"), "utf8");
const lookups = { NQ: V.makeLookup(nq), AAPL: V.makeLookup(aapl) }, lookupFor = (t) => lookups[t.dataRoot] || null;

suite("verify · parsing a track record", () => {
  const p = V.parseTrackRecord(c2);
  test("recognises the Collective2 trading-record export", () => eq(p.format, "collective2-trading-record"));
  test("reads both sample trades with side, prices and times", () => { eq(p.trades.length, 2); eq(p.trades[0].side, 1); eq(p.trades[1].side, -1); close(p.trades[0].openPx, 30289.6784, 1e-9); });
  test("maps @MNQZ6 to the NQ data root at $2 a point", () => { eq(p.trades[0].dataRoot, "NQ"); eq(p.trades[0].pointValue, 2); eq(p.trades[0].contract, "Z6"); });
  test("reads ET wall-clock times across daylight time (09:37:44 EDT = 13:37:44Z)", () => eq(new Date(p.trades[0].openMs).toISOString(), "2026-09-21T13:37:44.000Z"));
  test("ET in winter is UTC-5 (2026-01-15 10:00 ET = 15:00Z)", () => eq(new Date(V.etToMs("2026-01-15 10:00:00")).toISOString(), "2026-01-15T15:00:00.000Z"));
  test("a bare CL is Colgate stock, not crude oil; @CL is the future", () => { eq(V.classify("CL").assetClass, "stock"); eq(V.classify("@CL").assetClass, "future"); eq(V.classify("ESZ5").dataRoot, "ES"); });
  test("an unreadable row is skipped with a warning, never guessed", () => { const r = V.parseTrackRecord("symbol,side,open_time,open_price,close_time,close_price\nAAPL,BUY,2026-07-01 10:00,200,,201\n"); eq(r.trades.length, 0); ok(/close time/.test(r.warnings[0])); });
});

suite("verify · fill check against real minute bars", () => {
  const real = V.verifyRecord(c2, lookupFor);
  test("ares' real 2026-09-21 trade sits inside the real NQ range at entry and exit", () => { const t = real.fillCheck.perTrade.find((x) => x.id === "157667174"); eq(t.entry.status, "inside"); eq(t.exit.status, "inside"); });
  test("a trade on a day with no bars is NO-BAR, never counted as clean", () => { const t = real.fillCheck.perTrade.find((x) => x.id === "157603510"); eq(t.entry.status, "no-bar"); eq(real.fillCheck.noBar, 2); eq(real.fillCheck.checked, 2); });
  const planted = V.verifyRecord("symbol,side,open_time,open_price,close_time,close_price\nAAPL,BUY,2026-07-01 10:30,1.00,2026-07-01 15:00,1000\n", lookupFor);
  test("a flattering fake (bought far below, sold far above the market) is OUTSIDE and FAVOURS the strategy", () => { eq(planted.fillCheck.outside, 2); eq(planted.fillCheck.outsideFavoringStrategy, 2); ok(/CAUTION/.test(planted.fillCheck.reading)); });
  const inside = V.parseTrackRecord("symbol,side,open_time,open_price,close_time,close_price\nAAPL,BUY,2026-07-01 10:30,0,2026-07-01 15:00,0\n");
  const shifted = V.verifyRecord(c2.replace('"30289.6784"', '"30209.6784"'), lookupFor);
  test("a futures entry 80 points below the 3-minute range is caught (tolerance is one tick, not a percentage, and it is not mistaken for a contract roll)", () => { const t = shifted.fillCheck.perTrade.find((x) => x.id === "157667174"); eq(t.entry.status, "outside"); eq(t.entry.againstStrategy, false); });
  test("prices of zero are rejected at parse time", () => eq(inside.trades.length, 0));
  test("every output carries what a clean check does NOT establish", () => ok(/nothing about whether the strategy will make money/.test(real.doesNotEstablish)));
});

suite("verify · real fills vs hypothetical", () => {
  test("a CSV cannot show it — says so instead of guessing", () => eq(V.realVsHypothetical(V.parseTrackRecord(c2).trades).determinable, false));
  test("with per-fill data it counts legs priced at the real fill average", () => {
    const r = V.realVsHypothetical([{ legs: [{ price: 10, fills: [{ price: 9.9, quant: 1 }, { price: 10.1, quant: 1 }] }, { price: 10, fills: [{ price: 10.5, quant: 1 }] }, { price: 10, fills: [] }] }]);
    eq(r.legs, 3); eq(r.legsWithRealFills, 2); eq(r.legsPricedAtRealFillAverage, 1); close(r.realSharePct, 33.3, 0.05);
  });
});

suite("verify · cost re-pricing and forward requests", () => {
  const r = V.reprice(V.parseTrackRecord(c2).trades);
  test("futures: gross points minus 0.75 pt, in dollars at the contract's point value", () => { const t = r.perTrade.find((x) => x.id === "157667174"); close(t.grossPts, 492.5235, 1e-4); close(t.netPts, 491.7735, 1e-4); close(t.netDollarsPerContract, 983.55, 0.01); });
  test("a short's gross is entry minus exit", () => close(r.perTrade.find((x) => x.id === "157603510").grossPts, 13.797, 1e-3));
  test("a registration request is PENDING — nothing is registered without the operator", () => { const q = V.registrationRequest({ format: "x", trades: 2, fillCheck: { reading: "CONSISTENT" } }, { name: "t" }); eq(q.status, "PENDING_OPERATOR_APPROVAL"); ok(/Nothing is registered/.test(q.rule)); });
});
