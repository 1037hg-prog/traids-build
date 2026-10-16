/**
 * CRYPTO BARS — Alpaca v1beta3 consolidated crypto bars, pagination exhausted.
 *
 * Extracted 2026-08-24 from backend/reconstruct-lost-week.js, which had the only working copy in the
 * tree. R44 needs a real crypto benchmark and the ledger's mktRet field cannot supply one: it carries
 * a single equity-market series applied to every asset class, so on 2026-08-21 it reads -0.280 for
 * Crypto, Futures and FX alike — while the crypto complex rallied hard enough that twelve alt-coin
 * tickets closed at their full take-profit. Benchmarking a crypto cell against that series would
 * credit the signal for a move the benchmark never saw.
 *
 * Symbols use Alpaca's slash form ("BTC/USD"), which is also the board's own ticker form.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const HDRS = () => {
  const id = process.env.ALPACA_KEY_ID, secret = process.env.ALPACA_SECRET_KEY;
  if (!id || !secret) throw new Error("ALPACA_KEY_ID / ALPACA_SECRET_KEY not set in backend/.env");
  return { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": secret, Accept: "application/json" };
};

/** fetchCryptoBars(["BTC/USD",...], "1Day", "2026-07-20", "2026-08-25") -> { "BTC/USD": [bar,...] } */
async function fetchCryptoBars(symbols, timeframe, start, end) {
  if (!symbols || !symbols.length) return {};
  const out = {};
  const CH = 40;
  for (let i = 0; i < symbols.length; i += CH) {
    const chunk = symbols.slice(i, i + CH);
    let token = null;
    do {
      const p = new URLSearchParams({ symbols: chunk.join(","), timeframe, start, end, limit: "10000" });
      if (token) p.set("page_token", token);
      const r = await fetch(`https://data.alpaca.markets/v1beta3/crypto/us/bars?${p}`, { headers: HDRS() });
      if (!r.ok) throw new Error(`crypto bars ${r.status} for ${chunk.length} symbol(s)`);
      const j = await r.json();
      for (const [s, rows] of Object.entries(j.bars || {})) (out[s] ||= []).push(...rows);
      token = j.next_page_token || null;
    } while (token);
  }
  for (const s in out) out[s].sort((a, b) => String(a.t).localeCompare(String(b.t)));
  return out;
}

/**
 * dailyComplexReturn(bars) -> { "YYYY-MM-DD": pctReturn }
 * Equal-weight mean of each pair's close-to-close percent change. Equal weight, not cap weight,
 * because the question is what a basket of the traded pairs did — and the traded pairs are sized by
 * risk, not by market capitalisation.
 */
function dailyComplexReturn(bars) {
  const perDay = {};
  for (const rows of Object.values(bars)) {
    for (let i = 1; i < rows.length; i++) {
      const d = String(rows[i].t).slice(0, 10);
      if (!(rows[i - 1].c > 0)) continue;
      (perDay[d] ||= []).push((rows[i].c / rows[i - 1].c - 1) * 100);
    }
  }
  const out = {};
  for (const [d, v] of Object.entries(perDay)) out[d] = +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(4);
  return out;
}

module.exports = { fetchCryptoBars, dailyComplexReturn };
