#!/usr/bin/env node
/**
 * R153 (second script) — TRANSLATION VERIFICATION of "QQE MOD + SSL Hybrid + Waddah Attar Explosion" (kevinmck100, published 2022-05-05)
 * against TradingView's own Strategy Report (2026-09-23, operator: "keep mining"). Not a performance test.
 *
 * Report (Properties tab): BINANCE:BTCUSDT 1 hour, start 2022-01-01, defaults; 108 closed trades Jan 1 - May 5 2022, +28.40%, 66/108
 * winners, commission 0.01%. The trade list is held in data/r153-tv-trades-qqe-ssl-wae.json as the report lists it (times UTC).
 * Our bars: Coinbase BTC-USD hourly (R153/R155 caches) — not Binance BTCUSDT; hourly signals are more price-sensitive than daily ones.
 *
 * Only the parts of the script that decide trades are translated:
 *   QQE    RsiMa = EMA(RSI(6),6) with the QQE trailing band (factor 3, Wilders 11) -> FastAtrRsiTL; Bollinger(50, 0.35) of TL-50;
 *          QQE2 RsiMa2 = EMA(RSI(6),5); green bar = RsiMa2-50 > 3 AND RsiMa-50 > upper; qqeBuy = green and not green[1] (mirror red)
 *   SSL    BBMC = Keltma = HMA(close,60); upperk/lowerk = HMA +- 0.2*EMA(TR,60); sslBuy = close > upperk and > BBMC
 *   WAE    t1 = (MACD(20,40) - MACD[1]) * 180; e1 = 4*stdev(close,20); waeBuy = t1 > 0 and t1 > e1 (mirror for sells)
 *   entry  all three on the same bar, flat -> market at next open; stop = lowest low (highest high) of the last 10 bars incl. signal bar
 *   exit   SSL exit line (HMA(high/low,15) with Hlv3 state): long closes when close crosses under it AND the open trade is in
 *          profit at the close -> next open. Positions are never reversed directly.
 *
 *   node backend/r153-qqe-verify.js [--half floor|round]   (HMA(15)'s length/2 = 7.5 — Pine's conversion is checked both ways)
 */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), TV = D("r153-tv-trades-qqe-ssl-wae.json"), OUT = D("r153-qqe-verify.json");
const HALF = process.argv.includes("--half") ? process.argv[process.argv.indexOf("--half") + 1] : "floor";

function hourlyBars() {
  const m = new Map(); for (const f of ["r153-btc-coinbase-hourly.json", "r155-btc-coinbase-hourly-ext.json"]) for (const h of JSON.parse(fs.readFileSync(D(f), "utf8")).hours) m.set(h[0], h);
  return [...m.values()].sort((a, b) => a[0] - b[0]).map(([ts, o, h, l, c, v]) => ({ t: new Date(ts * 1000).toISOString(), o, h, l, c, v }));
}
// Pine v5 building blocks
const sma = (a, n) => { const o = new Array(a.length).fill(NaN); let s = 0, cnt = 0; const q = []; for (let i = 0; i < a.length; i++) { const v = a[i]; q.push(v); if (!isNaN(v)) { s += v; cnt++; } if (q.length > n) { const u = q.shift(); if (!isNaN(u)) { s -= u; cnt--; } } if (q.length === n && cnt === n) o[i] = s / n; } return o; };
const ema = (a, n) => { const o = new Array(a.length).fill(NaN), k = 2 / (n + 1), sm = sma(a, n); let prev = NaN; for (let i = 0; i < a.length; i++) { if (isNaN(prev)) { if (!isNaN(sm[i])) prev = sm[i]; } else if (!isNaN(a[i])) prev = k * a[i] + (1 - k) * prev; o[i] = prev; } return o; };
const rma = (a, n) => { const o = new Array(a.length).fill(NaN), sm = sma(a, n); let prev = NaN; for (let i = 0; i < a.length; i++) { if (isNaN(prev)) { if (!isNaN(sm[i])) prev = sm[i]; } else if (!isNaN(a[i])) prev = (a[i] + (n - 1) * prev) / n; o[i] = prev; } return o; };
const wma = (a, n) => { const o = new Array(a.length).fill(NaN), den = n * (n + 1) / 2; for (let i = n - 1; i < a.length; i++) { let s = 0, bad = false; for (let k = 0; k < n; k++) { const v = a[i - k]; if (isNaN(v)) { bad = true; break; } s += v * (n - k); } if (!bad) o[i] = s / den; } return o; };
const halfLen = (n) => HALF === "round" ? Math.round(n / 2) : Math.floor(n / 2);
const hma = (a, n) => { const w1 = wma(a, halfLen(n)), w2 = wma(a, n); return wma(w1.map((v, i) => 2 * v - w2[i]), Math.round(Math.sqrt(n))); };
const stdevP = (a, n) => { const o = new Array(a.length).fill(NaN); for (let i = n - 1; i < a.length; i++) { let s = 0; for (let k = 0; k < n; k++) s += a[i - k]; const m = s / n; let v = 0; for (let k = 0; k < n; k++) v += (a[i - k] - m) ** 2; o[i] = Math.sqrt(v / n); } return o; };
const rsi = (c, n) => { const ch = c.map((v, i) => i ? v - c[i - 1] : NaN), up = rma(ch.map((x) => isNaN(x) ? NaN : Math.max(x, 0)), n), dn = rma(ch.map((x) => isNaN(x) ? NaN : -Math.min(x, 0)), n); return up.map((u, i) => isNaN(u) || isNaN(dn[i]) ? NaN : dn[i] === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / dn[i])); };
function qqeTL(c, rsiLen, sf, fac) {
  const R = ema(rsi(c, rsiLen), sf), W = rsiLen * 2 - 1, atr = R.map((v, i) => i ? Math.abs(R[i - 1] - v) : NaN), dar = ema(ema(atr, W), W).map((x) => x * fac);
  const n = c.length, lb = new Array(n).fill(NaN), sb = new Array(n).fill(NaN), tl = new Array(n).fill(NaN); let trend = 1;
  for (let i = 0; i < n; i++) { if (isNaN(R[i]) || isNaN(dar[i])) { lb[i] = 0; sb[i] = 0; continue; }
    const nsb = R[i] + dar[i], nlb = R[i] - dar[i], l1 = i ? lb[i - 1] : NaN, s1 = i ? sb[i - 1] : NaN, r1 = i ? R[i - 1] : NaN;
    lb[i] = r1 > l1 && R[i] > l1 ? Math.max(l1, nlb) : nlb; sb[i] = r1 < s1 && R[i] < s1 ? Math.min(s1, nsb) : nsb;
    const crossUpS = i > 1 && ((R[i] > s1 && r1 <= sb[i - 2]) || (R[i] < s1 && r1 >= sb[i - 2]));                  // ta.cross(RSIndex, shortband[1])
    const crossLb = i > 1 && ((l1 > R[i] && lb[i - 2] <= r1) || (l1 < R[i] && lb[i - 2] >= r1));                   // ta.cross(longband[1], RSIndex)
    trend = crossUpS ? 1 : crossLb ? -1 : trend; tl[i] = trend === 1 ? lb[i] : sb[i]; }
  return { R, tl };
}
function signals(b) {
  const c = b.map((x) => x.c), h = b.map((x) => x.h), l = b.map((x) => x.l), n = b.length;
  const q1 = qqeTL(c, 6, 6, 3), q2 = qqeTL(c, 6, 5, 1.61), x = q1.tl.map((v) => v - 50), basis = sma(x, 50), dev = stdevP(x, 50).map((v) => 0.35 * v);
  const green = (i) => q2.R[i] - 50 > 3 && q1.R[i] - 50 > basis[i] + dev[i], red = (i) => q2.R[i] - 50 < -3 && q1.R[i] - 50 < basis[i] - dev[i];
  const tr = b.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : NaN), bbmc = hma(c, 60), rangema = ema(tr, 60);
  const upk = bbmc.map((v, i) => v + 0.2 * rangema[i]), lok = bbmc.map((v, i) => v - 0.2 * rangema[i]);
  const e20 = ema(c, 20), e40 = ema(c, 40), md = e20.map((v, i) => v - e40[i]), t1 = md.map((v, i) => i ? (v - md[i - 1]) * 180 : NaN), e1 = stdevP(c, 20).map((s) => 4 * s);
  const exH = hma(h, 15), exL = hma(l, 15), sslExit = new Array(n).fill(NaN); let hlv3 = NaN;
  for (let i = 0; i < n; i++) { hlv3 = c[i] > exH[i] ? 1 : c[i] < exL[i] ? -1 : hlv3; sslExit[i] = hlv3 < 0 ? exH[i] : exL[i]; }
  return { buy: (i) => i > 0 && green(i) && !green(i - 1) && c[i] > upk[i] && c[i] > bbmc[i] && t1[i] > 0 && t1[i] > e1[i],
           sell: (i) => i > 0 && red(i) && !red(i - 1) && c[i] < lok[i] && c[i] < bbmc[i] && -t1[i] > 0 && -t1[i] > e1[i],
           crossShort: (i) => i > 0 && sslExit[i] > c[i] && sslExit[i - 1] <= c[i - 1], crossLong: (i) => i > 0 && c[i] > sslExit[i] && c[i - 1] <= sslExit[i - 1] };
}
function simulate(b, start, end) {
  const s = signals(b), out = []; let pos = null, pend = null, pendExit = false;
  for (let i = 0; i < b.length; i++) { const x = b[i];
    if (pendExit && pos) { out.push({ ...pos, exitT: x.t, exit: x.o, why: "ssl exit" }); pos = null; } pendExit = false;
    if (pend && !pos) pos = { dir: pend.dir, entryT: x.t, entry: x.o, stop: pend.stop }; pend = null;
    if (pos) { if (pos.dir > 0 ? x.o <= pos.stop : x.o >= pos.stop) { out.push({ ...pos, exitT: x.t, exit: x.o, why: "stop (gap)" }); pos = null; }
      else if (pos.dir > 0 ? x.l <= pos.stop : x.h >= pos.stop) { out.push({ ...pos, exitT: x.t, exit: pos.stop, why: "stop" }); pos = null; } }
    if (x.t < start || x.t >= end || i + 1 >= b.length) continue;
    if (pos && ((pos.dir > 0 && s.crossShort(i)) || (pos.dir < 0 && s.crossLong(i))) && pos.dir * (x.c - pos.entry) > 0) pendExit = true;
    if (!pos) { let lo = Infinity, hi = -Infinity; for (let k = Math.max(0, i - 9); k <= i; k++) { lo = Math.min(lo, b[k].l); hi = Math.max(hi, b[k].h); }
      if (s.buy(i)) pend = { dir: 1, stop: lo }; else if (s.sell(i)) pend = { dir: -1, stop: hi }; } }
  if (pos) out.push({ ...pos, exitT: null, exit: b[b.length - 1].c, why: "open" });
  return out.map((t) => ({ ...t, retPct: +(100 * (t.dir * (t.exit / t.entry - 1) - 0.0002)).toFixed(2) }));
}
module.exports = { hourlyBars, simulate };

if (require.main === module) {
  const tv = JSON.parse(fs.readFileSync(TV, "utf8")).trades, bars = hourlyBars();
  const ours = simulate(bars, "2022-01-01T00:00:00Z", "2022-05-05T12:00:00Z").filter((t) => t.entryT >= "2022-01-01");
  const hrs = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 36e5), used = new Set();
  const rows = tv.map((t) => { let best = null; ours.forEach((o, k) => { if (used.has(k) || o.dir !== t.dir) return; const d = Math.abs(hrs(o.entryT, t.entryT)); if (d <= 1 && (!best || d < best.d)) best = { k, d }; });
    if (!best) return { tv: t, match: "MISSING" }; used.add(best.k); const o = ours[best.k];
    const exitOk = t.exitT ? (o.exitT && Math.abs(hrs(o.exitT, t.exitT)) <= 2 && Math.abs(o.exit / t.exit - 1) <= 0.01) : true;
    return { tv: t, ours: o, match: exitOk ? "MATCH" : "ENTRY ONLY" }; });
  const extra = ours.filter((_, k) => !used.has(k)), nM = rows.filter((r) => r.match === "MATCH").length, nE = rows.filter((r) => r.match !== "MISSING").length;
  const tvSum = tv.filter((t) => t.exitT).reduce((s, t) => s + 100 * (t.dir * (t.exit / t.entry - 1) - 0.0002), 0), ourSum = ours.filter((t) => t.exitT).reduce((s, t) => s + t.retPct, 0);
  writeJsonAtomic(OUT, { spec: "r153-qqe-verify-v1", asOf: new Date().toISOString(), half: HALF, barsSource: "Coinbase BTC-USD hourly (report used BINANCE:BTCUSDT 1h)", tvTrades: tv.length, fullMatches: nM, entryMatches: nE, extraTradesOurs: extra.length, sumRetPctTV: +tvSum.toFixed(2), sumRetPctOurs: +ourSum.toFixed(2), rows, extra });
  console.log(`R153 QQE+SSL+WAE [half ${HALF}]: ${nM}/${tv.length} full matches, ${nE}/${tv.length} entries (±1h, same side), ${extra.length} extra of ours (${ours.length} total) · summed % TV ${tvSum.toFixed(1)} vs ours ${ourSum.toFixed(1)}`);
}
