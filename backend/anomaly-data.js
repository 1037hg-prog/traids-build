#!/usr/bin/env node
/**
 * ANOMALY DATA — one survivorship-reduced daily panel for the anomaly-replication study (#1, 2026-09-23, operator: "then this in your
 * order; complete a component and then move on to the next").
 *
 * UNIVERSE: every US common stock (NYSE / NASDAQ / NYSE MKT) in Alpha Vantage LISTING_STATUS that was listed at any point 2016-01..2026-09
 * — active names plus names delisted since 2016-01-01 (data/av-listing-status-{active,delisted}-2026-09-23.csv). SPAC shells, units,
 * warrants, rights, preferreds, funds, exchange test symbols removed by name/symbol. Each listing record's bars are clipped to its own
 * [ipoDate, delistingDate] window, so a recycled ticker does not splice two companies.
 * PRICES: Alpaca SIP daily bars (adjustment=all: split- and dividend-adjusted, so returns are total returns), 2016-01-01 .. 2026-09-22.
 * HYGIENE: a name with any one-day close-to-close or gap move above +300% is dropped (bad adjustments / restructuring splices, see R158);
 * large DOWN moves are kept — a bankruptcy collapse is a real loss the anomaly must bear.
 * OUTPUT: data/anomaly-cache/ — meta.json (dates, symbols, listing info, counts) and close.f32 / open.f32 / vol.f32, dense
 * [symbol][day] Float32 matrices (NaN where not listed / no bar).
 *   node backend/anomaly-data.js            build (refuses to overwrite a finished cache)
 */
const fs = require("fs"), path = require("path");
const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f), DIR = D("anomaly-cache"), START = "2016-01-01", END = "2026-09-22T21:00:00Z";
if (fs.existsSync(path.join(DIR, "meta.json"))) { const m = JSON.parse(fs.readFileSync(path.join(DIR, "meta.json"), "utf8")); console.log(`anomaly cache exists: ${m.symbols.length} symbols x ${m.dates.length} days (${m.builtAt}) — refusing to rebuild`); process.exit(0); }
fs.mkdirSync(DIR, { recursive: true });
const parse = (f) => { const [h, ...r] = fs.readFileSync(f, "utf8").trim().split(/\r?\n/); const k = h.split(","); return r.map((x) => { const c = x.split(","); return Object.fromEntries(k.map((kk, i) => [kk, c[i]])); }); };
const bad = /acquisition|capital corp|merger|spac|\bunits?\b|warrant|rights?\b|preferred|depositary|\btrust\b|\bfund\b|etf|etn|notes?\b|%|when issued|test/i;
const ok = (x) => x.assetType === "Stock" && ["NYSE", "NASDAQ", "NYSE MKT"].includes(x.exchange) && !bad.test(x.name || "") && /^[A-Z]{1,5}$/.test(x.symbol) && !/^Z[A-Z]ZZT$|^ZVV$|^ZXIET$/.test(x.symbol);
(async () => {
  const recs = [...parse(D("av-listing-status-active-2026-09-23.csv")).filter(ok).map((x) => ({ ...x, state: "active" })), ...parse(D("av-listing-status-delisted-2026-09-23.csv")).filter((x) => ok(x) && x.delistingDate >= "2016-01-01").map((x) => ({ ...x, state: "delisted" }))];
  const bySym = new Map(); for (const r of recs) (bySym.get(r.symbol) || bySym.set(r.symbol, []).get(r.symbol)).push({ ipo: r.ipoDate, del: r.delistingDate && r.delistingDate !== "null" ? r.delistingDate : "9999-12-31", name: r.name, state: r.state });
  const { bars: spyB } = await fetchBars(["SPY"], { start: START, end: END, feed: "sip", quiet: true }); const dates = spyB.SPY.map((b) => b.t.slice(0, 10)), di = new Map(dates.map((d, i) => [d, i])), T = dates.length;
  const syms = [...bySym.keys()].sort(), keptSyms = [], info = [], C = [], O = [], V = []; let dropped = { noBars: 0, jump: 0, short: 0 };
  for (let i = 0; i < syms.length; i += 50) {
    const chunk = syms.slice(i, i + 50); let res; for (let k = 0; k < 3; k++) { try { res = await fetchBars(chunk, { start: START, end: END, feed: "sip", requireAll: false, quiet: true }); break; } catch (e) { if (k === 2) throw e; await new Promise((z) => setTimeout(z, 5000)); } }
    for (const s of chunk) {
      const b = (res.bars[s] || []), win = bySym.get(s), inWin = (d) => win.some((w) => d >= w.ipo && d <= w.del);
      const kept = b.filter((x) => di.has(x.t.slice(0, 10)) && inWin(x.t.slice(0, 10)));
      if (kept.length < 60) { dropped[b.length ? "short" : "noBars"]++; continue; }
      let jump = false; for (let k = 1; k < kept.length; k++) { const r = kept[k].c / kept[k - 1].c - 1, g = kept[k].o / kept[k - 1].c - 1; if (r > 3 || g > 3) { jump = true; break; } } if (jump) { dropped.jump++; continue; }
      const c = new Float32Array(T).fill(NaN), o = new Float32Array(T).fill(NaN), v = new Float32Array(T).fill(NaN);
      for (const x of kept) { const j = di.get(x.t.slice(0, 10)); c[j] = x.c; o[j] = x.o; v[j] = x.v; }
      keptSyms.push(s); info.push({ s, listings: win }); C.push(c); O.push(o); V.push(v);
    }
    process.stdout.write(`  anomaly-data ${Math.min(i + 50, syms.length)}/${syms.length} · kept ${keptSyms.length}\r`);
  }
  const write = (f, arr) => { const buf = Buffer.alloc(arr.length * T * 4); arr.forEach((a, k) => Buffer.from(a.buffer).copy(buf, k * T * 4)); fs.writeFileSync(path.join(DIR, f), buf); };
  write("close.f32", C); write("open.f32", O); write("vol.f32", V);
  fs.writeFileSync(path.join(DIR, "meta.json"), JSON.stringify({ spec: "anomaly-cache-v1", builtAt: new Date().toISOString(), source: "AV LISTING_STATUS (active + delisted since 2016) x Alpaca SIP daily adjustment=all", dates, symbols: keptSyms, info, counts: { candidates: syms.length, kept: keptSyms.length, delistedKept: info.filter((x) => x.listings.every((w) => w.state === "delisted")).length, dropped } }));
  console.log(`\nanomaly cache: ${keptSyms.length} of ${syms.length} symbols x ${T} days · dropped ${JSON.stringify(dropped)}`);
})().catch((e) => { console.error("anomaly-data FAILED:", e.message); process.exit(1); });
