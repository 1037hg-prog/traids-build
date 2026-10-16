#!/usr/bin/env node
/**
 * OPTIONS MIRROR TO THE BOOK ACCOUNT — SELFTEST. A fake broker in memory: no network, no key, no order anywhere.
 *   node docs/options-to-book-account/2026-10-16/selftest.cjs
 * Ends with "SELFTEST PASSED (n checks)" or exits 1 naming each failure.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");
const { loadCjs } = require("./loadcjs.cjs");
const G = loadCjs(path.join(PKG, "staged", "backend", "lib", "book-options-guard.js"));
const P = require("./pkg.cjs"), R = require("./record.cjs");

let n = 0; const fails = [];
const ok = (name, cond, detail) => { n++; if (!cond) fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };
// plainly fake values: never real keys or account numbers
const FAKE = { ALPACA_BOOK_KEY_ID: "FAKE-BOOK-KEY", ALPACA_BOOK_SECRET_KEY: "FAKE-BOOK-SECRET", ALPACA_BOOK_ACCOUNT_NUMBER: "PAFAKEBOOK1", ALPACA_KEY_ID: "FAKE-MAIN-KEY", ALPACA_SECRET_KEY: "FAKE-MAIN-SECRET" };
const OCC = "XYZ261120C00050000", OCC2 = "XYZ261120C00055000";

/** a fake broker: records every call; answers /v2/account with `acct`; orders by id from `orders`. */
function fakeBroker({ acct = { account_number: "PAFAKEBOOK1" }, orders = {}, accountFails = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url), p = u.pathname, m = init.method;
    calls.push({ host: u.host, method: m, path: p + u.search, body: init.body ? JSON.parse(init.body) : undefined, key: init.headers["APCA-API-KEY-ID"] });
    const res = (status, obj) => ({ ok: status < 300, status, text: async () => (obj === undefined ? "" : JSON.stringify(obj)) });
    if (m === "GET" && p === "/v2/account") return accountFails ? res(500, { message: "down" }) : res(200, acct);
    const mo = /^\/v2\/orders\/([^/]+)$/.exec(p);
    if (m === "GET" && mo) return orders[mo[1]] ? res(200, orders[mo[1]]) : res(404, { message: "not found" });
    if (m === "GET") return res(200, []);
    return res(200, { id: "fake-order", ok: true });
  };
  return { fetchImpl, calls, writes: () => calls.filter((c) => c.method !== "GET") };
}
const guardWith = (opt = {}, env = FAKE) => { const b = fakeBroker(opt); return { b, g: G.makeBookOptionsGuard({ env, fetchImpl: b.fetchImpl }) }; };
const refusedWith = async (fn, code) => { try { await fn(); return false; } catch (e) { return e instanceof G.GuardRefusal && (!code || e.code === code) ? true : `${e.name}:${e.code}:${e.message}`; } };
const single = (o = {}) => ({ symbol: OCC, qty: "1", side: "buy", type: "limit", limit_price: "1.10", time_in_force: "day", ...o });
const mleg = (o = {}) => ({ order_class: "mleg", qty: "1", type: "limit", limit_price: "-0.40", time_in_force: "day", legs: [{ symbol: OCC, ratio_qty: "1", side: "sell", position_intent: "sell_to_open" }, { symbol: OCC2, ratio_qty: "1", side: "buy", position_intent: "buy_to_open" }], ...o });

(async () => {
  // ---- 1. OCC symbols ---------------------------------------------------------------------------------------------------------
  ok("OCC symbols are options", G.isOccSymbol(OCC) && G.isOccSymbol("SPY261016P00580000") && G.isOccSymbol("BRKB270115C00500000"));
  ok("stock / ETF / crypto symbols are not", !G.isOccSymbol("SPY") && !G.isOccSymbol("AAPL") && !G.isOccSymbol("BTC/USD") && !G.isOccSymbol("") && !G.isOccSymbol(undefined));
  ok("a bad date or zero strike is not", !G.isOccSymbol("XYZ261320C00050000") && !G.isOccSymbol("XYZ260231C00050000") && !G.isOccSymbol("XYZ261120C00000000") && !G.isOccSymbol("xyz261120c00050000"));

  // ---- 2. order bodies -----------------------------------------------------------------------------------------------------
  ok("a single-leg option order passes", G.checkOptionOrder(single()) === null);
  ok("an mleg order of options passes", G.checkOptionOrder(mleg()) === null);
  ok("a stock order is refused", /not an option/.test(G.checkOptionOrder(single({ symbol: "SPY" }))));
  ok("a share sweep (stock sell) is refused", G.checkOptionOrder({ symbol: "XYZ", qty: "100", side: "sell", type: "market", time_in_force: "day" }) !== null);
  ok("an mleg with a stock leg is refused", /not an option/.test(G.checkOptionOrder(mleg({ legs: [{ symbol: OCC, ratio_qty: "1", side: "buy" }, { symbol: "XYZ", ratio_qty: "100", side: "sell" }] }))));
  ok("an mleg with a top-level symbol is refused", G.checkOptionOrder(mleg({ symbol: "XYZ" })) !== null);
  ok("an mleg with 0 or 5 legs is refused", G.checkOptionOrder(mleg({ legs: [] })) !== null && G.checkOptionOrder(mleg({ legs: Array(5).fill({ symbol: OCC, ratio_qty: "1", side: "buy" }) })) !== null);
  ok("notional is refused", G.checkOptionOrder(single({ notional: "100" })) !== null);
  ok("fractional / zero / missing qty is refused", G.checkOptionOrder(single({ qty: 0.5 })) !== null && G.checkOptionOrder(single({ qty: "0.5" })) !== null && G.checkOptionOrder(single({ qty: 0 })) !== null && G.checkOptionOrder(single({ qty: undefined })) !== null);
  ok("bracket / oco / oto are refused", ["bracket", "oco", "oto"].every((c) => G.checkOptionOrder(single({ order_class: c })) !== null));
  ok("a single-leg body with legs is refused", G.checkOptionOrder(single({ legs: [] })) !== null);
  ok("a non-object body is refused", G.checkOptionOrder(null) !== null && G.checkOptionOrder([single()]) !== null && G.checkOptionOrder("x") !== null);

  // ---- 3. construction: keys, account pin, host ------------------------------------------------------------------------------
  const ctor = (env, o = {}) => { try { G.makeBookOptionsGuard({ env, fetchImpl: fakeBroker().fetchImpl, ...o }); return null; } catch (e) { return e.code || e.message; } };
  ok("BOOK keys and pin: the guard builds", ctor(FAKE) === null);
  ok("no BOOK keys: refused (no fallback to the main keys)", ctor({ ...FAKE, ALPACA_BOOK_KEY_ID: "" }) === "NO_KEYS" && ctor({ ALPACA_KEY_ID: "FAKE-MAIN-KEY", ALPACA_SECRET_KEY: "FAKE-MAIN-SECRET", ALPACA_BOOK_ACCOUNT_NUMBER: "PAFAKEBOOK1" }) === "NO_KEYS");
  ok("no BOOK account pin: refused", ctor({ ...FAKE, ALPACA_BOOK_ACCOUNT_NUMBER: undefined }) === "NOT_PINNED");
  ok("a pin that is not a paper account: refused", ctor({ ...FAKE, ALPACA_BOOK_ACCOUNT_NUMBER: "FAKELIVE1" }) === "NOT_PAPER");
  ok("BOOK key id equal to the main key id: refused", ctor({ ...FAKE, ALPACA_BOOK_KEY_ID: "FAKE-MAIN-KEY" }) === "SHARED_KEYS");
  ok("BOOK key id equal to the TV key id: refused", ctor({ ...FAKE, ALPACA_TV_KEY_ID: "FAKE-BOOK-KEY" }) === "SHARED_KEYS");
  ok("a live or other host: refused", ctor(FAKE, { base: "https://api.alpaca.markets" }) === "HOST" && ctor(FAKE, { base: "https://paper-api.alpaca.markets.example" }) === "HOST");

  // ---- 4. the account the broker reports -------------------------------------------------------------------------------------
  {
    const { b, g } = guardWith();
    ok("BOOK account reported: an option order goes through", (await g.request("POST", "/v2/orders", single())).ok === true && b.writes().length === 1 && b.writes()[0].body.symbol === OCC);
    ok("…sent with the BOOK key id only, to the paper host", b.calls.every((c) => c.key === "FAKE-BOOK-KEY" && c.host === "paper-api.alpaca.markets"));
    ok("…and the account was read before the write", b.calls[0].path === "/v2/account" && b.calls[1].method === "POST");
  }
  {
    const { b, g } = guardWith({ acct: { account_number: "PAFAKEMAIN9" } });
    ok("the broker reports another account: refused, nothing sent", (await refusedWith(() => g.request("POST", "/v2/orders", single()), "WRONG_ACCOUNT")) === true && b.writes().length === 0);
  }
  {
    const { b, g } = guardWith({ acct: { account_number: "FAKELIVE1" } }, { ...FAKE, ALPACA_BOOK_ACCOUNT_NUMBER: "PAFAKEBOOK1" });
    ok("the broker reports a non-paper account: refused", (await refusedWith(() => g.request("POST", "/v2/orders", single()), "NOT_PAPER")) === true && b.writes().length === 0);
  }
  {
    const { b, g } = guardWith({ accountFails: true });
    ok("the account cannot be read: refused (fail closed)", (await refusedWith(() => g.request("POST", "/v2/orders", single()), "ACCOUNT_UNREAD")) === true && b.writes().length === 0);
  }
  {
    const { b, g } = guardWith({ acct: {} });
    ok("an account record with no number: refused", (await refusedWith(() => g.request("POST", "/v2/orders", single()))) === true && b.writes().length === 0);
  }

  // ---- 5. every write path ---------------------------------------------------------------------------------------------------
  {
    const orders = { "opt-1": { id: "opt-1", symbol: OCC, asset_class: "us_option", order_class: "simple" }, "ml-1": { id: "ml-1", symbol: "", order_class: "mleg", legs: [{ symbol: OCC, asset_class: "us_option" }, { symbol: OCC2, asset_class: "us_option" }] }, "etf-1": { id: "etf-1", symbol: "SPY", asset_class: "us_equity", order_class: "simple" } };
    const { b, g } = guardWith({ orders });
    ok("a stock order: refused, nothing sent", (await refusedWith(() => g.request("POST", "/v2/orders", single({ symbol: "SPY", qty: "10" })), "NOT_OPTION")) === true && b.writes().length === 0);
    ok("an mleg option order goes through", (await g.request("POST", "/v2/orders", mleg())).ok && b.writes().length === 1);
    ok("cancel an option order: allowed", (await g.request("DELETE", "/v2/orders/opt-1")).ok && b.writes().length === 2);
    ok("cancel an mleg option order: allowed", (await g.request("DELETE", "/v2/orders/ml-1")).ok && b.writes().length === 3);
    ok("cancel Plan E's ETF order: refused", (await refusedWith(() => g.request("DELETE", "/v2/orders/etf-1"), "NOT_OPTION")) === true && b.writes().length === 3);
    ok("cancel an unknown order: refused", (await refusedWith(() => g.request("DELETE", "/v2/orders/nope"), "ORDER_UNREAD")) === true && b.writes().length === 3);
    ok("replace an option order's limit: allowed", (await g.request("PATCH", "/v2/orders/opt-1", { limit_price: "1.05" })).ok && b.writes().length === 4);
    ok("replace an ETF order: refused", (await refusedWith(() => g.request("PATCH", "/v2/orders/etf-1", { limit_price: "1.05" }), "NOT_OPTION")) === true && b.writes().length === 4);
    ok("a replace that changes the symbol: refused", (await refusedWith(() => g.request("PATCH", "/v2/orders/opt-1", { symbol: "SPY" }), "NOT_OPTION")) === true && b.writes().length === 4);
    ok("cancel ALL orders: refused", (await refusedWith(() => g.request("DELETE", "/v2/orders"), "PATH")) === true && b.writes().length === 4);
    ok("close ALL positions: refused", (await refusedWith(() => g.request("DELETE", "/v2/positions"), "PATH")) === true && b.writes().length === 4);
    ok("close an option position: allowed", (await g.request("DELETE", `/v2/positions/${OCC}`)).ok && b.writes().length === 5);
    ok("close a stock position: refused", (await refusedWith(() => g.request("DELETE", "/v2/positions/SPY"), "NOT_OPTION")) === true && b.writes().length === 5);
    ok("a percentage close: refused", (await refusedWith(() => g.request("DELETE", `/v2/positions/${OCC}?percentage=50`), "PATH")) === true && b.writes().length === 5);
    ok("exercise an option: allowed; a stock: refused", (await g.request("POST", `/v2/positions/${OCC}/exercise`)).ok && (await refusedWith(() => g.request("POST", "/v2/positions/SPY/exercise"), "NOT_OPTION")) === true && b.writes().length === 6);
    ok("any other write: refused", (await refusedWith(() => g.request("POST", "/v2/watchlists", { name: "x" }), "PATH")) === true && (await refusedWith(() => g.request("PATCH", "/v2/account/configurations", {}), "PATH")) === true && (await refusedWith(() => g.request("PUT", "/v2/orders/opt-1", {}), "PATH")) === true && b.writes().length === 6);
    ok("odd paths: refused", (await refusedWith(() => g.request("GET", "/v2/../v1/orders"), "PATH")) === true && (await refusedWith(() => g.request("POST", "v2/orders", single()), "PATH")) === true && (await refusedWith(() => g.request("GET", "https://api.alpaca.markets/v2/orders"), "PATH")) === true);
    const before = b.calls.length;
    ok("reads pass and need no account check", Array.isArray(await g.request("GET", "/v2/positions")) && b.calls.length === before + 1 && b.writes().length === 6);
    ok("every write was preceded by an account read", b.calls.every((c, i) => c.method === "GET" || b.calls.slice(0, i).some((x) => x.path === "/v2/account")));
  }

  // ---- 5b. what is checked is what is sent; paths are canonical and writes go to rebuilt paths --------------------------------
  {
    const orders = { "opt-1": { id: "opt-1", symbol: OCC, asset_class: "us_option" }, "etf-1": { id: "etf-1", symbol: "SPY", asset_class: "us_equity" } };
    const { b, g } = guardWith({ orders });
    const sneaky = { ...single(), toJSON: () => ({ symbol: "SPY", qty: "100", side: "buy", type: "market", time_in_force: "day" }) };
    ok("a body whose toJSON turns it into a stock order: refused, nothing sent", (await refusedWith(() => g.request("POST", "/v2/orders", sneaky), "NOT_OPTION")) === true && b.writes().length === 0);
    let flip = 0; const getter = { qty: "1", side: "buy", type: "market", time_in_force: "day" }; Object.defineProperty(getter, "symbol", { enumerable: true, get: () => (flip++ === 0 ? OCC : "SPY") });
    const gr = await refusedWith(() => g.request("POST", "/v2/orders", getter));
    ok("a getter symbol is read once: the text sent is the text checked", gr === true ? b.writes().length === 0 : (b.writes().length === 1 && b.writes()[0].body.symbol === OCC), String(gr) + JSON.stringify(b.writes()));
    const inh = Object.create({ symbol: OCC }); Object.assign(inh, { qty: "1", side: "buy", type: "market", time_in_force: "day" });
    const nw = b.writes().length;
    ok("an inherited symbol is not trusted (it is not in the sent text)", (await refusedWith(() => g.request("POST", "/v2/orders", inh), "NOT_OPTION")) === true && b.writes().length === nw);
    const pt = { limit_price: "1.05", toJSON: () => ({ symbol: "SPY", qty: "100" }) };
    ok("a PATCH body whose toJSON changes the symbol: refused", (await refusedWith(() => g.request("PATCH", "/v2/orders/opt-1", pt), "NOT_OPTION")) === true && b.writes().length === nw);
    for (const bad of ["/v2/orders/opt-1\\%2E%2E", "/v2/orders/opt-1%2F..", "/v2/orders/%2E", "/v2/orders/opt-1;x", "/v2/orders/opt-1/../../orders", "/v2/orders/..", "/v2/orders/.", "/v2/orders/%E0"]) {
      ok(`a non-canonical write path is a refusal: ${bad}`, (await refusedWith(() => g.request("DELETE", bad), "PATH")) === true && b.writes().length === nw);
    }
    ok("GET on a non-canonical path is refused too", (await refusedWith(() => g.request("GET", "/v2/%2E%2E/v1/orders"), "PATH")) === true && (await refusedWith(() => g.request("GET", "/v2/orders?x=a\\b"), "PATH")) === true && (await refusedWith(() => g.request("GET", '/v2/orders?x="y"'), "PATH")) === true);
    ok("a stock symbol percent-encoded in a position close: refused", (await refusedWith(() => g.request("DELETE", "/v2/positions/%53%50%59"), "PATH")) === true && b.writes().length === nw);
    const c0 = b.calls.length; await g.request("DELETE", "/v2/orders/opt-1");
    const sent = b.calls.slice(c0).filter((c) => c.method === "DELETE");
    ok("a cancel goes to the rebuilt path of the order it looked up", sent.length === 1 && sent[0].path === "/v2/orders/opt-1");
    ok("a cancel with a body: refused", (await refusedWith(() => g.request("DELETE", "/v2/orders/opt-1", {}), "PATH")) === true);
    ok("a replace with a fractional qty: refused", (await refusedWith(() => g.request("PATCH", "/v2/orders/opt-1", { qty: "1.5" }), "NOT_OPTION")) === true && (await refusedWith(() => g.request("PATCH", "/v2/orders/opt-1", { qty: 0.5 }), "NOT_OPTION")) === true);
    ok("a POST /v2/orders with a query: refused", (await refusedWith(() => g.request("POST", "/v2/orders?symbol=SPY", single()), "PATH")) === true);
    const c1 = b.calls.length; await g.request("DELETE", `/v2/positions/${OCC}?qty=2`);
    ok("an option close by whole qty goes to the rebuilt path with its qty", b.calls.slice(c1).some((c) => c.method === "DELETE" && c.path === `/v2/positions/${OCC}?qty=2`));
    ok("a close by fractional qty: refused", (await refusedWith(() => g.request("DELETE", `/v2/positions/${OCC}?qty=1.5`), "PATH")) === true);
    { const c3 = b.calls.length; await g.request("GET", "/v2/orders:by_client_order_id?client_order_id=mirror-1");
      ok("reads may use orders:by_client_order_id", b.calls.length === c3 + 1 && b.calls[c3].method === "GET" && b.calls[c3].path === "/v2/orders:by_client_order_id?client_order_id=mirror-1"); }
    ok("…but a write may not use a ':' route", (await refusedWith(() => g.request("DELETE", "/v2/orders:by_client_order_id"), "PATH")) === true);
    { const c4 = b.calls.length; await g.request("GET", "/v2/orders?after=2026-10-16T09:30:00%2B00:00&status=all");
      ok("a GET query with %2B passes unchanged", b.calls.length === c4 + 1 && b.calls[c4].path === "/v2/orders?after=2026-10-16T09:30:00%2B00:00&status=all"); }
    ok("a replace with an unknown or __proto__ key: refused", (await refusedWith(() => g.request("PATCH", "/v2/orders/opt-1", JSON.parse('{"__proto__":{"symbol":"SPY"},"limit_price":"1.0"}')), "NOT_OPTION")) === true && (await refusedWith(() => g.request("PATCH", "/v2/orders/opt-1", { limit_price: "1.0", extended_hours: true }), "NOT_OPTION")) === true);
    { let k = 0; const pg = {}; Object.defineProperty(pg, "limit_price", { enumerable: true, get: () => (k++ === 0 ? "1.05" : "9.99") });
      const c2 = b.calls.length; await g.request("PATCH", "/v2/orders/opt-1", pg); const sentP = b.calls.slice(c2).find((c) => c.method === "PATCH");
      ok("a PATCH getter is read once: the text sent is the text checked", !!sentP && sentP.body.limit_price === "1.05" && Object.keys(sentP.body).join() === "limit_price"); }
    ok("a close or exercise with a body: refused", (await refusedWith(() => g.request("DELETE", `/v2/positions/${OCC}`, {}), "PATH")) === true && (await refusedWith(() => g.request("POST", `/v2/positions/${OCC}/exercise`, {}), "PATH")) === true);
    ok("a body that does not serialize: refused as a guard refusal", (await refusedWith(() => { const c = {}; c.c = c; return g.request("POST", "/v2/orders", c); }, "BODY")) === true);
  }

  // ---- 6. no key value ever leaves in an error ----------------------------------------------------------------------------
  {
    const msgs = [];
    for (const env of [{ ...FAKE, ALPACA_BOOK_KEY_ID: "FAKE-MAIN-KEY" }, { ...FAKE, ALPACA_BOOK_ACCOUNT_NUMBER: "FAKELIVE1" }]) { try { G.makeBookOptionsGuard({ env, fetchImpl: fakeBroker().fetchImpl }); } catch (e) { msgs.push(e.message); } }
    const { g } = guardWith({ acct: { account_number: "PAFAKEMAIN9" } }); try { await g.request("POST", "/v2/orders", single()); } catch (e) { msgs.push(e.message); }
    ok("errors carry env NAMES, never key values or whole account numbers", msgs.length === 3 && msgs.every((m) => !/FAKE-BOOK-KEY|FAKE-BOOK-SECRET|FAKE-MAIN-KEY|PAFAKEMAIN9|PAFAKEBOOK1/.test(m)), msgs.join(" | "));
    ok("describe() names the env variables only", JSON.stringify(guardWith().g.describe()) === JSON.stringify({ account: "BOOK (paper)", envNames: { keyId: "ALPACA_BOOK_KEY_ID", secret: "ALPACA_BOOK_SECRET_KEY", account: "ALPACA_BOOK_ACCOUNT_NUMBER" }, base: "https://paper-api.alpaca.markets" }));
  }

  // ---- 7. deploy / rollback on a temp root -------------------------------------------------------------------------------
  {
    const SAT = Date.parse("2026-10-17T19:00:00Z"), WED10 = Date.parse("2026-10-14T16:00:00Z");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-guard-st-")), rel = "backend/lib/book-options-guard.js", live = path.join(root, rel), quiet = () => {};
    fs.mkdirSync(path.join(root, "backend", "lib"), { recursive: true }); fs.copyFileSync(path.join(REPO, "backend", "lib", "run-window.js"), path.join(root, "backend", "lib", "run-window.js"));
    ok("plan reads base (absent)", P.run({ mode: "plan", root, nowMs: SAT, log: quiet }) === 0 && P.stateOf(rel, root).state === "base");
    ok("apply inside the fence is refused", P.run({ mode: "apply", root, nowMs: WED10, log: quiet }) === 2 && !fs.existsSync(live));
    ok("apply writes staged byte for byte", P.run({ mode: "apply", root, nowMs: SAT, log: quiet }) === 0 && fs.readFileSync(live).equals(fs.readFileSync(path.join(PKG, "staged", rel))));
    fs.appendFileSync(live, "\n// drift\n"); ok("drift refuses apply and rollback", P.run({ mode: "apply", root, nowMs: SAT, log: quiet }) === 2 && P.run({ mode: "rollback", root, nowMs: SAT, log: quiet }) === 2 && fs.existsSync(live));
    fs.writeFileSync(live, fs.readFileSync(path.join(PKG, "staged", rel)));
    ok("rollback removes the new file", P.run({ mode: "rollback", root, nowMs: SAT, log: quiet }) === 0 && !fs.existsSync(live));
  }
  ok("the live guard file is base or applied, never drifted", ["base", "applied"].includes(P.stateOf("backend/lib/book-options-guard.js", REPO).state));

  // ---- 8. record.cjs on a temp root ---------------------------------------------------------------------------------------
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-guard-rec-")), data = path.join(root, "backend", "data"), cr = path.join(data, "change-registry.json"), out = [];
    fs.mkdirSync(path.join(root, "backend", "lib"), { recursive: true }); fs.mkdirSync(data, { recursive: true });
    for (const f of ["run-window.js", "atomic-write.js"]) fs.copyFileSync(path.join(REPO, "backend", "lib", f), path.join(root, "backend", "lib", f));
    loadCjs(path.join(REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic(cr, []);
    const said = (argv, nowMs) => { out.length = 0; const code = R.main(argv, { root, nowMs, log: (x) => out.push(String(x)), lockWaitMs: 1, lockTries: 2 }); return { code, text: out.join(" ") }; };
    const SAT = Date.parse("2026-10-17T19:00:00Z"), WIN = Date.parse("2026-10-14T15:49:00-06:00");
    ok("record --dry writes nothing", said(["--dry"], SAT).code === 0 && JSON.parse(fs.readFileSync(cr, "utf8")).length === 0);
    ok("record --apply without --restarted: refused", said(["--apply"], SAT).code === 2);
    ok("record --apply at 15:49 MT on a trading day: refused for the window", /no-registry-write window/.test(said(["--restarted", "2026-10-13", "--apply"], WIN).text));
    ok("record --apply on Saturday appends one row", said(["--restarted", "2026-10-16", "--apply"], SAT).code === 0 && JSON.parse(fs.readFileSync(cr, "utf8")).length === 1 && JSON.parse(fs.readFileSync(cr, "utf8"))[0].id === "options-mirror-to-book-2026-10-16");
    ok("a second --apply adds nothing", said(["--restarted", "2026-10-16", "--apply"], SAT).code === 0 && JSON.parse(fs.readFileSync(cr, "utf8")).length === 1);
    ok("the row names env variables only, no values", !/FAKE|PA[A-Z0-9]{6,}/.test(fs.readFileSync(cr, "utf8")) && /ALPACA_BOOK_ACCOUNT_NUMBER/.test(fs.readFileSync(cr, "utf8")));
    fs.rmSync(root, { recursive: true, force: true });
  }
  const src = fs.readFileSync(path.join(PKG, "staged", "backend", "lib", "book-options-guard.js"), "utf8");
  ok("the guard names no main-account key variable as a source", !/env\[\s*["']ALPACA_(KEY_ID|SECRET_KEY)["']\s*\]|process\.env\.ALPACA_(KEY_ID|SECRET_KEY)\b/.test(src));
  ok("the guard holds no live host", !/https:\/\/api\.alpaca\.markets/.test(src));

  if (fails.length) { console.log(`\nSELFTEST FAILED: ${fails.length} of ${n}\n  ` + fails.join("\n  ")); process.exit(1); }
  console.log(`\nSELFTEST PASSED (${n} checks)`);
})().catch((e) => { console.log("SELFTEST CRASHED: " + e.stack); process.exit(1); });
