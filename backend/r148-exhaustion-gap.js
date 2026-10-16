#!/usr/bin/env node
/**
 * R148 — THIRD-GAP EXHAUSTION FADE (Bharat Jhunjhunwala, "Exhaustion Gap Theory Explained", YouTube VzXjj8Aa78M, read from his
 * slides and whiteboard 2026-09-23). Operator: "register it as R148".
 *
 * HIS RULES, as shown on the "Trading Exhaustion Gaps: A Reversal Strategy" slide and the "secret trick" whiteboard:
 *   setup    an exhaustion gap near a key support/resistance level; a trend gaps three times (breakaway, continuation,
 *            exhaustion) and the THIRD gap is the exhaustion gap; a volume spike confirms it
 *   entry    near resistance: SHORT when price falls back to the gap; near support: LONG when price rallies back to it
 *   stop     beyond the far extreme of the exhaustion move
 *   target   2 : 1 reward to risk
 *
 * MECHANISED (daily bars, Alpaca SIP, adjustment=all), frozen here:
 *   gap up on day t      low[t] > high[t-1]          (the gap survived the whole session — a daily-chart gap)
 *   up leg               starts the session after the last close below its 50-day SMA; gaps are counted inside the leg
 *   uptrend at t         close[t-1] > SMA50[t-1] AND close[t-1] / close[t-61] - 1 >= +20%
 *   near resistance      high[t] >= 0.97 x the highest high of the 252 sessions before t
 *   exhaustion signal    the gap on day t is the leg's THIRD up-gap (exactly the third) and all of the above hold
 *   volume spike         volume[t] >= 1.5 x the mean volume of the 20 sessions before t        (variant: required or not)
 *   liquidity            close[t] >= $5 and the median of close x volume over the 20 sessions before t >= $5M
 *   entry (short)        the first of sessions t+1..t+10 that trades down to high[t-1] (the gap's lower edge): at that level,
 *                        or at the open if the session opens below it; no fill in 10 sessions = no trade
 *   stop                 the highest high from t to the session before entry; R = stop - entry, 0.5% .. 25% of entry
 *   target               entry - 2R
 *   management           entry session: a high at or above the stop counts as a stop (order unknowable on a daily bar);
 *                        the target is not credited on the entry session. Later sessions: stop first, then target; an open
 *                        beyond either exits at the open. Otherwise exit at the close of the 20th session after entry.
 *   cost                 0.10% of entry, round trip, charged in R
 *   LONG side            the exact mirror: gap down (high[t] < low[t-1]), downtrend (close < SMA50, 60-day return <= -20%),
 *                        low within 3% of the 252-session low, entry when price rallies back to low[t-1], stop at the lowest
 *                        low since t, target +2R.
 * VARIANTS (4): side {SHORT, LONG} x volume spike {required, not required}.
 * STATISTIC: unit = calendar MONTH of entry. Per month the mean net R of trades entered; headline t is Newey-West lag 1 across
 * months (a trade can run into the next month). Signals from 2017-01-03 (252 sessions of history after Alpaca's 2016 start).
 *
 *   node backend/r148-exhaustion-gap.js           selftest + both controls (scrambled prices x2, look-ahead) — never the real number
 *   node backend/r148-exhaustion-gap.js --read    the ONE real read; refuses unless registered, controls passed, not yet read
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f);
const READ = process.argv.includes("--read"), OUT = D("r148-exhaustion-gap.json"), CTRL = D("r148-controls.json");
const START = "2016-01-01", END = "2026-09-22T21:00:00Z", FIRST_SIGNAL = "2017-01-03", COST = 0.0010, CHUNK = 40, MIN_MONTHS = 60, MIN_TRADES = 200;
const VARIANTS = [["SHORT", true], ["SHORT", false], ["LONG", true], ["LONG", false]];

// ── signal + trade engine (pure) ────────────────────────────────────────────────────────────────────────────────────────
function trades(bars, { peek = false } = {}) {
  const n = bars.length, out = []; if (n < 300) return out;
  const c = bars.map((b) => b.c), sma = new Array(n).fill(null); let s = 0;
  for (let i = 0; i < n; i++) { s += c[i]; if (i >= 50) s -= c[i - 50]; if (i >= 49) sma[i] = s / 50; }
  let upGaps = 0, dnGaps = 0;
  for (let t = 1; t < n; t++) {
    if (sma[t - 1] != null && c[t - 1] < sma[t - 1]) upGaps = 0;          // an up leg restarts after a close below the SMA
    if (sma[t - 1] != null && c[t - 1] > sma[t - 1]) dnGaps = 0;
    const gapUp = bars[t].l > bars[t - 1].h, gapDn = bars[t].h < bars[t - 1].l;
    if (gapUp) upGaps++; if (gapDn) dnGaps++;
    if (t < 252 || bars[t].t.slice(0, 10) < FIRST_SIGNAL || sma[t - 1] == null) continue;
    for (const side of ["SHORT", "LONG"]) {
      const S = side === "SHORT";
      if (S ? !(gapUp && upGaps === 3) : !(gapDn && dnGaps === 3)) continue;
      const r60 = c[t - 1] / c[t - 61] - 1;
      if (S ? !(c[t - 1] > sma[t - 1] && r60 >= 0.20) : !(c[t - 1] < sma[t - 1] && r60 <= -0.20)) continue;
      let ext = S ? -Infinity : Infinity; for (let k = t - 252; k < t; k++) ext = S ? Math.max(ext, bars[k].h) : Math.min(ext, bars[k].l);
      if (S ? bars[t].h < 0.97 * ext : bars[t].l > 1.03 * ext) continue;
      const dv = []; let vs = 0; for (let k = t - 20; k < t; k++) { dv.push(bars[k].c * bars[k].v); vs += bars[k].v; }
      dv.sort((a, b) => a - b); if (!(c[t] >= 5 && dv[10] >= 5e6)) continue;
      const volSpike = bars[t].v >= 1.5 * (vs / 20);
      const level = S ? bars[t - 1].h : bars[t - 1].l;
      let u = -1, E = null;
      for (let k = t + 1; k <= Math.min(t + 10, n - 1); k++) {
        if (S ? bars[k].o <= level : bars[k].o >= level) { u = k; E = bars[k].o; break; }
        if (S ? bars[k].l <= level : bars[k].h >= level) { u = k; E = level; break; }
      }
      if (u < 0) continue;
      let stop = S ? -Infinity : Infinity; for (let k = t; k < u; k++) stop = S ? Math.max(stop, bars[k].h) : Math.min(stop, bars[k].l);
      const R = S ? stop - E : E - stop; if (!(R >= 0.005 * E && R <= 0.25 * E)) continue;
      const tgt = S ? E - 2 * R : E + 2 * R, sign = S ? -1 : 1;
      let exitPx = null, why = "";
      if (S ? bars[u].h >= stop : bars[u].l <= stop) { exitPx = stop; why = "stop (entry day)"; }
      for (let k = u + 1; exitPx == null && k < n && k <= u + 20; k++) {
        const b = bars[k];
        if (S ? b.o >= stop : b.o <= stop) { exitPx = b.o; why = "stop (gap)"; break; }
        if (S ? b.h >= stop : b.l <= stop) { exitPx = stop; why = "stop"; break; }
        if (S ? b.o <= tgt : b.o >= tgt) { exitPx = b.o; why = "target (gap)"; break; }
        if (S ? b.l <= tgt : b.h >= tgt) { exitPx = tgt; why = "target"; break; }
        if (k === u + 20) { exitPx = b.c; why = "time"; }
      }
      if (exitPx == null) continue;                                          // window not closed by END
      if (peek) { const f = bars[Math.min(u + 5, n - 1)].c; if (!(sign * (f - E) > 0)) continue; }   // look-ahead by design
      const gross = sign * (exitPx - E) / R;
      out.push({ side, volSpike, gapDay: bars[t].t.slice(0, 10), entry: bars[u].t.slice(0, 10), E, stop, R, gross, net: gross - COST * E / R, why });
    }
  }
  return out;
}

// ── statistics ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return v > 0 ? m / Math.sqrt(v / n) : null; }
function summarise(all) {
  const res = {};
  for (const [side, vol] of VARIANTS) {
    const key = `${side}-${vol ? "VOL" : "ANY"}`, tr = all.filter((x) => x.side === side && (!vol || x.volSpike)), byM = new Map();
    for (const x of tr) { const m = x.entry.slice(0, 7); (byM.get(m) || byM.set(m, []).get(m)).push(x.net); }
    const months = [...byM.keys()].sort(), series = months.map((m) => mean(byM.get(m))), h = Math.floor(series.length / 2);
    res[key] = { trades: tr.length, months: months.length, meanNetRPerMonth: series.length ? +mean(series).toFixed(4) : null, tNW: series.length > 2 ? +nwT(series).toFixed(3) : null,
      firstHalf: h ? +mean(series.slice(0, h)).toFixed(4) : null, secondHalf: h ? +mean(series.slice(h)).toFixed(4) : null,
      meanNetRPerTrade: tr.length ? +mean(tr.map((x) => x.net)).toFixed(4) : null, meanGrossRPerTrade: tr.length ? +mean(tr.map((x) => x.gross)).toFixed(4) : null,
      winRatePct: tr.length ? +(100 * tr.filter((x) => x.net > 0).length / tr.length).toFixed(1) : null,
      exits: tr.reduce((o, x) => ((o[x.why] = (o[x.why] || 0) + 1), o), {}) };
  }
  return res;
}

// ── scrambled prices: day pairs (open/prior close, high/open, low/open, close/open) moved within the symbol ────────────────
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = (s) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
function scramble(bars, seed, sym) {
  const rng = mulberry(seed * 1000003 + hash(sym)), p = [];
  for (let i = 1; i < bars.length; i++) { const b = bars[i]; p.push([b.o / bars[i - 1].c, b.h / b.o, b.l / b.o, b.c / b.o, b.v]); }
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const out = [bars[0]]; let c = bars[0].c;
  for (let i = 1; i < bars.length; i++) { const [go, gh, gl, gc, v] = p[i - 1], o = c * go; c = o * gc; out.push({ t: bars[i].t, o, h: o * gh, l: o * gl, c, v }); }
  return out;
}

// ── known-answer selftest on a hand-built path ──────────────────────────────────────────────────────────────────────────
function selftest() {
  const bars = []; let px = 50; const day = (i) => new Date(Date.UTC(2017, 0, 3) + i * 864e5).toISOString();
  const push = (o, h, l, c, v = 1e6) => bars.push({ t: day(bars.length - 300), o, h, l, c, v });
  for (let i = 0; i < 300; i++) { push(px, px + 0.5, px - 0.5, px); }                                  // flat base, 300 sessions
  for (let i = 0; i < 60; i++) { px += 0.4; push(px - 0.2, px + 0.3, px - 0.4, px); }                  // steady uptrend (+48%)
  const gap = (lo) => { px = lo + 1; push(lo + 0.2, lo + 1.5, lo, px, 3e6); };                          // gap: low above prior high
  gap(bars[bars.length - 1].h + 0.5); for (let i = 0; i < 3; i++) { px += 0.3; push(px - 0.1, px + 0.3, px - 0.3, px); }
  gap(bars[bars.length - 1].h + 0.5); for (let i = 0; i < 3; i++) { px += 0.3; push(px - 0.1, px + 0.3, px - 0.3, px); }
  const priorHigh = bars[bars.length - 1].h; gap(priorHigh + 0.5); const gapIdx = bars.length - 1, top = bars[gapIdx].h;
  push(px, px + 0.2, px - 0.4, px - 0.3);                                                              // stall
  push(px - 0.3, px - 0.2, priorHigh - 0.2, priorHigh - 0.1);                                          // fills the gap -> short at priorHigh
  for (let i = 0; i < 25; i++) { const c0 = bars[bars.length - 1].c; push(c0, c0 + 0.1, c0 - 1.2, c0 - 1.0); }   // falls away
  const tr = trades(bars).filter((x) => x.side === "SHORT");
  const t0 = tr[0] || {}, R = top - priorHigh;
  const checks = {
    exactlyOneShortSignal: tr.length === 1,
    signalOnTheThirdGap: t0.gapDay === bars[gapIdx].t.slice(0, 10),
    volumeSpikeSeen: t0.volSpike === true,
    entryAtTheGapsLowerEdge: Math.abs((t0.E ?? 0) - priorHigh) < 1e-9,
    stopAtTheIslandTop: Math.abs((t0.stop ?? 0) - top) < 1e-9,
    reachesTwoR: t0.why === "target" && Math.abs(t0.gross - 2) < 1e-9,
    costChargedInR: Math.abs((t0.gross - t0.net) - COST * priorHigh / R) < 1e-9,
    noLongOnAnUptrend: trades(bars).filter((x) => x.side === "LONG").length === 0,
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

// ── one pass over the universe, chunked so ~11M bars never sit in memory at once ─────────────────────────────────────────
async function pass(names, fn) {
  let done = 0, priced = 0; const missing = [];
  for (let i = 0; i < names.length; i += CHUNK) {
    const chunk = names.slice(i, i + CHUNK);
    const { bars, missing: m } = await fetchBars(chunk, { start: START, end: END, feed: "sip", requireAll: false, quiet: true });
    missing.push(...m); for (const s of chunk) if (bars[s] && bars[s].length) { fn(s, bars[s]); priced++; }
    done += chunk.length; if (done % 400 < CHUNK) process.stdout.write(`  R148 ${done}/${names.length} names\r`);
  }
  process.stdout.write("\n"); return { priced, missing: missing.length };
}

(async () => {
  const st = selftest(); console.log(`R148 selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`); if (!st.pass) process.exit(1);
  if (process.argv.includes("--selftest")) return;
  const names = JSON.parse(fs.readFileSync(D("universe-expanded.json"), "utf8")).names.map((x) => x.sym);
  if (!READ) {
    const s1 = [], s2 = [], pk = [];
    const cov = await pass(names, (sym, b) => { s1.push(...trades(scramble(b, 1, sym))); s2.push(...trades(scramble(b, 2, sym))); pk.push(...trades(b, { peek: true })); });
    const a1 = summarise(s1), a2 = summarise(s2), ap = summarise(pk);
    const slim = (v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { trades: x.trades, months: x.months, meanNetRPerMonth: x.meanNetRPerMonth, tNW: x.tNW }]));
    const leakOk = [a1, a2].every((a) => Object.values(a).every((x) => x.tNW == null || x.tNW < 2));
    const peekOk = Object.values(ap).every((x) => x.tNW != null && x.tNW >= 3);
    const floor = Object.fromEntries(Object.keys(a1).map((k) => [k, +(((a1[k].meanNetRPerMonth ?? 0) + (a2[k].meanNetRPerMonth ?? 0)) / 2).toFixed(4)]));
    const ctrl = { spec: "r148-controls-v1", asOf: new Date().toISOString(), coverage: cov, selftest: st,
      leakTest: { method: "each symbol's day shape (open gap, high, low, close vs open, volume) shuffled within the symbol, seeds 1 and 2", requirement: "no variant reaches t_NW >= 2 on scrambled prices", pass: leakOk, seed1: slim(a1), seed2: slim(a2), noiseFloorNetRPerMonth: floor },
      positiveControl: { method: "keep only trades whose close 5 sessions after entry is on the winning side (look-ahead by design)", requirement: "t_NW >= 3 in every variant", pass: peekOk, result: slim(ap) }, pass: leakOk && peekOk };
    writeJsonAtomic(CTRL, ctrl);
    console.log(`R148 controls — leak ${leakOk ? "PASS" : "FAIL"} ${JSON.stringify(slim(a1))}`);
    console.log(`  seed 2 ${JSON.stringify(slim(a2))}`);
    console.log(`  look-ahead ${peekOk ? "PASS" : "FAIL"} ${JSON.stringify(slim(ap))}`);
    console.log(`  noise floor (net R per month) ${JSON.stringify(floor)}`);
    console.log(ctrl.pass ? "R148 READY — the one read is: node backend/r148-exhaustion-gap.js --read" : "R148 NOT READY — a control failed; the read is refused until it is understood");
    return;
  }
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R148) { console.error("R148 already sealed — refusing"); process.exit(2); }
  if (fs.existsSync(OUT) && JSON.parse(fs.readFileSync(OUT, "utf8")).read) { console.error("R148 already read — seal it, do not re-read"); process.exit(2); }
  const ctrl = fs.existsSync(CTRL) ? JSON.parse(fs.readFileSync(CTRL, "utf8")) : null; if (!ctrl || !ctrl.pass) { console.error("R148 controls have not passed"); process.exit(2); }
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R148"); if (!t) { console.error("R148 not registered"); process.exit(2); }
  const all = []; const cov = await pass(names, (sym, b) => { for (const x of trades(b)) all.push({ sym, ...x }); });
  const v = summarise(all), bar = t.bar.tRequired, floor = ctrl.leakTest.noiseFloorNetRPerMonth;
  for (const [k, x] of Object.entries(v)) x.clears = x.trades >= MIN_TRADES && x.months >= MIN_MONTHS && x.meanNetRPerMonth > 0 && x.meanNetRPerMonth > floor[k] && x.tNW >= bar && x.firstHalf > 0 && x.secondHalf > 0;
  const verdict = Object.values(v).some((x) => x.clears) ? "PASS" : "DID NOT PASS";
  writeJsonAtomic(OUT, { spec: "r148-read-v1", read: true, asOf: new Date().toISOString(), bar, coverage: cov, noiseFloor: floor, variants: v, verdict,
    sample: all.filter((x) => x.side === "SHORT").slice(-15) });
  console.log(`R148 READ — ${verdict} (bar t_NW >= ${bar})`);
  for (const [k, x] of Object.entries(v)) console.log(`  ${k.padEnd(10)} trades ${x.trades} · months ${x.months} · net R/month ${x.meanNetRPerMonth} (floor ${floor[k]}) · t_NW ${x.tNW} · halves ${x.firstHalf}/${x.secondHalf} · per trade net ${x.meanNetRPerTrade} gross ${x.meanGrossRPerTrade} · win ${x.winRatePct}%${x.clears ? " · CLEARS" : ""}`);
})().catch((e) => { console.error("R148 FAILED:", e.message); process.exit(1); });
