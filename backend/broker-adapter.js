#!/usr/bin/env node
/**
 * TRAIDS — BROKER ADAPTER (2026-07-25)
 *
 * One interface, two brokers. The execution engine talks to this and never learns which
 * venue is underneath — except for one property it MUST know: whether the account holds
 * real money.
 *
 * THE CENTRAL SAFETY IDEA. The engine's original paper-lock asserted "the account number
 * starts with PA". That is a fine lock for Alpaca and a useless one for Schwab, and the
 * tempting move — relax the assertion so Schwab passes — would delete the protection
 * entirely. So the lock is inverted instead: every adapter DECLARES `live: true|false`, and
 * the engine applies strictly more gates to a live adapter than a paper one. Adding a broker
 * can never weaken the engine, because a new adapter can only ever declare itself live and
 * thereby earn MORE scrutiny.
 *
 * WHAT EACH ADAPTER PROVIDES
 *   describe()            → { name, live, venue }
 *   account()             → { id, equity, buyingPower, currency }
 *   positions()           → [{ symbol, qty, avgPrice, marketValue }]
 *   orders(status)        → [{ id, symbol, side, qty, status, submittedAt }]
 *   quote(symbol)         → { price, ts }           ts = the print's own timestamp, not now()
 *   submit(order)         → { id, status }          may refuse; never silently succeeds
 *
 * SCHWAB IS REAL MONEY. Its `submit` is fully implemented and REFUSES BY DEFAULT. Transmission
 * requires TRAIDS_SCHWAB_ARMED=1 in the environment — deliberately a different variable from
 * the engine's own TRAIDS_EXEC_ARMED, so that arming paper trading can never, by itself, arm
 * live trading. Both must be set, independently and on purpose.
 *
 * I did not arm it and will not run it armed. Wiring real money to an automated order path is
 * a decision for the account holder, made explicitly, with a strategy that has cleared
 * validation. Today nothing has.
 *
 * Usage
 *   node backend/broker-adapter.js --check              structural self-check, both adapters
 *   node backend/broker-adapter.js --status schwab      account + positions (READ ONLY)
 *   node backend/broker-adapter.js --status alpaca
 */
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const fs = require("fs"), path = require("path");

const TOKEN_CACHE = path.join(__dirname, "data", ".schwab-token.json");

// ════════════════════════════════════════════════════════════════════════════
// ALPACA — PAPER. The only broker host here is the paper host, by construction.
// ════════════════════════════════════════════════════════════════════════════
const ALPACA_PAPER_BASE = "https://paper-api.alpaca.markets";
const ALPACA_DATA_BASE = "https://data.alpaca.markets";

async function alpacaApi(base, p, opts = {}) {
  const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY;
  if (!KEY || !SEC) throw new Error("Alpaca credentials absent");
  const r = await fetch(base + p, {
    ...opts,
    headers: { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, "content-type": "application/json", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : {};
}

const alpacaPaper = {
  describe: () => ({ name: "alpaca-paper", live: false, venue: "Alpaca (paper)" }),
  async account() {
    const a = await alpacaApi(ALPACA_PAPER_BASE, "/v2/account");
    // The paper assertion still belongs here — it is Alpaca-specific, which is exactly why it
    // lives in the Alpaca adapter rather than in the engine.
    if (!String(a.account_number || "").startsWith("PA")) throw new Error(`Alpaca account ${a.account_number} is not a paper account`);
    return { id: a.account_number, equity: +a.equity, buyingPower: +a.buying_power, currency: a.currency || "USD" };
  },
  async positions() {
    return (await alpacaApi(ALPACA_PAPER_BASE, "/v2/positions")).map(p => ({
      symbol: p.symbol, qty: +p.qty, avgPrice: +p.avg_entry_price, marketValue: +p.market_value }));
  },
  async orders(status = "open") {
    return (await alpacaApi(ALPACA_PAPER_BASE, `/v2/orders?status=${status}&limit=100&direction=desc`)).map(o => ({
      id: o.id, symbol: o.symbol, side: o.side, qty: +o.qty, status: o.status, submittedAt: o.submitted_at }));
  },
  async quote(symbol) {
    const q = await alpacaApi(ALPACA_DATA_BASE, `/v2/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=${process.env.ALPACA_FEED || "iex"}`);
    return { price: q?.trade?.p ?? null, ts: q?.trade?.t ? Date.parse(q.trade.t) : null };
  },
  async submit(order) {
    const res = await alpacaApi(ALPACA_PAPER_BASE, "/v2/orders", { method: "POST", body: JSON.stringify(order) });
    return { id: res.id, status: res.status };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// SCHWAB — LIVE MONEY. Read paths work; the write path refuses unless armed.
// ════════════════════════════════════════════════════════════════════════════
const SCHWAB_BASE = "https://api.schwabapi.com";
const SCHWAB_ARMED = process.env.TRAIDS_SCHWAB_ARMED === "1";

/**
 * Access tokens live ~30 minutes; the refresh token ~7 days. Cached to disk so a run does not
 * burn a refresh on every call, and re-fetched a minute before expiry rather than after — an
 * expiry race in an order path is exactly the kind of failure that partially submits.
 */
async function schwabToken() {
  const KEY = process.env.SCHWAB_APP_KEY, SEC = process.env.SCHWAB_APP_SECRET;
  const RT = process.env.SCHWAB_REFRESH_TOKEN;
  if (!KEY || !SEC) throw new Error("SCHWAB_APP_KEY / SCHWAB_APP_SECRET absent from backend/.env");
  if (!RT || /^your_/.test(RT)) throw new Error("SCHWAB_REFRESH_TOKEN not set — run: node backend/schwab-auth.js  (the refresh token expires weekly)");
  try {
    const c = JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8"));
    if (c.access && c.expires > Date.now() + 60000) return c.access;
  } catch { /* no cache yet */ }
  const r = await fetch(`${SCHWAB_BASE}/v1/oauth/token`, {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${KEY}:${SEC}`).toString("base64"),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: RT }),
    signal: AbortSignal.timeout(20000),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Schwab token refresh failed ${r.status} — ${t.slice(0, 140)}${r.status === 400 ? " (the weekly refresh token has most likely expired; re-run backend/schwab-auth.js)" : ""}`);
  const j = JSON.parse(t);
  try {
    fs.writeFileSync(TOKEN_CACHE, JSON.stringify({ access: j.access_token, expires: Date.now() + (j.expires_in || 1800) * 1000 }));
    fs.chmodSync(TOKEN_CACHE, 0o600);        // the token is a bearer credential; keep it off other users
  } catch { /* cache is an optimisation, not a requirement */ }
  return j.access_token;
}

async function schwabApi(p, opts = {}) {
  const tok = await schwabToken();
  const r = await fetch(SCHWAB_BASE + p, {
    ...opts,
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : {};
}

let _acctHash = null;
async function schwabAccountHash() {
  if (_acctHash) return _acctHash;
  const nums = await schwabApi("/trader/v1/accounts/accountNumbers");
  if (!Array.isArray(nums) || !nums.length) throw new Error("Schwab returned no accounts");
  _acctHash = nums[0].hashValue;
  return _acctHash;
}

const schwabLive = {
  describe: () => ({ name: "schwab-live", live: true, venue: "Charles Schwab (LIVE — real money)" }),
  async account() {
    const h = await schwabAccountHash();
    const a = await schwabApi(`/trader/v1/accounts/${h}?fields=positions`);
    const sa = a?.securitiesAccount || {};
    const bal = sa.currentBalances || {};
    return {
      id: `***${String(sa.accountNumber || "").slice(-4)}`,          // never log a full account number
      equity: +(bal.liquidationValue ?? bal.equity ?? 0),
      buyingPower: +(bal.buyingPower ?? bal.cashAvailableForTrading ?? 0),
      currency: "USD",
      type: sa.type, hash: h,
    };
  },
  async positions() {
    const h = await schwabAccountHash();
    const a = await schwabApi(`/trader/v1/accounts/${h}?fields=positions`);
    return (a?.securitiesAccount?.positions || []).map(p => ({
      symbol: p.instrument?.symbol,
      qty: (+p.longQuantity || 0) - (+p.shortQuantity || 0),
      avgPrice: +p.averagePrice || null,
      marketValue: +p.marketValue || null,
    }));
  },
  async orders(status = "open") {
    const h = await schwabAccountHash();
    const to = new Date(), from = new Date(Date.now() - 7 * 864e5);
    const iso = (d) => d.toISOString().slice(0, 23) + "Z";
    const q = `fromEnteredTime=${encodeURIComponent(iso(from))}&toEnteredTime=${encodeURIComponent(iso(to))}`;
    const o = await schwabApi(`/trader/v1/accounts/${h}/orders?${q}`);
    return (Array.isArray(o) ? o : []).map(x => ({
      id: x.orderId, symbol: x.orderLegCollection?.[0]?.instrument?.symbol,
      side: x.orderLegCollection?.[0]?.instruction, qty: +x.quantity,
      status: x.status, submittedAt: x.enteredTime,
    })).filter(x => status === "all" || /WORKING|PENDING|QUEUED|ACCEPTED/i.test(x.status || ""));
  },
  async quote(symbol) {
    const q = await schwabApi(`/marketdata/v1/${encodeURIComponent(symbol)}/quotes`);
    const d = q?.[symbol]?.quote || {};
    const px = d.lastPrice ?? d.mark ?? null;
    // Schwab timestamps are epoch millis on the quote itself — used as-is rather than stamping
    // now(), because the whole point of the freshness gate is the PRINT's age.
    return { price: Number.isFinite(px) ? px : null, ts: d.quoteTime ?? d.tradeTime ?? null };
  },

  /**
   * OPTION CHAIN — with implied volatility and greeks per contract.
   *
   * This is quietly the most valuable thing the Schwab connection provides, and it is a DATA
   * capability rather than an execution one. Option chains are the gating item for the
   * variance-risk-premium test (registry task #42, "when chain data exists") and the reason
   * the paid-data decision (task #39, ~$50–230/mo) has been sitting open. A funded Schwab
   * account carries entitled real-time chains, so that spend may be unnecessary.
   *
   * IMPORTANT LIMIT, stated so nobody plans a backtest around it: this returns the CURRENT
   * chain, not a history of chains. VRP cannot be backtested from here. What it enables is
   * forward COLLECTION — snapshot daily, and the history accrues from the first snapshot on.
   * That is slower, and it is also the only honest option: historical chain data at a price
   * worth paying does not really exist for retail, and today's results argue the forward path
   * is where the untested information lives anyway.
   */
  async chain(symbol, { fromDate, toDate, strikeCount = 20, contractType = "ALL" } = {}) {
    const p = new URLSearchParams({ symbol, contractType, strikeCount: String(strikeCount), includeUnderlyingQuote: "true" });
    if (fromDate) p.set("fromDate", fromDate);
    if (toDate) p.set("toDate", toDate);
    const c = await schwabApi(`/marketdata/v1/chains?${p}`);
    const out = [];
    for (const side of ["callExpDateMap", "putExpDateMap"]) {
      for (const [exp, strikes] of Object.entries(c[side] || {})) {
        for (const [strike, arr] of Object.entries(strikes)) {
          for (const o of arr) out.push({
            symbol: o.symbol, type: side.startsWith("call") ? "CALL" : "PUT",
            expiration: exp.split(":")[0], dte: +(exp.split(":")[1] ?? NaN), strike: +strike,
            bid: o.bid, ask: o.ask, mark: o.mark, last: o.last,
            iv: o.volatility, delta: o.delta, gamma: o.gamma, theta: o.theta, vega: o.vega,
            openInterest: o.openInterest, volume: o.totalVolume,
          });
        }
      }
    }
    return { underlying: c.underlyingPrice ?? c.underlying?.last ?? null, count: out.length, contracts: out };
  },

  /**
   * Daily bars. Schwab's own history, useful as an independent cross-check against the
   * existing feed — a second source is how a silent revision or a bad print gets caught.
   */
  async history(symbol, { years = 2, frequency = "daily" } = {}) {
    const p = new URLSearchParams({ symbol, periodType: "year", period: String(years), frequencyType: frequency, frequency: "1", needExtendedHoursData: "false" });
    const h = await schwabApi(`/marketdata/v1/pricehistory?${p}`);
    return (h.candles || []).map(c => ({ date: new Date(c.datetime).toISOString().slice(0, 10), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
  },

  /**
   * Build the Schwab order payload. Separated from transmission so the exact JSON that WOULD
   * be sent can be inspected, diffed and reviewed without any possibility of it going out.
   */
  buildOrder(order) {
    const side = order.side === "buy" ? "BUY" : "SELL";
    const base = {
      orderType: order.type === "limit" ? "LIMIT" : "MARKET",
      session: "NORMAL", duration: "DAY", orderStrategyType: "SINGLE",
      ...(order.type === "limit" ? { price: String(order.limit_price) } : {}),
      orderLegCollection: [{
        instruction: side, quantity: Number(order.qty),
        instrument: { symbol: order.symbol, assetType: "EQUITY" },
      }],
    };
    if (!order.stop_loss && !order.take_profit) return base;
    // Bracket = a one-triggers-one-cancels-other. Schwab expects the exits as children.
    const children = [];
    if (order.take_profit) children.push({
      orderType: "LIMIT", session: "NORMAL", duration: "GOOD_TILL_CANCEL", orderStrategyType: "SINGLE",
      price: String(order.take_profit.limit_price),
      orderLegCollection: [{ instruction: side === "BUY" ? "SELL" : "BUY", quantity: Number(order.qty), instrument: { symbol: order.symbol, assetType: "EQUITY" } }],
    });
    if (order.stop_loss) children.push({
      orderType: "STOP", session: "NORMAL", duration: "GOOD_TILL_CANCEL", orderStrategyType: "SINGLE",
      stopPrice: String(order.stop_loss.stop_price),
      orderLegCollection: [{ instruction: side === "BUY" ? "SELL" : "BUY", quantity: Number(order.qty), instrument: { symbol: order.symbol, assetType: "EQUITY" } }],
    });
    return { ...base, orderStrategyType: "TRIGGER", childOrderStrategies: children };
  },

  async submit(order) {
    const payload = this.buildOrder(order);
    if (!SCHWAB_ARMED) {
      const e = new Error(
        "REFUSED — Schwab is a LIVE-MONEY account and TRAIDS_SCHWAB_ARMED is not set. " +
        "This is a separate variable from TRAIDS_EXEC_ARMED on purpose: arming paper trading " +
        "must never, by itself, arm real money. The order payload was built and can be inspected, " +
        "but nothing was transmitted."
      );
      e.payload = payload; e.refused = true;
      throw e;
    }
    const h = await schwabAccountHash();
    const tok = await schwabToken();
    const r = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/${h}/orders`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`Schwab rejected the order ${r.status} — ${(await r.text()).slice(0, 200)}`);
    // Schwab returns the new order id in the Location header rather than a body.
    const id = (r.headers.get("location") || "").split("/").pop() || null;
    return { id, status: "SUBMITTED" };
  },
};

// ════════════════════════════════════════════════════════════════════════════
const ADAPTERS = { alpaca: alpacaPaper, "alpaca-paper": alpacaPaper, schwab: schwabLive, "schwab-live": schwabLive };
function getAdapter(name = "alpaca") {
  const a = ADAPTERS[String(name).toLowerCase()];
  if (!a) throw new Error(`unknown broker "${name}" — known: ${Object.keys(ADAPTERS).join(", ")}`);
  return a;
}
module.exports = { getAdapter, alpacaPaper, schwabLive, ADAPTERS };

// ════════════════════════════════════════════════════════════════════════════
if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  const argOf = (k) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : null; };

  if (args.includes("--check")) {
    console.log(`\n  TRAIDS — BROKER ADAPTER SELF-CHECK\n`);
    const IFACE = ["describe", "account", "positions", "orders", "quote", "submit"];
    let fail = 0;
    for (const [key, a] of [["alpaca-paper", alpacaPaper], ["schwab-live", schwabLive]]) {
      const missing = IFACE.filter(m => typeof a[m] !== "function");
      const d = a.describe();
      console.log(`  ${missing.length ? "✗" : "✓"} ${key.padEnd(14)} live=${String(d.live).padEnd(5)} ${d.venue}${missing.length ? ` — MISSING ${missing.join(", ")}` : ""}`);
      if (missing.length) fail++;
    }
    // The live adapter must refuse to transmit while unarmed. Assert it, do not assume it.
    let refused = false, built = null;
    try { await schwabLive.submit({ symbol: "AAPL", qty: 1, side: "buy", type: "market" }); }
    catch (e) { refused = !!e.refused; built = e.payload; }
    console.log(`  ${refused ? "✓" : "✗"} schwab submit REFUSES while unarmed (TRAIDS_SCHWAB_ARMED=${process.env.TRAIDS_SCHWAB_ARMED || "unset"})`);
    if (!refused) fail++;
    if (built) console.log(`     payload it would have built: ${JSON.stringify(built).slice(0, 120)}…`);

    // A bracket must produce a stop AND a target child, or a live stop could silently not exist.
    const br = schwabLive.buildOrder({ symbol: "AAPL", qty: 10, side: "buy", type: "market",
      stop_loss: { stop_price: 180 }, take_profit: { limit_price: 220 } });
    const kids = br.childOrderStrategies || [];
    const hasStop = kids.some(k => k.orderType === "STOP" && k.stopPrice === "180");
    const hasTgt = kids.some(k => k.orderType === "LIMIT" && k.price === "220");
    const exitSide = kids.every(k => k.orderLegCollection[0].instruction === "SELL");
    console.log(`  ${hasStop && hasTgt && exitSide ? "✓" : "✗"} bracket builds a STOP@180 and LIMIT@220, both exiting the long (${kids.length} child legs)`);
    if (!(hasStop && hasTgt && exitSide)) fail++;

    const authed = !!process.env.SCHWAB_REFRESH_TOKEN && !/^your_/.test(process.env.SCHWAB_REFRESH_TOKEN);
    console.log(`  ${authed ? "✓" : "○"} Schwab OAuth ${authed ? "refresh token present" : "NOT COMPLETED — run: node backend/schwab-auth.js (weekly)"}`);
    console.log(`\n  ${fail ? `✗ ${fail} structural check(s) failed` : "✓ interface parity, live-refusal and bracket construction all verified"}`);
    console.log(`  ${authed ? "" : "  (read paths untested against Schwab until OAuth is completed — nothing here has contacted a live account)"}\n`);
    process.exit(fail ? 1 : 0);
  }

  const name = argOf("--status") || "alpaca";
  const a = getAdapter(name);
  const d = a.describe();
  console.log(`\n  ${d.venue}${d.live ? "   ⚠ REAL MONEY — read-only here" : ""}\n`);
  try {
    const acct = await a.account();
    console.log(`  account ${acct.id} · equity ${acct.equity.toLocaleString()} · buying power ${acct.buyingPower.toLocaleString()}`);
    const pos = await a.positions();
    console.log(`  ${pos.length} position(s)${pos.length ? ": " + pos.slice(0, 8).map(p => `${p.symbol} ${p.qty}`).join(", ") : ""}`);
    const ord = await a.orders();
    console.log(`  ${ord.length} working order(s)`);
  } catch (e) { console.log(`  ✗ ${e.message}`); }
  console.log("");
})();
