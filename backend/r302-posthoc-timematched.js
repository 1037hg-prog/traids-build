#!/usr/bin/env node
/**
 * R302 POST-HOC DIAGNOSTIC (NOT the registered read; never decides the verdict; written 2026-10-01 AFTER the registered read).
 * Question: is the new-listing fade just alt-vs-BTC beta in the same 12 days? Control = the equal-weight BTC-minus-pair excess of
 * every PRE-EXISTING (listed before 2023) non-stable, non-wrapped Coinbase USD pair over the identical [F+2, F+14] window.
 * abnormal gross = event gross - same-window pre-existing alt excess; net = abnormal - 100 bps (same cost).
 *   node backend/r302-posthoc-timematched.js --fetch | --run
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { clusterMeans, tOf, mean } = require("./lib/clustered.js");
const D = (f) => path.join(__dirname, "data", f), CACHE = D("training/r302"), PRE = path.join(CACHE, "preexisting");
const COINBASE = "https://api.exchange.coinbase.com", LAST = "2026-09-30", WIN = 299, DAY = 86400000;
const EXCLUDE = new Set(["USDT","USDC","DAI","PYUSD","GUSD","PAX","USDP","EURC","UST","USTC","BUSD","TUSD","FRAX","LUSD","RLUSD","USDS","GYEN","MUSD","EUROC","FDUSD","USDD","CUSD","SUSD","AUSD","USD1","USDG","WRON","PAXG","WBTC","CBBTC","WETH","CBETH","WSTETH","STETH","LSETH","METH","WEETH","RETH","MSOL","JITOSOL","BNSOL","CBSOL","WAXL","WCFG","WLUNA","WNXM","RENBTC","TBTC","WRBTC","SOLVBTC","LBTC","BTC"]);
const toMs = (s) => Date.parse(s + "T00:00:00Z"), fromMs = (ms) => new Date(ms).toISOString().slice(0, 10), addDays = (s, n) => fromMs(toMs(s) + n * DAY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function get(pq) { for (let a = 0; a < 10; a++) { const w = last + 250 - Date.now(); if (w > 0) await sleep(w); last = Date.now();
  try { const r = await fetch(COINBASE + pq, { headers: { "User-Agent": "traids-r302-research" }, signal: AbortSignal.timeout(30000) }); if (r.status === 429 || r.status >= 500) { await sleep(Math.min(30000, 1000 * 2 ** a)); continue; } if (r.status === 404) return null; if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); } catch (e) { if (a === 9) throw e; await sleep(Math.min(30000, 1000 * 2 ** a)); } } throw new Error("retries"); }
const prods = () => JSON.parse(fs.readFileSync(path.join(CACHE, "products.json"), "utf8")).products;
const preIds = () => prods().filter((p) => { const f = path.join(CACHE, "candles", p.id + ".json"); if (!fs.existsSync(f)) return false; const r = JSON.parse(fs.readFileSync(f, "utf8")); return r.preExisting && !p.fx_stablecoin && !EXCLUDE.has(p.base_currency); }).map((p) => p.id);
async function fetchAll() {
  fs.mkdirSync(PRE, { recursive: true }); const ids = preIds(); let n = 0;
  for (const id of ids) { const f = path.join(PRE, id + ".json"); n++; if (fs.existsSync(f)) continue; const rows = []; let s = "2022-12-01";
    while (s <= LAST) { const e = [addDays(s, WIN - 1), LAST].sort()[0]; const j = await get(`/products/${id}/candles?granularity=86400&start=${s}T00:00:00Z&end=${e}T00:00:00Z`); if (Array.isArray(j)) for (const [t, , , , c] of j) { const d = fromMs(t * 1000); if (c > 0 && d <= LAST) rows.push([d, c]); } s = addDays(e, 1); }
    rows.sort((a, b) => a[0].localeCompare(b[0])); writeJsonAtomic(f, { id, rows }, { pretty: 0 }); if (n % 25 === 0) console.log(`fetched ${n}/${ids.length}`); }
  console.log("fetch complete", ids.length);
}
function run() {
  const ids = preIds(), px = {}; for (const id of ids) { const j = JSON.parse(fs.readFileSync(path.join(PRE, id + ".json"), "utf8")); px[id] = new Map(j.rows); }
  const btc = new Map(JSON.parse(fs.readFileSync(path.join(CACHE, "BTC-USD.json"), "utf8")).rows.map((b) => [b.d, b.c]));
  const reg = JSON.parse(fs.readFileSync(D("r302-crypto-listing-fade.json"), "utf8")), evs = reg.events;
  const ex = [];
  for (const e of evs) {
    const a = addDays(e.F, 2), b = addDays(e.F, 14), b0 = btc.get(a), b1 = btc.get(b); if (!b0 || !b1) continue;
    const xs = []; for (const id of ids) { const p0 = px[id].get(a), p1 = px[id].get(b); if (p0 && p1) xs.push((b1 / b0 - 1) - (p1 / p0 - 1)); }
    if (xs.length < 20) continue; xs.sort((p, q) => p - q);
    const bench = mean(xs), benchMed = (xs[(xs.length - 1) >> 1] + xs[xs.length >> 1]) / 2;
    ex.push({ base: e.base, F: e.F, month: e.F.slice(0, 7), gross: e.gross, bench, benchMed, nBench: xs.length, abn: e.gross - bench - 0.01, abnMed: e.gross - benchMed - 0.01, net: e.net });
  }
  const st = (key, rows = ex) => { const c = clusterMeans(rows, (r) => r.month, (r) => r[key]); return { n: rows.length, months: c.k, meanListing: mean(rows.map((r) => r[key])), meanOfMonthMeans: c.k ? mean(c.means) : null, tMonths: c.k >= 2 ? tOf(c.means) : null }; };
  const MID = "2024-11-15", h = (f) => ex.filter(f);
  const byYear = {}; for (const r of ex) (byYear[r.F.slice(0, 4)] ||= []).push(r); 
  const out = { id: "R302", note: "POST-HOC diagnostic; does not decide the verdict; registered read is data/r302-crypto-listing-fade.json", control: "equal-weight BTC-minus-pair excess of pre-existing (pre-2023) non-stable non-wrapped Coinbase USD pairs over the same [F+2,F+14]", nPreexistingPairs: ids.length,
    events: ex.length, registeredNet: st("net"), alt_tape_gross_excess_same_window: st("bench"), abnormalNet_vsMeanAltTape: st("abn"), abnormalNet_vsMedianAltTape: st("abnMed"),
    halves: { first: st("abn", h((r) => r.F < MID)), second: st("abn", h((r) => r.F >= MID)) }, byYear: Object.fromEntries(Object.entries(byYear).map(([y, r]) => [y, { registeredNet: st("net", r).meanListing, abnormalNet: st("abn", r).meanListing, altTape: st("bench", r).meanListing, n: r.length }])),
    medians: { registeredNet: ex.map((r) => r.net).sort((a, b) => a - b)[ex.length >> 1], abnormalNet: ex.map((r) => r.abn).sort((a, b) => a - b)[ex.length >> 1] }, winRateAbnormal: ex.filter((r) => r.abn > 0).length / ex.length };
  writeJsonAtomic(D("r302-posthoc-timematched.json"), out); console.log(JSON.stringify(out, null, 1));
}
(process.argv.includes("--fetch") ? fetchAll() : run());
