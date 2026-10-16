#!/usr/bin/env node
/**
 * R143 — when a stock's own implied volatility is cheap against its own history, does it then move MORE than the options implied?
 * Registered 2026-09-22 (operator: "register the iv percentile test"), prompted by a CNBC piece on NVDA's implied vol near a one-year low.
 *
 * OBSERVATIONS. Ten liquid optionable names, fixed before any data was read and chosen for option liquidity, not for outcome:
 *   NVDA AAPL MSFT AMZN META GOOGL TSLA AMD AVGO MU
 * Every 5th trading session (a fixed grid from the first covered date, so windows never overlap), for each name:
 *   S        = that session's SIP close
 *   IV       = average Black-Scholes implied vol (lib/bs.js, r = q = 0) of the call and the put at the two strikes nearest S, on the
 *              expiry closest to 7 calendar days out, priced at the option bar CLOSE of that session (a traded price, not a quote mid)
 *   RV       = annualised close-to-close realised vol of the NEXT 5 trading sessions
 *   diff     = RV - IV   (positive = the stock moved more than the options implied)
 *   ivRank   = percentile of IV within that name's trailing R observations (warm-up: no rank until R are available)
 * STATISTIC. Per calendar EPISODE (one grid date, all names): mean(diff | cheap) - mean(diff | not cheap). t across episodes that carry
 * at least one observation on each side. Unit: episode. A name-day with no usable option bars is dropped and counted, never imputed.
 * VARIANTS (4): rank window R in {52, 26} observations x "cheap" = bottom {20%, 10%} of that window.
 *
 *   node backend/r143-iv-percentile.js --collect        build data/r143-obs.jsonl (prices only; no statistic is computed)
 *   node backend/r143-iv-percentile.js --synth <seed>   LEAK TEST: ivRank labels shuffled within each name; the gap must vanish
 *   node backend/r143-iv-percentile.js --read           the one registered read (refuses unless R143 is registered)
 */
const fs = require("fs"), path = require("path"); require("dotenv").config({ path: path.join(__dirname, ".env") });
const { impliedVol, realizedVol } = require("./lib/bs.js"); const { fetchBars } = require("./lib/alpaca-bars.js"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), OBS = D("r143-obs.jsonl"), OUT = D("r143-iv-percentile.json");
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
const UNIVERSE = ["NVDA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "TSLA", "AMD", "AVGO", "MU"];
const START = "2024-02-01", END = "2026-09-18", STEP = 5, HORIZON = 5, VARIANTS = [[52, 0.20], [52, 0.10], [26, 0.20], [26, 0.10]];
const args = process.argv.slice(2), SYNTH = args.includes("--synth") ? Number(args[args.indexOf("--synth") + 1]) : null;
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length >= 3 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
const occ = (u, d, cp, k) => `${u}${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}${cp}${String(Math.round(k * 1000)).padStart(8, "0")}`;

async function collect() {
  const done = new Set(fs.existsSync(OBS) ? fs.readFileSync(OBS, "utf8").trim().split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return r.sym + "|" + r.date; }) : []);
  const { bars } = await fetchBars([...UNIVERSE, "SPY"], { start: START, end: END, feed: "sip", quiet: true });
  const cal = bars.SPY.map((b) => b.t.slice(0, 10));
  const grid = cal.filter((_, i) => i % STEP === 0).filter((d) => d >= START);
  const px = Object.fromEntries(Object.entries(bars).map(([k, v]) => [k, new Map(v.map((b) => [b.t.slice(0, 10), b.c]))]));
  console.log(`${grid.length} grid dates x ${UNIVERSE.length} names; ${done.size} already collected`);
  let n = 0, wrote = 0;
  for (const d of grid) {
    const i = cal.indexOf(d); if (i < 0 || i + HORIZON >= cal.length) continue;
    const fwd = cal.slice(i, i + HORIZON + 1);
    for (const sym of UNIVERSE) {
      if (done.has(sym + "|" + d)) continue;
      const S = px[sym].get(d); if (!(S > 0)) continue;
      // expiry: the Friday (or nearest listed date) 5-10 calendar days out; try each until bars come back
      const cands = []; for (let k = 5; k <= 10; k++) { const dt = new Date(d + "T00:00:00Z"); dt.setUTCDate(dt.getUTCDate() + k); cands.push(dt.toISOString().slice(0, 10)); }
      let picked = null, iv = null;
      for (const exp of cands) {
        const steps = [1, 2.5, 5], syms = [];
        for (const st of steps) { const base = Math.round(S / st) * st; for (const off of [-st, 0, st]) for (const cp of ["C", "P"]) syms.push(occ(sym, exp, cp, +(base + off).toFixed(2))); }
        const u = `https://data.alpaca.markets/v1beta1/options/bars?symbols=${[...new Set(syms)].join(",")}&timeframe=1Day&start=${d}&end=${d}&limit=200`;
        let j = null; for (let a = 0; a < 4 && !j; a++) { try { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(45000) }); if (r.status === 429) { await nap(2000 * (a + 1)); continue; } if (!r.ok) break; j = await r.json(); } catch { await nap(1200); } }
        await nap(320);
        const got = Object.entries((j && j.bars) || {}).map(([s, arr]) => ({ s, c: arr[0] && arr[0].c })).filter((x) => x.c > 0);
        if (got.length < 2) continue;
        const T = (Date.parse(exp + "T21:00:00Z") - Date.parse(d + "T21:00:00Z")) / (365 * 864e5); if (!(T > 0)) continue;
        const ivs = [];
        for (const g of got) { const m = g.s.match(/([CP])(\d{8})$/); if (!m) continue; const k = +m[2] / 1000; if (Math.abs(k / S - 1) > 0.03) continue; const v = impliedVol(g.c, S, k, T, m[1]); if (v) ivs.push(v); }
        if (ivs.length >= 2) { picked = { exp, T, iv: mean(ivs), legs: ivs.length }; iv = picked.iv; break; }
      }
      n++;
      if (!picked) { fs.appendFileSync(OBS, JSON.stringify({ sym, date: d, S, drop: "no usable option bars" }) + "\n"); continue; }
      const rv = realizedVol(fwd.map((x) => px[sym].get(x)).filter((x) => x > 0));
      fs.appendFileSync(OBS, JSON.stringify({ sym, date: d, S, expiry: picked.exp, T: +picked.T.toFixed(5), legs: picked.legs, iv: +iv.toFixed(4), rv: rv == null ? null : +rv.toFixed(4), fwdEnd: fwd[fwd.length - 1] }) + "\n");
      wrote++;
    }
    if (grid.indexOf(d) % 10 === 0) console.log(`  ${d}: ${wrote} written of ${n} attempted`);
  }
  console.log(`collect done: ${wrote} observations written (${n} attempted)`);
}

function analyse(rows, shuffleSeed = null) {
  const byName = {}; for (const r of rows) if (r.iv > 0 && r.rv != null) (byName[r.sym] ||= []).push(r);
  for (const s of Object.keys(byName)) byName[s].sort((a, b) => a.date.localeCompare(b.date));
  let rnd = null; if (shuffleSeed != null) { let a = shuffleSeed >>> 0; rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const out = {};
  for (const [R, frac] of VARIANTS) {
    const tagged = [];
    for (const [sym, rs] of Object.entries(byName)) {
      const ranks = rs.map((r, i) => { if (i < R) return null; const win = rs.slice(i - R, i).map((x) => x.iv); return win.filter((v) => v < r.iv).length / win.length; });
      const idx = ranks.map((v, i) => ({ v, i })).filter((x) => x.v != null);
      let labels = idx.map((x) => x.v <= frac);
      if (rnd) { for (let i = labels.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [labels[i], labels[j]] = [labels[j], labels[i]]; } }   // leak test: cheap/not labels shuffled within the name
      idx.forEach((x, n2) => tagged.push({ sym, date: rs[x.i].date, diff: rs[x.i].rv - rs[x.i].iv, cheap: labels[n2] }));
    }
    const byDate = {}; for (const t of tagged) (byDate[t.date] ||= []).push(t);
    const D_ = [], cheapN = [], restN = [];
    for (const d of Object.keys(byDate).sort()) { const c = byDate[d].filter((x) => x.cheap), r = byDate[d].filter((x) => !x.cheap); if (!c.length || !r.length) continue; D_.push(mean(c.map((x) => x.diff)) - mean(r.map((x) => x.diff))); cheapN.push(c.length); restN.push(r.length); }
    const h = Math.floor(D_.length / 2);
    out[`R${R}-bottom${Math.round(frac * 100)}`] = { episodes: D_.length, cheapObs: cheapN.reduce((s, x) => s + x, 0), otherObs: restN.reduce((s, x) => s + x, 0),
      meanGapVolPts: D_.length ? +(100 * mean(D_)).toFixed(2) : null, t: tOf(D_) == null ? null : +tOf(D_).toFixed(3),
      halves: D_.length ? { first: +(100 * mean(D_.slice(0, h))).toFixed(2), second: +(100 * mean(D_.slice(h))).toFixed(2) } : null };
  }
  return out;
}

(async () => {
  if (args.includes("--collect")) return collect();
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), R = [...(reg.tests || []), ...(reg.preregistered || [])].find((t) => t.id === "R143");
  if (!R) { console.error("R143 is not registered — refusing."); process.exit(2); }
  if (!fs.existsSync(OBS)) { console.error("no observations yet — run --collect"); process.exit(2); }
  const rows = fs.readFileSync(OBS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const usable = rows.filter((r) => r.iv > 0 && r.rv != null), dropped = rows.length - usable.length;
  const res = analyse(rows, SYNTH);
  const out = { spec: "r143-iv-percentile-v1", test: "R143", mode: SYNTH != null ? `LEAK TEST (labels shuffled, seed ${SYNTH})` : args.includes("--read") ? "REGISTERED READ" : "preview (weightless)",
    asOf: new Date().toISOString(), observations: usable.length, droppedNoOptionBars: dropped, names: [...new Set(usable.map((r) => r.sym))].length, window: [START, END], variants: res };
  if (args.includes("--read") && SYNTH == null) {
    const BAR = R.bar.tRequired, MIN = R.bar.minEpisodes;
    const ok = Object.entries(res).filter(([, v]) => v.episodes >= MIN && v.meanGapVolPts > 0 && v.t >= BAR && v.halves.first > 0 && v.halves.second > 0);
    out.read = true; out.verdict = ok.length ? `PASS — ${ok.map(([k]) => k).join(", ")}: cheap implied vol is followed by realised moves larger than implied` : "DID NOT PASS";
  }
  writeJsonAtomic(SYNTH != null ? D(`r143-synth-${SYNTH}.json`) : OUT, out);
  console.log(`R143 ${out.mode} — ${out.observations} observations, ${out.names} names, ${dropped} dropped`);
  for (const [k, v] of Object.entries(res)) console.log(`  ${k.padEnd(14)} episodes ${String(v.episodes).padStart(3)} · cheap obs ${v.cheapObs} vs ${v.otherObs} · gap ${v.meanGapVolPts} vol pts (t ${v.t}) · halves ${v.halves ? v.halves.first + "/" + v.halves.second : "-"}`);
  if (out.verdict) console.log("VERDICT:", out.verdict);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
