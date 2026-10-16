#!/usr/bin/env node
/**
 * TRAIDS — The OVERNIGHT ANOMALY: does the equity market earn its return while closed?
 *
 * One of the largest documented return patterns in the literature (Cooper/Cliff/Gulen 2008,
 * Lou/Polk/Skouras 2019): historically, ~ALL of the equity index's return accrued CLOSE→OPEN
 * (overnight), while OPEN→CLOSE (intraday) earned ~zero. If it still holds, it's harvestable
 * with market-on-close + market-on-open orders (auction fills — minimal spread cost) — one of
 * the few documented anomalies where retail execution is actually plausible.
 *
 * PRE-REGISTERED: (1) confirm the split exists in SPY/QQQ full history; (2) the REAL question
 * is the RECENT decade — most published anomalies decay; (3) harvest sim net of 0.3bp/side
 * (SPY auction) and note the tax reality (100% short-term gains, ~2×250 fills/yr).
 * Registered prior: split real historically, materially weakened recently, after-tax marginal.
 *
 * Usage: node backend/overnight-test.js
 */
async function yahoo(sym) {
  // explicit epoch bounds — range=max silently coarsens to MONTHLY bars, which
  // poisoned the first run of this test (402 "sessions" for 33y of SPY)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=1&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const res = (await r.json()).chart?.result?.[0];
  const ts = res?.timestamp || [], q = res?.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) if (q.close?.[i] != null && q.open?.[i] != null && q.open[i] > 0)
    out.push({ d: new Date(ts[i] * 1000).toISOString().slice(0, 10), o: q.open[i], c: q.close[i] });
  // granularity guard: daily data must have ~252 rows/yr — refuse coarse bars
  const yrs = (new Date(out[out.length - 1]?.d) - new Date(out[0]?.d)) / 3.15e10;
  if (yrs > 2 && out.length / yrs < 200) throw new Error(`${sym}: got ${out.length} bars over ${yrs.toFixed(1)}y — NOT daily data, refusing to compute`);
  return out;
}
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const ann = (rets) => (Math.pow(rets.reduce((p, r) => p * (1 + r), 1), 252 / rets.length) - 1) * 100;
const sharpe = (rets) => sd(rets) > 0 ? mean(rets) / sd(rets) * Math.sqrt(252) : 0;
const pad = (s, n) => String(s).padEnd(n);
const COST = 0.00003;   // 0.3bp per side — SPY/QQQ auction fills; generous for MOO/MOC

(async () => {
  console.log(`\n  TRAIDS — Overnight vs Intraday return split · MOO/MOC harvest sim · cost ${(COST * 1e4).toFixed(1)}bp/side\n`);
  for (const sym of ["SPY", "QQQ"]) {
    const d = await yahoo(sym);
    const rows = [];
    for (let i = 1; i < d.length; i++) {
      const on = d[i].o / d[i - 1].c - 1;          // close → next open  (overnight)
      const id = d[i].c / d[i].o - 1;              // open  → close      (intraday)
      rows.push({ d: d[i].d, on, id });
    }
    console.log(`  ${sym} — ${rows.length} sessions · ${rows[0].d} → ${rows[rows.length - 1].d}`);
    const line = (lbl, set) => {
      const onN = set.map(r => r.on - 2 * COST);   // harvest pays 2 crossings per night held
      const idN = set.map(r => r.id - 2 * COST);
      const diff = set.map(r => r.on - r.id);
      const t = sd(diff) > 0 ? mean(diff) / (sd(diff) / Math.sqrt(diff.length)) * 1 : 0;
      console.log("    " + pad(lbl, 14) + pad(`overnight ${ann(set.map(r => r.on)) >= 0 ? "+" : ""}${ann(set.map(r => r.on)).toFixed(1)}%/yr`, 20)
        + pad(`intraday ${ann(set.map(r => r.id)) >= 0 ? "+" : ""}${ann(set.map(r => r.id)).toFixed(1)}%/yr`, 20)
        + pad(`o/n NET ${ann(onN) >= 0 ? "+" : ""}${ann(onN).toFixed(1)}%/yr`, 18)
        + pad(`Shp ${sharpe(set.map(r => r.on)).toFixed(2)}/${sharpe(set.map(r => r.id)).toFixed(2)}`, 15)
        + `t(diff) ${t.toFixed(2)}`);
    };
    line("FULL", rows);
    const decades = [...new Set(rows.map(r => r.d.slice(0, 3) + "0s"))];
    for (const dec of decades) line(dec, rows.filter(r => r.d.slice(0, 3) + "0s" === dec));
    line("last 5y", rows.slice(-1260));
    line("last 2y", rows.slice(-504));
    console.log("");
  }
  console.log(`  READ: the anomaly is real only if the o/n vs intraday split holds in the RECENT rows, net of`);
  console.log(`  cost. Even then: the harvest is ~500 auction fills/yr of 100% SHORT-TERM-taxed gains, and it`);
  console.log(`  still carries overnight equity risk (gaps, not vol-free). Compare against just holding SPY.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
