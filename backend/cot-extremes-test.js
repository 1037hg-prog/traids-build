#!/usr/bin/env node
/**
 * TRAIDS — COT Positioning Extremes: does institutional futures positioning predict the market?
 *
 * PRE-REGISTERED HYPOTHESIS (stated before results): when large speculators' (non-commercial)
 * net positioning in S&P 500 / NASDAQ-100 futures hits multi-year percentile EXTREMES, forward
 * index returns tilt CONTRARIAN — spec washouts (<10th pctile) precede above-average returns,
 * spec euphoria (>90th) precedes below-average. Middle readings = no information.
 * Registered prior: weak-to-nothing standalone; possibly a modest regime tilt at extremes.
 *
 * METHOD (no lookahead, honest timing):
 *   • CFTC legacy futures-only COT via the public Socrata API — "S&P 500 Consolidated" and
 *     "NASDAQ-100 Consolidated" (full + e-mini combined), full available history.
 *   • netSpec = (noncomm long − noncomm short) / open interest, each report week (Tuesday).
 *   • Percentile vs the TRAILING 156 weeks only (needs ≥104 weeks of history to trade).
 *   • COT is RELEASED Friday ~3:30pm for Tuesday data → entry at the first index close ≥
 *     report date + 5 calendar days (the following Monday). No one trades Tuesday's data Tuesday.
 *   • Forward returns 1wk (5 td) and 4wk (21 td) from entry close, ^GSPC / ^NDX (Yahoo, 25y).
 *   • Buckets: <10th pctile (washout), >90th (euphoria), 10–90 (baseline).
 *   • Kill-tests: t-stats per bucket vs baseline; NON-OVERLAPPING 4wk cohorts (every 4th
 *     qualifying week); chronological 60/40 OOS split; by-decade table.
 *
 * Usage: node backend/cot-extremes-test.js
 */
const MARKETS = [
  { key: "SPX", cot: "S&P 500 Consolidated - CHICAGO MERCANTILE EXCHANGE", px: "^GSPC" },
  { key: "NDX", cot: "NASDAQ-100 Consolidated - CHICAGO MERCANTILE EXCHANGE", px: "^NDX" },
];
const LOOKBACK_W = 156, MIN_HIST_W = 104, LO = 10, HI = 90;

async function cot(market) {
  const where = encodeURIComponent(`market_and_exchange_names='${market}'`);
  const sel = "report_date_as_yyyy_mm_dd,open_interest_all,noncomm_positions_long_all,noncomm_positions_short_all";
  const u = `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$select=${sel}&$where=${where}&$order=report_date_as_yyyy_mm_dd&$limit=50000`;
  const r = await fetch(u); if (!r.ok) throw new Error(`CFTC ${r.status}`);
  return (await r.json()).map(x => ({
    d: x.report_date_as_yyyy_mm_dd.slice(0, 10),
    oi: +x.open_interest_all, nl: +x.noncomm_positions_long_all, ns: +x.noncomm_positions_short_all,
  })).filter(x => x.oi > 0);
}
async function yahoo(sym) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=25y&interval=1d`, { headers: { "User-Agent": "Mozilla/5.0" } });
  const res = (await r.json()).chart?.result?.[0];
  const ts = res?.timestamp || [], c = res?.indicators?.quote?.[0]?.close || [];
  const out = []; for (let i = 0; i < ts.length; i++) if (c[i] != null) out.push({ d: new Date(ts[i] * 1000).toISOString().slice(0, 10), c: c[i] });
  return out;
}
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const tOf = a => sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0;
const pad = (s, n) => String(s).padEnd(n);
const fmt = (a, base) => a.length ? `${pad("n " + a.length, 8)}${pad("avg " + (mean(a) >= 0 ? "+" : "") + mean(a).toFixed(2) + "%", 12)}${pad("t " + tOf(a).toFixed(2), 8)}${base != null ? "vs base " + (base >= 0 ? "+" : "") + base.toFixed(2) + "%" : ""}` : "n 0";

(async () => {
  console.log(`\n  TRAIDS — COT Positioning Extremes test · large-spec net %OI · trailing-${LOOKBACK_W}w percentile · entry Monday after release\n`);
  for (const M of MARKETS) {
    const [cotRows, px] = await Promise.all([cot(M.cot), yahoo(M.px)]);
    const pxIdx = new Map(px.map((x, i) => [x.d, i]));
    const firstCloseOnOrAfter = (dstr) => { const t = new Date(dstr).getTime(); for (let i = 0; i < px.length; i++) if (new Date(px[i].d).getTime() >= t) return i; return -1; };

    // percentile of net spec vs trailing window (past only)
    const net = cotRows.map(x => (x.nl - x.ns) / x.oi);
    const rows = [];
    for (let i = MIN_HIST_W; i < cotRows.length; i++) {
      const hist = net.slice(Math.max(0, i - LOOKBACK_W), i);
      const pct = hist.filter(v => v < net[i]).length / hist.length * 100;
      const entryIdx = firstCloseOnOrAfter(new Date(new Date(cotRows[i].d).getTime() + 5 * 86400000).toISOString().slice(0, 10));
      if (entryIdx < 0 || entryIdx + 21 >= px.length) continue;
      const e = px[entryIdx].c;
      rows.push({ d: cotRows[i].d, pct, f1: (px[entryIdx + 5].c / e - 1) * 100, f4: (px[entryIdx + 21].c / e - 1) * 100 });
    }
    console.log(`  ${M.key} — ${cotRows.length} COT weeks (${cotRows[0]?.d} → ${cotRows[cotRows.length - 1]?.d}) · ${rows.length} tradeable weeks\n`);

    const lo = rows.filter(r => r.pct < LO), hi = rows.filter(r => r.pct > HI), mid = rows.filter(r => r.pct >= LO && r.pct <= HI);
    for (const [hz, f] of [["1-week", "f1"], ["4-week", "f4"]]) {
      const base = mean(mid.map(r => r[f]));
      console.log(`    ${hz} forward returns:`);
      console.log(`      ${pad("washout  <" + LO + "th (buy?)", 26)}${fmt(lo.map(r => r[f]), base)}`);
      console.log(`      ${pad("euphoria >" + HI + "th (fade?)", 26)}${fmt(hi.map(r => r[f]), base)}`);
      console.log(`      ${pad("middle (baseline)", 26)}${fmt(mid.map(r => r[f]), null)}`);
    }
    // non-overlapping 4wk cohorts for the extreme buckets (every 4th qualifying week)
    const deo = (set) => set.filter((_, i) => i % 4 === 0).map(r => r.f4);
    console.log(`    4-week NON-OVERLAPPING (honest N):`);
    console.log(`      ${pad("washout de-overlapped", 26)}${fmt(deo(lo), mean(deo(mid)))}`);
    console.log(`      ${pad("euphoria de-overlapped", 26)}${fmt(deo(hi), mean(deo(mid)))}`);
    // OOS split on the washout-long idea (the pre-registered direction)
    const cut = Math.floor(rows.length * 0.6);
    const cutD = rows[cut]?.d || "9999";
    const loIn = lo.filter(r => r.d < cutD).map(r => r.f4), loOut = lo.filter(r => r.d >= cutD).map(r => r.f4);
    console.log(`    OOS (washout, 4wk): in-sample ${fmt(loIn)} · out-of-sample ${fmt(loOut)}`);
    // by decade
    const decades = [...new Set(rows.map(r => r.d.slice(0, 3) + "0s"))];
    let line = "    by decade (washout 4wk vs middle): ";
    for (const dec of decades) {
      const l = lo.filter(r => r.d.slice(0, 3) + "0s" === dec).map(r => r.f4);
      const m = mid.filter(r => r.d.slice(0, 3) + "0s" === dec).map(r => r.f4);
      line += `${dec}: ${l.length ? ((mean(l) - mean(m)) >= 0 ? "+" : "") + (mean(l) - mean(m)).toFixed(2) + "%(n" + l.length + ")" : "—"}  `;
    }
    console.log(line + "\n");
  }
  console.log(`  READ: the contrarian story is real only if extremes beat the middle CONSISTENTLY — significant`);
  console.log(`  t on de-overlapped cohorts, holding OOS, not one-decade-driven. Anything less = COT extremes are`);
  console.log(`  regime color for the dashboard, not a tradeable signal. (Registered prior: the latter.)\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
