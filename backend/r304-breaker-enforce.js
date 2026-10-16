#!/usr/bin/env node
/**
 * R304 — DOES THE CIRCUIT BREAKER EARN ENFORCEMENT? (registered 2026-10-01, operator: "yes register it")
 *
 * The board's circuit breaker runs in OBSERVE mode (lib/risk-policy.js breakerMode): when the session's capped exposure reaches the
 * ceiling ($25,000 = 25% of the book) or realized P&L reaches -$2,000, it stamps a WOULD-HALT event in data/circuit-breaker.json and
 * counts the tickets it would have refused, but refuses nothing. Enforcing it would refuse every new board ticket for the rest of the
 * day. This measures what those tickets are worth: if the signal tickets opened after the day's first would-halt LOSE, refusing them
 * pays; if not, enforcement only costs evidence (~40% of the board's tickets).
 *
 * STATISTIC (unit = halt day): for each ET session from 2026-10-02 with a HALT/WOULD-HALT event, A_d = mean rMult of the canonical
 * SIGNAL tickets (lib/reconcile.js cleanEraLedger) opened that day at or after the first event and settled. One-sample t over halt days;
 * ENFORCE WARRANTED if t <= -bar (bar from the registry). A day counts once it is 7 calendar days old (about 5 sessions; tickets settle).
 * DIAGNOSTICS (reported, not gated): same-day tickets opened before the halt; signal tickets opened >= 09:45 ET on non-halt days
 * (time-of-day match); control tickets after the halt (the market-day effect); dollars.
 * CONFIG GUARD: the test measures the breaker as configured at registration (observe; $25,000 ceiling; -$2,000 realized). A halt event
 * with another threshold, or breakerMode other than observe, freezes the day count at the change (configChanged) for the operator.
 * MODES  (default) write data/r304-breaker-enforce.json   [close chain]   ·   --read (once, seals)   ·   --selftest
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const ID = "R304", OUT = D("r304-breaker-enforce.json"), EVIDENCE_START = "2026-10-02", READ_AT = 30, MATURE_DAYS = 7, LATE_HM = "09:45";
const REG_CEILING = 25000, REG_LOSS = 2000, REG_MODE = "observe";
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
const etDate = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const etHM = (ms) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });

/** first halt event per ET day, with the thresholds its reason names */
function haltDays(events) {
  const h = {};
  for (const e of events || []) { if (!/HALT/.test(e.type || "")) continue; const d = etDate(Date.parse(e.at)); if (h[d]) continue;
    const ceil = /ceiling \$(\d+)/.exec(e.reason || ""), loss = /<= -\$(\d+)/.exec(e.reason || "");
    h[d] = { at: Date.parse(e.at), mode: e.mode || null, reason: e.reason, ceiling: ceil ? +ceil[1] : null, loss: loss ? +loss[1] : null }; }
  return h;
}
function compute({ signals, controls, events, mode, todayMs, prevChanged = null }) {
  const H = haltDays(events), today = etDate(todayMs), matureBefore = etDate(todayMs - MATURE_DAYS * 864e5);
  const inWin = (t) => Number.isFinite(t.openedAt) && etDate(t.openedAt) >= EVIDENCE_START && etDate(t.openedAt) <= matureBefore;
  const days = Object.keys(H).filter((d) => d >= EVIDENCE_START).sort();
  let configChangedOn = [prevChanged, mode !== REG_MODE ? today : null].filter(Boolean).sort()[0] || null;   // persisted: the first night a change was seen never moves forward
  for (const d of days) { const h = H[d]; if ((h.ceiling != null && h.ceiling !== REG_CEILING) || (h.loss != null && h.loss !== REG_LOSS) || (h.mode && h.mode !== REG_MODE)) { configChangedOn = configChangedOn && configChangedOn < d ? configChangedOn : d; break; } }
  const rows = [];
  for (const d of days) {
    if (d > matureBefore) continue; if (configChangedOn && d >= configChangedOn) break;
    const h = H[d], A = signals.filter((t) => inWin(t) && etDate(t.openedAt) === d && t.openedAt >= h.at), B = signals.filter((t) => inWin(t) && etDate(t.openedAt) === d && t.openedAt < h.at);
    const CA = controls.filter((t) => inWin(t) && etDate(t.openedAt) === d && t.openedAt >= h.at);
    rows.push({ d, haltET: etHM(h.at), reason: (h.reason || "").slice(0, 90), refusedN: A.length, refusedMeanR: A.length ? +mean(A.map((t) => t.rMult)).toFixed(4) : null, refusedPnl: Math.round(A.reduce((s, t) => s + t.pnl, 0)),
      keptN: B.length, keptMeanR: B.length ? +mean(B.map((t) => t.rMult)).toFixed(4) : null, controlsAfterN: CA.length, controlsAfterMeanR: CA.length ? +mean(CA.map((t) => t.rMult)).toFixed(4) : null });
  }
  const used = rows.filter((r) => r.refusedN > 0), x = used.map((r) => r.refusedMeanR), t = tOf(x);
  const nonHalt = signals.filter((s) => inWin(s) && !H[etDate(s.openedAt)] && etHM(s.openedAt) >= LATE_HM), byDay = {};
  for (const s of nonHalt) (byDay[etDate(s.openedAt)] ||= []).push(s.rMult);
  const nh = Object.values(byDay).map(mean);
  return { haltDays: used.length, haltDaysNoRefusedTickets: rows.length - used.length, meanRefusedR: x.length ? +mean(x).toFixed(4) : null, tRefused: t == null ? null : +t.toFixed(3),
    refusedTickets: used.reduce((s, r) => s + r.refusedN, 0), refusedPnl: used.reduce((s, r) => s + r.refusedPnl, 0), refusedWinPct: null,
    timeMatchedNonHalt: { days: nh.length, meanR: nh.length ? +mean(nh).toFixed(4) : null, tR: tOf(nh) == null ? null : +tOf(nh).toFixed(3), from: `${LATE_HM} ET` },
    configChangedOn, rows };
}
function load() {
  const R = require("./lib/reconcile.js"); const L = R.cleanEraLedger();
  R.assertReconciled("signal meanR", +(L.signals.reduce((s, t) => s + t.rMult, 0) / L.signals.length).toFixed(4), L.meanR);   // canonical meanR is stored to 4 dp
  const B = JSON.parse(fs.readFileSync(D("circuit-breaker.json"), "utf8")); let mode = REG_MODE;
  try { mode = require("./lib/risk-policy.js").RISK_POLICY.breakerMode || REG_MODE; } catch {}
  return { signals: L.signals, controls: L.controls || [], events: B.events || [], mode, todayMs: Date.now() };
}
function write() {
  const prev0 = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {}; const inp = load(), c = compute({ ...inp, prevChanged: prev0.configChangedOn || null });
  const winA = (() => { const H = haltDays(inp.events), m = etDate(inp.todayMs - MATURE_DAYS * 864e5); const A = inp.signals.filter((t) => Number.isFinite(t.openedAt) && etDate(t.openedAt) >= EVIDENCE_START && etDate(t.openedAt) <= m && H[etDate(t.openedAt)] && t.openedAt >= H[etDate(t.openedAt)].at); return A.length ? +(100 * A.filter((t) => t.rMult > 0).length / A.length).toFixed(1) : null; })();
  c.refusedWinPct = winA;
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
  const out = { id: ID, asOf: new Date().toISOString(), evidenceStart: EVIDENCE_START, readAt: READ_AT, breakerMode: inp.mode, registeredConfig: { mode: REG_MODE, ceiling: REG_CEILING, realizedHalt: -REG_LOSS }, ...c,
    status: c.configChangedOn ? `FROZEN — breaker configuration changed on ${c.configChangedOn}; read on the days before it (operator)` : c.haltDays >= READ_AT ? "READY TO READ" : `ACCRUING — ${c.haltDays}/${READ_AT} halt days`,
    dailyClock: { sessions: c.haltDays, estimate: c.meanRefusedR, unit: "mean net R of signal tickets opened after the day's first would-halt, per halt day (negative = enforcement would have paid)" },
    preview: { weightless: true, window: "2026-08-25..2026-09-25 (17 halt days, seen before registration)", meanR: -0.031, tDayClustered: -0.89, refusedPnl: -2192, timeMatchedNonHaltMeanR: 0.028 },
    read: prev.read || null };
  writeJsonAtomic(OUT, out);
  console.log(`[r304] ${out.status} · mean refused-ticket R ${c.meanRefusedR} (t ${c.tRefused}) over ${c.haltDays} halt days · refused $${c.refusedPnl} · time-matched non-halt ${c.timeMatchedNonHalt.meanR}`);
}
function read() {
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((e) => e.id === ID), seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if ((seals.tests || {})[ID]) throw new Error("already sealed — read once"); const o = JSON.parse(fs.readFileSync(OUT, "utf8")); if (o.read) throw new Error("already read");
  const inp = load(), c = compute({ ...inp, prevChanged: o.configChangedOn || null }), used = c.rows.filter((r) => r.refusedN > 0).slice(0, READ_AT); if (used.length < READ_AT) throw new Error(`${used.length} halt days < ${READ_AT} — refusing`);
  const x = used.map((r) => r.refusedMeanR), tt = tOf(x), bar = t.bar.tRequired, verdict = tt != null && tt <= -bar ? "ENFORCE WARRANTED" : "NOT WARRANTED";
  const res = { verdict, tRefused: +tt.toFixed(3), meanRefusedR: +mean(x).toFixed(4), bar: -bar, window: [used[0].d, used[used.length - 1].d], days: used.length, refusedPnl: used.reduce((s, r) => s + r.refusedPnl, 0), readAt: new Date().toISOString() };
  writeJsonAtomic(OUT, { ...o, read: res });
  seals.tests = seals.tests || {}; seals.tests[ID] = { sealedOn: new Date().toISOString().slice(0, 10), unit: "halt days (first 30 from 2026-10-02)", verdict: `${verdict} — t ${res.tRefused} vs -${bar} over ${res.days} halt days ${res.window.join("..")}; mean ${res.meanRefusedR}R; refused tickets $${res.refusedPnl}`, output: "data/r304-breaker-enforce.json" };
  writeJsonAtomic(D("read-seals.json"), seals); console.log(seals.tests[ID].verdict);
}
function selftest() {
  const ok = [], at = (d, hm) => Date.parse(`${d}T${hm}:00-04:00`), tk = (d, hm, r) => ({ openedAt: at(d, hm), rMult: r, pnl: 100 * r });
  const events = [{ at: new Date(at("2026-10-02", "09:50")).toISOString(), type: "WOULD-HALT", mode: "observe", reason: "current-epoch capped exposure $26000 >= ceiling $25000 (25% of book)" },
    { at: new Date(at("2026-10-02", "11:00")).toISOString(), type: "WOULD-HALT", mode: "observe", reason: "second event same day ignored" },
    { at: new Date(at("2026-10-05", "09:40")).toISOString(), type: "WOULD-HALT", mode: "observe", reason: "realized day P&L $-2100 <= -$2000" },
    { at: new Date(at("2026-10-06", "09:40")).toISOString(), type: "WOULD-HALT", mode: "observe", reason: "current-epoch capped exposure $31000 >= ceiling $30000 (30% of book)" }];
  const signals = [tk("2026-10-02", "09:40", 1), tk("2026-10-02", "09:55", -0.5), tk("2026-10-02", "10:30", -0.3), tk("2026-10-05", "09:30", 0.2), tk("2026-10-05", "10:00", -0.1), tk("2026-10-06", "10:00", -9), tk("2026-10-07", "10:00", 0.4), tk("2026-10-07", "09:00", 9)];
  const c = compute({ signals, controls: [], events, mode: "observe", todayMs: Date.parse("2026-10-30T12:00:00Z") });
  ok.push(["first event per day; only tickets at/after it count (10-02 refused mean -0.4 kept 1; 10-05 refused -0.1 kept 1)", c.rows[0].refusedMeanR === -0.4 && c.rows[0].keptN === 1 && c.rows[1].refusedMeanR === -0.1 && c.rows[1].keptN === 1]);
  ok.push(["a threshold change freezes the count at that day (10-06 ceiling $30000)", c.configChangedOn === "2026-10-06" && c.haltDays === 2]);
  ok.push(["time-matched non-halt: only >= 09:45 ET on non-halt days (10-07 10:00 = 0.4)", c.timeMatchedNonHalt.meanR === 0.4 && c.timeMatchedNonHalt.days === 1]);
  const young = compute({ signals, controls: [], events, mode: "observe", todayMs: Date.parse("2026-10-06T12:00:00Z") });
  ok.push(["a day counts only once 7 calendar days old", young.haltDays === 0]);
  const ev3 = events.slice(0, 3), enf = compute({ signals, controls: [], events: ev3, mode: "enforce", todayMs: Date.parse("2026-10-30T12:00:00Z") });
  ok.push(["breakerMode enforce freezes the test on the night it is first seen", enf.configChangedOn === "2026-10-30" && enf.haltDays === 2]);
  const later = compute({ signals, controls: [], events: ev3, mode: "enforce", todayMs: Date.parse("2026-11-20T12:00:00Z"), prevChanged: "2026-10-30" });
  ok.push(["the freeze date persists (does not move forward with the clock)", later.configChangedOn === "2026-10-30"]);
  for (const [n, v] of ok) console.log(v ? "ok  " : "FAIL", n); if (ok.some(([, v]) => !v)) process.exit(1); console.log("selftest passed");
}
const mode = process.argv.includes("--selftest") ? "selftest" : process.argv.includes("--read") ? "read" : "write";
try { ({ selftest, read, write })[mode](); } catch (e) { console.error("[r304] FAILED:", e.message); process.exit(1); }
