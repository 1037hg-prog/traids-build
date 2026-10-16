#!/usr/bin/env node
/**
 * R220-R224 — MINING ROUND 7 (registered 2026-09-24 by register-mine7.js before this file ran; rules frozen in the registry).
 *   R220 USL/USO crude-oil roll front-run      R221 UNL/UNG nat-gas roll front-run
 *   R222 SPY monthly opex-week premium         R223 EFA+EEM MSCI quarterly-review rebalance
 *   R224 BWX international-Treasury month-end
 * PRIMARY statistic for every test is RAW net-of-cost window return (no drift adjustment) per the 2026-09-24 house
 * rule against signal-dependent drift laundering. Drift-adjusted figures, falsifiers and IEF-correlation are computed
 * and disclosed as SECONDARY/non-gating.
 * Implementation notes (disclosed, not rule changes):
 *   N1 "session index k within the month" uses each symbol's OWN bar calendar (USO for R220, UNG for R221, SPY for
 *      R222/R223's anchor dates, BWX for R224) — matches the registered rule text exactly.
 *   N2 R222 opex week = sessions from (exclusive) the prior week's last session through the first session on/after
 *      the calendar 3rd Friday.
 *   N3 R223 effective date = last SPY session whose date falls in {Feb,May,Aug,Nov}; entry = 3rd-to-last session of
 *      that month.
 *   N4 IEF month-end series (for correlation, all tests) = R180's own definition: last-5-session gross window return
 *      per month, rebuilt directly from IEF bars here (not read from R180's output file, so this script has no
 *      dependency on R180 having been run first).
 *   node backend/r220-r224-mine7.js [--dry]
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f);
const DRY = process.argv.includes("--dry");
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")), SEAL = seals.tests || seals;
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = (id) => reg.preregistered.find((t) => t.id === id);
const IDS = ["R220", "R221", "R222", "R223", "R224"];
if (!DRY) for (const id of IDS) if (SEAL[id]) { console.error(`${id} already sealed — refusing to re-run non-dry`); process.exit(2); }

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length >= 3 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); };
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)]; };
const r3 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(3));
const START = "2016-01-01", END = "2026-08-31", inRange = (d) => d >= START && d <= END;

function byMonth(series) { const m = {}; for (const b of series) if (inRange(b.d)) (m[b.d.slice(0, 7)] = m[b.d.slice(0, 7)] || []).push(b); for (const k in m) m[k].sort((a, b) => (a.d < b.d ? -1 : 1)); return m; }

(async () => {
  const { bars } = await fetchBars(["USO", "USL", "UNG", "UNL", "SPY", "EFA", "EEM", "BWX", "IEF"], { start: "2015-11-01", end: END, feed: "sip", adjustment: "all", quiet: true });
  const B = {}; for (const s of Object.keys(bars)) B[s] = bars[s].map((b) => ({ d: b.t.slice(0, 10), o: b.o, c: b.c }));
  const results = {};

  // ---------- shared: IEF month-end series (R180's own definition, rebuilt) ----------
  const iefM = byMonth(B.IEF), iefYms = Object.keys(iefM).sort();
  const iefSeries = {};
  for (const ym of iefYms) { const days = iefM[ym]; if (days.length < 6) continue;
    // need previous session's close (may be last day of prior month) for the -6th-session return chain
    const idxAll = B.IEF.findIndex((b) => b.d === days[0].d);
    const L = days.length, entry = B.IEF[idxAll + (L - 6)] ? days[L - 6] : null; if (!entry) continue;
    const exit = days[L - 1];
    if (!entry || !exit) continue;
    const entryIdxGlobal = B.IEF.findIndex((b) => b.d === entry.d);
    if (entryIdxGlobal <= 0) continue;
    iefSeries[ym] = exit.c / B.IEF[entryIdxGlobal - 1].c - 1; }
  const corrWithIEF = (byYm) => { const yms = Object.keys(byYm).filter((y) => iefSeries[y] !== undefined); if (yms.length < 5) return null; return r3(corr(yms.map((y) => byYm[y]), yms.map((y) => iefSeries[y]))); };

  // ---------- R220 / R221: commodity roll ----------
  function rollTest(frontSym, strip, seed) {
    const front = byMonth(B[frontSym]), rows = [], falsifierRows = [];
    const globalIdx = new Map(B[frontSym].map((b, i) => [b.d, i])), globalIdxStrip = new Map(B[strip].map((b, i) => [b.d, i]));
    const ms = Object.keys(front).sort();
    for (const ym of ms) { const days = front[ym]; if (days.length < 15) continue;
      const entryD = days[3], exitD = days[8]; if (!entryD || !exitD) continue;
      const iF = globalIdx.get(entryD.d), jF = globalIdx.get(exitD.d), iS = globalIdxStrip.get(entryD.d), jS = globalIdxStrip.get(exitD.d);
      if (iF == null || jF == null || iS == null || jS == null) continue;
      const frontR = B[frontSym][jF].c / B[frontSym][iF].c - 1, stripR = B[strip][jS].c / B[strip][iS].c - 1;
      const raw = stripR - frontR;
      // drift: pair return on the month's OTHER days (session-to-session), x5, using front's own day grid for alignment
      const other = []; for (let k = 1; k < days.length; k++) { if (k >= 3 && k <= 8) continue; const d0 = days[k - 1].d, d1 = days[k].d;
        const gF0 = globalIdx.get(d0), gF1 = globalIdx.get(d1), gS0 = globalIdxStrip.get(d0), gS1 = globalIdxStrip.get(d1);
        if (gF0 == null || gF1 == null || gS0 == null || gS1 == null) continue;
        other.push((B[strip][gS1].c / B[strip][gS0].c - 1) - (B[frontSym][gF1].c / B[frontSym][gF0].c - 1)); }
      const drift = other.length ? 5 * mean(other) : 0;
      rows.push({ ym, raw, net: raw - 0.0008, adj: raw - 0.0008 - drift });
      // falsifier: session indices 14..18
      if (days.length >= 19) { const eD = days[14], xD = days[18]; const iF2 = globalIdx.get(eD.d), jF2 = globalIdx.get(xD.d), iS2 = globalIdxStrip.get(eD.d), jS2 = globalIdxStrip.get(xD.d);
        if (iF2 != null && jF2 != null && iS2 != null && jS2 != null) falsifierRows.push((B[strip][jS2].c / B[strip][iS2].c - 1) - (B[frontSym][jF2].c / B[frontSym][iF2].c - 1) - 0.0008); }
    }
    const net = rows.map((r) => r.net), t = tOf(net);
    const rng = mulberry(seed), draws = [];
    for (let k = 0; k < 200; k++) { const s = []; for (const ym of ms) { const days = front[ym]; if (days.length < 15) continue;
        const maxStart = days.length - 5; const k0 = Math.floor(rng() * maxStart);
        const entryD = days[k0], exitD = days[Math.min(days.length - 1, k0 + 5)]; if (!entryD || !exitD) continue;
        const iF = globalIdx.get(entryD.d), jF = globalIdx.get(exitD.d), iS = globalIdxStrip.get(entryD.d), jS = globalIdxStrip.get(exitD.d);
        if (iF == null || jF == null || iS == null || jS == null) continue;
        s.push((B[strip][jS].c / B[strip][iS].c - 1) - (B[frontSym][jF].c / B[frontSym][iF].c - 1) - 0.0008); }
      draws.push(tOf(s)); }
    const byYmNet = Object.fromEntries(rows.map((r) => [r.ym, r.net]));
    return { months: rows.length, meanNetPct: r3(100 * mean(net)), primaryT: t, meanAdjPct: r3(100 * mean(rows.map((r) => r.adj))), adjT: r3(tOf(rows.map((r) => r.adj))), falsifierT: r3(tOf(falsifierRows)), falsifierN: falsifierRows.length, placeboP95: r3(p95(draws)), corrWithIEFmonthEnd: corrWithIEF(byYmNet) };
  }
  results.R220 = rollTest("USO", "USL", 220000);
  results.R221 = rollTest("UNG", "UNL", 221000);
  results.corrR220vR221 = (() => { const a = results.R220, b = results.R221; return null; })(); // filled below after we have per-ym series

  // recompute R220/R221 per-ym net series for cross-correlation
  function rollSeries(frontSym, strip) {
    const front = byMonth(B[frontSym]), globalIdx = new Map(B[frontSym].map((b, i) => [b.d, i])), globalIdxStrip = new Map(B[strip].map((b, i) => [b.d, i])), out = {};
    for (const ym of Object.keys(front).sort()) { const days = front[ym]; if (days.length < 15) continue; const entryD = days[3], exitD = days[8]; if (!entryD || !exitD) continue;
      const iF = globalIdx.get(entryD.d), jF = globalIdx.get(exitD.d), iS = globalIdxStrip.get(entryD.d), jS = globalIdxStrip.get(exitD.d); if (iF == null || jF == null || iS == null || jS == null) continue;
      out[ym] = (B[strip][jS].c / B[strip][iS].c - 1) - (B[frontSym][jF].c / B[frontSym][iF].c - 1) - 0.0008; }
    return out; }
  { const a = rollSeries("USO", "USL"), b = rollSeries("UNG", "UNL"), yms = Object.keys(a).filter((y) => b[y] !== undefined);
    results.corrR220vR221 = yms.length >= 5 ? r3(corr(yms.map((y) => a[y]), yms.map((y) => b[y]))) : null; }

  // ---------- R222: opex week SPY ----------
  { const S = B.SPY.filter((b) => inRange(b.d)), di = new Map(B.SPY.map((b, i) => [b.d, i]));
    const ms = {}; S.forEach((b) => (ms[b.d.slice(0, 7)] = ms[b.d.slice(0, 7)] || []).push(b.d));
    const rows = [], ctrlRows = [];
    for (const ym of Object.keys(ms).sort()) {
      const [y, m] = ym.split("-").map(Number);
      // find 3rd Friday calendar date
      let fridays = []; for (let d = 1; d <= 31; d++) { const dt = new Date(Date.UTC(y, m - 1, d)); if (dt.getUTCMonth() !== m - 1) break; if (dt.getUTCDay() === 5) fridays.push(dt.toISOString().slice(0, 10)); }
      const f3 = fridays[2]; if (!f3) continue;
      const idxF3 = di.get(f3) ?? (() => { for (let i = 0; i < B.SPY.length; i++) if (B.SPY[i].d >= f3) return i; return -1; })();
      if (idxF3 < 0) continue;
      const exitIdx = B.SPY[idxF3] ? idxF3 : idxF3; // if f3 itself not a session, next available at/after
      const exitDate = B.SPY[exitIdx].d;
      // Monday of that week: exitDate minus up to 4 calendar days, find first session >= that Monday
      const mon = new Date(exitDate + "T12:00:00Z"); mon.setUTCDate(mon.getUTCDate() - (mon.getUTCDay() + 6) % 7);
      const monStr = mon.toISOString().slice(0, 10);
      let entryIdx = -1; for (let i = exitIdx; i >= 0; i--) { if (B.SPY[i].d < monStr) { entryIdx = i; break; } }
      if (entryIdx < 0) continue;
      const win = B.SPY[exitIdx].c / B.SPY[entryIdx].c - 1;
      rows.push({ ym, net: win - 0.0004 });
      // falsifier: window 2 weeks earlier (10 calendar days back from monStr), same length
      const ctrlEnd = new Date(monStr + "T12:00:00Z"); ctrlEnd.setUTCDate(ctrlEnd.getUTCDate() - 10); const ctrlEndStr = ctrlEnd.toISOString().slice(0, 10);
      let ctrlExitIdx = -1; for (let i = 0; i < B.SPY.length; i++) if (B.SPY[i].d >= ctrlEndStr) { ctrlExitIdx = i; break; }
      let ctrlEntryIdx = -1; if (ctrlExitIdx >= 0) for (let i = ctrlExitIdx; i >= 0; i--) { if (B.SPY[i].d < new Date(new Date(B.SPY[ctrlExitIdx].d + "T12:00:00Z").setUTCDate(new Date(B.SPY[ctrlExitIdx].d + "T12:00:00Z").getUTCDate() - ((new Date(B.SPY[ctrlExitIdx].d + "T12:00:00Z").getUTCDay() + 6) % 7))).toISOString().slice(0, 10)) { ctrlEntryIdx = i; break; } }
      if (ctrlExitIdx >= 0 && ctrlEntryIdx >= 0 && ctrlExitIdx !== exitIdx) ctrlRows.push(B.SPY[ctrlExitIdx].c / B.SPY[ctrlEntryIdx].c - 1 - 0.0004);
    }
    const net = rows.map((r) => r.net), t = tOf(net);
    const post = rows.filter((r) => r.ym >= "2018-06");
    const rng = mulberry(222000), draws = []; for (let k = 0; k < 200; k++) draws.push(tOf(rows.map((r) => { const flip = rng() < 0.5 ? 1 : -1; return flip * (r.net + 0.0004) - 0.0004; })));
    const byYmNet = Object.fromEntries(rows.map((r) => [r.ym, r.net]));
    results.R222 = { months: rows.length, meanNetPct: r3(100 * mean(net)), primaryT: t, post2018_06_t: r3(tOf(post.map((r) => r.net))), post2018_06_n: post.length, falsifierT: r3(tOf(ctrlRows)), falsifierN: ctrlRows.length, placeboP95: r3(p95(draws)), corrWithIEFmonthEnd: corrWithIEF(byYmNet) };
  }

  // ---------- R223: MSCI EFA/EEM ----------
  { const S = B.SPY.filter((b) => inRange(b.d));
    const byYm = {}; S.forEach((b) => (byYm[b.d.slice(0, 7)] = byYm[b.d.slice(0, 7)] || []).push(b.d));
    const revMonths = Object.keys(byYm).filter((ym) => ["02", "05", "08", "11"].includes(ym.slice(5))).sort();
    const ctrlMonths = Object.keys(byYm).filter((ym) => ["03", "06", "09", "12"].includes(ym.slice(5))).sort();
    const idxEFA = new Map(B.EFA.map((b, i) => [b.d, i])), idxEEM = new Map(B.EEM.map((b, i) => [b.d, i]));
    function evalMonths(list) { const rows = [];
      for (const ym of list) { const days = byYm[ym]; if (days.length < 15) continue; const entryD = days[days.length - 3], exitD = days[days.length - 1];
        const iE = idxEFA.get(entryD), jE = idxEFA.get(exitD), iM = idxEEM.get(entryD), jM = idxEEM.get(exitD); if (iE == null || jE == null || iM == null || jM == null) continue;
        const rEFA = B.EFA[jE].c / B.EFA[iE].c - 1, rEEM = B.EEM[jM].c / B.EEM[iM].c - 1, win = (rEFA + rEEM) / 2;
        rows.push({ ym, net: win - 0.0008, rEFA, rEEM }); }
      return rows; }
    const rows = evalMonths(revMonths), ctrl = evalMonths(ctrlMonths);
    const net = rows.map((r) => r.net), t = tOf(net);
    const rng = mulberry(223000), draws = [];
    for (let k = 0; k < 200; k++) { const s = []; for (const ym of revMonths) { const days = byYm[ym]; if (days.length < 15) continue;
        const pool = days.slice(0, days.length - 3); const k0 = Math.floor(rng() * Math.max(1, pool.length - 3));
        const entryD = pool[k0], exitD = days[Math.min(days.length - 1, k0 + 3)]; if (!entryD || !exitD) continue;
        const iE = idxEFA.get(entryD), jE = idxEFA.get(exitD), iM = idxEEM.get(entryD), jM = idxEEM.get(exitD); if (iE == null || jE == null || iM == null || jM == null) continue;
        s.push((((B.EFA[jE].c / B.EFA[iE].c - 1) + (B.EEM[jM].c / B.EEM[iM].c - 1)) / 2) - 0.0008); }
      draws.push(tOf(s)); }
    const byYmNet = Object.fromEntries(rows.map((r) => [r.ym, r.net]));
    results.R223 = { events: rows.length, meanNetPct: r3(100 * mean(net)), primaryT: t, EFAlegT: r3(tOf(rows.map((r) => r.rEFA - 0.0004))), EEMlegT: r3(tOf(rows.map((r) => r.rEEM - 0.0004))), falsifierT: r3(tOf(ctrl.map((r) => r.net))), falsifierN: ctrl.length, placeboP95: r3(p95(draws)), corrWithIEFmonthEnd: corrWithIEF(byYmNet) };
  }

  // ---------- R224: BWX international treasury month-end ----------
  { const bwxM = byMonth(B.BWX), gi = new Map(B.BWX.map((b, i) => [b.d, i])), rows = [];
    for (const ym of Object.keys(bwxM).sort()) { const days = bwxM[ym]; if (days.length < 6) continue; const L = days.length, entry = days[L - 6], exit = days[L - 1];
      const gE = gi.get(entry.d), gX = gi.get(exit.d); if (gE == null || gX == null || gE === 0) continue;
      const win = B.BWX[gX].c / B.BWX[gE - 1].c - 1;
      const other = []; for (let k = 1; k < L - 5; k++) { const d0 = days[k - 1].d, d1 = days[k].d; const g0 = gi.get(d0), g1 = gi.get(d1); if (g0 != null && g1 != null) other.push(B.BWX[g1].c / B.BWX[g0].c - 1); }
      const drift = other.length ? 5 * mean(other) : 0;
      rows.push({ ym, net: win - 0.0004, adj: win - 0.0004 - drift, isRefund: ["02", "05", "08", "11"].includes(ym.slice(5)) }); }
    const net = rows.map((r) => r.net), t = tOf(net);
    const rng = mulberry(224000), draws = []; for (let k = 0; k < 200; k++) { const s = []; for (const ym of Object.keys(bwxM).sort()) { const days = bwxM[ym]; if (days.length < 6) continue;
        const k0 = Math.floor(rng() * (days.length - 5)); const entry = days[k0], exit = days[Math.min(days.length - 1, k0 + 5)]; const gE = gi.get(entry.d), gX = gi.get(exit.d); if (gE == null || gX == null || gE === 0) continue;
        s.push(B.BWX[gX].c / B.BWX[gE - 1].c - 1 - 0.0004); } draws.push(tOf(s)); }
    const refund = rows.filter((r) => r.isRefund), other8 = rows.filter((r) => !r.isRefund);
    const byYmNet = Object.fromEntries(rows.map((r) => [r.ym, r.net]));
    const ce = corrWithIEF(byYmNet);
    results.R224 = { months: rows.length, meanNetPct: r3(100 * mean(net)), primaryT: t, meanAdjPct: r3(100 * mean(rows.map((r) => r.adj))), adjT: r3(tOf(rows.map((r) => r.adj))), refundMonths_t: r3(tOf(refund.map((r) => r.net))), refundMonths_n: refund.length, other8Months_t: r3(tOf(other8.map((r) => r.net))), placeboP95: r3(p95(draws)), corrWithIEFmonthEnd: ce, passConditionalOnCorr: ce !== null && Math.abs(ce) <= 0.5 };
  }

  if (DRY) { console.log("DRY (counts only):", JSON.stringify({ R220: results.R220.months, R221: results.R221.months, R222: results.R222.months, R223: results.R223.events, R224: results.R224.months, corrR220vR221: results.corrR220vR221 })); return; }

  // ---------- verdicts + seals ----------
  for (const id of IDS) {
    const r = results[id], e = E(id); if (SEAL[id]) { console.log(`${id} already sealed — skipped`); delete r.primaryT; continue; }
    let pass = r.primaryT >= e.bar.tRequired && r.primaryT > r.placeboP95;
    if (id === "R224") pass = pass && r.passConditionalOnCorr;
    const verdict = `${pass ? "PASS" : "DID NOT PASS"} — primary t ${r.primaryT != null ? r.primaryT.toFixed(3) : "n/a"} vs bar ${e.bar.tRequired}, placebo p95 ${r.placeboP95}${id === "R224" ? `, corr w/ IEF month-end ${r.corrWithIEFmonthEnd}` : ""}`;
    r.verdict = verdict; delete r.primaryT;
    SEAL[id] = { sealedOn: new Date().toISOString().slice(0, 10), unit: e.bar.unit, verdict };
    e.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict;
    fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: id, verdict }) + "\n");
  }
  writeJsonAtomic(D("read-seals.json"), seals); reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  writeJsonAtomic(D("r220-r224-mine7.json"), { spec: "mine7-v1", ranAt: new Date().toISOString(), results });
  console.log(JSON.stringify(results, null, 1));
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
