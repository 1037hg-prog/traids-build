"use strict";
/**
 * CORR-SIZE PREVIEW — WEIGHTLESS replay of lib/corr-size.js over the canonical ledger. 2026-09-24.
 *
 * Not a registered test, moves nothing. For every settled SIGNAL ticket (lib/reconcile.js
 * cleanEraLedger(), !ctrl) it reconstructs the open signal book at that ticket's openedAt from the
 * other signal tickets' openedAt/closedAt (plus today's still-open board signals, which were open
 * from their addedAt onward), then applies corrSizeMult using a correlation fit AS OF the last
 * session STRICTLY BEFORE the ticket's session — a genuine point-in-time fit per session, not one
 * fit on today's data.
 *
 * Simulation is sequential: a peer contributes its APPLIED risk (base x its own mult), which is
 * what the live book would hold. Same-instant batches are processed in ledger order, as the entry
 * POST processes them. Applied P&L = pnl x mult (linear; ignores share/contract rounding).
 *
 * USAGE  node corr-size-preview.js [--panel-cache <file.json>]
 * OUTPUT data/corr-size-preview.json
 */
const fs = require("fs"), path = require("path");
const { cleanEraLedger } = require("./lib/reconcile");
const { sessionOf } = require("./lib/session");
const { writeJsonAtomic } = require("./lib/atomic-write");
const { buildPanel, fitAt } = require("./corr-factors-fit");
const { corrSizeMult } = require("./lib/corr-size");

const D = (f) => path.join(__dirname, "data", f);
const argv = process.argv.slice(2);
const cacheArg = argv.includes("--panel-cache") ? argv[argv.indexOf("--panel-cache") + 1] : null;
const FOCUS = ["2026-08-20", "2026-08-24", "2026-08-27"];

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] : null; };
const r0 = (x) => Math.round(x);

async function main() {
  const L = cleanEraLedger();
  const board = JSON.parse(fs.readFileSync(D("board_positions.json"), "utf8"));
  const settledIds = new Set(L.signals.map((t) => t.id));

  // base risk dollars: stamped riskDollars, else |pnl / rMult|, else class median
  const derived = (t) => (Number(t.riskDollars) > 0 ? Number(t.riskDollars) : Math.abs(t.rMult) > 0.05 ? Math.abs(t.pnl / t.rMult) : null);
  const clsMed = {};
  for (const t of L.signals) { const r = derived(t); if (r) (clsMed[t.cls] ||= []).push(r); }
  for (const c in clsMed) clsMed[c] = q(clsMed[c], 0.5);

  const events = [];
  L.signals.forEach((t, i) => events.push({ id: t.id, sym: t.sym, cls: t.cls, dir: t.dir, openedAt: t.openedAt, closedAt: t.closedAt, pnl: t.pnl, rMult: t.rMult, reason: t.reason, base: derived(t) || clsMed[t.cls] || 500, ord: i, settled: true }));
  board.filter((p) => !p.ctrl && !p.vetoShadow && !settledIds.has(p.id)).forEach((p, i) =>
    events.push({ id: p.id, sym: p.sym, cls: p.cls, dir: p.dir, openedAt: p.addedAt, closedAt: Infinity, base: Number(p.riskDollars) > 0 ? Number(p.riskDollars) : clsMed[p.cls] || 500, ord: 1e6 + i, settled: false }));
  events.sort((a, b) => a.openedAt - b.openedAt || a.ord - b.ord);

  const firstSession = sessionOf(events[0].openedAt);
  const start = new Date(Date.parse(firstSession) - 110 * 86400e3).toISOString().slice(0, 10);
  let panel;
  if (cacheArg && fs.existsSync(cacheArg)) { panel = JSON.parse(fs.readFileSync(cacheArg, "utf8")); console.log(`panel from cache ${cacheArg}`); }
  else {
    console.log(`building panel from ${start} (first ticket session ${firstSession}) ...`);
    panel = await buildPanel({ start, quiet: true });
    if (cacheArg) fs.writeFileSync(cacheArg, JSON.stringify(panel));
  }
  console.log(`panel ${panel.dates[0]} .. ${panel.dates[panel.dates.length - 1]} (${panel.dates.length} sessions)`);

  // one PIT fit per distinct "last session strictly before the ticket's session"
  const fits = new Map();
  const fitFor = (sess) => {
    let idx = -1; for (let i = panel.dates.length - 1; i >= 0; i--) if (panel.dates[i] < sess) { idx = i; break; }
    if (idx < 60) return null;
    if (!fits.has(idx)) fits.set(idx, fitAt(panel, idx));
    return fits.get(idx);
  };

  const runVariant = (label, opts) => {
    const out = [];
    const reasons = {};
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const sess = sessionOf(e.openedAt);
      const fit = fitFor(sess);
      const book = [];
      for (let j = 0; j < i; j++) { const o = events[j]; if (o.closedAt > e.openedAt && o.appliedRisk) book.push({ id: o.id, sym: o.sym, cls: o.cls, dir: o.dir, riskDollars: o.appliedRisk }); }
      const res = fit ? corrSizeMult({ id: e.id, sym: e.sym, cls: e.cls, dir: e.dir, riskDollars: e.base }, book, { factors: fit, nowMs: e.openedAt, ...opts })
        : { mult: 1, crowding: 0, why: "fail-open: no PIT fit (< 60 prior sessions in panel)", topPeers: [] };
      e.appliedRisk = e.base * res.mult;
      const rk = res.why.startsWith("fail-open") ? res.why.replace(/ [A-Z0-9/.]+ not in fit/, " <sym> not in fit").replace(/\(.*\)/, "").trim() : "fitted";
      reasons[rk] = (reasons[rk] || 0) + 1;
      out.push({ ...e, mult: res.mult, crowding: res.crowding, why: res.why, fitAsOf: fit ? fit.asOfSession : null, peers: (res.topPeers || []).slice(0, 3) });
    }
    for (const e of events) delete e.appliedRisk;
    const S = out.filter((x) => x.settled);
    const flat = S.reduce((s, x) => s + x.pnl, 0), app = S.reduce((s, x) => s + x.pnl * x.mult, 0);
    const mults = S.map((x) => x.mult);
    const byKey = (keyFn) => {
      const m = {};
      for (const x of S) { const k = keyFn(x); (m[k] ||= { flat: 0, applied: 0, n: 0 }); m[k].flat += x.pnl; m[k].applied += x.pnl * x.mult; m[k].n++; }
      const days = Object.entries(m).map(([d, v]) => ({ session: d, n: v.n, flat: r0(v.flat), applied: r0(v.applied) })).sort((a, b) => a.session.localeCompare(b.session));
      const f = days.map((d) => d.flat), a = days.map((d) => d.applied);
      const dd = (arr) => { let pk = 0, c = 0, w = 0; for (const x of arr) { c += x; pk = Math.max(pk, c); w = Math.min(w, c - pk); } return r0(w); };
      return {
        sessions: days.length,
        sdFlat: r0(sd(f)), sdApplied: r0(sd(a)), meanFlat: r0(mean(f)), meanApplied: r0(mean(a)),
        sharpeFlat: +(mean(f) / sd(f)).toFixed(3), sharpeApplied: +(mean(a) / sd(a)).toFixed(3),
        maxDDFlat: dd(f), maxDDApplied: dd(a),
        worst5Flat: days.slice().sort((x, y) => x.flat - y.flat).slice(0, 5),
        worst5Applied: days.slice().sort((x, y) => x.applied - y.applied).slice(0, 5),
        focus: days.filter((d) => FOCUS.includes(d.session)),
      };
    };
    const byCls = {};
    for (const x of S) { const c = (byCls[x.cls] ||= { n: 0, flat: 0, applied: 0, mults: [] }); c.n++; c.flat += x.pnl; c.applied += x.pnl * x.mult; c.mults.push(x.mult); }
    for (const c of Object.values(byCls)) { c.flat = r0(c.flat); c.applied = r0(c.applied); c.meanMult = +mean(c.mults).toFixed(3); c.atFloor = c.mults.filter((m) => m <= 0.5001).length; delete c.mults; }
    const stops = S.filter((x) => /stop/i.test(x.reason || ""));
    const bins = { "1.00": 0, "0.90-0.99": 0, "0.80-0.89": 0, "0.70-0.79": 0, "0.60-0.69": 0, "0.51-0.59": 0, "0.50 floor": 0 };
    for (const m of mults) { if (m >= 0.9999) bins["1.00"]++; else if (m >= 0.9) bins["0.90-0.99"]++; else if (m >= 0.8) bins["0.80-0.89"]++; else if (m >= 0.7) bins["0.70-0.79"]++; else if (m >= 0.6) bins["0.60-0.69"]++; else if (m > 0.5001) bins["0.51-0.59"]++; else bins["0.50 floor"]++; }
    return {
      label, opts,
      tickets: S.length,
      pnlFlat: r0(flat), pnlApplied: r0(app), meanMult: +mean(mults).toFixed(4),
      pnlAppliedRiskMatched: r0(app / mean(mults)),
      grossRiskFlat: r0(S.reduce((s, x) => s + x.base, 0)), grossRiskApplied: r0(S.reduce((s, x) => s + x.base * x.mult, 0)),
      stopTail: { n: stops.length, flat: r0(stops.reduce((s, x) => s + x.pnl, 0)), applied: r0(stops.reduce((s, x) => s + x.pnl * x.mult, 0)) },
      multDistribution: { bins, p10: q(mults, 0.1), p25: q(mults, 0.25), median: q(mults, 0.5), p75: q(mults, 0.75), p90: q(mults, 0.9) },
      failOpenReasons: reasons,
      byClass: byCls,
      byCloseSession_realizedCash: byKey((x) => sessionOf(x.closedAt)),
      byOpenSession_graded: byKey((x) => sessionOf(x.openedAt)),
      sample: S.filter((x) => FOCUS.includes(sessionOf(x.openedAt))).slice(0, 12).map((x) => ({ sym: x.sym, cls: x.cls, dir: x.dir, pnl: r0(x.pnl), mult: x.mult, crowding: x.crowding, fitAsOf: x.fitAsOf, peers: x.peers })),
    };
  };

  const A = runVariant("abs-rho>0.3 (default)", {});
  const B = runVariant("signed rho>0.3 (literal sketch)", { signedOnly: true });
  const fitDates = [...fits.values()].map((f) => f.asOfSession).sort();
  const doc = {
    version: "corr-size-preview-v1", builtAt: new Date().toISOString(), weightless: true,
    ledger: { source: L.source, epoch: L.epoch, signals: L.n, boardOpenSignalsAddedToBook: events.filter((e) => !e.settled).length },
    pointInTime: `one fit per session, asOf the last panel session strictly before the ticket's ET session; ${fits.size} distinct fits ${fitDates[0]} .. ${fitDates[fitDates.length - 1]}`,
    caveats: [
      "universe membership taken from names the board traded (membership only, no outcome) — fits are PIT in DATA, not in which names were chosen",
      "Alpaca adjustment=all: later splits/dividends rescale earlier closes; daily-return correlation is essentially unaffected",
      "FX synthetic from currency ETFs; futures via ETF proxies; NZD/MXN pairs and 6N/6M unfitted -> fail-open mult 1",
      "applied P&L = pnl x mult, linear — ignores integer share/contract rounding (options at 1-2 contracts cannot actually scale to 0.7x)",
      "book = settled signal tickets + today's still-open board signals; retired rows and pre-epoch closes are absent from the book",
    ],
    variants: [A, B],
  };
  writeJsonAtomic(D("corr-size-preview.json"), doc);

  for (const V of [A, B]) {
    console.log(`\n=== ${V.label} ===  tickets ${V.tickets}  meanMult ${V.meanMult}`);
    console.log(`  P&L flat $${V.pnlFlat}  applied $${V.pnlApplied}  (risk-matched $${V.pnlAppliedRiskMatched})  gross risk ${V.grossRiskFlat} -> ${V.grossRiskApplied}`);
    console.log(`  stop tail n ${V.stopTail.n}: flat $${V.stopTail.flat} -> applied $${V.stopTail.applied}`);
    for (const [k, S] of [["CLOSE-session (realized)", V.byCloseSession_realizedCash], ["OPEN-session (graded)", V.byOpenSession_graded]]) {
      console.log(`  ${k}: sessions ${S.sessions}  sd $${S.sdFlat} -> $${S.sdApplied}  mean $${S.meanFlat} -> $${S.meanApplied}  sharpe ${S.sharpeFlat} -> ${S.sharpeApplied}  maxDD $${S.maxDDFlat} -> $${S.maxDDApplied}`);
      console.log(`    worst5 flat:    ${S.worst5Flat.map((d) => `${d.session} ${d.flat}/${d.applied}`).join("  ")}`);
      console.log(`    worst5 applied: ${S.worst5Applied.map((d) => `${d.session} ${d.flat}/${d.applied}`).join("  ")}`);
      console.log(`    focus:          ${S.focus.map((d) => `${d.session} n${d.n} ${d.flat}/${d.applied}`).join("  ")}`);
    }
    console.log(`  mult bins ${JSON.stringify(V.multDistribution.bins)}  p10 ${V.multDistribution.p10} med ${V.multDistribution.median} p90 ${V.multDistribution.p90}`);
    console.log(`  by class ${JSON.stringify(V.byClass)}`);
    console.log(`  reasons ${JSON.stringify(V.failOpenReasons)}`);
  }
  console.log(`\nwrote data/corr-size-preview.json  (${doc.pointInTime})`);
}
main().catch((e) => { console.error("corr-size-preview FAILED:", e.stack || e.message); process.exitCode = 1; });
