#!/usr/bin/env node
/**
 * R157 — "AI SuperTrend x Pivot Percentile - Strategy [PresentTrading]", OUT OF SAMPLE (2026-09-23, operator: "AI SuperTrend then 1-3").
 * Translation checked against TradingView's own report (R153 third script, backend/r153-aist-verify.js, Bitfinex's own candles):
 * 114/139 of the author's trades reproduce (91 exact; 23 same exit with the entry shifted <= 48h), 20 extra of ours.
 * The report covers BITFINEX:BTCUSD 6h 2013-05 .. 2024-01 and was published 2024-01-27; trades entered 2024-01-27 .. 2026-09-22 are
 * out of sample. ONE member, the author's defaults, long and short, Bitfinex 6h/12h/1D candles.
 *
 * STATISTIC: monthly return = sum over trades exiting in the month of (direction x price return - 0.20% round trip, the author's own
 * 0.1% per side); 33 months 2024-01 .. 2026-09; Newey-West lag 1. Unit exposure (the author sizes 10% of equity; t is unaffected).
 * CONTROLS: drift-kept floor (2 scrambles of the 6h bars, 12h/1D re-aggregated from them), 10 arithmetic drift-free scrambles (mean
 * noise t < 2; member bar = bar + max(0, noise mean)), winners-only look-ahead must reach the member bar.
 */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { simulate, bitfinexCandles } = require("./r153-aist-verify.js");
const D = (f) => path.join(__dirname, "data", f), READ = process.argv.includes("--read"), OUT = D("r157-aist-oos.json"), CTRL = D("r157-controls.json");
const OOS = "2024-01-27T00:00:00Z", END = "2026-09-22T18:00:00Z", COST = 0.0020, SEEDS = 10;
const MONTHS = (() => { const o = []; for (let y = 2024; y <= 2026; y++) for (let m = 1; m <= 12; m++) { const k = y + "-" + String(m).padStart(2, "0"); if (k >= "2024-01" && k <= "2026-09") o.push(k); } return o; })();
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return v > 0 ? m / Math.sqrt(v / n) : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const aggFrom6h = (b6, hours) => { const m = new Map(), span = hours * 3600; for (const x of b6) { const k = Math.floor(x.ts / span) * span, b = m.get(k); if (!b) m.set(k, { ts: k, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v }); else { b.h = Math.max(b.h, x.h); b.l = Math.min(b.l, x.l); b.c = x.c; b.v += x.v; } } return [...m.values()].sort((a, b) => a.ts - b.ts); };
function scrambled(b6, seed, zeroDrift) {
  const rng = mulberry(seed * 1000003 + 157), p = [];
  for (let i = 1; i < b6.length; i++) { const x = b6[i]; p.push([x.o / b6[i - 1].c, x.h / x.o, x.l / x.o, x.c / x.o, x.v]); }
  if (zeroDrift) { const g = p.reduce((s, x) => s + x[0] * x[3], 0) / p.length, k = 1 / g; for (const x of p) x[0] *= k; }
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const out = [{ ...b6[0] }]; let c = b6[0].c; for (let i = 1; i < b6.length; i++) { const [go, gh, gl, gc, v] = p[i - 1], o = c * go; c = o * gc; out.push({ ...b6[i], o, h: o * gh, l: o * gl, c, v }); }
  return { tf: { "6h": out, "12h": aggFrom6h(out, 12), "1D": aggFrom6h(out, 24) } };
}
function evaluate(src, which = "all") {
  const b6 = src.tf["6h"], last = b6[b6.length - 1].c;
  const tr = simulate(src, OOS, END).filter((t) => t.entryT >= OOS).map((t) => { const net = t.dir * ((t.exitT ? t.exit : last) / t.entry - 1) - COST; return { ...t, net, month: (t.exitT || END).slice(0, 7) }; }).filter((t) => which === "all" || t.net > 0);
  const mm = new Map(MONTHS.map((k) => [k, 0])); for (const t of tr) if (mm.has(t.month)) mm.set(t.month, mm.get(t.month) + t.net);
  const s = MONTHS.map((k) => mm.get(k)), h = Math.floor(s.length / 2), tt = nwT(s);
  return { trades: tr.length, meanPctPerMonth: +(100 * mean(s)).toFixed(4), tNW: tt == null ? null : +tt.toFixed(3), firstHalfPct: +(100 * mean(s.slice(0, h))).toFixed(4), secondHalfPct: +(100 * mean(s.slice(h))).toFixed(4),
    winRatePct: tr.length ? +(100 * tr.filter((x) => x.net > 0).length / tr.length).toFixed(1) : null, compoundedPct: +(100 * (tr.reduce((e, x) => e * (1 + x.net), 1) - 1)).toFixed(1) };
}
(async () => {
  const tf = await bitfinexCandles(), real = { tf: { "6h": tf["6h"].filter((b) => b.ts * 1000 <= Date.parse(END)), "12h": tf["12h"], "1D": tf["1D"] } };
  if (process.argv.includes("--selftest")) { const is = simulate(real, "2013-01-01T00:00:00Z", "2024-01-27T00:00:00Z").filter((x) => x.entryT < "2024-01-27"); console.log(`R157 selftest: in-sample trades ${is.length} (TradingView 139); 6h bars ${real.tf["6h"].length}`); process.exit(is.length >= 120 && is.length <= 150 ? 0 : 1); }
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R157"); if (!t) { console.error("R157 not registered"); process.exit(2); }
  if (!READ) {
    const drift = [1, 2].map((z) => evaluate(scrambled(real.tf["6h"], z, false))), noise = []; for (let z = 1; z <= SEEDS; z++) noise.push(evaluate(scrambled(real.tf["6h"], z, true)));
    const ts = noise.map((x) => x.tNW ?? 0), mu = mean(ts), memberBar = +(t.bar.tRequired + Math.max(0, mu)).toFixed(3), peek = evaluate(real, "winners");
    const floor = +((drift[0].meanPctPerMonth + drift[1].meanPctPerMonth) / 2).toFixed(4), leakOk = mu < 2, peekOk = peek.tNW != null && peek.tNW >= memberBar;
    writeJsonAtomic(CTRL, { spec: "r157-controls-v1", asOf: new Date().toISOString(), leakTest: { seedsT: ts, meanT: +mu.toFixed(3), memberBar, pass: leakOk }, floorPctPerMonth: floor, driftRuns: drift, positiveControl: { tNW: peek.tNW, trades: peek.trades, pass: peekOk }, pass: leakOk && peekOk, note: "no unfiltered real statistic computed" });
    console.log(`R157 controls — leak ${leakOk ? "PASS" : "FAIL"} (noise mean t ${mu.toFixed(3)}) · look-ahead ${peekOk ? "PASS" : "FAIL"} (winners t ${peek.tNW}, ${peek.trades} trades) · member bar ${memberBar} · floor ${floor}%/month`);
    console.log(leakOk && peekOk ? "R157 READY — node backend/r157-aist-oos.js --read" : "R157 NOT READY"); return;
  }
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R157) { console.error("sealed"); process.exit(2); }
  const ctrl = JSON.parse(fs.readFileSync(CTRL, "utf8")); if (!ctrl.pass) { console.error("controls have not passed"); process.exit(2); }
  const v = evaluate(real), bar = ctrl.leakTest.memberBar, b6 = real.tf["6h"];
  v.clears = v.trades >= 15 && v.meanPctPerMonth > 0 && v.meanPctPerMonth > ctrl.floorPctPerMonth && v.tNW >= bar && v.firstHalfPct > 0 && v.secondHalfPct > 0;
  const bh = (b6[b6.length - 1].c / b6.find((b) => b.ts * 1000 >= Date.parse(OOS)).o - 1) * 100;
  writeJsonAtomic(OUT, { spec: "r157-read-v1", read: true, asOf: new Date().toISOString(), memberBar: bar, floor: ctrl.floorPctPerMonth, result: v, btcBuyHoldPct: +bh.toFixed(1), verdict: v.clears ? "PASS" : "DID NOT PASS" });
  console.log(`R157 READ — ${v.clears ? "PASS" : "DID NOT PASS"}: ${v.trades} trades · ${v.meanPctPerMonth}%/month (floor ${ctrl.floorPctPerMonth}) · t ${v.tNW} vs bar ${bar} · halves ${v.firstHalfPct}/${v.secondHalfPct} · win ${v.winRatePct}% · compounded ${v.compoundedPct}% (full exposure) vs BTC buy-and-hold ${bh.toFixed(1)}%`);
})().catch((e) => { console.error("R157 FAILED:", e.message); process.exit(1); });
