#!/usr/bin/env node
/**
 * DOES "STRONG PRICE, FADING VOLUME" PREDICT ANYTHING? — whole-market scan, graded.
 *
 * Built 2026-08-14 (operator: "a whole market scan should predict this"). The Evidence Chart's
 * new readout surfaced NVDA up 16pp on SPY while trading at 0.75x its normal volume, and the
 * natural hypothesis is that outperformance on thinning participation is exhaustion — that the
 * move is running out of buyers and will give back.
 *
 * That is a real, testable claim, so it gets tested rather than admired.
 *
 * ═══ THE CONTROL THAT MAKES THIS A TEST ═══
 * The naive version — "find extended names on low volume, see if they fall" — cannot separate
 * the VOLUME effect from the MOMENTUM effect, because extended names may mean-revert (or keep
 * running) regardless of volume. So every extended name is bucketed by participation and the
 * buckets are compared against each other:
 *
 *     EXTENDED + FADING   top-quintile 20d excess vs SPY, volume ratio < 0.8
 *     EXTENDED + RISING   top-quintile 20d excess vs SPY, volume ratio > 1.2
 *     EXTENDED (all)      the momentum baseline
 *     EVERYTHING          the universe baseline
 *
 * If fading and rising perform identically, volume adds nothing and the divergence story is
 * folklore. Only the SPREAD between them is evidence about volume.
 *
 * ═══ HONEST LIMITS, stated before the numbers ═══
 * This is IN-SAMPLE across roughly 400 sessions of one regime — a rising, AI-led tape. It cannot
 * establish an edge; it can only kill one. A pattern that fails here fails everywhere, which is
 * why it is worth running first and cheap. Anything that survives earns a pre-registered forward
 * test, not a position. Statistics are clustered by DATE, because every name scanned on one
 * morning shares that morning's tape.
 *
 * Usage: node backend/volume-divergence-test.js
 */
const fs = require("fs"), path = require("path");
const API = process.env.TRAIDS_URL || "http://localhost:3001";
const LOOK = 20, VOL_RECENT = 10, VOL_BASE = 40, FADE = 0.8, RISE = 1.2, HORIZONS = [5, 20];
const post = (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(180000) }).then(r => r.ok ? r.json() : Promise.reject(new Error(`${u} ${r.status}`)));
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

(async () => {
  const map = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "sector-map.json"), "utf8"));
  const universe = Object.keys(map);
  const data = (await post(`${API}/api/equities/bars`, { symbols: [...universe, "SPY"], days: 500 })).data || {};
  const spy = data.SPY || [];
  if (spy.length < 150) throw new Error(`SPY returned ${spy.length} bars — refusing to scan on a short benchmark`);
  const spyC = spy.map(b => b.c), dates = spy.map(b => b.t);
  const spyIdx = new Map(dates.map((d, i) => [d, i]));

  // Per-name series aligned to SPY's calendar; a name missing a session is simply absent that day.
  const series = {};
  for (const s of universe) {
    const b = data[s];
    if (!Array.isArray(b) || b.length < 150) continue;
    series[s] = { c: new Map(b.map(x => [x.t, x.c])), v: new Map(b.map(x => [x.t, x.v || 0])) };
  }
  const syms = Object.keys(series);

  // ── build the observation set ──────────────────────────────────────────────────────────────
  const obs = [];
  const start = VOL_BASE + VOL_RECENT + 5;
  for (let i = start; i < dates.length - Math.max(...HORIZONS); i++) {
    const d = dates[i], dPrev = dates[i - LOOK];
    const spyRet = 100 * (spyC[i] / spyC[i - LOOK] - 1);
    const day = [];
    for (const s of syms) {
      const S = series[s];
      const c0 = S.c.get(dPrev), c1 = S.c.get(d);
      if (!(c0 > 0) || !(c1 > 0)) continue;
      let recent = 0, rn = 0, base = 0, bn = 0;
      for (let k = i - VOL_RECENT + 1; k <= i; k++) { const v = S.v.get(dates[k]); if (v > 0) { recent += v; rn++; } }
      for (let k = i - VOL_RECENT - VOL_BASE + 1; k <= i - VOL_RECENT; k++) { const v = S.v.get(dates[k]); if (v > 0) { base += v; bn++; } }
      if (rn < 6 || bn < 25 || base === 0) continue;
      const volRatio = (recent / rn) / (base / bn);
      const excess = 100 * (c1 / c0 - 1) - spyRet;
      const fwd = {};
      for (const h of HORIZONS) {
        const cf = S.c.get(dates[i + h]);
        if (!(cf > 0)) continue;
        fwd[h] = 100 * (cf / c1 - 1) - (100 * (spyC[i + h] / spyC[i] - 1));   // forward EXCESS vs SPY
      }
      if (Object.keys(fwd).length !== HORIZONS.length) continue;
      day.push({ sym: s, excess, volRatio, fwd });
    }
    if (day.length < 40) continue;
    day.sort((a, b) => b.excess - a.excess);
    const cut = Math.max(1, Math.floor(day.length / 5));
    day.forEach((o, rank) => { o.extended = rank < cut; o.date = d; });
    obs.push(...day);
  }

  /**
   * ⚠ THE OVERLAP TRAP — the defect that made the first run of this file print t = 5.95.
   *
   * Day-clustering fixes one problem: every name scanned on the same morning shares that
   * morning's tape, so they are not independent observations. Averaging within a date handles it.
   *
   * It does NOT fix the other: a 20-day forward return sampled EVERY day overlaps the next one by
   * 19/20. Across 270 sessions there are roughly 13 genuinely independent 20-day windows, not
   * 270 — so dividing by sqrt(270) overstates significance by about sqrt(20), a factor of 4.5.
   * A t of 5.95 becomes about 1.33, which is nothing.
   *
   * So every statistic is reported twice: `t` computed on all daily observations (the flattering
   * conventional figure) and `tIndep` computed on NON-OVERLAPPING windows only — one observation
   * every h sessions. The second number is the one that means anything.
   */
  const byDay = (rows, h) => {
    const m = new Map();
    for (const r of rows) (m.get(r.date) || m.set(r.date, []).get(r.date)).push(r.fwd[h]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, a]) => ({ d, v: mean(a) }));
  };
  const stat = (rows, h) => {
    const daily = byDay(rows, h);
    if (daily.length < 3) return null;
    const all = daily.map(x => x.v);
    const m = mean(all), s = sd(all);
    // non-overlapping: keep one observation every h sessions along the date axis
    const idx = new Map(dates.map((d, i) => [d, i]));
    const indep = [];
    let lastI = -Infinity;
    for (const x of daily) { const i = idx.get(x.d); if (i - lastI >= h) { indep.push(x.v); lastI = i; } }
    const mi = mean(indep), si = sd(indep);
    return {
      n: rows.length, days: daily.length, mean: m,
      t: s ? m / (s / Math.sqrt(daily.length)) : null,
      indepN: indep.length, meanIndep: mi,
      tIndep: (si && indep.length > 2) ? mi / (si / Math.sqrt(indep.length)) : null,
    };
  };

  const extended = obs.filter(o => o.extended);
  const fading = extended.filter(o => o.volRatio < FADE);
  const rising = extended.filter(o => o.volRatio > RISE);

  console.log(`\n  STRONG PRICE, FADING VOLUME — does it predict?`);
  console.log(`  ${syms.length} names · ${new Set(obs.map(o => o.date)).size} sessions · ${obs.length.toLocaleString()} observations`);
  console.log(`  "extended" = top quintile of ${LOOK}d excess vs SPY that day · volume ratio = last ${VOL_RECENT}d ÷ prior ${VOL_BASE}d`);
  console.log(`  all figures are FORWARD EXCESS RETURN vs SPY, day-clustered\n`);

  for (const h of HORIZONS) {
    console.log(`  ── forward ${h} sessions ──`);
    const rows = [
      ["everything (baseline)", stat(obs, h)],
      ["extended (all)", stat(extended, h)],
      [`extended + FADING vol <${FADE}`, stat(fading, h)],
      [`extended + RISING vol >${RISE}`, stat(rising, h)],
    ];
    console.log(`    ${"".padEnd(30)} ${"fwd excess".padStart(10)}  ${"t (overlapping)".padStart(15)}  ${"t (INDEPENDENT)".padStart(16)}`);
    for (const [label, s] of rows) {
      if (!s) { console.log(`    ${label.padEnd(30)} —`); continue; }
      console.log(`    ${label.padEnd(30)} ${((s.mean >= 0 ? "+" : "") + s.mean.toFixed(3) + "%").padStart(10)}  ${(s.t == null ? "—" : s.t.toFixed(2)).padStart(15)}  ${(s.tIndep == null ? "—" : s.tIndep.toFixed(2)).padStart(11)} (n=${s.indepN})`);
    }
    const f = stat(fading, h), r = stat(rising, h);
    if (f && r) {
      const spread = f.mean - r.mean;
      console.log(`    → FADING minus RISING: ${(spread >= 0 ? "+" : "") + spread.toFixed(3)}pp  ${Math.abs(spread) < 0.15 ? "— indistinguishable; volume adds nothing here" : (spread < 0 ? "— fading underperforms, the divergence story points the right way" : "— fading OUTperforms, the opposite of the story")}`);
    }
    console.log();
  }
  console.log(`  IN-SAMPLE, one regime, ~2 years of a rising tape. This can kill a hypothesis, never establish one.`);
  console.log(`  Anything that survives earns a pre-registered forward test, not a position.\n`);
})();
