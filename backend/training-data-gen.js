#!/usr/bin/env node
/**
 * TRAIDS — HISTORICAL TRAINING-DATA GENERATOR (2026-07-25)
 *
 * Produces the labeled dataset a prediction engine needs, by replaying the board's OWN signal
 * functions across the full universe over years of history.
 *
 * WHY THIS EXISTS: forward paper trading produces ~40 labeled records a day. A selection model
 * over ~16 features needs six figures of examples before its output means anything, so forward
 * collection alone would take decades. History is the only place that volume exists.
 *
 * THREE PROPERTIES THIS FILE IS BUILT AROUND
 *
 * 1. ONE COPY OF THE SIGNAL LOGIC. Signals come from signal-replay.js, which extracts them from
 *    src/App.jsx at load time. This generator contains no reimplementation of a signal, so the
 *    dataset cannot describe code that stopped running.
 *
 * 2. FEATURES SEE ONLY THE PAST, LABELS SEE ONLY THE FUTURE. Every feature at decision bar i is
 *    computed from bars ≤ i. Every label is computed from bars > i. There is exactly one place
 *    in this file that indexes past i, and it is the label block. `--verify` re-computes a
 *    sample of feature vectors against TRUNCATED bar arrays and asserts they are identical,
 *    because the claim "no look-ahead" is worth nothing unless something checks it.
 *
 * 3. ENTRY IS THE NEXT BAR'S OPEN. A signal formed on bar i's close cannot be filled at that
 *    close. Labels are measured from bar i+1's open, which is the earliest honestly attainable
 *    price. Measuring from bar i's close would inflate every result and is the single most
 *    common way a backtest lies.
 *
 * WHAT HISTORY CANNOT PROVIDE, stated so the ceiling is visible: of the 29 live observers, only
 * the price/volume-derived ones can be reconstructed point-in-time. Short-sale volume,
 * off-exchange share, insider filings, headline tone and earnings context exist only going
 * forward. A model trained here therefore conditions on ~16 features, and a live model may use
 * more — so the two are not interchangeable, and the live one must be validated separately.
 *
 * Usage
 *   node backend/training-data-gen.js --limit 40          quick pass over 40 symbols
 *   node backend/training-data-gen.js                      full universe
 *   node backend/training-data-gen.js --verify             look-ahead audit on a sample
 *   node backend/training-data-gen.js --days 2000 --out my.jsonl
 */
const fs = require("fs"), path = require("path");
const S = require("./signal-replay");

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : d; };
const LIMIT = +argOf("--limit", 0);
const DAYS = +argOf("--days", 2000);
const VERIFY = args.includes("--verify");
const OUT_DIR = path.join(__dirname, "data", "training");
const OUT = path.join(OUT_DIR, argOf("--out", "dataset.jsonl"));
const MKT = "http://localhost:3002/api/yahoo";
const CHUNK = 40;

// ── decision-time conventions, all declared here so a reader never has to infer one ──
const CONV = {
  warmup: 120,            // bars required before any signal is trusted (55-day break + 50 MA + ADX)
  voteMin: 0.30,          // board's own gate
  confMin: 0.30,
  entry: "next bar open",
  stopAtr: 1.5,           // stop distance in ATR(14) units
  targetAtr: 3.0,         // target distance in ATR(14) units
  horizonBars: 20,        // hard flat if neither level is reached
  ambiguity: "stop-first",// a bar containing both levels resolves against the position
  gaps: "settle at open", // a gap through the stop fills at the open, not the stop
  costBps: 5,             // round-trip, applied to the net label only
};

// ════════════════════════════════════════════════════════════════════════════
// Universe — read from the app so it cannot drift from what the board scans
// ════════════════════════════════════════════════════════════════════════════
function universe() {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.jsx"), "utf8");
  const grab = (n) => { const i = app.indexOf(`const ${n} = [`); if (i < 0) return []; const j = app.indexOf("];", i); return (app.slice(i, j).match(/"[A-Z0-9.\/=^-]+"/g) || []).map(s => s.slice(1, -1)); };
  const sp = [...new Set((app.match(/symbol:"[A-Z.]+"/g) || []).map(x => x.slice(8, -1)))];
  const eq = [...new Set([...sp, ...grab("BOARD_EQ_EXTRA"), ...grab("BOARD_EQ_MID")])];
  const crypto = grab("BOARD_CRYPTO"), fx = grab("BOARD_FX");
  return [
    ...eq.map(s => ({ sym: s, feed: s, cls: "Equity" })),
    ...crypto.map(s => ({ sym: s, feed: `${s}-USD`, cls: "Crypto" })),
    ...fx.map(s => ({ sym: s, feed: `${s}=X`, cls: "FX" })),
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// Feed helpers
// ════════════════════════════════════════════════════════════════════════════
const toBars = (rows) => (rows || []).map(b => ({ date: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }))
  .filter(b => b.date && Number.isFinite(b.close) && b.close > 0);

// Retried, because a single transient failure silently deleted 40 instruments from the first
// full run. A dropped chunk is indistinguishable from "those instruments had no signals"
// once the dataset is written, so the failure must be retried and then RECORDED, never
// swallowed.
async function fetchBatch(feeds, attempts = 3) {
  let lastErr;
  for (let a = 0; a < attempts; a++) {
    if (a) await new Promise(r => setTimeout(r, 2000 * a));
    try {
      const r = await fetch(`${MKT}/batch`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbols: feeds, days: DAYS }),
        signal: AbortSignal.timeout(180000),
      });
      if (!r.ok) throw new Error(`batch ${r.status}`);
      const j = await r.json();
      return j.data || {};
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function fetchSeries(sym) {
  try {
    const r = await fetch(`${MKT}/${encodeURIComponent(sym)}/history?days=${DAYS}&interval=1d`, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) return null;
    const j = await r.json();
    const m = new Map();
    for (const b of (j.bars || [])) if (Number.isFinite(b.close)) m.set(b.date, b);
    return m;
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURES — every one of these reads bars[0..i] only. Nothing here may index past i.
// ════════════════════════════════════════════════════════════════════════════
const ret = (bars, i, n) => (i - n >= 0 && bars[i - n].close > 0) ? (bars[i].close / bars[i - n].close - 1) : null;
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

function features(bars, i, ctx) {
  const b = bars[i], prev = bars[i - 1];
  const closes = bars.slice(0, i + 1).map(x => x.close);
  const highs = bars.slice(0, i + 1).map(x => x.high ?? x.close);
  const lows = bars.slice(0, i + 1).map(x => x.low ?? x.close);

  // trailing distribution of 20-day returns, for a percentile rather than a raw number
  const r20 = ret(bars, i, 20);
  const hist = [];
  for (let k = Math.max(20, i - 250); k <= i; k++) { const v = ret(bars, k, 20); if (v != null) hist.push(v); }
  const momPctile = (r20 != null && hist.length > 30) ? hist.filter(v => v <= r20).length / hist.length : null;

  const vols = bars.slice(Math.max(0, i - 20), i).map(x => x.volume || 0);
  const avgVol = mean(vols);
  const bb = S.bollingerBands(closes, 20, 2);
  const width = bb && bb.upper && bb.upper[i] != null ? (bb.upper[i] - bb.lower[i]) / closes[i] : null;
  const widthHist = [];
  if (bb && bb.upper) for (let k = Math.max(20, i - 250); k <= i; k++) if (bb.upper[k] != null) widthHist.push((bb.upper[k] - bb.lower[k]) / closes[k]);
  const squeeze = (width != null && widthHist.length > 30) ? widthHist.filter(v => v >= width).length / widthHist.length : null;

  const atrArr = S.atr ? S.atr(highs, lows, closes, 14) : null;
  const atrVal = atrArr ? atrArr[i] : null;
  const rsiArr = S.rsi(closes, 14);
  const adxArr = S.adx(highs, lows, closes, 14);
  const hi52 = Math.max(...closes.slice(Math.max(0, i - 251)));

  const d = b.date;
  const spy = ctx.spy && ctx.spy.get(d), sect = ctx.sector && ctx.sector.get(d);
  const spyRet20 = ctx.spySeries ? ctxRet(ctx.spySeries, d, 20) : null;
  const symRet20 = r20;

  return {
    // instrument-level
    momPctile,
    revRet5: ret(bars, i, 5),
    ret20: r20,
    squeeze,
    rvol: (avgVol && avgVol > 0) ? (b.volume || 0) / avgVol : null,
    prevMove: prev && prev.close > 0 && bars[i - 2] ? (prev.close / bars[i - 2].close - 1) : null,
    gapPct: prev && prev.close > 0 && b.open ? (b.open / prev.close - 1) : null,
    atrPct: (atrVal && b.close > 0) ? atrVal / b.close : null,
    rsi14: rsiArr ? rsiArr[i] : null,
    adx14: adxArr ? adxArr[i] : null,
    dist52w: hi52 > 0 ? b.close / hi52 - 1 : null,
    // cross-sectional / market-wide
    spyRet20,
    relRet20: (symRet20 != null && spyRet20 != null) ? symRet20 - spyRet20 : null,
    sectorRS: (symRet20 != null && ctx.sectorSeries) ? (() => { const s = ctxRet(ctx.sectorSeries, d, 20); return s == null ? null : symRet20 - s; })() : null,
    vix: ctx.vix ? (ctx.vix.get(d) || null) : null,
    vixChg: ctx.vixSeries ? ctxRet(ctx.vixSeries, d, 5) : null,
    yield10: ctx.tnx ? (ctx.tnx.get(d) || null) : null,
    yieldChg: ctx.tnxSeries ? ctxDiff(ctx.tnxSeries, d, 20) : null,
    regimeAlign: (spyRet20 != null && symRet20 != null) ? (Math.sign(spyRet20) === Math.sign(symRet20) ? 1 : 0) : null,
  };
}

// Date-anchored lookups on a market-wide series. Anchored by DATE, never by position — two
// series with different holiday calendars do not share an index, and assuming they do is how a
// feature ends up measuring a different day than it claims to.
function ctxRet(series, date, n) {
  const i = series.idx.get(date);
  if (i == null || i - n < 0) return null;
  const a = series.vals[i - n], b = series.vals[i];
  return (a > 0 && b > 0) ? b / a - 1 : null;
}
function ctxDiff(series, date, n) {
  const i = series.idx.get(date);
  if (i == null || i - n < 0) return null;
  return series.vals[i] - series.vals[i - n];
}
function toSeries(map) {
  if (!map) return null;
  const dates = [...map.keys()].sort();
  return { idx: new Map(dates.map((d, i) => [d, i])), vals: dates.map(d => map.get(d).close), dates };
}

// ════════════════════════════════════════════════════════════════════════════
// LABELS — the ONLY block permitted to look past i
// ════════════════════════════════════════════════════════════════════════════
function labels(bars, i, dir, atrVal, spySeries) {
  const e = bars[i + 1];
  if (!e || !Number.isFinite(e.open) || e.open <= 0) return null;   // unfillable → no row, not a guess
  const entry = e.open;
  const out = { entry };

  for (const h of [1, 3, 5, 10, 20]) {
    const k = i + 1 + h;
    out[`fwdRet${h}`] = (k < bars.length && bars[k].close > 0) ? dir * (bars[k].close / entry - 1) : null;
    // excess over the market on the same window: a long in a rising market is not skill, and a
    // model trained on raw returns learns beta and reports it as alpha
    if (spySeries && out[`fwdRet${h}`] != null) {
      const si = spySeries.idx.get(e.date);
      const sk = si != null ? si + h : null;
      out[`fwdExc${h}`] = (sk != null && sk < spySeries.vals.length && spySeries.vals[si] > 0)
        ? out[`fwdRet${h}`] - dir * (spySeries.vals[sk] / spySeries.vals[si] - 1) : null;
    } else out[`fwdExc${h}`] = null;
  }

  // Settle under the declared convention: stop-first on ambiguity, gap-aware, hard flat at the
  // horizon. This is what makes the label comparable to how the live board grades a trade.
  if (Number.isFinite(atrVal) && atrVal > 0) {
    const stop = entry - dir * CONV.stopAtr * atrVal;
    const target = entry + dir * CONV.targetAtr * atrVal;
    let exit = null, reason = "horizon", gapped = false, ambiguous = false;
    for (let k = i + 1; k < Math.min(bars.length, i + 1 + CONV.horizonBars); k++) {
      const bar = bars[k];
      const hitStop = dir > 0 ? bar.low <= stop : bar.high >= stop;
      const hitTgt = dir > 0 ? bar.high >= target : bar.low <= target;
      if (hitStop && hitTgt) ambiguous = true;
      if (hitStop) {
        const gapThrough = dir > 0 ? bar.open <= stop : bar.open >= stop;
        exit = gapThrough ? bar.open : stop;      // a gap fills at the open, not the stop
        gapped = gapThrough; reason = "stop"; break;
      }
      if (hitTgt) { exit = target; reason = "target"; break; }
    }
    if (exit == null) { const last = bars[Math.min(bars.length - 1, i + CONV.horizonBars)]; exit = last.close; }
    const risk = CONV.stopAtr * atrVal;
    out.rMult = +(((exit - entry) * dir) / risk).toFixed(4);
    out.rMultNet = +(out.rMult - (CONV.costBps / 1e4) * entry / risk).toFixed(4);
    out.exitReason = reason; out.gapped = gapped; out.ambiguous = ambiguous;
  } else { out.rMult = null; out.rMultNet = null; out.exitReason = null; out.gapped = null; out.ambiguous = null; }

  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════════════════
(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  console.log(`\n  TRAIDS — HISTORICAL TRAINING-DATA GENERATOR`);
  console.log(`  signal functions in use: breakout · mean-reversion · trend · ensemble (extracted from the app)\n`);

  console.log("  fetching market-wide context series…");
  const [spyM, vixM, tnxM] = await Promise.all([fetchSeries("SPY"), fetchSeries("^VIX"), fetchSeries("^TNX")]);
  const spySeries = toSeries(spyM), vixSeries = toSeries(vixM), tnxSeries = toSeries(tnxM);
  console.log(`  SPY ${spyM ? spyM.size : 0} bars · VIX ${vixM ? vixM.size : 0} · 10y ${tnxM ? tnxM.size : 0}`);
  if (!spySeries) { console.log("\n  ✗ market context unavailable — refusing to generate a dataset without a benchmark\n"); process.exit(1); }

  // Sector proxy: one broad ETF, honest about being a proxy rather than a true GICS map.
  const sectorM = await fetchSeries("XLK");
  const sectorSeries = toSeries(sectorM);

  let uni = universe();
  if (LIMIT) uni = uni.slice(0, LIMIT);
  console.log(`  universe: ${uni.length} instrument(s) · ${DAYS} calendar days of history\n`);

  if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
  const ctxBase = { spy: spyM, spySeries, vix: vixM, vixSeries, tnx: tnxM, tnxSeries, sector: sectorM, sectorSeries };
  const STRATS = [["Breakout", "breakoutSignal"], ["Mean-Reversion", "meanRevSignal"], ["Trend", "trendSignal"], ["Ensemble", "ensembleSignal"]];

  let rows = 0, symsDone = 0, symsEmpty = 0, unfillable = 0;
  const byStrat = {}, byYear = {};
  const episodes = new Set();      // distinct bets, as opposed to distinct rows
  const fetchFailed = [], noData = [], thinHistory = [];
  const verifySamples = [];

  for (let c = 0; c < uni.length; c += CHUNK) {
    const slice = uni.slice(c, c + CHUNK);
    let data;
    try { data = await fetchBatch(slice.map(s => s.feed)); }
    catch (e) {
      slice.forEach(s => fetchFailed.push(s.sym));
      console.log(`\n  ⚠ chunk ${c}-${c + slice.length} failed after retries (${e.message}) — ${slice.length} instruments recorded as MISSING, not skipped`);
      continue;
    }

    const out = [];
    for (const u of slice) {
      const bars = toBars(data[u.feed]);
      symsDone++;
      // An instrument the feed returns NOTHING for is almost always delisted or acquired —
      // not "thin history". Conflating the two hides survivorship bias inside a routine-looking
      // skip counter. The first full run lost SGEN, PXD, KSU, ABC, ANSS, JNPR and others this
      // way: every one an acquisition, every one removed in the flattering direction, because
      // companies that ceased to exist are exactly the ones whose trades ended badly.
      if (!bars.length) { noData.push(u.sym); continue; }
      if (bars.length < CONV.warmup + 40) { symsEmpty++; thinHistory.push(u.sym); continue; }
      const closes = bars.map(x => x.close), highs = bars.map(x => x.high ?? x.close), lows = bars.map(x => x.low ?? x.close);
      const atrArr = S.atr(highs, lows, closes, 14);

      // Episode tracking. Trend and ensemble signals describe a STATE, so they re-fire on
      // consecutive bars throughout the same move: those rows are repeated observations of ONE
      // bet, not independent examples. Without a grouping key a trainer would treat a 40-bar
      // trend as 40 independent samples, inflate its effective sample size by that factor, and
      // leak across any random train/test split (the same episode landing on both sides).
      // `episode` collapses each run so splits can be made by episode and standard errors can
      // be clustered on it.
      const epState = {};   // "strategy|dir" -> { id, lastIdx }

      for (let i = CONV.warmup; i < bars.length - 2; i++) {
        for (const [name, fn] of STRATS) {
          let sig;
          try { sig = S[fn](bars, i); } catch { continue; }
          if (!sig || !Number.isFinite(sig.vote) || Math.abs(sig.vote) < CONV.voteMin) continue;
          if (!Number.isFinite(sig.confidence) || sig.confidence < CONV.confMin) continue;
          const dir = Math.sign(sig.vote);
          const lab = labels(bars, i, dir, atrArr[i], spySeries);
          if (!lab) { unfillable++; continue; }
          const f = features(bars, i, ctxBase);
          const ek = `${name}|${dir}`;
          if (!epState[ek] || i > epState[ek].lastIdx + 1) {
            epState[ek] = { id: `${u.sym}|${name}|${dir}|${bars[i].date}`, startIdx: i, lastIdx: i };
          } else epState[ek].lastIdx = i;
          const ep = epState[ek];
          episodes.add(ep.id);
          const row = {
            sym: u.sym, cls: u.cls, date: bars[i].date, entryDate: bars[i + 1].date,
            strategy: name, dir, vote: +sig.vote.toFixed(4), conf: +sig.confidence.toFixed(4),
            episode: ep.id, episodeBar: i - ep.startIdx,     // 0 = first firing of this run
            f, ...lab,
          };
          out.push(row);
          rows++;
          byStrat[name] = (byStrat[name] || 0) + 1;
          const y = bars[i].date.slice(0, 4); byYear[y] = (byYear[y] || 0) + 1;
          if (VERIFY && verifySamples.length < 400 && rows % 37 === 0) verifySamples.push({ bars, i, f });
        }
      }
    }
    if (out.length) fs.appendFileSync(OUT, out.map(r => JSON.stringify(r)).join("\n") + "\n");
    const pct = Math.min(100, Math.round(100 * symsDone / uni.length));
    process.stdout.write(`\r  replaying… ${symsDone}/${uni.length} instruments (${pct}%) · ${rows.toLocaleString()} rows   `);
  }
  process.stdout.write("\n");

  // ── look-ahead audit: features recomputed against truncated history must be identical ──
  let laFail = 0;
  if (VERIFY) {
    console.log(`\n  look-ahead audit on ${verifySamples.length} sampled decisions…`);
    for (const s of verifySamples) {
      const truncated = s.bars.slice(0, s.i + 1);      // every future bar removed
      const again = features(truncated, s.i, ctxBase);
      if (JSON.stringify(again) !== JSON.stringify(s.f)) {
        laFail++;
        if (laFail <= 3) {
          const diff = Object.keys(s.f).filter(k => JSON.stringify(s.f[k]) !== JSON.stringify(again[k]));
          console.log(`  ✗ ${s.bars[s.i].date} differs on: ${diff.join(", ")}`);
        }
      }
    }
    console.log(laFail
      ? `  ✗ ${laFail} of ${verifySamples.length} feature vectors CHANGED when future bars were removed — the dataset leaks the future`
      : `  ✓ ${verifySamples.length}/${verifySamples.length} feature vectors identical with future bars removed — no look-ahead`);
  }

  // ── manifest ────────────────────────────────────────────────────────────────
  const featNames = Object.keys(features(
    Array.from({ length: 300 }, (_, k) => ({ date: `2024-01-${String((k % 28) + 1).padStart(2, "0")}`, open: 100, high: 101, low: 99, close: 100 + k * 0.1, volume: 1e6 })),
    250, ctxBase));
  const manifest = {
    generated: new Date().toISOString(),
    rows, instruments: symsDone, skippedThinHistory: symsEmpty, unfillableEntries: unfillable,
    // Coverage accounting, kept separate on purpose — these three are different failures and
    // only one of them is benign.
    coverage: {
      universe: uni.length,
      contributed: symsDone - noData.length - thinHistory.length,
      noDataLikelyDelisted: { count: noData.length, symbols: noData },
      thinHistory: { count: thinHistory.length, symbols: thinHistory },
      fetchFailed: { count: fetchFailed.length, symbols: fetchFailed },
    },
    survivorshipWarning: noData.length
      ? `${noData.length} instrument(s) returned no history and are absent from this dataset. Spot checks on the first full run showed these are predominantly ACQUIRED or DELISTED names (SGEN, PXD, KSU, ABC, ANSS, JNPR …). Their absence biases every result in the FAVOURABLE direction, because companies that ceased to exist are over-represented among trades that ended badly. Any conclusion drawn from this dataset inherits that bias, and its size is not yet measured — see the universe/survivorship audit.`
      : null,
    // The number that governs what can be learned. Rows overstate it because state-based
    // signals re-fire through a single move; episodes are the distinct bets.
    episodes: episodes.size,
    rowsPerEpisode: episodes.size ? +(rows / episodes.size).toFixed(2) : null,
    splitGuidance: "Split train/test by DATE and group by `episode`. A random row-level split puts the same episode on both sides and will report a skill that does not exist.",
    days: DAYS, conventions: CONV, features: featNames,
    labels: ["fwdRet1/3/5/10/20", "fwdExc1/3/5/10/20 (excess over benchmark)", "rMult", "rMultNet", "exitReason", "gapped", "ambiguous"],
    byStrategy: byStrat, byYear,
    lookaheadAudit: VERIFY ? { sampled: verifySamples.length, failures: laFail } : "not run — pass --verify",
    notBackfillable: ["shortVolumeZ", "atsShare", "insiderNet", "headlineTone", "earningsContext"],
    caveat: "Features see bars ≤ i only; labels see bars > i only. Entry is bar i+1's open, never bar i's close.",
  };
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 1));

  const mb = fs.existsSync(OUT) ? fs.statSync(OUT).size / 1048576 : 0;
  console.log(`\n  ── DATASET ──`);
  console.log(`  ${rows.toLocaleString()} rows · ${mb.toFixed(1)} MB · ${featNames.length} features · ${symsDone} instruments (${symsEmpty} skipped for thin history)`);
  console.log(`  ${episodes.size.toLocaleString()} distinct episodes (${episodes.size ? (rows / episodes.size).toFixed(1) : "—"} rows each) ← the effective sample size, not the row count`);
  console.log(`  by strategy: ${Object.entries(byStrat).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(" · ")}`);
  console.log(`  by year:     ${Object.entries(byYear).sort().map(([k, v]) => `${k} ${v.toLocaleString()}`).join(" · ")}`);
  console.log(`  ${unfillable.toLocaleString()} signal(s) dropped as unfillable rather than priced by assumption`);
  console.log(`\n  ── COVERAGE ──`);
  console.log(`  ${symsDone - noData.length - thinHistory.length} of ${uni.length} instruments contributed rows`);
  if (thinHistory.length) console.log(`  ${thinHistory.length} skipped for genuinely thin history`);
  if (fetchFailed.length) console.log(`  ✗ ${fetchFailed.length} LOST to fetch failure after retries — re-run to include them: ${fetchFailed.slice(0, 6).join(", ")}${fetchFailed.length > 6 ? "…" : ""}`);
  if (noData.length) {
    console.log(`  ▲ ${noData.length} returned NO history — predominantly delisted/acquired names.`);
    console.log(`    This is SURVIVORSHIP BIAS and it flatters every result computed from this dataset.`);
    console.log(`    e.g. ${noData.slice(0, 10).join(", ")}`);
  }
  console.log(`\n  written: backend/data/training/${path.basename(OUT)} + manifest.json`);
  console.log(`  elapsed: ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  process.exit(laFail ? 1 : 0);
})();
