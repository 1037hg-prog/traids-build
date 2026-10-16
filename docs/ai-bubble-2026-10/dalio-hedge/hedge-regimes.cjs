#!/usr/bin/env node
"use strict";
/**
 * hedge-regimes.cjs — WHAT HELD VALUE WHEN STOCKS FELL, split by rate regime (2026-10-07, for Josh's Dalio question).
 * Measurement of known instruments; registers nothing, trades nothing, writes only ./results.json here.
 *
 * INPUT  ./data.json from fetch-data.cjs (Yahoo dividend-adjusted closes via :3002, FRED DTB3/DEXJPUS/DEXUSEU local).
 * CALENDAR ^SP500TR trading dates 1988-06-08 .. END (2026-10-06, last complete session for every series). Other series are
 *          forward-filled onto it (a holiday mismatch carries the prior close; returns are simple daily).
 * INSTRUMENTS (daily simple returns; "A|B" = A where it exists, else B — splice is per day)
 *   QQQ      QQQ total return | ^NDX price (pre-1999-03, no dividends)
 *   SPX      ^SP500TR (S&P 500 total return)
 *   TBILL    FRED DTB3 / 100 / 252 per session (3-month bill)
 *   BIL      BIL | TBILL                     SHORT  SHY | VFISX (Vanguard Short-Term Treasury)
 *   INTER    IEF | VFITX                     LONG   TLT | VUSTX (Vanguard Long-Term Treasury)
 *   TIPS     TIP | VIPSX (from 2000-06)      GOLD   GLD | GC=F front-month continuous (from 2000-08-30; NO gold before that)
 *   USD      UUP | DX-Y.NYB spot (no carry)  COMMOD ^SPGSCI (as served by Yahoo; ER/spot definition not verified)
 *   MF       DBMF | TSMOM proxy (below)      RYMFX, AQMIX  real managed-futures mutual funds, own history only
 *   PUTW     ^PUT CBOE S&P 500 PutWrite (cash-secured ATM monthly puts) = the short-vol sleeve
 *   SPX+P1.0 / SPX+P1.2  SPY total return + a monthly-rolled 5% OTM SPY put on 100% of NAV, Black-Scholes priced and marked daily
 *            at sigma = VIX x 1.0 or x 1.2 (OTM skew), r = ^IRX, q = 1.8%; bought at each month-end close, expires next month-end.
 *            No bid/ask beyond the 1.2x case. This is the put-PROTECTION estimate from VIX the brief asked for.
 * TSMOM PROXY (managed futures before DBMF; Moskowitz-Ooi-Pedersen 2012 form): 9 markets — SP500TR, ^GDAXI, VUSTX, VFITX, GC=F,
 *   DXY, JPY (FRED DEXJPUS), EUR (FRED DEXUSEU), ^SPGSCI. Excess return = asset return - TBILL for the four total-return assets;
 *   price return for gold/FX/commodity. At each month-end: signal = sign(past 252-session excess return), weight = signal x 0.40 /
 *   (63-session realised vol) / N_active, |w| <= 3; held fixed through the next month; + TBILL on collateral; - 1.0%/yr fee+cost.
 *   Validated below against DBMF, RYMFX, AQMIX where they overlap.
 * Run: node hedge-regimes.cjs
 */
const fs = require("fs"), path = require("path");
const D = JSON.parse(fs.readFileSync(path.join(__dirname, "data.json"), "utf8"));
const END = "2026-10-06";
const { bsPrice } = require("C:/Users/joshc/Downloads/traids (2)/traids-bundle/backend/lib/bs.js");
const Y = D.yahoo;
const CAL = Y["^SP500TR"].map((r) => r[0]).filter((d) => d <= END);
const N = CAL.length, IDX = new Map(CAL.map((d, i) => [d, i]));
const f2 = (x, d = 1) => (x == null || !isFinite(x) ? "n/a" : (x * 100).toFixed(d));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); };

// ── align a [date,value] series onto CAL with forward fill (null before first obs) ──
function align(rows) {
  const out = new Array(N).fill(null); let j = 0, last = null;
  for (let i = 0; i < N; i++) { while (j < rows.length && rows[j][0] <= CAL[i]) { last = rows[j][1]; j++; } out[i] = last; }
  return out;
}
const yCol = (sym, col) => align(Y[sym].filter((r) => r[0] <= END && r[col] > 0).map((r) => [r[0], r[col]]));  // col 4 = close, 5 = adjClose
const ADJ = (s) => yCol(s, 5), CLOSE = (s) => yCol(s, 4), LOW = (s) => yCol(s, 3);
const rets = (lv) => lv.map((v, i) => (i > 0 && v != null && lv[i - 1] != null ? v / lv[i - 1] - 1 : null));
const splice = (...arrs) => CAL.map((_, i) => { for (const a of arrs) if (a[i] != null) return a[i]; return null; });
// first-day-of-existence guard: a forward-filled series returns 0 on days before its own first print — impossible here
// because align() is null before the first observation, so rets() is null there too.

const dtb3 = align(D.dtb3); const RF = dtb3.map((v) => (v == null ? null : v / 100 / 252));
const TNX = CLOSE("^TNX"), IRX = CLOSE("^IRX"), VIX = CLOSE("^VIX");
const R = {};
R.QQQ = splice(rets(ADJ("QQQ")), rets(CLOSE("^NDX")));
R.SPX = rets(ADJ("^SP500TR"));
R.TBILL = RF.map((v, i) => (i > 0 ? v : null));
R.BIL = splice(rets(ADJ("BIL")), R.TBILL);
R.SHORT = splice(rets(ADJ("SHY")), rets(ADJ("VFISX")));
R.INTER = splice(rets(ADJ("IEF")), rets(ADJ("VFITX")));
R.LONG = splice(rets(ADJ("TLT")), rets(ADJ("VUSTX")));
R.TIPS = splice(rets(ADJ("TIP")), rets(ADJ("VIPSX")));
R.GOLD = splice(rets(ADJ("GLD")), rets(CLOSE("GC=F")));
R.USD = splice(rets(ADJ("UUP")), rets(CLOSE("DX-Y.NYB")));
R.COMMOD = rets(CLOSE("^SPGSCI"));
R.RYMFX = rets(ADJ("RYMFX")); R.AQMIX = rets(ADJ("AQMIX")); R.DBMF = rets(ADJ("DBMF"));
R.PUTW = rets(CLOSE("^PUT"));

// ── TSMOM proxy ──
const fx = (id, invert) => { const a = align(D.fred[id]); return a.map((v, i) => (i > 0 && v != null && a[i - 1] != null ? (invert ? a[i - 1] / v - 1 : v / a[i - 1] - 1) : null)); };
const xs = (r) => r.map((v, i) => (v == null || RF[i] == null ? null : v - RF[i]));
const TS_ASSETS = {
  SP500: xs(R.SPX), DAX: xs(rets(ADJ("^GDAXI"))), UST_LONG: xs(rets(ADJ("VUSTX"))), UST_INT: xs(rets(ADJ("VFITX"))),
  GOLD: rets(CLOSE("GC=F")), DXY: rets(CLOSE("DX-Y.NYB")), JPY: fx("DEXJPUS", true), EUR: fx("DEXUSEU", false), GSCI: R.COMMOD,
};
const isME = CAL.map((d, i) => i === N - 1 || CAL[i + 1].slice(0, 7) !== d.slice(0, 7));
const tsW = new Array(N).fill(null); let wNow = null, nActive = [];
for (let i = 0; i < N; i++) {
  if (wNow) tsW[i] = wNow;
  if (isME[i]) {
    const w = {};
    for (const [k, a] of Object.entries(TS_ASSETS)) {
      if (i < 252) continue; const win = a.slice(i - 251, i + 1); if (win.some((x) => x == null)) continue;
      const cum = win.reduce((p, x) => p * (1 + x), 1) - 1; const v = sd(a.slice(i - 62, i + 1)) * Math.sqrt(252); if (!(v > 0)) continue;
      w[k] = Math.sign(cum) * 0.4 / v;
    }
    const n = Object.keys(w).length;
    if (n >= 4) {
      for (const k in w) w[k] = w[k] / n;
      // ex-ante portfolio vol target 10%/yr: trailing 63-session returns of this weight vector, scale clamped to [0.25, 3]
      const pr = []; for (let d = i - 62; d <= i; d++) { let s2 = 0; for (const k in w) s2 += w[k] * TS_ASSETS[k][d]; pr.push(s2); }
      const exAnte = sd(pr) * Math.sqrt(252), sc = Math.max(0.25, Math.min(3, 0.10 / exAnte));
      for (const k in w) w[k] = Math.max(-3, Math.min(3, w[k] * sc)); wNow = w; nActive.push([CAL[i], n]);
    } else wNow = null;
  }
}
R.TSMOM = CAL.map((_, i) => { const w = tsW[i]; if (!w || RF[i] == null) return null; let s = RF[i] - 0.01 / 252; for (const k in w) { const x = TS_ASSETS[k][i]; if (x == null) return null; s += w[k] * x; } return s; });
R.MF = splice(R.DBMF, R.TSMOM);

// ── put-protection overlay model (SPY TR + monthly 5% OTM put on 100% of NAV) ──
function putOverlay(mult) {
  const S = CLOSE("SPY"), A = ADJ("SPY"), out = new Array(N).fill(null), Q = 0.018;
  let nav = null, units = 0, nPut = 0, K = 0, expI = -1, sig = 0;
  const pv = (i) => { if (i === expI) return Math.max(K - S[i], 0); const T = Math.max((Date.parse(CAL[expI]) - Date.parse(CAL[i])) / 864e5, 0.5) / 365; return bsPrice(S[i], K, T, VIX[i] / 100 * mult, "P", Math.log(1 + IRX[i] / 100), Q); };
  let prev = null;
  for (let i = 0; i < N; i++) {
    if (S[i] == null || A[i] == null || VIX[i] == null || IRX[i] == null) continue;
    if (nav != null) { const v = units * A[i] + nPut * pv(i); out[i] = prev ? v / prev - 1 : null; nav = v; prev = v; }
    if (isME[i] && i < N - 1) {
      if (nav == null) { nav = 1; prev = 1; }
      // next month-end index
      let j = i + 1; while (j < N && !isME[j]) j++; if (j >= N) break;
      expI = j; K = 0.95 * S[i]; const T = (Date.parse(CAL[j]) - Date.parse(CAL[i])) / 864e5 / 365;
      const p = bsPrice(S[i], K, T, VIX[i] / 100 * mult, "P", Math.log(1 + IRX[i] / 100), Q);
      nPut = nav / S[i]; units = (nav - nPut * p) / A[i];
    }
  }
  return out;
}
R["SPX+P1.0"] = putOverlay(1.0); R["SPX+P1.2"] = putOverlay(1.2); R.SPY = rets(ADJ("SPY"));

const COLS = ["QQQ", "SPX", "TBILL", "SHORT", "INTER", "LONG", "TIPS", "GOLD", "USD", "MF", "RYMFX", "AQMIX", "COMMOD", "PUTW", "SPY", "SPX+P1.0", "SPX+P1.2"];

// ── window return with coverage ──
function win(key, i0, i1) { let p = 1, miss = 0; for (let i = i0 + 1; i <= i1; i++) { const r = R[key][i]; if (r == null) miss++; else p *= 1 + r; } const cov = 1 - miss / Math.max(1, i1 - i0); return { ret: p - 1, cov }; }
const fmtW = (w) => (w.cov < 0.6 ? "  n/a" : (f2(w.ret) + (w.cov < 0.999 ? "*" : "")).padStart(6));

// ── drawdown episodes ──
function episodes(key, thr) {
  const lv = []; let v = 1; for (let i = 0; i < N; i++) { if (R[key][i] != null) v *= 1 + R[key][i]; lv.push(v); }
  const eps = []; let pk = 0, inDD = false, tr = 0;
  for (let i = 1; i < N; i++) {
    if (lv[i] >= lv[pk]) { if (inDD) { eps.push([pk, tr]); inDD = false; } pk = i; tr = i; continue; }
    if (lv[i] < lv[tr] || tr < pk) tr = lv[i] < lv[tr] || tr <= pk ? i : tr;
    if (lv[i] / lv[pk] - 1 <= -thr) inDD = true;
  }
  if (inDD) eps.push([pk, tr]);
  return eps.map(([a, b]) => ({ peak: CAL[a], trough: CAL[b], i0: a, i1: b, dd: lv[b] / lv[a] - 1 }));
}
const out = { asOf: END, fetchedAt: D.fetchedAt, notes: [] };
console.log(`HEDGE REGIMES — data fetched ${D.fetchedAt}, calendar ${CAL[0]} .. ${CAL[N - 1]} (${N} sessions)`);
console.log(`TNX scale check: ${["2000-01-14", "2008-06-30", "2020-03-09", "2022-10-21", END].map((d) => `${d} ${TNX[IDX.get(d)]}`).join(" | ")}`);
console.log(`TSMOM proxy active from ${nActive[0][0]} with ${nActive[0][1]} markets; ${nActive.at(-1)[1]} markets at ${nActive.at(-1)[0]}`);

function table(title, eps) {
  console.log(`\n${title}`);
  console.log(`${"window".padEnd(23)} ${"10y chg".padStart(7)} | ` + COLS.map((c) => c.padStart(6).slice(-8)).join(" "));
  const rows = [];
  for (const e of eps) {
    const dy = TNX[e.i1] - TNX[e.i0];
    const cells = Object.fromEntries(COLS.map((c) => [c, win(c, e.i0, e.i1)]));
    rows.push({ ...e, d10y: +dy.toFixed(2), regime: dy > 0 ? "RISING" : "FALLING", cells: Object.fromEntries(Object.entries(cells).map(([k, w]) => [k, { ret: +w.ret.toFixed(4), cov: +w.cov.toFixed(3) }])) });
    console.log(`${(e.peak + ".." + e.trough).padEnd(23)} ${((dy >= 0 ? "+" : "") + dy.toFixed(2)).padStart(7)} | ` + COLS.map((c) => fmtW(cells[c])).join(" "));
  }
  return rows;
}
out.spxEpisodes = table("A. S&P 500 TR drawdowns >= 15% (peak close -> trough close), % return of each instrument over the window. * = partial coverage; n/a = <60% coverage", episodes("SPX", 0.15));
out.qqqEpisodes = table("B. QQQ (|^NDX pre-1999) drawdowns >= 20%", episodes("QQQ", 0.2));

// ── stock AND long-Treasury joint declines (rolling 63-session windows both <= -5%) ──
{
  const lvS = [], lvL = []; let a = 1, b = 1; for (let i = 0; i < N; i++) { if (R.SPX[i] != null) a *= 1 + R.SPX[i]; if (R.LONG[i] != null) b *= 1 + R.LONG[i]; lvS.push(a); lvL.push(b); }
  const flag = CAL.map((_, i) => i >= 63 && R.LONG[i - 62] != null && lvS[i] / lvS[i - 63] - 1 <= -0.05 && lvL[i] / lvL[i - 63] - 1 <= -0.05);
  const eps = []; let s = -1;
  for (let i = 0; i < N; i++) { if (flag[i] && s < 0) s = i; if ((!flag[i] || i === N - 1) && s >= 0) { const e = flag[i] ? i : i - 1; eps.push({ i0: s - 63, i1: e }); s = -1; } }
  // merge windows that overlap or sit within 21 sessions
  const m = []; for (const e of eps) { if (m.length && e.i0 <= m.at(-1).i1 + 21) m.at(-1).i1 = Math.max(m.at(-1).i1, e.i1); else m.push({ ...e }); }
  const ep = m.map((e) => ({ peak: CAL[e.i0], trough: CAL[e.i1], i0: e.i0, i1: e.i1 }));
  out.jointEpisodes = table("C. Stocks AND long Treasuries both down >= 5% over a rolling 63-session window (merged; window = first 63-session start .. last flagged day)", ep);
}

// ── named windows the all-time-high definition nests inside bigger drawdowns, plus the current 2026 rate leg ──
{
  const at = (d) => CAL.findLastIndex((x) => x <= d);
  let lo = CAL.findIndex((d) => d >= "2026-01-01"), loI = lo; for (let i = lo; i < N; i++) if (TNX[i] < TNX[loI]) loI = i;
  const ep = [["2011-04-29", "2011-10-03"], ["2015-05-21", "2016-02-11"], [CAL[loI], END]].map(([p, t]) => ({ peak: p, trough: t, i0: at(p), i1: at(t) }));
  out.namedWindows = table("A2. Named windows: 2011 and 2015-16 S&P price drawdowns (nested inside larger TR drawdowns, so not in A), and the 2026 rate leg = 10y yield's 2026 low close -> " + END, ep);
}
// ── stock/bond correlation regime: rolling 252-session correlation of daily SPX vs LONG returns ──
{
  const rc = (j) => { const a = [], b = []; for (let i = j - 251; i <= j; i++) if (R.SPX[i] != null && R.LONG[i] != null) { a.push(R.SPX[i]); b.push(R.LONG[i]); } return a.length > 200 ? corr(a, b) : null; };
  const series = []; for (let j = 260; j < N; j += 21) { const c = rc(j); if (c != null) series.push([CAL[j], c]); }
  const now = rc(N - 1), pos = series.filter((x) => x[1] > 0).length;
  const yr = (y) => rc(CAL.findLastIndex((d) => d <= y + "-12-31"));
  console.log("\nA3. Rolling 252-session correlation, daily S&P 500 TR vs long Treasuries (LONG): now (" + END + ") " + now.toFixed(2) + "; positive in " + pos + " of " + series.length + " monthly samples since " + series[0][0]);
  console.log("    year-end values: " + ["1994", "1999", "2000", "2002", "2008", "2013", "2018", "2020", "2021", "2022", "2023", "2024", "2025"].map((y) => y + " " + yr(y).toFixed(2)).join(" | "));
  const ch = (k) => (TNX[N - 1] - TNX[N - 1 - k]); console.log("    10y yield " + TNX[N - 1].toFixed(2) + "%: change over 63 / 126 / 252 sessions " + [63, 126, 252].map((k) => (ch(k) >= 0 ? "+" : "") + ch(k).toFixed(2)).join(" / ") + " pts; 13-wk bill " + IRX[N - 1].toFixed(2) + "% (" + ((IRX[N - 1] - IRX[N - 253]) >= 0 ? "+" : "") + (IRX[N - 1] - IRX[N - 253]).toFixed(2) + " over 252)");
  out.corrRegime = { now, positiveShare: pos / series.length, from: series[0][0], tnx: TNX[N - 1], tnxChg63: ch(63), tnxChg126: ch(126), tnxChg252: ch(252) };
}
// ── monthly returns, worst QQQ months split by the month's 10y change ──
const months = []; { let cur = null; for (let i = 1; i < N; i++) { const ym = CAL[i].slice(0, 7); if (!cur || cur.ym !== ym) { cur = { ym, i0: i - 1, i1: i }; months.push(cur); } else cur.i1 = i; } }
const mret = (key, m) => { let p = 1; for (let i = m.i0 + 1; i <= m.i1; i++) { if (R[key][i] == null) return null; p *= 1 + R[key][i]; } return p - 1; };
const full = months.filter((m) => m.ym >= "1990-01" && m.ym <= "2026-09");
const qm = full.map((m) => ({ ym: m.ym, q: mret("QQQ", m), dy: TNX[m.i1] - TNX[m.i0], m }));
const sorted = [...qm].sort((a, b) => a.q - b.q); const cut = sorted[Math.floor(qm.length * 0.1)].q;
const worst = qm.filter((x) => x.q <= cut);
const wR = worst.filter((x) => x.dy > 0), wF = worst.filter((x) => x.dy <= 0);
console.log(`\nD. QQQ worst-decile months 1990-01..2026-09 (${qm.length} months; cut ${f2(cut)}%): ${worst.length} months, ${wF.length} with the 10y yield FALLING, ${wR.length} RISING`);
console.log(`   rising-yield worst months: ${wR.map((x) => x.ym).join(" ")}`);
console.log(`${"instrument".padEnd(10)} | ${"corr all".padStart(8)} ${"n".padStart(4)} | ${"worst: falling-yield mean / hit / n".padStart(36)} | ${"worst: rising-yield mean / hit / n".padStart(35)} | ${"QQQ<0 & 10y up: mean / corr / n".padStart(32)}`);
out.worstMonths = { cut, nMonths: qm.length, falling: wF.map((x) => x.ym), rising: wR.map((x) => x.ym), rows: {} };
for (const c of COLS) {
  const pairs = qm.map((x) => [x.q, mret(c, x.m), x.dy]).filter((p) => p[1] != null);
  const ca = pairs.length > 24 ? corr(pairs.map((p) => p[0]), pairs.map((p) => p[1])) : null;
  const g = (set) => { const v = set.map((x) => mret(c, x.m)).filter((v) => v != null); return v.length ? { mean: mean(v), hit: v.filter((z) => z > 0).length / v.length, n: v.length } : null; };
  const gf = g(wF), gr = g(wR);
  const ru = pairs.filter((p) => p[0] < 0 && p[2] > 0); const cru = ru.length > 10 ? corr(ru.map((p) => p[0]), ru.map((p) => p[1])) : null;
  out.worstMonths.rows[c] = { corrAll: ca, nAll: pairs.length, worstFalling: gf, worstRising: gr, downUp: { mean: ru.length ? mean(ru.map((p) => p[1])) : null, corr: cru, n: ru.length } };
  const s = (o) => (o ? `${f2(o.mean, 2).padStart(6)} / ${(100 * o.hit).toFixed(0).padStart(3)}% / ${String(o.n).padStart(2)}` : "n/a");
  console.log(`${c.padEnd(10)} | ${(ca == null ? "n/a" : ca.toFixed(2)).padStart(8)} ${String(pairs.length).padStart(4)} | ${s(gf).padStart(36)} | ${s(gr).padStart(35)} | ${(ru.length ? `${f2(mean(ru.map((p) => p[1])), 2).padStart(6)} / ${cru == null ? "n/a" : cru.toFixed(2)} / ${ru.length}` : "n/a").padStart(32)}`);
}

// ── calendar-year returns for the key years ──
console.log(`\nE. Calendar-year total returns (%)`);
const YRS = ["2000", "2001", "2002", "2008", "2018", "2020", "2022", "2023"];
console.log(`${"year".padEnd(6)} ${"10y chg".padStart(7)} | ` + COLS.map((c) => c.padStart(6).slice(-8)).join(" "));
out.years = {};
for (const y of YRS) {
  const i0 = CAL.findLastIndex((d) => d < y + "-01-01"), i1 = CAL.findLastIndex((d) => d <= y + "-12-31");
  const cells = Object.fromEntries(COLS.map((c) => [c, win(c, i0, i1)]));
  out.years[y] = Object.fromEntries(Object.entries(cells).map(([k, w]) => [k, +w.ret.toFixed(4)]));
  console.log(`${y.padEnd(6)} ${((TNX[i1] - TNX[i0] >= 0 ? "+" : "") + (TNX[i1] - TNX[i0]).toFixed(2)).padStart(7)} | ` + COLS.map((c) => fmtW(cells[c])).join(" "));
}

// ── TSMOM proxy validation ──
console.log(`\nF. TSMOM proxy validation (monthly returns where both exist)`);
out.proxyValidation = {};
for (const ref of ["DBMF", "RYMFX", "AQMIX"]) {
  const pr = full.map((m) => [mret("TSMOM", m), mret(ref, m)]).filter((p) => p[0] != null && p[1] != null);
  const c = corr(pr.map((p) => p[0]), pr.map((p) => p[1]));
  const ann = (k) => Math.pow(pr.reduce((s, p) => s * (1 + p[k]), 1), 12 / pr.length) - 1;
  out.proxyValidation[ref] = { n: pr.length, corr: c, proxyCAGR: ann(0), refCAGR: ann(1), proxyVol: sd(pr.map((p) => p[0])) * Math.sqrt(12), refVol: sd(pr.map((p) => p[1])) * Math.sqrt(12) };
  console.log(`   vs ${ref.padEnd(5)} n ${pr.length} months  corr ${c.toFixed(2)}  CAGR proxy ${f2(ann(0))}% vs ${f2(ann(1))}%  vol proxy ${f2(out.proxyValidation[ref].proxyVol)}% vs ${f2(out.proxyValidation[ref].refVol)}%`);
}
for (const y of ["2008", "2014", "2022"]) { const i0 = CAL.findLastIndex((d) => d < y + "-01-01"), i1 = CAL.findLastIndex((d) => d <= y + "-12-31"); console.log(`   ${y}: TSMOM proxy ${f2(win("TSMOM", i0, i1).ret)}%  DBMF ${fmtW(win("DBMF", i0, i1))}  RYMFX ${fmtW(win("RYMFX", i0, i1))}  AQMIX ${fmtW(win("AQMIX", i0, i1))}`); }

// ── full-period stats: CAGR, vol, maxDD ──
console.log(`\nG. Whole-history stats (each instrument over its own available span, daily)`);
out.stats = {};
for (const c of COLS) {
  let lv = 1, pk = 1, mdd = 0, n = 0, first = null; const rr = [];
  for (let i = 0; i < N; i++) { const r = R[c][i]; if (r == null) continue; if (!first) first = CAL[i]; lv *= 1 + r; n++; rr.push(r); pk = Math.max(pk, lv); mdd = Math.min(mdd, lv / pk - 1); }
  const cagr = Math.pow(lv, 252 / n) - 1, vol = sd(rr) * Math.sqrt(252);
  out.stats[c] = { from: first, cagr, vol, maxDD: mdd };
  console.log(`   ${c.padEnd(9)} from ${first}  CAGR ${f2(cagr).padStart(5)}%  vol ${f2(vol).padStart(5)}%  maxDD ${f2(mdd).padStart(6)}%`);
}

// ── put protection: cost today and historical drag ──
{
  const i = N - 1, S = CLOSE("SPY")[i], v = VIX[i], r = Math.log(1 + IRX[i] / 100);
  console.log(`\nH. Put protection priced from VIX on ${CAL[i]}: SPY close ${S.toFixed(2)}, VIX ${v.toFixed(2)}, 13-wk bill ${IRX[i].toFixed(2)}%, q 1.8%`);
  out.putCost = [];
  for (const [lbl, k, days] of [["1-mo 5% OTM", 0.95, 30], ["3-mo 10% OTM", 0.90, 91], ["1-mo ATM", 1.0, 30]]) for (const mult of [1.0, 1.2]) {
    const p = bsPrice(S, k * S, days / 365, v / 100 * mult, "P", r, 0.018), pct = p / S, ann = pct * 365 / days;
    out.putCost.push({ lbl, mult, premiumPct: pct, annualisedPct: ann });
    console.log(`   ${lbl.padEnd(13)} sigma = VIX x ${mult.toFixed(1)} = ${(v * mult).toFixed(1)}%: premium ${(p).toFixed(2)} = ${f2(pct, 2)}% of spot -> rolled all year ${f2(ann, 1)}% of notional per year`);
  }
  const both = []; for (let j = 0; j < N; j++) if (R.SPY[j] != null && R["SPX+P1.0"][j] != null) both.push(j);
  for (const k of ["SPX+P1.0", "SPX+P1.2"]) {
    let a = 1, b = 1; for (const j of both) { a *= 1 + R.SPY[j]; b *= 1 + R[k][j]; }
    const yrs = both.length / 252, ca = Math.pow(a, 1 / yrs) - 1, cb = Math.pow(b, 1 / yrs) - 1;
    console.log(`   ${k}: ${CAL[both[0]]}..${CAL[both.at(-1)]} SPY TR CAGR ${f2(ca, 2)}% vs hedged ${f2(cb, 2)}% -> drag ${f2(cb - ca, 2)} pts/yr`);
    out[`putDrag_${k}`] = { from: CAL[both[0]], spyCAGR: ca, hedgedCAGR: cb };
  }
}
fs.writeFileSync(path.join(__dirname, "results.json"), JSON.stringify(out, null, 1));
console.log(`\nwrote results.json`);
