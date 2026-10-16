#!/usr/bin/env node
"use strict";
/**
 * BOARD COST — what the spread costs the Equity + Crypto lane, and what refusing the widest names is worth (profit program lever 2).
 * READ-ONLY printer. Population: lib/reconcile.js cleanEraLedger() signals, cls Equity/Crypto, closed >= REGIME_START (2026-08-25, where sizing is today's).
 * EXPLORATORY / IN-SAMPLE. Cost definition (stated, sensitivity shown):
 *   full  = spreadBps/1e4 * notional   (marketable in AND out: cross the whole quoted spread over the round trip)  <- primary
 *   half  = full/2                     (cross one side only: e.g. passive exit, or exit marked at mid)             <- lower bound
 * The ledger's paper fills carry ~0 crossing (mean fillVsMidBps printed below), so ledger pnl is GROSS of this cost.
 * Equity spread = ticket's own stamped NBBO (obs.spreadBps, full ask-bid over mid). Unstamped tickets are priced at the strategy's stamped median (labelled).
 * Crypto spread = nearest preceding row of data/crypto-spread-log.jsonl (lookback 12h) + an ASSUMED Alpaca taker fee of 0.25%/side (R307's registered 0.50% RT).
 * t = cluster-robust by MT close day. Refusal thresholds tried: 6 (multiplicity 6).
 *   node backend/profit-program/board-cost.js
 */
const fs = require("fs"), path = require("path");
const C = require("./_common.js");
const { $, f, pad, lpad, mean, sum, clusterT, clusterDiffT } = C;
const B = C.laneBoard();
const reg = B.sig.filter((t) => t._day >= C.REGIME_START);
const eq = reg.filter((t) => t.cls === "Equity" && Number.isFinite(t._notional) && Number.isFinite(t._risk));
const cr = reg.filter((t) => t.cls === "Crypto" && Number.isFinite(t._notional) && Number.isFinite(t._risk));
const sessions = new Set(reg.map((t) => t._day)).size;
const MONTH = 21;   // trading sessions per month
console.log(`BOARD COST (profit program lever 2) source ${B.source}; regime window closed >= ${C.REGIME_START}: ${reg.length} lane signals (${eq.length} equity, ${cr.length} crypto with notional+risk), ${sessions} sessions; month = ${MONTH} sessions`);

// ---------- equity spread coverage, sign convention, R49
const st = (t) => t.obs && Number.isFinite(t.obs.spreadBps);
const stamped = eq.filter(st);
console.log(`\n[1] EQUITY SPREAD STAMP COVERAGE (regime window): ${stamped.length} of ${eq.length} equity signals carry obs.spreadBps (${(stamped.length / eq.length * 100).toFixed(0)}%)`);
const byS = {}; for (const t of eq) { const o = (byS[t.strategy] ||= { n: 0, s: 0 }); o.n++; if (st(t)) o.s++; }
for (const [k, o] of Object.entries(byS)) console.log(`   ${lpad(k, 16)} ${pad(o.s, 4)} / ${pad(o.n, 4)} stamped`);
// sign convention of fillVsMidBps
let match = 0, cmp = 0; const fm = [];
for (const t of stamped) if (Number.isFinite(t.obs.fillVsMidBps) && Number.isFinite(t.obs.bidAtEntry) && Number.isFinite(t.obs.askAtEntry)) {
  const mid = (t.obs.bidAtEntry + t.obs.askAtEntry) / 2, adv = t.dir * (t.entry - mid) / mid * 1e4;
  cmp++; if (Math.abs(adv - t.obs.fillVsMidBps) < 0.2) match++; fm.push(t.obs.fillVsMidBps);
}
console.log(`   fillVsMidBps = dir*(entry-mid)/mid*1e4 (positive = paid worse than mid): ${match}/${cmp} rows reproduce; mean ${mean(fm).toFixed(2)} bps, median ${C.median(fm).toFixed(2)}, share exactly 0: ${(fm.filter((v) => v === 0).length / fm.length * 100).toFixed(0)}%  => paper entries carry ~no crossing cost; mean stamped full spread ${mean(stamped.map((t) => t.obs.spreadBps)).toFixed(1)} bps, median ${C.median(stamped.map((t) => t.obs.spreadBps)).toFixed(1)}`);
// R49 measured on this path
const wideKept = stamped.filter((t) => t.obs.spreadBps > 100);
console.log(`\n[2] R49 (refuse equity spread > 100 bps; lib/enforcement-gates.js, enforced from 2026-08-27 at the entry POST, only when obs.spreadBps is stamped)`);
console.log(`   executed signal tickets with stamped spread > 100 bps, opened on/after 2026-08-27 (by openedAt ET date): ${B.sig.filter((t) => t.cls === "Equity" && st(t) && t.obs.spreadBps > 100 && new Date(t.openedAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) >= "2026-08-27").length}; before (08-26 evidence day): ${B.sig.filter((t) => t.cls === "Equity" && st(t) && t.obs.spreadBps > 100 && new Date(t.openedAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) < "2026-08-27").length}`);
const r49sh = B.ctl.filter((t) => t.cls === "Equity" && t.vetoShadow && /R49/.test(t.veto || ""));
console.log(`   R49 veto shadows in the ledger: ${r49sh.length} (sessions ${new Set(r49sh.map((t) => t._day)).size}); shadow gross R mean ${f(mean(r49sh.map((t) => t.rMult)))} (a negative number means the gate refused losers; this arm is gross of spread)`);
const unst = eq.filter((t) => !st(t));
const symMed = new Map(); for (const t of B.sig.filter((x) => x.cls === "Equity" && st(x))) (symMed.get(t.sym) || symMed.set(t.sym, []).get(t.sym)).push(t.obs.spreadBps);
let leakKnown = 0, leakSym = 0;
for (const t of unst) { const a = symMed.get(t.sym); if (a) { leakSym++; if (C.median(a) > 100) leakKnown++; } }
{
  const sh = r49sh.filter((t) => Number.isFinite(t._notional) && t.obs && Number.isFinite(t.obs.spreadBps));
  const shc = sum(sh.map((t) => t.obs.spreadBps / 1e4 * t._notional)), shp = sum(sh.map((t) => t.pnl));
  console.log(`   R49 shadows with notional+spread ${sh.length}: gross pnl they would have booked ${$(shp)}; full-spread cost they would have paid ${$(-shc)}; so the gate's value is ${$(shc - shp)} over the evidence window (${$((shc - shp) / new Set(sh.map((t) => t._day)).size * 0 + (shc - shp) / sessions * MONTH)}/month at this flow); in R: shadow gross ${f(mean(sh.map((t) => t.rMult)))} per ticket.`);
  const wk = B.sig.filter((t) => t.cls === "Equity" && st(t) && t.obs.spreadBps > 100 && new Date(t.openedAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) >= "2026-08-27");
  for (const t of wk) console.log(`   executed after enforcement: ${t.strategy} ${t.sym} opened ${new Date(t.openedAt).toISOString()} spread ${t.obs.spreadBps.toFixed(0)} bps pnl ${$(t.pnl)}`);
}
console.log(`   unstamped equity tickets (pass R49 ungated by rule): ${unst.length} of ${eq.length}; ${leakSym} have the same symbol stamped elsewhere, of which ${leakKnown} have a symbol-median spread > 100 bps`);
const unstByDay = {}; for (const t of unst) unstByDay[t._day.slice(0, 7)] = (unstByDay[t._day.slice(0, 7)] || 0) + 1; console.log(`   unstamped by close month: ${JSON.stringify(unstByDay)}`);

// ---------- cost per ticket
const fallback = {}; for (const s of Object.keys(byS)) { const a = stamped.filter((t) => t.strategy === s).map((t) => t.obs.spreadBps); fallback[s] = a.length ? C.median(a) : C.median(stamped.map((t) => t.obs.spreadBps)); }
for (const t of eq) { t._spr = st(t) ? t.obs.spreadBps : fallback[t.strategy]; t._imputed = !st(t); t._costFull = t._spr / 1e4 * t._notional; t._costHalf = t._costFull / 2; }
const costRow = (label, rows) => {
  if (!rows.length) return `${lpad(label, 26)}   0`;
  const gross = sum(rows.map((t) => t.pnl)), cf = sum(rows.map((t) => t._costFull)), ch = sum(rows.map((t) => t._costHalf));
  const r = sum(rows.map((t) => t._risk)) / rows.length;
  return `${lpad(label, 26)} ${pad(rows.length, 4)} ${pad(C.median(rows.map((t) => t._spr)).toFixed(0), 5)} ${pad("$" + (cf / rows.length).toFixed(1), 7)} ${pad(f(mean(rows.map((t) => t._costFull / t._risk)), 3), 7)}  ${pad($(gross), 8)} ${pad($(-cf), 8)} ${pad($(gross - cf), 9)} ${pad($(gross - ch), 9)}  ${pad(f(mean(rows.map((t) => t.rMult)), 3), 7)} ${pad(f(mean(rows.map((t) => (t.pnl - t._costFull) / t._risk)), 3), 7)}`;
};
const HEAD = `${lpad("", 26)} ${pad("n", 4)} ${pad("medBps", 5)} ${pad("$/tkt", 7)} ${pad("R/tkt", 7)}  ${pad("gross", 8)} ${pad("-cost", 8)} ${pad("net(full)", 9)} ${pad("net(half)", 9)}  ${pad("grossR", 7)} ${pad("netR", 7)}`;
console.log(`\n[3] EQUITY COST BY STRATEGY (regime window; unstamped priced at the strategy's stamped median spread; "cost" = full round-trip spread; netR uses the full cost)`);
console.log(HEAD);
console.log(costRow("ALL EQUITY", eq));
for (const s of C.LANE_STRATS) { const x = eq.filter((t) => t.strategy === s); if (x.length) console.log(costRow(s, x)); }
console.log(`   stamped only:`); console.log(costRow("  ALL stamped", eq.filter((t) => !t._imputed)));
const net = (rows) => sum(rows.map((t) => t.pnl - t._costFull));
const tAll = clusterT(eq, (t) => (t.pnl - t._costFull) / t._risk);
console.log(`   net-of-full-spread mean R ${f(tAll.mean, 4)}  cluster-t ${f(tAll.t, 2)} (${tAll.G} day-clusters, ${tAll.n} tickets) | month at this flow: gross ${$(sum(eq.map((t) => t.pnl)) / sessions * MONTH)}, cost ${$(-sum(eq.map((t) => t._costFull)) / sessions * MONTH)}, net ${$(net(eq) / sessions * MONTH)}`);
const gs = sum(eq.map((t) => t.pnl)), cs = sum(eq.map((t) => t._costFull));
console.log(`   cost vs gross: gross ${$(gs)} on ${eq.length} tickets, cost ${$(-cs)}; cost per $ of gross absolute P&L: ${(cs / sum(eq.map((t) => Math.abs(t.pnl)))).toFixed(2)} (sum |pnl| ${$(sum(eq.map((t) => Math.abs(t.pnl))))})`);

// by spread bucket
console.log(`\n[4] EQUITY BY SPREAD BUCKET (stamped tickets only)`);
console.log(HEAD);
const bk = [[0, 10], [10, 25], [25, 50], [50, 100], [100, 1e9]];
for (const [lo, hi] of bk) console.log(costRow(`${lo}-${hi >= 1e9 ? "inf" : hi} bps`, eq.filter((t) => !t._imputed && t._spr >= lo && t._spr < hi)));
// by entry-time (ET half hour)
console.log(`\n[5] EQUITY BY ENTRY TIME (ET half-hour of openedAt; stamped only)`);
console.log(HEAD);
const tb = {}; for (const t of eq.filter((x) => !x._imputed)) { const hm = C.etHM(t.openedAt); const k = hm.slice(0, 2) + ":" + (hm.slice(3) < "30" ? "00" : "30"); (tb[k] ||= []).push(t); }
for (const k of Object.keys(tb).sort()) console.log(costRow(k + " ET", tb[k]));
const bt = eq.map((t) => C.etHM(t.openedAt)); console.log(`   openedAt minute-of-day (ET) quantiles: p5 ${bt.sort()[Math.floor(bt.length * .05)]}  p50 ${bt[Math.floor(bt.length * .5)]}  p95 ${bt[Math.floor(bt.length * .95)]}`);

// ---------- refusal screens
console.log(`\n[6] WHAT REFUSING THE WIDEST SPREADS IS WORTH (equity, stamped only; 6 thresholds tried). gain = -(gross pnl - cost) of the refused set, in dollars at this window's sizing`);
console.log(`${lpad("refuse spread >", 16)} ${pad("n", 4)} ${pad("share", 6)} ${pad("G", 3)} ${pad("gross", 8)} ${pad("cost(full)", 10)} ${pad("net(full)", 9)} ${pad("gain full", 9)} ${pad("/month", 8)} ${pad("gain half", 9)} ${pad("/month", 8)}  ${pad("netR", 7)} ${pad("t(netR)", 7)}`);
const stm = eq.filter((t) => !t._imputed), sess2 = new Set(stm.map((t) => t._day)).size;
const screens = [];
for (const T of [100, 60, 40, 30, 20, 10]) {
  const W = stm.filter((t) => t._spr > T); if (!W.length) continue;
  const gross = sum(W.map((t) => t.pnl)), cf = sum(W.map((t) => t._costFull)), ch = sum(W.map((t) => t._costHalf));
  const tt = clusterT(W, (t) => (t.pnl - t._costFull) / t._risk);
  const gainF = -(gross - cf), gainH = -(gross - ch);
  screens.push({ T, n: W.length, gross, cf, gainF, gainH, t: tt.t });
  console.log(`${lpad(">" + T + " bps", 16)} ${pad(W.length, 4)} ${pad((W.length / stm.length * 100).toFixed(0) + "%", 6)} ${pad(tt.G, 3)} ${pad($(gross), 8)} ${pad($(-cf), 10)} ${pad($(gross - cf), 9)} ${pad($(gainF), 9)} ${pad($(gainF / sess2 * MONTH), 8)} ${pad($(gainH), 9)} ${pad($(gainH / sess2 * MONTH), 8)}  ${pad(f(tt.mean, 3), 7)} ${pad(f(tt.t, 2), 7)}`);
}
console.log(`   (stamped sample = ${stm.length} tickets over ${sess2} sessions; the 100 bps row is what R49 already enforces, so it is the executed remainder and should be ~0 tickets)`);
// complementary: the kept (narrow) set
for (const T of [30, 40]) { const K = stm.filter((t) => t._spr <= T); const tt = clusterT(K, (t) => (t.pnl - t._costFull) / t._risk); console.log(`   kept at <=${T} bps: n ${K.length}, gross ${$(sum(K.map((t) => t.pnl)))}, net(full) ${$(sum(K.map((t) => t.pnl - t._costFull)))}, net mean R ${f(tt.mean, 4)} t ${f(tt.t, 2)}`); }

// [6b] sensitivity: only tickets sized AFTER cost-aware sizing went live (lib/cost-size.js, applied from 2026-09-03: wide-spread tickets already get 0.5x risk)
{
  const late = stm.filter((t) => t._day >= "2026-09-04"), sl = new Set(late.map((t) => t._day)).size;
  console.log("\n[6b] SAME SCREEN, ONLY TICKETS SIZED AFTER cost-aware sizing (closed >= 2026-09-04): " + late.length + " stamped equity tickets, " + sl + " sessions. Wide names already carry up to 0.5x risk here, so the dollars are smaller.");
  console.log(lpad("refuse spread >", 16) + " " + pad("n", 4) + " " + pad("gross", 8) + " " + pad("cost(full)", 10) + " " + pad("gain full", 9) + " " + pad("/month", 8) + " " + pad("gain half", 9) + " " + pad("/month", 8) + "  " + pad("netR", 7) + " " + pad("t(netR)", 7) + " " + pad("G", 3));
  for (const T of [100, 60, 40, 30, 20, 10]) {
    const W = late.filter((t) => t._spr > T); if (!W.length) continue;
    const gross = sum(W.map((t) => t.pnl)), cf = sum(W.map((t) => t._costFull)), ch = sum(W.map((t) => t._costHalf));
    const tt = clusterT(W, (t) => (t.pnl - t._costFull) / t._risk);
    console.log(lpad(">" + T + " bps", 16) + " " + pad(W.length, 4) + " " + pad($(gross), 8) + " " + pad($(-cf), 10) + " " + pad($(cf - gross), 9) + " " + pad($((cf - gross) / sl * MONTH), 8) + " " + pad($(ch - gross), 9) + " " + pad($((ch - gross) / sl * MONTH), 8) + "  " + pad(f(tt.mean, 3), 7) + " " + pad(f(tt.t, 2), 7) + " " + pad(tt.G, 3));
  }
  const cheap = late.filter((t) => t._spr <= 30), wide = late.filter((t) => t._spr > 30);
  console.log("   gross R per ticket, narrow (<=30 bps) " + f(mean(cheap.map((t) => t.rMult))) + " (n " + cheap.length + ") vs wide (>30 bps) " + f(mean(wide.map((t) => t.rMult))) + " (n " + wide.length + "): gross difference " + f(clusterDiffT(wide, cheap, (t) => t.rMult).diff) + "R, t " + f(clusterDiffT(wide, cheap, (t) => t.rMult).t, 2) + " => the refusal does not forgo gross edge; the gain is the cost avoided.");
}
// [6c] PLACEBO: the whole stamped book nets negative, so refusing ANY tickets "gains". How much of the gain is the spread targeting?
{
  console.log("\n[6c] PLACEBO: refuse a RANDOM subset of the same size (5,000 draws) instead of the widest. The stamped book nets negative after cost, so any refusal gains; only the excess over random is the spread's contribution.");
  let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (const [lab, pool] of [["regime window (closed >= " + C.REGIME_START + ")", stm], ["after cost-aware sizing (closed >= 2026-09-04)", stm.filter((t) => t._day >= "2026-09-04")]]) {
    const net = pool.map((t) => t.pnl - t._costFull), tot = sum(net), sl = new Set(pool.map((t) => t._day)).size;
    console.log("   " + lab + ": " + pool.length + " stamped tickets, " + sl + " sessions, net after full spread " + $(tot) + " (gross " + $(sum(pool.map((t) => t.pnl))) + ")");
    for (const T of [60, 40, 30, 20]) {
      const W = pool.filter((t) => t._spr > T); if (W.length < 5) continue;
      const gain = -sum(W.map((t) => t.pnl - t._costFull));
      const draws = []; for (let i = 0; i < 5000; i++) { const idx = pool.map((_, j) => j); for (let j = idx.length - 1; j > 0; j--) { const k = Math.floor(rnd() * (j + 1)); [idx[j], idx[k]] = [idx[k], idx[j]]; } draws.push(-sum(idx.slice(0, W.length).map((j) => net[j]))); }
      draws.sort((a, b) => a - b);
      const rmean = mean(draws), p95 = draws[Math.floor(draws.length * 0.95)], beat = draws.filter((x) => x >= gain).length / draws.length;
      console.log("      refuse > " + T + " bps (" + W.length + " tickets): gain " + $(gain) + " | random same-size refusal: mean " + $(rmean) + ", p95 " + $(p95) + " | share of random draws >= observed " + (beat * 100).toFixed(1) + "% | EXCESS over random " + $(gain - rmean) + " = " + $((gain - rmean) / sl * MONTH) + "/month (full spread)");
    }
  }
  console.log("   reading: the excess is the part that is about the spread. The remainder of any 'gain' is simply not trading a book whose expectancy after cost is negative (which needs no spread rule at all).");
}
// ---------- crypto
console.log(`\n[7] CRYPTO COST (regime window; ${cr.length} signal tickets with notional): spread = per-symbol MEDIAN of fresh quotes in data/crypto-spread-log.jsonl + ASSUMED 0.25%/side Alpaca taker fee`);
const LOG = path.join(__dirname, "..", "data", "crypto-spread-log.jsonl");
const bySym = new Map(); let nsn = 0, stale = 0;
for (const ln of fs.readFileSync(LOG, "utf8").split(String.fromCharCode(10))) {
  if (!ln) continue;
  try {
    const r = JSON.parse(ln); const q = Date.parse(r.quoteAt), run = Date.parse(r.runAt);
    if (!Number.isFinite(run) || !Number.isFinite(r.rtBps)) continue;
    if (!Number.isFinite(q) || run - q > 10 * 60e3) { stale++; continue; }   // drop stale last-quotes (illiquid coins report the last quote, not a live spread)
    nsn++; (bySym.get(r.sym) || bySym.set(r.sym, []).get(r.sym)).push(r.rtBps);
  } catch {}
}
const symMedC = new Map([...bySym].map(([k, v]) => [k, C.median(v)]));
const classMedC = C.median([...bySym.values()].flat());
console.log(`   spread log: ${nsn} fresh rows (${stale} stale dropped), ${bySym.size} symbols, class median ${classMedC.toFixed(1)} bps (declared constant in cost-model.json: 20 bps). Per-symbol MEDIAN spread is used for every crypto ticket (a cost estimate, not a selection input)`);
let matched = 0; const crm = [];
for (const t of cr) { if (symMedC.has(t.sym)) { t._spr = symMedC.get(t.sym); matched++; } else t._spr = classMedC; crm.push(t); }
console.log(`   tickets priced at their own symbol median: ${matched} of ${cr.length}; the rest at the class median`);
if (crm.length) {
  const FEE = 0.005;   // 0.25% x 2, ASSUMED
  const rowC = (label, rows) => {
    const gross = sum(rows.map((t) => t.pnl)), sp = sum(rows.map((t) => t._spr / 1e4 * t._notional)), fee = sum(rows.map((t) => FEE * t._notional));
    return `${lpad(label, 22)} ${pad(rows.length, 4)} medSpread ${pad(C.median(rows.map((t) => t._spr)).toFixed(0), 4)}bps  notional/tkt ${pad("$" + mean(rows.map((t) => t._notional)).toFixed(0), 6)}  gross ${pad($(gross), 7)}  spread ${pad($(-sp), 6)}  fees(0.50%RT) ${pad($(-fee), 6)}  net ${pad($(gross - sp - fee), 7)}  netR/tkt ${f(mean(rows.map((t) => (t.pnl - t._spr / 1e4 * t._notional - FEE * t._notional) / t._risk)), 3)}`;
  };
  console.log(rowC("ALL matched crypto", crm));
  for (const s of ["Trend", "Ensemble", "Breakout", "Mean-Reversion"]) { const x = crm.filter((t) => t.strategy === s); if (x.length) console.log(rowC(s, x)); }
  const tt = clusterT(crm, (t) => (t.pnl - t._spr / 1e4 * t._notional - FEE * t._notional) / t._risk);
  console.log(`   crypto matched net mean R ${f(tt.mean, 4)} t ${f(tt.t, 2)} (${tt.G} day-clusters)`);
}
console.log(`\nprinted slices: 7 sections; refusal thresholds tried 6; crypto fee is an assumption not a measurement.`);
{
  console.log(`\n[8] MEASURED BROKER ENTRY SLIPPAGE (data/alpaca-reconcile.json, Alpaca PAPER fills of mirrored board tickets; positive = paid worse than the ticket's claimed entry)`);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "alpaca-reconcile.json"), "utf8"));
    const p = j.perTicket.filter((t) => Number.isFinite(t.slippagePct)), e = p.filter((t) => !String(t.sym).includes("/")), c = p.filter((t) => String(t.sym).includes("/"));
    const bps = (a) => a.map((t) => t.slippagePct * 100);
    console.log(`   asOf ${j.asOf}: ${p.length} filled mirrored tickets (${e.length} equity, ${c.length} crypto). Entry slippage bps: all mean ${mean(bps(p)).toFixed(1)} median ${C.median(bps(p)).toFixed(1)}; equity mean ${mean(bps(e)).toFixed(1)} median ${C.median(bps(e)).toFixed(1)}; crypto mean ${mean(bps(c)).toFixed(1)} median ${C.median(bps(c)).toFixed(1)}`);
    console.log(`   entry slippage dollars on those tickets: ${$(-sum(p.map((t) => t.slippagePct / 100 * t.ticketEntry * t.qty)))} (one side only). Ledger pnl ${$(sum(p.map((t) => t.ourPnl)))} vs broker pnl ${$(sum(p.map((t) => t.brokerPnl).filter(Number.isFinite)))} on the same tickets: NOT a cost comparison (78 of 100 ended differently at the broker: bracket legs vs the board's close), shown only so nobody reads it as one.`);
    console.log(`   median equity entry slippage ${C.median(bps(e)).toFixed(1)} bps vs half of the median stamped spread ${(C.median(stamped.map((t) => t.obs.spreadBps)) / 2).toFixed(1)} bps => a marketable entry pays about the half-spread; the mirror's market exit pays about the same again, so 'full' is the primary cost.`);
  } catch (err) { console.log("   reconcile file unreadable: " + err.message); }
}
const out = { spec: "board-cost-v1", asOf: new Date().toISOString(), regimeStart: C.REGIME_START, equityN: eq.length, stampedN: stamped.length, screens };
C.write("board-cost.json", out);
