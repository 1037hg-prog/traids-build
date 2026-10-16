"use strict";
// TIMING SKEPTIC (pre-registration) availability checks. Plain public GETs, no key, no login, under two requests a second,
// a hard cap counted in a file beside this script. NOTHING here computes or prints a return, a discount, a z-score or any
// result of any rule. It prints clock times, dates, null/valued flags and COUNTS of rows only.
//
//   node docs/fund-discounts/2026-10-12/attack-timing-check.cjs meta        # when did Yahoo last stamp each NAV symbol (16 requests)
//   node docs/fund-discounts/2026-10-12/attack-timing-check.cjs poll [all]  # has today's NAV appeared yet (10 requests; 64 with "all")
//   node docs/fund-discounts/2026-10-12/attack-timing-check.cjs stale       # no-trade days among liquidity-eligible days (20 requests)
//   node docs/fund-discounts/2026-10-12/attack-timing-check.cjs stamp       # does the public list's NAV date match Yahoo's row date (1 + 8 requests)
//   node docs/fund-discounts/2026-10-12/attack-timing-check.cjs repeat A,B  # which of a NAV symbol's last rows repeat the row before (1 request each)
//   node docs/fund-discounts/2026-10-12/attack-timing-check.cjs splits      # split-type events, large and small, 64 funds (64 requests + 1 per fund with an event)
//   node docs/fund-discounts/2026-10-12/attack-timing-check.cjs weekly      # funds that changed between daily and weekly NAVs (no request; reads scout-universe.json)
//   node docs/fund-discounts/2026-10-12/attack-timing-check.cjs arith       # the conversions quoted in attack-timing.md (no request)
const fs = require("fs"), path = require("path");
const U = JSON.parse(fs.readFileSync(path.join(__dirname, "scout-universe.json"), "utf8")).funds.filter((f) => f.priceRows && f.navRows && !f.navSymbolRejected)
  .sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
const COUNT_FILE = path.join(__dirname, "attack-timing-requests.json"), CAP = 280, GAP = 700;
const readCount = () => { try { return JSON.parse(fs.readFileSync(COUNT_FILE, "utf8")); } catch { return { count: 0, byHost: {} }; } };
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function get(url, headers = {}) {
  const c = readCount(), host = new URL(url).host;
  if (c.count >= CAP) throw new Error(`request cap reached (${c.count}/${CAP})`);
  const w = last + GAP - Date.now(); if (w > 0) await nap(w); last = Date.now();
  c.count++; c.byHost[host] = (c.byHost[host] || 0) + 1; fs.writeFileSync(COUNT_FILE, JSON.stringify(c));
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*", ...headers }, signal: AbortSignal.timeout(45000) });
  return { status: r.status, text: await r.text(), type: r.headers.get("content-type") || "" };
}
const ny = (t) => new Date(t * 1000).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const every = (n, k) => U.filter((_, i) => i % Math.ceil(U.length / n) === (k || 0));
const clock = () => console.log("clock New York:", new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false }), "| funds with both series:", U.length);

async function meta() {
  clock();
  for (const f of every(16)) {
    const r = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${f.navSymbol}?range=5d&interval=1d`);
    if (r.status !== 200) { console.log(`  ${f.navSymbol}: HTTP ${r.status}`); continue; }
    const res = JSON.parse(r.text).chart.result[0], m = res.meta, ts = res.timestamp || [], cl = (res.indicators.quote[0] || {}).close || [];
    const rows = ts.slice(-3).map((t, i) => `${day(t)}:${cl[ts.length - Math.min(3, ts.length) + i] == null ? "null" : "valued"}`).join(" ");
    // LEVELS ONLY, yes/no: does the live quote equal the latest VALUED daily row? "no" = a newer NAV sits in the quote before the daily row has it.
    let lv = null; for (let i = cl.length - 1; i >= 0; i--) if (cl[i] != null) { lv = cl[i]; break; }
    const same = lv == null || m.regularMarketPrice == null ? "?" : Math.abs(m.regularMarketPrice - lv) < 0.0051 ? "yes" : "no";
    console.log(`  ${f.navSymbol.padEnd(6)} ${String(m.instrumentType).padEnd(10)} ${String(m.exchangeName).padEnd(4)} last stamp (regularMarketTime) ${m.regularMarketTime ? ny(m.regularMarketTime) : "-"} NY | quote equals latest valued row: ${same.padEnd(3)} | last rows ${rows} | ${f.sponsor}`);
  }
  console.log("requests so far:", JSON.stringify(readCount()));
}

async function poll(all) {
  clock();
  const list = all ? U : every(50), now = Math.floor(Date.now() / 1000), tally = {}, late = [];
  let calLast = null;
  for (let i = 0; i < list.length; i += 5) {
    const syms = list.slice(i, i + 5).map((f) => f.navSymbol);
    const r = await get(`https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1=${now - 12 * 86400}&period2=${now}&interval=1d&comparisons=${syms.join(",")}`);
    if (r.status !== 200) { console.log("  HTTP", r.status, "for", syms.join(",")); continue; }
    const res = JSON.parse(r.text).chart.result[0], ts = res.timestamp; calLast = day(ts[ts.length - 1]);
    const got = new Set();
    for (const c of res.comparisons || []) { got.add(c.symbol); let l = -1; c.close.forEach((v, k) => { if (v != null) l = k; }); const d = l >= 0 ? day(ts[l]) : "none"; tally[d] = (tally[d] || 0) + 1; if (d !== calLast) late.push(c.symbol); }
    for (const s of syms) if (!got.has(s)) tally["not returned"] = (tally["not returned"] || 0) + 1;
  }
  console.log("latest market day on the calendar:", calLast, "| NAV symbols asked:", list.length);
  console.log("date of each symbol's latest VALUED NAV row:", JSON.stringify(tally));
  if (tally[calLast] && late.length && late.length <= 60) console.log("not yet showing the latest day:", late.join(" "));
  console.log("requests so far:", JSON.stringify(readCount()));
}

async function stale() {
  clock();
  const now = Math.floor(Date.now() / 1000), tot = { rows: 0, zeroVol: 0, elig: 0, eligNextZeroVol: 0, eligNextSameClose: 0, eligSameDayZeroVol: 0 };
  console.log("per fund: valued rows | rows with no volume | liquidity-eligible days (30-day median close x volume >= $400,000, as of the day) | of those: the day itself has no volume | the NEXT row has no volume | the NEXT row's close equals this close");
  for (const f of every(20, 3)) {
    const r = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${f.ticker}?period1=0&period2=${now}&interval=1d`);
    if (r.status !== 200) { console.log(`  ${f.ticker}: HTTP ${r.status}`); continue; }
    const res = JSON.parse(r.text).chart.result[0], q = res.indicators.quote[0], rows = [];
    (res.timestamp || []).forEach((t, i) => { if (q.close[i] != null && q.close[i] > 0) rows.push({ c: q.close[i], v: q.volume[i] || 0 }); });
    let zero = 0, elig = 0, nz = 0, ns = 0, sz = 0;
    for (let i = 0; i < rows.length; i++) {
      if (!(rows[i].v > 0)) zero++;
      if (i < 29 || i + 1 >= rows.length) continue;
      const dv = rows.slice(i - 29, i + 1).map((x) => x.c * x.v).sort((a, b) => a - b), med = (dv[14] + dv[15]) / 2;
      if (med < 400000) continue;
      elig++; if (!(rows[i].v > 0)) sz++; if (!(rows[i + 1].v > 0)) nz++; if (Math.abs(rows[i + 1].c / rows[i].c - 1) < 1e-9) ns++;
    }
    tot.rows += rows.length; tot.zeroVol += zero; tot.elig += elig; tot.eligNextZeroVol += nz; tot.eligNextSameClose += ns; tot.eligSameDayZeroVol += sz;
    console.log(`  ${f.ticker.padEnd(5)} ${String(rows.length).padStart(6)} | ${String(zero).padStart(5)} | ${String(elig).padStart(6)} | ${String(sz).padStart(4)} | ${String(nz).padStart(4)} | ${String(ns).padStart(5)} (${elig ? (100 * ns / elig).toFixed(1) : "-"}%)  ${f.assetClassIfKnown}`);
  }
  console.log("ALL 20:", JSON.stringify(tot), `| next-row-same-close share of eligible days ${(100 * tot.eligNextSameClose / tot.elig).toFixed(2)}% | next-row-no-volume share ${(100 * tot.eligNextZeroVol / tot.elig).toFixed(3)}%`);
  console.log("requests so far:", JSON.stringify(readCount()));
}

async function stamp() {
  clock();
  const r = await get("https://www.cefconnect.com/api/v3/DailyPricing", { Accept: "application/json, text/plain, */*" });
  if (r.status !== 200 || !/json/.test(r.type)) { console.log("NOT SERVED AS JSON: HTTP", r.status, r.type, "- left alone"); return; }
  const rows = JSON.parse(r.text), keys = Object.keys(rows[0] || {});
  console.log("list rows:", rows.length, "| field NAMES:", keys.join(", "));
  const navKey = ["NAV", "Nav", "NetAssetValue"].find((k) => keys.includes(k));
  if (!navKey) { console.log("no plain NAV level field recognised; stopping"); return; }
  const by = new Map(rows.map((x) => [x.Ticker, { nav: Number(x[navKey]), date: String(x.NAVPublished).slice(0, 10), listDate: String(x.LastUpdated).slice(0, 10) }]));
  const list = every(40, 1).filter((f) => by.has(f.ticker)), now = Math.floor(Date.now() / 1000), tally = { sameDate: 0, dayBefore: 0, dayAfter: 0, noMatch: 0, listNavDateNotOnYahoo: 0 }, odd = [];
  console.log("list dates (LastUpdated) in the sample:", JSON.stringify([...new Set(list.map((f) => by.get(f.ticker).listDate))]), "| NAV dates:", JSON.stringify([...new Set(list.map((f) => by.get(f.ticker).date))]));
  for (let i = 0; i < list.length; i += 5) {
    const part = list.slice(i, i + 5);
    const y = await get(`https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1=${now - 20 * 86400}&period2=${now}&interval=1d&comparisons=${part.map((f) => f.navSymbol).join(",")}`);
    if (y.status !== 200) { console.log("  HTTP", y.status); continue; }
    const res = JSON.parse(y.text).chart.result[0], ts = res.timestamp.map(day);
    for (const c of res.comparisons || []) {
      const f = part.find((x) => x.navSymbol === c.symbol); if (!f) continue;
      const L = by.get(f.ticker), k = ts.indexOf(L.date), eq = (v) => v != null && Math.abs(v - L.nav) < 0.0051;
      // LEVELS ONLY: is the list's NAV level found on Yahoo at the same date, the row before, or the row after? No value is printed.
      if (k < 0) { tally.listNavDateNotOnYahoo++; odd.push(f.ticker); continue; }
      if (eq(c.close[k])) tally.sameDate++; else if (k > 0 && eq(c.close[k - 1])) { tally.dayBefore++; odd.push(f.ticker + "(-1)"); } else if (k + 1 < ts.length && eq(c.close[k + 1])) { tally.dayAfter++; odd.push(f.ticker + "(+1)"); } else { tally.noMatch++; odd.push(f.ticker + "(?)"); }
    }
  }
  console.log("funds compared:", list.length, "| the list's NAV level is found on Yahoo at:", JSON.stringify(tally), odd.length ? "| not same-date: " + odd.join(" ") : "");
  console.log("requests so far:", JSON.stringify(readCount()));
}

// LEVELS ONLY, yes/no flags, one request a symbol: is each of the last month's NAV rows a repeat of the row before (R) or not (.),
// and does the live quote equal the latest valued row or the one before it? No value is printed.
async function repeat() {
  clock();
  for (const s of (process.argv[3] || "XEMDX,XHGLX,XPDIX").split(",").slice(0, 8)) {
    const r = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?range=1mo&interval=1d`);
    if (r.status !== 200) { console.log(`  ${s}: HTTP ${r.status}`); continue; }
    const res = JSON.parse(r.text).chart.result[0], m = res.meta, v = res.indicators.quote[0].close.filter((x) => x != null), q = m.regularMarketPrice;
    const eq = (a, b) => Math.abs(a - b) < 0.0051, reps = []; for (let i = 1; i < v.length; i++) reps.push(eq(v[i], v[i - 1]) ? "R" : ".");
    console.log(`  ${s}: valued rows ${v.length} | repeats ${reps.join("")} | quote equals latest valued row: ${eq(q, v[v.length - 1])} | equals the row before: ${eq(q, v[v.length - 2])} | stamp ${ny(m.regularMarketTime)} NY`);
  }
  console.log("requests so far:", JSON.stringify(readCount()));
}

// CORPORATE-EVENT LISTS ONLY (dates and ratios; quarterly rows are fetched and never read): how common are split-type events on
// the price symbols, large and small, and does the NAV symbol list the same ones? 64 funds (every fifth by ticker), one request
// each, plus one for the NAV symbol of each fund that has an event.
async function splits() {
  clock();
  const now = Math.floor(Date.now() / 1000), list = every(64, 2), tot = { funds: 0, withAny: 0, withSmall: 0, withLarge: 0, small: 0, large: 0, smallAlsoOnNav: 0, largeAlsoOnNav: 0 };
  const ev = async (sym) => { const r = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=0&period2=${now}&interval=3mo&events=split`);
    if (r.status !== 200) return null; const e = ((JSON.parse(r.text).chart.result || [])[0] || {}).events; return Object.values((e && e.splits) || {}).map((x) => ({ d: day(x.date), r: x.numerator / x.denominator, s: x.splitRatio })).sort((a, b) => (a.d < b.d ? -1 : 1)); };
  for (const f of list) {
    const P = await ev(f.ticker); if (!P) { console.log(`  ${f.ticker}: not served`); continue; }
    tot.funds++; if (!P.length) continue;
    const isSmall = (x) => x.r > 1 / 1.5 && x.r < 1.5, N = (await ev(f.navSymbol)) || [], onNav = (x) => N.some((y) => y.d === x.d || Math.abs(new Date(y.d) - new Date(x.d)) <= 4 * 86400000);
    const sm = P.filter(isSmall), lg = P.filter((x) => !isSmall(x));
    tot.withAny++; if (sm.length) tot.withSmall++; if (lg.length) tot.withLarge++; tot.small += sm.length; tot.large += lg.length; tot.smallAlsoOnNav += sm.filter(onNav).length; tot.largeAlsoOnNav += lg.filter(onNav).length;
    console.log(`  ${f.ticker.padEnd(5)} price symbol: ${P.map((x) => `${x.d} ${x.s}${onNav(x) ? "" : " (not on the NAV symbol's list)"}`).join("; ")}`);
  }
  console.log("TOTAL:", JSON.stringify(tot));
  console.log("requests so far:", JSON.stringify(readCount()));
}

// OFFLINE (no request): from the data scout's table, the funds whose NAV was a weekly value in some years, and whether a
// daily year comes directly before the first weekly year (a daily-to-weekly change the trailing detector sees late).
async function weekly() {
  const all = JSON.parse(fs.readFileSync(path.join(__dirname, "scout-universe.json"), "utf8")).funds.filter((f) => f.navRows && (f.navWeeklyValueYears || []).length);
  let into = 0, intoClear = 0, out = 0;
  for (const f of all) {
    // entries look like "2019:46chg/252rows"; the year is the first four characters. The NAV series' own first year is used.
    const w = f.navWeeklyValueYears.map((x) => Number(String(x).slice(0, 4))).sort((a, b) => a - b), first = Number(f.navFirst.slice(0, 4)), last = Number(f.navLast.slice(0, 4));
    // "clear" = at least one whole calendar year of daily values lies between the series' first (partial) year and the first weekly year.
    const becameWeekly = w[0] > first, clear = w[0] - first >= 2, becameDaily = w[w.length - 1] < last; if (becameWeekly) into++; if (clear) intoClear++; if (becameDaily) out++;
    console.log(`  ${f.ticker.padEnd(5)} weekly-value years ${w[0]}..${w[w.length - 1]} (${w.length}) | NAV series ${first}..${last} | daily before: ${clear ? "yes, a whole year or more" : becameWeekly ? "only the series' first partial year" : "no"} | daily after: ${becameDaily ? "yes" : "no"}`);
  }
  console.log(`funds with weekly-value years: ${all.length} | with a whole daily year or more BEFORE the first weekly year: ${intoClear} | with only the first partial year before it: ${into - intoClear} | with daily years AFTER the last weekly year: ${out}`);
}

// ARITHMETIC ONLY (no request, no series): the conversions quoted in attack-timing.md.
async function arith() {
  const binom = (n, k, p) => { let c = 1; for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1); return c * p ** k * (1 - p) ** (n - k); };
  const tailBelow = (n, k, p) => { let s = 0; for (let i = 0; i < k; i++) s += binom(n, i, p); return s; };
  // 1. How long the 70-in-252 weekly detector takes to notice a fund that has just gone weekly.
  const daily = 1 - 0.133, weekly = 0.2, rows = (252 * daily - 70) / (daily - weekly);
  console.log(`1. weekly detector: a daily fund changes on ${(252 * daily).toFixed(0)} of 252 rows (median repeat share 13.3%, scout-data 3.2); once weekly it changes on 1 row in 5;`);
  console.log(`   the trailing count falls to 70 after ${rows.toFixed(0)} rows = ${(rows / 21).toFixed(1)} months. In that time 4 rows in 5 carry an old value and only the fifth identical row is blocked.`);
  // 2. A fast detector, 21 rows: at least K changes.
  for (const K of [8, 10]) console.log(`2. fast detector "at least ${K} changes in the 21 rows ending s": a weekly fund (1 in 5) passes by chance ${(100 * (1 - tailBelow(21, K, 0.2))).toFixed(1)}% of days; a quiet daily fund with 45% repeats (MIN) is refused ${(100 * tailBelow(21, K, 0.55)).toFixed(1)}% of days; the median daily fund (13.3% repeats) is refused ${(100 * tailBelow(21, K, daily)).toFixed(4)}% of days`);
  // 3. The pinned shuffle: expected share of a dip that comes back within h rows, by construction, averaged over start days.
  for (const N of [5358, 2520]) { const h = 252; console.log(`3. pinned shuffle, ${N} rows (${N === 5358 ? "the median fund's days with both series" : "a ten-year fund"}), hold ${h}: on a day with ${h} rows left the whole dip is expected back; averaged over all start days ${(100 * (h / (N - h)) * Math.log(N / h)).toFixed(1)}% of the dip comes back within the hold, with no edge in the data`); }
  // 4. The scout-seen real moves against draft B's 1.3x screen.
  console.log(`4. a price that "stepped down to 0.59x to 0.77x" (scout-data, outcomesSeen b) is a step of ${(1 / 0.77).toFixed(2)}x to ${(1 / 0.59).toFixed(2)}x: at or over draft B's 1.3x for nearly all of them; the up-steps seen were 1.31x to 1.74x`);
  // 5. GAB's listed small ratios.
  const all = 1.10 * 1.04 * 1.023 * 1.008 * 1.01, first3 = 1.10 * 1.04 * 1.023;
  console.log(`5. GAB small ratios on the price symbol multiply to ${all.toFixed(4)}; the three its NAV symbol also lists to ${first3.toFixed(4)}; the part only the price carries is ${((all / first3 - 1) * 100).toFixed(2)}%`);
}

const mode = process.argv[2];
({ meta, poll: () => poll(process.argv[3] === "all"), stale, stamp, repeat, splits, weekly, arith }[mode] || (async () => console.log("modes: meta | poll [all] | stale | stamp | repeat [SYM,SYM] | splits | weekly | arith")))().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
