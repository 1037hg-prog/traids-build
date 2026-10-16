#!/usr/bin/env node
/**
 * R279 — Tax-loss-selling reversal. Registered 2026-09-28 in backend/register-r276-r280.js (the registry wins).
 *   Year-end Y = 2016..2025: universe pitTopN(Y, 1000) from the anomaly-cache-v2 panel (stocks only, active + delisted), close >= $5 at
 *   formation; YTD = close(last session <= Dec 15, Y) / close(last session of Y-1) - 1. V1 bottom decile by YTD; V2 = V1 names at
 *   <= 0.60 x their max close over the prior 252 sessions. Buy close of the last December session, sell close of the 5th January
 *   session. 20 bps round trip. Statistic: per-year EW net minus IWM, t over 10 year-ends, bar 2.307 (best-of-2); PASS also needs
 *   the mean above the random-draw p95 (same count, same year's universe, 1,000 draws).
 *
 *   node backend/r279-tax-loss-reversal.js --selftest   universe sizes and formation dates only (no returns)
 *   node backend/r279-tax-loss-reversal.js --read       the one registered read (refuses if sealed)
 *
 * NOTES (fixed before any outcome): N1 panel close is adjustment=all (splits+dividends). N2 a name whose exit close is missing is
 * valued at its last valid close in (entry, exit]; a name with no valid entry close is not eligible. N3 prior-252 max uses sessions
 * t-251..t (formation day included). N4 IWM from Alpaca SIP daily adjustment=all. N5 (found by --selftest, before any
 * return was computed) the panel starts 2016-01-04, so year-end 2016's YTD base is that first session's close, not 2015-12-31's;
 * its universe is pitTopN's disclosed year-1 fallback (first 60 sessions of 2016).
 */
"use strict";
const fs = require("fs"), path = require("path");
const { panel, pitTopN } = require("./lib/tv-pit-panel.js");
const { fetchBars } = require("./lib/alpaca-bars.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), OUT = D("r279-tax-loss-reversal.json");
const BAR = 2.307, COST = 0.002, DRAWS = 1000, YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const mode = ["--selftest", "--read"].find((m) => process.argv.includes(m)) || "--selftest";
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);

function forms() {
  const p = panel(), DT = p.DATES, lastIdx = (pred) => { let k = -1; for (let t = 0; t < DT.length; t++) if (pred(DT[t])) k = t; return k; };
  return YEARS.map((Y) => {
    const base = Math.max(0, lastIdx((d) => d <= `${Y - 1}-12-31`)), f = lastIdx((d) => d <= `${Y}-12-15`), entry = lastIdx((d) => d <= `${Y}-12-31`);
    const jan = []; for (let t = entry + 1; t < DT.length && jan.length < 5; t++) if (DT[t].startsWith(`${Y + 1}-01`)) jan.push(t);
    const exit = jan.length === 5 ? jan[4] : null;
    const uni = pitTopN(Y, 1000).names.map((s) => p.idx.get(s)).filter((s) => s != null);
    const rows = [];
    for (const s of uni) { const cb = p.c(s, base), cf = p.c(s, f), ce = p.c(s, entry); if (!(cb > 0) || !(cf >= 5) || !(ce > 0)) continue;
      let mx = 0; for (let t = Math.max(0, f - 251); t <= f; t++) { const c = p.c(s, t); if (c > mx) mx = c; }
      let cx = null; if (exit != null) for (let t = exit; t > entry; t--) { const c = p.c(s, t); if (c > 0) { cx = c; break; } }
      rows.push({ sym: p.SYMS[s], ytd: cf / cb - 1, offHigh: cf / mx, ret: cx != null ? cx / ce - 1 : 0 }); }
    rows.sort((a, b) => a.ytd - b.ytd);
    return { Y, base: p.DATES[base], formation: p.DATES[f], entry: p.DATES[entry], exit: exit != null ? p.DATES[exit] : null, universe: rows.length, rows };
  });
}

(async () => {
  const F = forms();
  if (mode === "--selftest") { for (const x of F) console.log(`${x.Y}: base ${x.base} form ${x.formation} entry ${x.entry} exit ${x.exit} universe ${x.universe} decile ${Math.floor(x.universe / 10)}`); process.exit(F.every((x) => x.exit && x.universe > 500) ? 0 : 1); }
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests.R279) throw new Error("R279 already sealed — read-once");
  const iwm = (await fetchBars(["IWM"], { start: "2016-12-01", end: "2026-01-31T23:00:00Z", feed: "sip", adjustment: "all", quiet: true, requireAll: true })).bars.IWM;
  const ic = new Map(iwm.map((b) => [b.t.slice(0, 10), b.c]));
  let seed = 279279; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const years = F.map((x) => {
    const k = Math.floor(x.rows.length / 10), v1 = x.rows.slice(0, k), v2 = v1.filter((r) => r.offHigh <= 0.6), top = x.rows.slice(-k);
    const bench = ic.get(x.exit) / ic.get(x.entry) - 1, ew = (a) => (a.length ? mean(a.map((r) => r.ret - COST)) : null);
    const draws = []; for (let d = 0; d < DRAWS; d++) { const pick = []; const used = new Set(); while (pick.length < k) { const i = Math.floor(rnd() * x.rows.length); if (!used.has(i)) { used.add(i); pick.push(x.rows[i]); } } draws.push(ew(pick) - bench); }
    return { Y: x.Y, entry: x.entry, exit: x.exit, n1: v1.length, n2: v2.length, iwmPct: +(100 * bench).toFixed(3), v1: ew(v1) - bench, v2: v2.length ? ew(v2) - bench : null, v1Raw: ew(v1), top: ew(top) - bench, draws };
  });
  const v1 = years.map((y) => y.v1), v2 = years.filter((y) => y.v2 != null).map((y) => y.v2);
  const drawMeans = []; for (let d = 0; d < DRAWS; d++) drawMeans.push(mean(years.map((y) => y.draws[d]))); drawMeans.sort((a, b) => a - b); const p95 = drawMeans[Math.floor(0.95 * DRAWS)];
  const t1 = tOf(v1), t2 = tOf(v2), pass = (t1 >= BAR && mean(v1) > p95) || (t2 >= BAR && mean(v2) > p95);
  const verdict = `${pass ? "PASSED" : "DID NOT PASS"} — bar ${BAR}, 10 year-ends: V1 bottom-decile losers vs IWM ${(100 * mean(v1)).toFixed(3)}%/window t ${t1.toFixed(3)}; V2 deep losers ${(100 * mean(v2)).toFixed(3)}% t ${t2.toFixed(3)} (${v2.length} yrs); random-draw p95 ${(100 * p95).toFixed(3)}%; winners (top decile) ${(100 * mean(years.map((y) => y.top))).toFixed(3)}%`;
  const out = { test: "R279", readAt: new Date().toISOString(), verdict, bar: BAR, drawP95Pct: +(100 * p95).toFixed(3),
    years: years.map((y) => ({ Y: y.Y, entry: y.entry, exit: y.exit, n1: y.n1, n2: y.n2, iwmPct: y.iwmPct, v1RawPct: +(100 * y.v1Raw).toFixed(3), v1ExPct: +(100 * y.v1).toFixed(3), v2ExPct: y.v2 == null ? null : +(100 * y.v2).toFixed(3), topExPct: +(100 * y.top).toFixed(3) })) };
  writeJsonAtomic(OUT, out);
  seals.tests = seals.tests || {}; seals.tests.R279 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "year-ends, one-sample t on EW net minus IWM; best-of-2 bar", verdict, output: "data/r279-tax-loss-reversal.json" };
  writeJsonAtomic(D("read-seals.json"), seals);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", tests: ["R279"], detail: verdict }) + "\n");
  console.log(verdict); console.log(JSON.stringify(out.years));
})().catch((e) => { console.error("R279 FAILED:", e.message); process.exit(1); });
