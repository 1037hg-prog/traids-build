"use strict";
/**
 * REPLAY RANKER — scorer (2026-09-24, operator items 2+3). Trained by backend/replay-ranker-fit.js on the board-replay dataset
 * (backend/board-replay.js) to rank one session's equity signal tickets against each other: target = the ticket's R minus its
 * session's mean R, so the day's market move — which no ticket-level model can know — is taken out of the label.
 *
 *   const RR = require("./lib/replay-ranker.js");
 *   RR.score(obs, meta)  -> number   higher = expected to beat its session-mates; NaN if the model file is missing or unusable.
 *     obs  = the ticket's obs object at entry (regimeAlign, momPctile, revRet5, ... as the board stamps them)
 *     meta = { dir, strategy, conf, score, nBull, nBear, total, stopPct }   stopPct = 100 * scan-time stop distance / entry
 *   RR.vectorOf(obs, meta, features) -> number[]   the one vector builder, shared with the fitter so training and serving agree.
 *
 * NEVER THROWS. A scorer inside the board path must fail to NaN, never to an exception and never to a fabricated number.
 * WEIGHTLESS until a registered read says otherwise: nothing may size, gate or order a ticket on this score.
 */
const fs = require("fs"), path = require("path");
const MODEL = path.join(__dirname, "..", "data", "replay-ranker.json");
const STRATS = ["Trend", "Ensemble", "Mean-Reversion", "Breakout"];
// signed (direction-aware) versions: a long and a short on the same reading are opposite bets
const CENTER = { momPctile: 0.5, stochK: 50 };

function feat(name, obs, meta) {
  const o = obs || {}, m = meta || {}, dir = m.dir > 0 ? 1 : m.dir < 0 ? -1 : NaN;
  const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  if (name === "dir") return dir;
  if (name.startsWith("st:")) return m.strategy ? (m.strategy === name.slice(3) ? 1 : 0) : NaN;
  if (name.startsWith("m:")) return num(m[name.slice(2)]);
  if (name.startsWith("dx:")) { const k = name.slice(3), v = num(o[k]); return Number.isFinite(v) && Number.isFinite(dir) ? dir * (v - (CENTER[k] || 0)) : NaN; }
  if (name.startsWith("o:")) return num(o[name.slice(2)]);
  return NaN;
}
function vectorOf(obs, meta, features) { return features.map((f) => { const v = feat(f, obs, meta); return Number.isFinite(v) ? v : NaN; }); }

let _cache = { mtime: 0, m: null };
function load() {
  try {
    const st = fs.statSync(MODEL);
    if (st.mtimeMs !== _cache.mtime) _cache = { mtime: st.mtimeMs, m: JSON.parse(fs.readFileSync(MODEL, "utf8")) };
    return _cache.m;
  } catch { return null; }
}

function score(obs, meta, opts = {}) {
  try {
    const M = load(); if (!M || !Array.isArray(M.features) || !M.models) return NaN;
    const which = opts.model || M.primary, mdl = M.models[which]; if (!mdl) return NaN;
    if (!meta || !(meta.dir === 1 || meta.dir === -1) || !STRATS.includes(meta.strategy) || !obs) return NaN;   // no direction or strategy → no ranking, never a default
    const LRN = require("./gbm.js"), x = vectorOf(obs, meta, M.features);
    const s = which === "ridge" ? LRN.ridgePredict(mdl, x) : LRN.gbmPredict(mdl, x);
    return Number.isFinite(s) ? s : NaN;
  } catch { return NaN; }
}

function info() { const M = load(); return M ? { version: M.version, guardVersion: M.guardVersion, primary: M.primary, features: M.features, trainedThrough: M.trainedThrough } : null; }

module.exports = { score, vectorOf, info, STRATS, MODEL };
