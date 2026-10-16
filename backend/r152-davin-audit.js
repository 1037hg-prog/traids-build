#!/usr/bin/env node
/** R152 DAVIN POST-READ AUDIT (2026-09-23). WEIGHTLESS — the sealed R152 verdict is unchanged. DAVIN cleared its bar but beat its
 *  drift-kept floor by 0.004%/month. Questions: (1) does it beat simply HOLDING the same 15 ETFs; (2) does it beat a matched placebo
 *  (random entry days, same symbol, same hold lengths); (3) how much of the time is it invested. Same daily-series statistic as R152. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
let src = fs.readFileSync(path.join(__dirname, "r152-tv-top-strategies.js"), "utf8").replace(/\(async \(\) => \{[\s\S]*$/, "module.exports = { DAVIN, summariseD, ETFS };");
const m = new module.constructor(); m.paths = module.paths; m.filename = path.join(__dirname, "r152-tv-top-strategies.js"); m._compile(src, m.filename);
const { DAVIN, summariseD, ETFS } = m.exports, COST = 0.001;
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const addDays = (r, x, b, member) => { const mp = (r.days[member] ||= new Map()), put = (d, v) => { const k = b[d].t.slice(0, 10), e = mp.get(k) || [0, 0]; e[0] += v; e[1]++; mp.set(k, e); };
  const ei = x.entryIdx, xi = x.exitIdx; if (xi === ei) { put(ei, x.dir * (x.exit / x.entry - 1) - COST); return; }
  put(ei, x.dir * (b[ei].c / x.entry - 1) - COST / 2); for (let d = ei + 1; d < xi; d++) put(d, x.dir * (b[d].c / b[d - 1].c - 1)); put(xi, x.dir * (x.exit / b[xi - 1].c - 1) - COST / 2); };
(async () => {
  const { bars } = await fetchBars(ETFS, { start: "2016-01-01", end: "2026-09-22T21:00:00Z", feed: "sip", requireAll: false, quiet: true });
  const real = { trades: [], days: {} }, hold = { trades: [], days: {} }, plac = { trades: [], days: {} }, rng = mulberry(1520); let inDays = 0, allDays = 0;
  for (const [s, b] of Object.entries(bars)) { if (b.length < 250) continue;
    const tr = DAVIN(b, s); for (const x of tr) { x.net = x.dir * (x.exit / x.entry - 1) - COST; real.trades.push(x); addDays(real, x, b, "DAVIN"); inDays += x.exitIdx - x.entryIdx + 1; }
    allDays += b.length - 200;
    const bh = { member: "DAVIN", dir: 1, entryIdx: 200, exitIdx: b.length - 1, entry: b[200].o, exit: b[b.length - 1].c, entryT: b[200].t }; bh.net = bh.exit / bh.entry - 1 - COST; hold.trades.push(bh); addDays(hold, bh, b, "DAVIN");
    for (const x of tr) for (let r = 0; r < 10; r++) { const len = x.exitIdx - x.entryIdx, ei = 200 + Math.floor(rng() * (b.length - 201 - len)); if (ei < 200) continue;
      const p = { member: "DAVIN", dir: 1, entryIdx: ei, exitIdx: ei + len, entry: b[ei].o, exit: len ? b[ei + len].o : b[ei].c, entryT: b[ei].t }; p.net = p.exit / p.entry - 1 - COST; plac.trades.push(p); addDays(plac, p, b, "DAVIN"); } }
  // the placebo has 10x the positions: weight its days back to one position's worth per real trade by the same equal-weight daily mean
  const R = summariseD(real).DAVIN, H = summariseD(hold).DAVIN, P = summariseD(plac).DAVIN;
  const out = { spec: "r152-davin-audit-v1", asOf: new Date().toISOString(), weightless: true, timeInMarketPct: +(100 * inDays / allDays).toFixed(1),
    davin: { meanPctPerMonth: R.meanNetPctPerMonth, tNW: R.tNW, trades: R.trades }, buyAndHoldSameEtfs: { meanPctPerMonth: H.meanNetPctPerMonth, tNW: H.tNW },
    matchedPlaceboRandomEntries: { meanPctPerMonth: P.meanNetPctPerMonth, tNW: P.tNW, trades: P.trades } };
  writeJsonAtomic(path.join(__dirname, "data", "r152-davin-audit.json"), out); console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error("audit FAILED:", e.message); process.exit(1); });
