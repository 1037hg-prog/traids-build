#!/usr/bin/env node
/**
 * TEST #66 — THE FEAR & GREED CONTRARIAN CLAIM, GRADED.   (registered 2026-08-19)
 *
 * THE CLAIM. CNN's index page asserts that "extreme fear has marked bottoms and extreme greed
 * has often preceded pullbacks". It attaches no sample, no horizon, and no forward return to
 * that sentence — anywhere. The same page also says these are "sentiment indicators, not trade
 * signals". A subscription product features the dial above the fold regardless.
 *
 * WHAT THIS DOES. Reconstructs our own composite point-in-time over the available history, then
 * grades the sentence: forward 5 / 10 / 21-session returns CONDITIONED on the band, against the
 * unconditional base rate over the identical dates. "And then what happened", which is the one
 * thing the claim has never carried.
 *
 * ───────────────────────────────────────────────────────────────────────────────────────────
 * THREE THINGS THAT WOULD MAKE THIS FAKE, AND WHAT IS DONE ABOUT EACH
 *
 * 1. LOOK-AHEAD IN THE NORMALISATION. Each component is a percentile against its own trailing
 *    history. Ranking against the FULL series would let a 2019 reading know its 2026 percentile,
 *    which would score beautifully and mean nothing. Every percentile here ranks a date against
 *    the 250 sessions BEFORE it and nothing after.
 *
 * 2. OVERLAPPING FORWARD WINDOWS. A 21-session forward return sampled daily reuses 20 of its 21
 *    days with its neighbour. Treating those as independent inflates t by roughly sqrt(h) — it
 *    is the single easiest way to manufacture significance in a study shaped like this one. The
 *    headline inference is therefore a MOVING BLOCK BOOTSTRAP with block length = h, which
 *    preserves the overlap instead of pretending it is absent. The naive t is printed beside it
 *    purely so the size of the lie is visible.
 *
 * 3. THE BASE RATE. Equities drift up, so "extreme fear was followed by a gain" is not evidence
 *    of anything until it is compared with what an unconditional holder got over the same dates.
 *    Every bucket is reported as a DIFFERENCE from unconditional, never as a raw return.
 *
 * ───────────────────────────────────────────────────────────────────────────────────────────
 * HONEST LIMITATION, STATED UP FRONT. Only 4 of the 7 components can be reconstructed
 * historically: momentum, volatility, safe-haven and junk-bond demand all come from price series
 * we can pull point-in-time. Stock-price STRENGTH and BREADTH need the live board universe, and
 * PUT/CALL needs a per-date options history that is not on file. So this is a 4-of-7 composite
 * and is NOT the same number the live gauge records daily. It is labelled that way in the output
 * and in the JSON. The forward record (fear-greed-forward.json) is what eventually grades the
 * live 7-component composite; this reconstruction exists to say whether the claim is worth the
 * wait, on the components we can honestly rebuild.
 *
 * Nothing here trades. Paper validation record, not trading advice.
 */
const fs = require("fs"), path = require("path");
const API = process.env.TRAIDS_URL || "http://localhost:3001";
const YAHOO = process.env.TRAIDS_YAHOO || "http://localhost:3002";
const OUT = path.join(__dirname, "data", "fear-greed-reconstruction.json");
const FWD = path.join(__dirname, "data", "fear-greed-forward.json");
const GAUGE = path.join(__dirname, "data", "sentiment-gauge.json");
const FWD_H = 21;                     // the registered forward horizon — the claim is about turns, not days
const LOOKBACK = 250;                 // sessions each percentile ranks against — trailing only
const HORIZONS = [5, 10, 21];
const BOOT = 4000, SEED = 0x66ea6;

const post = (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(180000) }).then(r => r.ok ? r.json() : Promise.reject(new Error(`${u} ${r.status}`)));
const sma = (a, i, n) => { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; };
const mean = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const bandOf = (c) => c <= 24 ? "EXTREME FEAR" : c <= 44 ? "FEAR" : c <= 55 ? "NEUTRAL" : c <= 75 ? "GREED" : "EXTREME GREED";
const BANDS = ["EXTREME FEAR", "FEAR", "NEUTRAL", "GREED", "EXTREME GREED"];
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Percentile of v within hist — SAME rule as the live gauge, trailing window only. */
const pct = (hist, v) => { const h = hist.filter(Number.isFinite); if (h.length < 30) return null; return Math.round(100 * h.filter(x => x <= v).length / h.length); };

/** Trailing percentile of series[i] against the LOOKBACK values strictly before it. */
const ptPct = (series, i) => { const past = series.slice(Math.max(0, i - LOOKBACK), i); return pct(past, series[i]); };

(async () => {
  console.log(`\n  TEST #66 — FEAR & GREED, GRADED · reconstruction + forward record`);
  console.log(`  4 of 7 components (momentum · volatility · safe-haven · junk-bond) — see header.\n`);

  const core = await post(`${API}/api/equities/bars`, { symbols: ["SPY", "TLT", "HYG"], days: 3000 });
  const spy = core.data.SPY || [], tlt = core.data.TLT || [], hyg = core.data.HYG || [];
  if (spy.length < 400) throw new Error(`SPY returned ${spy.length} bars — refusing to grade a claim on a short series`);
  let vix = [];
  try { const y = await post(`${YAHOO}/api/yahoo/batch`, { symbols: ["^VIX"], days: 3000 }); vix = (y.data["^VIX"] || []).filter(b => Number.isFinite(b.c)); } catch { /* scored as unavailable */ }

  // align every series on SPY's dates — a component missing on a date is simply not scored there
  const at = (bars) => { const m = new Map(); for (const b of bars) m.set(b.date || b.t || b.time, b.c); return m; };
  const dates = spy.map(b => b.date || b.t || b.time);
  const spyC = spy.map(b => b.c), tltM = at(tlt), hygM = at(hyg), vixM = at(vix);
  const tltC = dates.map(d => tltM.get(d) ?? null), hygC = dates.map(d => hygM.get(d) ?? null), vixC = dates.map(d => vixM.get(d) ?? null);

  // ── raw component series (value per date; null where inputs are missing) ──
  const momR = spyC.map((c, i) => { const m = sma(spyC, i, 125); return m ? 100 * (c / m - 1) : null; });
  const volR = vixC.map((c, i) => { if (c == null) return null; const w = vixC.slice(Math.max(0, i - 49), i + 1); if (w.length < 50 || w.some(x => x == null)) return null; return 100 * (c / (w.reduce((s, v) => s + v, 0) / w.length) - 1); });
  const r20 = (a, i) => (i >= 20 && a[i] != null && a[i - 20] != null) ? 100 * (a[i] / a[i - 20] - 1) : null;
  const shR = dates.map((_, i) => { const a = r20(spyC, i), b = r20(tltC, i); return (a != null && b != null) ? a - b : null; });
  const jbR = dates.map((_, i) => { const a = r20(hygC, i), b = r20(tltC, i); return (a != null && b != null) ? a - b : null; });

  // ── point-in-time composite ──
  const rows = [];
  for (let i = 0; i < dates.length; i++) {
    const scores = [];
    const mom = momR[i] == null ? null : ptPct(momR, i); if (mom != null) scores.push(mom);
    const vol = volR[i] == null ? null : ptPct(volR, i); if (vol != null) scores.push(100 - vol);   // low vol = greed
    const sh = shR[i] == null ? null : ptPct(shR, i); if (sh != null) scores.push(sh);
    const jb = jbR[i] == null ? null : ptPct(jbR, i); if (jb != null) scores.push(jb);
    if (scores.length < 4) continue;                      // all four or the date is not scored
    const composite = Math.round(mean(scores));
    rows.push({ date: dates[i], i, composite, band: bandOf(composite) });
  }
  if (rows.length < 200) throw new Error(`only ${rows.length} scored dates — not enough to grade anything`);

  // ── forward returns from each scored date ──
  for (const r of rows) for (const h of HORIZONS) r[`f${h}`] = (r.i + h < spyC.length) ? 100 * (spyC[r.i + h] / spyC[r.i] - 1) : null;

  /**
   * MOVING BLOCK BOOTSTRAP on the bucket-minus-unconditional difference.
   * Blocks of length h are resampled with replacement over the ORIGINAL date ordering, so the
   * overlap between neighbouring forward windows is carried into the null instead of assumed
   * away. p is two-sided: the share of resamples whose difference is at least as extreme as
   * the observed one when the band label carries no information.
   */
  function bootstrapDiff(vals, flags, h) {
    const n = vals.length, obsIn = [], obsOut = [];
    for (let k = 0; k < n; k++) (flags[k] ? obsIn : obsOut).push(vals[k]);
    if (obsIn.length < 10) return null;
    const obs = mean(obsIn) - mean(vals);
    const rand = rng(SEED + h), nb = Math.ceil(n / h), cnt = obsIn.length;
    let ge = 0;
    for (let b = 0; b < BOOT; b++) {
      // rebuild a series of the same length from random blocks, then re-label the SAME number
      // of observations at random positions — destroying only the band↔return association
      const seq = [];
      for (let j = 0; j < nb; j++) { const st = Math.floor(rand() * Math.max(1, n - h)); for (let q = 0; q < h && seq.length < n; q++) seq.push(vals[st + q]); }
      const pick = [];
      for (let j = 0; j < cnt; j++) pick.push(seq[Math.floor(rand() * seq.length)]);
      if (Math.abs(mean(pick) - mean(seq)) >= Math.abs(obs)) ge++;
    }
    return { diff: obs, p: ge / BOOT, n: obsIn.length };
  }

  const out = { test: "#66 fear-greed-contrarian", builtAt: new Date().toISOString(),
    unit: "reconstruction, 4 of 7 components (momentum, volatility, safeHaven, junkBond)",
    caveat: "NOT the live 7-component gauge; strength/breadth/putCall cannot be rebuilt point-in-time",
    span: { from: rows[0].date, to: rows[rows.length - 1].date, scoredDates: rows.length },
    horizons: {} };

  console.log(`  span ${rows[0].date} → ${rows[rows.length - 1].date} · ${rows.length} scored sessions\n`);
  for (const h of HORIZONS) {
    const use = rows.filter(r => r[`f${h}`] != null);
    const vals = use.map(r => r[`f${h}`]);
    const uncond = mean(vals);
    console.log(`  ── forward ${h} sessions · unconditional ${uncond >= 0 ? "+" : ""}${uncond.toFixed(2)}% over ${vals.length} dates ──`);
    console.log(`     band            n     mean     vs uncond   naive t   block-bootstrap p`);
    out.horizons[h] = { unconditional: +uncond.toFixed(4), n: vals.length, bands: {} };
    for (const bd of BANDS) {
      const flags = use.map(r => r.band === bd);
      const inB = vals.filter((_, k) => flags[k]);
      if (!inB.length) { console.log(`     ${bd.padEnd(15)} ${String(0).padStart(4)}        —           —         —          —`); continue; }
      const d = mean(inB) - uncond;
      const naiveT = sd(inB) ? d / (sd(inB) / Math.sqrt(inB.length)) : 0;
      const bs = bootstrapDiff(vals, flags, h);
      console.log(`     ${bd.padEnd(15)} ${String(inB.length).padStart(4)}  ${(mean(inB) >= 0 ? "+" : "") + mean(inB).toFixed(2)}%    ${(d >= 0 ? "+" : "") + d.toFixed(2)}pp     ${naiveT.toFixed(2).padStart(6)}      ${bs ? bs.p.toFixed(3) : "—"}`);
      out.horizons[h].bands[bd] = { n: inB.length, mean: +mean(inB).toFixed(4), vsUncond: +d.toFixed(4), naiveT: +naiveT.toFixed(2), bootstrapP: bs ? +bs.p.toFixed(4) : null };
    }
    console.log("");
  }

  // the claim, in its own words, scored
  const claim = [];
  for (const h of HORIZONS) {
    const ef = out.horizons[h].bands["EXTREME FEAR"], eg = out.horizons[h].bands["EXTREME GREED"];
    claim.push({ horizon: h,
      extremeFearBeatsBase: ef ? (ef.vsUncond > 0 && ef.bootstrapP < 0.05) : null,
      extremeGreedTrailsBase: eg ? (eg.vsUncond < 0 && eg.bootstrapP < 0.05) : null });
  }
  out.claimVerdict = claim;
  console.log(`  ── THE CLAIM, SCORED (bar: beats unconditional with block-bootstrap p < 0.05) ──`);
  for (const c of claim) console.log(`     ${String(c.horizon).padStart(2)}d · "extreme fear marks bottoms": ${c.extremeFearBeatsBase === null ? "no observations" : c.extremeFearBeatsBase ? "SUPPORTED" : "NOT SUPPORTED"} · "extreme greed precedes pullbacks": ${c.extremeGreedTrailsBase === null ? "no observations" : c.extremeGreedTrailsBase ? "SUPPORTED" : "NOT SUPPORTED"}`);

  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

  /**
   * THE REGISTERED FORWARD RECORD — separate file, separate standard.
   *
   * Everything above is a reconstruction of a 4-of-7 composite over history that already
   * existed. It can say whether the claim is worth waiting on; it cannot BE the evidence,
   * because it was computed after the fact on data the specification could have been shaped
   * around. The registered candidate (fear-greed-contrarian) is graded on this file instead:
   * one row per LIVE gauge reading, graded +21 sessions later, as excess over the unconditional
   * base rate measured on the reconstruction span and frozen here as the reference.
   */
  const gauge = (() => { try { return JSON.parse(fs.readFileSync(GAUGE, "utf8")); } catch { return null; } })();
  const uncondRef = out.horizons[FWD_H] ? out.horizons[FWD_H].unconditional : null;
  const idxOf = new Map(dates.map((d, i) => [d, i]));
  const readings = [];
  for (const h of (gauge?.history || [])) {
    if (!h?.date || h.composite == null) continue;
    const i = idxOf.get(h.date);
    const row = { date: h.date, composite: h.composite, band: h.band ?? bandOf(h.composite), scoredOf: h.scoredOf ?? null };
    if (i != null && i + FWD_H < spyC.length && uncondRef != null) {
      row.fwd = +(100 * (spyC[i + FWD_H] / spyC[i] - 1)).toFixed(4);
      row.unconditional = uncondRef;
      row.excess = +(row.fwd - uncondRef).toFixed(4);      // what markFile() records
    }
    readings.push(row);
  }
  const matured = readings.filter(r => Number.isFinite(r.excess)).length;
  fs.writeFileSync(FWD, JSON.stringify({
    test: "#66 fear-greed-contrarian", unit: "live 7-component gauge readings, graded +" + FWD_H + " sessions",
    horizon: FWD_H, unconditionalReference: uncondRef,
    note: "Excess is over the unconditional base rate on the reconstruction span, frozen as the reference so the comparator cannot drift with the result.",
    updatedAt: new Date().toISOString(), readings,
  }, null, 1));

  console.log(`\n  written: ${path.basename(OUT)} (reconstruction) · ${path.basename(FWD)} (${readings.length} live reading(s), ${matured} matured)`);
  console.log(`  Reconstruction is NOT the evidence — the registered candidate is graded on the forward file.`);
  console.log(`  Paper validation record. Not trading advice.\n`);
})().catch(e => { console.error(`\n  FAILED: ${e.message}\n  (needs :3001 and :3002 — this fails closed rather than publishing a partial gauge)\n`); process.exit(1); });
