#!/usr/bin/env node
"use strict";
/**
 * TASTYTRADE BROKER ADAPTER — the order path for Plan E on tastytrade (built 2026-10-09; operator: "yes build it").
 * A small, require()-safe client: no I/O happens on load. Used by backend/planE-tasty.js. NOT wired into any .bat, task or the close chain.
 *
 * SOURCES (verified 2026-10-09 against developer.tastytrade.com and its published OpenAPI 3.1 specs /openapi/<area>.json):
 *   /docs/authentication/oauth2/          POST /oauth/token, grant_type=refresh_token; every request needs a User-Agent; access tokens ~15 min
 *   /docs/sandbox/                        prod https://api.tastyworks.com · sandbox https://api.cert.tastyworks.com; separate OAuth apps;
 *                                         sandbox fills are synthetic (market = $1, limit < $3 fills, >= $3 never fills); /market-data -> 502
 *   /docs/concepts/orders-and-order-types POST /accounts/{acct}/orders, POST /accounts/{acct}/orders/dry-run (same body), GET .../orders,
 *                                         GET .../orders/live; Market cannot be GTC; buying is a Debit, selling a Credit ("Buying for a credit
 *                                         ... is rejected"); equity/future/crypto orders are 1 leg; crypto quantity may be decimal
 *   /docs/concepts/order-lifecycle/       statuses Received/Routed/In Flight/Contingent -> Live/Cancel Requested/Replace Requested ->
 *                                         terminal Filled/Cancelled/Rejected/Expired/Removed/Partially Removed; "Filled" can arrive before every
 *                                         leg fill is processed (re-fetch); a Day order sent while the market is closed sits "Received" until the open
 *   /docs/guides/idempotency-and-retries  no idempotency key, the API does not de-duplicate: unique external-identifier per order; after a
 *                                         timeout / 5xx look the identifier up (GET orders, orders/live) BEFORE resubmitting; GETs retry freely
 *   /docs/guides/rate-limits-and-backoff  no published REST quota; 429 carries no rate-limit headers; exponential backoff with jitter, capped
 *   /openapi/orders.json                  DELETE /accounts/{acct}/orders/{id} (cancel), GET /accounts/{acct}/orders/{id}; dry-run response data:
 *                                         buying-power-effect{change-in-buying-power(-effect), new-buying-power, change-in-margin-requirement,
 *                                         isolated-order-margin-requirement ...}, fee-calculation{total-fees(-effect), commission, clearing-fees,
 *                                         regulatory-fees, proprietary-index-option-fees}, warnings[], errors[]; 422 error envelope
 *                                         {error:{code,message,errors[]}}; quantities/prices are "Decimal value serialized as a JSON string"
 *   /openapi/accounts-and-customers.json  GET /customers/me/accounts (customer_id: "Only a value of `me` is allowed")
 *   /openapi/balances-and-positions.json  GET /accounts/{acct}/balances (net-liquidating-value, cash-balance, equity-buying-power,
 *                                         derivative-buying-power, effective-cryptocurrency-buying-power ...), GET /accounts/{acct}/positions
 *   /openapi/account-status.json          GET /accounts/{acct}/trading-status (is-futures-enabled, is-cryptocurrency-enabled, is-closing-only ...)
 *   /openapi/instruments.json             GET /instruments/equities/{sym}, /instruments/futures?product-code[]=ZN, /instruments/futures/{sym},
 *                                         /instruments/cryptocurrencies/{sym} ("BTC/USD" URL-encoded in a path)
 *   /openapi/market-data.json             GET /market-data/by-type?equity=..&future=..&cryptocurrency=.. (REST quotes; <= 100 symbols;
 *                                         "Available to funded account holders only"; sandbox 502) — quotes ARE available over REST in production
 *   /openapi/transactions.json            GET /accounts/{acct}/transactions?start-date= (commission, clearing-fees, regulatory-fees per order-id)
 *   NOT documented anywhere on developer.tastytrade.com (checked 2026-10-09): crypto time-in-force rules. The builder defaults (Limit GTC,
 *   Market IOC) are this file's choice; the production dry-run is the arbiter before any order is placed.
 *
 * GUARDS (all enforced at ONE choke point, request()):
 *   - env "prod" | "cert" only; the host is fixed per env and asserted on every URL (api.tastyworks.com vs api.cert.tastyworks.com);
 *     credentials come only from the matching prefix (TASTY_* for prod, TASTY_CERT_* for cert) — never mixed.
 *   - PRODUCTION: every non-GET is refused EXCEPT POST /oauth/token and POST /accounts/{acct}/orders/dry-run, unless the caller constructed
 *     the broker with live:true AND the arm file it named exists with a non-empty line (re-checked on every call; this file never writes it).
 *     The guard judges the NORMALISED path fetch will send: '.'/'..' segments (incl. %2e forms) or any URL-parser rewrite -> refused.
 *   - A dry-run is OK only with 2xx, no errors[] AND no warnings[] (orders spec: "A warning here means the order would be rejected").
 *   - Orders, dry-runs, positions, balances need the PINNED account (TASTY_ACCOUNT_NUMBER / TASTY_CERT_ACCOUNT_NUMBER) and it must be one of
 *     /customers/me/accounts; absent -> refused with the accounts found (code NOT_PINNED), so the operator can set it.
 *   - Optional symbol whitelist (allowSymbols): any leg outside it is refused before the network.
 *   - Orders are validated locally (1 leg, known types, Market never GTC, Buy=Debit/Sell=Credit, positive quantity, external-identifier for place).
 * RETRIES: pacing (min gap between requests); 429 / 5xx / network -> exponential backoff with jitter (Retry-After honoured if ever sent),
 *   capped; GETs, dry-runs and cancels retry; an order POST NEVER retries blindly: before every retry the external-identifier is looked up
 *   and an order found is ADOPTED; a failed look-up stops with "uncertain" and nothing is resent. 401 -> token refreshed once.
 *   PRODUCTION order POST with an UNKNOWN outcome (network / timeout / 5xx / 2xx without an order id): the API does not de-duplicate and an
 *   order still being processed may not be listed yet, so place() waits PROD_UNKNOWN_WAIT_MS (8 s), looks the identifier up (orders/live,
 *   then orders), waits and looks again, then returns UNCERTAIN — it NEVER resends. Only 429 / 401 (refused before processing) resend.
 *   (The cert sandbox keeps the short back-off + look-up + resend: its fills are synthetic.)
 * TOKENS: in memory only, refreshed 60 s before expiry; never logged, never written, never placed in an error message.
 *
 *   node backend/lib/tasty-broker.js --selftest              fake HTTP, no network: every guard, every builder's exact JSON, token, retry/adoption
 *   node backend/lib/tasty-broker.js --accounts [--env cert] GET only: lists the accounts so TASTY_ACCOUNT_NUMBER can be set
 */
const fs = require("fs"), path = require("path");

const HOSTS = Object.freeze({ prod: "https://api.tastyworks.com", cert: "https://api.cert.tastyworks.com" });
const PREFIX = Object.freeze({ prod: "TASTY_", cert: "TASTY_CERT_" });
const UA = "TRAIDS-tasty-broker/1.0";
const TERMINAL = Object.freeze(["Filled", "Cancelled", "Rejected", "Expired", "Removed", "Partially Removed"]);
const WORKING = Object.freeze(["Received", "Routed", "In Flight", "Contingent", "Live", "Cancel Requested", "Replace Requested"]);
// RESTING = accepted and not terminal (tasty-zn-runner.js's list). It is NOT "confirmed at the exchange": Received / Routed / In Flight can
// still end Rejected (order-lifecycle docs). A protective stop counts as resting only at "Live" (planE-tasty.js znPlaceStop / znStopCheck).
const RESTING = Object.freeze(["Received", "Routed", "In Flight", "Contingent", "Live"]);
const DRY_RUN_RE = /^\/accounts\/[^/?#]+\/orders\/dry-run$/;
const EXT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const INSTRUMENTS = Object.freeze(["Equity", "Future", "Cryptocurrency"]);
const ORDER_TYPES = Object.freeze(["Market", "Limit", "Stop"]);
const TIFS = Object.freeze(["Day", "GTC", "IOC"]);
const ACTIONS = Object.freeze({ BUY: "Buy to Open", SELL: "Sell to Close" });   // Plan E is long-only: opens with buys, reduces with sells
const PROD_UNKNOWN_WAIT_MS = 8000;   // production order POST with an unknown outcome: wait this long before each of the 2 look-ups (never resent)

class BrokerError extends Error { constructor(code, message, extra) { super(message); this.code = code; if (extra) Object.assign(this, extra); } }

// ---- defensive parsing helpers
const num = (x) => { const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN; return Number.isFinite(n) ? n : null; };
const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
const arr = (x) => (Array.isArray(x) ? x : []);
const str = (x) => (typeof x === "string" ? x : x == null ? null : String(x));
const signed = (v, effect) => (v == null ? null : effect === "Debit" ? -Math.abs(v) : effect === "Credit" ? Math.abs(v) : v);   // Debit = money out of the account
const errOf = (json, text, status) => {
  const e = obj(json).error;
  if (e && typeof e === "object") return { code: str(e.code), message: str(e.message), errors: arr(e.errors).map((x) => ({ code: str(obj(x).code), message: str(obj(x).message) })) };
  if (typeof e === "string") return { code: e, message: str(obj(json).error_description) };   // OAuth envelope: {error:"invalid_grant"}
  if (status >= 200 && status < 300) return null;
  return { code: null, message: text ? String(text).slice(0, 200) : `HTTP ${status}` };
};
const errText = (e) => (e ? [e.code, e.message, ...arr(e.errors).map((x) => [x.code, x.message].filter(Boolean).join(": "))].filter(Boolean).join(" | ") : "");

// ---- formatting (exact strings the API receives)
const onTick = (px, tick) => { const t = num(tick); if (!(t > 0)) return px; return Math.round(px / t + 1e-9) * t; };
const fmtNum = (x, maxDp = 6) => { const s = (+x).toFixed(maxDp); return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s; };
const floorDp = (q, dp) => { const f = 10 ** dp; return Math.floor(q * f + 1e-9) / f; };
const fmtEquityPx = (px) => (px >= 1 ? (Math.round(px * 100 + 1e-9) / 100).toFixed(2) : fmtNum(Math.round(px * 10000 + 1e-9) / 10000, 4));
const fmtQty = (q, dp = 0) => { if (!(q > 0)) throw new BrokerError("VALIDATION", `quantity must be > 0 (got ${q})`); const v = dp > 0 ? floorDp(q, dp) : Math.floor(q + 1e-9); if (!(v > 0)) throw new BrokerError("VALIDATION", `quantity ${q} rounds to 0 at ${dp} dp`); return fmtNum(v, dp); };
const sideAction = (side) => { const a = ACTIONS[side]; if (!a) throw new BrokerError("VALIDATION", `side must be BUY or SELL (got ${side})`); return a; };
const effectFor = (side) => (side === "BUY" ? "Debit" : "Credit");

// ---- order builders (pure; exact JSON in --selftest)
function buildEquityOrder({ symbol, qty, side, type = "Market", price, extId }) {
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(String(symbol))) throw new BrokerError("VALIDATION", `bad equity symbol ${symbol}`);
  const leg = { "instrument-type": "Equity", symbol, quantity: fmtQty(qty, 0), action: sideAction(side) };
  if (type === "Market") return { "time-in-force": "Day", "order-type": "Market", legs: [leg], ...(extId ? { "external-identifier": extId } : {}) };
  if (type === "Limit") { if (!(num(price) > 0)) throw new BrokerError("VALIDATION", "limit price required"); return { "time-in-force": "Day", "order-type": "Limit", price: fmtEquityPx(num(price)), "price-effect": effectFor(side), legs: [leg], ...(extId ? { "external-identifier": extId } : {}) }; }
  throw new BrokerError("VALIDATION", `equity order type must be Market or Limit (got ${type})`);
}
function buildFutureOrder({ symbol, qty, side, price, tick, extId }) {   // futures: Limit, Day only
  if (!/^\/[A-Z0-9]{1,4}[FGHJKMNQUVXZ]\d{1,2}$/.test(String(symbol))) throw new BrokerError("VALIDATION", `bad future symbol ${symbol}`);
  if (!(num(price) > 0) || !(num(tick) > 0)) throw new BrokerError("VALIDATION", "future limit needs price and tick-size");
  return { "time-in-force": "Day", "order-type": "Limit", price: fmtNum(onTick(num(price), tick)), "price-effect": effectFor(side), legs: [{ "instrument-type": "Future", symbol, quantity: fmtQty(qty, 0), action: sideAction(side) }], ...(extId ? { "external-identifier": extId } : {}) };
}
function buildFutureStop({ symbol, qty, trigger, tick, extId }) {   // the ZN disaster stop: GTC stop-market SELL (tasty-zn-runner.js stopBody shape)
  if (!(num(trigger) > 0)) throw new BrokerError("VALIDATION", `stop trigger must be > 0 (got ${trigger})`);
  return { "time-in-force": "GTC", "order-type": "Stop", "stop-trigger": fmtNum(tick ? onTick(num(trigger), tick) : num(trigger)), legs: [{ "instrument-type": "Future", symbol, quantity: fmtQty(qty, 0), action: ACTIONS.SELL }], ...(extId ? { "external-identifier": extId } : {}) };
}
function buildCryptoOrder({ symbol, qty, side, type = "Limit", price, tick, qtyDecimals = 8, tif, extId }) {
  if (!/^[A-Z0-9]{2,10}\/USD$/.test(String(symbol))) throw new BrokerError("VALIDATION", `bad crypto symbol ${symbol}`);
  const leg = { "instrument-type": "Cryptocurrency", symbol, quantity: fmtQty(qty, qtyDecimals), action: sideAction(side) };
  if (type === "Limit") { if (!(num(price) > 0)) throw new BrokerError("VALIDATION", "crypto limit price required"); return { "time-in-force": tif || "GTC", "order-type": "Limit", price: fmtNum(onTick(num(price), num(tick) > 0 ? tick : 0.01)), "price-effect": effectFor(side), legs: [leg], ...(extId ? { "external-identifier": extId } : {}) }; }
  if (type === "Market") return { "time-in-force": tif || "IOC", "order-type": "Market", legs: [leg], ...(extId ? { "external-identifier": extId } : {}) };
  throw new BrokerError("VALIDATION", `crypto order type must be Limit or Market (got ${type})`);
}

// ---- local validation (before any network)
function validateOrder(o, { forPlace = false, allowSymbols = null } = {}) {
  const bad = [], b = obj(o), legs = arr(b.legs);
  if (legs.length !== 1) bad.push(`exactly 1 leg required (got ${legs.length})`);
  if (!ORDER_TYPES.includes(b["order-type"])) bad.push(`order-type ${b["order-type"]} not allowed`);
  if (!TIFS.includes(b["time-in-force"])) bad.push(`time-in-force ${b["time-in-force"]} not allowed`);
  if (b["order-type"] === "Market" && b["time-in-force"] === "GTC") bad.push("Market cannot be GTC (docs)");
  const leg = obj(legs[0]);
  if (!INSTRUMENTS.includes(leg["instrument-type"])) bad.push(`instrument-type ${leg["instrument-type"]} not allowed`);
  if (!Object.values(ACTIONS).includes(leg.action)) bad.push(`action ${leg.action} not allowed`);
  if (!(num(leg.quantity) > 0)) bad.push(`quantity ${leg.quantity} must be > 0`);
  if (typeof leg.symbol !== "string" || !leg.symbol) bad.push("symbol missing");
  if (b["order-type"] === "Limit") { if (!(num(b.price) > 0)) bad.push("Limit needs price > 0"); const want = leg.action === ACTIONS.BUY ? "Debit" : "Credit"; if (b["price-effect"] !== want) bad.push(`${leg.action} must be ${want} (docs: buying for a credit is rejected)`); }
  if (b["order-type"] === "Stop" && !(num(b["stop-trigger"]) > 0)) bad.push("Stop needs stop-trigger > 0");
  if (b["order-type"] === "Stop" && leg["instrument-type"] !== "Future") bad.push("Stop orders only for the ZN disaster stop (Future)");
  if (forPlace && !EXT_ID_RE.test(String(b["external-identifier"] || ""))) bad.push("external-identifier required (1-64 of A-Z a-z 0-9 . _ : -)");
  if (allowSymbols && leg.symbol && !allowSymbols.includes(leg.symbol)) bad.push(`symbol ${leg.symbol} is not on the whitelist`);
  if (bad.length) throw new BrokerError("VALIDATION", `order refused locally: ${bad.join("; ")}`, { problems: bad });
  return true;
}

// host assert: a URL is sent only if it is https on EXACTLY the env's host (prod and cert can never cross)
function hostCheck(env, url) {
  const want = HOSTS[env]; if (!want) throw new BrokerError("ENV", `unknown env ${env}`);
  let u; try { u = new URL(url); } catch { throw new BrokerError("HOST", `unparseable URL refused`); }
  if (u.protocol !== "https:" || u.origin !== want) throw new BrokerError("HOST", `host assert failed: ${u.origin} is not ${want} (${env})`);
  return u.toString();
}
const armedText = (t) => typeof t === "string" && t.split(/\r?\n/).some((l) => l.trim().length > 0);
const isArmed = (file) => { try { return !!file && fs.existsSync(file) && armedText(fs.readFileSync(file, "utf8")); } catch { return false; } };

function credsFromEnv(env, source = process.env) {
  const p = PREFIX[env], c = { prefix: p, clientId: source[p + "CLIENT_ID"], clientSecret: source[p + "CLIENT_SECRET"], refreshToken: source[p + "REFRESH_TOKEN"], accountNumber: source[p + "ACCOUNT_NUMBER"] || null };
  for (const k of ["clientId", "clientSecret", "refreshToken"]) if (typeof c[k] === "string") c[k] = c[k].trim().replace(/^["']|["']$/g, "");
  if (typeof c.accountNumber === "string") c.accountNumber = c.accountNumber.trim().replace(/^["']|["']$/g, "") || null;
  return c;
}

/**
 * createBroker({ env:'prod'|'cert', creds?, live?, armFile?, allowSymbols?, fetch?, sleep?, now?, random?, minGapMs?, maxRetries?, log? })
 */
function createBroker(opts = {}) {
  const env = opts.env;
  if (!Object.prototype.hasOwnProperty.call(HOSTS, env)) throw new BrokerError("ENV", `env must be "prod" or "cert" (got ${env})`);
  const host = HOSTS[env];
  const creds = opts.creds || credsFromEnv(env);
  if (creds.prefix !== PREFIX[env]) throw new BrokerError("CREDS", `credentials prefix ${creds.prefix} does not match env ${env} (needs ${PREFIX[env]}*)`);
  const missing = ["CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN"].filter((k) => !creds[{ CLIENT_ID: "clientId", CLIENT_SECRET: "clientSecret", REFRESH_TOKEN: "refreshToken" }[k]]).map((k) => PREFIX[env] + k);
  if (missing.length) throw new BrokerError("CREDS", `missing ${missing.join(", ")} (names only; values are never printed)`);
  const fetchImpl = opts.fetch || globalThis.fetch, sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))), now = opts.now || (() => Date.now()), rnd = opts.random || Math.random;
  const minGapMs = opts.minGapMs == null ? 200 : opts.minGapMs, maxRetries = opts.maxRetries == null ? 4 : opts.maxRetries, log = opts.log || (() => {});
  const allowSymbols = opts.allowSymbols ? [...opts.allowSymbols] : null;
  const stats = { requests: 0, tokenRefreshes: 0, retries: 0, sleeps: [] };
  let tok = null, exp = 0, lastAt = 0, acct = null;

  const liveAllowed = () => opts.live === true && isArmed(opts.armFile);
  const backoffMs = (i, retryAfter) => (retryAfter > 0 ? retryAfter * 1000 : Math.round(Math.min(30000, 1000 * 2 ** i) * (0.5 + rnd())));
  const nap = async (ms) => { stats.sleeps.push(ms); await sleep(ms); };

  const shapeOk = (p) => typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && !/[\s\\]|:\/\//.test(p);
  // the path exactly as the server receives it: a '.' or '..' segment (also %2e forms, also inside a %2F-encoded segment) or any
  // rewrite by the URL parser makes it null, so the guard below always judges the path that is actually sent
  function servedPath(p) {
    const raw = p.split(/[?#]/)[0];
    for (const seg of raw.split("/")) { let d; try { d = decodeURIComponent(seg); } catch { return null; } if (d.split(/[/\\]/).some((x) => x === "." || x === "..")) return null; }
    let np; try { np = new URL(host + p).pathname; } catch { return null; }
    return np === raw ? np : null;
  }
  function assertUrl(p) {
    if (!shapeOk(p)) throw new BrokerError("HOST", `refused path ${String(p).slice(0, 80)}`);
    if (servedPath(p) == null) throw new BrokerError("HOST", `refused path with dot segments or a non-canonical form: ${p.slice(0, 80)}`);
    return hostCheck(env, host + p);
  }
  async function pace() { const wait = lastAt + minGapMs - now(); if (wait > 0) await nap(wait); lastAt = now(); }
  async function send(method, p, body, auth) {
    const url = assertUrl(p); await pace(); stats.requests++;
    const headers = { "User-Agent": UA, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) headers.Authorization = "Bearer " + (await token());
    let res;
    try { res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined }); }
    catch (e) { return { status: 0, ok: false, network: true, json: null, data: undefined, error: { code: "network", message: String((e && e.message) || e).slice(0, 160) } }; }
    const status = num(res && res.status) || 0; let text = ""; try { text = await res.text(); } catch {}
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    const ra = res && res.headers && typeof res.headers.get === "function" ? num(res.headers.get("retry-after")) : null;
    return { status, ok: status >= 200 && status < 300, json, data: obj(json).data, error: errOf(json, json ? null : text, status), retryAfter: ra };
  }
  async function token() {
    if (tok && now() < exp - 60000) return tok;
    let r = null;
    for (let i = 0; i <= 2; i++) {   // 429 / 5xx / network only; a 4xx is never retried (repeated failed logins can IP-block for ~8 h per the docs)
      r = await send("POST", "/oauth/token", { grant_type: "refresh_token", refresh_token: creds.refreshToken, client_secret: creds.clientSecret, client_id: creds.clientId }, false);
      if (!(r.status === 429 || r.status >= 500 || r.network) || i === 2) break; stats.retries++; await nap(backoffMs(i, r.retryAfter));
    }
    const j = obj(r.json);
    if (!r.ok || typeof j.access_token !== "string" || !j.access_token) { tok = null; throw new BrokerError("TOKEN", `${env} token exchange failed (HTTP ${r.status}${r.error && r.error.code ? ", " + r.error.code : ""})`); }
    tok = j.access_token; exp = now() + (num(j.expires_in) > 0 ? num(j.expires_in) : 900) * 1000; stats.tokenRefreshes++; return tok;
  }
  function guard(method, p) {
    if (!["GET", "POST", "DELETE"].includes(method)) throw new BrokerError("REFUSED", `method ${method} not used by this adapter`);
    // judged on the NORMALISED path (what fetch sends): '/accounts/X/orders/dry-run/..' would reach '/accounts/X/orders/' — refused here
    const np = shapeOk(p) ? servedPath(p) : null;   // a malformed shape is refused by assertUrl (HOST) for GETs; writes never pass with it
    if (shapeOk(p) && np == null) throw new BrokerError("REFUSED", `REFUSED: path with dot segments or a non-canonical form (${p.slice(0, 80).replace(/\d{4,}|[A-Z0-9]{5,}(?=\/orders)/g, "…")})`);
    if (env === "prod" && method !== "GET" && !(method === "POST" && np != null && (np === "/oauth/token" || DRY_RUN_RE.test(np))) && !liveAllowed())
      throw new BrokerError("REFUSED", `REFUSED: production ${method} ${p.replace(/\d{4,}|[A-Z0-9]{5,}(?=\/orders)/g, "…")} needs live:true AND the operator's arm file${opts.armFile ? " (" + path.basename(opts.armFile) + ")" : ""}`);
  }
  // one choke point: guard, pace, 401 refresh-once, 429/5xx/network backoff (never for an order POST — place() owns that)
  async function request(method, p, body, { retry = true, retries = maxRetries } = {}) {
    guard(method, p);
    let refreshed = false;
    for (let i = 0; ; i++) {
      const r = await send(method, p, body, true);
      if (r.status === 401 && !refreshed) { refreshed = true; tok = null; stats.retries++; continue; }
      if (retry && (r.status === 429 || r.status >= 500 || r.network) && i < retries) { stats.retries++; log({ kind: "backoff", method, status: r.status, attempt: i + 1 }); await nap(backoffMs(i, r.retryAfter)); continue; }
      return r;
    }
  }
  const need = () => { if (!acct) throw new BrokerError("NOT_SELECTED", "no account selected — call selectAccount() first (pinned account required for orders)"); return acct; };
  const fail = (what, r) => new BrokerError("HTTP", `${what}: HTTP ${r.status}${r.error ? " " + errText(r.error) : ""}`, { httpStatus: r.status });

  // ---- accounts / balances / positions / status
  async function accounts() {
    const r = await request("GET", "/customers/me/accounts"); if (!r.ok) throw fail("accounts", r);
    return arr(obj(r.data).items).map((x) => { const a = obj(obj(x).account); return a["account-number"] ? { accountNumber: str(a["account-number"]), accountType: str(a["account-type-name"]), marginOrCash: str(a["margin-or-cash"]), nickname: str(a.nickname), isClosed: a["is-closed"] === true, isFuturesApproved: a["is-futures-approved"] === true, authority: str(obj(x)["authority-level"]) } : null; }).filter(Boolean);
  }
  async function selectAccount() {
    const list = await accounts(), pin = creds.accountNumber;
    if (!pin) throw new BrokerError("NOT_PINNED", `${PREFIX[env]}ACCOUNT_NUMBER is not set — orders refused. Accounts found: ${list.map((a) => `${a.accountNumber} (${a.accountType || "?"}, ${a.marginOrCash || "?"}${a.nickname ? ", " + a.nickname : ""})`).join("; ") || "none"}`, { accounts: list });
    const hit = list.find((a) => a.accountNumber === pin);
    if (!hit) throw new BrokerError("PIN_NOT_FOUND", `${PREFIX[env]}ACCOUNT_NUMBER …${pin.slice(-4)} is not among this login's accounts (${list.map((a) => a.accountNumber).join(", ") || "none"}) — orders refused`, { accounts: list });
    if (hit.isClosed) throw new BrokerError("ACCOUNT_CLOSED", `account …${pin.slice(-4)} is closed`, { accounts: list });
    acct = pin; return hit;
  }
  async function balances() {
    const r = await request("GET", `/accounts/${need()}/balances`); if (!r.ok) throw fail("balances", r); const d = obj(r.data), n = (k) => num(d[k]);
    return { nlv: n("net-liquidating-value"), cash: n("cash-balance"), equityBuyingPower: n("equity-buying-power"), derivativeBuyingPower: n("derivative-buying-power"), cryptoBuyingPower: n("effective-cryptocurrency-buying-power"), availableTradingFunds: n("available-trading-funds"), maintenanceRequirement: n("maintenance-requirement"), futuresMarginRequirement: n("futures-margin-requirement"), longEquityValue: n("long-equity-value"), longFuturesValue: n("long-futures-value"), longCryptoValue: n("long-cryptocurrency-value"), pendingCash: signed(n("pending-cash"), d["pending-cash-effect"]), marginEquity: n("margin-equity"), cashAvailableToWithdraw: n("cash-available-to-withdraw"), updatedAt: str(d["updated-at"]) };
  }
  async function positions() {
    const r = await request("GET", `/accounts/${need()}/positions`); if (!r.ok) throw fail("positions", r);
    return arr(obj(r.data).items).map((x) => { const p = obj(x), q = num(p.quantity); if (!p.symbol || q == null) return null; return { symbol: str(p.symbol), instrumentType: str(p["instrument-type"]), underlying: str(p["underlying-symbol"]), qty: p["quantity-direction"] === "Short" ? -q : q, direction: str(p["quantity-direction"]), closePrice: num(p["close-price"]), averageOpenPrice: num(p["average-open-price"]), multiplier: num(p.multiplier) || 1, mark: num(p.mark) }; }).filter((p) => p && p.qty !== 0);
  }
  async function tradingStatus() {
    const r = await request("GET", `/accounts/${need()}/trading-status`); if (!r.ok) throw fail("trading-status", r); const d = obj(r.data);
    return { frozen: d["is-frozen"] === true, closed: d["is-closed"] === true, closingOnly: d["is-closing-only"] === true, futuresEnabled: d["is-futures-enabled"] === true, futuresClosingOnly: d["is-futures-closing-only"] === true, cryptoEnabled: d["is-cryptocurrency-enabled"] === true, cryptoClosingOnly: d["is-cryptocurrency-closing-only"] === true, inMarginCall: d["is-in-margin-call"] === true, patternDayTrader: d["is-pattern-day-trader"] === true, dayTradeCount: num(d["day-trade-count"]), feeSchedule: str(d["fee-schedule-name"]) };
  }
  // ---- instruments
  async function equity(sym) { const r = await request("GET", `/instruments/equities/${encodeURIComponent(sym)}`); if (!r.ok) throw fail(`equity ${sym}`, r); const d = obj(r.data); return { symbol: str(d.symbol), active: d.active === true, isEtf: d["is-etf"] === true, closingOnly: d["is-closing-only"] === true, fractional: d["is-fractional-quantity-eligible"] === true, illiquid: d["is-illiquid"] === true, description: str(d["short-description"] || d.description) }; }
  const normFuture = (f) => ({ symbol: str(f.symbol), productCode: str(f["product-code"]), active: f.active === true, tradeable: f["is-tradeable"] === true, closingOnly: f["is-closing-only"] === true, activeMonth: f["active-month"] === true, nextActiveMonth: f["next-active-month"] === true, expirationDate: str(f["expiration-date"]), firstNotice: str(f["first-notice-date"]), closingOnlyDate: str(f["closing-only-date"]), lastTradeDate: str(f["last-trade-date"]), tick: num(f["tick-size"]), multiplier: num(f["notional-multiplier"]), streamer: str(f["streamer-symbol"]) });
  async function future(sym) { const r = await request("GET", `/instruments/futures/${encodeURIComponent(sym)}`); if (!r.ok) throw fail(`future ${sym}`, r); return normFuture(obj(r.data)); }
  async function futures(productCode) { const r = await request("GET", `/instruments/futures?product-code[]=${encodeURIComponent(productCode)}`); if (!r.ok) throw fail(`futures ${productCode}`, r); return arr(obj(r.data).items).map((f) => normFuture(obj(f))).filter((f) => f.symbol); }
  async function activeFuture(productCode) {   // the exchange's front ("active-month") tradeable contract; Plan E's ZN leg picks its own contract by R219's rule
    const live = (await futures(productCode)).filter((f) => f.active && f.tradeable && !f.closingOnly).sort((a, b) => String(a.expirationDate).localeCompare(String(b.expirationDate)));
    return live.find((f) => f.activeMonth) || live[0] || null;
  }
  async function crypto(sym) {
    const r = await request("GET", `/instruments/cryptocurrencies/${encodeURIComponent(sym)}`); if (!r.ok) throw fail(`crypto ${sym}`, r); const d = obj(r.data);
    const venues = arr(d["destination-venue-symbols"]).map(obj).filter((v) => v.routable !== false), qd = venues.map((v) => num(v["max-quantity-precision"])).filter((x) => x != null), pd = venues.map((v) => num(v["max-price-precision"])).filter((x) => x != null);
    return { symbol: str(d.symbol), active: d.active === true, closingOnly: d["is-closing-only"] === true, tick: num(d["tick-size"]), qtyDecimals: qd.length ? Math.min(...qd) : 8, priceDecimals: pd.length ? Math.min(...pd) : null, streamer: str(d["streamer-symbol"]) };
  }
  // ---- quotes (REST; production + funded accounts only; the sandbox answers 502)
  async function quotes(byType) {
    const parts = [], all = []; for (const k of ["equity", "future", "cryptocurrency"]) { const s = arr(obj(byType)[k]).filter(Boolean); if (s.length) { parts.push(`${k}=${s.map(encodeURIComponent).join(",")}`); all.push(...s); } }
    if (!all.length) return { available: true, bySymbol: {} }; if (all.length > 100) throw new BrokerError("VALIDATION", "quotes: at most 100 symbols per request (docs)");
    const r = await request("GET", `/market-data/by-type?${parts.join("&")}`, undefined, { retries: 1 });   // quotes are optional: one retry, then "unavailable" (the sandbox 502s forever)
    if (!r.ok) return { available: false, httpStatus: r.status, reason: errText(r.error) || `HTTP ${r.status}` };
    // market-data spec: "JSON keys are dasherized" (updatedAt -> updated-at; tradingHalted is "Serialized as `is-trading-halted`"); the
    // camelCase names the schema lists are read too, in case a response ever carries them
    const flag = (v) => v === true || v === "true";
    const out = {}; for (const x of arr(obj(r.data).items)) { const q = obj(x); if (!q.symbol) continue; const bid = num(q.bid), ask = num(q.ask), upd = str(q["updated-at"] ?? q.updatedAt), t = Date.parse(upd); out[q.symbol] = { bid, ask, mid: num(q.mid) ?? (bid > 0 && ask > 0 ? (bid + ask) / 2 : null), mark: num(q.mark), last: num(q.last), close: num(q.close), updatedAt: upd, ageMs: Number.isFinite(t) ? now() - t : null, halted: flag(q["is-trading-halted"]) || flag(q.tradingHalted) }; }
    return { available: true, bySymbol: out };
  }
  // ---- orders
  function summarize(o) {
    const d = obj(o), legs = arr(d.legs).map(obj), fills = legs.flatMap((l) => arr(l.fills).map(obj)); let q = 0, pv = 0, at = null;
    for (const f of fills) { const fq = num(f.quantity), fp = num(f["fill-price"]); if (fq > 0 && fp != null) { q += fq; pv += fq * fp; const t = str(f["filled-at"]); if (t && (!at || t > at)) at = t; } }
    const status = str(d.status), legQty = legs[0] ? num(legs[0].quantity) : null, remainingQty = legs[0] ? num(legs[0]["remaining-quantity"]) : null, size = num(d.size);
    // the quantity the ORDER says is filled (orders spec: Order.size, legs[].quantity, legs[].remaining-quantity): "Filled" is terminal =
    // the whole order filled, even while its leg fills have not been posted yet (lifecycle docs); otherwise quantity - remaining-quantity
    const orderFilledQty = status === "Filled" ? legQty ?? size : legQty != null && remainingQty != null ? Math.max(0, legQty - remainingQty) : null;
    return { id: d.id == null ? null : String(d.id), status, extId: str(d["external-identifier"]), orderType: str(d["order-type"]), tif: str(d["time-in-force"]), price: num(d.price), stopTrigger: num(d["stop-trigger"]), size, symbol: legs[0] ? str(legs[0].symbol) : null, action: legs[0] ? str(legs[0].action) : null, filledQty: q, avgFill: q ? pv / q : null, lastFillAt: at, legQty, remainingQty, orderFilledQty, fillsPending: orderFilledQty != null && orderFilledQty > q + 1e-9, rejectReason: str(d["reject-reason"]), terminal: TERMINAL.includes(status), working: WORKING.includes(status) };
  }
  // ok = 2xx AND no errors[] AND no warnings[]: the dry-run spec (POST /accounts/{account_number}/orders/dry-run, /openapi/orders.json)
  // says "A warning here means the order would be rejected if actually submitted." — so a warning is never OK (wouldReject)
  function parseDry(r) {
    const d = obj(r.data), bp = obj(d["buying-power-effect"]), fc = obj(d["fee-calculation"]), n = (o, k) => signed(num(o[k]), o[k + "-effect"]);
    const errors = [...arr(d.errors), ...arr(r.error && r.error.errors)].map((e) => ({ code: str(obj(e).code), message: str(obj(e).message) }));
    const warnings = arr(d.warnings).map((w) => ({ code: str(obj(w).code), message: str(obj(w).message) }));
    const cf = d["closing-fee-calculation"], closing = cf && typeof cf === "object" ? signed(num(cf["total-fees"]), cf["total-fees-effect"]) : num(cf);
    return { ok: r.ok && errors.length === 0 && warnings.length === 0, wouldReject: warnings.length > 0, httpStatus: r.status, error: r.ok ? null : errText(r.error) || `HTTP ${r.status}`, errors, warnings, order: d.order ? summarize(d.order) : null,
      buyingPower: { changeInBuyingPower: n(bp, "change-in-buying-power"), currentBuyingPower: n(bp, "current-buying-power"), newBuyingPower: n(bp, "new-buying-power"), changeInMarginRequirement: n(bp, "change-in-margin-requirement"), isolatedOrderMarginRequirement: n(bp, "isolated-order-margin-requirement"), impact: num(bp.impact), effect: str(bp.effect) },
      fees: { total: n(fc, "total-fees"), commission: n(fc, "commission"), clearing: n(fc, "clearing-fees"), regulatory: n(fc, "regulatory-fees"), proprietary: n(fc, "proprietary-index-option-fees") }, closingFees: closing };
  }
  async function dryRun(order) {
    validateOrder(order, { allowSymbols });
    const r = await request("POST", `/accounts/${need()}/orders/dry-run`, order);
    return parseDry(r);
  }
  async function findByExtId(extId) {   // no server-side filter exists for external-identifier (orders spec): scan today's orders, then the newest search page
    for (const p of [`/accounts/${need()}/orders/live?per-page=200`, `/accounts/${need()}/orders?per-page=200&sort=Desc`]) {
      const r = await request("GET", p); if (!r.ok) return { error: `${p.split("?")[0].replace(/\/accounts\/[^/]+/, "/accounts/…")}: HTTP ${r.status}` };
      const hit = arr(obj(r.data).items).map(obj).find((o) => o["external-identifier"] === extId); if (hit) return { order: hit };
    }
    return { order: null };
  }
  async function place(order) {
    validateOrder(order, { forPlace: true, allowSymbols });
    guard("POST", `/accounts/${need()}/orders`);   // refuse BEFORE any look-up when production is not armed
    const extId = order["external-identifier"], tries = [];
    const prior = await findByExtId(extId);
    if (prior.error) return { uncertain: true, extId, reason: `look-up before placing failed (${prior.error}) — nothing sent`, tries };
    if (prior.order) return { adopted: true, extId, order: summarize(prior.order), raw: prior.order, tries };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await request("POST", `/accounts/${need()}/orders`, order, { retry: false }); tries.push({ attempt, httpStatus: r.status });
      if (r.ok && obj(r.data).order && obj(obj(r.data).order).id != null) return { placed: true, extId, order: summarize(r.data.order), raw: r.data.order, warnings: arr(r.data.warnings), fees: parseDry(r).fees, buyingPower: parseDry(r).buyingPower, tries };
      if (!r.ok && r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 401) return { rejected: true, extId, httpStatus: r.status, error: errText(r.error) || `HTTP ${r.status}`, tries };
      // 2xx without an order id, 401, 429, 5xx, timeout/network: the outcome is UNKNOWN -> look the identifier up before any retry (docs)
      if (r.status === 401) tok = null;
      stats.retries++;
      if (env === "prod" && r.status !== 429 && r.status !== 401) {
        // PRODUCTION, outcome unknown (network / timeout / 5xx / 2xx without an id): the API does not de-duplicate and an order still being
        // processed may not be listed yet -> wait longer, look the identifier up twice, then UNCERTAIN. Never resent (only 429/401 are:
        // those were refused before processing).
        for (let k = 1; k <= 2; k++) {
          await nap(PROD_UNKNOWN_WAIT_MS);
          const look = await findByExtId(extId);
          if (look.error) return { uncertain: true, extId, reason: `HTTP ${r.status || "network"} then look-up failed (${look.error}) — NOT resent`, tries };
          if (look.order) return { adopted: true, extId, afterError: r.status || "network", lookups: k, order: summarize(look.order), raw: look.order, tries };
        }
        return { uncertain: true, extId, reason: `HTTP ${r.status || "network"}: outcome unknown and the identifier was not found in 2 look-ups over ${(2 * PROD_UNKNOWN_WAIT_MS) / 1000} s — NOT resent (the API does not de-duplicate; operator: check the account)`, tries };
      }
      await nap(backoffMs(attempt - 1, r.retryAfter));
      const look = await findByExtId(extId);
      if (look.error) return { uncertain: true, extId, reason: `HTTP ${r.status || "network"} then look-up failed (${look.error}) — NOT resent`, tries };
      if (look.order) return { adopted: true, extId, afterError: r.status || "network", order: summarize(look.order), raw: look.order, tries };
    }
    return { failed: true, extId, reason: "3 attempts, no order found under the identifier", tries };
  }
  async function cancel(id) {
    const r = await request("DELETE", `/accounts/${need()}/orders/${encodeURIComponent(String(id))}`);
    return { ok: r.ok, httpStatus: r.status, error: r.ok ? null : errText(r.error) || `HTTP ${r.status}`, order: r.data ? summarize(r.data) : null };
  }
  async function order(id) { const r = await request("GET", `/accounts/${need()}/orders/${encodeURIComponent(String(id))}`); if (!r.ok) return { ok: false, httpStatus: r.status, error: errText(r.error) }; return { ok: true, order: summarize(r.data), raw: r.data }; }
  async function liveOrders() { const r = await request("GET", `/accounts/${need()}/orders/live?per-page=200`); if (!r.ok) throw fail("live orders", r); return arr(obj(r.data).items).map(summarize); }
  // poll until a status in `until` (default: any terminal) or the timeout; "Filled" is re-read until the leg fills arrive (lifecycle docs)
  async function waitOrder(id, { until = TERMINAL, timeoutMs = 60000, pollMs = 2000 } = {}) {
    const t0 = now(); let last = null;
    for (;;) {
      const r = await order(id); if (r.ok) { last = r.order; if (until.includes(last.status) || (last.terminal && !until.includes(last.status))) break; }
      if (now() - t0 >= timeoutMs) break; await nap(pollMs);
    }
    if (last && last.status === "Filled" && !last.filledQty) for (let i = 0; i < 5 && !last.filledQty; i++) { await nap(1500); const r = await order(id); if (r.ok) last = r.order; }
    return { order: last, waitedMs: now() - t0, timedOut: !last || !until.includes(last.status) };
  }
  async function fees(orderIds, startDate) {
    const r = await request("GET", `/accounts/${need()}/transactions?start-date=${encodeURIComponent(startDate)}&per-page=250`); if (!r.ok) return { available: false, httpStatus: r.status };
    const ids = orderIds.map(String), rows = arr(obj(r.data).items).map(obj).filter((t) => ids.includes(String(t["order-id"]))); if (!rows.length) return { available: false, rows: 0 };
    const s = (k) => +rows.reduce((a, t) => a + Math.abs(num(t[k]) || 0), 0).toFixed(4);
    const out = { available: true, rows: rows.length, commission: s("commission"), clearing: s("clearing-fees"), regulatory: s("regulatory-fees"), proprietary: s("proprietary-index-option-fees"), other: s("other-charge"), estimated: rows.some((t) => t["is-estimated-fee"] === true) };
    out.total = +(out.commission + out.clearing + out.regulatory + out.proprietary + out.other).toFixed(4); return out;
  }
  return { env, host, accountNumber: () => acct, pinned: () => creds.accountNumber, liveAllowed, stats, token, request, accounts, selectAccount, balances, positions, tradingStatus, equity, future, futures, activeFuture, crypto, quotes, dryRun, place, cancel, order, liveOrders, waitOrder, findByExtId, fees, summarize, invalidateToken: () => { tok = null; } };
}

// ================================================================== selftest (fake HTTP; no network) ==================================================================
function fakeHttp(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || "GET", rec = { method, url, host: u.origin, path: u.pathname, search: u.search, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(rec);
    const rt = routes.find((x) => x.method === method && (typeof x.path === "string" ? x.path === u.pathname : x.path.test(u.pathname + u.search)));
    if (!rt) throw new Error(`fakeHttp: no route for ${method} ${u.pathname}${u.search}`);
    let out = typeof rt.respond === "function" ? rt.respond(rec) : Array.isArray(rt.respond) ? rt.respond[Math.min(rt.n = (rt.n || 0) + 1, rt.respond.length) - 1] : rt.respond;
    if (typeof out === "function") out = out(rec);
    if (out && out.throw) throw new Error(out.throw);
    const body = out.raw != null ? out.raw : JSON.stringify(out.body == null ? {} : out.body), hdr = out.headers || {};
    return { status: out.status || 200, headers: { get: (k) => hdr[k.toLowerCase()] ?? null }, text: async () => body };
  };
  return { fetch, calls };
}

async function selftest() {
  const fails = []; let n = 0;
  const eq = (label, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`); if (!ok) fails.push(label); };
  const throwsCode = async (label, fn, code, re) => { n++; try { await fn(); console.log(`FAIL ${label}: did not throw`); fails.push(label); } catch (e) { const ok = e.code === code && (!re || re.test(e.message)); console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `: threw ${e.code} ${e.message}`}`); if (!ok) fails.push(label); } };
  const os = require("os"), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tasty-broker-selftest-")), ARM = path.join(tmp, "ARMED");
  const FAKE_RT = "rt-SECRET-should-never-print-123456", creds = (env, acctNo = "5WT00001") => ({ prefix: PREFIX[env], clientId: "cid", clientSecret: "csecret", refreshToken: FAKE_RT, accountNumber: acctNo });
  let clock = 1_800_000_000_000; const now = () => clock, sleep = async (ms) => { clock += ms; };
  const tokenRoute = (counter) => ({ method: "POST", path: "/oauth/token", respond: () => { counter.n = (counter.n || 0) + 1; return { status: 200, body: { access_token: `AT${counter.n}`, expires_in: 900, token_type: "Bearer" } }; } });
  const acctRoute = { method: "GET", path: "/customers/me/accounts", respond: { body: { data: { items: [{ account: { "account-number": "5WT00001", "account-type-name": "Individual", "margin-or-cash": "Margin", "is-closed": false }, "authority-level": "owner" }, { account: { "account-number": "5WT00002", "account-type-name": "Roth IRA", "margin-or-cash": "Cash" }, "authority-level": "owner" }] } } } };
  const mk = (env, routes, extra = {}) => { const h = fakeHttp(routes); return { h, b: createBroker({ env, creds: creds(env, extra.acctNo === undefined ? "5WT00001" : extra.acctNo), fetch: h.fetch, sleep, now, random: () => 0.5, minGapMs: extra.minGapMs || 0, live: extra.live, armFile: extra.armFile, allowSymbols: extra.allowSymbols }) }; };

  // ---- 1. builders: exact JSON
  eq("equity market BUY", buildEquityOrder({ symbol: "QQQ", qty: 3, side: "BUY", type: "Market", extId: "pe-20261009-QQQ-B" }), { "time-in-force": "Day", "order-type": "Market", legs: [{ "instrument-type": "Equity", symbol: "QQQ", quantity: "3", action: "Buy to Open" }], "external-identifier": "pe-20261009-QQQ-B" });
  eq("equity limit SELL (cents, Credit)", buildEquityOrder({ symbol: "SPY", qty: 12, side: "SELL", type: "Limit", price: 612.3449, extId: "pe-x" }), { "time-in-force": "Day", "order-type": "Limit", price: "612.34", "price-effect": "Credit", legs: [{ "instrument-type": "Equity", symbol: "SPY", quantity: "12", action: "Sell to Close" }], "external-identifier": "pe-x" });
  eq("equity limit BUY 99.999 -> 100.00 Debit", buildEquityOrder({ symbol: "SGOV", qty: 1, side: "BUY", type: "Limit", price: 99.999 }), { "time-in-force": "Day", "order-type": "Limit", price: "100.00", "price-effect": "Debit", legs: [{ "instrument-type": "Equity", symbol: "SGOV", quantity: "1", action: "Buy to Open" }] });
  eq("future limit BUY on tick", buildFutureOrder({ symbol: "/ZNZ6", qty: 1, side: "BUY", price: 112.515625, tick: 0.015625, extId: "pe-zn-202610-B-L1" }), { "time-in-force": "Day", "order-type": "Limit", price: "112.515625", "price-effect": "Debit", legs: [{ "instrument-type": "Future", symbol: "/ZNZ6", quantity: "1", action: "Buy to Open" }], "external-identifier": "pe-zn-202610-B-L1" });
  eq("future limit SELL off-tick 112.52 -> 112.515625 Credit", buildFutureOrder({ symbol: "/ZNZ6", qty: 2, side: "SELL", price: 112.52, tick: 1 / 64 }), { "time-in-force": "Day", "order-type": "Limit", price: "112.515625", "price-effect": "Credit", legs: [{ "instrument-type": "Future", symbol: "/ZNZ6", quantity: "2", action: "Sell to Close" }] });
  eq("future GTC stop SELL", buildFutureStop({ symbol: "/ZNZ6", qty: 1, trigger: 110.015625, tick: 1 / 64, extId: "pe-zn-202610-DSTOP" }), { "time-in-force": "GTC", "order-type": "Stop", "stop-trigger": "110.015625", legs: [{ "instrument-type": "Future", symbol: "/ZNZ6", quantity: "1", action: "Sell to Close" }], "external-identifier": "pe-zn-202610-DSTOP" });
  eq("crypto limit BUY (8 dp floor, tick 0.01, GTC)", buildCryptoOrder({ symbol: "BTC/USD", qty: 0.123456789, side: "BUY", type: "Limit", price: 62123.456, tick: 0.01, qtyDecimals: 8, extId: "pe-20261009-BTCUSD-B" }), { "time-in-force": "GTC", "order-type": "Limit", price: "62123.46", "price-effect": "Debit", legs: [{ "instrument-type": "Cryptocurrency", symbol: "BTC/USD", quantity: "0.12345678", action: "Buy to Open" }], "external-identifier": "pe-20261009-BTCUSD-B" });
  eq("crypto market SELL (IOC, no price)", buildCryptoOrder({ symbol: "ETH/USD", qty: 1.5, side: "SELL", type: "Market", qtyDecimals: 8 }), { "time-in-force": "IOC", "order-type": "Market", legs: [{ "instrument-type": "Cryptocurrency", symbol: "ETH/USD", quantity: "1.5", action: "Sell to Close" }] });
  eq("fmtNum keeps integer zeros (10 -> '10', 110 -> '110')", [fmtNum(10), fmtNum(110), fmtNum(110.5), fmtNum(0.00012300, 8)], ["10", "110", "110.5", "0.000123"]);
  await throwsCode("builder: qty 0 refused", () => buildEquityOrder({ symbol: "QQQ", qty: 0, side: "BUY" }), "VALIDATION");
  await throwsCode("builder: crypto qty rounds to 0 refused", () => buildCryptoOrder({ symbol: "BTC/USD", qty: 0.000000001, side: "BUY", type: "Market", qtyDecimals: 8 }), "VALIDATION", /rounds to 0/);
  eq("builder: equity qty 2.7 floors to '2' (whole shares never round up)", buildEquityOrder({ symbol: "QQQ", qty: 2.7, side: "BUY" }).legs[0].quantity, "2");
  await throwsCode("builder: equity qty 0.5 rounds to 0 -> refused", () => buildEquityOrder({ symbol: "QQQ", qty: 0.5, side: "BUY" }), "VALIDATION", /rounds to 0/);
  await throwsCode("builder: side SHORT refused", () => buildEquityOrder({ symbol: "QQQ", qty: 1, side: "SHORT" }), "VALIDATION");
  await throwsCode("builder: future stop trigger <= 0 refused (a $1 sandbox fill - 2.5)", () => buildFutureStop({ symbol: "/ZNZ6", qty: 1, trigger: -1.5 }), "VALIDATION");
  await throwsCode("builder: bad future symbol refused", () => buildFutureOrder({ symbol: "ZNZ6", qty: 1, side: "BUY", price: 1, tick: 1 / 64 }), "VALIDATION");
  // local validation
  await throwsCode("validate: Market + GTC refused", () => validateOrder({ "time-in-force": "GTC", "order-type": "Market", legs: [{ "instrument-type": "Equity", symbol: "QQQ", quantity: "1", action: "Buy to Open" }] }), "VALIDATION", /GTC/);
  await throwsCode("validate: BUY limit as Credit refused", () => validateOrder({ "time-in-force": "Day", "order-type": "Limit", price: "1", "price-effect": "Credit", legs: [{ "instrument-type": "Equity", symbol: "QQQ", quantity: "1", action: "Buy to Open" }] }), "VALIDATION", /Debit/);
  await throwsCode("validate: 2 legs refused", () => validateOrder({ "time-in-force": "Day", "order-type": "Market", legs: [{ "instrument-type": "Equity", symbol: "QQQ", quantity: "1", action: "Buy to Open" }, { "instrument-type": "Equity", symbol: "SPY", quantity: "1", action: "Buy to Open" }] }), "VALIDATION", /1 leg/);
  await throwsCode("validate: place without external-identifier refused", () => validateOrder(buildEquityOrder({ symbol: "QQQ", qty: 1, side: "BUY" }), { forPlace: true }), "VALIDATION", /external-identifier/);
  await throwsCode("validate: Sell to Open (short) refused", () => validateOrder({ "time-in-force": "Day", "order-type": "Market", legs: [{ "instrument-type": "Equity", symbol: "QQQ", quantity: "1", action: "Sell to Open" }] }), "VALIDATION", /action/);
  await throwsCode("validate: Equity Option refused", () => validateOrder({ "time-in-force": "Day", "order-type": "Market", legs: [{ "instrument-type": "Equity Option", symbol: "SPY", quantity: "1", action: "Buy to Open" }] }), "VALIDATION", /instrument-type/);
  // raw bodies (the builders refuse these before validateOrder is reached; place() and dryRun() take any body, so the choke point is tested alone)
  { const leg1 = (o = {}) => ({ "instrument-type": "Equity", symbol: "QQQ", quantity: "1", action: "Buy to Open", ...o });
    await throwsCode("validate: raw quantity '0' refused", () => validateOrder({ "time-in-force": "Day", "order-type": "Market", legs: [leg1({ quantity: "0" })] }), "VALIDATION", /quantity 0 must be > 0/);
    await throwsCode("validate: raw Stop on an Equity leg refused", () => validateOrder({ "time-in-force": "GTC", "order-type": "Stop", "stop-trigger": "100", legs: [leg1({ action: "Sell to Close" })] }), "VALIDATION", /Stop orders only for the ZN disaster stop/);
    await throwsCode("validate: raw Stop with no stop-trigger refused", () => validateOrder({ "time-in-force": "GTC", "order-type": "Stop", legs: [{ "instrument-type": "Future", symbol: "/ZNZ6", quantity: "1", action: "Sell to Close" }] }), "VALIDATION", /Stop needs stop-trigger > 0/);
    await throwsCode("validate: raw Limit with no price refused", () => validateOrder({ "time-in-force": "Day", "order-type": "Limit", "price-effect": "Debit", legs: [leg1()] }), "VALIDATION", /Limit needs price > 0/); }

  // ---- 2. env / host / credential guards
  await throwsCode("env 'live' refused", () => createBroker({ env: "live", creds: creds("prod") }), "ENV");
  await throwsCode("cert creds on prod refused", () => createBroker({ env: "prod", creds: creds("cert"), fetch: () => { throw new Error("no"); } }), "CREDS", /prefix/);
  await throwsCode("missing creds named, never valued", () => createBroker({ env: "cert", creds: { prefix: "TASTY_CERT_", clientId: "x" } }), "CREDS", /TASTY_CERT_CLIENT_SECRET, TASTY_CERT_REFRESH_TOKEN/);
  eq("credsFromEnv picks only the env's prefix", (() => { const c = credsFromEnv("cert", { TASTY_CLIENT_ID: "P", TASTY_CERT_CLIENT_ID: "C", TASTY_CERT_CLIENT_SECRET: "S", TASTY_CERT_REFRESH_TOKEN: "R", TASTY_ACCOUNT_NUMBER: "PROD1", TASTY_CERT_ACCOUNT_NUMBER: " 5WT9 " }); return [c.prefix, c.clientId, c.accountNumber]; })(), ["TASTY_CERT_", "C", "5WT9"]);
  {
    const tc = {}, { h, b } = mk("cert", [tokenRoute(tc), acctRoute]);
    await throwsCode("host assert: absolute URL in a path refused", () => b.request("GET", "https://evil.example/x"), "HOST");
    await throwsCode("host assert: protocol-relative path refused", () => b.request("GET", "//evil.example/x"), "HOST");
    await throwsCode("host assert: relative path refused", () => b.request("GET", "customers/me"), "HOST");
    await b.accounts(); eq("cert requests go only to api.cert.tastyworks.com", [...new Set(h.calls.map((c) => c.host))], ["https://api.cert.tastyworks.com"]);
    eq("User-Agent on every request incl. token", h.calls.every((c) => c.headers["User-Agent"] === UA), true);
  }
  {
    const tc = {}, { h, b } = mk("prod", [tokenRoute(tc), acctRoute]); await b.accounts();
    eq("prod requests go only to api.tastyworks.com", [...new Set(h.calls.map((c) => c.host))], ["https://api.tastyworks.com"]);
  }
  await throwsCode("host assert: a cert URL is refused for prod", () => hostCheck("prod", "https://api.cert.tastyworks.com/customers/me/accounts"), "HOST");
  await throwsCode("host assert: a prod URL is refused for cert", () => hostCheck("cert", "https://api.tastyworks.com/customers/me/accounts"), "HOST");
  await throwsCode("host assert: plain http refused", () => hostCheck("prod", "http://api.tastyworks.com/x"), "HOST");
  await throwsCode("host assert: look-alike host refused", () => hostCheck("prod", "https://api.tastyworks.com.evil.example/x"), "HOST");
  eq("host assert: the env's own host passes", [hostCheck("prod", "https://api.tastyworks.com/a"), hostCheck("cert", "https://api.cert.tastyworks.com/a")], ["https://api.tastyworks.com/a", "https://api.cert.tastyworks.com/a"]);

  // ---- 3. production mutation guard (arm file + live flag), account pin
  const orderBody = { ...buildEquityOrder({ symbol: "QQQ", qty: 1, side: "BUY", type: "Market", extId: "pe-t-1" }) };
  const dryResp = { status: 201, body: { data: { order: { id: null, status: "Received", legs: [{ symbol: "QQQ", quantity: "1", action: "Buy to Open" }] }, "buying-power-effect": { "change-in-buying-power": "605.12", "change-in-buying-power-effect": "Debit", "new-buying-power": "24394.88", "new-buying-power-effect": "Credit", "current-buying-power": "25000.0", "current-buying-power-effect": "Credit", "change-in-margin-requirement": "605.12", "change-in-margin-requirement-effect": "Debit", "isolated-order-margin-requirement": "605.12", "isolated-order-margin-requirement-effect": "Debit", impact: "605.12", effect: "Debit" }, "fee-calculation": { "regulatory-fees": "0.0", "regulatory-fees-effect": "None", "clearing-fees": "0.008", "clearing-fees-effect": "Debit", commission: "0.0", "commission-effect": "None", "proprietary-index-option-fees": "0.0", "total-fees": "0.008", "total-fees-effect": "Debit" }, warnings: [{ code: "market_closed", message: "Market is closed" }] } } };
  const orderRoutes = (tc, extra = []) => [tokenRoute(tc), acctRoute, ...extra, { method: "POST", path: /^\/accounts\/5WT00001\/orders\/dry-run$/, respond: dryResp }, { method: "GET", path: /^\/accounts\/5WT00001\/orders\/live/, respond: { body: { data: { items: [] } } } }, { method: "GET", path: /^\/accounts\/5WT00001\/orders\?/, respond: { body: { data: { items: [] } } } }, { method: "POST", path: "/accounts/5WT00001/orders", respond: { status: 201, body: { data: { order: { id: 555, status: "Routed", "external-identifier": "pe-t-1", legs: [{ symbol: "QQQ", quantity: "1", action: "Buy to Open", fills: [] }] }, warnings: [] } } } }, { method: "DELETE", path: /^\/accounts\/5WT00001\/orders\/\d+$/, respond: { status: 200, body: { data: { id: 555, status: "Cancel Requested", legs: [] } } } }];
  {
    const tc = {}, { h, b } = mk("prod", orderRoutes(tc)); await b.selectAccount();
    // the fixture carries a market_closed warning: per the dry-run spec a warning means "would be rejected", so ok is false (and wouldReject true)
    const d = await b.dryRun(orderBody); eq("prod dry-run allowed without arm (POST .../orders/dry-run only)", [d.ok, d.wouldReject, d.httpStatus, h.calls.filter((c) => c.method === "POST" && /\/orders\/dry-run$/.test(c.path)).length], [false, true, 201, 1]);
    eq("dry-run parse: buying power signed (Debit -> negative), fees", [d.buyingPower.changeInBuyingPower, d.buyingPower.newBuyingPower, d.fees.total, d.fees.clearing, d.fees.commission, d.warnings[0].code], [-605.12, 24394.88, -0.008, -0.008, 0, "market_closed"]);
    await throwsCode("prod place refused: no live flag, no arm file", () => b.place(orderBody), "REFUSED", /arm file/);
    await throwsCode("prod cancel refused: no live flag, no arm file", () => b.cancel(555), "REFUSED");
    eq("refused prod place sent nothing (no POST /orders, no look-up)", h.calls.filter((c) => c.method !== "GET" && c.path !== "/oauth/token" && !/dry-run/.test(c.path)).length + h.calls.filter((c) => /orders\/live|orders\?/.test(c.path + c.search)).length, 0);
  }
  {
    const tc = {}, { b } = mk("prod", [tokenRoute(tc), acctRoute, { method: "POST", path: /dry-run$/, respond: { status: 201, body: { data: { order: { status: "Received", legs: [] }, warnings: [], "buying-power-effect": {}, "fee-calculation": {} } } } }]); await b.selectAccount();
    const d = await b.dryRun(orderBody); eq("dry-run 201 with no warnings and no errors -> ok true", [d.ok, d.wouldReject], [true, false]);
  }
  {   // B03: the exemption must hold for the path fetch actually sends ('.../dry-run/..' normalises to '.../orders/')
    const tc = {}, { h, b } = mk("prod", orderRoutes(tc)); await b.selectAccount();
    await throwsCode("prod unarmed POST .../orders/dry-run/.. refused (URL normalizes to .../orders/)", () => b.request("POST", "/accounts/5WT00001/orders/dry-run/..", orderBody), "REFUSED");
    await throwsCode("prod unarmed POST .../orders/dry-run/%2e%2e refused (encoded dot segment)", () => b.request("POST", "/accounts/5WT00001/orders/dry-run/%2e%2e", orderBody), "REFUSED");
    await throwsCode("prod unarmed POST .../orders/dry-run/x refused (exemption is the exact dry-run path only)", () => b.request("POST", "/accounts/5WT00001/orders/dry-run/x", orderBody), "REFUSED", /needs live:true/);
    eq("nothing POSTed for the dot-segment / longer dry-run paths", h.calls.filter((c) => c.method === "POST" && c.path !== "/oauth/token").length, 0);
    await throwsCode("a dot segment is refused even for a GET", () => b.request("GET", "/accounts/5WT00001/./balances"), "REFUSED");
  }
  { const tc = {}, closedAcct = { method: "GET", path: "/customers/me/accounts", respond: { body: { data: { items: [{ account: { "account-number": "5WT00001", "is-closed": true } }] } } } };
    const { b } = mk("cert", [tokenRoute(tc), closedAcct]); await throwsCode("pinned account closed -> ACCOUNT_CLOSED (orders refused)", () => b.selectAccount(), "ACCOUNT_CLOSED"); }
  {
    const tc = {}, { h, b } = mk("prod", orderRoutes(tc), { live: true, armFile: ARM }); await b.selectAccount();
    await throwsCode("prod place refused: live flag but arm file ABSENT", () => b.place(orderBody), "REFUSED");
    fs.writeFileSync(ARM, " \r\n\t\n"); await throwsCode("prod place refused: arm file whitespace only", () => b.place(orderBody), "REFUSED");
    fs.writeFileSync(ARM, "armed by operator (selftest temp file)\n"); const p = await b.place(orderBody);
    eq("prod place allowed: live flag AND non-empty arm file", [p.placed, p.order.id, p.order.status], [true, "555", "Routed"]);
    fs.unlinkSync(ARM); await throwsCode("arm file re-checked on every call (removed -> refused)", () => b.cancel(555), "REFUSED");
    eq("exactly one order POST happened", h.calls.filter((c) => c.method === "POST" && c.path === "/accounts/5WT00001/orders").length, 1);
  }
  {
    const tc = {}, { b } = mk("prod", orderRoutes(tc), { armFile: ARM }); fs.writeFileSync(ARM, "armed\n"); await b.selectAccount();
    await throwsCode("prod place refused: arm file present but live flag absent", () => b.place(orderBody), "REFUSED"); fs.unlinkSync(ARM);
  }
  {
    const tc = {}, { b } = mk("cert", orderRoutes(tc).map((r) => ({ ...r })));
    await throwsCode("orders before selectAccount refused", () => b.dryRun(orderBody), "NOT_SELECTED");
    await b.selectAccount(); const p = await b.place(orderBody); eq("cert place needs no arm file", !!p.placed, true);
  }
  {
    const tc = {}, { h, b } = mk("prod", orderRoutes(tc), { acctNo: null });
    await throwsCode("account not pinned -> NOT_PINNED lists the accounts found", () => b.selectAccount(), "NOT_PINNED", /5WT00001 \(Individual, Margin\); 5WT00002 \(Roth IRA, Cash\)/);
    await throwsCode("unpinned: dry-run refused (no account selected)", () => b.dryRun(orderBody), "NOT_SELECTED");
    eq("unpinned: no order or dry-run request reached the network", h.calls.filter((c) => /orders/.test(c.path)).length, 0);
  }
  { const tc = {}, { b } = mk("prod", orderRoutes(tc), { acctNo: "5WT99999" }); await throwsCode("pinned account not in the login's accounts -> PIN_NOT_FOUND", () => b.selectAccount(), "PIN_NOT_FOUND"); }
  { const tc = {}, { h, b } = mk("prod", orderRoutes(tc), { acctNo: "5WT10001" });
    await throwsCode("pin 5WT10001 shares only the last 4 with login account 5WT00001 -> PIN_NOT_FOUND (exact match only)", () => b.selectAccount(), "PIN_NOT_FOUND");
    await throwsCode("pin not found: dry-run refused (no account selected)", () => b.dryRun(orderBody), "NOT_SELECTED");
    eq("pin not found: no order or dry-run request reached the network", h.calls.filter((c) => /orders/.test(c.path)).length, 0); }
  { const tc = {}, { h, b } = mk("cert", orderRoutes(tc), { allowSymbols: ["QQQ", "SPY"] }); await b.selectAccount();
    await throwsCode("whitelist: TSLA refused before the network", () => b.place(buildEquityOrder({ symbol: "TSLA", qty: 1, side: "BUY", extId: "pe-t-2" })), "VALIDATION", /whitelist/);
    await throwsCode("whitelist: dry-run of TSLA refused too", () => b.dryRun(buildEquityOrder({ symbol: "TSLA", qty: 1, side: "BUY" })), "VALIDATION", /whitelist/);
    eq("whitelist refusals sent nothing", h.calls.filter((c) => /orders/.test(c.path)).length, 0); }

  // ---- 4. token: exchange body, caching, expiry refresh, 401 refresh, failure text never carries secrets
  {
    const tc = {}, { h, b } = mk("cert", [tokenRoute(tc), acctRoute]);
    await b.accounts(); await b.accounts(); await b.accounts();
    const tcalls = h.calls.filter((c) => c.path === "/oauth/token");
    eq("token: one exchange for three requests (cached in memory)", tcalls.length, 1);
    eq("token: refresh_token grant body keys", Object.keys(tcalls[0].body).sort(), ["client_id", "client_secret", "grant_type", "refresh_token"]);
    eq("token: grant_type refresh_token; Authorization Bearer AT1", [tcalls[0].body.grant_type, h.calls[1].headers.Authorization], ["refresh_token", "Bearer AT1"]);
    clock += 841 * 1000; await b.accounts(); eq("token: refreshed when < 60 s of its 900 s remain", [h.calls.filter((c) => c.path === "/oauth/token").length, h.calls[h.calls.length - 1].headers.Authorization], [2, "Bearer AT2"]);
  }
  {
    const tc = {}, routes = [tokenRoute(tc), { method: "GET", path: "/customers/me/accounts", respond: [{ status: 401, body: { error: { code: "unauthorized", message: "token expired" } } }, acctRoute.respond] }];
    const { h, b } = mk("cert", routes); const a = await b.accounts();
    eq("token: 401 -> token refreshed once and the request retried", [a.length, h.calls.filter((c) => c.path === "/oauth/token").length], [2, 2]);
  }
  { let n401 = 0; const tc = {}, { h, b } = mk("cert", [tokenRoute(tc), { method: "GET", path: "/customers/me/accounts", respond: () => { n401++; if (n401 > 20) return { throw: "runaway 401 loop" }; return { status: 401, body: { error: { code: "unauthorized", message: "revoked" } } }; } }]);
    await throwsCode("token: persistent 401 -> one refresh, then a loud HTTP 401", () => b.accounts(), "HTTP", /HTTP 401/);
    eq("token: persistent 401 -> exactly 2 token exchanges and 2 GETs (no login loop: IP-block risk)", [h.calls.filter((c) => c.path === "/oauth/token").length, n401], [2, 2]); }
  {
    const { b } = mk("cert", [{ method: "POST", path: "/oauth/token", respond: { status: 400, body: { error: "invalid_grant", error_description: "Grant revoked" } } }]);
    let msg = ""; try { await b.accounts(); } catch (e) { msg = e.message + JSON.stringify(e); }
    eq("token failure: error names the code, never the refresh token or secret", [/invalid_grant/.test(msg), msg.includes(FAKE_RT), msg.includes("csecret")], [true, false, false]);
  }
  {
    const tcalls = { n: 0 }, { h, b } = mk("cert", [{ method: "POST", path: "/oauth/token", respond: () => { tcalls.n++; return { status: 400, body: { error: "invalid_grant" } }; } }]);
    try { await b.accounts(); } catch {} eq("token: a 4xx is never retried (IP-block risk)", h.calls.filter((c) => c.path === "/oauth/token").length, 1);
  }

  // ---- 5. pacing and 429 back-off
  {
    const tc = {}, { h, b } = mk("cert", [tokenRoute(tc), { method: "GET", path: "/customers/me/accounts", respond: [{ status: 429, body: { error: { code: "rate_limit", message: "slow down" } } }, { status: 429, raw: "too many" }, { status: 503, raw: "<html>busy</html>" }, acctRoute.respond] }]);
    const s0 = b.stats.sleeps.length, a = await b.accounts();
    eq("429,429,503 then 200: three back-offs 1 s, 2 s, 4 s (jitter x1.0), then success", [a.length, b.stats.sleeps.slice(s0)], [2, [1000, 2000, 4000]]);
    eq("non-JSON error bodies parsed defensively", h.calls.length, 5);
  }
  {
    const tc = {}, { b } = mk("cert", [tokenRoute(tc), { method: "GET", path: "/customers/me/accounts", respond: [{ status: 429, headers: { "retry-after": "3" } }, acctRoute.respond] }]);
    const s0 = b.stats.sleeps.length; await b.accounts(); eq("Retry-After honoured (3 s)", b.stats.sleeps.slice(s0), [3000]);
  }
  {
    const tc = {}, { b } = mk("cert", [tokenRoute(tc), { method: "GET", path: "/customers/me/accounts", respond: { status: 503, raw: "" } }]);
    await throwsCode("5xx forever: capped retries then a loud error", () => b.accounts(), "HTTP", /HTTP 503/); eq("capped at 4 retries", b.stats.retries, 4);
  }
  {
    const tc = {}, { b } = mk("cert", [tokenRoute(tc), acctRoute], { minGapMs: 200 }); const s0 = b.stats.sleeps.length;
    await b.accounts(); await b.accounts(); eq("pacing: a 200 ms gap is enforced between requests", b.stats.sleeps.slice(s0).every((x) => x > 0 && x <= 200) && b.stats.sleeps.length - s0 >= 1, true);
  }

  // ---- 6. place(): look-up before placing and before every retry; adoption
  const liveWith = (items) => ({ method: "GET", path: /^\/accounts\/5WT00001\/orders\/live/, respond: typeof items === "function" ? items : { body: { data: { items } } } });
  const searchWith = (items) => ({ method: "GET", path: /^\/accounts\/5WT00001\/orders\?/, respond: typeof items === "function" ? items : { body: { data: { items } } } });
  const prior = { id: 777, status: "Filled", "external-identifier": "pe-t-1", legs: [{ symbol: "QQQ", quantity: "1", action: "Buy to Open", fills: [{ "fill-price": "600.5", quantity: "1", "filled-at": "2026-10-09T14:00:01Z" }] }] };
  {
    const tc = {}, { h, b } = mk("cert", [tokenRoute(tc), acctRoute, liveWith([prior]), searchWith([]), { method: "POST", path: "/accounts/5WT00001/orders", respond: { throw: "must not POST" } }]); await b.selectAccount();
    const p = await b.place(orderBody); eq("adopt: an order already carrying the identifier is adopted, no POST", [p.adopted, p.order.id, p.order.avgFill, h.calls.filter((c) => c.method === "POST" && /orders$/.test(c.path)).length], [true, "777", 600.5, 0]);
  }
  {
    let posted = false; const tc = {}, { h, b } = mk("cert", [tokenRoute(tc), acctRoute, liveWith(() => ({ body: { data: { items: posted ? [prior] : [] } } })), searchWith([]), { method: "POST", path: "/accounts/5WT00001/orders", respond: () => { posted = true; return { status: 500, raw: "upstream" }; } }]); await b.selectAccount();
    const p = await b.place(orderBody); eq("POST 500 but the order exists -> look-up adopts it, ONE POST", [p.adopted, p.afterError, h.calls.filter((c) => c.method === "POST" && /orders$/.test(c.path)).length], [true, 500, 1]);
  }
  {
    const tc = {}, routes = [tokenRoute(tc), acctRoute, liveWith([]), searchWith([]), { method: "POST", path: "/accounts/5WT00001/orders", respond: [{ status: 502, raw: "bad gateway" }, { status: 201, body: { data: { order: { id: 901, status: "Routed", "external-identifier": "pe-t-1", legs: [] } } } }] }];
    const { h, b } = mk("cert", routes); await b.selectAccount(); const p = await b.place(orderBody);
    const posts = h.calls.filter((c) => c.method === "POST" && /orders$/.test(c.path)), looks = h.calls.filter((c) => /orders\/live/.test(c.path)).length;
    eq("POST 502, look-up finds nothing -> resubmitted with the SAME identifier", [p.placed, posts.length, posts.map((c) => c.body["external-identifier"]), looks], [true, 2, ["pe-t-1", "pe-t-1"], 2]);
  }
  {
    const tc = {}, { h, b } = mk("cert", [tokenRoute(tc), acctRoute, liveWith([]), searchWith([]), { method: "POST", path: "/accounts/5WT00001/orders", respond: { status: 422, body: { error: { code: "validation_error", message: "Order validation failed", errors: [{ code: "insufficient_buying_power", message: "not enough" }] } } } }]); await b.selectAccount();
    const p = await b.place(orderBody); eq("POST 422 -> rejected, never retried, reason carried", [p.rejected, /insufficient_buying_power/.test(p.error), h.calls.filter((c) => c.method === "POST" && /orders$/.test(c.path)).length], [true, true, 1]);
  }
  {
    let posted = false; const tc = {}, { h, b } = mk("cert", [tokenRoute(tc), acctRoute, liveWith(() => (posted ? { status: 500, raw: "down" } : { body: { data: { items: [] } } })), searchWith([]), { method: "POST", path: "/accounts/5WT00001/orders", respond: () => { posted = true; return { throw: "socket hang up" }; } }]); await b.selectAccount();
    const p = await b.place(orderBody); eq("POST network error and the look-up fails -> UNCERTAIN, nothing resent", [p.uncertain === true, h.calls.filter((c) => c.method === "POST" && /orders$/.test(c.path)).length], [true, 1]);
  }
  {
    const tc = {}, { h, b } = mk("cert", [tokenRoute(tc), acctRoute, liveWith([]), searchWith([]), { method: "POST", path: "/accounts/5WT00001/orders", respond: [{ status: 429, raw: "" }, { status: 201, body: { data: { order: { id: 902, status: "Received", legs: [] } } } }] }]); await b.selectAccount();
    const p = await b.place(orderBody); eq("POST 429 -> look-up, then one resubmission", [p.placed, h.calls.filter((c) => c.method === "POST" && /orders$/.test(c.path)).length, h.calls.filter((c) => /orders\/live/.test(c.path)).length], [true, 2, 2]);
  }
  {
    const tc = {}, { h, b } = mk("cert", [tokenRoute(tc), acctRoute, liveWith(() => ({ status: 500, raw: "" })), searchWith([]), { method: "POST", path: "/accounts/5WT00001/orders", respond: { throw: "must not POST" } }]); await b.selectAccount();
    const p = await b.place(orderBody); eq("look-up BEFORE placing fails (500 after retries) -> uncertain, nothing sent", [p.uncertain === true, /nothing sent/.test(p.reason), h.calls.filter((c) => c.method === "POST" && /orders$/.test(c.path)).length], [true, true, 0]);
  }
  {
    const tc = {}, { h, b } = mk("cert", [tokenRoute(tc), acctRoute, liveWith([]), searchWith([]), { method: "POST", path: "/accounts/5WT00001/orders", respond: [{ status: 201, body: { data: { order: { status: "Received", legs: [] } } } }, { status: 201, body: { data: { order: { id: 903, status: "Received", legs: [] } } } }] }]); await b.selectAccount();
    const p = await b.place(orderBody); eq("201 without an order id -> look-up before any retry, then placed with an id", [p.placed === true, p.order && p.order.id, h.calls.filter((c) => /orders\/live/.test(c.path)).length, h.calls.filter((c) => c.method === "POST" && /orders$/.test(c.path)).length], [true, "903", 2, 2]);
  }
  {
    const tc = {}, { h, b } = mk("cert", [tokenRoute(tc), acctRoute, liveWith([]), searchWith([prior]), { method: "POST", path: "/accounts/5WT00001/orders", respond: { throw: "must not POST" } }]); await b.selectAccount();
    const p = await b.place(orderBody); eq("identifier found only on the orders search page (older order) -> adopted, no POST", [p.adopted === true, p.order && p.order.id, h.calls.filter((c) => c.method === "POST" && /orders$/.test(c.path)).length], [true, "777", 0]);
  }
  // ---- 6b. PRODUCTION order POST with an unknown outcome: wait 8 s, look up twice, then UNCERTAIN — never resent (review fix 2026-10-09)
  {
    const posts = (h) => h.calls.filter((c) => c.method === "POST" && /orders$/.test(c.path)).length, looks = (h) => h.calls.filter((c) => /orders\/live/.test(c.path)).length;
    { const tc = {}, { h, b } = mk("prod", [tokenRoute(tc), acctRoute, liveWith([]), searchWith([]), { method: "POST", path: "/accounts/5WT00001/orders", respond: [{ status: 502, raw: "bad gateway" }, { status: 201, body: { data: { order: { id: 901, status: "Routed", "external-identifier": "pe-t-1", legs: [] } } } }] }], { live: true, armFile: ARM });
      fs.writeFileSync(ARM, "armed (selftest)\n"); await b.selectAccount(); const s0 = b.stats.sleeps.length, p = await b.place(orderBody);
      eq("prod: POST 502, identifier not found in 2 look-ups 8 s apart -> UNCERTAIN, ONE POST, never resent", [p.uncertain === true, /NOT resent/.test(p.reason || ""), posts(h), looks(h), b.stats.sleeps.slice(s0).filter((x) => x === 8000).length], [true, true, 1, 3, 2]); }
    { let nLive = 0; const tc = {}, { h, b } = mk("prod", [tokenRoute(tc), acctRoute, liveWith(() => ({ body: { data: { items: ++nLive >= 3 ? [prior] : [] } } })), searchWith([]), { method: "POST", path: "/accounts/5WT00001/orders", respond: { throw: "socket hang up" } }], { live: true, armFile: ARM });
      await b.selectAccount(); const p = await b.place(orderBody);
      eq("prod: POST network error, the order is listed only on the 2nd look-up -> adopted, ONE POST", [p.adopted === true, p.afterError, p.lookups, p.order && p.order.id, posts(h)], [true, "network", 2, "777", 1]); }
    { const tc = {}, { h, b } = mk("prod", [tokenRoute(tc), acctRoute, liveWith([]), searchWith([]), { method: "POST", path: "/accounts/5WT00001/orders", respond: [{ status: 201, body: { data: { order: { status: "Received", legs: [] } } } }, { status: 201, body: { data: { order: { id: 903, status: "Received", legs: [] } } } }] }], { live: true, armFile: ARM });
      await b.selectAccount(); const p = await b.place(orderBody);
      eq("prod: 201 without an order id (outcome unknown) -> UNCERTAIN after 2 look-ups, ONE POST", [p.uncertain === true, posts(h), looks(h)], [true, 1, 3]); }
    { const tc = {}, { h, b } = mk("prod", [tokenRoute(tc), acctRoute, liveWith([]), searchWith([]), { method: "POST", path: "/accounts/5WT00001/orders", respond: [{ status: 429, raw: "" }, { status: 201, body: { data: { order: { id: 902, status: "Received", legs: [] } } } }] }], { live: true, armFile: ARM });
      await b.selectAccount(); const s0 = b.stats.sleeps.length, p = await b.place(orderBody);
      eq("prod: POST 429 (refused before processing) -> short back-off, look-up, one resubmission", [p.placed === true, posts(h), looks(h), b.stats.sleeps.slice(s0)], [true, 2, 2, [1000]]); }
    fs.unlinkSync(ARM);
  }
  { const tc = {}, { b } = mk("cert", [tokenRoute(tc), acctRoute, { method: "GET", path: /^\/market-data\/by-type/, respond: () => ({ body: { data: { items: [{ symbol: "QQQ", bid: "600.0", ask: "600.2", "updated-at": new Date(clock - 5000).toISOString(), "is-trading-halted": true }, { symbol: "SPY", bid: "660", ask: "660.1", "is-trading-halted": false }, { symbol: "EFA", bid: "101", ask: "101.1", updatedAt: new Date(clock - 1000).toISOString(), tradingHalted: true }] } } }) }]);
    const q = (await b.quotes({ equity: ["QQQ", "SPY", "EFA"] })).bySymbol;
    eq("quotes: dasherized keys (spec: 'JSON keys are dasherized') -> updated-at age 5 s and is-trading-halted read; camelCase still read; absent age -> null", [q.QQQ.ageMs, q.QQQ.halted, q.SPY.ageMs, q.SPY.halted, q.EFA.ageMs, q.EFA.halted], [5000, true, null, false, 1000, true]); }
  {
    const tc = {}, dr = { method: "POST", path: /dry-run$/, respond: { status: 201, body: { data: { order: { status: "Received", legs: [] }, errors: [{ code: "insufficient_buying_power", message: "x" }], "buying-power-effect": {}, "fee-calculation": {} } } } };
    const { b } = mk("prod", [tokenRoute(tc), acctRoute, dr]); await b.selectAccount(); const d = await b.dryRun(orderBody);
    eq("dry-run 201 carrying data.errors[] -> ok false, the code carried", [d.ok, d.errors[0] && d.errors[0].code], [false, "insufficient_buying_power"]);
  }
  { const { b } = mk("cert", [tokenRoute({})]);
    eq("summarize: Received/Routed/In Flight/Contingent/Live all count as working (cancellable)", ["Received", "Routed", "In Flight", "Contingent", "Live"].map((st) => b.summarize({ status: st }).working), [true, true, true, true, true]);
    eq("summarize: Filled/Cancelled/Rejected are terminal, not working", ["Filled", "Cancelled", "Rejected"].map((st) => [b.summarize({ status: st }).terminal, b.summarize({ status: st }).working]), [[true, false], [true, false], [true, false]]);
    eq("summarize: 'Filled' with no leg fills yet -> orderFilledQty = leg quantity, fillsPending", (() => { const s = b.summarize({ status: "Filled", size: "2", legs: [{ symbol: "/ZNZ6", quantity: "2", fills: [] }] }); return [s.filledQty, s.orderFilledQty, s.fillsPending]; })(), [0, 2, true]);
    eq("summarize: Cancelled, quantity 2 remaining-quantity 1, no fills -> orderFilledQty 1", (() => { const s = b.summarize({ status: "Cancelled", legs: [{ quantity: "2", "remaining-quantity": "1", fills: [] }] }); return [s.orderFilledQty, s.fillsPending]; })(), [1, true]); }
  { const tc = {}, { h, b } = mk("cert", [tokenRoute(tc), acctRoute, { method: "GET", path: /^\/market-data\/by-type/, respond: { body: { data: { items: [] } } } }]);
    await throwsCode("quotes: more than 100 symbols refused before the network (docs)", () => b.quotes({ equity: Array.from({ length: 101 }, (_, i) => `S${i}`) }), "VALIDATION", /100 symbols/);
    eq("quotes: exactly 100 symbols is one request", [(await b.quotes({ equity: Array.from({ length: 100 }, (_, i) => `S${i}`) })).available, h.calls.filter((c) => /market-data/.test(c.path)).length], [true, 1]); }

  // ---- 7. parsing: positions, balances, summaries, quotes, waitOrder, fees, instruments
  {
    const tc = {}, routes = [tokenRoute(tc), acctRoute,
      { method: "GET", path: "/accounts/5WT00001/positions", respond: { body: { data: { items: [{ symbol: "QQQ", "instrument-type": "Equity", quantity: "20", "quantity-direction": "Long", "close-price": "600.1" }, { symbol: "/ZNZ6", "instrument-type": "Future", quantity: "1", "quantity-direction": "Short", multiplier: 1000 }, { symbol: "SPY", quantity: "0", "quantity-direction": "Zero" }, { junk: true }, null] } } } },
      { method: "GET", path: "/accounts/5WT00001/balances", respond: { body: { data: { "net-liquidating-value": "25012.5", "cash-balance": "24000", "equity-buying-power": "48000", "pending-cash": "100", "pending-cash-effect": "Debit" } } } },
      { method: "GET", path: /^\/market-data\/by-type/, respond: [{ status: 502, raw: "<html>502</html>" }, { status: 502, raw: "<html>502</html>" }, { body: { data: { items: [{ symbol: "QQQ", bid: "600.0", ask: "600.2", updatedAt: new Date(clock).toISOString() }, { symbol: "BTC/USD", bid: "62000", ask: "62010", mid: "62005" }] } } }] },
      { method: "GET", path: "/accounts/5WT00001/orders/31", respond: [{ body: { data: { id: 31, status: "Routed", legs: [] } } }, { body: { data: { id: 31, status: "Filled", legs: [{ fills: [] }] } } }, { body: { data: { id: 31, status: "Filled", legs: [{ fills: [{ "fill-price": "10", quantity: "1", "filled-at": "t1" }, { "fill-price": "11", quantity: "3", "filled-at": "t2" }] }] } } }] },
      { method: "GET", path: /^\/accounts\/5WT00001\/transactions/, respond: { body: { data: { items: [{ "order-id": 31, commission: "1.00", "commission-effect": "Debit", "clearing-fees": "0.30", "regulatory-fees": "0.02", "proprietary-index-option-fees": "0" }, { "order-id": 99, commission: "5" }] } } } },
      { method: "GET", path: "/instruments/futures/%2FZNZ6", respond: { body: { data: { symbol: "/ZNZ6", "product-code": "ZN", active: true, "is-tradeable": true, "is-closing-only": false, "tick-size": "0.015625", "notional-multiplier": "1000.0", "first-notice-date": "2026-11-30", "streamer-symbol": "/ZNZ26:XCBT" } } } },
      { method: "GET", path: "/instruments/cryptocurrencies/BTC%2FUSD", respond: { body: { data: { symbol: "BTC/USD", active: true, "tick-size": "0.01", "destination-venue-symbols": [{ "max-quantity-precision": 8, "max-price-precision": 2, routable: true }] } } } },
      { method: "GET", path: /^\/instruments\/futures\?product-code/, respond: { body: { data: { items: [{ symbol: "/ZNH7", active: true, "is-tradeable": true, "expiration-date": "2027-03-19" }, { symbol: "/ZNZ6", active: true, "is-tradeable": true, "active-month": true, "expiration-date": "2026-12-19" }, { symbol: "/ZNU6", active: false, "expiration-date": "2026-09-19" }] } } } }];
    const { h, b } = mk("cert", routes); await b.selectAccount();
    eq("positions: Short is negative, zero/junk rows dropped", (await b.positions()).map((p) => [p.symbol, p.qty]), [["QQQ", 20], ["/ZNZ6", -1]]);
    const bl = await b.balances(); eq("balances parsed (strings -> numbers, pending-cash Debit negative, absent -> null)", [bl.nlv, bl.cash, bl.equityBuyingPower, bl.pendingCash, bl.cryptoBuyingPower], [25012.5, 24000, 48000, -100, null]);
    const q1 = await b.quotes({ equity: ["QQQ"], cryptocurrency: ["BTC/USD"] }); eq("quotes: 502 twice (one retry only) -> available:false with the status (sandbox / unfunded)", [q1.available, q1.httpStatus], [false, 502]);
    const q2 = await b.quotes({ equity: ["QQQ"], cryptocurrency: ["BTC/USD"] }); eq("quotes: bid/ask/mid parsed; mid computed when absent", [q2.bySymbol.QQQ.mid, q2.bySymbol["BTC/USD"].mid, q2.bySymbol.QQQ.ageMs >= 0], [600.1, 62005, true]);
    eq("quotes: symbols with '/' URL-encoded in the query", h.calls.filter((c) => /market-data/.test(c.path)).pop().search, "?equity=QQQ&cryptocurrency=BTC%2FUSD");
    const w = await b.waitOrder(31, { until: ["Filled"], timeoutMs: 60000, pollMs: 2000 }); eq("waitOrder: Filled re-read until leg fills arrive; partial fills averaged", [w.order.status, w.order.filledQty, w.order.avgFill, w.order.lastFillAt], ["Filled", 4, 10.75, "t2"]);
    eq("fees: only this order's transaction rows summed", await b.fees([31], "2026-10-09"), { available: true, rows: 1, commission: 1, clearing: 0.3, regulatory: 0.02, proprietary: 0, other: 0, estimated: false, total: 1.32 });
    const f = await b.future("/ZNZ6"); eq("future instrument parsed", [f.symbol, f.productCode, f.tick, f.multiplier, f.firstNotice, f.tradeable], ["/ZNZ6", "ZN", 0.015625, 1000, "2026-11-30", true]);
    eq("activeFuture: the active-month tradeable contract", (await b.activeFuture("ZN")).symbol, "/ZNZ6");
    const c = await b.crypto("BTC/USD"); eq("crypto instrument parsed (precision from the routable venue)", [c.symbol, c.tick, c.qtyDecimals], ["BTC/USD", 0.01, 8]);
  }
  {
    const tc = {}, { b } = mk("cert", [tokenRoute(tc), acctRoute, { method: "GET", path: "/accounts/5WT00001/positions", respond: { raw: "not json at all" } }, { method: "GET", path: "/accounts/5WT00001/balances", respond: { body: { data: null } } }]); await b.selectAccount();
    eq("defensive: a 200 with a non-JSON body -> empty positions, not a crash", await b.positions(), []);
    eq("defensive: data:null balances -> nulls", (await b.balances()).nlv, null);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails.length ? `SELFTEST FAILED (${fails.length} of ${n})` : `SELFTEST PASS (${n} checks)`);
  return fails.length ? 1 : 0;
}

async function cli() {
  const argv = process.argv, envName = (() => { const i = argv.indexOf("--env"); return i > 0 ? argv[i + 1] : "prod"; })();
  if (argv.includes("--selftest")) return selftest();
  if (argv.includes("--accounts")) {
    require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
    const b = createBroker({ env: envName }), list = await b.accounts();
    console.log(`tastytrade ${envName} (${b.host}) — ${list.length} account(s); pinned ${PREFIX[envName]}ACCOUNT_NUMBER: ${b.pinned() ? "…" + b.pinned().slice(-4) : "NOT SET"}`);
    for (const a of list) console.log(`  ${a.accountNumber}  ${a.accountType || "?"} · ${a.marginOrCash || "?"}${a.nickname ? " · " + a.nickname : ""}${a.isClosed ? " · CLOSED" : ""}`);
    return 0;
  }
  console.log("usage: node backend/lib/tasty-broker.js --selftest | --accounts [--env prod|cert]"); return 2;
}

module.exports = { createBroker, credsFromEnv, hostCheck, buildEquityOrder, buildFutureOrder, buildFutureStop, buildCryptoOrder, validateOrder, isArmed, armedText, onTick, fmtNum, floorDp, fakeHttp, BrokerError, HOSTS, PREFIX, TERMINAL, WORKING, RESTING, UA };
if (require.main === module) cli().then((code) => { process.exitCode = code; }, (e) => { console.error(`tasty-broker FAILED: ${e.code ? e.code + " " : ""}${e.message}`); process.exitCode = 1; });
