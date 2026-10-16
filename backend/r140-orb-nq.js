#!/usr/bin/env node
/**
 * R140 — opening-range breakout on NQ (registered 2026-09-21 before any real row was read; operator: "test the opening range breakout on nq").
 * Motivated by the profile of Collective2's ares (entries concentrated 09:30-10:30 ET, same-day exits, 36% winners, wins 2.6x losses).
 *
 * RULE (frozen; six variants = opening-range length L in {5, 15, 30} minutes x stop in {opposite side, range midpoint}):
 *   · Opening range = high/low of the 1-minute NQ bars from 09:30 to 09:30+L ET.
 *   · Signal: the FIRST 1-minute bar after the range whose CLOSE is above the range high (long) or below the range low (short),
 *     with that bar starting before 12:00 ET. One trade per session.
 *   · ENTRY at the OPEN of the NEXT bar (clean timing: the signal bar is complete before anything is decided).
 *   · STOP: opposite side of the range, or the range midpoint. Checked from the entry bar onward; a bar that trades through the stop exits
 *     AT the stop, or at that bar's open if it opened beyond the stop.
 *   · Otherwise EXIT at the close of the last regular-session bar (flat every night, as ares is).
 *   · netPts = points x direction - 0.75 pt round-trip cost (the house MNQ figure).
 * STATISTIC: mean netPts per SESSION (sessions with no signal count 0), t across sessions. Unit: session.
 *
 *   node backend/r140-orb-nq.js --synth <seed>    LEAK TEST: same pipeline on bar-shuffled sessions (bar shapes kept, time order destroyed)
 *   node backend/r140-orb-nq.js                    the registered run on real bars (refuses unless R140 is registered)
 *   node backend/r140-orb-nq.js --ares            weightless: how often ares' real entries coincide with this rule's signals
 */
const fs = require("fs"), path = require("path"); const tb = require("./futures-testbed"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const COST = 0.75, LS = [5, 15, 30], STOPS = ["opposite", "midpoint"], CUTOFF = "12:00";
const args = process.argv.slice(2), SYNTH = args.includes("--synth") ? Number(args[args.indexOf("--synth") + 1]) : null, ARES = args.includes("--ares");
const hmAdd = (hm, m) => { const [h, mm] = hm.split(":").map(Number), t = h * 60 + mm + m; return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0"); };
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length >= 3 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function scramble(days, seed) {   // keep each bar's shape relative to the prior close, shuffle bar order within the session, re-chain prices
  const r = rng(seed), out = {};
  for (const [d, bs] of Object.entries(days)) {
    const shapes = bs.map((b, i) => { const p = i ? bs[i - 1].c : b.o; return { o: b.o - p, h: b.h - p, l: b.l - p, c: b.c - p }; });
    for (let i = shapes.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [shapes[i], shapes[j]] = [shapes[j], shapes[i]]; }
    let prev = bs[0].o; out[d] = bs.map((b, i) => { const s = shapes[i], nb = { ...b, o: prev + s.o, h: prev + s.h, l: prev + s.l, c: prev + s.c }; prev = nb.c; return nb; });
  }
  return out;
}

function runDay(bs, L, stopKind) {
  const end = hmAdd("09:30", L), orb = bs.filter((b) => b.time < end); if (orb.length < L * 0.8) return null;
  const hi = Math.max(...orb.map((b) => b.h)), lo = Math.min(...orb.map((b) => b.l)), mid = (hi + lo) / 2;
  const k0 = bs.findIndex((b) => b.time >= end); if (k0 < 0) return null;
  for (let k = k0; k < bs.length - 1; k++) {
    const b = bs[k]; if (b.time >= CUTOFF) break;
    const dir = b.c > hi ? 1 : b.c < lo ? -1 : 0; if (!dir) continue;
    const e = bs[k + 1], entry = e.o, stop = stopKind === "opposite" ? (dir > 0 ? lo : hi) : mid;
    if ((dir > 0 && entry <= stop) || (dir < 0 && entry >= stop)) return { signalTime: b.time, entryTime: e.time, dir, skipped: "opened beyond the stop" };
    let exit = null, how = "close";
    for (let j = k + 1; j < bs.length; j++) { const x = bs[j];
      if (dir > 0 && x.l <= stop) { exit = x.o <= stop ? x.o : stop; how = "stop"; break; }
      if (dir < 0 && x.h >= stop) { exit = x.o >= stop ? x.o : stop; how = "stop"; break; } }
    if (exit == null) exit = bs[bs.length - 1].c;
    const pts = (exit - entry) * dir;
    return { signalTime: b.time, entryTime: e.time, dir, entry, stop, exit, how, pts, net: pts - COST, risk: Math.abs(entry - stop) };
  }
  return { none: true };
}

function evaluate(days) {
  const sessions = Object.keys(days).sort(), res = {};
  for (const L of LS) for (const S of STOPS) {
    const per = [], trades = [];
    for (const d of sessions) { const r = runDay(days[d], L, S); if (r == null) continue; if (r.net != null) { per.push(r.net); trades.push({ d, ...r }); } else per.push(0); }
    const w = trades.filter((t) => t.net > 0), l = trades.filter((t) => t.net <= 0), gross = trades.length ? trades.map((t) => t.pts) : [];
    res[`L${L}-${S}`] = { sessions: per.length, trades: trades.length, meanNetPtsPerSession: +mean(per).toFixed(3), t: tOf(per) == null ? null : +tOf(per).toFixed(3),
      grossMeanPtsPerTrade: gross.length ? +mean(gross).toFixed(3) : null, grossT: tOf(gross) == null ? null : +tOf(gross).toFixed(3),
      winPct: trades.length ? +(100 * w.length / trades.length).toFixed(1) : null, avgWin: w.length ? +mean(w.map((t) => t.net)).toFixed(1) : null, avgLoss: l.length ? +mean(l.map((t) => t.net)).toFixed(1) : null,
      netDollarsPerMNQ: +(per.reduce((s, x) => s + x, 0) * 2).toFixed(0),
      extraTickMeanPerSession: +mean(per.map((x, i) => x)).toFixed(3) - +(0.5 * trades.length / per.length).toFixed(3),   // one more tick each side = 0.5 pt per trade
      halves: (() => { const h = Math.floor(per.length / 2); return { first: +mean(per.slice(0, h)).toFixed(3), second: +mean(per.slice(h)).toFixed(3) }; })(),
      meanR: trades.length ? +mean(trades.map((t) => t.pts / t.risk)).toFixed(3) : null, _trades: trades };
  }
  return res;
}

(async () => {
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), R = [...(reg.tests || []), ...(reg.preregistered || [])].find((t) => t.id === "R140");
  if (SYNTH == null && !R) { console.error("R140 is not registered — the real run refuses. Register first (backend/register-r140.js)."); process.exit(2); }
  const bars = await tb.loadBars({ root: "NQ", resolution: "1minute", lookbackDays: 400, pages: 14, quiet: true });
  let days = tb.sessionize(bars, { start: "09:30", end: "16:00", minBars: 300 });
  if (SYNTH != null) days = scramble(days, SYNTH);
  const res = evaluate(days), strip = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([x]) => x !== "_trades"))]));
  const first = Object.keys(days).sort()[0], last = Object.keys(days).sort().slice(-1)[0];
  if (ARES) {   // weightless diagnostic: ares' real entries vs this rule's signals
    const parse = (l) => { const o = []; let c = "", q = false; for (const ch of l) { if (ch === '"') { q = !q; continue; } if (ch === "," && !q) { o.push(c); c = ""; continue; } c += ch; } o.push(c); return o; };
    const L_ = fs.readFileSync(path.join(process.env.USERPROFILE, "Downloads", "collective2_strategy_trading_record_for_ares.csv"), "utf8").trim().split(/\r?\n/), H = parse(L_[0]);
    const ares = L_.slice(1).map((l) => Object.fromEntries(parse(l).map((v, i) => [H[i], v]))).map((r) => ({ d: r["Open Time ET"].slice(0, 10), hm: r["Open Time ET"].slice(11, 16), dir: r.Side === "LONG" ? 1 : -1 })).filter((a) => days[a.d]);
    const out = {};
    for (const [k, v] of Object.entries(res)) { const byDay = Object.fromEntries(v._trades.map((t) => [t.d, t])); let sameDay = 0, sameDir = 0, within5 = 0;
      for (const a of ares) { const t = byDay[a.d]; if (!t) continue; sameDay++; if (t.dir === a.dir) { sameDir++; const diff = Math.abs((+a.hm.slice(0, 2) * 60 + +a.hm.slice(3)) - (+t.entryTime.slice(0, 2) * 60 + +t.entryTime.slice(3))); if (diff <= 5) within5++; } }
      out[k] = { aresEntriesInCoverage: ares.length, onASignalDay: sameDay, sameDirection: sameDir, withinFiveMinutesSameDirection: within5 }; }
    // where do ares' entries sit relative to each opening range? (fraction entering beyond the range in the trade direction)
    const pos = {}; for (const L of LS) { let beyond = 0, n = 0; for (const a of ares) { const bs = days[a.d]; const orb = bs.filter((b) => b.time < hmAdd("09:30", L)); if (a.hm < hmAdd("09:30", L)) { (pos[`L${L}`] ||= { insideRangeWindow: 0 }).insideRangeWindow++; continue; } const hi = Math.max(...orb.map((b) => b.h)), lo = Math.min(...orb.map((b) => b.l)); const bar = bs.find((b) => b.time === a.hm); if (!bar) continue; n++; if ((a.dir > 0 && bar.c > hi) || (a.dir < 0 && bar.c < lo)) beyond++; } pos[`L${L}`] = { ...(pos[`L${L}`] || {}), entriesAfterRange: n, beyondRangeInTradeDirection: beyond }; }
    writeJsonAtomic(D("r140-ares-overlap.json"), { spec: "r140-ares-overlap-v1", weight: "NONE — exploratory; ares' own record, our rule", asOf: new Date().toISOString(), coverage: { first, last }, overlap: out, entryPosition: pos });
    console.log(JSON.stringify({ overlap: out, entryPosition: pos }, null, 1)); return;
  }
  const out = { spec: "r140-orb-nq-v1", test: "R140", mode: SYNTH != null ? `LEAK TEST (bar-shuffled, seed ${SYNTH})` : "REGISTERED RUN", asOf: new Date().toISOString(), coverage: { first, last, sessions: Object.keys(days).length }, variants: strip(res) };
  writeJsonAtomic(D(SYNTH != null ? `r140-orb-nq-synth-${SYNTH}.json` : "r140-orb-nq.json"), out);
  console.log(`R140 ${out.mode} — NQ ${first}..${last}, ${out.coverage.sessions} sessions`);
  for (const [k, v] of Object.entries(out.variants)) console.log(`  ${k.padEnd(14)} trades ${String(v.trades).padStart(3)} · net/session ${String(v.meanNetPtsPerSession).padStart(7)} pts (t ${v.t}) · +1 tick ${v.extraTickMeanPerSession.toFixed(3)} · halves ${v.halves.first}/${v.halves.second} · gross/trade ${v.grossMeanPtsPerTrade} · win ${v.winPct}% · avg win ${v.avgWin} / loss ${v.avgLoss} · $${v.netDollarsPerMNQ} per MNQ`);
  if (SYNTH == null) {   // the registered verdict, exactly as written in R140's decisionRule
    const BAR = R.bar.tRequired, ok = Object.entries(out.variants).filter(([, v]) => v.sessions >= 200 && v.meanNetPtsPerSession > 0 && v.t >= BAR && v.extraTickMeanPerSession > 0 && v.halves.first > 0 && v.halves.second > 0);
    out.verdict = ok.length ? `PASS — ${ok.map(([k]) => k).join(", ")} clear(s) every condition; routes to the operator as a candidate forward paper test` : "DID NOT PASS";
    writeJsonAtomic(D("r140-orb-nq.json"), out); console.log("VERDICT:", out.verdict);
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
