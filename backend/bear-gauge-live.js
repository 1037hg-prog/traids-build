#!/usr/bin/env node
/**
 * BEAR GAUGE — INTRADAY. (2026-08-24, operator: "make them intraday")
 *
 * WHY THIS IS A SEPARATE SCRIPT AND A SEPARATE FILE. The nightly gauge (bear-gauge.js) reads
 * market-tape.json, which the close chain rebuilds once a day from daily bars. Re-running the
 * nightly path hourly would recompute the SAME closed-session value and stamp it with a fresh
 * timestamp — turning honest staleness into false freshness, which is worse than the staleness.
 * So this computes TODAY from live Schwab quotes, takes history from the tape, and writes
 * bear-gauge-live.json. The nightly file is never touched and remains the authoritative reading.
 *
 * SAME FOUR COMPONENTS, SAME THRESHOLDS as bear-gauge.js — if those diverge the two readings stop
 * being comparable, which is the whole point of showing them side by side:
 *   TREND    today's chained SPX level below its own 200-day mean
 *   VOL      $VIX above 25
 *   BREADTH  equal-weight minus cap-weight (RSP% − SPY%) below −0.002
 *   CREDIT   HYG underperforming SPX by >2% over the trailing 20 sessions, today included
 *
 * FORMING BAR, AND IT SAYS SO. Every reading is labelled formingBar:true with the ET time it was
 * taken. A midday score is a partial session, not a close, and the file says which.
 *
 * FAILS CLOSED. If any of the four quotes is missing, NOTHING is written and the run exits 1 —
 * a regime score computed from three of four inputs is not a regime score.
 *
 * Usage: node backend/bear-gauge-live.js      (hourly during market hours; see automation/board-discipline.bat)
 */
const fs = require("fs"), path = require("path");
const schwab = require("./lib/schwab.js");
const D = (f) => path.join(__dirname, "data", f);

const VIX_ELEVATED = 25, BREADTH_NARROW = -0.002, CREDIT_DIVERGE = -0.02, CREDIT_MIN_SESSIONS = 15;

(async () => {
  const tape = JSON.parse(fs.readFileSync(D("market-tape.json"), "utf8"));
  const days = Object.keys(tape.days).sort();
  const etDay = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const etHM = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

  const want = ["SPY", "RSP", "HYG", "$VIX"];
  const tok = await schwab.token();
  const r = await fetch("https://api.schwabapi.com/marketdata/v1/quotes?symbols=" + encodeURIComponent(want.join(",")) + "&fields=quote",
    { headers: { Authorization: "Bearer " + tok }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("schwab quotes " + r.status);
  const j = await r.json();

  const q = {};
  for (const k of want) {
    const v = j[k] && j[k].quote;
    // Schwab's field is netPercentChange (verified 2026-08-24; netPercentChangeInDouble does not exist here)
    if (v) q[k] = { last: v.lastPrice ?? v.mark, pct: v.netPercentChange ?? v.markPercentChange };
  }
  const missing = want.filter((k) => !q[k] || !Number.isFinite(q[k].pct) || !Number.isFinite(q[k].last));
  if (missing.length) {
    console.error("BEAR GAUGE (live) — no usable quote for " + missing.join(", ") + " · refusing to score on partial data; nothing written");
    process.exit(1);
  }

  const spxToday = q.SPY.pct / 100;

  // TREND — chain today's move onto the tape's synthetic level, compare to the 200-day mean
  let acc = 100;
  const lvl = [];
  for (const d of days) { const x = tape.days[d].spx; if (Number.isFinite(x)) acc *= 1 + x; lvl.push(acc); }
  lvl.push(acc * (1 + spxToday));
  const i = lvl.length - 1;
  const w = lvl.slice(i - 199, i + 1);
  const trend = lvl[i] < (w.reduce((a, b) => a + b, 0) / w.length) ? 1 : 0;

  // VOL
  const vixLvl = q["$VIX"].last;
  const vol = vixLvl > VIX_ELEVATED ? 1 : 0;

  // BREADTH — equal-weight minus cap-weight, the same quantity market-tape.js stores
  const brToday = (q.RSP.pct - q.SPY.pct) / 100;
  const breadth = brToday < BREADTH_NARROW ? 1 : 0;

  // CREDIT — 20 sessions of HYG vs SPX with today's partial included
  let hAcc = 1 + q.HYG.pct / 100, sAcc = 1 + spxToday, n = 1;
  for (let k = days.length - 1; k >= days.length - 19 && k >= 0; k--) {
    const hh = tape.days[days[k]].hyg, ss = tape.days[days[k]].spx;
    if (Number.isFinite(hh) && Number.isFinite(ss)) { hAcc *= 1 + hh; sAcc *= 1 + ss; n++; }
  }
  const credit = (n >= CREDIT_MIN_SESSIONS && (hAcc - sAcc) < CREDIT_DIVERGE) ? 1 : 0;

  const score = trend + vol + breadth + credit;
  const nightly = (() => { try { return JSON.parse(fs.readFileSync(D("bear-gauge.json"), "utf8")); } catch { return null; } })();

  const out = {
    spec: "bear-gauge-live v1", intraday: true, formingBar: true,
    asOf: etDay, etTime: etHM, computedAt: new Date().toISOString(), score,
    components: { trendBroken: !!trend, volElevated: !!vol, breadthNarrow: !!breadth, creditDiverging: !!credit },
    thresholds: { vixElevated: VIX_ELEVATED, breadthNarrow: BREADTH_NARROW, creditDiverge: CREDIT_DIVERGE },
    inputs: { spyPct: q.SPY.pct, rspPct: q.RSP.pct, hygPct: q.HYG.pct, vix: vixLvl, breadthSpread: +brToday.toFixed(5), creditSpread20: +(hAcc - sAcc).toFixed(5), tapeThrough: days[days.length - 1] },
    nightly: nightly ? { asOf: nightly.asOf, score: nightly.score } : null,
    note: "Forming bar: today from live Schwab quotes, history from the close-chain tape. bear-gauge.json (nightly) remains the authoritative reading.",
  };
  fs.writeFileSync(D("bear-gauge-live.json"), JSON.stringify(out, null, 1));

  console.log(`BEAR GAUGE (live ${etDay} ${etHM} ET) — score ${score}/4 — trend ${trend ? "BROKEN" : "intact"} · vol ${vol ? "ELEVATED" : "calm"} · breadth ${breadth ? "NARROW" : "broad"} · credit ${credit ? "DIVERGING" : "confirming"}`);
  console.log(`  live: SPY ${q.SPY.pct}% · RSP ${q.RSP.pct}% · HYG ${q.HYG.pct}% · VIX ${vixLvl} · breadth spread ${brToday.toFixed(5)}`);
  if (nightly) console.log(`  nightly (${nightly.asOf}): score ${nightly.score}${nightly.score !== score ? "  ← intraday differs" : ""}`);
  console.log("  written: bear-gauge-live.json — the nightly file is untouched");
})().catch((e) => { console.error("BEAR GAUGE (live) failed:", e.message); process.exit(1); });
