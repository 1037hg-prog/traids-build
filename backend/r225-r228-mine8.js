#!/usr/bin/env node
/**
 * R225-R228 — MINING ROUND 8 (registered 2026-09-24 by register-mine8.js before this file ran; rules frozen in the registry).
 *   R225 SPY quad-witching vs non-quad 3rd Fridays     R226 same on QQQ
 *   R227 IWM/SPY Russell reconstitution anticipatory (2001-2026, Yahoo)   R228 same, post-event reversal
 * PRIMARY statistic for every test is RAW net-of-cost window return (fixed non-signal-dependent baseline for R225/R226;
 * no baseline at all for R227/R228). Secondary diagnostics, falsifiers, cross-source validation and IEF-correlation are
 * disclosed, never gating (except R227/R228's pre-declared Yahoo/Alpaca-overlap sanity note, which is reported not gated).
 *   node backend/r225-r228-mine8.js [--dry]
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f);
const DRY = process.argv.includes("--dry");
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")), SEAL = seals.tests || seals;
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = (id) => reg.preregistered.find((t) => t.id === id);
const IDS = ["R225", "R226", "R227", "R228"];
if (!DRY) for (const id of IDS) if (SEAL[id]) { console.error(`${id} already sealed — refusing to re-run non-dry`); process.exit(2); }

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length >= 3 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); };
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)]; };
const r3 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(3));
const START = "2016-01-01", END = "2026-08-31", inRange = (d) => d >= START && d <= END;

async function yahooHistory(sym) {
  const r = await fetch(`http://localhost:3002/api/yahoo/${sym}/history?days=20000&interval=1d`);
  if (!r.ok) throw new Error(`yahoo proxy ${sym} ${r.status}`);
  const j = await r.json();
  return j.bars.filter((b) => b.adjClose != null).map((b) => ({ d: b.date, c: b.adjClose })).sort((a, b) => (a.d < b.d ? -1 : 1));
}

(async () => {
  const { bars } = await fetchBars(["SPY", "QQQ", "IWM", "IEF"], { start: "2015-11-01", end: END, feed: "sip", adjustment: "all", quiet: true });
  const B = {}; for (const s of Object.keys(bars)) B[s] = bars[s].map((b) => ({ d: b.t.slice(0, 10), c: b.c }));
  const results = {};

  // ---------- shared: IEF month-end series ----------
  function byMonth(series) { const m = {}; for (const b of series) if (inRange(b.d)) (m[b.d.slice(0, 7)] = m[b.d.slice(0, 7)] || []).push(b); for (const k in m) m[k].sort((a, b) => (a.d < b.d ? -1 : 1)); return m; }
  const iefM = byMonth(B.IEF), iefSeries = {}, giIEF = new Map(B.IEF.map((b, i) => [b.d, i]));
  for (const ym of Object.keys(iefM)) { const days = iefM[ym]; if (days.length < 6) continue; const L = days.length, entry = days[L - 6], exit = days[L - 1];
    const gE = giIEF.get(entry.d); if (!gE) continue; iefSeries[ym] = B.IEF[giIEF.get(exit.d)].c / B.IEF[gE - 1].c - 1; }
  const corrWithIEF = (byYm) => { const yms = Object.keys(byYm).filter((y) => iefSeries[y] !== undefined); if (yms.length < 5) return null; return r3(corr(yms.map((y) => byYm[y]), yms.map((y) => iefSeries[y]))); };

  // ---------- R225 / R226: quad-witching ----------
  function thirdFriday(y, m) { let fridays = []; for (let d = 1; d <= 31; d++) { const dt = new Date(Date.UTC(y, m - 1, d)); if (dt.getUTCMonth() !== m - 1) break; if (dt.getUTCDay() === 5) fridays.push(dt.toISOString().slice(0, 10)); } return fridays[2]; }
  function quadTest(sym, seed) {
    const S = B[sym].filter((b) => inRange(b.d)), di = new Map(B[sym].map((b, i) => [b.d, i]));
    const byYm = {}; S.forEach((b) => (byYm[b.d.slice(0, 7)] = byYm[b.d.slice(0, 7)] || []).push(b.d));
    const rows = []; // { ym, isQuad, ret }
    for (const ym of Object.keys(byYm).sort()) { const [y, m] = ym.split("-").map(Number); const f3 = thirdFriday(y, m); if (!f3) continue;
      let idx = -1; for (let i = 0; i < B[sym].length; i++) if (B[sym][i].d >= f3) { idx = i; break; } if (idx <= 0) continue;
      const ret = B[sym][idx].c / B[sym][idx - 1].c - 1 - 0.0004;
      rows.push({ ym, isQuad: ["03", "06", "09", "12"].includes(m.toString().padStart(2, "0")), ret });
    }
    const quad = rows.filter((r) => r.isQuad), nonQuad = rows.filter((r) => !r.isQuad);
    const baseline = mean(nonQuad.map((r) => r.ret));
    const adj = quad.map((r) => r.ret - baseline), t = tOf(adj);
    const twoSample_t = (() => { // Welch-ish, informational only
      const mq = mean(quad.map((r) => r.ret)), mn = mean(nonQuad.map((r) => r.ret));
      const vq = sd(quad.map((r) => r.ret)) ** 2 / quad.length, vn = sd(nonQuad.map((r) => r.ret)) ** 2 / nonQuad.length;
      return (mq - mn) / Math.sqrt(vq + vn); })();
    const rng = mulberry(seed), draws = [];
    for (let k = 0; k < 200; k++) { const pool = [...nonQuad]; const sample = []; for (let i = 0; i < quad.length; i++) sample.push(pool[Math.floor(rng() * pool.length)].ret - baseline); draws.push(tOf(sample)); }
    const byYmRet = Object.fromEntries(quad.map((r) => [r.ym, r.ret - baseline]));
    return { events: quad.length, nonQuadN: nonQuad.length, meanNetPct: r3(100 * mean(quad.map((r) => r.ret))), nonQuadBaselinePct: r3(100 * baseline), meanAdjPct: r3(100 * mean(adj)), primaryT: t, twoSampleT: r3(twoSample_t), placeboP95: r3(p95(draws)), corrWithIEFmonthEnd: corrWithIEF(byYmRet), _byYmRet: byYmRet };
  }
  results.R225 = quadTest("SPY", 225000); results.R226 = quadTest("QQQ", 226000);
  const corrR225vR226 = (() => { const a = results.R225._byYmRet, b = results.R226._byYmRet, yms = Object.keys(a).filter((y) => b[y] !== undefined); return yms.length >= 5 ? r3(corr(yms.map((y) => a[y]), yms.map((y) => b[y]))) : null; })();
  delete results.R225._byYmRet; delete results.R226._byYmRet; results.corrR225vR226 = corrR225vR226;

  // ---------- R227 / R228: Russell reconstitution (Yahoo, 2001-2026) ----------
  const yIWM = await yahooHistory("IWM"), ySPY = await yahooHistory("SPY");
  const idxIWM = new Map(yIWM.map((b, i) => [b.d, i])), idxSPY = new Map(ySPY.map((b, i) => [b.d, i]));
  function lastFridayOfMonth(y, m) { const last = new Date(Date.UTC(y, m, 0)); let d = last.getUTCDate(); while (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== 5) d--; return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10); }
  function sessionOnOrBefore(idxMap, arr, dateStr) { let last = null; for (const b of arr) { if (b.d <= dateStr) last = b; else break; } return last; }
  function sessionsAround(dateStr) {
    const effIWM = sessionOnOrBefore(null, yIWM, dateStr); if (!effIWM) return null;
    const gI = idxIWM.get(effIWM.d), gS = idxSPY.get(effIWM.d); if (gI == null || gS == null) return null;
    return { effDate: effIWM.d, gI, gS };
  }
  const YEARS = []; for (let y = 2001; y <= 2026; y++) YEARS.push(y);
  function eventRows(monthPicker, entryOffset, exitOffset) { // entry/exit are session-index offsets from effective session (negative = before)
    const rows = [];
    for (const y of YEARS) { const target = monthPicker(y); const anchor = sessionsAround(target); if (!anchor) continue;
      const eIdx = anchor.gI + entryOffset, xIdx = anchor.gI + exitOffset; if (eIdx < 0 || xIdx >= yIWM.length) continue;
      const entryD = yIWM[eIdx].d, exitD = yIWM[xIdx].d; const eS = idxSPY.get(entryD), xS = idxSPY.get(exitD); if (eS == null || xS == null) continue;
      const rIWM = yIWM[xIdx].c / yIWM[eIdx].c - 1, rSPY = ySPY[xS].c / ySPY[eS].c - 1;
      rows.push({ y, effDate: anchor.effDate, rIWM, rSPY }); }
    return rows;
  }
  function juneRecon(y) { return lastFridayOfMonth(y, 6); }
  function decemberControl(y) { return lastFridayOfMonth(y, 12); }

  // R227: entry = effective-5 sessions, exit = effective session (index 0)
  { const rows = eventRows(juneRecon, -5, 0);
    const pair = rows.map((r) => ({ y: r.y, net: (r.rIWM - r.rSPY) - 0.0008 }));
    const t = tOf(pair.map((r) => r.net));
    const half = Math.floor(pair.length / 2), firstHalf = pair.slice(0, half), secondHalf = pair.slice(half);
    const ctrl = eventRows(decemberControl, -5, 0).map((r) => (r.rIWM - r.rSPY) - 0.0008);
    const rng = mulberry(227000), draws = [];
    for (let k = 0; k < 200; k++) { const s = []; for (const y of YEARS) { const target = juneRecon(y); const anchor = sessionsAround(target); if (!anchor) continue;
        const jitter = Math.floor(rng() * 25) - 12; const eIdx = anchor.gI + jitter - 5, xIdx = anchor.gI + jitter; if (eIdx < 0 || xIdx >= yIWM.length || eIdx >= xIdx) continue;
        const entryD = yIWM[eIdx].d, exitD = yIWM[xIdx].d; const eS = idxSPY.get(entryD), xS = idxSPY.get(exitD); if (eS == null || xS == null) continue;
        s.push((yIWM[xIdx].c / yIWM[eIdx].c - 1) - (ySPY[xS].c / ySPY[eS].c - 1) - 0.0008); } draws.push(tOf(s)); }
    // Alpaca overlap validation for 2016-2025
    const overlapYears = YEARS.filter((y) => y >= 2016 && y <= 2025);
    const alpacaRows = []; for (const y of overlapYears) { const target = juneRecon(y);
      const effA = (() => { let last = null; for (const b of B.IWM) { if (b.d <= target) last = b; else break; } return last; })(); if (!effA) continue;
      const gIa = B.IWM.findIndex((b) => b.d === effA.d), eIdxA = gIa - 5; if (eIdxA < 0) continue;
      const entryD = B.IWM[eIdxA].d, exitD = effA.d; const spyE = B.SPY.find((b) => b.d === entryD), spyX = B.SPY.find((b) => b.d === exitD); if (!spyE || !spyX) continue;
      alpacaRows.push({ y, net: (effA.c / B.IWM[eIdxA].c - 1) - (spyX.c / spyE.c - 1) - 0.0008 }); }
    const overlapDiffs = alpacaRows.map((a) => { const y = pair.find((p) => p.y === a.y); return y ? Math.abs(y.net - a.net) : null; }).filter((x) => x != null);
    const byYmNet = Object.fromEntries(pair.map((r) => [String(r.y), r.net]));
    results.R227 = { events: pair.length, meanNetPct: r3(100 * mean(pair.map((r) => r.net))), primaryT: t, firstHalf_t: r3(tOf(firstHalf.map((r) => r.net))), firstHalf_n: firstHalf.length, secondHalf_t: r3(tOf(secondHalf.map((r) => r.net))), secondHalf_n: secondHalf.length, falsifierT: r3(tOf(ctrl)), falsifierN: ctrl.length, placeboP95: r3(p95(draws)), corrWithIEFmonthEnd: corrWithIEF(byYmNet), yahooAlpacaOverlap: { n: overlapDiffs.length, maxAbsDiff: r3(Math.max(...overlapDiffs, 0)), meanAbsDiff: r3(mean(overlapDiffs.length ? overlapDiffs : [0])) }, _pair: pair };
  }
  // R228: entry = effective session (index 0), exit = effective+5
  { const rows = eventRows(juneRecon, 0, 5);
    const pair = rows.map((r) => ({ y: r.y, net: (r.rSPY - r.rIWM) - 0.0008 })); // SHORT IWM / LONG SPY
    const t = tOf(pair.map((r) => r.net));
    const half = Math.floor(pair.length / 2), firstHalf = pair.slice(0, half), secondHalf = pair.slice(half);
    const ctrl = eventRows(decemberControl, 0, 5).map((r) => (r.rSPY - r.rIWM) - 0.0008);
    const rng = mulberry(228000), draws = [];
    for (let k = 0; k < 200; k++) { const s = []; for (const y of YEARS) { const target = juneRecon(y); const anchor = sessionsAround(target); if (!anchor) continue;
        const jitter = Math.floor(rng() * 20); const eIdx = anchor.gI + jitter, xIdx = eIdx + 5; if (eIdx < 0 || xIdx >= yIWM.length) continue;
        const entryD = yIWM[eIdx].d, exitD = yIWM[xIdx].d; const eS = idxSPY.get(entryD), xS = idxSPY.get(exitD); if (eS == null || xS == null) continue;
        s.push((ySPY[xS].c / ySPY[eS].c - 1) - (yIWM[xIdx].c / yIWM[eIdx].c - 1) - 0.0008); } draws.push(tOf(s)); }
    const byYmNet = Object.fromEntries(pair.map((r) => [String(r.y), r.net]));
    const corrWithR227 = (() => { const a = results.R227._pair, yms = a.map((r) => r.y).filter((y) => pair.find((p) => p.y === y)); if (yms.length < 5) return null;
      return r3(corr(yms.map((y) => a.find((r) => r.y === y).net), yms.map((y) => pair.find((r) => r.y === y).net))); })();
    results.R228 = { events: pair.length, meanNetPct: r3(100 * mean(pair.map((r) => r.net))), primaryT: t, firstHalf_t: r3(tOf(firstHalf.map((r) => r.net))), firstHalf_n: firstHalf.length, secondHalf_t: r3(tOf(secondHalf.map((r) => r.net))), secondHalf_n: secondHalf.length, falsifierT: r3(tOf(ctrl)), falsifierN: ctrl.length, placeboP95: r3(p95(draws)), corrWithIEFmonthEnd: corrWithIEF(byYmNet), corrWithR227: corrWithR227 };
  }
  delete results.R227._pair;

  if (DRY) { console.log("DRY (counts only):", JSON.stringify({ R225: results.R225.events, R226: results.R226.events, R227: results.R227.events, R228: results.R228.events, corrR225vR226, yahooAlpacaOverlapN: results.R227.yahooAlpacaOverlap.n })); return; }

  // ---------- verdicts + seals ----------
  for (const id of IDS) {
    const r = results[id], e = E(id); if (SEAL[id]) { console.log(`${id} already sealed — skipped`); delete r.primaryT; continue; }
    const pass = r.primaryT >= e.bar.tRequired && r.primaryT > r.placeboP95;
    const verdict = `${pass ? "PASS" : "DID NOT PASS"} — primary t ${r.primaryT != null ? r.primaryT.toFixed(3) : "n/a"} vs bar ${e.bar.tRequired}, placebo p95 ${r.placeboP95}`;
    r.verdict = verdict; delete r.primaryT;
    SEAL[id] = { sealedOn: new Date().toISOString().slice(0, 10), unit: e.bar.unit, verdict };
    e.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict;
    fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: id, verdict }) + "\n");
  }
  writeJsonAtomic(D("read-seals.json"), seals); reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  writeJsonAtomic(D("r225-r228-mine8.json"), { spec: "mine8-v1", ranAt: new Date().toISOString(), results, corrR225vR226 });
  console.log(JSON.stringify({ ...results, corrR225vR226 }, null, 1));
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
