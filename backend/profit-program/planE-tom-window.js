#!/usr/bin/env node
"use strict";
/**
 * PLAN E - is the ZN month-end window the right length? EXPLORATORY, IN-SAMPLE, weightless. READ-ONLY on the repo.
 *   node backend/profit-program/planE-tom-window.js [--refresh]
 * Data: IEF dividend-adjusted daily closes 2002-07..2026-10 from the repo's own local Yahoo proxy (GET http://localhost:3002/api/yahoo/IEF/history), cached to
 * backend/data/profit-program/planE-ief-yahoo.json on first run (--refresh re-pulls). IEF TOTAL return minus the daily T-bill (DTB3 month / 252) = excess return.
 *
 * Offsets: o = 0 is the LAST session of a month, o = -1 the one before, ..., o = +1 the FIRST session of the next month. Each month contributes one observation
 * per offset; t = mean / (sd / sqrt(months)) with one observation per month, i.e. clustered by month (no overlap between months).
 * Windows [a..b] sum the daily excess returns over offsets a..b. R180's registered window is [-5..0] (close of session -6 to the last close).
 * MULTIPLICITY, stated: 21 single offsets (-10..+10) and a 9 x 5 grid of windows (a in -8..0, b in 0..4) = 45 windows. The protocol is select-then-test:
 * the window is picked on DISCOVERY months only (2002-08..2018-12) and read ONCE on HOLDOUT months (2019-01..2026-09, the period R180 was sealed on).
 * Cost is not charged in the per-offset table; the 2 bps per side is charged per WINDOW whatever its length; the window table charges 2 bps per side on IEF (R180's cost) = 4 bps per month.
 * Nothing here is evidence: a better window would be a PROPOSAL for a weightless forward twin, registered by the main loop.
 */
const fs = require("fs"), path = require("path");
const M = require("./planE-model.js");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const CACHE = path.join(M.BACKEND, "data", "profit-program", "planE-ief-yahoo.json");
const mean = M.mean, sd = M.sd;
const tOf = (x) => (x.length > 2 && sd(x) > 0 ? mean(x) / (sd(x) / Math.sqrt(x.length)) : NaN);

(async () => {
  if (!fs.existsSync(CACHE) || process.argv.includes("--refresh")) {
    const r = await fetch("http://localhost:3002/api/yahoo/IEF/history?days=9500&interval=1d", { signal: AbortSignal.timeout(90000) });
    if (!r.ok) throw new Error("local yahoo proxy HTTP " + r.status + " (start the 3002 server or use the cache)");
    const j = await r.json(); writeJsonAtomic(CACHE, { spec: "planE-ief-yahoo-v1", fetchedAt: new Date().toISOString(), symbol: "IEF", bars: j.bars.map((b) => ({ d: b.date, adj: b.adjClose })) });
  }
  const C = JSON.parse(fs.readFileSync(CACHE, "utf8")), bars = C.bars.filter((b) => b.adj > 0), TBY = M.tbillByMonth();
  const ret = bars.map((b, i) => (i ? { d: b.d, x: b.adj / bars[i - 1].adj - 1 - (TBY[b.d.slice(0, 7)] ?? 0.0) / 252 } : null)).filter(Boolean);
  const byM = {}; ret.forEach((r) => (byM[r.d.slice(0, 7)] = byM[r.d.slice(0, 7)] || []).push(r));
  const months = Object.keys(byM).sort().filter((m) => byM[m].length >= 15 && m >= "2002-09" && m <= "2026-09");
  const at = (m, o) => { if (o <= 0) { const a = byM[m]; return a[a.length - 1 + o]; } const nm = months[months.indexOf(m) + 1]; return nm && byM[nm] ? byM[nm][o - 1] : null; };
  const rowsM = months.map((m) => ({ m, v: (o) => { const r = at(m, o); return r ? r.x : null; } })).filter((r, i) => i < months.length - 1);
  console.log(`IEF excess-of-T-bill daily returns, ${rowsM.length} months ${rowsM[0].m}..${rowsM[rowsM.length - 1].m} (cache fetched ${C.fetchedAt})`);
  const half = (m) => (m <= "2018-12" ? "disc" : "hold");
  const out = { spec: "planE-tom-window-v1", fetchedAt: C.fetchedAt, months: rowsM.length, offsets: [], windows: [] };

  console.log("\nPER-OFFSET mean excess return (bp/day) and t by month; discovery 2002-2018 vs holdout 2019-2026 (21 offsets looked at)");
  console.log("offset   all: mean bp   t     discovery: bp   t     holdout: bp   t");
  for (let o = -10; o <= 10; o++) {
    const all = [], d = [], h = [];
    for (const r of rowsM) { const v = r.v(o); if (v == null) continue; all.push(v); (half(r.m) === "disc" ? d : h).push(v); }
    const row = { o, all: { bp: +(1e4 * mean(all)).toFixed(2), t: +tOf(all).toFixed(2) }, disc: { bp: +(1e4 * mean(d)).toFixed(2), t: +tOf(d).toFixed(2) }, hold: { bp: +(1e4 * mean(h)).toFixed(2), t: +tOf(h).toFixed(2) } }; out.offsets.push(row);
    console.log(`${(o >= 0 ? "+" : "") + o}`.padStart(5) + `    ${String(row.all.bp).padStart(8)} ${String(row.all.t).padStart(6)}    ${String(row.disc.bp).padStart(8)} ${String(row.disc.t).padStart(6)}    ${String(row.hold.bp).padStart(8)} ${String(row.hold.t).padStart(6)}`);
  }
  console.log("\nWINDOWS [a..b] (9 x 5 = 45 tried), net of 4 bps per month; select on discovery, read once on holdout. Printed: the registered window, every window with discovery t >= 3.0, and the 5 longest");
  console.log("window     days  disc mean%/mo  disc t   hold mean%/mo  hold t   all mean%/mo  all t");
  const win = (a, b) => { const all = [], d = [], h = []; for (const r of rowsM) { let s = 0, ok = true; for (let o = a; o <= b; o++) { const v = r.v(o); if (v == null) { ok = false; break; } s += v; } if (!ok) continue; s -= 0.0004; all.push(s); (half(r.m) === "disc" ? d : h).push(s); } return { all, d, h }; };
  const printed = [];
  for (let a = -8; a <= 0; a++) for (let b = 0; b <= 4; b++) {
    const w = win(a, b), row = { a, b, days: b - a + 1, disc: { mean: +(100 * mean(w.d)).toFixed(3), t: +tOf(w.d).toFixed(2) }, hold: { mean: +(100 * mean(w.h)).toFixed(3), t: +tOf(w.h).toFixed(2) }, all: { mean: +(100 * mean(w.all)).toFixed(3), t: +tOf(w.all).toFixed(2) } }; out.windows.push(row); printed.push(row);
  }
  const show = printed.filter((r) => (r.a === -5 && r.b === 0) || r.disc.t >= 3.0 || r.days >= 12);
  for (const row of show) console.log(`[${row.a},${row.b >= 0 ? "+" : ""}${row.b}]`.padEnd(10) + `${String(row.days).padStart(3)}  ${String(row.disc.mean).padStart(10)}  ${String(row.disc.t).padStart(7)}  ${String(row.hold.mean).padStart(11)}  ${String(row.hold.t).padStart(7)}  ${String(row.all.mean).padStart(11)} ${String(row.all.t).padStart(6)}${row.a === -5 && row.b === 0 ? "   <- R180 registered window" : ""}`);
  // select-then-test
  const best = [...out.windows].sort((p, q) => q.disc.t - p.disc.t)[0], reg = out.windows.find((w) => w.a === -5 && w.b === 0);
  console.log(`\nSELECT-THEN-TEST: best of 45 on discovery = [${best.a}..${best.b}] (t ${best.disc.t}); holdout for that pick: ${best.hold.mean}%/mo t ${best.hold.t}.  The registered [-5..0]: discovery ${reg.disc.mean}%/mo t ${reg.disc.t}, holdout ${reg.hold.mean}%/mo t ${reg.hold.t}.`);
  const dm = best.hold.mean - reg.hold.mean;
  console.log(`   holdout difference (pick minus registered): ${dm.toFixed(3)} %/mo per unit of IEF-beta notional; at the ZN overlay's 4.2 x 0.79 = 3.32 notional: ${(3.318 * dm).toFixed(2)} % of NAV per month = $${Math.round(3.318 * dm * 1000)}/month per $100k (before ZN-vs-IEF differences)`);
  out.selectThenTest = { pick: { a: best.a, b: best.b }, discT: best.disc.t, holdMeanPct: best.hold.mean, holdT: best.hold.t, registeredHoldMeanPct: reg.hold.mean, holdDiffPctPerMonth: +dm.toFixed(3), usdPerMonthPer100k: Math.round(3.318 * dm * 1000), multiplicity: { offsets: 21, windows: 45 } };
  writeJsonAtomic(path.join(M.BACKEND, "data", "profit-program", "planE-tom-window.json"), out);
  console.log("\nwrote backend/data/profit-program/planE-tom-window.json");
})().catch((e) => { console.error("planE-tom-window FAILED:", e.stack); process.exit(1); });
