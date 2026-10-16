#!/usr/bin/env node
/**
 * R15 — REPLICATE A COVERED-CALL ETF ON REAL CONTRACTS, AS A KNOWN-ANSWER TEST.
 * Registered 2026-08-03 before running. Operator: mimic the option-income ETFs inside TRAIDS.
 *
 * SUBSTITUTION, declared: R15 registered QYLD (NDX calls). Alpaca serves SPXW reliably and NDX
 * options are not available on this key, so the replication target is XYLD — Global X's S&P 500
 * version of the SAME mechanical rule (hold the index, sell the at-the-money monthly call, hold
 * to expiry, re-strike). Same issuer, same methodology, different index. The answer key changes
 * from QYLD's record to XYLD's, which is measured here from the same adjusted-price source.
 *
 * THE POINT IS NOT THE STRATEGY. Alpaca's option data gives contract BARS, not bid/ask. Pricing
 * an entry at a bar close assumes the print was executable — the exact error the external panel
 * flagged in R13. We cannot fix that without a chain feed. So this test MEASURES the error:
 *
 *     replication CAGR minus XYLD's actual CAGR = our fill optimism on index options
 *
 * within +/-1.0%/yr -> pipeline reproduces a real fund; trustworthy for index-option work
 * above +1.0%/yr    -> fills optimistic by that margin; #45/#58/#59/#60 overstated similarly
 * below -1.0%/yr    -> replication misses something the fund does; attribute before concluding
 * beyond +/-2%/yr   -> pipeline unfit; no further VRP test gets built on bar-close pricing
 *
 * EXPECTED ON THE RECORD (written before running): the replication BEATS XYLD, because bar-close
 * pricing ignores the spread we would cross. If so, that is the measurement, not an edge.
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch { } })();
const AH = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
const D = (f) => path.join(__dirname, "data", f);
const nap = (ms) => new Promise(r => setTimeout(r, ms));
const STEP = 25;                    // SPX listed strike step near the money
const CONTRACT = 100;               // index option multiplier

async function stockBars(sym, start, end) {
  const out = []; let token = null;
  do {
    const p = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, end, limit: "10000", feed: "iex", adjustment: "all" });
    if (token) p.set("page_token", token);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${p}`, { headers: AH, signal: AbortSignal.timeout(60000) });
    if (!r.ok) break;
    const j = await r.json();
    out.push(...((j.bars || {})[sym] || []));
    token = j.next_page_token || null;
  } while (token);
  return out;
}
async function optBar(sym, on) {
  const p = new URLSearchParams({ symbols: sym, timeframe: "1Day", start: on, end: on, limit: "5" });
  try {
    const r = await fetch(`https://data.alpaca.markets/v1beta1/options/bars?${p}`, { headers: AH, signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    const j = await r.json();
    const b = (j.bars || {})[sym];
    return b && b.length ? b[0].c : null;
  } catch { return null; }
}
const occ = (root, expISO, cp, strike) => {
  const [y, m, d] = expISO.split("-");
  return `${root}${y.slice(2)}${m}${d}${cp}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
};
// third Friday of a given year/month
function thirdFriday(y, m) {
  const d = new Date(Date.UTC(y, m - 1, 1));
  let count = 0;
  while (true) { if (d.getUTCDay() === 5) { count++; if (count === 3) break; } d.setUTCDate(d.getUTCDate() + 1); }
  return d.toISOString().slice(0, 10);
}

(async () => {
  const START = "2024-01-01", END = "2026-08-04";
  console.log(`R15 — covered-call replication on REAL SPXW contracts vs XYLD's actual record\n`);
  const spx = await stockBars("SPY", START, END);           // SPY as the index proxy for level; SPX = SPY x ~10
  const xyld = await stockBars("XYLD", START, END);
  if (!spx.length || !xyld.length) { console.error("no index/fund bars"); process.exit(1); }
  const spxIdx = new Map(spx.map((b, i) => [String(b.t).slice(0, 10), i]));
  // real S&P 500 PRICE index — what SPXW contracts are struck and settled against
  const gspc = new Map();
  try {
    const gr = await fetch('http://localhost:3002/api/yahoo/%5EGSPC/history?days=1100&interval=1d', { signal: AbortSignal.timeout(45000) });
    for (const b of ((await gr.json()).bars || [])) if (Number.isFinite(b.close)) gspc.set(b.date, b.close);
  } catch {}
  if (gspc.size < 300) { console.error('ABORT: no SPX price index — refusing to substitute a total-return proxy again'); process.exit(1); }
  console.log();

  // build monthly cycles: enter the trading day AFTER each third Friday, expire on the next
  const cycles = [];
  for (let y = 2024; y <= 2026; y++) for (let m = 1; m <= 12; m++) {
    const exp = thirdFriday(y, m);
    if (exp <= START || exp >= END) continue;
    cycles.push(exp);
  }
  cycles.sort();
  console.log(`  ${cycles.length} monthly expiries in window\n`);

  let equity = 1.0, priced = 0, skipped = 0;
  const rows = [];
  for (let i = 0; i < cycles.length - 1; i++) {
    const entryExp = cycles[i], exp = cycles[i + 1];
    // entry = first trading day strictly after the prior expiry
    const entryDate = spx.map(b => String(b.t).slice(0, 10)).find(d => d > entryExp);
    if (!entryDate) { skipped++; continue; }
    const eI = spxIdx.get(entryDate), xI = spxIdx.get(exp);
    if (eI == null || xI == null) { skipped++; continue; }
    // FIXED 2026-08-03. The first run used adjustment=all SPY x10 as "the index" for BOTH the
    // equity leg and the option strike/settlement. That is a total-return series, but SPXW
    // settles against the SPX PRICE index — so dividends (~1.3%/yr) leaked into the strategy
    // return without ever being surrendered to the call. The replication then BEAT buy-and-hold,
    // which is structurally impossible for a covered call in a bull market, and that impossibility
    // is what exposed the bug.
    //   equity leg  : SPY TOTAL return (you do collect the dividends)
    //   option leg  : struck and settled on the SPX PRICE index (what the contract references)
    const pxEntry = gspc.get(entryDate), pxExp = gspc.get(exp);
    if (pxEntry == null || pxExp == null) { skipped++; continue; }
    const spyEntry = spx[eI].c, spyExp = spx[xI].c;
    const K = Math.round(pxEntry / STEP) * STEP;               // at-the-money on the PRICE index
    const sym = occ("SPXW", exp, "C", K);
    const prem = await optBar(sym, entryDate);
    await nap(220);
    if (prem == null) { skipped++; rows.push({ exp, sym, note: "no contract bar" }); continue; }
    priced++;
    const equityRet = spyExp / spyEntry - 1;                   // total return on the held index
    const callCost = Math.max(0, pxExp - K) / pxEntry;         // short call, normalised to notional
    const premRet = prem / pxEntry;                            // premium received, same normalisation
    const idxEntry = pxEntry, idxExp = pxExp;
    const idxRet = pxExp / pxEntry - 1;
    const cycleRet = equityRet + premRet - callCost;
    equity *= (1 + cycleRet);
    rows.push({ entry: entryDate, exp, K, idxEntry: +idxEntry.toFixed(0), idxExp: +idxExp.toFixed(0), prem, premPct: +(100 * prem / idxEntry).toFixed(2), idxRet: +(100 * idxRet).toFixed(2), cycleRet: +(100 * cycleRet).toFixed(2) });
  }
  const yrs = (new Date(cycles[cycles.length - 1]) - new Date(cycles[0])) / (365.25 * 864e5);
  const repCagr = (Math.pow(equity, 1 / yrs) - 1) * 100;
  const xyldCagr = (Math.pow(xyld[xyld.length - 1].c / xyld[0].c, 1 / (xyld.length / 252)) - 1) * 100;
  const spyCagr = (Math.pow(spx[spx.length - 1].c / spx[0].c, 1 / (spx.length / 252)) - 1) * 100;
  const sane = repCagr <= spyCagr + 0.5;   // a covered call CANNOT beat buy-and-hold in a bull market

  console.log(`  cycles priced ${priced}, skipped ${skipped}\n`);
  console.log(`  REPLICATION (bar-close fills)   ${repCagr.toFixed(2)}%  CAGR over ${yrs.toFixed(1)}y`);
  console.log(`  XYLD actual (the answer key)    ${xyldCagr.toFixed(2)}%`);
  console.log(`  SPY buy-and-hold                ${spyCagr.toFixed(2)}%`);
  const err = repCagr - xyldCagr;
  console.log(`\n  REPLICATION ERROR: ${(err >= 0 ? "+" : "") + err.toFixed(2)}%/yr`);
  const verdict = Math.abs(err) <= 1 ? "PASS — pipeline reproduces a real fund's record within 1%/yr"
    : Math.abs(err) <= 2 ? (err > 0 ? "FILLS OPTIMISTIC by " + err.toFixed(2) + "%/yr — every prior options result overstated by roughly this mechanism"
      : "REPLICATION SHORT by " + Math.abs(err).toFixed(2) + "%/yr — missing something the fund does; attribute before concluding")
    : "FAIL — beyond +/-2%/yr. Pipeline unfit for index-option research; no further VRP test on bar-close pricing.";
  console.log(`  VERDICT: ${verdict}`);
  if (!sane) console.log(`
  !! SANITY CHECK FAILED: replication (${repCagr.toFixed(2)}%) exceeds buy-and-hold (${spyCagr.toFixed(2)}%).
     A covered call caps upside; it cannot beat the index in a rising market. Treat as a BUG, not a result.`);
  console.log(`\n  fund expense drag not adjusted (XYLD ~0.60%/yr) — the true error is ~${(err - 0.6).toFixed(2)}%/yr once that is added back to XYLD.`);
  fs.writeFileSync(D("r15-overwrite.json"), JSON.stringify({ ranAt: new Date().toISOString(), target: "XYLD (declared substitution for QYLD — SPXW available, NDX not)", cyclesPriced: priced, skipped, years: +yrs.toFixed(2), replicationCagr: +repCagr.toFixed(2), xyldActualCagr: +xyldCagr.toFixed(2), spyCagr: +spyCagr.toFixed(2), replicationError: +err.toFixed(2), verdict, rows }, null, 1));
  console.log(`\nwritten: r15-overwrite.json`);
})();
