"use strict";
/**
 * BOOK OPTIONS GUARD — the only way the board's options mirror (backend/alpaca-options-mirror.js) may reach Alpaca, from 2026-10-16.
 *
 * The options mirror moves from the main paper account to the BOOK paper account (operator, 2026-10-16). This guard makes that the
 * ONLY thing it can do. It can only ever trade the BOOK paper account, and only options:
 *
 *   KEYS        only the BOOK env names, ALPACA_BOOK_KEY_ID / ALPACA_BOOK_SECRET_KEY. There is no fallback to the main account's
 *               names (ALPACA_KEY_ID / ALPACA_SECRET_KEY) or the TV account's; a BOOK key id equal to either of those refuses.
 *   ACCOUNT     ALPACA_BOOK_ACCOUNT_NUMBER names the BOOK account. Before EVERY call that can change anything, the guard asks the
 *               broker GET /v2/account and refuses unless account_number equals it and is a paper account ("PA..."). An error on
 *               that read refuses (fail closed).
 *   HOST        https://paper-api.alpaca.markets only.
 *   WRITES      POST /v2/orders: a single-leg option (OCC symbol, no legs) or an mleg order whose every leg is an OCC symbol; whole
 *               contracts; no notional; no bracket / oco / oto. Anything else, a stock or ETF order included, refuses.
 *               DELETE / PATCH /v2/orders/{id}: only after GET /v2/orders/{id} shows an option order (the BOOK account also holds
 *               Plan E's ETF orders; the mirror may never cancel or replace them). A PATCH may not carry symbol, side, legs or notional.
 *               DELETE /v2/positions/{OCC}, POST /v2/positions/{OCC}/exercise and /do-not-exercise: option symbols only.
 *               Every other write refuses, DELETE /v2/orders (cancel all) and DELETE /v2/positions (close all) among them.
 *   READS       GET on /v2/... passes (the mirror reads its orders, positions and the calendar). Reads never change anything.
 *
 * Key VALUES are never printed, logged or put in an error. The guard sends nothing itself until request() is called; fetchImpl is
 * injected so the selftest runs on a fake broker with no network.
 */
const PAPER_BASE = "https://paper-api.alpaca.markets";
const ENV = { keyId: "ALPACA_BOOK_KEY_ID", secret: "ALPACA_BOOK_SECRET_KEY", account: "ALPACA_BOOK_ACCOUNT_NUMBER" };
const OTHER_KEY_NAMES = ["ALPACA_KEY_ID", "ALPACA_TV_KEY_ID"];

class GuardRefusal extends Error {
  constructor(code, why) { super(`BOOK options guard refused (${code}): ${why}`); this.name = "GuardRefusal"; this.code = code; this.refused = true; }
}
const refuse = (code, why) => { throw new GuardRefusal(code, why); };

/** An OCC option symbol: root (1-6, letter first), YYMMDD (a real calendar date), C or P, strike x1000 in 8 digits. */
function isOccSymbol(s) {
  const m = /^([A-Z][A-Z0-9]{0,5})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(s || ""));
  if (!m) return false;
  const y = 2000 + +m[2], mo = +m[3], d = +m[4], dt = new Date(Date.UTC(y, mo - 1, d));
  return mo >= 1 && mo <= 12 && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && +m[6] > 0;
}
const isWholeQty = (q) => { const n = typeof q === "string" && /^\d+$/.test(q.trim()) ? +q : q; return typeof n === "number" && Number.isInteger(n) && n > 0; };
const isPlainObject = (o) => !!o && typeof o === "object" && !Array.isArray(o);

/** checkOptionOrder(body) -> null when it is an option order this guard allows, else the reason (a string). */
function checkOptionOrder(body) {
  if (!isPlainObject(body)) return "the order body is not an object";
  if (body.notional !== undefined && body.notional !== null) return "a notional order is not an option order";
  if (!isWholeQty(body.qty)) return `qty ${JSON.stringify(body.qty)} is not a whole number of contracts`;
  const cls = body.order_class === undefined || body.order_class === "" ? "simple" : body.order_class;
  if (cls === "mleg") {
    if (body.symbol !== undefined && body.symbol !== null && body.symbol !== "") return "an mleg order carries no top-level symbol";
    if (!Array.isArray(body.legs) || body.legs.length < 1 || body.legs.length > 4) return "an mleg order needs 1 to 4 legs";
    const bad = body.legs.filter((l) => !isPlainObject(l) || !isOccSymbol(l.symbol));
    if (bad.length) return `leg symbol(s) not an option: ${bad.map((l) => JSON.stringify(l && l.symbol)).join(", ")}`;
    return null;
  }
  if (cls !== "simple") return `order_class ${JSON.stringify(body.order_class)} is not allowed (simple or mleg only)`;
  if (body.legs !== undefined) return "a single-leg order carries no legs";
  if (!isOccSymbol(body.symbol)) return `symbol ${JSON.stringify(body.symbol)} is not an option (OCC) symbol`;
  return null;
}

/** isOptionOrderRecord(order) -> true when a broker order record is an option order (single-leg or mleg). */
function isOptionOrderRecord(o) {
  if (!isPlainObject(o)) return false;
  if (o.asset_class !== undefined && o.asset_class !== "us_option" && o.order_class !== "mleg") return false;
  if (o.order_class === "mleg") return Array.isArray(o.legs) && o.legs.length > 0 && o.legs.every((l) => isPlainObject(l) && isOccSymbol(l.symbol) && (l.asset_class === undefined || l.asset_class === "us_option"));
  return isOccSymbol(o.symbol);
}

function makeBookOptionsGuard({ env = process.env, fetchImpl = globalThis.fetch, base = PAPER_BASE, timeoutMs = 20000 } = {}) {
  if (base !== PAPER_BASE) refuse("HOST", `base ${JSON.stringify(base)} is not the Alpaca paper endpoint`);
  const keyId = String(env[ENV.keyId] || "").trim(), secret = String(env[ENV.secret] || "").trim(), want = String(env[ENV.account] || "").trim();
  if (!keyId || !secret) refuse("NO_KEYS", `${ENV.keyId} / ${ENV.secret} not set — no fallback to any other account`);
  if (!want) refuse("NOT_PINNED", `${ENV.account} not set — the BOOK account cannot be confirmed`);
  if (!/^PA/.test(want)) refuse("NOT_PAPER", `${ENV.account} does not name a paper account`);
  for (const n of OTHER_KEY_NAMES) if (env[n] && String(env[n]).trim() === keyId) refuse("SHARED_KEYS", `${ENV.keyId} holds the same key id as ${n} — that is not the BOOK account`);
  if (typeof fetchImpl !== "function") refuse("NO_FETCH", "no fetch implementation");
  const headers = { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret, "content-type": "application/json" };

  const raw = async (method, p, body) => {
    const init = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) init.signal = AbortSignal.timeout(timeoutMs);
    const r = await fetchImpl(base + p, init);
    const t = await r.text();
    if (!r.ok) { const e = new Error(`${method} ${p.split("?")[0]} -> ${r.status} ${String(t).slice(0, 160)}`); e.status = r.status; throw e; }
    return t ? JSON.parse(t) : {};
  };

  /** GET /v2/account and refuse unless it is the BOOK paper account. Fails closed. */
  async function verifyAccount() {
    let a;
    try { a = await raw("GET", "/v2/account"); } catch (e) { refuse("ACCOUNT_UNREAD", `GET /v2/account failed (${String(e.message).slice(0, 120)}) — refusing`); }
    const got = String((a && a.account_number) || "").trim();
    if (!/^PA/.test(got)) refuse("NOT_PAPER", "the broker reports an account that is not a paper account");
    if (got !== want) refuse("WRONG_ACCOUNT", `the broker reports account …${got.slice(-4)}, not the BOOK account …${want.slice(-4)}`);
    return { accountNumberTail: got.slice(-4) };
  }

  const seg = (p) => p.split("?")[0].split("/").filter(Boolean);           // "/v2/orders/abc" -> ["v2","orders","abc"]
  const optionOrderById = async (id) => {
    let o; try { o = await raw("GET", `/v2/orders/${encodeURIComponent(id)}`); } catch (e) { refuse("ORDER_UNREAD", `GET /v2/orders/${id} failed (${String(e.message).slice(0, 120)})`); }
    if (!isOptionOrderRecord(o)) refuse("NOT_OPTION", `order ${id} is not an option order (${(o && (o.symbol || o.order_class)) || "?"}) — the mirror never touches it`);
    return o;
  };

  /** request(method, path, body) — the mirror's single door to the broker. */
  async function request(method, p, body) {
    const M = String(method || "").toUpperCase();
    if (typeof p !== "string" || !p.startsWith("/v2/") || /\.\.|\/\//.test(p) || /[\s#]/.test(p)) refuse("PATH", `path ${JSON.stringify(p)} is not allowed`);
    const s = seg(p);
    if (M === "GET") { if (body !== undefined) refuse("PATH", "a GET carries no body"); return raw("GET", p); }
    await verifyAccount();
    const sym = s[2] !== undefined ? decodeURIComponent(s[2]) : undefined;
    if (M === "POST" && s.length === 2 && s[1] === "orders") {
      const why = checkOptionOrder(body); if (why) refuse("NOT_OPTION", why);
      return raw("POST", p.split("?")[0], body);
    }
    if ((M === "DELETE" || M === "PATCH") && s.length === 3 && s[1] === "orders") {
      if (M === "DELETE" && body !== undefined) refuse("PATH", "a cancel carries no body");
      if (M === "PATCH") {
        if (!isPlainObject(body)) refuse("PATH", "a replace needs a body");
        const bad = ["symbol", "side", "legs", "notional", "order_class"].filter((k) => k in body); if (bad.length) refuse("NOT_OPTION", `a replace may not change ${bad.join(", ")}`);
        if (body.qty !== undefined && !isWholeQty(body.qty)) refuse("NOT_OPTION", "a replace qty must be whole contracts");
      }
      await optionOrderById(sym);
      return raw(M, p.split("?")[0], body);
    }
    if (M === "DELETE" && s.length === 3 && s[1] === "positions") {
      if (!isOccSymbol(sym)) refuse("NOT_OPTION", `position ${JSON.stringify(sym)} is not an option`);
      if (/[?&](percentage)=/.test(p)) refuse("PATH", "a partial close by percentage is not allowed");
      return raw("DELETE", p, undefined);
    }
    if (M === "POST" && s.length === 4 && s[1] === "positions" && (s[3] === "exercise" || s[3] === "do-not-exercise")) {
      if (!isOccSymbol(sym)) refuse("NOT_OPTION", `position ${JSON.stringify(sym)} is not an option`);
      return raw("POST", p.split("?")[0], undefined);
    }
    refuse("PATH", `${M} ${p.split("?")[0]} is not an options-mirror call`);
  }

  return { request, verifyAccount, describe: () => ({ account: "BOOK (paper)", envNames: { ...ENV }, base }) };
}

module.exports = { makeBookOptionsGuard, checkOptionOrder, isOptionOrderRecord, isOccSymbol, GuardRefusal, ENV, PAPER_BASE };
