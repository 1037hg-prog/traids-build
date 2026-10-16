#!/usr/bin/env node
/**
 * R212-R215 — MINING ROUND 6 (registered 2026-09-24 by register-mine6.js before this file ran; rules frozen in the registry).
 *   R212 UUP month-end, signed by SPY-minus-EFA month-to-date      R213 SPY FOMC-cycle even weeks
 *   R214 GLD overnight (close -> next open)                          R215 SPY pre-holiday day
 * Each read is sealed once. Implementation notes (disclosed, not rule changes):
 *   N1 R212 "window length in sessions" = 3 (two full sessions + the night into the last day) for the other-day baseline.
 *   N2 R213 FOMC dates are parsed from r196-pre-fomc.js's hard-coded list (federalreserve.gov); that file is read as text, never required.
 *   N3 R213 cost: 2 bps charged on the first and last day of every contiguous even-week run.
 *   N4 R215 holidays come from SPY's own bar calendar (a weekday with no bar between two trading days).
 *   node backend/r212-r215-mine6.js
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f);
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")), SEAL = seals.tests || seals;
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = (id) => reg.preregistered.find((t) => t.id === id);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); }, tOf = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(0.95 * s.length)]; };
const START = "2016-01-01", END = "2026-08-31", inRange = (d) => d >= START && d <= END;
const src = fs.readFileSync(path.join(__dirname, "r196-pre-fomc.js"), "utf8");
const block = src.slice(src.indexOf("const FOMC = ["), src.indexOf("];", src.indexOf("const FOMC = [")));
const FOMC = [...block.matchAll(/"(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]).filter(inRange);
(async () => {
  const { bars } = await fetchBars(["SPY", "EFA", "UUP", "GLD", "SLV"], { start: "2015-11-01", end: END, feed: "sip", adjustment: "all", quiet: true });
  const B = {}; for (const s of Object.keys(bars)) B[s] = bars[s].map((b) => ({ d: b.t.slice(0, 10), o: b.o, c: b.c }));
  const results = {};

  // ---------- R212 ----------
  { const idx = (s) => { const m = new Map(); B[s].forEach((b, i) => m.set(b.d, i)); return m; };
    const iSPY = idx("SPY"), iEFA = idx("EFA"), U = B.UUP, months = {};
    U.forEach((b, i) => { (months[b.d.slice(0, 7)] = months[b.d.slice(0, 7)] || []).push(i); });
    const ms = Object.keys(months).sort().filter((m) => m >= "2016-01" && m <= "2026-08");
    const mtd = (sym, im, prevLastDate, d) => { const a = B[sym][im.get(prevLastDate)], b = B[sym][im.get(d)]; return a && b ? b.c / a.c - 1 : null; };
    function rows(entryK) {   // entryK(len) -> index within month of the entry close; exit = open of entry+3
      const out = [];
      for (const m of ms) { const ix = months[m], prev = months[ms[ms.indexOf(m) - 1]] || months[Object.keys(months).sort().filter((x) => x < m).pop()]; if (!prev || ix.length < 15) continue;
        const k = entryK(ix.length), e = ix[k], x = ix[k + 3]; if (x === undefined) continue;
        const prevLast = U[prev[prev.length - 1]].d, ed = U[e].d; const s1 = mtd("SPY", iSPY, prevLast, ed), s2 = mtd("EFA", iEFA, prevLast, ed); if (s1 == null || s2 == null) continue;
        const S = s1 - s2, pos = S > 0 ? -1 : 1, win = U[x].o / U[e].c - 1;
        const other = ix.filter((j, q) => q !== 0 && (q < k + 1 || q > k + 3)).map((j) => U[j].c / U[j - 1].c - 1), base = 3 * mean(other);
        out.push({ m, S, pos, v: pos * (win - base) - 0.0004, raw: win - base, rev: pos * (U[x].c / U[x].o - 1) }); }
      return out; }
    const R = rows((L) => L - 4), MID = rows(() => 6), t = tOf(R.map((r) => r.v));
    const rng = mulberry(212000), draws = []; for (let k = 0; k < 200; k++) draws.push(tOf(R.map((r) => (rng() < 0.5 ? 1 : -1) * r.raw - 0.0004)));
    const big = [...R].sort((a, b) => Math.abs(b.S) - Math.abs(a.S)).slice(0, Math.floor(R.length / 2));
    results.R212 = { months: R.length, meanPct: +(100 * mean(R.map((r) => r.v))).toFixed(3), t: +t.toFixed(3), topHalfAbsS_t: +tOf(big.map((r) => r.v)).toFixed(2), unconditionalUUP_t: +tOf(R.map((r) => r.raw)).toFixed(2), midMonthFalsifier_t: +tOf(MID.map((r) => r.v)).toFixed(2), lastDayReversal_t: +tOf(R.map((r) => -r.rev)).toFixed(2), placeboP95: +p95(draws).toFixed(3), primaryT: t }; }

  // ---------- R213 ----------
  { const S = B.SPY.filter((b) => b.d >= "2015-12-01"), di = new Map(S.map((b, i) => [b.d, i])); const f0 = FOMC.map((d) => di.get(d)).filter((i) => i !== undefined);
    function cycles(shift) {
      const out = [], evenDaily = [];
      for (let c = 0; c + 1 < f0.length; c++) { const a = f0[c], z = f0[c + 1]; const ev = [], od = []; let prevEven = false; const days = [];
        for (let i = a - 1; i <= z - 2; i++) { if (i < 1) continue; const k = i - a, w = Math.floor((k + 1 + shift) / 5), even = w % 2 === 0; days.push({ i, even, r: S[i].c / S[i - 1].c - 1 }); }
        days.forEach((x, j) => { if (!x.even) { od.push(x.r); return; } let r = x.r; if (j === 0 || !days[j - 1].even) r -= 0.0002; if (j === days.length - 1 || !days[j + 1].even) r -= 0.0002; ev.push(r); evenDaily.push({ d: S[x.i].d, r }); });
        if (ev.length && od.length) out.push({ d: S[a].d, v: 5 * (mean(ev) - mean(od)) }); }
      return { out, evenDaily }; }
    const { out, evenDaily } = cycles(0), t = tOf(out.map((x) => x.v)); const post = out.filter((x) => x.d >= "2019-06-01");
    const rng = mulberry(213000), draws = []; for (let k = 0; k < 200; k++) draws.push(tOf(cycles(1 + Math.floor(rng() * 9)).out.map((x) => x.v)));
    const allDaily = S.slice(1).filter((b) => b.d >= evenDaily[0].d && b.d <= evenDaily[evenDaily.length - 1].d).map((b, i) => b.c / S[di.get(b.d) - 1].c - 1);
    const evSet = new Map(evenDaily.map((x) => [x.d, x.r])); const strat = S.slice(1).filter((b) => b.d >= evenDaily[0].d && b.d <= evenDaily[evenDaily.length - 1].d).map((b) => evSet.get(b.d) ?? 0);
    const sh = (a) => (mean(a) / sd(a)) * Math.sqrt(252);
    results.R213 = { cycles: out.length, fomcDates: FOMC.length, meanWeeklyDiffPct: +(100 * mean(out.map((x) => x.v))).toFixed(3), t: +t.toFixed(3), postPublication_t: +tOf(post.map((x) => x.v)).toFixed(2), postPublicationCycles: post.length, evenOnlySharpe: +sh(strat).toFixed(2), buyHoldSharpe: +sh(allDaily).toFixed(2), placeboP95: +p95(draws).toFixed(3), primaryT: t }; }

  // ---------- R214 ----------
  { function legs(sym) { const b = B[sym], out = []; for (let i = 1; i < b.length; i++) if (inRange(b[i].d)) out.push({ m: b[i].d.slice(0, 7), on: b[i].o / b[i - 1].c - 1, id: b[i].c / b[i].o - 1 }); return out; }
    const monthly = (L, f) => { const o = {}; for (const x of L) o[x.m] = (o[x.m] || 0) + f(x); return Object.values(o); };
    const G = legs("GLD"), net = monthly(G, (x) => x.on - 0.0002), t = tOf(net);
    const rng = mulberry(214000), draws = []; for (let k = 0; k < 200; k++) draws.push(tOf(monthly(G, (x) => (rng() < 0.5 ? x.on : x.id) - 0.0002)));
    results.R214 = { months: net.length, netMonthlyPct: +(100 * mean(net)).toFixed(3), t: +t.toFixed(3), gross_t: +tOf(monthly(G, (x) => x.on)).toFixed(2), grossAnnualPct: +(1200 * mean(monthly(G, (x) => x.on))).toFixed(2), intraday_t: +tOf(monthly(G, (x) => x.id)).toFixed(2), onMinusId_t: +tOf(monthly(G, (x) => x.on - x.id)).toFixed(2), SLV_gross_t: +tOf(monthly(legs("SLV"), (x) => x.on)).toFixed(2), SPY_gross_t: +tOf(monthly(legs("SPY"), (x) => x.on)).toFixed(2), placeboP95: +p95(draws).toFixed(3), primaryT: t }; }

  // ---------- R215 ----------
  { const S = B.SPY, set = new Set(S.map((b) => b.d)), addDay = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const nextWeekday = (d) => { let x = addDay(d, 1); while ([0, 6].includes(new Date(x + "T12:00:00Z").getUTCDay())) x = addDay(x, 1); return x; };
    const yr = {}; for (let i = 1; i < S.length; i++) if (inRange(S[i].d)) (yr[S[i].d.slice(0, 4)] = yr[S[i].d.slice(0, 4)] || []).push(S[i].c / S[i - 1].c - 1);
    const ym = Object.fromEntries(Object.entries(yr).map(([y, a]) => [y, mean(a)]));
    const ev = [], after = [], nonIdx = {};
    for (let i = 1; i + 1 < S.length; i++) { const d = S[i].d; if (!inRange(d)) continue; const nw = nextWeekday(d);
      if (!set.has(nw) && nw < S[S.length - 1].d) { const dow = new Date(nw + "T12:00:00Z").getUTCDay(); ev.push({ d, v: S[i].c / S[i - 1].c - 1 - 0.0004 - ym[d.slice(0, 4)], longWeekend: dow === 1 || dow === 5 }); after.push(S[i + 1].c / S[i].c - 1 - ym[d.slice(0, 4)]); }
      else (nonIdx[d.slice(0, 4)] = nonIdx[d.slice(0, 4)] || []).push(i); }
    const t = tOf(ev.map((x) => x.v)), perYear = {}; ev.forEach((x) => (perYear[x.d.slice(0, 4)] = (perYear[x.d.slice(0, 4)] || 0) + 1));
    const rng = mulberry(215000), draws = []; for (let k = 0; k < 200; k++) { const s = []; for (const [y, n] of Object.entries(perYear)) for (let j = 0; j < n; j++) { const i = nonIdx[y][Math.floor(rng() * nonIdx[y].length)]; s.push(S[i].c / S[i - 1].c - 1 - 0.0004 - ym[y]); } draws.push(tOf(s)); }
    results.R215 = { events: ev.length, meanPct: +(100 * mean(ev.map((x) => x.v))).toFixed(3), t: +t.toFixed(3), dayAfter_t: +tOf(after).toFixed(2), longWeekend_t: +tOf(ev.filter((x) => x.longWeekend).map((x) => x.v)).toFixed(2), midweek_t: +tOf(ev.filter((x) => !x.longWeekend).map((x) => x.v)).toFixed(2), placeboP95: +p95(draws).toFixed(3), primaryT: t }; }

  if (process.argv.includes("--dry")) { console.log("DRY (counts only):", JSON.stringify({ R212: results.R212.months, R213: [results.R213.cycles, results.R213.fomcDates, results.R213.postPublicationCycles], R214: results.R214.months, R215: results.R215.events })); return; }
  // ---------- verdicts + seals ----------
  for (const id of ["R212", "R213", "R214", "R215"]) {
    const r = results[id], e = E(id); if (SEAL[id]) { console.log(`${id} already sealed — skipped`); delete r.primaryT; continue; }
    const pass = r.primaryT >= e.bar.tRequired && r.primaryT > r.placeboP95;
    const verdict = `${pass ? "PASS" : "DID NOT PASS"} — primary t ${r.primaryT.toFixed(3)} vs bar ${e.bar.tRequired}, placebo p95 ${r.placeboP95}`;
    r.verdict = verdict; delete r.primaryT;
    SEAL[id] = { sealedOn: new Date().toISOString().slice(0, 10), unit: e.bar.unit, verdict };
    e.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict;
    fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: id, verdict }) + "\n");
  }
  writeJsonAtomic(D("read-seals.json"), seals); reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  writeJsonAtomic(D("r212-r215-mine6.json"), { spec: "mine6-v1", ranAt: new Date().toISOString(), results });
  console.log(JSON.stringify(results, null, 1));
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
