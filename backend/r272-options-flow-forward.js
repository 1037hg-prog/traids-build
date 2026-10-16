#!/usr/bin/env node
/**
 * R272 — OPTIONS WHALE PRINTS, FORWARD (registered 2026-09-27; evidence from 2026-09-28). Grades the daily Schwab chain record
 * written by backend/options-flow-record.js. Rule frozen in backend/register-r271-r272.js (the registry wins on any conflict):
 *   whale contract on day d: DTE 1..45; OTM 2..25% vs the underlying's RAW close on d; volume >= 500; premium = volume x mid x 100
 *   (last if no mid) >= $500k; volume >= 5 x open interest (OI 0 treated as 100).
 *   Name-day direction = sign(call premium - put premium). Enter d+1 OPEN, exit d+5 CLOSE, signed, adjusted, minus 20 bps.
 *   Clustered by signal date; t over dates; bar 1.676 at >= 60 signal dates and >= 90 days; timing control (same name, same
 *   direction, random recorded non-signal day, 1,000 draws) must also be beaten at p95. Incomplete record days are excluded.
 *
 *   node backend/r272-options-flow-forward.js          nightly: grade whatever has matured, write data/r272-options-flow-forward.json
 *   node backend/r272-options-flow-forward.js --read   the one registered read (refuses before the read condition)
 */
"use strict";
const fs = require("fs"), path = require("path");
const { fetchBars } = require("./lib/alpaca-bars.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), DIR = D("options-flow"), OUT = D("r272-options-flow-forward.json");
const START = "2026-09-28", MIN_DATES = 60, MIN_DAYS = 90, BAR = 1.676, HOLD = 5, COST = 0.002, DRAWS = 1000;
const MIN_VOL = 500, MIN_PREM = 500000, SPIKE = 5, DTE_MAX = 45, OTM_MIN = 0.02, OTM_MAX = 0.25;
const READ = process.argv.includes("--read");
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length >= 3 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
const dte = (d, exp) => Math.round((Date.parse(exp + "T12:00:00Z") - Date.parse(d + "T12:00:00Z")) / 864e5);

(async () => {
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) >= START).sort() : [];
  const days = [], excluded = [];
  for (const f of files) { const j = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); (j.complete ? days : excluded).push(j); }
  const base = { test: "R272", asOf: new Date().toISOString(), recordedDays: days.length, excludedIncompleteDays: excluded.map((j) => j.date) };
  if (!days.length) { writeJsonAtomic(OUT, { ...base, dailyClock: { sessions: 0, unit: "signal dates graded since 2026-09-28", estimate: null }, note: "no complete record days yet" }); return console.log("R272: no complete record days yet (first snapshot 2026-09-28 15:30-15:55 ET)"); }
  const names = [...new Set(days.flatMap((j) => Object.keys(j.names)))].sort();
  const endIso = new Date(Date.now() - 20 * 60000).toISOString();
  const raw = (await fetchBars(names, { start: "2026-09-20", end: endIso, feed: "sip", adjustment: "raw", quiet: true, requireAll: false })).bars;
  const adj = (await fetchBars(names, { start: "2026-09-20", end: endIso, feed: "sip", adjustment: "all", quiet: true, requireAll: false })).bars;
  const P = {}; for (const s of names) { const b = adj[s] || [], r = raw[s] || []; P[s] = { cal: b.map((x) => x.t.slice(0, 10)), o: b.map((x) => x.o), c: b.map((x) => x.c), rawClose: new Map(r.map((x) => [x.t.slice(0, 10), x.c])) }; P[s].idx = new Map(P[s].cal.map((d, i) => [d, i])); }
  const ret = (s, d, dir, h) => { const p = P[s]; const i = p.idx.get(d); if (i == null || i + h >= p.cal.length) return null; return dir * (p.c[i + h] / p.o[i + 1] - 1); };

  const signals = [], nameDays = [];
  for (const j of days) for (const [s, n] of Object.entries(j.names)) {
    const spot = P[s] && P[s].rawClose.get(j.date); if (!spot) continue; nameDays.push({ s, d: j.date });
    let net = 0, n0 = 0;
    for (const [occ, exp, right, strike, vol, oi, bid, ask, last] of n.rows) {
      const k = dte(j.date, exp); if (k < 1 || k > DTE_MAX || vol < MIN_VOL) continue;
      const otm = right === "C" ? strike / spot - 1 : 1 - strike / spot; if (otm < OTM_MIN || otm > OTM_MAX) continue;
      const px = bid > 0 && ask > 0 ? (bid + ask) / 2 : last; const prem = vol * px * 100; if (prem < MIN_PREM) continue;
      if (vol < SPIKE * (oi > 0 ? oi : 100)) continue;
      net += right === "C" ? prem : -prem; n0++;
    }
    if (n0 && net !== 0) signals.push({ s, d: j.date, dir: net > 0 ? 1 : -1, netPremium: Math.round(net), contracts: n0 });
  }
  const clustered = (rows, h, cost) => { const byD = new Map(); for (const r of rows) { const x = ret(r.s, r.d, r.dir, h); if (x == null) continue; if (!byD.has(r.d)) byD.set(r.d, []); byD.get(r.d).push(x - cost); }
    const per = [...byD.values()].map(mean); return { dates: per.length, signals: [...byD.values()].reduce((a, v) => a + v.length, 0), meanPct: per.length ? +(100 * mean(per)).toFixed(4) : null, t: per.length >= 3 ? +(tOf(per) ?? 0).toFixed(3) : null }; };
  const prim = clustered(signals, HOLD, COST), gross = clustered(signals, HOLD, 0);
  const daysSince = Math.floor((Date.now() - Date.parse(START + "T12:00:00Z")) / 864e5);
  const out = { ...base, rule: "vol >= 5x OI, OTM 2-25%, DTE 1-45, vol >= 500, premium >= $500k; d+1 open to d+5 close, 20 bps", signalsRecorded: signals.length,
    primary5dNet: prim, gross5d: gross, bar: BAR, readCondition: `>= ${MIN_DATES} graded signal dates AND >= ${MIN_DAYS} days since ${START}`, daysSinceStart: daysSince,
    dailyClock: { sessions: prim.dates, unit: "signal dates graded since 2026-09-28", estimate: prim.meanPct }, recentSignals: signals.slice(-25) };
  if (READ) {
    const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests.R272) throw new Error("R272 already sealed — read-once");
    if (prim.dates < MIN_DATES || daysSince < MIN_DAYS) throw new Error(`read condition not met: ${prim.dates} dates, ${daysSince} days`);
    const sigKey = new Set(signals.map((r) => r.s + "|" + r.d)), pools = {}; for (const r of nameDays) if (!sigKey.has(r.s + "|" + r.d)) (pools[r.s] = pools[r.s] || []).push(r.d);
    let seed = 272272; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const ctrl = []; for (let k = 0; k < DRAWS; k++) ctrl.push(clustered(signals.filter((r) => pools[r.s] && pools[r.s].length).map((r) => ({ s: r.s, d: pools[r.s][Math.floor(rnd() * pools[r.s].length)], dir: r.dir })), HOLD, COST).meanPct);
    ctrl.sort((a, b) => a - b); const p95 = ctrl[Math.floor(0.95 * DRAWS)], pass = prim.t >= BAR && prim.meanPct > p95;
    const verdict = `${pass ? "PASSED" : "DID NOT PASS"} — net ${prim.meanPct}%/date t ${prim.t} (${prim.dates} dates, ${prim.signals} signals) vs bar ${BAR}; timing control p95 ${p95}%`;
    Object.assign(out, { read: { verdict, controlP95MeanPct: p95, pass } });
    seals.tests = seals.tests || {}; seals.tests.R272 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "signal dates, one-sample t", verdict, output: "data/r272-options-flow-forward.json" };
    writeJsonAtomic(D("read-seals.json"), seals);
    fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", tests: ["R272"], detail: verdict }) + "\n");
    console.log(verdict);
  }
  writeJsonAtomic(OUT, out);
  console.log(`R272: ${days.length} record days (${excluded.length} incomplete excluded), ${signals.length} signals, ${prim.dates} dates graded${prim.dates ? `, running net ${prim.meanPct}%` : ""} — read at ${MIN_DATES} dates / ${MIN_DAYS} days`);
})().catch((e) => { console.error("R272 FAILED:", e.message); process.exit(1); });
