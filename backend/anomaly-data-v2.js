#!/usr/bin/env node
/**
 * ANOMALY DATA v2 (2026-09-23) — fixes a look-ahead the #4 code reviewers found in v1 (backend/anomaly-data.js): v1 DROPPED every name
 * with a one-day move above +300% anywhere in 2016-2026 (342 names), i.e. it used knowledge of the whole future to decide who was in the
 * universe in 2017. v2 keeps those names up to the day BEFORE their first such jump (the jump is a recycled-ticker splice or a bad
 * adjustment; nothing after it is trusted) — the name then leaves the panel like a delisting, held at its last close.
 * Also records, per symbol, the truncation date so studies can disclose it. v1's kept rows are copied unchanged; only the symbols v1 did
 * not keep are fetched. Output: data/anomaly-cache-v2/ (same layout as v1). Refuses to overwrite a finished v2.
 * NOTE for studies: the panel is adjustment=all (split- and dividend-adjusted), so any PRICE-LEVEL screen (e.g. close >= $5) reads prices
 * that depend on later splits — a look-ahead. Use dollar-volume screens (invariant to split adjustment) instead.
 */
const fs = require("fs"), path = require("path"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f), V1 = D("anomaly-cache"), V2 = D("anomaly-cache-v2"), START = "2016-01-01", END = "2026-09-22T21:00:00Z";
if (fs.existsSync(path.join(V2, "meta.json"))) { console.log("anomaly-cache-v2 exists — refusing to rebuild"); process.exit(0); }
fs.mkdirSync(V2, { recursive: true });
const parse = (f) => { const [h, ...r] = fs.readFileSync(f, "utf8").trim().split(/\r?\n/); const k = h.split(","); return r.map((x) => { const c = x.split(","); return Object.fromEntries(k.map((kk, i) => [kk, c[i]])); }); };
const bad = /acquisition|capital corp|merger|spac|\bunits?\b|warrant|rights?\b|preferred|depositary|\btrust\b|\bfund\b|etf|etn|notes?\b|%|when issued|test/i;
const ok = (x) => x.assetType === "Stock" && ["NYSE", "NASDAQ", "NYSE MKT"].includes(x.exchange) && !bad.test(x.name || "") && /^[A-Z]{1,5}$/.test(x.symbol) && !/^Z[A-Z]ZZT$|^ZVV$|^ZXIET$/.test(x.symbol);
(async () => {
  const m1 = JSON.parse(fs.readFileSync(path.join(V1, "meta.json"), "utf8")), T = m1.dates.length, di = new Map(m1.dates.map((d, i) => [d, i])), N1 = m1.symbols.length;
  const rd = (f) => { const b = fs.readFileSync(path.join(V1, f)); return new Float32Array(b.buffer, b.byteOffset, N1 * T); };
  const C1 = rd("close.f32"), O1 = rd("open.f32"), V1v = rd("vol.f32");
  const recs = [...parse(D("av-listing-status-active-2026-09-23.csv")).filter(ok).map((x) => ({ ...x, state: "active" })), ...parse(D("av-listing-status-delisted-2026-09-23.csv")).filter((x) => ok(x) && x.delistingDate >= "2016-01-01").map((x) => ({ ...x, state: "delisted" }))];
  const bySym = new Map(); for (const r of recs) (bySym.get(r.symbol) || bySym.set(r.symbol, []).get(r.symbol)).push({ ipo: r.ipoDate, del: r.delistingDate && r.delistingDate !== "null" ? r.delistingDate : "9999-12-31", name: r.name, state: r.state });
  const kept1 = new Set(m1.symbols), todo = [...bySym.keys()].filter((s) => !kept1.has(s)).sort();
  const addSyms = [], addInfo = [], AC = [], AO = [], AV = []; let truncated = 0, stillShort = 0;
  for (let i = 0; i < todo.length; i += 50) {
    const chunk = todo.slice(i, i + 50), { bars } = await fetchBars(chunk, { start: START, end: END, feed: "sip", requireAll: false, quiet: true });
    for (const s of chunk) {
      const win = bySym.get(s), kept = (bars[s] || []).filter((x) => di.has(x.t.slice(0, 10)) && win.some((w) => x.t.slice(0, 10) >= w.ipo && x.t.slice(0, 10) <= w.del));
      let cut = kept.length, cutDate = null; for (let k = 1; k < kept.length; k++) { const r = kept[k].c / kept[k - 1].c - 1, g = kept[k].o / kept[k - 1].c - 1; if (r > 3 || g > 3) { cut = k; cutDate = kept[k].t.slice(0, 10); break; } }
      const use = kept.slice(0, cut); if (use.length < 60) { stillShort++; continue; }
      if (cutDate) truncated++;
      const c = new Float32Array(T).fill(NaN), o = new Float32Array(T).fill(NaN), v = new Float32Array(T).fill(NaN);
      for (const x of use) { const j = di.get(x.t.slice(0, 10)); c[j] = x.c; o[j] = x.o; v[j] = x.v; }
      addSyms.push(s); addInfo.push({ s, listings: win, truncatedBefore: cutDate }); AC.push(c); AO.push(o); AV.push(v);
    }
    process.stdout.write(`  v2 ${Math.min(i + 50, todo.length)}/${todo.length} · added ${addSyms.length}\r`);
  }
  const N2 = N1 + addSyms.length, write = (f, base, add) => { const buf = Buffer.alloc(N2 * T * 4); Buffer.from(base.buffer, base.byteOffset, N1 * T * 4).copy(buf, 0); add.forEach((a, k) => Buffer.from(a.buffer).copy(buf, (N1 + k) * T * 4)); fs.writeFileSync(path.join(V2, f), buf); };
  write("close.f32", C1, AC); write("open.f32", O1, AO); write("vol.f32", V1v, AV);
  fs.writeFileSync(path.join(V2, "meta.json"), JSON.stringify({ spec: "anomaly-cache-v2", builtAt: new Date().toISOString(), source: m1.source + " · v2: names with a >+300% one-day move are TRUNCATED before the move instead of dropped (point-in-time)", dates: m1.dates, symbols: [...m1.symbols, ...addSyms], info: [...m1.info.map((x) => ({ ...x, truncatedBefore: null })), ...addInfo], counts: { v1Kept: N1, added: addSyms.length, truncated, stillTooShort: stillShort, total: N2, delistedKept: [...m1.info, ...addInfo].filter((x) => x.listings.every((w) => w.state === "delisted")).length } }));
  console.log(`\nanomaly-cache-v2: ${N2} symbols (${N1} from v1 + ${addSyms.length} added, ${truncated} truncated at their first +300% jump; ${stillShort} still too short)`);
})().catch((e) => { console.error("anomaly-data-v2 FAILED:", e.message); process.exit(1); });
