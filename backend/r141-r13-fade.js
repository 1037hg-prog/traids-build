#!/usr/bin/env node
/**
 * R141 — FADE of R13 (pre-market-news gappers) on the untouched holdout 2025-03-03..2026-09-18. Registered 2026-09-21; operator: "go".
 *
 * R13 (2026-08-03, 2024-01..2025-02): buying stocks with pre-market news (04:00-09:25 ET) that open >= +2% above the prior close, open to
 * close, LOST 0.508pp gross vs SPY per trade (t -4.20, 290 independent days). It was shelved: (1) the IEX daily OPEN may not be executable,
 * (2) a quote probe put the median spread at 333bps (on IEX quotes that look like a thin book), (3) short borrow is unmeasured.
 *
 * TIMING AUDIT (fixed in the rule): R13 selected on a gap computed FROM the opening price and entered AT that price — the official open
 * is not known before one is filled at it. PRIMARY variant enters at 09:35 ET, when the 09:30 open (and so the gap) is already printed.
 *
 * RULE (two variants, best-of-2):
 *   Event: symbol (1-5 letters) tagged on >= 1 Alpaca news article created 04:00-09:25 ET on day d; SIP daily open(d) >= 1.02 x SIP close(d-1);
 *          SIP open(d) >= $5 (a marginable short).
 *   A (primary)  "0935": SHORT at the open of the 09:35 SIP 1-minute bar, COVER at the SIP daily close; SPY leg identical (09:35 open -> close).
 *   B            "open": SHORT at the SIP daily open, COVER at the SIP daily close (R13's own timing, reversed; carries the timing flaw above).
 *   fade excess (pp) = -[(exit/entry - 1) - (SPY exit/SPY entry - 1)] x 100
 *   cost (pp) = half the SIP quoted spread at entry + half at exit (NBBO sampled 09:35:00-09:35:30 / 15:59:00-15:59:30; the open for B uses
 *               09:30:30-09:31:00) + 0.05pp fees/slippage + 0.10pp one-day borrow. An event with no two-sided quote is charged 1.00pp.
 * STATISTIC: per DAY the mean net fade excess over that day's events; t across days. Unit: trading day.
 *
 *   node backend/r141-r13-fade.js --collect        crawl the holdout news (no prices, no outcomes)   -> data/r141-news.json
 *   node backend/r141-r13-fade.js --synth <seed>   LEAK TEST: each event's open->close replaced by the same symbol on a random other holdout day
 *   node backend/r141-r13-fade.js                  the registered run (refuses unless R141 is registered)
 */
const fs = require("fs"), path = require("path"); require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const AH = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const START = "2025-03-03", END = "2026-09-18", GAP = 1.02, MINPX = 5, FEES = 0.05, BORROW = 0.10, NOQUOTE = 1.0;
const args = process.argv.slice(2), SYNTH = args.includes("--synth") ? Number(args[args.indexOf("--synth") + 1]) : null;
const etParts = (iso) => { const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }); const p = {}; for (const o of f.formatToParts(new Date(iso))) if (o.type !== "literal") p[o.type] = o.value; return { day: `${p.year}-${p.month}-${p.day}`, min: (parseInt(p.hour) % 24) * 60 + parseInt(p.minute) }; };
const etToUtc = (day, hm) => { const off = new Date(`${day}T12:00:00Z`).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" }).match(/GMT([+-]\d+)/)[1]; const [h, m, sec = 0] = hm.split(":").map(Number); return new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), h - Number(off), m, sec)).toISOString(); };
async function getJ(url) { for (let a = 0; a < 5; a++) { try { const r = await fetch(url, { headers: AH, signal: AbortSignal.timeout(60000) }); if (r.status === 429) { await nap(3000 * (a + 1)); continue; } if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); } catch (e) { if (a === 4) throw e; await nap(1500); } } }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }, tOf = (a) => (a.length >= 3 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);

async function collect() {
  const OUT = D("r141-news.json"); let st = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { byDay: {}, token: null, pages: 0, articles: 0, done: false };
  if (st.done) { console.log("news already collected"); return; }
  const byDay = Object.fromEntries(Object.entries(st.byDay).map(([k, v]) => [k, new Set(v)]));
  let token = st.token, pages = st.pages, articles = st.articles;
  do {
    const p = new URLSearchParams({ start: `${START}T00:00:00Z`, end: `${END}T23:59:59Z`, limit: "50", sort: "asc" }); if (token) p.set("page_token", token);
    const j = await getJ(`https://data.alpaca.markets/v1beta1/news?${p}`);
    for (const n of j.news || []) { articles++; const { day, min } = etParts(n.created_at); if (min < 240 || min > 565) continue; for (const s of n.symbols || []) (byDay[day] ||= new Set()).add(s); }
    token = j.next_page_token || null; pages++;
    if (pages % 50 === 0) { writeJsonAtomic(OUT, { byDay: Object.fromEntries(Object.entries(byDay).map(([k, v]) => [k, [...v]])), token, pages, articles, done: false }); console.log(`  page ${pages} · ${articles} articles · ${Object.keys(byDay).length} days`); }
    await nap(260);
  } while (token);
  writeJsonAtomic(OUT, { byDay: Object.fromEntries(Object.entries(byDay).map(([k, v]) => [k, [...v]])), token: null, pages, articles, done: true, collectedAt: new Date().toISOString() });
  console.log(`collected ${articles} articles, pre-market news on ${Object.keys(byDay).length} days`);
}

async function dailyBars(list) {
  const bars = {};
  for (let i = 0; i < list.length; i += 50) { const chunk = list.slice(i, i + 50); let tok = null;
    do { const p = new URLSearchParams({ symbols: chunk.join(","), timeframe: "1Day", start: "2025-02-20", end: "2026-09-19", limit: "10000", feed: "sip", adjustment: "all" }); if (tok) p.set("page_token", tok);
      const j = await getJ(`https://data.alpaca.markets/v2/stocks/bars?${p}`); for (const [k, v] of Object.entries(j.bars || {})) (bars[k] ||= []).push(...v); tok = j.next_page_token || null; await nap(300); } while (tok);
    if (i % 1000 === 0) console.log(`  daily bars ${i}/${list.length}`); }
  return bars;
}
async function minuteAt(day, syms, hm) {   // 1-minute SIP bar starting at hm for each symbol
  const out = {}; for (let i = 0; i < syms.length; i += 100) { const p = new URLSearchParams({ symbols: syms.slice(i, i + 100).join(","), timeframe: "1Min", start: etToUtc(day, hm), end: etToUtc(day, hm), limit: "10000", feed: "sip", adjustment: "all" });
    const j = await getJ(`https://data.alpaca.markets/v2/stocks/bars?${p}`); for (const [k, v] of Object.entries(j.bars || {})) if (v[0]) out[k] = v[0]; await nap(300); } return out;
}
async function spreadsAt(day, syms, hmFrom, hmTo) {   // median SIP quoted spread (bps of mid) in a 30-second window
  const acc = {}; for (let i = 0; i < syms.length; i += 100) { let tok = null;
    do { const p = new URLSearchParams({ symbols: syms.slice(i, i + 100).join(","), start: etToUtc(day, hmFrom), end: etToUtc(day, hmTo), limit: "10000", feed: "sip" });
      if (tok) p.set("page_token", tok); const j = await getJ(`https://data.alpaca.markets/v2/stocks/quotes?${p}`);
      for (const [k, v] of Object.entries(j.quotes || {})) for (const q of v) if (q.bp > 0 && q.ap >= q.bp) (acc[k] ||= []).push(10000 * (q.ap - q.bp) / ((q.ap + q.bp) / 2));
      tok = j.next_page_token || null; await nap(300); } while (tok); }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => { const s = v.sort((a, b) => a - b); return [k, s[Math.floor(s.length / 2)]]; }));
}

async function run() {
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), R = [...(reg.tests || []), ...(reg.preregistered || [])].find((t) => t.id === "R141");
  if (SYNTH == null && !R) { console.error("R141 is not registered — the real run refuses."); process.exit(2); }
  const news = JSON.parse(fs.readFileSync(D("r141-news.json"), "utf8")); if (!news.done) { console.error("news crawl not finished — run --collect"); process.exit(2); }
  const days = Object.keys(news.byDay).filter((d) => d >= START && d <= END).sort();
  const universe = [...new Set(days.flatMap((d) => news.byDay[d]))].filter((s) => /^[A-Z]{1,5}$/.test(s));
  console.log(`${days.length} news days · ${universe.length} symbols`);
  const bars = await dailyBars(["SPY", ...universe]);
  const idx = Object.fromEntries(Object.entries(bars).map(([k, v]) => [k, new Map(v.map((b, i) => [String(b.t).slice(0, 10), i]))]));
  // events (selection uses only the prior close and the day's open — known by 09:30)
  const events = [];
  for (const d of days) { if (idx.SPY.get(d) == null) continue;
    for (const s of news.byDay[d]) { const b = bars[s], i = idx[s] && idx[s].get(d); if (!b || i == null || i < 1) continue; if (!(b[i].o >= GAP * b[i - 1].c) || !(b[i].o >= MINPX)) continue; events.push({ d, s, o: b[i].o, c: b[i].c }); } }
  console.log(`${events.length} events on ${new Set(events.map((e) => e.d)).size} days`);
  // MATCHED BASELINE (amendment 2026-09-22, pre-evidence): for every event, K = 5 of the SAME symbol's ordinary holdout days (days on which that
  // symbol is not an event), drawn with a fixed seed. The event's fade is compared with the mean fade on those days, same entry timing.
  const K = 5, isEvent = new Set(events.map((e) => e.s + "|" + e.d)); let sa = 20260922 >>> 0;
  const srng = () => { sa = (sa + 0x6D2B79F5) >>> 0; let t = sa; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ordinary = (sym) => (bars[sym] || []).map((x) => String(x.t).slice(0, 10)).filter((dd) => dd >= START && dd <= END && !isEvent.has(sym + "|" + dd) && idx.SPY.get(dd) != null);
  const ordCache = {}; for (const e of events) { const pool = (ordCache[e.s] ||= ordinary(e.s)); const pick = new Set(); for (let g = 0; g < 50 && pick.size < Math.min(K, pool.length); g++) pick.add(pool[Math.floor(srng() * pool.length)]); e.base = [...pick]; }
  const dayFade = (sym, dd, entry, spyEntry) => { const b = bars[sym][idx[sym].get(dd)], sp = bars.SPY[idx.SPY.get(dd)]; return -((b.c / entry - 1) - (sp.c / spyEntry - 1)) * 100; };
  const openFade = (sym, dd) => { const b = bars[sym][idx[sym].get(dd)], sp = bars.SPY[idx.SPY.get(dd)]; return dayFade(sym, dd, b.o, sp.o); };
  if (SYNTH != null) {   // leak test: same pipeline, each event's day replaced by a random other holdout day of the same symbol (selection kept, outcome scrambled)
    let a = SYNTH >>> 0; const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const per = {}, raw = {}; for (const e of events) { const pool = ordCache[e.s].filter((dd) => !e.base.includes(dd)); if (!pool.length || !e.base.length) continue; const dd = pool[Math.floor(r() * pool.length)];
      const ev = openFade(e.s, dd), base = mean(e.base.map((b) => openFade(e.s, b))); (per[e.d] ||= []).push(ev - base); (raw[e.d] ||= []).push(ev); }
    const xs = Object.values(per).map(mean), rs = Object.values(raw).map(mean), out = { spec: "r141-leak-test-matched", seed: SYNTH, days: xs.length, matchedDiffMeanPp: +mean(xs).toFixed(4), matchedT: +tOf(xs).toFixed(3), rawFadeMeanPp: +mean(rs).toFixed(4), rawT: +tOf(rs).toFixed(3) };
    writeJsonAtomic(D(`r141-synth-matched-${SYNTH}.json`), out); console.log("LEAK TEST (matched statistic, event outcome scrambled, open timing):", JSON.stringify(out)); return;
  }
  // prices at 09:35 and spreads
  const byD = {}; for (const e of events) (byD[e.d] ||= []).push(e);
  let n = 0;
  for (const [d, es] of Object.entries(byD)) { const syms = [...new Set(es.map((e) => e.s)), "SPY"];
    const m935 = await minuteAt(d, syms, "09:35"), sOpen = await spreadsAt(d, syms, "09:30:30", "09:31:00"), s935 = await spreadsAt(d, syms, "09:35:00", "09:35:30"), sClose = await spreadsAt(d, syms, "15:59:00", "15:59:30");
    for (const e of es) { e.p935 = m935[e.s] ? m935[e.s].o : null; e.spy935 = m935.SPY ? m935.SPY.o : null; e.sprOpen = sOpen[e.s] ?? null; e.spr935 = s935[e.s] ?? null; e.sprClose = sClose[e.s] ?? null; }
    if (++n % 25 === 0) console.log(`  priced ${n}/${Object.keys(byD).length} days`); }
  const need = {}; for (const e of events) for (const b of e.base) (need[b] ||= new Set()).add(e.s);
  const m935base = {}; let nb = 0; for (const [dd, set] of Object.entries(need)) { m935base[dd] = await minuteAt(dd, [...set, "SPY"], "09:35"); if (++nb % 50 === 0) console.log(`  baseline 09:35 bars ${nb}/${Object.keys(need).length} days`); }
  const spyOf = (d) => bars.SPY[idx.SPY.get(d)];
  const variant = (key) => { const per = {}, gross = {}, matched = {}; let noq = 0, used = 0;
    for (const e of events) { const sp = spyOf(e.d); let entry, spyEntry, sEntry;
      if (key === "0935") { entry = e.p935; spyEntry = e.spy935; sEntry = e.spr935; } else { entry = e.o; spyEntry = sp.o; sEntry = e.sprOpen; }
      if (!(entry > 0) || !(spyEntry > 0)) continue; used++;
      const g = -((e.c / entry - 1) - (sp.c / spyEntry - 1)) * 100;
      const cost = sEntry != null && e.sprClose != null ? (sEntry / 2 + e.sprClose / 2) / 100 + FEES + BORROW : (noq++, NOQUOTE + BORROW);
      (per[e.d] ||= []).push(g - cost); (gross[e.d] ||= []).push(g);
      const bs = e.base.map((b) => { if (key === "open") return openFade(e.s, b); const m = m935base[b] || {}; return m[e.s] && m.SPY ? dayFade(e.s, b, m[e.s].o, m.SPY.o) : null; }).filter((x) => x != null);
      if (bs.length) (matched[e.d] ||= []).push(g - mean(bs)); }
    const ds = Object.keys(per).sort(), xs = ds.map((d) => mean(per[d])), gx = ds.map((d) => mean(gross[d])), h = Math.floor(xs.length / 2);
    const mds = Object.keys(matched).sort(), mx = mds.map((d) => mean(matched[d])), mh = Math.floor(mx.length / 2);
    const matchedOut = { days: mx.length, meanPp: +mean(mx).toFixed(4), t: +tOf(mx).toFixed(3), halves: { first: +mean(mx.slice(0, mh)).toFixed(4), second: +mean(mx.slice(mh)).toFixed(4) } };
    return { matched: matchedOut, events: used, days: xs.length, noQuoteEvents: noq, grossMeanPp: +mean(gx).toFixed(4), grossT: +tOf(gx).toFixed(3), netMeanPp: +mean(xs).toFixed(4), netT: +tOf(xs).toFixed(3), halves: { first: +mean(xs.slice(0, h)).toFixed(4), second: +mean(xs.slice(h)).toFixed(4) }, daysPositive: xs.filter((x) => x > 0).length }; };
  const res = { "0935": variant("0935"), open: variant("open") };
  const allSpr = events.map((e) => e.spr935).filter((x) => x != null).sort((a, b) => a - b);
  const BAR = R.bar.tRequired, ok = Object.entries(res).filter(([, v]) => v.days >= 200 && v.netMeanPp > 0 && v.netT >= BAR && v.halves.first > 0 && v.halves.second > 0 && v.matched.days >= 200 && v.matched.meanPp > 0 && v.matched.t >= BAR && v.matched.halves.first > 0 && v.matched.halves.second > 0);
  const out = { spec: "r141-r13-fade-v2-matched", test: "R141", asOf: new Date().toISOString(), window: [START, END], variants: res, medianSpreadBpsAt0935: allSpr.length ? +allSpr[Math.floor(allSpr.length / 2)].toFixed(1) : null,
    verdict: ok.length ? `PASS — ${ok.map(([k]) => k).join(", ")}; routes to the operator (borrow still unmeasured)` : "DID NOT PASS" };
  writeJsonAtomic(D("r141-r13-fade.json"), out);
  for (const [k, v] of Object.entries(res)) console.log(`  ${k.padEnd(5)} events ${v.events} · days ${v.days} · gross ${v.grossMeanPp}pp (t ${v.grossT}) · NET ${v.netMeanPp}pp (t ${v.netT}) · halves ${v.halves.first}/${v.halves.second} · days+ ${v.daysPositive}/${v.days} · no-quote ${v.noQuoteEvents} · MATCHED vs own ordinary days ${v.matched.meanPp}pp (t ${v.matched.t}, halves ${v.matched.halves.first}/${v.matched.halves.second})`);
  console.log("median spread at 09:35:", out.medianSpreadBpsAt0935, "bps · VERDICT:", out.verdict);
}
(args.includes("--collect") ? collect() : run()).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
