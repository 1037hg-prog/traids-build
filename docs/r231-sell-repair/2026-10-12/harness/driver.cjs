"use strict";
/**
 * SEALED DRIVER (r231-sell-repair package, 2026-10-12; after docs/pause-switches/2026-10-12/harness/driver.cjs) — runs ONE temp copy of the
 * R231 runner with a FIXED clock, FAKE keys and a FAKE broker, in this process. Nothing leaves the process: every fetch is answered here from
 * the spec or refused, and node's own socket modules refuse too. The real broker is never asked anything.
 *
 *   node harness/driver.cjs <runner file> <spec.json> <out.json>
 *
 * REFUSES (exit 2, nothing loaded) unless the runner file sits under the system temp folder and has no .env beside it: it cannot be pointed
 * at a live file. The mode flags are set here, in memory (spec.argv), never on a command line.
 *
 *   spec  { now: ISO instant (new Date() / Date.now() return it),
 *           argv: [...]              the runner's own arguments
 *           env: { NAME: value }     set before the runner loads (the runner's own sandbox variables)
 *           coinbase: { COIN: [{ d, c }] }      completed daily closes served as Coinbase candles
 *           orders: [order objects]             orders the fake broker already holds
 *           account: { COIN: "qty" }            what the fake ACCOUNT holds, coin by coin (strings, 9 decimals). GET /v2/positions lists them.
 *                                               A SELL asking for more than the account has of the coin is REFUSED 403 with the broker's own
 *                                               "insufficient balance" body (as recorded 2026-10-09); no `account` -> GET /v2/positions is 404
 *           held: { COIN: "qty" }               the part of a position held for another open order (qty_available = qty - held)
 *           positionsError: "text"              GET /v2/positions answers 500
 *           positionsBusy: n                    the first n GET /v2/positions answer 429 ("rate limit exceeded"), then as above
 *           positionsThrow: "text"              GET /v2/positions does not answer at all: the call itself fails with an Error carrying this
 *                                               message — "" for an error with NO words (a failed read must not be judged by its words)
 *           positionsList: [rows]               GET /v2/positions answers this list AS IT IS (a row with a quantity that is not a number, ...);
 *                                               `account` still decides what a sell can take
 *           atPositions: { append: { "<file>": "text" } }   what ANOTHER WRITER does while this run is under way: at the FIRST GET
 *                                               /v2/positions, before it is answered, the text is appended to that file of the runner's own
 *                                               data folder (a bare file name; the folder is under the temp folder) — a ticket the board's
 *                                               mirror books after the run's reconcile and before its read of the account
 *           cidError: { "<client id>": "text" } GET /v2/orders:by_client_order_id for that id answers 500 (every other id as usual)
 *           fill: "instant" | "none"            "instant": a POSTed order fills at once at px[COIN] (default 100) and moves the account;
 *                                               "none" (default): it stays accepted
 *           px: { COIN: price }
 *           feeRate: 0.0025                     with fill "instant": a BUY's fee is taken in the coin, rounded UP at 9 decimals (as the two
 *                                               recorded balances show), and a CFEE row is created 2.5 s after the fill
 *           cfee: [rows]                        CFEE rows the fake broker already lists;  cfeeError: "text" -> that call answers 500
 *           postReject: { "SYM/USD|side": "message" }   orders the fake broker refuses with a 403 whatever the account holds }
 *   out   { code, calls: [{ method, host, path, query, body }], posts: [bodies of POST /v2/orders, in order; a refused one carries `refused`],
 *           orders: [...], account: { COIN: "qty" }, cfee: [rows] }
 */
const fs = require("fs"), path = require("path"), os = require("os");
const [, , targetArg, specFile, outFile] = process.argv;
if (!targetArg || !specFile || !outFile) { console.error("usage: node driver.cjs <runner file under the temp folder> <spec.json> <out.json>"); process.exit(2); }
const target = path.resolve(targetArg), TMP = fs.realpathSync(os.tmpdir());
const under = (p, dir) => { const r = path.relative(dir, p); return !!r && !r.startsWith("..") && !path.isAbsolute(r); };
if (!fs.existsSync(target) || !under(fs.realpathSync(target), TMP)) { console.error(`driver: ${target} is not under the temp folder — refusing (this driver never runs a live file)`); process.exit(2); }
if (fs.existsSync(path.join(path.dirname(target), ".env"))) { console.error("driver: a .env sits beside the runner — refusing"); process.exit(2); }
const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));

// 1 the clock
const RealDate = Date, FIX = RealDate.parse(spec.now);
if (!Number.isFinite(FIX)) { console.error("driver: spec.now is not an instant"); process.exit(2); }
class FixedDate extends RealDate { constructor(...a) { if (a.length === 0) super(FIX); else super(...a); } static now() { return FIX; } }
globalThis.Date = FixedDate;

// 2 the environment: no credential of this machine, fake keys only (the temp tree's own dotenv stub loads nothing)
for (const k of Object.keys(process.env)) if (/KEY|SECRET|TOKEN|PASSWORD|ALPACA|SCHWAB|TASTY|TELEGRAM|SMTP|ANTHROPIC|R231_|R191_/i.test(k)) delete process.env[k];
for (const k of ["ALPACA_KEY_ID", "ALPACA_SECRET_KEY"]) process.env[k] = "SELFTEST-FAKE-" + k;
for (const [k, v] of Object.entries(spec.env || {})) process.env[k] = String(v);

// 3 the network: node's socket modules refuse; fetch is the fake broker / fake Coinbase below, and nothing else
const refuse = (what) => () => { throw new Error(`selftest driver: network refused (${what})`); };
for (const [mod, fns] of [["http", ["request", "get"]], ["https", ["request", "get"]], ["net", ["connect", "createConnection"]], ["tls", ["connect"]], ["dgram", ["createSocket"]]]) { const m = require(mod); for (const f of fns) m[f] = refuse(`${mod}.${f}`); }
const NANO = 1e9, nano = (x) => Math.round(Number(x) * NANO), s9 = (n) => (n / NANO).toFixed(9);
const calls = [], posts = [], orders = new Map(), cfee = [...(spec.cfee || [])]; let seq = 0, busyLeft = Number(spec.positionsBusy) || 0, atPositionsDone = false;
const acct = spec.account ? Object.fromEntries(Object.entries(spec.account).map(([c, q]) => [c, nano(q)])) : null, held = Object.fromEntries(Object.entries(spec.held || {}).map(([c, q]) => [c, nano(q)]));
for (const o of spec.orders || []) orders.set(o.id, { ...o });
const byCid = (cid) => [...orders.values()].find((o) => o.client_order_id === cid);
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => (body == null ? "" : JSON.stringify(body)) });
const coinOf = (sym) => String(sym || "").replace(/\/?USD$/, "");
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)), method = String(init.method || "GET").toUpperCase(), body = init.body ? JSON.parse(init.body) : null, p = u.pathname;
  calls.push({ method, host: u.hostname, path: p, query: u.search, body });
  if (u.hostname === "paper-api.alpaca.markets") {
    if (p === "/v2/orders:by_client_order_id") { const id = u.searchParams.get("client_order_id"), o = byCid(id); if (spec.cidError && spec.cidError[id]) return res(500, { message: spec.cidError[id] }); return o ? res(200, o) : res(404, { code: 40410000, message: "order not found" }); }
    if (p === "/v2/positions" && method === "GET") {
      if (spec.atPositions && !atPositionsDone) { atPositionsDone = true; for (const [f, t] of Object.entries(spec.atPositions.append || {})) { if (path.basename(f) !== f) throw new Error("selftest driver: atPositions takes a bare file name of the runner's data folder"); fs.appendFileSync(path.join(path.dirname(target), "data", f), String(t)); } }
      if (spec.positionsThrow != null) throw new Error(String(spec.positionsThrow));
      if (busyLeft > 0) { busyLeft--; return res(429, { code: 42910000, message: "rate limit exceeded" }); }
      if (spec.positionsError) return res(500, { message: spec.positionsError });
      if (spec.positionsList) return res(200, spec.positionsList);
      if (!acct) return res(404, { message: "selftest driver: no route GET /v2/positions (the spec gives no account)" });
      return res(200, Object.entries(acct).filter(([, n]) => n > 0).map(([c, n]) => ({ asset_class: "crypto", symbol: `${c}USD`, side: "long", qty: s9(n), qty_available: s9(Math.max(0, n - (held[c] || 0))) })));
    }
    if (p === "/v2/account/activities/CFEE" && method === "GET") { if (spec.cfeeError) return res(500, { message: spec.cfeeError }); return res(200, [...cfee].sort((a, b) => (String(a.created_at) < String(b.created_at) ? 1 : -1))); }
    if (p === "/v2/orders" && method === "POST") {
      if (byCid(body.client_order_id)) return res(422, { code: 40010001, message: "client_order_id must be unique" });
      const c = coinOf(body.symbol), rj = (spec.postReject || {})[body.symbol + "|" + body.side];
      if (rj) { posts.push({ ...body, refused: rj }); return res(403, { code: 40310000, message: rj }); }
      if (acct && body.side === "sell") {   // the broker's own refusal, in the shape recorded on 2026-10-09
        const av = Math.max(0, (acct[c] || 0) - (held[c] || 0));
        if (nano(body.qty) > av) { const msg = `insufficient balance for ${c} (requested: ${Number(body.qty)}, available: ${Number(s9(av))})`; posts.push({ ...body, refused: msg }); return res(403, { available: String(Number(s9(av))), balance: String(Number(s9(acct[c] || 0))), code: 40310000, message: msg, symbol: "USD" }); }
      }
      const o = { id: "ord-" + ++seq, client_order_id: body.client_order_id, symbol: body.symbol, side: body.side, type: body.type, time_in_force: body.time_in_force, qty: body.qty != null ? String(body.qty) : null, notional: body.notional || null, status: "accepted", filled_qty: "0", filled_avg_price: null, filled_at: null };
      if (spec.fill === "instant") {
        const px = (spec.px || {})[c] || 100, q = body.qty != null ? nano(body.qty) : Math.floor((Number(body.notional) / px) * NANO + 1e-6), at = new RealDate(FIX + 200).toISOString();
        Object.assign(o, { status: "filled", filled_qty: s9(q), filled_avg_price: String(px), filled_at: at });
        if (acct) {
          if (body.side === "sell") acct[c] = (acct[c] || 0) - q;
          else { const fee = spec.feeRate ? Math.ceil(q * spec.feeRate - 1e-6) : 0; acct[c] = (acct[c] || 0) + q - fee; if (fee) cfee.push({ id: `cfee-${seq}`, activity_type: "CFEE", date: at.slice(0, 10), created_at: new RealDate(FIX + 2700).toISOString(), symbol: `${c}USD`, qty: "-" + s9(fee), price: String(px), net_amount: "0", description: "Coin Pair Transaction Fee (Non USD)", status: "executed" }); }
        }
      }
      orders.set(o.id, o); posts.push(body); return res(200, o);
    }
    return res(404, { message: "selftest driver: no route " + method + " " + p });
  }
  const cb = /^\/products\/([A-Z0-9]+)-USD\/candles$/.exec(p);
  if (u.hostname === "api.exchange.coinbase.com" && cb && method === "GET") return res(200, ((spec.coinbase || {})[cb[1]] || []).map((x) => [RealDate.parse(x.d + "T00:00:00Z") / 1000, x.c, x.c, x.c, x.c, 1]));
  throw new Error(`selftest driver: network refused (${method} ${u.hostname}${p})`);
};

// 4 run it
process.argv = [process.argv[0], target, ...(spec.argv || [])];
process.on("exit", (code) => { try { fs.writeFileSync(outFile, JSON.stringify({ code, calls, posts, orders: [...orders.values()], account: acct ? Object.fromEntries(Object.entries(acct).map(([c, n]) => [c, s9(n)])) : null, cfee })); } catch { /* the caller reads a missing file as a failed run */ } });
require(target);
