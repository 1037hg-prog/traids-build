#!/usr/bin/env node
"use strict";
/**
 * Emitter — R195 crypto funding extremes (contrarian 3-day holds, BTC/ETH) -> R195.
 * backend/r195-funding-extremes.js is NOT require-safe (top-level seal code), so the pieces used are COPIED verbatim:
 *   constants (lines 45), mean/nwT/dayOf/addDays (lines 48-51), daily funding (lines 93-96), signals (lines 101-113), ret (line 114),
 *   series/stat (lines 118-122). Data = the script's own caches backend/data/training/mine3/hl-funding-<COIN>.json and
 *   coinbase-<COIN>-USD-daily.json (read-only; the cache `end` stamps are checked against the script's FUND_END/PX_END).
 * The signal list is checked against the persisted signalRows in data/r195-funding-extremes.json.
 */
const fs = require("fs"), path = require("path");
const { writeEntry, writeUnavailable } = require("../lib-entry.js");
const DATA = path.join(__dirname, "..", "..", "data"), D = (f) => path.join(DATA, f), CACHE = D("training/mine3");
// ---- copied from backend/r195-funding-extremes.js lines 45-51 ----
const COINS = ["BTC", "ETH"], COST = 0.002, LAST_SIGNAL = "2026-08-31";
const FUND_END = Date.UTC(2026, 8, 1), PX_END = Date.UTC(2026, 8, 15);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function nwT(a, L) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * g / n; } return m / Math.sqrt(v / n); }
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10), addDays = (d, k) => dayOf(Date.parse(d + "T00:00:00Z") + k * 86400000);

const base = { id: "R195", name: "Crypto funding extremes (contrarian 3-day, BTC/ETH)", registryId: "R195", script: "backend/r195-funding-extremes.js", emitter: "backend/ensemble/emit/r195.js" };
const fund = {}, px = {};
for (const coin of COINS) {
  const ff = path.join(CACHE, `hl-funding-${coin}.json`), pf = path.join(CACHE, `coinbase-${coin}-USD-daily.json`);
  if (!fs.existsSync(ff) || !fs.existsSync(pf)) { writeUnavailable({ ...base, reason: `cache missing for ${coin} under data/training/mine3` }); process.exit(0); }
  const fj = JSON.parse(fs.readFileSync(ff, "utf8")), pj = JSON.parse(fs.readFileSync(pf, "utf8"));
  if (fj.end !== FUND_END || pj.end !== PX_END) throw new Error(`${coin}: cache end stamp differs from the sealed script's (would have refetched)`);
  fund[coin] = fj.rows; px[coin] = pj.rows;
}
// ---- copied lines 93-96 (daily funding) ----
const daily = {};
for (const coin of COINS) {
  const by = new Map(); for (const r of fund[coin]) { const d = dayOf(r.time); if (!by.has(d)) by.set(d, []); by.get(d).push(r.rate); }
  const m = new Map(); for (const [d, a] of by) { if (a.length >= 12) m.set(d, mean(a)); }
  daily[coin] = m;
}
// ---- copied lines 101-114 (signals, ret) ----
const close = {}; for (const coin of COINS) close[coin] = new Map(px[coin].map((x) => [x.d, x.c]));
const signals = []; let firstEligible = null;
for (const coin of COINS) {
  const m = daily[coin], days = [...m.keys()].sort();
  for (const d of days) {
    if (d > LAST_SIGNAL) continue;
    const tr = []; for (let k = 1; k <= 180; k++) { const x = m.get(addDays(d, -k)); if (x !== undefined) tr.push(x); }
    if (tr.length < 150) continue; if (!firstEligible || d < firstEligible) firstEligible = d;
    const f = m.get(d), lt = tr.filter((x) => x < f).length, gt = tr.filter((x) => x > f).length;
    const dir = lt >= 0.9 * tr.length ? -1 : gt >= 0.9 * tr.length ? 1 : 0;
    if (dir) signals.push({ coin, d, dir, f });
  }
}
const ret = (coin, d, h) => { const a = close[coin].get(d), b = close[coin].get(addDays(d, h)); return a > 0 && b > 0 ? b / a - 1 : NaN; };
// ---- copied lines 118-122 (per-day aggregation + stat) ----
function series(sigs, h, sign = 1) {
  const by = new Map(); for (const s of sigs) { const r = ret(s.coin, s.d, h); if (!Number.isFinite(r)) continue; const x = sign * s.dir * r - COST; if (!by.has(s.d)) by.set(s.d, []); by.get(s.d).push(x); }
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, a]) => ({ d, x: mean(a) }));
}
const stat = (rows, L) => { const a = rows.map((r) => r.x); return { signalDays: a.length, meanNetPct: +(100 * mean(a)).toFixed(3), tNW: +nwT(a, L).toFixed(3) }; };
// ---- end of copied block ----

const persisted = JSON.parse(fs.readFileSync(D("r195-funding-extremes.json"), "utf8"));
const key = (s) => `${s.coin}|${s.d}|${s.dir}`, pk = new Set(persisted.signalRows.map(key)), ok = signals.length === persisted.signalRows.length && signals.every((s) => pk.has(key(s)));
const P = series(signals, 3), prim = stat(P, 2), sealed = persisted.primary.tNW;

// Daily marks. The traded positions = the SAME signals that enter the statistic (3-day return finite). Entry at the Coinbase close of d
// (00:00 UTC d+1), exit at the close of d+3. Per position (R158 addDays model): day d+k return = dir * (close(d+k)/close(d+k-1) - 1),
// entry cost COST/2 on d+1, exit cost COST/2 on d+3. Portfolio day = equal-weight mean over positions open that day.
const acc = new Map(), put = (d, v) => { const e = acc.get(d) || [0, 0]; e[0] += v; e[1]++; acc.set(d, e); };
let traded = 0, gapMerged = 0;
for (const s of signals) {
  if (!Number.isFinite(ret(s.coin, s.d, 3))) continue; traded++;
  let prevD = s.d; const c = close[s.coin];
  for (let k = 1; k <= 3; k++) {
    const d = addDays(s.d, k); if (k < 3 && !(c.get(d) > 0)) { gapMerged++; continue; }   // missing interim close: carry the move into the next marked day
    let v = s.dir * (c.get(d) / c.get(prevD) - 1); if (prevD === s.d) v -= COST / 2; if (k === 3) v -= COST / 2;
    put(d, v); prevD = d;
  }
}
const ser = [...acc.keys()].sort().map((d) => ({ d, r: acc.get(d)[0] / acc.get(d)[1] }));
const lastExit = [ser[ser.length - 1].d, addDays(LAST_SIGNAL, 3)].sort()[1];   // live through the last signal day (08-31) + its 3-day hold; later days are cash
writeEntry({ ...base, unit: "daily", net: true,
  costModel: "10 bps per side (0.20% round trip, as sealed): 10 bps on the first held day (entry at the Coinbase close of the signal day), 10 bps on the exit day",
  window: [addDays(firstEligible, 1), lastExit], calendar: "crypto-24x7", series: ser,
  reproduction: { statistic: "primary NW t (lag 2) of per-signal-day mean net 3-day contrarian return", sealed, emitted: prim.tNW, tolerance: 0.02, match: Math.abs(prim.tNW - sealed) <= 0.02 },
  construction: `Each of the ${traded} traded signals (coin, day d, contrarian dir) is held from the Coinbase close of d to the close of d+3 and marked daily close-to-close (dir x simple daily return, R158 addDays model) on d+1..d+3, with 10 bps entry cost on d+1 and 10 bps exit cost on d+3; the day's return is the equal-weight mean over all positions open that day (overlapping signal days and BTC+ETH on one day all share capital equally).`,
  notes: `Signal list recomputed from the script's caches ${ok ? "= persisted signalRows exactly" : "DIFFERS from persisted signalRows"} (${signals.length} signals, ${P.length} signal days, mean net ${prim.meanNetPct}% vs sealed ${persisted.primary.meanNetPct}%). The sealed statistic averages BTC+ETH per signal day and treats each signal day as one observation; the library series instead shares capital across overlapping 3-day holds, so its daily mean is not the sealed per-signal mean. Short positions use daily-rebalanced marks (sum of daily returns), so a short's compounded series differs from dir x r3 by the compounding term. Interim missing closes merged into the next day: ${gapMerged}. Window starts the day after the first eligible signal day (${firstEligible}; 150 of 180 trailing funding days needed).` });
