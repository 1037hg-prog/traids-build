#!/usr/bin/env node
/**
 * TRAIDS — Congressional-Trade Following Backtest (an INFORMATION-edge test, not a price signal)
 *
 * Tests the real, retail-accessible idea: do you make money following U.S. Senators' stock
 * PURCHASES? Uses the free public STOCK-Act disclosure dataset (senate-stock-watcher), and —
 * crucially — models the REALISTIC 45-day reporting lag: you can only act once a trade is
 * DISCLOSED, not when it happened. We enter LAG calendar days after the transaction (default 40,
 * the legal max-ish), hold 1/3/6/12 months, and measure return AND alpha vs SPY over the same
 * window. We also run a LAG=0 variant (enter on the transaction date — impossible in reality) to
 * quantify exactly how much edge the disclosure lag eats.
 *
 * HONEST CAVEATS: dataset is 2014-2019 (this free mirror) and Alpaca daily prices start ~2018, so
 * the usable window is ~2018-2019 (a real but limited sample). Amounts are RANGES → equal-weighted.
 * Survivorship (tickers still priceable today). No shorts/options. "Following Pelosi" headlines are
 * cherry-picked; this measures the AGGREGATE, lag-adjusted, net-of-cost reality.
 *
 * Usage:  node backend/congress-trade-test.js        (ALPACA keys; LAG=40 FROM=2018-06-01 defaults)
 */
const fs = require("fs"), path = require("path");
function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC) { console.error("\n  Missing ALPACA keys.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const LAG = parseInt(process.env.LAG || "40");                 // realistic disclosure lag (calendar days)
const FROM = process.env.FROM || "2018-06-01";                 // only purchases after this (Alpaca price coverage)
const COST_BPS = parseFloat(process.env.COST_BPS || "5");
const SRC = "https://raw.githubusercontent.com/timothycarambat/senate-stock-watcher-data/master/aggregate/all_transactions.json";
const HOLDS = [["1mo", 21], ["3mo", 63], ["6mo", 126], ["12mo", 252]];

async function fetchBars(sym) {
  const start = "2018-01-01";
  for (let attempt = 0; attempt < 4; attempt++) {
    const out = []; let tok = null, ok = true;
    do {
      const pr = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED });
      if (tok) pr.set("page_token", tok);
      const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${pr}`, { headers });
      if (r.status === 429) { await new Promise(z => setTimeout(z, 1500)); ok = false; break; }   // rate-limited → back off + retry
      if (!r.ok) return out;
      const j = await r.json();
      for (const b of (j.bars?.[sym] || [])) out.push({ d: (b.t || "").slice(0, 10), c: b.c });
      tok = j.next_page_token || null;
    } while (tok);
    if (ok) return out;
  }
  return [];
}
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const std = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mdy2iso = s => { const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };
const addDays = (iso, n) => new Date(new Date(iso + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);

(async () => {
  console.log(`\n  TRAIDS — Congressional-Trade Following (Senate purchases)  ·  realistic lag ${LAG}d · holds 1/3/6/12mo · net ${COST_BPS}bps\n`);
  process.stdout.write("  fetching disclosures");
  const all = await (await fetch(SRC)).json();
  const buys = all.filter(t => t.type === "Purchase" && t.asset_type === "Stock" && /^[A-Z]{1,5}$/.test(t.ticker || "") && mdy2iso(t.transaction_date) && mdy2iso(t.transaction_date) >= FROM)
    .map(t => ({ ticker: t.ticker, txn: mdy2iso(t.transaction_date) }));
  console.log(` · ${buys.length} stock purchases after ${FROM}`);
  const tickers = ["SPY", ...new Set(buys.map(b => b.ticker))];   // SPY first (fetched while limits are freshest)
  console.log(`  fetching prices for ${tickers.length} tickers`);
  const px = {};
  const store = (tk, bars) => { if (bars.length > 60) { const map = {}, dates = []; for (const b of bars) { map[b.d] = b.c; dates.push(b.d); } px[tk] = { map, dates }; } };
  store("SPY", await fetchBars("SPY"));   // guarantee the benchmark
  if (!px["SPY"]) { console.error("  No SPY data (Alpaca rate-limited) — re-run.\n"); process.exit(1); }
  let i = 1;
  const worker = async () => { while (i < tickers.length) { const tk = tickers[i++]; store(tk, await fetchBars(tk)); if (i % 50 === 0) process.stdout.write("."); } };
  await Promise.all(Array.from({ length: 5 }, worker));
  console.log(`\n  ${Object.keys(px).length}/${tickers.length} tickers priceable\n`);

  const priceOnAfter = (tk, iso) => { const p = px[tk]; if (!p) return null; let lo = 0, hi = p.dates.length - 1, ans = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (p.dates[mid] >= iso) { ans = mid; hi = mid - 1; } else lo = mid + 1; } return ans < 0 ? null : { d: p.dates[ans], c: p.map[p.dates[ans]], i: ans }; };
  const fwd = (tk, iso, H) => { const e = priceOnAfter(tk, iso); if (!e) return null; const p = px[tk]; if (e.i + H >= p.dates.length) return null; const x = p.map[p.dates[e.i + H]]; return e.c > 0 ? { ret: x / e.c - 1, entryD: e.d, exitD: p.dates[e.i + H] } : null; };

  const run = (lag) => {
    const res = {}; for (const [lbl] of HOLDS) res[lbl] = { ret: [], alpha: [] };
    for (const b of buys) {
      const entryISO = addDays(b.txn, lag);
      for (const [lbl, H] of HOLDS) {
        const tr = fwd(b.ticker, entryISO, H); if (!tr) continue;
        const sp = fwd("SPY", tr.entryD, H); if (!sp) continue;
        const net = (tr.ret - COST_BPS * 2 / 10000);
        res[lbl].ret.push(net * 100);
        res[lbl].alpha.push((net - sp.ret) * 100);
      }
    }
    return res;
  };

  const pad = (s, n) => String(s).padEnd(n);
  const report = (label, res) => {
    console.log(`  ${label}`);
    console.log("    " + pad("hold", 7) + pad("n", 7) + pad("avg ret", 11) + pad("avg alpha", 12) + pad("med alpha", 12) + pad("win vs SPY", 12) + "t(alpha)");
    for (const [lbl] of HOLDS) {
      const a = res[lbl].alpha, r = res[lbl].ret; if (a.length < 5) { console.log("    " + pad(lbl, 7) + "too few"); continue; }
      const t = std(a) > 0 ? mean(a) / (std(a) / Math.sqrt(a.length)) : 0;
      const win = a.filter(x => x > 0).length / a.length * 100;
      console.log("    " + pad(lbl, 7) + pad(a.length, 7) + pad((mean(r) >= 0 ? "+" : "") + mean(r).toFixed(1) + "%", 11) + pad((mean(a) >= 0 ? "+" : "") + mean(a).toFixed(2) + "%", 12) + pad((median(a) >= 0 ? "+" : "") + median(a).toFixed(2) + "%", 12) + pad(win.toFixed(0) + "%", 12) + (t >= 0 ? "+" : "") + t.toFixed(2));
    }
    console.log("");
  };

  report(`REALISTIC — enter ${LAG} days after the trade (when it's disclosed):`, run(LAG));
  report("BEST-CASE — enter ON the transaction date (impossible — shows what the lag costs):", run(0));

  console.log("  READ: 'avg alpha' = return minus SPY over the same hold. The REALISTIC (lagged) block is");
  console.log("  what you could actually capture; the BEST-CASE block is the un-followable ideal. If realistic");
  console.log("  alpha is ~0 / t<2, the 45-day disclosure lag has already eaten the edge (the usual finding).");
  console.log("  Limited window (~2018-19) + survivorship flatter this → treat a weak result as the ceiling.\n");
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
