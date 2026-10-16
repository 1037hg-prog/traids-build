#!/usr/bin/env node
/**
 * R146 — do our option wings lose money on underlyings that are already in a strong uptrend? (registered 2026-09-22; operator: "test it",
 * after INTC ran 25% in five days and our only INTC tickets were wings that lost 1.11R.)
 *
 * POPULATION: every clean-era OPTIONS signal ticket in the canonical ledger (lib/reconcile.js), 2026-07-31 onward. Controls, vetoed
 * shadows and retired rows are excluded by the ledger itself.
 * TREND AT ENTRY, known before the ticket exists: the underlying's daily closes UP TO THE PRIOR SESSION.
 *   ret20  = close(d-1) / close(d-21) - 1
 *   vsMa50 = close(d-1) / mean(close(d-50..d-1)) - 1
 * BUCKET: within each entry session, rank that session's tickets by the measure and call the top 20% (or top 10%) "hot". Ranking inside
 * the session removes the market's own day: a day when everything rose cannot make the hot bucket look bad or good on its own.
 * STATISTIC: per session, mean rMult(hot) - mean rMult(rest); t across sessions holding at least one ticket on each side. Unit: session.
 * VARIANTS (4): measure {ret20, vsMa50} x bucket {top 20%, top 10%}.
 *
 *   node backend/r146-wings-vs-trend.js --synth <seed>   LEAK TEST: trend ranks shuffled within each session; the gap must vanish
 *   node backend/r146-wings-vs-trend.js                  the registered run (refuses unless R146 is registered)
 */
const fs = require("fs"), path = require("path"); const { fetchBars } = require("./lib/alpaca-bars.js"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const args = process.argv.slice(2), SYNTH = args.includes("--synth") ? Number(args[args.indexOf("--synth") + 1]) : null;
const NULLS = args.includes("--nulls") ? Number(args[args.indexOf("--nulls") + 1]) : 0;   // empirical best-of-family null: N shuffles in one pass
const VARIANTS = [["ret20", 0.20], ["ret20", 0.10], ["vsMa50", 0.20], ["vsMa50", 0.10]];
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length >= 3 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

(async () => {
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), R = [...(reg.tests || []), ...(reg.preregistered || [])].find((t) => t.id === "R146");
  if (SYNTH == null && !NULLS && !R) { console.error("R146 is not registered — the real run refuses."); process.exit(2); }
  const led = require("./lib/reconcile.js").cleanEraLedger();
  const tix = led.signals.filter((r) => r.cls === "Options" && Number.isFinite(r.rMult) && r.sym && r.openedAt);
  const syms = [...new Set(tix.map((r) => r.sym))];
  const { bars } = await fetchBars(syms, { start: "2026-04-01", end: new Date(Date.now() - 20 * 60000).toISOString(), feed: "sip", requireAll: false, quiet: true, adjustment: "all" });
  const closes = Object.fromEntries(Object.entries(bars).map(([k, v]) => [k, v.map((b) => ({ d: b.t.slice(0, 10), c: b.c }))]));
  const rows = [];
  for (const t of tix) {
    const day = etDay(t.openedAt), series = closes[t.sym]; if (!series) continue;
    const prior = series.filter((b) => b.d < day); if (prior.length < 51) continue;
    const c = prior.map((b) => b.c), last = c[c.length - 1];
    rows.push({ id: t.id, sym: t.sym, day, rMult: t.rMult, pnl: t.pnl || 0,
      ret20: last / c[c.length - 21] - 1, vsMa50: last / mean(c.slice(-50)) - 1 });
  }
  const bySession = {}; for (const r of rows) (bySession[r.day] ||= []).push(r);
  let rnd = null; if (SYNTH != null) { let a = SYNTH >>> 0; rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
  const compute = (shuffler) => {
  const res = {};
  for (const [measure, frac] of VARIANTS) {
    const D_ = [], hotAll = [], restAll = [], hotPnl = [], restPnl = [];
    for (const day of Object.keys(bySession).sort()) {
      const rs = [...bySession[day]]; if (rs.length < 5) continue;
      let vals = rs.map((r) => r[measure]);
      const rnd = shuffler;
      if (rnd) { for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; } }
      const order = rs.map((r, i) => ({ r, v: vals[i] })).sort((a, b) => b.v - a.v);
      const k = Math.max(1, Math.round(order.length * frac));
      const hot = order.slice(0, k).map((x) => x.r), rest = order.slice(k).map((x) => x.r);
      if (!hot.length || !rest.length) continue;
      D_.push(mean(hot.map((r) => r.rMult)) - mean(rest.map((r) => r.rMult)));
      hotAll.push(...hot.map((r) => r.rMult)); restAll.push(...rest.map((r) => r.rMult));
      hotPnl.push(...hot.map((r) => r.pnl)); restPnl.push(...rest.map((r) => r.pnl));
    }
    const h = Math.floor(D_.length / 2);
    res[`${measure}-top${Math.round(frac * 100)}`] = { sessions: D_.length, hotTickets: hotAll.length, restTickets: restAll.length,
      gapR: D_.length ? +mean(D_).toFixed(4) : null, t: tOf(D_) == null ? null : +tOf(D_).toFixed(3),
      hotMeanR: hotAll.length ? +mean(hotAll).toFixed(4) : null, restMeanR: restAll.length ? +mean(restAll).toFixed(4) : null,
      hotMeanDollars: hotPnl.length ? +mean(hotPnl).toFixed(2) : null, restMeanDollars: restPnl.length ? +mean(restPnl).toFixed(2) : null,
      halves: D_.length ? { first: +mean(D_.slice(0, h)).toFixed(4), second: +mean(D_.slice(h)).toFixed(4) } : null };
  }
  return res; };
  if (NULLS) {
    const maxes = [];
    for (let i = 0; i < NULLS; i++) { let a = (1000 + i) >>> 0; const rr = () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
      const r2 = compute(rr); maxes.push(Math.max(...Object.values(r2).map((v) => Math.abs(v.t ?? 0)))); }
    maxes.sort((x, y) => x - y);
    const q = (p) => +maxes[Math.floor(maxes.length * p)].toFixed(3);
    const outN = { spec: "r146-empirical-null-v1", shuffles: NULLS, note: "max |t| across the four variants per shuffle — the family's own null, which the theoretical best-of-4 bar underestimates because the hot bucket is small and option R is heavy-tailed", median: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: +maxes[maxes.length - 1].toFixed(3) };
    writeJsonAtomic(D("r146-empirical-null.json"), outN); console.log(JSON.stringify(outN)); return;
  }
  const res = compute(rnd);
  const out = { spec: "r146-wings-vs-trend-v1", test: "R146", mode: SYNTH != null ? `LEAK TEST (ranks shuffled, seed ${SYNTH})` : "REGISTERED RUN",
    asOf: new Date().toISOString(), tickets: rows.length, underlyings: syms.length, sessions: Object.keys(bySession).length, variants: res };
  if (SYNTH == null) { const BAR = R.bar.tRequired, ok = Object.entries(res).filter(([, v]) => v.sessions >= R.bar.minSessions && v.gapR != null && Math.abs(v.t) >= BAR && Math.sign(v.halves.first) === Math.sign(v.halves.second));
    out.read = true;
    out.verdict = !ok.length ? "DID NOT PASS — no measure separates hot underlyings from the rest at the bar"
      : ok.every(([, v]) => v.gapR < 0) ? `ESTABLISHED (negative) — wings on the hottest underlyings do worse: ${ok.map(([k, v]) => `${k} ${v.gapR}R (t ${v.t})`).join(", ")}`
      : `ESTABLISHED (positive) — wings on the hottest underlyings do BETTER: ${ok.map(([k, v]) => `${k} ${v.gapR}R (t ${v.t})`).join(", ")}`; }
  writeJsonAtomic(D(SYNTH != null ? `r146-synth-${SYNTH}.json` : "r146-wings-vs-trend.json"), out);
  console.log(`R146 ${out.mode} — ${rows.length} option tickets, ${syms.length} underlyings, ${out.sessions} sessions`);
  for (const [k, v] of Object.entries(res)) console.log(`  ${k.padEnd(14)} sessions ${String(v.sessions).padStart(2)} · hot ${String(v.hotTickets).padStart(3)} vs rest ${String(v.restTickets).padStart(3)} · gap ${v.gapR}R (t ${v.t}) · hot ${v.hotMeanR}R/$${v.hotMeanDollars} vs rest ${v.restMeanR}R/$${v.restMeanDollars} · halves ${v.halves ? v.halves.first + "/" + v.halves.second : "-"}`);
  if (out.verdict) console.log("VERDICT:", out.verdict);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
