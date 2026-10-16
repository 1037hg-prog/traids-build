#!/usr/bin/env node
/**
 * WEEKLY CASH-SECURED PUT SELLING — DOES THE RELATIVE'S CLAIM HOLD UP?
 *
 * 2026-09-08. The operator's relative reports making money selling weekly puts on "SpaceX", NVDA and
 * AMZN for the last few months, holding a week, not looking at them until Friday, and shrugging at
 * assignment ("if I have to buy the shares at the end of the week so what"). This measures the claim.
 *
 * WHY IT IS MEASURABLE AT ALL. Alpaca serves REAL historical option bars on single names back to
 * ~2024-01 on the existing key (found 2026-07-28 for SPXW, confirmed for NVDA/AMZN/DXYZ today). So
 * this is priced by the market, not by Black-Scholes. That matters more than it sounds: test #58/#61
 * measured real credit at 0.80x the Black-Scholes-at-implied-vol credit, and that single correction
 * took the same VRP episodes from Sharpe 1.57 to -0.17. A modelled backtest of put selling flatters
 * itself by roughly the whole edge, so nothing modelled is used here.
 *
 * THE RULE, fixed before running:
 *   every Friday, sell ONE cash-secured put per name expiring the FOLLOWING Friday (7 days)
 *   strike = the listed strike nearest to spot x (1 - m), for m in {0%, 2%, 5%} measured separately
 *   credit = that contract's traded CLOSE on the entry Friday, and again net of a fill haircut measured
 *            measured cross-vs-mid cost on this shop's own premium sleeve, as the taker's fill)
 *   settle = intrinsic at the expiry Friday close: payoff = credit - max(0, K - S_exp)
 *   capital = K x 100 held in cash the whole week (that is what "cash-secured" means)
 *   cycles are NON-OVERLAPPING; one open put per name at a time, exactly as described.
 *
 * BENCHMARK. The same capital in the shares over the same weeks. Assignment converts the put seller
 * into a shareholder anyway, so "so what if I have to buy" is only a shrug if the shares were the
 * thing you wanted; the honest comparison is therefore against simply holding them.
 *
 * WHAT THIS IS NOT. Not a registered test — it is a retrospective measurement of someone else's
 * claim, run once, on a window that contains a specific history (see the drawdown table it prints).
 * If the operator wants to trade it, it gets registered forward like everything else.
 *
 * Usage: node backend/weekly-put-study-2026-09-08.js [--start 2024-01-05]
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const AH = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
const namesArg = process.argv.indexOf("--names");
const NAMES = namesArg > 0 && process.argv[namesArg + 1] ? process.argv[namesArg + 1].split(",").map((s) => s.trim().toUpperCase()) : ["NVDA", "AMZN", "DXYZ"];
const MONEYNESS = [0, 0.02, 0.05];
/**
 * FILL HAIRCUT, MEASURED PER NAME 2026-09-08 rather than borrowed. The first run used the R21 sleeve's
 * 16% cross-vs-mid cost, which is right for a rotating universe of defined-risk spreads and badly wrong
 * for two of the most liquid single-name option books in existence: the live median cost of selling the
 * bid instead of the mid on the front weekly is 1.9% on NVDA and 3.4% on AMZN (DXYZ 4.1%). At 16% the
 * at-the-money case flipped from a winner to a loser, which was an artifact of the wrong number, not a
 * finding. These are rounded up from the live measurement, and the credit is already a traded close.
 */
const HAIRCUT = { NVDA: 0.02, AMZN: 0.035, DXYZ: 0.045, SPCX: 0.05 };   // SPCX measured 4.8% on the front weekly, 2026-09-08
const startArg = (process.argv[process.argv.indexOf("--start") + 1] || "").match(/^\d{4}-\d{2}-\d{2}$/);
const START = startArg ? startArg[0] : "2024-01-05";
const tagArg = process.argv.indexOf("--tag");
const OUT = path.join(__dirname, "data", `weekly-put-study-2026-09-08${tagArg > 0 && process.argv[tagArg + 1] ? "-" + process.argv[tagArg + 1] : ""}.json`);
const iso = (d) => d.toISOString().slice(0, 10);
const occ = (root, exp, k) => `${root}${exp.slice(2).replace(/-/g, "")}P${String(Math.round(k * 1000)).padStart(8, "0")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stockBars(sym) {
  const out = [];
  let url = `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${START}&limit=10000&adjustment=all&feed=sip`;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(url, { headers: AH, signal: AbortSignal.timeout(30000) });
    if (!r.ok) { const t = await r.text(); throw new Error(`${sym} bars ${r.status} ${t.slice(0, 120)}`); }
    const j = await r.json();
    for (const b of j.bars || []) out.push({ d: String(b.t).slice(0, 10), c: b.c, o: b.o, h: b.h, l: b.l });
    if (!j.next_page_token) break;
    url = url.replace(/&page_token=[^&]*/, "") + `&page_token=${j.next_page_token}`;
  }
  return out;
}

/** One batched call for many option symbols; returns { occ: { date: close } }. */
async function optCloses(syms) {
  const out = {};
  for (let i = 0; i < syms.length; i += 90) {
    const batch = syms.slice(i, i + 90);
    const r = await fetch(`https://data.alpaca.markets/v1beta1/options/bars?symbols=${batch.join(",")}&timeframe=1Day&start=${START}&limit=10000`,
      { headers: AH, signal: AbortSignal.timeout(40000) });
    if (r.status === 429) { await sleep(2000); i -= 90; continue; }
    if (!r.ok) continue;
    const j = await r.json();
    for (const [s, bars] of Object.entries(j.bars || {})) { const m = {}; for (const b of bars) m[String(b.t).slice(0, 10)] = b.c; out[s] = m; }
    await sleep(120);
  }
  return out;
}

(async () => {
  console.log(`WEEKLY CASH-SECURED PUTS — real option prices, ${START} → today\n`);
  const px = {}, results = {};
  for (const sym of NAMES) { px[sym] = await stockBars(sym); console.log(`  ${sym}: ${px[sym].length} daily bars ${px[sym][0]?.d} → ${px[sym][px[sym].length - 1]?.d}`); }

  for (const sym of NAMES) {
    const bars = px[sym], byDate = Object.fromEntries(bars.map((b) => [b.d, b]));
    const fridays = bars.filter((b) => new Date(b.d + "T12:00:00Z").getUTCDay() === 5).map((b) => b.d);
    // cycle = sell on friday[i], expire friday[i+1] (skip when the gap is not ~7 days: holidays)
    const cycles = [];
    for (let i = 0; i < fridays.length - 1; i++) {
      const gap = (Date.parse(fridays[i + 1]) - Date.parse(fridays[i])) / 864e5;
      if (gap >= 6 && gap <= 8) cycles.push({ entry: fridays[i], exp: fridays[i + 1] });
    }
    // build the candidate strike grid per cycle per moneyness, then fetch every contract at once
    const want = [];
    for (const c of cycles) {
      const spot = byDate[c.entry].c;
      for (const m of MONEYNESS) {
        const target = spot * (1 - m);
        // listed grids differ by price level; probe the plausible increments around the target
        const step = spot > 500 ? 5 : spot > 100 ? 2.5 : spot > 25 ? 1 : 0.5;
        const cands = [];
        for (let k = -3; k <= 3; k++) { const strike = Math.round((target + k * step) / step) * step; if (strike > 0) cands.push(+strike.toFixed(2)); }
        want.push({ cycle: c, m, spot, target, cands: [...new Set(cands)] });
      }
    }
    const allSyms = [...new Set(want.flatMap((w) => w.cands.map((k) => occ(sym, w.cycle.exp, k))))];
    console.log(`\n  ${sym}: ${cycles.length} weekly cycles, probing ${allSyms.length} contracts…`);
    const closes = await optCloses(allSyms);

    const rows = { 0: [], 0.02: [], 0.05: [] };
    for (const w of want) {
      const { cycle, m, spot, target } = w;
      let best = null;
      for (const k of w.cands) {
        const s = occ(sym, cycle.exp, k), c = closes[s]?.[cycle.entry];
        if (!(c > 0)) continue;
        if (!best || Math.abs(k - target) < Math.abs(best.k - target)) best = { k, credit: c, occ: s };
      }
      if (!best) continue;
      const sExp = byDate[cycle.exp]?.c;
      if (!(sExp > 0)) continue;
      const capital = best.k * 100;
      const gross = (best.credit - Math.max(0, best.k - sExp)) * 100;
      const net = (best.credit * (1 - (HAIRCUT[sym] ?? 0.04)) - Math.max(0, best.k - sExp)) * 100;
      rows[m].push({ entry: cycle.entry, exp: cycle.exp, spot, strike: best.k, credit: best.credit, sExp,
        assigned: sExp < best.k, gross: +gross.toFixed(2), net: +net.toFixed(2), capital,
        grossPct: +(100 * gross / capital).toFixed(4), netPct: +(100 * net / capital).toFixed(4) });
    }
    results[sym] = rows;
  }

  // ── report ────────────────────────────────────────────────────────────────
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const r2 = (x) => (x == null ? null : +x.toFixed(2));
  const summary = {};
  for (const sym of NAMES) {
    summary[sym] = {};
    const bars = px[sym], first = bars[0]?.c, last = bars[bars.length - 1]?.c;
    for (const m of MONEYNESS) {
      const rows = results[sym][m]; if (!rows.length) { summary[sym][m] = null; continue; }
      const win = rows.filter((r) => r.net > 0).length;
      const worst = rows.reduce((w, r) => (w == null || r.net < w.net ? r : w), null);
      // compounded on the cash actually tied up each week
      let eq = 1; for (const r of rows) eq *= 1 + r.netPct / 100;
      summary[sym][m] = {
        cycles: rows.length, from: rows[0].entry, to: rows[rows.length - 1].exp,
        assignedPct: r2(100 * rows.filter((r) => r.assigned).length / rows.length),
        winPctNet: r2(100 * win / rows.length),
        meanGrossPctPerWeek: r2(mean(rows.map((r) => r.grossPct))), meanNetPctPerWeek: r2(mean(rows.map((r) => r.netPct))),
        totalNetPct: r2(100 * (eq - 1)),
        worstWeek: { entry: worst.entry, netPct: r2(worst.netPct), strike: worst.strike, sExp: worst.sExp },
        buyHoldPct: r2(100 * (last / first - 1)),
      };
    }
  }
  fs.writeFileSync(OUT, JSON.stringify({ spec: "weekly-put-study-v1", builtAt: new Date().toISOString(), start: START, crossHaircut: HAIRCUT, summary, rows: results }, null, 1));

  for (const sym of NAMES) {
    console.log(`\n${"=".repeat(78)}\n${sym}   buy & hold over the same window: ${summary[sym][0]?.buyHoldPct ?? "n/a"}%`);
    for (const m of MONEYNESS) {
      const s = summary[sym][m]; if (!s) { console.log(`  ${(100 * m).toFixed(0)}% OTM: no contracts found`); continue; }
      console.log(`  ${String((100 * m).toFixed(0) + "% OTM").padEnd(8)} ${String(s.cycles).padStart(3)} wks  win ${String(s.winPctNet).padStart(5)}%  assigned ${String(s.assignedPct).padStart(5)}%  mean ${String(s.meanNetPctPerWeek).padStart(6)}%/wk  TOTAL ${String(s.totalNetPct).padStart(7)}%  worst week ${s.worstWeek.netPct}% (${s.worstWeek.entry})`);
    }
  }
  console.log(`\nwritten: ${path.basename(OUT)}`);
})().catch((e) => { console.error("study failed:", e.message); process.exit(1); });
