"use strict";
// STEP 2+3 (offline, no request): from the cached per-symbol series, build the coverage table and the data-quality screens.
// COUNTS, DATES AND REPEATS ONLY. Nothing here computes a return, a discount, or anything conditional on either.
//   node scout-analyze.cjs            -> prints the summary and writes scout-universe.json (through backend/lib/atomic-write.js)
//   node scout-analyze.cjs --no-write -> prints only
const fs = require("fs"), path = require("path");
const { CACHE } = require("./scout-lib.cjs");
const { writeJsonAtomic } = require("../../../backend/lib/atomic-write.js");
const SER = path.join(CACHE, "series");
const slim = JSON.parse(fs.readFileSync(path.join(CACHE, "cefconnect-universe-slim.json"), "utf8"));
const prog = JSON.parse(fs.readFileSync(path.join(CACHE, "coverage-progress.json"), "utf8"));
const cal = JSON.parse(fs.readFileSync(path.join(CACHE, "calendar.json"), "utf8")).days;
const load = (s) => { try { return JSON.parse(fs.readFileSync(path.join(SER, s + ".json"), "utf8")); } catch { return null; } };
const yearOf = (i) => cal[i].slice(0, 4);
const marketDaysInYear = {}; for (const d of cal) marketDaysInYear[d.slice(0, 4)] = (marketDaysInYear[d.slice(0, 4)] || 0) + 1;

function seriesStats(s) {
  if (!s || !s.idx.length) return null;
  const { idx, close } = s, n = idx.length, o = { rows: n, first: cal[idx[0]], last: cal[idx[n - 1]] };
  // gaps: market days inside the series' own span with no row
  let missing = 0, longGap = { days: 0 };
  for (let k = 1; k < n; k++) { const g = idx[k] - idx[k - 1] - 1; if (g > 0) { missing += g; if (g > longGap.days) longGap = { days: g, from: cal[idx[k - 1] + 1], to: cal[idx[k] - 1] }; } }
  o.missingMarketDaysInSpan = missing; o.longestGap = longGap.days ? longGap : null;
  // repeats: a row whose value equals the previous row's value; runs of identical values
  let rep = 0, run = 1, best = { rows: 1 }, runStart = 0;
  const changesByYear = {}, rowsByYear = {}, repByYear = {}, changeWeekday = [0, 0, 0, 0, 0, 0, 0];
  rowsByYear[yearOf(idx[0])] = 1;
  for (let k = 1; k < n; k++) {
    const y = yearOf(idx[k]); rowsByYear[y] = (rowsByYear[y] || 0) + 1;
    if (close[k] === close[k - 1]) { rep++; run++; repByYear[y] = (repByYear[y] || 0) + 1; if (run > best.rows) best = { rows: run, from: cal[idx[runStart]], to: cal[idx[k]] }; }
    else { run = 1; runStart = k; changesByYear[y] = (changesByYear[y] || 0) + 1; changeWeekday[new Date(cal[idx[k]] + "T12:00:00Z").getUTCDay()]++; }
  }
  o.repeatRows = rep; o.repeatShare = +(rep / Math.max(1, n - 1)).toFixed(4); o.longestFlatRun = best.rows > 1 ? best : null;
  // per-year shape: years whose rows are sparse (under 80% of market days), and years with daily rows but a value that moves about weekly
  const years = Object.keys(rowsByYear).sort(), inner = years.slice(1, -1); // first and last year are partial
  o.sparseYears = inner.filter((y) => rowsByYear[y] < 0.8 * marketDaysInYear[y]).map((y) => `${y}:${rowsByYear[y]}/${marketDaysInYear[y]}`);
  o.weeklyValueYears = inner.filter((y) => rowsByYear[y] >= 0.8 * marketDaysInYear[y] && (changesByYear[y] || 0) <= 70).map((y) => `${y}:${changesByYear[y] || 0}chg/${rowsByYear[y]}rows`);
  o.fewRowYears = inner.filter((y) => rowsByYear[y] <= 70).map((y) => `${y}:${rowsByYear[y]}`);
  const totChg = changeWeekday.reduce((a, b) => a + b, 0); o.changeWeekdayShare = totChg ? changeWeekday.slice(1, 6).map((c) => +(c / totChg).toFixed(2)) : null; // Mon..Fri
  o._rowsByYear = rowsByYear; o._changesByYear = changesByYear;
  return o;
}

// A symbol that Yahoo serves under the list's NAV ticker but that is NOT a NAV series (found by the direct look, scout-quirks.cjs):
const NOT_A_NAV = { OXLCX: "typed MUTUALFUND but on exchange NGM with traded volume on 3942 of 3955 rows and a daily high/low range: a price-like copy, not a net asset value (this fund reports NAV monthly)",
  XBANX: "typed MUTUALFUND but on exchange NGM with traded volume on 3249 of 3250 rows; equals the price exactly on 83.7% of rows: a price-like copy, not a net asset value (this fund reports NAV monthly)" };
const funds = [], missingNavByDay = new Map(), navOnlyByDay = new Map();
for (const r of slim) {
  const guess = "X" + r.Ticker + "X", listed = r.NavTicker && r.NavTicker !== r.Ticker ? r.NavTicker : null;
  const P = load(r.Ticker), navSym = [listed, guess].filter(Boolean).find((s) => prog.asked[s] === "ok" && !NOT_A_NAV[s]) || null, V = navSym ? load(navSym) : null;
  const rejected = [listed, guess].filter(Boolean).find((s) => prog.asked[s] === "ok" && NOT_A_NAV[s]) || null;
  const ps = seriesStats(P), vs = seriesStats(V);
  const f = { ticker: r.Ticker, name: r.Name, navSymbol: navSym, navSymbolFromList: r.NavTicker || null, navSymbolTried: [...new Set([listed, guess].filter(Boolean))], ...(rejected ? { navSymbolRejected: rejected, navSymbolRejectedWhy: NOT_A_NAV[rejected] } : {}),
    priceRows: ps ? ps.rows : 0, priceFirst: ps ? ps.first : null, priceLast: ps ? ps.last : null, navRows: vs ? vs.rows : 0, navFirst: vs ? vs.first : null, navLast: vs ? vs.last : null,
    assetClassIfKnown: r.CategoryName ? String(r.CategoryName).replace("Morningstar US CEF ", "") : null,
    sponsor: r.SponsorName || null, inception: r.InceptionDate ? String(r.InceptionDate).slice(0, 10) : null, termFund: r.Term === true, distributionFrequency: r.DistributionFrequency || null,
    listNavPublished: r.NAVPublished ? String(r.NAVPublished).slice(0, 10) : null };
  if (ps && vs) {
    const pset = new Set(P.idx), vset = new Set(V.idx), lo = Math.max(P.idx[0], V.idx[0]), hi = Math.min(P.idx[P.idx.length - 1], V.idx[V.idx.length - 1]);
    let both = 0, pOnly = 0, vOnly = 0; const pOnlyEx = [], vOnlyEx = [];
    for (let i = lo; i <= hi; i++) { const a = pset.has(i), b = vset.has(i); if (a && b) both++; else if (a) { pOnly++; if (pOnlyEx.length < 3) pOnlyEx.push(cal[i]); missingNavByDay.set(i, (missingNavByDay.get(i) || 0) + 1); } else if (b) { vOnly++; if (vOnlyEx.length < 3) vOnlyEx.push(cal[i]); navOnlyByDay.set(i, (navOnlyByDay.get(i) || 0) + 1); } }
    Object.assign(f, { overlapFirst: cal[lo], overlapLast: cal[hi], bothRows: both, priceOnlyDays: pOnly, priceOnlyExamples: pOnlyEx, navOnlyDays: vOnly, navOnlyExamples: vOnlyEx });
  }
  if (vs) Object.assign(f, { navMissingMarketDaysInSpan: vs.missingMarketDaysInSpan, navLongestGap: vs.longestGap, navRepeatRows: vs.repeatRows, navRepeatShare: vs.repeatShare, navLongestFlatRun: vs.longestFlatRun,
    navSparseYears: vs.sparseYears, navWeeklyValueYears: vs.weeklyValueYears, navFewRowYears: vs.fewRowYears, navChangeWeekdayShareMonFri: vs.changeWeekdayShare });
  if (ps) Object.assign(f, { priceMissingMarketDaysInSpan: ps.missingMarketDaysInSpan, priceLongestGap: ps.longestGap, priceRepeatShare: ps.repeatShare, priceSparseYears: ps.sparseYears });
  funds.push(f);
}

// ---------- summary (counts only) ----------
const both = funds.filter((f) => f.priceRows && f.navRows), priceOnly = funds.filter((f) => f.priceRows && !f.navRows), neither = funds.filter((f) => !f.priceRows);
const med = (a) => { const s = [...a].sort(); return s.length ? s[s.length >> 1] : null; }, medN = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
console.log(`FUNDS ${funds.length}: both series ${both.length}, price only ${priceOnly.length}, no price ${neither.length}`);
console.log("price only (no NAV series on Yahoo):", priceOnly.map((f) => `${f.ticker}[tried ${f.navSymbolTried.join("/")}]`).join(" "));
console.log("no price:", neither.map((f) => f.ticker).join(" ") || "none");
console.log("NAV symbol used: list's own", both.filter((f) => f.navSymbol === f.navSymbolFromList).length, "| X+ticker+X guess where the list had none or failed", both.filter((f) => f.navSymbol !== f.navSymbolFromList).map((f) => `${f.ticker}->${f.navSymbol}`).join(" ") || "none");
console.log("NAV first date: earliest", [...both.map((f) => f.navFirst)].sort()[0], "median", med(both.map((f) => f.navFirst)), "latest", [...both.map((f) => f.navFirst)].sort().pop());
const byDec = {}; for (const f of both) { const k = f.navFirst.slice(0, 4); byDec[k] = (byDec[k] || 0) + 1; } console.log("NAV first year tally:", JSON.stringify(Object.fromEntries(Object.entries(byDec).sort())));
console.log("NAV rows: min", Math.min(...both.map((f) => f.navRows)), "median", medN(both.map((f) => f.navRows)), "max", Math.max(...both.map((f) => f.navRows)), "| price rows median", medN(both.map((f) => f.priceRows)), "| both-rows median", medN(both.map((f) => f.bothRows)), "sum", both.reduce((a, f) => a + f.bothRows, 0));
const byYearFunds = {}; for (const f of both) for (let y = +f.overlapFirst.slice(0, 4); y <= +f.overlapLast.slice(0, 4); y++) byYearFunds[y] = (byYearFunds[y] || 0) + 1; console.log("funds with both series, by calendar year (alive-today list only):", JSON.stringify(byYearFunds));
console.log("NAV last date tally:", JSON.stringify(Object.entries(both.reduce((t, f) => (t[f.navLast] = (t[f.navLast] || 0) + 1, t), {})).sort()), "| price last date tally:", JSON.stringify(Object.entries(funds.filter((f) => f.priceRows).reduce((t, f) => (t[f.priceLast] = (t[f.priceLast] || 0) + 1, t), {})).sort()));
console.log("NAV history starts AFTER price history starts by more than a year:", both.filter((f) => Date.parse(f.navFirst) - Date.parse(f.priceFirst) > 366 * 864e5).length, "| price starts after NAV by >30d:", both.filter((f) => Date.parse(f.priceFirst) - Date.parse(f.navFirst) > 30 * 864e5).map((f) => `${f.ticker}(p ${f.priceFirst}, nav ${f.navFirst})`).join(" ") || "none");
console.log("price history starts more than a year after the list's inception date:", funds.filter((f) => f.priceRows && f.inception && Date.parse(f.priceFirst) - Date.parse(f.inception) > 366 * 864e5).length, "of", funds.filter((f) => f.priceRows && f.inception).length);
const cat = {}; for (const f of funds) { const k = f.assetClassIfKnown || "?"; cat[k] = cat[k] || [0, 0]; cat[k][0]++; if (f.priceRows && f.navRows) cat[k][1]++; } console.log("by asset class [listed, both series]:", JSON.stringify(cat));
console.log("\n--- QUIRK SCREENS (NAV series) ---");
const top = (arr, key, n = 12) => [...arr].sort((a, b) => key(b) - key(a)).slice(0, n);
console.log("years with daily rows but a value that changes ~weekly or less (<=70 changes):", both.filter((f) => f.navWeeklyValueYears.length).map((f) => `${f.ticker}/${f.navSymbol}[${f.navWeeklyValueYears.join(",")}]`).join(" ") || "none");
console.log("years with 70 or fewer NAV rows (weekly/monthly rows):", both.filter((f) => f.navFewRowYears.length).map((f) => `${f.ticker}/${f.navSymbol}[${f.navFewRowYears.join(",")}]`).join(" ") || "none");
console.log("funds with any sparse NAV year (<80% of market days):", both.filter((f) => f.navSparseYears.length).length, "| examples:", top(both.filter((f) => f.navSparseYears.length), (f) => f.navSparseYears.length, 14).map((f) => `${f.ticker}[${f.navSparseYears.slice(0, 6).join(",")}${f.navSparseYears.length > 6 ? ",+" + (f.navSparseYears.length - 6) : ""}]`).join(" "));
const sparseYearTally = {}; for (const f of both) for (const s of f.navSparseYears) sparseYearTally[s.slice(0, 4)] = (sparseYearTally[s.slice(0, 4)] || 0) + 1; console.log("sparse NAV years, how many funds per year:", JSON.stringify(sparseYearTally));
console.log("longest NAV gaps (market days with no NAV row inside the series):", top(both.filter((f) => f.navLongestGap), (f) => f.navLongestGap.days, 14).map((f) => `${f.ticker} ${f.navLongestGap.days}d ${f.navLongestGap.from}..${f.navLongestGap.to}`).join(" | "));
console.log("NAV gap totals: funds with 0 missing days", both.filter((f) => f.navMissingMarketDaysInSpan === 0).length, "| median missing", medN(both.map((f) => f.navMissingMarketDaysInSpan)), "| funds missing >100 days", both.filter((f) => f.navMissingMarketDaysInSpan > 100).length, "| >500", both.filter((f) => f.navMissingMarketDaysInSpan > 500).length);
console.log("longest flat NAV runs (identical value on consecutive rows):", top(both.filter((f) => f.navLongestFlatRun), (f) => f.navLongestFlatRun.rows, 14).map((f) => `${f.ticker} ${f.navLongestFlatRun.rows}rows ${f.navLongestFlatRun.from}..${f.navLongestFlatRun.to}`).join(" | "));
console.log("NAV repeat share (row equals previous row): median", medN(both.map((f) => f.navRepeatShare)), "| >=0.30:", both.filter((f) => f.navRepeatShare >= 0.3).map((f) => `${f.ticker}:${f.navRepeatShare}`).join(" ") || "none");
console.log("funds with a flat NAV run of 5+ rows:", both.filter((f) => f.navLongestFlatRun && f.navLongestFlatRun.rows >= 5).length, "| 10+ rows:", both.filter((f) => f.navLongestFlatRun && f.navLongestFlatRun.rows >= 10).length);
console.log("one weekday holds >=60% of all NAV changes (a weekly strike):", both.filter((f) => f.navChangeWeekdayShareMonFri && Math.max(...f.navChangeWeekdayShareMonFri) >= 0.6).map((f) => `${f.ticker}[MonFri ${f.navChangeWeekdayShareMonFri.join("/")}]`).join(" ") || "none");
console.log("\n--- DATE MISMATCH (inside the span where both series exist) ---");
console.log("price row but no NAV row: funds with 0 such days", both.filter((f) => f.priceOnlyDays === 0).length, "| median", medN(both.map((f) => f.priceOnlyDays)), "| worst:", top(both, (f) => f.priceOnlyDays, 10).map((f) => `${f.ticker}:${f.priceOnlyDays}`).join(" "));
console.log("NAV row but no price row: funds with 0 such days", both.filter((f) => f.navOnlyDays === 0).length, "| median", medN(both.map((f) => f.navOnlyDays)), "| worst:", top(both, (f) => f.navOnlyDays, 10).map((f) => `${f.ticker}:${f.navOnlyDays} e.g. ${f.navOnlyExamples.join(",")}`).join(" | "));
console.log("market days on which the most funds have a price row but no NAV row:", [...missingNavByDay.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([i, c]) => `${cal[i]}:${c}`).join(" "));
console.log("market days on which the most funds have a NAV row but no price row:", [...navOnlyByDay.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([i, c]) => `${cal[i]}:${c}`).join(" "));
console.log("\n--- PRICE series ---");
console.log("longest price gaps:", top(funds.filter((f) => f.priceLongestGap), (f) => f.priceLongestGap.days, 10).map((f) => `${f.ticker} ${f.priceLongestGap.days}d ${f.priceLongestGap.from}..${f.priceLongestGap.to}`).join(" | "));
console.log("price repeat share (close equals previous close): median", medN(funds.filter((f) => f.priceRows).map((f) => f.priceRepeatShare)), "| >=0.25:", funds.filter((f) => f.priceRepeatShare >= 0.25).map((f) => `${f.ticker}:${f.priceRepeatShare}`).join(" ") || "none");
// the one-cent tick as a share of the latest price level (a mechanical floor on the quoted spread; a level, not an outcome)
const lastPx = funds.map((f) => { const s = load(f.ticker); return s ? s.close[s.close.length - 1] : null; }).filter((x) => x > 0).sort((a, b) => a - b), q = (p) => lastPx[Math.floor(p * (lastPx.length - 1))];
console.log(`latest price level: p10 $${q(0.1).toFixed(2)}, median $${q(0.5).toFixed(2)}, p90 $${q(0.9).toFixed(2)} -> one cent is ${(1e4 * 0.01 / q(0.1)).toFixed(1)} / ${(1e4 * 0.01 / q(0.5)).toFixed(1)} / ${(1e4 * 0.01 / q(0.9)).toFixed(1)} bps of price; funds under $5: ${lastPx.filter((x) => x < 5).length}, under $10: ${lastPx.filter((x) => x < 10).length}, of ${lastPx.length}`);

if (!process.argv.includes("--no-write")) {
  const out = { what: "Closed-end fund data scout, 2026-10-12: coverage of Yahoo's chart endpoint for every fund on the public list. COUNTS AND DATES ONLY - no return, no discount, no outcome.",
    listSource: "GET https://www.cefconnect.com/api/v3/DailyPricing (descriptive fields only kept)", listAsOf: "2026-10-09", listHoldsOnlyFundsAliveToday: true,
    seriesSource: "GET https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1=0&period2=<now>&interval=1d&comparisons=<5 symbols> (closes aligned to US market days since 1970-01-02)",
    seriesFetched: JSON.parse(fs.readFileSync(path.join(CACHE, "calendar.json"), "utf8")).fetchedAt, calendarFirst: cal[0], calendarLast: cal[cal.length - 1],
    caveats: ["rows are counted on US market days (the S&P 500 index calendar); a row a fund carries on a non-market day is not counted here", "priceFirst of 1970-01-02 would mean 'at or before 1970'", "the latest NAV row is 2026-10-09 because the series were fetched between 16:25 and 16:31 New York time on 2026-10-12, before that evening's NAVs were out (still not out at 16:44)",
      "two NAV symbols that Yahoo serves are price-like copies and are rejected (navSymbolRejected): OXLCX and XBANX", "navRows and the NAV dates say nothing about UNITS: see scout-data.md section 3 for the funds whose NAV series is not adjusted for a share split the way the price series is"],
    counts: { funds: funds.length, bothSeries: both.length, priceOnly: priceOnly.length, noPrice: neither.length },
    funds: funds.map((f) => f) };
  writeJsonAtomic(path.join(__dirname, "scout-universe.json"), out);
  console.log("\nwrote scout-universe.json:", funds.length, "funds");
}
