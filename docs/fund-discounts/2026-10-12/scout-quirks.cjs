"use strict";
// STEP 3 (direct look, one request per symbol): what the single-symbol chart response carries for a fund's price symbol and its NAV
// symbol: instrument type and name, row and null counts, time-of-day of the stamps, rows on days that are not market days, duplicate
// dates, whether an adjusted-close field exists and on how many rows it differs from the close, and the EVENTS lists (dividends,
// capital gains, splits) with their dates. FIELDS, COUNTS AND DATES ONLY: no price path, no return, no discount.
//   node scout-quirks.cjs SYM1,SYM2,...        fetch (cached) and print
//   node scout-quirks.cjs --pairs P1:N1,P2:N2  compare the event dates of a price symbol and its NAV symbol (no request if cached)
const fs = require("fs"), path = require("path");
const { get, CACHE, readCount } = require("./scout-lib.cjs");
const DIR = path.join(CACHE, "direct"); fs.mkdirSync(DIR, { recursive: true });
const cal = new Set(JSON.parse(fs.readFileSync(path.join(CACHE, "calendar.json"), "utf8")).days);
const etDay = (t) => new Date(t * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
async function fetchOne(sym) {
  const f = path.join(DIR, sym + ".json"); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d&events=${encodeURIComponent("div,splits,capitalGains")}`;
  const r = await get(url, { timeoutMs: 60000 });
  if (r.status !== 200) return { sym, error: `HTTP ${r.status} ${r.text.slice(0, 120).replace(/\s+/g, " ")}` };
  const res = JSON.parse(r.text).chart.result[0], ts = res.timestamp || [], q = (res.indicators.quote || [{}])[0], adj = res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose;
  const ev = res.events || {}, evList = (o) => Object.values(o || {}).sort((a, b) => a.date - b.date);
  const o = { sym, fetchedAt: new Date().toISOString(), meta: { type: res.meta.instrumentType, name: res.meta.longName || res.meta.shortName, exchange: res.meta.exchangeName, fullExchange: res.meta.fullExchangeName, currency: res.meta.currency, firstTradeDate: res.meta.firstTradeDate, tz: res.meta.exchangeTimezoneName, regularMarketTime: res.meta.regularMarketTime, granularity: res.meta.dataGranularity },
    indicatorKeys: Object.keys(res.indicators), quoteKeys: Object.keys(q), eventKeys: Object.keys(ev), ts, close: q.close || [], high: q.high || [], low: q.low || [], open: q.open || [], volume: q.volume || [], adj: adj || null,
    dividends: evList(ev.dividends).map((d) => ({ date: d.date, amount: d.amount })), capitalGains: evList(ev.capitalGains).map((d) => ({ date: d.date, amount: d.amount })), splits: evList(ev.splits).map((d) => ({ date: d.date, numerator: d.numerator, denominator: d.denominator, ratio: d.splitRatio })) };
  fs.writeFileSync(f, JSON.stringify(o)); return o;
}
function describe(o) {
  if (o.error) return console.log(`\n${o.sym}: ${o.error}`);
  const n = o.ts.length, days = o.ts.map(etDay), nulls = []; o.close.forEach((c, i) => { if (c == null) nulls.push(days[i]); });
  const tod = {}; for (const t of o.ts) { const k = new Date(t * 1000).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }); tod[k] = (tod[k] || 0) + 1; }
  const offCal = days.filter((d) => !cal.has(d)), seen = new Set(), dup = []; for (const d of days) { if (seen.has(d)) dup.push(d); seen.add(d); }
  const wk = days.filter((d) => { const w = new Date(d + "T12:00:00Z").getUTCDay(); return w === 0 || w === 6; });
  let adjDiff = 0, lastDiff = null; if (o.adj) o.adj.forEach((a, i) => { const c = o.close[i]; if (a != null && c != null && Math.abs(a / c - 1) > 1e-6) { adjDiff++; lastDiff = days[i]; } });
  const flatOHLC = o.close.filter((c, i) => c != null && o.high[i] === c && o.low[i] === c && o.open[i] === c).length, vol = o.volume.filter((v) => v > 0).length;
  const dd = (a) => a.length ? `${a.length} (${etDay(a[0].date)}..${etDay(a[a.length - 1].date)})` : "0";
  console.log(`\n${o.sym}: type ${o.meta.type} | "${o.meta.name}" | exchange ${o.meta.exchange} (${o.meta.fullExchange}) | first trade date ${o.meta.firstTradeDate ? etDay(o.meta.firstTradeDate) : "-"}`);
  console.log(`  rows ${n} ${days[0]}..${days[n - 1]} | null closes ${nulls.length}${nulls.length ? " (" + nulls.slice(-4).join(",") + ")" : ""} | stamp time of day (New York): ${Object.entries(tod).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => k + " x" + v).join(", ")}`);
  console.log(`  rows on a day that is not a US market day ${offCal.length}${offCal.length ? " (" + offCal.slice(0, 4).join(",") + ")" : ""} | weekend rows ${wk.length} | duplicate dates ${dup.length}${dup.length ? " (" + dup.slice(-3).join(",") + ")" : ""}`);
  console.log(`  fields: indicators[${o.indicatorKeys.join(",")}] quote[${o.quoteKeys.join(",")}] events[${o.eventKeys.join(",") || "none"}] | adjclose ${o.adj ? `present, differs from close on ${adjDiff} of ${n} rows${lastDiff ? ", last on " + lastDiff : ""}` : "ABSENT"} | rows with open=high=low=close ${flatOHLC} | rows with volume>0 ${vol}`);
  console.log(`  events: dividends ${dd(o.dividends)} | capital gains ${dd(o.capitalGains)} | splits ${o.splits.length}${o.splits.length ? ": " + o.splits.map((s) => `${etDay(s.date)} ${s.ratio || s.numerator + ":" + s.denominator}`).join(", ") : ""}`);
}
(async () => {
  if (process.argv[2] === "--pairs") {
    for (const pr of process.argv[3].split(",")) { const [p, v] = pr.split(":"), P = await fetchOne(p), V = await fetchOne(v); if (P.error || V.error) { console.log(pr, "missing"); continue; }
      const lo = Math.max(P.ts[0], V.ts[0]), dset = (o, k) => new Set(o[k].filter((d) => d.date >= lo).map((d) => etDay(d.date)));
      const pd = new Set([...dset(P, "dividends"), ...dset(P, "capitalGains")]), vd = new Set([...dset(V, "dividends"), ...dset(V, "capitalGains")]);
      const common = [...pd].filter((d) => vd.has(d)).length, pOnly = [...pd].filter((d) => !vd.has(d)), vOnly = [...vd].filter((d) => !pd.has(d));
      // a NAV-side date that sits one market day away from a price-side date
      const near = vOnly.filter((d) => { const t = Date.parse(d + "T12:00:00Z"); return pOnly.some((x) => Math.abs(Date.parse(x + "T12:00:00Z") - t) <= 4 * 864e5); }).length;
      console.log(`${p} vs ${v} (since both exist): distribution dates on the price symbol ${pd.size}, on the NAV symbol ${vd.size}, same date ${common}, price-only ${pOnly.length}, NAV-only ${vOnly.length} (of which within 4 days of a price-only date: ${near})${pOnly.length ? " | price-only e.g. " + pOnly.slice(-3).join(",") : ""}${vOnly.length ? " | NAV-only e.g. " + vOnly.slice(-3).join(",") : ""}`);
      console.log(`   splits: price symbol ${P.splits.length}, NAV symbol ${V.splits.length}${V.splits.length ? " (" + V.splits.map((s) => etDay(s.date) + " " + (s.ratio || s.numerator + ":" + s.denominator)).join(", ") + ")" : ""}`); }
    return;
  }
  for (const s of (process.argv[2] || "").split(",").filter(Boolean)) describe(await fetchOne(s));
  console.log("\nrequests so far:", JSON.stringify(readCount()));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
