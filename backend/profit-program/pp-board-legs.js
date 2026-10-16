#!/usr/bin/env node
/**
 * PROFIT PROGRAM / board legs (read-only printer). The board's strategy-legs on the SAME population the dashboard table uses
 * (lib/reconcile.js cleanEraLedger() signals, controls out, entries stamped outside 09:25-16:00 ET out), plus the hidden bucket.
 * Per leg: tickets, sessions, gross $ (the ledger's pnl), cost-charged $ (non-options: minus riskDollars x costR; options already
 * carry a measured cost), $/session, a session-clustered t (clustered by OPEN session, lib/session.js, the graded key), the risk
 * it ties up (risk-days / sessions in the window) and $ per $1,000 of risk per month (21 sessions). Also the board's effective N
 * (design effect of clustering the tickets' R by open session) and the Breakout concentration check.
 * IN-SAMPLE / EXPLORATORY: every slice printed here is a descriptive cut of past tickets, not a test.
 *   node backend/profit-program/pp-board-legs.js [--since 2026-07-20] [--until 9999-12-31] [--no-write]
 */
"use strict";
const fs = require("fs"), path = require("path");
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SINCE = arg("--since", "2026-07-20"), UNTIL = arg("--until", "9999-12-31");
const rc = require("../lib/reconcile.js"), S = require("../lib/session.js");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const { riskOf, notionalOf } = require("./_common.js");   // implied dollar risk of 1R (units*stopDist, else |pnl/rMult|, else riskDollars) - riskDollars is absent on 1,256 of 2,196 rows
const L = require("./pp-reconcile.js").loadLedger();
const mtDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
const hm = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
const isOvernight = (t) => { const o = t.openedAt || t.addedAt; if (!o) return false; const x = hm(o); return x < "09:25" || x >= "16:00"; };
const inRange = (t) => { const d = mtDay(t.closedAt); return d >= SINCE && d <= UNTIL; };
const cm = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "cost-model.json"), "utf8")).netEdgeByClass || {}; } catch { return {}; } })();
const classCostR = (c) => (cm[c] && Number.isFinite(cm[c].meanCostR) ? cm[c].meanCostR : 0);
const ticketCostR = (t) => (t.cls === "Options" ? 0 : (t.obs && Number.isFinite(t.obs.costR) ? t.obs.costR : classCostR(t.cls)));
const rk = (t) => { const r = riskOf(t); return Number.isFinite(r) ? r : 0; };
// R24 clones carry no stop (R is arbitrary), so their cost is the measured equity round trip (cost-model.json perClass.Equity.roundTripPct) x notional, not costR x R
const RT_EQ = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "cost-model.json"), "utf8")).perClass.Equity.roundTripPct / 100; } catch { return 0.002195; } })();
const costUsd = (t) => (t.strategy === "R24-13F-clone" ? (Number.isFinite(notionalOf(t)) ? RT_EQ * notionalOf(t) : 0) : ticketCostR(t) * rk(t));
const sum = (a) => a.reduce((s, v) => s + v, 0), mean = (a) => (a.length ? sum(a) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1)); };
const tOf = (a) => { const s = sd(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : NaN; };
const bizDays = (aMs, bMs) => { let d = new Date(S.sessionOf(aMs) + "T12:00:00Z"); const e = new Date(S.sessionOf(bMs) + "T12:00:00Z"); let n = 0; while (d < e) { d = new Date(d.getTime() + 864e5); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; } return Math.max(1, n); };

const all = L.signals.filter((t) => !t.ctrl && Number.isFinite(t.pnl) && inRange(t));
const table = all.filter((t) => !isOvernight(t)), hidden = all.filter(isOvernight);
const winSessions = [...new Set(table.concat(hidden).map((t) => mtDay(t.closedAt)))].sort();
const W = winSessions.length;

function leg(label, T) {
  const bySess = {}; for (const t of T) (bySess[S.openSession(t)] ||= []).push(t);
  const sess = Object.keys(bySess).sort();
  const daily = sess.map((d) => sum(bySess[d].map((t) => t.pnl)));
  const dailyNet = sess.map((d) => sum(bySess[d].map((t) => t.pnl - costUsd(t))));
  const gross = sum(T.map((t) => t.pnl)), cost = sum(T.map(costUsd)), net = gross - cost;
  const riskDays = sum(T.map((t) => rk(t) * bizDays(t.openedAt, t.closedAt)));
  const riskAtWork = riskDays / W;
  const perSession = net / W;
  return { leg: label, n: T.length, sessionsActive: sess.length, windowSessions: W, grossUsd: Math.round(gross), costUsd: Math.round(cost), netUsd: Math.round(net),
    netPerWindowSession: +perSession.toFixed(2), tGrossBySession: +tOf(daily).toFixed(2), tNetBySession: +tOf(dailyNet).toFixed(2),
    riskAtWorkUsd: Math.round(riskAtWork), usdPerMonth: Math.round(perSession * 21), usdPerMonthPer1kRisk: riskAtWork > 0 ? +((perSession * 21) / (riskAtWork / 1000)).toFixed(1) : null,
    avgR: +mean(T.map((t) => t.rMult)).toFixed(4), winPct: +(100 * T.filter((t) => t.rMult > 0).length / Math.max(1, T.length)).toFixed(1) };
}
const group = (T, f) => { const m = {}; for (const t of T) (m[f(t)] ||= []).push(t); return m; };
const rows = [];
rows.push(leg("BOARD (dashboard table)", table));
for (const [k, v] of Object.entries(group(table, (t) => t.strategy || "?")).sort((a, b) => b[1].length - a[1].length)) rows.push(leg(k, v));
const byCls = []; for (const [k, v] of Object.entries(group(table, (t) => (t.strategy || "?") + " / " + (t.cls || "?"))).sort((a, b) => b[1].length - a[1].length)) byCls.push(leg(k, v));
const hid = hidden.length ? leg("HIDDEN (entered outside 09:25-16:00 ET)", hidden) : null;

// effective N: design effect of clustering ticket R by open session
function effN(T, keyf = (t) => S.openSession(t)) {
  const r = T.map((t) => t.rMult).filter(Number.isFinite), n = r.length, m = mean(r), s2 = sd(r) ** 2;
  const g = {}; for (const t of T) if (Number.isFinite(t.rMult)) (g[keyf(t)] ||= []).push(t.rMult - m);
  const G = Object.keys(g).length, varCl = (sum(Object.values(g).map((a) => sum(a) ** 2)) / (n * n)) * (G / (G - 1));
  const naive = s2 / n; return { tickets: n, sessions: G, naiveSE: +Math.sqrt(naive).toFixed(5), clusteredSE: +Math.sqrt(varCl).toFixed(5), deff: +(varCl / naive).toFixed(2), effectiveN: +(n * naive / varCl).toFixed(1) };
}
const effKeys = { "open session": (t) => S.openSession(t), "open session x class": (t) => S.openSession(t) + "|" + t.cls, "open session x class x direction": (t) => S.openSession(t) + "|" + t.cls + "|" + t.dir, "open session x strategy x class x direction": (t) => S.openSession(t) + "|" + t.strategy + "|" + t.cls + "|" + t.dir };
const effMulti = Object.entries(effKeys).map(([k, fn]) => ({ clusterBy: k, ...effN(table, fn) }));
const eff = effN(table), effByStrat = Object.entries(group(table, (t) => t.strategy)).filter(([, v]) => v.length >= 30).map(([k, v]) => ({ strategy: k, ...effN(v) }));
// Breakout concentration
const bo = table.filter((t) => t.strategy === "Breakout");
const boBySess = {}; for (const t of bo) { const d = S.openSession(t) + " open / " + mtDay(t.closedAt) + " close"; (boBySess[d] ||= { n: 0, usd: 0, targets: 0 }); boBySess[d].n++; boBySess[d].usd += t.pnl; if (t.reason === "target") boBySess[d].targets++; }
const boTotal = sum(bo.map((t) => t.pnl));
const out = { spec: "pp-board-legs-v1", asOf: new Date().toISOString(), since: SINCE, until: UNTIL, population: { table: table.length, hidden: hidden.length, windowSessionsMTcloseDay: W },
  effectiveNMulti: effMulti, costNote: "non-options cost = ticket obs.costR if stamped else cost-model.json class meanCostR, times riskDollars; options pnl already carries measured cost", rows, byStrategyClass: byCls, hidden: hid, effectiveN: eff, effectiveNByStrategy: effByStrat,
  breakout: { tickets: bo.length, totalUsd: Math.round(boTotal), bySession: Object.fromEntries(Object.entries(boBySess).map(([k, v]) => [k, { n: v.n, usd: Math.round(v.usd), targets: v.targets }])), boardNetExBreakoutUsd: Math.round(sum(table.map((t) => t.pnl)) - boTotal) } };
if (!argv.includes("--no-write")) writeJsonAtomic(path.join(__dirname, "..", "data", "profit-program", `pp-board-legs-${SINCE}.json`), out);
const f$ = (v) => (v < 0 ? "-$" : "+$") + Math.abs(Math.round(v)).toLocaleString("en-US");
const P = (r) => console.log(`${r.leg.padEnd(34)} n${String(r.n).padStart(5)} act${String(r.sessionsActive).padStart(3)}  gross ${f$(r.grossUsd).padStart(8)}  cost ${f$(-r.costUsd).padStart(8)}  net ${f$(r.netUsd).padStart(8)}  $/sess ${f$(r.netPerWindowSession).padStart(6)}  t(gross) ${String(r.tGrossBySession).padStart(6)} t(net) ${String(r.tNetBySession).padStart(6)}  risk@work $${String(r.riskAtWorkUsd).padStart(6)}  $/mo ${f$(r.usdPerMonth).padStart(7)}  $/mo per $1k risk ${String(r.usdPerMonthPer1kRisk).padStart(6)}  avgR ${r.avgR}`);
console.log(`PP BOARD LEGS  closed ${SINCE}..${UNTIL === "9999-12-31" ? "now" : UNTIL} (MT close day; ${W} sessions)  table ${table.length} tickets + hidden ${hidden.length}   [IN-SAMPLE descriptive; t clustered by OPEN session]`);
for (const r of rows) P(r); if (hid) P(hid);
console.log("\nby strategy / class"); for (const r of byCls) P(r);
console.log(`\nEFFECTIVE N (table): ${eff.tickets} tickets in ${eff.sessions} open sessions -> design effect ${eff.deff}, effective N ${eff.effectiveN}  (naive SE ${eff.naiveSE} R vs session-clustered SE ${eff.clusteredSE} R)`);
for (const e of effMulti) console.log(`  cluster by ${e.clusterBy.padEnd(46)} clusters ${String(e.sessions).padStart(5)}  design effect ${String(e.deff).padStart(5)}  effective N ${e.effectiveN}`);
for (const e of effByStrat) console.log(`  ${e.strategy.padEnd(16)} tickets ${String(e.tickets).padStart(4)}  sessions ${String(e.sessions).padStart(3)}  deff ${e.deff}  effective N ${e.effectiveN}`);
console.log(`\nBREAKOUT: ${bo.length} tickets, ${f$(boTotal)} total; board net excluding Breakout ${f$(sum(table.map((t) => t.pnl)) - boTotal)}`);
for (const [k, v] of Object.entries(out.breakout.bySession)) console.log(`  ${k}: ${v.n} tickets, ${f$(v.usd)}, ${v.targets} target exits`);
