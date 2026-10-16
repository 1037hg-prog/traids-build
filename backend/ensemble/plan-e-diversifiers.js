#!/usr/bin/env node
"use strict";
/**
 * PLAN-E DIVERSIFIER MEASUREMENT — ensemble-architect 2026-10-07.
 * Measurement only. Reads backend/data/strategy-library/*.json READ-ONLY and prints. Writes nothing.
 *
 * Every library stream is projected onto Plan E's own session grid (PLAN-E-CORE.json), inside the overlap window, with absent
 * dates = 0 (the library's convention: zeros inside `window` are cash). crypto-24x7 streams are compounded from the previous
 * session's date to the session date, exactly as Plan E's own crypto leg is.
 *
 * Reported per stream: overlap days, active-day share, rho vs PLAN-E-CORE (full / 2023+ / Plan E's worst-5% days), rho vs each
 * Plan E leg, the stream's own annualised Sharpe over the overlap, and dSharpe from adding it at a FIXED RISK SHARE (sized so the
 * satellite's sigma contribution is 10% of Plan E's sigma — inverse-vol, no mean fitting). Everything here is IN-SAMPLE CONTEXT.
 */
const fs = require("fs"), path = require("path");
const LIB = path.join(__dirname, "..", "data", "strategy-library");
const ONLY_PASS = process.argv.includes("--pass");
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return da > 0 && db > 0 ? n / Math.sqrt(da * db) : null; };
const sharpe = (a) => { const s = sd(a); return s > 0 ? +(mean(a) / s * Math.sqrt(252)).toFixed(2) : null; };

const entries = fs.readdirSync(LIB).filter((f) => /\.json$/.test(f) && !/^index|^correlation/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(LIB, f), "utf8")));
const pe = entries.find((e) => e.id === "PLAN-E-CORE");
const sessions = pe.series.map((x) => x.d), peR = pe.series.map((x) => x.r);
const sessIdx = new Map(sessions.map((d, i) => [d, i]));
const prevSession = new Map(); sessions.forEach((d, i) => prevSession.set(d, i ? sessions[i - 1] : null));

/** project a library entry onto the Plan E session grid; returns { v: aligned array, lo, hi (index range of the overlap) } */
function project(e) {
  const v = new Array(sessions.length).fill(0);
  if (e.calendar === "monthly") return null;
  if (e.calendar === "crypto-24x7") {
    const m = new Map(e.series.map((x) => [x.d, x.r]));
    for (let i = 1; i < sessions.length; i++) {
      let g = 1, any = false;
      for (let t = Date.parse(sessions[i - 1]) + 864e5; t <= Date.parse(sessions[i]); t += 864e5) { const k = new Date(t).toISOString().slice(0, 10); if (m.has(k)) { g *= 1 + m.get(k); any = true; } }
      if (any) v[i] = g - 1;
    }
  } else {
    for (const x of e.series) { const i = sessIdx.get(x.d); if (i != null) v[i] = x.r; }
  }
  const lo = Math.max(0, sessions.findIndex((d) => d >= e.window[0])), hiRaw = sessions.filter((d) => d <= e.window[1]).length - 1;
  const hi = Math.min(sessions.length - 1, hiRaw);
  return hi - lo < 120 ? null : { v, lo, hi };
}

const stressCut = [...peR].sort((a, b) => a - b)[Math.floor(0.05 * peR.length)];
const rows = [];
for (const e of entries) {
  if (e.status !== "ok" || e.id.startsWith("PLAN-E") || e.void) continue;
  if (ONLY_PASS && !/\bPASS/.test(String(e.verdict || "")) ) continue;
  const p = project(e); if (!p) continue;
  const a = p.v.slice(p.lo, p.hi + 1), b = peR.slice(p.lo, p.hi + 1), ds = sessions.slice(p.lo, p.hi + 1);
  const i23 = ds.findIndex((d) => d >= "2023-01-01");
  const st = []; const sb = [];
  ds.forEach((d, i) => { if (b[i] <= stressCut) { st.push(a[i]); sb.push(b[i]); } });
  // fixed-risk-share add: w such that w*sd(a) = 0.10 * sd(b)
  const sa = sd(a), sb0 = sd(b), w = sa > 0 ? 0.10 * sb0 / sa : 0;
  const comb = a.map((x, i) => b[i] + w * x);
  rows.push({
    id: e.id, verdict: /\bPASS/.test(String(e.verdict || "")) && !/DID NOT PASS|NOT PASS/.test(String(e.verdict || "")) ? "PASS" : (/DID NOT PASS/.test(String(e.verdict || "")) ? "DNP" : "other"),
    days: a.length, activePct: +(100 * a.filter((x) => x !== 0).length / a.length).toFixed(1),
    rho: +(corr(a, b) ?? 0).toFixed(3),
    rho23: i23 >= 0 && a.length - i23 > 120 ? +(corr(a.slice(i23), b.slice(i23)) ?? 0).toFixed(3) : null,
    rhoStress: st.length > 30 ? +(corr(st, sb) ?? 0).toFixed(3) : null,
    ownSharpe: sharpe(a), volAnnPct: +(100 * sa * Math.sqrt(252)).toFixed(1),
    peSharpe: sharpe(b), combSharpe: sharpe(comb),
    dSharpe: +(sharpe(comb) - sharpe(b)).toFixed(3),
    legRho: Object.fromEntries(["EQUITY", "GOLD", "DBMF", "CRYPTO", "TSY"].map((L) => {
      const le = entries.find((x) => x.id === "PLAN-E-" + L), lp = project(le);
      const lv = lp.v.slice(p.lo, p.hi + 1);
      return [L, +(corr(a, lv) ?? 0).toFixed(3)];
    })),
  });
}

rows.sort((x, y) => y.dSharpe - x.dSharpe);
const fmt = (r) => `${r.id.padEnd(20)} ${r.verdict.padEnd(5)} d${String(r.days).padStart(5)} act${String(r.activePct).padStart(6)}% rho ${String(r.rho).padStart(6)} rho23 ${String(r.rho23).padStart(6)} rhoStr ${String(r.rhoStress).padStart(6)} ownSh ${String(r.ownSharpe).padStart(6)} vol ${String(r.volAnnPct).padStart(5)}% | PE ${r.peSharpe} -> ${r.combSharpe} (d ${r.dSharpe >= 0 ? "+" : ""}${r.dSharpe}) | legs E${r.legRho.EQUITY} G${r.legRho.GOLD} D${r.legRho.DBMF} C${r.legRho.CRYPTO} T${r.legRho.TSY}`;
console.log(`Plan E grid: ${sessions.length} sessions ${sessions[0]}..${sessions[sessions.length - 1]}; stress cut (worst 5%) ${(100 * stressCut).toFixed(2)}%/day; ${rows.length} streams measured\n`);
console.log("=== TOP 25 by dSharpe at a 10%-of-Plan-E-vol risk share (IN-SAMPLE CONTEXT) ===");
rows.slice(0, 25).forEach((r) => console.log(fmt(r)));
console.log("\n=== PASS-verdict streams, all ===");
rows.filter((r) => r.verdict === "PASS").forEach((r) => console.log(fmt(r)));
console.log("\n=== |rho| to PLAN-E-CORE, lowest 15 among streams with ownSharpe > 0.3 ===");
rows.filter((r) => r.ownSharpe > 0.3).sort((a, b) => Math.abs(a.rho) - Math.abs(b.rho)).slice(0, 15).forEach((r) => console.log(fmt(r)));
console.log("\n=== rho on Plan E's worst-5% days, most NEGATIVE 12 (ownSharpe > 0) ===");
rows.filter((r) => r.rhoStress != null && r.ownSharpe > 0).sort((a, b) => a.rhoStress - b.rhoStress).slice(0, 12).forEach((r) => console.log(fmt(r)));
