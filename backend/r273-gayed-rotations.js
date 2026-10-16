#!/usr/bin/env node
/**
 * R273 — Gayed & Bilello intermarket rotations, post-publication (registered 2026-09-27 in backend/register-r273.js; the registry wins).
 *   V1 utilities: XLU vs SPY, 20 sessions -> XLU if ahead else SPY
 *   V2 treasuries: IEF vs TLT, 20 sessions -> SPY if IEF ahead else IEF
 *   V3 lumber/gold: LBR=F vs GLD, 65 sessions -> SPY if lumber ahead else IEF
 * Weekly: signal at the week's last close, held open-to-open from the next session. 5 bps a side per switch.
 * Statistic: weekly active return vs a static mix at the variant's own time-in-each; t over weeks; bar 2.104 (best-of-3);
 * timing control = 1,000 circular shifts of the variant's own signal sequence (PASS needs mean > shift p95).
 *
 *   node backend/r273-gayed-rotations.js --selftest   known answer: a never-switching signal must give active = 0 exactly
 *   node backend/r273-gayed-rotations.js --read       the one registered read (refuses if sealed)
 */
"use strict";
const fs = require("fs"), path = require("path");
const { fetchBars } = require("./lib/alpaca-bars.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), OUT = D("r273-gayed-rotations.json");
const START = "2016-02-01", BAR = 2.104, COST_SIDE = 0.0005, DRAWS = 1000;
const mode = ["--selftest", "--read"].find((m) => process.argv.includes(m)) || "--selftest";
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
const stats = (r) => { let v = 1, pk = 1, dd = 0; for (const x of r) { v *= 1 + x; pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); } return { cagrPct: +(100 * (v ** (52 / r.length) - 1)).toFixed(2), maxDDPct: +(100 * dd).toFixed(1), sharpe: +((mean(r) / sd(r)) * Math.sqrt(52)).toFixed(2) }; };
const weekKey = (d) => { const t = new Date(d + "T12:00:00Z"), day = (t.getUTCDay() + 6) % 7; return new Date(t.getTime() - day * 864e5).toISOString().slice(0, 10); };

async function load() {
  const syms = ["SPY", "XLU", "IEF", "TLT", "GLD", "IWM"];
  const r = await fetchBars(syms, { start: "2015-06-01", end: new Date(Date.now() - 20 * 60e3).toISOString(), feed: "sip", adjustment: "all", quiet: true, requireAll: true });
  const P = {}; for (const s of syms) P[s] = new Map(r.bars[s].map((b) => [b.t.slice(0, 10), { o: b.o, c: b.c }]));
  const j = await (await fetch("http://localhost:3002/api/yahoo/" + encodeURIComponent("LBR=F") + "/history?days=4200&interval=1d", { signal: AbortSignal.timeout(60000) })).json();
  const lbr = (j.bars || []).filter((b) => b.close > 0).map((b) => ({ d: b.date, c: b.close }));
  const cal = r.bars.SPY.map((b) => b.t.slice(0, 10));
  return { P, lbr, cal, spyStart: cal[0] };
}

/** Build weekly rows: for each week, signal-day index, entry/exit open indices. */
function weeks(cal) {
  const lastOfWeek = []; for (let i = 0; i < cal.length; i++) if (i === cal.length - 1 || weekKey(cal[i + 1]) !== weekKey(cal[i])) lastOfWeek.push(i);
  const out = []; for (let k = 0; k + 1 < lastOfWeek.length; k++) { const s = lastOfWeek[k], e = s + 1, x = lastOfWeek[k + 1] + 1; if (x >= cal.length) break; out.push({ s, e, x, d: cal[s] }); }
  return out;
}

function runVariant(W, cal, P, sigFn, onAsset, offAsset, from) {
  const rows = [];
  for (const w of W) { if (cal[w.s] < from) continue; const st = sigFn(w.s); if (st == null) continue;
    const r = (sym) => P[sym].get(cal[w.x]).o / P[sym].get(cal[w.e]).o - 1; rows.push({ d: w.d, on: st, rOn: r(onAsset), rOff: r(offAsset) }); }
  return rows;
}
function grade(rows, states) {
  const n = rows.length, p = states.filter(Boolean).length / n; let prev = null; const strat = [], mix = [];
  for (let i = 0; i < n; i++) { const on = states[i]; let x = on ? rows[i].rOn : rows[i].rOff; if (prev !== null && on !== prev) x -= 2 * COST_SIDE; prev = on; strat.push(x); mix.push(p * rows[i].rOn + (1 - p) * rows[i].rOff); }
  const act = strat.map((x, i) => x - mix[i]); return { strat, mix, act, p, switches: states.reduce((a, s, i) => a + (i && s !== states[i - 1] ? 1 : 0), 0) };
}
function evaluate(rows, label) {
  const states = rows.map((r) => r.on), g = grade(rows, states), n = rows.length;
  let seed = 273273; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const shifts = []; for (let k = 0; k < DRAWS; k++) { const off = 1 + Math.floor(rnd() * (n - 1)); const sh = states.map((_, i) => states[(i + off) % n]); shifts.push(mean(grade(rows, sh).act)); }
  shifts.sort((a, b) => a - b); const p95 = shifts[Math.floor(0.95 * DRAWS)], t = tOf(g.act), m = mean(g.act);
  return { label, weeks: n, from: rows[0].d, to: rows[n - 1].d, timeInOffense: +g.p.toFixed(3), switches: g.switches,
    strategy: stats(g.strat), staticMix: stats(g.mix), spyBuyHold: stats(rows.map((r) => r.rOnSpy ?? r.rOn)),
    activeWeeklyBps: +(1e4 * m).toFixed(2), activeAnnualPct: +(100 * m * 52).toFixed(2), t: +t.toFixed(3), shiftP95Bps: +(1e4 * p95).toFixed(2),
    pass: t >= BAR && m > p95 };
}

(async () => {
  const { P, lbr, cal } = await load(); const W = weeks(cal), idx = new Map(cal.map((d, i) => [d, i]));
  const lb = (sym, i, L) => (i - L >= 0 && P[sym].get(cal[i]) && P[sym].get(cal[i - L]) ? P[sym].get(cal[i]).c / P[sym].get(cal[i - L]).c - 1 : null);
  const lbrIdx = new Map(lbr.map((b, i) => [b.d, i]));
  const lumber = (i, L) => { let k = null; for (let j = i; j >= Math.max(0, i - 5); j--) if (lbrIdx.has(cal[j])) { k = lbrIdx.get(cal[j]); break; } return k != null && k - L >= 0 ? lbr[k].c / lbr[k - L].c - 1 : null; };
  if (mode === "--selftest") {
    const rows = runVariant(W, cal, P, () => true, "SPY", "IEF", START), g = grade(rows, rows.map(() => true));
    const maxAbs = Math.max(...g.act.map(Math.abs)); console.log(`selftest: never-switching signal, ${rows.length} weeks, max |active| = ${maxAbs} (${maxAbs < 1e-12 ? "OK" : "FAIL"})`);
    console.log(`lumber LBR=F: ${lbr.length} bars from ${lbr[0] && lbr[0].d}; SPY calendar from ${cal[0]}`); process.exit(maxAbs < 1e-12 ? 0 : 1);
  }
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests.R273) throw new Error("R273 already sealed — read-once");
  const sig = {
    V1: (i) => { const a = lb("XLU", i, 20), b = lb("SPY", i, 20); return a == null || b == null ? null : !(a > b); },   // on = SPY (offense) when XLU NOT ahead
    V2: (i) => { const a = lb("IEF", i, 20), b = lb("TLT", i, 20); return a == null || b == null ? null : a > b; },
    V3: (i) => { const a = lumber(i, 65), b = lb("GLD", i, 65); return a == null || b == null ? null : a > b; },
  };
  const R = {
    V1: runVariant(W, cal, P, sig.V1, "SPY", "XLU", START), V2: runVariant(W, cal, P, sig.V2, "SPY", "IEF", START), V3: runVariant(W, cal, P, sig.V3, "SPY", "IEF", START),
  };
  const primary = { V1: evaluate(R.V1, "utilities 4wk: SPY / XLU"), V2: evaluate(R.V2, "10y vs 30y 20d: SPY / IEF"), V3: evaluate(R.V3, "lumber vs gold 13wk: SPY / IEF") };
  // secondary (not graded)
  const half = (rows, lo, hi) => rows.filter((r) => r.d >= lo && r.d <= hi);
  const trendOn = (d) => { const me = {}; for (const [k, v] of P.SPY) if (k <= d) me[k.slice(0, 7)] = v.c; const ms = Object.keys(me).sort(); if (ms.length < 11) return null; const cur = ms.at(-1) === d.slice(0, 7) ? ms.slice(0, -1) : ms; const last10 = cur.slice(-10).map((m) => me[m]); return me[cur.at(-1)] > mean(last10); };
  const agree = (rows) => { const a = rows.map((r) => { const t = trendOn(r.d); return t == null ? null : t === r.on; }).filter((x) => x != null); return +(a.filter(Boolean).length / a.length).toFixed(3); };
  const secondary = {
    V2_TLT: evaluate(runVariant(W, cal, P, sig.V2, "SPY", "TLT", START), "V2 with TLT"), V3_TLT: evaluate(runVariant(W, cal, P, sig.V3, "SPY", "TLT", START), "V3 with TLT"),
    V3_IWM: evaluate(runVariant(W, cal, P, sig.V3, "IWM", "IEF", START), "V3 with IWM offense"),
    V1_2016_2021: evaluate(half(R.V1, "2016", "2021-12-31"), "V1 2016-21"), V1_2022_2026: evaluate(half(R.V1, "2022", "2026-12-31"), "V1 2022-26"),
    V2_2016_2021: evaluate(half(R.V2, "2016", "2021-12-31"), "V2 2016-21"), V2_2022_2026: evaluate(half(R.V2, "2022", "2026-12-31"), "V2 2022-26"),
    agreementWith10MonthTrend: { V1: agree(R.V1), V2: agree(R.V2), V3: agree(R.V3) },
  };
  const pass = Object.values(primary).some((v) => v.pass);
  const line = (k) => `${k} active ${primary[k].activeAnnualPct}%/yr t ${primary[k].t} (${primary[k].weeks} wks, shift p95 ${primary[k].shiftP95Bps} bps/wk vs ${primary[k].activeWeeklyBps})`;
  const verdict = `${pass ? "PASSED" : "DID NOT PASS"} — bar ${BAR}: ${line("V1")}; ${line("V2")}; ${line("V3")}`;
  writeJsonAtomic(OUT, { test: "R273", readAt: new Date().toISOString(), verdict, primary, secondary });
  seals.tests = seals.tests || {}; seals.tests.R273 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "weeks, one-sample t on active return vs static mix; best-of-3 bar", verdict, output: "data/r273-gayed-rotations.json" };
  writeJsonAtomic(D("read-seals.json"), seals);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", tests: ["R273"], detail: verdict }) + "\n");
  console.log(verdict); console.log(JSON.stringify({ primary, secondary }, null, 1));
})().catch((e) => { console.error("R273 FAILED:", e.message); process.exit(1); });
