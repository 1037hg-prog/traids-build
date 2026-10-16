#!/usr/bin/env node
/**
 * R109 — LET WINNERS RUN PAST THE CLOSE. Registered 2026-09-09, evidence from 2026-09-10.
 *
 * THE QUESTION. 66% of clean-era exits are "close", the end-of-session flatten, at an average win of
 * +0.247R against an average loss of -0.216R — near-symmetric outcomes, which is what harvesting a
 * move at an arbitrary clock time produces. The operator's reading: let the winners run. If the
 * book's winners carry momentum, holding one more session should pay; if they mean-revert, the
 * flatten is protecting the book rather than costing it.
 *
 * THE RULE, frozen before evidence. Every position closed with reason "close" and a POSITIVE booked
 * rMult is recorded as a SHADOW. Nothing about the live flatten changes — the position is still
 * closed, the ledger still records it, no capital is held overnight. On the Nth trading session
 * after the flatten it is graded at ((close_N - entry) * dir) / stopDist, using the SAME entry and
 * the SAME floored stop distance the real ticket used, so the counterfactual is in the ticket's own
 * R. The statistic is the DELTA: held minus booked.
 *
 * COST IS CHARGED TO NEITHER ARM, and that is not an oversight. The position is opened and closed
 * exactly once whichever rule applies; extending a hold adds no round trip. The comparison is
 * cost-neutral by construction, which is rare on this board and worth saying out loud.
 *
 * STATISTIC: mean session-clustered delta in R. CLUSTERING UNIT: the SESSION OF THE FLATTEN — every
 * ticket flattened on one day shares that day's overnight tape, so a session contributes the mean of
 * its own shadows. n is sessions, never shadows.
 *
 * BAR: 30 sessions and 150 shadows, session-clustered t >= 2.214 (best-of-3 from lib/null-bar.js —
 * the horizon was searched across +1/+3/+5 in the motivating preview, so the family is 3). Interim
 * kill-only at 15 sessions if t <= -2. PRIMARY IS +1 SESSION; +3 and +5 accrue as declared family
 * members and are reported with their overlap stated — they share sessions with each other and with
 * later shadows, so they are NOT independent confirmations of the primary.
 *
 * THE PREVIEW POINTED THE OTHER WAY, and that is disclosed in the registry rather than buried: green
 * tickets held +1/+3/+5 sessions gave back -0.012R / -0.061R / -0.125R on 453 backward-looking rows.
 * Nothing cleared. This is registered anyway because a cheap look disagreeing with the intuition is
 * exactly when a test earns its keep, and because refusing to register on the strength of a
 * weightless backward look is the same error mirrored.
 *
 * Usage: node backend/r109-hold-past-close.js
 */
const fs = require("fs"), path = require("path");
const R = require("./lib/reconcile.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");

const D = (f) => path.join(__dirname, "data", f);
const SHADOWS = D("r109-shadows.jsonl");
const API = process.env.TRAIDS_API || "http://localhost:3001";
const HORIZONS = [1, 3, 5];
const PRIMARY = 1;

const REG = (() => { const r = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
  for (const v of Object.values(r)) if (Array.isArray(v)) { const t = v.find((x) => x && x.id === "R109"); if (t) return t; } })();
if (!REG || !REG.bar) { console.error("R109 not registered with a bar — refusing"); process.exit(1); }
const EV = REG.evidenceStart, B = REG.bar;

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => { const s = sd(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : null; };
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(3));
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const readShadows = () => { try { return fs.readFileSync(SHADOWS, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

(async () => {
  const L = R.cleanEraLedger();

  // ── 1. RECORD tonight's shadows (append-only, never re-record an id) ───────
  const have = new Set(readShadows().map((s) => s.id));
  const fresh = (L.signals || []).filter((t) =>
    t.reason === "close" && Number.isFinite(t.rMult) && t.rMult > 0 &&
    Number.isFinite(t.entry) && Number.isFinite(t.stopDist) && t.stopDist > 0 &&
    Number.isFinite(t.closedAt) && etDay(t.closedAt) >= EV && !have.has(t.id));
  for (const t of fresh) {
    fs.appendFileSync(SHADOWS, JSON.stringify({ id: t.id, sym: t.sym, cls: t.cls, dir: t.dir,
      entry: t.entry, stopDist: t.stopDist, bookedR: t.rMult,
      flattenSession: etDay(t.closedAt), recordedAt: new Date().toISOString() }) + "\n");
  }

  // ── 2. GRADE the ones whose horizon has matured ───────────────────────────
  const shadows = readShadows();
  if (!shadows.length) {
    writeJsonAtomic(D("r109-hold-past-close.json"), { spec: "r109-v1", test: "R109", asOf: new Date().toISOString(),
      evidenceStart: EV, bar: B, shadows: 0, verdict: `ACCRUING — 0/${B.minSessions} sessions (nothing recorded since ${EV})`,
      dailyClock: { sessions: 0, estimate: null, unit: "R delta, held minus booked, per shadow" } });
    console.log(`R109 — 0 shadows recorded (evidence starts ${EV}; ${fresh.length} added tonight)`);
    return;
  }

  const syms = [...new Set(shadows.map((s) => s.sym))];
  let data = {};
  try { data = (await fetch(`${API}/api/equities/bars`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbols: syms, days: 120 }), signal: AbortSignal.timeout(180000) }).then((r) => r.json())).data || {}; }
  catch (e) { console.error("bars fetch failed:", e.message); process.exit(1); }
  const dayOf = (b) => String(b.t).slice(0, 10);

  const arms = {};
  for (const h of HORIZONS) {
    const graded = [], pending = [];
    for (const s of shadows) {
      const bars = data[s.sym] || [];
      const i = bars.map(dayOf).indexOf(s.flattenSession);
      if (i < 0) { pending.push({ ...s, why: "no bar for the flatten session" }); continue; }
      const j = i + h;
      if (j >= bars.length) { pending.push({ ...s, why: `+${h} sessions not complete` }); continue; }
      const heldR = ((bars[j].c - s.entry) * s.dir) / s.stopDist;
      graded.push({ ...s, heldR: r3(heldR), delta: r3(heldR - s.bookedR), exitDate: dayOf(bars[j]) });
    }
    const bySession = {};
    for (const g of graded) (bySession[g.flattenSession] ||= []).push(g.delta);
    const sessions = Object.keys(bySession).sort();
    const vals = sessions.map((d) => mean(bySession[d]));
    arms[`+${h}d`] = { horizon: h, primary: h === PRIMARY, graded: graded.length, pending: pending.length,
      sessions: sessions.length, meanDeltaR: r3(mean(vals)), t: r3(tOf(vals)),
      meanBookedR: r3(mean(graded.map((g) => g.bookedR))), meanHeldR: r3(mean(graded.map((g) => g.heldR))),
      positiveSessions: vals.filter((x) => x > 0).length,
      overlapNote: h === PRIMARY ? null : `+${h} sessions overlap each other and later shadows — NOT an independent confirmation of the primary` };
  }

  const P = arms[`+${PRIMARY}d`];
  let verdict;
  if (P.sessions >= B.minSessions && P.graded >= B.minShadows && P.t != null)
    verdict = P.t >= B.tRequired && P.meanDeltaR > 0
      ? `PASS — holding a green ticket +${PRIMARY} session beats the flatten by ${P.meanDeltaR}R, t ${P.t} on ${P.sessions} sessions (bar ${B.tRequired}). Routes to the operator as a PROPOSAL, never an automatic change, and not before gap risk and capacity are read beside it.`
      : `DID NOT PASS — delta ${P.meanDeltaR}R, t ${P.t} on ${P.sessions} sessions (bar ${B.tRequired}). The end-of-session flatten is not costing the book its winners; the 0.72 payoff ratio is an ENTRY problem and must be pursued there.`;
  else if (P.sessions >= B.interimSessions && P.t != null && P.t <= B.interimKillT)
    verdict = `KILLED at interim — t ${P.t} on ${P.sessions} sessions. Holding is actively worse than flattening.`;
  else
    verdict = `ACCRUING — ${P.sessions}/${B.minSessions} sessions, ${P.graded}/${B.minShadows} shadows${P.t == null ? "" : ` (delta ${P.meanDeltaR}R, t ${P.t})`}`;

  const out = { spec: "r109-v1", test: "R109", asOf: new Date().toISOString(), evidenceStart: EV, bar: B,
    primaryHorizonSessions: PRIMARY, costNote: "charged to neither arm — one round trip either way, so the comparison is cost-neutral",
    shadowsRecorded: shadows.length, addedTonight: fresh.length, arms, verdict,
    dailyClock: { sessions: P.sessions, estimate: P.meanDeltaR, unit: "R delta (held minus booked) per shadow, session-clustered",
      detail: `${P.graded} graded, ${P.pending} in flight` } };
  writeJsonAtomic(D("r109-hold-past-close.json"), out);

  console.log(`R109 hold past the close — ${verdict}`);
  console.log(`   ${shadows.length} shadows (${fresh.length} added tonight) · cost-neutral by construction`);
  for (const k of Object.keys(arms)) {
    const a = arms[k];
    console.log(`   ${k}${a.primary ? " PRIMARY" : "        "}  ${String(a.graded).padStart(4)} graded  ${String(a.sessions).padStart(3)} sess  booked ${a.meanBookedR}  held ${a.meanHeldR}  delta ${a.meanDeltaR}  t ${a.t}`);
  }
})().catch((e) => { console.error("R109 failed:", e.message); process.exit(1); });
