#!/usr/bin/env node
/**
 * R271 — OPTIONS WHALE PRINTS, HISTORICAL (registered 2026-09-27 before any flow data was fetched; amended R271-A1 the same
 * session, pre-evidence, adding variant B "clean sweeps"). Operator: "do we have an options whale tracker" → "register and build both".
 *
 * RULE (frozen in backend/register-r271-r272.js + amend-r271-sweeps.js; restated here, the registry wins on any conflict):
 *   Universe: the 80 names in data/r147-earnings.
 *   A contract-day (contract c, day d) is a WHALE (variant A) when: DTE 1..45; OTM 2..25% vs the underlying's RAW close on d;
 *     volume >= 500; premium = volume x vw x 100 >= $500k; volume >= 5 x mean volume over the 10 prior trading days (no bar = 0)
 *     and >= 3 prior days with a bar.
 *   Variant B: A's contract-days re-measured from that day's TRADES with multi-leg / stock-tied / cancelled prints removed;
 *     single-leg volume >= 500, premium >= $500k, and sweep share >= 0.5 (ISO-flagged S/b/d, or a >= 2-exchange cluster of
 *     trades each within 500 ms of the previous).
 *   Name-day direction = sign(call whale premium - put whale premium). Enter the underlying at d+1 OPEN, exit d+5 CLOSE,
 *   signed, split/dividend-adjusted, minus 20 bps round trip. Clustered by signal date; t over dates; bar best-of-2 = 1.959.
 *   Timing control: random non-signal days of the same name, same direction, 1,000 draws; PASS needs t >= bar AND mean > p95.
 *
 *   node backend/r271-options-whale-hist.js --collect [--only SYM]   contracts + daily bars + qualifying days' trades; NO outcome read
 *   node backend/r271-options-whale-hist.js --status                 collection progress
 *   node backend/r271-options-whale-hist.js --read                   the one registered read (refuses unless all 80 names are complete)
 */
"use strict";
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { fetchBars } = require("./lib/alpaca-bars.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), CACHE = D("r271-cache"), EARN = D("r147-earnings"), OUT = D("r271-options-whale-hist.json");
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
const args = process.argv.slice(2), mode = ["--collect", "--status", "--read"].find((m) => args.includes(m)) || "--status";
const EV_START = "2024-02-01", SIG_END = "2026-09-17", EXP_END = "2026-09-25";
const MIN_VOL = 500, MIN_PREM = 500000, SPIKE = 5, LOOKBACK = 10, MIN_PRIOR = 3, DTE_MAX = 45, OTM_MIN = 0.02, OTM_MAX = 0.25, WIN = 0.30;
const COST = 0.0020, COST_STRESS = 0.0050, HOLD = 5, BAR = 1.959, DRAWS = 1000;
const CANCEL = new Set(["A", "C", "E", "G"]);
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length >= 3 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const dte = (d, exp) => Math.round((Date.parse(exp + "T12:00:00Z") - Date.parse(d + "T12:00:00Z")) / 864e5);
const universe = () => fs.readdirSync(EARN).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();

// ── rate-limited GET (Alpaca data: 200/min on the basic plan; we stay ~180) ────────────────────────────────────────
let lastReq = 0, nReq = 0;
async function get(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastReq + 335 - Date.now(); if (wait > 0) await nap(wait); lastReq = Date.now(); nReq++;
    try {
      const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(45000) });
      if (r.status === 429 || r.status >= 500) { await nap(5000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
      return await r.json();
    } catch (e) { if (attempt === 5) throw e; await nap(3000 * (attempt + 1)); }
  }
}

let MULTI = null;
async function conditionSets() {
  if (MULTI) return MULTI;
  const m = await get("https://data.alpaca.markets/v1beta1/options/meta/conditions/trade");
  MULTI = new Set(Object.entries(m).filter(([, v]) => /multi leg|stock option/i.test(v)).map(([k]) => k));
  return MULTI;
}

async function contractsFor(sym) {
  const out = new Map();
  for (const status of ["inactive", "active"]) {
    let tok = null;
    do {
      const u = `https://paper-api.alpaca.markets/v2/options/contracts?underlying_symbols=${sym}&status=${status}&expiration_date_gte=${EV_START}&expiration_date_lte=${EXP_END}&limit=10000${tok ? "&page_token=" + tok : ""}`;
      const j = await get(u);
      for (const c of j.option_contracts || []) if (c.root_symbol === sym) out.set(c.symbol, { occ: c.symbol, exp: c.expiration_date, right: c.type === "call" ? "C" : "P", strike: +c.strike_price });
      tok = j.next_page_token;
    } while (tok);
  }
  return [...out.values()];
}

async function optionBars(occs, start, end) {
  const res = {}; let tok = null;
  do {
    const u = `https://data.alpaca.markets/v1beta1/options/bars?symbols=${occs.join(",")}&timeframe=1Day&start=${start}&end=${end}&limit=10000${tok ? "&page_token=" + tok : ""}`;
    const j = await get(u);
    for (const [k, v] of Object.entries(j.bars || {})) (res[k] = res[k] || []).push(...v);
    tok = j.next_page_token;
  } while (tok);
  return res;
}

async function dayTrades(occ, d) {
  const out = []; let tok = null;
  do {
    const u = `https://data.alpaca.markets/v1beta1/options/trades?symbols=${occ}&start=${d}T08:00:00Z&end=${addDays(d, 1)}T02:00:00Z&limit=10000${tok ? "&page_token=" + tok : ""}`;
    const j = await get(u);
    out.push(...((j.trades || {})[occ] || []));
    tok = j.next_page_token;
  } while (tok);
  return out;
}

/** Variant B measurement of one contract-day from its trades. */
function measureTrades(trades, multi) {
  const legs = trades.filter((t) => { const cs = String(t.c || ""); for (const ch of cs) { if (CANCEL.has(ch) || multi.has(ch)) return false; } return true; })
    .map((t) => ({ ms: Date.parse(t.t), p: t.p, s: t.s, x: t.x, iso: /[Sbd]/.test(String(t.c || "")) })).sort((a, b) => a.ms - b.ms);
  const vol = legs.reduce((s, t) => s + t.s, 0), prem = legs.reduce((s, t) => s + t.s * t.p * 100, 0);
  const sweep = new Array(legs.length).fill(false);
  for (let i = 0; i < legs.length;) { let j = i; while (j + 1 < legs.length && legs[j + 1].ms - legs[j].ms <= 500) j++;
    if (j > i && new Set(legs.slice(i, j + 1).map((t) => t.x)).size >= 2) for (let k = i; k <= j; k++) sweep[k] = true; i = j + 1; }
  const sweepVol = legs.reduce((s, t, k) => s + (t.iso || sweep[k] ? t.s : 0), 0);
  return { slVol: vol, slPrem: Math.round(prem), sweepShare: vol ? +(sweepVol / vol).toFixed(4) : 0, trades: trades.length, legsKept: legs.length };
}

async function collectOne(sym) {
  const file = path.join(CACHE, sym + ".json");
  if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).complete) return console.log(`${sym}: done already`);
  const req0 = nReq, multi = await conditionSets();
  const { bars } = await fetchBars([sym], { start: "2023-11-01", end: "2026-09-26T20:00:00Z", feed: "sip", adjustment: "raw", quiet: true, requireAll: false });
  const ub = (bars[sym] || []).map((b) => ({ d: b.t.slice(0, 10), c: b.c }));
  if (!ub.length) { writeJsonAtomic(file, { sym, complete: true, note: "no underlying bars", contractsListed: 0, candidates: [] }); return console.log(`${sym}: no underlying bars`); }
  const cal = ub.map((b) => b.d), idx = new Map(cal.map((d, i) => [d, i])), close = new Map(ub.map((b) => [b.d, b.c]));
  const closeOnOrBefore = (d) => { let lo = 0, hi = cal.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (cal[m] <= d) { ans = m; lo = m + 1; } else hi = m - 1; } return ans >= 0 ? ub[ans].c : ub[0].c; };
  const listed = await contractsFor(sym);
  const kept = listed.filter((c) => { const ref = closeOnOrBefore(addDays(c.exp, -DTE_MAX)); return c.strike >= ref * (1 - WIN) && c.strike <= ref * (1 + WIN); });
  const byExp = new Map(); for (const c of kept) { if (!byExp.has(c.exp)) byExp.set(c.exp, []); byExp.get(c.exp).push(c); }
  const candidates = [];
  for (const [exp, cs] of [...byExp.entries()].sort()) {
    const start = addDays(exp, -(DTE_MAX + 20)), end = exp;
    for (let i = 0; i < cs.length; i += 100) {
      const batch = cs.slice(i, i + 100), got = await optionBars(batch.map((c) => c.occ), start, end);
      for (const c of batch) {
        const bs = got[c.occ] || []; if (!bs.length) continue;
        const vol = new Map(bs.map((b) => [b.t.slice(0, 10), b]));
        for (const b of bs) {
          const d = b.t.slice(0, 10); if (d < EV_START || d > SIG_END) continue;
          const k = dte(d, c.exp), prem = b.v * b.vw * 100; if (k < 1 || k > DTE_MAX || b.v < MIN_VOL || prem < MIN_PREM) continue;
          const i0 = idx.get(d); if (i0 == null) continue;
          const prior = cal.slice(Math.max(0, i0 - LOOKBACK), i0), avg10 = prior.length ? prior.reduce((s, pd) => s + (vol.get(pd)?.v || 0), 0) / LOOKBACK : 0;
          const priorBars = bs.filter((x) => x.t.slice(0, 10) < d).length, spot = close.get(d);
          const otm = c.right === "C" ? c.strike / spot - 1 : 1 - c.strike / spot;
          const qualA = b.v >= SPIKE * avg10 && priorBars >= MIN_PRIOR && otm >= OTM_MIN && otm <= OTM_MAX;
          candidates.push({ occ: c.occ, d, exp: c.exp, right: c.right, strike: c.strike, v: b.v, vw: b.vw, prem: Math.round(prem), avg10: +avg10.toFixed(1), priorBars, spot, otm: +otm.toFixed(4), dte: k, qualA });
        }
      }
    }
  }
  for (const cd of candidates.filter((x) => x.qualA)) Object.assign(cd, measureTrades(await dayTrades(cd.occ, cd.d), multi));
  writeJsonAtomic(file, { sym, complete: true, collectedAt: new Date().toISOString(), contractsListed: listed.length, contractsKept: kept.length, requests: nReq - req0, candidates });
  console.log(`${sym}: ${listed.length} listed, ${kept.length} kept, ${candidates.length} large prints, ${candidates.filter((x) => x.qualA).length} variant-A days, ${nReq - req0} requests`);
}

async function collect() {
  fs.mkdirSync(CACHE, { recursive: true });
  const only = args.includes("--only") ? [args[args.indexOf("--only") + 1]] : universe();
  for (const s of only) { try { await collectOne(s); } catch (e) { console.error(`${s}: FAILED ${e.message}`); } }
}

function status() {
  const u = universe(), done = u.filter((s) => { try { return JSON.parse(fs.readFileSync(path.join(CACHE, s + ".json"), "utf8")).complete; } catch { return false; } });
  console.log(`R271 collection: ${done.length}/${u.length} names complete${done.length < u.length ? " · missing: " + u.filter((s) => !done.includes(s)).join(" ") : ""}`);
  return { done, u };
}

async function read() {
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); if (![...reg.tests, ...reg.preregistered].some((t) => t.id === "R271")) throw new Error("R271 not registered");
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests.R271) throw new Error("R271 already sealed — read-once");
  const { done, u } = status(); if (done.length < u.length) throw new Error("collection incomplete — the registered read needs all 80 names");
  const cache = Object.fromEntries(u.map((s) => [s, JSON.parse(fs.readFileSync(path.join(CACHE, s + ".json"), "utf8"))]));
  const { bars } = await fetchBars(u, { start: "2024-01-01", end: "2026-09-26T20:00:00Z", feed: "sip", adjustment: "all", quiet: true, requireAll: false });
  const px = {}; for (const s of u) { const b = bars[s] || []; px[s] = { cal: b.map((x) => x.t.slice(0, 10)), o: b.map((x) => x.o), c: b.map((x) => x.c) }; px[s].idx = new Map(px[s].cal.map((d, i) => [d, i])); }
  const ret = (s, d, dir, h, exitOnClose = true) => { const p = px[s]; const i = p.idx.get(d); if (i == null || i + h >= p.cal.length) return null; const e = p.o[i + 1], x = p.c[i + h]; return dir * (x / e - 1); };
  const earnDays = {}; for (const s of u) { const j = JSON.parse(fs.readFileSync(path.join(EARN, s + ".json"), "utf8")); earnDays[s] = (j.quarterlyEarnings || []).map((q) => q.reportedDate).filter(Boolean); }
  const nearEarn = (s, d) => { const p = px[s], i = p.idx.get(d); if (i == null) return false; return earnDays[s].some((e) => { let j = p.idx.get(e); if (j == null) { j = p.cal.findIndex((x) => x >= e); if (j < 0) return false; } return Math.abs(j - i) <= 3; }); };

  const signalsFor = (variant) => {
    const out = [];
    for (const s of u) {
      const by = new Map();
      for (const c of cache[s].candidates || []) {
        if (!c.qualA) continue;
        let prem = c.prem;
        if (variant === "B") { if (!(c.slVol >= MIN_VOL && c.slPrem >= MIN_PREM && c.sweepShare >= 0.5)) continue; prem = c.slPrem; }
        by.set(c.d, (by.get(c.d) || 0) + (c.right === "C" ? prem : -prem));
      }
      for (const [d, net] of by) if (net !== 0) out.push({ s, d, dir: net > 0 ? 1 : -1, net });
    }
    return out;
  };
  const clustered = (rows, h, cost) => { const byD = new Map(); for (const r of rows) { const x = ret(r.s, r.d, r.dir, h); if (x == null) continue; if (!byD.has(r.d)) byD.set(r.d, []); byD.get(r.d).push(x - cost); }
    const per = [...byD.values()].map(mean); return { dates: per.length, signals: [...byD.values()].reduce((a, v) => a + v.length, 0), meanPct: per.length ? +(100 * mean(per)).toFixed(4) : null, t: per.length ? +(tOf(per) ?? 0).toFixed(3) : null }; };
  let seed = 271271; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const report = {};
  for (const v of ["A", "B"]) {
    const sig = signalsFor(v), sigKey = new Set(sig.map((r) => r.s + "|" + r.d));
    const prim = clustered(sig, HOLD, COST), gross = clustered(sig, HOLD, 0);
    const pools = {}; for (const s of u) pools[s] = px[s].cal.filter((d, i) => d >= EV_START && d <= SIG_END && i + HOLD < px[s].cal.length && !sigKey.has(s + "|" + d));
    const ctrl = []; for (let k = 0; k < DRAWS; k++) { const rows = sig.filter((r) => pools[r.s].length).map((r) => ({ s: r.s, d: pools[r.s][Math.floor(rnd() * pools[r.s].length)], dir: r.dir })); ctrl.push(clustered(rows, HOLD, COST).meanPct); }
    ctrl.sort((a, b) => a - b); const p95 = ctrl[Math.floor(0.95 * DRAWS)];
    const ne = sig.filter((r) => nearEarn(r.s, r.d));
    report[v] = { signals: sig.length, bullish: sig.filter((r) => r.dir > 0).length, bearish: sig.filter((r) => r.dir < 0).length,
      primary5dNet: prim, gross5d: gross, controlP95MeanPct: p95, controlMedianMeanPct: ctrl[DRAWS >> 1],
      pass: prim.t != null && prim.t >= BAR && prim.meanPct > p95,
      secondary: { day1: clustered(sig, 1, COST), day20: clustered(sig, 20, COST), stress50bps: clustered(sig, HOLD, COST_STRESS), bullOnly: clustered(sig.filter((r) => r.dir > 0), HOLD, COST), bearOnly: clustered(sig.filter((r) => r.dir < 0), HOLD, COST),
        nearEarningsShare: sig.length ? +(ne.length / sig.length).toFixed(3) : null, exEarnings: clustered(sig.filter((r) => !nearEarn(r.s, r.d)), HOLD, COST) } };
  }
  const pass = report.A.pass || report.B.pass;
  const verdict = `${pass ? "PASSED" : "DID NOT PASS"} — A: net ${report.A.primary5dNet.meanPct}%/date t ${report.A.primary5dNet.t} (${report.A.primary5dNet.dates} dates) vs bar ${BAR}, control p95 ${report.A.controlP95MeanPct}%; B (sweeps): net ${report.B.primary5dNet.meanPct}% t ${report.B.primary5dNet.t} (${report.B.primary5dNet.dates} dates), control p95 ${report.B.controlP95MeanPct}%`;
  writeJsonAtomic(OUT, { test: "R271", readAt: new Date().toISOString(), bar: BAR, verdict, report });
  seals.tests = seals.tests || {}; seals.tests.R271 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "signal dates (equal-weight mean over names), one-sample t; best-of-2 bar", verdict, output: "data/r271-options-whale-hist.json" };
  writeJsonAtomic(D("read-seals.json"), seals);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", tests: ["R271"], detail: verdict }) + "\n");
  console.log(verdict); console.log(JSON.stringify(report, null, 1));
}

(async () => { if (mode === "--collect") await collect(); else if (mode === "--read") await read(); else status(); })().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
