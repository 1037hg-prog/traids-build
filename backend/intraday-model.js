#!/usr/bin/env node
/**
 * R41 — ONE MODEL ON THE INTRADAY HORIZON. Registered 2026-08-23, forward evidence from 2026-08-25.
 *
 * The Medallion shape: no single rule has to earn weight; a model that eats every signal's features
 * outputs one forecast, and the forecast is what gets tested out of sample. The signals are R39's two
 * rules (ORB30, VWAPR); the features are nine signal-time observables (lib/intraday-features.js); the
 * learners are the shop's own GBM and ridge (lib/gbm.js, the bake-off's code). Costs are inside R.
 *
 * TWO MODES, one file (data/intraday-model.json):
 *
 *   (default) HISTORY — in-sample exploration on the two-year backfill (intraday-history.js rows).
 *     Monthly walk-forward, purged one session: for month m, train on rows dated before the session
 *     preceding m's first session, capped at the most recent TRAIN_CAP rows; score every row in m.
 *     First TRAIN_MONTHS months are train-only. Reports OOS Spearman(forecast, R) and, for each policy,
 *     mean daily R with day-clustered t over OOS sessions, split by half-year. NEVER a verdict.
 *
 *   --forward — the registered test. Each night after R39 seals a session, the model is fit on every
 *     row dated before the previous session (history + earlier forward sessions, same cap) and scores
 *     that session's signals. Recorded per session: baseline (every signal), forecast > 0, top decile,
 *     for both learners. VERDICT per the registered bar: forecast>0 mean daily R > 0 at the best-of-2
 *     null bar over >= 30 forward sessions and >= 200 taken trades, AND above the baseline; interim
 *     kill-only at 16 (t <= -2). Sessions before 2026-08-25 are PREVIEW.
 *
 * Usage: node backend/intraday-model.js [--train-months 4] [--cap 150000]      history read
 *        node backend/intraday-model.js --forward                               score sealed forward sessions
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { gbmFit, gbmPredict, ridgeFit, ridgePredict } = require("./lib/gbm.js");
const { FEATURES, features, sessionEdges } = require("./lib/intraday-features.js");
const NB = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f);
const OUT = D("intraday-model.json");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? +process.argv[i + 1] : d; };
const TRAIN_MONTHS = arg("--train-months", 4), TRAIN_CAP = arg("--cap", 150000);
const EVIDENCE_START = "2026-08-25";
const BAR = { minSessions: 30, minTrades: 200, interimSessions: 16, interimKillT: -2.0, learners: 2 };
const FIT = { gbm: { rounds: 60, lr: 0.1, depth: 2 }, ridge: { lambda: 50 } };
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const tOf = (a) => { const k = a.length; if (k < 2) return null; const g = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - g) ** 2, 0) / (k - 1)); return sd > 0 ? +(g / (sd / Math.sqrt(k))).toFixed(3) : null; };
const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
const spearman = (a, b) => { if (a.length < 3) return null; const ra = rank(a), rb = rank(b), ma = mean(ra), mb = mean(rb); let num = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; } return da && db ? +(num / Math.sqrt(da * db)).toFixed(4) : null; };
const half = (d) => d.slice(0, 4) + (d.slice(5, 7) <= "06" ? "H1" : "H2");
const r4 = (x) => x == null ? null : +(+x).toFixed(4);

const store = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
if (!store.spec) Object.assign(store, { spec: "R41 — one model on the intraday horizon", registered: "2026-08-23", evidenceStart: EVIDENCE_START, bar: BAR, features: [...FEATURES, "variantORB"] });

/** packed row → feature vector; packed = [sym, dir, sig, r, how, ...features] */
const vec = (row, v) => [...row.slice(5).map((x) => (x == null ? NaN : x)), v === "orb30" ? 1 : 0];
function loadHistoryRows() {
  const H = JSON.parse(fs.readFileSync(D("intraday-history-family.json"), "utf8"));
  if (!H.features) { console.error("history rows carry no features — run intraday-history.js --regrade"); process.exit(1); }
  const X = [], y = [], meta = [];
  for (const d of Object.keys(H.days).sort()) for (const v of ["orb30", "vwapr"]) for (const row of H.days[d].rows[v] || []) { if (row.length !== 5 + FEATURES.length) continue; X.push(vec(row, v)); y.push(row[3]); meta.push({ day: d, v, sym: row[0] }); }
  return { X, y, meta };
}
function fitBoth(X, y, idx) { return { gbm: gbmFit(X, y, idx, FIT.gbm), ridge: ridgeFit(X, y, idx, FIT.ridge) }; }
const predict = (m, L, x) => L === "gbm" ? gbmPredict(m.gbm, x) : ridgePredict(m.ridge, x);

/* ───────────────────────────── HISTORY (exploration) ───────────────────────────── */
function runHistory() {
  const { X, y, meta } = loadHistoryRows();
  const days = [...new Set(meta.map((m) => m.day))].sort();
  const months = [...new Set(days.map((d) => d.slice(0, 7)))].sort();
  console.log(`R41 HISTORY (in-sample exploration) — ${X.length.toLocaleString()} rows over ${days.length} sessions, ${months.length} months · walk-forward purged, first ${TRAIN_MONTHS} months train-only, cap ${TRAIN_CAP.toLocaleString()}`);
  const preds = { gbm: new Array(X.length).fill(null), ridge: new Array(X.length).fill(null) };
  const t0 = Date.now();
  for (let mi = TRAIN_MONTHS; mi < months.length; mi++) {
    const m = months[mi];
    const firstDay = days.find((d) => d.startsWith(m)); const purgeBefore = days[days.indexOf(firstDay) - 1];
    let trainIdx = []; for (let i = 0; i < X.length; i++) if (meta[i].day < purgeBefore) trainIdx.push(i);
    if (trainIdx.length > TRAIN_CAP) trainIdx = trainIdx.slice(-TRAIN_CAP);
    const testIdx = []; for (let i = 0; i < X.length; i++) if (meta[i].day.startsWith(m)) testIdx.push(i);
    if (trainIdx.length < 2000 || !testIdx.length) continue;
    const M = fitBoth(X, y, trainIdx);
    for (const i of testIdx) { preds.gbm[i] = predict(M, "gbm", X[i]); preds.ridge[i] = predict(M, "ridge", X[i]); }
    console.log(`  ${m}: trained on ${trainIdx.length.toLocaleString()} rows (< ${purgeBefore}), scored ${testIdx.length.toLocaleString()} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  const oos = []; for (let i = 0; i < X.length; i++) if (preds.gbm[i] != null) oos.push(i);
  if (oos.length < 500) { console.log(`  not enough out-of-sample rows yet (${oos.length}) — needs more than ${TRAIN_MONTHS} month(s) of history on disk; nothing written`); return; }
  function policyStats(p, sel, label) {
    const byDay = {}; for (const i of oos) { (byDay[meta[i].day] ||= []); if (sel(i)) byDay[meta[i].day].push(y[i]); }
    const dailyR = Object.values(byDay).map((a) => a.length ? mean(a) : 0);
    const n = Object.values(byDay).reduce((s, a) => s + a.length, 0);
    const byHalf = {}; for (const [d, a] of Object.entries(byDay)) (byHalf[half(d)] ||= []).push(a.length ? mean(a) : 0);
    return { label, sessions: dailyR.length, trades: n, tradesPerDay: +(n / (dailyR.length || 1)).toFixed(1), meanDailyR: r4(mean(dailyR)), t: tOf(dailyR), byHalf: Object.fromEntries(Object.entries(byHalf).sort().map(([h, a]) => [h, { sessions: a.length, meanDailyR: r4(mean(a)), t: tOf(a) }])) };
  }
  const hist = { asOf: new Date().toISOString(), inSample: true, rows: X.length, oosRows: oos.length, sessions: days.length, months, trainMonths: TRAIN_MONTHS, cap: TRAIN_CAP, learners: {} };
  for (const L of ["gbm", "ridge"]) {
    const p = preds[L];
    const top = new Set(); const byDay = {}; for (const i of oos) (byDay[meta[i].day] ||= []).push(i);
    for (const idx of Object.values(byDay)) { const k = Math.max(1, Math.floor(idx.length / 10)); idx.slice().sort((a, b) => p[b] - p[a]).slice(0, k).forEach((i) => top.add(i)); }
    hist.learners[L] = {
      spearmanOOS: spearman(oos.map((i) => p[i]), oos.map((i) => y[i])),
      byVariant: Object.fromEntries(["orb30", "vwapr"].map((v) => { const ii = oos.filter((i) => meta[i].v === v); return [v, { n: ii.length, spearman: spearman(ii.map((i) => p[i]), ii.map((i) => y[i])) }]; })),
      policies: [policyStats(p, () => true, "baseline: every signal (R39 as registered)"), policyStats(p, (i) => p[i] > 0, "forecast > 0"), policyStats(p, (i) => top.has(i), "top decile per day"), policyStats(p, (i) => p[i] < 0, "forecast < 0 (what the model would skip)")],
    };
  }
  const promising = ["gbm", "ridge"].filter((L) => { const f = hist.learners[L].policies[1]; const halves = Object.values(f.byHalf); return f.meanDailyR > 0 && f.t >= 2 && (hist.months.length - TRAIN_MONTHS) >= 12 && halves.every((h) => h.meanDailyR > 0); });
  hist.read = promising.length ? `PROMISING in-sample for ${promising.join(", ")} — the registered bar is forward-only` : "NOT PROMISING — the forecast does not order this horizon's trades better than chance over the history read";
  store.history = hist;
  writeJsonAtomic(OUT, store);
  console.log(`\nOOS rows ${oos.length.toLocaleString()} over ${months.length - TRAIN_MONTHS} months`);
  for (const L of ["gbm", "ridge"]) { const o = hist.learners[L]; console.log(`\n${L.toUpperCase()} · OOS Spearman(forecast, R) ${o.spearmanOOS} · orb30 ${o.byVariant.orb30.spearman} (n ${o.byVariant.orb30.n.toLocaleString()}) · vwapr ${o.byVariant.vwapr.spearman} (n ${o.byVariant.vwapr.n.toLocaleString()})`);
    for (const s of o.policies) { console.log(`  ${s.label.padEnd(44)} trades/day ${String(s.tradesPerDay).padStart(6)} · mean daily R ${String(s.meanDailyR).padStart(8)} · t ${String(s.t).padStart(7)}`); for (const [h, v] of Object.entries(s.byHalf)) console.log(`      ${h}: ${v.sessions} sessions · mean daily R ${v.meanDailyR} · t ${v.t}`); } }
  console.log(`\n  ${hist.read}\nwritten: intraday-model.json (history)`);
}

/* ───────────────────────────── FORWARD (the registered test) ───────────────────────────── */
function runForward() {
  const fam = JSON.parse(fs.readFileSync(D("intraday-family.json"), "utf8"));
  const fwd = store.forward || { days: {}, rows: {} };
  const DIRF = D("intraday"), DIRH = D("intraday-history");
  const sealed = Object.keys(fam.days).filter((d) => fam.days[d].trades && !fwd.days[d] && fs.existsSync(path.join(DIRF, `${d}.json`))).sort();
  if (!sealed.length) console.log("R41 FORWARD — no newly sealed R39 session to score.");
  const base = loadHistoryRows();
  const t0 = Date.now();
  for (const d of sealed) {
    const J = JSON.parse(fs.readFileSync(path.join(DIRF, `${d}.json`), "utf8"));
    // previous session for gap/prior-return features: the latest forward file before d, else the latest history file
    const prevFile = [...fs.readdirSync(DIRF).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < d).map((f) => path.join(DIRF, f)), ...(fs.existsSync(DIRH) ? fs.readdirSync(DIRH).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < d).map((f) => path.join(DIRH, f)) : [])].sort((a, b) => path.basename(b).localeCompare(path.basename(a)))[0];
    const prev = prevFile ? sessionEdges(JSON.parse(fs.readFileSync(prevFile, "utf8")).symbols) : {};
    const spy = J.symbols.SPY || [];
    const packed = { orb30: [], vwapr: [] };
    for (const v of ["orb30", "vwapr"]) for (const x of fam.days[d].trades[v] || []) { if (!J.symbols[x.sym]) continue; packed[v].push([x.sym, x.dir, x.sig, x.r, x.how, ...features(x, J.symbols[x.sym], spy, prev[x.sym])]); }
    // training set: history + earlier forward sessions, all dated before the session preceding d
    const allDays = [...new Set([...base.meta.map((m) => m.day), ...Object.keys(fwd.rows)])].sort().filter((x) => x < d);
    const purgeBefore = allDays[allDays.length - 1];
    const X = [], y = [];
    for (let i = 0; i < base.X.length; i++) if (base.meta[i].day < purgeBefore) { X.push(base.X[i]); y.push(base.y[i]); }
    for (const [fd, rows] of Object.entries(fwd.rows)) if (fd < purgeBefore) for (const v of ["orb30", "vwapr"]) for (const row of rows[v] || []) { X.push(vec(row, v)); y.push(row[3]); }
    let idx = X.map((_, i) => i); if (idx.length > TRAIN_CAP) idx = idx.slice(-TRAIN_CAP);
    if (idx.length < 2000) { console.log(`  ${d}: only ${idx.length} training rows — not scored (needs the history backfill)`); continue; }
    const M = fitBoth(X, y, idx);
    const rec = { preview: d < EVIDENCE_START, trainRows: idx.length, trainBefore: purgeBefore, n: packed.orb30.length + packed.vwapr.length, learners: {} };
    for (const L of ["gbm", "ridge"]) {
      const rows = []; for (const v of ["orb30", "vwapr"]) for (const row of packed[v]) rows.push({ r: row[3], p: predict(M, L, vec(row, v)) });
      const take = rows.filter((x) => x.p > 0), k = Math.max(1, Math.floor(rows.length / 10)), top = rows.slice().sort((a, b) => b.p - a.p).slice(0, k);
      rec.learners[L] = { baselineR: r4(mean(rows.map((x) => x.r))), forecastPosN: take.length, forecastPosR: take.length ? r4(mean(take.map((x) => x.r))) : 0, topDecileR: r4(mean(top.map((x) => x.r))), spearman: spearman(rows.map((x) => x.p), rows.map((x) => x.r)) };
    }
    fwd.days[d] = { ...rec, scoredAt: new Date().toISOString() }; fwd.rows[d] = packed;
    console.log(`  ${d}${rec.preview ? " (PREVIEW)" : ""}: ${rec.n} signals · trained on ${idx.length.toLocaleString()} rows (< ${purgeBefore}) · GBM baseline ${rec.learners.gbm.baselineR} → forecast>0 ${rec.learners.gbm.forecastPosR} on ${rec.learners.gbm.forecastPosN} · ridge ${rec.learners.ridge.baselineR} → ${rec.learners.ridge.forecastPosR} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  // the registered statistic over evidence sessions
  const ev = Object.entries(fwd.days).filter(([d]) => d >= EVIDENCE_START).sort();
  const S = ev.length, stats = {};
  for (const L of ["gbm", "ridge"]) {
    const fR = ev.map(([, x]) => x.learners[L].forecastPosR), bR = ev.map(([, x]) => x.learners[L].baselineR);
    stats[L] = { sessions: S, trades: ev.reduce((s, [, x]) => s + x.learners[L].forecastPosN, 0), forecastPos: { meanDailyR: r4(mean(fR)), t: tOf(fR) }, baseline: { meanDailyR: r4(mean(bR)), t: tOf(bR) }, beatsBaseline: S ? mean(fR) > mean(bR) : null };
  }
  const bar = S >= 5 ? NB.nullBar({ variants: BAR.learners, n: S, trials: 2000 }) : null;
  let verdict;
  if (S < BAR.interimSessions) verdict = `ACCRUING — ${S}/${BAR.minSessions} forward sessions`;
  else if (S < BAR.minSessions) verdict = ["gbm", "ridge"].filter((L) => stats[L].forecastPos.t != null && stats[L].forecastPos.t <= BAR.interimKillT).map((L) => `${L} KILLED at interim`).join(", ") || `ACCRUING — interim at ${S}: none dead`;
  else { const clear = ["gbm", "ridge"].filter((L) => stats[L].forecastPos.meanDailyR > 0 && stats[L].forecastPos.t >= bar.p95 && stats[L].trades >= BAR.minTrades && stats[L].beatsBaseline); verdict = clear.length ? `CLEARED (best-of-2 bar ${bar.p95}): ${clear.join(", ")} — proposal for an intraday paper sleeve that trades the forecast` : `DID NOT PASS — no learner clears the best-of-2 bar ${bar.p95} while beating the baseline`; }
  Object.assign(fwd, { asOf: new Date().toISOString(), evidenceSessions: S, stats, nullBar: bar, verdict });
  store.forward = fwd;
  writeJsonAtomic(OUT, store);
  console.log(`R41 FORWARD — evidence from ${EVIDENCE_START} · ${S} evidence session(s) · ${verdict}`);
  for (const L of ["gbm", "ridge"]) if (S) console.log(`  ${L}: forecast>0 mean daily R ${stats[L].forecastPos.meanDailyR} (t ${stats[L].forecastPos.t}, ${stats[L].trades} trades) vs baseline ${stats[L].baseline.meanDailyR} — ${stats[L].beatsBaseline ? "beats" : "does not beat"} the baseline`);
  console.log("written: intraday-model.json (forward)");
}

if (process.argv.includes("--forward")) runForward(); else runHistory();
