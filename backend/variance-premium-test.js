#!/usr/bin/env node
/**
 * TRAIDS — Variance Risk Premium: measure it, then try to harvest it honestly.
 *
 * The claim (well-documented in the literature): options IMPLY more volatility than the market
 * subsequently REALIZES — sellers of insurance get paid. This measures that premium directly:
 *   VIX(t)  = market-implied 30-day annualized vol
 *   RV(t)   = realized annualized vol over the NEXT 21 trading days (close-to-close)
 *   premium = VIX − subsequent RV   (in vol points)
 *
 * Then a HARVEST PROXY: each month (non-overlapping cohorts — no pseudo-replication), "sell"
 * 30-day vol at the VIX and buy it back at realized. P&L per unit vega ≈ (VIX − RV) vol points.
 * Costs: a blunt 1.0 vol-point round-trip haircut standing in for retail spreads/fees — real
 * retail structures (defined-risk verticals, SVXY-style ETPs) leak at least this much.
 * Filters tested: term-structure contango (VIX < VIX3M) and VIX-level splits.
 *
 * HONEST FRAME: this is a SHORT-VOL premium. You collect small amounts steadily and give back
 * violently in crashes (Feb-2018, Mar-2020 style). Expect the data to show BOTH. This is an
 * allocation-sleeve candidate like DBMF/funding-carry — NOT a daily trading engine.
 *
 * Usage: node backend/variance-premium-test.js     (Yahoo public data, no keys)
 */
const RANGE = process.env.RANGE || "25y";
const COST_VOLPTS = parseFloat(process.env.COST || "1.0");   // round-trip, per monthly harvest

async function yahoo(sym, range = RANGE) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`${sym}: HTTP ${r.status}`);
  const j = await r.json();
  const res = j.chart?.result?.[0];
  const ts = res?.timestamp || [], c = res?.indicators?.quote?.[0]?.close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) if (c[i] != null) out.push({ d: new Date(ts[i] * 1000).toISOString().slice(0, 10), c: c[i] });
  return out;
}
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => { const m = mean(a), s = sd(a); return s > 0 ? m / (s / Math.sqrt(a.length)) : 0; };
const pad = (s, n) => String(s).padEnd(n);

(async () => {
  console.log(`\n  TRAIDS — Variance Risk Premium test · VIX-implied vs subsequently-realized · ${RANGE} · cost ${COST_VOLPTS} vol-pt RT\n`);
  process.stdout.write("  fetching ^GSPC, ^VIX, ^VIX3M");
  const [spx, vix, vix3m] = await Promise.all([yahoo("^GSPC"), yahoo("^VIX"), yahoo("^VIX3M", "10y")]);   // Yahoo serves ^VIX3M by fixed range only — 10y is its max reliable depth
  console.log(`  ·  SPX ${spx.length}d, VIX ${vix.length}d, VIX3M ${vix3m.length}d\n`);

  // align by date
  const vixBy = Object.fromEntries(vix.map(x => [x.d, x.c]));
  const v3By  = Object.fromEntries(vix3m.map(x => [x.d, x.c]));
  // realized vol over next 21 trading days from SPX closes
  const rows = [];
  for (let i = 0; i < spx.length - 22; i++) {
    const v = vixBy[spx[i].d]; if (v == null) continue;
    const rets = [];
    for (let k = i + 1; k <= i + 21; k++) rets.push(Math.log(spx[k].c / spx[k - 1].c));
    const rv = sd(rets) * Math.sqrt(252) * 100;
    rows.push({ d: spx[i].d, vix: v, rv, prem: v - rv, v3: v3By[spx[i].d] ?? null });
  }

  // ── 1. THE MEASUREMENT (non-overlapping monthly cohorts — honest N) ──
  const monthly = [];
  for (let i = 0; i < rows.length; i += 21) monthly.push(rows[i]);
  const prem = monthly.map(r => r.prem);
  console.log("  1) IS THE PREMIUM REAL?  (non-overlapping ~monthly cohorts)");
  console.log(`     n=${prem.length} months · avg VIX ${mean(monthly.map(r => r.vix)).toFixed(1)} · avg subsequent RV ${mean(monthly.map(r => r.rv)).toFixed(1)}`);
  console.log(`     mean premium ${mean(prem) >= 0 ? "+" : ""}${mean(prem).toFixed(2)} vol pts · median ${prem.slice().sort((a, b) => a - b)[Math.floor(prem.length / 2)].toFixed(2)} · positive ${(prem.filter(p => p > 0).length / prem.length * 100).toFixed(0)}% of months`);
  console.log(`     t-stat ${tstat(prem).toFixed(2)} · 95% CI low ${(mean(prem) - 1.96 * sd(prem) / Math.sqrt(prem.length)).toFixed(2)} vol pts\n`);

  console.log("     by year (mean premium, vol pts):");
  const yrs = [...new Set(monthly.map(r => r.d.slice(0, 4)))].sort();
  let line = "     ";
  for (const y of yrs) { const p = mean(monthly.filter(r => r.d.slice(0, 4) === y).map(r => r.prem)); line += pad(`${y.slice(2)}:${p >= 0 ? "+" : ""}${p.toFixed(1)}`, 10); if (line.length > 90) { console.log(line); line = "     "; } }
  if (line.trim()) console.log(line);

  const worst = monthly.slice().sort((a, b) => a.prem - b.prem).slice(0, 6);
  console.log("\n     THE TAIL — worst harvest months (this is what you're being paid to hold):");
  for (const w of worst) console.log(`       ${w.d}  sold at VIX ${w.vix.toFixed(1)} → realized ${w.rv.toFixed(1)}  =  ${w.prem.toFixed(1)} vol pts`);

  // ── 2. HARVEST PROXY (net of blunt costs) + filters + OOS ──
  const runs = [
    ["unconditional",            m => true],
    ["contango only (VIX<VIX3M)", m => m.v3 != null && m.vix < m.v3],
    ["backwardation (VIX>VIX3M)", m => m.v3 != null && m.vix >= m.v3],
    ["VIX<20 entries only",       m => m.vix < 20],
    ["VIX≥20 entries only",       m => m.vix >= 20],
  ];
  console.log("\n  2) HARVEST PROXY — short 30d vol monthly, net of costs (vol pts per month held)");
  console.log("     " + pad("filter", 28) + pad("n", 6) + pad("gross/mo", 10) + pad("net/mo", 10) + pad("t(net)", 8) + pad("Sharpe", 8) + "worst mo / maxDD(cum)");
  for (const [lbl, f] of runs) {
    const sel = monthly.filter(f);
    if (sel.length < 12) { console.log("     " + pad(lbl, 28) + "n<12"); continue; }
    const net = sel.map(r => r.prem - COST_VOLPTS);
    let eq = 0, pk = 0, dd = 0; for (const x of net) { eq += x; pk = Math.max(pk, eq); dd = Math.min(dd, eq - pk); }
    const shp = sd(net) > 0 ? mean(net) / sd(net) * Math.sqrt(12) : 0;
    console.log("     " + pad(lbl, 28) + pad(sel.length, 6) + pad((mean(sel.map(r => r.prem)) >= 0 ? "+" : "") + mean(sel.map(r => r.prem)).toFixed(2), 10) + pad((mean(net) >= 0 ? "+" : "") + mean(net).toFixed(2), 10) + pad(tstat(net).toFixed(2), 8) + pad(shp.toFixed(2), 8) + Math.min(...net).toFixed(1) + " / " + dd.toFixed(1));
  }
  const cut = Math.floor(monthly.length * 0.6);
  const oosIn = monthly.slice(0, cut).map(r => r.prem - COST_VOLPTS), oosOut = monthly.slice(cut).map(r => r.prem - COST_VOLPTS);
  console.log(`\n     OOS: first 60% net ${mean(oosIn) >= 0 ? "+" : ""}${mean(oosIn).toFixed(2)}/mo (t ${tstat(oosIn).toFixed(2)})  ·  last 40% net ${mean(oosOut) >= 0 ? "+" : ""}${mean(oosOut).toFixed(2)}/mo (t ${tstat(oosOut).toFixed(2)})`);

  // ── 3. WHAT IT MEANS IN DOLLARS ──
  const netUncond = mean(monthly.map(r => r.prem)) - COST_VOLPTS;
  console.log(`\n  3) SIZE OF THE PRIZE (rough): at ~$100 vega per vol pt per ~$10k allocated to the sleeve,`);
  console.log(`     ${netUncond >= 0 ? "+" : ""}${netUncond.toFixed(2)} net vol pts/mo ≈ $${(netUncond * 100 * 12).toFixed(0)}/yr per $10k ≈ ${(netUncond * 100 * 12 / 100).toFixed(1)}%/yr — BEFORE the tail months above,`);
  console.log(`     which arrive clustered with equity drawdowns (it's crash insurance you're writing).`);
  console.log(`\n  READ: literature says the premium is real; the honest questions are (a) does it survive the`);
  console.log(`  cost haircut, (b) is it regime-dependent (contango filter), (c) is the tail tolerable next to`);
  console.log(`  an equity-heavy core. Judge it as an ALLOCATION SLEEVE vs DBMF/funding-carry — never as a`);
  console.log(`  trading signal. Retail implementation (defined-risk spreads) keeps LESS than shown here.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
