#!/usr/bin/env node
/**
 * R144 — the Dow-leads-the-S&P trade (registered 2026-09-22; operator: "register the lead-lag test"). From a Facebook reel by
 * "20-Minute Trader": on his whiteboard the Dow (red) moves, SPY (blue) does not follow within 2-4 minutes, and the circled BUY is on the
 * laggard. Tested on the futures the pros use for exactly this: YM (Dow) and ES (S&P), 1-minute bars, regular session only.
 *
 * RULE (frozen; six variants = lookback W in {2,3,4} minutes x gap G in {0.05%, 0.10%}):
 *   At the close of each 1-minute bar t (09:32-15:45 ET): rY = YM(t)/YM(t-W) - 1, rE = ES(t)/ES(t-W) - 1.
 *   LONG  ES when rY - rE >= G and rY > 0 (the Dow moved up, the S&P did not follow).
 *   SHORT ES when rY - rE <= -G and rY < 0.
 *   ENTRY at the OPEN of bar t+1 (clean timing: the signal bar is complete first). EXIT at the CLOSE of bar t+10.
 *   One position at a time: no new signal while a trade is open. netPts = (exit - entry) x direction - 0.75 ES points (a tick each side
 *   plus commission, charged conservatively).
 * STATISTIC: per SESSION the mean netPts over that session's signals; t across sessions that fired at least one signal. Unit: session.
 *
 *   node backend/r144-leadlag.js --synth <seed>   LEAK TEST: bar shapes shuffled within each day, INDEPENDENTLY per instrument, which
 *                                                 destroys the cross-instrument relationship the rule trades. Must show |t| < 2.
 *   node backend/r144-leadlag.js --peek           POSITIVE CONTROL: the same machinery using YM's NEXT W minutes (look-ahead by design).
 *                                                 It must light up, or the measurement cannot detect convergence even when it exists.
 *   node backend/r144-leadlag.js                  the registered run (refuses unless R144 is registered)
 */
const fs = require("fs"), path = require("path"); const tb = require("./futures-testbed"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const COST = 0.75, HOLD = 10, WS = [2, 3, 4], GS = [0.0005, 0.0010], FROM = "09:32", TO = "15:45";
const args = process.argv.slice(2), SYNTH = args.includes("--synth") ? Number(args[args.indexOf("--synth") + 1]) : null, PEEK = args.includes("--peek");
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length >= 3 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function scrambleDay(bs, r) { const sh = bs.map((b, i) => { const p = i ? bs[i - 1].c : b.o; return { o: b.o - p, h: b.h - p, l: b.l - p, c: b.c - p }; });
  for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
  let prev = bs[0].o; return bs.map((b, i) => { const s = sh[i], nb = { ...b, o: prev + s.o, h: prev + s.h, l: prev + s.l, c: prev + s.c }; prev = nb.c; return nb; }); }

(async () => {
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), R = [...(reg.tests || []), ...(reg.preregistered || [])].find((t) => t.id === "R144");
  if (SYNTH == null && !PEEK && !R) { console.error("R144 is not registered — the real run refuses."); process.exit(2); }
  const [esRaw, ymRaw] = await Promise.all([tb.loadBars({ root: "ES", resolution: "1minute", lookbackDays: 400, pages: 14, quiet: true }), tb.loadBars({ root: "YM", resolution: "1minute", lookbackDays: 400, pages: 14, quiet: true })]);
  const byDay = (bars) => { const d = {}; for (const b of bars) if (b.time >= "09:30" && b.time < "16:00") (d[b.date] ||= []).push(b); return d; };
  let es = byDay(esRaw), ym = byDay(ymRaw);
  if (SYNTH != null) { const r1 = rng(SYNTH), r2 = rng(SYNTH ^ 0x9e3779b9); for (const d of Object.keys(es)) es[d] = scrambleDay(es[d], r1); for (const d of Object.keys(ym)) ym[d] = scrambleDay(ym[d], r2); }
  const days = Object.keys(es).filter((d) => ym[d] && es[d].length > 300 && ym[d].length > 300).sort();
  const res = {};
  for (const W of WS) for (const G of GS) {
    const per = [], all = [];
    for (const d of days) {
      const E = es[d], Y = ym[d], eAt = new Map(E.map((b, i) => [b.time, i])), yAt = new Map(Y.map((b, i) => [b.time, i]));
      const sig = [];
      let openUntil = -1;
      for (let i = W; i < E.length - HOLD - 1; i++) {
        const b = E[i]; if (b.time < FROM || b.time >= TO) continue; if (i <= openUntil) continue;
        const yi = yAt.get(b.time), yPrev = yAt.get(E[i - W].time); if (yi == null || yPrev == null) continue;
        const rY = PEEK ? (Y[Math.min(yi + W, Y.length - 1)].c / Y[yi].c - 1) : (Y[yi].c / Y[yPrev].c - 1);   // --peek: YM's NEXT W minutes (look-ahead control)
        const rE = E[i].c / E[i - W].c - 1, gap = rY - rE;
        let dir = 0; if (gap >= G && rY > 0) dir = 1; else if (gap <= -G && rY < 0) dir = -1;
        if (!dir) continue;
        const entry = E[i + 1].o, exit = E[Math.min(i + 1 + HOLD, E.length - 1)].c, pts = (exit - entry) * dir;
        sig.push(pts - COST); openUntil = i + HOLD; }
      if (sig.length) { per.push(mean(sig)); all.push(...sig); }
    }
    const h = Math.floor(per.length / 2);
    res[`W${W}-G${(G * 100).toFixed(2)}%`] = { sessionsWithSignals: per.length, signals: all.length, meanNetPtsPerSession: per.length ? +mean(per).toFixed(3) : null,
      t: tOf(per) == null ? null : +tOf(per).toFixed(3), meanNetPtsPerSignal: all.length ? +mean(all).toFixed(3) : null, grossPerSignal: all.length ? +(mean(all) + COST).toFixed(3) : null,
      winPct: all.length ? +(100 * all.filter((x) => x > 0).length / all.length).toFixed(1) : null,
      halves: per.length ? { first: +mean(per.slice(0, h)).toFixed(3), second: +mean(per.slice(h)).toFixed(3) } : null, dollarsPerES: all.length ? +(all.reduce((s, x) => s + x, 0) * 50).toFixed(0) : null };
  }
  const mode = SYNTH != null ? `LEAK TEST (seed ${SYNTH})` : PEEK ? "POSITIVE CONTROL (look-ahead by design)" : "REGISTERED RUN";
  const out = { spec: "r144-leadlag-v1", test: "R144", mode, asOf: new Date().toISOString(), coverage: { first: days[0], last: days[days.length - 1], sessions: days.length }, variants: res };
  if (SYNTH == null && !PEEK) { const BAR = R.bar.tRequired, ok = Object.entries(res).filter(([, v]) => v.sessionsWithSignals >= R.bar.minSessions && v.meanNetPtsPerSession > 0 && v.t >= BAR && v.halves.first > 0 && v.halves.second > 0);
    out.read = true; out.verdict = ok.length ? `PASS — ${ok.map(([k]) => k).join(", ")}` : "DID NOT PASS"; }
  writeJsonAtomic(D(SYNTH != null ? `r144-synth-${SYNTH}.json` : PEEK ? "r144-peek.json" : "r144-leadlag.json"), out);
  console.log(`R144 ${mode} — ES/YM ${out.coverage.first}..${out.coverage.last}, ${out.coverage.sessions} sessions`);
  for (const [k, v] of Object.entries(res)) console.log(`  ${k.padEnd(12)} signals ${String(v.signals).padStart(5)} on ${String(v.sessionsWithSignals).padStart(3)} sessions · net/session ${String(v.meanNetPtsPerSession).padStart(7)} (t ${v.t}) · net/signal ${v.meanNetPtsPerSignal} (gross ${v.grossPerSignal}) · win ${v.winPct}% · halves ${v.halves ? v.halves.first + "/" + v.halves.second : "-"} · $${v.dollarsPerES} per ES`);
  if (out.verdict) console.log("VERDICT:", out.verdict);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
