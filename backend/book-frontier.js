#!/usr/bin/env node
/** BOOK FRONTIER (2026-09-25, operator: "we need to get this thing making 25-30% returns with minimal drawdown"). EXPLORATORY; seals nothing.
 *  Three sleeves, monthly, 2018-01..2026-08 (2017 excluded on purpose — see crypto-trend-book audit):
 *    T  Treasury month-end on ZN at leverage L (data/futures-month-end.json rowsOut.tre; overlay on NAV, margin only)
 *    C  BTC/ETH 50/50 on the 50-day rule (Coinbase daily; next-day application; 25 bps per switch; T-bills when out)
 *    E  QQQ or SPY with a 10-month (≈200-day) filter: hold next month if the month-end close > 10-month average, else T-bills; 5 bps/switch
 *  Book = L x tre + wC x C + wE x E + (1 - wC - wE) x tbill. Grid search IS in-sample — the table is a map of the trade-offs, not a forecast.
 *  Also reports each winning mix on 2021-2026 and with crypto drift set to 0/10/20%/yr.
 *  node backend/book-frontier.js */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function candles(coin) { const all = [], stop = Date.parse("2016-06-01"); let end = Date.parse("2026-09-01");
  while (end > stop) { const s = Math.max(stop, end - 299 * 864e5); const r = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(end).toISOString()}`, { headers: { "User-Agent": "TRAIDS book-frontier" } }); const a = await r.json(); if (!Array.isArray(a)) break; all.push(...a); if (!a.length && all.length) break; end = s - 864e5; await sleep(350); }
  const m = new Map(); for (const [t, , , , c] of all) m.set(new Date(t * 1000).toISOString().slice(0, 10), c); return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, c]) => ({ d, c })); }
const TBD = (() => { const M = {}; for (const l of fs.readFileSync(path.join(__dirname, "data", "training", "fred", "DTB3.csv"), "utf8").trim().split(/\r?\n/).slice(1)) { const [d, v] = l.split(","); if (v && v !== ".") M[d.slice(0, 7)] = +v / 100; } return M; })();
function cryptoDaily(rows) { const out = new Map(); let pos = 0; for (let i = 50; i < rows.length; i++) { const r = rows[i].c / rows[i - 1].c - 1; let v = pos ? r : (TBD[rows[i].d.slice(0, 7)] || 0) / 365; const on = rows[i].c > mean(rows.slice(i - 49, i + 1).map((x) => x.c)) ? 1 : 0; if (on !== pos) v -= 0.0025; out.set(rows[i].d, v); pos = on; } return out; }
async function yahoo(sym) { const j = await (await fetch(`http://localhost:3002/api/yahoo/${sym}/history?days=9000&interval=1d`, { signal: AbortSignal.timeout(60000) })).json(); return j.bars.filter((b) => b.date <= "2026-08-31" && (b.adjClose || b.close) > 0).map((b) => ({ d: b.date, c: b.adjClose || b.close })); }
function equityMonthly(rows) {   // 10-month filter on month-end closes; position decided at month m-1's end applies to month m
  const me = {}; for (const r of rows) me[r.d.slice(0, 7)] = r.c; const ms = Object.keys(me).sort(), out = {};
  for (let i = 11; i < ms.length; i++) { const prev = ms.slice(i - 11, i).map((m) => me[m]), on = me[ms[i - 1]] > mean(prev.slice(-10)); const onBefore = i > 11 ? me[ms[i - 2]] > mean(ms.slice(i - 12, i - 1).map((m) => me[m]).slice(-10)) : on;
    out[ms[i]] = (on ? me[ms[i]] / me[ms[i - 1]] - 1 : (TBD[ms[i]] || 0) / 12) - (on !== onBefore ? 0.0005 : 0); }
  return out; }
function stats(r) { const w = r.reduce((p, x) => p * (1 + x), 1); let pk = 1, v = 1, dd = 0; for (const x of r) { v *= 1 + x; pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); } return { cagr: 100 * (w ** (12 / r.length) - 1), sharpe: (mean(r) / sd(r)) * Math.sqrt(12), dd: 100 * dd }; }
(async () => {
  const btc = await candles("BTC"), eth = await candles("ETH"), qqq = await yahoo("QQQ"), spy = await yahoo("SPY");
  const TR = new Map(JSON.parse(fs.readFileSync(path.join(__dirname, "data", "futures-month-end.json"), "utf8")).rowsOut.map((r) => [r.m, r]));
  const cb = cryptoDaily(btc), ce = cryptoDaily(eth), C = {}; for (const [d, a] of cb) { if (!ce.has(d)) continue; const m = d.slice(0, 7); C[m] = (C[m] || 1) * (1 + 0.5 * a + 0.5 * ce.get(d)); } for (const m in C) C[m] -= 1;
  const EQ = { QQQ: equityMonthly(qqq), SPY: equityMonthly(spy) };
  const months = (lo, hi) => Object.keys(C).filter((m) => m >= lo && m <= hi && TR.has(m) && EQ.QQQ[m] != null && EQ.SPY[m] != null).sort();
  const book = (ms, L, wC, wE, eq, cDrift = null) => { let cAdj = 0; if (cDrift != null) { const hist = ms.map((m) => C[m]); cAdj = (1 + cDrift) ** (1 / 12) - 1 - mean(hist); }
    return ms.map((m) => { const t = TR.get(m); return L * t.tre + wC * (C[m] + cAdj) + wE * EQ[eq][m] + (1 - wC - wE) * t.tb; }); };
  const M18 = months("2018-01", "2026-08"), M21 = months("2021-01", "2026-08"), rows = [];
  for (const eq of ["QQQ", "SPY"]) for (const L of [0, 3, 4, 5]) for (const wC of [0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4]) for (const wE of [0, 0.2, 0.4, 0.6, 0.8]) {
    if (wC + wE > 1) continue; const s = stats(book(M18, L, wC, wE, eq)); rows.push({ eq, L, wC, wE, ...s }); }
  const fmt = (x) => ({ cagr: +x.cagr.toFixed(1), sharpe: +x.sharpe.toFixed(2), maxDD: +x.dd.toFixed(1) });
  const sleevesAlone = { "Treasury 5x (+T-bills)": fmt(stats(book(M18, 5, 0, 0, "QQQ"))), "crypto 50-day sleeve": fmt(stats(M18.map((m) => C[m]))), "QQQ 10-month filter": fmt(stats(M18.map((m) => EQ.QQQ[m]))), "SPY 10-month filter": fmt(stats(M18.map((m) => EQ.SPY[m]))), "QQQ buy & hold": fmt(stats(M18.map((m) => { const a = qqq.filter((r) => r.d.slice(0, 7) === m); const b = qqq.filter((r) => r.d.slice(0, 7) < m); return a.length && b.length ? a[a.length - 1].c / b[b.length - 1].c - 1 : 0; }))) };
  // for each target return band, the mix with the shallowest drawdown
  const pick = (lo) => rows.filter((r) => r.cagr >= lo).sort((a, b) => b.dd - a.dd)[0];
  const targets = {}; for (const lo of [15, 20, 25, 30]) { const p = pick(lo); if (!p) { targets[`>=${lo}%`] = "none in grid"; continue; }
    const s21 = stats(book(M21, p.L, p.wC, p.wE, p.eq)), stress = {}; for (const cd of [0, 0.1, 0.2]) stress[`crypto ${100 * cd}%/yr`] = fmt(stats(book(M18, p.L, p.wC, p.wE, p.eq, cd)));
    targets[`>=${lo}%`] = { mix: `Treasury ${p.L}x + ${100 * p.wC}% crypto trend + ${100 * p.wE}% ${p.eq} trend + rest T-bills`, "2018-26": fmt(p), "2021-26": fmt(s21), stress }; }
  const out = { window: `${M18[0]}..${M18[M18.length - 1]}`, sleevesAlone, bestMixByTarget: targets, gridSize: rows.length };
  writeJsonAtomic(path.join(__dirname, "data", "book-frontier.json"), { ranAt: new Date().toISOString(), exploratory: true, out, grid: rows.map((r) => ({ ...r, cagr: +r.cagr.toFixed(2), sharpe: +r.sharpe.toFixed(3), dd: +r.dd.toFixed(2) })) });
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
