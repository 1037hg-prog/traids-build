"use strict";
/**
 * OPTIONS-PREMIUM LANE — shared read-only helpers for backend/profit-program/options-*.js and r25-*.js.
 * Writes nothing by itself. The only ledger source is lib/reconcile.js cleanEraLedger(); assertReconciled() runs first.
 */
const fs = require("fs"), path = require("path");
const RC = require("../lib/reconcile.js");
const { writeJsonAtomic } = require("../lib/atomic-write.js");

const DATA = path.join(__dirname, "..", "data");
const OUT_DIR = path.join(DATA, "profit-program");
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const mtDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
const etHM = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms)).replace(/^24/, "00");
const etDow = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date(ms));
const sum = (a) => a.reduce((s, v) => s + v, 0);
const mean = (a) => (a.length ? sum(a) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
/** t of the mean of a list of independent observations (call it on ONE VALUE PER SESSION to get a session-clustered t) */
const tOf = (a) => { const s = sd(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : NaN; };
const $ = (v) => (Number.isFinite(v) ? (v < 0 ? "-$" : "+$") + Math.abs(Math.round(v)).toLocaleString("en-US") : "n/a");
const u$ = (v) => (Number.isFinite(v) ? "$" + Math.abs(Math.round(v)).toLocaleString("en-US") : "n/a");
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");

/** the canonical ledger, reconciled before use */
function ledger() {
  const L = RC.cleanEraLedger();
  RC.assertReconciled("signals+controls vs settled", L.signals.length + L.controls.length, L.settled, { log: false });
  RC.assertReconciled("pooled edge re-derived", RC.recomputeEdge(L), L.pooledEdgeR, { log: false });
  return L;
}
const isR25 = (t) => t.cls === "Options" && t.strategy === "R25-0dte";
const isR21 = (t) => t.cls === "Options" && t.strategy === "R21-premium";
/** the dashboard's table rule: entered inside 09:25-16:00 ET */
const inHours = (t) => { const hm = etHM(t.openedAt || t.addedAt); return hm >= "09:25" && hm < "16:00"; };

/** win/loss anatomy of a list of tickets with a $ field. win = pnl > 0 (the dashboard rule on rMult>0 is identical for these rows) */
function anatomy(T, pnlOf = (t) => t.pnl) {
  const p = T.map(pnlOf), W = p.filter((x) => x > 0), Lo = p.filter((x) => !(x > 0));
  const gw = sum(W), gl = sum(Lo), aw = W.length ? gw / W.length : 0, al = Lo.length ? gl / Lo.length : 0;
  return { n: T.length, wins: W.length, losses: Lo.length, winPct: T.length ? 100 * W.length / T.length : NaN, gains: gw, lossesSum: gl, net: gw + gl, avgWin: aw, avgLoss: al,
    lossToWin: aw > 0 ? Math.abs(al) / aw : NaN, breakEvenWinPct: aw + Math.abs(al) > 0 ? 100 * Math.abs(al) / (aw + Math.abs(al)) : NaN, worst: p.length ? Math.min(...p) : NaN };
}
/** group tickets by a key, return per-session sums and the session-clustered t of the DAILY SUM and of the DAILY MEAN per ticket */
function bySession(T, pnlOf, keyOf = (t) => etDay(t.openedAt)) {
  const m = new Map();
  for (const t of T) { const k = keyOf(t); (m.get(k) || m.set(k, []).get(k)).push(pnlOf(t)); }
  const days = [...m.keys()].sort();
  const sums = days.map((d) => sum(m.get(d)));
  return { days, sums, counts: days.map((d) => m.get(d).length), n: days.length, meanPerSession: mean(sums), t: tOf(sums), worstDay: sums.length ? Math.min(...sums) : NaN, bestDay: sums.length ? Math.max(...sums) : NaN,
    posDays: sums.filter((x) => x > 0).length };
}

/** difference of means (cell minus rest) with a cluster-robust t (one-dummy OLS, CR1 small-cluster factor); rows = array, inCell/y/cluster = functions */
function clusterDiff(rows, inCell, y, cluster) {
  const d = rows.map((r) => (inCell(r) ? 1 : 0)), dbar = mean(d), yv = rows.map(y);
  const sxx = sum(d.map((x) => (x - dbar) ** 2)); if (!(sxx > 0)) return { diff: NaN, t: NaN };
  const b = sum(d.map((x, i) => (x - dbar) * yv[i])) / sxx, a = mean(yv) - b * dbar;
  const g = new Map(); rows.forEach((r, i) => { const k = cluster(r); g.set(k, (g.get(k) || 0) + (d[i] - dbar) * (yv[i] - a - b * d[i])); });
  const G = g.size, meat = sum([...g.values()].map((x) => x * x)) * (G / (G - 1)), se = Math.sqrt(meat) / sxx;
  return { diff: b, t: se > 0 ? b / se : NaN, clusters: G };
}
function writeOut(name, obj) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  writeJsonAtomic(file, obj);
  return file;
}
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);

module.exports = { clusterDiff, DATA, OUT_DIR, RC, etDay, mtDay, etHM, etDow, sum, mean, sd, tOf, $, u$, f, ledger, isR25, isR21, inHours, anatomy, bySession, writeOut, arg, flag };
