#!/usr/bin/env node
/**
 * R13 — PRE-MARKET NEWS → INTRADAY DRIFT. Registered before running (test-registry.json).
 *
 * Operator: "we should catch the news early and capitalize on the movements even if shorter
 * timed trades." On 2026-08-03 every headline behind the day's movers was published 04:33-08:42
 * ET while the moves happened 09:30-09:50 — Corning's upgrade hit at 05:30, the stock opened
 * repriced at 134.78 and still ran to 146.18 during the session.
 *
 * RULE (fixed in advance): symbol has >=1 news article 04:00-09:25 ET AND opens >= +2% above
 * the prior close. Buy the OPEN, sell the CLOSE, same session. Excess = stock (open->close)
 * minus SPY (open->close).
 *
 * WHY SAME-DAY: power. R12 died on overlapping 63-day windows (~13 independent periods in 3
 * years). A same-day hold does not overlap the next session, so each trading day is one
 * independent observation and 2.5 years gives ~640.
 *
 * BAR: |t| >= 3.5 (searched-result bar), day-clustered, AND net of 2x spread must stay positive.
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const D = (f) => path.join(__dirname, "data", f);
const AH = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
const nap = (ms) => new Promise(r => setTimeout(r, ms));
const GAP_MIN = 2.0;                 // % — registered, may not be re-tuned
const SPREAD_BPS_PER_SIDE = 10;      // from test #45; round trip = 2x
const START = "2024-01-01", END = "2026-07-31";

const etParts = (iso) => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const p = {}; for (const o of f.formatToParts(new Date(iso))) if (o.type !== "literal") p[o.type] = o.value;
  return { day: `${p.year}-${p.month}-${p.day}`, min: (parseInt(p.hour) % 24) * 60 + parseInt(p.minute) };
};

// ── 1. collect pre-market-news symbols per day (cached — the crawl is the slow part) ────────
async function collectNews() {
  const CACHE = D("r13-news.json");
  if (fs.existsSync(CACHE) && !process.argv.includes("--refresh")) {
    const c = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    console.log(`loaded cached pre-market news for ${Object.keys(c.byDay).length} days (${c.collectedAt})\n`);
    return c.byDay;
  }
  const byDay = {};
  let token = null, pages = 0, articles = 0;
  do {
    const p = new URLSearchParams({ start: `${START}T00:00:00Z`, end: `${END}T23:59:59Z`, limit: "50", sort: "asc" });
    if (token) p.set("page_token", token);
    let j = null;
    for (let a = 0; a < 4 && !j; a++) {
      try {
        const r = await fetch(`https://data.alpaca.markets/v1beta1/news?${p}`, { headers: AH, signal: AbortSignal.timeout(45000) });
        if (r.status === 429) { await nap(3000 * (a + 1)); continue; }
        if (!r.ok) break;
        j = await r.json();
      } catch { await nap(1500); }
    }
    if (!j) break;
    for (const n of (j.news || [])) {
      articles++;
      const { day, min } = etParts(n.created_at);
      if (min < 4 * 60 || min > 9 * 60 + 25) continue;      // pre-market window only
      for (const s of (n.symbols || [])) (byDay[day] ||= new Set()).add(s);
    }
    token = j.next_page_token || null;
    if (++pages % 40 === 0) process.stdout.write(`  page ${pages} · ${articles} articles · ${Object.keys(byDay).length} days\r`);
    await nap(260);
  } while (token && pages < 6000);
  const plain = Object.fromEntries(Object.entries(byDay).map(([k, v]) => [k, [...v]]));
  fs.writeFileSync(D("r13-news.json"), JSON.stringify({ collectedAt: new Date().toISOString(), articles, byDay: plain }));
  console.log(`\ncollected ${articles} articles → pre-market news on ${Object.keys(plain).length} days\n`);
  return plain;
}

// ── 2. prices ───────────────────────────────────────────────────────────────────────────────
const bars = {};
async function fetchBars(list) {
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25); let token = null;
    do {
      const p = new URLSearchParams({ symbols: chunk.join(","), timeframe: "1Day", start: "2023-11-01", end: "2026-08-01", limit: "10000", feed: "iex", adjustment: "all" });
      if (token) p.set("page_token", token);
      try {
        const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${p}`, { headers: AH, signal: AbortSignal.timeout(60000) });
        if (!r.ok) break;
        const j = await r.json();
        for (const [k, v] of Object.entries(j.bars || {})) bars[k] = (bars[k] || []).concat(v);
        token = j.next_page_token || null;
      } catch { break; }
      await nap(320);
    } while (token);
    process.stdout.write(`  priced ${Object.keys(bars).length}/${list.length}\r`);
  }
}

(async () => {
  const byDay = await collectNews();
  const days = Object.keys(byDay).sort();
  const universe = [...new Set(days.flatMap(d => byDay[d]))].filter(s => /^[A-Z]{1,5}$/.test(s));
  console.log(`${days.length} days · ${universe.length} distinct symbols ever carrying pre-market news`);
  await fetchBars(["SPY"]);
  if (!bars.SPY || bars.SPY.length < 300) { console.error("ABORT: no SPY"); process.exit(1); }
  await fetchBars(universe);
  console.log(`\npriced ${Object.keys(bars).length - 1} symbols\n`);

  const idx = {}; for (const [k, v] of Object.entries(bars)) idx[k] = new Map(v.map((b, i) => [String(b.t).slice(0, 10), i]));
  const spy = bars.SPY, spyIdx = idx.SPY;

  const perDay = [];                 // one observation per trading day
  let events = 0;
  for (const d of days) {
    const si = spyIdx.get(d); if (si == null) continue;
    const spyOC = (spy[si].c / spy[si].o - 1) * 100;
    const hits = [];
    for (const s of byDay[d]) {
      const b = bars[s], ii = idx[s]?.get(d);
      if (!b || ii == null || ii < 1) continue;
      const gap = (b[ii].o / b[ii - 1].c - 1) * 100;
      if (!(gap >= GAP_MIN)) continue;                     // registered condition
      const oc = (b[ii].c / b[ii].o - 1) * 100;
      hits.push(oc - spyOC);
      events++;
    }
    if (hits.length) perDay.push({ day: d, n: hits.length, mean: hits.reduce((a, x) => a + x, 0) / hits.length });
  }
  const xs = perDay.map(p => p.mean);
  const m = xs.reduce((a, x) => a + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  const se = sd / Math.sqrt(xs.length), t = m / se;
  const cost = 2 * SPREAD_BPS_PER_SIDE / 100;              // pp, round trip
  const netM = m - cost, netT = netM / se;

  console.log(`RESULT — pre-market news + gap >= +${GAP_MIN}%, buy open / sell close, market-relative`);
  console.log(`  qualifying events            ${events}`);
  console.log(`  INDEPENDENT trading days     ${xs.length}   <- each day is one observation, no overlap`);
  console.log(`  GROSS mean excess / trade    ${(m >= 0 ? "+" : "") + m.toFixed(3)} pp   (t ${t.toFixed(2)})`);
  console.log(`  round-trip cost @${SPREAD_BPS_PER_SIDE}bps/side  -${cost.toFixed(3)} pp`);
  console.log(`  NET mean excess / trade      ${(netM >= 0 ? "+" : "") + netM.toFixed(3)} pp   (t ${netT.toFixed(2)})`);
  console.log(`  days positive                ${perDay.filter(p => p.mean > 0).length}/${xs.length}`);
  const pass = netM > 0 && Math.abs(netT) >= 3.5;
  console.log(`\n  BAR: net mean > 0 AND |t| >= 3.5 (searched-result bar)`);
  console.log(`  VERDICT: ${pass ? "CLEARS — proceed to out-of-sample split and real-quote costs" : "DOES NOT CLEAR → R13 is DEAD; no intraday execution loop gets built"}`);
  console.log(`  Implied Sharpe sanity check: ${(netT / Math.sqrt(xs.length / 252)).toFixed(2)} annualized${Math.abs(netT / Math.sqrt(xs.length / 252)) > 1.5 ? "  <-- IMPLAUSIBLE, treat as defect signal" : ""}`);
  fs.writeFileSync(D("r13-news-drift.json"), JSON.stringify({ ranAt: new Date().toISOString(), gapMin: GAP_MIN, events, days: xs.length, grossMeanPp: +m.toFixed(4), grossT: +t.toFixed(3), costPp: cost, netMeanPp: +netM.toFixed(4), netT: +netT.toFixed(3), pass, perDay }, null, 1));
  console.log(`\nwritten: r13-news-drift.json`);
})();
