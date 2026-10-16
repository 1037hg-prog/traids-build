#!/usr/bin/env node
"use strict";
/**
 * Emitter — R200 crypto monthly expiry reversal (BTC/ETH, fade the 72h pre-expiry move for 72h) -> R200.
 * backend/r200-crypto-expiry.js is NOT require-safe (top-level seal code), so the pieces used are COPIED verbatim:
 *   constants (lines 47-49), mean/tPlain (lines 52-53), sgn (line 56), fridays (lines 84-87), px map + priceAt + legs + legNet + pooled
 *   (lines 92-98), the month loop (lines 100-107), primVals + stat t (line 112). Data = the script's own cache
 *   backend/data/training/flows4/coinbase-<COIN>-USD-1h.json (read-only; startMs/endMs checked against the script's PX_START/PX_END).
 * The per-expiry nets are checked against the persisted `expiries` rows in data/r200-crypto-expiry.json.
 */
const fs = require("fs"), path = require("path");
const { writeEntry, writeUnavailable } = require("../lib-entry.js");
const DATA = path.join(__dirname, "..", "..", "data"), CACHE = path.join(DATA, "training", "flows4");
// ---- copied from backend/r200-crypto-expiry.js lines 47-49, 52-53, 56 ----
const COST = 0.001, H = 3600e3, WIN = 72 * H, MAX_STALE = 3;
const PX_START = Date.parse("2019-12-20T00:00:00Z"), PX_END = Date.parse("2026-09-01T00:00:00Z");
const COINS = ["BTC", "ETH"], FIRST_MONTH = "2020-01", LAST_MONTH = "2026-08";
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function tPlain(a) { const n = a.length, m = mean(a); const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1); return m / Math.sqrt(v / n); }
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
// ---- copied lines 84-87 ----
function fridays(y, mo) {
  const out = []; for (let d = 1; d <= 31; d++) { const t = Date.UTC(y, mo - 1, d, 8); if (new Date(t).getUTCMonth() !== mo - 1) break; if (new Date(t).getUTCDay() === 5) out.push(t); }
  return out;
}

const base = { id: "R200", name: "Crypto monthly expiry reversal (BTC/ETH, 72h fade)", registryId: "R200", script: "backend/r200-crypto-expiry.js", emitter: "backend/ensemble/emit/r200.js" };
// ---- copied lines 91-98 (cache read replaces the fetcher; same rows) ----
const px = {}, stale = { count: 0, maxH: 0 };
for (const c of COINS) {
  const f = path.join(CACHE, `coinbase-${c}-USD-1h.json`); if (!fs.existsSync(f)) { writeUnavailable({ ...base, reason: `cache missing: data/training/flows4/coinbase-${c}-USD-1h.json` }); process.exit(0); }
  const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j.startMs !== PX_START || j.endMs !== PX_END) throw new Error(`${c}: cache span differs from the sealed script's`);
  px[c] = new Map(j.rows.map((r) => [r.t, r.c]));
}
const priceAt = (c, T) => { for (let k = 1; k <= 1 + MAX_STALE; k++) { const v = px[c].get(T - k * H); if (v != null) { if (k > 1) { stale.count++; stale.maxH = Math.max(stale.maxH, k - 1); } return v; } } return null; };
const legs = (A) => { const o = {}; for (const c of COINS) { const p0 = priceAt(c, A - WIN), p1 = priceAt(c, A), p2 = priceAt(c, A + WIN); if (p0 == null || p1 == null || p2 == null) return null; o[c] = { pre: p1 / p0 - 1, post: p2 / p1 - 1 }; } return o; };
const legNet = (L, dir, cost = COST) => { const p = dir * sgn(L.pre); return p * L.post - (p ? 2 * cost : 0); };
const pooled = (lg, dir = -1, cost = COST, coins = COINS) => mean(coins.map((c) => legNet(lg[c], dir, cost)));
// ---- copied lines 100-107 (placebos not needed) ----
const months = [];
for (let y = 2020; y <= 2026; y++) for (let mo = 1; mo <= 12; mo++) {
  const key = `${y}-${String(mo).padStart(2, "0")}`; if (key < FIRST_MONTH || key > LAST_MONTH) continue;
  const fr = fridays(y, mo), E = fr[fr.length - 1], lg = legs(E);
  if (!lg) continue;
  months.push({ key, E, expiry: new Date(E).toISOString(), lg });
}
// ---- copied line 112 (statistic) ----
const primVals = months.map((m) => pooled(m.lg)), emitted = +tPlain(primVals).toFixed(3);
// ---- end of copied block ----

const persisted = JSON.parse(fs.readFileSync(path.join(DATA, "r200-crypto-expiry.json"), "utf8")), sealed = persisted.primary.t;
const pm = new Map(persisted.expiries.map((e) => [e.month, e.netPct])), rowsOk = months.length === persisted.expiries.length && months.every((m, i) => Math.abs(pm.get(m.key) - +(100 * primVals[i]).toFixed(3)) < 1e-9);

// Daily marks: per coin p = -sgn(pre); marks at E (Fri 08:00), Sat/Sun/Mon 00:00 UTC and E+72h (Mon 08:00), each price by the script's
// priceAt convention. Day return per coin = p * (P_k / P_{k-1} - 1) (daily-rebalanced marks, R158 model); 10 bps entry on the Friday,
// 10 bps exit on the Monday. The script's portfolio is the pooled BTC/ETH equal weight (a flat coin = 0), so day r = mean over both coins.
const acc = new Map(); let merged = 0;
for (const m of months) {
  const marks = [m.E, m.E + 16 * H, m.E + 40 * H, m.E + 64 * H, m.E + WIN];   // Sat 00:00 = E+16h, Sun +40h, Mon +64h
  for (const c of COINS) {
    const p = -sgn(m.lg[c].pre); if (!p) continue;
    let prevT = marks[0], prevP = priceAt(c, marks[0]);
    for (let k = 1; k < marks.length; k++) {
      const T = marks[k], P = priceAt(c, T); if (P == null && k < marks.length - 1) { merged++; continue; }
      const d = new Date(T - 1).toISOString().slice(0, 10);   // the UTC day the move happened in (a 00:00 mark closes the previous day)
      let v = p * (P / prevP - 1); if (prevT === marks[0]) v -= COST; if (k === marks.length - 1) v -= COST;
      acc.set(d, (acc.get(d) || 0) + v / COINS.length); prevT = T; prevP = P;
    }
  }
}
const ser = [...acc.keys()].sort().map((d) => ({ d, r: acc.get(d) }));
writeEntry({ ...base, unit: "daily", net: true,
  costModel: "10 bps per side per coin (as sealed): 10 bps on the Friday entry at the expiry, 10 bps on the Monday exit; a coin with zero pre-move is flat and pays nothing",
  window: ["2020-01-01", "2026-08-31"], calendar: "crypto-24x7", series: ser,
  reproduction: { statistic: "primary t (plain one-sample, sd n-1) over expiries of the pooled BTC/ETH net reversal return", sealed, emitted, tolerance: 0.02, match: Math.abs(emitted - sealed) <= 0.02 },
  construction: `For each of the ${months.length} priced last-Friday 08:00 UTC expiries, each coin fades its 72h pre-expiry move from E to E+72h; the hold is marked at 00:00 UTC Sat/Sun/Mon (price = close of the prior hourly candle, the script's convention) so it books on Fri, Sat, Sun and Mon with entry cost on Fri and exit cost on Mon; day return = mean over BTC and ETH (the script's pooled equal weight, flat coin = 0).`,
  notes: `Per-expiry pooled nets ${rowsOk ? "= persisted expiries rows exactly" : "DIFFER from persisted expiries rows"}. The sealed t is over the per-expiry nets (pos x post - costs); the daily marks use daily-rebalanced simple returns, so a short's 4-day compounded path differs from pos x post by the compounding term. Interim midnight marks missing and merged into the next mark: ${merged}; stale price fallbacks (<=3h) ${stale.count}. Window = the registered 2020-01..2026-08 months; only ~4 days a month carry capital.` });
