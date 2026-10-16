#!/usr/bin/env node
/**
 * CROSS-SECTIONAL INSIDER OBSERVER — Phase 2 testing, step 3. (2026-08-20, operator: "insider observer third")
 *
 * The EDGAR Form 4 pipeline (insider-edgar.js) already covers the expanded universe — its
 * roster is sector-map.json, which the universe build grew to ~4,100 names. This file is the
 * CROSS-SECTIONAL turn on that data: instead of asking "what are this name's insiders doing
 * vs its own volume" (obs:insiderNet90, unchanged), it asks "where does this name's insider
 * flow RANK against every other name in the universe tonight" — a question that only exists
 * at breadth, and the one with the literature behind it (officer/director open-market
 * purchases, cross-sectionally extreme, are among the few insider effects that replicate).
 *
 * ═══ WHAT IS MEASURED, PER NAME (individual insiders only — net90Indiv) ═══
 *   netM    net officer/director open-market dollars, $M signed, trailing 90d. Entities
 *           (10% corporate holders, funds) excluded upstream — a Sumitomo treasury buy is
 *           portfolio management, not conviction.
 *   xn      netM normalized by the name's median daily dollar volume from the universe build.
 *           DECLARED BASIS: that volume is IEX-OBSERVED (~3% of tape), so xn is in "IEX-days"
 *           units — internally consistent, not comparable to obs:insiderNet90's consolidated
 *           basis. The percentile below is invariant to this scaling.
 *   pctl    cross-sectional percentile of xn among ACTIVE names (any indiv open-market P or S
 *           in 90d). 100 = heaviest relative buying in the universe; 0 = heaviest selling.
 *   buyers  distinct individual buyers (cluster buys > lone buys, per the literature).
 *
 * ═══ THE AGGREGATE DIAL (context, logged, never acted on) ═══
 *   breadth = (#net-buying − #net-selling) / #active across the whole universe — the classic
 *   slow contrarian aggregate. Snapshotted daily so a series accrues.
 *
 * ═══ HOW IT BECOMES A DIAL ═══
 *   Served at /api/insider-xsec; the app stamps obs.insiderXP (= pctl) on equity tickets.
 *   Names with NO individual open-market activity get null — silence is not a percentile.
 *   The weighted board auto-discovers obs keys: enters at weight zero, earns by the bars.
 *
 * Storage: data/insider-xsec.json — { days: { 'YYYY-MM-DD': {...} } }, last 130 sessions.
 * Pure post-processor: no network, runs in seconds, chain step right after insider-edgar.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const OUT = D("insider-xsec.json");
const etDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

(() => {
  const edgar = JSON.parse(fs.readFileSync(D("insider-edgar.json"), "utf8"));
  const uni = JSON.parse(fs.readFileSync(D("universe-expanded.json"), "utf8"));
  const dv = new Map(uni.names.map((n) => [n.sym, n.medDollarVol]));
  const today = etDay();

  // Active = at least one INDIVIDUAL open-market transaction in the lookback. A name whose
  // only Form 4s are grants/exercises is silent, not neutral — it gets no rank.
  const active = [];
  for (const [sym, v] of Object.entries(edgar.data || {})) {
    if (!dv.has(sym)) continue;                          // universe members only
    if (!Number.isFinite(v.net90Indiv)) continue;         // pre-classification cache rows
    if (!((v.indivBuys || 0) > 0 || (v.indivSells || 0) > 0)) continue;
    const mdv = dv.get(sym);
    if (!(mdv > 0)) continue;
    active.push({ sym, netM: v.net90Indiv, xn: (v.net90Indiv * 1e6) / mdv, buyers: v.distinctIndivBuyers || 0 });
  }
  active.sort((a, b) => a.xn - b.xn);
  const N = active.length;
  const bySym = {};
  active.forEach((r, i) => {
    bySym[r.sym] = { netM: +r.netM.toFixed(3), xn: +r.xn.toFixed(2), pctl: +((100 * (i + 0.5)) / N).toFixed(1), buyers: r.buyers };
  });

  const nBuy = active.filter((r) => r.netM > 0).length, nSell = active.filter((r) => r.netM < 0).length;
  const totBuyM = active.reduce((s, r) => s + Math.max(0, r.netM), 0);
  const totSellM = active.reduce((s, r) => s + Math.min(0, r.netM), 0);

  const st = (() => { try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {
    return { spec: "insider-xsec-v1", registered: "2026-08-20",
      definition: "pctl = cross-sectional percentile of net90Indiv/medDollarVol(IEX-observed) among names with any individual open-market P/S in 90d; silence = null, never 50",
      days: {} };
  } })();
  st.days[today] = {
    snapshotAt: new Date().toISOString(), edgarRefreshedAt: edgar.refreshedAt,
    universeCovered: Object.keys(edgar.data || {}).filter((s) => dv.has(s)).length, active: N,
    breadth: N ? +(((nBuy - nSell) / N).toFixed(3)) : null,
    nBuy, nSell, totBuyM: +totBuyM.toFixed(1), totSellM: +totSellM.toFixed(1),
    bySym,
  };
  const keys = Object.keys(st.days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 130))) delete st.days[k];
  writeJsonAtomic(OUT, st);

  const d = st.days[today];
  console.log(`INSIDER X-SEC — ${today}: ${d.universeCovered} universe names in EDGAR data · ${N} active (any indiv open-market P/S in 90d)`);
  console.log(`  breadth ${d.breadth} (${nBuy} net-buying vs ${nSell} net-selling) · $${totBuyM.toFixed(0)}M bought / $${Math.abs(totSellM).toFixed(0)}M sold — the usual insider posture is net-selling; the dial is the RANK, not the level`);
  const top = active.slice(-3).reverse(), bot = active.slice(0, 3);
  console.log(`  heaviest relative buying:  ${top.map((r) => `${r.sym} $${r.netM.toFixed(1)}M (${r.buyers} buyer${r.buyers === 1 ? "" : "s"})`).join(" · ")}`);
  console.log(`  heaviest relative selling: ${bot.map((r) => `${r.sym} $${r.netM.toFixed(1)}M`).join(" · ")}`);
  console.log(`written: insider-xsec.json · dial obs:insiderXP self-registers on the weighted board once tickets carry it`);
})();
