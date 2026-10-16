#!/usr/bin/env node
/**
 * TRAIDS — 13F "BEST IDEAS" CLONE (test #38) — HISTORY
 *
 * HYPOTHESIS (literature: Cohen/Polk/Silli "Best Ideas"): the LARGEST, highest-conviction positions of concentrated managers
 * outperform even at the mandated 45-day disclosure lag, because the edge is slow. The productized clones (GURU/ALFA) failed by
 * cloning BREADTH — this tests concentration.
 *
 * PRE-REGISTERED DESIGN (fixed before running, 2026-07-23):
 *   • Managers (8, chosen for concentration + long records): Berkshire, Pershing Square, Baupost, Greenlight, Third Point,
 *     Appaloosa, Scion, Duquesne.
 *   • Signal: each manager's TOP-3 equity positions by reported value in each original 13F-HR (amendments skipped), quarters
 *     2017-12-31 -> latest.
 *   • Portfolio: equal-weight UNION of all managers' top-3 (deduped), formed at the close of the first trading day AFTER the
 *     filing-window close for that quarter; held to the next formation. No look-ahead: only filings already on EDGAR at formation.
 *   • Prices: Alpaca daily bars (adjustment=all) via the local :3001 bars endpoint. Names with no price are DROPPED AND COUNTED.
 *   • Costs: 10 bps x measured turnover per rebalance. Benchmark: SPY, same dates. Metric: quarterly excess return
 *     (non-overlapping cohorts). VERDICT BAR: mean quarterly excess > 0, t >= 2 full-sample, AND same sign in the last-40% OOS
 *     split. Low power at n ~ 30 quarters is inherent and disclosed; a pass is suggestive, a fail is a fail.
 *
 * FIX 2026-10-02 (operator: "fix this" — r24-attribution.js found 8 of the 16 open-cohort names came from stale or wrong filings).
 * The rule above was not what the code did. Now, through ONE config shared with best-ideas-forward.js (backend/lib/r24-managers.js):
 *   (a) a manager contributes only its original 13F-HR for THAT period, accepted by 16:00 ET on the formation day;
 *   (b) CIKs are fixed per period and verified (Baupost had been a 2002 /ADV shell, so it never contributed; Greenlight moved to DME
 *       Capital Management from 2024-03-31; Pershing to Pershing Square Inc. from 2026-06-30; Scion stops after 2025-09-30);
 *   (c) formation = the close of the first NYSE session after the window close (day 45, rolled to the next federal business day),
 *       from the NYSE calendar — it used to be the date of the LATEST filing among managers, priced at that day's close even when
 *       the filing landed after the close;
 *   (d) CUSIPs with no ticker are listed per cohort (skippedUnmapped); obvious live listings are mapped in CUSIP_OVERRIDES.
 * The pre-fix code is kept at docs/r24-fix/best-ideas-13f.js.orig-2026-10-02.
 *
 * Usage: node backend/best-ideas-13f.js [--sip]
 *   --sip   sensitivity: price from Alpaca SIP daily bars directly (full history from 2017-12) instead of the :3001 endpoint, whose
 *           feed on this server starts ~2018-11 for SPY and ~2020-07 for most names (A0925-IEX), which drops the 2017-2019 quarters
 *           and mis-dates the first 2020 cohort's entries.
 */
"use strict";
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const R = require("./lib/r24-managers.js");
const CUSIP_CACHE = path.join(__dirname, "data", "cusip-map.json");
const SIP = process.argv.includes("--sip");
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
const cum = (a) => a.reduce((s, v) => s * (1 + v), 1) - 1;
const pc = (x, d = 2) => (x * 100).toFixed(d) + "%";

function alpacaHeaders() {
  if (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET_KEY) throw new Error("ALPACA_KEY_ID / ALPACA_SECRET_KEY missing — the NYSE calendar (and --sip bars) need them");
  return { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
}
async function calendar() {
  const r = await fetch("https://paper-api.alpaca.markets/v2/calendar?start=2017-12-01&end=" + R.addDays(new Date().toISOString().slice(0, 10), 200), { headers: alpacaHeaders() });
  if (!r.ok) throw new Error(`Alpaca calendar ${r.status}`);
  return (await r.json()).map((d) => d.date).sort();
}
async function serverBars(tickers) {
  const out = {};
  for (let i = 0; i < tickers.length; i += 80) {
    try {
      const r = await fetch("http://localhost:3001/api/equities/bars", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: tickers.slice(i, i + 80), days: 3200 }) });
      if (r.ok) { const d = (await r.json()).data || {}; for (const s in d) if (d[s]) out[s] = d[s].map((b) => ({ t: String(b.t).slice(0, 10), c: b.c })); }
    } catch {}
  }
  return out;
}
async function sipBars(tickers) {
  const out = {}, end = new Date(Date.now() - 20 * 60e3).toISOString();
  for (let i = 0; i < tickers.length; i += 50) {
    let token = null;
    do {
      const q = new URLSearchParams({ symbols: tickers.slice(i, i + 50).join(","), timeframe: "1Day", start: "2017-12-01", end, adjustment: "all", feed: "sip", limit: "10000" });
      if (token) q.set("page_token", token);
      const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${q}`, { headers: alpacaHeaders() });
      if (!r.ok) throw new Error(`Alpaca SIP bars ${r.status}`);
      const j = await r.json();
      for (const s in j.bars || {}) (out[s] ||= []).push(...j.bars[s].map((b) => ({ t: b.t.slice(0, 10), c: b.c })));
      token = j.next_page_token || null;
    } while (token);
  }
  return out;
}

(async () => {
  console.log(`\n  TRAIDS — 13F BEST-IDEAS CLONE (test #38) · top-3 conviction positions of 8 concentrated managers · rule r24-fix-2026-10-02 · prices: ${SIP ? "Alpaca SIP (sensitivity)" : ":3001 bars endpoint (registered)"}\n`);
  for (const m of R.MANAGERS) console.log(`  ${m.name.padEnd(36)} ${m.filers.map((f) => `${f.cik} ${f.entity}${f.from || f.to ? ` [${f.from || "…"}..${f.to || "…"}]` : ""}`).join(" → ")}`);

  const cal = await calendar();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const past = cal.filter((d) => d < today);
  const periods = R.quarterEnds("2017-12-31", today).filter((p) => { const F = R.formationDate(p, cal); return F && past.includes(F); });
  console.log(`\n  formable periods: ${periods.length} (${periods[0]} → ${periods[periods.length - 1]}) · reading EDGAR (one request at a time, >= 150 ms apart)…`);

  const memo = {};
  const getFilings = async (cik) => (memo[cik] ||= await R.filings13F(cik));
  const members = [];
  for (const p of periods) { members.push(await R.cohortMembers(p, R.formationDate(p, cal), { getFilings, getHoldings: R.holdingsOf })); process.stdout.write("."); }
  console.log("");

  let cache = {}; try { cache = JSON.parse(fs.readFileSync(CUSIP_CACHE, "utf8")); } catch {}
  const allC = [...new Set(members.flatMap((c) => [...c.cusips.keys()]))];
  const add = await R.openFigi(allC, cache);
  if (Object.keys(add).length) { cache = { ...cache, ...add }; writeJsonAtomic(CUSIP_CACHE, cache, { pretty: 0 }); }
  const tk = (c) => R.tickerOf(c, cache).ticker;
  const tickers = [...new Set(allC.map(tk).filter(Boolean))];
  const bars = SIP ? await sipBars([...tickers, "SPY"]) : await serverBars([...tickers, "SPY"]);
  for (const s in bars) bars[s] = bars[s].filter((b) => b.t < today);           // completed sessions only
  console.log(`  distinct positions ${allC.length} · tickers ${tickers.length} · priced ${Object.keys(bars).length - (bars.SPY ? 1 : 0)} + SPY`);
  const onOrAfter = (s, d) => { const b = bars[s]; if (!b) return null; const x = b.find((y) => y.t >= d); return x ? { px: x.c, t: x.t } : null; };

  const cohorts = [], excluded = [];
  for (let i = 0; i < members.length - 1; i++) {
    const c = members[i], formDate = c.formation, endDate = members[i + 1].formation;
    const tks = [...new Set([...c.cusips.keys()].map(tk).filter(Boolean))];
    const skippedUnmapped = [...c.cusips.entries()].filter(([x]) => !tk(x)).map(([x, v]) => ({ cusip: x, issuer: v.issuer, managers: v.managers }));
    const legs = [], noPrice = [];
    for (const t of tks) { const p0 = onOrAfter(t, formDate), p1 = onOrAfter(t, endDate); if (!p0 || !p1 || p1.t <= p0.t) { noPrice.push(t); continue; } legs.push({ tk: t, ret: p1.px / p0.px - 1 }); }
    if (legs.length < 5) { excluded.push(`${c.period}: ${legs.length} priced legs`); continue; }
    const s0 = onOrAfter("SPY", formDate), s1 = onOrAfter("SPY", endDate);
    if (!s0 || !s1) { excluded.push(`${c.period}: no SPY`); continue; }
    const held = new Set(legs.map((l) => l.tk)), prev = cohorts.length ? cohorts[cohorts.length - 1].held : null;
    const turnover = prev ? 1 - [...held].filter((t) => prev.has(t)).length / held.size : 1;
    cohorts.push({ q: c.period, formDate, endDate, n: legs.length, held, noPrice, skippedUnmapped, managersIn: c.managers.filter((m) => m.contributes).length, port: mean(legs.map((l) => l.ret)) - 0.001 * turnover, spy: s1.px / s0.px - 1 });
  }

  console.log(`\n  quarter      formed       held to      mgrs   n   portfolio      SPY     excess   skippedUnmapped / unpriced`);
  console.log("  " + "-".repeat(118));
  for (const c of cohorts) console.log(`  ${c.q}   ${c.formDate}   ${c.endDate}   ${c.managersIn}/8 ${String(c.n).padStart(3)} ${pc(c.port).padStart(10)} ${pc(c.spy).padStart(9)} ${pc(c.port - c.spy).padStart(9)}   ${[...c.skippedUnmapped.map((u) => u.issuer), ...c.noPrice.map((t) => t + " (no price)")].join("; ")}`);
  if (excluded.length) console.log(`  excluded (fewer than 5 priced legs or no SPY): ${excluded.join(" | ")}`);

  const ex = cohorts.map((c) => c.port - c.spy), t = tOf(ex), cut = Math.floor(ex.length * 0.6), oos = ex.slice(cut);
  console.log(`\n  ── PRE-REGISTERED VERDICT (test #38) ──`);
  console.log(`    quarters: ${ex.length} (${cohorts[0] && cohorts[0].q} → ${cohorts.length && cohorts[cohorts.length - 1].q}) · mean quarterly excess ${pc(mean(ex))} · t = ${t.toFixed(2)}`);
  console.log(`    cumulative: portfolio ${pc(cum(cohorts.map((c) => c.port)), 1)} vs SPY ${pc(cum(cohorts.map((c) => c.spy)), 1)}`);
  console.log(`    OOS (last 40%, ${oos.length} quarters from ${cohorts[cut] && cohorts[cut].q}): mean excess ${pc(mean(oos))}/qtr · t = ${tOf(oos).toFixed(2)}`);
  const pass = mean(ex) > 0 && t >= 2 && mean(oos) > 0;
  console.log(pass ? `    ★ CLEARS the bar (mean>0, t≥2, OOS same sign) — goes to the approval queue as an allocation candidate, not a trading signal.`
    : `    ✕ Does NOT clear the pre-registered bar (need mean>0 AND t≥2 AND OOS same sign). Not established.`);
  const years = {};
  for (const c of cohorts) (years[c.formDate.slice(0, 4)] ||= []).push(c);
  console.log(`\n    per year (cohorts grouped by formation year, quarterly returns compounded)\n    year   q   portfolio      SPY     excess`);
  for (const [y, a] of Object.entries(years)) { const P = cum(a.map((c) => c.port)), S = cum(a.map((c) => c.spy)); console.log(`    ${y} ${String(a.length).padStart(3)} ${pc(P, 1).padStart(10)} ${pc(S, 1).padStart(9)} ${pc(P - S, 1).padStart(9)}`); }
  const nUnm = cohorts.reduce((s, c) => s + c.skippedUnmapped.length, 0);
  console.log(`\n    Disclosed: adjusted closes (adjustment=all: splits and dividends) on both sides, ${nUnm} unmapped top-3 slots across cohorts (listed above), low power at n≈${ex.length} quarters; managers picked in 2026 for long records (D24).\n`);
})().catch((e) => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
