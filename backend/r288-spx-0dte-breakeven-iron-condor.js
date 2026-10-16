#!/usr/bin/env node
/**
 * R288 — SPX 0DTE "BREAKEVEN" IRON CONDOR (Sandvand), registered 2026-09-29 (the registry entry wins; SCOUT-0929 family).
 *
 * RULE (registry text, implemented; every departure or gap-fill is listed in NOTES below and in knownWeaknesses):
 *   SPXW same-day expiry. One iron condor per hour 10:00,11:00,...,15:00 ET. Short put / short call = the OTM strike whose |delta| is
 *   closest to 0.12 inside the band 0.10-0.15; wings 30 SPX points further out. If the two sides' mid credits differ by >25% the short
 *   strike of the side that needs it moves ONE strike (5 pts) toward ATM so the credits come closer. A separate stop on EACH short leg at a
 *   mark equal to the TOTAL condor credit; after 13:00 the level tightens linearly to credit x remaining-time fraction (floor 0.5 x credit).
 *   Profit target: buy a short leg back at $0.05. Otherwise held to expiry (cash settled at the official SPX close). 1 condor per $25k NAV
 *   per entry (NAV $25k); no new entries once realised loss today <= 2% NAV ($500). Cost: full crossing per leg at entry, stop and target,
 *   plus $0.65 commission + exchange/regulatory fees per contract traded.
 *
 * STATISTIC (registry): per-session net P&L per $ of maximum risk; one-sample t over sessions (clustering unit = sessions).
 *   session R = sum(condor net $) / sum(condor max risk $), max risk per condor = (30 - total mid credit) x 100.
 *   Read window = the sealed HOLDOUT 2025-06-02..2026-09-28 (nExpected 340 = the bar's n). The discovery window 2024-01-02..2025-05-30 is
 *   computed too and reported as context; nothing is tuned on it (there is nothing to tune: every parameter is fixed above).
 *   Bar = registry bar.tRequired read at run time (never hard-coded). Placebo = random-minute-inside-the-same-hour null, 200 draws,
 *   PASS needs observed mean session R > null p95. Controls reported: no-stop hold-to-expiry twin at the same strikes; R162-style single
 *   09:45 condor held to expiry; cost at 1x, 2x and mid.
 *
 *   node backend/r288-spx-0dte-breakeven-iron-condor.js --fetch      cache SPXW 1-minute trade bars + SPY-implied SPX path per session
 *   node backend/r288-spx-0dte-breakeven-iron-condor.js --coverage   entries/skips per hour on a few DISCOVERY days (no P&L printed)
 *   node backend/r288-spx-0dte-breakeven-iron-condor.js --selftest   known answers on synthetic days (must pass before --read)
 *   node backend/r288-spx-0dte-breakeven-iron-condor.js --read       the one registered read (refuses if already read)
 *
 * NOTES (fixed before any outcome):
 *  N1 Alpaca option bars are TRADE bars. Each leg is priced by the underlying-implied mark: BS price at the current SPX with the implied vol
 *     of the leg's last print (a print no older than 30 min for entry selection). Stops/targets fire on that mark, never on a stale print.
 *  N2 SPX path = SPY SIP 1-minute close x k, k = official SPX close (FRED SP500) / SPY last regular 1-minute close of that day. Settlement =
 *     the official SPX close. Bar j (09:30+j) is known at clock 09:30+j+1; an entry at clock t uses bars <= t-1 and fills at t.
 *  N3 SPX has no R162 haircut. R162 charged the per-underlying median mid-minus-cross gap per spread = $0.01 on SPY-class (1 cent on a
 *     1-wide spread); SPX is 10x SPY notional so the same gap is $0.10 per spread = $0.05 per leg. BASE crossing = $0.05/leg/transaction,
 *     STRESS = $0.10, MID = 0. Fees: $0.65 commission + $0.20 exchange/regulatory per contract per trade (entries: 4; each early close: 1).
 *     Exits are triggered on marks so they are identical across cost arms; only the P&L pricing differs.
 *  N4 Rule gaps filled (fixed here, before any read): (a) 'move the richer side toward ATM' is self-contradictory (toward ATM RAISES a side's
 *     credit); the stated purpose is equal credits, so the POORER side moves one strike toward ATM, once. (b) Entry needs a print within 30
 *     minutes on the short and on the wing, and each side's mid credit >= $0.10, else the entry is skipped. (c) The tightened stop level is
 *     floored at short entry mark + $0.05 or late entries would stop on the entry bar. (d) Gross-risk cap = 6 open condors (= the six daily
 *     entries, never binds; not modelled). (e) Daily loss cap counts realised short-leg round trips (net of cost) closed before the entry
 *     time. (f) After a short leg is closed its long wing is held to expiry and settles at intrinsic. (g) Early-close sessions are skipped.
 *  N5 Random-minute null: each hour's entry minute uniform on [h:00, h:59] (hour 15 capped at 15:54), resampled until entries are >= 30 min apart.
 */
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { loadBars } = require("./lib/equity-bars-1m.js");
const D = (f) => path.join(__dirname, "data", f), CACHE = D("training/R288"), OUT = D("r288-spx-0dte-breakeven-iron-condor.json");

// ---------- constants (fixed) ----------
const ID = "R288", KEY = "SPX_0DTE_BREAKEVEN_IRON_CONDOR";
const FROM = "2024-01-02", DISC_TO = "2025-05-30", HOLD_FROM = "2025-06-02", TO = "2026-09-28";
const ENTRY_HOURS = [10, 11, 12, 13, 14, 15], DELTA_T = 0.12, DELTA_LO = 0.10, DELTA_HI = 0.15, WING = 30, STEP = 5;
const EQ_TOL = 0.25, MIN_SIDE_CREDIT = 0.10, PRINT_WINDOW = 30, TARGET_PX = 0.05, TIGHT_FROM = 210 /* 13:00 */, TIGHT_FLOOR = 0.5, TIGHT_SPAN = 180;
const H_BASE = 0.05, COMM = 0.65, FEES = 0.20, NAV = 25000, DAILY_CAP = 0.02 * NAV, RATE = 0.045, MIN_YR = 525600, DRAWS = 200, NULL_SEED = 288288;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
function nwT(a) { const n = a.length, m = mean(a), L = Math.floor(4 * (n / 100) ** (2 / 9)); let v = a.reduce((s, x) => s + (x - m) ** 2, 0) / n;
  for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += (a[i] - m) * (a[i - l] - m); v += 2 * (1 - l / (L + 1)) * g / n; } return m / Math.sqrt(v / n); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------- Black-Scholes ----------
const ncdf = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
function bs(right, S, K, T, v) { T = Math.max(T, 0.25 / MIN_YR); const sT = v * Math.sqrt(T), d1 = (Math.log(S / K) + (RATE + v * v / 2) * T) / sT, d2 = d1 - sT, df = Math.exp(-RATE * T);
  return right === "C" ? { px: S * ncdf(d1) - K * df * ncdf(d2), delta: ncdf(d1) } : { px: K * df * ncdf(-d2) - S * ncdf(-d1), delta: ncdf(d1) - 1 }; }
function ivOf(right, S, K, T, px) { const intr = right === "C" ? Math.max(0, S - K) : Math.max(0, K - S); if (!(px > intr + 1e-9) || !(px > 0.01)) return null; let lo = 0.01, hi = 6; if (bs(right, S, K, T, hi).px < px) return null;
  for (let i = 0; i < 34; i++) { const mid = (lo + hi) / 2; if (bs(right, S, K, T, mid).px > px) hi = mid; else lo = mid; } return (lo + hi) / 2; }
const intrinsic = (right, settle, K) => (right === "C" ? Math.max(0, settle - K) : Math.max(0, K - settle));

// ---------- time ----------
const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const etOf = (iso) => { const p = Object.fromEntries(etFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value])); return { d: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` }; };
function utcOf(day, hm) { for (const off of [4, 5]) { const [h, m] = hm.split(":").map(Number); const t = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), h + off, m)); const e = etOf(t.toISOString()); if (e.d === day && e.hm === hm) return t.toISOString(); } throw new Error("no ET mapping"); }
const minIdx = (hm) => { const [h, m] = hm.split(":").map(Number); return (h - 9) * 60 + m - 30; };   // 09:30 -> 0

// ---------- data ----------
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
let lastCall = 0; const nap = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  for (let i = 0; i < 24; i++) { const wait = lastCall + 1200 - Date.now(); if (wait > 0) await nap(wait); lastCall = Date.now();
    try { const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(45000) }); if (r.status === 429 || r.status >= 500) { await nap(Math.min(90000, 5000 * (i + 1))); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); } catch (e) { if (i === 23 || /HTTP 4/.test(e.message)) throw e; await nap(2500 * (i + 1)); } }
  throw new Error("fetch failed");
}
const occ = (day, r, k) => "SPXW" + day.slice(2).replace(/-/g, "") + r + String(Math.round(k * 1000)).padStart(8, "0");
function spxClose() { const m = {}; for (const l of fs.readFileSync(path.join(CACHE, "SP500.csv"), "utf8").trim().split(/\r?\n/).slice(1)) { const [d, v] = l.split(","); if (v && v !== ".") m[d] = +v; } return m; }
async function sessions() { const cal = await getJson(`https://paper-api.alpaca.markets/v2/calendar?start=${FROM}&end=${TO}`); return cal.filter((c) => c.close === "16:00" && c.date >= FROM && c.date <= TO).map((c) => c.date); }
let spyByDay = null;
async function loadSpy() { if (spyByDay) return spyByDay; const rows = await loadBars({ symbol: "SPY", from: FROM, to: TO, quiet: true }); spyByDay = {};
  for (const r of rows) { if (r.time < "09:30" || r.time >= "16:00" || r.date < FROM || r.date > TO) continue; (spyByDay[r.date] ||= new Array(390).fill(null))[minIdx(r.time)] = r.c; } return spyByDay; }
// strike range needed over the WHOLE day (a put short can sit above the open after a rally): puts [minS*0.965-30, maxS], calls [minS, maxS*1.035+30].
// Cache v1 (open-anchored range) is upgraded in place: only the missing strikes are fetched and merged. Caching everything never touches a decision.
const rangeOf = (lo, hi) => ({ P: [Math.floor((lo * 0.965 - WING) / STEP) * STEP, Math.floor(hi / STEP) * STEP], C: [Math.ceil(lo / STEP) * STEP, Math.floor((hi * 1.035 + WING) / STEP) * STEP] });
const v1Range = (s0) => rangeOf(s0, s0);   // v1 covered puts up to floor(s0), calls from ceil(s0), tails 3.5%
async function fetchLegs(day, cands, legs) {
  for (let i = 0; i < cands.length; i += 100) { const chunk = cands.slice(i, i + 100), map = Object.fromEntries(chunk.map(([r, K]) => [occ(day, r, K), r + K])); let token = null;
    do { const q = new URLSearchParams({ symbols: Object.keys(map).join(","), timeframe: "1Min", start: utcOf(day, "09:30"), end: utcOf(day, "16:00"), limit: "10000" }); if (token) q.set("page_token", token);
      const j = await getJson(`https://data.alpaca.markets/v1beta1/options/bars?${q}`);
      for (const [sym, arr] of Object.entries(j.bars || {})) for (const b of arr) { const m = minIdx(etOf(b.t).hm); if (m >= 0 && m < 390) (legs[map[sym]] ||= []).push([m, b.c]); }
      token = j.next_page_token || null; } while (token); }
}
const candsIn = (need, have) => { const out = []; for (const r of ["P", "C"]) for (let K = need[r][0]; K <= need[r][1]; K += STEP) if (!have || K < have[r][0] || K > have[r][1]) out.push([r, K]); return out; };
async function fetchDay(day, spx, spy) {
  const f = path.join(CACHE, `day-${day}.json.gz`);
  if (fs.existsSync(f)) { const rec = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString()); if (rec.cov || !Object.keys(rec.legs).length) return rec;
    const need = rangeOf(Math.min(...rec.S), Math.max(...rec.S)), cands = candsIn(need, v1Range(rec.S[0])); await fetchLegs(day, cands, rec.legs); rec.cov = need; fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(rec))); return rec; }
  const a = spy[day], close = spx[day]; if (!a || !close) return null; const have = a.filter((x) => x != null).length; if (have < 380) return null;
  let last = null; const S = a.map((x) => (x != null ? (last = x) : last)); const first = S.find((x) => x != null); for (let i = 0; i < S.length; i++) if (S[i] == null) S[i] = first;
  const k = close / S[389], Sx = S.map((x) => +(x * k).toFixed(3)), legs = {}, need = rangeOf(Math.min(...Sx), Math.max(...Sx));
  await fetchLegs(day, candsIn(need, null), legs);
  const rec = { day, settle: close, k: +k.toFixed(6), S: Sx, legs, cov: need }; fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(rec))); return rec;
}
function inflate(rec) { const legs = {}; for (const [key, arr] of Object.entries(rec.legs)) { const px = new Float32Array(390).fill(NaN); for (const [m, c] of arr) px[m] = c; legs[key] = px; } return { day: rec.day, settle: rec.settle, S: rec.S, legs }; }

// ---------- simulation ----------
const T_at = (t) => (390 - t) / MIN_YR;                    // t = minutes after 09:30 (clock time)
function legAt(day, right, K, m, memo) {                    // underlying-implied mark of a leg at clock m (uses bars <= m-1)
  const key = right + K + "@" + m, hit = memo.get(key); if (hit !== undefined) return hit;
  const px = day.legs[right + K]; let out = null;
  if (px) for (let p = m - 1; p >= Math.max(0, m - PRINT_WINDOW); p--) if (px[p] >= TARGET_PX) { const sig = ivOf(right, day.S[p], K, T_at(p + 1), px[p]); if (sig != null) { const b = bs(right, day.S[m - 1], K, T_at(m), sig); out = { sig, mark: b.px, delta: Math.abs(b.delta) }; } break; }
  memo.set(key, out); return out;
}
function pickShort(day, right, m, memo) {
  const S = day.S[m - 1]; let best = null, bd = 9;
  const start = right === "P" ? Math.floor(S / STEP) * STEP : Math.ceil(S / STEP) * STEP, dir = right === "P" ? -STEP : STEP;
  for (let K = start, i = 0; i < 90; K += dir, i++) { const dist = Math.abs(K - S) / S; if (dist < 0.001) continue; if (dist > 0.05) break;
    const L = legAt(day, right, K, m, memo); if (!L) continue; if (L.delta < 0.06) break; if (L.delta > DELTA_HI || L.delta < DELTA_LO) continue; const d = Math.abs(L.delta - DELTA_T); if (d < bd) { bd = d; best = { K, L }; } }
  return best;
}
function sideOf(day, right, Ks, m, memo) { const Kw = right === "P" ? Ks - WING : Ks + WING, s = legAt(day, right, Ks, m, memo), w = legAt(day, right, Kw, m, memo); if (!s || !w) return null; return { right, Ks, Kw, s0: s.mark, w0: w.mark, sig: s.sig, credit: s.mark - w.mark }; }
function selectCondor(day, m, memo) {
  const ps = pickShort(day, "P", m, memo), cs = pickShort(day, "C", m, memo); if (!ps || !cs) return { skip: "no-short" };
  let P = sideOf(day, "P", ps.K, m, memo), C = sideOf(day, "C", cs.K, m, memo); if (!P || !C) return { skip: "no-wing-print" };
  const hi = Math.max(P.credit, C.credit), lo = Math.min(P.credit, C.credit);
  if (hi > 0 && (hi - lo) / hi > EQ_TOL) { const poorP = P.credit < C.credit, r = poorP ? "P" : "C", cur = poorP ? P : C, Kn = r === "P" ? cur.Ks + STEP : cur.Ks - STEP, mv = sideOf(day, r, Kn, m, memo);
    if (mv && Math.abs(Kn - day.S[m - 1]) > 0.001 * day.S[m - 1]) { if (poorP) P = mv; else C = mv; } }
  if (!(P.credit >= MIN_SIDE_CREDIT) || !(C.credit >= MIN_SIDE_CREDIT)) return { skip: "thin-credit" };
  return { P, C, Ctot: P.credit + C.credit };
}
function exitsFor(day, m, cond, tighten) {                  // path of each short leg: marks with the last-print vol, stop / target / expiry
  const res = {};
  for (const side of [cond.P, cond.C]) {
    let sig = side.sig, ev = { kind: "expiry", t: 390 }; const px = day.legs[side.right + side.Ks], Lmin = side.s0 + 0.05;
    for (let j = m; j <= 388; j++) { const t = j + 1; const pr = px ? px[j] : NaN; if (pr >= TARGET_PX) { const s2 = ivOf(side.right, day.S[j], side.Ks, T_at(t), pr); if (s2 != null) sig = s2; }
      const mk = bs(side.right, day.S[j], side.Ks, T_at(t), sig).px;
      const f = !tighten || t < TIGHT_FROM ? 1 : Math.max(TIGHT_FLOOR, (390 - t) / TIGHT_SPAN), level = Math.max(cond.Ctot * f, Lmin);
      if (mk >= level) { ev = { kind: "stop", t, mark: mk }; break; } if (mk <= TARGET_PX) { ev = { kind: "target", t, mark: mk }; break; } }
    res[side.right] = ev; }
  return res;
}
function getRec(day, m, cache, memo) {
  const key = day.day + "|" + m; if (cache.has(key)) return cache.get(key);
  const c = selectCondor(day, m, memo); let rec;
  if (c.skip) rec = { skip: c.skip, m }; else rec = { m, day: day.day, settle: day.settle, P: c.P, C: c.C, Ctot: c.Ctot, ex: exitsFor(day, m, c, true), exNT: exitsFor(day, m, c, false), risk: (WING - c.Ctot) * 100 };
  cache.set(key, rec); return rec;
}
// price a record. mode: "managed" | "managedNT" | "hold" (no stop, no target). h = crossing per leg per transaction, fees = per-contract $ (comm+fees).
function priceRec(rec, mode, h, fee) {
  let pnl = 0, contracts = 4, cross = 4 * h * 100, exitCross = 0, shortRT = [];
  for (const side of [rec.P, rec.C]) {
    const ev = mode === "hold" ? { kind: "expiry" } : (mode === "managedNT" ? rec.exNT : rec.ex)[side.right];
    const sf = side.s0 - h, wf = side.w0 + h, wx = intrinsic(side.right, rec.settle, side.Kw);
    let sx; if (ev.kind === "expiry") sx = intrinsic(side.right, rec.settle, side.Ks); else if (ev.kind === "stop") { sx = ev.mark + h; contracts++; exitCross += h * 100; } else { sx = TARGET_PX + h; contracts++; exitCross += h * 100; }
    pnl += ((sf - sx) + (wx - wf)) * 100; if (ev.kind !== "expiry") shortRT.push({ t: ev.t, v: ((sf - sx) * 100) - fee }); }
  pnl -= contracts * fee; return { pnl, contracts, entryCross: cross, exitCross, shortRT };
}
// one session under an entry-minute plan; the daily-loss cap uses the BASE-cost managed record
function runSession(day, minutes, cache, memo, modes) {
  const taken = [], skips = {};
  for (const m of minutes) { const rec = getRec(day, m, cache, memo); if (rec.skip) { skips[rec.skip] = (skips[rec.skip] || 0) + 1; continue; }
    let realised = 0; for (const r of taken) for (const e of priceRec(r, "managed", H_BASE, COMM + FEES).shortRT) if (e.t <= m) realised += e.v;
    if (realised <= -DAILY_CAP) { skips.cap = (skips.cap || 0) + 1; continue; } taken.push(rec); }
  return { taken, skips };
}
const armsDef = { net: ["managed", H_BASE, COMM + FEES], net2x: ["managed", 2 * H_BASE, COMM + FEES], gross: ["managed", 0, 0], noStop: ["hold", H_BASE, COMM + FEES], noStop2x: ["hold", 2 * H_BASE, COMM + FEES], noStopGross: ["hold", 0, 0], noTighten: ["managedNT", H_BASE, COMM + FEES] };
function sessionR(taken, arm) { if (!taken.length) return null; const [mode, h, fee] = armsDef[arm]; let p = 0, r = 0; for (const rec of taken) { p += priceRec(rec, mode, h, fee).pnl; r += rec.risk; } return { r: p / r, pnl: p, risk: r }; }
const hourMinutes = ENTRY_HOURS.map((h) => minIdx(`${String(h).padStart(2, "0")}:00`));
const dayMinutes = () => hourMinutes.slice();

// ---------- selftest (synthetic days, hand-computable) ----------
function synthDay(spec) {                                    // constant-vol BS world; S path given by fn(j) ; prints every minute for all 5-pt strikes
  const S = new Array(390).fill(0).map((_, j) => spec.S(j)), legs = {}, sigma = spec.sigma;
  for (let K = spec.S0 - 400; K <= spec.S0 + 400; K += 5) for (const r of ["P", "C"]) { if ((r === "P") !== (K < spec.S0)) continue; const px = new Float32Array(390).fill(NaN); for (let j = 0; j < 390; j++) { const v = bs(r, S[j], K, T_at(j + 1), sigma).px; if (v >= 0.05) px[j] = v; } legs[r + K] = px; }
  return { day: "SYNTH", settle: spec.settle, S, legs };
}
function selftest() {
  const ok = []; const chk = (name, cond, info) => { ok.push(cond); console.log(`  ${cond ? "OK  " : "FAIL"} ${name}${info ? " — " + info : ""}`); };
  const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
  // T1: never-out (empty entry plan) -> no sessions, active return exactly 0
  { const day = synthDay({ S0: 5000, S: () => 5000, sigma: 0.30, settle: 5000 }); const r = runSession(day, [], new Map(), new Map()); chk("never-enter rule yields no trades and zero P&L", r.taken.length === 0 && sessionR(r.taken, "net") === null); }
  // T2: flat tape. hold-to-expiry at mid, no costs = total mid credit x100 exactly; independent delta check of the chosen strikes
  const flat = synthDay({ S0: 5000, S: () => 5000, sigma: 0.30, settle: 5000 }), cache = new Map(), memo = new Map(), rec = getRec(flat, 30, cache, memo);
  chk("flat 10:00 condor selected", !rec.skip, rec.skip);
  if (!rec.skip) {
    const dP = Math.abs(bs("P", 5000, rec.P.Ks, T_at(30), 0.30).delta), dC = Math.abs(bs("C", 5000, rec.C.Ks, T_at(30), 0.30).delta);
    chk("chosen shorts sit inside the 0.10-0.15 delta band (independent BS)", dP >= 0.099 && dP <= 0.151 && dC >= 0.099 && dC <= 0.151, `dP ${dP.toFixed(3)} dC ${dC.toFixed(3)}`);
    const hand = ((bs("P", 5000, rec.P.Ks, T_at(30), 0.30).px - bs("P", 5000, rec.P.Kw, T_at(30), 0.30).px) + (bs("C", 5000, rec.C.Ks, T_at(30), 0.30).px - bs("C", 5000, rec.C.Kw, T_at(30), 0.30).px)) * 100;
    const g = priceRec(rec, "hold", 0, 0); chk("no-stop, zero-cost, flat tape P&L = entry mid credit x100 (hand)", near(g.pnl, hand, 1e-3), `${g.pnl.toFixed(4)} vs ${hand.toFixed(4)}`);
    const c = priceRec(rec, "hold", H_BASE, COMM + FEES), expect = hand - 4 * H_BASE * 100 - 4 * (COMM + FEES); chk("cost identity: net = mid - 4 legs x crossing x100 - 4 contracts x fee", near(c.pnl, expect, 1e-3), `${c.pnl.toFixed(4)} vs ${expect.toFixed(4)}`);
    const c2 = priceRec(rec, "hold", 2 * H_BASE, COMM + FEES); chk("2x stress lowers a hold trade by exactly 4 x 0.05 x 100", near(c.pnl - c2.pnl, 4 * H_BASE * 100, 1e-6));
    chk("flat tape: shorts decay to the $0.05 target, none stop", rec.ex.P.kind !== "stop" && rec.ex.C.kind !== "stop", `${rec.ex.P.kind}/${rec.ex.C.kind}`);
    if (rec.ex.P.kind === "target") { const gm = priceRec(rec, "managed", 0, 0); const hd = (side) => (side.s0 - TARGET_PX) + (0 - side.w0);
      // target fill at $0.05 (h 0); wings expire worthless in a flat tape
      const exp = (hd(rec.P) * (rec.ex.P.kind === "target" ? 1 : 0) + hd(rec.C) * (rec.ex.C.kind === "target" ? 1 : 0)) * 100; chk("managed gross flat-tape P&L = (s0 - 0.05 + (0 - w0)) per target leg (hand)", rec.ex.C.kind === "target" ? near(gm.pnl, exp, 1e-3) : true, `${gm.pnl.toFixed(3)} vs ${exp.toFixed(3)}`); }
    // T3: a +2% jump at 10:30 through the call short: the call stop must fire, at a mark >= the total-credit level; loss checked by hand
    const jump = synthDay({ S0: 5000, S: (j) => (j < 60 ? 5000 : 5100), sigma: 0.30, settle: 5100 }), rj = getRec(jump, 30, new Map(), new Map());
    const evC = rj.ex.C; chk("+2% jump: call short is stopped at the jump bar", evC.kind === "stop" && evC.t === 61, `${evC.kind} t=${evC.t}`);
    if (evC.kind === "stop") { chk("stop mark is at or above the total-credit level", evC.mark >= rj.Ctot - 1e-9, `mark ${evC.mark.toFixed(3)} level ${rj.Ctot.toFixed(3)}`);
      const p = priceRec(rj, "managed", 0, 0), callHand = ((rj.C.s0 - evC.mark) + (intrinsic("C", 5100, rj.C.Kw) - rj.C.w0)) * 100; const putEv = rj.ex.P;
      const putHand = ((rj.P.s0 - (putEv.kind === "target" ? TARGET_PX : putEv.kind === "stop" ? putEv.mark : 0)) + (0 - rj.P.w0)) * 100;
      chk("jump-day gross P&L = call leg (stop) + put leg (hand)", near(p.pnl, callHand + putHand, 1e-3), `${p.pnl.toFixed(3)} vs ${(callHand + putHand).toFixed(3)}`);
      const pn = priceRec(rj, "managed", H_BASE, COMM + FEES); chk("stop trade cost identity (5 contracts + 5 legs crossed when put also closes)", near(p.pnl - pn.pnl, (4 * H_BASE * 100 + (pn.contracts - 4) * H_BASE * 100) + pn.contracts * (COMM + FEES), 1e-3)); }
  }
  // T4: shuffled entry minutes on a flat tape -> the hold-to-expiry P&L is unchanged in sign (all shorts OTM, decay only): sanity that timing alone cannot manufacture a loss
  { const c3 = new Map(), m3 = new Map(); let allPos = true, n = 0; for (const m of [40, 100, 200, 300]) { const r = getRec(flat, m, c3, m3); if (r.skip) continue; n++; if (!(priceRec(r, "hold", 0, 0).pnl > 0)) allPos = false; } chk("flat tape: every hold-to-expiry condor earns its credit (sign check on 4 timings)", n > 0 && allPos, `${n} entries`); }
  console.log(ok.every(Boolean) ? "SELFTEST PASS" : "SELFTEST FAIL"); return ok.every(Boolean);
}

// ---------- run ----------
async function loadSessions(days, spx, spy) { const out = []; let i = 0; for (const day of days) { const r = await fetchDay(day, spx, spy); i++; if (r) out.push(inflate(r)); if (i % 25 === 0) process.stdout.write(`  ${day} ${i}/${days.length}\r`); } process.stdout.write("\n"); return out; }
const seriesOf = (dayList, arm, planFn, cache, memoFor) => { const rows = []; for (const d of dayList) { const { taken } = runSession(d, planFn(d), cache, memoFor(d)); const s = sessionR(taken, arm); if (s) rows.push({ day: d.day, ...s, n: taken.length }); } return rows; };

async function main() {
  const mode = ["--fetch", "--coverage", "--selftest", "--read"].find((m) => process.argv.includes(m)) || "--selftest";
  if (mode === "--selftest") { console.log("R288 selftest (known answers):"); process.exit(selftest() ? 0 : 1); }
  fs.mkdirSync(CACHE, { recursive: true });
  const spx = spxClose(), spy = await loadSpy(), days = await sessions();
  if (mode === "--fetch") { const order = [...days.filter((d) => d >= HOLD_FROM), ...days.filter((d) => d < HOLD_FROM)]; let n = 0, ok = 0;
    for (const day of order) { let r = null; for (let a = 0; a < 40; a++) { try { r = await fetchDay(day, spx, spy); break; } catch (e) { console.log("  retry " + day + " (" + e.message + ")"); await nap(60000); } } n++; if (r) ok++; if (n % 20 === 0) console.log(`  ${day} ${n}/${order.length} usable ${ok}`); }
    console.log(`R288 fetch done: ${ok} usable of ${n} sessions cached in data/training/R288`); return; }
  if (mode === "--coverage") {
    const pick = days.filter((d) => d <= DISC_TO).filter((_, i) => i % 40 === 0).slice(0, 9), ds = await loadSessions(pick, spx, spy), agg = {};
    for (const d of ds) { const cache = new Map(), memo = new Map(); for (const m of hourMinutes) { const r = getRec(d, m, cache, memo), k = (10 + hourMinutes.indexOf(m)) + ":00 " + (r.skip || "ENTRY"); agg[k] = (agg[k] || 0) + 1; } }
    console.log("coverage on", ds.length, "discovery sessions (entries vs skips, no P&L):"); for (const [k, v] of Object.entries(agg).sort()) console.log("  ", k, v); return; }
  // ---- --read ----
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((x) => x.id === ID); if (!reg) throw new Error(ID + " not registered");
  const BAR = reg.bar.tRequired; if (!(BAR > 0)) throw new Error("registry bar missing");
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests && seals.tests[ID]) || fs.existsSync(OUT)) throw new Error(ID + " already read — read-once");
  const hold = await loadSessions(days.filter((d) => d >= HOLD_FROM), spx, spy), disc = await loadSessions(days.filter((d) => d <= DISC_TO), spx, spy);
  const caches = new Map(), memos = new Map(); const cacheFor = () => caches, memoFor = (d) => { let m = memos.get(d.day); if (!m) { m = new Map(); memos.set(d.day, m); } return m; };
  const primary = (list, arm) => seriesOf(list, arm, dayMinutes, caches, memoFor);
  const stat = (rows) => ({ n: rows.length, mean: mean(rows.map((r) => r.r)), t: tOf(rows.map((r) => r.r)), tNW: nwT(rows.map((r) => r.r)), win: rows.filter((r) => r.r > 0).length / rows.length });
  const A = {}; for (const arm of Object.keys(armsDef)) A[arm] = primary(hold, arm);
  const S = Object.fromEntries(Object.entries(A).map(([k, v]) => [k, stat(v)])), Sd = { net: stat(primary(disc, "net")), gross: stat(primary(disc, "gross")), noStop: stat(primary(disc, "noStop")) };
  // R162-style single 09:45 condor held to expiry (timing control)
  const single = []; for (const d of hold) { const { taken } = runSession(d, [minIdx("09:45")], caches, memoFor(d)); const s = sessionR(taken, "noStop"); if (s) single.push({ day: d.day, ...s }); }
  // hourly cells (registered net rule, each hour's condor alone)
  const cells = {}; ENTRY_HOURS.forEach((h, i) => { const rows = []; for (const d of hold) { const rec = getRec(d, hourMinutes[i], caches, memoFor(d)); if (rec.skip) continue; const p = priceRec(rec, "managed", H_BASE, COMM + FEES).pnl; rows.push(p / rec.risk); } cells[h + ":00"] = { entries: rows.length, meanR: +mean(rows).toFixed(5), t: +tOf(rows).toFixed(2) }; });
  // random-minute-in-hour null (200 draws), registered rule, base cost
  const rnd = mulberry(NULL_SEED), nullMeans = [], nullTs = [];
  for (let k = 0; k < DRAWS; k++) { const rows = []; for (const d of hold) { let plan; for (let tries = 0; tries < 200; tries++) { plan = ENTRY_HOURS.map((h) => { const hi = h === 15 ? 54 : 59; return minIdx(`${String(h).padStart(2, "0")}:00`) + Math.floor(rnd() * (hi + 1)); }); if (plan.every((m, i) => i === 0 || m - plan[i - 1] >= 30)) break; }
      const { taken } = runSession(d, plan, caches, memoFor(d)); const s = sessionR(taken, "net"); if (s) rows.push(s.r); } nullMeans.push(mean(rows)); nullTs.push(tOf(rows)); if ((k + 1) % 20 === 0) process.stdout.write(`  null draw ${k + 1}/${DRAWS}\r`); }
  nullMeans.sort((a, b) => a - b); nullTs.sort((a, b) => a - b); const p95 = nullMeans[Math.floor(0.95 * DRAWS)], p95t = nullTs[Math.floor(0.95 * DRAWS)];
  const net = A.net, half = Math.floor(net.length / 2), h1 = net.slice(0, half).map((r) => r.r), h2 = net.slice(half).map((r) => r.r);
  const g = A.gross, gh1 = mean(g.slice(0, half).map((r) => r.r)), gh2 = mean(g.slice(half).map((r) => r.r));
  // maxDD on $10k of capital-at-risk deployed per session
  let cum = 0, pk = 0, dd = 0; for (const r of net) { cum += r.r * 10000; pk = Math.max(pk, cum); dd = Math.min(dd, cum - pk); }
  // friction family (per condor, averaged over taken condors, registered rule, base cost)
  const fr = { entryCross: [], exitCross: [], allIn: [], risk: [], credit: [], crossW: [] };
  for (const d of hold) { const { taken } = runSession(d, dayMinutes(), caches, memoFor(d)); for (const rec of taken) { const p = priceRec(rec, "managed", H_BASE, COMM + FEES), allIn = p.entryCross + p.exitCross + p.contracts * (COMM + FEES);
    fr.entryCross.push(p.entryCross / rec.risk); fr.exitCross.push(p.exitCross / rec.risk); fr.allIn.push(allIn / rec.risk); fr.credit.push(allIn / (rec.Ctot * 100)); fr.crossW.push((p.entryCross + p.exitCross) / (WING * 100)); fr.risk.push(rec.risk); } }
  let stopsTot = 0, targTot = 0, exp = 0, both = 0, cnd = 0, noEntry = {}; for (const d of hold) { const { taken, skips } = runSession(d, dayMinutes(), caches, memoFor(d)); for (const k in skips) noEntry[k] = (noEntry[k] || 0) + skips[k]; for (const r of taken) { cnd++; const e = [r.ex.P.kind, r.ex.C.kind]; stopsTot += e.filter((x) => x === "stop").length; targTot += e.filter((x) => x === "target").length; exp += e.filter((x) => x === "expiry").length; if (e[0] === "stop" && e[1] === "stop") both++; } }
  const sameSign = (a, b) => (a > 0 && b > 0) || (a < 0 && b < 0), tNet = tOf(net.map((r) => r.r)), beats = mean(net.map((r) => r.r)) > p95, halvesOk = sameSign(mean(h1), mean(h2));
  const passes = tNet >= BAR && beats && halvesOk, verdict = passes ? "PASS" : "DID NOT PASS";
  const sec = (s) => ({ n: s.n, meanR: +s.mean.toFixed(5), t: +s.t.toFixed(3), tNW: +s.tNW.toFixed(3), winRate: +s.win.toFixed(3) });
  const out = { id: ID, key: KEY, name: reg.name, readAt: new Date().toISOString(), rule: reg.rule, window: { holdout: [HOLD_FROM, TO], discoveryContext: [FROM, DISC_TO] }, unit: "sessions", n: net.length,
    statistic: "per-session net P&L / max risk (registered rule, base crossing), one-sample t over sessions; holdout window", bar: BAR, tNet: +tNet.toFixed(3), tGross: +S.gross.t.toFixed(3), tNetNewveyWest: +S.net.tNW.toFixed(3),
    meanNet: +S.net.mean.toFixed(5), meanGross: +S.gross.mean.toFixed(5), winRate: +S.net.win.toFixed(3),
    placebo: { kind: "random minute inside each hour, 200 draws, registered rule, base cost", draws: DRAWS, p95Mean: +p95.toFixed(5), p95t: +p95t.toFixed(3), medianMean: +nullMeans[DRAWS >> 1].toFixed(5), observed: +S.net.mean.toFixed(5), beats },
    halves: { first: { meanNet: +mean(h1).toFixed(5), t: +tOf(h1).toFixed(2), n: h1.length, meanGross: +gh1.toFixed(5) }, second: { meanNet: +mean(h2).toFixed(5), t: +tOf(h2).toFixed(2), n: h2.length, meanGross: +gh2.toFixed(5) }, sameSign: halvesOk },
    dollarsAt10k: { netPerYear: +(S.net.mean * 10000 * 252).toFixed(0), basis: "mean session R x $10k of capital-at-risk deployed each session x 252 sessions" }, maxDD: { dollarsAt10k: +dd.toFixed(0), basis: "cumulative session R x $10k" },
    arms: { net: sec(S.net), net2xCrossing: sec(S.net2x), mid_noCost: sec(S.gross), noStopTwin: sec(S.noStop), noStopTwin2x: sec(S.noStop2x), noStopTwinMid: sec(S.noStopGross), noTightening: sec(S.noTighten), r162Single0945HoldToExpiry: (() => { const a = single.map((r) => r.r); return { n: a.length, meanR: +mean(a).toFixed(5), t: +tOf(a).toFixed(3) }; })() },
    discoveryContext: { net: sec(Sd.net), mid_noCost: sec(Sd.gross), noStopTwin: sec(Sd.noStop) }, hourlyCells: cells,
    frictionFamily: { note: "per condor, registered rule, base crossing. all-in friction / max loss is the only one summable with equity costR; the others are on different denominators and must not be added to the book total.",
      entryCrossingOverMaxLossPct: +(100 * mean(fr.entryCross)).toFixed(3), exitCrossingOverMaxLossPct: +(100 * mean(fr.exitCross)).toFixed(3), allInFrictionOverMaxLossPct: +(100 * mean(fr.allIn)).toFixed(3),
      allInFrictionOverNetCreditPct: +(100 * mean(fr.credit)).toFixed(1), crossingAsPctOfSpreadWidth: +(100 * mean(fr.crossW)).toFixed(3), meanMaxRiskUSD: +mean(fr.risk).toFixed(0) },
    behaviour: { condors: cnd, stops: stopsTot, targets: targTot, heldToExpiry: exp, bothSidesStopped: both, skips: noEntry },
    costModel: `entry/stop/target at full crossing: base $${H_BASE}/leg/transaction (R162 $0.01/spread SPY-class scaled x10 to SPX notional = $0.10/spread), stress 2x, mid; $${COMM} commission + $${FEES} fees per contract traded; cash settlement free`,
    dataSources: ["Alpaca v1beta1 options bars SPXW 1Min TRADE bars", "Alpaca SIP SPY 1Min (SPX path = SPY x k)", "FRED SP500 official close (settlement, k)", "Alpaca paper calendar (sessions, early closes skipped)", "data/test-registry.json (bar)"],
    knownWeaknesses: ["Trade bars, not quotes: crossing is a modelled haircut ($0.05/leg, scaled from R162's SPY-class median gap, not measured on SPX), and marks are BS at the last print's implied vol so stop timing rests on a model.", "SPX path is SPY x daily ratio k: intraday tracking error and the SPY close-auction gap are not modelled.", "Rule gaps filled by the builder (see NOTES N4): poorer-side equalisation, $0.10 minimum side credit, tightened-stop floor, cap on realised short-leg P&L only.", "Author's 2021-2023 record and 8.6% both-sides-stopped figure cannot be checked; window is 2024-06..2026-09 only.", "The 30-min print window for wings can skip entries on quiet days; skips are counted in behaviour.skips."],
    verdictScript: verdict };
  writeJsonAtomic(OUT, out);
  console.log(`\nR288 ${verdict} — holdout ${HOLD_FROM}..${TO}, n=${net.length} sessions, ${cnd} condors`);
  console.log(`  net mean ${(100 * S.net.mean).toFixed(3)}% of max risk/session, t ${tNet.toFixed(3)} (NW ${S.net.tNW.toFixed(2)}) vs bar ${BAR}; gross ${(100 * S.gross.mean).toFixed(3)}% t ${S.gross.t.toFixed(2)}; 2x cost ${(100 * S.net2x.mean).toFixed(3)}% t ${S.net2x.t.toFixed(2)}`);
  console.log(`  placebo (random minute) p95 ${(100 * p95).toFixed(3)}% observed ${(100 * S.net.mean).toFixed(3)}% beats=${beats}; halves ${(100 * mean(h1)).toFixed(3)}% / ${(100 * mean(h2)).toFixed(3)}% sameSign=${halvesOk}`);
  console.log(`  no-stop twin ${(100 * S.noStop.mean).toFixed(3)}% t ${S.noStop.t.toFixed(2)}; single 09:45 ${(100 * mean(single.map((r) => r.r))).toFixed(3)}%; $/yr @10k ${(S.net.mean * 10000 * 252).toFixed(0)}; maxDD $${dd.toFixed(0)}`);
}
main().catch((e) => { console.error("R288 FAILED:", e.message); process.exit(1); });
