#!/usr/bin/env node
/** Month-end strategy profit — what R186 (IEF, last 5 sessions) and R218 (UUP against its month-to-date move, last 3 sessions) would
 *  have made trade by trade on the actual ETFs, 2016-01..2026-08, net of 2 bps a side. Raw P&L (not excess over drift): what the money
 *  makes. EXPLORATORY summary of already-sealed rules; seals nothing.  node backend/month-end-profit.js [--capital=50000] */
const path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const CAP = +((process.argv.find((a) => a.startsWith("--capital=")) || "=50000").split("=")[1]), COST = 0.0004;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
(async () => {
  const { bars } = await fetchBars(["IEF", "UUP"], { start: "2015-12-01", end: "2026-08-31", feed: "sip", adjustment: "all", quiet: true });
  const byMonth = (s) => { const M = {}; bars[s].forEach((b, i) => (M[b.t.slice(0, 7)] = M[b.t.slice(0, 7)] || []).push(i)); return M; };
  const I = bars.IEF, U = bars.UUP, MI = byMonth("IEF"), MU = byMonth("UUP"), months = Object.keys(MI).filter((m) => m >= "2016-01" && m <= "2026-08").sort();
  const rows = [];
  for (const m of months) {
    const a = MI[m], u = MU[m], prevU = MU[Object.keys(MU).sort().filter((x) => x < m).pop()]; if (!a || !u || !prevU || a.length < 15) continue;
    const ief = I[a[a.length - 1]].c / I[a[a.length - 6]].c - 1 - COST;               // R186: buy close of 6th-to-last, sell close of last
    const e = u[u.length - 4], x = u[u.length - 1], mtd = U[e].c / U[prevU[prevU.length - 1]].c - 1;
    const uup = mtd === 0 ? 0 : (mtd > 0 ? -1 : 1) * (U[x].c / U[e].c - 1) - COST;        // R218: against month-to-date, close L-4 -> close of last
    rows.push({ m, ief, uup });
  }
  const summ = (r, cap) => { const yrs = r.length / 12, wealth = r.reduce((p, x) => p * (1 + x), 1); let pk = 1, w = 1, dd = 0; for (const x of r) { w *= 1 + x; pk = Math.max(pk, w); dd = Math.min(dd, w / pk - 1); }
    const byYear = {}; rows.forEach((row, i) => (byYear[row.m.slice(0, 4)] = (byYear[row.m.slice(0, 4)] || 0) + r[i] * cap));
    return { perYearPct: +(100 * (wealth ** (1 / yrs) - 1)).toFixed(2), perYearDollars: Math.round(cap * (wealth ** (1 / yrs) - 1)), hitRate: +(r.filter((x) => x > 0).length / r.length).toFixed(2), bestMonth: Math.round(cap * Math.max(...r)), worstMonth: Math.round(cap * Math.min(...r)), maxDrawdownPct: +(100 * dd).toFixed(1), sharpe: +((mean(r) / sd(r)) * Math.sqrt(12)).toFixed(2), losingYears: Object.values(byYear).filter((v) => v < 0).length, years: Object.keys(byYear).length, byYear: Object.fromEntries(Object.entries(byYear).map(([y, v]) => [y, Math.round(v)])) }; };
  const ief = rows.map((r) => r.ief), uup = rows.map((r) => r.uup), both = rows.map((r) => (r.ief + r.uup) / 2), both2 = rows.map((r) => r.ief + r.uup);
  const corr = (() => { const ma = mean(ief), mb = mean(uup); let c = 0, va = 0, vb = 0; ief.forEach((v, i) => { c += (v - ma) * (uup[i] - mb); va += (v - ma) ** 2; vb += (uup[i] - mb) ** 2; }); return +(c / Math.sqrt(va * vb)).toFixed(2); })();
  const out = { capital: CAP, months: rows.length, window: `${rows[0].m}..${rows[rows.length - 1].m}`, costBpsPerSide: 2, corrIEFvsUUP: corr,
    treasuriesAllCapital: summ(ief, CAP), dollarAllCapital: summ(uup, CAP), splitHalfHalf: summ(both, CAP),
    bothFullSize_sameCapital: { note: "both trades at full size on the same capital (they overlap 3 days a month; needs margin, e.g. 2x buying power)", ...summ(both2, CAP) } };
  writeJsonAtomic(path.join(__dirname, "data", "month-end-profit.json"), { ranAt: new Date().toISOString(), exploratory: true, out });
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
