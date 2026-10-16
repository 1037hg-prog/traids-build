#!/usr/bin/env node
/**
 * R177 leg (a) — Trend-only replay ranker on the 2021-2023 HOLDOUT. Registered 2026-09-24 (backend/data/test-registry.json, R177)
 * BEFORE the holdout replay was built (backend/board-replay-holdout.js).
 *
 * FROZEN SCORER. data/replay-ranker.json (replay-ranker-v1-2026-09-22, ridge) through lib/replay-ranker.js. Its sha256 must equal the
 * registry's artifact.sha256 or this script refuses. Nothing is refit.
 *
 * POPULATION. Replay EQUITY signal tickets with strategy Trend, cap-kept (the board's shown set — the same population the ranker was
 * fit on), settled, 2021-01-04..2023-12-29. R is GROSS (no costs modelled).
 *
 * STATISTIC (as registered). Per session with >= 4 Trend tickets: sort by the ridge score, top half minus bottom half mean R (odd
 * middle dropped). TIES ARE BROKEN BY A SEEDED RANDOM KEY, never by row order (row order carried outcome information in another
 * study today). t over sessions (plain; tickets settle by the next open, so sessions do not overlap).
 * Secondary (must also be > 0 to pass): the same gap WITHIN direction — longs ranked among longs, shorts among shorts; a direction
 * group needs >= 4 tickets; the session value is the mean of its qualifying direction gaps.
 * Controls: within-session LABEL shuffle through the same pipeline (|t| < 2); peek = rank by realised R (must clear the bar).
 * Reported beside: pitLiquid subset (liquid at the time), year split 2021/2022/2023.
 *
 *   node backend/r177-trend-holdout.js          → compute + print, writes data/r177-trend-holdout.json (no seal)
 *   node backend/r177-trend-holdout.js --read   → the one registered read: seals R177a if the controls pass
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic, writeTextAtomic } = require("./lib/atomic-write.js");
const RR = require("./lib/replay-ranker.js");
const D = (f) => path.join(__dirname, "data", f);
const READ = process.argv.includes("--read"), MIN_PER_SESSION = 4, SEED = 177, YEARS = ["2021", "2022", "2023"];

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const tOf = (a) => { if (a.length < 3) return null; const m = mean(a), v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); return v > 0 ? m / Math.sqrt(v / a.length) : null; };
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ── registry + frozen artifact ──
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const ENTRY = [...(reg.tests || []), ...(reg.preregistered || [])].find((t) => t.id === "R177");
if (!ENTRY) throw new Error("R177 not in the registry");
const BAR = ENTRY.bar.a.tRequired;
const artPath = path.join(__dirname, "..", ENTRY.artifact.file), sha = crypto.createHash("sha256").update(fs.readFileSync(artPath)).digest("hex");
if (sha !== ENTRY.artifact.sha256) { console.error(`R177: artifact sha256 ${sha} != registered ${ENTRY.artifact.sha256} — the frozen scorer changed; refusing.`); process.exit(2); }
const info = RR.info();
if (!info || info.version !== ENTRY.artifact.version) { console.error(`R177: artifact version ${info && info.version} != registered ${ENTRY.artifact.version}; refusing.`); process.exit(2); }

// ── read condition: the holdout replay exists, was built after registration, with the same scan as the fitted replay ──
const hm = JSON.parse(fs.readFileSync(D("board-replay/replay-meta-holdout-2021-2023.json"), "utf8"));
const fm = JSON.parse(fs.readFileSync(D("board-replay/replay-meta.json"), "utf8"));
const sanity = { holdoutBuiltAt: hm.builtAt, registered: ENTRY.registered, builtAfterRegistration: hm.builtAt.slice(0, 10) >= ENTRY.registered, sameScanHash: hm.scanSourceHash === fm.scanSourceHash, scanHash: hm.scanSourceHash,
  sessionsScanned: hm.sessionsScanned, gaps: { noOpenWindow: hm.gaps.noOpenWindow.length, thinOpenWindow: hm.gaps.thinOpenWindow.length, keptWithoutFullDay: hm.gaps.keptWithoutFullDay, nextOpenFromDaily: hm.gaps.nextOpenFromDaily } };
if (!sanity.builtAfterRegistration || !sanity.sameScanHash || hm.sessionsScanned < 700) { console.error("R177: read condition not met " + JSON.stringify(sanity)); process.exit(2); }

// ── population + frozen scores ──
const rows = [];
for (const y of YEARS) for (const line of fs.readFileSync(D(`board-replay/replay-${y}.jsonl`), "utf8").split("\n")) {
  if (!line) continue; const t = JSON.parse(line);
  if (t.capKept && t.st === "Trend" && Number.isFinite(t.r)) rows.push(t);
}
const rng = mulberry(SEED);
for (const t of rows) {
  t._s = RR.score(t.obs, { dir: t.dir, strategy: t.st, conf: t.conf, score: t.score, nBull: t.nBull, nBear: t.nBear, total: t.total, stopPct: t.stopPct }, { model: ENTRY.artifact.model });
  t._k = rng();                                                       // seeded tie-break key, assigned before any sort
}
const scored = rows.filter((t) => Number.isFinite(t._s));

function gapOf(a, scoreKey, rKey) {   // a: tickets of one group; sort by score desc, ties by the seeded key
  const s = a.slice().sort((x, y) => (y[scoreKey] - x[scoreKey]) || (x._k - y._k)), h = Math.floor(s.length / 2);
  return mean(s.slice(0, h).map((x) => x[rKey])) - mean(s.slice(s.length - h).map((x) => x[rKey]));
}
function series(pop, { scoreKey = "_s", rKey = "r", withinDir = false } = {}) {
  const by = new Map(); for (const t of pop) (by.get(t.d) || by.set(t.d, []).get(t.d)).push(t);
  const out = [];
  for (const d of [...by.keys()].sort()) {
    const a = by.get(d);
    if (!withinDir) { if (a.length >= MIN_PER_SESSION) out.push({ d, n: a.length, gap: gapOf(a, scoreKey, rKey) }); continue; }
    const g = [], n = []; for (const dir of [1, -1]) { const b = a.filter((t) => t.dir === dir); if (b.length >= MIN_PER_SESSION) { g.push(gapOf(b, scoreKey, rKey)); n.push(b.length); } }
    if (g.length) out.push({ d, n: n.reduce((s, x) => s + x, 0), gap: mean(g) });
  }
  return out;
}
const summ = (ser) => { const g = ser.map((x) => x.gap), t = tOf(g); return { sessions: ser.length, tickets: ser.reduce((s, x) => s + x.n, 0), meanGapR: ser.length ? +mean(g).toFixed(4) : null, t: t == null ? null : +t.toFixed(3) }; };
const block = (pop) => ({ primary: summ(series(pop)), withinDirection: summ(series(pop, { withinDir: true })), byYear: Object.fromEntries(YEARS.map((y) => [y, summ(series(pop.filter((t) => t.d.startsWith(y))))])) });

const full = block(scored), pit = block(scored.filter((t) => t.pitLiquid === true));
// leak control: permute the realised R labels within each session (seeded), keep the scores, same pipeline
const shufR = (() => { const r2 = mulberry(SEED + 1), by = new Map(); for (const t of scored) (by.get(t.d) || by.set(t.d, []).get(t.d)).push(t);
  for (const a of by.values()) { const v = a.map((t) => t.r); for (let i = v.length - 1; i > 0; i--) { const j = Math.floor(r2() * (i + 1)); [v[i], v[j]] = [v[j], v[i]]; } a.forEach((t, i) => (t._rs = v[i])); } return summ(series(scored, { rKey: "_rs" })); })();
for (const t of scored) t._peek = t.r;
const peek = summ(series(scored, { scoreKey: "_peek" }));
const leakPass = shufR.t == null || Math.abs(shufR.t) < 2, peekPass = peek.t != null && peek.t >= BAR;
const P = full.primary, W = full.withinDirection;
const verdict = !leakPass || !peekPass ? `CONTROLS FAILED — label shuffle t ${shufR.t}, peek t ${peek.t}; no read`
  : P.t != null && P.t >= BAR && P.meanGapR > 0 && W.meanGapR > 0 ? `PASS — Trend top-minus-bottom ${P.meanGapR}R/session, t ${P.t} >= ${BAR} over ${P.sessions} sessions; within-direction ${W.meanGapR}R (t ${W.t}) > 0`
  : `DID NOT PASS — Trend top-minus-bottom ${P.meanGapR}R/session, t ${P.t} vs bar ${BAR} over ${P.sessions} sessions; within-direction ${W.meanGapR}R (t ${W.t}); pitLiquid t ${pit.primary.t}`;

const out = { spec: "r177-trend-holdout-v1", test: "R177", leg: "a", ranAt: new Date().toISOString(), mode: READ ? "registered read" : "status (not sealed)",
  artifact: { file: ENTRY.artifact.file, version: info.version, model: ENTRY.artifact.model, sha256: sha, shaMatchesRegistry: true }, bar: BAR, sanity,
  population: { trendCapKeptSettled: rows.length, scored: scored.length, unscored: rows.length - scored.length, note: "cap-kept Trend EQUITY replay tickets 2021-01-04..2023-12-29, gross R" },
  full, pitLiquid: pit, controls: { labelShuffle: shufR, leakPass, peek, peekPass }, tieBreak: `seeded random key (mulberry ${SEED}), never row order`, verdict };
writeJsonAtomic(D("r177-trend-holdout.json"), out);
console.log(JSON.stringify({ population: out.population, full, pitLiquid: pit, controls: out.controls, sanity, verdict }, null, 1));
if (!READ) process.exit(0);

const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
if (seals.tests.R177a) { console.error("R177a already sealed — refusing"); process.exit(2); }
if (!leakPass || !peekPass) { console.error("R177a: controls failed — NOT sealed"); process.exit(3); }
const today = new Date().toISOString().slice(0, 10);
seals.tests.R177a = { sealedOn: today, unit: "sessions", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
ENTRY.status = `READ (a) ${today} — ${verdict} · (b) forward stamping from 2026-09-25, read at 30 sessions`;
ENTRY.readA = { sealedOn: today, verdict, t: P.t, meanGapR: P.meanGapR, sessions: P.sessions, withinDirection: W, pitLiquid: pit.primary, byYear: full.byYear, controls: out.controls, evidence: "backend/data/r177-trend-holdout.json" };
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const LG = D("agent-ledger.jsonl");
const prior = fs.readFileSync(LG, "utf8");
const NL = String.fromCharCode(10);
writeTextAtomic(LG, prior + (prior && !prior.endsWith(NL) ? NL : "") + JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R177a", verdict }) + "\n");
console.log("R177a sealed: " + verdict);
