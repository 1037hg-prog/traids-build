#!/usr/bin/env node
"use strict";
/**
 * Library emitter — R158 Payne "IPO reversal" price rule, members HOLD-252 and HOLD-126. READ-ONLY.
 *
 * Source: backend/r158-ipo-reversal.js is NOT require()-safe (its IIFE runs 12 scramble passes and writes r158-controls.json on load)
 * and is never executed here. Copied VERBATIM: constants and cleanBars/TEST_SYM (lines 25-29), run() (31-46), mean/nwT/summariseD
 * (47-55), and the real-bars path of pass() incl. addDays/feed (72-86). The sealed statistic is already built on a DAILY series
 * (addDays: entry day open->close minus half cost, close->close in between, exit day prior close->exit price minus half cost; equal weight
 * across open positions per day = sum/cnt), so the library series IS the sealed script's own days map, member by member.
 *
 * Reproduction: summariseD() verbatim — the daily series summed per month over 2017-01..2026-09 (117 months, flat months = 0), NW lag 1 t.
 */
const fs = require("fs"), path = require("path");
const { fetchBars } = require("../../lib/alpaca-bars.js");
const { writeEntry } = require("../lib-entry.js");
const D = (f) => path.join(__dirname, "..", "..", "data", f);

// ── verbatim lines 25-29 ─────────────────────────────────────────────────────────────────────────────────────────────────
const START = "2016-01-01", END = "2026-09-22T21:00:00Z", COST = 0.0030, SEEDS = 10, BASE = 40, RANGE = 1.35, DOWN = 0.5, AGE = 252;
const MIN_PX = 2, TEST_SYM = /^Z[A-Z]ZZT$|^ZVV$|^ZXIET$|^ZJZZT$|^ZBZX$|^ZTEST/;   // amended 2026-09-23 pre-read (data hygiene)
const cleanBars = (b) => { for (let k = 1; k < b.length; k++) { const r = b[k].c / b[k - 1].c - 1, g = b[k].o / b[k - 1].c - 1; if (r > 3 || g > 3 || r < -0.9 || g < -0.9) return false; } return true; };
const MEMBERS = ["HOLD-126", "HOLD-252"], HOLDS = { "HOLD-126": 126, "HOLD-252": 252 };
const MONTHS = (() => { const o = []; for (let y = 2017; y <= 2026; y++) for (let m = 1; m <= 12; m++) { const k = y + "-" + String(m).padStart(2, "0"); if (k <= "2026-09") o.push(k); } return o; })();

// ── verbatim lines 31-46 ─────────────────────────────────────────────────────────────────────────────────────────────────
function run(b, sym, member) {
  const hold = HOLDS[member], c = b.map((x) => x.c), out = []; let peak = -Infinity, pos = null, pend = null, exitPend = false;
  for (let i = 0; i < b.length; i++) {
    if (exitPend && pos) { out.push({ member, sym, dir: 1, entryIdx: pos.i, exitIdx: i, entryT: b[pos.i].t, entry: pos.px, exit: b[i].o, why: "stop" }); pos = null; exitPend = false; }
    if (pend && !pos) { pos = { i, px: b[i].o, floor: pend.floor }; } pend = null;
    if (pos && i - pos.i >= hold) { out.push({ member, sym, dir: 1, entryIdx: pos.i, exitIdx: i, entryT: b[pos.i].t, entry: pos.px, exit: c[i], why: "time" }); pos = null; }
    if (pos && c[i] < pos.floor && i + 1 < b.length) exitPend = true;
    if (!pos && !exitPend && i >= AGE && i >= BASE && i + 1 < b.length) {
      let bmax = -Infinity, bmin = Infinity; for (let k = i - BASE; k < i; k++) { bmax = Math.max(bmax, c[k]); bmin = Math.min(bmin, c[k]); }
      if (bmax / bmin <= RANGE && bmax <= DOWN * peak && c[i] > bmax && c[i] >= MIN_PX) pend = { floor: bmin };
    }
    peak = Math.max(peak, c[i]);            // the post-IPO high uses closes up to and including day i (known at its close)
  }
  if (pos) out.push({ member, sym, dir: 1, entryIdx: pos.i, exitIdx: b.length - 1, entryT: b[pos.i].t, entry: pos.px, exit: c[b.length - 1], why: "marked at end" });
  return out;
}
// ── verbatim lines 47-55 ─────────────────────────────────────────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return v > 0 ? m / Math.sqrt(v / n) : null; }
function summariseD(r, which = "days") { const res = {}; for (const m of MEMBERS) {
  const tr = r.trades.filter((x) => x.member === m && (which === "days" || x.peekOk)), mm = new Map(MONTHS.map((k) => [k, 0])), exp = new Set();
  for (const [d, [sum, cnt]] of (r[which][m] || new Map())) { const k = d.slice(0, 7); if (!mm.has(k)) continue; mm.set(k, mm.get(k) + sum / cnt); exp.add(k); }
  const s = MONTHS.map((k) => mm.get(k)), h = Math.floor(s.length / 2), t = nwT(s);
  res[m] = { trades: tr.length, names: new Set(tr.map((x) => x.sym)).size, months: exp.size, meanNetPctPerMonth: +(100 * mean(s)).toFixed(4), tNW: t == null ? null : +t.toFixed(3), firstHalfPct: +(100 * mean(s.slice(0, h))).toFixed(4), secondHalfPct: +(100 * mean(s.slice(h))).toFixed(4),
    meanNetPctPerTrade: tr.length ? +(100 * mean(tr.map((x) => x.net))).toFixed(3) : null, medianNetPctPerTrade: tr.length ? +(100 * tr.map((x) => x.net).sort((a, b) => a - b)[Math.floor(tr.length / 2)]).toFixed(3) : null,
    winRatePct: tr.length ? +(100 * tr.filter((x) => x.net > 0).length / tr.length).toFixed(1) : null, doublersPct: tr.length ? +(100 * tr.filter((x) => x.net >= 1).length / tr.length).toFixed(1) : null }; } return res; }

// ── verbatim lines 72-86 (pass), real bars only (the identity transform); scramble transforms not run ─────────────────────────
async function pass(transforms) {
  const U = JSON.parse(fs.readFileSync(D("ipo-universe.json"), "utf8")).names, ipo = new Map(U.map((x) => [x.symbol, x.ipoDate])), nameOf = new Map(U.map((x) => [x.symbol, x.name])), syms = U.map((x) => x.symbol);
  const res = transforms.map(() => ({ trades: [], priced: 0, skipped: 0, days: {}, peekDays: {} }));
  const addDays = (map, x, bars, cost) => { const m = (map[x.member] ||= new Map()), put = (d, v) => { const k = bars[d].t.slice(0, 10), e = m.get(k) || [0, 0]; e[0] += v; e[1]++; m.set(k, e); };
    const ei = x.entryIdx, xi = x.exitIdx; if (xi === ei) { put(ei, x.exit / x.entry - 1 - cost); return; }
    put(ei, bars[ei].c / x.entry - 1 - cost / 2); for (let d = ei + 1; d < xi; d++) put(d, bars[d].c / bars[d - 1].c - 1); put(xi, x.exit / bars[xi - 1].c - 1 - cost / 2); };
  const feed = (r, tr, bars) => { for (const x of tr) { x.net = x.exit / x.entry - 1 - COST; x.peekOk = x.net > 0; r.trades.push(x); addDays(r.days, x, bars, COST); if (x.peekOk) addDays(r.peekDays, x, bars, COST); } };
  for (let i = 0; i < syms.length; i += 50) {
    const { bars } = await fetchBars(syms.slice(i, i + 50), { start: START, end: END, feed: "sip", requireAll: false, quiet: true });
    for (const [s, b0] of Object.entries(bars)) { const lag = (Date.parse(b0[0]?.t) - Date.parse(ipo.get(s))) / 864e5; if (TEST_SYM.test(s) || /test/i.test(nameOf.get(s) || "") || !(b0.length > AGE + BASE) || !(lag >= -3 && lag <= 10) || !cleanBars(b0)) { res.forEach((r) => r.skipped++); continue; }
      transforms.forEach((tf, k) => { const b = tf(b0, s), r = res[k]; r.priced++; for (const m of MEMBERS) feed(r, run(b, s, m), b); }); }
    process.stdout.write(`  R158 emit ${Math.min(i + 50, syms.length)}/${syms.length}\r`);
  }
  process.stdout.write("\n"); return res;
}

(async () => {
  const [real] = await pass([(b) => b]), v = summariseD(real), sealedAll = JSON.parse(fs.readFileSync(D("r158-ipo-reversal.json"), "utf8")), sealed = sealedAll.members;
  console.log(`priced ${real.priced} (sealed ${sealedAll.priced}), skipped ${real.skipped}`);
  const WIN = ["2017-01-03", "2026-09-22"];
  for (const [m, id] of [["HOLD-252", "R158-HOLD252"], ["HOLD-126", "R158-HOLD126"]]) {
    const e = v[m], s = sealed[m], all = [...(real.days[m] || new Map()).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, [sum, cnt]]) => ({ d, r: sum / cnt }));
    const series = all.filter((x) => x.d >= WIN[0] && x.d <= WIN[1]), outside = all.length - series.length;
    const match = e.tNW != null && Math.abs(e.tNW - s.tNW) <= 0.02;
    writeEntry({
      id, name: `Payne IPO reversal (price rule), ${m}`, registryId: "R158",
      script: "backend/r158-ipo-reversal.js", emitter: "backend/ensemble/emit/r158.js", unit: "daily", net: true,
      costModel: "0.30% round trip (small/mid-cap IPOs): 0.15% on the entry day, 0.15% on the exit day, as sealed",
      window: WIN, calendar: "us-equity", series,
      reproduction: { statistic: "Newey-West lag-1 t of the daily series summed per month, 2017-01..2026-09 (117 months)", sealed: s.tNW, emitted: e.tNW, tolerance: 0.02, match },
      construction: "The sealed script's own daily book (addDays): each long trade entered at the open after a base breakout is marked entry-open->close, "
        + "close->close, and prior-close->exit price (next open on a stop, the close on the time exit), with half the round trip on each end; the day's "
        + "return is the equal-weight mean over all positions open that day.",
      notes: `Trades ${e.trades} (sealed ${s.trades}), names ${e.names} (sealed ${s.names}), months with exposure ${e.months} (sealed ${s.months}), mean net %/month ${e.meanNetPctPerMonth} (sealed ${s.meanNetPctPerMonth}); priced ${real.priced} symbols (sealed ${sealedAll.priced}). `
        + `${outside} day(s) fell outside the statistic's 2017-01..2026-09 months and are not emitted. Positions open at the data end are marked at the last close ("marked at end") as sealed. `
        + "Bars re-fetched from Alpaca SIP (adjustment=all, delisted names kept) on emit day. adjustment=all is a total-return series restated by every dividend declared since the 2026-09-23 read, which can flip a marginal base/breakout test"
        + (e.trades !== s.trades || e.names !== s.names ? ` — COUNT DRIFT: ${e.trades - s.trades >= 0 ? "+" : ""}${e.trades - s.trades} trade(s), ${e.names - s.names >= 0 ? "+" : ""}${e.names - s.names} name(s) vs the seal (not traced trade-by-trade: the seal persisted no trade list); t moves by ${(e.tNW - s.tNW).toFixed(3)}.` : "."),
    });
  }
})().catch((e) => { console.error("R158 emit FAILED:", e.stack); process.exit(1); });
