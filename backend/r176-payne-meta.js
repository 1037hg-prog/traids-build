#!/usr/bin/env node
/**
 * R176 — PAYNE META-FILTER (registered 2026-09-24 before this file ran; rule frozen in data/test-registry.json).
 * Can entry-time price features rank his trades so that taking only the predicted top half beats taking them all?
 * Samples: (1) his published trades (data/payne-model-portfolio.json, prices from data/payne-audit-cache split bars);
 *          (2) the R175 replica rule's trades (re-generated here with the same frozen rule on data/anomaly-cache-v2).
 * Walk-forward by calendar year; train only on trades whose exit precedes the test year. One read; seals only if the controls pass.
 * PIPELINE FIX 2026-09-24 (before any seal; the first run's controls FAILED and nothing was sealed): tied scores were ordered by row
 * insertion, and replica rows are inserted in EXIT order — fast take-profit winners first — so ties leaked the outcome into the top half
 * (a constant feature showed a 30% "gap" at t 13). Rows are now sorted by entry date + a seeded random key, and every sort breaks ties by
 * that random key. Rule, features, model settings and bar unchanged.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js"); const LRN = require("./lib/gbm.js");
const D = (f) => path.join(__dirname, "data", f);
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R176) { console.error("R176 already sealed — refusing"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), ENTRY = reg.preregistered.find((t) => t.id === "R176"); const BAR = ENTRY.bar.tRequired;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length >= 3 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// features from a close series cl[] (index i = entry day; uses closes up to i-1 only)
function feats(cl, i, spy) {
  if (i < 261) return null; const c = (k) => cl[k]; for (const k of [i - 1, i - 6, i - 21, i - 61, i - 253]) if (!(c(k) > 0)) return null;
  let s50 = 0, s200 = 0, mx = 0; for (let k = i - 200; k < i; k++) { if (!(c(k) > 0)) return null; s200 += c(k); if (k >= i - 50) s50 += c(k); }
  for (let k = i - 252; k < i; k++) if (c(k) > mx) mx = c(k);
  let g = 0, l = 0, up = 0, dn = 0; for (let k = i - 14; k < i; k++) { const d = c(k) - c(k - 1); if (d > 0) g += d; else l -= d; }
  for (let k = i - 10; k < i; k++) { const r = c(k) / c(k - 1) - 1; if (r >= 0.05) up = 1; if (r <= -0.05) dn = 1; }
  const rets = []; for (let k = i - 20; k < i; k++) rets.push(Math.log(c(k) / c(k - 1)));
  return [c(i - 1) / c(i - 6) - 1, c(i - 1) / c(i - 21) - 1, c(i - 1) / c(i - 61) - 1, c(i - 1) / c(i - 253) - 1, c(i - 1) / mx - 1, c(i - 1) > s50 / 50 ? 1 : 0, c(i - 1) > s200 / 200 ? 1 : 0,
    l === 0 ? 100 : 100 - 100 / (1 + g / l), up, dn, sd(rets) * Math.sqrt(252), spy.above200, spy.r20];
}
function evaluate(rows, years, model, shuffleSeed = null, peek = false) {
  const X = rows.map((r) => r.x), y = rows.map((r) => r.ex); const ys = shuffleSeed == null ? y : (() => { const rng = mulberry(shuffleSeed), out = y.slice(), by = {}; rows.forEach((r, i) => (by[r.mo] = by[r.mo] || []).push(i)); for (const ix of Object.values(by)) { const v = ix.map((i) => y[i]); for (let a = v.length - 1; a > 0; a--) { const b = Math.floor(rng() * (a + 1)); [v[a], v[b]] = [v[b], v[a]]; } ix.forEach((i, k) => (out[i] = v[k])); } return out; })();
  const pred = new Array(rows.length).fill(NaN), tie = (() => { const rng = mulberry(9176); return rows.map(() => rng()); })();
  for (const Y of years) {
    const tr = rows.map((r, i) => i).filter((i) => rows[i].exit < `${Y}-01-01`), te = rows.map((r, i) => i).filter((i) => rows[i].entry.startsWith(String(Y)));
    if (tr.length < 60 || !te.length) continue;
    if (peek) { te.forEach((i) => (pred[i] = ys[i])); continue; }
    const m = model === "ridge" ? LRN.ridgeFit(X, ys, tr, { lambda: 50 }) : LRN.gbmFit(X, ys, tr, { rounds: 80, lr: 0.05, depth: 2 });
    te.forEach((i) => (pred[i] = model === "ridge" ? LRN.ridgePredict(m, X[i]) : LRN.gbmPredict(m, X[i])));
  }
  const by = {}; rows.forEach((r, i) => { if (Number.isFinite(pred[i])) (by[r.mo] = by[r.mo] || []).push({ p: pred[i], k: tie[i], ex: ys[i], win: r.ret > 0 }); });
  const gaps = [], top = [], all = [];
  for (const a of Object.values(by)) { if (a.length < 4) continue; a.sort((u, v) => v.p - u.p || u.k - v.k); const h = Math.floor(a.length / 2); gaps.push(mean(a.slice(0, h).map((x) => x.ex)) - mean(a.slice(a.length - h).map((x) => x.ex))); top.push(...a.slice(0, h)); all.push(...a); }
  return { months: gaps.length, meanGapPct: gaps.length ? +(100 * mean(gaps)).toFixed(2) : null, t: gaps.length >= 3 ? +tOf(gaps).toFixed(3) : null,
    topHalf: top.length ? { trades: top.length, meanExcessPct: +(100 * mean(top.map((x) => x.ex))).toFixed(2), winPct: +(100 * top.filter((x) => x.win).length / top.length).toFixed(1) } : null,
    allScored: all.length ? { trades: all.length, meanExcessPct: +(100 * mean(all.map((x) => x.ex))).toFixed(2), winPct: +(100 * all.filter((x) => x.win).length / all.length).toFixed(1) } : null };
}

(async () => {
  const { bars } = await fetchBars(["SPY"], { start: "2016-01-01", end: "2026-09-22T21:00:00Z", feed: "sip", adjustment: "split", quiet: true });
  const spyB = (bars.SPY || []).map((b) => ({ d: b.t.slice(0, 10), c: b.c })), spyIdx = new Map(spyB.map((b, i) => [b.d, i]));
  const spyAt = (d) => { let i = spyB.findIndex((b) => b.d >= d); if (i < 201) return null; const c = spyB.map((b) => b.c); let s = 0; for (let k = i - 200; k < i; k++) s += c[k]; return { above200: c[i - 1] > s / 200 ? 1 : 0, r20: c[i - 1] / c[i - 21] - 1, i }; };
  const spyRet = (d0, d1) => { const a = spyB.find((b) => b.d >= d0), b = spyB.find((b) => b.d >= d1) || spyB[spyB.length - 1]; return a && b ? b.c / a.c - 1 : null; };

  // (1) his trades
  const P = JSON.parse(fs.readFileSync(D("payne-model-portfolio.json"), "utf8")), cache = (s) => { try { return JSON.parse(fs.readFileSync(D(`payne-audit-cache/${s.replace(/[^A-Z0-9.]/gi, "_")}-split.json`), "utf8")); } catch { return null; } };
  const his = [];
  for (const t of [...P.closed.map((r) => ({ ...r, open: false })), ...P.open.map((o) => ({ ticker: o.markAs || o.ticker, entryDate: o.entryDate, entryPrice: o.entryPrice, exitDate: null, open: true }))]) {
    const b = cache(t.ticker); if (!b) continue; const i = b.findIndex((x) => x.d >= t.entryDate); if (i < 0) continue; const sp = spyAt(t.entryDate); if (!sp) continue;
    const f = feats(b.map((x) => x.c), i, sp); if (!f) continue;
    const exitD = t.exitDate || b[b.length - 1].d, ret = t.open ? b[b.length - 1].c / b[i].c - 1 : t.exitPrice / t.entryPrice - 1, sr = spyRet(t.entryDate, exitD); if (sr == null) continue;
    his.push({ x: f, ex: ret - sr, ret, entry: t.entryDate, exit: t.open ? "9999-12-31" : exitD, mo: t.entryDate.slice(0, 7), open: t.open });
  }
  // (2) replica trades — the frozen R175 rule, re-generated (same code path as r175-payne-replica.js)
  const PANEL = D("anomaly-cache-v2"), meta = JSON.parse(fs.readFileSync(path.join(PANEL, "meta.json"), "utf8")), DATES = meta.dates, N = meta.symbols.length, T = DATES.length;
  const rdp = (f) => { const b = fs.readFileSync(path.join(PANEL, f)); return new Float32Array(b.buffer, b.byteOffset, N * T); };
  const C = rdp("close.f32"), O = rdp("open.f32"), V = rdp("vol.f32"), c = (s, t) => C[s * T + t], o = (s, t) => O[s * T + t], v = (s, t) => V[s * T + t];
  const wk = (d) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
  const t0 = DATES.findIndex((d) => d >= "2017-01-03"), tEnd = DATES.findIndex((d) => d > "2026-08-31") - 1;
  const rep = []; const held = new Map();
  const passes = (s, t) => { let s50 = 0, s200 = 0, mx = 0; for (let k = t - 199; k <= t; k++) { const x = c(s, k); if (!(x > 0)) return false; s200 += x; if (k > t - 50) s50 += x; } const cl = c(s, t); if (!(cl > s50 / 50 && cl > s200 / 200)) return false; for (let k = t - 251; k <= t; k++) if (c(s, k) > mx) mx = c(s, k); const dd = cl / mx - 1; if (!(dd <= -0.05 && dd >= -0.2)) return false; let pop = false; for (let k = t - 9; k <= t; k++) if (c(s, k) / c(s, k - 1) - 1 >= 0.05) pop = true; if (!pop) return false; let g = 0, l = 0; for (let k = t - 13; k <= t; k++) { const d = c(s, k) - c(s, k - 1); if (d > 0) g += d; else l -= d; } const rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l); return rsi >= 45 && rsi <= 70; };
  for (let t = t0; t <= tEnd; t++) {
    for (const [s, p] of [...held]) { const cl = c(s, t); if (!(cl > 0) || cl >= p.px * 1.15 || Date.parse(DATES[t]) - Date.parse(DATES[p.ti]) >= 365 * 864e5) { const xt = cl > 0 ? Math.min(t + 1, T - 1) : t; const px = cl > 0 ? (o(s, xt) > 0 ? o(s, xt) : cl) : p.last; rep.push({ s, ti: p.ti, xt, ret: px / p.px - 1 }); held.delete(s); } else p.last = cl; }
    if (!(t > 0 && wk(DATES[t]) !== wk(DATES[t - 1]))) continue;
    const ts = t - 1, U = [];
    for (let s = 0; s < N; s++) { if (!(c(s, ts) > 0) || !(c(s, ts - 259) > 0)) continue; const dv = []; for (let k = ts - 19; k <= ts; k++) { const x = c(s, k) * v(s, k); if (Number.isFinite(x)) dv.push(x); } if (dv.length < 15) continue; dv.sort((a, b) => a - b); if (!(dv[dv.length >> 1] >= 25e6)) continue; const a = c(s, ts - 21), b = c(s, ts - 252); if (a > 0 && b > 0) U.push({ s, mom: a / b - 1 }); }
    if (!U.length) continue; const srt = U.map((x) => x.mom).sort((a, b) => a - b), cut = srt[Math.floor(0.7 * srt.length)];
    let n = 0; for (const x of U.filter((x) => x.mom >= cut && passes(x.s, ts)).sort((a, b) => b.mom - a.mom)) { if (n >= 3 || held.size >= 40) break; if (held.has(x.s) || !(o(x.s, t) > 0)) continue; held.set(x.s, { ti: t, px: o(x.s, t), last: c(x.s, t) }); n++; }
  }
  const repRows = [];
  for (const r of rep) { const d = DATES[r.ti], sp = spyAt(d); if (!sp) continue; const cl = []; for (let k = 0; k < T; k++) cl.push(c(r.s, k)); const f = feats(cl, r.ti, sp); if (!f) continue; const sr = spyRet(d, DATES[r.xt]); if (sr == null) continue; repRows.push({ x: f, ex: r.ret - sr, ret: r.ret, entry: d, exit: DATES[r.xt], mo: d.slice(0, 7) }); }

  const order = (a) => { const rng = mulberry(4176); a.forEach((r) => (r._k = rng())); a.sort((u, v) => (u.entry < v.entry ? -1 : u.entry > v.entry ? 1 : u._k - v._k)); };
  order(his); order(repRows);
  const hisYears = [2022, 2023, 2024, 2025, 2026], repYears = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
  const res = {}; for (const [k, rows, yrs] of [["his", his, hisYears], ["replica", repRows, repYears]]) for (const m of ["ridge", "gbm"]) res[`${k}.${m}`] = evaluate(rows, yrs, m);
  const leak = {}; for (const [k, rows, yrs] of [["his", his, hisYears], ["replica", repRows, repYears]]) for (const m of ["ridge", "gbm"]) leak[`${k}.${m}`] = evaluate(rows, yrs, m, 176).t;
  const peek = evaluate(his, hisYears, "ridge", null, true);
  const leakPass = Object.values(leak).every((t) => t == null || Math.abs(t) < 2), peekPass = peek.t != null && peek.t >= BAR;
  const primary = res["his.ridge"], best = Object.entries(res).filter(([, r]) => r.t != null).sort((a, b) => b[1].t - a[1].t)[0];
  const verdict = !leakPass || !peekPass ? `CONTROLS FAILED — leak ${leakPass ? "ok" : "FAIL " + JSON.stringify(leak)}, peek t ${peek.t}` : best && best[1].t >= BAR && best[1].meanGapPct > 0 ? `PASS — ${best[0]} top-minus-bottom ${best[1].meanGapPct}%/trade, t ${best[1].t} >= ${BAR}` : `DID NOT PASS — primary (ridge on his trades) gap ${primary.meanGapPct}%/trade t ${primary.t}; best ${best ? best[0] + " t " + best[1].t : "n/a"} vs bar ${BAR}`;
  const out = { spec: "r176-payne-meta-v1", test: "R176", ranAt: new Date().toISOString(), samples: { his: his.length, hisOpen: his.filter((r) => r.open).length, replica: repRows.length }, results: res, controls: { leakShuffle: leak, leakPass, peek, peekPass }, bar: BAR, verdict };
  writeJsonAtomic(D("r176-payne-meta.json"), out); console.log(JSON.stringify(out, null, 1));
  if (!leakPass || !peekPass) { console.error("controls failed — NOT sealed"); process.exit(3); }
  seals.tests.R176 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "entry months", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  ENTRY.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R176", verdict }) + "\n");
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
