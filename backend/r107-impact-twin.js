#!/usr/bin/env node
/**
 * R107 — THE IMPACT-CHARGED BOOK. Registered 2026-09-08, evidence from 2026-09-09.
 *
 * Does the equity book survive its own footprint?
 *
 * A paper order moves no price, so rMult on this ledger cannot contain market impact and never will, however many sessions
 * accrue. The cost model charges spread and commission only. Every result this apparatus has produced is therefore measured in a
 * world where our own trading has no price effect. This does not fix that. It prices it.
 *
 * THE CHARGE, frozen before evidence:
 *   participation p = shares / median daily volume over the symbol's trailing 30 sessions
 *   sigma          = sd of that symbol's daily log returns over the same window
 *   impactR        = 2 * C * sigma * sqrt(p) / stopPct        (entry and exit, expressed in the ticket's own R)
 *   charged book   = the identical ticket at rMult - impactR. Nothing is refused, resized or reordered.
 *
 * C = 1.0 is the declared central value of the square-root law and is the PRIMARY. C = 0.3 and C = 1.5 are computed every night
 * as disclosed sensitivities and may never be substituted for it — that substitution is the whole reason the coefficient is
 * declared in advance.
 *
 * MEASURED AT REGISTRATION, weightless: 333 settled equity tickets, 209 symbols, median participation 0.115% of median daily
 * volume, impact 0.0322R per ticket at today's size against a board gap of 0.016R. The omission is the same size as the thing
 * being measured, which is why this is registered rather than filed as a caveat.
 *
 * IMPACT HITS SIGNALS AND CONTROLS IDENTICALLY, so it cannot move the signal-minus-control gap. This test is about the ABSOLUTE
 * book. Reading it as evidence about selection would be wrong, and the output says so.
 *
 * Usage: node backend/r107-impact-twin.js
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const rc = require("./lib/reconcile.js"), S = require("./lib/session.js");
const D = (f) => path.join(__dirname, "data", f);
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return d; } };
const API = process.env.TRAIDS_API || "http://localhost:3001";

const REG = (() => { const r = rd("test-registry.json", {}); for (const k of Object.keys(r)) if (Array.isArray(r[k])) { const t = r[k].find((x) => x.id === "R107"); if (t) return t; } })();
if (!REG || !REG.bar) { console.error("R107 not registered with a bar — refusing"); process.exit(1); }
const EV = REG.evidenceStart, B = REG.bar, C_PRIMARY = B.impactCoefficient ?? 1.0, C_SENS = [0.3, 1.5];

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => { const s = sd(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : null; };
const r4 = (x) => (x == null ? null : +x.toFixed(4));
const medianOf = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

(async () => {
  const L = rc.cleanEraLedger();
  const usable = (r) => r.cls === "Equity" && Number.isFinite(r.rMult) && r.entry > 0 && r.stopDist > 0 && r.units > 0;
  const sig = L.signals.filter(usable), ctl = L.controls.filter(usable);
  const all = [...sig, ...ctl];
  const syms = [...new Set(all.map((r) => r.sym))];
  if (!syms.length) { console.log("R107 — no priceable equity tickets yet"); return; }

  let data = {};
  try {
    data = (await fetch(`${API}/api/equities/bars`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: syms, days: 30 }), signal: AbortSignal.timeout(240000) }).then((r) => r.json())).data || {};
  } catch (e) { console.error("bars failed:", e.message); process.exit(1); }

  const adv = {}, vol = {};
  for (const s of Object.keys(data)) {
    const b = (data[s] || []).filter((x) => x.v > 0 && x.c > 0);
    if (b.length < 10) continue;
    adv[s] = medianOf(b.map((x) => x.v));
    const rets = []; for (let i = 1; i < b.length; i++) rets.push(Math.log(b[i].c / b[i - 1].c));
    vol[s] = sd(rets);
  }
  const impactOf = (t, C) => {
    if (!(adv[t.sym] > 0) || !(vol[t.sym] > 0)) return null;
    const p = t.units / adv[t.sym], stopPct = t.stopDist / t.entry;
    return stopPct > 0 ? 2 * C * vol[t.sym] * Math.sqrt(p) / stopPct : null;
  };

  const priced = sig.map((t) => ({ t, imp: impactOf(t, C_PRIMARY) })).filter((x) => x.imp != null);
  const pricedCtl = ctl.map((t) => ({ t, imp: impactOf(t, C_PRIMARY) })).filter((x) => x.imp != null);
  const ev = priced.filter((x) => S.openSession(x.t) >= EV), evCtl = pricedCtl.filter((x) => S.openSession(x.t) >= EV);

  const perSession = (rows) => {
    const days = [...new Set(rows.map((x) => S.openSession(x.t)))].sort();
    return days.map((d) => ({ day: d, mean: mean(rows.filter((x) => S.openSession(x.t) === d).map((x) => x.t.rMult - x.imp)) }));
  };
  const ps = perSession(ev), psCtl = perSession(evCtl);
  const chargedMeans = ps.map((x) => x.mean);
  const n = ps.length, t = chargedMeans.length >= 2 ? tOf(chargedMeans) : null;

  let verdict;
  if (n >= B.minSessions && t != null) verdict = t >= B.tRequired && mean(chargedMeans) > 0
    ? `PASS — the charged book is positive: mean ${r4(mean(chargedMeans))}R per ticket, t ${r4(t)} on ${n} sessions (bar ${B.tRequired}).`
    : `DID NOT PASS — charged mean ${r4(mean(chargedMeans))}R, t ${r4(t)} on ${n} sessions (bar ${B.tRequired}). The book does not survive its own footprint at current size.`;
  else if (n >= B.interimSessions && t != null && t <= B.interimKillT) verdict = `KILLED at interim — charged t ${r4(t)} on ${n} sessions.`;
  else verdict = `ACCRUING — ${n}/${B.minSessions} sessions${t == null ? "" : ` (charged mean ${r4(mean(chargedMeans))}R, t ${r4(t)})`}`;

  // disclosed sensitivities and the capacity curve — never substitutable for the primary
  const sens = {};
  for (const C of C_SENS) {
    const rows = sig.map((x) => ({ t: x, imp: impactOf(x, C) })).filter((x) => x.imp != null).filter((x) => S.openSession(x.t) >= EV);
    sens["C" + C] = { medianImpactR: r4(medianOf(rows.map((x) => x.imp))), chargedMeanR: r4(mean(rows.map((x) => x.t.rMult - x.imp))) };
  }
  const curve = {};
  for (const M of [1, 10, 100, 1000]) {
    curve[M + "x"] = r4(medianOf(priced.map((x) => x.imp * Math.sqrt(M))));   // impact grows with the square root of size
  }

  const out = { spec: "r107-impact-twin-v1", test: "R107", asOf: new Date().toISOString(), evidenceStart: EV, bar: B,
    coefficient: C_PRIMARY, tickets: ev.length, symbolsPriced: Object.keys(adv).length, sessions: n,
    medianImpactR: r4(medianOf(ev.map((x) => x.imp))),
    medianParticipationPct: r4(100 * medianOf(ev.map((x) => x.t.units / adv[x.t.sym]))),
    unchargedMeanR: r4(mean(ev.map((x) => x.t.rMult))), chargedMeanR: r4(mean(chargedMeans)), t: r4(t),
    controlChargedMeanR: psCtl.length ? r4(mean(psCtl.map((x) => x.mean))) : null,
    note: "Impact is charged identically to signals and controls, so it cannot move the signal-minus-control gap. This reads the ABSOLUTE book only.",
    sensitivities: sens, capacityCurveMedianImpactR: curve, perSession: ps, verdict,
    dailyClock: { sessions: n, estimate: r4(mean(chargedMeans)), unit: "charged R per ticket", detail: `median impact ${r4(medianOf(ev.map((x) => x.imp)))}R at C=${C_PRIMARY}` } };
  writeJsonAtomic(D("r107-impact-twin.json"), out);
  console.log(`R107 impact twin — ${verdict}`);
  console.log(`   median impact ${out.medianImpactR}R on ${out.medianParticipationPct}% participation · uncharged ${out.unchargedMeanR}R → charged ${out.chargedMeanR}R`);
  console.log(`   capacity (median impact by size): ${Object.entries(curve).map(([k, v]) => k + " " + v + "R").join(" · ")}`);
})().catch((e) => { console.error("R107 failed:", e.message); process.exit(1); });
