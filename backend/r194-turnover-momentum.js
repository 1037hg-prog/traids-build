#!/usr/bin/env node
/**
 * R194 — SHORT-TERM MOMENTUM IN HIGH-TURNOVER STOCKS (Medhat & Schmeling, RFS 2022). Registered 2026-09-24 (family MINE-3,
 * best-of-5 bar) BEFORE this file ran; rule, statistic, bar and controls are frozen in data/test-registry.json (preregistered[]).
 *
 *   node backend/r194-turnover-momentum.js              -> data/r194-turnover-momentum.json; seals once if the bootstrap control passes
 *   node backend/r194-turnover-momentum.js --coverage   -> prints universe / decile sizes only (no returns), writes nothing
 *
 * IMPLEMENTATION NOTES (every choice below was fixed before the first read; none was chosen on results)
 *  - Panel: data/anomaly-cache-v2 (adjusted close/open/volume, symbol-major Float32, NaN = no bar). Common-stock panel (no ETFs).
 *  - Month-end = the last panel session of each calendar month. Formation month m = sessions (me[m-1], me[m]].
 *  - Universe at me[m]: 20-session median dollar volume (adj close x adj volume) >= $25M, >= 15 finite sessions in the 20 (as R175),
 *    close at me[m-1] and me[m] both > 0 (so the 1-month return exists).
 *  - Turnover proxy (registered): MEAN DAILY dollar volume over formation month m / MEAN DAILY dollar volume over the 12 calendar
 *    months BEFORE m (m excluded, so the ratio measures abnormal activity). Daily means, not monthly sums, so trading-day counts
 *    do not move the ratio. Needs >= 15 finite sessions in m and >= 200 in the trailing 12 months. For the first holding months
 *    (2017-01..) the trailing window starts at the panel's first session 2016-01-04 (11-12 months available; >= 200 sessions holds).
 *  - Sort (DEPENDENT / conditional, as the registry text reads "within the top turnover decile"): rank the universe by turnover,
 *    top decile = the floor(n/10) highest; within it rank by the 1-month return c(me[m])/c(me[m-1])-1 (no skip month — this is
 *    SHORT-TERM momentum), long the floor(k/10) highest, short the floor(k/10) lowest. The low-turnover contrast is the identical
 *    sort in the floor(n/10) LOWEST-turnover names. Every sort breaks ties with a seeded random key (mulberry32, seed per month
 *    and per purpose), never row order.
 *  - Holding: equal weight, month-end close me[m] to month-end close me[m+1] (the paper's convention; the month label is the
 *    HOLDING month). A name with no bar at me[m+1] (delisted, or truncated by the v2 >+300% rule) is exited at its last finite
 *    close inside the month (0 if none) — no delisting return is modelled. Such holdings are counted and reported.
 *  - Cost: 20 bps per side per leg, full turnover assumed every month (no netting of names that stay in a leg):
 *    net L-S = (R_long - 0.004) - (R_short + 0.004) = gross - 0.008.
 *  - Statistic: plain t over months of the net L-S (no NW — none registered). Primary = holding months 2020-01..2026-08;
 *    2017-01..2019-12 reported separately (inside the paper's sample; not part of the verdict).
 *  - Bootstrap control (registered "drift-free iid bootstrap of gross monthly returns: |t| < 2") is implemented as the house leak
 *    test: each stock's real monthly returns are demeaned (arithmetic drift = 0) and redrawn iid with replacement into a fresh
 *    monthly path; the real universe and real turnover deciles are kept; the SAME sort/hold pipeline is run on the scrambled
 *    returns and the gross L-S t is computed over the primary window. 20 seeded draws; the control passes when the MEDIAN t has
 *    |t| < 2 (a single draw fails 5% of the time by chance, and re-drawing would be choosing on results; the median catches a
 *    systematic leak). All 20 t's and the count with |t| >= 2 are reported.
 *  - Verdict: PASS only if primary net t >= bar (from the registry) AND the bootstrap control passes. Seals only if the control
 *    passes; otherwise writes the JSON, exits 3 and does NOT seal (fix the pipeline, not the rule).
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), PANEL = D("anomaly-cache-v2"), ID = "R194", COVERAGE = process.argv.includes("--coverage");
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")), SEALS = seals.tests || seals;
if (SEALS[ID] && !COVERAGE) { console.error(`${ID} already sealed — refusing`); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === ID);
if (!E) { console.error(`${ID} not registered`); process.exit(2); }
const BAR = E.bar.tRequired;
const meta = JSON.parse(fs.readFileSync(path.join(PANEL, "meta.json"), "utf8")), DATES = meta.dates, SYMS = meta.symbols, T = DATES.length, N = SYMS.length;
const rd = (f) => { const b = fs.readFileSync(path.join(PANEL, f)); return new Float32Array(b.buffer, b.byteOffset, N * T); };
const C = rd("close.f32"), V = rd("vol.f32");
const c = (s, t) => C[s * T + t];
const MIN_DV = 25e6, COST_LS = 4 * 0.002, LAST_HOLD = "2026-08", FIRST_HOLD = "2017-01", PRIMARY = ["2020-01", "2026-08"], PAPER = ["2017-01", "2019-12"];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN);
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// sort ascending by value, ties by a seeded random key (never row order)
function sortKeyed(items, val, seed) { const rng = mulberry(seed); const k = items.map((x) => ({ x, v: val(x), r: rng() })); k.sort((a, b) => a.v - b.v || a.r - b.r); return k.map((z) => z.x); }

// ---- month-ends -------------------------------------------------------------------------------------------------------------
const monthOf = (t) => DATES[t].slice(0, 7), MONTHS = [], ME = [];
for (let t = 0; t < T; t++) { const m = monthOf(t); if (t === T - 1 || monthOf(t + 1) !== m) { if (m <= LAST_HOLD) { MONTHS.push(m); ME.push(t); } } }
const MS = [0]; for (let i = 0; i < ME.length - 1; i++) MS.push(ME[i] + 1);    // first session index of each month
const NM = MONTHS.length;
// per-symbol per-month dollar-volume sums and finite counts
const dvSum = new Float64Array(N * NM), dvCnt = new Int32Array(N * NM);
for (let s = 0; s < N; s++) for (let mi = 0; mi < NM; mi++) { let S = 0, K = 0; for (let t = MS[mi]; t <= ME[mi]; t++) { const x = c(s, t) * V[s * T + t]; if (c(s, t) > 0 && Number.isFinite(x)) { S += x; K++; } } dvSum[s * NM + mi] = S; dvCnt[s * NM + mi] = K; }
function median20(s, t) { const a = []; for (let k = t - 19; k <= t; k++) { if (k < 0) continue; const cl = c(s, k), x = cl * V[s * T + k]; if (cl > 0 && Number.isFinite(x)) a.push(x); } if (a.length < 15) return NaN; a.sort((x, y) => x - y); return a[a.length >> 1]; }
// universe + turnover + 1-month return at formation month index mi (holding month mi+1)
function formation(mi) {
  const t = ME[mi], out = [];
  for (let s = 0; s < N; s++) {
    const c1 = c(s, t), c0 = c(s, ME[mi - 1]); if (!(c1 > 0) || !(c0 > 0)) continue;
    if (!(median20(s, t) >= MIN_DV)) continue;
    const cm = dvCnt[s * NM + mi]; if (cm < 15) continue;
    let S = 0, K = 0; for (let j = Math.max(0, mi - 12); j < mi; j++) { S += dvSum[s * NM + j]; K += dvCnt[s * NM + j]; }
    if (K < 200 || !(S > 0)) continue;
    out.push({ s, turn: (dvSum[s * NM + mi] / cm) / (S / K), r1: c1 / c0 - 1 });
  }
  return out;
}
// holding return from ME[mi] close to ME[mi+1] close; exit at last finite close if the name drops out
function holdRet(s, mi) { const p0 = c(s, ME[mi]); let last = p0, cut = false; for (let t = ME[mi] + 1; t <= ME[mi + 1]; t++) { const x = c(s, t); if (x > 0) last = x; else cut = true; } const end = c(s, ME[mi + 1]); return { r: (end > 0 ? end : last) / p0 - 1, cut: !(end > 0) || cut }; }

const firstF = MONTHS.indexOf(FIRST_HOLD) - 1;
const F = []; for (let mi = firstF; mi < NM - 1; mi++) {
  const U = formation(mi), n = U.length, dec = Math.floor(n / 10);
  const byTurn = sortKeyed(U, (x) => x.turn, 194000 + mi);
  const hi = byTurn.slice(n - dec), lo = byTurn.slice(0, dec);
  const legs = (grp, seed) => { const k = grp.length, q = Math.floor(k / 10), srt = sortKeyed(grp, (x) => x.r1, seed); return { k, q, long: srt.slice(k - q).map((x) => x.s), short: srt.slice(0, q).map((x) => x.s) }; };
  F.push({ mi, hold: MONTHS[mi + 1], n, U, hi: legs(hi, 195000 + mi), lo: legs(lo, 196000 + mi), hiSet: hi.map((x) => x.s), loSet: lo.map((x) => x.s) });
}
if (COVERAGE) {
  const q = (a) => { const s = [...a].sort((x, y) => x - y); return { min: s[0], med: s[s.length >> 1], max: s[s.length - 1] }; };
  console.log(JSON.stringify({ holdMonths: F.length, first: F[0].hold, last: F[F.length - 1].hold, universe: q(F.map((f) => f.n)), hiDecile: q(F.map((f) => f.hi.k)), namesPerLegHi: q(F.map((f) => f.hi.q)), namesPerLegLo: q(F.map((f) => f.lo.q)) }, null, 1));
  process.exit(0);
}

// ---- the rule ---------------------------------------------------------------------------------------------------------------
let cutCount = 0, holdCount = 0;
function legSeries(which) {
  return F.map((f) => { const L = f[which]; const rl = L.long.map((s) => holdRet(s, f.mi)), rs = L.short.map((s) => holdRet(s, f.mi));
    if (which === "hi") { holdCount += rl.length + rs.length; cutCount += rl.filter((x) => x.cut).length + rs.filter((x) => x.cut).length; }
    const Rl = mean(rl.map((x) => x.r)), Rs = mean(rs.map((x) => x.r)); return { hold: f.hold, long: Rl, short: Rs, gross: Rl - Rs, net: Rl - Rs - COST_LS, q: L.q }; });
}
const inW = (w) => (x) => x.hold >= w[0] && x.hold <= w[1];
function summ(rows) { const net = rows.map((x) => x.net), gross = rows.map((x) => x.gross);
  return { months: rows.length, window: [rows[0].hold, rows[rows.length - 1].hold], netMeanPct: +(100 * mean(net)).toFixed(3), netT: +tOf(net).toFixed(3), grossMeanPct: +(100 * mean(gross)).toFixed(3), grossT: +tOf(gross).toFixed(3),
    longMeanPct: +(100 * mean(rows.map((x) => x.long))).toFixed(3), shortMeanPct: +(100 * mean(rows.map((x) => x.short))).toFixed(3), netWinPct: +(100 * net.filter((x) => x > 0).length / net.length).toFixed(1), meanNamesPerLeg: +mean(rows.map((x) => x.q)).toFixed(1) }; }
const HI = legSeries("hi"), LO = legSeries("lo");
const prim = summ(HI.filter(inW(PRIMARY))), paper = summ(HI.filter(inW(PAPER))), loPrim = summ(LO.filter(inW(PRIMARY))), loPaper = summ(LO.filter(inW(PAPER)));
const pr = HI.filter(inW(PRIMARY)), half = pr.length >> 1;

// ---- bootstrap control: drift-free iid monthly-return scramble through the same pipeline -------------------------------------
const pool = new Map();   // s -> demeaned real monthly returns (all months where both month-end closes exist)
for (let s = 0; s < N; s++) { const a = []; for (let mi = 1; mi < NM; mi++) { const p0 = c(s, ME[mi - 1]), p1 = c(s, ME[mi]); if (p0 > 0 && p1 > 0) a.push(p1 / p0 - 1); } if (a.length >= 2) { const m = mean(a); pool.set(s, a.map((x) => x - m)); } }
const primF = F.filter((f) => f.hold >= PRIMARY[0] && f.hold <= PRIMARY[1]), bootT = [];
for (let k = 0; k < 20; k++) {
  const rng = mulberry(1940000 + k), simPath = new Map();
  const R = (s, mi) => { let p = simPath.get(s); if (!p) { p = new Float64Array(NM).fill(NaN); simPath.set(s, p); } if (Number.isNaN(p[mi])) { const a = pool.get(s); p[mi] = a[Math.floor(rng() * a.length)]; } return p[mi]; };
  const series = primF.map((f) => { const grp = f.hiSet.map((s) => ({ s, r1: R(s, f.mi) }));
    const kq = Math.floor(grp.length / 10), srt = sortKeyed(grp, (x) => x.r1, 195000 + f.mi); const L = srt.slice(grp.length - kq), S = srt.slice(0, kq);
    return mean(L.map((x) => R(x.s, f.mi + 1))) - mean(S.map((x) => R(x.s, f.mi + 1))); });
  bootT.push(+tOf(series).toFixed(3));
}
const bs = [...bootT].sort((a, b) => a - b), bootMedian = (bs[9] + bs[10]) / 2, bootPass = Math.abs(bootMedian) < 2;

const pass = bootPass && prim.netT >= BAR;
const verdict = !bootPass ? `CONTROLS FAILED — drift-free bootstrap median t ${bootMedian.toFixed(2)}`
  : pass ? `PASS — high-turnover 1-month momentum net ${prim.netMeanPct}%/mo, t ${prim.netT} >= ${BAR} (2020-01..2026-08; bootstrap median t ${bootMedian.toFixed(2)})`
  : `DID NOT PASS — high-turnover 1-month momentum net ${prim.netMeanPct}%/mo, t ${prim.netT} vs ${BAR} (gross ${prim.grossMeanPct}%/mo t ${prim.grossT}; low-turnover L-S net ${loPrim.netMeanPct}%/mo t ${loPrim.netT}; 2017-19 net t ${paper.netT})`;
const out = { spec: "r194-turnover-momentum-v1", test: ID, ranAt: new Date().toISOString(), bar: BAR,
  coverage: { panel: meta.spec, sessions: [DATES[0], DATES[T - 1]], holdMonths: F.length, universeMedian: [...F.map((f) => f.n)].sort((a, b) => a - b)[F.length >> 1], hiDecileMedian: [...F.map((f) => f.hi.k)].sort((a, b) => a - b)[F.length >> 1], holdingsCutShort: { count: cutCount, of: holdCount } },
  primary: { ...prim, firstHalfNetT: +tOf(pr.slice(0, half).map((x) => x.net)).toFixed(2), secondHalfNetT: +tOf(pr.slice(half).map((x) => x.net)).toFixed(2) },
  paperSample2017_2019: paper,
  lowTurnoverContrast: { primary: loPrim, paperSample2017_2019: loPaper, note: "the paper predicts REVERSAL (negative L-S) in low-turnover names" },
  controls: { bootstrap: { draws: bootT.length, tByDraw: bootT, medianT: +bootMedian.toFixed(3), countAbsTge2: bootT.filter((x) => Math.abs(x) >= 2).length, pass: bootPass } },
  monthly: HI.map((x) => ({ hold: x.hold, longPct: +(100 * x.long).toFixed(3), shortPct: +(100 * x.short).toFixed(3), netPct: +(100 * x.net).toFixed(3), perLeg: x.q })),
  verdict };
writeJsonAtomic(D("r194-turnover-momentum.json"), out);
console.log(JSON.stringify({ ...out, monthly: `${out.monthly.length} rows (in file)` }, null, 1));
if (!bootPass) { console.error("bootstrap control failed — NOT sealed; fix the pipeline, not the rule"); process.exit(3); }
const today = new Date().toISOString().slice(0, 10);
SEALS[ID] = { sealedOn: today, unit: "months", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
E.status = "READ " + today + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict }) + "\n");
console.log("sealed", ID);
