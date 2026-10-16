#!/usr/bin/env node
/**
 * R187 — ALPHAINSIDER'S TOP CRYPTO TRADINGVIEW SCRIPTS, translated, verified against AlphaInsider's own trade logs, then tested on
 * the years BEFORE the one they were ranked on (registered 2026-09-24; frozen rule/statistic/bar/controls in
 * data/test-registry.json -> preregistered R187). Paper research only: no orders, no broker calls.
 *
 * THE FIVE (AlphaInsider strategy_id | TradingView script | our JS translation below; the Pine source is NOT stored or republished):
 *   0zkSY2gJ414DuTZIXkIb6  Multi-Oscillator Divergence Strategy (Craig_Claussen)   https://www.tradingview.com/script/8tJR3Gvh-Multi-Oscillator-Divergence-Strategy/        published 2019-12-29  BTC
 *   pBlhFtpNU86BofGLGPwvH  Triple Threat (alexjnelson)                              https://www.tradingview.com/script/WUKWF5Uu-Triple-Threat/                               published 2022-03-15  BTC
 *   a0XGqoYvpO32d_KOWiBm3  Strategy - DMI Indicator with DPO Indicator as a Guard   https://www.tradingview.com/script/SIqJCTCL-Strategy-DMI-Indicator-with-DPO-Indicator-as-a-Guard/  published 2021-05-02  BTC
 *   bzxOJiXGHRVKvs-_T9zmk  Stealthy 7 Linear Regression Channel Strategy (stealthy7) https://www.tradingview.com/script/ypsI7e0J-Stealthy-7-Linear-Regression-Channel-Strategy/ published 2017-05-10  ETH
 *   OZKJvQzBe94tyDZGSGTJ0  [LunaOwl] LOHAS Investor - PriceChannel (LunaOwl)        https://www.tradingview.com/script/gBlsZ02G-LunaOwl-    -    -LOHAS-Investor-PriceChannel/  published 2019-12-09  ETH
 *   (publication dates read from each script page's own timestamp, 2026-09-24; one page view per script.)
 *
 * INPUTS. Trade logs: data/alphainsider/timelines/<id>.jsonl (official API, alphainsider-record.js). Descriptions: official
 * searchStrategies API (they carry the TradingView link but no timeframe). Candles: Coinbase Exchange public hourly candles
 * (BTC: data/r153-btc-coinbase-hourly.json + data/r155-btc-coinbase-hourly-ext.json + data/r187-btc-coinbase-hourly-ext.json;
 * ETH: data/r187-eth-coinbase-hourly.json), aggregated to UTC-aligned 1h/2h/4h/6h/8h/12h/1D bars (TradingView's Coinbase
 * crypto calendar: 24/7, daily bar = 00:00 UTC). AlphaInsider's TradingViewTracker trades Coinbase (provider field in the log).
 *
 * IMPLEMENTATION NOTES (written before any OOS number was computed; none of these is chosen on results):
 *  N1 TIMEFRAME. No description states a timeframe; it is read from the log's fill timestamps: Multi-Osc fills only on even UTC
 *     hours -> 2h; Triple Threat only 00:00 -> 1D (the description also says "Bitcoin's daily chart"); DMI/DPO only 00:00/12:00 ->
 *     12h; Stealthy 00:00 -> 1D. LunaOwl fills at arbitrary minutes (its entries are STOP orders), so its timeframe cannot be read
 *     from the clock: the gate tries 1D, 12h, 8h, 6h, 4h, 2h, 1h (declared order) and keeps the highest match (ties -> declared
 *     order). This is a known-answer (translation) choice against AlphaInsider's log, never against OOS performance.
 *  N2 FILLS. Signals on closed bars only; market orders fill at the next bar open (TradingView default, process_orders_on_close
 *     off). LunaOwl's entries are stop orders at the 21-bar channel; the registered leak control says "fills at the next bar open",
 *     so the PRIMARY LunaOwl translation detects the touch on the closed bar (high >= prior bar's channel high, or low <= prior
 *     channel low) and fills at the NEXT bar open. The stop-level intrabar fill (how TradingView/AlphaInsider actually execute it:
 *     max(open, level)) is computed as CONTEXT only and is never the verdict. If a closed bar touched both levels while flat, the
 *     level nearer that bar's open is taken as touched first.
 *  N3 SIZING. AlphaInsider sizes every TradingViewTracker position at 1.5x strategy value, long and short (measured from each
 *     log: |new_holdings x price| / strategy_value; reported per script). The OOS statistic uses that leverage, rebalanced per
 *     bar (constant exposure); script-level sizing (100% / 10% / 50% of equity / 1 contract) is not what AlphaInsider runs.
 *     Cost: 10 bps per side on traded notional (registered), not AlphaInsider's 25 bps fee.
 *  N4 calc_on_order_fills=true (Multi-Osc, DMI/DPO, LunaOwl) lets TradingView re-run the script inside the fill bar on history;
 *     that intrabar re-evaluation is a TradingView backtest artefact and is NOT translated (closed bars only).
 *  N5 PINE CONVENTIONS. ema/rma seeded with the SMA of the first `len` values; rsi = rma-based; stdev = population; pivots:
 *     left neighbours strictly beyond the centre, right neighbours beyond-or-equal; valuewhen(cond, x, 1) = previous occurrence;
 *     v4 offset(x, n) = x[n]; two opposite market entries on one bar -> the later one (short) wins; a Stealthy long entry and a
 *     close_all on the same bar -> the entry wins (it reverses). Comparisons with na are false.
 *  N6 GATE. Recorded events are grouped by timestamp (<=120 s); a group whose resulting side (sign of new_holdings, |notional| >=
 *     1% of value, else flat) differs from the previous group's side is one recorded side change. Match = same resulting side and
 *     |our fill time - recorded time| <= one bar (+120 s), one-to-one, nearest first (ties by a seeded random key). Pass >= 80%.
 *  N7 STATISTIC. UTC days in [publication date, 2025-09-23]. Strategy daily net return (bars compounded inside the day, position
 *     carried in from warm-up) regressed on the asset's daily close-to-close return; intercept x 365; Newey-West Bartlett lag 5 t.
 *  N8 CONTROLS. randomEntry: the OOS position path is cut into its runs (each trade, and each flat spell for scripts that go
 *     flat); the runs are shuffled into random order (seeded; 200 draws), i.e. the same trades, sides and holding lengths at
 *     random dates; costs charged on the shuffled path's own position changes. The script's alpha must exceed the draws' 95th
 *     percentile alpha. The control itself PASSES when the draws are centred (|median t| < 2: the harness does not manufacture
 *     alpha). peek: the same runs at their real dates, each non-flat run's side set with foresight to the sign of the asset's move
 *     over it; its alpha t must clear the bar (2.33). leak: closed-bar signals / next-open fills by construction, plus a selftest.
 *  N9 CONTEXT. The same statistic on the ranked year (2025-09-24..2026-09-23) and the stop-fill LunaOwl variant are reported,
 *     never used for the verdict.
 *
 *   node backend/r187-ai-crypto-scripts.js            gate + controls + read + seal (seals only if controls pass)
 *   node backend/r187-ai-crypto-scripts.js --dry      everything except the registry / seal / ledger writes
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const OUT = D("r187-ai-crypto-scripts.json"), ETH_H = D("r187-eth-coinbase-hourly.json"), BTC_X = D("r187-btc-coinbase-hourly-ext.json");
const COST = 0.0010, OOS_END = "2025-09-23", RANK_FROM = "2025-09-24", RANK_TO = "2026-09-23", BAR = 2.33, DRAWS = 200, NW_LAG = 5;
const DRY = process.argv.includes("--dry");

// ── candles ────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function coinbaseHourly(product, start, end) {
  const out = new Map(); let t = Date.parse(start); const stop = Date.parse(end);
  while (t < stop) { const e = Math.min(t + 299 * 36e5, stop);
    const u = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600&start=${new Date(t).toISOString()}&end=${new Date(e).toISOString()}`;
    let r; for (let k = 0; k < 5; k++) { r = await fetch(u, { headers: { "User-Agent": "traids-research" }, signal: AbortSignal.timeout(20000) }).catch(() => null); if (r && r.ok) break; await new Promise((z) => setTimeout(z, 2000 * (k + 1))); }
    if (!r || !r.ok) throw new Error(`Coinbase ${product} hourly ${r && r.status}`);
    for (const [ts, lo, hi, op, cl, v] of await r.json()) out.set(ts, [ts, op, hi, lo, cl, v]);
    t = e + 36e5; await new Promise((z) => setTimeout(z, 350)); }
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}
async function hourly(asset) {
  if (asset === "ETH") {
    if (!fs.existsSync(ETH_H)) { const hours = await coinbaseHourly("ETH-USD", "2016-05-18T00:00:00Z", "2026-09-24T12:00:00Z"); writeJsonAtomic(ETH_H, { source: "Coinbase Exchange public candles ETH-USD granularity 3600", fetchedAt: new Date().toISOString(), hours }); }
    return JSON.parse(fs.readFileSync(ETH_H, "utf8")).hours;
  }
  if (!fs.existsSync(BTC_X)) { const hours = await coinbaseHourly("BTC-USD", "2026-09-22T00:00:00Z", "2026-09-24T12:00:00Z"); writeJsonAtomic(BTC_X, { source: "Coinbase Exchange public candles BTC-USD granularity 3600, extends r155-btc-coinbase-hourly-ext.json", fetchedAt: new Date().toISOString(), hours }); }
  const m = new Map(); for (const f of ["r153-btc-coinbase-hourly.json", "r155-btc-coinbase-hourly-ext.json", "r187-btc-coinbase-hourly-ext.json"]) for (const h of JSON.parse(fs.readFileSync(D(f), "utf8")).hours) m.set(h[0], h);
  return [...m.values()].sort((a, b) => a[0] - b[0]);
}
const TF = { "1h": 1, "2h": 2, "4h": 4, "6h": 6, "8h": 8, "12h": 12, "1D": 24 };
function agg(hrs, hours) {          // UTC-aligned bars; ts = bar open (seconds); only complete-to-now bars
  const span = hours * 3600, map = new Map();
  for (const [ts, o, h, l, c, v] of hrs) { const k = Math.floor(ts / span) * span, b = map.get(k); if (!b) map.set(k, { ts: k, o, h, l, c, v }); else { b.h = Math.max(b.h, h); b.l = Math.min(b.l, l); b.c = c; b.v += v; } }
  const last = hrs[hrs.length - 1][0] + 3600;
  return [...map.values()].filter((b) => b.ts + span <= last).sort((a, b) => a.ts - b.ts);
}

// ── Pine helpers (N5) ───────────────────────────────────────────────────────────────────────────────────────────────────
const nan = (n) => new Array(n).fill(NaN);
function seeded(a, n, step) { const o = nan(a.length); let s = 0, c = 0, st = false; for (let i = 0; i < a.length; i++) { const x = a[i]; if (!st) { if (isNaN(x)) { s = 0; c = 0; continue; } s += x; c++; if (c === n) { o[i] = s / n; st = true; } } else o[i] = isNaN(x) ? o[i - 1] : step(x, o[i - 1]); } return o; }
const ema = (a, n) => seeded(a, n, (x, p) => (2 / (n + 1)) * x + (1 - 2 / (n + 1)) * p);
const rma = (a, n) => seeded(a, n, (x, p) => (x + (n - 1) * p) / n);
const sma = (a, n) => { const o = nan(a.length); for (let i = n - 1; i < a.length; i++) { let s = 0, bad = false; for (let k = 0; k < n; k++) { const v = a[i - k]; if (isNaN(v)) { bad = true; break; } s += v; } if (!bad) o[i] = s / n; } return o; };
const stdevP = (a, n) => { const m = sma(a, n), o = nan(a.length); for (let i = n - 1; i < a.length; i++) { if (isNaN(m[i])) continue; let s = 0; for (let k = 0; k < n; k++) s += (a[i - k] - m[i]) ** 2; o[i] = Math.sqrt(s / n); } return o; };
const rsi = (c, n) => { const ch = c.map((v, i) => i ? v - c[i - 1] : NaN), up = rma(ch.map((x) => isNaN(x) ? NaN : Math.max(x, 0)), n), dn = rma(ch.map((x) => isNaN(x) ? NaN : -Math.min(x, 0)), n); return up.map((u, i) => isNaN(u) || isNaN(dn[i]) ? NaN : dn[i] === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / dn[i])); };
const fixnan = (a) => { let last = NaN; return a.map((x) => (isNaN(x) ? last : (last = x))); };
const gt = (a, b) => !isNaN(a) && !isNaN(b) && a > b, lt = (a, b) => gt(b, a);
const crossover = (a, b, i) => i > 0 && gt(a[i], b[i]) && !isNaN(a[i - 1]) && !isNaN(b[i - 1]) && a[i - 1] <= b[i - 1];
const crossunder = (a, b, i) => crossover(b, a, i);
function pivot(a, L, R, low) {      // value at bar t = a[t-R] if a pivot centred at t-R is confirmed at t
  const o = nan(a.length);
  for (let t = L + R; t < a.length; t++) { const c = a[t - R]; if (isNaN(c)) continue; let ok = true;
    for (let k = 1; k <= L && ok; k++) { const v = a[t - R - k]; if (isNaN(v) || (low ? v <= c : v >= c)) ok = false; }
    for (let k = 1; k <= R && ok; k++) { const v = a[t - R + k]; if (isNaN(v) || (low ? v < c : v > c)) ok = false; }
    if (ok) o[t] = c; }
  return o;
}
// market-order simulator: decide(i, pos) at the close of bar i returns a target (-1/0/1) or null; fill at bar i+1 open
function marketSim(bars, decide) {
  const ev = []; let pos = 0;
  for (let i = 0; i + 1 < bars.length; i++) { const tgt = decide(i, pos); if (tgt != null && tgt !== pos) { ev.push({ i: i + 1, px: bars[i + 1].o, side: tgt }); pos = tgt; } }
  return ev;
}

// ── translations (our JS; logic of the named public scripts, inputs at their published defaults) ───────────────────────────
// Multi-Oscillator Divergence Strategy by Craig_Claussen — https://www.tradingview.com/script/8tJR3Gvh-Multi-Oscillator-Divergence-Strategy/
function multiOsc(bars) {
  const len = 117, lbR = 5, lbL = 5, rangeUpper = 500, rangeLower = 7, n = bars.length, c = bars.map((b) => b.c), lo = bars.map((b) => b.l), hi = bars.map((b) => b.h);
  const osc = ema(c, len), ma = rma(c.map((x, i) => x - osc[i]), 1);        // maType "DPO": close - ema(close,117), rma length 1
  const pl = pivot(ma, lbL, lbR, true), ph = pivot(ma, lbL, lbR, false), plF = pl.map((x) => !isNaN(x)), phF = ph.map((x) => !isNaN(x));
  const cond = (F, higher) => { const out = { reg: new Array(n).fill(false), hid: new Array(n).fill(false) }; let prev = -1;   // prev = last bar where F was true
    for (let t = 0; t < n; t++) { if (!F[t]) continue;
      if (prev >= 0) { const bs = t - (prev + 1);                               // barssince(F[1]) at t
        const inR = rangeLower <= bs && bs <= rangeUpper, oN = ma[t - lbR], oP = ma[prev - lbR], pN = higher ? hi[t - lbR] : lo[t - lbR], pP = higher ? hi[prev - lbR] : lo[prev - lbR];
        if (!higher) { out.reg[t] = pN < pP && oN > oP && inR; out.hid[t] = pN > pP && oN < oP && inR; }   // regular bull / hidden bull
        else { out.reg[t] = pN > pP && oN < oP && inR; out.hid[t] = pN < pP && oN > oP && inR; } }        // regular bear / hidden bear
      prev = t; }
    return out; };
  const B = cond(plF, false), S = cond(phF, true);
  return marketSim(bars, (i) => { if (i < lbR) return null; const bull = B.reg[i - lbR] || B.hid[i - lbR], bear = S.reg[i - lbR] || S.hid[i - lbR]; return bear ? -1 : bull ? 1 : null; });
}
// Triple Threat by alexjnelson (BBWP part by The_Caretaker) — https://www.tradingview.com/script/WUKWF5Uu-Triple-Threat/
function tripleThreat(bars) {
  const n = bars.length, c = bars.map((b) => b.c), basis = sma(c, 21), dev = stdevP(c, 21), bbw = basis.map((b, i) => (b + dev[i] - (b - dev[i])) / b);
  const bbwp = bbw.map((x, i) => { let s = 0; for (let k = 1; k <= 255; k++) { const p = i - k >= 0 ? bbw[i - k] : NaN; s += gt(p, x) ? 0 : 1; } return (s / 255) * 100; });
  const bbwpMA = sma(bbwp, 8), R = rsi(c, 14), RM = sma(R, 7), cma = ema(c, 50);
  const X = 5, RT = 3, IT = 12, OS = 35, OB = 65, BT = 4;
  let cu = false, ru = false, cd = false, rd = false, bz = false, sz = false, fbc = false, fsc = false, cbz = false, csz = false, mbz = false, msz = false, mfb = false, mfs = false;
  const sig = new Array(n).fill(0);
  for (let i = 0; i < n; i++) { const r = R[i], m = RM[i], d = r - m, ok = !isNaN(d);
    const cu2 = (cu && !(ok && -d > RT)) || (ok && d > X), ru2 = cu2 && (ru || (ok && d < RT)), buy = (ru2 && ok && d > X) || (ok && d > IT);
    const cd2 = (cd && !(ok && d > RT)) || (ok && -d > X), rd2 = cd2 && (rd || (ok && -d < RT)), sell = (rd2 && ok && -d > X) || (ok && -d > IT);
    const bz2 = (buy || bz) && !sell, sz2 = (sell || sz) && !buy, bSig = bz2 && sz, sSig = sz2 && bz;
    const fbc2 = (fbc && !sSig) || (!isNaN(r) && r <= OS), fsc2 = (fsc && !bSig) || (!isNaN(r) && r >= OB);
    const allowB = gt(r, m) && gt(m, OS), allowS = lt(r, m) && lt(m, OB), bbc = gt(bbwp[i] - bbwpMA[i], BT);
    const fullB = bz2 && (fbc2 || bbc) && allowB, fullS = sz2 && (fsc2 || bbc) && allowS;
    const cbz2 = (cbz || fullB) && !fullS, csz2 = (csz || fullS) && !fullB;
    const mbz2 = cbz2 && gt(c[i], cma[i]), msz2 = csz2 && lt(c[i], cma[i]), mbc = mbz2 && !mbz, msc = msz2 && !msz;
    const mfb2 = (mfb || mbc) && !msc, mfs2 = (mfs || msc) && !mbc;
    if (mfb2 && !mfb) sig[i] = 1; if (mfs2 && !mfs) sig[i] = -1;   // both in one bar -> the later entry (short) wins
    cu = cu2; ru = ru2; cd = cd2; rd = rd2; bz = bz2; sz = sz2; fbc = fbc2; fsc = fsc2; cbz = cbz2; csz = csz2; mbz = mbz2; msz = msz2; mfb = mfb2; mfs = mfs2; }
  return marketSim(bars, (i) => (bars[i].ts >= Date.UTC(2019, 0, 1) / 1000 && sig[i] ? sig[i] : null));
}
// Strategy - DMI Indicator with DPO Indicator as a Guard by Craig_Claussen — https://www.tradingview.com/script/SIqJCTCL-Strategy-DMI-Indicator-with-DPO-Indicator-as-a-Guard/
function dmiDpo(bars) {
  const len = 34, per = 34, back = 18, n = bars.length, h = bars.map((b) => b.h), l = bars.map((b) => b.l), c = bars.map((b) => b.c);
  const up = h.map((x, i) => i ? x - h[i - 1] : NaN), dn = l.map((x, i) => i ? l[i - 1] - x : NaN);
  const pDM = up.map((u, i) => isNaN(u) ? NaN : u > dn[i] && u > 0 ? u : 0), mDM = dn.map((d, i) => isNaN(d) ? NaN : d > up[i] && d > 0 ? d : 0);
  const tr = bars.map((b, i) => i ? Math.max(b.h - b.l, Math.abs(b.h - c[i - 1]), Math.abs(b.l - c[i - 1])) : NaN), trur = rma(tr, len);
  const plus = fixnan(rma(pDM, len).map((x, i) => 100 * x / trur[i])), minus = fixnan(rma(mDM, len).map((x, i) => 100 * x / trur[i]));
  const ma = sma(c, per), dpo = c.map((x, i) => i >= back ? x - ma[i - back] : NaN);
  return marketSim(bars, (i) => { const L = crossover(plus, minus, i) && gt(dpo[i], 0), S = crossunder(plus, minus, i) && lt(dpo[i], 0); return S ? -1 : L ? 1 : null; });
}
// Stealthy 7 Linear Regression Channel Strategy by stealthy7 — https://www.tradingview.com/script/ypsI7e0J-Stealthy-7-Linear-Regression-Channel-Strategy/
function stealthy(bars) {
  const len = 100, n = bars.length, c = bars.map((b) => b.c), o = bars.map((b) => b.o), up = nan(n), lo = nan(n), mid = nan(n);
  const sx = len * (len + 1) / 2, sxx = len * (len + 1) * (2 * len + 1) / 6;
  for (let t = len; t < n; t++) { let sy = 0, sxy = 0; for (let i = 1; i <= len; i++) { sy += c[t - i]; sxy += i * c[t - i]; }
    const m = (len * sxy - sx * sy) / (len * sxx - sx * sx), b = sy / len - m * sx / len; let d = 0; for (let i = 1; i <= len; i++) d += (c[t - i] - (i * m + b)) ** 2;
    const sd = Math.sqrt(d / len); up[t] = b + sd; lo[t] = b - sd; mid[t] = b; }       // mult1 = mult2 = 1; trend mode (Range Mode off)
  return marketSim(bars, (i, pos) => { if (crossover(o, up, i)) return 1; if (crossunder(o, lo, i)) return -1;
    if (crossover(o, mid, i) && pos < 0) return 0; if (crossunder(o, mid, i) && pos > 0) return 0; return null; });
}
// [LunaOwl] LOHAS Investor - PriceChannel by LunaOwl — https://www.tradingview.com/script/gBlsZ02G-LunaOwl-    -    -LOHAS-Investor-PriceChannel/
function lunaOwl(bars, { stopFill = false } = {}) {
  const L = 21, n = bars.length, CH = nan(n), CL = nan(n);
  for (let i = L - 1; i < n; i++) { let hh = -Infinity, ll = Infinity; for (let k = 0; k < L; k++) { hh = Math.max(hh, bars[i - k].h); ll = Math.min(ll, bars[i - k].l); } CH[i] = hh; CL[i] = ll; }
  const ev = []; let pos = 0;
  for (let j = L + 1; j < n; j++) { const b = bars[j], lvH = CH[j - 1], lvL = CL[j - 1];          // stops placed at bar j-1's close (close[21] exists)
    let tL = pos !== 1 && b.h >= lvH, tS = pos !== -1 && b.l <= lvL;
    if (tL && tS) { if (Math.abs(b.o - lvH) <= Math.abs(b.o - lvL)) tS = false; else tL = false; }
    if (!tL && !tS) continue; const side = tL ? 1 : -1;
    if (stopFill) { ev.push({ i: j, px: side > 0 ? Math.max(b.o, lvH) : Math.min(b.o, lvL), side }); pos = side; }
    else if (j + 1 < n) { ev.push({ i: j + 1, px: bars[j + 1].o, side }); pos = side; } }
  return ev;
}
const SCRIPTS = [
  { id: "0zkSY2gJ414DuTZIXkIb6", name: "Multi-Oscillator Divergence Strategy by Craig_Claussen", asset: "BTC", tfs: ["2h"], pub: "2019-12-29", run: multiOsc, url: "https://www.tradingview.com/script/8tJR3Gvh-Multi-Oscillator-Divergence-Strategy/",
    settings: "maType DPO (close - EMA 117, RMA 1), pivots L5/R5, range 7..500, regular+hidden divergences, entries delayed offset(,5); long+short stop-and-reverse; script sizing 100% equity, no commission set",
    caveats: ["Entries fire 10 bars after the divergence pivot (5 to confirm the pivot + offset(,5)); no look-ahead once confirmed.", "calc_on_order_fills=true (TradingView intrabar re-evaluation on history) not translated.", "Author warns it repaints if 'Pivot Lookback Right' is raised; defaults do not repaint on closed bars."] },
  { id: "pBlhFtpNU86BofGLGPwvH", name: "Triple Threat by alexjnelson", asset: "BTC", tfs: ["1D"], pub: "2022-03-15", run: tripleThreat, url: "https://www.tradingview.com/script/WUKWF5Uu-Triple-Threat/",
    settings: "RSI 14 / SMA 7 retest state machine (crossover 5, retest 3, instant 12, OS 35, OB 65), BBWP 21/255 with SMA 8 (threshold 4), EMA 50 confirmation; long+short; SL/TP off; start 2019-01-01; script sizing 100% equity",
    caveats: ["Description says settings are 'optimized for this chart' (BTC daily since 2018): in-sample fit before publication.", "No repainting features; closed-bar state machine."] },
  { id: "a0XGqoYvpO32d_KOWiBm3", name: "Strategy - DMI Indicator with DPO Indicator as a Guard by Craig_Claussen", asset: "BTC", tfs: ["12h"], pub: "2021-05-02", run: dmiDpo, url: "https://www.tradingview.com/script/SIqJCTCL-Strategy-DMI-Indicator-with-DPO-Indicator-as-a-Guard/",
    settings: "+DI/-DI crossover (RMA 34), DPO 34 non-centred (close - SMA34[18]) as guard; long+short reversal; script sizing 10% equity, commission 0.25%",
    caveats: ["calc_on_order_fills=true not translated.", "Non-centred DPO: no look-ahead (the centred option would look back only)."] },
  { id: "bzxOJiXGHRVKvs-_T9zmk", name: "Stealthy 7 Linear Regression Channel Strategy by stealthy7", asset: "ETH", tfs: ["1D"], pub: "2017-05-10", run: stealthy, url: "https://www.tradingview.com/script/ypsI7e0J-Stealthy-7-Linear-Regression-Channel-Strategy/",
    settings: "Least-squares line over close[1..100] extrapolated to the current bar +/- 1 residual SD; source = open; trend mode (Range Mode off): long on open crossing above upper, short on crossing below lower, flat when open crosses the middle; script sizing 1 contract",
    caveats: ["The channel is refit every bar (the author calls it 'random'); on closed bars it does not repaint.", "Signal uses the bar's own open against a channel from prior closes; fill at next open."] },
  { id: "OZKJvQzBe94tyDZGSGTJ0", name: "[LunaOwl] LOHAS Investor - PriceChannel by LunaOwl", asset: "ETH", tfs: ["1D", "12h", "8h", "6h", "4h", "2h", "1h"], pub: "2019-12-09", run: lunaOwl, url: "https://www.tradingview.com/script/gBlsZ02G-LunaOwl-    -    -LOHAS-Investor-PriceChannel/",
    settings: "21-bar price channel (highest high / lowest low incl. the current bar); stop-entry long at the channel high, stop-entry short at the channel low; always-in stop-and-reverse; script sizing 50% equity, commission 0.07%",
    caveats: ["Stop orders fill intrabar on TradingView/AlphaInsider; the primary translation fills at the next open after the closed-bar touch (N2) — costs the breakout part of one bar.", "calc_on_order_fills=true not translated."] },
];

// ── AlphaInsider log -> recorded side changes (N6) ─────────────────────────────────────────────────────────────────────
function recorded(id) {
  const L = fs.readFileSync(D(`alphainsider/timelines/${id}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .sort((a, b) => a.at.localeCompare(b.at) || (+a.timeline_id) - (+b.timeline_id));
  const groups = []; for (const e of L) { const g = groups[groups.length - 1]; if (g && Date.parse(e.at) - Date.parse(g.last.at) <= 120e3) { g.events.push(e); g.last = e; } else groups.push({ at: e.at, events: [e], last: e }); }
  const lev = [], changes = []; let prev = 0;
  for (const g of groups) { const e = g.last, notional = +e.new_holdings * +e.price, val = +e.strategy_value, side = Math.abs(notional) >= 0.01 * val ? Math.sign(notional) : 0;
    if (side) lev.push(Math.abs(notional) / val); if (side !== prev) changes.push({ at: g.at, t: Date.parse(g.at), side, price: +e.price }); prev = side; }
  lev.sort((a, b) => a - b);
  return { events: L.length, groups: groups.length, changes, leverage: lev.length ? +lev[Math.floor(lev.length / 2)].toFixed(3) : null, first: L[0].at, last: L[L.length - 1].at, firstValue: +L[0].strategy_value, lastValue: +L[L.length - 1].strategy_value };
}
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gate(bars, ev, rec, tfH) {
  const barMs = tfH * 36e5, tol = barMs + 120e3, from = rec.changes[0].t - barMs, to = rec.changes[rec.changes.length - 1].t + barMs;
  const ours = ev.map((e) => ({ t: bars[e.i].ts * 1000, side: e.side })).filter((o) => o.t >= from && o.t <= to), rng = mulberry(187);
  const cand = []; rec.changes.forEach((r, a) => ours.forEach((o, b) => { const d = Math.abs(o.t - r.t); if (o.side === r.side && d <= tol) cand.push({ a, b, d, k: rng() }); }));
  cand.sort((x, y) => x.d - y.d || x.k - y.k); const ua = new Set(), ub = new Set();
  for (const c of cand) if (!ua.has(c.a) && !ub.has(c.b)) { ua.add(c.a); ub.add(c.b); }
  const rows = rec.changes.map((r, a) => ({ at: r.at, side: r.side, matched: ua.has(a) }));
  return { recordedChanges: rec.changes.length, matched: ua.size, matchPct: +(100 * ua.size / rec.changes.length).toFixed(1), oursInPeriod: ours.length, extraOurs: ours.length - ub.size, pass: ua.size / rec.changes.length >= 0.8, missed: rows.filter((r) => !r.matched).map((r) => `${r.at.slice(0, 16)} ${r.side > 0 ? "L" : r.side < 0 ? "S" : "flat"}`) };
}

// ── accounting / statistic (N3, N7) ─────────────────────────────────────────────────────────────────────────────────────
const dayOf = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
// events: [{i, px, side}] sorted by i. Returns Map(day -> net return) over [from, to], constant leverage L rebalanced per bar
function account(bars, events, L, from, to, startPos = null) {
  const days = new Map(); let pos = 0, k = 0; const evAt = new Map(); for (const e of events) { if (!evAt.has(e.i)) evAt.set(e.i, []); evAt.get(e.i).push(e); }
  let started = false;
  for (let i = 0; i < bars.length; i++) { const b = bars[i], d = dayOf(b.ts), ref = i ? bars[i - 1].c : b.o, inW = d >= from && d <= to;
    if (inW && !started) { started = true; if (startPos != null) pos = startPos; }
    let m = 1, px0 = ref; const es = evAt.get(i) || [];
    for (const e of es) { m *= 1 + L * pos * (e.px / px0 - 1); m *= 1 - COST * L * Math.abs(e.side - pos); pos = e.side; px0 = e.px; }
    m *= 1 + L * pos * (b.c / px0 - 1);
    if (inW) days.set(d, (days.get(d) ?? 1) * m); }
  for (const [d, m] of days) days.set(d, m - 1); return days;
}
function assetDays(bars, from, to) { const m = new Map(); for (let i = 1; i < bars.length; i++) { const d = dayOf(bars[i].ts); if (d < from || d > to) continue; m.set(d, (m.get(d) ?? 1) * (bars[i].c / bars[i - 1].c)); } for (const [d, x] of m) m.set(d, x - 1); return m; }
function olsNW(y, x, lag = NW_LAG) {
  const n = y.length, mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n; let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  const beta = sxx > 0 ? sxy / sxx : 0, a = my - beta * mx, u = y.map((v, i) => v - a - beta * x[i]);
  const XtX = [[n, n * mx], [n * mx, x.reduce((s, v) => s + v * v, 0)]], det = XtX[0][0] * XtX[1][1] - XtX[0][1] ** 2, inv = [[XtX[1][1] / det, -XtX[0][1] / det], [-XtX[1][0] / det, XtX[0][0] / det]];
  const S = [[0, 0], [0, 0]], add = (w, i, j) => { const xi = [1, x[i]], xj = [1, x[j]], uu = u[i] * u[j]; for (let r = 0; r < 2; r++) for (let q = 0; q < 2; q++) S[r][q] += w * uu * (xi[r] * xj[q] + (i === j ? 0 : xj[r] * xi[q])); };
  for (let i = 0; i < n; i++) add(1, i, i); for (let l = 1; l <= lag; l++) { const w = 1 - l / (lag + 1); for (let i = l; i < n; i++) add(w, i, i - l); }
  const V = [[0, 0], [0, 0]]; for (let r = 0; r < 2; r++) for (let q = 0; q < 2; q++) { let s = 0; for (let p = 0; p < 2; p++) for (let z = 0; z < 2; z++) s += inv[r][p] * S[p][z] * inv[z][q]; V[r][q] = s; }
  const se = Math.sqrt(V[0][0]); return { alphaDaily: a, alphaAnn: a * 365, beta, t: se > 0 ? a / se : 0, n };
}
function stat(sd, ad) {
  const ds = [...sd.keys()].filter((d) => ad.has(d)).sort(), y = ds.map((d) => sd.get(d)), x = ds.map((d) => ad.get(d)), r = olsNW(y, x);
  let eq = 1, pk = 1, mdd = 0, bh = 1; for (let i = 0; i < y.length; i++) { eq *= 1 + y[i]; bh *= 1 + x[i]; pk = Math.max(pk, eq); mdd = Math.max(mdd, 1 - eq / pk); }
  return { days: ds.length, from: ds[0], to: ds[ds.length - 1], alphaAnnPct: +(100 * r.alphaAnn).toFixed(2), beta: +r.beta.toFixed(3), tNW: +r.t.toFixed(3), totalPct: +(100 * (eq - 1)).toFixed(1), buyHoldPct: +(100 * (bh - 1)).toFixed(1), maxDDPct: +(100 * mdd).toFixed(1) };
}
// runs of the position path inside the window (N8)
function runsIn(bars, events, from, to) {
  const pos = new Array(bars.length).fill(0); let p = 0, k = 0; const es = [...events].sort((a, b) => a.i - b.i);
  for (let i = 0; i < bars.length; i++) { while (k < es.length && es[k].i === i) p = es[k++].side; pos[i] = p; }
  const idx = bars.map((b, i) => i).filter((i) => { const d = dayOf(bars[i].ts); return d >= from && d <= to; }), i0 = idx[0], i1 = idx[idx.length - 1], runs = [];
  for (let i = i0; i <= i1; i++) { const r = runs[runs.length - 1]; if (r && r.side === pos[i]) r.len++; else runs.push({ side: pos[i], start: i, len: 1 }); }
  return { i0, i1, runs };
}
const pathEvents = (bars, i0, runs, prevSide) => { const ev = []; let i = i0, p = prevSide; for (const r of runs) { if (r.side !== p) ev.push({ i, px: bars[i].o, side: r.side }); p = r.side; i += r.len; } return ev; };
function controls(bars, events, L, from, to, ad, seedKey) {
  const { i0, runs } = runsIn(bars, events, from, to), rng = mulberry(1870000 + seedKey), draws = [];
  for (let z = 0; z < DRAWS; z++) { const sh = runs.map((r) => ({ ...r, k: rng() })).sort((a, b) => a.k - b.k);
    const ev = pathEvents(bars, i0, sh, 0), sd = account(bars, ev, L, from, to, 0), s = stat(sd, ad); draws.push({ a: s.alphaAnnPct, t: s.tNW }); }
  const as = draws.map((d) => d.a).sort((a, b) => a - b), ts = draws.map((d) => d.t).sort((a, b) => a - b), q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  let i = i0; const pk = runs.map((r) => { const end = Math.min(i + r.len, bars.length - 1), mv = bars[end].o / bars[i].o - 1, o = { ...r, side: r.side === 0 ? 0 : (mv >= 0 ? 1 : -1) }; i += r.len; return o; });
  const peek = stat(account(bars, pathEvents(bars, i0, pk, 0), L, from, to, 0), ad);
  return { runs: runs.length, randomEntry: { draws: DRAWS, alphaAnnPctP95: +q(as, 0.95).toFixed(2), alphaAnnPctMedian: +q(as, 0.5).toFixed(2), tMedian: +q(ts, 0.5).toFixed(3), tP95: +q(ts, 0.95).toFixed(3), centred: Math.abs(q(ts, 0.5)) < 2 },
    peek: { alphaAnnPct: peek.alphaAnnPct, tNW: peek.tNW, clearsBar: peek.tNW >= BAR } };
}

function selftest() {
  const checks = {}, mk = (n, f) => Array.from({ length: n }, (_, i) => { const p = f(i); return { ts: 1.6e9 + i * 86400, o: p, h: p * 1.01, l: p * 0.99, c: p * 1.001, v: 1 }; });
  const bars = mk(400, (i) => 100 + 10 * Math.sin(i / 15));
  const ev = marketSim(bars, (i) => (i === 10 ? 1 : i === 20 ? -1 : null)); checks.fillsAtNextOpen = ev[0].i === 11 && ev[0].px === bars[11].o && ev[1].i === 21;
  const rng = mulberry(5), x = Array.from({ length: 2000 }, () => (rng() - 0.5) * 0.06), y = x.map((v) => 0.002 + 0.5 * v + (rng() - 0.5) * 0.02);
  const r = olsNW(y, x); checks.nwRecoversPlantedAlpha = Math.abs(r.alphaDaily - 0.002) < 0.0006 && r.t > 5 && Math.abs(r.beta - 0.5) < 0.05;
  const lw = lunaOwl(bars); checks.lunaNextOpenAfterTouch = lw.every((e) => e.px === bars[e.i].o);
  return { pass: Object.values(checks).every(Boolean), checks };
}

if (require.main === module) (async () => {
  const st = selftest(); console.log(`R187 selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`); if (!st.pass) process.exit(1);
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), T = reg.preregistered.find((x) => x.id === "R187");
  if (!T) { console.error("R187 not registered"); process.exit(2); }
  if (T.bar.tRequired !== BAR) { console.error(`bar mismatch: registry ${T.bar.tRequired} vs script ${BAR}`); process.exit(2); }
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R187) { console.error("R187 already sealed — refusing"); process.exit(2); }
  const H = { BTC: await hourly("BTC"), ETH: await hourly("ETH") }, barsCache = {};
  const barsFor = (asset, tf) => (barsCache[asset + tf] ||= agg(H[asset], TF[tf]));
  const results = [];
  for (const [k, S] of SCRIPTS.entries()) {
    const rec = recorded(S.id), attempts = [];
    for (const tf of S.tfs) { const b = barsFor(S.asset, tf), g = gate(b, S.run(b), rec, TF[tf]); attempts.push({ tf, ...g }); }
    if (S.id === "OZKJvQzBe94tyDZGSGTJ0") for (const tf of S.tfs) { const b = barsFor(S.asset, tf), g = gate(b, lunaOwl(b, { stopFill: true }), rec, TF[tf]); attempts.push({ tf, variant: "stop-level fill (context, N2)", ...g }); }
    const prim = attempts.filter((a) => !a.variant), best = prim.reduce((p, a) => (a.matchPct > p.matchPct ? a : p), prim[0]);
    const row = { id: S.id, name: S.name, asset: S.asset, url: S.url, published: S.pub, settings: S.settings, alphaInsider: { events: rec.events, sideChanges: rec.changes.length, first: rec.first, last: rec.last, leverage: rec.leverage },
      gate: { timeframe: best.tf, matchPct: best.matchPct, matched: best.matched, of: best.recordedChanges, extraOurs: best.extraOurs, pass: best.pass, missed: best.missed, attempts: attempts.map(({ missed, ...a }) => a) }, caveats: S.caveats };
    console.log(`\n${S.name} [${S.asset}] gate: ${attempts.map((a) => `${a.tf}${a.variant ? "(stop)" : ""} ${a.matched}/${a.recordedChanges}=${a.matchPct}% (+${a.extraOurs} extra)`).join(" · ")} -> ${best.pass ? "VERIFIED" : "EXCLUDED"} @ ${best.tf} · AI leverage ${rec.leverage}`);
    if (best.pass) {
      const b = barsFor(S.asset, best.tf), ev = S.run(b), L = rec.leverage || 1.5, ad = assetDays(b, S.pub, OOS_END), oos = stat(account(b, ev, L, S.pub, OOS_END), ad);
      oos.trades = ev.filter((e) => e.side !== 0 && dayOf(b[e.i].ts) >= S.pub && dayOf(b[e.i].ts) <= OOS_END).length;
      const ctl = controls(b, ev, L, S.pub, OOS_END, ad, k), rk = stat(account(b, ev, L, RANK_FROM, RANK_TO), assetDays(b, RANK_FROM, RANK_TO));
      row.oos = oos; row.controls = ctl; row.rankedYearContext = rk; row.leverageUsed = L;
      const f0 = rec.first.slice(0, 10), f1 = rec.last.slice(0, 10), vp = account(b, ev, L, f0, f1); let eq = 1; for (const d of [...vp.keys()].sort()) eq *= 1 + vp.get(d);
      row.gate.precisionPct = +(100 * best.matched / Math.max(1, best.oursInPeriod)).toFixed(1);
      row.valuePathContext = { period: f0 + '..' + f1, alphaInsiderValueRatio: +(rec.lastValue / rec.firstValue).toFixed(3), oursRatioAt10bps: +eq.toFixed(3), note: 'fidelity context only: ours rebalances to constant 1.5x per bar and pays 10 bps; AlphaInsider holds a fixed quantity and pays 25 bps + slippage' };
      row.byYearContext = []; for (let y = +S.pub.slice(0, 4); y <= 2025; y++) { const a0 = y === +S.pub.slice(0, 4) ? S.pub : y + '-01-01', z0 = y === 2025 ? OOS_END : y + '-12-31', sy = stat(account(b, ev, L, a0, z0), assetDays(b, a0, z0)); row.byYearContext.push({ year: y, alphaAnnPct: sy.alphaAnnPct, tNW: sy.tNW, totalPct: sy.totalPct, buyHoldPct: sy.buyHoldPct }); }
      if (S.id === "OZKJvQzBe94tyDZGSGTJ0") { const e2 = lunaOwl(b, { stopFill: true }); row.stopFillContext = stat(account(b, e2, L, S.pub, OOS_END), ad); }
      row.beatsRandomP95 = oos.alphaAnnPct > ctl.randomEntry.alphaAnnPctP95; row.clears = oos.tNW >= BAR && row.beatsRandomP95;
      console.log(`  OOS ${oos.from}..${oos.to} (${oos.days} d): trades ${oos.trades} · total ${oos.totalPct}% vs B&H ${oos.buyHoldPct}% · alpha ${oos.alphaAnnPct}%/yr beta ${oos.beta} t ${oos.tNW} · maxDD ${oos.maxDDPct}%`);
      console.log(`  controls: random p95 alpha ${ctl.randomEntry.alphaAnnPctP95}% (median t ${ctl.randomEntry.tMedian}, centred ${ctl.randomEntry.centred}) · peek t ${ctl.peek.tNW} (clears ${ctl.peek.clearsBar}) · ranked year alpha ${rk.alphaAnnPct}% t ${rk.tNW}${row.stopFillContext ? ` · stop-fill ctx alpha ${row.stopFillContext.alphaAnnPct}% t ${row.stopFillContext.tNW}` : ""}`);
    }
    results.push(row);
  }
  const verified = results.filter((r) => r.gate.pass), excluded = results.filter((r) => !r.gate.pass);
  const controlsPass = verified.length > 0 && verified.every((r) => r.controls.peek.clearsBar && r.controls.randomEntry.centred) && st.pass;
  const winners = verified.filter((r) => r.clears), verdict = winners.length ? "PASS" : "DID NOT PASS";
  const summary = verified.map((r) => `${r.name.split(" by ")[0].slice(0, 32)} ${r.asset} ${r.gate.timeframe}: alpha ${r.oos.alphaAnnPct}%/yr t ${r.oos.tNW} (random p95 ${r.controls.randomEntry.alphaAnnPctP95}%)`).join("; ");
  const line = `${verdict}${winners.length ? ` (clears: ${winners.map((r) => r.name.split(" by ")[0].slice(0, 40) + " " + r.asset).join(", ")})` : ""} — ${verified.length} of 5 verified (${summary})${excluded.length ? `; EXCLUDED untranslatable: ${excluded.map((r) => `${r.name.split(" by ")[0].slice(0, 32)} (${r.gate.matchPct}%)`).join(", ")}` : ""}; bar t ${BAR}`;
  const out = { spec: "r187-read-v1", asOf: new Date().toISOString(), bar: BAR, costPerSide: COST, oosEnd: OOS_END, selftest: st, controlsPass, verdict, verdictLine: line, verified: verified.map((r) => r.id), excluded: excluded.map((r) => ({ id: r.id, name: r.name, matchPct: r.gate.matchPct })), scripts: results, sealed: false,
    ipNote: "Only our JS translation is stored; no Pine source is kept or republished (TradingView House Rules)." };
  console.log(`\nR187 ${controlsPass ? "controls PASS" : "controls FAIL — not sealed"} · ${line}`);
  if (controlsPass && !DRY) {
    const day = new Date().toISOString().slice(0, 10);
    seals.tests.R187 = { sealedOn: day, unit: "days in each verified script's OOS window (publication .. 2025-09-23)", verdict: line, file: "r187-ai-crypto-scripts.json" };
    writeJsonAtomic(D("read-seals.json"), seals);
    T.status = `READ ${day} — ${line}`; writeJsonAtomic(D("test-registry.json"), reg);
    fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R187", verdict: line }) + "\n");
    out.sealed = true;
  }
  writeJsonAtomic(OUT, out);
})().catch((e) => { console.error("R187 FAILED:", e.stack || e.message); process.exit(1); });

module.exports = { SCRIPTS, hourly, agg, TF, account, assetDays, olsNW, stat, runsIn, mulberry, dayOf, COST, lunaOwl };
