#!/usr/bin/env node
"use strict";
/**
 * HOLDOUT FOR THE LIVE SLICES — the same entry-time slices as options-full-loss-anatomy.js, run on the R116 archive (3,868 R25-rule wings
 * over 501 sessions, 2024-08-19..2026-08-18, entirely before the live sleeve existed). EXPLORATORY: the archive's crossing is borrowed
 * from R25's live record, so absolute levels are approximate; the question is only whether a slice that looks different in the 35 live
 * sessions looks different in 501 other sessions. y = net $ per contract-wing. Cluster = session. Multiplicity: best-of-(2 x cells) bar.
 * Slices that need a field the archive lacks are marked: no IV (distance is |spot - short strike| / spot, not expected-move units).
 *   node backend/profit-program/options-archive-holdout.js
 * Writes backend/data/profit-program/options-archive-holdout.json
 */
const fs = require("fs"), path = require("path");
const C = require("./_opt-common.js");
const B = require("./_opt-bars.js");
const { nullBar } = require("../lib/null-bar.js");
const { $, f } = C;
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
(async () => {
  const A = JSON.parse(fs.readFileSync(path.join(C.DATA, "r116-zero-dte-replay-wings.json"), "utf8"));
  const mac = JSON.parse(fs.readFileSync(path.join(C.DATA, "macro-calendar.json"), "utf8"));
  const macroDays = new Set([].concat(mac.CPI || [], mac.NFP || [], mac.FOMC || []));
  const vixAll = await B.vixDailyLong();
  const vd = Object.keys(vixAll).sort();
  const priorVix = (d) => { let v = null; for (const k of vd) { if (k < d) v = vixAll[k]; else break; } return v; };
  const syms = [...new Set(A.map((w) => w.u))], daily = {};
  for (const s of syms) daily[s] = await B.stockDaily(s, "2024-07-15", "2026-10-09");
  const prevMove = (s, d) => { const a = daily[s].filter((x) => x.d < d); if (a.length < 2) return null; return Math.abs(a[a.length - 1].c / a[a.length - 2].c - 1); };
  const dow = (d) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(new Date(d + "T12:00:00Z"));
  const rows = A.filter((w) => w.width > 0 && Number.isFinite(w.settle)).map((w) => ({ day: w.day, sym: w.u, dow: dow(w.day), y: w.pnl, cw: w.creditCross / w.width, mny: Math.abs(w.spot - w.shortStrike) / w.spot, vix: priorVix(w.day), prev: prevMove(w.u, w.day), macro: macroDays.has(w.day), right: w.right }));
  const days = [...new Set(rows.map((r) => r.day))].sort();
  console.log(`ARCHIVE HOLDOUT — ${rows.length} wings, ${days.length} sessions (${days[0]}..${days[days.length - 1]}); y = net $ per contract-wing; mean ${$(C.mean(rows.map((r) => r.y)))} (t ${f(C.bySession(rows, (r) => r.y, (r) => r.day).t)} on session sums)`);
  const q = (vals, p) => { const s = [...vals].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const cells = [];
  const cat = (variable, fn, levels) => levels.forEach((lv) => cells.push({ variable, level: String(lv), pred: (r) => fn(r) === lv }));
  const tert = (variable, key, dec) => { const v = rows.map((r) => r[key]).filter((x) => x != null); const a = q(v, 1 / 3), b = q(v, 2 / 3); cells.push({ variable, level: `low (<${a.toFixed(dec)})`, pred: (r) => r[key] != null && r[key] < a }, { variable, level: "mid", pred: (r) => r[key] != null && r[key] >= a && r[key] < b }, { variable, level: `high (>=${b.toFixed(dec)})`, pred: (r) => r[key] != null && r[key] >= b }); };
  cat("underlying", (r) => r.sym, syms.sort());
  cat("weekday", (r) => r.dow, ["Mon", "Tue", "Wed", "Thu", "Fri"]);
  tert("credit / width", "cw", 3);
  tert("short strike distance (% of spot; no IV in the archive)", "mny", 4);
  tert("VIX prior close", "vix", 1);
  tert("underlying prior-day |move|", "prev", 4);
  cat("scheduled macro day (CPI/NFP/FOMC)", (r) => (r.macro ? "yes" : "no"), ["yes", "no"]);
  const out = { label: "EXPLORATORY holdout on the R116 archive", wings: rows.length, sessions: days.length, cells: [] };
  console.log(`${"variable / level".padEnd(58)} ${"n".padStart(5)} ${"sess".padStart(4)} ${"$/wing".padStart(7)} ${"vs rest".padStart(8)} ${"t(clust)".padStart(8)}`);
  let last = "";
  for (const c of cells) {
    const R = rows.filter(c.pred); if (!R.length) continue;
    const dt = C.clusterDiff(rows, c.pred, (r) => r.y, (r) => r.day);
    if (c.variable !== last) { console.log(`-- ${c.variable}`); last = c.variable; }
    console.log(`   ${c.level.padEnd(55)} ${String(R.length).padStart(5)} ${String(new Set(R.map((r) => r.day)).size).padStart(4)} ${$(C.mean(R.map((r) => r.y))).padStart(7)} ${$(dt.diff).padStart(8)} ${f(dt.t).padStart(8)}`);
    out.cells.push({ variable: c.variable, level: c.level, n: R.length, sessions: new Set(R.map((r) => r.day)).size, meanY: C.mean(R.map((r) => r.y)), diffVsRest: dt.diff, t: dt.t });
  }
  const V = out.cells.length, bar = nullBar({ variants: 2 * V, n: days.length, trials: 20000 });
  const maxAbs = Math.max(...out.cells.map((c) => Math.abs(c.t)).filter(Number.isFinite));
  console.log(`\nmultiplicity: ${V} cells -> best-of-${2 * V} null bar at n=${days.length} sessions p95 ${f(bar.p95)}; largest |t| ${f(maxAbs)} -> ${maxAbs > bar.p95 ? "at least one cell CLEARS" : "no cell clears"}`);
  out.multiplicity = { cells: V, nullBarP95: bar.p95, maxAbsT: maxAbs };
  console.log("\nwrote " + C.writeOut("options-archive-holdout.json", out));
})().catch((e) => { console.error("FAILED: " + e.message); process.exitCode = 1; });
