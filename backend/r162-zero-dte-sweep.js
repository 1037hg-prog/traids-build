#!/usr/bin/env node
/**
 * R162 — 0DTE SHORT-SPREAD STRUCTURE SWEEP on real same-day option prices (#2 of the operator's ordered list, 2026-09-23).
 * Context: R25's live 0DTE sleeve is +0.04R over 158 trades, but R116 walked the frozen R25 rule over 501 archived sessions
 * (2024-08-19..2026-08-18) and it DID NOT PASS (-0.0086R/session, t -0.84). This asks the broader question honestly: is there ANY
 * short 0DTE vertical — short-strike delta x width x side — that earns net of crossing, found on one year and confirmed on the next?
 *
 * DATA: R116's cache only (data/cache/r116 — Alpaca 1-minute option TRADE bars 09:45-09:50 ET for every same-day strike within +-3% of
 * spot, both rights, SPY/QQQ/IWM; SIP 1-minute underlying bars for spot at 09:50 and settlement at the last regular close). The same
 * URLs as R116 are requested, so every read is a cache hit; if one is missing it is fetched and cached like R116.
 * PRICING (R116's, unchanged): entry at the last 09:45-09:50 trade of each leg; delta from Black-Scholes implied vol; crossing cost = the
 * per-underlying median mid-minus-cross gap from R25's live record, per spread; commission $0.65/leg; settle at intrinsic.
 * GRID (84 variants): short delta {0.10,0.15,0.20,0.25,0.30,0.35,0.40} (nearest strike within 0.05) x width {1,2,3,5} strikes x side
 * {P, C, PC}. Gates: crossing <= 35% of credit, width <= 3% of spot, credit after crossing > 0. R = P&L / max loss per wing.
 * STATISTIC: per variant, per session the mean R over its wings (SPY/QQQ/IWM x its sides); t over sessions (plain, days ~independent).
 * PROTOCOL: known-answer first (the R116 cell — 0.25 delta, 1 strike, both sides, R116's own tolerances and caps — must reproduce R116's
 * -0.0086R within 0.002R). DISCOVERY 2024-08-19..2025-08-18: carry variants with mean R > 0 and t >= 1.5. HOLDOUT 2025-08-19..2026-08-18,
 * computed only by --holdout, once, for the carried list; PASS: mean R > 0, t >= best-of-k bar (k carried, n = holdout sessions), both
 * holdout halves positive.   --check | --discovery | --holdout
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), CACHE = path.join(__dirname, "data", "cache", "r116"), OUTD = D("r162-discovery.json"), OUTH = D("r162-holdout.json");
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
const FROM = "2024-08-19", TO = "2026-08-18", CHECK_TO = "2026-09-15", SPLIT = "2025-08-18", ANCHORS = ["SPY", "QQQ", "IWM"], SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT"];
const RATE = 0.045, RANGE = 0.03, COMM_PER_LEG = 0.65, MAX_CROSS_COST_PCT = 0.35, MAX_WIDTH_PCT_OF_SPOT = 0.03;
const DELTAS = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40], WIDTHS = [1, 2, 3, 5], SIDES = ["P", "C", "PC"];

let lastCall = 0, fetched = 0; const nap = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {                              // identical to R116's (same cache key = sha1(url))
  const f = path.join(CACHE, crypto.createHash("sha1").update(url).digest("hex") + ".json");
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  for (let i = 0; i < 8; i++) { const wait = lastCall + 340 - Date.now(); if (wait > 0) await nap(wait); lastCall = Date.now();
    try { const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(30000) }); if (r.status === 429 || r.status >= 500) { await nap(2000 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`); const j = await r.json(); fs.writeFileSync(f, JSON.stringify(j)); fetched++; return j; } catch (e) { if (i === 7 || /HTTP 4/.test(e.message)) throw e; await nap(2000 * (i + 1)); } }
  throw new Error("fetch failed");
}
async function bars(base, params) { const out = {}; let token = null; do { const q = new URLSearchParams({ ...params, limit: "10000" }); if (token) q.set("page_token", token); const j = await getJson(`${base}?${q}`); for (const [s, a] of Object.entries(j.bars || {})) (out[s] ||= []).push(...a); token = j.next_page_token || null; } while (token); return out; }
const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const etOf = (iso) => { const p = Object.fromEntries(etFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value])); return { d: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` }; };
function utcOf(day, hm) { for (const off of [4, 5]) { const [h, m] = hm.split(":").map(Number); const t = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), h + off, m)); const e = etOf(t.toISOString()); if (e.d === day && e.hm === hm) return t.toISOString(); } throw new Error("no ET mapping"); }
const ncdf = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
function bs(right, S, K, T, v) { const sT = v * Math.sqrt(T), d1 = (Math.log(S / K) + (RATE + v * v / 2) * T) / sT, d2 = d1 - sT, df = Math.exp(-RATE * T); return right === "C" ? { px: S * ncdf(d1) - K * df * ncdf(d2), delta: ncdf(d1) } : { px: K * df * ncdf(-d2) - S * ncdf(-d1), delta: ncdf(d1) - 1 }; }
function deltaFrom(right, S, K, T, px) { const intrinsic = right === "C" ? Math.max(0, S - K) : Math.max(0, K - S); if (!(px > intrinsic)) return null; let lo = 0.01, hi = 5; if (bs(right, S, K, T, hi).px < px) return null; for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (bs(right, S, K, T, mid).px > px) hi = mid; else lo = mid; } return bs(right, S, K, T, (lo + hi) / 2).delta; }
const occ = (u, d, r, k) => u + d.slice(2).replace(/-/g, "") + r + String(Math.round(k * 1000)).padStart(8, "0");
const live = JSON.parse(fs.readFileSync(D("zero-dte-sleeve.json"), "utf8")), gapBy = {};
{ const g = {}; for (const e of live.entries) if (e.date <= CHECK_TO) for (const w of e.wings) (g[w.sym] ||= []).push(w.creditMid - w.creditCross);
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }, anchorAll = ANCHORS.flatMap((s) => g[s] || []);
  for (const s of SYMS) gapBy[s] = +((g[s] && g[s].length >= 5 ? med(g[s]) : med(anchorAll))).toFixed(4); }

// one session: every priced leg per anchor (same requests as R116's session(), so the cache answers)
async function sessionLegs(day, close) {
  const stock = await bars("https://data.alpaca.markets/v2/stocks/bars", { symbols: SYMS.join(","), timeframe: "1Min", start: utcOf(day, "09:30"), end: utcOf(day, close), feed: "sip", adjustment: "raw" });
  const closeUtc = utcOf(day, close), tYears = (Date.parse(closeUtc) - Date.parse(utcOf(day, "09:50"))) / (365 * 864e5), res = {};
  for (const u of SYMS) {
    const sb = (stock[u] || []).filter((b) => b.t < closeUtc), pre = sb.filter((b) => etOf(b.t).hm <= "09:50"), spot = pre.length ? pre[pre.length - 1].c : null, settle = sb.length ? sb[sb.length - 1].c : null;
    if (!(spot > 0) || !(settle > 0) || etOf(sb[sb.length - 1].t).hm < "12:00") continue;
    const cands = []; for (let k = Math.floor(spot * (1 - RANGE)); k <= Math.ceil(spot) + 1; k++) cands.push(["P", k]); for (let k = Math.floor(spot) - 1; k <= Math.ceil(spot * (1 + RANGE)); k++) cands.push(["C", k]);
    const px = {};
    for (let i = 0; i < cands.length; i += 90) { const chunk = cands.slice(i, i + 90), map = Object.fromEntries(chunk.map(([r, k]) => [occ(u, day, r, k), [r, k]]));
      const ob = await bars("https://data.alpaca.markets/v1beta1/options/bars", { symbols: Object.keys(map).join(","), timeframe: "1Min", start: utcOf(day, "09:45"), end: utcOf(day, "09:50") });
      for (const [s, a] of Object.entries(ob)) { const inWin = a.filter((b) => { const hm = etOf(b.t).hm; return hm >= "09:45" && hm <= "09:50"; }); if (inWin.length) px[s] = { right: map[s][0], strike: map[s][1], px: inWin[inWin.length - 1].c }; } }
    if (!ANCHORS.includes(u)) continue;
    res[u] = { spot, settle, legs: {} };
    for (const right of ["P", "C"]) res[u].legs[right] = Object.values(px).filter((v) => v.right === right).map((v) => ({ ...v, delta: deltaFrom(right, spot, v.strike, tYears, v.px) })).filter((l) => l.delta != null && Math.abs(l.delta) < 1).sort((a, b) => a.strike - b.strike);
  }
  return res;
}
function wing(u, s, right, target, width, tol, capLoss) {
  const side = s.legs[right]; if (!side || side.length < 3) return null; const want = right === "P" ? -target : target;
  let short = null, best = Infinity; for (const l of side) { const d = Math.abs(l.delta - want); if (d < best) { best = d; short = l; } } if (!short || best > tol) return null;
  const i = side.indexOf(short), long = right === "P" ? side.filter((l) => l.strike <= short.strike - width).pop() : side.find((l) => l.strike >= short.strike + width);
  if (!long || (width === 1 && long !== (right === "P" ? side[i - 1] : side[i + 1]))) return null;
  const w = Math.abs(long.strike - short.strike); if (w > s.spot * MAX_WIDTH_PCT_OF_SPOT) return null;
  const credit = short.px - long.px, gap = gapBy[u], cc = credit - gap; if (!(cc > 0) || gap / credit > MAX_CROSS_COST_PCT) return null;
  const maxLoss = (w - cc) * 100; if (!(maxLoss > 0) || (capLoss && maxLoss > capLoss)) return null;
  const cost = right === "P" ? Math.min(Math.max(short.strike - s.settle, 0), w) : Math.min(Math.max(s.settle - short.strike, 0), w), pnl = (cc - cost) * 100 - 2 * COMM_PER_LEG;
  return pnl / maxLoss;
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const tOf = (a) => { if (a.length < 3) return null; const m = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); return sd > 0 ? m / (sd / Math.sqrt(a.length)) : null; };
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const key = (d, w, sd) => `D${d.toFixed(2)}-W${w}-${sd}`;
async function evaluate(days) {                               // per variant: array of session mean R
  const out = {}, known = []; for (const d of DELTAS) for (const w of WIDTHS) for (const sd of SIDES) out[key(d, w, sd)] = [];
  for (let i = 0; i < days.length; i++) { const { day, close } = days[i]; let S; try { S = await sessionLegs(day, close); } catch (e) { continue; }
    { const r = []; for (const u of ANCHORS) if (S[u]) for (const right of ["P", "C"]) { const x = wing(u, S[u], right, 0.25, 1, 0.10, 667 / 4); if (x != null) r.push(x); } if (r.length) known.push(mean(r)); }
    for (const d of DELTAS) for (const w of WIDTHS) for (const sd of SIDES) { const r = []; for (const u of ANCHORS) if (S[u]) for (const right of sd === "PC" ? ["P", "C"] : [sd]) { const x = wing(u, S[u], right, d, w, 0.05, null); if (x != null) r.push(x); } if (r.length) out[key(d, w, sd)].push(mean(r)); }
    if (i % 50 === 0) process.stdout.write(`  R162 ${day} ${i + 1}/${days.length} (fetched ${fetched})\r`); }
  process.stdout.write("\n"); return { out, known };
}
(async () => {
  const mode = ["--check", "--discovery", "--holdout"].find((m) => process.argv.includes(m)) || "--check";
  const cal = await getJson(`https://paper-api.alpaca.markets/v2/calendar?start=${FROM}&end=${CHECK_TO}`), all = cal.map((c) => ({ day: c.date, close: c.close })).filter((d) => d.day >= FROM && d.day <= TO);
  if (mode === "--check") { const { known } = await evaluate(all); const m = +mean(known).toFixed(4), ok = Math.abs(m - (-0.0086)) <= 0.002; console.log(`R162 known-answer: R116 cell over ${known.length} sessions mean ${m}R (R116 published -0.0086R) — ${ok ? "PASS" : "FAIL"} · fetched ${fetched} new files`); writeJsonAtomic(D("r162-check.json"), { asOf: new Date().toISOString(), sessions: known.length, meanR: m, target: -0.0086, pass: ok, fetched }); return; }
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); if (!reg.preregistered.find((x) => x.id === "R162")) { console.error("R162 not registered"); process.exit(2); }
  const chk = fs.existsSync(D("r162-check.json")) ? JSON.parse(fs.readFileSync(D("r162-check.json"), "utf8")) : null; if (!chk || !chk.pass) { console.error("known-answer check has not passed"); process.exit(2); }
  if (mode === "--discovery") {
    if (fs.existsSync(OUTD)) { console.error("discovery sealed"); process.exit(2); }
    const { out } = await evaluate(all.filter((d) => d.day <= SPLIT)); const res = Object.fromEntries(Object.entries(out).map(([k, a]) => [k, { sessions: a.length, meanR: a.length ? +mean(a).toFixed(4) : null, t: tOf(a) == null ? null : +tOf(a).toFixed(3) }]));
    const carried = Object.entries(res).filter(([, v]) => v.meanR > 0 && v.t >= 1.5).map(([k]) => k), k = carried.length, nH = all.filter((d) => d.day > SPLIT).length;
    const rng = mulberry(162), mx = []; for (let i = 0; i < 20000; i++) { let b = -Infinity; for (let j = 0; j < Math.max(1, k); j++) { const s = []; for (let n = 0; n < nH; n++) s.push(rng() * 2 - 1); b = Math.max(b, tOf(s)); } mx.push(b); } mx.sort((a, b) => a - b); const bar = +mx[Math.floor(0.95 * mx.length)].toFixed(3);
    writeJsonAtomic(OUTD, { spec: "r162-discovery-v1", sealedAt: new Date().toISOString(), window: [FROM, SPLIT], results: res, carriedForward: carried, holdoutBar: bar });
    const top = Object.entries(res).sort((a, b) => (b[1].t ?? -9) - (a[1].t ?? -9)); console.log(`R162 DISCOVERY ${FROM}..${SPLIT} (sealed) — carried ${k} of 84 · holdout bar t >= ${bar}`);
    for (const [kk, v] of top.slice(0, 12)) console.log(`  ${kk.padEnd(14)} ${v.sessions} sessions · mean ${v.meanR}R · t ${v.t}${carried.includes(kk) ? " · CARRIED" : ""}`); console.log(`  ... worst: ${top.slice(-3).map(([kk, v]) => kk + " " + v.meanR + "R t" + v.t).join(" | ")}`); return;
  }
  if (mode === "--holdout") {
    if (fs.existsSync(OUTH)) { console.error("holdout already read"); process.exit(2); }
    const disc = JSON.parse(fs.readFileSync(OUTD, "utf8")); const { out } = await evaluate(all.filter((d) => d.day > SPLIT)), res = {};
    for (const k of disc.carriedForward) { const a = out[k], h = Math.floor(a.length / 2), v = { sessions: a.length, meanR: +mean(a).toFixed(4), t: +tOf(a).toFixed(3), firstHalfR: +mean(a.slice(0, h)).toFixed(4), secondHalfR: +mean(a.slice(h)).toFixed(4) }; v.clears = v.meanR > 0 && v.t >= disc.holdoutBar && v.firstHalfR > 0 && v.secondHalfR > 0; res[k] = v; }
    const verdict = Object.values(res).some((v) => v.clears) ? "PASS" : "DID NOT PASS", ctx = Object.fromEntries(Object.entries(out).map(([k, a]) => [k, { meanR: a.length ? +mean(a).toFixed(4) : null, t: tOf(a) == null ? null : +tOf(a).toFixed(3) }]));
    writeJsonAtomic(OUTH, { spec: "r162-holdout-v1", read: true, asOf: new Date().toISOString(), window: [SPLIT, TO], bar: disc.holdoutBar, carried: res, contextAll: ctx, verdict });
    console.log(`R162 HOLDOUT ${SPLIT}..${TO} — ${verdict} (bar t >= ${disc.holdoutBar})`); for (const [k, v] of Object.entries(res)) console.log(`  ${k.padEnd(14)} ${v.sessions} sessions · mean ${v.meanR}R · t ${v.t} · halves ${v.firstHalfR}/${v.secondHalfR}${v.clears ? " · CLEARS" : ""}`);
  }
})().catch((e) => { console.error("R162 FAILED:", e.message); process.exit(1); });
