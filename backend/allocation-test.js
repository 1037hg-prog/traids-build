#!/usr/bin/env node
/**
 * TRAIDS — Honest Allocation Test (the real "make returns" path)
 *
 * The board has no edge; the ONE real edge (the CTA/trend premium) is buyable as DBMF/KMLM.
 * So the honest way to "improve returns" isn't a signal — it's ALLOCATION: bolt a slice of a
 * real trend sleeve onto a normal core portfolio and measure what it does to risk-adjusted
 * return and (critically) the 2022 drawdown. This blends REAL funds — SPY, TLT, DBMF, KMLM —
 * so the result is exactly what you'd actually hold, not a synthetic backtest.
 *
 * Cores tested:   100% SPY   ·   classic 60/40 (SPY/TLT)
 * CTA sleeve:     0 / 10 / 20 / 30%  carved out of the core, put into DBMF
 * Reports per blend: annual return, vol, Sharpe, max drawdown, and the 2022 return.
 *
 * D20 FIX (2026-08-06): this caveat used to claim the window included "2020 + 2022". The 2020
 * part is FALSE — the common date axis where SPY, TLT and DBMF all have data begins 2020-07-31,
 * AFTER the Feb-Mar 2020 crash, so that crisis is not in the sample at all.
 *
 * The fix is that the window is now MEASURED rather than described: the script counts distinct
 * SPY drawdowns >15% and prints them. Doing so immediately corrected the correction — the first
 * draft of this comment asserted "2022 only", and the counter found TWO stress events (2022 and
 * 2025-04). Two is better than one and still small; CTA behaviour is regime-specific, so a
 * maxDD improvement measured across two bears is suggestive, not a general property.
 *
 * HONEST CAVEATS: DBMF only exists since 2019, so this window starts 2020-07-31 and MISSES the
 * 2020 crash entirely — see the measured crisis count printed at run time,
 * not multi-decade. Past low correlation / crisis alpha is the documented CTA property but isn't
 * guaranteed forward. This is RISK improvement (smoother ride, shallower bears), not a return
 * maximizer — adding the sleeve usually trims top-line return a hair while lifting Sharpe.
 *
 * Usage:  node backend/allocation-test.js        (ALPACA keys; DAYS=2600 ≈ since DBMF inception)
 */
const fs = require("fs"), path = require("path");
function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC) { console.error("\n  Missing ALPACA keys.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "2600");
const SYMS = ["SPY", "TLT", "DBMF", "KMLM"];

async function fetchBars(sym) { const start = new Date(Date.now() - DAYS * 86400000).toISOString().split("T")[0]; const out = []; let tok = null; do { const pr = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED }); if (tok) pr.set("page_token", tok); const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${pr}`, { headers }); if (!r.ok) break; const j = await r.json(); for (const b of (j.bars?.[sym] || [])) out.push({ d: (b.t || "").slice(0, 10), c: b.c }); tok = j.next_page_token || null; } while (tok); return out; }

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const std = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
function perf(r) { const m = mean(r), v = std(r); let eq = 1, pk = 1, dd = 0; for (const x of r) { eq *= 1 + x; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); } return { ann: m * 252, vol: v * Math.sqrt(252), sharpe: v > 0 ? m / v * Math.sqrt(252) : 0, maxDD: dd }; }
const corr = (a, b) => { const n = Math.min(a.length, b.length); if (n < 3) return 0; const ma = mean(a), mb = mean(b); let ab = 0, aa = 0, bb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; } return aa && bb ? ab / Math.sqrt(aa * bb) : 0; };
const comp = a => a.reduce((s, r) => s * (1 + r), 1) - 1;

(async () => {
  console.log(`\n  TRAIDS — Honest Allocation Test  ·  core ± a real CTA sleeve (DBMF)  ·  ~${DAYS}d\n`);
  process.stdout.write("  fetching");
  const raw = {}; for (const s of SYMS) { raw[s] = await fetchBars(s); process.stdout.write("."); }
  console.log("");
  // common date axis where SPY, TLT, DBMF all exist (KMLM optional/newer)
  const maps = {}; for (const s of SYMS) { maps[s] = {}; raw[s].forEach(b => maps[s][b.d] = b.c); }
  const dates = Object.keys(maps.SPY).filter(d => maps.TLT[d] != null && maps.DBMF[d] != null).sort();
  const ret = (s) => { const r = []; for (let i = 1; i < dates.length; i++) { const a = maps[s][dates[i - 1]], b = maps[s][dates[i]]; r.push(a > 0 && b != null ? b / a - 1 : 0); } return r; };
  const rSPY = ret("SPY"), rTLT = ret("TLT"), rDBMF = ret("DBMF");
  const rDates = dates.slice(1);
  console.log(`  window ${dates[0]} → ${dates[dates.length - 1]}  ·  ${rDates.length} days  ·  corr(DBMF,SPY) = ${corr(rDBMF, rSPY).toFixed(2)}`);

  /**
   * D20 — COUNT THE CRISES, DO NOT CLAIM THEM. The whole case for a CTA sleeve is crisis alpha,
   * so the number of independent stress events in the window IS the sample size for that claim.
   * Counted here as distinct SPY drawdowns exceeding 15% from a running peak, separated by a
   * recovery to within 5% of that peak, so one long bear is one event rather than many.
   */
  {
    let peak = 1, eq = 1, inDD = false, episodes = [], trough = 1, start = null;
    for (let i = 0; i < rSPY.length; i++) {
      eq *= 1 + rSPY[i];
      if (eq > peak) { if (inDD) { episodes.push({ start, end: rDates[i], depth: trough / peak - 1 }); inDD = false; } peak = eq; trough = eq; }
      else {
        if (eq < trough) trough = eq;
        if (!inDD && eq / peak - 1 <= -0.15) { inDD = true; start = rDates[i]; }
      }
    }
    if (inDD) episodes.push({ start, end: rDates[rDates.length - 1], depth: trough / peak - 1 });
    const yrs = [...new Set(rDates.map(d => d.slice(0, 4)))];
    console.log(`  crisis sample for the CTA claim: ${episodes.length} SPY drawdown(s) >15% in this window` +
      (episodes.length ? ` — ${episodes.map(e => `${e.start.slice(0, 7)} (${(100 * e.depth).toFixed(0)}%)`).join(", ")}` : ""));
    console.log(`  calendar years covered: ${yrs.join(", ")}`);
    if (episodes.length <= 1) {
      console.log(`  *** ONE CRISIS IS AN ANECDOTE ABOUT THAT CRISIS. Every risk figure below is conditioned`);
      console.log(`  *** on a single stress event, and CTA behaviour is regime-specific. Do not read the maxDD`);
      console.log(`  *** improvement as a general property. (D20)`);
    }
    console.log("");
  }

  const blend = (coreRets, w) => coreRets.map((c, i) => (1 - w) * c + w * rDBMF[i]);
  const core60 = rSPY.map((s, i) => 0.6 * s + 0.4 * rTLT[i]);
  const yr2022 = (r) => { const idx = rDates.map((d, i) => d.slice(0, 4) === "2022" ? i : -1).filter(i => i >= 0); return idx.length ? comp(idx.map(i => r[i])) * 100 : null; };

  const pad = (s, n) => String(s).padEnd(n);
  const row = (label, r) => { const p = perf(r), y = yr2022(r); console.log("  " + pad(label, 26) + pad((p.ann * 100).toFixed(1) + "%", 9) + pad((p.vol * 100).toFixed(1) + "%", 8) + pad(p.sharpe.toFixed(2), 8) + pad((p.maxDD * 100).toFixed(1) + "%", 9) + (y == null ? "n/a" : (y >= 0 ? "+" : "") + y.toFixed(1) + "%")); };

  console.log("  " + pad("portfolio", 26) + pad("ann", 9) + pad("vol", 8) + pad("Sharpe", 8) + pad("maxDD", 9) + "2022");
  console.log("  " + "─".repeat(66));
  console.log("  CORE = 100% SPY");
  for (const w of [0, 0.1, 0.2, 0.3]) row(`  ${(100 - w * 100).toFixed(0)}% SPY / ${(w * 100).toFixed(0)}% DBMF`, blend(rSPY, w));
  console.log("  CORE = 60/40 (SPY/TLT)");
  for (const w of [0, 0.1, 0.2, 0.3]) row(`  ${(100 - w * 100).toFixed(0)}% 60-40 / ${(w * 100).toFixed(0)}% DBMF`, blend(core60, w));

  if (raw.KMLM && raw.KMLM.length > 200) {
    const kd = dates.filter(d => maps.KMLM[d] != null); const ki = {}; kd.forEach((d, i) => ki[d] = i);
    const rK = []; for (let i = 1; i < kd.length; i++) { const a = maps.KMLM[kd[i - 1]], b = maps.KMLM[kd[i]]; rK.push(a > 0 ? b / a - 1 : 0); }
    const pK = perf(rK); console.log(`\n  (ref) KMLM standalone since ${kd[0]}: Sharpe ${pK.sharpe.toFixed(2)} · vol ${(pK.vol * 100).toFixed(1)}% · maxDD ${(pK.maxDD * 100).toFixed(1)}%`);
  }

  console.log(`\n  READ: watch the Sharpe and maxDD columns as the DBMF slice grows. A 20-30% trend sleeve`);
  console.log(`  typically LIFTS Sharpe and SHRINKS the 2022 drawdown while trimming top-line a touch — that's`);
  console.log(`  the diversification working. This is the honest "make it better": not a signal, an allocation`);
  console.log(`  you can implement today by buying DBMF/KMLM. ~2019-on only; past crisis alpha isn't a promise.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
