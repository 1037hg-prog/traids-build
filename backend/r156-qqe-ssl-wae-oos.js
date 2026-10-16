#!/usr/bin/env node
/**
 * R156 — "QQE MOD + SSL Hybrid + Waddah Attar Explosion" (kevinmck100), OUT OF SAMPLE (2026-09-23, operator: "keep mining").
 * Translation VERIFIED against TradingView's own report (R153 second script: 98/109 trades match, backend/r153-qqe-verify.js).
 * The author's report covers BINANCE:BTCUSDT 1h 2022-01-01 .. 2022-05-05 (published 2022-05-05). Everything from 2022-05-06 on is
 * data the author never saw. ONE member: the author's exact defaults on BTC 1h (Coinbase BTC-USD hourly), trades entered
 * 2022-05-06 .. 2026-09-22, sized as published (each trade risks 2% of equity: weight = 2% / stop distance).
 *
 * STATISTIC: monthly strategy return = sum over trades EXITING in the month of weight x (direction x price return - 0.10% round trip);
 * 53 months 2022-05 .. 2026-09 (0 when no exits); Newey-West lag 1. (Holds are hours to a few days, so exit-month booking is exact to
 * within a day; the author's own commission was 0.02% round trip — the house 0.10% is charged.)
 * CONTROLS: drift-kept floor (2 hourly-bar scrambles), 10 arithmetic drift-free scrambles (mean noise t < 2; member bar = bar + max(0,
 * noise mean)), winners-only look-ahead must reach the member bar.
 */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { hourlyBars, simulate } = require("./r153-qqe-verify.js");
const D = (f) => path.join(__dirname, "data", f), READ = process.argv.includes("--read"), OUT = D("r156-qqe-ssl-wae-oos.json"), CTRL = D("r156-controls.json");
const OOS = "2022-05-06T00:00:00Z", END = "2026-09-22T21:00:00Z", COST = 0.0010, RISK = 0.02, SEEDS = 10;
const MONTHS = (() => { const o = []; for (let y = 2022; y <= 2026; y++) for (let m = 1; m <= 12; m++) { const k = y + "-" + String(m).padStart(2, "0"); if (k >= "2022-05" && k <= "2026-09") o.push(k); } return o; })();
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return v > 0 ? m / Math.sqrt(v / n) : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function scramble(bars, seed, zeroDrift = false) {
  const rng = mulberry(seed * 1000003 + 156), p = [];
  for (let i = 1; i < bars.length; i++) { const x = bars[i]; p.push([x.o / bars[i - 1].c, x.h / x.o, x.l / x.o, x.c / x.o, x.v]); }
  if (zeroDrift) { const g = p.reduce((s, x) => s + x[0] * x[3], 0) / p.length, k = 1 / g; for (const x of p) x[0] *= k; }
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const out = [{ ...bars[0] }]; let c = bars[0].c;
  for (let i = 1; i < bars.length; i++) { const [go, gh, gl, gc, v] = p[i - 1], o = c * go; c = o * gc; out.push({ ...bars[i], o, h: o * gh, l: o * gl, c, v }); }
  return out;
}
function evaluate(bars, which = "all") {
  const tr = simulate(bars, OOS, END).filter((t) => t.entryT >= OOS).map((t) => { const dist = Math.abs(t.entry - t.stop) / t.entry, w = dist > 0 ? RISK / dist : 0;
    const net = t.dir * ((t.exitT ? t.exit : bars[bars.length - 1].c) / t.entry - 1) - COST; return { ...t, weight: w, net, wnet: w * net, month: (t.exitT || END).slice(0, 7) }; })
    .filter((t) => which === "all" || t.net > 0);
  const mm = new Map(MONTHS.map((k) => [k, 0])); for (const t of tr) if (mm.has(t.month)) mm.set(t.month, mm.get(t.month) + t.wnet);
  const s = MONTHS.map((k) => mm.get(k)), h = Math.floor(s.length / 2), t = nwT(s);
  return { trades: tr.length, meanPctPerMonth: +(100 * mean(s)).toFixed(4), tNW: t == null ? null : +t.toFixed(3), firstHalfPct: +(100 * mean(s.slice(0, h))).toFixed(4), secondHalfPct: +(100 * mean(s.slice(h))).toFixed(4),
    winRatePct: tr.length ? +(100 * tr.filter((x) => x.net > 0).length / tr.length).toFixed(1) : null, meanWeight: tr.length ? +mean(tr.map((x) => x.weight)).toFixed(2) : null, compoundedPct: +(100 * (s.reduce((e, r) => e * (1 + r), 1) - 1)).toFixed(1) };
}
(async () => {
  const bars = hourlyBars().filter((b) => b.t <= END);
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R156");
  if (process.argv.includes("--selftest")) { const is = simulate(bars, "2022-01-01T00:00:00Z", "2022-05-05T12:00:00Z").filter((x) => x.entryT >= "2022-01-01" && x.entryT < "2022-05-06"); console.log(`R156 selftest: in-sample trades ${is.length} (TradingView 109); bars ${bars.length} ${bars[0].t.slice(0, 10)}..${bars[bars.length - 1].t.slice(0, 16)}`); process.exit(is.length >= 100 && is.length <= 118 ? 0 : 1); }
  if (!t) { console.error("R156 not registered"); process.exit(2); }
  if (!READ) {
    const drift = [1, 2].map((z) => evaluate(scramble(bars, z))), noise = []; for (let z = 1; z <= SEEDS; z++) noise.push(evaluate(scramble(bars, z, true)));
    const ts = noise.map((x) => x.tNW ?? 0), mu = mean(ts), memberBar = +(t.bar.tRequired + Math.max(0, mu)).toFixed(3), peek = evaluate(bars, "winners");
    const floor = +((drift[0].meanPctPerMonth + drift[1].meanPctPerMonth) / 2).toFixed(4), leakOk = mu < 2, peekOk = peek.tNW != null && peek.tNW >= memberBar;
    writeJsonAtomic(CTRL, { spec: "r156-controls-v1", asOf: new Date().toISOString(), leakTest: { seedsT: ts, meanT: +mu.toFixed(3), memberBar, pass: leakOk }, floorPctPerMonth: floor, driftRuns: drift, positiveControl: { tNW: peek.tNW, trades: peek.trades, requirement: "winners-only t >= member bar", pass: peekOk }, pass: leakOk && peekOk, note: "no unfiltered real statistic computed" });
    console.log(`R156 controls — leak ${leakOk ? "PASS" : "FAIL"} (noise mean t ${mu.toFixed(3)}) · look-ahead ${peekOk ? "PASS" : "FAIL"} (winners t ${peek.tNW}, ${peek.trades} trades) · member bar ${memberBar} · floor ${floor}%/month`);
    console.log(leakOk && peekOk ? "R156 READY — node backend/r156-qqe-ssl-wae-oos.js --read" : "R156 NOT READY");
    return;
  }
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R156) { console.error("sealed"); process.exit(2); }
  const ctrl = JSON.parse(fs.readFileSync(CTRL, "utf8")); if (!ctrl.pass) { console.error("controls have not passed"); process.exit(2); }
  const v = evaluate(bars), bar = ctrl.leakTest.memberBar;
  v.clears = v.trades >= 50 && v.meanPctPerMonth > 0 && v.meanPctPerMonth > ctrl.floorPctPerMonth && v.tNW >= bar && v.firstHalfPct > 0 && v.secondHalfPct > 0;
  const bh = (bars[bars.length - 1].c / bars.find((b) => b.t >= OOS).o - 1) * 100;
  writeJsonAtomic(OUT, { spec: "r156-read-v1", read: true, asOf: new Date().toISOString(), memberBar: bar, floor: ctrl.floorPctPerMonth, result: v, btcBuyHoldPct: +bh.toFixed(1), verdict: v.clears ? "PASS" : "DID NOT PASS" });
  console.log(`R156 READ — ${v.clears ? "PASS" : "DID NOT PASS"}: ${v.trades} trades · ${v.meanPctPerMonth}%/month (floor ${ctrl.floorPctPerMonth}) · t ${v.tNW} vs bar ${bar} · halves ${v.firstHalfPct}/${v.secondHalfPct} · win ${v.winRatePct}% · mean weight ${v.meanWeight}x · compounded ${v.compoundedPct}% vs BTC buy-and-hold ${bh.toFixed(1)}%`);
})().catch((e) => { console.error("R156 FAILED:", e.message); process.exit(1); });
