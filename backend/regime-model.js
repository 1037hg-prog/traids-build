#!/usr/bin/env node
/**
 * REGIME MODEL (manifest A4, built 2026-08-21). "What kind of day is the market in" as a number.
 *
 * Clusters daily market state into k=4 regimes with k-means over ~380 sessions of bars (the
 * sentiment gauge's stored history is 8 sessions — too short — so state is derived from bars):
 *   spyVs50   SPY close vs its 50-day SMA, %          slope50   SPY 50d SMA vs 200d SMA, %
 *   rv20      SPY 20-day realized vol, annualized %   ret5      SPY 5-day return, %
 *   credit20  HYG minus IEF 20-day return, pp         size20    IWM minus SPY 20-day return, pp
 *   breadth50 share of the 11 sector ETFs above their own 50-day SMA, %
 * Standardized on the clustering window; deterministic initialization (quantile seeds on the first
 * feature — no Math.random, so the run is reproducible and the provenance audit stays clean).
 * Regimes are LABELLED BY THEIR CENTROIDS, never by name: "regime 2" is whatever its numbers say.
 *
 * Every ticket gets obs.regimeId plus the raw state (obs.spyVs50, obs.rv20, obs.credit20,
 * obs.breadth50) — numeric dials the weighted board can split on. Hierarchical shrinkage of dial
 * weights toward a per-regime prior is the weighted board's job once a dial has earned anything;
 * this file only makes the regime observable and records the clean-era direction split by regime
 * (the finding it was built to capture: longs +0.14R / shorts −0.13R regardless of signal).
 * Output: data/regime-model.json. Served at /api/regime. Nightly in the close chain.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const API = process.env.TRAIDS_API || "http://localhost:3001";
const SECTORS = ["XLK", "XLE", "XLF", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC"];
const K = 4;
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sma = (a, n, i) => i + 1 >= n ? mean(a.slice(i - n + 1, i + 1)) : null;

(async () => {
  const r = await fetch(`${API}/api/yahoo/batch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: ["SPY", "HYG", "IEF", "IWM", ...SECTORS], days: 900 }), signal: AbortSignal.timeout(120000) });
  const data = (await r.json()).data || {};
  const d = (b) => String(b.t || b.date).slice(0, 10);
  const spy = data.SPY || [];
  if (spy.length < 260) { console.error("REGIME MODEL — insufficient SPY history:", spy.length); process.exit(1); }
  const closesOf = (sym) => { const m = new Map(); for (const b of data[sym] || []) m.set(d(b), b.c); return m; };
  const C = Object.fromEntries(["SPY", "HYG", "IEF", "IWM", ...SECTORS].map((s) => [s, closesOf(s)]));
  const dates = spy.map(d);
  const spyC = spy.map((b) => b.c);
  const seriesAt = (sym, i) => C[sym].get(dates[i]);
  const ret = (sym, i, n) => { const a = seriesAt(sym, i), b = seriesAt(sym, i - n); return a && b ? 100 * (a / b - 1) : null; };
  const rows = [];
  for (let i = 200; i < dates.length; i++) {
    const s50 = sma(spyC, 50, i), s200 = sma(spyC, 200, i);
    const rets = []; for (let j = i - 19; j <= i; j++) rets.push(Math.log(spyC[j] / spyC[j - 1]));
    const rv20 = 100 * Math.sqrt(252) * Math.sqrt(mean(rets.map((x) => (x - mean(rets)) ** 2)));
    const credit20 = ret("HYG", i, 20) != null && ret("IEF", i, 20) != null ? ret("HYG", i, 20) - ret("IEF", i, 20) : null;
    const size20 = ret("IWM", i, 20) != null ? ret("IWM", i, 20) - ret("SPY", i, 20) : null;
    let above = 0, cnt = 0; for (const s of SECTORS) { const arr = (data[s] || []).map((b) => b.c); const idx = (data[s] || []).findIndex((b) => d(b) === dates[i]); if (idx >= 49) { cnt++; if (arr[idx] > mean(arr.slice(idx - 49, idx + 1))) above++; } }
    const f = { spyVs50: +(100 * (spyC[i] / s50 - 1)).toFixed(2), slope50: +(100 * (s50 / s200 - 1)).toFixed(2), rv20: +rv20.toFixed(2), ret5: +ret("SPY", i, 5).toFixed(2), credit20: credit20 != null ? +credit20.toFixed(2) : null, size20: size20 != null ? +size20.toFixed(2) : null, breadth50: cnt ? +(100 * above / cnt).toFixed(1) : null };
    if (Object.values(f).some((v) => v == null)) continue;
    rows.push({ date: dates[i], f });
  }
  const FEATS = ["spyVs50", "slope50", "rv20", "ret5", "credit20", "size20", "breadth50"];
  const mu = {}, sd = {};
  for (const k of FEATS) { const v = rows.map((r) => r.f[k]); mu[k] = mean(v); sd[k] = Math.sqrt(mean(v.map((x) => (x - mu[k]) ** 2))) || 1; }
  const Z = rows.map((r) => FEATS.map((k) => (r.f[k] - mu[k]) / sd[k]));
  // deterministic seeds: quantiles of the first feature (spyVs50)
  const order = Z.map((z, i) => [z[0], i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  let cents = Array.from({ length: K }, (_, c) => Z[order[Math.floor((c + 0.5) * order.length / K)]].slice());
  let assign = new Array(Z.length).fill(0);
  for (let it = 0; it < 50; it++) {
    let changed = 0;
    for (let i = 0; i < Z.length; i++) { let best = 0, bd = Infinity; for (let c = 0; c < K; c++) { let dd = 0; for (let k = 0; k < FEATS.length; k++) dd += (Z[i][k] - cents[c][k]) ** 2; if (dd < bd) { bd = dd; best = c; } } if (assign[i] !== best) { assign[i] = best; changed++; } }
    for (let c = 0; c < K; c++) { const m = Z.filter((_, i) => assign[i] === c); if (m.length) cents[c] = FEATS.map((_, k) => mean(m.map((z) => z[k]))); }
    if (!changed) break;
  }
  /**
   * COMPLETENESS GUARD — added 2026-09-01 by the morning integrity wave.
   *
   * This writer asks /api/yahoo/batch for 560 days and expects ~380 sessions. On 2026-08-31 it
   * silently accepted a truncated response TWICE IN ONE DAY: the label fingerprint taken at
   * 18:39 UTC covers 185 sessions (2025-12-02 -> 2026-08-27); regime-model.json written at
   * 20:47 UTC the same day covers 41 (2026-07-01 -> 2026-08-27) — the SAME nominal end date, a
   * 78% collapse of the clustering window, and 100% of the 41 overlapping labels changed.
   *
   * That is not cosmetic. R35 (breadth) and R38 (vol) are REGISTERED and enforced as shadows,
   * and they read breadth50P25 / rv20P90 — quantiles computed from THIS window's distribution.
   * A window that silently shrinks by 78% moves those thresholds with no record of why.
   *
   * Fail closed, per the standing live-data rule: refuse to overwrite a good model with a
   * truncated one. This is a WRITER completeness assertion on an unregistered engineering
   * parameter — it does not touch any registered bar, rule, threshold formula or verdict.
   */
  /**
   * WINDOW LENGTH FIX — alpha hunt 2026-09-02.
   *
   * The guard above could never pass. The clustering loop starts at i=200 (sma200 warm-up), so
   * usable rows = bars - 200. days:560 returns 386 bars => 186 rows, permanently below the 250
   * floor. The "185 sessions" in the incident note was therefore not a truncated feed at all —
   * it was this writer's structural ceiling. Verified 2026-09-02: the batch endpoint dropped
   * nothing and no symbol was short at 560, 900 or 1100 days.
   *
   * Consequence, and the reason this is not cosmetic: because the guard blocked every rebuild,
   * regime-model.json stayed frozen on the 41-session build of 2026-08-31 (2026-07-01 ->
   * 2026-08-27) — the truncated artifact the guard was written to prevent, locked in one write
   * too late. src/App.jsx:12687 and :12689 enforce R35 and R38 off ITS quantiles:
   *   breadth50P25  63.6 (41-session)  vs  54.5 (416-session)  — R35 refused longs on 32% of
   *                                                               sessions, by design 25%
   *   rv20P90      15.26 (41-session)  vs  19.50 (416-session)  — R38 refused ALL entries on
   *                                                               25% of sessions, by design 10%
   * A 90th-percentile vol gate firing a quarter of the time is not the gate that was registered.
   *
   * days 560 -> 900 restores the ~380-row design target this file's header already states
   * (900 calendar days => 617 bars => 416 rows) and makes MIN_SESSIONS reachable. This changes
   * an unregistered engineering parameter — the feed window — not R35's or R38's rule, which is
   * and remains "refuse outside this window's 25th/90th percentile". It DOES move the realized
   * thresholds, which is the whole point and is disclosed above rather than absorbed silently.
   */
  const MIN_SESSIONS = 250;                 // ~1 trading year; the design target is ~380
  const MIN_FRACTION_OF_PREVIOUS = 0.75;    // catches a silent shrink even above the floor
  {
    let prevSessions = 0;
    try { prevSessions = Number(JSON.parse(fs.readFileSync(D("regime-model.json"), "utf8")).window.sessions) || 0; } catch {}
    const floor = Math.max(MIN_SESSIONS, Math.ceil(prevSessions * MIN_FRACTION_OF_PREVIOUS));
    if (rows.length < floor) {
      console.error(`REFUSING TO WRITE — clustering window is ${rows.length} sessions (${rows[0].date} -> ${rows[rows.length - 1].date}).`);
      console.error(`  Floor is ${floor} (MIN_SESSIONS ${MIN_SESSIONS}; previous build ${prevSessions} x ${MIN_FRACTION_OF_PREVIOUS}).`);
      console.error("  The feed returned a partial batch. R35/R38 read quantiles off this window — writing a");
      console.error("  truncated one would move two ENFORCED thresholds with no record. Existing model left intact.");
      process.exitCode = 1;
      return;
    }
  }
  const centroidsRaw = cents.map((c) => Object.fromEntries(FEATS.map((k, j) => [k, +(c[j] * sd[k] + mu[k]).toFixed(2)])));
  const label = (c) => `${c.spyVs50 >= 0 ? "above-50d" : "below-50d"} · ${c.rv20 < mu.rv20 ? "low-vol" : "high-vol"} · ${c.breadth50 >= 55 ? "broad" : "narrow"} · credit ${c.credit20 >= 0 ? "+" : "−"}`;
  const history = rows.map((r, i) => ({ date: r.date, regimeId: assign[i] }));
  // thresholds for the zoo's market-state filters (R35 breadth, R38 vol), fixed from this window's distribution
  const q = (k, p) => { const v = rows.map((r) => r.f[k]).sort((a, b) => a - b); return +v[Math.floor(p * (v.length - 1))].toFixed(2); };
  const thresholds = { breadth50P25: q("breadth50", 0.25), rv20Median: q("rv20", 0.5), rv20P90: q("rv20", 0.9) };
  const today = { date: rows[rows.length - 1].date, regimeId: assign[assign.length - 1], label: label(centroidsRaw[assign[assign.length - 1]]), features: rows[rows.length - 1].f, thresholds };
  // clean-era direction split by regime (the finding this exists to capture)
  let split = {};
  try {
    const log = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8"));
    const et = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const regOf = new Map(history.map((h) => [h.date, h.regimeId]));
    const rowsT = log.filter((t) => Number.isFinite(t.rMult) && t.openedAt && et(t.openedAt) >= "2026-07-20" && !t.ctrl && !t.ctrlRand && !t.vetoShadow && t.cls !== "Options");
    for (const t of rowsT) { const g = regOf.get(et(t.openedAt)); if (g == null) continue; const k = `regime ${g}`; (split[k] ||= { days: new Set(), long: [], short: [] }); split[k].days.add(et(t.openedAt)); (t.dir > 0 ? split[k].long : split[k].short).push(t.rMult); }
    split = Object.fromEntries(Object.entries(split).map(([k, v]) => [k, { sessions: v.days.size, longs: v.long.length, longAvgR: v.long.length ? +mean(v.long).toFixed(3) : null, shorts: v.short.length, shortAvgR: v.short.length ? +mean(v.short).toFixed(3) : null }]));
  } catch {}
  writeJsonAtomic(D("regime-model.json"), { spec: "regime-kmeans-v1", built: "2026-08-21", asOf: new Date().toISOString(), k: K, features: FEATS, window: { from: rows[0].date, to: rows[rows.length - 1].date, sessions: rows.length }, standardization: { mu, sd }, centroids: centroidsRaw.map((c, i) => ({ regimeId: i, label: label(c), days: assign.filter((a) => a === i).length, ...c })), today, cleanEraDirectionSplit: split, history });
  console.log(`REGIME MODEL — k=${K} over ${rows.length} sessions (${rows[0].date} → ${rows[rows.length - 1].date}) · today: regime ${today.regimeId} (${today.label})`);
  for (const c of centroidsRaw.map((c, i) => ({ i, c }))) console.log(`  regime ${c.i} (${assign.filter((a) => a === c.i).length}d): ${label(c.c)} · spyVs50 ${c.c.spyVs50}% · rv20 ${c.c.rv20}% · breadth ${c.c.breadth50}% · credit20 ${c.c.credit20}pp`);
  for (const [k, v] of Object.entries(split)) console.log(`  ${k}: ${v.sessions} clean-era sessions · longs ${v.longs} avgR ${v.longAvgR} · shorts ${v.shorts} avgR ${v.shortAvgR}`);
  console.log("written: regime-model.json → served at /api/regime; tickets stamp obs.regimeId + the four state features");
})();
