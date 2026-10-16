#!/usr/bin/env node
/**
 * R137 — cluster insider buying, six-month hold, against SPY (registered 2026-09-20 before any price was read). One run; refuses to overwrite.
 * Prices: Alpaca daily, consolidated tape, total-return adjusted, fetched once into data/r137-prices.json. Known-answer checks run before the read.
 */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBarsSip } = require("./lib/sip-fetch.js");
const D = (f) => path.join(__dirname, "data", f), OUT = D("r137-insider-cluster.json"), PX = D("r137-prices.json");
if (fs.existsSync(OUT)) { console.error("R137 — store already written; the read is one run. Refusing."); process.exit(2); }
const REG = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((t) => t.id === "R137"), BAR = REG.bar.tRequired, HOLD = 126;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null), sdv = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length < 3 ? null : +(mean(a) / (sdv(a) / Math.sqrt(a.length))).toFixed(3)), pct = (x) => (x == null ? null : +(100 * x).toFixed(2));
(async () => {
  const signals = JSON.parse(fs.readFileSync(D("r137-signals.json"), "utf8")).signals, syms = [...new Set(signals.map((s) => s.sym))];
  let px; if (fs.existsSync(PX)) px = JSON.parse(fs.readFileSync(PX, "utf8")); else {
    console.log(`fetching daily bars for ${syms.length} tickers + SPY …`); const r = await fetchBarsSip(["SPY", ...syms], { start: "2018-12-15", end: "2025-12-31", timeframe: "1Day", adjustment: "all", requireAll: false, requireSymbols: ["SPY"], quiet: true, chunkSize: 40 });
    px = {}; for (const [s, bars] of Object.entries(r.bars)) px[s] = bars.map((b) => [String(b.t).slice(0, 10), b.o, b.c]); writeJsonAtomic(PX, px); console.log(`priced ${Object.keys(px).length} of ${syms.length + 1} (effective end ${r.effectiveEnd})`); }
  const SPY = px.SPY, spyIdx = new Map(SPY.map((b, i) => [b[0], i]));
  const trade = (sym, signalDate) => { const i0 = SPY.findIndex((b) => b[0] > signalDate); if (i0 < 0 || i0 + HOLD >= SPY.length) return { why: "hold runs past the data" }; const dIn = SPY[i0][0], dOut = SPY[i0 + HOLD][0], bars = px[sym]; if (!bars) return { why: "no price history" };
    const m = new Map(bars.map((b) => [b[0], b])), a = m.get(dIn), z = m.get(dOut); if (!a || !z || !(a[1] > 0) || !(z[2] > 0)) return { why: "no bar on entry or exit day" }; const stock = z[2] / a[1] - 1, spy = SPY[i0 + HOLD][2] / SPY[i0][1] - 1; return { dIn, dOut, stock, spy, excess: stock - spy }; };
  // known-answer 1: plumbing — SPY vs itself is exactly zero excess, and the direct recomputation matches
  const ka = ["2020-03-23", "2022-01-03"].map((d) => { const t = trade("SPY", d), i = spyIdx.get(t.dIn); return { d, excess: t.excess, direct: SPY[i + HOLD][2] / SPY[i][1] - 1, viaTrade: t.stock }; }), ka1ok = ka.every((k) => Math.abs(k.excess) < 1e-12 && Math.abs(k.direct - k.viaTrade) < 1e-9);
  // known-answer 2: dates shuffled across tickers — the ticker-specific information is destroyed, so mean excess must be ~0 relative to its own spread
  let seed = 20260920; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296), dates = signals.map((s) => s.signalDate); for (let i = dates.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [dates[i], dates[j]] = [dates[j], dates[i]]; }
  const sh = signals.map((s, i) => trade(s.sym, dates[i])).filter((t) => t.excess != null); const shBy = {}; for (const t of sh) (shBy[t.dIn.slice(0, 7)] ||= []).push(t.excess); const shT = tOf(Object.values(shBy).map(mean));
  console.log(`known-answer 1 (plumbing): ${ka1ok ? "PASS" : "FAIL"} · known-answer 2 (dates shuffled across tickers): mean excess ${pct(mean(sh.map((t) => t.excess)))}%, month-clustered t ${shT} — reported, see note`);
  if (!ka1ok) { console.error("R137 — plumbing check failed; nothing read."); process.exit(3); }
  // ---- the read ----
  const rows = signals.map((s) => ({ ...s, ...trade(s.sym, s.signalDate) })), ok = rows.filter((r) => r.excess != null), miss = rows.filter((r) => r.excess == null), missNoHist = miss.filter((r) => r.why !== "hold runs past the data");
  const byM = {}; for (const r of ok) (byM[r.dIn.slice(0, 7)] ||= []).push(r.excess); const monthly = Object.keys(byM).sort().map((m) => mean(byM[m])), t = tOf(monthly);
  const penal = [...ok.map((r) => ({ m: r.dIn.slice(0, 7), e: r.excess })), ...missNoHist.map((r) => ({ m: r.signalDate.slice(0, 7), e: -0.30 }))], pM = {}; for (const x of penal) (pM[x.m] ||= []).push(x.e); const penalMonthly = Object.values(pM).map(mean);
  const grp = (f) => { const g = {}; for (const r of ok) (g[f(r)] ||= []).push(r.excess); return Object.fromEntries(Object.entries(g).sort().map(([k, v]) => [k, { n: v.length, meanExcessPct: pct(mean(v)), beatSpyPct: +(100 * v.filter((x) => x > 0).length / v.length).toFixed(1) }])); };
  const sorted = ok.map((r) => r.excess).sort((a, b) => a - b), tot = sorted.reduce((s, x) => s + x, 0), k5 = Math.ceil(sorted.length * 0.05);
  const pass = monthly.length >= REG.bar.minSessions && mean(monthly) > 0 && t >= BAR && mean(penalMonthly) > 0;
  const out = { spec: "r137-insider-cluster-v1", test: "R137", readAt: new Date().toISOString(), bar: REG.bar, verdict: pass ? "PASSES its bar — a candidate tilt for the operator's core portfolio to take to his adviser; adopts nothing" : "DID NOT PASS",
    primary: { signalsPriced: ok.length, entryMonths: monthly.length, meanMonthlyExcessPct: pct(mean(monthly)), t, perSignalMeanExcessPct: pct(mean(ok.map((r) => r.excess))), medianExcessPct: pct(sorted[Math.floor(sorted.length / 2)]), beatSpyPct: +(100 * ok.filter((r) => r.excess > 0).length / ok.length).toFixed(1), meanStockPct: pct(mean(ok.map((r) => r.stock))), meanSpyPct: pct(mean(ok.map((r) => r.spy))) },
    penalisedLens: { missingCountedAsMinus30: missNoHist.length, meanMonthlyExcessPct: pct(mean(penalMonthly)), t: tOf(penalMonthly) }, coverage: { signals: rows.length, priced: ok.length, noUsableHistory: missNoHist.length, holdPastData: miss.length - missNoHist.length, missingPct: +(100 * missNoHist.length / rows.length).toFixed(1) },
    knownAnswer: { plumbing: ka, shuffledDates: { n: sh.length, meanExcessPct: pct(mean(sh.map((x) => x.excess))), t: shT, note: "shuffling dates keeps the SMALL-CAP-vs-SPY tilt of the ticker list, so this is the universe's own excess, not zero by construction — it is the honest baseline for the primary" } },
    weightless: { byYear: grp((r) => r.dIn.slice(0, 4)), byBuyers: grp((r) => (r.buyers >= 4 ? "4+ insiders" : "3 insiders")), byDollars: grp((r) => (r.usd >= 1e6 ? "c) >= $1M" : r.usd >= 2.5e5 ? "b) $250k-$1M" : "a) < $250k")), top5pctShareOfTotal: +(sorted.slice(-k5).reduce((s, x) => s + x, 0) / tot).toFixed(2), bottom5pctShareOfTotal: +(sorted.slice(0, k5).reduce((s, x) => s + x, 0) / tot).toFixed(2) } };
  writeJsonAtomic(OUT, out); const p = out.primary;
  console.log(`\nR137 — ${out.verdict}\nPRIMARY: ${p.signalsPriced} signals over ${p.entryMonths} entry months · mean monthly excess over SPY ${p.meanMonthlyExcessPct}% per 6 months · t ${p.t} (bar ${BAR}) · median ${p.medianExcessPct}% · beat SPY ${p.beatSpyPct}% · stock ${p.meanStockPct}% vs SPY ${p.meanSpyPct}%`);
  console.log(`coverage: ${out.coverage.priced}/${out.coverage.signals} priced, ${out.coverage.noUsableHistory} with no usable history (${out.coverage.missingPct}%) · penalised lens ${out.penalisedLens.meanMonthlyExcessPct}% (t ${out.penalisedLens.t})\nbaseline (same tickers, dates shuffled): ${out.knownAnswer.shuffledDates.meanExcessPct}% (t ${shT})`);
  console.log("by year:", JSON.stringify(out.weightless.byYear)); console.log("by buyers:", JSON.stringify(out.weightless.byBuyers)); console.log("by dollars:", JSON.stringify(out.weightless.byDollars)); console.log(`top 5% of signals carry ${out.weightless.top5pctShareOfTotal} of the total excess; bottom 5% carry ${out.weightless.bottom5pctShareOfTotal}`);
})().catch((e) => { console.error("R137 FAILED:", e.message); process.exit(1); });
