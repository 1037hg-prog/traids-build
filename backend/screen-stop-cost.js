#!/usr/bin/env node
/**
 * STOP-TO-COST SCREEN for new futures roots (2026-09-18). Outcome-free and weightless: bars only, no engine, no rule, no result.
 * Same convention as data/stop-cost-screen-2026-09-17.json: every 1-minute bar in the 09:35-11:30 ET room window over the last
 * 20 sessions; ratio = median candle range / modelled round trip (2 ticks + commission / $ per point). Where no micro exists the
 * full-size contract and the $7.20 commission are used. Also prints how thin the tape is (bars per window, zero-range share).
 * Writes data/stop-cost-screen-2026-09-18.json.
 */
const tb = require("./futures-testbed.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const path = require("path");
const SPECS = {
  NKD: { name: "Nikkei 225, dollar contract (CME)", tick: 5, usdPerPt: 5, feeRt: 7.2, note: "$5 x index, tick 5 pts = $25; no micro" },
  NIY: { name: "Nikkei 225, yen contract (CME)", tick: 5, usdPerPt: 500 / 147, feeRt: 7.2, note: "Y500 x index, tick 5 pts = Y2,500; $/pt at an ASSUMED 147 yen per dollar; no micro" },
  PA: { name: "Palladium (NYMEX)", tick: 0.5, usdPerPt: 100, feeRt: 7.2, note: "100 oz, tick $0.50 = $50; no micro" },
  GC: { name: "Gold — control (micro MGC)", tick: 0.1, usdPerPt: 10, feeRt: 1.72, note: "should reproduce ~8.6 from the 09-17 screen" },
};
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
(async () => {
  const ranked = [];
  for (const [root, sp] of Object.entries(SPECS)) {
    const raw = await tb.loadBars({ root, resolution: "1minute", pages: 4, lookbackDays: 45, quiet: true });
    const sess = tb.sessionize(raw, { start: "09:30", minBars: 1 }), ds = Object.keys(sess).sort().slice(-21, -1);   // last 20 COMPLETE sessions (today dropped)
    const win = ds.flatMap((d) => sess[d].filter((b) => b.time >= "09:35" && b.time < "11:30")), rng = win.map((b) => b.h - b.l);
    const cost = 2 * sp.tick + sp.feeRt / sp.usdPerPt;
    const o = { market: root, name: sp.name, spec: sp.note, sessions: ds.length, barsPerWindow: ds.length ? +(win.length / ds.length).toFixed(1) : 0, barsPossible: 115,
      zeroRangePct: rng.length ? +(100 * rng.filter((x) => x === 0).length / rng.length).toFixed(1) : null, medianRangePts: rng.length ? q(rng, 0.5) : null, p75RangePts: rng.length ? q(rng, 0.75) : null,
      medianRangeTicks: rng.length ? +(q(rng, 0.5) / sp.tick).toFixed(1) : null, roundTripCostPts: +cost.toFixed(3), ratioMedian: rng.length ? +(q(rng, 0.5) / cost).toFixed(2) : null, ratioP75: rng.length ? +(q(rng, 0.75) / cost).toFixed(2) : null };
    ranked.push(o); console.log(JSON.stringify(o));
  }
  writeJsonAtomic(path.join(__dirname, "data", "stop-cost-screen-2026-09-18.json"), { kind: "stop-cost-screen", weight: "NONE — outcome-free feature screen", generatedAt: new Date().toISOString(), window: { start: "09:35", end: "11:30" }, ranked });
})().catch((e) => { console.error("FAILED", e.message); process.exit(1); });
