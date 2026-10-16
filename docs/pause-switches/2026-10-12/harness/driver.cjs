"use strict";
/**
 * SEALED DRIVER (pause-switches package, 2026-10-12) — runs ONE temp copy of a runner with a FIXED clock, FAKE keys and a FAKE broker, in this
 * process. Nothing leaves the process: every fetch is answered here from the spec or refused, and node's own socket modules refuse too.
 *
 *   node harness/driver.cjs <runner file> <spec.json> <out.json>
 *
 * REFUSES (exit 2, nothing loaded) unless the runner file sits under the system temp folder, has no .env beside it and no backend/data of the
 * repo above it: it cannot be pointed at a live file. The mode flags are set here, in memory (spec.argv), never on a command line.
 *
 *   spec  { now: ISO instant (new Date() / Date.now() return it),
 *           argv: [...]            the runner's own arguments,
 *           env: { NAME: value }   set before the runner loads (the runner's own sandbox variables),
 *           calendar: [{ date, open, close }]     the fake broker's session calendar,
 *           orders: [order objects]               orders the fake broker already holds,
 *           postReject: { "SYM/USD|side": "message" }   orders the fake broker refuses with a 403,
 *           coinbase: { COIN: [{ d, c }] }        completed daily closes served as Coinbase candles,
 *           bars / signals / barDate              read by the stub rule and bar modules of a temp tree (globalThis.__PS_SPEC) }
 *   out   { code, calls: [{ method, host, path, query, body }], posts: [bodies of POST /v2/orders, in order], orders: [...] }
 */
const fs = require("fs"), path = require("path"), os = require("os");
const [, , targetArg, specFile, outFile] = process.argv;
if (!targetArg || !specFile || !outFile) { console.error("usage: node driver.cjs <runner file under the temp folder> <spec.json> <out.json>"); process.exit(2); }
const target = path.resolve(targetArg), TMP = fs.realpathSync(os.tmpdir());
const under = (p, dir) => { const r = path.relative(dir, p); return !!r && !r.startsWith("..") && !path.isAbsolute(r); };
if (!under(fs.realpathSync(target), TMP)) { console.error(`driver: ${target} is not under the temp folder — refusing (this driver never runs a live file)`); process.exit(2); }
if (fs.existsSync(path.join(path.dirname(target), ".env"))) { console.error("driver: a .env sits beside the runner — refusing"); process.exit(2); }
const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));

// 1 the clock
const RealDate = Date, FIX = RealDate.parse(spec.now);
if (!Number.isFinite(FIX)) { console.error("driver: spec.now is not an instant"); process.exit(2); }
class FixedDate extends RealDate { constructor(...a) { if (a.length === 0) super(FIX); else super(...a); } static now() { return FIX; } }
globalThis.Date = FixedDate;

// 2 the environment: no credential of this machine, fake keys only (the temp tree's own dotenv stub loads nothing)
for (const k of Object.keys(process.env)) if (/KEY|SECRET|TOKEN|PASSWORD|ALPACA|SCHWAB|TASTY|TELEGRAM|SMTP|ANTHROPIC/i.test(k)) delete process.env[k];
for (const k of ["ALPACA_KEY_ID", "ALPACA_SECRET_KEY", "ALPACA_TV_KEY_ID", "ALPACA_TV_SECRET_KEY"]) process.env[k] = "SELFTEST-FAKE-" + k;
for (const [k, v] of Object.entries(spec.env || {})) process.env[k] = String(v);

// 3 the network: node's socket modules refuse; fetch is the fake broker / fake Coinbase below, and nothing else
const refuse = (what) => () => { throw new Error(`selftest driver: network refused (${what})`); };
for (const [mod, fns] of [["http", ["request", "get"]], ["https", ["request", "get"]], ["net", ["connect", "createConnection"]], ["tls", ["connect"]], ["dgram", ["createSocket"]]]) { const m = require(mod); for (const f of fns) m[f] = refuse(`${mod}.${f}`); }
const calls = [], posts = [], orders = new Map(); let seq = 0;
for (const o of spec.orders || []) orders.set(o.id, { ...o });
const byCid = (cid) => [...orders.values()].find((o) => o.client_order_id === cid);
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => (body == null ? "" : JSON.stringify(body)) });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)), method = String(init.method || "GET").toUpperCase(), body = init.body ? JSON.parse(init.body) : null, p = u.pathname;
  calls.push({ method, host: u.hostname, path: p, query: u.search, body });
  if (u.hostname === "paper-api.alpaca.markets") {
    if (p === "/v2/orders:by_client_order_id") { const o = byCid(u.searchParams.get("client_order_id")); return o ? res(200, o) : res(404, { code: 40410000, message: "order not found" }); }
    if (p === "/v2/orders" && method === "POST") {
      if (byCid(body.client_order_id)) return res(422, { code: 40010001, message: "client_order_id must be unique" });
      const rj = (spec.postReject || {})[body.symbol + "|" + body.side]; if (rj) { posts.push({ ...body, refused: rj }); return res(403, { code: 40310000, message: rj }); }   // the fake broker refuses this order (it is still recorded as asked)
      const o = { id: "ord-" + ++seq, client_order_id: body.client_order_id, symbol: body.symbol, side: body.side, type: body.type, time_in_force: body.time_in_force, qty: body.qty != null ? String(body.qty) : null, notional: body.notional || null, stop_price: body.stop_price || null, status: "accepted", filled_qty: "0", filled_avg_price: null, filled_at: null };
      orders.set(o.id, o); posts.push(body); return res(200, o);
    }
    const m = /^\/v2\/orders\/([^/]+)$/.exec(p);
    if (m) { const o = orders.get(decodeURIComponent(m[1])); if (!o) return res(404, { message: "order not found" }); if (method === "DELETE") { o.status = "canceled"; return res(204, null); } return res(200, o); }
    if (p === "/v2/calendar") return res(200, (spec.calendar || []).filter((c) => c.date >= u.searchParams.get("start") && c.date <= u.searchParams.get("end")));
    return res(404, { message: "selftest driver: no route " + method + " " + p });
  }
  const cb = /^\/products\/([A-Z0-9]+)-USD\/candles$/.exec(p);
  if (u.hostname === "api.exchange.coinbase.com" && cb && method === "GET") return res(200, ((spec.coinbase || {})[cb[1]] || []).map((x) => [RealDate.parse(x.d + "T00:00:00Z") / 1000, x.c, x.c, x.c, x.c, 1]));
  throw new Error(`selftest driver: network refused (${method} ${u.hostname}${p})`);
};

// 4 run it
globalThis.__PS_SPEC = spec;
process.argv = [process.argv[0], target, ...(spec.argv || [])];
process.on("exit", (code) => { try { fs.writeFileSync(outFile, JSON.stringify({ code, calls, posts, orders: [...orders.values()] })); } catch { /* the caller reads a missing file as a failed run */ } });
require(target);
