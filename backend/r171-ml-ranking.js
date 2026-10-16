#!/usr/bin/env node
/**
 * R171 — do the CLEAN bake-off models rank the board's signals? Registered 2026-09-24 (operator: "2"), before any clean stamp exists.
 *
 * The four nightly bake-off learners (ridge, gbm, ridgeTicket, gbmTicket — backend/model-bakeoff.js) score every ticket at entry
 * (src/App.jsx: obs.bakeoffRidge / bakeoffGbm / bakeoffRidgeT / bakeoffGbmT + t.bakeoffVersion). Until 2026-09-24 they trained on
 * post-entry news fields (audit A0923-030); from the 2026-09-24 refit the board guard (lib/feature-manifest.js BOARD_GUARD_VERSION)
 * removes them. Only stamps from a version recorded clean in data/r171-clean-versions.json count.
 *
 *   node backend/r171-ml-ranking.js            → nightly status (writes data/r171-ml-ranking.json; reads nothing sealed)
 *   node backend/r171-ml-ranking.js --preview  → the same machinery on the PRE-evidence (contaminated) stamps; weightless, writes nothing
 *   node backend/r171-ml-ranking.js --read     → the one registered read; refuses before the read condition or if already sealed
 *
 * Statistic (per model): for each entry session, the clean-era SIGNAL tickets carrying a clean stamp of that model (>= 4), sorted by the
 * score; top half minus bottom half mean rMult (odd middle ticket dropped). One number per session; plain t over sessions (tickets
 * settle by the next open, so sessions do not overlap). Controls: a within-session score shuffle (leak test: must read |t| < 2) and
 * a peek ranker that sorts by the realized rMult (positive control: must clear the bar). Nothing here trades or adopts.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const rc = require("./lib/reconcile.js"), S = require("./lib/session.js");
const D = (f) => path.join(__dirname, "data", f);
const PREVIEW = process.argv.includes("--preview"), READ = process.argv.includes("--read");
const EVIDENCE_START = "2026-09-25", MIN_PER_SESSION = 4, READ_SESSIONS = 30;
// CLEAN VERSIONS: the version label is keyed to the training data's last session, not the run date, so cleanliness is read from the
// model file itself — a version counts only if model-bakeoff.json carried featureGuard (the board guard) and every named input passes
// assertBoardObsAdmissible when it was seen. Each nightly run appends the current version to data/r171-clean-versions.json.
const CV_FILE = D("r171-clean-versions.json");
const cleanVersions = (() => {
  let cv = { versions: {} }; try { cv = JSON.parse(fs.readFileSync(CV_FILE, "utf8")); } catch {}
  try {
    const m = JSON.parse(fs.readFileSync(D("model-bakeoff.json"), "utf8")), FM = require("./lib/feature-manifest.js");
    const names = [...(m.features || []), ...(m.featuresTicketNames || [])].filter((k) => !/^(dir|isCtrl|cls:)/.test(k));
    let admissible = true; try { FM.assertBoardObsAdmissible(names); } catch { admissible = false; }
    if (m.featureGuard && admissible && m.version && !cv.versions[m.version]) cv.versions[m.version] = { firstSeen: new Date().toISOString(), featureGuard: m.featureGuard, trainedAt: m.trainedAt };
  } catch {}
  return cv;
})();
const MODELS = [["ridge", "bakeoffRidge"], ["gbm", "bakeoffGbm"], ["ridgeTicket", "bakeoffRidgeT"], ["gbmTicket", "bakeoffGbmT"]];

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const tOf = (a) => { if (a.length < 3) return null; const m = mean(a), v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); return v > 0 ? m / Math.sqrt(v / a.length) : null; };
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const L = rc.cleanEraLedger();
const inScope = (r) => {
  const d = S.openSession(r);
  if (!Number.isFinite(r.rMult) || !r.obs) return false;
  if (PREVIEW) return d < EVIDENCE_START;                               // pre-evidence stamps, contaminated models: machinery check only
  return d >= EVIDENCE_START && !!cleanVersions.versions[(r.obs && r.obs.bakeoffVersion) || r.bakeoffVersion]; // clean model version AND opened on/after evidence start
};
const rows = L.signals.filter(inScope);

// TIE-BREAK (2026-09-24, found on R176): ledger rows are in SETTLE order — stopped-out losers settle first — so tied scores must never
// fall back to row order (that leaks the outcome). Every sort breaks ties by a stable hash of the ticket id instead.
const tieKey = (r) => { let h = 2166136261; const s = String(r.id || r.sym + r.openedAt); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
function gapSeries(scoreOf) {
  const bySess = {};
  for (const r of rows) { const s = scoreOf(r); if (!Number.isFinite(s)) continue; (bySess[S.openSession(r)] = bySess[S.openSession(r)] || []).push({ s, R: r.rMult, k: tieKey(r) }); }
  const out = [];
  for (const d of Object.keys(bySess).sort()) {
    const a = bySess[d]; if (a.length < MIN_PER_SESSION) continue;
    a.sort((x, y) => y.s - x.s || x.k - y.k); const h = Math.floor(a.length / 2);
    out.push({ session: d, n: a.length, gap: mean(a.slice(0, h).map((x) => x.R)) - mean(a.slice(a.length - h).map((x) => x.R)) });
  }
  return out;
}
const summarise = (ser) => ({ sessions: ser.length, tickets: ser.reduce((s, x) => s + x.n, 0), meanGapR: ser.length ? +mean(ser.map((x) => x.gap)).toFixed(4) : null, t: ser.length >= 3 ? +tOf(ser.map((x) => x.gap)).toFixed(3) : null });

const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const entry = [...(reg.tests || []), ...(reg.preregistered || [])].find((t) => t.id === "R171");
const BAR = entry ? entry.bar.tRequired : null;

const models = MODELS.map(([name, key]) => ({ model: name, ...summarise(gapSeries((r) => r.obs[key])) }));
// leak test: shuffle each model's scores within session (seeded); must read |t| < 2
const rng = mulberry(171);
const shuffled = MODELS.map(([name, key]) => {
  const bySess = {}; rows.forEach((r) => { if (Number.isFinite(r.obs[key])) (bySess[S.openSession(r)] = bySess[S.openSession(r)] || []).push(r.obs[key]); });
  for (const d in bySess) { const a = bySess[d]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } }
  const idx = {}; const perm = (r) => { const d = S.openSession(r); idx[d] = idx[d] || 0; return bySess[d] ? bySess[d][idx[d]++] : NaN; };
  return { model: name, ...summarise(gapSeries((r) => (Number.isFinite(r.obs[key]) ? perm(r) : NaN))) };
});
const peek = summarise(gapSeries((r) => r.rMult));
const sessionsMin = Math.min(...models.map((m) => m.sessions));
const leakPass = shuffled.every((m) => m.t == null || Math.abs(m.t) < 2), peekPass = BAR == null || (peek.t != null && peek.t >= BAR);
const best = models.filter((m) => m.t != null).sort((a, b) => b.t - a.t)[0] || null;
const coverage = (() => { const all = L.signals.filter((r) => (PREVIEW ? S.openSession(r) < EVIDENCE_START : S.openSession(r) >= EVIDENCE_START)); return { signalTickets: all.length, inScope: rows.length, stamped: rows.filter((r) => MODELS.some(([, k]) => Number.isFinite(r.obs[k]))).length }; })();

let verdict;
if (sessionsMin < READ_SESSIONS) verdict = `ACCRUING — ${sessionsMin}/${READ_SESSIONS} sessions on the thinnest model` + (best ? ` (best so far ${best.model} ${best.meanGapR}R, t ${best.t}; weightless)` : "");
else if (!leakPass || !peekPass) verdict = `CONTROLS FAILED — leak ${leakPass ? "ok" : "FAIL"}, peek ${peekPass ? "ok" : "FAIL"}; no read`;
else verdict = best && best.t >= BAR && best.meanGapR > 0 ? `PASS — ${best.model} top-minus-bottom ${best.meanGapR}R/session, t ${best.t} >= best-of-4 bar ${BAR}` : `DID NOT PASS — best ${best ? best.model + " t " + best.t : "n/a"} vs best-of-4 bar ${BAR}`;
// interim kill at 15 sessions: every model t <= -2
if (!PREVIEW && sessionsMin >= 15 && sessionsMin < READ_SESSIONS && models.every((m) => m.t != null && m.t <= -2)) verdict = `KILLED (interim) — all four models t <= -2 at ${sessionsMin} sessions`;

const out = { spec: "r171-ml-ranking-v1", test: "R171", asOf: new Date().toISOString(), mode: PREVIEW ? "preview (pre-evidence, contaminated stamps, weightless)" : "evidence", evidenceStart: EVIDENCE_START, cleanVersions: Object.keys(cleanVersions.versions), bar: BAR, coverage, models, controls: { leakShuffle: shuffled, leakPass, peek, peekPass }, verdict };
console.log(JSON.stringify(out, null, 1));
if (PREVIEW) process.exit(0);
if (READ) {
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if (seals.tests.R171) { console.error("R171 already sealed — refusing"); process.exit(2); }
  if (sessionsMin < READ_SESSIONS) { console.error(`R171 read condition not met (${sessionsMin}/${READ_SESSIONS} sessions)`); process.exit(2); }
  seals.tests.R171 = { sealedOn: S.todaySession(), unit: "sessions", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R171", verdict }) + "\n");
}
writeJsonAtomic(CV_FILE, cleanVersions);
writeJsonAtomic(D("r171-ml-ranking.json"), out);
