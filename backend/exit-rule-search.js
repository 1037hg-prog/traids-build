/**
 * EXIT-RULE SEARCH — a demonstration kept in the repo because its result is a standing warning.
 *
 * Built 2026-08-14 (operator: "you could trade on that t of 5.95 and then predict when to get
 * out" / "maintaining profit"). Twelve plausible exit rules applied to the same extended-momentum
 * entries. The winner, a 10% take-profit, prints t = 2.71 — comfortably past the textbook 2.0.
 *
 * It is not significant. Searching twelve rules raises the honest 95% bar to about 3.39 (see
 * lib/null-bar.js), and a best-of-12 that good arrives by chance 13% of the time. The search
 * manufactured the number.
 *
 * The secondary finding is worth as much: every PROFIT-PROTECTION rule ranked at the bottom.
 * Trailing stops went 3% -> t=-0.21, 5% -> 0.61, 8% -> 0.69, 12% -> 1.39. Tighter protection,
 * worse result, and a 3% trail turned the edge negative — because extended momentum names are
 * volatile enough that a tight trail is triggered by ordinary noise before the move develops.
 * Protecting profit and capturing momentum are opposed; you may have one.
 *
 * Original note follows.
 */
// What does "find the right exit" actually do? Take the extended-momentum cohort and try a grid
// of plausible exit rules. Report every one, the best one, and — the part that matters — what the
// best-of-N looks like when the same search is run against PURE NOISE with no edge in it at all.
const API = "http://localhost:3001";
const fs = require("fs");
const ROOT = "C:/Users/joshc/Downloads/traids (2)/traids-bundle";
const post = (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(180000) }).then(r => r.json());
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

(async () => {
  const map = JSON.parse(fs.readFileSync(ROOT + "/backend/data/sector-map.json", "utf8"));
  const uni = Object.keys(map);
  const data = (await post(`${API}/api/equities/bars`, { symbols: [...uni, "SPY"], days: 500 })).data || {};
  const spy = data.SPY || [], dates = spy.map(b => b.t), spyC = spy.map(b => b.c);
  const S = {};
  for (const s of uni) { const b = data[s]; if (Array.isArray(b) && b.length > 150) S[s] = new Map(b.map(x => [x.t, x.c])); }
  const syms = Object.keys(S);

  // exit rules: hold N days, or trailing stop X%, or take-profit Y% — the usual grid
  const RULES = [
    ...[3, 5, 10, 15, 20, 30].map(n => ({ name: `hold ${n}d`, kind: "time", n })),
    ...[3, 5, 8, 12].map(x => ({ name: `trail ${x}%`, kind: "trail", x })),
    ...[5, 10].map(y => ({ name: `target ${y}%`, kind: "tp", y })),
  ];
  const MAXH = 30;

  // build entries: top-quintile 20d excess, sampled every 20 sessions (non-overlapping)
  const entries = [];
  for (let i = 60; i < dates.length - MAXH; i += 20) {
    const spyRet = 100 * (spyC[i] / spyC[i - 20] - 1);
    const day = [];
    for (const s of syms) {
      const c0 = S[s].get(dates[i - 20]), c1 = S[s].get(dates[i]);
      if (c0 > 0 && c1 > 0) day.push({ s, ex: 100 * (c1 / c0 - 1) - spyRet });
    }
    if (day.length < 40) continue;
    day.sort((a, b) => b.ex - a.ex);
    for (const o of day.slice(0, Math.floor(day.length / 5))) entries.push({ sym: o.s, i });
  }

  const runRule = (rule) => {
    const perPeriod = new Map();
    for (const e of entries) {
      const px = []; for (let k = 0; k <= MAXH; k++) { const c = S[e.sym].get(dates[e.i + k]); px.push(c > 0 ? c : null); }
      if (!px[0]) continue;
      let exitK = MAXH, peak = px[0];
      for (let k = 1; k <= MAXH; k++) {
        if (!px[k]) continue;
        const r = 100 * (px[k] / px[0] - 1);
        peak = Math.max(peak, px[k]);
        if (rule.kind === "time" && k >= rule.n) { exitK = k; break; }
        if (rule.kind === "trail" && 100 * (px[k] / peak - 1) <= -rule.x) { exitK = k; break; }
        if (rule.kind === "tp" && r >= rule.y) { exitK = k; break; }
      }
      const pe = px[exitK]; if (!pe) continue;
      const ret = 100 * (pe / px[0] - 1) - (100 * (spyC[e.i + exitK] / spyC[e.i] - 1));
      (perPeriod.get(e.i) || perPeriod.set(e.i, []).get(e.i)).push(ret);
    }
    const per = [...perPeriod.values()].map(mean);
    const m = mean(per), s = sd(per);
    return { mean: m, t: s ? m / (s / Math.sqrt(per.length)) : 0, n: per.length };
  };

  console.log(`\n  EXIT-RULE SEARCH on ${entries.length} extended-momentum entries, non-overlapping periods\n`);
  const res = RULES.map(r => ({ ...r, ...runRule(r) })).sort((a, b) => b.t - a.t);
  for (const r of res) console.log(`    ${r.name.padEnd(12)} excess ${(r.mean >= 0 ? "+" : "") + r.mean.toFixed(3)}%   t=${r.t.toFixed(2)}   (${r.n} periods)`);
  const best = res[0];
  console.log(`\n    BEST OF ${RULES.length}: "${best.name}" at t = ${best.t.toFixed(2)}`);

  // Null: same search, same shapes, on RANDOM data with zero edge.
  const nullBest = [];
  for (let trial = 0; trial < 2000; trial++) {
    let bt = -Infinity;
    for (let r = 0; r < RULES.length; r++) {
      const per = Array.from({ length: best.n }, () => (Math.random() * 2 - 1) * 3);   // null draw: best-of-N noise null for the searched t — never a price
      const m = mean(per), s = sd(per);
      bt = Math.max(bt, s ? m / (s / Math.sqrt(per.length)) : 0);
    }
    nullBest.push(bt);
  }
  nullBest.sort((a, b) => a - b);
  const p95 = nullBest[Math.floor(0.95 * nullBest.length)];
  const beats = 100 * nullBest.filter(x => x >= best.t).length / nullBest.length;
  console.log(`\n    THE NULL: run the SAME ${RULES.length}-rule search on pure noise, 2,000 times.`);
  console.log(`      best-of-${RULES.length} t exceeds ${p95.toFixed(2)} in 5% of runs — that is the bar a tuned exit must clear, not 2.0`);
  console.log(`      a best-of-${RULES.length} t of ${best.t.toFixed(2)} or higher happens by chance ${beats.toFixed(1)}% of the time\n`);
})();
