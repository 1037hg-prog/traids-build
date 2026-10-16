#!/usr/bin/env node
/**
 * GEX RECORDER — dealer gamma exposure from real open interest (2026-09-30, operator: "do both a and b").
 *
 * WHY. R289 tested a same-day 0DTE "gamma" filter and DID NOT PASS (t -3.06), but it had to use a VOLUME-gamma proxy because no
 * open-interest history existed. Schwab keeps no historical chains, so the only way to get an honest GEX test is to record it forward.
 * This writes, twice a day, every SPX / SPY / QQQ option within 60 days: strike, expiry, right, open interest (the prior session's
 * settled OI), gamma, delta, IV, volume, bid/ask — plus the computed exposure.
 *
 * GEX (the common "dealers long calls, short puts" convention, SqueezeMetrics-style): per contract
 *   GEX$ = sign x gamma x OI x 100 x S^2 x 0.01   (sign +1 call, -1 put)  = dollars of underlying dealers must trade per 1% move.
 * Summary per snapshot: total GEX, GEX by expiry bucket (0DTE, 1-7d, 8-60d), call wall (strike with the largest call GEX), put wall
 * (largest |put GEX|), and the gamma FLIP level (spot at which total GEX, re-priced with Black-Scholes gamma at each contract's IV,
 * crosses zero; searched on a +/-10% grid). The convention is an assumption about who is short what; it is recorded, not proved.
 *
 * SLOTS (self-gated, once each per trading day): "open" 09:40-10:15 ET, "close" 15:30-15:55 ET. A missed slot is logged as missed,
 * never back-filled (three record types). Read-only: Schwab market data only; no orders anywhere.
 *   node backend/gex-record.js            run the slot that is open now (intraday.bat fires every 30 min)
 *   node backend/gex-record.js --test     ignore the clock, SPY only, print the summary, write nothing
 *   node backend/gex-record.js --schwab-md   W2b (server migration 2026-10, docs/server/wave2b-schwab; the VPS units traids-gex /
 *        traids-gex-shadow only): the token of the operator's MARKET-DATA-ONLY Schwab app (lib/schwab-md.js: the unit's EnvironmentFile
 *        + the VPS token file; it refuses home's own env names) instead of lib/schwab.js + backend/.env (dotenv is not loaded), and
 *        a market holiday records nothing (home's intraday.bat never fires on one). Same slots, rows and files. No flag: unchanged.
 * Output: data/gex/<date>-<slot>-<sym>.json (rows [occ, exp, right, strike, oi, gamma, delta, iv, volume, bid, ask]) and one summary
 * line per symbol and slot in data/gex/summary.jsonl.
 */
"use strict";
const fs = require("fs"), path = require("path");
const MD = process.argv.includes("--schwab-md");   // W2b (2026-10): the VPS units only — see the header
if (!MD) require("dotenv").config({ path: path.join(__dirname, ".env") });
const { token } = require(MD ? "./lib/schwab-md.js" : "./lib/schwab.js");   // W2b: the market-data app on the VPS; home unchanged
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const DIR = path.join(__dirname, "data", "gex"), SUMMARY = path.join(DIR, "summary.jsonl");
const TEST = process.argv.includes("--test");
const SYMS = [["$SPX", 200, [[0, 3], [4, 10], [11, 24], [25, 45], [46, 60]]], ["SPY", 120, [[0, 60]]], ["QQQ", 120, [[0, 60]]]];
const SLOTS = [["open", "09:40", "10:15"], ["close", "15:30", "15:55"]];
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(0, 19) + "Z [gex]", ...a);
const et = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date()).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === "24" ? "00" : p.hour}:${p.minute}`, wd: p.weekday }; };
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);

async function chainSlice(sym, strikes, from, to, tok) {
  const u = `https://api.schwabapi.com/marketdata/v1/chains?symbol=${encodeURIComponent(sym)}&contractType=ALL&strikeCount=${strikes}&fromDate=${from}&toDate=${to}`;
  for (let a = 0; a < 4; a++) {
    const r = await fetch(u, { headers: { Authorization: "Bearer " + tok }, signal: AbortSignal.timeout(60000) }).catch((e) => ({ ok: false, status: "net " + e.message }));
    if (r.status === 429 || r.status >= 500 || String(r.status).startsWith("net")) { await nap(3000 * (a + 1)); continue; }
    if (!r.ok) throw new Error(`${sym} chain ${r.status}`);
    const j = await r.json(), rows = [];
    for (const [kind, right] of [["callExpDateMap", "C"], ["putExpDateMap", "P"]]) for (const st of Object.values(j[kind] || {})) for (const arr of Object.values(st)) for (const c of arr) {
      const g = Number(c.gamma), oi = Number(c.openInterest) || 0;
      rows.push([String(c.symbol || "").replace(/\s+/g, ""), String(c.expirationDate || "").slice(0, 10), right, +c.strikePrice, oi, Number.isFinite(g) && g > -900 ? g : null, Number(c.delta) > -900 ? Number(c.delta) : null, Number(c.volatility) > 0 ? +c.volatility : null, Number(c.totalVolume) || 0, Number(c.bid) || 0, Number(c.ask) || 0]);
    }
    return { rows, spot: Number(j.underlyingPrice) || null };
  }
  throw new Error(`${sym} chain ${from}..${to}: failed after retries`);
}

// Black-Scholes gamma (r = 0, q = 0: enough to locate the flip; the snapshot's own gamma is used for the level at spot)
const npdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
const bsGamma = (S, K, T, iv) => { if (!(S > 0 && K > 0 && T > 0 && iv > 0)) return 0; const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / (iv * Math.sqrt(T)); return npdf(d1) / (S * iv * Math.sqrt(T)); };

function summarize(sym, rows, spot, date) {
  const yrs = (exp) => Math.max(1 / 365 / 6.5, (Date.parse(exp + "T20:00:00Z") - Date.now()) / (365 * 864e5));
  const gexAt = (S, useSnapshot) => rows.reduce((s, r) => { const [, exp, right, K, oi, g, , iv] = r; if (!(oi > 0)) return s; const gg = useSnapshot ? g : bsGamma(S, K, yrs(exp), (iv || 0) / 100); if (!(gg > 0)) return s; return s + (right === "C" ? 1 : -1) * gg * oi * 100 * S * S * 0.01; }, 0);
  const byStrike = new Map(), bucket = { "0dte": 0, "1-7d": 0, "8-60d": 0 };
  for (const r of rows) { const [, exp, right, K, oi, g] = r; if (!(oi > 0 && g > 0)) continue; const v = (right === "C" ? 1 : -1) * g * oi * 100 * spot * spot * 0.01;
    const s = byStrike.get(K) || { call: 0, put: 0 }; if (right === "C") s.call += v; else s.put += v; byStrike.set(K, s);
    const d = Math.round((Date.parse(exp) - Date.parse(date)) / 864e5); bucket[d <= 0 ? "0dte" : d <= 7 ? "1-7d" : "8-60d"] += v; }
  let callWall = null, putWall = null; for (const [K, s] of byStrike) { if (!callWall || s.call > callWall.gex) callWall = { strike: K, gex: s.call }; if (!putWall || s.put < putWall.gex) putWall = { strike: K, gex: s.put }; }
  let flip = null, prev = null; for (let k = -100; k <= 100; k++) { const S = spot * (1 + k / 1000); const v = gexAt(S, false); if (prev && Math.sign(v) !== Math.sign(prev.v)) { flip = +(prev.S + (S - prev.S) * (Math.abs(prev.v) / (Math.abs(prev.v) + Math.abs(v)))).toFixed(2); if (Math.abs(S - spot) > Math.abs((flip ?? S) - spot)) break; } prev = { S, v }; }
  const M = (x) => Math.round(x / 1e6);
  return { sym, spot, contracts: rows.length, withOI: rows.filter((r) => r[4] > 0).length, totalGexM: M(gexAt(spot, true)), bucketsM: Object.fromEntries(Object.entries(bucket).map(([k, v]) => [k, M(v)])), callWall: callWall && { strike: callWall.strike, gexM: M(callWall.gex) }, putWall: putWall && { strike: putWall.strike, gexM: M(putWall.gex) }, flip, convention: "dealers long calls / short puts" };
}

(async () => {
  const t = et(); let slot = null;
  if (!TEST) {
    if (["Sat", "Sun"].includes(t.wd)) return log("weekend — nothing to record");
    if (MD) { const hol = require("./lib/run-window.js").marketHoliday(t.date); if (hol) return log(`${t.date} is a market holiday (${hol}) — nothing to record`); }   // W2b: as intraday.bat at home
    slot = SLOTS.find(([, lo, hi]) => t.hm >= lo && t.hm < hi); if (!slot) return log(`${t.hm} ET is outside both slots — nothing to do`);
  }
  fs.mkdirSync(DIR, { recursive: true });
  const tok = await token(); const date = t.date, name = TEST ? "test" : slot[0];
  for (const [sym, strikes, slices] of TEST ? [SYMS[1]] : SYMS) {
    const f = path.join(DIR, `${date}-${name}-${sym.replace("$", "")}.json`); if (!TEST && fs.existsSync(f)) { log(`${sym} ${name} already recorded`); continue; }
    try {
      let rows = [], spot = null; for (const [a, b] of slices) { const r = await chainSlice(sym, strikes, addDays(date, a), addDays(date, b), tok); rows = rows.concat(r.rows); spot = spot || r.spot; await nap(500); }
      const seen = new Set(); rows = rows.filter((r) => (seen.has(r[0]) ? false : seen.add(r[0])));
      const sum = { at: new Date().toISOString(), date, slot: name, ...summarize(sym, rows, spot, date) };
      if (TEST) { console.log(JSON.stringify(sum)); continue; }
      writeJsonAtomic(f, { spec: "rows [occ, exp, right, strike, oi, gamma, delta, iv%, volume, bid, ask]", ...sum, rows });
      fs.appendFileSync(SUMMARY, JSON.stringify(sum) + "\n");
      log(`${sym} ${name}: spot ${spot} · ${rows.length} contracts · total GEX ${sum.totalGexM}M/1% · call wall ${sum.callWall && sum.callWall.strike} · put wall ${sum.putWall && sum.putWall.strike} · flip ${sum.flip}`);
    } catch (e) { log(`${sym} ${name}: MISSED — ${e.message}`); fs.appendFileSync(SUMMARY, JSON.stringify({ at: new Date().toISOString(), date, slot: name, sym, missed: e.message.slice(0, 120) }) + "\n"); }
  }
})().catch((e) => { log("ERROR " + e.message); process.exit(1); });
