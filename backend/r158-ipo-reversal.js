#!/usr/bin/env node
/**
 * R158 — PAYNE "IPO REVERSAL", the price rule (2026-09-23, operator: "AI SuperTrend then 1-3"; #3 = the IPO-reversal rule from the
 * Payne's Education webinar replay, screen recording 2026-09-23 162359). Payne's checklist: public at least a year; the stock "fell by
 * at least 50%"; "price stabilization"; "then the stock breaks out above its upper trend line". Examples given: Samsara, Lemonade,
 * AppLovin, Robinhood, Root. His fundamental items (great business, credible founder, revenue/margin growth) are judgement and are
 * NOT tested — this is the mechanical price part only.
 *
 * UNIVERSE: data/ipo-universe.json — 3,817 US common stocks listed 2016-01..2025-09 from Alpha Vantage LISTING_STATUS active + delisted
 * (1,309 since delisted), prices from Alpaca SIP (which keeps delisted symbols). A name is used only if its first Alpaca bar is within
 * 10 calendar days of its listed IPO date (so the post-IPO high is really post-IPO).
 * RULE (decided before any computation):
 *   eligible on day t: >= 252 bars since the first bar; the 40-bar base (t-40 .. t-1) has max close / min close <= 1.35, and the base's
 *   max close <= 50% of the highest close since the first bar (still at least 50% down); breakout: close_t > the base's max close.
 *   Entry at the next open. Exit: a close below the base's min close -> next open (stop), else after HOLD bars at that bar's close.
 *   One open position per name. Delisted names: an open position is marked at the last available close.
 *   Members: HOLD-126 (six months), HOLD-252 (a year).
 * STATISTIC: daily strategy-return series (equal weight across open positions each day), summed per month 2017-01 .. 2026-09 (117),
 * 0.30% round trip (small/mid-cap IPOs), Newey-West lag 1. CONTROLS as R154: drift-kept floor (2 seeds), per-member empirical null from
 * 10 arithmetic drift-free scrambles (mean noise t < 2), winners-only look-ahead >= the member bar.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f), READ = process.argv.includes("--read"), OUT = D("r158-ipo-reversal.json"), CTRL = D("r158-controls.json");
const START = "2016-01-01", END = "2026-09-22T21:00:00Z", COST = 0.0030, SEEDS = 10, BASE = 40, RANGE = 1.35, DOWN = 0.5, AGE = 252;
const MIN_PX = 2, TEST_SYM = /^Z[A-Z]ZZT$|^ZVV$|^ZXIET$|^ZJZZT$|^ZBZX$|^ZTEST/;   // amended 2026-09-23 pre-read (data hygiene)
const cleanBars = (b) => { for (let k = 1; k < b.length; k++) { const r = b[k].c / b[k - 1].c - 1, g = b[k].o / b[k - 1].c - 1; if (r > 3 || g > 3 || r < -0.9 || g < -0.9) return false; } return true; };
const MEMBERS = ["HOLD-126", "HOLD-252"], HOLDS = { "HOLD-126": 126, "HOLD-252": 252 };
const MONTHS = (() => { const o = []; for (let y = 2017; y <= 2026; y++) for (let m = 1; m <= 12; m++) { const k = y + "-" + String(m).padStart(2, "0"); if (k <= "2026-09") o.push(k); } return o; })();

function run(b, sym, member) {
  const hold = HOLDS[member], c = b.map((x) => x.c), out = []; let peak = -Infinity, pos = null, pend = null, exitPend = false;
  for (let i = 0; i < b.length; i++) {
    if (exitPend && pos) { out.push({ member, sym, dir: 1, entryIdx: pos.i, exitIdx: i, entryT: b[pos.i].t, entry: pos.px, exit: b[i].o, why: "stop" }); pos = null; exitPend = false; }
    if (pend && !pos) { pos = { i, px: b[i].o, floor: pend.floor }; } pend = null;
    if (pos && i - pos.i >= hold) { out.push({ member, sym, dir: 1, entryIdx: pos.i, exitIdx: i, entryT: b[pos.i].t, entry: pos.px, exit: c[i], why: "time" }); pos = null; }
    if (pos && c[i] < pos.floor && i + 1 < b.length) exitPend = true;
    if (!pos && !exitPend && i >= AGE && i >= BASE && i + 1 < b.length) {
      let bmax = -Infinity, bmin = Infinity; for (let k = i - BASE; k < i; k++) { bmax = Math.max(bmax, c[k]); bmin = Math.min(bmin, c[k]); }
      if (bmax / bmin <= RANGE && bmax <= DOWN * peak && c[i] > bmax && c[i] >= MIN_PX) pend = { floor: bmin };
    }
    peak = Math.max(peak, c[i]);            // the post-IPO high uses closes up to and including day i (known at its close)
  }
  if (pos) out.push({ member, sym, dir: 1, entryIdx: pos.i, exitIdx: b.length - 1, entryT: b[pos.i].t, entry: pos.px, exit: c[b.length - 1], why: "marked at end" });
  return out;
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return v > 0 ? m / Math.sqrt(v / n) : null; }
function summariseD(r, which = "days") { const res = {}; for (const m of MEMBERS) {
  const tr = r.trades.filter((x) => x.member === m && (which === "days" || x.peekOk)), mm = new Map(MONTHS.map((k) => [k, 0])), exp = new Set();
  for (const [d, [sum, cnt]] of (r[which][m] || new Map())) { const k = d.slice(0, 7); if (!mm.has(k)) continue; mm.set(k, mm.get(k) + sum / cnt); exp.add(k); }
  const s = MONTHS.map((k) => mm.get(k)), h = Math.floor(s.length / 2), t = nwT(s);
  res[m] = { trades: tr.length, names: new Set(tr.map((x) => x.sym)).size, months: exp.size, meanNetPctPerMonth: +(100 * mean(s)).toFixed(4), tNW: t == null ? null : +t.toFixed(3), firstHalfPct: +(100 * mean(s.slice(0, h))).toFixed(4), secondHalfPct: +(100 * mean(s.slice(h))).toFixed(4),
    meanNetPctPerTrade: tr.length ? +(100 * mean(tr.map((x) => x.net))).toFixed(3) : null, medianNetPctPerTrade: tr.length ? +(100 * tr.map((x) => x.net).sort((a, b) => a - b)[Math.floor(tr.length / 2)]).toFixed(3) : null,
    winRatePct: tr.length ? +(100 * tr.filter((x) => x.net > 0).length / tr.length).toFixed(1) : null, doublersPct: tr.length ? +(100 * tr.filter((x) => x.net >= 1).length / tr.length).toFixed(1) : null }; } return res; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = (s) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
function scramble(bars, seed, key, zeroDrift = false) {
  const rng = mulberry(seed * 1000003 + hash(key)), p = [];
  for (let i = 1; i < bars.length; i++) { const x = bars[i]; p.push([x.o / bars[i - 1].c, x.h / x.o, x.l / x.o, x.c / x.o, x.v]); }
  if (zeroDrift && p.length) { const g = p.reduce((s, x) => s + x[0] * x[3], 0) / p.length, k = 1 / g; for (const x of p) x[0] *= k; }
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const out = [{ ...bars[0] }]; let c = bars[0].c; for (let i = 1; i < bars.length; i++) { const [go, gh, gl, gc, v] = p[i - 1], o = c * go; c = o * gc; out.push({ ...bars[i], o, h: o * gh, l: o * gl, c, v }); }
  return out;
}
function selftest() {
  const mk = (px, i) => ({ t: new Date(Date.UTC(2017, 0, 2) + i * 864e5).toISOString(), o: px, h: px * 1.01, l: px * 0.99, c: px, v: 1e6 });
  const b = []; for (let i = 0; i < 700; i++) b.push(mk(i < 60 ? 20 + i * 0.5 : i < 300 ? 50 - (i - 60) * 0.15 : i < 420 ? 14 + ((i % 7) - 3) * 0.2 : 15 + (i - 420) * 0.1, i));
  const t = run(b, "X", "HOLD-126"), checks = { entersOnTheBreakoutAfterTheBase: t.length >= 1 && t[0].entryIdx > 420 && t[0].entryIdx < 440, doesNotEnterBeforeOneYear: t.every((x) => x.entryIdx >= 252), exitsByTimeOrStop: t.every((x) => x.exitIdx - x.entryIdx <= 127) };
  return { pass: Object.values(checks).every(Boolean), checks };
}
async function pass(transforms) {
  const U = JSON.parse(fs.readFileSync(D("ipo-universe.json"), "utf8")).names, ipo = new Map(U.map((x) => [x.symbol, x.ipoDate])), nameOf = new Map(U.map((x) => [x.symbol, x.name])), syms = U.map((x) => x.symbol);
  const res = transforms.map(() => ({ trades: [], priced: 0, skipped: 0, days: {}, peekDays: {} }));
  const addDays = (map, x, bars, cost) => { const m = (map[x.member] ||= new Map()), put = (d, v) => { const k = bars[d].t.slice(0, 10), e = m.get(k) || [0, 0]; e[0] += v; e[1]++; m.set(k, e); };
    const ei = x.entryIdx, xi = x.exitIdx; if (xi === ei) { put(ei, x.exit / x.entry - 1 - cost); return; }
    put(ei, bars[ei].c / x.entry - 1 - cost / 2); for (let d = ei + 1; d < xi; d++) put(d, bars[d].c / bars[d - 1].c - 1); put(xi, x.exit / bars[xi - 1].c - 1 - cost / 2); };
  const feed = (r, tr, bars) => { for (const x of tr) { x.net = x.exit / x.entry - 1 - COST; x.peekOk = x.net > 0; r.trades.push(x); addDays(r.days, x, bars, COST); if (x.peekOk) addDays(r.peekDays, x, bars, COST); } };
  for (let i = 0; i < syms.length; i += 50) {
    const { bars } = await fetchBars(syms.slice(i, i + 50), { start: START, end: END, feed: "sip", requireAll: false, quiet: true });
    for (const [s, b0] of Object.entries(bars)) { const lag = (Date.parse(b0[0]?.t) - Date.parse(ipo.get(s))) / 864e5; if (TEST_SYM.test(s) || /test/i.test(nameOf.get(s) || "") || !(b0.length > AGE + BASE) || !(lag >= -3 && lag <= 10) || !cleanBars(b0)) { res.forEach((r) => r.skipped++); continue; }
      transforms.forEach((tf, k) => { const b = tf(b0, s), r = res[k]; r.priced++; for (const m of MEMBERS) feed(r, run(b, s, m), b); }); }
    process.stdout.write(`  R158 ${Math.min(i + 50, syms.length)}/${syms.length}\r`);
  }
  process.stdout.write("\n"); return res;
}
(async () => {
  const st = selftest(); console.log(`R158 selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`); if (!st.pass) process.exit(1);
  if (process.argv.includes("--selftest")) return;
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R158"); if (!t) { console.error("R158 not registered"); process.exit(2); }
  const slim = (v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { trades: x.trades, meanNetPctPerMonth: x.meanNetPctPerMonth, tNW: x.tNW }]));
  if (!READ) {
    const tf = [(b, k) => scramble(b, 1, k), (b, k) => scramble(b, 2, k)]; for (let z = 1; z <= SEEDS; z++) tf.push((b, k) => scramble(b, z, k, true)); tf.push((b) => b);
    const runs = await pass(tf), a1 = summariseD(runs[0]), a2 = summariseD(runs[1]), nz = runs.slice(2, 2 + SEEDS).map((r) => summariseD(r)), real = runs[runs.length - 1], ap = summariseD(real, "peekDays");
    const nullT = Object.fromEntries(MEMBERS.map((k) => { const ts = nz.map((a) => a[k].tNW ?? 0), mu = mean(ts); return [k, { seedsT: ts, meanT: +mu.toFixed(3), memberBar: +(t.bar.tRequired + Math.max(0, mu)).toFixed(3) }]; }));
    const leakOk = Object.values(nullT).every((x) => x.meanT < 2), peekOk = MEMBERS.every((k) => ap[k].tNW != null && ap[k].tNW >= nullT[k].memberBar);
    const floor = Object.fromEntries(MEMBERS.map((k) => [k, +(((a1[k].meanNetPctPerMonth ?? 0) + (a2[k].meanNetPctPerMonth ?? 0)) / 2).toFixed(4)]));
    writeJsonAtomic(CTRL, { spec: "r158-controls-v2 (data hygiene)", asOf: new Date().toISOString(), priced: real.priced, skipped: real.skipped, selftest: st, leakTest: { pass: leakOk, empiricalNull: nullT, noiseFloorPctPerMonth: floor, driftKept: { seed1: slim(a1), seed2: slim(a2) } }, positiveControl: { pass: peekOk, result: slim(ap) }, pass: leakOk && peekOk, note: "no unfiltered real statistic computed" });
    console.log(`R158 controls — leak ${leakOk ? "PASS" : "FAIL"} · look-ahead ${peekOk ? "PASS" : "FAIL"} · priced ${real.priced}, skipped ${real.skipped}`);
    for (const k of MEMBERS) console.log(`  ${k} noise mean t ${nullT[k].meanT} -> bar ${nullT[k].memberBar} · floor ${floor[k]} · peek t ${ap[k].tNW} (${ap[k].trades} trades)`);
    console.log(leakOk && peekOk ? "R158 READY — node backend/r158-ipo-reversal.js --read" : "R158 NOT READY"); return;
  }
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R158) { console.error("sealed"); process.exit(2); }
  const ctrl = JSON.parse(fs.readFileSync(CTRL, "utf8")); if (!ctrl.pass) { console.error("controls have not passed"); process.exit(2); }
  const [real] = await pass([(b) => b]), v = summariseD(real), floor = ctrl.leakTest.noiseFloorPctPerMonth, mbar = (k) => ctrl.leakTest.empiricalNull[k].memberBar;
  for (const [k, x] of Object.entries(v)) x.clears = x.trades >= 100 && x.months >= 36 && x.meanNetPctPerMonth > 0 && x.meanNetPctPerMonth > floor[k] && x.tNW >= mbar(k) && x.firstHalfPct > 0 && x.secondHalfPct > 0;
  const verdict = Object.values(v).some((x) => x.clears) ? "PASS" : "DID NOT PASS";
  writeJsonAtomic(OUT, { spec: "r158-read-v1", read: true, asOf: new Date().toISOString(), familyBar: t.bar.tRequired, priced: real.priced, noiseFloor: floor, members: v, verdict });
  console.log(`R158 READ — ${verdict}`);
  for (const [k, x] of Object.entries(v)) console.log(`  ${k} trades ${x.trades} (${x.names} names) · %/month ${x.meanNetPctPerMonth} (floor ${floor[k]}) · t ${x.tNW} vs bar ${mbar(k)} · halves ${x.firstHalfPct}/${x.secondHalfPct} · per trade mean ${x.meanNetPctPerTrade}% median ${x.medianNetPctPerTrade}% · win ${x.winRatePct}% · doubled ${x.doublersPct}%${x.clears ? " · CLEARS" : ""}`);
})().catch((e) => { console.error("R158 FAILED:", e.message); process.exit(1); });
