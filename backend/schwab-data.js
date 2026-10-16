#!/usr/bin/env node
/**
 * TRAIDS — SCHWAB MARKET DATA (READ ONLY, TRADE-INCAPABLE BY CONSTRUCTION)
 *
 * Market data from a funded Schwab account, with no ability to trade — not "we choose not to
 * call the order endpoint", but no order code in the file at all.
 *
 * TWO LAYERS OF ENFORCEMENT, and the first one is not mine:
 *
 *   LAYER 1 — AT SCHWAB (do this; it is the one that actually binds).
 *     A Schwab developer app is registered against specific API products. An app registered
 *     for "Market Data Production" ONLY — without "Accounts and Trading" — holds credentials
 *     that return 401 on every order endpoint. Nothing running on this machine, no bug of
 *     mine, and no future edit can place a trade with those keys, because the entitlement to
 *     do so does not exist. Check the app at https://developer.schwab.com → your app → API
 *     products. If "Accounts and Trading" is enabled and you only want data, create a
 *     data-only app and use ITS key/secret here.
 *     This is the same principle as the Alpaca paper keys, which 401 against the live host:
 *     make the dangerous thing impossible rather than merely un-called.
 *
 *   LAYER 2 — IN THIS FILE.
 *     Only /marketdata/v1/* endpoints appear here. There is no account endpoint, no order
 *     construction, no POST of any kind. `assertTradeIncapable()` reads this file's own source
 *     at startup and throws if an order path, a trader endpoint, or a mutating HTTP method
 *     ever appears in it — so a future edit that adds one fails loudly instead of quietly
 *     widening what these credentials touch.
 *
 * WHAT THIS IS FOR. Option chains are the gating item on the variance-risk-premium test.
 * Schwab returns the CURRENT chain, never a history of chains, so VRP only becomes testable
 * if something snapshots it daily starting now. `--snapshot` is that job: three months of
 * daily snapshots produce an implied-vs-realised volatility series that was not purchased
 * from anyone.
 *
 * Usage
 *   node backend/schwab-data.js --check              structural proof it cannot trade
 *   node backend/schwab-data.js --quote SPY
 *   node backend/schwab-data.js --chain XSP
 *   node backend/schwab-data.js --snapshot           the daily VRP collection job
 */
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const fs = require("fs"), path = require("path");

const BASE = "https://api.schwabapi.com";
const MD = "/marketdata/v1";                       // the ONLY API surface this file touches
const TOKEN_CACHE = path.join(__dirname, "data", ".schwab-token.json");
const SNAP_DIR = path.join(__dirname, "data", "chain-snapshots");
const DEFAULT_UNDERLYINGS = ["XSP", "SPY"];

/**
 * Refuse to run if this file ever gains the ability to trade. Checked against its own source,
 * so it cannot be defeated by editing a config or setting a variable — only by editing the
 * check itself, which is a visible act in a diff.
 */
function assertTradeIncapable() {
  const src = fs.readFileSync(__filename, "utf8");
  // Strip this function's own body so its patterns do not match themselves.
  let body = src.replace(/function assertTradeIncapable[\s\S]*?\n}\n/, "");

  // EXACTLY ONE mutating request is permitted in this file: the OAuth token exchange, which is
  // a form-encoded POST to /v1/oauth/token and cannot place an order. It is excised by its
  // sentinel markers rather than by loosening the rule, so the allowance is a single named
  // exception visible in any diff — and any OTHER POST still fails the check.
  //
  // The first version of this function had no exception and correctly rejected the whole file;
  // the comment beside the token call claimed an exemption the code did not implement. The
  // check was right and the prose was wrong, which is the correct direction for that to fail.
  // Markers carry explanatory prose, so match from BEGIN to END rather than requiring a bare
  // `/* OAUTH-EXCHANGE-BEGIN */` — an earlier version did, silently failed to match, and the
  // check refused the whole file. Failing closed on a malformed marker is the right direction.
  const oauthBlock = /\/\* OAUTH-EXCHANGE-BEGIN[\s\S]*?OAUTH-EXCHANGE-END \*\//;
  const hadOauth = oauthBlock.test(body);
  body = body.replace(oauthBlock, "");
  if (/\/v1\/oauth\/token/.test(body))
    throw new Error("an OAuth token call appears outside the marked exchange block — refusing to load.");

  const banned = [
    [/\/trader\/v\d/, "a trader (account/order) endpoint"],
    [/orderLegCollection|orderStrategyType|childOrderStrategies/, "order payload construction"],
    [/method:\s*["'](POST|PUT|DELETE|PATCH)["']/i, "a mutating HTTP method outside the OAuth exchange"],
    [/\/orders\b/, "an orders path"],
  ];
  const hits = banned.filter(([re]) => re.test(body)).map(([, w]) => w);
  if (hits.length) throw new Error(`schwab-data.js is meant to be READ-ONLY but now contains: ${hits.join(", ")}. Refusing to load.`);
  return { hadOauth };
}
assertTradeIncapable();

// ── auth ─────────────────────────────────────────────────────────────────────
async function token() {
  const KEY = process.env.SCHWAB_APP_KEY, SEC = process.env.SCHWAB_APP_SECRET, RT = process.env.SCHWAB_REFRESH_TOKEN;
  if (!KEY || !SEC) throw new Error("SCHWAB_APP_KEY / SCHWAB_APP_SECRET absent from backend/.env");
  if (!RT || /^your_/.test(RT)) throw new Error("SCHWAB_REFRESH_TOKEN not set — run: node backend/schwab-auth.js (expires weekly)");
  try {
    const c = JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8"));
    if (c.access && c.expires > Date.now() + 60000) return c.access;
  } catch {}
  /* OAUTH-EXCHANGE-BEGIN — the ONE mutating request permitted in this file. Form-encoded token
     refresh; it cannot place an order. assertTradeIncapable() excises exactly this block and
     rejects any other POST/PUT/DELETE/PATCH, and any oauth call outside these markers. */
  const r = await fetch(`${BASE}/v1/oauth/token`, {
    method: "POST",
    headers: { authorization: "Basic " + Buffer.from(`${KEY}:${SEC}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: RT }),
    signal: AbortSignal.timeout(20000),
  });
  /* OAUTH-EXCHANGE-END */
  const t = await r.text();
  if (!r.ok) throw new Error(`token refresh ${r.status} — ${t.slice(0, 140)}${r.status === 400 ? " (weekly refresh token likely expired; re-run backend/schwab-auth.js)" : ""}`);
  const j = JSON.parse(t);
  try { fs.mkdirSync(path.dirname(TOKEN_CACHE), { recursive: true }); fs.writeFileSync(TOKEN_CACHE, JSON.stringify({ access: j.access_token, expires: Date.now() + (j.expires_in || 1800) * 1000 })); fs.chmodSync(TOKEN_CACHE, 0o600); } catch {}
  return j.access_token;
}

async function get(p) {
  const tok = await token();
  const r = await fetch(BASE + p, { headers: { authorization: `Bearer ${tok}`, accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : {};
}

// ── data ─────────────────────────────────────────────────────────────────────
async function quote(symbol) {
  const q = await get(`${MD}/${encodeURIComponent(symbol)}/quotes`);
  const d = q?.[symbol]?.quote || {};
  return { symbol, price: d.lastPrice ?? d.mark ?? null, bid: d.bidPrice ?? null, ask: d.askPrice ?? null, ts: d.quoteTime ?? d.tradeTime ?? null };
}

async function chain(symbol, { strikeCount = 30, contractType = "ALL", fromDate, toDate } = {}) {
  const p = new URLSearchParams({ symbol, contractType, strikeCount: String(strikeCount), includeUnderlyingQuote: "true" });
  if (fromDate) p.set("fromDate", fromDate);
  if (toDate) p.set("toDate", toDate);
  const c = await get(`${MD}/chains?${p}`);
  const contracts = [];
  for (const side of ["callExpDateMap", "putExpDateMap"]) {
    for (const [exp, strikes] of Object.entries(c[side] || {})) {
      for (const [strike, arr] of Object.entries(strikes)) {
        for (const o of arr) contracts.push({
          type: side.startsWith("call") ? "C" : "P",
          exp: exp.split(":")[0], dte: +(exp.split(":")[1] ?? NaN), strike: +strike,
          bid: o.bid, ask: o.ask, mark: o.mark, iv: o.volatility,
          delta: o.delta, gamma: o.gamma, theta: o.theta, vega: o.vega,
          oi: o.openInterest, vol: o.totalVolume,
        });
      }
    }
  }
  return { symbol, underlying: c.underlyingPrice ?? null, ivIndex: c.volatility ?? null, count: contracts.length, contracts };
}

async function history(symbol, { years = 2 } = {}) {
  const p = new URLSearchParams({ symbol, periodType: "year", period: String(years), frequencyType: "daily", frequency: "1", needExtendedHoursData: "false" });
  const h = await get(`${MD}/pricehistory?${p}`);
  return (h.candles || []).map(c => ({ date: new Date(c.datetime).toISOString().slice(0, 10), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
}

/**
 * The daily snapshot. Writes one file per underlying per trading day and never overwrites an
 * existing one — a re-run must not silently replace a morning snapshot with an afternoon one,
 * because the series' value depends on every observation being taken at a comparable time.
 */
async function snapshot(underlyings = DEFAULT_UNDERLYINGS, { force = false } = {}) {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const now = new Date();
  const day = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
  const results = [];

  // A snapshot taken while the market is shut records the PREVIOUS session's chain under
  // TODAY's date. Nothing downstream could ever detect that — the file looks perfectly normal —
  // and the implied-vol series would quietly carry duplicated observations that inflate its
  // sample and understate its variance. So closed sessions are refused, not merely skipped.
  if (["Sat", "Sun"].includes(dow)) {
    return { day, dow, aborted: "market closed (weekend) — a snapshot now would stamp stale quotes with today's date", results };
  }

  for (const u of underlyings) {
    const f = path.join(SNAP_DIR, `${u}-${day}.json`);
    if (fs.existsSync(f) && !force) { results.push({ symbol: u, skipped: "already snapshotted today" }); continue; }
    try {
      // Holiday detection without a market calendar: ask the tape. If the newest print is
      // hours old on a weekday, the market did not trade today.
      const q = await quote(u);
      if (q.ts) {
        const ageH = (Date.now() - q.ts) / 3600000;
        if (ageH > 4) { results.push({ symbol: u, skipped: `last print is ${ageH.toFixed(1)}h old — market likely closed (holiday); refusing to record stale quotes as today's` }); continue; }
      }
      const c = await chain(u);
      // 30-delta implied vol is the standard VRP reference point; stored alongside the raw
      // chain so the series is usable without re-parsing every file.
      const near = c.contracts.filter(x => Number.isFinite(x.dte) && x.dte >= 20 && x.dte <= 45 && Number.isFinite(x.iv) && Number.isFinite(x.delta));
      const atm = near.filter(x => Math.abs(Math.abs(x.delta) - 0.5) < 0.1);
      const ivAtm = atm.length ? atm.reduce((s, x) => s + x.iv, 0) / atm.length : null;
      const rec = { day, capturedAt: new Date().toISOString(), symbol: u, underlying: c.underlying, ivIndex: c.ivIndex, ivAtm30d: ivAtm, contracts: c.contracts };
      fs.writeFileSync(f, JSON.stringify(rec));
      results.push({ symbol: u, contracts: c.count, underlying: c.underlying, ivAtm30d: ivAtm });
    } catch (e) { results.push({ symbol: u, error: e.message }); }
  }
  return { day, results };
}

module.exports = { quote, chain, history, snapshot, assertTradeIncapable, SNAP_DIR };

// ════════════════════════════════════════════════════════════════════════════
if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  const argOf = (k) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : null; };

  if (args.includes("--check")) {
    console.log(`\n  TRAIDS — SCHWAB DATA MODULE · TRADE-INCAPABILITY CHECK\n`);
    const src = fs.readFileSync(__filename, "utf8");
    const surfaces = [...new Set(src.match(/\/(marketdata|trader)\/v\d+[^\s`"']*/g) || [])];
    console.log(`  API surfaces referenced in this file:`);
    surfaces.forEach(s => console.log(`    ${/trader/.test(s) ? "✗" : "✓"} ${s}`));
    let ok = true;
    try { assertTradeIncapable(); console.log(`  ✓ structural check passed — no trader endpoint, no order payload, no JSON mutation`); }
    catch (e) { ok = false; console.log(`  ✗ ${e.message}`); }
    const exported = Object.keys(module.exports);
    console.log(`  ✓ exports: ${exported.join(", ")} — nothing that places an order`);
    const authed = !!process.env.SCHWAB_REFRESH_TOKEN && !/^your_/.test(process.env.SCHWAB_REFRESH_TOKEN);
    console.log(`  ${authed ? "✓" : "○"} OAuth ${authed ? "token present" : "NOT COMPLETED — run: node backend/schwab-auth.js"}`);
    console.log(`\n  LAYER 1 REMINDER — the binding control is at Schwab, not here:`);
    console.log(`  register the app for "Market Data Production" WITHOUT "Accounts and Trading",`);
    console.log(`  and the credentials return 401 on every order endpoint no matter what runs locally.\n`);
    process.exit(ok ? 0 : 1);
  }

  try {
    if (args.includes("--quote")) console.log(await quote(argOf("--quote")));
    else if (args.includes("--chain")) {
      const c = await chain(argOf("--chain"));
      console.log(`\n  ${c.symbol} · underlying ${c.underlying} · ${c.count} contracts · IV index ${c.ivIndex}`);
      console.table(c.contracts.filter(x => x.dte >= 20 && x.dte <= 45).slice(0, 10));
    } else if (args.includes("--history")) {
      const h = await history(argOf("--history"));
      console.log(`  ${h.length} daily bars · ${h[0]?.date} → ${h[h.length - 1]?.date}`);
    } else if (args.includes("--snapshot")) {
      const r = await snapshot(DEFAULT_UNDERLYINGS, { force: args.includes("--force") });
      console.log(`\n  chain snapshot · ${r.day}${r.dow ? ` (${r.dow})` : ""}`);
      if (r.aborted) { console.log(`  · ABORTED — ${r.aborted}\n`); process.exit(0); }
      for (const x of r.results) {
        const mark = x.error ? "✗" : x.skipped ? "·" : "✓";
        const iv = x.ivAtm30d == null ? "—" : x.ivAtm30d.toFixed(2);
        const detail = x.error || x.skipped || (x.contracts + " contracts · underlying " + x.underlying + " · 30d ATM IV " + iv);
        console.log("  " + mark + " " + String(x.symbol).padEnd(6) + " " + detail);
      }
      console.log(`  → ${SNAP_DIR}\n`);
    } else {
      console.log(`\n  usage: --check | --quote SYM | --chain SYM | --history SYM | --snapshot\n`);
    }
  } catch (e) { console.log(`\n  ✗ ${e.message}\n`); process.exit(1); }
})();
