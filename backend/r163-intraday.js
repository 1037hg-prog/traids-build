#!/usr/bin/env node
/**
 * R163 — PUBLISHED INTRADAY PATTERNS on 30-minute bars, discovery 2017-2021, sealed holdout 2022-2026 (#3 of the operator's ordered
 * list, 2026-09-23). Universe: the 100 names of data/r147-universe.json + 15 liquid ETFs (the R151 set). Alpaca SIP 30-minute bars,
 * regular hours only (09:30..15:30 bar starts, 13 a day), adjustment=all.
 *
 * PATTERNS (direction fixed from the literature before any computation; bar k = the 30 minutes starting 09:30 + 30k):
 *   INTRAMOM      Gao-Han-Li-Zhou (2018): sign(first half-hour return incl. the overnight gap, prev close -> 10:00) -> hold 15:30 -> 16:00
 *   INTRAMOM_SPY  the same on SPY alone (the paper's own test)
 *   ORB30         10:30 close above the 09:30-10:00 high -> long to the close; below its low -> short
 *   VWAPREV       11:30 price more than 0.5% from the session VWAP so far -> position toward VWAP, held to the close
 *   GAPFADE       |open / prev close - 1| > 1% -> fade the gap from the open to the close
 *   PERIODICITY   Heston-Korajczyk-Sadka (2010): per half-hour interval k (bars 1..12), rank the 100 stocks by their mean interval-k
 *                 return over the previous 5 sessions; long the top quintile, short the bottom, for interval k today
 * COST: 0.05% per round trip per position (PERIODICITY pays it on both legs every interval).
 * STATISTIC: per session, the mean net return across that pattern's positions (0 when none); Newey-West t, lag 5, over sessions.
 * PROTOCOL: controls first — shuffled-session null (each symbol's signal paired with a random other session's outcome) must give |t| < 2
 * for every pattern (gross); positive control (position = sign of the outcome) t >= 5. DISCOVERY 2017-01..2021-12: carry mean > 0 and
 * t >= 1.5. HOLDOUT 2022-01..2026-09, --holdout, once, carried list only; PASS: mean > 0, t >= best-of-k bar, both halves positive.
 *   --build | --controls | --discovery | --holdout
 */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f), CACHE = D("r163-intraday-cache.json"), CTRL = D("r163-controls.json"), OUTD = D("r163-discovery.json"), OUTH = D("r163-holdout.json");
const ETFS = ["SPY", "QQQ", "IWM", "DIA", "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "XLC"], COST = 0.0005, DISC = ["2017-01-01", "2021-12-31"], HOLD = ["2022-01-01", "2026-09-22"];
const PATTERNS = ["INTRAMOM", "INTRAMOM_SPY", "ORB30", "VWAPREV", "GAPFADE", "PERIODICITY"];
const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const et = (iso) => { const p = Object.fromEntries(etFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value])); return { d: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` }; };
const SLOTS = Array.from({ length: 13 }, (_, k) => { const m = 570 + 30 * k; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; });
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a, L = 5) { const n = a.length; if (n < 10) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let k = 1; k <= L; k++) { let c = 0; for (let i = k; i < n; i++) c += d[i] * d[i - k]; v += 2 * (1 - k / (L + 1)) * c / n; } return v > 0 ? m / Math.sqrt(v / n) : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function build() {
  if (fs.existsSync(CACHE)) return console.log("r163 cache exists");
  const syms = [...JSON.parse(fs.readFileSync(D("r147-universe.json"), "utf8")).names, ...ETFS], out = {};
  for (const s of syms) {
    const days = {}; for (let y = 2016; y <= 2026; y++) {
      const { bars } = await fetchBars([s], { start: `${y}-01-01`, end: y === 2026 ? "2026-09-22T21:00:00Z" : `${y}-12-31T23:59:59Z`, timeframe: "30Min", feed: "sip", quiet: true, requireAll: false });
      for (const b of bars[s] || []) { const e = et(b.t), k = SLOTS.indexOf(e.hm); if (k < 0) continue; (days[e.d] ||= Array(13).fill(null))[k] = [b.o, b.h, b.l, b.c, b.vw, b.v]; } }
    out[s] = days; process.stdout.write(`  r163 build ${s} ${Object.keys(days).length} days\n`);
  }
  writeJsonAtomic(CACHE, { spec: "r163-cache-v1", builtAt: new Date().toISOString(), slots: SLOTS, bars: out }); console.log("r163 cache written");
}
// per symbol per day: signal position(s) and outcome return, for each pattern (except PERIODICITY, computed cross-sectionally)
function events(cache) {
  const ev = Object.fromEntries(PATTERNS.map((p) => [p, []]));      // {p, s, d, pos, r}
  for (const [s, days] of Object.entries(cache)) {
    const ds = Object.keys(days).sort(); let prevClose = null;
    for (const d of ds) { const b = days[d], full = b.every(Boolean), last = [...b].reverse().find(Boolean);
      if (full && prevClose) {
        const O = (k) => b[k][0], Hh = (k) => b[k][1], L = (k) => b[k][2], C = (k) => b[k][3];
        const s0 = C(0) / prevClose - 1, rl = C(12) / C(11) - 1; ev.INTRAMOM.push({ s, d, pos: Math.sign(s0), r: rl }); if (s === "SPY") ev.INTRAMOM_SPY.push({ s, d, pos: Math.sign(s0), r: rl });
        const orb = C(1) > Hh(0) ? 1 : C(1) < L(0) ? -1 : 0; ev.ORB30.push({ s, d, pos: orb, r: C(12) / C(1) - 1 });
        let pv = 0, vv = 0; for (let k = 0; k <= 3; k++) { pv += b[k][4] * b[k][5]; vv += b[k][5]; } const dev = vv > 0 ? C(3) / (pv / vv) - 1 : 0; ev.VWAPREV.push({ s, d, pos: Math.abs(dev) > 0.005 ? -Math.sign(dev) : 0, r: C(12) / C(3) - 1 });
        const gap = O(0) / prevClose - 1; ev.GAPFADE.push({ s, d, pos: Math.abs(gap) > 0.01 ? -Math.sign(gap) : 0, r: C(12) / O(0) - 1 });
      }
      if (last) prevClose = last[3]; }
  }
  return ev;
}
function periodicity(cache, sessions, outcomeShuffle = null, peek = false) {   // daily net spread averaged over intervals 1..12
  const names = Object.keys(cache).filter((s) => !ETFS.includes(s)), dayIdx = new Map(sessions.map((d, i) => [d, i])), res = {};
  const ir = (s, d, k) => { const b = cache[s][d]; return b && b[k] && b[k - 1] ? b[k][3] / b[k - 1][3] - 1 : NaN; };
  for (let i = 5; i < sessions.length; i++) { const d = sessions[i], per = [];
    for (let k = 1; k <= 12; k++) { const xs = [];
      for (const s of names) { const hist = [1, 2, 3, 4, 5].map((j) => ir(s, sessions[i - j], k)).filter(Number.isFinite); if (hist.length < 4) continue; const od = outcomeShuffle ? outcomeShuffle(s, i) : d, out = ir(s, od, k); if (!Number.isFinite(out)) continue; xs.push({ v: peek ? out : mean(hist), out }); }
      if (xs.length < 40) continue; xs.sort((a, b) => a.v - b.v); const q = Math.floor(xs.length / 5), lo = xs.slice(0, q), hi = xs.slice(-q); per.push({ gross: mean(hi.map((x) => x.out)) - mean(lo.map((x) => x.out)) }); }
    if (per.length) res[d] = { gross: mean(per.map((x) => x.gross)), net: mean(per.map((x) => x.gross)) - 2 * COST }; }
  return res;
}
function summarise(daily, from, to) { const ds = Object.keys(daily).filter((d) => d >= from && d <= to).sort(), net = ds.map((d) => daily[d].net), gross = ds.map((d) => daily[d].gross), h = Math.floor(net.length / 2);
  return { sessions: ds.length, netBpsPerDay: +(1e4 * mean(net)).toFixed(3), grossBpsPerDay: +(1e4 * mean(gross)).toFixed(3), tNW: nwT(net) == null ? null : +nwT(net).toFixed(3), tGrossNW: nwT(gross) == null ? null : +nwT(gross).toFixed(3), firstHalfBps: +(1e4 * mean(net.slice(0, h))).toFixed(3), secondHalfBps: +(1e4 * mean(net.slice(h))).toFixed(3), activeDaysPct: +(100 * ds.filter((d) => daily[d].n > 0).length / Math.max(1, ds.length)).toFixed(1) }; }
function dailyOf(list, mode = "real", rng = null, byKey = null) {   // per session: mean over positions of pos*r - cost (0-position rows contribute nothing)
  const out = {}; for (const e of list) { let pos = e.pos, r = e.r;
    if (mode === "shuffle") { const pool = byKey.get(e.s); r = pool[Math.floor(rng() * pool.length)]; } if (mode === "peek") pos = Math.sign(e.r);
    const o = (out[e.d] ||= { g: 0, n: 0, all: 0 }); o.all++; if (!pos) continue; o.g += pos * r; o.n++; }
  return Object.fromEntries(Object.entries(out).map(([d, o]) => [d, { n: o.n, gross: o.n ? o.g / o.n : 0, net: o.n ? o.g / o.n - COST : 0 }])); }
(async () => {
  const mode = ["--build", "--controls", "--discovery", "--holdout"].find((m) => process.argv.includes(m)) || "--build";
  if (mode === "--build") return build();
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); if (!reg.preregistered.find((x) => x.id === "R163")) { console.error("R163 not registered"); process.exit(2); }
  const cache = JSON.parse(fs.readFileSync(CACHE, "utf8")).bars, ev = events(cache), sessions = Object.keys(cache.SPY).sort();
  const all = (fn) => Object.fromEntries(PATTERNS.map((p) => [p, p === "PERIODICITY" ? fn.per() : fn.ev(ev[p])]));
  if (mode === "--controls") {
    const rng = mulberry(163), byKey = new Map(); for (const p of PATTERNS) for (const e of ev[p]) (byKey.get(e.s) || byKey.set(e.s, []).get(e.s)).push(e.r);
    const pool = new Map(); for (const p of PATTERNS) for (const e of ev[p]) { const k = p + "|" + e.s; (pool.get(k) || pool.set(k, []).get(k)).push(e.r); }
    const shuffled = {}, peek = {};
    for (const p of PATTERNS) { if (p === "PERIODICITY") { const rng2 = mulberry(1631); shuffled[p] = summarise(periodicity(cache, sessions, (s, i) => sessions[5 + Math.floor(rng2() * (sessions.length - 5))]), ...DISC); peek[p] = summarise(periodicity(cache, sessions, null, true), ...DISC); continue; }
      const bk = new Map(); for (const e of ev[p]) (bk.get(e.s) || bk.set(e.s, []).get(e.s)).push(e.r);
      shuffled[p] = summarise(dailyOf(ev[p], "shuffle", rng, bk), ...DISC); peek[p] = summarise(dailyOf(ev[p], "peek"), ...DISC); }
    const leakOk = PATTERNS.every((p) => shuffled[p].tGrossNW == null || Math.abs(shuffled[p].tGrossNW) < 2), peekOk = PATTERNS.every((p) => peek[p].tGrossNW >= 5);
    writeJsonAtomic(CTRL, { spec: "r163-controls-v1", asOf: new Date().toISOString(), shuffledGrossT: Object.fromEntries(PATTERNS.map((p) => [p, shuffled[p].tGrossNW])), peekGrossT: Object.fromEntries(PATTERNS.map((p) => [p, peek[p].tGrossNW])), leakOk, peekOk, pass: leakOk && peekOk });
    console.log(`R163 controls — shuffled |gross t|<2: ${leakOk ? "PASS" : "FAIL"} ${JSON.stringify(Object.fromEntries(PATTERNS.map((p) => [p, shuffled[p].tGrossNW])))} · positive control: ${peekOk ? "PASS" : "FAIL"} ${JSON.stringify(Object.fromEntries(PATTERNS.map((p) => [p, peek[p].tGrossNW])))}`); return;
  }
  const ctrl = fs.existsSync(CTRL) ? JSON.parse(fs.readFileSync(CTRL, "utf8")) : null; if (!ctrl || !ctrl.pass) { console.error("controls have not passed"); process.exit(2); }
  const real = { ...Object.fromEntries(PATTERNS.filter((p) => p !== "PERIODICITY").map((p) => [p, dailyOf(ev[p])])), PERIODICITY: periodicity(cache, sessions) };
  if (mode === "--discovery") {
    if (fs.existsSync(OUTD)) { console.error("discovery sealed"); process.exit(2); }
    const res = Object.fromEntries(PATTERNS.map((p) => [p, summarise(real[p], ...DISC)])), carried = PATTERNS.filter((p) => res[p].netBpsPerDay > 0 && res[p].tNW >= 1.5), k = carried.length;
    const nH = Object.keys(real.INTRAMOM).filter((d) => d >= HOLD[0] && d <= HOLD[1]).length, rng = mulberry(1632), mx = []; for (let i = 0; i < 5000; i++) { let b = -Infinity; for (let j = 0; j < Math.max(1, k); j++) { const s = []; for (let n = 0; n < nH; n++) s.push(rng() * 2 - 1); b = Math.max(b, nwT(s)); } mx.push(b); } mx.sort((a, b) => a - b); const bar = +mx[Math.floor(0.95 * mx.length)].toFixed(3);
    writeJsonAtomic(OUTD, { spec: "r163-discovery-v1", sealedAt: new Date().toISOString(), window: DISC, results: res, carriedForward: carried, holdoutBar: bar });
    console.log(`R163 DISCOVERY ${DISC.join("..")} (sealed) — carried ${k}: ${carried.join(", ") || "none"} · holdout bar t >= ${bar}`); for (const p of PATTERNS) console.log(`  ${p.padEnd(13)} net ${res[p].netBpsPerDay} bps/day (gross ${res[p].grossBpsPerDay}) · t ${res[p].tNW} · halves ${res[p].firstHalfBps}/${res[p].secondHalfBps} · active ${res[p].activeDaysPct}%${carried.includes(p) ? " · CARRIED" : ""}`); return;
  }
  if (mode === "--holdout") {
    if (fs.existsSync(OUTH)) { console.error("holdout already read"); process.exit(2); }
    const disc = JSON.parse(fs.readFileSync(OUTD, "utf8")), res = {}, ctx = {};
    for (const p of PATTERNS) { const v = summarise(real[p], ...HOLD); ctx[p] = { netBpsPerDay: v.netBpsPerDay, tNW: v.tNW }; if (disc.carriedForward.includes(p)) res[p] = { ...v, clears: v.netBpsPerDay > 0 && v.tNW >= disc.holdoutBar && v.firstHalfBps > 0 && v.secondHalfBps > 0 }; }
    const verdict = Object.values(res).some((v) => v.clears) ? "PASS" : "DID NOT PASS";
    writeJsonAtomic(OUTH, { spec: "r163-holdout-v1", read: true, asOf: new Date().toISOString(), window: HOLD, bar: disc.holdoutBar, carried: res, contextAll: ctx, verdict });
    console.log(`R163 HOLDOUT ${HOLD.join("..")} — ${verdict} (bar t >= ${disc.holdoutBar})`); for (const [p, v] of Object.entries(res)) console.log(`  ${p.padEnd(13)} net ${v.netBpsPerDay} bps/day · t ${v.tNW} · halves ${v.firstHalfBps}/${v.secondHalfBps}${v.clears ? " · CLEARS" : ""}`); console.log("  context (weightless):", JSON.stringify(ctx));
  }
})().catch((e) => { console.error("R163 FAILED:", e.message); process.exit(1); });
