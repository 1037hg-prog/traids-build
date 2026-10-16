#!/usr/bin/env node
/** $100k BOOK PLAN, year by year in dollars, WITH DIVIDENDS (2026-09-25, operator: "we need the dividends"). EXPLORATORY; seals nothing.
 *  Stock/ETF sleeves use Alpaca SIP daily adjustment=all (total return) — NOT the Yahoo proxy, whose adjClose was raw close until the
 *  2026-09-25 fix. Plans (each year starts fresh at $100,000, monthly rebalance to the weights):
 *    A  4.2x ZN month-end overlay + $30k QQQ + $30k SPY (10-month filter) + $15k BTC/ETH 50-day + $25k T-bills
 *    B  same, but $20k SPY-side moves to DBMF (held always): $20k QQQ + $20k SPY + $20k DBMF (from 2019-06)
 *  node backend/plan-years.js */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TBY = (() => { const M = {}; for (const l of fs.readFileSync(path.join(__dirname, "data", "training", "fred", "DTB3.csv"), "utf8").trim().split(/\r?\n/).slice(1)) { const [d, v] = l.split(","); if (v && v !== ".") M[d.slice(0, 7)] = +v / 100; } return M; })();
async function candles(coin) { const all = [], stop = Date.parse("2017-01-01"); let end = Date.parse("2026-09-01");
  while (end > stop) { const s = Math.max(stop, end - 299 * 864e5); const r = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(end).toISOString()}`, { headers: { "User-Agent": "TRAIDS plan-years" } }); const a = await r.json(); if (!Array.isArray(a)) break; all.push(...a); if (!a.length && all.length) break; end = s - 864e5; await sleep(350); }
  const m = new Map(); for (const [t, , , , c] of all) m.set(new Date(t * 1000).toISOString().slice(0, 10), c); return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, c]) => ({ d, c })); }
function cryptoDaily(rows) { const out = new Map(); let pos = 0; for (let i = 50; i < rows.length; i++) { const r = rows[i].c / rows[i - 1].c - 1; let v = pos ? r : (TBY[rows[i].d.slice(0, 7)] || 0) / 365; const on = rows[i].c > mean(rows.slice(i - 49, i + 1).map((x) => x.c)) ? 1 : 0; if (on !== pos) v -= 0.0025; out.set(rows[i].d, v); pos = on; } return out; }
const monthEnds = (bars) => { const me = {}; for (const b of bars) me[b.t.slice(0, 7)] = b.c; return me; };
function trendMonthly(me) { const ms = Object.keys(me).sort(), out = {}; let prevOn = null;
  for (let i = 10; i < ms.length; i++) { const on = me[ms[i - 1]] > mean(ms.slice(i - 10, i).map((m) => me[m])); out[ms[i]] = (on ? me[ms[i]] / me[ms[i - 1]] - 1 : (TBY[ms[i]] || 0) / 12) - (prevOn !== null && on !== prevOn ? 0.0005 : 0); prevOn = on; }
  return out; }
function holdMonthly(me) { const ms = Object.keys(me).sort(), out = {}; for (let i = 1; i < ms.length; i++) out[ms[i]] = me[ms[i]] / me[ms[i - 1]] - 1; return out; }
(async () => {
  const { bars } = await fetchBars(["QQQ", "SPY", "DBMF"], { start: "2016-01-01", end: "2026-08-31T23:00:00Z", feed: "sip", adjustment: "all", quiet: true, requireAll: false });
  const Q = trendMonthly(monthEnds(bars.QQQ)), S = trendMonthly(monthEnds(bars.SPY)), DB = holdMonthly(monthEnds(bars.DBMF));
  const btc = await candles("BTC"), eth = await candles("ETH"), cb = cryptoDaily(btc), ce = cryptoDaily(eth), C = {};
  for (const [d, a] of cb) { if (!ce.has(d)) continue; const m = d.slice(0, 7); C[m] = (C[m] || 1) * (1 + 0.5 * a + 0.5 * ce.get(d)); } for (const m in C) C[m] -= 1;
  const TR = new Map(JSON.parse(fs.readFileSync(path.join(__dirname, "data", "futures-month-end.json"), "utf8")).rowsOut.map((r) => [r.m, r]));
  const L = 4.2;
  const plan = (m, withDbmf) => { const t = TR.get(m); const tre = L * t.tre, cr = 0.15 * C[m], tb = 0.25 * t.tb;
    const eq = withDbmf ? 0.2 * Q[m] + 0.2 * S[m] : 0.3 * Q[m] + 0.3 * S[m], db = withDbmf ? 0.2 * DB[m] : 0; return { tre, eq, cr, tb, db, r: tre + eq + cr + tb + db }; };
  const years = (lo, withDbmf) => { const ms = Object.keys(C).filter((m) => m >= lo && m <= "2026-08" && TR.has(m) && Q[m] != null && S[m] != null && (!withDbmf || DB[m] != null)).sort(); const Y = {};
    for (const m of ms) { const p = plan(m, withDbmf), y = m.slice(0, 4); const o = (Y[y] = Y[y] || { nav: 1, pk: 1, dd: 0, tre: 0, eq: 0, cr: 0, tb: 0, db: 0 }); for (const k of ["tre", "eq", "cr", "tb", "db"]) o[k] += p[k] * o.nav * 100000; o.nav *= 1 + p.r; o.pk = Math.max(o.pk, o.nav); o.dd = Math.min(o.dd, o.nav / o.pk - 1); }
    const all = ms.map((m) => plan(m, withDbmf).r), w = all.reduce((p, x) => p * (1 + x), 1); let pk = 1, v = 1, dd = 0; for (const x of all) { v *= 1 + x; pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); }
    return { from: ms[0], cagrPct: +(100 * (w ** (12 / all.length) - 1)).toFixed(1), maxDDPct: +(100 * dd).toFixed(1), sharpe: +((mean(all) / sd(all)) * Math.sqrt(12)).toFixed(2),
      byYear: Object.fromEntries(Object.entries(Y).map(([y, o]) => [y, { total: Math.round((o.nav - 1) * 100000), treasury: Math.round(o.tre), stocks: Math.round(o.eq), crypto: Math.round(o.cr), dbmf: Math.round(o.db), tbills: Math.round(o.tb), worstDipPct: +(100 * o.dd).toFixed(1) }])) }; };
  const out = { dividends: "included (Alpaca adjustment=all)", A_2018: years("2018-01", false), A_2019_06: years("2019-06", false), B_2019_06: years("2019-06", true) };
  writeJsonAtomic(path.join(__dirname, "data", "plan-years.json"), { ranAt: new Date().toISOString(), exploratory: true, out });
  const show = (name, x) => { console.log(`${name}  from ${x.from}: CAGR ${x.cagrPct}%  maxDD ${x.maxDDPct}%  Sharpe ${x.sharpe}`); for (const [y, o] of Object.entries(x.byYear)) console.log(`  ${y} total ${String(o.total).padStart(7)} | treasury ${String(o.treasury).padStart(6)} stocks ${String(o.stocks).padStart(6)} crypto ${String(o.crypto).padStart(6)} dbmf ${String(o.dbmf).padStart(6)} tbills ${String(o.tbills).padStart(5)} | dip ${o.worstDipPct}%`); };
  show("PLAN A (current)", out.A_2018); show("PLAN A", out.A_2019_06); show("PLAN B (+DBMF)", out.B_2019_06);
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
