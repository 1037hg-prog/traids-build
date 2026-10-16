#!/usr/bin/env node
/**
 * TRAIDS — Stop-Run Reversal GAUNTLET (independent replication attempt)
 *
 * The collaborator's transcript claims: `stoprun_reversal__regime_up`, 10:01–11:30 ET window,
 * NQ/MNQ, n=67 OOS trades, PF 2.20, +$38k. We do NOT have his exact rules, so this is a
 * PRE-REGISTERED CANONICAL RECONSTRUCTION from the breadcrumbs (stop-run of prior-day levels,
 * reclaim entry, ATR stops, time window, regime filter). If the canonical version dies here,
 * the canonical version dies on independent data — his exact variant still gets its own run
 * when the rules arrive. If it survives, that's genuinely interesting.
 *
 * PRE-REGISTERED PRIMARY SPEC (fixed before results were seen):
 *   • Data: NQ continuous (front-month by max daily volume), 5-minute bars, Massive CME feed.
 *   • Regime UP: prior day's RTH close > 50-day SMA of RTH closes (no lookahead).
 *   • Sweep: price trades BELOW prior day's RTH low (9:30–16:00 ET) any time ≥ 9:30 ET.
 *   • Entry: first 5m bar that CLOSES back ABOVE the PDL, with that close occurring inside
 *     10:01–11:30 ET and within 12 bars (60 min) of the sweep start. Fill at NEXT bar open
 *     (gap-aware — you never get the trigger price) + slippage.
 *   • Stop: sweep extreme low − 0.25×ATR(14, 5m). Target: entry + 2R. Stop-first if both hit
 *     intrabar; if a bar OPENS through the stop, fill at that open (gap-aware).
 *   • Time exit: flat at 13:00 ET. One trade per day (de-overlapped by construction).
 *   • Costs: commission 1 tick round-trip + slippage 1 tick/side (primary; swept 0/1/2).
 *   • SHORT mirror (PDH sweep, regime DOWN) reported for symmetry context.
 *
 * KILL-TESTS: OOS 60/40 chronological split · by-quarter · regime split (up/down/none) ·
 * slippage sweep · WINDOW PLACEBO (same strategy in every other 90-min window — where does
 * his window rank?) · effective-N t-stat & 95% CI.
 *
 * Usage:  node backend/stoprun-gauntlet.js          (env: ROOT=NQ RR=2 SLIP_TICKS=1)
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const FB = require("./lib/futures-bars.js");   // 2026-10-02 Massive exit: bars come from the local store (Massive archive + nightly Schwab appender); no Massive call

const ROOT = process.env.ROOT || "NQ";
const TICK = 0.25;                                   // NQ tick (points)
const RR = parseFloat(process.env.RR || "2");
const SLIP_TICKS = parseFloat(process.env.SLIP_TICKS || "1");   // per side
const COMM_TICKS_RT = 1;                             // ~$4-5 RT ≈ 1 tick on NQ
const ATR_PAD = 0.25, RECLAIM_BARS = 12, SMA_N = 50;
const WIN_START = "10:01", WIN_END = "11:30", EXIT_T = "13:00";
const MCODES = ["F","G","H","J","K","M","N","Q","U","V","X","Z"];

// ── data: continuous 5m series via per-day max-volume contract ──────────────
const fmtET = (ns) => {
  const d = new Date(ns / 1e6);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t) => p.find(x => x.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}` };
};

async function loadBars() { return FB.loadBars({ root: ROOT, resolution: "5minute", lookbackDays: 760, quiet: true }); }   // 2026-10-02 Massive exit: was a private Massive client (1session map + 5minute aggs); same rows (+v) from the store

// ── indicators / day structure ───────────────────────────────────────────────
const inRTH = (t) => t >= "09:30" && t < "16:00";
function buildDays(bars) {
  const days = new Map();
  for (const b of bars) { if (!days.has(b.date)) days.set(b.date, []); days.get(b.date).push(b); }
  const dates = [...days.keys()].sort();
  const meta = {};
  let prevCloses = [];
  for (const d of dates) {
    const rth = days.get(d).filter(b => inRTH(b.time));
    if (rth.length < 30) { meta[d] = null; continue; }
    const hi = Math.max(...rth.map(b => b.h)), lo = Math.min(...rth.map(b => b.l)), close = rth[rth.length - 1].c;
    const sma = prevCloses.length >= SMA_N ? prevCloses.slice(-SMA_N).reduce((s, v) => s + v, 0) / SMA_N : null;
    meta[d] = { hi, lo, close, smaPrior: sma };   // smaPrior uses closes BEFORE d
    prevCloses.push(close);
  }
  return { days, dates, meta };
}
function atr5(bars, i, p = 14) {
  if (i < p) return null;
  let s = 0;
  for (let k = i - p + 1; k <= i; k++) s += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
  return s / p;
}

// ── replay one day, one direction, in a given entry window ──────────────────
function replayDay(rth, pdl, pdh, dir, winStart, winEnd, slipTicks) {
  // dir +1: sweep BELOW pdl then reclaim above.  dir -1: sweep ABOVE pdh then reject below.
  const lvl = dir > 0 ? pdl : pdh;
  let sweepAt = -1, extreme = null;
  for (let i = 1; i < rth.length; i++) {
    const b = rth[i];
    if (sweepAt < 0) {
      const swept = dir > 0 ? b.l < lvl : b.h > lvl;
      if (swept) { sweepAt = i; extreme = dir > 0 ? b.l : b.h; }
      continue;
    }
    extreme = dir > 0 ? Math.min(extreme, b.l) : Math.max(extreme, b.h);
    if (i - sweepAt > RECLAIM_BARS) return null;                       // reclaim too slow — setup dead
    const reclaimed = dir > 0 ? b.c > lvl : b.c < lvl;
    if (!reclaimed) continue;
    if (b.time < winStart || b.time > winEnd) return null;             // reclaim outside HIS window
    if (i + 1 >= rth.length) return null;
    const a = atr5(rth, i); if (!a) return null;
    const fill = rth[i + 1].o + dir * slipTicks * TICK;                // next-bar open + slip (gap-aware)
    const stop = extreme - dir * ATR_PAD * a;
    const risk = (fill - stop) * dir; if (!(risk > 0)) return null;
    const target = fill + dir * risk * RR;
    for (let k = i + 1; k < rth.length; k++) {
      const bk = rth[k];
      if (k > i + 1 && (dir > 0 ? bk.o <= stop : bk.o >= stop))        // gapped through stop → fill at open
        return done(fill, bk.o, dir, risk, rth[i].date, "gap-stop");
      if (dir > 0 ? bk.l <= stop : bk.h >= stop) return done(fill, stop, dir, risk, rth[i].date, "stop");
      if (dir > 0 ? bk.h >= target : bk.l <= target) return done(fill, target, dir, risk, rth[i].date, "target");
      if (bk.time >= EXIT_T) return done(fill, bk.c, dir, risk, rth[i].date, "time");
    }
    return done(fill, rth[rth.length - 1].c, dir, risk, rth[0].date, "eod");
  }
  return null;
  function done(entry, exit, dir, risk, date, reason) {
    const grossPts = (exit - entry) * dir - slipTicks * TICK;          // exit slip
    const costPts = COMM_TICKS_RT * TICK;
    const netPts = grossPts - costPts;
    return { date, rMult: netPts / risk, pts: netPts, reason };
  }
}

// ── stats ────────────────────────────────────────────────────────────────────
function stat(ts) {
  const n = ts.length; if (!n) return null;
  const r = ts.map(t => t.rMult);
  const m = r.reduce((s, v) => s + v, 0) / n;
  const sd = n > 1 ? Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1)) : 0;
  const t = sd > 0 ? m / (sd / Math.sqrt(n)) : 0;
  const lo = m - 1.96 * (sd / Math.sqrt(n || 1));
  const w = r.filter(v => v > 0).length;
  const gW = r.filter(v => v > 0).reduce((s, v) => s + v, 0), gL = Math.abs(r.filter(v => v <= 0).reduce((s, v) => s + v, 0));
  const pts = ts.reduce((s, x) => s + x.pts, 0);
  return { n, win: w / n * 100, expR: m, tStat: t, ciLo: lo, pf: gL ? gW / gL : (gW ? Infinity : 0), pts };
}
const pad = (s, n) => String(s).padEnd(n);
const row = (lbl, s) => console.log("    " + pad(lbl, 30) + (s ? pad("n " + s.n, 8) + pad("win " + s.win.toFixed(0) + "%", 9) + pad("exp " + (s.expR >= 0 ? "+" : "") + s.expR.toFixed(3) + "R", 13) + pad("PF " + (isFinite(s.pf) ? s.pf.toFixed(2) : "∞"), 9) + pad("t " + s.tStat.toFixed(2), 8) + pad("CI₉₅lo " + s.ciLo.toFixed(3), 14) + (s.pts >= 0 ? "+" : "") + s.pts.toFixed(0) + " pts" : "no trades"));

(async () => {
  console.log(`\n  TRAIDS — Stop-Run Reversal GAUNTLET · ${ROOT} 5m continuous (local futures store) · pre-registered spec`);
  console.log(`  window ${WIN_START}–${WIN_END} ET · reclaim ≤${RECLAIM_BARS} bars · stop=sweep−${ATR_PAD}×ATR · ${RR}R target · flat ${EXIT_T} · slip ${SLIP_TICKS}t/side + ${COMM_TICKS_RT}t comm\n`);
  const bars = await loadBars();
  const { days, dates, meta } = buildDays(bars);
  console.log(`\n\n  ${bars.length} 5m bars · ${dates.length} sessions · ${dates[0]} → ${dates[dates.length - 1]}\n`);

  // replay every session
  const T = { upLong: [], noRegLong: [], dnLong: [], dnShort: [], noRegShort: [] };
  for (let di = 1; di < dates.length; di++) {
    const d = dates[di], pd = dates[di - 1];
    const m = meta[d], pm = meta[pd];
    if (!m || !pm || pm.smaPrior == null) continue;
    const rth = days.get(d).filter(b => inRTH(b.time));
    if (rth.length < 40) continue;
    const regimeUp = pm.close > pm.smaPrior;
    const L = replayDay(rth, pm.lo, pm.hi, +1, WIN_START, WIN_END, SLIP_TICKS);
    const S = replayDay(rth, pm.lo, pm.hi, -1, WIN_START, WIN_END, SLIP_TICKS);
    if (L) { T.noRegLong.push(L); (regimeUp ? T.upLong : T.dnLong).push(L); }
    if (S) { T.noRegShort.push(S); if (!regimeUp) T.dnShort.push(S); }
  }

  console.log("  PRIMARY (pre-registered): LONG stop-run reversal, regime UP, his window");
  row("stoprun LONG · regime UP", stat(T.upLong));
  console.log("\n  REGIME SPLIT (the conditioning he applied — does it hold up?)");
  row("LONG · no regime filter", stat(T.noRegLong));
  row("LONG · regime DOWN only", stat(T.dnLong));
  row("SHORT mirror · regime DOWN", stat(T.dnShort));
  row("SHORT mirror · no filter", stat(T.noRegShort));

  // OOS split on the primary
  const prim = T.upLong;
  if (prim.length) {
    const cutIdx = Math.floor(prim.length * 0.6);
    const cut = prim.map(t => t.date).sort()[cutIdx] || "9999";
    console.log("\n  OUT-OF-SAMPLE SPLIT (primary, chronological 60/40)");
    row("in-sample (first 60%)", stat(prim.filter(t => t.date < cut)));
    row("out-of-sample (last 40%)", stat(prim.filter(t => t.date >= cut)));
    console.log("\n  BY QUARTER (primary — is it carried by one lucky stretch?)");
    const qs = [...new Set(prim.map(t => t.date.slice(0, 4) + " Q" + (Math.floor((+t.date.slice(5, 7) - 1) / 3) + 1)))].sort();
    for (const q of qs) row("  " + q, stat(prim.filter(t => (t.date.slice(0, 4) + " Q" + (Math.floor((+t.date.slice(5, 7) - 1) / 3) + 1)) === q)));
  }

  // slippage sweep on the primary
  console.log("\n  SLIPPAGE SWEEP (primary spec re-run end-to-end)");
  for (const st of [0, 1, 2]) {
    const ts = [];
    for (let di = 1; di < dates.length; di++) {
      const d = dates[di], pd = dates[di - 1], m = meta[d], pm = meta[pd];
      if (!m || !pm || pm.smaPrior == null || !(pm.close > pm.smaPrior)) continue;
      const rth = days.get(d).filter(b => inRTH(b.time)); if (rth.length < 40) continue;
      const L = replayDay(rth, pm.lo, pm.hi, +1, WIN_START, WIN_END, st);
      if (L) ts.push(L);
    }
    row(`slip ${st} tick/side`, stat(ts));
  }

  // WINDOW PLACEBO — same strategy, every other 90-min window: where does HIS rank?
  console.log("\n  WINDOW PLACEBO (same rules, every 90-min window — is 10:01–11:30 special, or just one draw?)");
  const winScores = [];
  for (let h = 9.5; h <= 14; h += 0.5) {
    const ws = `${String(Math.floor(h)).padStart(2, "0")}:${h % 1 ? "31" : "01"}`;
    const weH = h + 1.5;
    const we = `${String(Math.floor(weH)).padStart(2, "0")}:${weH % 1 ? "30" : "00"}`;
    const ts = [];
    for (let di = 1; di < dates.length; di++) {
      const d = dates[di], pd = dates[di - 1], m = meta[d], pm = meta[pd];
      if (!m || !pm || pm.smaPrior == null || !(pm.close > pm.smaPrior)) continue;
      const rth = days.get(d).filter(b => inRTH(b.time)); if (rth.length < 40) continue;
      const L = replayDay(rth, pm.lo, pm.hi, +1, ws, we, SLIP_TICKS);
      if (L) ts.push(L);
    }
    const s = stat(ts);
    if (s) winScores.push({ w: `${ws}–${we}`, s, his: ws === WIN_START });
  }
  winScores.sort((a, b) => b.s.expR - a.s.expR);
  winScores.forEach((x, i) => row(`  #${i + 1} ${x.w}${x.his ? "  ← HIS WINDOW" : ""}`, x.s));

  console.log(`\n  VERDICT GUIDE: a real edge shows expR>0 with CI₉₅lo>0 out-of-sample, survives 2 ticks of`);
  console.log(`  slippage, is not the only green quarter, and HIS window beats most placebo windows for a`);
  console.log(`  reason other than rank luck. Anything less = the search-survivor profile (same as our 22).`);
  console.log(`  NOTE: this is a canonical RECONSTRUCTION — his exact rules still deserve their own run.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
