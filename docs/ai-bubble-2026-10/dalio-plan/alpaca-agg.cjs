#!/usr/bin/env node
/**
 * alpaca-agg.cjs — READ-ONLY aggregates of the three Alpaca PAPER accounts (main / BOOK / TV).
 * GET only: /v2/account, /v2/positions, /v2/account/portfolio/history. Keys from backend/.env, never printed; account numbers never printed.
 * Prints per account: equity, cash, long/short market value, gross/equity, crypto MV, AI-hardware-basket MV, 1-month peak-to-now drawdown.
 */
const path = require("path");
const B = "C:/Users/joshc/Downloads/traids (2)/traids-bundle/backend";
require(path.join(B, "node_modules/dotenv")).config({ path: path.join(B, ".env") });
const BASE = "https://paper-api.alpaca.markets";
// AI-hardware basket (disclosed): semis ETFs + AI-hardware megacaps + the 10-01 top-50 momentum names tagged Semiconductors / hardware /
// optics (docs/core-model-2026-10-02/part-a-leadership/leadership.json top50, hand-filtered; software names like DOCN/TWLO/FTNT excluded)
const AI = ["SMH", "SOXX", "SOXL", "USD", "NVDA", "AVGO", "TSM", "ASML", "ARM", "SMCI", "ANET", "VRT", "KLAC", "QCOM",
  "SNDK", "AXTI", "MU", "LITE", "AAOI", "WDC", "STX", "ASX", "DELL", "AMD", "TSEM", "UMC", "INTC", "COHR", "MRVL", "CIEN", "TER", "LRCX", "AMAT", "MTSI", "HPE", "TTMI", "MKSI", "ONTO", "SMTC", "FLEX", "BE", "CRDO", "ALAB"];
const ACCTS = [["main (shared: board mirror + runners)", "ALPACA_KEY_ID", "ALPACA_SECRET_KEY"], ["BOOK (Plan E ETF sleeves)", "ALPACA_BOOK_KEY_ID", "ALPACA_BOOK_SECRET_KEY"], ["TV (R24 mirror / R316 / R309 target)", "ALPACA_TV_KEY_ID", "ALPACA_TV_SECRET_KEY"]];
const get = async (h, p) => { const r = await fetch(BASE + p, { headers: h }); if (!r.ok) throw new Error(`${p} HTTP ${r.status}`); return r.json(); };
const $ = (x) => "$" + Math.round(x).toLocaleString("en-US");
(async () => {
  console.log(`ALPACA PAPER AGGREGATES — ${new Date().toISOString()} (paper endpoint ${BASE}; GET only)`);
  console.log(`AI-hardware basket (${AI.length}): ${AI.join(" ")}`);
  const tot = { eq: 0, lmv: 0, smv: 0, ai: 0, qqq: 0 };
  for (const [name, k, s] of ACCTS) {
    if (!process.env[k] || !process.env[s]) { console.log(`\n${name}: keys missing`); continue; }
    const h = { "APCA-API-KEY-ID": process.env[k], "APCA-API-SECRET-KEY": process.env[s] };
    try {
      const a = await get(h, "/v2/account"), P = await get(h, "/v2/positions");
      const eq = +a.equity, lmv = +a.long_market_value, smv = +a.short_market_value;
      const crypto = P.filter((p) => p.asset_class === "crypto").reduce((x, p) => x + +p.market_value, 0);
      const aiRows = P.filter((p) => AI.includes(p.symbol)), aiMv = aiRows.reduce((x, p) => x + +p.market_value, 0);
      const idx = P.filter((p) => ["QQQ", "SPY", "TQQQ", "SPXL", "UPRO"].includes(p.symbol)).reduce((x, p) => x + +p.market_value, 0);
      const longs = P.filter((p) => +p.market_value > 0).length, shorts = P.filter((p) => +p.market_value < 0).length;
      let ddLine = "";
      try { const ph = await get(h, "/v2/account/portfolio/history?period=1M&timeframe=1D"); const e = (ph.equity || []).filter((x) => x != null && x > 0); if (e.length) { const pk = Math.max(...e); ddLine = `1-month daily equity: peak ${$(pk)} -> last ${$(e[e.length - 1])} = ${(100 * (e[e.length - 1] / pk - 1)).toFixed(2)}% (n ${e.length})`; } } catch (e) { ddLine = `portfolio history: ${e.message}`; }
      console.log(`\n${name}`);
      console.log(`  equity ${$(eq)} · last_equity ${$(+a.last_equity)} · cash ${$(+a.cash)} · buying_power ${$(+a.buying_power)} · multiplier ${a.multiplier}`);
      console.log(`  positions ${P.length} (long ${longs} / short ${shorts}) · long MV ${$(lmv)} · short MV ${$(smv)} · gross/equity ${((lmv - smv) / eq).toFixed(2)}x · net/equity ${((lmv + smv) / eq).toFixed(2)}x`);
      console.log(`  crypto MV ${$(crypto)} · QQQ/SPY(+lev) MV ${$(idx)} · AI-hardware MV ${$(aiMv)} (${(100 * aiMv / eq).toFixed(1)}% of equity; ${aiRows.map((p) => `${p.symbol} ${$(+p.market_value)}`).join(", ") || "none"})`);
      console.log(`  ${ddLine}`);
      tot.eq += eq; tot.lmv += lmv; tot.smv += smv; tot.ai += aiMv; tot.qqq += idx;
    } catch (e) { console.log(`\n${name}: ${e.message}`); }
  }
  console.log(`\nALL THREE: equity ${$(tot.eq)} · long ${$(tot.lmv)} · short ${$(tot.smv)} · AI-hardware ${$(tot.ai)} (${(100 * tot.ai / tot.eq).toFixed(1)}%) · QQQ/SPY ${$(tot.qqq)}`);
})();
