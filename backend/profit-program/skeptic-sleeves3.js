#!/usr/bin/env node
/**
 * SKEPTIC / lane sleeves-and-sizing, third printer (read-only; GET requests only; no orders, no broker writes, never prints a key).
 *   H1) R191 / R231 crypto forward legs: do the orders listed in the runner state files exist as FILLED orders at the broker, and
 *       does the broker hold the quantity those states claim? (main paper account; quantities and order status only - no performance read:
 *       both legs are read-once tests, their dollars are quoted only from decay-monitor / pp-broker-attrib.)
 *   H2) stale open option spreads: are they ghosts (already in the ledger)? Independent re-derivation of the expiry settle from the
 *       OCC legs on the position rows and the expiry-day close of the underlying (raw daily bars through _opt-bars.js stockDaily, cached).
 *   H3) the dashboard-table dollars of the board by MT close day: session t, weekly t, share of the top two days, with the modelled cost,
 *       with the mirror-measured cost ratio, and with the stale spreads booked on their expiry days.
 *       Population: lib/reconcile.js cleanEraLedger() signals (controls out), entries stamped outside 09:25-16:00 ET shown apart.
 *   H4) R295 arithmetic from backend/data/decay-monitor.json ONLY (read-once test: its ledger is not opened here).
 * IN-SAMPLE / descriptive. Writes only backend/data/profit-program/skeptic-sleeves3.json.
 *   node backend/profit-program/skeptic-sleeves3.js [--no-write] [--no-broker]
 */
"use strict";
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const rc = require("../lib/reconcile.js");
const { riskOf, notionalOf } = require("./_common.js");
const { stockDaily } = require("./_opt-bars.js");
const argv = process.argv.slice(2);
const DATA = path.join(__dirname, "..", "data");
const rd = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
const sum = (a) => a.reduce((s, v) => s + v, 0), mean = (a) => (a.length ? sum(a) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1)); };
const tOf = (a) => { const s = sd(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : NaN; };
const usdF = (v) => (!Number.isFinite(v) ? "n/a" : (v < 0 ? "-$" : "+$") + Math.abs(Math.round(v)).toLocaleString("en-US"));
const r2 = (v) => (Number.isFinite(v) ? +v.toFixed(2) : null);
const out = { spec: "skeptic-sleeves3-v1", asOf: new Date().toISOString() };

// ---------- H1) R191 / R231 runner state vs the broker ----------
async function partH1() {
  if (argv.includes("--no-broker")) { console.log("H1) skipped (--no-broker)"); return; }
  const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
  if (!H["APCA-API-KEY-ID"]) { console.log("H1) main account keys not configured"); return; }
  const API = "https://paper-api.alpaca.markets";
  const get = async (p) => { const r = await fetch(API + p, { method: "GET", headers: H }); if (r.status === 404) return null; if (!r.ok) throw new Error(`${p.split("?")[0]} ${r.status}`); return r.json(); };
  const legs = { R191: rd("r191-crypto-trend.json").orders, R231: rd("r231-crypto-vote-sized.json").orders };
  const pos = await get("/v2/positions"), crypto = pos.filter((p) => p.asset_class === "crypto");
  const brokerQty = Object.fromEntries(crypto.map((p) => [p.symbol.replace("/", "").replace(/USD$/, ""), { qty: +p.qty, px: +p.current_price, mv: +p.market_value }]));
  const res = {}, claimed = {}, filledByCoin = {};
  for (const [leg, orders] of Object.entries(legs)) {
    const rows = [];
    for (const o of orders) {
      const b = await get(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(o.cid)}`);
      const coin = (/^r\d{3}-([A-Z]+)-/.exec(o.cid) || [])[1], sign = o.side === "buy" ? 1 : -1;
      const fq = b ? +b.filled_qty || 0 : 0;
      rows.push({ cid: o.cid, coin, side: o.side, stateQty: o.qty, statePx: o.px, broker: b ? b.status : "NOT FOUND", brokerFilledQty: fq, brokerFillPx: b && b.filled_avg_price ? +b.filled_avg_price : null, brokerType: b ? `${b.type}/${b.time_in_force}` : null });
      claimed[coin] = (claimed[coin] || 0) + sign * o.qty; filledByCoin[coin] = (filledByCoin[coin] || 0) + sign * fq;
    }
    const filled = rows.filter((r) => r.brokerFilledQty > 0), notF = rows.filter((r) => !(r.brokerFilledQty > 0));
    const stNot = sum(notF.map((r) => r.stateQty * r.statePx)), stAll = sum(rows.map((r) => r.stateQty * r.statePx));
    const mism = filled.filter((r) => Math.abs(r.brokerFilledQty - r.stateQty) / r.stateQty > 0.005);
    res[leg] = { stateOrders: rows.length, filledAtBroker: filled.length, notFilledAtBroker: notF.length, stateNotionalAllOrdersUsd: Math.round(stAll), stateNotionalNotFilledUsd: Math.round(stNot), qtyMismatch: mism.length, rows };
    console.log(`H1) ${leg}: the runner state lists ${rows.length} orders (order notional ${usdF(stAll)}); at the broker ${filled.length} FILLED, ${notF.length} not filled / not found (state notional of those ${usdF(stNot)}); filled qty differs from the state qty by > 0.5% on ${mism.length}`);
    for (const r of notF) console.log(`      ${r.cid.padEnd(26)} state qty ${r.stateQty} @ ${r2(r.statePx)} -> broker: ${r.broker}${r.brokerType ? " (" + r.brokerType + ")" : ""}, filled qty ${r.brokerFilledQty}`);
    for (const r of mism) console.log(`      ${r.cid.padEnd(26)} state qty ${r.stateQty} vs broker filled ${r.brokerFilledQty} (${r.broker})`);
  }
  const coins = [...new Set(Object.keys(claimed).concat(Object.keys(brokerQty)))].sort(), cmp = [];
  for (const c of coins) { const b = brokerQty[c] || { qty: 0, px: null, mv: 0 };
    cmp.push({ coin: c, stateClaimedQty: +(claimed[c] || 0).toFixed(6), brokerFilledQtyOfTheseOrders: +(filledByCoin[c] || 0).toFixed(6), brokerPositionQty: b.qty, brokerPx: b.px, claimedNotionalAtBrokerPx: b.px ? Math.round((claimed[c] || 0) * b.px) : null, brokerMarketValue: Math.round(b.mv) }); }
  const clN = sum(cmp.map((x) => x.claimedNotionalAtBrokerPx || 0)), brN = sum(cmp.map((x) => x.brokerMarketValue || 0));
  res.byCoin = cmp; res.claimedNotionalAtBrokerPxUsd = clN; res.brokerCryptoMarketValueUsd = brN;
  console.log(`    by coin (state-claimed qty of R191+R231 | broker filled qty of the same orders | broker position qty in main):`);
  for (const x of cmp) console.log(`      ${x.coin.padEnd(5)} claimed ${String(x.stateClaimedQty).padStart(14)} | filled ${String(x.brokerFilledQtyOfTheseOrders).padStart(14)} | position ${String(x.brokerPositionQty).padStart(14)}   claimed notional ${usdF(x.claimedNotionalAtBrokerPx)} vs broker market value ${usdF(x.brokerMarketValue)}`);
  console.log(`    the two runner states claim ${usdF(clN)} of crypto at the current broker prices; the main account holds ${usdF(brN)} of crypto in total`);
  res.note = "the runner state order lists are as of each state file (asOf in the file); orders sent in the latest close-chain run can be missing from them - see skeptic-sleeves3b.js for the full broker order history of a symbol";
  console.log("    note: " + res.note);
  out.cryptoLegsVsBroker = res;
}

// ---------- H2) stale open option spreads ----------
async function partH2(L) {
  const raw = rd("trade_log.json"), rawIds = new Set(raw.map((t) => t.id)), canonIds = new Set(L.signals.concat(L.controls).map((t) => t.id));
  const occ = (s) => { const m = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(s || ""); return m ? { exp: `20${m[2]}-${m[3]}-${m[4]}`, call: m[5] === "C", k: +m[6] / 1000 } : null; };
  const pos = rd("board_positions.json"), opt = pos.filter((p) => p.cls === "Options" && !p.ctrl && !p.vetoShadow), now = Date.now(), rows = [];
  for (const p of opt) {
    const a = occ(p.occAtm), b = occ(p.occK2); if (!a || !b) continue; if (Date.parse(a.exp + "T20:00:00Z") > now) continue;
    const bars = await stockDaily(p.sym, "2026-07-20", "2026-10-09"), bar = bars.find((x) => x.d === a.exp), Sx = bar ? bar.c : null;
    const lo = Math.min(a.k, b.k), hi = Math.max(a.k, b.k), mult = 100 * (p.contracts || 1);
    const val = Sx == null ? null : a.call ? Math.max(0, Math.min(Sx, hi) - lo) : Math.max(0, hi - Math.max(Sx, lo));
    const credit = !!p.optCredit, pnl = val == null ? null : credit ? (p.debit - val) * mult : (val - p.debit) * mult;
    // ghost check: the same id anywhere in the raw ledger file, or a settled non-control option row of the same symbol + strategy opened within a day
    const twin = raw.filter((t) => t.cls === "Options" && !t.ctrl && t.sym === p.sym && t.strategy === p.strategy && Math.abs((t.openedAt || 0) - p.addedAt) < 864e5);
    const ghost = canonIds.has(p.id), rawRow = raw.find((t) => t.id === p.id), rawNote = rawRow ? `raw row ${rawRow.reason} ${rawRow.pnl} (not canonical: ${!canonIds.has(p.id)})` : "no raw row";
    rows.push({ id: p.id, sym: p.sym, strategy: p.strategy, kind: credit ? "credit" : "debit", expiry: a.exp, legs: `${a.call ? "C" : "P"} ${a.k}/${b.k}`, close: Sx, settleUsd: r2(pnl), maxLossUsd: p.riskDollars, ghost, rawNote, sameSymbolRowsWithinADay: twin.length,
      marginToFlipPct: Sx == null ? null : r2(100 * Math.min(Math.abs(Sx - a.k), Math.abs(Sx - b.k)) / Sx) });
  }
  const tot = sum(rows.map((r) => r.settleUsd || 0)), ghosts = rows.filter((r) => r.ghost);
  const byS = {}; for (const r of rows) byS[r.strategy] = r2((byS[r.strategy] || 0) + (r.settleUsd || 0));
  out.staleSpreads = { n: rows.length, settleUsd: r2(tot), maxLossUsd: sum(rows.map((r) => r.maxLossUsd)), byStrategy: byS, ghosts: ghosts.length, rows };
  console.log(`\nH2) ${rows.length} open non-control option positions past the expiry in their OCC symbols: settle at expiry intrinsic ${usdF(tot)} (max loss ${usdF(-out.staleSpreads.maxLossUsd)}); by strategy ${JSON.stringify(byS)}`);
  console.log(`    ghost check: ${ghosts.length} of ${rows.length} have their id in the CANONICAL ledger (a same-id row in the raw file that the canonical view excludes is shown per row)`);
  for (const r of rows) console.log(`      ${String(r.sym).padEnd(6)} ${String(r.strategy).padEnd(15)} ${r.kind.padEnd(6)} ${r.legs.padEnd(13)} exp ${r.expiry} close ${r.close} -> ${usdF(r.settleUsd)}  (nearest strike ${r.marginToFlipPct}% from the close; in canonical ledger ${r.ghost}; ${r.rawNote})`);
  return rows;
}

// ---------- H4) R295 from the decay monitor only ----------
function partH4() {
  const dm = rd("decay-monitor.json"), l = dm.legs.find((x) => x.id === "R295"), NAV = 20000, KILL_AT = 20;
  const usd = l.units.map(([, pct]) => pct / 100 * NAV), per = mean(usd), left = Math.max(0, KILL_AT - usd.length);
  const o = out.r295 = { source: "decay-monitor.json asOf " + dm.asOf, n: usd.length, negative: usd.filter((x) => x < 0).length, totalUsd: Math.round(sum(usd)), perSessionUsd: Math.round(per), tFixed: r2(l.tFixed), eNegative: r2(l.negativeEdge.e), eNeeded: l.negativeEdge.threshold,
    sessionsToRegisteredKill: left, oneTimeAvoidableStopNowUsd: Math.round(-per * left), oneTimeAvoidableAt25pctUsd: Math.round(-per * left * 0.75), ifItRanAFullMonthUsd: Math.round(per * 21), recurringAfterKillUsdPerMonth: 0 };
  console.log(`\nH4) R295 (decay monitor only): ${o.n} evidence sessions, ${o.negative} negative, total ${usdF(o.totalUsd)}, ${usdF(o.perSessionUsd)}/session, t ${o.tFixed}, e ${o.eNegative} of ${o.eNeeded}`);
  console.log(`    the registered kill is evaluated once at evidence session ${KILL_AT}: ${left} sessions remain -> stopping now avoids ${left} x ${usdF(-per)} = ${usdF(o.oneTimeAvoidableStopNowUsd)} ONCE (25% stake: ${usdF(o.oneTimeAvoidableAt25pctUsd)}); x21 = ${usdF(o.ifItRanAFullMonthUsd)}/month applies only if the leg ran past its own kill; after the kill the recurring saving is $0/month`);
}

// ---------- H3) board table dollars by MT close day ----------
function partH3(L, stale) {
  const mtDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  const hm = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
  const isOvernight = (t) => { const o = t.openedAt || t.addedAt; if (!o) return false; const x = hm(o); return x < "09:25" || x >= "16:00"; };
  const cmj = rd("cost-model.json"), cm = cmj.netEdgeByClass || {}, RT_EQ = cmj.perClass.Equity.roundTripPct / 100;
  const classCostR = (c) => (cm[c] && Number.isFinite(cm[c].meanCostR) ? cm[c].meanCostR : 0);
  const rk = (t) => { const r = riskOf(t); return Number.isFinite(r) ? r : 0; };
  const costUsd = (t) => (t.cls === "Options" ? 0 : t.strategy === "R24-13F-clone" ? (Number.isFinite(notionalOf(t)) ? RT_EQ * notionalOf(t) : 0) : (t.obs && Number.isFinite(t.obs.costR) ? t.obs.costR : classCostR(t.cls)) * rk(t));
  const weekOf = (d) => { const x = new Date(d + "T12:00:00Z"), w = (x.getUTCDay() + 6) % 7; return new Date(x.getTime() - w * 864e5).toISOString().slice(0, 10); };
  const res = {};
  for (const since of ["2026-09-25", "2026-08-25"]) {
    const all = L.signals.filter((t) => !t.ctrl && Number.isFinite(t.pnl) && mtDay(t.closedAt) >= since);
    const table = all.filter((t) => !isOvernight(t)), hidden = all.filter(isOvernight);
    const days = [...new Set(all.map((t) => mtDay(t.closedAt)))].sort();
    const series = (rows, f) => days.map((d) => sum(rows.filter((t) => mtDay(t.closedAt) === d).map(f)));
    const g = series(table, (t) => t.pnl), gh = series(all, (t) => t.pnl), ch = series(all, costUsd);
    const st = days.map((d) => sum(stale.filter((r) => r.expiry === d).map((r) => r.settleUsd || 0)));
    const wk = (a) => { const m = {}; days.forEach((d, i) => { m[weekOf(d)] = (m[weekOf(d)] || 0) + a[i]; }); return Object.values(m); };
    const top2 = (a) => { const s = [...a].sort((x, y) => y - x); return s[0] + s[1]; };
    const variant = (label, a) => ({ label, totalUsd: Math.round(sum(a)), perSessionUsd: Math.round(mean(a)), tByCloseDay: r2(tOf(a)), weeks: wk(a).length, tByWeek: r2(tOf(wk(a))), positiveDays: a.filter((x) => x > 0).length, top2DaysUsd: Math.round(top2(a)), exTop2Usd: Math.round(sum(a) - top2(a)) });
    const net = (a, b, k) => a.map((x, i) => x - k * b[i]);
    const v = [variant("table gross (the dashboard figure)", g), variant("table + hidden gross", gh), variant("table + hidden, modelled cost x1", net(gh, ch, 1)),
      variant("table + hidden, modelled cost x0.46 (mirror-measured since 10-02)", net(gh, ch, 0.46)), variant("table + hidden, modelled cost x0.68 (mirror-measured, all)", net(gh, ch, 0.68)),
      variant("table + hidden, modelled cost x2", net(gh, ch, 2)), variant("table + hidden gross + stale spreads on their expiry days", gh.map((x, i) => x + st[i]))];
    const wins = table.filter((t) => t.pnl > 0), loss = table.filter((t) => t.pnl <= 0);
    res[since] = { sessions: days.length, tableTickets: table.length, hiddenTickets: hidden.length, winPct: r2(100 * wins.length / table.length), avgWinUsd: r2(mean(wins.map((t) => t.pnl))), avgLossUsd: r2(mean(loss.map((t) => t.pnl))),
      modelledCostUsd: Math.round(sum(ch)), staleInWindowUsd: Math.round(sum(st)), variants: v, dailyTableGross: days.map((d, i) => [d, Math.round(g[i])]) };
    console.log(`\nH3) board closed since ${since}: ${days.length} MT close days, table ${table.length} tickets (${res[since].winPct}% wins, avg win ${usdF(res[since].avgWinUsd)}, avg loss ${usdF(res[since].avgLossUsd)}) + hidden ${hidden.length}; modelled cost ${usdF(-sum(ch))}; stale spreads expiring in the window ${usdF(sum(st))}`);
    for (const x of v) console.log(`      ${x.label.padEnd(66)} ${usdF(x.totalUsd).padStart(9)}  ${usdF(x.perSessionUsd).padStart(6)}/session  t by day ${String(x.tByCloseDay).padStart(6)}  t by week (${x.weeks}) ${String(x.tByWeek).padStart(6)}  days up ${String(x.positiveDays).padStart(2)}/${days.length}  top-2 days ${usdF(x.top2DaysUsd)}  rest ${usdF(x.exTop2Usd)}`);
    console.log(`      daily table gross: ${days.map((d, i) => d.slice(5) + " " + usdF(g[i])).join(", ")}`);
  }
  out.boardByDay = res;
}

(async () => {
  const L = rc.cleanEraLedger();
  const m = +mean(L.signals.map((t) => t.rMult)).toFixed(4);
  rc.assertReconciled("signal count", L.signals.length, L.n, { log: false });
  rc.assertReconciled("signal mean R (4dp)", m, L.meanR, { log: false, tolerance: 1e-9 });
  console.log(`  RECONCILED  canonical ledger ${L.source}: ${L.signals.length} signals at ${L.meanR}R, ${L.controls.length} controls`);
  try { await partH1(); } catch (e) { console.log("H1) error: " + e.message); out.cryptoLegsVsBroker = { error: e.message }; }
  const stale = await partH2(L);
  partH3(L, stale);
  partH4();
  if (!argv.includes("--no-write")) writeJsonAtomic(path.join(DATA, "profit-program", "skeptic-sleeves3.json"), out);
})().catch((e) => { console.log("error:", e.message); process.exitCode = 1; });
