#!/usr/bin/env node
/**
 * TRAIDS — DAILY FORECAST (R19). Registered 2026-08-05, BEFORE the first call was recorded.
 *
 * WHY THIS EXISTS. The operator's claim is that the day's run is readable in advance: "predict
 * the run, daily market, daily news trend — should be easy to see." That is a genuinely
 * testable claim, and it is the right kind of claim, because it is falsifiable and cheap.
 *
 * So this does not argue. It writes a CALL DOWN BEFORE THE SESSION and grades it afterwards
 * against what actually happened. Same pattern as R7's scanner shadow, which is the only
 * honest way to evaluate a forecast: recorded first, graded later, never re-read after the
 * fact.
 *
 * THE FAILURE MODE IT IS BUILT AGAINST. "It was obvious" is almost always a memory artifact —
 * the days that were obvious in hindsight are the ones you remember, and the ambiguous ones
 * vanish. A forecast log has no such memory. If the run really is easy to see, this beats a
 * coin flip quickly and visibly, and that is a result worth having. If it does not, the log
 * says so with no room to renegotiate.
 *
 * FAILS CLOSED. Every input is asserted live with a timestamp. If a real quote or a real news
 * count cannot be fetched, this records NOTHING for that field rather than a default — a
 * forecast graded against invented inputs grades nothing. (Standing live-data rule.)
 *
 * NOTHING HERE TRADES. It is a scorecard. Weighting the board by any of it requires clearing
 * the R18/R19 bars first.
 *
 * Usage:
 *   node backend/daily-forecast.js           record today's call (idempotent per ET day)
 *   node backend/daily-forecast.js --grade   grade every open call whose outcome is now known
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const STATE = D("daily-forecast.json");
const API = process.env.TRAIDS_API || "http://localhost:3001";

const etDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const rd = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };

async function jget(url, ms = 20000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// The bars endpoint is a POST taking {symbols, days} — same call traids-alerts.js makes.
async function bars(symbols, days) {
  try {
    const r = await fetch(`${API}/api/equities/bars`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols, days }), signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) return {};
    return (await r.json()).data || {};
  } catch { return {}; }
}

/**
 * MARKET STATE — from real SPY bars only. Returns null on any failure; null means this field
 * is simply absent from the call, never zero and never "flat".
 */
// WHOLE MARKET FIRST, THEN DISSECT — the operator's stated order of operations. SPY sets the
// regime; the sector ETFs say what is actually carrying it. Breadth (how many sectors are
// above their own 20d) is the dissection that a single index level hides: SPY can be green on
// two megacap sectors while seven are red, and that is a different market than a broad rally.
const SECTORS = { XLK: "tech", XLF: "financials", XLE: "energy", XLV: "health", XLI: "industrials", XLY: "discretionary", XLP: "staples", XLU: "utilities", XLB: "materials" };

function sma(c, n) { return c.slice(-n).reduce((s, x) => s + x, 0) / n; }

async function marketState() {
  const syms = ["SPY", ...Object.keys(SECTORS)];
  const d = await bars(syms, 40);
  const spy = (d.SPY || []).filter(b => Number.isFinite(b?.c));
  if (spy.length < 21) return null;                     // fail closed
  const c = spy.map(b => b.c), last = c[c.length - 1];
  const rets = c.slice(1).map((x, i) => (x - c[i]) / c[i]).slice(-20);
  const vol20 = Math.sqrt(rets.reduce((s, x) => s + x * x, 0) / rets.length) * Math.sqrt(252);

  // dissection — each sector graded on its OWN trend and its 5d run
  const sectors = {};
  for (const s in SECTORS) {
    const b = (d[s] || []).filter(x => Number.isFinite(x?.c));
    if (b.length < 21) continue;                        // absent, never defaulted
    const sc = b.map(x => x.c), sl = sc[sc.length - 1];
    sectors[SECTORS[s]] = { above20: sl > sma(sc, 20), ret5: +(100 * (sl - sc[sc.length - 6]) / sc[sc.length - 6]).toFixed(2) };
  }
  const have = Object.keys(sectors).length;
  const breadth = have ? Object.values(sectors).filter(x => x.above20).length / have : null;

  return {
    asOfBar: spy[spy.length - 1].t || spy[spy.length - 1].date || null,
    spy: +last.toFixed(2),
    aboveSma20: last > sma(c, 20),
    ret5: +(100 * (last - c[c.length - 6]) / c[c.length - 6]).toFixed(2),
    vol20: +(100 * vol20).toFixed(1),
    n: spy.length,
    sectorsRead: have,
    breadth: breadth == null ? null : +breadth.toFixed(2),
    sectors,
  };
}

/**
 * NEWS TREND — real headline counts only. The operator named war news, political news,
 * manufacturing/econ prints and earnings as the drivers, so those are the buckets.
 *
 * DELIBERATELY COARSE. This counts headlines by topic; it does not score sentiment. A
 * sentiment number invented from a headline count would be exactly the kind of confident
 * fabrication the live-data rule exists to prevent, and 2026-08-05's measurement showed the
 * existing polSent/econSent observers are already DEGENERATE (they collapse to one value per
 * session and therefore carry an effective n of 1). Counting is honest; scoring is not, yet.
 */
// Sources, in order. Finnhub's general feed is macro-wide (we hold the key); CNBC and Yahoo
// RSS are the operator's named sources and need no key. Ticker-level feeds (Zacks etc.) are
// deliberately NOT used here — they say nothing about war, tariffs or an ISM print.
async function fetchHeadlines() {
  const out = [];
  const FH = process.env.FINNHUB_API_KEY || process.env.FINNHUB_KEY;
  if (FH) {
    const j = await jget(`https://finnhub.io/api/v1/news?category=general&token=${FH}`, 25000);
    if (Array.isArray(j)) for (const x of j) out.push({ t: `${x.headline || ""} ${x.summary || ""}`, src: "finnhub" });
  }
  const RSS = [
    ["cnbc",  "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114"],
    ["yahoo", "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US"],
  ];
  for (const [src, url] of RSS) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) continue;
      const xml = await r.text();
      for (const m of xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gs)) {
        const t = m[1].trim();
        if (t && !/^(CNBC|Yahoo)/i.test(t)) out.push({ t, src });
      }
    } catch { /* a source that is down contributes nothing; it never contributes a default */ }
  }
  return out;
}

async function newsState() {
  const items = await fetchHeadlines();
  if (!items.length) return null;                       // fail closed: absent, not zero
  const bySrc = {};
  for (const x of items) bySrc[x.src] = (bySrc[x.src] || 0) + 1;
  const txt = items.map(x => x.t.toLowerCase());
  const count = (re) => txt.filter(t => re.test(t)).length;
  return {
    n: items.length,
    sources: bySrc,
    war: count(/\bwar\b|strike|missile|troops|ceasefire|military|conflict|invasion/),
    political: count(/trump|white house|tariff|congress|senate|executive order|sanction/),
    macro: count(/\bism\b|manufactur|payroll|\bcpi\b|\bppi\b|inflation|\bfed\b|rate cut|gdp|jobless/),
    earnings: count(/earnings|guidance|beat|miss|quarterly result|\beps\b/),
  };
}

/**
 * THE CALL. Direction is derived MECHANICALLY from the inputs above so it cannot be revised
 * after the fact. A human-adjustable forecast is not gradeable — the whole point is that the
 * rule is fixed and the log is written before the outcome.
 */
function makeCall(mkt, news) {
  if (!mkt) return null;
  let score = 0;
  const because = [];
  if (mkt.aboveSma20) { score += 1; because.push("SPY above 20d"); } else { score -= 1; because.push("SPY below 20d"); }
  if (mkt.ret5 > 0.5) { score += 1; because.push(`5d +${mkt.ret5}%`); }
  else if (mkt.ret5 < -0.5) { score -= 1; because.push(`5d ${mkt.ret5}%`); }
  // Breadth is the dissection doing work: a rally carried by 2 of 9 sectors is narrower than
  // the index level suggests, and narrow rallies are the ones that reverse without warning.
  if (mkt.breadth != null) {
    if (mkt.breadth >= 0.67) { score += 1; because.push(`broad (${Math.round(mkt.breadth * mkt.sectorsRead)}/${mkt.sectorsRead} sectors above 20d)`); }
    else if (mkt.breadth <= 0.33) { score -= 1; because.push(`narrow (${Math.round(mkt.breadth * mkt.sectorsRead)}/${mkt.sectorsRead} sectors above 20d)`); }
  }
  if (news) {
    // War/political headline density is treated as a RISK flag, not a direction. Which way
    // geopolitics resolves is not predictable from a headline count, and pretending otherwise
    // would be the "confident about noise" failure. It only dampens conviction.
    const risk = news.war + news.political;
    if (risk >= Math.max(6, news.n * 0.25)) { because.push(`heavy war/political flow (${risk}/${news.n})`); score = score > 0 ? score - 1 : score + 1; }
  }
  return {
    direction: score > 0 ? "UP" : score < 0 ? "DOWN" : "FLAT",
    conviction: Math.abs(score),          // 0-2; graded separately so calibration is visible
    because,
  };
}

(async () => {
  const grading = process.argv.includes("--grade");
  const st = rd(STATE, { spec: "r19-v1", registered: "2026-08-05", calls: {}, graded: {} });

  if (!grading) {
    const day = etDay();
    if (st.calls[day]) { console.log(`R19 · call for ${day} already recorded — not overwriting (a forecast you can rewrite is not a forecast).`); return; }
    const [mkt, news] = await Promise.all([marketState(), newsState()]);
    if (!mkt) { console.error("R19 · ABORT — no real SPY bars. Recording nothing rather than a defaulted call."); process.exit(1); }
    const call = makeCall(mkt, news);
    st.calls[day] = { recordedAt: new Date().toISOString(), market: mkt, news, call, newsAvailable: !!news };
    fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
    console.log(`R19 · ${day} CALL: ${call.direction} (conviction ${call.conviction})`);
    console.log(`      because: ${call.because.join(" · ")}`);
    console.log(`      market: SPY ${mkt.spy}, 5d ${mkt.ret5}%, vol20 ${mkt.vol20}%`);
    console.log(news ? `      news(${news.n} from ${Object.entries(news.sources).map(([k, v]) => k + ":" + v).join(" ")}): war ${news.war} · political ${news.political} · macro ${news.macro} · earnings ${news.earnings}`
                     : `      news: UNAVAILABLE — recorded as absent, not as zero`);
    // WHOLE MARKET, THEN DISSECT. The index level alone hides which sectors are carrying it.
    if (mkt.sectorsRead) {
      const s = Object.entries(mkt.sectors).sort((a, b) => b[1].ret5 - a[1].ret5);
      console.log(`      breadth ${Math.round(mkt.breadth * mkt.sectorsRead)}/${mkt.sectorsRead} sectors above their own 20d${mkt.breadth >= 0.67 ? " (BROAD)" : mkt.breadth <= 0.33 ? " (NARROW)" : ""}`);
      console.log(`      leaders: ${s.slice(0, 3).map(([k, v]) => `${k} ${v.ret5 >= 0 ? "+" : ""}${v.ret5}%`).join(" · ")}`);
      console.log(`      laggards: ${s.slice(-3).map(([k, v]) => `${k} ${v.ret5 >= 0 ? "+" : ""}${v.ret5}%`).join(" · ")}`);
    }
    console.log(`      NOT A TRADE. Graded next session; ${Object.keys(st.calls).length} call(s) logged, need 20 to read.`);
    return;
  }

  // ── GRADE ──────────────────────────────────────────────────────────────────
  const d = await bars(["SPY"], 90);
  const spy = (d.SPY || []).filter(b => Number.isFinite(b?.c));
  if (spy.length < 5) { console.error("R19 · cannot grade — no real SPY bars."); process.exit(1); }
  const byDate = new Map(spy.map(b => [String(b.t || b.date).slice(0, 10), b]));
  const dates = [...byDate.keys()].sort();

  let n = 0, hit = 0;
  for (const day of Object.keys(st.calls).sort()) {
    if (st.graded[day]) { n++; if (st.graded[day].hit) hit++; continue; }
    const i = dates.indexOf(day);
    if (i < 0 || i + 1 >= dates.length) continue;                 // outcome not known yet
    const c0 = byDate.get(dates[i]).c, c1 = byDate.get(dates[i + 1]).c;
    const actual = c1 > c0 ? "UP" : c1 < c0 ? "DOWN" : "FLAT";
    const called = st.calls[day].call.direction;
    // A FLAT call is scored as a miss, not excused. Declining to call is allowed; it just does
    // not earn credit. Otherwise the rule could buy accuracy by abstaining on hard days.
    const isHit = called === actual && called !== "FLAT";
    st.graded[day] = { called, actual, hit: isHit, move: +(100 * (c1 - c0) / c0).toFixed(2), conviction: st.calls[day].call.conviction };
    n++; if (isHit) hit++;
  }
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));

  console.log(`\nR19 · DAILY FORECAST SCORECARD`);
  for (const d of Object.keys(st.graded).sort().slice(-15)) {
    const g = st.graded[d];
    console.log(`  ${d}  called ${g.called.padEnd(5)} actual ${g.actual.padEnd(5)} ${g.move >= 0 ? "+" : ""}${g.move}%  conv ${g.conviction}  ${g.hit ? "HIT" : "miss"}`);
  }
  if (!n) { console.log(`  no graded calls yet.`); return; }
  const rate = hit / n;
  // Binomial test against a coin flip. The bar is fixed here and not renegotiable later.
  const se = Math.sqrt(0.25 / n), z = (rate - 0.5) / se;
  console.log(`\n  ${hit}/${n} = ${(100 * rate).toFixed(1)}%  vs coin flip  z ${z.toFixed(2)}`);
  console.log(`  BAR (fixed in advance): >=20 graded calls AND z >= 2.0. ${n >= 20 && z >= 2 ? "CLEARS — read it." : `not yet (${n}/20 calls${n >= 20 ? "" : ""}).`}`);
  console.log(`  Note: SPY is UP on most days over most samples, so beating 50% is NOT the`);
  console.log(`  achievement — beating the base rate of up-days in the SAME window is. Base rate`);
  console.log(`  here: ${(100 * Object.values(st.graded).filter(g => g.actual === "UP").length / n).toFixed(1)}% up-days. That is the number to beat, and the z above understates`);
  console.log(`  the bar whenever that base rate exceeds 50%.`);
})();
