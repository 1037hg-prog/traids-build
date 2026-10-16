#!/usr/bin/env node
/**
 * R201 — ENSEMBLE-1 READ (ensemble-architect, 2026-09-24). The rule, weights, statistic, bar, controls, validity and verdict are
 * frozen in data/test-registry.json (preregistered[ensembleSpec="ensemble-combo-v1"].ensembleSpecDetail), registered by
 * backend/ensemble/register-ensemble-1.js BEFORE any combination was evaluated. This file implements that spec literally.
 *
 *   node backend/ensemble/read-ensemble-1.js --selftest   known-answer check on a SYNTHETIC library (reads no real holdout data)
 *   node backend/ensemble/read-ensemble-1.js              the one read -> data/r201-ensemble-1.json; seals only if valid
 *
 * IMPLEMENTATION NOTES (fixed before the read):
 *  N1. "live on d" = d inside the entry's window AND on its calendar (us-equity: an Alpaca SIP SPY session; crypto: every UTC day) —
 *      the same liveMap() the measurement uses. For WEIGHTS the spec says "live on d (d inside its window)": a us-equity component
 *      inside its window keeps its weight on a weekend date of a mixed calendar and earns 0 there (capital idle, not re-allocated).
 *  N2. Own calendar for the selection t = the entry's live dates <= 2022-12-31 (flat = 0); NW lag 5.
 *  N3. Residual correlation for duplicates: OLS residual on [1, SPY, BTC] over each entry's own live dates <= 2022-12-31; pairwise
 *      correlation over dates live for both (>= 250). Union-find merges declared clusters and residual rho > 0.8.
 *  N4. Tie-break key: mulberry32(seed XOR hash(id)) first draw; higher preT wins, then higher key.
 *  N5. σ_i(d): sample sd of the last 60 dates listed in the entry's series strictly before d (>= 20 needed). The series lists every
 *      day with capital at risk or a cost (lib-entry.js convention), so "active" = listed.
 *  N6. Combination calendar = dates in [2023-01-01, H_end] on which at least one component is inside its window, restricted to
 *      sessions if every component is us-equity, else every calendar day. H_end = the latest window end among the components.
 *  N7. Controls draw from the same library ('ok' entries). Shuffle: per date, k distinct entries live on that date (fewer if the pool
 *      is smaller). Random-component: k distinct entries whose window overlaps the holdout by >= 365 calendar days; each draw builds
 *      its own calendar by N6. 200 draws each, per variant, seeded from the registry seed. p95 = sorted[ceil(0.95*200)-1].
 *  N8. Peek: the components' returns replaced by max(r,0), weights unchanged (σ from the real series).
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const C = require("./common.js");
const D = (f) => path.join(__dirname, "..", "data", f);
const SELFTEST = process.argv.includes("--selftest");
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(3)), r5 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(5));
const hash = (s) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const HOLD_START = "2023-01-01", SEL_END = "2022-12-31", DRAWS = 200;

/** Everything the read computes, as a pure function of (library, benchmarks, spec). */
function evaluate(lib, sessions, spyR, btcR, spec) {
  const seed = spec.seed, ok = lib.filter((e) => e.status === "ok");
  const live = new Map(ok.map((e) => [e.id, C.liveMap(e, sessions)]));
  const byId = new Map(ok.map((e) => [e.id, e]));

  // ---- selection (data <= 2022-12-31 only) -------------------------------------------------------------------------------------
  const rows = ok.map((e) => {
    const m = live.get(e.id), pre = [...m.entries()].filter(([d]) => d <= SEL_END);
    const mech = C.lookup(spec.mechanismNotStated, e.id) ? null : C.lookup(spec.mechanism, e.id) || null;
    const preT = pre.length >= 250 ? C.nwT(pre.map(([, v]) => v), 5) : null;
    const reasons = [];
    if (!(e.reproduction && e.reproduction.match === true)) reasons.push("reproduction not matched");
    if (!mech) reasons.push("no stated mechanism");
    if (pre.length < 250) reasons.push(`only ${pre.length} pre-2023 dates`); else if (!(preT >= 1.0)) reasons.push(`pre-2023 t ${r3(preT)} < 1.0`);
    if (!(e.window[1] >= "2023-12-31")) reasons.push(`window ends ${e.window[1]}`);
    return { id: e.id, mechanism: mech, preDays: pre.length, preT: r3(preT), eligible: reasons.length === 0, reasons };
  });
  const elig = rows.filter((r) => r.eligible).map((r) => r.id);
  // residuals on selection data
  const resid = new Map();
  for (const id of elig) { const pre = [...live.get(id).entries()].filter(([d]) => d <= SEL_END), fit = C.ols(pre.map(([, v]) => v), pre.map(([d]) => [1, spyR.get(d) || 0, btcR.get(d) || 0])); resid.set(id, new Map(pre.map(([d], i) => [d, fit.resid[i]]))); }
  const parent = new Map(elig.map((id) => [id, id])), find = (x) => (parent.get(x) === x ? x : find(parent.get(x))), unite = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
  const merges = [];
  for (const cl of spec.declaredClusters) { const mem = elig.filter((id) => C.lookup(cl.members, id)); for (let i = 1; i < mem.length; i++) { unite(mem[0], mem[i]); merges.push({ a: mem[0], b: mem[i], why: `declared: ${cl.name}` }); } }
  const residPairs = [];
  for (let i = 0; i < elig.length; i++) for (let j = i + 1; j < elig.length; j++) { const a = resid.get(elig[i]), b = resid.get(elig[j]), xa = [], xb = []; for (const [d, v] of a) { const w = b.get(d); if (w !== undefined) { xa.push(v); xb.push(w); } }
    const rho = xa.length >= 250 ? C.corr(xa, xb) : null; residPairs.push({ a: elig[i], b: elig[j], rho: r3(rho), common: xa.length }); if (rho != null && rho > 0.8) { unite(elig[i], elig[j]); merges.push({ a: elig[i], b: elig[j], why: `residual rho ${r3(rho)}` }); } }
  const clusters = new Map(); for (const id of elig) { const r = find(id); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(id); }
  const key = (id) => C.mulberry((seed ^ hash(id)) >>> 0)();
  const preT = new Map(rows.map((r) => [r.id, r.preT]));
  const components = [...clusters.values()].map((mem) => [...mem].sort((a, b) => (preT.get(b) - preT.get(a)) || (key(b) - key(a)))[0]).sort();
  const clusterList = [...clusters.values()].map((mem) => ({ members: [...mem].sort(), representative: components.find((c) => mem.includes(c)) }));

  // ---- point-in-time sigma ------------------------------------------------------------------------------------------------------
  const sigCache = new Map();
  function sigmaFn(id) {
    if (sigCache.has(id)) return sigCache.get(id);
    const s = byId.get(id).series, ds = s.map((x) => x.d), vs = s.map((x) => x.r), memo = new Map();
    const f = (d) => { if (memo.has(d)) return memo.get(d); let lo = 0, hi = ds.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (ds[mid] < d) lo = mid + 1; else hi = mid; }   // lo = count strictly before d
      const n = Math.min(60, lo), v = n >= 20 ? C.sdOf(vs.slice(lo - n, lo)) : null, out = v > 0 ? v : null; memo.set(d, out); return out; };
    sigCache.set(id, f); return f;
  }
  const inWin = (id, d) => { const w = byId.get(id).window; return d >= w[0] && d <= w[1]; };
  const rOf = (id, d) => { const v = live.get(id).get(d); return v === undefined ? 0 : v; };

  function calendarFor(ids) {
    if (!ids.length) return [];
    const end = ids.map((id) => byId.get(id).window[1]).sort().pop(), allEq = ids.every((id) => byId.get(id).calendar === "us-equity");
    return C.days(HOLD_START, end).filter((d) => (!allEq || sessions.has(d)) && ids.some((id) => inWin(id, d)));
  }
  /** slotsAt(d) -> [{r, sig}] for the combination on date d; returns the combined series for both variants. */
  function combine(dates, slotsAt) {
    const ER = [], EW = [];
    for (const d of dates) { const sl = slotsAt(d); if (!sl.length) { ER.push(0); EW.push(0); continue; }
      EW.push(sl.reduce((s, x) => s + x.r, 0) / sl.length);
      const fin = sl.filter((x) => x.sig), W = fin.reduce((s, x) => s + 1 / x.sig, 0); ER.push(W > 0 ? fin.reduce((s, x) => s + x.r / x.sig, 0) / W : 0); }
    return { ER, EW };
  }
  const fixedSlots = (ids, transform = (x) => x) => (d) => ids.filter((id) => inWin(id, d)).map((id) => ({ r: transform(rOf(id, d)), sig: sigmaFn(id)(d) }));
  function alpha(dates, r) {
    const X = dates.map((d) => [1, spyR.get(d) || 0, btcR.get(d) || 0]), fit = C.ols(r, X);
    return { t: fit.t[0], alphaDaily: fit.b[0], betaSPY: fit.b[1], betaBTC: fit.b[2] };
  }
  function describe(dates, r) {
    const a = alpha(dates, r), perYr = dates.length / ((Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 864e5 / 365.25);
    let eq = 1, pk = 1, dd = 0; for (const x of r) { eq *= 1 + x; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
    const yrs = dates.length / perYr, sd = C.sdOf(r);
    return { days: dates.length, first: dates[0], last: dates[dates.length - 1], alphaT: r3(a.t), alphaAnnPct: r3(100 * a.alphaDaily * perYr), betaSPY: r3(a.betaSPY), betaBTC: r3(a.betaBTC),
      rawT: r3(C.nwT(r, 5)), meanAnnPct: r3(100 * C.mean(r) * perYr), volAnnPct: r3(100 * sd * Math.sqrt(perYr)), sharpe: r3(C.mean(r) / sd * Math.sqrt(perYr)), cagrPct: r3(100 * (eq ** (1 / yrs) - 1)), maxDDPct: r3(100 * dd) };
  }

  const k = components.length, out = { selection: { rows, eligible: elig, merges, residualPairs: residPairs, clusters: clusterList, components, k } };
  if (k < 2) { out.void = true; return out; }
  const hDates = calendarFor(components), true_ = combine(hDates, fixedSlots(components));
  out.holdout = { ER: describe(hDates, true_.ER), EW: describe(hDates, true_.EW) };
  // in-sample context (weightless): the same combination on selection data
  const inDates = (() => { const allEq = components.every((id) => byId.get(id).calendar === "us-equity"), st = components.map((id) => byId.get(id).window[0]).sort()[0]; return C.days(st, SEL_END).filter((d) => (!allEq || sessions.has(d)) && components.some((id) => inWin(id, d))); })();
  const ins = combine(inDates, fixedSlots(components)); out.inSampleContext = { ER: describe(inDates, ins.ER), EW: describe(inDates, ins.EW), note: "selection-period combination, CONTEXT ONLY, never evidence" };
  out.componentsHoldout = Object.fromEntries(components.map((id) => { const ds = hDates.filter((d) => inWin(id, d)), v = ds.map((d) => rOf(id, d)); return [id, { preT: preT.get(id), holdoutDays: ds.length, holdoutRawT: r3(C.nwT(v, 5)), holdoutAlphaT: r3(alpha(ds, v).t), holdoutMeanAnnPct: r3(100 * C.mean(v) * 252) }]; }));

  // ---- controls ---------------------------------------------------------------------------------------------------------------
  const rng = C.mulberry(seed * 1000 + 7), pick = (arr, n) => { const a = [...arr]; for (let i = 0; i < Math.min(n, a.length); i++) { const j = i + Math.floor(rng() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, Math.min(n, a.length)); };
  const allIds = ok.map((e) => e.id).sort();
  const shuffle = { ER: [], EW: [] };
  for (let t = 0; t < DRAWS; t++) {
    const choice = new Map(hDates.map((d) => [d, pick(allIds.filter((id) => live.get(id).has(d)), k)]));
    const c = combine(hDates, (d) => choice.get(d).map((id) => ({ r: rOf(id, d), sig: sigmaFn(id)(d) })));
    shuffle.ER.push(alpha(hDates, c.ER).t); shuffle.EW.push(alpha(hDates, c.EW).t);
  }
  const hEnd = hDates[hDates.length - 1];
  const rcPool = allIds.filter((id) => { const w = byId.get(id).window, a = w[0] > HOLD_START ? w[0] : HOLD_START, b = w[1] < hEnd ? w[1] : hEnd; return (Date.parse(b) - Date.parse(a)) / 864e5 >= 365; });
  const randomComponent = { ER: [], EW: [], draws: [] };
  for (let t = 0; t < DRAWS; t++) { const ids = pick(rcPool, k), ds = calendarFor(ids), c = combine(ds, fixedSlots(ids)); randomComponent.ER.push(alpha(ds, c.ER).t); randomComponent.EW.push(alpha(ds, c.EW).t); randomComponent.draws.push(ids); }
  const peekC = combine(hDates, fixedSlots(components, (x) => Math.max(x, 0))), peek = { ER: alpha(hDates, peekC.ER).t, EW: alpha(hDates, peekC.EW).t };
  const p95 = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length === DRAWS ? s[Math.ceil(0.95 * DRAWS) - 1] : null; };
  out.controls = {
    shuffle: { draws: DRAWS, p95ER: r3(p95(shuffle.ER)), p95EW: r3(p95(shuffle.EW)), medianER: r3([...shuffle.ER].sort((a, b) => a - b)[99]), medianEW: r3([...shuffle.EW].sort((a, b) => a - b)[99]) },
    randomComponent: { draws: DRAWS, pool: rcPool.length, p95ER: r3(p95(randomComponent.ER)), p95EW: r3(p95(randomComponent.EW)), medianER: r3([...randomComponent.ER].sort((a, b) => a - b)[99]), medianEW: r3([...randomComponent.EW].sort((a, b) => a - b)[99]) },
    peek: { tER: r3(peek.ER), tEW: r3(peek.EW), required: 3 },
  };
  out._dist = { shuffleER: shuffle.ER.map(r3), shuffleEW: shuffle.EW.map(r3), rcER: randomComponent.ER.map(r3), rcEW: randomComponent.EW.map(r3) };
  out.coverage = { holdoutDates: hDates.length, spyMissingOnSessions: hDates.filter((d) => sessions.has(d) && !spyR.has(d)).length, btcMissing: hDates.filter((d) => !btcR.has(d)).length };
  return out;
}

function verdictOf(res, bar) {
  if (res.void) return { valid: false, pass: false, text: `VOID — ${res.selection.k} component(s) met the rule (needs >= 2); not sealed` };
  const c = res.controls, v = res.holdout.ER.alphaT >= res.holdout.EW.alphaT ? "ER" : "EW", t = res.holdout[v].alphaT;
  const sh = c.shuffle["p95" + v], rc = c.randomComponent["p95" + v];
  const valid = res.selection.k >= 2 && res.coverage.spyMissingOnSessions === 0 && res.coverage.btcMissing === 0 && Number.isFinite(c.shuffle.p95ER) && Number.isFinite(c.shuffle.p95EW) && Number.isFinite(c.randomComponent.p95ER) && Number.isFinite(c.randomComponent.p95EW) && c.peek.tER >= 3 && c.peek.tEW >= 3;
  const pass = valid && t >= bar && t > sh && t > rc;
  const text = `${pass ? "PASS" : "DID NOT PASS"} — ${res.selection.k} components (${res.selection.components.join(", ")}); holdout ${res.holdout[v].first}..${res.holdout[v].last} ${res.holdout[v].days} days; best variant ${v} alpha t ${t} vs bar ${bar} (ER ${res.holdout.ER.alphaT}, EW ${res.holdout.EW.alphaT}); alpha ${res.holdout[v].alphaAnnPct}%/yr, raw t ${res.holdout[v].rawT}, Sharpe ${res.holdout[v].sharpe}; shuffle p95 ${sh} (${t > sh ? "beaten" : "not beaten"}), random-component p95 ${rc} (${t > rc ? "beaten" : "not beaten"}); peek t ${c.peek["t" + v]}`;
  return { valid, pass, variant: v, text };
}

// ---- selftest: synthetic library, known answer ---------------------------------------------------------------------------------
function selftest(spec) {
  const rng = C.mulberry(4242), gauss = () => { let u = 0, v = 0; while (!u) u = rng(); v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const sessions = new Set(C.days("2016-01-01", "2026-09-23").filter((d) => { const w = new Date(d + "T12:00:00Z").getUTCDay(); return w !== 0 && w !== 6; }));
  const spyR = new Map([...sessions].map((d) => [d, 0.01 * gauss()])), btcR = new Map(C.days("2016-01-01", "2026-09-23").map((d) => [d, 0.03 * gauss()]));
  const mk = (id, mu, cal = "us-equity", repro = true, preOnly = false) => { const ds = cal === "us-equity" ? [...sessions] : C.days("2016-01-01", "2026-09-23"); return { status: "ok", id, calendar: cal, window: ["2016-01-01", "2026-09-23"], reproduction: { match: repro }, series: ds.map((d) => ({ d, r: (preOnly && d > SEL_END ? 0 : mu) + 0.01 * gauss() })) }; };
  // planted: R180 and R164 carry +0.12%/day; R192 duplicates R180 (declared cluster); R150-RSI2 carries edge but has no mechanism; R166 carries
  // edge but did not reproduce; 13 zero-edge strategies (a noise one may pass the permissive t >= 1.0 screen by chance — that is allowed)
  const base = mk("R180", 0.0012), dup = { ...base, id: "R192", series: base.series.map((x) => ({ d: x.d, r: x.r + 0.001 * gauss() })) };
  const noise = ["R168", "R169", "R184", "R193", "R196", "R198", "R165", "R167", "R170", "R182", "R194", "R150-OTT", "R152-DAVIN"].map((id) => mk(id, 0));
  const lib = [base, dup, mk("R164", 0.0012), ...noise, mk("R150-RSI2", 0.0012, "us-equity", true, true), mk("R166", 0.0012, "us-equity", false, true), mk("R190-N50", 0, "crypto-24x7")];   // the two exclusion probes carry edge only <= 2022
  const res = evaluate(lib, sessions, spyR, btcR, spec), v = verdictOf(res, 1.953);
  const checks = {
    selectsThePlantedMechanismBackedReproducedEdges: res.selection.components.includes("R164") && res.selection.components.filter((x) => x === "R180" || x === "R192").length === 1 && !res.selection.components.includes("R150-RSI2") && !res.selection.components.includes("R166"),
    declaredDuplicateCollapses: res.selection.clusters.some((c) => c.members.includes("R180") && c.members.includes("R192")),
    noMechanismExcluded: res.selection.rows.find((r) => r.id === "R150-RSI2").reasons.includes("no stated mechanism"),
    unreproducedExcluded: res.selection.rows.find((r) => r.id === "R166").reasons.includes("reproduction not matched"),
    plantedEdgePasses: v.pass === true && res.holdout.ER.alphaT > 3,
    controlsBelowTruth: res.controls.shuffle.p95ER < res.holdout.ER.alphaT && res.controls.randomComponent.p95ER < res.holdout.ER.alphaT,
    peekValid: res.controls.peek.tER >= 3,
  };
  // null library: no planted edge anywhere -> the rule should select few/none and nothing should pass
  const nullLib = ["R180", "R164", "R168", "R169", "R184", "R196", "R193"].map((id) => mk(id, 0));
  const nres = evaluate(nullLib, sessions, spyR, btcR, spec), nv = verdictOf(nres, 1.953);
  checks.nullLibraryDoesNotPass = nv.pass === false;
  return { pass: Object.values(checks).every(Boolean), checks, planted: { verdict: v.text }, nullLibrary: { components: nres.selection.components, verdict: nv.text } };
}

(async () => {
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.ensembleSpec === "ensemble-combo-v1");
  if (!E) { console.error("ENSEMBLE-1 not registered"); process.exit(2); }
  const ID = E.id, spec = E.ensembleSpecDetail, BAR = E.bar.tRequired;
  const st = selftest(spec); console.log(`${ID} selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`); console.log(`  planted: ${st.planted.verdict}`); console.log(`  null: components ${JSON.stringify(st.nullLibrary.components)} -> ${st.nullLibrary.verdict}`);
  if (!st.pass) process.exit(1);
  if (SELFTEST) return;
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); }
  const OUT = D("r201-ensemble-1.json"); if (fs.existsSync(OUT)) { console.error(`${OUT} exists — the one read has happened; seal it, do not re-read`); process.exit(2); }

  const lib = C.loadLibrary(), spy = await C.spyDaily(), btc = await C.btcDaily(), sessions = new Set(spy.map((x) => x.d)), spyR = C.toRet(spy), btcR = C.toRet(btc);
  const res = evaluate(lib, sessions, spyR, btcR, spec), v = verdictOf(res, BAR);
  console.log(`\n${ID} selection: eligible ${JSON.stringify(res.selection.eligible)} -> components ${JSON.stringify(res.selection.components)}`);
  for (const r of res.selection.rows) console.log(`  ${r.id.padEnd(18)} preT ${String(r.preT).padEnd(7)} ${r.eligible ? "ELIGIBLE" : r.reasons.join("; ")}`);
  if (res.holdout) { console.log(`  holdout ER ${JSON.stringify(res.holdout.ER)}`); console.log(`  holdout EW ${JSON.stringify(res.holdout.EW)}`); console.log(`  controls ${JSON.stringify(res.controls)}`); }
  const libIndex = lib.map((e) => ({ id: e.id, status: e.status, emitterSha256: e.source.emitterSha256, scriptSha256: e.source.sha256, generatedAt: e.generatedAt }));
  writeJsonAtomic(OUT, { spec: "r201-ensemble-1-read-v1", test: ID, asOf: new Date().toISOString(), bar: BAR, selftest: st, library: libIndex, ...res, verdict: v.text, pass: v.pass, controlsValid: v.valid, verdictVariant: v.variant || null });
  console.log(`\n  VERDICT: ${v.text}`);
  if (!v.valid) { console.log("  controls invalid or VOID — NOT sealed"); return; }
  const today = todayET(), s2 = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (s2.tests[ID]) throw new Error("sealed concurrently — not overwriting");
  s2.tests[ID] = { sealedOn: today, unit: "days", verdict: v.text }; s2.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), s2);
  const reg2 = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E2 = reg2.preregistered.find((t) => t.id === ID);
  E2.status = `READ ${today} — ${v.text}`; reg2.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg2);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "ensemble-architect", action: "seal-read", test: ID, verdict: v.text }) + "\n");
  console.log(`  sealed ${ID} (${today})`);
})().catch((e) => { console.error("R201 FAILED (nothing sealed):", e.stack); process.exit(1); });
