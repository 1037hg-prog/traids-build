"use strict";
/**
 * STRATEGY RETURN LIBRARY — entry writer (ensemble-architect, 2026-09-24).
 *
 * Every emitter in backend/ensemble/emit/ ends by calling writeEntry() or writeUnavailable(). This file is the ONLY writer of
 * backend/data/strategy-library/<ID>.json. It reads the registry and the seals READ-ONLY (for the verdict text) and never writes them.
 *
 * SERIES CONVENTION (the contract every emitter follows)
 *   series   [{ d: "YYYY-MM-DD", r: <decimal net return of the strategy's capital that day> }], ascending, unique dates.
 *            Only days with capital at risk or a cost charged are listed. Any date inside `window` that is absent = 0 (cash at 0%).
 *   window   [first, last] — the span over which the strategy was live in its own sealed test (zeros are meaningful only inside it).
 *   calendar "us-equity" (US sessions) | "crypto-24x7" (every calendar day, UTC-dated daily bars).
 *            | "monthly" (added 2026-09-25 for book-level streams whose source persists only monthly rows: d = the month's LAST CALENDAR
 *            day, r = that month's net return; used only in monthly correlation / book simulations, never in daily matrices).
 *   Multi-day holds are marked to market daily (close-to-close), entry cost on the entry day, exit cost on the exit day.
 *   An intraday event (or one that spans two sessions without a daily mark in the script) is booked on its EXIT date.
 *   Several concurrent positions = equal weight across open positions that day, unless the sealed script defines the portfolio.
 *   reproduction  the sealed script's own headline statistic recomputed from the SAME trade/event list the series is built from:
 *                 { statistic, sealed, emitted, tolerance, match }. match=false is written honestly; the combination selection rule
 *                 requires match=true.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const ROOT = path.join(__dirname, "..", "..");                         // repo root
const LIB = path.join(__dirname, "..", "data", "strategy-library");
if (!fs.existsSync(LIB)) fs.mkdirSync(LIB, { recursive: true });

const sha256 = (rel) => { const f = path.join(ROOT, rel); return fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null; };
function registryEntry(registryId) {
  const reg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "test-registry.json"), "utf8"));
  return (reg.preregistered || []).find((t) => t.id === registryId) || (reg.tests || []).find((t) => t.id === registryId) || null;
}
function sealOf(registryId) {
  const s = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "read-seals.json"), "utf8"));
  return (s.tests || {})[registryId] || null;
}
function checkSeries(series, calendar) {
  if (!Array.isArray(series) || !series.length) throw new Error("series empty");
  let prev = "";
  for (const x of series) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.d)) throw new Error(`bad date ${x.d}`);
    if (!(x.d > prev)) throw new Error(`series not strictly ascending at ${x.d}`);
    if (!Number.isFinite(x.r)) throw new Error(`non-finite r on ${x.d}`);
    if (x.r <= -1) throw new Error(`r <= -100% on ${x.d}`);
    if (calendar === "monthly") { const [y, m] = x.d.split("-").map(Number); const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); if (x.d !== last) throw new Error(`monthly series date ${x.d} is not its month's last calendar day`); }
    if (calendar === "us-equity") { const wd = new Date(x.d + "T12:00:00Z").getUTCDay(); if (wd === 0 || wd === 6) throw new Error(`weekend date ${x.d} on a us-equity calendar`); }
    prev = x.d;
  }
}
function quickStats(series, window) {
  const r = series.map((x) => x.r), n = r.length, m = r.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1));
  return { activeDays: n, first: series[0].d, last: series[n - 1].d, window, meanActiveDayPct: +(100 * m).toFixed(4), sdActiveDayPct: +(100 * sd).toFixed(4), sumPct: +(100 * r.reduce((a, b) => a + b, 0)).toFixed(2) };
}

/**
 * e = { id, name, registryId, script (repo-relative), emitter (repo-relative), unit ("daily"|"per-event"), net (bool), costModel (text),
 *       window [a,b], calendar, series, reproduction {statistic, sealed, emitted, tolerance, match}, construction (text: how the
 *       daily series was built from the trades/events), notes? }
 */
function writeEntry(e) {
  for (const k of ["id", "name", "registryId", "script", "emitter", "unit", "costModel", "window", "calendar", "series", "reproduction", "construction"]) if (e[k] == null) throw new Error(`${e.id || "?"}: missing ${k}`);
  if (!["us-equity", "crypto-24x7", "monthly"].includes(e.calendar)) throw new Error(`${e.id}: calendar must be us-equity|crypto-24x7|monthly`);
  checkSeries(e.series, e.calendar);
  if (e.series[0].d < e.window[0] || e.series[e.series.length - 1].d > e.window[1]) throw new Error(`${e.id}: series outside window ${e.window}`);
  const reg = registryEntry(e.registryId), seal = sealOf(e.registryId);
  const out = {
    spec: "strategy-library-entry-v1", status: "ok", id: e.id, name: e.name,
    source: { registryId: e.registryId, script: e.script, sha256: sha256(e.script), emitter: e.emitter, emitterSha256: sha256(e.emitter), registryName: reg ? reg.name : null },
    unit: e.unit, net: e.net !== false, costModel: e.costModel, window: e.window, calendar: e.calendar,
    verdict: seal ? seal.verdict : reg ? reg.status : null, sealedOn: seal ? seal.sealedOn : null,
    construction: e.construction, reproduction: e.reproduction, notes: e.notes || null,
    stats: quickStats(e.series, e.window), generatedAt: new Date().toISOString(), series: e.series.map((x) => ({ d: x.d, r: +x.r.toFixed(8) })),
  };
  writeJsonAtomic(path.join(LIB, `${e.id}.json`), out, { pretty: 0 });
  console.log(`  library ${e.id}: ${out.stats.activeDays} active days ${out.stats.first}..${out.stats.last} · reproduction ${e.reproduction.match ? "MATCH" : "NO MATCH"} (${e.reproduction.statistic}: sealed ${e.reproduction.sealed} emitted ${e.reproduction.emitted})`);
  return out;
}
function writeUnavailable({ id, name, registryId, script, emitter = null, reason }) {
  const reg = registryEntry(registryId), seal = sealOf(registryId);
  const out = { spec: "strategy-library-entry-v1", status: "unavailable", id, name, source: { registryId, script, sha256: script ? sha256(script) : null, emitter, emitterSha256: emitter ? sha256(emitter) : null, registryName: reg ? reg.name : null },
    verdict: seal ? seal.verdict : reg ? reg.status : null, reason, generatedAt: new Date().toISOString() };
  writeJsonAtomic(path.join(LIB, `${id}.json`), out, { pretty: 1 });
  console.log(`  library ${id}: UNAVAILABLE — ${reason}`);
  return out;
}
module.exports = { writeEntry, writeUnavailable, sha256, registryEntry, sealOf, LIB, ROOT };
