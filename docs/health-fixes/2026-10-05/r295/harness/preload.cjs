// R295-V7 harness preload (node -r preload.cjs <harness copy>): a FAKE Alpaca paper broker, a fixed clock and fake keys, installed before
// the harness copy of the runner loads as the MAIN module (never require()d). Every other host throws. No network, no real keys.
// spec (JSON file in H_SPEC): { now, fn, date, apply, live, orders: [...], positions: {SYM: signed qty}, fillMarket: {SYM: px} | "auto", bars: {SYM: [{o,h,l,c}]} }
// out (H_OUT): { code, calls, orders, positions, notify }
"use strict";
const fs = require("fs");
const spec = JSON.parse(fs.readFileSync(process.env.H_SPEC, "utf8"));
const RealDate = Date, FIX = RealDate.parse(spec.now), T0 = RealDate.now();
class FDate extends RealDate { constructor(...a) { if (a.length === 0) super(FIX + (RealDate.now() - T0)); else super(...a); } static now() { return FIX + (RealDate.now() - T0); } }
globalThis.Date = FDate;
for (const k of ["ALPACA_KEY_ID", "ALPACA_SECRET_KEY", "ALPACA_TV_KEY_ID", "ALPACA_TV_SECRET_KEY"]) process.env[k] = "FAKE-" + k;
globalThis.__H_LIVE = !!spec.live; globalThis.__H_SPEC = spec; globalThis.__H_NOTIFY = [];
const calls = [], orders = new Map(), pos = { ...(spec.positions || {}) }; let seq = 0;
const clone = (o) => JSON.parse(JSON.stringify(o));
// R295-V7R: the runner's chain guard asks PowerShell (CIM) for node command lines; the harness answers from spec.procs (or a failed scan with
// spec.procScanFail). Every other child process call goes to the real child_process.
{ const cpm = require("child_process"), real = cpm.spawnSync;
  cpm.spawnSync = (cmd, args, opt) => { if (/powershell/i.test(String(cmd))) { calls.push({ method: "PROC", path: "powershell", query: "", body: null }); return spec.procScanFail ? { status: 1, stdout: "", stderr: "harness: scan failed" } : { status: 0, stdout: (spec.procs || []).join("\r\n") + "\r\n", stderr: "" }; } return real.call(cpm, cmd, args, opt); }; }
const legIds = new Set();
for (const o of (spec.orders || []).map(clone)) { orders.set(o.id, o); for (const l of o.legs || []) { legIds.add(l.id); if (!orders.has(l.id)) orders.set(l.id, l); } }
for (const o of orders.values()) if (o.legs) o.legs = o.legs.map((l) => orders.get(l.id));   // nested legs ARE the leg orders
const TERM = ["filled", "canceled", "expired", "rejected", "done_for_day", "replaced"];
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => (body == null ? "" : JSON.stringify(body)) });
const fillNow = (o, px) => { o.status = "filled"; o.filled_qty = o.qty; o.filled_avg_price = String(px); o.filled_at = new FDate().toISOString(); pos[o.symbol] = (pos[o.symbol] || 0) + (o.side === "buy" ? 1 : -1) * Number(o.qty); };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), method = (init.method || "GET").toUpperCase(), body = init.body ? JSON.parse(init.body) : null;
  calls.push({ method, path: u.pathname, query: u.search, body });
  if (u.hostname !== "paper-api.alpaca.markets") throw new Error("harness: unexpected host " + u.hostname);
  const p = u.pathname;
  if (p === "/v2/orders:by_client_order_id") { const cid = u.searchParams.get("client_order_id"); const o = [...orders.values()].find((x) => x.client_order_id === cid); return o ? res(200, clone(o)) : res(404, { message: "order not found" }); }
  if (p === "/v2/orders" && method === "GET") { const st = u.searchParams.get("status"); return res(200, [...orders.values()].filter((o) => !legIds.has(o.id) && (st !== "open" || !TERM.includes(o.status))).map(clone)); }   // R295-V7R: --check-flattens lists open orders
  if (p === "/v2/orders" && method === "POST") {
    if ([...orders.values()].some((x) => x.client_order_id === body.client_order_id)) return res(422, { message: "client_order_id must be unique" });
    const o = { id: "h-" + ++seq, client_order_id: body.client_order_id, symbol: body.symbol, side: body.side, type: body.type, time_in_force: body.time_in_force, qty: String(body.qty), stop_price: body.stop_price || null, status: "accepted", filled_qty: "0", filled_avg_price: null, filled_at: null, created_at: new FDate().toISOString() };
    orders.set(o.id, o);
    const fm = spec.fillMarket; if (o.type === "market" && fm) { const px = fm === "auto" ? (spec.px || {})[o.symbol] : fm[o.symbol]; if (px != null) fillNow(o, px); }
    return res(200, clone(o));
  }
  const m = /^\/v2\/orders\/([^/]+)$/.exec(p);
  if (m) { const o = orders.get(decodeURIComponent(m[1]));
    if (method === "DELETE") { if (!o) return res(404, { message: "order not found" }); if (TERM.includes(o.status)) return res(422, { message: "order is not cancelable" }); o.status = "canceled"; for (const l of o.legs || []) if (!TERM.includes(l.status)) l.status = "canceled"; return res(204, null); }
    return o ? res(200, clone(o)) : res(404, { message: "order not found" }); }
  if (p === "/v2/positions") return res(200, Object.entries(pos).filter(([, q]) => q).map(([s, q]) => ({ symbol: s, qty: String(q), side: q < 0 ? "short" : "long" })));
  const pm = /^\/v2\/positions\/(.+)$/.exec(p);
  if (pm) { const s = decodeURIComponent(pm[1]), q = pos[s] || 0; if (spec.posFail && spec.posFail.includes(s)) return res(403, { message: "harness: positions unavailable" }); /* 403: api() does not retry it (a 5xx is retried ~42 s per read) */ return q ? res(200, { symbol: s, qty: String(q), side: q < 0 ? "short" : "long", qty_available: String(q) }) : res(404, { code: 40410000, message: "position does not exist" }); }
  if (p === "/v2/calendar") return res(200, [{ date: spec.date }]);
  return res(404, { message: "harness: no route " + method + " " + p });
};
process.on("exit", (code) => { fs.writeFileSync(process.env.H_OUT, JSON.stringify({ code, calls, orders: [...orders.values()], positions: pos, notify: globalThis.__H_NOTIFY }, null, 1)); });
