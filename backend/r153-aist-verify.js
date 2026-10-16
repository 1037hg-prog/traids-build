#!/usr/bin/env node
/**
 * R153 (third script) — TRANSLATION VERIFICATION of "AI SuperTrend x Pivot Percentile - Strategy [PresentTrading]" (published
 * 2024-01-27) against TradingView's own Strategy Report (2026-09-23, operator: "AI SuperTrend then 1-3"). Not a performance test.
 *
 * Report (Properties): BITFINEX:BTCUSD 6 hours; defaults (k 6, n 48; ST1 on '360' len 10 x3.5 WMA volume-weighted; ST2 on '720'
 * len 5 x3; KNN price WMA 10 vs WMA(ST,80); pivot percentile 14; ADX 14 on 'D' with filter ON; direction Both); 10% of equity,
 * commission 0.1%, slippage 1 tick. 139 trades 2013-05 .. 2024-01 (138 closed). The report's times are New York local; stored as UTC.
 * Our bars: 6h / 12h / 1D built (UTC boundaries) from Coinbase BTC-USD hourly, which starts 2015-07-20 — trades before ~2015-10 cannot
 * be checked. Volume is Coinbase's, not Bitfinex's (the SuperTrend centre is volume-weighted), so some drift is expected.
 *
 * Translated as written, including its quirks:
 *   - the KNN includes the current point itself at distance 0 (weight 1e6), so label_ is ~ the current label; ==1 / ==0 need unanimity
 *   - the pivot-percentile length array overwrites slots 3 and 4 and leaves 5, 6 as na: effective lengths 14, 28, 42, 84, 98
 *   - the ADX/DMI deltas are taken bar-to-bar on the 6h chart of daily values (non-zero only when the daily value changes)
 *   - exits: a stop at superTrend -/+ 3.5 x ATR, re-set on every bar where the exit condition holds; entries reverse positions
 *   --htf confirmed (default): a higher-timeframe value is the last COMPLETED 12h/1D bar (Pine lookahead_off on history);
 *   --htf forming: the forming higher-timeframe bar's value so far. Both are checked; the one TradingView's trades match is reported.
 */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), TV = D("r153-tv-trades-aist.json"), OUT = D("r153-aist-verify.json");
const LAG = process.argv.includes("--lag") ? +process.argv[process.argv.indexOf("--lag") + 1] : 0;
const HTF = process.argv.includes("--htf") ? process.argv[process.argv.indexOf("--htf") + 1] : "confirmed";

const BFX = D("r153-bitfinex-btcusd-candles.json");
async function bitfinexCandles() {        // Bitfinex public candles (the report's own exchange): [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME]
  if (fs.existsSync(BFX)) return JSON.parse(fs.readFileSync(BFX, "utf8")).tf;
  const tf = {};
  for (const [k, ms] of [["6h", 216e5], ["12h", 432e5], ["1D", 864e5]]) { const rows = new Map(); let start = Date.parse("2013-01-01T00:00:00Z"); const end = Date.parse("2026-09-22T21:00:00Z");
    while (start < end) { const u = `https://api-pub.bitfinex.com/v2/candles/trade:${k}:tBTCUSD/hist?limit=10000&sort=1&start=${start}&end=${end}`;
      const r = await fetch(u, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error("Bitfinex " + r.status); const j = await r.json(); if (!j.length) break;
      for (const [t, o, c, h, l, v] of j) rows.set(t, { ts: t / 1000, o, h, l, c, v }); start = j[j.length - 1][0] + ms; await new Promise((z) => setTimeout(z, 1500)); }
    tf[k] = [...rows.values()].sort((a, b) => a.ts - b.ts); }
  writeJsonAtomic(BFX, { source: "Bitfinex public API v2 candles trade:{6h,12h,1D}:tBTCUSD", fetchedAt: new Date().toISOString(), tf }); return tf;
}
function hourly() { const m = new Map(); for (const f of ["r153-btc-coinbase-hourly.json", "r155-btc-coinbase-hourly-ext.json"]) for (const h of JSON.parse(fs.readFileSync(D(f), "utf8")).hours) m.set(h[0], h); return [...m.values()].sort((a, b) => a[0] - b[0]); }
function agg(hrs, hours) { const map = new Map(); for (const [ts, o, h, l, c, v] of hrs) { const k = Math.floor(ts / (hours * 3600)) * hours * 3600, b = map.get(k); if (!b) map.set(k, { ts: k, o, h, l, c, v }); else { b.h = Math.max(b.h, h); b.l = Math.min(b.l, l); b.c = c; b.v += v; } } return [...map.values()].sort((a, b) => a.ts - b.ts); }
const wma = (a, n) => { const o = new Array(a.length).fill(NaN), den = n * (n + 1) / 2; for (let i = n - 1; i < a.length; i++) { let s = 0, bad = false; for (let k = 0; k < n; k++) { const v = a[i - k]; if (isNaN(v)) { bad = true; break; } s += v * (n - k); } if (!bad) o[i] = s / den; } return o; };
const rmaAtr = (b, n) => { const tr = b.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l), o = new Array(b.length).fill(NaN); let s = 0; for (let i = 0; i < b.length; i++) { if (i < n) { s += tr[i]; if (i === n - 1) o[i] = s / n; } else o[i] = (tr[i] + (n - 1) * o[i - 1]) / n; } return o; };
const pnr = (a, len, p, i) => { if (!(len > 0) || i - len + 1 < 0) return NaN; const w = a.slice(i - len + 1, i + 1).sort((x, y) => x - y); return w[Math.max(0, Math.ceil(p / 100 * len) - 1)]; };
// map a higher-timeframe series onto chart bars: value of the last HTF bar completed at the chart bar's close (or the forming one)
function mapHTF(chart, htf, hours, vals) {
  const idx = new Map(htf.map((b, i) => [b.ts, i])), out = new Array(chart.length).fill(NaN), span = hours * 3600; let cur = null;
  for (let j = 0; j < chart.length; j++) { const k0 = Math.floor(chart[j].ts / span) * span, i = idx.get(k0); if (i == null) continue;
    const completes = k0 + span === chart[j].ts + 6 * 3600;
    if (!cur || cur.k0 !== k0) cur = { k0, h: chart[j].h, l: chart[j].l }; else { cur.h = Math.max(cur.h, chart[j].h); cur.l = Math.min(cur.l, chart[j].l); }
    if (completes) out[j] = vals[i];
    else if (HTF === "forming" && vals.field) out[j] = vals.field === "close" ? chart[j].c : vals.field === "high" ? cur.h : cur.l;
    else out[j] = i > 0 ? vals[i - 1] : NaN; }
  return out;
}
function supertrend(close, vwmaC, atr, factor) {
  const n = close.length, dir = new Array(n).fill(NaN), st = new Array(n).fill(NaN), up = new Array(n).fill(NaN), lo = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) { const ru = vwmaC[i] + factor * atr[i], rl = vwmaC[i] - factor * atr[i], pl = i ? (isNaN(lo[i - 1]) ? 0 : lo[i - 1]) : 0, pu = i ? (isNaN(up[i - 1]) ? 0 : up[i - 1]) : 0, c1 = i ? close[i - 1] : NaN;
    lo[i] = rl > pl || c1 < pl ? rl : pl; up[i] = ru < pu || c1 > pu ? ru : pu;
    if (!i || isNaN(atr[i - 1])) dir[i] = 1; else if (st[i - 1] === pu) dir[i] = close[i] > up[i] ? -1 : 1; else dir[i] = close[i] < lo[i] ? 1 : -1;
    st[i] = dir[i] === -1 ? lo[i] : up[i]; }
  return { dir, st };
}
function knnLabel(st, lab, t, k = 6, n = 48) {
  if (t - n + 1 < 0) return NaN; const x = st[t], d = [], idx = [];
  for (let i = 0; i < n; i++) { d.push(Math.abs(x - st[t - i])); idx.push(i); }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - i - 1; j++) if (d[j] > d[j + 1]) { [d[j], d[j + 1]] = [d[j + 1], d[j]]; [idx[j], idx[j + 1]] = [idx[j + 1], idx[j]]; }
  let ws = 0, tw = 0; for (let i = 0; i < k; i++) { const w = 1 / (d[i] + 1e-6); ws += w * lab[t - idx[i]]; tw += w; } return ws / tw;
}
function signals(src) {
  const b = src.tf ? src.tf["6h"] : agg(src, 6), b12 = src.tf ? src.tf["12h"] : agg(src, 12), b24 = src.tf ? src.tf["1D"] : agg(src, 24), n = b.length, c = b.map((x) => x.c), h = b.map((x) => x.h), l = b.map((x) => x.l), v = b.map((x) => x.v);
  const wv10 = wma(v, 10), wv5 = wma(v, 5), vw1 = wma(c.map((x, i) => x * v[i]), 10).map((s, i) => s / wv10[i]), atr1 = rmaAtr(b, 10);
  const c12 = Object.assign(b12.map((x) => x.c), { field: "close" }), tc2 = mapHTF(b, b12, 12, c12), atr12 = rmaAtr(b12, 5), atr2 = mapHTF(b, b12, 12, atr12);
  const vw2 = wma(tc2.map((x, i) => x * v[i]), 5).map((s, i) => s / wv5[i]);
  const s1 = supertrend(c, vw1, atr1, 3.5), s2 = supertrend(c, vw2, atr2, 3.0);
  const price = wma(c, 10), sT1 = wma(s1.st, 80), sT2 = wma(s2.st, 80), lab1 = price.map((p, i) => p > sT1[i] ? 1 : 0), lab2 = price.map((p, i) => p > sT2[i] ? 1 : 0);
  const L1 = new Array(n).fill(NaN), L2 = new Array(n).fill(NaN); for (let t = 0; t < n; t++) { L1[t] = knnLabel(s1.st, lab1, t); L2[t] = knnLabel(s2.st, lab2, t); }
  const Hd = mapHTF(b, b24, 24, Object.assign(b24.map((x) => x.h), { field: "high" })), Ld = mapHTF(b, b24, 24, Object.assign(b24.map((x) => x.l), { field: "low" })), Cd = mapHTF(b, b24, 24, Object.assign(b24.map((x) => x.c), { field: "close" }));
  const dH = Hd.map((x, i) => i ? x - Hd[i - 1] : NaN), dL = Ld.map((x, i) => i ? Ld[i - 1] - x : NaN), pDM = dH.map((x, i) => x > dL[i] && x > 0 ? x : 0), mDM = dL.map((x, i) => x > dH[i] && x > 0 ? x : 0);
  const ATR = wma(Hd.map((x, i) => i ? Math.abs(x - Ld[i]) + Math.abs(x - Cd[i - 1]) + Math.abs(Ld[i] - Cd[i - 1]) : NaN), 14), pDI = wma(pDM, 14).map((x, i) => 100 * x / ATR[i]), mDI = wma(mDM, 14).map((x, i) => 100 * x / ATR[i]);
  const ADX = wma(pDI.map((p, i) => 100 * Math.abs(p - mDI[i]) / (p + mDI[i])), 14);
  const lens = [14, 28, 42, 84, 98, NaN, NaN], ctv = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) { const hh = pnr(h, 144, 75, i), ll = pnr(l, 144, 25, i); if (isNaN(hh)) continue; let cb = 0, cr = 0, wb = 0, wr = 0;
    for (const L of lens) { const ph = pnr(h, L, 75, i), pl = pnr(l, L, 25, i); cb += (ph > hh) + (pl > hh); cr += (ph < ll) + (pl < ll); wb += pl < hh && pl > ll ? 1 : 0; wr += ph > ll && ph < hh ? 1 : 0; }
    const bull = cb + 0.5 * wb - 0.5 * wr - cr, bear = cr + 0.5 * wr - 0.5 * wb - cb; ctv[i] = bull - bear; }
  const S = [];
  for (let i = 0; i < n; i++) { const d1 = s1.dir[i], d2 = s2.dir[i], p1 = i ? s1.dir[i - 1] : NaN, p2 = i ? s2.dir[i - 1] : NaN;
    const tUp = d1 === -1 && p1 === 1 && L1[i] === 1, tUp2 = d2 === -1 && p2 === 1 && L2[i] === 1, tDn = d1 === 1 && p1 === -1 && L1[i] === 0, tDn2 = d2 === 1 && p2 === -1 && L2[i] === 0;
    const adxL = ADX[i] > 20 && pDI[i] > mDI[i], adxS = ADX[i] > 20 && mDI[i] > pDI[i];
    S.push({ long: d1 < 0 && L1[i] === 1 && d2 < 0 && L2[i] === 1 && adxL && ctv[i] > 0, short: d1 > 0 && L1[i] === 0 && d2 > 0 && L2[i] === 0 && adxS && ctv[i] < 0,
      exitL: !(tUp || tUp2) || ctv[i] < 0, exitS: !(tDn || tDn2) || ctv[i] > 0, stopL: s1.st[i] - atr1[i] * 3.5, stopS: s1.st[i] + atr1[i] * 3.5 }); }
  return { b, S };
}
function simulate(hrs, from, to) {
  const { b, S } = signals(hrs), out = []; let pos = null, pend = 0, stopL = NaN, stopS = NaN;
  for (let i = 0; i < b.length; i++) { const x = b[i], T = new Date(x.ts * 1000).toISOString();
    if (pend) { if (pos && pos.dir !== pend) { out.push({ ...pos, exitT: T, exit: x.o, why: "reverse" }); pos = null; } if (!pos) pos = { dir: pend, entryT: T, entry: x.o }; pend = 0; }
    if (pos) { const sp = pos.dir > 0 ? stopL : stopS; if (!isNaN(sp)) { if (pos.dir > 0 ? x.o <= sp : x.o >= sp) { out.push({ ...pos, exitT: T, exit: x.o, why: "stop (gap)" }); pos = null; } else if (pos.dir > 0 ? x.l <= sp : x.h >= sp) { out.push({ ...pos, exitT: T, exit: sp, why: "stop" }); pos = null; } } }
    const s = S[i - LAG] || {}; if (s.exitL) stopL = s.stopL; if (s.exitS) stopS = s.stopS;
    if (T < from || T >= to || i + 1 >= b.length) continue;
    if (s.long && !(pos && pos.dir > 0)) pend = 1; else if (s.short && !(pos && pos.dir < 0)) pend = -1; }
  if (pos) out.push({ ...pos, exitT: null, exit: b[b.length - 1].c, why: "open" });
  return out.map((t) => ({ ...t, retPct: +(100 * (t.dir * (t.exit / t.entry - 1) - 0.002)).toFixed(2) }));
}
module.exports = { hourly, simulate, bitfinexCandles };

if (require.main === module) (async () => {
  const SRC = process.argv.includes("--coinbase") ? hourly() : { tf: await bitfinexCandles() };
  const tv = JSON.parse(fs.readFileSync(TV, "utf8")).trades, CHECK_FROM = process.argv.includes("--coinbase") ? "2015-10-15T00:00:00Z" : "2013-01-01T00:00:00Z";
  const ours = simulate(SRC, "2013-01-01T00:00:00Z", "2024-01-27T00:00:00Z").filter((t) => t.entryT >= CHECK_FROM);
  const tvC = tv.filter((t) => t.entryT >= CHECK_FROM), hrs = (a, b) => (Date.parse(a) - Date.parse(b)) / 36e5, used = new Set();
  const rows = tvC.map((t) => { let best = null; ours.forEach((o, k) => { if (used.has(k) || o.dir !== t.dir) return; const d = Math.abs(hrs(o.entryT, t.entryT)); if (d <= 6 && (!best || d < best.d)) best = { k, d }; });
    if (!best) return { tv: t, match: "MISSING" }; used.add(best.k); const o = ours[best.k];
    const ok = t.exitT ? (o.exitT && Math.abs(hrs(o.exitT, t.exitT)) <= 12 && Math.abs(o.exit / t.exit - 1) <= 0.02) : true; return { tv: t, ours: o, match: ok ? "MATCH" : "ENTRY ONLY" }; });
  // second pass: a remaining TV trade whose entry is within 48h (same side) AND whose exit is within 12h / 2% = same trade, entry shifted
  for (const r of rows) { if (r.match !== "MISSING") continue; const t = r.tv; let best = null;
    ours.forEach((o, k) => { if (used.has(k) || o.dir !== t.dir) return; const d = Math.abs(hrs(o.entryT, t.entryT)); const exOk = t.exitT ? (o.exitT && Math.abs(hrs(o.exitT, t.exitT)) <= 12 && Math.abs(o.exit / t.exit - 1) <= 0.02) : !o.exitT;
      if (d <= 48 && exOk && (!best || d < best.d)) best = { k, d }; });
    if (best) { used.add(best.k); r.ours = ours[best.k]; r.match = "SHIFTED ENTRY, SAME EXIT"; } }
  const nS = rows.filter((r) => r.match === "SHIFTED ENTRY, SAME EXIT").length;
  const extra = ours.filter((o, k) => !used.has(k) && o.entryT < "2024-01-27"), nM = rows.filter((r) => r.match === "MATCH").length, nE = rows.filter((r) => r.match !== "MISSING").length;
  writeJsonAtomic(OUT, { spec: "r153-aist-verify-v1", asOf: new Date().toISOString(), htf: HTF, checkedFrom: CHECK_FROM, tvTradesChecked: tvC.length, fullMatches: nM, entryMatches: nE, shiftedEntrySameExit: nS, extraTradesOurs: extra.length, rows, extra });
  console.log(`R153 AI-SuperTrend [htf ${HTF}]: ${nM}/${tvC.length} full matches, ${nE}/${tvC.length} entries (±1 bar, same side), ${nS} same exit with entry shifted <=48h, ${extra.length} extra of ours (${ours.length} total from ${CHECK_FROM.slice(0, 10)})`);
  if (process.argv.includes("--rows")) for (const r of rows.slice(0, 40)) console.log(`  TV ${r.tv.dir > 0 ? "L" : "S"} ${r.tv.entryT.slice(0, 13)}→${(r.tv.exitT || "open").slice(0, 13)} | ours ${r.ours ? r.ours.entryT.slice(0, 13) + "→" + (r.ours.exitT || "open").slice(0, 13) + " " + r.ours.why : "—"} ${r.match}`);
})();
