#!/usr/bin/env node
/**
 * TRAIDS — Overnight vs Intraday Decomposition
 *
 * Tests the most-documented equity anomaly we've never checked: do returns accrue
 * OVERNIGHT (prior close → open) or INTRADAY (open → close)? Splits every day's return
 * into the two windows across the universe over ~2 years, then asks the only question
 * that matters for a retail trader: is the overnight effect CAPTURABLE net of the daily
 * round-trip cost it would take to harvest it — or is it just a structural fact that says
 * "holding beats day-trading"?
 *
 * Honest by construction: gross AND net of costs, vs buy-and-hold. Survivorship caveat
 * applies (today's 45 liquid names) — it flatters any positive drift.
 *
 * Usage:  node backend/overnight-decomp.js            (needs ALPACA keys in backend/.env)
 *         COST_BPS=5 DAYS=750 node backend/overnight-decomp.js
 */
const fs = require("fs");
const path = require("path");
function loadEnv() { try { const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8"); for (const line of txt.split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC || /your_|xxx|changeme/i.test(KEY)) { console.error("\n  No real ALPACA keys in backend/.env.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "750");
const COST_BPS = parseFloat(process.env.COST_BPS || "5");   // per side
const UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","JPM","V","UNH","XOM","JNJ","WMT","PG","MA","HD","CVX","ABBV","KO","PEP","COST","MRK","AVGO","LLY","BAC","ADBE","CRM","NFLX","AMD","DIS","INTC","QCOM","TXN","HON","UNP","LOW","CAT","GS","BKNG","NKE","MS","BA","T","PFE","C"];

async function fetchBars(sym) {
  const start = new Date(Date.now() - DAYS * 86_400_000).toISOString().split("T")[0];
  const out = []; let pageToken = null;
  do {
    const params = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED });
    if (pageToken) params.set("page_token", pageToken);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${params}`, { headers });
    if (!r.ok) break;
    const j = await r.json();
    for (const b of (j.bars?.[sym] || [])) out.push({ o: b.o, h: b.h, l: b.l, c: b.c });
    pageToken = j.next_page_token || null;
  } while (pageToken);
  return out;
}
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const winPct = a => a.length ? a.filter(v => v > 0).length / a.length * 100 : 0;
const ann = m => m * 252;

(async () => {
  console.log(`\n  TRAIDS — Overnight vs Intraday Decomposition  ·  ${UNIVERSE.length} names · ~${DAYS}d · ${COST_BPS}bps/side\n`);
  const overnight = [], intraday = [], full = [];
  process.stdout.write("  fetching");
  for (const sym of UNIVERSE) {
    const d = await fetchBars(sym); process.stdout.write(".");
    for (let i = 1; i < d.length; i++) {
      if (!(d[i - 1].c > 0) || !(d[i].o > 0)) continue;
      overnight.push((d[i].o - d[i - 1].c) / d[i - 1].c);   // prior close → today open
      intraday.push((d[i].c - d[i].o) / d[i].o);            // today open → today close
      full.push((d[i].c - d[i - 1].c) / d[i - 1].c);        // close → close
    }
  }
  console.log(`\n\n  ${full.length} symbol-days analyzed.\n`);
  const pct = x => (x >= 0 ? "+" : "") + (x * 100).toFixed(3) + "%";

  console.log("  WINDOW         avg/day     win%     annualized");
  console.log("  " + "─".repeat(48));
  console.log("  Overnight      " + pct(mean(overnight)).padEnd(11) + winPct(overnight).toFixed(0).padEnd(8) + "+" + (ann(mean(overnight)) * 100).toFixed(1) + "%");
  console.log("  Intraday       " + pct(mean(intraday)).padEnd(11) + winPct(intraday).toFixed(0).padEnd(8) + (ann(mean(intraday)) >= 0 ? "+" : "") + (ann(mean(intraday)) * 100).toFixed(1) + "%");
  console.log("  Full (C→C)     " + pct(mean(full)).padEnd(11) + winPct(full).toFixed(0).padEnd(8) + "+" + (ann(mean(full)) * 100).toFixed(1) + "%");

  // Is the overnight effect CAPTURABLE? Harvesting it = buy MOC, sell MOO every day = one
  // round-trip per day. Net overnight return = overnight − round-trip cost.
  const rt = COST_BPS * 2 / 10000;
  const netOvernight = mean(overnight) - rt;
  console.log("\n  CAPTURE TEST — daily 'buy close / sell open' to harvest the overnight window:");
  console.log("    gross overnight/day   " + pct(mean(overnight)));
  console.log("    minus round-trip cost −" + (rt * 100).toFixed(3) + "%  (" + COST_BPS + "bps × 2)");
  console.log("    NET overnight/day     " + pct(netOvernight) + "   annualized " + (netOvernight >= 0 ? "+" : "") + (ann(netOvernight) * 100).toFixed(1) + "%");
  console.log("    buy-and-hold/day      " + pct(mean(full)) + "   annualized +" + (ann(mean(full)) * 100).toFixed(1) + "%");

  console.log("\n  VERDICT:");
  if (netOvernight > mean(full) && netOvernight > 0)
    console.log("    Overnight harvest beats buy-and-hold NET of costs — a real, tradeable asymmetry. Validate OOS before believing it.");
  else if (mean(overnight) > mean(intraday) && netOvernight <= 0)
    console.log("    The overnight effect is REAL gross (overnight >> intraday) but DIES net of daily round-trip costs.\n    Implication is structural, not a day-trade signal: returns come from HOLDING overnight, so a swing/hold\n    that simply STAYS in the position captures it for free — while day-trading (flat overnight) forfeits it.");
  else
    console.log("    No exploitable overnight asymmetry in this universe/window. Another honest null.");
  console.log("\n  Caveat: survivorship (today's 45 liquid names) flatters all drift; IEX opens can be noisy. Indicative.\n");
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
