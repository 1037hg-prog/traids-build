// Scratch harness runner: loads ONE harness copy of a runner (in a fake backend dir under the scratchpad) with a FAKE broker (no network),
// a fixed clock and fake keys. Usage: node run-scenario.cjs <harness runner file> <spec.json> <out.json>
// spec: { now: ISO, argv: [...], live: bool, orders: [order objects], postStatus: "accepted"|..., postReject: {SYM: "403 msg"}, calendar: [...],
//         account: {...}, positions: [...], clock: {...}, coinbase: {...}, deleteBehavior: "cancel" }
"use strict";
const fs = require("fs"), path = require("path");
const [, , target, specFile, outFile] = process.argv;
const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
// fixed clock
const RealDate = Date, FIX = RealDate.parse(spec.now);
class FDate extends RealDate { constructor(...a) { if (a.length === 0) super(FIX); else super(...a); } static now() { return FIX; } }
globalThis.Date = FDate;
// fake keys only (dotenv never overrides an existing env var; the fake backend dir has no .env)
for (const k of ["ALPACA_KEY_ID", "ALPACA_SECRET_KEY", "ALPACA_TV_KEY_ID", "ALPACA_TV_SECRET_KEY", "ALPACA_BOOK_KEY_ID", "ALPACA_BOOK_SECRET_KEY"]) process.env[k] = "FAKE-" + k;
globalThis.__H_LIVE = !!spec.live;
globalThis.__H_SPEC = spec;
const calls = [];
const orders = new Map(); let seq = 0;
for (const o of spec.orders || []) orders.set(o.id, { ...o });
for (const o of [...orders.values()]) if (o.legs) o.legs = o.legs.map((l) => { if (!orders.has(l.id)) orders.set(l.id, { ...l }); return orders.get(l.id); });   // nested legs are the same objects as /v2/orders/{leg id}
const byCid = (cid) => [...orders.values()].find((o) => o.client_order_id === cid);
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => (body == null ? "" : JSON.stringify(body)) });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), method = (init.method || "GET").toUpperCase(), body = init.body ? JSON.parse(init.body) : null;
  calls.push({ method, path: u.pathname, query: u.search, body });
  if (!/^(paper-api|data)\.alpaca\.markets$|^api\.exchange\.coinbase\.com$|^localhost$/.test(u.hostname)) throw new Error("harness: unexpected host " + u.hostname);
  if (u.hostname === "paper-api.alpaca.markets") {
    const p = u.pathname;
    if (p === "/v2/orders:by_client_order_id") { if ((spec.cidLookupFail || []).includes(u.searchParams.get("client_order_id"))) return res(503, { message: "harness: lookup unavailable" });   // review 2026-10-02: a read-back / lookup that fails
      const o = byCid(u.searchParams.get("client_order_id")); return o ? res(200, o) : res(404, { code: 40410000, message: "order not found" }); }
    if (p === "/v2/orders" && method === "POST") {
      if (byCid(body.client_order_id)) return res(422, { code: 40010001, message: "client_order_id must be unique" });
      const rj = (spec.postReject || {})[body.symbol + "|" + body.side] || (spec.postReject || {})[body.symbol];
      if (rj) return res(403, { code: 40310000, message: rj });
      const o = { id: "ord-" + ++seq, client_order_id: body.client_order_id, symbol: body.symbol, side: body.side, type: body.type, time_in_force: body.time_in_force, qty: body.qty != null ? String(body.qty) : null, notional: body.notional || null, stop_price: body.stop_price || null, status: spec.postStatus || "accepted", filled_qty: "0", filled_avg_price: null, filled_at: null, created_at: new RealDate(FIX).toISOString() };
      if (spec.postCreatesThen503) { orders.set(o.id, o); spec.postCreatesThen503 = false; return res(503, { message: "upstream" }); }
      orders.set(o.id, o); return res(200, o);
    }
    if (p === "/v2/orders" && method === "GET") { const st = u.searchParams.get("status"); const all = [...orders.values()]; return res(200, st === "open" ? all.filter((o) => !["filled", "canceled", "expired", "rejected", "replaced", "done_for_day"].includes(o.status)) : all); }
    const m = /^\/v2\/orders\/([^/]+)$/.exec(p);
    if (m) { const o = orders.get(decodeURIComponent(m[1]));
      if (method === "DELETE") { if (!o) return res(404, { message: "order not found" }); if (["filled", "canceled", "expired", "rejected"].includes(o.status)) return res(422, { message: "order is not cancelable" }); o.status = spec.deleteLeaves || "canceled"; o.canceled_at = new RealDate(FIX).toISOString(); if (o.legs) for (const l of o.legs) if (!["filled", "canceled", "expired"].includes(l.status)) l.status = "canceled"; return res(204, null); }
      if (!o) return res(404, { message: "order not found" }); return res(200, o); }
    if (p === "/v2/calendar") return res(200, (spec.calendar || []).filter((c) => c.date >= u.searchParams.get("start") && c.date <= u.searchParams.get("end")));
    if (p === "/v2/account") return res(200, spec.account || { buying_power: "100000", cash: "50000", account_number: "PA000FAKE", status: "ACTIVE" });
    if (p === "/v2/clock") return res(200, spec.clock || { is_open: false });
    if (p === "/v2/positions") return res(200, spec.positions || []);
    const pm = /^\/v2\/positions\/(.+)$/.exec(p); if (pm) { const x = (spec.positions || []).find((q) => q.symbol === decodeURIComponent(pm[1])); return x ? res(200, x) : res(404, { message: "position does not exist" }); }
  }
  const cb = /^\/products\/([A-Z]+)-USD\/candles$/.exec(u.pathname);
  if (u.hostname === "api.exchange.coinbase.com" && cb) {   // daily candles of COMPLETED UTC days, newest first: spec.cb[coin] = { dir: "up"|"down", base }
    const c = (spec.cb || {})[cb[1]] || { dir: "up", base: 100 }, end = Math.floor(FIX / 864e5) * 864e5, out = [];
    for (let i = 1; i <= 290; i++) { const t = end - i * 864e5, k = 290 - i, px = c.base * (c.dir === "down" ? 2 - k / 290 : 1 + k / 290) * (1 + 0.01 * Math.sin(k)); out.push([t / 1000, px * 0.99, px * 1.01, px, px, 1000]); }
    return res(200, out);
  }
  return res(404, { message: "harness: no route " + method + " " + u.pathname });
};
process.argv = [process.argv[0], target, ...(spec.argv || [])];
process.on("exit", (code) => { fs.writeFileSync(outFile, JSON.stringify({ code, calls, orders: [...orders.values()] }, null, 1)); });
require(target);
