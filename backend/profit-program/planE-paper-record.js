#!/usr/bin/env node
"use strict";
/**
 * PLAN E PAPER RECORD IN DOLLARS - reads backend/data/planE-paper-scoreboard.json (the scoreboard's own output; refresh it with
 * `node backend/planE-paper-scoreboard.js --print`) and the cached inputs; prints what traded, gains, losses, fees, and tracking vs the model BY LEG.
 * READ-ONLY on the repo; offline. Writes backend/data/profit-program/planE-paper-record.json.
 *   node backend/profit-program/planE-paper-record.js
 *
 * Tracking by leg: the model is risk-manager.js buildBook with the month-end window on the CALENDAR (fixWindow) priced on the same $100,000 anchor
 * (model day $ = model day return x the paper NAV at the prior close, so a leg gap is a gap in dollars on the paper's own NAV path).
 *   ETF + cash : paper ETF leg + paper cash leg   vs  model EQUITY + GOLD + DBMF + CASH   (paper holds JAAA / SGOV where the model holds T-bills)
 *   crypto     : paper derived 50-day sleeve      vs  model CRYPTO  (model marks the UTC close of the SAME date, the paper sleeve D-1: a one-day alignment gap)
 *   ZN         : paper (R219 quote-priced)        vs  model TSY     (the model is in the September window on 09-30; the paper's ZN window opened before its start)
 */
const fs = require("fs"), path = require("path");
const M = require("./planE-model.js");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const sb = JSON.parse(fs.readFileSync(path.join(M.BACKEND, "data", "planE-paper-scoreboard.json"), "utf8"));
const usd = (x, d = 0) => (x < 0 ? "-$" : "+$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x, d = 2) => (x >= 0 ? "+" : "") + x.toFixed(d) + "%";

(async () => {
  const out = { spec: "planE-paper-record-v1", scoreboardWrittenAt: sb.writtenAt, asOf: sb.asOf, start: sb.start };
  const S = sb.summary;
  console.log(`PLAN E PAPER RECORD  ${sb.start} .. ${sb.asOf}  (${S.sessionsOnRecord} sessions after the start close; scoreboard status ${sb.status}, written ${sb.writtenAt})`);
  console.log(`NAV $${sb.anchor.toLocaleString()} -> $${S.nav.toFixed(2)}  =  ${usd(S.cumUsd, 2)} (${pct(S.cumPct)})   max drawdown ${pct(S.maxDdPct)} (${usd(sb.anchor * S.maxDdPct / 100)})   one-month mark ${S.oneMonthMark} (${S.sessionsToMark} sessions to go)`);
  console.log(`vs model (scoreboard) ${pct(S.modelCumPct)} = ${usd(sb.anchor * S.modelCumPct / 100)} -> paper minus model ${usd(sb.anchor * S.vsModelPp / 100)} (${S.vsModelPp.toFixed(2)} pp);  vs SPY buy-and-hold ${pct(S.spyCumPct)} = ${usd(sb.anchor * S.spyCumPct / 100)}`);

  // --- by leg
  const legs = ["etf", "crypto", "zn", "cash"], cum = Object.fromEntries(legs.map((l) => [l, sb.daily.reduce((s, d) => s + (d.contrib[l] || 0), 0)]));
  const tot = legs.reduce((s, l) => s + cum[l], 0);
  console.log("\nBY LEG (sum of daily dollar contributions)");
  const alloc = { ...sb.legs.allocation, zn: 0 };   // ZN has no allocation of its own: its margin sits in the 12% cash reserve
  for (const l of legs) console.log(`  ${l.toUpperCase().padEnd(7)} allocated ${alloc[l].toLocaleString().padStart(7)}   P&L ${usd(cum[l], 2).padStart(11)}   ${alloc[l] ? (100 * cum[l] / alloc[l]).toFixed(2) + "% on its own allocation" : "(no ZN position on the record; the 09-2026 window opened before the start)"}`);
  console.log(`  TOTAL                       ${usd(tot, 2).padStart(11)}   (scoreboard NAV change ${usd(S.cumUsd, 2)})`);
  out.byLeg = Object.fromEntries(legs.map((l) => [l, { allocUsd: alloc[l], pnlUsd: +cum[l].toFixed(2) }]));

  // --- trades
  console.log("\nWHAT TRADED (the scoreboard's trade log; [F] broker fill, [D] derived at the Coinbase UTC close - not a fill)");
  console.log("  leg    sym   status  entry date       qty        entry px     exit/mark px   P&L $     %      fees $");
  let realized = 0, unreal = 0, feesTot = 0;
  for (const t of sb.trades) {
    const ex = t.exit || t.mark; realized += t.status === "CLOSED" ? t.gainUsd : 0; unreal += t.status === "OPEN" ? t.gainUsd : 0; feesTot += t.feesUsd || 0;
    console.log(`  ${t.leg.padEnd(6)} ${t.sym.padEnd(5)} ${t.status.padEnd(6)} ${t.entry.date} ${t.entry.time.padEnd(9)} ${String(+t.qty.toFixed(4)).padStart(9)} ${String(t.entry.px).padStart(11)} ${String(ex.px).padStart(13)}   ${usd(t.gainUsd, 2).padStart(9)} ${pct(t.gainPct).padStart(7)} ${("$" + (t.feesUsd || 0).toFixed(2)).padStart(8)}`);
  }
  const closed = sb.trades.filter((t) => t.status === "CLOSED"), wins = closed.filter((t) => t.gainUsd > 0), losses = closed.filter((t) => t.gainUsd <= 0);
  console.log(`  closed ${closed.length} (${wins.length} win / ${losses.length} loss): realized ${usd(realized, 2)} (gains ${usd(wins.reduce((s, t) => s + t.gainUsd, 0), 2)}, losses ${usd(losses.reduce((s, t) => s + t.gainUsd, 0), 2)});  open ${sb.trades.filter((t) => t.status === "OPEN").length} lots: unrealized ${usd(unreal, 2)};  fees ${("$" + feesTot.toFixed(2))} of which crypto (ASSUMED 25 bps) $${sb.trades.filter((t) => t.leg === "crypto").reduce((s, t) => s + (t.feesUsd || 0), 0).toFixed(2)}`);
  out.trades = { closed: closed.length, wins: wins.length, losses: losses.length, realizedUsd: +realized.toFixed(2), unrealizedUsd: +unreal.toFixed(2), feesUsd: +feesTot.toFixed(2) };

  // --- the daily table in dollars
  console.log("\nDAILY $ (paper vs model)");
  console.log("  date        NAV           day $    ETF $   CRYPTO $   ZN $   CASH $    paper%   model%  track pp");
  for (const d of sb.daily) console.log(`  ${d.date}  ${("$" + d.nav.toFixed(2)).padStart(11)}  ${usd(d.dayUsd, 0).padStart(7)}  ${usd(d.contrib.etf, 0).padStart(7)} ${usd(d.contrib.crypto, 0).padStart(8)} ${usd(d.contrib.zn, 0).padStart(6)} ${usd(d.contrib.cash, 0).padStart(7)}   ${d.dayPct.toFixed(2).padStart(6)}  ${d.modelPct == null ? "   start" : d.modelPct.toFixed(2).padStart(7)}  ${d.trackingPp == null ? "" : d.trackingPp.toFixed(2).padStart(7)}`);

  // --- tracking by leg vs the model (calendar window)
  const inp = M.loadInputs(), r = await M.rmRows(inp, { asOf: sb.asOf, fixWindow: true });
  const rd = M.rmDaily(r.rows, { w: M.E_W, zn: 4.2 }, {}), byDate = new Map(rd.map((x) => [x.d, x]));
  const model = { etfcash: 0, crypto: 0, zn: 0 }, paper = { etfcash: 0, crypto: 0, zn: 0 };
  let prevNav = sb.anchor;
  const rowsOut = [];
  for (const d of sb.daily) {
    if (d.start) { prevNav = d.nav; continue; }
    const m = byDate.get(d.date); if (!m) continue;
    const mEtf = (m.legs.EQUITY + m.legs.GOLD + m.legs.DBMF + m.legs.CASH) * prevNav, mCry = m.legs.CRYPTO * prevNav, mZn = m.legs.ZN * prevNav;
    model.etfcash += mEtf; model.crypto += mCry; model.zn += mZn; paper.etfcash += d.contrib.etf + d.contrib.cash; paper.crypto += d.contrib.crypto; paper.zn += d.contrib.zn;
    rowsOut.push({ d: d.date, modelEtfCash: +mEtf.toFixed(2), paperEtfCash: +(d.contrib.etf + d.contrib.cash).toFixed(2), modelCrypto: +mCry.toFixed(2), paperCrypto: +d.contrib.crypto.toFixed(2), modelZn: +mZn.toFixed(2), paperZn: +d.contrib.zn.toFixed(2) });
    prevNav = d.nav;
  }
  const mTot = model.etfcash + model.crypto + model.zn, pTot = paper.etfcash + paper.crypto + paper.zn;
  console.log("\nTRACKING BY LEG, dollars on the paper NAV path (model = risk-manager buildBook, calendar window, weights of a $100k book)");
  console.log("  leg            paper $        model $        paper - model");
  for (const [k, lab] of [["etfcash", "ETF + cash"], ["crypto", "CRYPTO"], ["zn", "ZN"]]) console.log(`  ${lab.padEnd(12)} ${usd(paper[k], 0).padStart(10)} ${usd(model[k], 0).padStart(14)} ${usd(paper[k] - model[k], 0).padStart(14)}`);
  console.log(`  ${"TOTAL".padEnd(12)} ${usd(pTot, 0).padStart(10)} ${usd(mTot, 0).padStart(14)} ${usd(pTot - mTot, 0).padStart(14)}   (the scoreboard's own model line is ${usd(sb.anchor * S.modelCumPct / 100, 0)}; this rebuild's is a few $ different: crypto aligned on the same UTC date, T-bill = DTB3 carried)`);
  out.trackingByLeg = { paper, model, rows: rowsOut };
  writeJsonAtomic(path.join(M.BACKEND, "data", "profit-program", "planE-paper-record.json"), out);
  console.log("\nwrote backend/data/profit-program/planE-paper-record.json");
})().catch((e) => { console.error("planE-paper-record FAILED:", e.stack); process.exit(1); });
