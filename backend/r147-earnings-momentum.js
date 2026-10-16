#!/usr/bin/env node
/**
 * R147 — EARNINGS MOMENTUM (Charles Payne, "Unstoppable Prosperity", 2019, pp. 61-63). 2026-09-23, operator: "register the
 * earnings momentum test".
 *
 * THE BOOK'S RULE. "A string of earnings that beat the Street by a greater and greater margin ... in each successive quarter,
 * not only are results better than Wall Street consensus, but better by wider margins than the prior quarter and year ago
 * comparable period." His worked example (MasTec, 3 Nov 2016) cites "four straight quarters of earnings that beat the Street".
 *
 * TWO READINGS, because the book's own example fails the strict one: MTZ's Nov-2016 beat (+$0.12 in the book, +$0.11 in Alpha
 * Vantage) is SMALLER than the prior quarter's (+$0.13). So:
 *   STRICT  4 straight beats, and this beat (actual - estimate, in dollars per share) is larger than BOTH the prior quarter's
 *           beat and the year-ago quarter's beat.
 *   LOOSE   4 straight beats, and this beat is larger than the year-ago quarter's beat (the MTZ example passes this one).
 * Beats are compared in dollars, as the book's table does; percent surprises explode near a zero estimate.
 *
 * TRADE. Long at the first regular-session OPEN after the report is public (pre-market report: that day's open; post-market or
 * unstated: the next session's open). Exit at the CLOSE of the H-th session counting the entry session as 1, H in {20, 60}.
 * Measured against SPY over the same open-to-close window, charged 0.10% round trip. Four variants: {STRICT, LOOSE} x {20, 60}.
 *
 * STATISTIC. Unit = earnings SEASON (calendar quarter of the report date). Per season: mean net excess of the qualifying reports
 * MINUS mean net excess of every other report in the same 100-name universe that season. Headline t is Newey-West (lag 1),
 * because a 60-session hold overlaps the next season. Sign check: the qualifiers' own net excess over SPY must also be positive.
 *
 * MODES
 *   node backend/r147-earnings-momentum.js            coverage + known-answer selftest + both controls (never the real number)
 *   node backend/r147-earnings-momentum.js --read     the ONE real read; refuses until coverage is complete and controls pass
 *   node backend/r147-earnings-momentum.js --selftest the pure checks only (known answer + scramble determinism); no data, no write
 *
 * 2026-10-05 HEALTH SWEEP (FT-6) — THE "FIXED-SEED" LEAK TEST WAS NOT REPRODUCIBLE. It printed READY on 09-28, 09-30 and 10-01 and
 * NOT READY on 09-29 and 10-02 with the same seeds, the same 100 earnings files and the same bar window: the seed-2 STRICT-20 t went
 * -0.737, 1.034, -0.275, 0.104, -3.515 night to night. Cause: ONE mulberry stream per seed was consumed across symbols in
 * Object.keys(bars) order, and that order is the order Alpaca's paginated multi-symbol responses first mention each symbol — it
 * changes between two fetches minutes apart (probe 2026-10-05: same bar counts, different key order from position 15, around the
 * short-history names SNDK / SPCX). Every symbol after the first reordering got a different shuffle, so "seeds 1 and 2" named a
 * different scramble every night. Fix: each symbol gets its OWN stream, mulberry32(fnv1a(`${seed}|${SYMBOL}`)), and symbols are
 * scrambled in sorted order — the scramble of a symbol now depends only on (seed, symbol, its own bars), not on fetch order or on
 * any other symbol's bar count. The seeds (1, 2), the shuffle, the variants and the |t_NW| < 2 requirement are unchanged. Each run
 * also records an input fingerprint (bar-count shape + a scale-free hash of the day-pair ratios the scramble uses), so a future
 * change in the control's numbers can be told apart: same fingerprint => same numbers, by construction.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f), DIR = D("r147-earnings");
const COST = 0.0010, HOLDS = [20, 60], CONDS = ["STRICT", "LOOSE"], START = "2016-01-04", END = "2026-09-22", FIRST_ENTRY = "2016-02-01", MIN_SEASONS = 30;
const READ = process.argv.includes("--read"), OUT = D("r147-earnings-momentum.json"), CTRL = D("r147-controls.json");

// ── classification (pure; the selftest pins it) ─────────────────────────────────────────────────────────────────────────
const cents = (x) => Math.round(x * 100) / 100;
function parseQuarters(raw) {
  return (raw || []).map((e) => ({ fq: e.fiscalDateEnding, date: e.reportedDate, time: e.reportTime, est: parseFloat(e.estimatedEPS), act: parseFloat(e.reportedEPS) }))
    .filter((e) => e.fq && e.date && Number.isFinite(e.est) && Number.isFinite(e.act)).map((e) => ({ ...e, beat: cents(e.act - e.est) }))
    .sort((a, b) => a.fq.localeCompare(b.fq));
}
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;
function classify(q, i) {
  if (i < 4) return { valid: true, history: false };
  for (let k = 1; k <= 3; k++) { const g = days(q[i - k].fq, q[i - k + 1].fq); if (g < 70 || g > 110) return { valid: true, history: false }; }   // consecutive fiscal quarters
  const ya = days(q[i - 4].fq, q[i].fq); if (ya < 340 || ya > 390) return { valid: true, history: false };
  const base = q[i].beat > 0 && q[i - 1].beat > 0 && q[i - 2].beat > 0 && q[i - 3].beat > 0;
  return { valid: true, history: true, base, STRICT: base && q[i].beat > q[i - 1].beat && q[i].beat > q[i - 4].beat, LOOSE: base && q[i].beat > q[i - 4].beat };
}
function entryIndex(sessions, date, time) {   // sessions: sorted YYYY-MM-DD
  const pre = String(time || "").toLowerCase() === "pre-market";
  for (let i = 0; i < sessions.length; i++) if (pre ? sessions[i] >= date : sessions[i] > date) return i;
  return -1;
}

// ── statistics ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a, lag = 1) {
  const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m);
  let v = d.reduce((s, x) => s + x * x, 0) / n;
  for (let l = 1; l <= lag; l++) { let c = 0; for (let i = l; i < n; i++) c += d[i] * d[i - l]; v += 2 * (1 - l / (lag + 1)) * c / n; }
  return v > 0 ? m / Math.sqrt(v / n) : null;
}
const plainT = (a) => { const n = a.length; if (n < 3) return null; const m = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)); return sd > 0 ? m / (sd / Math.sqrt(n)) : null; };
const season = (d) => `${d.slice(0, 4)}Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}`;
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// 2026-10-05: one stream PER SYMBOL, keyed by (seed, symbol) — never a shared stream consumed in fetch order (see the header).
function fnv1a(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
const symbolStream = (seed, sym) => mulberry(fnv1a(`${seed}|${sym}`));
function scrambleAll(bars, seed) { const out = {}; for (const k of Object.keys(bars).sort()) out[k] = scramble(bars[k], symbolStream(seed, k)); return out; }
// What the control consumes, fingerprinted: SHAPE (symbols, bar counts, first/last dates) and RATIOS (the open/prior-close and close/open
// pairs the scramble moves, to 8 significant digits — invariant to a uniform price rescale such as a later dividend adjustment).
function fingerprint(bars) {
  const shape = crypto.createHash("sha256"), ratios = crypto.createHash("sha256");
  for (const k of Object.keys(bars).sort()) {
    const b = bars[k] || [];
    shape.update(`${k}:${b.length}:${b.length ? String(b[0].t).slice(0, 10) : ""}:${b.length ? String(b[b.length - 1].t).slice(0, 10) : ""};`);
    ratios.update(k + ":");
    for (let i = 1; i < b.length; i++) ratios.update(`${(b[i].o / b[i - 1].c).toPrecision(8)},${(b[i].c / b[i].o).toPrecision(8)};`);
  }
  return { shape: shape.digest("hex").slice(0, 16), ratios: ratios.digest("hex").slice(0, 16) };
}

// Scrambled prices: each day's (open/prior close, close/open) pair is moved to a random day of the same symbol, then the path is
// rebuilt. Dates, calendar and earnings stay; any link between a report and what follows it is destroyed.
function scramble(bars, rng) {
  if (bars.length < 3) return bars;
  const pairs = []; for (let i = 1; i < bars.length; i++) pairs.push([bars[i].o / bars[i - 1].c, bars[i].c / bars[i].o]);
  for (let i = pairs.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; }
  const out = [{ ...bars[0] }]; let c = bars[0].c;
  for (let i = 1; i < bars.length; i++) { const o = c * pairs[i - 1][0]; c = o * pairs[i - 1][1]; out.push({ t: bars[i].t, o, c }); }
  return out;
}

// ── the event study ─────────────────────────────────────────────────────────────────────────────────────────────────────
function study(earn, bars, { peek = false } = {}) {
  const spy = bars.SPY, sessions = spy.map((b) => b.t.slice(0, 10)), spyAt = new Map(spy.map((b, i) => [b.t.slice(0, 10), b]));
  const events = []; const drops = { noHistory: 0, noEntry: 0, noPrice: 0, beforeWindow: 0, windowOpen: 0 };
  for (const [sym, q] of Object.entries(earn)) {
    const px = new Map((bars[sym] || []).map((b) => [b.t.slice(0, 10), b]));
    for (let i = 0; i < q.length; i++) {
      const c = classify(q, i); if (!c.history) { drops.noHistory++; continue; }
      const ei = entryIndex(sessions, q[i].date, q[i].time); if (ei < 0) { drops.noEntry++; continue; }
      if (sessions[ei] < FIRST_ENTRY) { drops.beforeWindow++; continue; }
      const ex = {};
      for (const H of HOLDS) {
        const xi = ei + H - 1; if (xi >= sessions.length) { ex[H] = null; continue; }
        const e = px.get(sessions[ei]), x = px.get(sessions[xi]), se = spyAt.get(sessions[ei]), sx = spyAt.get(sessions[xi]);
        ex[H] = e && x && se && sx ? (x.c / e.o - 1) - (sx.c / se.o - 1) - COST : undefined;
      }
      if (HOLDS.every((H) => ex[H] === null)) { drops.windowOpen++; continue; }
      if (HOLDS.some((H) => ex[H] === undefined)) { drops.noPrice++; continue; }
      events.push({ sym, date: q[i].date, entry: sessions[ei], season: season(q[i].date), base: c.base, STRICT: c.STRICT, LOOSE: c.LOOSE, ex });
    }
  }
  const variants = {};
  for (const cond of CONDS) for (const H of HOLDS) {
    const key = `${cond}-${H}`, bySeason = new Map();
    for (const e of events) { if (e.ex[H] == null) continue;
      const qual = peek ? (e.base && e.ex[H] > 0) : e[cond];
      const s = bySeason.get(e.season) || { q: [], o: [] }; (qual ? s.q : s.o).push(e.ex[H]); bySeason.set(e.season, s); }
    const rows = [...bySeason.entries()].sort((a, b) => a[0].localeCompare(b[0])).filter(([, s]) => s.q.length && s.o.length)
      .map(([k, s]) => ({ season: k, nQ: s.q.length, nO: s.o.length, qNet: mean(s.q), oNet: mean(s.o), diff: mean(s.q) - mean(s.o) }));
    const diffs = rows.map((r) => r.diff), half = Math.floor(rows.length / 2);
    variants[key] = { seasons: rows.length, qualifiers: rows.reduce((s, r) => s + r.nQ, 0), others: rows.reduce((s, r) => s + r.nO, 0),
      meanDiffPct: rows.length ? +(100 * mean(diffs)).toFixed(3) : null, tNW: rows.length > 2 ? +nwT(diffs).toFixed(3) : null, tPlain: rows.length > 2 ? +plainT(diffs).toFixed(3) : null,
      firstHalfPct: half ? +(100 * mean(diffs.slice(0, half))).toFixed(3) : null, secondHalfPct: half ? +(100 * mean(diffs.slice(half))).toFixed(3) : null,
      qualNetExcessPct: rows.length ? +(100 * mean(rows.map((r) => r.qNet))).toFixed(3) : null, perSeason: rows.map((r) => ({ ...r, qNet: +(100 * r.qNet).toFixed(2), oNet: +(100 * r.oNet).toFixed(2), diff: +(100 * r.diff).toFixed(2) })) };
  }
  return { events: events.length, drops, variants };
}

// ── known-answer selftest: MasTec from the book, with Alpha Vantage's own numbers (probe of 2026-09-23) ───────────────────
function selftest() {
  const mtz = parseQuarters([
    { fiscalDateEnding: "2015-03-31", reportedDate: "2015-05-11", reportedEPS: "0.07", estimatedEPS: "0.18", reportTime: "post-market" },
    { fiscalDateEnding: "2015-06-30", reportedDate: "2015-08-17", reportedEPS: "0.1", estimatedEPS: "0.11", reportTime: "post-market" },
    { fiscalDateEnding: "2015-09-30", reportedDate: "2015-11-03", reportedEPS: "0.26", estimatedEPS: "0.33", reportTime: "post-market" },
    { fiscalDateEnding: "2015-12-31", reportedDate: "2016-02-25", reportedEPS: "0.19", estimatedEPS: "0.12", reportTime: "post-market" },
    { fiscalDateEnding: "2016-03-31", reportedDate: "2016-05-05", reportedEPS: "0.02", estimatedEPS: "-0.02", reportTime: "post-market" },
    { fiscalDateEnding: "2016-06-30", reportedDate: "2016-08-04", reportedEPS: "0.36", estimatedEPS: "0.23", reportTime: "post-market" },
    { fiscalDateEnding: "2016-09-30", reportedDate: "2016-11-03", reportedEPS: "0.81", estimatedEPS: "0.7", reportTime: "post-market" },
    { fiscalDateEnding: "2016-12-31", reportedDate: "2017-02-23", reportedEPS: "0.7", estimatedEPS: "0.54", reportTime: "post-market" },
  ]);
  const i = mtz.findIndex((e) => e.date === "2016-11-03"), c = classify(mtz, i);
  const sess = ["2016-11-02", "2016-11-03", "2016-11-04", "2016-11-07"];
  const checks = {
    beatsInDollars: JSON.stringify(mtz.slice(3, 7).map((e) => e.beat)) === JSON.stringify([0.07, 0.04, 0.13, 0.11]),
    fourStraightBeats: c.base === true,
    strictFailsAsTheBookItselfShows: c.STRICT === false,
    looseQualifiesTheBooksExample: c.LOOSE === true,
    postMarketEntersNextOpen: sess[entryIndex(sess, "2016-11-03", "post-market")] === "2016-11-04",
    preMarketEntersSameOpen: sess[entryIndex(sess, "2016-11-03", "pre-market")] === "2016-11-03",
    newestNeedsHistory: classify(mtz, 3).history === false,
    // 2026-10-05: the leak test's scramble must not depend on the order the bars arrived in, nor on another symbol's bar count
    scrambleIsOrderFree: (() => {
      const mk = (n, p0) => Array.from({ length: n }, (_, i) => ({ t: `2020-01-${String(i + 1).padStart(2, "0")}`, o: p0 + i + 0.25, c: p0 + i + 0.5 }));
      const A = { ZZZ: mk(9, 10), AAA: mk(7, 50), MMM: mk(8, 90) }, B = { AAA: mk(7, 50), MMM: mk(8, 90), ZZZ: mk(9, 10) }, C = { AAA: mk(7, 50), MMM: mk(12, 90), ZZZ: mk(9, 10) };
      const a = scrambleAll(A, 2), b = scrambleAll(B, 2), c = scrambleAll(C, 2);
      return JSON.stringify(a.AAA) === JSON.stringify(b.AAA) && JSON.stringify(a.ZZZ) === JSON.stringify(b.ZZZ) && JSON.stringify(a.MMM) === JSON.stringify(b.MMM)
        && JSON.stringify(a.ZZZ) === JSON.stringify(c.ZZZ) && JSON.stringify(scrambleAll(A, 1).ZZZ) !== JSON.stringify(a.ZZZ);
    })(),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  const st = selftest(); console.log(`R147 selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`); if (!st.pass) process.exit(1);
  if (process.argv.includes("--selftest")) return;   // pure checks only — no data read, nothing written
  const uni = JSON.parse(fs.readFileSync(D("r147-universe.json"), "utf8"));
  const held = uni.names.filter((s) => fs.existsSync(path.join(DIR, s + ".json")));
  if (held.length < uni.names.length) { console.log(`R147 coverage ${held.length}/${uni.names.length} — earnings fetch still running (r147-fetch.js nightly); controls and read wait for 100%`); return; }
  const earn = {}; let empty = 0;
  for (const s of uni.names) { const q = parseQuarters(JSON.parse(fs.readFileSync(path.join(DIR, s + ".json"), "utf8")).quarterlyEarnings); if (q.length) earn[s] = q; else empty++; }
  const syms = Object.keys(earn);
  const spyRes = await fetchBars(["SPY"], { start: START, end: END, feed: "sip", quiet: true });
  const res = await fetchBars(syms, { start: START, end: END, feed: "sip", requireAll: false, quiet: true });
  const bars = { ...res.bars, SPY: spyRes.bars.SPY };
  const coverage = { names: uni.names.length, withEarnings: syms.length, noEarningsHistory: empty, noPriceBars: res.missing };

  if (!READ) {
    const synth = [1, 2].map((seed) => study(earn, scrambleAll(bars, seed)).variants);
    const peek = study(earn, bars, { peek: true }).variants;
    const slim = (v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { seasons: x.seasons, meanDiffPct: x.meanDiffPct, tNW: x.tNW }]));
    const leakOk = synth.every((v) => Object.values(v).every((x) => x.tNW != null && Math.abs(x.tNW) < 2));
    const peekOk = Object.values(peek).every((x) => x.tNW != null && x.tNW >= 3);
    const fp = fingerprint(bars);
    const prev = (() => { try { return JSON.parse(fs.readFileSync(CTRL, "utf8")); } catch { return null; } })();
    const prevFp = prev && prev.reproducibility ? prev.reproducibility.input : null;
    const ctrl = { spec: "r147-controls-v2", asOf: new Date().toISOString(), coverage, selftest: st,
      leakTest: { method: "day pairs shuffled within each symbol and SPY (seeds 1, 2); one stream per symbol, mulberry32(fnv1a(seed|SYMBOL)), symbols in sorted order", pass: leakOk, seed1: slim(synth[0]), seed2: slim(synth[1]) },
      positiveControl: { method: "qualifier = 4 straight beats AND the realised excess > 0 (look-ahead by design)", pass: peekOk, result: slim(peek) }, pass: leakOk && peekOk,
      reproducibility: { input: fp, sameInputAsPrevious: prevFp ? prevFp.shape === fp.shape && prevFp.ratios === fp.ratios : null, previousAsOf: prev ? prev.asOf : null, previousPass: prev ? prev.pass : null,
        previousSpec: prev ? prev.spec : null,
        note: "Same input fingerprint => same control numbers, by construction (v2). A v1 file's numbers came from a fetch-order-dependent shared stream and are not comparable." } };
    writeJsonAtomic(CTRL, ctrl);
    console.log(`R147 controls — leak test ${leakOk ? "PASS" : "FAIL"} ${JSON.stringify(ctrl.leakTest.seed1)} · look-ahead control ${peekOk ? "PASS" : "FAIL"} ${JSON.stringify(ctrl.positiveControl.result)}`);
    console.log(ctrl.pass ? "R147 READY — controls pass; the one read is: node backend/r147-earnings-momentum.js --read" : "R147 NOT READY — a control failed; the read is refused until it is understood");
    return;
  }

  // ── the one read ──
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if (seals.tests.R147) { console.error("R147 is already sealed — refusing a second read"); process.exit(2); }
  if (fs.existsSync(OUT) && JSON.parse(fs.readFileSync(OUT, "utf8")).read) { console.error("R147 already read (data/r147-earnings-momentum.json) — seal it, do not re-read"); process.exit(2); }
  const ctrl = fs.existsSync(CTRL) ? JSON.parse(fs.readFileSync(CTRL, "utf8")) : null;
  if (!ctrl || !ctrl.pass) { console.error("R147 controls have not passed — run without --read first"); process.exit(2); }
  // 2026-10-05: a v1 controls file came from the fetch-order-dependent scramble (see the header) — its PASS is not reproducible
  if (ctrl.spec !== "r147-controls-v2") { console.error(`R147 controls file is ${ctrl.spec || "unversioned"}, not the reproducible r147-controls-v2 — run without --read first`); process.exit(2); }
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R147");
  if (!t) { console.error("R147 is not registered — refusing"); process.exit(2); }
  const r = study(earn, bars), bar = t.bar.tRequired;
  for (const v of Object.values(r.variants)) v.clears = v.seasons >= MIN_SEASONS && v.meanDiffPct > 0 && v.tNW >= bar && v.firstHalfPct > 0 && v.secondHalfPct > 0 && v.qualNetExcessPct > 0;
  const verdict = Object.values(r.variants).some((v) => v.clears) ? "PASS" : "DID NOT PASS";
  writeJsonAtomic(OUT, { spec: "r147-read-v1", read: true, asOf: new Date().toISOString(), bar, coverage, events: r.events, drops: r.drops, variants: r.variants, verdict });
  console.log(`R147 READ — ${verdict} (bar t_NW >= ${bar})`);
  for (const [k, v] of Object.entries(r.variants)) console.log(`  ${k.padEnd(10)} seasons ${v.seasons} · qualifiers ${v.qualifiers} · diff ${v.meanDiffPct}% · t_NW ${v.tNW} (plain ${v.tPlain}) · halves ${v.firstHalfPct}/${v.secondHalfPct} · qualifiers vs SPY net ${v.qualNetExcessPct}%${v.clears ? " · CLEARS" : ""}`);
})().catch((e) => { console.error("R147 FAILED:", e.message); process.exit(1); });
