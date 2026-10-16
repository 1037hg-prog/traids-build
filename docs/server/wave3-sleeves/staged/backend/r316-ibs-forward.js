#!/usr/bin/env node
/**
 * R316 — R313 FORWARD: the IBS dip-buy on R313's 20 ETFs, decided at close-5 min ET from LIVE Schwab quotes, DAY market orders on the
 * Alpaca PAPER "TV" account — an EXECUTION AUDIT with kill switches, not an edge test. Registered 2026-10-02 (data/test-registry.json,
 * preregistered R316, frozen; operator 2026-10-02: "run R313 forward"). This runner implements that entry and nothing else. It never
 * edits the registry, a seal, the change-registry or any other runner's files.
 *
 *   REUSE     UNIVERSE, ibsOf, prep, simulate, placeboRunC, summarise, pairedDiffs, nwT, schwabDate, COST, PLACEBO_DRAWS/SEED come from
 *             backend/r313-ibs-etfs.js (its main() runs only when invoked directly; a require() never fetches or writes). The shadow IS
 *             R313's simulate() on the official forward bars. The placebo is R313's corrected placebo with the 2026-10-02 audit fix:
 *             UNRESTRICTED start days (entry-signal days are eligible starts) — placeboPrepU below; R313's placeboRunC draws it.
 *
 *   DECIDE    --decide --live (tasks "TRAIDS R316 1354" 13:54 MT = 15:54 ET, backup "TRAIDS R316 1357" 15:57 ET; one-time 10:54/10:57 MT
 *             on NYSE early-close dates). Refuses unless today is a session on Alpaca's calendar (early closes included) and ET is in
 *             [close-6, close-1) min. Takes data/r316.lock, waits until close-5:00, reads the TV account's positions, makes ONE batched
 *             Schwab /quotes call for the 20 (last/high/low/bid/ask/quoteTime/tradeTime recorded) and decides per the registered rule:
 *               IBS_est = (last - low) / (high - low); NO DECISION for an ETF when high <= low, the quote is older than 60 s, is not
 *               real-time, or lacks a field. A last outside [low, high] widens the range to it (the true IBS is then 0 or 1; flagged).
 *               ENTRY  no active R316 lot AND IBS_est < 0.1 -> BUY $1,000 notional (fractional), DAY market, cid r316-<SYM>-<YYYYMMDD>-B.
 *                      Skipped (logged) when the account holds ANY shares of the ETF outside an R316 lot (another runner's position).
 *               EXIT   an open R316 lot AND IBS_est > 0.9 -> SELL the lot's filled qty, DAY market, cid r316-<SYM>-<YYYYMMDD>-S.
 *               One lot per ETF; no stop, no time cap. EXECUTION CHOICE (as R311): an exit the rule fired that the broker did not
 *               complete (rejected / partly filled / not sent) is "owed" and re-sent at the next decision whatever that day's IBS says;
 *               3 zero-fill exit orders in a row stop the re-sends (alerted, operator). The round trip's shadow pair stays the day the
 *               rule fired.
 *             The decision is persisted BEFORE any send and after every send. One decision a day (state.days[D].decision === true); the
 *             backup fire finds it and only completes planned orders not yet at the broker (each cid looked up first and ADOPTED if the
 *             broker has it — a lost POST answer is never re-sent blind). NO DECISION (decision false, the backup re-queries, the
 *             after-close logs a gap, alerted, exit 1) when the quote call fails, when 0 of the 20 quotes are usable, or when the quotes
 *             come back after the window (the clock is re-checked with the quotes in hand — a stalled run never decides on post-market
 *             quotes). >= 4 ETFs without a decision on a decided day is alerted. Alerts are keyed by date x fire (--by).
 *   HARD GUARD every POST: host must be the paper endpoint; the local clock AND Alpaca's /v2/clock timestamp (skew <= 30 s, is_open)
 *             must both be inside [close-10, close-1) ET on the session date (15:50-15:59 on a normal day), with a 5 s margin at the end.
 *             The after-close audits every order's broker created_at (the send; submitted_at only as a fallback) against
 *             [close-10, close-1): a NEW violation writes data/r316-HALT.json (kind guard-violation, escalating any other HALT kind:
 *             nothing is sent until the operator removes it) and alerts; a violation already in the ledger never re-halts.
 *   SWITCHES  backend/data/TRAIDS_STOP (all jobs) -> nothing run. data/r316-HALT.json: guard-violation -> nothing sent; interim-kill ->
 *             no new entries, exits continue (positions unwind under the rule). data/r316-OFF (operator) -> no new entries, exits continue.
 *
 *   AFTER     --after-close (close chain, 16:15 ET or later; broker GETs only, never a POST; started in [close-30, close) on a session
 *             day it DEFERS and does nothing, so a chain catch-up never holds the lock through the decision): reconciles fills from filled_qty /
 *             filled_avg_price (never status alone); audits send times; refreshes the OFFICIAL daily bars from Schwab pricehistory
 *             (R313's source and request form; split-adjusted price) for the 20 from 14 days before the first live decision; today's
 *             bar is taken only from close+15 min and is PROVISIONAL — a session's bars are FINAL once a complete refresh ran on a later
 *             ET date (so a session is scored at the first after-close after it). On final sessions only: the R313 SHADOW (R313's
 *             simulate from evidenceStart, flat), one "day" ledger row per session (IBS_est vs final IBS: entries/exits both / missed /
 *             extra, at signal level and at action level; decision quote vs official close), a "gap" row for a session with no
 *             decision (never back-filled), and one "round-trip" row per completed lot: actual fill-to-fill return, shadow close-to-close
 *             return of the SAME signal pair (entry session close -> the close of the session the exit rule fired), SHORTFALL =
 *             shadow - actual in % of notional, decision quote vs fill vs official close for both legs. Rows are keyed; a re-run
 *             appends nothing twice. Then the nightly status (data/r316-status.json): round trips, mean shortfall (per round trip;
 *             day-clustered beside it), fill-to-fill mean and day-clustered t (CR1, clusters = entry days), the shadow's return and its
 *             paired excess over the unrestricted-start placebo, the interim kill (ONE look, at the first after-close with >= 40 round
 *             trips: t <= -2.0 -> HALT interim-kill + alert; a calendar-time NW t of the daily book P&L is reported beside it, ungated)
 *             and execution-read readiness (>= 60). Paper has no fees: fill-to-fill is the net return. Reported only, never gated:
 *             signal agreement counts noDecision apart from missed; late (backup-decided) legs; R313's own unpaired forward trades.
 *   EVIDENCE  state.evidenceStart = the first session on which a live order reached the broker (ledger row "evidence-start"); the shadow,
 *             day rows and round trips count from it. state.firstLiveDecision = the first live decision (gaps count from it).
 *
 *   node backend/r316-ibs-forward.js --decide --live [--by task]   the 15:55 ET decision (scheduled; never by hand outside the window)
 *   node backend/r316-ibs-forward.js --after-close                 reconcile + official bars + shadow + shortfall + status (close chain)
 *   node backend/r316-ibs-forward.js --dry | --decide              today's decisions from live quotes, nothing sent, nothing written
 *   node backend/r316-ibs-forward.js --status                      the record from local files (no network)
 *   node backend/r316-ibs-forward.js --read-execution              refuses before 60 round trips; prints the registered decision (never seals)
 *   node backend/r316-ibs-forward.js --selftest                    known answers in a temp dir (fake broker, fake quotes, fake bars, no network)
 *
 * RUNTIME FILES (this runner only): data/r316-state.json, r316-ledger.jsonl, r316-bars.json, r316-status.json, r316.lock, r316-HALT.json.
 * Built 2026-10-02 by the R316 builder (workflow), for review before the tasks are created. Repaired 2026-10-02 after the review
 * (late-quote re-check, 0-usable no-decision, HALT escalation + no re-halt, created_at audit, after-close deferral, one interim look,
 * per-fire alert class, reporting fields); the selftest covers each repair.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const R313 = require("./r313-ibs-etfs.js");
const { ibsOf, UNIVERSE, prep, simulate, placeboRunC, pairedDiffs, summarise, nwT, mean, shiftMonth, schwabDate, isWeekend, COST, PLACEBO_DRAWS, PLACEBO_SEED } = R313;

const ID = "R316", CID_PREFIX = "r316-", PAPER = "https://paper-api.alpaca.markets";
const NOTIONAL = 1000, IBS_ENTRY = 0.1, IBS_EXIT = 0.9;
const QUOTE_MAX_AGE_S = 60, QUOTE_FUTURE_TOL_S = 30, CLOCK_SKEW_MAX_S = 30;
const WIN_FROM = 6, DECIDE_AT = 5, LAST_SEND = 1, GUARD_FROM = 10, END_MARGIN_S = 5;   // minutes before the close (margin in seconds)
const LATE_AFTER_S = 30;                                                               // a decision made after close-5:00 + 30 s is "late"
const CEILING_PCT = 0.12, MIN_RT = 60, INTERIM_RT = 40, INTERIM_T = -3.13,   /* pre-evidence amendment 2026-10-02: one look, bar -3.13 (the review calibration of the entry-day CR1 t); was -2.0 */ KILL_MONTHS = 24;
const BAR_LEAD_DAYS = 14, FORMING_BAR_MIN = 15, STUCK_EXITS = 3, EPS = 1e-9;
const AFTER_CLOSE_DEFER_MIN = 30;   // an after-close started in [close-30, close) on a session day defers (a chain catch-up must not hold the lock through the decision)
const ND_ALERT = 4;                 // >= 4 of 20 ETFs without a decision on a decided day -> alerted (0 usable = no decision at all)
const KILL_NW_LAG = 10;             // calendar-time Newey-West lag of the UNGATED interim-kill diagnostic (2026-10-02 review)
const LOCK_STALE_MS = 20 * 60e3, BREAK_STALE_MS = 60e3, BOOT_SLACK_MS = 30e3;
const TERMINAL = ["filled", "canceled", "expired", "rejected", "done_for_day"];
const ACTIVE = ["planned", "pending", "open", "exiting", "exit-owed"];
const fin = Number.isFinite;
const r3 = (x) => (x == null || !fin(x) ? null : +x.toFixed(3)), r4 = (x) => (x == null || !fin(x) ? null : +x.toFixed(4)), r6 = (x) => (x == null || !fin(x) ? null : +x.toFixed(6)), r8 = (x) => (x == null || !fin(x) ? null : +x.toFixed(8));
const num = (x) => (x == null || x === "" ? null : fin(+x) ? +x : null);
const iso = (ms) => new Date(ms).toISOString();

// ── time (America/New_York) ──────────────────────────────────────────────────────────────────────────────────────────────────
const ET_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, weekday: "short" });
function etParts(ms) {
  const p = Object.fromEntries(ET_FMT.formatToParts(new Date(ms)).map((x) => [x.type, x.value])), h = +p.hour % 24, mins = h * 60 + +p.minute;
  return { date: `${p.year}-${p.month}-${p.day}`, wd: p.weekday, mins, minsF: mins + +p.second / 60 + (((ms % 1000) + 1000) % 1000) / 60000, hms: `${String(h).padStart(2, "0")}:${p.minute}:${p.second}` };
}
const hm = (m) => `${Math.floor(m / 60)}:${String(Math.floor(m % 60)).padStart(2, "0")}`;
const hms = (m) => { const s = Math.round(m * 60); return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const addDays = (d, k) => new Date(Date.parse(d + "T12:00:00Z") + k * 864e5).toISOString().slice(0, 10);
const toMins = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); if (!fin(h) || !fin(m)) throw new Error(`calendar close "${hhmm}" unreadable`); return h * 60 + m; };
const cidFor = (sym, date, side) => `${CID_PREFIX}${sym}-${date.replace(/-/g, "")}-${side}`;
// fractional quantity as Alpaca takes it: floored to 9 decimals (never sells more than held), trailing zeros dropped
const qstr = (x) => (Math.floor(x * 1e9 + 1e-3) / 1e9).toFixed(9).replace(/\.?0+$/, "");

// ── the registered windows (pure) ───────────────────────────────────────────────────────────────────────────────────────────
// decision window [close-6, close-1) on the session date
function decideWindow(ms, sess) { const e = etParts(ms); return e.date === sess.date && e.minsF >= sess.closeMins - WIN_FROM && e.minsF < sess.closeMins - LAST_SEND; }
// the HARD send guard: [close-10, close-1) ET on the session date; margin (s) shaved off the end for sends, 0 for the audit
function windowCheck(ms, sess, marginS = END_MARGIN_S) {
  if (!fin(ms)) return "time unreadable";
  const e = etParts(ms), from = sess.closeMins - GUARD_FROM, to = sess.closeMins - LAST_SEND - marginS / 60;
  if (e.date !== sess.date) return `ET date ${e.date} is not the session ${sess.date}`;
  if (!(e.minsF >= from && e.minsF < to)) return `ET ${e.hms} outside the send window ${hms(from)}-${hms(to)}`;
  return null;
}
function clockCheck(ck, sess, localMs) {
  if (!ck || ck.is_open !== true) return "Alpaca clock says the market is closed";
  const ts = Date.parse(ck.timestamp); if (!fin(ts)) return "Alpaca clock timestamp unreadable";
  if (Math.abs(ts - localMs) > CLOCK_SKEW_MAX_S * 1000) return `local clock ${((localMs - ts) / 1000).toFixed(0)} s off Alpaca's (> ${CLOCK_SKEW_MAX_S} s)`;
  const w = windowCheck(ts, sess); return w ? `Alpaca clock: ${w}` : null;
}

// ── IBS estimate and the decision (pure) ────────────────────────────────────────────────────────────────────────────────────
function ibsEstimate(q, nowMs) {
  if (!q) return { ok: false, ibs: null, ageS: null, why: "no quote" };
  const { last, high, low, quoteTime } = q, ageS = fin(quoteTime) ? (nowMs - quoteTime) / 1000 : null, have = [last, high, low].every((x) => fin(x) && x > 0);
  let ibs = null, clamped = false;
  if (have && high > low) { const hi = Math.max(high, last), lo = Math.min(low, last); clamped = hi !== high || lo !== low; ibs = (last - lo) / (hi - lo); }
  const base = { ibs, ageS: ageS == null ? null : +ageS.toFixed(1), clamped };
  if (!have) return { ...base, ok: false, why: "quote lacks last/high/low" };
  if (!(high > low)) return { ...base, ok: false, why: "high <= low (no range)" };
  if (q.realtime === false) return { ...base, ok: false, why: "not a real-time quote" };
  if (ageS == null) return { ...base, ok: false, why: "no quoteTime" };
  if (ageS > QUOTE_MAX_AGE_S) return { ...base, ok: false, stale: true, why: `quote ${ageS.toFixed(0)} s old (> ${QUOTE_MAX_AGE_S} s)` };
  if (ageS < -QUOTE_FUTURE_TOL_S) return { ...base, ok: false, why: `quoteTime ${(-ageS).toFixed(0)} s in the future (clock disagreement)` };
  return { ...base, ok: true, why: null };
}
const activeLot = (s, sym) => s.lots.find((l) => l.sym === sym && ACTIVE.includes(l.status));
const exitStuck = (l) => { const t = (l.exitOrders || []).slice(-STUCK_EXITS); return t.length === STUCK_EXITS && t.every((x) => x.done && !(x.filledQty > 0)); };
// account: { SYM: qty } (the TV account's positions). entriesBlocked / exitsBlocked: null or a reason.
function decideAll({ quotes, nowMs, state, account, entriesBlocked = null, exitsBlocked = null }) {
  const out = [];
  for (const sym of UNIVERSE) {
    const q = quotes ? quotes[sym] : null, est = ibsEstimate(q, nowMs), lot = activeLot(state, sym), held = (account && account[sym]) || 0;
    const row = { sym, ibsEst: est.ibs == null ? null : r6(est.ibs), ok: est.ok, why: est.why, ageS: est.ageS, ...(est.clamped ? { clamped: true } : {}), action: "none" };
    if (lot) {
      const owedQty = lot.status === "exit-owed" ? lot.qty - (lot.exitFilledQty || 0) : null;
      if (lot.status === "exit-owed") {
        if (exitsBlocked) row.action = "exit-blocked";
        else if (exitStuck(lot)) row.action = "exit-stuck";
        else if (held + EPS < owedQty) { row.action = "exit-refused-not-held"; row.note = `owed ${qstr(owedQty)}, account holds ${held}`; }
        else { row.action = "SELL"; row.qty = qstr(owedQty); row.owed = true; }
      } else if (lot.status === "open") {
        if (!est.ok) row.action = "hold-no-decision";
        else if (est.ibs > IBS_EXIT) {
          if (exitsBlocked) row.action = "exit-blocked";
          else if (held + EPS < lot.qty) { row.action = "exit-refused-not-held"; row.note = `lot ${lot.qtyStr}, account holds ${held}`; }
          else { row.action = "SELL"; row.qty = lot.qtyStr; }
        } else row.action = "hold";
      } else row.action = `wait-${lot.status}`;                       // pending / exiting / planned: not settled at the broker yet — nothing new
    } else if (est.ok && est.ibs < IBS_ENTRY) {
      if (entriesBlocked) row.action = "entry-blocked";
      else if (Math.abs(held) > EPS) { row.action = "skip-held-by-other"; row.note = `account holds ${held} ${sym} outside any R316 lot`; }   // no active R316 lot: every share is another runner's
      else { row.action = "BUY"; row.notional = NOTIONAL; }
    }
    out.push(row);
  }
  return out;
}

// ── statistics (pure) ───────────────────────────────────────────────────────────────────────────────────────────────────────
// CR1 cluster-robust t of the mean (clusters = entry days): V = G/(G-1) * sum_g (sum_i in g (x_i - mean))^2 / n^2. One row per
// cluster reduces it to the ordinary t (selftest).
function clusterT(vals, clusters) {
  const n = vals.length; if (n < 2) return null;
  const m = mean(vals), g = new Map(); vals.forEach((v, i) => g.set(clusters[i], (g.get(clusters[i]) || 0) + (v - m)));
  const G = g.size; if (G < 2) return null;
  let ss = 0; for (const s of g.values()) ss += s * s;
  const V = (G / (G - 1)) * ss / (n * n); return V > 0 ? m / Math.sqrt(V) : null;
}
function dayMeans(rows, valOf) { const by = new Map(); for (const r of rows) (by.get(r.entryDate) || by.set(r.entryDate, []).get(r.entryDate)).push(valOf(r)); return [...by.values()].map(mean); }
function plainT(a) { if (a.length < 2) return null; const m = mean(a), v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); return v > 0 ? m / Math.sqrt(v / a.length) : null; }
function execStats(rts) {
  const n = rts.length; if (!n) return { n: 0, entryDays: 0 };
  const cl = rts.map((r) => r.entryDate), sf = rts.map((r) => r.shortfallPct), ff = rts.map((r) => 100 * r.actualRet), sh = rts.map((r) => 100 * r.shadowRet);
  const tff = clusterT(ff, cl), onTime = rts.filter((r) => r.lateLeg !== true);
  return { n, entryDays: new Set(cl).size, meanShortfallPct: r4(mean(sf)), shortfallCrT: r3(clusterT(sf, cl)), dayMeanShortfallPct: r4(mean(dayMeans(rts, (r) => r.shortfallPct))),
    // beside the headline (not the registered statistic): legs decided after close-5:00 + 30 s (backup days) carry less drift to the close
    lateLegRoundTrips: n - onTime.length, meanShortfallOnTimePct: onTime.length ? r4(mean(onTime.map((r) => r.shortfallPct))) : null,
    meanFillToFillPct: r4(mean(ff)), fillToFillCrT: r3(tff), fillToFillCrTRaw: tff, fillToFillDayMeanT: r3(plainT(dayMeans(rts, (r) => 100 * r.actualRet))),
    meanShadowPct: r4(mean(sh)), winRateFillToFillPct: +(100 * ff.filter((x) => x > 0).length / n).toFixed(1) };
}
function interimKill(st) {
  const applies = st.n >= INTERIM_RT, t = st.fillToFillCrTRaw;
  return { at: INTERIM_RT, bar: INTERIM_T, roundTrips: st.n, applies, t: r3(t), triggered: applies && t != null && t <= INTERIM_T };
}
// UNGATED diagnostic for the operator's pre-evidence amendment decision (2026-10-02 review): calendar-time Newey-West t of the arm's daily
// book P&L, every lot marked to the official close (open lots included). The registered kill statistic stays the entry-day CR1 t above.
function nwTLag(v, L = KILL_NW_LAG) {
  const n = v.length; if (n < 3) return null;
  const m = mean(v), d = v.map((x) => x - m); let g = d.reduce((a, x) => a + x * x, 0) / n;
  for (let l = 1; l <= L && l < n; l++) { let c = 0; for (let i = l; i < n; i++) c += d[i] * d[i - l]; g += 2 * (1 - l / (L + 1)) * c / n; }
  return g > 0 ? m / Math.sqrt(g / n) : null;
}
// per final session (sorted, >= evidenceStart): sum over lots of the day's mark-to-close change / entry fill; the exit day uses the exit fill
function bookDailyPnl(lots, store, fsDates) {
  const idx = new Map(fsDates.map((d, i) => [d, i])), pnl = new Array(fsDates.length).fill(0), last = fsDates[fsDates.length - 1];
  for (const l of lots) {
    if (!(l.entryFill > 0) || !(l.qty > 0) || !idx.has(l.entryDate)) continue;
    const end = l.status === "closed" && l.exitFill > 0 ? (l.exitCompleteDate || l.exitDecisionDate) : null, stop = end && end <= last ? end : last;
    let prev = l.entryFill;
    for (let k = idx.get(l.entryDate); k < fsDates.length && fsDates[k] <= stop; k++) {
      const d = fsDates[k], px = end && d === end ? l.exitFill : (barOf(store, l.sym, d) || {}).c; if (!(px > 0)) continue;
      pnl[k] += (px - prev) / l.entryFill; prev = px;
    }
  }
  return pnl;
}
const roundTripsOf = (rows) => { const m = new Map(); for (const r of rows) if (r.kind === "round-trip" && r.key) m.set(r.key, r); return [...m.values()]; };

// ── the shadow and the unrestricted-start placebo (R313 code) ───────────────────────────────────────────────────────────────
const barArr = (store, sym, to) => { const by = (store.bySym || {})[sym] || {}; return Object.keys(by).filter((d) => d <= to).sort().map((d) => ({ t: d, o: by[d].o, h: by[d].h, l: by[d].l, c: by[d].c, v: by[d].v })); };
const barOf = (store, sym, d) => ((store.bySym || {})[sym] || {})[d] || null;
// R313's rule, verbatim, on the official forward bars: flat at evidenceStart, entries on [from, to], close-to-close.
function runShadow(store, from, to) {
  const PS = {}, closed = [], open = [];
  for (const sym of UNIVERSE) { const bars = barArr(store, sym, to); if (!bars.length) continue; const P = prep(bars, { from, to }); PS[sym] = P; const r = simulate(P, sym); closed.push(...r.closed); open.push(...r.open); }
  return { PS, closed, open, from, to };
}
// R313's placeboPrepC with the 2026-10-02 audit fix: ENTRY-SIGNAL DAYS ARE ELIGIBLE STARTS (unrestricted). Everything else as R313: a
// day of the same ETF in the same month (+-1 when none qualifies), inside the window, not a synthetic halt day; R313's placeboRunC then
// keeps [i, i+H] disjoint from the real trade's [t-3, u] and draws H from OTHER ETFs' holds.
function placeboPrepU(trades, PS) {
  const elig = new Map();
  const eligOf = (sym) => {
    if (elig.has(sym)) return elig.get(sym);
    const P = PS[sym], m = new Map();
    for (let i = 0; i < P.n; i++) { if (P.d[i] < P.from || P.d[i] > P.to || P.synth[i]) continue; const k = P.d[i].slice(0, 7); (m.get(k) || m.set(k, []).get(k)).push(i); }
    elig.set(sym, m); return m;
  };
  const slots = trades.map((x) => { const m = eligOf(x.sym); return { sym: x.sym, month: x.month, t: x.t, u: x.u, same: m.get(x.month) || [], wide: [shiftMonth(x.month, -1), x.month, shiftMonth(x.month, 1)].flatMap((k) => m.get(k) || []) }; });
  return { slots, holdPool: trades.map((x) => [x.sym, x.hold]), symbolsInPool: new Set(trades.map((x) => x.sym)).size };
}
function shadowReport(sh) {
  if (!sh) return null;
  const net = sh.closed.map((x) => ({ ...x, net: x.gross - COST })), S = summarise(net);
  const out = { closed: sh.closed.length, open: sh.open.length, meanGrossPctPerTrade: net.length ? r4(100 * mean(net.map((x) => x.gross))) : null, meanNetPctPerTrade: net.length ? r4(100 * mean(net.map((x) => x.net))) : null,
    meanNetPctPerMonth: S.meanNetPctPerMonth, months: S.months, costPct: 100 * COST, placebo: null };
  if (net.length && new Set(net.map((x) => x.sym)).size >= 2) {
    const pl = placeboRunC(placeboPrepU(net, sh.PS), sh.PS, { draws: PLACEBO_DRAWS, seed: PLACEBO_SEED, cost: COST }), dC = pairedDiffs(S, pl);
    out.placebo = { form: "R313 corrected matched placebo, UNRESTRICTED start days (2026-10-02 audit fix)", draws: PLACEBO_DRAWS, seed: PLACEBO_SEED, slots: pl.slots, droppedPerDraw: r3(pl.droppedPerDraw),
      widenedPerDraw: r3(pl.widenedPerDraw), pairedMonths: dC.length, pairedExcessPctPerMonth: dC.length ? r4(100 * mean(dC)) : null, pairedT: r3(nwT(dC)) };
  } else out.placebo = { note: "needs closed shadow trades in >= 2 ETFs (holds are drawn from OTHER ETFs)" };
  return out;
}

// ── IO ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function pathsFor(dataDir) { const P = (f) => path.join(dataDir, f); return { dataDir, state: P("r316-state.json"), ledger: P("r316-ledger.jsonl"), bars: P("r316-bars.json"), status: P("r316-status.json"), lock: P("r316.lock"), halt: P("r316-HALT.json"), off: P("r316-OFF"), stop: P("TRAIDS_STOP"), registry: P("test-registry.json"), seals: P("read-seals.json") }; }
// exists but unreadable -> throws (fail closed: never a fresh state over a real one)
const readJson = (f, dflt) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")) : dflt);
function saveJson(f, obj) { for (let i = 0; ; i++) { try { writeJsonAtomic(f, obj); return; } catch (e) { if (i >= 2) throw e; const t = Date.now() + 250; while (Date.now() < t) { /* antivirus / sharing violation: retry */ } } } }
const freshState = () => ({ spec: "r316-state-v1", id: ID, evidenceStart: null, firstLiveDecision: null, lots: [], days: {}, lastRun: {} });
const freshStatus = () => ({ spec: "r316-status-v1", id: ID, alerts: {}, decide: null, nightly: null });
function saveState(ctx, s) { s.asOf = iso(ctx.clock()); saveJson(ctx.paths.state, s); if (ctx.onSave) ctx.onSave(s); }
function readLedger(f) {
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/), rows = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim(); if (!l) continue;
    try { rows.push(JSON.parse(l)); } catch (e) { if (i >= lines.length - 2) continue; throw new Error(`r316 ledger line ${i + 1} does not parse — refusing (a lost key could re-append a graded row)`); }
  }
  return rows;
}
const ledgerKeys = (rows) => new Set(rows.filter((r) => r.key).map((r) => r.key));
function appendLedger(ctx, row) { const r = { ts: iso(ctx.clock()), test: ID, ...row }; fs.appendFileSync(ctx.paths.ledger, JSON.stringify(r) + "\n"); return r; }
function readEnvKeys(file, names) {   // only the named keys, into a local object — never into process.env, never printed (close-arm-runner)
  const out = {}; try { for (const ln of fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && names.includes(m[1])) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); } } catch { /* missing file: no keys */ }
  return out;
}
async function alertOnce(ctx, date, cls, title, body) {
  let st; try { st = readJson(ctx.paths.status, freshStatus()); } catch { st = freshStatus(); }
  st.alerts = st.alerts || {}; const day = (st.alerts[date] = st.alerts[date] || {});
  if (day[cls]) return false;
  let ok = false; try { ok = !!(await ctx.notify(`R316 ${date}: ${title}`, String(body).slice(0, 3500))); } catch (e) { ctx.log(`alert threw: ${String(e.message).slice(0, 80)}`); }
  if (ok) { day[cls] = iso(ctx.clock()); for (const d of Object.keys(st.alerts)) if (d < addDays(date, -14)) delete st.alerts[d]; saveJson(ctx.paths.status, st); }
  else ctx.log(`ALERT NOT DELIVERED (${cls}) — tried again at the next run: ${title}`);
  return ok;
}
function writeStatusPart(ctx, part, value) { let st; try { st = readJson(ctx.paths.status, freshStatus()); } catch { st = freshStatus(); } st[part] = value; st.asOf = iso(ctx.clock()); saveJson(ctx.paths.status, st); }

// ── lock (close-arm-runner.cjs's, verbatim in behaviour) ─────────────────────────────────────────────────────────────────────
function pidAlive(pid) { if (!(Number.isInteger(pid) && pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
function breakStale(lockPath, judgedRaw) {
  const bl = lockPath + ".break";
  try { const fd = fs.openSync(bl, "wx"); fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); fs.closeSync(fd); }
  catch (e) { if (e.code !== "EEXIST") throw e; try { if (Date.now() - fs.statSync(bl).mtimeMs > BREAK_STALE_MS) fs.unlinkSync(bl); } catch { /* raced */ } return false; }
  try {
    let now; try { now = fs.readFileSync(lockPath, "utf8"); } catch (e) { if (e.code === "ENOENT") return true; throw e; }
    if (now !== judgedRaw) return false;
    fs.unlinkSync(lockPath); return true;
  } finally { try { fs.unlinkSync(bl); } catch { /* gone */ } }
}
function acquireLock(lockPath, me, { now = () => Date.now(), alive = pidAlive, boot = Date.now() - os.uptime() * 1000 } = {}) {
  let broke = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { const fd = fs.openSync(lockPath, "wx"); try { fs.writeSync(fd, JSON.stringify(me)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } return { ok: true, broke }; }
    catch (e) { if (e.code !== "EEXIST") throw e; }
    let raw; try { raw = fs.readFileSync(lockPath, "utf8"); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    let cur = null; try { cur = JSON.parse(raw); } catch { /* being written */ }
    let mtime = now(); try { mtime = fs.statSync(lockPath).mtimeMs; } catch { /* gone */ }
    const started = cur && Date.parse(cur.startedAt), age = now() - (fin(started) ? started : mtime);
    const why = !cur ? (age > BREAK_STALE_MS ? "unreadable lock older than 60 s" : null)
      : fin(started) && started < boot - BOOT_SLACK_MS ? `holder started ${cur.startedAt}, before this boot` : !alive(cur.pid) ? `pid ${cur.pid} not alive` : age > LOCK_STALE_MS ? `older than 20 min` : null;
    if (!why) return { ok: false, heldBy: cur, ageMs: age };
    if (!breakStale(lockPath, raw)) return { ok: false, heldBy: cur, note: "a stale lock is being broken by another run" };
    broke = { prev: cur, why, at: iso(now()) };
  }
  return { ok: false, heldBy: null, note: "lock not acquired after 4 attempts" };
}
function releaseLock(lockPath, me) { try { const cur = JSON.parse(fs.readFileSync(lockPath, "utf8")); if (cur.pid === me.pid && cur.startedAt === me.startedAt) { fs.unlinkSync(lockPath); return true; } } catch { /* not ours */ } return false; }

// ── broker / data adapters (real) ───────────────────────────────────────────────────────────────────────────────────────────
function realBroker(envFile, { readOnly = false } = {}) {
  const k = readEnvKeys(envFile, ["ALPACA_TV_KEY_ID", "ALPACA_TV_SECRET_KEY"]);
  const H = { "APCA-API-KEY-ID": k.ALPACA_TV_KEY_ID || "", "APCA-API-SECRET-KEY": k.ALPACA_TV_SECRET_KEY || "", "content-type": "application/json" };
  const hasKeys = !!(H["APCA-API-KEY-ID"] && H["APCA-API-SECRET-KEY"]);
  async function api(p, init = {}, retry429 = 3) {
    if (PAPER !== "https://paper-api.alpaca.markets" || !/^https:\/\/paper-api\.alpaca\.markets$/.test(PAPER)) throw new Error("not the paper endpoint — refusing");
    if (!hasKeys) throw new Error("no ALPACA_TV_KEY_ID / ALPACA_TV_SECRET_KEY in backend/.env — refusing (no fallback to the shared account)");
    if (readOnly && init.method && init.method !== "GET") throw new Error(`read-only mode: ${init.method} refused`);
    for (let i = 0; ; i++) {
      const r = await fetch(PAPER + p, { headers: H, ...init, signal: AbortSignal.timeout(10000) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 429 && i < retry429) { await new Promise((res) => setTimeout(res, 1000 * 2 ** i)); continue; }
      if (!r.ok) { const e = new Error(`${r.status} ${JSON.stringify(j).slice(0, 160)}`); e.status = r.status; throw e; }
      return j;
    }
  }
  return {
    host: PAPER, hasKeys, readOnly,
    calendar: (a, b) => api(`/v2/calendar?start=${a}&end=${b}`),
    clock: () => api("/v2/clock"),
    positions: () => api("/v2/positions"),
    openOrders: () => api("/v2/orders?status=open&limit=500"),
    asset: (s) => api(`/v2/assets/${encodeURIComponent(s)}`),
    orderByCid: async (cid) => { try { return await api(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(cid)}`); } catch (e) { if (e.status === 404) return null; throw e; } },
    submit: (body) => api("/v2/orders", { method: "POST", body: JSON.stringify(body) }, 0),   // a 429 on the POST goes back to sendOrder (guard re-checked)
  };
}
async function schwabQuotes(syms) {
  const schwab = require("./lib/schwab.js"), tok = await schwab.token();
  const r = await fetch(`https://api.schwabapi.com/marketdata/v1/quotes?symbols=${encodeURIComponent(syms.join(","))}&fields=quote,regular&indicative=false`, { headers: { Authorization: "Bearer " + tok }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`schwab quotes HTTP ${r.status}`);
  const j = await r.json(), out = {};
  for (const s of syms) {
    const v = j[s], q = v && v.quote; if (!q) continue;
    out[s] = { last: num(q.lastPrice), high: num(q.highPrice), low: num(q.lowPrice), bid: num(q.bidPrice), ask: num(q.askPrice), open: num(q.openPrice), prevClose: num(q.closePrice),
      quoteTime: num(q.quoteTime), tradeTime: num(q.tradeTime), volume: num(q.totalVolume), status: q.securityStatus || null, realtime: v.realtime === true,
      regLast: num(v.regular && v.regular.regularMarketLastPrice), regTradeTime: num(v.regular && v.regular.regularMarketTradeTime) };
  }
  return out;
}
// R313's request form (pricehistory, daily, split-adjusted, regular session); dates via R313's schwabDate (midnight stamps or throw)
async function schwabDaily(sym, fromDate, toDate) {
  const schwab = require("./lib/schwab.js"), tok = await schwab.token();
  const s = Date.parse(fromDate + "T00:00:00Z"), e = Date.parse(toDate + "T23:59:59Z");
  const u = `https://api.schwabapi.com/marketdata/v1/pricehistory?symbol=${encodeURIComponent(sym)}&periodType=year&period=20&frequencyType=daily&frequency=1&startDate=${s}&endDate=${e}&needExtendedHoursData=false`;
  for (let a = 0; a < 3; a++) {
    const r = await fetch(u, { headers: { Authorization: "Bearer " + tok }, signal: AbortSignal.timeout(30000) });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 15000 * (a + 1))); continue; }
    if (!r.ok) throw new Error(`${sym} pricehistory HTTP ${r.status}`);
    const j = await r.json(); if (!Array.isArray(j.candles)) throw new Error(`${sym} pricehistory: no candles array`);
    const lastDay = Date.parse(toDate + "T00:00:00Z") - 12 * 3600e3, out = [];
    for (const x of j.candles) {
      let d; try { d = schwabDate(x.datetime); } catch (err) { if (x.datetime >= lastDay) continue; throw err; }   // only the newest (forming / provisional) candle may be skipped
      out.push({ d, o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume });
    }
    return out.filter((b) => !isWeekend(b.d) && b.d >= fromDate && b.d <= toDate);
  }
  throw new Error(`${sym} pricehistory rate-limited 3 times`);
}
async function sessionOf(broker, date) {
  const c = await broker.calendar(date, date); if (!Array.isArray(c)) throw new Error("calendar: not a list");
  if (!c.length || c[0].date !== date) return null;
  return { date, close: c[0].close, closeMins: toMins(c[0].close) };
}
async function sessionsBetween(broker, a, b) {
  if (!a || a > b) return [];
  const c = await broker.calendar(a, b); if (!Array.isArray(c)) throw new Error("calendar: not a list");
  return c.filter((x) => x.date >= a && x.date <= b).map((x) => ({ date: x.date, close: x.close, closeMins: toMins(x.close) })).sort((x, y) => (x.date < y.date ? -1 : 1));
}

// ── sending ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function sendGuard(ctx, sess) {
  if (ctx.broker.host !== PAPER) return `non-paper host ${ctx.broker.host}`;
  const t0 = ctx.clock(), w = windowCheck(t0, sess); if (w) return `local clock: ${w}`;
  let ck; try { ck = await ctx.broker.clock(); } catch (e) { return `Alpaca clock unreadable (${String(e.message).slice(0, 60)})`; }
  return clockCheck(ck, sess, (t0 + ctx.clock()) / 2);
}
// the broker's id is looked up FIRST every pass (adopt, never re-send); the guard is re-checked before every POST
async function sendOrder(ctx, cid, body, sess) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let prior; try { prior = await ctx.broker.orderByCid(cid); } catch (e) { return { refused: `broker lookup failed (${String(e.message).slice(0, 80)}) — not sent` }; }
    if (prior) return { order: prior, adopted: true };
    const g = await sendGuard(ctx, sess); if (g) return { refused: g };
    try { return { order: await ctx.broker.submit({ ...body, type: "market", time_in_force: "day", client_order_id: cid }) }; }
    catch (e) {
      const st = e.status, msg = String(e.message).slice(0, 200);
      if (st === 429) { await ctx.sleep(1500 * (attempt + 1)); continue; }
      if (st === 422 && /client_order_id|unique/i.test(msg)) continue;                       // the id is at the broker: the next pass adopts it
      if (st >= 400 && st < 500) return { rejected: msg };                                    // a refusal: no order exists
      ctx.log(`  ${cid}: POST answer lost or 5xx (${msg.slice(0, 80)}) — looking the id up before any re-send`); await ctx.sleep(1000);
    }
  }
  let last = null; try { last = await ctx.broker.orderByCid(cid); } catch { /* unknown */ }
  return last ? { order: last, adopted: true } : { refused: "3 attempts without a broker answer and no order under the id — the backup fire retries (adopt first)" };
}
const bodyOf = (p) => (p.side === "buy" ? { symbol: p.sym, notional: String(p.notional), side: "buy" } : { symbol: p.sym, qty: String(p.qty), side: "sell" });
function planOrders(s, day) {
  const decisionOf = (x) => { const q = (day.quotes || {})[x.sym] || {}; return { date: day.date, at: day.decidedAt, ibsEst: x.ibsEst, last: q.last, high: q.high, low: q.low, bid: q.bid, ask: q.ask, quoteTime: q.quoteTime }; };
  const ds = [...(day.decisions || [])].sort((a, b) => (a.action === "SELL" ? 0 : 1) - (b.action === "SELL" ? 0 : 1));   // exits first: they free cash and never strand a lot
  for (const x of ds) {
    if (x.action === "BUY") {
      const cid = cidFor(x.sym, day.date, "B"); if (day.planned.some((p) => p.cid === cid) || activeLot(s, x.sym)) continue;
      s.lots.push({ key: cid, sym: x.sym, entryDate: day.date, entryCid: cid, status: "planned", notional: NOTIONAL, entryDecision: decisionOf(x), exitOrders: [] });
      day.planned.push({ cid, sym: x.sym, side: "buy", notional: NOTIONAL, lotKey: cid });
    } else if (x.action === "SELL") {
      const cid = cidFor(x.sym, day.date, "S"), l = activeLot(s, x.sym); if (!l || day.planned.some((p) => p.cid === cid)) continue;
      l.exitOrders.push({ cid, qty: x.qty, sentOn: day.date, status: "planned", owed: !!x.owed });
      if (!l.exitDecisionDate) { l.exitDecisionDate = day.date; l.exitDecision = decisionOf(x); }
      l.status = "exiting";
      day.planned.push({ cid, sym: x.sym, side: "sell", qty: x.qty, lotKey: l.key, owed: !!x.owed });
    }
  }
}
async function completeSends(ctx, s, day, sess) {
  const c = { sent: 0, adopted: 0, rejected: 0, refused: 0 }, refusals = [];
  for (const p of day.planned) {
    const prev = day.sends[p.cid]; if (prev && ["sent", "adopted", "rejected"].includes(prev.status)) continue;
    const r = await sendOrder(ctx, p.cid, bodyOf(p), sess), at = iso(ctx.clock()), lot = s.lots.find((l) => l.key === p.lotKey);
    const x = p.side === "sell" && lot ? lot.exitOrders.find((o) => o.cid === p.cid) : null;
    if (r.order) {
      const status = r.adopted ? "adopted" : "sent";
      day.sends[p.cid] = { status, at, orderId: r.order.id || null, createdAt: r.order.created_at || null, submittedAt: r.order.submitted_at || null, brokerStatus: r.order.status || null, host: ctx.broker.host };
      if (p.side === "buy" && lot) Object.assign(lot, { status: "pending", entryCreatedAt: r.order.created_at || null, entrySubmittedAt: r.order.submitted_at || null, entryHost: ctx.broker.host, ...(r.adopted ? { entryAdopted: true } : {}) });
      if (x) Object.assign(x, { status: "sent", createdAt: r.order.created_at || null, submittedAt: r.order.submitted_at || null, host: ctx.broker.host, ...(r.adopted ? { adopted: true } : {}) });
      c[status]++;
      if (!s.evidenceStart) { s.evidenceStart = day.date; appendLedger(ctx, { kind: "evidence-start", key: "evidence-start", date: day.date, note: "first session on which the reviewed runner's live paper order reached the broker (registry R316 evidenceStart)" }); ctx.log(`EVIDENCE START ${day.date} (first live order at the broker)`); }
      ctx.log(`  ${status === "adopted" ? "ADOPTED (already at the broker)" : "SENT"} ${p.side.toUpperCase()} ${p.side === "buy" ? "$" + p.notional : p.qty} ${p.sym} DAY market (${p.cid})${p.owed ? " — owed exit" : ""}`);
    } else if (r.rejected) {
      day.sends[p.cid] = { status: "rejected", at, why: r.rejected }; c.rejected++; refusals.push(`${p.cid} REJECTED ${r.rejected}`);
      if (p.side === "buy" && lot) lot.status = "rejected";
      if (x) { Object.assign(x, { status: "rejected", done: true, filledQty: 0, why: r.rejected }); lot.status = "exit-owed"; }
      ctx.log(`  REJECTED ${p.cid}: ${r.rejected}`);
    } else {
      day.sends[p.cid] = { status: "refused", at, why: r.refused, tries: ((prev && prev.tries) || 0) + 1 }; c.refused++; refusals.push(`${p.cid} NOT SENT ${r.refused}`);
      ctx.log(`  NOT SENT ${p.cid}: ${r.refused}`);
    }
    saveState(ctx, s);                                                                         // persisted after every send
    appendLedger(ctx, { kind: `order-${day.sends[p.cid].status}`, cid: p.cid, sym: p.sym, side: p.side, ...(p.side === "buy" ? { notional: p.notional } : { qty: p.qty }), date: day.date, ...(p.owed ? { owed: true } : {}),
      ...(day.sends[p.cid].submittedAt ? { submittedAt: day.sends[p.cid].submittedAt } : {}), ...(day.sends[p.cid].why ? { why: day.sends[p.cid].why } : {}) });
  }
  day.done = day.planned.every((p) => ["sent", "adopted", "rejected"].includes((day.sends[p.cid] || {}).status));
  saveState(ctx, s);
  return { ...c, refusals };
}

// ── reconcile (broker GETs only) ────────────────────────────────────────────────────────────────────────────────────────────
// dayOver(d): the session d is over (its DAY orders are final, a planned order not at the broker was never sent)
async function reconcileLots(ctx, s, { dayOver }) {
  const b = ctx.broker, notes = [];
  for (const l of s.lots) {
    if (l.status === "planned" || l.status === "pending") {
      if (l.status === "planned" && !dayOver(l.entryDate)) continue;                           // today's decision run owns it
      const o = await b.orderByCid(l.entryCid);
      if (!o) { if (dayOver(l.entryDate)) { const was = l.status; l.status = was === "planned" ? "not-sent" : "entry-missing"; appendLedger(ctx, { kind: `entry-${l.status}`, cid: l.entryCid, sym: l.sym, date: l.entryDate }); notes.push(`${l.sym} entry ${l.entryCid}: ${l.status}`); } continue; }
      if (l.status === "planned") { l.status = "pending"; l.entryAdopted = true; l.entryHost = b.host; appendLedger(ctx, { kind: "entry-adopted", cid: l.entryCid, sym: l.sym, date: l.entryDate }); }
      if (!l.entryCreatedAt) l.entryCreatedAt = o.created_at || null;
      if (!l.entrySubmittedAt) l.entrySubmittedAt = o.submitted_at || null;
      if (!TERMINAL.includes(o.status)) { notes.push(`${l.sym} entry ${l.entryCid} still ${o.status} at the broker — re-checked next run`); continue; }
      const fq = +o.filled_qty || 0; l.entryOrderStatus = o.status;
      if (fq > EPS) {
        Object.assign(l, { status: "open", qty: fq, qtyStr: String(o.filled_qty), entryFill: +o.filled_avg_price, entryFilledAt: o.filled_at || null });
        appendLedger(ctx, { kind: "entry-filled", cid: l.entryCid, sym: l.sym, date: l.entryDate, qty: l.qtyStr, px: l.entryFill, value: r4(fq * l.entryFill), notionalOrdered: num(o.notional), brokerStatus: o.status });
      } else { l.status = "unfilled"; appendLedger(ctx, { kind: "entry-not-filled", cid: l.entryCid, sym: l.sym, date: l.entryDate, brokerStatus: o.status }); notes.push(`${l.sym} entry ${l.entryCid} filled nothing (${o.status})`); }
    }
    if (l.status === "exiting" || l.status === "exit-owed") {
      for (const x of l.exitOrders) {
        if (x.done) continue;
        if (x.status === "planned" && !dayOver(x.sentOn)) continue;
        const o = await b.orderByCid(x.cid);
        if (!o) { if (dayOver(x.sentOn)) { Object.assign(x, { done: true, filledQty: 0, status: x.status === "planned" ? "not-sent" : "missing" }); appendLedger(ctx, { kind: `exit-${x.status}`, cid: x.cid, sym: l.sym, date: x.sentOn }); notes.push(`${l.sym} exit ${x.cid}: ${x.status}`); } continue; }
        if (x.status === "planned") { x.status = "sent"; x.adopted = true; x.host = b.host; }
        if (!x.createdAt) x.createdAt = o.created_at || null;
        if (!x.submittedAt) x.submittedAt = o.submitted_at || null;
        if (!TERMINAL.includes(o.status)) continue;
        const fq = +o.filled_qty || 0;
        Object.assign(x, { done: true, brokerStatus: o.status, filledQty: fq, avgPx: fq > 0 ? +o.filled_avg_price : null, filledAt: o.filled_at || null });
        appendLedger(ctx, { kind: fq <= EPS ? "exit-not-filled" : fq + EPS < +x.qty ? "exit-partial" : "exit-filled", cid: x.cid, sym: l.sym, date: x.sentOn, qty: x.qty, filledQty: fq, px: x.avgPx, brokerStatus: o.status });
      }
      const got = l.exitOrders.filter((x) => x.filledQty > 0), fq = got.reduce((a, x) => a + x.filledQty, 0);
      l.exitFilledQty = fq; l.exitRemaining = Math.max(0, l.qty - fq);
      if (fq >= l.qty - EPS) {
        l.exitFill = got.length === 1 ? got[0].avgPx : r8(got.reduce((a, x) => a + x.filledQty * x.avgPx, 0) / fq);
        l.exitFilledAt = got.map((x) => x.filledAt).filter(Boolean).sort().pop() || null;
        l.exitCompleteDate = l.exitFilledAt ? etParts(Date.parse(l.exitFilledAt)).date : got[got.length - 1].sentOn;
        l.status = "closed"; appendLedger(ctx, { kind: "exit-complete", key: `exit-complete:${l.key}`, lot: l.key, sym: l.sym, px: l.exitFill, qty: r8(fq), orders: got.length, exitDecisionDate: l.exitDecisionDate });
      } else if (l.exitOrders.every((x) => x.done)) {
        if (l.status !== "exit-owed") { l.status = "exit-owed"; appendLedger(ctx, { kind: "exit-owed", lot: l.key, sym: l.sym, remaining: qstr(l.exitRemaining), stuck: exitStuck(l) }); }
        notes.push(`${l.sym} lot ${l.key}: ${qstr(l.exitRemaining)} still held after the exit — ${exitStuck(l) ? `EXIT STUCK (${STUCK_EXITS} zero-fill exits in a row; not re-sent; operator)` : "re-sent at the next decision (owed)"}`);
      } else l.status = "exiting";
    }
  }
  return { notes };
}
// every order's broker SEND time against [close-10, close-1) of its own session (no margin) and the paper host. The send time is Alpaca's
// created_at (when the broker received the runner's POST); submitted_at is only the fallback — on the TV paper account it trails
// created_at by up to 152.6 s in a burst (read-only GETs 2026-10-02), so grading it could only produce a FALSE stop, never miss one.
function guardAudit(s) {
  const out = [];
  for (const l of s.lots) {
    const orders = [{ cid: l.entryCid, sentOn: l.entryDate, createdAt: l.entryCreatedAt, submittedAt: l.entrySubmittedAt, host: l.entryHost },
      ...(l.exitOrders || []).map((x) => ({ cid: x.cid, sentOn: x.sentOn, createdAt: x.createdAt, submittedAt: x.submittedAt, host: x.host }))];
    for (const o of orders) {
      const at = o.createdAt || o.submittedAt, field = o.createdAt ? "created_at" : "submitted_at"; if (!at) continue;
      const base = { cid: o.cid, sentAt: at, field, ...(o.submittedAt ? { submittedAt: o.submittedAt } : {}) };
      if (o.host && o.host !== PAPER) { out.push({ ...base, why: `sent to ${o.host}, not the paper endpoint` }); continue; }
      const day = s.days[o.sentOn]; if (!day || !fin(day.closeMins)) { out.push({ ...base, why: `no session record for ${o.sentOn}` }); continue; }
      const why = windowCheck(Date.parse(at), { date: o.sentOn, closeMins: day.closeMins }, 0);
      if (why) out.push({ ...base, why: `broker ${field}: ${why}` });
    }
  }
  return out;
}

// ── DECIDE ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function runDecide(ctx) {
  const P = ctx.paths, log = ctx.log;
  if (fs.existsSync(P.stop)) { log("backend/data/TRAIDS_STOP present — the operator stopped all scheduled jobs; nothing decided, nothing sent"); return 0; }
  const halt = readJson(P.halt, null);
  if (halt && halt.kind === "guard-violation") { log(`HALTED (${halt.kind} ${halt.date}): ${halt.why} — nothing sent until the operator reviews and removes data/r316-HALT.json`); return 0; }
  const t0 = ctx.clock(), e0 = etParts(t0), sess = await sessionOf(ctx.broker, e0.date);
  if (!sess) { log(`${e0.date} is not a session on Alpaca's calendar — nothing to decide`); return 0; }
  if (!decideWindow(t0, sess)) { log(`ET ${e0.hms} is outside the decision window ${hm(sess.closeMins - WIN_FROM)}-${hm(sess.closeMins - LAST_SEND)} (close ${sess.close}) — nothing decided`); return 0; }
  const me = { pid: process.pid, by: ctx.by, mode: "decide", startedAt: iso(ctx.clock()) }, lo = { now: ctx.clock, alive: ctx.pidAlive || pidAlive, boot: ctx.bootMs ? ctx.bootMs() : Date.now() - os.uptime() * 1000 };
  let lk = acquireLock(P.lock, me, lo);
  while (!lk.ok && etParts(ctx.clock()).minsF < sess.closeMins - LAST_SEND - 0.5) { await ctx.sleep(3000); me.startedAt = iso(ctx.clock()); lk = acquireLock(P.lock, me, lo); }
  if (!lk.ok) { const h = lk.heldBy; log(`lock held by ${h ? `${h.pid} (${h.by}, ${h.mode}) since ${h.startedAt}` : "?"} — gave up at close-1:30`); await alertOnce(ctx, sess.date, "lock", "decision NOT made — lock held", `data/r316.lock held by ${JSON.stringify(h)} through the window.`); return 1; }
  if (lk.broke) { log(`broke a stale lock (${lk.broke.why})`); await alertOnce(ctx, sess.date, "lock-broken", "stale lock broken", JSON.stringify(lk.broke)); }
  try { return await decideLocked(ctx, sess, halt); }
  finally { releaseLock(P.lock, me); }
}
async function decideLocked(ctx, sess, halt) {
  const P = ctx.paths, log = ctx.log, D = sess.date, s = readJson(P.state, freshState());
  const off = fs.existsSync(P.off), entriesBlocked = halt ? `HALT ${halt.kind} (${halt.date})` : off ? "OFF switch data/r316-OFF" : null;
  let day = s.days[D];
  if (day && day.decision === true) {
    log(`already decided today at ${day.decidedEt} ET (by ${day.by}) — completing planned orders not yet at the broker`);
    const r = await completeSends(ctx, s, day, sess);
    return finishDecide(ctx, s, day, r, true);
  }
  await reconcileLots(ctx, s, { dayOver: (d) => d < D }).then((r) => r.notes.forEach((n) => log(`  ${n}`)));
  saveState(ctx, s);
  if (ctx.warmQuotes) { try { await ctx.warmQuotes(); } catch (e) { log(`Schwab token warm-up failed (${String(e.message).slice(0, 100)}) — the quote call at close-5 tries again`); } }
  const waitMs = (sess.closeMins - DECIDE_AT - etParts(ctx.clock()).minsF) * 60000;
  if (waitMs > 0) { log(`waiting ${(waitMs / 1000).toFixed(1)} s until ${hm(sess.closeMins - DECIDE_AT)}:00 ET`); await ctx.sleep(waitMs); }
  const account = Object.fromEntries((await ctx.broker.positions()).map((p) => [p.symbol, +p.qty]));   // after the wait: what the account holds at the decision
  let quotes = null, quoteError = null;
  try { quotes = await ctx.quotes(UNIVERSE); } catch (e) { quoteError = String(e.message).slice(0, 160); }
  const qAt = ctx.clock(), eq = etParts(qAt);
  // the clock is checked AGAIN with the quotes in hand (2026-10-02 review): a run that stalled past the window (suspend during the wait,
  // slow GETs, a long token refresh) would otherwise decide on extended-hours quotes — fresh quoteTime, realtime, a post-market last above
  // the session high clamped to IBS 1.0 — and owe an exit the registered rule never fired. Not a registered decision: no decision today.
  if (!quoteError && !decideWindow(qAt, sess)) { quoteError = `quotes taken at ${eq.hms} ET, outside the decision window ${hm(sess.closeMins - WIN_FROM)}-${hm(sess.closeMins - LAST_SEND)} - not a registered decision`; quotes = null; }
  const decisions = decideAll({ quotes, nowMs: qAt, state: s, account, entriesBlocked });
  // a 200 answer with NO usable quote (delayed entitlement, frozen feed, empty body) is no decision either: decision stays false, the
  // backup re-queries, the after-close logs the gap (fail closed on the record, not only on the orders)
  if (!quoteError && !decisions.some((x) => x.ok)) quoteError = `0 of ${UNIVERSE.length} quotes usable (${[...new Set(decisions.map((x) => x.why))].join("; ").slice(0, 120)})`;
  const keep = (q) => (q ? { last: q.last, high: q.high, low: q.low, bid: q.bid, ask: q.ask, quoteTime: q.quoteTime, tradeTime: q.tradeTime, realtime: q.realtime, regLast: q.regLast, volume: q.volume } : null);
  day = s.days[D] = Object.assign(day || { planned: [], sends: {}, attempts: [] }, {
    date: D, close: sess.close, closeMins: sess.closeMins, by: ctx.by, decision: !quoteError, decidedAt: iso(qAt), decidedEt: eq.hms, late: eq.minsF > sess.closeMins - DECIDE_AT + LATE_AFTER_S / 60,
    quoteError, quotes: quotes ? Object.fromEntries(UNIVERSE.map((x) => [x, keep(quotes[x])])) : null, decisions, entriesBlocked });
  day.attempts.push({ at: iso(qAt), by: ctx.by, ok: !quoteError, ...(quoteError ? { error: quoteError } : {}) });
  planOrders(s, day);
  if (!s.firstLiveDecision && !quoteError) s.firstLiveDecision = D;
  s.lastRun.decide = D; saveState(ctx, s);                                                     // the decision is on disk BEFORE any send
  appendLedger(ctx, { kind: "decision", date: D, decidedEt: eq.hms, late: day.late, by: ctx.by, quoteError, entriesBlocked, quoteAgeMaxS: r3(Math.max(...decisions.map((x) => (fin(x.ageS) ? x.ageS : -Infinity)))),
    etfs: decisions.map((x) => ({ s: x.sym, ibs: x.ibsEst, a: x.action, ...(x.ok ? {} : { why: x.why }) })), planned: day.planned.map((p) => p.cid) });
  log(`decided ${D} at ${eq.hms} ET${day.late ? " (LATE)" : ""}${quoteError ? ` — NO QUOTES (${quoteError}): no entry/exit decision today; owed exits only` : ""}: ${decisions.filter((x) => !["none", "hold"].includes(x.action)).map((x) => `${x.sym} ${x.ibsEst} ${x.action}`).join(", ") || "no action"}`);
  const r = await completeSends(ctx, s, day, sess);
  return finishDecide(ctx, s, day, r, false);
}
// backup = this run found the day already decided and only completed sends. Decision-level issues are alerted by the deciding run; a
// completing run alerts only its own send problems. The alert class carries the fire (ctx.by), so one fire's alert never suppresses the
// other fire's different problem the same day (2026-10-02 review).
async function finishDecide(ctx, s, day, r, backup) {
  const D = day.date, decIssues = [];
  if (day.quoteError) decIssues.push(`no decision: ${day.quoteError}`);
  for (const x of day.decisions || []) if (["exit-refused-not-held", "exit-stuck"].includes(x.action)) decIssues.push(`${x.sym} ${x.action}${x.note ? ` (${x.note})` : ""}`);
  const nd = (day.decisions || []).filter((x) => !x.ok);
  if (!day.quoteError && nd.length >= ND_ALERT) decIssues.push(`${nd.length}/${UNIVERSE.length} ETFs without a decision: ${nd.map((x) => `${x.sym} ${x.why}`).join("; ")}`);
  const issues = [...decIssues, ...r.refusals], alertable = backup ? r.refusals : issues;
  writeStatusPart(ctx, "decide", { date: D, at: iso(ctx.clock()), by: ctx.by, backup, decided: day.decision === true, decidedEt: day.decidedEt, late: day.late, planned: day.planned.length, ...r, refusals: undefined, done: day.done,
    skippedHeldByOther: (day.decisions || []).filter((x) => x.action === "skip-held-by-other").map((x) => x.sym), noDecision: nd.map((x) => `${x.sym}: ${x.why}`), issues });
  ctx.log(`R316 decide ${D}${backup ? " (backup)" : ""} — planned ${day.planned.length} · sent ${r.sent} · adopted ${r.adopted} · rejected ${r.rejected} · not sent ${r.refused}${day.done ? "" : " · INCOMPLETE"}${decIssues.length ? ` · ${decIssues.length} decision issue(s)` : ""}`);
  if (alertable.length) await alertOnce(ctx, D, `${day.quoteError ? "no-decision" : "orders"}:${ctx.by}`, day.quoteError ? "NO decision today (no registered quotes)" : r.refusals.length || backup ? "order problems at the decision" : "decision problems (ETFs without a decision)", alertable.join("\n"));
  return (day.quoteError && !backup) || (issues.length && !day.done) ? 1 : 0;   // no decision is never a quiet exit 0 (fail-open invariant)
}

// ── AFTER-CLOSE ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function runAfterClose(ctx) {
  const P = ctx.paths;
  if (fs.existsSync(P.stop)) { ctx.log("backend/data/TRAIDS_STOP present — nothing run"); return 0; }
  // a close-chain CATCH-UP can start in the afternoon ("TRAIDS Market Close" has StartWhenAvailable; the Labor Day chain ran at 15:58). Its
  // 20-symbol pricehistory refresh (15 s / 30 s sleeps on a 429) would hold data/r316.lock through the decision window and turn the day
  // into a gap. Started in [close-30, close) on a session day -> deferred; the next after-close reconciles everything it skipped.
  const e0 = etParts(ctx.clock()); let s0 = null;
  try { s0 = await sessionOf(ctx.broker, e0.date); } catch { /* unreadable calendar: the locked run reads it again */ }
  if (s0 && e0.minsF >= s0.closeMins - AFTER_CLOSE_DEFER_MIN && e0.minsF < s0.closeMins) { ctx.log(`after-close at ${e0.hms} ET is inside [close-${AFTER_CLOSE_DEFER_MIN} min, close) of today's session (close ${s0.close}) — DEFERRED, nothing done (the ${hm(s0.closeMins - DECIDE_AT)} ET decision owns data/r316.lock); the next after-close reconciles`); return 0; }
  const me = { pid: process.pid, by: ctx.by, mode: "after-close", startedAt: iso(ctx.clock()) }, lo = { now: ctx.clock, alive: ctx.pidAlive || pidAlive, boot: ctx.bootMs ? ctx.bootMs() : Date.now() - os.uptime() * 1000 };
  let lk = acquireLock(P.lock, me, lo);
  for (let i = 0; !lk.ok && i < 20; i++) { await ctx.sleep(3000); me.startedAt = iso(ctx.clock()); lk = acquireLock(P.lock, me, lo); }
  if (!lk.ok) { ctx.log(`lock held (${JSON.stringify(lk.heldBy)}) — after-close not run; the next chain run retries`); return 1; }
  try { return await afterCloseLocked(ctx); }
  finally { releaseLock(P.lock, me); }
}
async function refreshBars(ctx, store, from, D, sessToday, now) {
  const e = etParts(now), todayOk = !sessToday || e.minsF >= sessToday.closeMins + FORMING_BAR_MIN, to = todayOk ? D : addDays(D, -1);
  const errors = [], revisions = [];
  store.bySym = store.bySym || {};
  for (const sym of UNIVERSE) {
    try {
      const bars = await ctx.dailyBars(sym, from, to), by = (store.bySym[sym] = store.bySym[sym] || {});
      for (const b of bars) {
        if (![b.o, b.h, b.l, b.c].every((x) => fin(x) && x > 0)) throw new Error(`${sym} ${b.d}: non-positive or missing price`);
        const prev = by[b.d], changed = prev && ["o", "h", "l", "c"].some((k) => Math.abs(prev[k] - b[k]) > 1e-9);
        if (changed) revisions.push({ sym, d: b.d, was: { o: prev.o, h: prev.h, l: prev.l, c: prev.c, fetchedOn: prev.fetchedOn }, now: { o: b.o, h: b.h, l: b.l, c: b.c }, wasFinal: prev.fetchedOn > b.d });
        by[b.d] = { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, fetchedOn: D, firstFetchedOn: prev ? prev.firstFetchedOn : D };
      }
    } catch (err) { errors.push(`${sym}: ${String(err.message).slice(0, 100)}`); }
  }
  if (!errors.length) store.lastFullFetch = { on: D, at: iso(now), from, to };
  store.asOf = iso(now); saveJson(ctx.paths.bars, store);
  return { okAll: !errors.length, errors, revisions, to };
}
function dayRow(d, s, store, sh) {
  const day = s.days[d] || null, decided = !!(day && day.decision === true), dec = decided ? Object.fromEntries(day.decisions.map((x) => [x.sym, x])) : {};
  const shE = new Set(sh ? [...sh.closed, ...sh.open].filter((x) => x.entryDate === d).map((x) => x.sym) : []), shX = new Set(sh ? sh.closed.filter((x) => x.exitDate === d).map((x) => x.sym) : []);
  // signal level compares IBS_est with the final IBS only where an IBS_est exists; a final signal on an ETF (or a day) without a decision
  // is counted as noDecision, not as an estimate error (2026-10-02 review). The action level is unchanged: a missed trade is missed.
  const C = { entrySignal: { both: 0, missed: 0, extra: 0, noDecision: 0 }, exitSignal: { both: 0, missed: 0, extra: 0, noDecision: 0 }, entryAction: { both: 0, missed: 0, extra: 0 }, exitAction: { both: 0, missed: 0, extra: 0 } };
  const tally = (o, est, fn) => { if (est && fn) o.both++; else if (fn) o.missed++; else if (est) o.extra++; };
  const dq = { noDecision: [], noBar: [], highLeLow: [], clamped: [] }, per = [];
  for (const sym of UNIVERSE) {
    const b = barOf(store, sym, d), fi = b ? ibsOf(b) : NaN, x = dec[sym], est = x && x.ok ? x.ibsEst : null, q = decided && day.quotes ? day.quotes[sym] : null;
    if (!b) dq.noBar.push(sym); else if (!fin(fi)) dq.highLeLow.push(sym);
    if (!x || !x.ok) dq.noDecision.push(sym); if (x && x.clamped) dq.clamped.push(sym);
    if (est != null) { tally(C.entrySignal, est < IBS_ENTRY, fin(fi) && fi < IBS_ENTRY); tally(C.exitSignal, est > IBS_EXIT, fin(fi) && fi > IBS_EXIT); }
    else { if (fin(fi) && fi < IBS_ENTRY) C.entrySignal.noDecision++; if (fin(fi) && fi > IBS_EXIT) C.exitSignal.noDecision++; }
    tally(C.entryAction, !!x && x.action === "BUY", shE.has(sym)); tally(C.exitAction, !!x && x.action === "SELL" && !x.owed, shX.has(sym));
    per.push({ sym, ibsEst: est, ibsFinal: fin(fi) ? r6(fi) : null, actual: x ? x.action : "no-decision", shadow: shE.has(sym) ? "BUY" : shX.has(sym) ? "SELL" : "none",
      decisionLast: q ? q.last : null, close: b ? b.c : null, closeVsDecisionLastPct: q && b && fin(q.last) ? r4(100 * (b.c / q.last - 1)) : null, high: b ? b.h : null, low: b ? b.l : null, decisionHigh: q ? q.high : null, decisionLow: q ? q.low : null });
  }
  return { kind: "day", key: `day:${d}`, date: d, decided, decidedEt: day ? day.decidedEt || null : null, late: day ? !!day.late : null, counts: C, dataQuality: dq, perEtf: per };
}
// days = state.days: a leg whose decision day was "late" (decided after close-5:00 + 30 s, i.e. by the backup fire) is flagged
function roundTripRow(l, store, lastFinal, days = {}) {
  const t = l.entryDate, u = l.exitDecisionDate;
  if (!u) return { wait: "no exit decision date" };
  if (!lastFinal || u > lastFinal) return { wait: `exit session ${u} not final yet` };
  const bt = barOf(store, l.sym, t), bu = barOf(store, l.sym, u);
  if (!bt || !bu) return { wait: `no official bar for ${l.sym} ${!bt ? t : u}` };
  const actual = l.exitFill / l.entryFill - 1, shadowRet = bu.c / bt.c - 1, ed = l.entryDecision || {}, xd = l.exitDecision || {}, fo = (l.exitOrders || []).filter((x) => x.filledQty > 0);
  return { row: { kind: "round-trip", key: `rt:${l.key}`, lot: l.key, sym: l.sym, entryDate: t, exitDecisionDate: u, exitCompleteDate: l.exitCompleteDate || null, qty: r8(l.qty),
    entryFill: l.entryFill, exitFill: l.exitFill, actualRet: r8(actual), shadowRet: r8(shadowRet), shortfallPct: r6(100 * (shadowRet - actual)),
    entryClose: bt.c, exitClose: bu.c, ibsFinalEntry: r6(ibsOf(bt)), ibsFinalExit: r6(ibsOf(bu)), ibsEstEntry: ed.ibsEst ?? null, ibsEstExit: xd.ibsEst ?? null,
    entryDecision: { last: ed.last ?? null, bid: ed.bid ?? null, ask: ed.ask ?? null, quoteTime: ed.quoteTime ?? null }, exitDecision: { last: xd.last ?? null, bid: xd.bid ?? null, ask: xd.ask ?? null, quoteTime: xd.quoteTime ?? null },
    entryFillVsClosePct: r6(100 * (l.entryFill / bt.c - 1)), exitFillVsClosePct: r6(100 * (1 - l.exitFill / bu.c)),
    entryFillVsDecisionLastPct: fin(ed.last) ? r6(100 * (l.entryFill / ed.last - 1)) : null, exitFillVsDecisionLastPct: fin(xd.last) ? r6(100 * (1 - l.exitFill / xd.last)) : null,
    entryDriftLastToClosePct: fin(ed.last) ? r6(100 * (bt.c / ed.last - 1)) : null, exitDriftLastToClosePct: fin(xd.last) ? r6(100 * (bu.c / xd.last - 1)) : null,
    entryDecidedEt: (days[t] && days[t].decidedEt) || null, exitDecidedEt: (days[u] && days[u].decidedEt) || null, lateLeg: !!(days[t] && days[t].late) || !!(days[u] && days[u].late),
    exitOrdersFilled: fo.length, owedRemainderSold: fo.some((x) => x.owed), feesNote: "Alpaca paper: no fees; fill-to-fill is net" } };
}
async function afterCloseLocked(ctx) {
  const P = ctx.paths, log = ctx.log, now = ctx.clock(), e = etParts(now), D = e.date, s = readJson(P.state, freshState());
  if (!s.firstLiveDecision && !s.lots.length) {
    log("R316 after-close — no live decision yet (the forward has not started); nothing to reconcile");
    writeStatusPart(ctx, "nightly", { date: D, asOf: iso(now), started: false, note: "waiting for the first --decide --live run (TRAIDS R316 1354 / 1357 tasks)" }); return 0;
  }
  let code = 0;
  const sessToday = await sessionOf(ctx.broker, D), dayOver = (d) => d < D || (!!sessToday && d === D && e.minsF >= sessToday.closeMins);
  const rec = await reconcileLots(ctx, s, { dayOver }); rec.notes.forEach((n) => log(`  ${n}`));
  s.lastRun.afterClose = D; saveState(ctx, s);
  let have = ledgerKeys(readLedger(P.ledger));
  // the registered stop: an order outside [close-10, close-1) ET or to a non-paper endpoint
  // A NEW violation (not yet in the ledger) halts: the HALT is written FIRST (escalating any other HALT kind — an interim-kill or operator
  // HALT lets exits through, a guard violation stops everything), then the ledger rows, then the alert. A violation already in the ledger
  // never re-halts: the operator reviewed it and removed the HALT (2026-10-02 review). While a guard-violation HALT stands, exit 1 nightly.
  const viol = guardAudit(s), freshViol = viol.filter((v) => !have.has(`guard:${v.cid}`));
  if (freshViol.length) {
    const curHalt = readJson(P.halt, null);
    if (!curHalt || curHalt.kind !== "guard-violation") saveJson(P.halt, { ...(curHalt ? { supersedes: curHalt } : {}), kind: "guard-violation", date: D, at: iso(now), why: freshViol.map((v) => `${v.cid}: ${v.why}`).join("; "), stopsExits: true, registry: "R316 interimKill: any order outside 15:50-15:59 ET or to a non-paper endpoint -> stop and alert" });
    for (const v of freshViol) appendLedger(ctx, { kind: "guard-violation", key: `guard:${v.cid}`, ...v });
    await alertOnce(ctx, D, "guard", "HALTED — an order outside the registered send window", freshViol.map((v) => `${v.cid} ${v.sentAt} (${v.field}): ${v.why}`).join("\n") + "\nNothing is sent until the operator reviews and removes backend/data/r316-HALT.json.");
    log(`GUARD VIOLATION — ${freshViol.length} new order(s); data/r316-HALT.json is guard-violation; nothing is sent until the operator removes it`);
  }
  const haltNow = readJson(P.halt, null);
  if (haltNow && haltNow.kind === "guard-violation") { code = 1; if (!freshViol.length) log(`HALT guard-violation (${haltNow.date}) still in place — nothing is sent until the operator reviews and removes data/r316-HALT.json`); }
  // official bars (R313's source); final = refreshed completely on a later ET date
  const store = readJson(P.bars, { spec: "r316-bars-v1", source: "Schwab marketdata/v1/pricehistory daily (R313's request form), split-adjusted price, regular session", bySym: {}, lastFullFetch: null });
  const br = await refreshBars(ctx, store, addDays(s.firstLiveDecision || s.lots[0].entryDate, -BAR_LEAD_DAYS), D, sessToday, now);
  for (const v of br.revisions) if (!have.has(`rev:${v.sym}:${v.d}:${D}`)) appendLedger(ctx, { kind: "bar-revision", key: `rev:${v.sym}:${v.d}:${D}`, ...v });
  if (!br.okAll) { code = 1; log(`official bars INCOMPLETE tonight (${br.errors.join("; ")}) — no session becomes final until a complete refresh`); await alertOnce(ctx, D, "bars", "official bars incomplete", br.errors.join("\n")); }
  const lf = store.lastFullFetch, sessions = await sessionsBetween(ctx.broker, s.firstLiveDecision || s.lots[0].entryDate, D);
  const finalDates = lf ? sessions.map((x) => x.date).filter((d) => d < lf.on && d <= lf.to) : [], lastFinal = finalDates[finalDates.length - 1] || null;
  have = ledgerKeys(readLedger(P.ledger));
  for (const d of finalDates) if (!have.has(`gap:${d}`) && !(s.days[d] && s.days[d].decision === true)) {
    const why = s.days[d] ? `decision attempts failed: ${(s.days[d].attempts || []).map((a) => a.error).filter(Boolean).join("; ")}` : "no decision run reached the window";
    appendLedger(ctx, { kind: "gap", key: `gap:${d}`, date: d, why, preEvidence: !s.evidenceStart || d < s.evidenceStart }); log(`  GAP ${d}: ${why} (logged, never back-filled)`);
    await alertOnce(ctx, D, `gap:${d}`, `missed decision ${d}`, why);
  }
  const sh = s.evidenceStart && lastFinal && lastFinal >= s.evidenceStart ? runShadow(store, s.evidenceStart, lastFinal) : null;
  for (const d of finalDates) if (s.evidenceStart && d >= s.evidenceStart && !have.has(`day:${d}`)) appendLedger(ctx, dayRow(d, s, store, sh));
  const waiting = [];
  for (const l of s.lots) if (l.status === "closed" && !have.has(`rt:${l.key}`)) { const r = roundTripRow(l, store, lastFinal, s.days); if (r.row) { appendLedger(ctx, r.row); log(`  ROUND TRIP ${l.sym} ${l.entryDate} -> ${l.exitDecisionDate}: fill-to-fill ${r4(100 * r.row.actualRet)}% · shadow ${r4(100 * r.row.shadowRet)}% · shortfall ${r4(r.row.shortfallPct)}%`); } else waiting.push(`${l.sym} ${l.key}: ${r.wait}`); }
  // nightly status
  const rows = readLedger(P.ledger); have = ledgerKeys(rows);
  const st = execStats(roundTripsOf(rows)), days = rows.filter((r) => r.kind === "day");
  // UNGATED diagnostic beside the registered statistic: calendar-time NW t of the daily book P&L (open lots marked to the official close)
  const fsEv = finalDates.filter((d) => s.evidenceStart && d >= s.evidenceStart), tCal = fsEv.length >= 3 ? nwTLag(bookDailyPnl(s.lots, store, fsEv)) : null;
  // INTERIM KILL = ONE interim look, on the first night with >= 40 round trips (the registry is silent on the look schedule; nightly looks
  // with the entry-day CR1 t stop a zero-edge arm for noise far above nominal — 2026-10-02 review: 14.9% before the 60-trip read and 46.8%
  // within 24 months, vs 11.7% for one look). The statistic and the bar are the registered ones (day-clustered t <= -2.0).
  const ikLook = rows.find((r) => r.key === "interim-kill-look") || null;
  const ik = { ...interimKill(st), schedule: "one look at the first after-close with >= 40 round trips", looked: ikLook ? { date: ikLook.date, roundTrips: ikLook.roundTrips, t: ikLook.t, triggered: ikLook.triggered } : null,
    diagnostic: { calendarNwT: r3(tCal), lag: KILL_NW_LAG, sessions: fsEv.length, gated: false, note: "calendar-time Newey-West t of the arm's daily book P&L (open lots marked to the official close); reported only — the registered kill statistic is the entry-day CR1 t" } };
  if (ik.applies && !ikLook) {
    if (ik.triggered && !have.has("interim-kill")) {
      const curHalt = readJson(P.halt, null), kill = { kind: "interim-kill", date: D, at: iso(now), why: `day-clustered t of fill-to-fill ${ik.t} <= ${INTERIM_T} at ${ik.roundTrips} round trips (the one interim look)`, stopsExits: false, registry: "R316 interimKill (amended 2026-10-02): one look at >= 40 round trips, day-clustered t <= -3.13 -> stop (kill only)" };
      if (!curHalt) saveJson(P.halt, kill);                                                   // HALT first, then the rows
      else if (curHalt.kind !== "guard-violation") saveJson(P.halt, { ...kill, supersedes: curHalt });
      else saveJson(P.halt, { ...curHalt, interimKill: kill });                                // the guard violation stays the stronger stop; the kill rides with it
      appendLedger(ctx, { kind: "interim-kill", key: "interim-kill", date: D, ...ik });
    }
    appendLedger(ctx, { kind: "interim-kill-look", key: "interim-kill-look", date: D, at: INTERIM_RT, bar: INTERIM_T, roundTrips: ik.roundTrips, t: ik.t, triggered: ik.triggered, diagnostic: ik.diagnostic });
    ik.looked = { date: D, roundTrips: ik.roundTrips, t: ik.t, triggered: ik.triggered };
    log(`  INTERIM-KILL LOOK (the one look) at ${ik.roundTrips} round trips: CR1 t ${ik.t} ${ik.triggered ? `<= ${INTERIM_T} — KILLED (no new entries; exits continue)` : `> ${INTERIM_T} — continues`} · calendar NW t (diagnostic) ${ik.diagnostic.calendarNwT}`);
    if (ik.triggered) await alertOnce(ctx, D, "interim-kill", "INTERIM KILL — R316 stopped (no new entries)", `fill-to-fill day-clustered t ${ik.t} <= ${INTERIM_T} at ${ik.roundTrips} round trips (the one interim look). Calendar-time NW t (diagnostic, ungated) ${ik.diagnostic.calendarNwT}. Exits continue under the rule; record and close (operator / main loop).`);
  }
  const agree = {}; for (const k of ["entrySignal", "exitSignal", "entryAction", "exitAction"]) agree[k] = days.reduce((a, r) => ({ both: a.both + r.counts[k].both, missed: a.missed + r.counts[k].missed, extra: a.extra + r.counts[k].extra, ...(k.endsWith("Signal") ? { noDecision: (a.noDecision || 0) + (r.counts[k].noDecision || 0) } : {}) }), { both: 0, missed: 0, extra: 0 });
  const lots = s.lots, cnt = (f) => lots.filter(f).length;
  const nightly = {
    date: D, asOf: iso(now), started: true, evidenceStart: s.evidenceStart, firstLiveDecision: s.firstLiveDecision, lastFinalSession: lastFinal, provisionalThrough: br.to,
    sessionsDecided: Object.values(s.days).filter((x) => x.decision === true).length, gaps: rows.filter((r) => r.kind === "gap" && !r.preEvidence).length, gapsPreEvidence: rows.filter((r) => r.kind === "gap" && r.preEvidence).length,
    lots: { active: cnt((l) => ACTIVE.includes(l.status)), open: cnt((l) => l.status === "open"), exitOwed: cnt((l) => l.status === "exit-owed"), closed: cnt((l) => l.status === "closed"), unfilled: cnt((l) => l.status === "unfilled"), rejected: cnt((l) => l.status === "rejected"), notSent: cnt((l) => ["not-sent", "entry-missing"].includes(l.status)) },
    roundTrips: st.n, roundTripsAwaitingFinalBars: waiting.length, execution: st, agreement: { days: days.length, ...agree },
    shadow: shadowReport(sh),
    // UNGATED, labelled (2026-10-02 review): the paired shortfall is measured on the live arm's own pairs, so it cannot see the cost of
    // choosing trades from a 15:55 IBS estimate; this puts R313's own forward trades beside the live arm's (different trade sets)
    unpairedAllIn: { shadowOwnGrossPctPerTrade: sh && sh.closed.length ? r4(100 * mean(sh.closed.map((x) => x.gross))) : null, shadowOwnClosed: sh ? sh.closed.length : 0, actualPctPerTrade: st.n ? st.meanFillToFillPct : null, actualRoundTrips: st.n,
      note: "R313's own forward trades (official closes) vs the live arm's fill-to-fill trades — different trade sets; includes the 15:55 selection effect the paired shortfall excludes; reported only" },
    interimKill: ik, executionRead: { at: MIN_RT, ready: st.n >= MIN_RT, remaining: Math.max(0, MIN_RT - st.n), ceilingPctPerRoundTrip: CEILING_PCT, how: "node backend/r316-ibs-forward.js --read-execution (prints; sealing is the main loop's)" },
    kill24: { due: s.evidenceStart ? addDays(s.evidenceStart, Math.round(KILL_MONTHS * 30.44)) : null, rule: "shadow's paired excess over the unrestricted-start placebo <= 0 -> stop (not auto-sealed here)" },
    halt: readJson(P.halt, null), off: fs.existsSync(P.off), barsComplete: br.okAll, guardViolations: viol.length, guardViolationsNew: freshViol.length };
  writeStatusPart(ctx, "nightly", nightly); saveState(ctx, s);
  printNightly(log, nightly);
  return code;
}
function printNightly(log, n) {
  if (!n || !n.started) return log(`R316 — not started${n && n.note ? ` (${n.note})` : ""}`);
  const x = n.execution || {}, sh = n.shadow, pl = sh && sh.placebo;
  log(`R316 ${n.date} — evidence from ${n.evidenceStart || "(no live order yet)"} · final through ${n.lastFinalSession || "—"} · decided ${n.sessionsDecided} session(s), gaps ${n.gaps}`);
  log(`  round trips ${x.n || 0}${x.n ? ` over ${x.entryDays} entry day(s): mean shortfall ${x.meanShortfallPct}%/round trip (day-clustered mean ${x.dayMeanShortfallPct}%, CR t ${x.shortfallCrT}) · fill-to-fill ${x.meanFillToFillPct}% (CR t ${x.fillToFillCrT}, win ${x.winRateFillToFillPct}%) · shadow same pairs ${x.meanShadowPct}%` : ""} · awaiting final bars ${n.roundTripsAwaitingFinalBars}`);
  log(`  lots: active ${n.lots.active} (open ${n.lots.open}, owed ${n.lots.exitOwed}) · closed ${n.lots.closed} · unfilled ${n.lots.unfilled} · rejected ${n.lots.rejected} · not sent ${n.lots.notSent}`);
  const a = n.agreement; log(`  IBS_est vs final over ${a.days} day(s): entry signals both ${a.entrySignal.both} / missed ${a.entrySignal.missed} / extra ${a.entrySignal.extra} / no decision ${a.entrySignal.noDecision || 0} · exit signals ${a.exitSignal.both}/${a.exitSignal.missed}/${a.exitSignal.extra}/${a.exitSignal.noDecision || 0} · actions entry ${a.entryAction.both}/${a.entryAction.missed}/${a.entryAction.extra}, exit ${a.exitAction.both}/${a.exitAction.missed}/${a.exitAction.extra}`);
  if (sh) log(`  shadow (R313 rule, official bars): ${sh.closed} closed / ${sh.open} open · mean net ${sh.meanNetPctPerTrade}%/trade · placebo (unrestricted) ${pl && pl.pairedMonths != null ? `paired excess ${pl.pairedExcessPctPerMonth}%/month t ${pl.pairedT} over ${pl.pairedMonths} month(s)` : (pl && pl.note) || "—"}`);
  if (n.unpairedAllIn && (n.unpairedAllIn.shadowOwnClosed || n.unpairedAllIn.actualRoundTrips)) log(`  unpaired (reported only): R313's own forward trades ${n.unpairedAllIn.shadowOwnGrossPctPerTrade ?? "—"}%/trade gross over ${n.unpairedAllIn.shadowOwnClosed} · live arm ${n.unpairedAllIn.actualPctPerTrade ?? "—"}%/trade over ${n.unpairedAllIn.actualRoundTrips}`);
  const ik = n.interimKill, lk = ik.looked;
  log(`  interim kill (one look at >= ${ik.at}): ${lk ? `LOOKED ${lk.date} at ${lk.roundTrips} round trips, CR1 t ${lk.t} ${lk.triggered ? `<= ${INTERIM_T} TRIGGERED` : `> ${INTERIM_T} — continues`}` : ik.applies ? `due now (t ${ik.t})` : `not yet (${ik.roundTrips}/${ik.at})`}${ik.diagnostic && ik.diagnostic.calendarNwT != null ? ` · calendar NW t ${ik.diagnostic.calendarNwT} (diagnostic)` : ""} · execution read (>= ${n.executionRead.at}): ${n.executionRead.ready ? "READY" : `${n.executionRead.remaining} to go`} · 24-month kill due ${n.kill24.due || "—"}${n.halt ? ` · HALT ${n.halt.kind}` : ""}${n.off ? " · OFF" : ""}`);
}

// ── STATUS / READ / DRY ─────────────────────────────────────────────────────────────────────────────────────────────────────
function runStatus(ctx) {
  const P = ctx.paths, s = readJson(P.state, freshState()), st = readJson(P.status, freshStatus()), rows = readLedger(P.ledger);
  ctx.log(`R316 status (local files) — evidenceStart ${s.evidenceStart || "—"} · first live decision ${s.firstLiveDecision || "—"} · lots ${s.lots.length} · ledger rows ${rows.length}`);
  if (st.decide) ctx.log(`  last decide ${st.decide.date} ${st.decide.decidedEt || ""} by ${st.decide.by}: planned ${st.decide.planned}, sent ${st.decide.sent}, adopted ${st.decide.adopted}, rejected ${st.decide.rejected}, not sent ${st.decide.refused}${st.decide.issues && st.decide.issues.length ? ` · issues: ${st.decide.issues.join(" | ")}` : ""}`);
  printNightly(ctx.log, st.nightly);
  const x = execStats(roundTripsOf(rows)); ctx.log(`  from the ledger now: ${x.n} round trip(s)${x.n ? `, mean shortfall ${x.meanShortfallPct}%` : ""}`);
  for (const l of s.lots.filter((l) => ACTIVE.includes(l.status))) ctx.log(`  lot ${l.key} ${l.status}${l.qtyStr ? ` ${l.qtyStr} @ ${l.entryFill}` : ""}`);
  return 0;
}
function runReadExecution(ctx) {
  const P = ctx.paths, log = ctx.log, reg = readJson(P.registry, null);
  const entry = reg && [...(reg.preregistered || []), ...(reg.tests || [])].find((t) => t.id === ID);
  if (!entry || !entry.bar) { log("R316 not found in the registry (or no bar) — refusing"); return 2; }
  if (entry.bar.executionCostCeilingPctPerRoundTrip !== CEILING_PCT || entry.bar.minRoundTrips !== MIN_RT) { log(`registry bar ${JSON.stringify(entry.bar)} differs from this runner's (${CEILING_PCT}%, ${MIN_RT}) — refusing`); return 2; }
  const rts = roundTripsOf(readLedger(P.ledger));
  if (rts.length < MIN_RT) { log(`R316 execution read REFUSED — ${rts.length} completed round trip(s) < ${MIN_RT} (registered: execution read once at >= ${MIN_RT}); nothing decided, nothing written`); return 2; }
  const st = execStats(rts), ok = st.meanShortfallPct <= CEILING_PCT, seals = readJson(P.seals, {}), sealed = (seals.tests || seals)[ID];
  log(`R316 EXECUTION READ (print only) — ${st.n} round trips over ${st.entryDays} entry days`);
  log(`  mean all-in shortfall ${st.meanShortfallPct}% per round trip (ceiling ${CEILING_PCT}%) · day-clustered mean ${st.dayMeanShortfallPct}% · CR t ${st.shortfallCrT} · fill-to-fill ${st.meanFillToFillPct}% (CR t ${st.fillToFillCrT}) · shadow ${st.meanShadowPct}%`);
  log(ok ? `  EXECUTION OK — ${st.meanShortfallPct}% <= ${CEILING_PCT}% per round trip: the arm continues as a weightless forward record under the 24-month kill`
    : `  EXECUTION FAILS — ${st.meanShortfallPct}% > ${CEILING_PCT}% per round trip: stop; the IBS sleeve is not executable at our costs; recorded and closed`);
  log(`  registry decisionRule.executionRead: ${entry.decisionRule.executionRead}`);
  log(`  ${sealed ? `NOTE: read-seals.json already holds R316 (${JSON.stringify(sealed).slice(0, 120)})` : "not sealed — sealing (read-seals.json + registry status) is the main loop's, not this runner's"}`);
  return 0;
}
async function runDry(ctx, note) {
  const P = ctx.paths, log = ctx.log, now = ctx.clock(), e = etParts(now);
  log(`R316 DRY${note ? ` (${note})` : ""} — ${e.date} ${e.hms} ET (${e.wd}) · read-only: no POST, nothing written`);
  log(`  switches: TRAIDS_STOP ${fs.existsSync(P.stop) ? "PRESENT" : "absent"} · r316-HALT ${fs.existsSync(P.halt) ? JSON.stringify(readJson(P.halt, null)) : "absent"} · r316-OFF ${fs.existsSync(P.off) ? "PRESENT" : "absent"} · TV keys ${ctx.broker.hasKeys ? "present" : "MISSING (a live run refuses)"} · host ${ctx.broker.host}`);
  const sess = await sessionOf(ctx.broker, e.date), next = (await sessionsBetween(ctx.broker, addDays(e.date, 1), addDays(e.date, 10)))[0];
  const ref = sess || next;
  if (sess) log(`  today is a session (close ${sess.close} ET)`); else log(`  today is NOT a session; next session ${next ? `${next.date} (close ${next.close})` : "—"}`);
  if (ref) log(`  ${sess ? "today" : next.date}: decision window ${hm(ref.closeMins - WIN_FROM)}-${hm(ref.closeMins - LAST_SEND)} ET · decide at ${hm(ref.closeMins - DECIDE_AT)}:00 · hard send guard ${hm(ref.closeMins - GUARD_FROM)}:00-${hms(ref.closeMins - LAST_SEND - END_MARGIN_S / 60)} ET (audit ${hm(ref.closeMins - GUARD_FROM)}-${hm(ref.closeMins - LAST_SEND)}) · tasks 13:54 / 13:57 MT = 15:54 / 15:57 ET (early-close days 10:54 / 10:57 MT)`);
  const inWin = !!sess && decideWindow(now, sess), rth = !!sess && e.minsF >= 9 * 60 + 30 && e.minsF < sess.closeMins;
  if (!inWin) log(`  NOW IS OUTSIDE ${rth ? "THE DECISION WINDOW" : "MARKET HOURS"} — a live run would decide nothing now. Below: what it WOULD compute from the last quotes, MARKED STALE.`);
  const ck = await ctx.broker.clock(); log(`  Alpaca clock: is_open ${ck.is_open} · broker time ${ck.timestamp} · local skew ${((now - Date.parse(ck.timestamp)) / 1000).toFixed(1)} s · next_open ${ck.next_open} · next_close ${ck.next_close}`);
  const pos = await ctx.broker.positions(), account = Object.fromEntries(pos.map((p) => [p.symbol, +p.qty]));
  const inU = pos.filter((p) => UNIVERSE.includes(p.symbol));
  log(`  TV account positions: ${pos.length} total · in the 20 ETFs: ${inU.length ? inU.map((p) => `${p.symbol} ${p.qty}`).join(", ") : "none"}`);
  const oo = await ctx.broker.openOrders(); log(`  open orders on the TV account: ${oo.length}${oo.filter((o) => UNIVERSE.includes(o.symbol)).length ? ` (in the 20: ${oo.filter((o) => UNIVERSE.includes(o.symbol)).map((o) => `${o.symbol} ${o.side} ${o.client_order_id}`).join(", ")})` : ""} · r316- ids: ${oo.filter((o) => String(o.client_order_id).startsWith(CID_PREFIX)).length}`);
  const bad = [];
  for (const sym of UNIVERSE) { try { const a = await ctx.broker.asset(sym); if (!(a.tradable && a.fractionable)) bad.push(`${sym} tradable ${a.tradable} fractionable ${a.fractionable}`); } catch (err) { bad.push(`${sym} asset lookup failed (${String(err.message).slice(0, 40)})`); } }
  log(`  assets: ${bad.length ? `PROBLEMS — ${bad.join("; ")}` : "all 20 tradable and fractionable on Alpaca"}`);
  const s = readJson(P.state, freshState());
  log(`  state: evidenceStart ${s.evidenceStart || "—"} · first live decision ${s.firstLiveDecision || "—"} · active lots ${s.lots.filter((l) => ACTIVE.includes(l.status)).length}`);
  const t0 = ctx.clock(); let quotes; try { quotes = await ctx.quotes(UNIVERSE); } catch (err) { log(`  Schwab quotes FAILED: ${err.message} — a live run would make NO decision today (logged gap)`); return 1; }
  const live = decideAll({ quotes, nowMs: t0, state: s, account });
  const newest = Math.max(...Object.values(quotes).map((q) => q.quoteTime || 0));
  const fresh = Object.fromEntries(Object.entries(quotes).map(([k, q]) => [k, { ...q, quoteTime: t0 - 1000, realtime: true }]));
  const asIf = decideAll({ quotes: fresh, nowMs: t0, state: s, account });   // as if each ETF's last quote were 1 s old (display only)
  log(`  Schwab /quotes: ${Object.keys(quotes).length}/20 returned in one call (${((ctx.clock() - t0) / 1000).toFixed(2)} s) · newest quoteTime ${newest ? etParts(newest).date + " " + etParts(newest).hms + " ET" : "—"}`);
  log(`  ${"ETF".padEnd(4)} ${"last".padStart(9)} ${"high".padStart(9)} ${"low".padStart(9)} ${"bid".padStart(9)} ${"ask".padStart(9)}  quoteTime(ET)      age s   IBS_est  ${"WOULD (as-if fresh)".padEnd(38)}  live verdict now`);
  for (let i = 0; i < UNIVERSE.length; i++) {
    const sym = UNIVERSE[i], q = quotes[sym] || {}, a = asIf[i], l = live[i], f = (x) => (fin(x) ? String(x) : "—").padStart(9), qt = fin(q.quoteTime) ? `${etParts(q.quoteTime).date.slice(5)} ${etParts(q.quoteTime).hms}` : "—";
    const would = a.action === "BUY" ? `BUY $${NOTIONAL} ${cidFor(sym, ref ? ref.date : e.date, "B")}` : a.action === "SELL" ? `SELL ${a.qty} ${cidFor(sym, ref ? ref.date : e.date, "S")}` : a.ok ? a.action : `no decision (${a.why})`;
    log(`  ${sym.padEnd(4)} ${f(q.last)} ${f(q.high)} ${f(q.low)} ${f(q.bid)} ${f(q.ask)}  ${qt.padEnd(17)} ${String(l.ageS ?? "—").padStart(7)}  ${(String(a.ibsEst ?? "—") + (a.clamped ? "*" : " ")).padStart(9)} ${would.padEnd(38)}  ${l.ok ? l.action : `STALE / no decision: ${l.why}`}`);
  }
  const reg = Object.values(quotes).filter((q) => fin(q.regLast) && fin(q.last) && Math.abs(q.regLast - q.last) > 1e-9).length;
  if (asIf.some((x) => x.clamped)) log(`  * last outside the quote's [low, high] — the range is widened to it (IBS 0 or 1): ${asIf.filter((x) => x.clamped).map((x) => x.sym).join(" ")}`);
  log(`  note: ${reg} of 20 lastPrice values differ from regularMarketLastPrice now (extended-hours prints); at 15:55 ET lastPrice is the regular session's. Whether Schwab's highPrice/lowPrice include pre-market prints is checked by the after-close (decision high/low vs the official bar, every day row).`);
  return 0;
}

// ── SELFTEST (temp dir, fake broker / quotes / bars / notify; no network, no real file touched) ──────────────────────────────
function fakeWorld(t0) {
  const w = { t: t0, sessions: {}, account: {}, orders: new Map(), posts: [], quotes: {}, bars: {}, notes: [], logs: [], quoteCalls: 0, clockSkewMs: 0, isOpen: true, host: PAPER };
  w.now = () => w.t; return w;
}
function fakeBroker(w) {
  return {
    host: w.host, hasKeys: true,
    calendar: async (a, b) => Object.keys(w.sessions).filter((d) => d >= a && d <= b).sort().map((d) => ({ date: d, open: "09:30", close: w.sessions[d] })),
    clock: async () => ({ is_open: w.isOpen, timestamp: new Date(w.t + w.clockSkewMs).toISOString() }),
    positions: async () => Object.entries(w.account).filter(([, q]) => Math.abs(q) > EPS).map(([symbol, q]) => ({ symbol, qty: String(q) })),
    openOrders: async () => [...w.orders.values()].filter((o) => !TERMINAL.includes(o.status)),
    asset: async (s) => ({ symbol: s, tradable: true, fractionable: true }),
    orderByCid: async (cid) => (w.orders.has(cid) ? { ...w.orders.get(cid) } : null),
    submit: async (body) => {
      w.posts.push({ ...body, at: w.t });
      if (w.rejectNext) { const m = w.rejectNext; w.rejectNext = null; const e = new Error(`403 ${m}`); e.status = 403; throw e; }
      if (w.orders.has(body.client_order_id)) { const e = new Error('422 {"message":"client_order_id must be unique"}'); e.status = 422; throw e; }
      const o = { id: `o${w.posts.length}`, client_order_id: body.client_order_id, symbol: body.symbol, side: body.side, notional: body.notional || null, qty: body.qty || null, type: body.type, time_in_force: body.time_in_force,
        status: "new", created_at: new Date(w.t).toISOString(), submitted_at: new Date(w.t + (w.submitLagMs || 0)).toISOString(), filled_qty: "0", filled_avg_price: null, filled_at: null };
      w.orders.set(o.client_order_id, o);
      if (w.loseNextResponse) { w.loseNextResponse = false; throw new Error("fetch failed (simulated lost answer)"); }
      if (w.crashAfterPost) { w.crashAfterPost = false; const e = new Error("SIMULATED CRASH"); e.crash = true; throw e; }
      return { ...o };
    },
  };
}
// fills every working order: buys at px (notional / px shares), sells at px; part[sym] = fraction of a sell that fills (expired remainder)
function fillAll(w, px, part = {}) {
  for (const o of w.orders.values()) {
    if (TERMINAL.includes(o.status)) continue;
    const p = px[o.symbol]; if (!fin(p)) { o.status = "expired"; continue; }
    const q = o.side === "buy" ? +(+o.notional / p).toFixed(9) : +(+o.qty * (part[o.symbol] ?? 1)).toFixed(9);
    o.filled_qty = String(q); o.filled_avg_price = q > 0 ? String(p) : null; o.filled_at = q > 0 ? new Date(w.t).toISOString() : null;
    o.status = o.side === "sell" && q + EPS < +o.qty ? "expired" : q > 0 ? "filled" : "expired";
    w.account[o.symbol] = +(((w.account[o.symbol] || 0) + (o.side === "buy" ? q : -q)).toFixed(9));
  }
}
const qOf = (ibs, w, { base = 100, ageS = 1 } = {}) => ({ last: +(base - 1 + 2 * ibs).toFixed(4), high: base + 1, low: base - 1, bid: +(base - 1 + 2 * ibs - 0.01).toFixed(4), ask: +(base - 1 + 2 * ibs + 0.01).toFixed(4), quoteTime: w.t - ageS * 1000, tradeTime: w.t - ageS * 1000, realtime: true });
function testCtx(dir, w, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  return { paths: pathsFor(dir), live: true, by: "selftest", clock: () => w.t, sleep: async (ms) => { w.t += Math.max(0, ms); }, broker: fakeBroker(w),
    quotes: async () => { w.quoteCalls++; if (w.quoteError) throw new Error(w.quoteError); const out = {}; for (const [k, v] of Object.entries(w.quotes)) out[k] = typeof v === "function" ? v() : { ...v }; return out; },
    dailyBars: async (sym, a, b) => { if (w.barsError && w.barsError[sym]) throw new Error(w.barsError[sym]); return ((w.bars[sym] || [])).filter((x) => x.d >= a && x.d <= b).map((x) => ({ ...x })); },
    notify: async (t, b) => { w.notes.push({ t, b }); return true; }, log: (...a) => w.logs.push(a.join(" ")), bootMs: () => w.t - 3600e3, pidAlive: () => true, ...extra };
}
async function selftest() {
  const checks = {}, detail = {}, tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "r316-selftest-"));
  const realData = path.join(__dirname, "data"), realFiles = ["r316-state.json", "r316-ledger.jsonl", "r316-bars.json", "r316-status.json", "r316.lock", "r316-HALT.json"];
  const before = Object.fromEntries(realFiles.map((f) => { try { const s = fs.statSync(path.join(realData, f)); return [f, `${s.size}:${s.mtimeMs}`]; } catch { return [f, null]; } }));
  const ET = (date, hhmmss) => { const [h, m, s] = hhmmss.split(":").map(Number); return Date.parse(`${date}T${String(h + 4).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s || 0).padStart(2, "0")}Z`); };   // EDT (Oct 2026) = UTC-4
  const near = (a, b, tol = 1e-9) => fin(a) && fin(b) && Math.abs(a - b) <= tol;
  try {
    // (a) IBS estimate edge cases, quote staleness
    { const T = 1e12, q = (o) => ({ last: 99.1, high: 101, low: 99, quoteTime: T - 1000, realtime: true, ...o });
      const A = ibsEstimate(q(), T), B = ibsEstimate(q({ high: 99, low: 99 }), T), C = ibsEstimate(q({ last: 98.5 }), T), Dd = ibsEstimate(q({ last: 101.5 }), T);
      const E60 = ibsEstimate(q({ quoteTime: T - 60000 }), T), E61 = ibsEstimate(q({ quoteTime: T - 61000 }), T), Fu = ibsEstimate(q({ quoteTime: T + 31000 }), T), Fu29 = ibsEstimate(q({ quoteTime: T + 29000 }), T);
      const G = ibsEstimate(q({ quoteTime: null }), T), Hh = ibsEstimate(q({ realtime: false }), T), I = ibsEstimate(q({ last: NaN }), T), J = ibsEstimate(null, T), K = ibsEstimate(q({ high: 98 }), T);
      checks.a_ibsEdgeCases = A.ok && near(A.ibs, 0.05) && !B.ok && /high <= low/.test(B.why) && C.ok && C.ibs === 0 && C.clamped && Dd.ok && Dd.ibs === 1 && Dd.clamped && !K.ok
        && E60.ok && !E61.ok && E61.stale && !Fu.ok && Fu29.ok && !G.ok && !Hh.ok && !I.ok && !J.ok;
      // strict thresholds: exactly 0.1 is no entry, exactly 0.9 is no exit (R313: < 0.1, > 0.9)
      const w0 = fakeWorld(T), st = freshState(), mk = (ibs) => ({ last: 99 + 2 * ibs, high: 101, low: 99, quoteTime: T - 1000, realtime: true });
      const ex = (last) => ({ last, high: 20, low: 10, quoteTime: T - 1000, realtime: true });   // (11-10)/10 === 0.1 and (19-10)/10 === 0.9 exactly in doubles
      if (ibsEstimate(ex(11), T).ibs !== 0.1 || ibsEstimate(ex(19), T).ibs !== 0.9) throw new Error("exact-threshold fixture is not exact");
      const d1 = decideAll({ quotes: { SPY: ex(11), IWM: mk(0.0999) }, nowMs: T, state: st, account: {} });
      const st2 = freshState(); st2.lots.push({ key: "k", sym: "SPY", status: "open", qty: 2, qtyStr: "2", exitOrders: [] }, { key: "k2", sym: "IWM", status: "open", qty: 2, qtyStr: "2", exitOrders: [] });
      const d2 = decideAll({ quotes: { SPY: ex(19), IWM: mk(0.9001) }, nowMs: T, state: st2, account: { SPY: 2, IWM: 2 } });
      checks.a_strictThresholds = d1.find((x) => x.sym === "SPY").action === "none" && d1.find((x) => x.sym === "IWM").action === "BUY" && d2.find((x) => x.sym === "SPY").action === "hold" && d2.find((x) => x.sym === "IWM").action === "SELL" && d2.find((x) => x.sym === "IWM").qty === "2";
      // R313's own ibsOf agrees on bars
      checks.a_ibsOfAgrees = near(ibsOf({ h: 101, l: 99, c: 99.1 }), 0.05) && !fin(ibsOf({ h: 99, l: 99, c: 99 })); void w0; }
    // (b) the time guards
    { const S = { date: "2026-10-05", closeMins: 960 }, E = { date: "2026-11-27", closeMins: 780 }, et = (d, x) => ET(d, x), ETs = (d, x) => Date.parse(`${d}T${x}Z`);
      checks.b_sendWindow = windowCheck(et("2026-10-05", "15:49:59"), S) !== null && windowCheck(et("2026-10-05", "15:50:00"), S) === null && windowCheck(et("2026-10-05", "15:58:54"), S) === null
        && windowCheck(et("2026-10-05", "15:58:56"), S) !== null && windowCheck(et("2026-10-05", "15:58:59"), S, 0) === null && windowCheck(et("2026-10-05", "15:59:00"), S, 0) !== null
        && windowCheck(et("2026-10-06", "15:55:00"), S) !== null && windowCheck(ETs("2026-11-27", "17:50:00"), E) === null /* 12:50 EST */ && windowCheck(ETs("2026-11-27", "17:59:00"), E, 0) !== null && windowCheck(ETs("2026-11-27", "20:55:00"), E) !== null;
      checks.b_decideWindow = !decideWindow(et("2026-10-05", "15:53:59"), S) && decideWindow(et("2026-10-05", "15:54:00"), S) && decideWindow(et("2026-10-05", "15:58:59"), S) && !decideWindow(et("2026-10-05", "15:59:00"), S)
        && decideWindow(ETs("2026-11-27", "17:54:00"), E) && !decideWindow(ETs("2026-11-27", "20:54:00"), E);
      const L = et("2026-10-05", "15:55:00");
      checks.b_clockCheck = clockCheck({ is_open: true, timestamp: "2026-10-05T15:55:01.123456789-04:00" }, S, L) === null && clockCheck({ is_open: false, timestamp: iso(L) }, S, L) !== null
        && /off Alpaca/.test(clockCheck({ is_open: true, timestamp: iso(L + 31000) }, S, L)) && clockCheck({ is_open: true, timestamp: iso(L + 29000) }, S, L) === null && clockCheck({ is_open: true, timestamp: "garbage" }, S, L) !== null;
      checks.b_cidFormat = cidFor("SPY", "2026-10-05", "B") === "r316-SPY-20261005-B" && cidFor("EWA", "2026-12-24", "S") === "r316-EWA-20261224-S" && qstr(9.990009990) === "9.99000999" && qstr(2) === "2" && qstr(1.0000000004) === "1"; }
    // (c) statistics: CR1 with one row per cluster = ordinary t; shortfall arithmetic; interim kill boundary
    { const v = [0.3, -0.1, 0.2, 0.05, -0.02], t1 = clusterT(v, v.map((_, i) => i)), m = mean(v), sd = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1)), tt = m / (sd / Math.sqrt(v.length));
      const two = clusterT([1, 1, -1, -1], ["a", "a", "b", "b"]);
      checks.c_clusterT = near(t1, tt, 1e-12) && two === 0 && clusterT([1, 2], ["a", "a"]) === null;
      const rt = roundTripRow({ key: "k", sym: "SPY", entryDate: "2026-10-05", exitDecisionDate: "2026-10-06", entryFill: 100.10, exitFill: 101.00, qty: 9.99000999, entryDecision: { last: 100.02, ibsEst: 0.05 }, exitDecision: { last: 101.15, ibsEst: 0.95 }, exitOrders: [] },
        { bySym: { SPY: { "2026-10-05": { o: 100.2, h: 100.5, l: 99.95, c: 100.00 }, "2026-10-06": { o: 100.1, h: 101.25, l: 100.0, c: 101.20 } } } }, "2026-10-06").row;
      checks.c_shortfallArithmetic = !!rt && near(rt.actualRet, 0.00899101, 1e-8) && near(rt.shadowRet, 0.012, 1e-12) && near(rt.shortfallPct, 0.300899, 1e-6) && near(rt.entryFillVsClosePct, 0.1, 1e-9) && near(rt.exitFillVsClosePct, 100 * (1 - 101 / 101.2), 1e-6)
        && roundTripRow({ key: "k", sym: "SPY", entryDate: "2026-10-05", exitDecisionDate: "2026-10-06", entryFill: 1, exitFill: 1, exitOrders: [] }, { bySym: {} }, "2026-10-05").wait != null;
      const mkRts = (n, f) => Array.from({ length: n }, (_, i) => ({ kind: "round-trip", key: `rt:${i}`, entryDate: `2026-${String(10 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`, actualRet: f(i), shadowRet: 0, shortfallPct: 0 }));
      const neg = (i) => -0.004 + (i % 2 ? 0.001 : -0.001), k39 = interimKill(execStats(mkRts(39, neg))), k40 = interimKill(execStats(mkRts(40, neg))), k40p = interimKill(execStats(mkRts(40, (i) => 0.001 + (i % 2 ? 0.001 : -0.001))));
      checks.c_interimKill = !k39.applies && !k39.triggered && k40.applies && k40.triggered && k40.t <= -2 && k40p.applies && !k40p.triggered; }
    // (d) the decision rule: one lot per ETF, skip-if-held-by-other, exit not held, owed exits re-sent whatever the signal, stuck exits stop
    { const T = 1e12, mk = (ibs) => ({ last: 99 + 2 * ibs, high: 101, low: 99, quoteTime: T - 1000, realtime: true }), st = freshState();
      st.lots.push({ key: "a", sym: "SPY", status: "open", qty: 5, qtyStr: "5", exitOrders: [] }, { key: "b", sym: "IWM", status: "exit-owed", qty: 4, qtyStr: "4", exitFilledQty: 1.5, exitOrders: [{ done: true, filledQty: 1.5 }] },
        { key: "c", sym: "MDY", status: "exit-owed", qty: 3, qtyStr: "3", exitFilledQty: 0, exitOrders: [{ done: true, filledQty: 0 }, { done: true, filledQty: 0 }, { done: true, filledQty: 0 }] },
        { key: "d", sym: "XLK", status: "open", qty: 7, qtyStr: "7", exitOrders: [] }, { key: "e", sym: "XLF", status: "pending", exitOrders: [] });
      const d = Object.fromEntries(decideAll({ quotes: { SPY: mk(0.05), IWM: mk(0.5), MDY: mk(0.5), XLK: mk(0.95), XLF: mk(0.01), DIA: mk(0.02), XLE: mk(0.03), EWA: mk(0.04) }, nowMs: T, state: st, account: { SPY: 5, IWM: 2.5, MDY: 3, XLK: 6, DIA: 3, XLE: -2 } }).map((x) => [x.sym, x]));
      checks.d_oneLotPerEtf = d.SPY.action === "hold" && d.XLF.action === "wait-pending";
      checks.d_skipHeldByOther = d.DIA.action === "skip-held-by-other" && d.XLE.action === "skip-held-by-other" && d.EWA.action === "BUY" && d.EWA.notional === NOTIONAL;
      checks.d_owedExit = d.IWM.action === "SELL" && d.IWM.owed === true && d.IWM.qty === "2.5" && d.MDY.action === "exit-stuck" && d.XLK.action === "exit-refused-not-held";
      const blocked = Object.fromEntries(decideAll({ quotes: { EWA: mk(0.04), XLK: mk(0.95) }, nowMs: T, state: st, account: { XLK: 7 }, entriesBlocked: "OFF" }).map((x) => [x.sym, x]));
      checks.d_offBlocksEntriesNotExits = blocked.EWA.action === "entry-blocked" && blocked.XLK.action === "SELL";
      const st3 = freshState(); st3.lots.push({ key: "z", sym: "XLU", status: "open", qty: 3, qtyStr: "3", exitOrders: [] });
      const day3 = { date: "2026-10-05", decidedAt: "x", quotes: {}, planned: [], sends: {}, decisions: decideAll({ quotes: { SPY: mk(0.02), XLU: mk(0.97) }, nowMs: T, state: st3, account: { XLU: 3 } }) };
      planOrders(st3, day3);
      checks.d_exitsPlannedFirst = day3.planned.length === 2 && day3.planned[0].side === "sell" && day3.planned[0].cid === "r316-XLU-20261005-S" && day3.planned[1].cid === "r316-SPY-20261005-B" && st3.lots[0].status === "exiting" && st3.lots[1].status === "planned"; }
    // (e) unrestricted placebo: entry-signal days are eligible (R313's restricted prep excluded them); disjoint windows; deterministic
    { const mkBars = (seed, n) => { const rng = R313.mulberry(seed), out = []; let c = 100, d = "2026-09-01"; for (let i = 0; i < n; i++) { while (isWeekend(d)) d = addDays(d, 1); const o = c * (1 + (rng() - 0.5) * 0.01), h = Math.max(o, c) * (1 + rng() * 0.01), l = Math.min(o, c) * (1 - rng() * 0.01); c = l + (h - l) * rng(); out.push({ t: d, o, h, l, c, v: 1000 }); d = addDays(d, 1); } return out; };
      const PS = {}, trades = []; for (const [k, sym] of ["SPY", "IWM", "DIA"].entries()) { PS[sym] = prep(mkBars(11 + k, 120), { from: "2026-09-15", to: "2027-02-10" }); trades.push(...simulate(PS[sym], sym).closed.map((x) => ({ ...x, net: x.gross - COST }))); }
      const pu = placeboPrepU(trades, PS), pc = R313.placeboPrepC(trades, PS), sigIn = (sl) => sl.same.some((i) => PS[sl.sym].sig[i]);
      let disjoint = true, n = 0;
      const pl1 = placeboRunC(pu, PS, { draws: 50, seed: 313, cost: COST, record: (sl, i, H) => { n++; if (!(i + H < sl.t - 3 || i > sl.u)) disjoint = false; } }), pl2 = placeboRunC(pu, PS, { draws: 50, seed: 313, cost: COST });
      checks.e_placeboUnrestricted = trades.length >= 5 && pu.slots.some(sigIn) && !pc.slots.some(sigIn) && pu.slots.every((s, k) => s.same.length >= pc.slots[k].same.length) && disjoint && n > 0 && JSON.stringify(pl1.monthPlaceboMean) === JSON.stringify(pl2.monthPlaceboMean);
      detail.e = { trades: trades.length, slotsWithSignalDays: pu.slots.filter(sigIn).length }; }
    // (f) FULL FLOW in a temp dir: decide (wait, one quote call, skip-held, stale, high=low), backup = no re-send, fills, after-close (provisional
    //     then final), agreement rows, round trips (incl. a partial exit owed and re-sent), no duplicate rows on re-runs, a gap.
    { const dir = path.join(tmpRoot, "flow"), w = fakeWorld(ET("2026-10-05", "15:54:00")), ctx = testCtx(dir, w);
      for (const d of ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12"]) w.sessions[d] = "16:00";
      const setQ = (m) => { w.quotes = {}; for (const sym of UNIVERSE) { const v = m[sym]; w.quotes[sym] = v === undefined ? () => qOf(0.5, w) : typeof v === "function" ? v : () => qOf(v, w); } };
      // day 1
      w.account.DIA = 3;                                                                          // another runner holds DIA
      setQ({ SPY: 0.05, XLK: 0.08, DIA: 0.02, EWA: () => qOf(0.01, w, { ageS: 61 }), XLE: () => ({ ...qOf(0.5, w), high: 100, low: 100 }) });
      const c1 = await runDecide(ctx), s1 = readJson(ctx.paths.state), dd1 = s1.days["2026-10-05"];
      checks.f_day1Decide = c1 === 0 && w.quoteCalls === 1 && w.posts.length === 2 && w.posts.every((p) => p.type === "market" && p.time_in_force === "day" && p.side === "buy" && p.notional === "1000")
        && w.posts.map((p) => p.client_order_id).join(",") === "r316-SPY-20261005-B,r316-XLK-20261005-B" && etParts(w.posts[0].at).hms === "15:55:00" && s1.evidenceStart === "2026-10-05"
        && dd1.decisions.find((x) => x.sym === "DIA").action === "skip-held-by-other" && !dd1.decisions.find((x) => x.sym === "EWA").ok && !dd1.decisions.find((x) => x.sym === "XLE").ok && dd1.done;
      w.t = ET("2026-10-05", "15:57:00"); const c1b = await runDecide(ctx);
      checks.f_backupSendsNothing = c1b === 0 && w.posts.length === 2 && w.quoteCalls === 1 && w.logs.some((l) => /already decided today/.test(l));
      w.t = ET("2026-10-05", "15:55:30"); fillAll(w, { SPY: 100.10, XLK: 50.00 });
      // bars (official): 10-05 SPY IBS 0.0909 (both), XLK 0.15 (extra entry), IWM 0.05 (missed entry); 10-06 SPY/IWM exit; 10-07 XLK exit
      const B = (sym, d, o, h, l, c) => { (w.bars[sym] = w.bars[sym] || []).push({ d, o, h, l, c, v: 1e6 }); };
      for (const sym of UNIVERSE) for (const d of ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]) B(sym, d, 100, 101, 99, 100);
      const day = (d, m) => { for (const sym of UNIVERSE) { const v = m[sym]; if (v) B(sym, d, ...v); else B(sym, d, 100, 101, 99, 100); } };
      day("2026-10-05", { SPY: [100.2, 100.5, 99.95, 100.00], XLK: [50.5, 51, 49, 49.3], IWM: [100, 101, 99, 99.1], DIA: [100, 101, 99, 99.12] });   // DIA: a real dip the actual skipped (held by another runner)
      w.t = ET("2026-10-05", "16:20:00"); const a1 = await runAfterClose(ctx), s1a = readJson(ctx.paths.state), L1 = readLedger(ctx.paths.ledger);
      checks.f_afterClose1 = a1 === 0 && s1a.lots.filter((l) => l.status === "open").length === 2 && s1a.lots.find((l) => l.sym === "SPY").qtyStr === "9.99000999" && !L1.some((r) => r.kind === "day") && !L1.some((r) => r.kind === "round-trip");
      // day 2: SPY exits (est 0.95)
      w.t = ET("2026-10-06", "15:54:00"); setQ({ SPY: 0.95 }); await runDecide(ctx);
      const p2 = w.posts.slice(2); w.t = ET("2026-10-06", "15:55:20"); fillAll(w, { SPY: 101.00 });
      day("2026-10-06", { SPY: [100.1, 101.25, 100.0, 101.20], IWM: [99.2, 100.5, 99.0, 100.45] });
      w.t = ET("2026-10-06", "16:20:00"); await runAfterClose(ctx); const L2 = readLedger(ctx.paths.ledger), d05 = L2.find((r) => r.key === "day:2026-10-05");
      checks.f_day2 = p2.length === 1 && p2[0].client_order_id === "r316-SPY-20261006-S" && p2[0].qty === "9.99000999" && p2[0].side === "sell" && !!d05
        && d05.counts.entrySignal.both === 2 && d05.counts.entrySignal.extra === 1 && d05.counts.entrySignal.missed === 1 && d05.counts.entryAction.both === 1 && d05.counts.entryAction.extra === 1 && d05.counts.entryAction.missed === 2
        && d05.dataQuality.noDecision.includes("EWA") && d05.dataQuality.noDecision.includes("XLE") && !L2.some((r) => r.kind === "round-trip");
      // day 3: XLK exits (est 0.95) but only half fills -> owed
      w.t = ET("2026-10-07", "15:54:00"); setQ({ XLK: 0.95 }); await runDecide(ctx);
      w.t = ET("2026-10-07", "15:55:20"); fillAll(w, { XLK: 52.00 }, { XLK: 0.5 });
      day("2026-10-07", { XLK: [51, 52.3, 50.8, 52.2] });
      w.t = ET("2026-10-07", "16:20:00"); await runAfterClose(ctx); const s3 = readJson(ctx.paths.state), L3 = readLedger(ctx.paths.ledger), rtSpy = L3.find((r) => r.key === "rt:r316-SPY-20261005-B");
      checks.f_roundTripSpy = !!rtSpy && near(rtSpy.shortfallPct, 0.300899, 1e-6) && near(rtSpy.actualRet, 101 / 100.1 - 1, 1e-8) && rtSpy.exitDecisionDate === "2026-10-06" && s3.lots.find((l) => l.sym === "XLK").status === "exit-owed";
      // day 4: XLK owed remainder re-sent whatever the signal (0.5), new cid
      w.t = ET("2026-10-08", "15:54:00"); setQ({}); await runDecide(ctx); const p4 = w.posts.filter((p) => p.client_order_id.startsWith("r316-XLK-20261008"));
      w.t = ET("2026-10-08", "15:55:20"); fillAll(w, { XLK: 51.00 });
      day("2026-10-08", {});
      w.t = ET("2026-10-08", "16:20:00"); await runAfterClose(ctx);
      w.t = ET("2026-10-09", "16:20:00"); day("2026-10-09", { IWM: [100, 101, 99, 99.05] }); await runAfterClose(ctx);   // no decide run on 10-09 -> a gap once 10-09 is final; IWM dips (shadow enters)
      w.t = ET("2026-10-10", "11:00:00"); const nRows = readLedger(ctx.paths.ledger).length; await runAfterClose(ctx); const L5 = readLedger(ctx.paths.ledger);
      const rtX = L5.find((r) => r.key === "rt:r316-XLK-20261005-B"), keys = L5.filter((r) => r.key).map((r) => r.key);
      w.t = ET("2026-10-10", "11:05:00"); await runAfterClose(ctx); const L6 = readLedger(ctx.paths.ledger), keys6 = L6.filter((r) => r.key).map((r) => r.key);
      checks.f_owedExitAndXlkRoundTrip = p4.length === 1 && p4[0].client_order_id === "r316-XLK-20261008-S" && p4[0].qty === "10" && !!rtX && rtX.exitDecisionDate === "2026-10-07" && near(rtX.exitFill, 51.5, 1e-9)
        && near(rtX.actualRet, 51.5 / 50 - 1, 1e-8) && near(rtX.shadowRet, 52.2 / 49.3 - 1, 1e-8) && rtX.owedRemainderSold === true;
      checks.f_gapLogged = L5.some((r) => r.key === "gap:2026-10-09") && w.notes.some((n) => /missed decision 2026-10-09/.test(n.t));
      // repair: a final dip on a day (or ETF) without a decision is noDecision at signal level, not an IBS_est miss; the action is still missed
      const d09 = L5.find((r) => r.key === "day:2026-10-09");
      checks.f_gapDaySignalsAreNoDecision = !!d09 && d09.decided === false && d09.counts.entrySignal.noDecision === 1 && d09.counts.entrySignal.missed === 0 && d09.counts.entryAction.missed === 1 && d05.counts.entrySignal.noDecision === 0;
      checks.f_noDuplicateRows = new Set(keys6).size === keys6.length && keys6.length === keys.length && L6.length === L5.length + 0 && nRows <= L5.length;
      const stt = readJson(ctx.paths.status), ni = stt.nightly;
      checks.f_status = ni.started && ni.roundTrips === 2 && ni.evidenceStart === "2026-10-05" && ni.lastFinalSession === "2026-10-09" && ni.shadow && ni.shadow.closed >= 2 && ni.interimKill.applies === false && ni.executionRead.ready === false && ni.executionRead.remaining === 58;
      detail.f = { nightly: { roundTrips: ni.roundTrips, execution: ni.execution, shadow: ni.shadow, agreement: ni.agreement, unpairedAllIn: ni.unpairedAllIn, interimKill: ni.interimKill } };
      // repair: reporting fields beside the registered statistics (late legs, R313's own unpaired trades, the one-look schedule, the NW diagnostic)
      checks.f_reportingFields = rtSpy.lateLeg === false && rtSpy.entryDecidedEt === "15:55:00" && ni.execution.lateLegRoundTrips === 0 && near(ni.execution.meanShortfallOnTimePct, ni.execution.meanShortfallPct, 1e-12)
        && ni.unpairedAllIn.shadowOwnClosed >= 2 && fin(ni.unpairedAllIn.shadowOwnGrossPctPerTrade) && ni.unpairedAllIn.actualRoundTrips === 2
        && ni.interimKill.looked === null && ni.interimKill.diagnostic.gated === false && ni.interimKill.diagnostic.sessions === 5 && ni.agreement.entrySignal.noDecision === 1;
      // guard audit on the real flow: all orders inside the window -> no HALT; the broker's created_at is recorded on every lot
      const sF = readJson(ctx.paths.state);
      checks.f_noGuardViolation = !fs.existsSync(ctx.paths.halt) && guardAudit(sF).length === 0 && sF.lots.every((l) => !!l.entryCreatedAt) && sF.lots.every((l) => l.exitOrders.every((x) => !!x.createdAt)); }
    // (g) persistence after every send + crash: the backup completes without a duplicate POST
    { const dir = path.join(tmpRoot, "crash"), w = fakeWorld(ET("2026-10-05", "15:54:00")); w.sessions["2026-10-05"] = "16:00";
      for (const sym of UNIVERSE) w.quotes[sym] = () => qOf(["SPY", "IWM", "DIA"].includes(sym) ? 0.03 : 0.5, w);
      let saves = 0; const ctx = testCtx(dir, w, { onSave: (s) => { const d = s.days["2026-10-05"]; if (d && Object.keys(d.sends).length === 1 && ++saves === 1) { const e = new Error("SIMULATED CRASH after the first send's save"); e.crash = true; throw e; } } });
      let threw = false; try { await runDecide(ctx); } catch (e) { threw = !!e.crash; }
      const mid = readJson(ctx.paths.state), lockGone = !fs.existsSync(ctx.paths.lock);
      const ctx2 = testCtx(dir, w); w.t = ET("2026-10-05", "15:57:00"); await runDecide(ctx2);
      const cids = w.posts.map((p) => p.client_order_id), fin2 = readJson(ctx2.paths.state);
      checks.g_crashThenBackup = threw && lockGone && Object.keys(mid.days["2026-10-05"].sends).length === 1 && w.posts.length === 3 && new Set(cids).size === 3 && fin2.days["2026-10-05"].done && w.quoteCalls === 1; }
    // (h) adoption: a lost POST answer is adopted by its id, never re-sent; a 403 is a rejection (lot rejected, no retry)
    { const dir = path.join(tmpRoot, "adopt"), w = fakeWorld(ET("2026-10-05", "15:54:00")); w.sessions["2026-10-05"] = "16:00";
      for (const sym of UNIVERSE) w.quotes[sym] = () => qOf(["SPY", "IWM"].includes(sym) ? 0.03 : 0.5, w);
      w.loseNextResponse = true; const ctx = testCtx(dir, w); await runDecide(ctx); const s = readJson(ctx.paths.state), d = s.days["2026-10-05"];
      const w2 = fakeWorld(ET("2026-10-05", "15:54:00")); w2.sessions["2026-10-05"] = "16:00"; for (const sym of UNIVERSE) w2.quotes[sym] = () => qOf(sym === "SPY" ? 0.03 : 0.5, w2);
      w2.orders.set("r316-SPY-20261005-B", { id: "pre", client_order_id: "r316-SPY-20261005-B", symbol: "SPY", side: "buy", notional: "1000", status: "filled", submitted_at: iso(w2.t), filled_qty: "9.9", filled_avg_price: "101", filled_at: iso(w2.t) });
      const ctxB = testCtx(path.join(tmpRoot, "adopt2"), w2); await runDecide(ctxB); const sB = readJson(ctxB.paths.state);
      const w3 = fakeWorld(ET("2026-10-05", "15:54:00")); w3.sessions["2026-10-05"] = "16:00"; for (const sym of UNIVERSE) w3.quotes[sym] = () => qOf(sym === "SPY" ? 0.03 : 0.5, w3); w3.rejectNext = "insufficient buying power";
      const ctxC = testCtx(path.join(tmpRoot, "reject"), w3); await runDecide(ctxC); const sC = readJson(ctxC.paths.state); w3.t = ET("2026-10-05", "15:57:00"); await runDecide(ctxC);
      checks.h_adoption = w.posts.length === 2 && d.sends["r316-SPY-20261005-B"].status === "adopted" && d.sends["r316-IWM-20261005-B"].status === "sent"
        && w2.posts.length === 0 && sB.days["2026-10-05"].sends["r316-SPY-20261005-B"].status === "adopted"
        && w3.posts.length === 1 && sC.lots[0].status === "rejected" && sC.days["2026-10-05"].sends["r316-SPY-20261005-B"].status === "rejected" && w3.notes.some((n) => /order problems/.test(n.t)); }
    // (i) the hard guard refuses: non-paper host, Alpaca clock outside / skewed / closed, a decision run outside its window
    { const mkW = () => { const w = fakeWorld(ET("2026-10-05", "15:54:00")); w.sessions["2026-10-05"] = "16:00"; for (const sym of UNIVERSE) w.quotes[sym] = () => qOf(sym === "SPY" ? 0.03 : 0.5, w); return w; };
      const w1 = mkW(); w1.host = "https://api.alpaca.markets"; await runDecide(testCtx(path.join(tmpRoot, "g1"), w1));
      const w2 = mkW(); w2.clockSkewMs = 40000; await runDecide(testCtx(path.join(tmpRoot, "g2"), w2));
      const w3 = mkW(); w3.isOpen = false; await runDecide(testCtx(path.join(tmpRoot, "g3"), w3));
      const w4 = mkW(); w4.t = ET("2026-10-05", "15:53:00"); const r4c = await runDecide(testCtx(path.join(tmpRoot, "g4"), w4));
      const w5 = mkW(); w5.t = ET("2026-10-05", "15:59:00"); await runDecide(testCtx(path.join(tmpRoot, "g5"), w5));
      const w6 = mkW(); w6.t = ET("2026-10-04", "15:55:00"); await runDecide(testCtx(path.join(tmpRoot, "g6"), w6));
      const refused = (w) => w.posts.length === 0;
      checks.i_hardGuard = refused(w1) && refused(w2) && refused(w3) && refused(w4) && r4c === 0 && w4.quoteCalls === 0 && refused(w5) && w5.quoteCalls === 0 && refused(w6)
        && readJson(path.join(tmpRoot, "g1", "r316-state.json")).days["2026-10-05"].sends["r316-SPY-20261005-B"].status === "refused";
      let threw = null; try { await realBroker(path.join(tmpRoot, "no.env")).positions(); } catch (e) { threw = e.message; }
      let ro = null; const rb = realBroker(path.join(tmpRoot, "no.env"), { readOnly: true }); try { await rb.submit({}); } catch (e) { ro = e.message; }
      checks.i_realBrokerRefusesWithoutKeys = /no ALPACA_TV/.test(threw || "") && /no ALPACA_TV|read-only/.test(ro || ""); }
    // (j) guard audit: an order the broker stamps 16:00:30 ET -> HALT guard-violation, alerted once; the next decide sends nothing
    { const dir = path.join(tmpRoot, "audit"), w = fakeWorld(ET("2026-10-05", "16:20:00")); for (const d of ["2026-10-05", "2026-10-06"]) w.sessions[d] = "16:00";
      for (const sym of UNIVERSE) { w.bars[sym] = [{ d: "2026-10-05", o: 100, h: 101, l: 99, c: 100, v: 1 }]; w.quotes[sym] = () => qOf(sym === "SPY" ? 0.03 : 0.5, w); }
      const ctx = testCtx(dir, w); const s = freshState(); s.firstLiveDecision = "2026-10-05"; s.evidenceStart = "2026-10-05";
      s.days["2026-10-05"] = { date: "2026-10-05", closeMins: 960, decision: true, decisions: [], planned: [], sends: {}, attempts: [] };
      s.lots.push({ key: "r316-IWM-20261005-B", sym: "IWM", entryDate: "2026-10-05", entryCid: "r316-IWM-20261005-B", status: "pending", entrySubmittedAt: iso(ET("2026-10-05", "16:00:30")), entryHost: PAPER, exitOrders: [] });
      w.orders.set("r316-IWM-20261005-B", { client_order_id: "r316-IWM-20261005-B", symbol: "IWM", status: "filled", filled_qty: "10", filled_avg_price: "100", filled_at: iso(w.t), submitted_at: iso(ET("2026-10-05", "16:00:30")) });
      saveJson(ctx.paths.state, s);
      const a = await runAfterClose(ctx); const halt = readJson(ctx.paths.halt, null); await runAfterClose(ctx);
      w.t = ET("2026-10-06", "15:54:00"); await runDecide(ctx);
      checks.j_guardAuditHalts = a === 1 && halt && halt.kind === "guard-violation" && w.notes.filter((n) => /HALTED/.test(n.t)).length === 1 && w.posts.length === 0 && readLedger(ctx.paths.ledger).filter((r) => r.kind === "guard-violation").length === 1; }
    // (k) quote failure: no decision, owed exits still sent, the backup retries the quotes (decision false); TRAIDS_STOP runs nothing
    { const dir = path.join(tmpRoot, "qfail"), w = fakeWorld(ET("2026-10-05", "15:54:00")); w.sessions["2026-10-05"] = "16:00";
      for (const sym of UNIVERSE) w.quotes[sym] = () => qOf(sym === "SPY" ? 0.03 : 0.5, w);
      const ctx = testCtx(dir, w); const s = freshState(); s.firstLiveDecision = "2026-10-02"; s.evidenceStart = "2026-10-02";
      s.lots.push({ key: "x", sym: "IWM", entryDate: "2026-10-02", entryCid: "x", status: "exit-owed", qty: 4, qtyStr: "4", exitFilledQty: 0, exitOrders: [{ cid: "r316-IWM-20261002-S", done: true, filledQty: 0, sentOn: "2026-10-02" }] });
      w.account.IWM = 4; saveJson(ctx.paths.state, s); w.quoteError = "schwab quotes HTTP 401";
      await runDecide(ctx); const s1 = readJson(ctx.paths.state), d1 = s1.days["2026-10-05"];
      w.quoteError = null; w.t = ET("2026-10-05", "15:57:00"); await runDecide(ctx); const s2 = readJson(ctx.paths.state), d2 = s2.days["2026-10-05"];
      checks.k_quoteFailure = d1.decision === false && w.posts[0].client_order_id === "r316-IWM-20261005-S" && w.notes.some((n) => /NO decision/.test(n.t)) && d2.decision === true && d2.late === true
        && w.posts.length === 2 && w.posts[1].client_order_id === "r316-SPY-20261005-B" && w.quoteCalls === 2;
      const ws = fakeWorld(ET("2026-10-05", "15:54:00")); ws.sessions["2026-10-05"] = "16:00"; const cs = testCtx(path.join(tmpRoot, "stop"), ws); fs.writeFileSync(cs.paths.stop, "");
      checks.k_traidsStop = (await runDecide(cs)) === 0 && (await runAfterClose(cs)) === 0 && ws.posts.length === 0 && !fs.existsSync(cs.paths.state); }
    // (l) the registry agrees with this runner (read-only): universe, bar, interim kill
    { const reg = JSON.parse(fs.readFileSync(path.join(realData, "test-registry.json"), "utf8")), e = [...(reg.preregistered || []), ...(reg.tests || [])].find((t) => t.id === ID);
      const uni = e && (e.rule.match(/UNIVERSE:\s*([A-Z ]+?)\s*\(/) || [])[1];
      checks.l_registryAgrees = !!e && uni === UNIVERSE.join(" ") && e.bar.executionCostCeilingPctPerRoundTrip === CEILING_PCT && e.bar.minRoundTrips === MIN_RT && /At >= 40 round trips/.test(e.interimKill) && /<= -2\.0/.test(e.interimKill)
        && /15:50-15:59/.test(e.interimKill) && /IBS_est < 0\.1/.test(e.rule) && /IBS_est > 0\.9/.test(e.rule) && /older than 60 s/.test(e.rule) && /\$1,000 notional/.test(e.rule) && /r316-/.test(e.rule); }
    // (m) REPAIRS after the 2026-10-02 review — one known answer each
    // m1 the run stalls past the window (suspend in the wait) and gets post-market quotes: XLK last 51.20 above the high 51.00 would clamp
    //    to IBS 1.0 -> NO decision, nothing planned, the lot stays open, and the next day (IBS 0.5) sends nothing
    { const dir = path.join(tmpRoot, "late"), w = fakeWorld(ET("2026-10-05", "15:54:00")); for (const d of ["2026-10-05", "2026-10-06"]) w.sessions[d] = "16:00";
      const s = freshState(); s.firstLiveDecision = "2026-10-02"; s.evidenceStart = "2026-10-02";
      s.lots.push({ key: "r316-XLK-20261002-B", sym: "XLK", entryDate: "2026-10-02", entryCid: "r316-XLK-20261002-B", status: "open", qty: 20, qtyStr: "20", entryFill: 50, exitOrders: [] });
      w.account.XLK = 20; for (const sym of UNIVERSE) w.quotes[sym] = () => qOf(0.5, w);
      w.quotes.XLK = () => ({ last: 51.2, high: 51, low: 50, bid: 51.19, ask: 51.21, quoteTime: w.t - 1000, tradeTime: w.t - 1000, realtime: true });
      w.stallTo = ET("2026-10-05", "16:06:00");
      const ctx = testCtx(dir, w, { sleep: async (ms) => { w.t += Math.max(0, ms); if (w.stallTo) { w.t = w.stallTo; w.stallTo = null; } } }); saveJson(ctx.paths.state, s);
      const c = await runDecide(ctx), d1 = readJson(ctx.paths.state).days["2026-10-05"];
      w.t = ET("2026-10-05", "16:20:00"); await runAfterClose(ctx);
      w.t = ET("2026-10-06", "15:54:00"); w.quotes.XLK = () => qOf(0.5, w, { base: 50.5 }); await runDecide(ctx);
      const s2 = readJson(ctx.paths.state), lot = s2.lots.find((l) => l.sym === "XLK");
      checks.m_lateQuotesNoDecision = c === 1 && d1.decision === false && /outside the decision window/.test(d1.quoteError || "") && d1.planned.length === 0 && lot.status === "open" && !lot.exitDecisionDate
        && w.posts.length === 0 && w.notes.some((n) => /NO decision/.test(n.t)) && s2.days["2026-10-06"].decision === true; }
    // m2 a 200 answer with no usable quote (delayed / 15 min frozen / empty body) is NO decision: alerted, the backup re-queries and decides;
    //    >= 4 ETFs without a decision on a decided day is alerted
    { const res = {}, cases = { delayed: (w) => () => ({ ...qOf(0.03, w), realtime: false }), frozen: (w) => () => qOf(0.03, w, { ageS: 900 }), empty: null };
      for (const [k, mk] of Object.entries(cases)) {
        const w = fakeWorld(ET("2026-10-05", "15:54:00")), dir = path.join(tmpRoot, `nq-${k}`); w.sessions["2026-10-05"] = "16:00"; w.quotes = {}; if (mk) for (const sym of UNIVERSE) w.quotes[sym] = mk(w);
        const ctx1 = testCtx(dir, w, { by: "task1354" }), c1 = await runDecide(ctx1), d1 = readJson(ctx1.paths.state).days["2026-10-05"];
        for (const sym of UNIVERSE) w.quotes[sym] = () => qOf(sym === "SPY" ? 0.03 : 0.5, w);                // the backup's quotes are good
        w.t = ET("2026-10-05", "15:57:00"); await runDecide(testCtx(dir, w, { by: "task1357" })); const d2 = readJson(ctx1.paths.state).days["2026-10-05"];
        res[k] = c1 === 1 && d1.decision === false && /0 of 20 quotes usable/.test(d1.quoteError || "") && w.notes.filter((n) => /NO decision/.test(n.t)).length === 1 && w.quoteCalls === 2
          && d2.decision === true && d2.late === true && w.posts.length === 1 && w.posts[0].client_order_id === "r316-SPY-20261005-B";
      }
      { const w = fakeWorld(ET("2026-10-05", "15:54:00")); w.sessions["2026-10-05"] = "16:00"; for (const [i, sym] of UNIVERSE.entries()) w.quotes[sym] = i < 5 ? () => qOf(0.5, w, { ageS: 120 }) : () => qOf(0.5, w);
        const ctxP = testCtx(path.join(tmpRoot, "nq-partial"), w, { by: "task1354" }), cP = await runDecide(ctxP), dP = readJson(ctxP.paths.state).days["2026-10-05"];
        res.partial = cP === 0 && dP.decision === true && w.notes.length === 1 && /5\/20 ETFs without a decision/.test(w.notes[0].b) && /decision problems/.test(w.notes[0].t); }
      checks.m_noUsableQuotesNoDecision = Object.values(res).every((v) => v === true); detail.m2 = res; }
    // m3 the alert class carries the fire: the primary's refusal alert does not suppress the backup's own refusal alert the same day
    { const w = fakeWorld(ET("2026-10-05", "15:54:00")), dir = path.join(tmpRoot, "alertcls"); w.sessions["2026-10-05"] = "16:00"; w.clockSkewMs = 40000;
      for (const sym of UNIVERSE) w.quotes[sym] = () => qOf(sym === "SPY" ? 0.03 : 0.5, w);
      await runDecide(testCtx(dir, w, { by: "task1354" })); const n1 = w.notes.length;
      w.t = ET("2026-10-05", "15:57:00"); await runDecide(testCtx(dir, w, { by: "task1357" })); const n2 = w.notes.length;
      w.t = ET("2026-10-05", "15:57:30"); await runDecide(testCtx(dir, w, { by: "task1357" }));               // the same fire again: deduplicated
      checks.m_alertPerFire = n1 === 1 && n2 === 2 && w.notes.length === 2 && w.posts.length === 0 && /NOT SENT/.test(w.notes[1].b) && w.quoteCalls === 1; }
    // m4 a NEW guard violation escalates an interim-kill HALT to guard-violation (exits stop too); once the operator removes the HALT, the
    //    reviewed violation never re-halts and the forward resumes (XLU exit at IBS 0.95 is sent)
    { const dir = path.join(tmpRoot, "halt2"), w = fakeWorld(ET("2026-10-05", "16:20:00")); for (const d of ["2026-10-05", "2026-10-06", "2026-10-07"]) w.sessions[d] = "16:00";
      for (const sym of UNIVERSE) w.quotes[sym] = () => qOf(0.5, w); w.quotes.XLU = () => qOf(0.95, w);
      const ctx = testCtx(dir, w), s = freshState(); s.firstLiveDecision = "2026-10-05"; s.evidenceStart = "2026-10-05";
      s.days["2026-10-05"] = { date: "2026-10-05", closeMins: 960, decision: true, decisions: [], planned: [], sends: {}, attempts: [] };
      s.lots.push({ key: "r316-IWM-20261005-B", sym: "IWM", entryDate: "2026-10-05", entryCid: "r316-IWM-20261005-B", status: "pending", entryCreatedAt: iso(ET("2026-10-05", "16:00:30")), entryHost: PAPER, exitOrders: [] },
        { key: "r316-XLU-20261001-B", sym: "XLU", entryDate: "2026-10-01", entryCid: "r316-XLU-20261001-B", status: "open", qty: 12, qtyStr: "12", entryFill: 80, exitOrders: [] });
      w.account.XLU = 12; w.account.IWM = 10;
      w.orders.set("r316-IWM-20261005-B", { client_order_id: "r316-IWM-20261005-B", symbol: "IWM", status: "filled", filled_qty: "10", filled_avg_price: "100", filled_at: iso(w.t), created_at: iso(ET("2026-10-05", "16:00:30")), submitted_at: iso(ET("2026-10-05", "16:00:30")) });
      saveJson(ctx.paths.state, s); saveJson(ctx.paths.halt, { kind: "interim-kill", date: "2026-10-02", stopsExits: false });
      const a = await runAfterClose(ctx), h1 = readJson(ctx.paths.halt, null);
      w.t = ET("2026-10-06", "15:54:00"); await runDecide(ctx); const postsHalted = w.posts.length;
      fs.unlinkSync(ctx.paths.halt);                                                                          // the operator reviews and removes it
      w.t = ET("2026-10-06", "16:20:00"); const a2 = await runAfterClose(ctx), h2 = fs.existsSync(ctx.paths.halt);
      w.t = ET("2026-10-07", "15:54:00"); await runDecide(ctx);
      checks.m_haltEscalatesThenClears = a === 1 && !!h1 && h1.kind === "guard-violation" && !!h1.supersedes && h1.supersedes.kind === "interim-kill" && postsHalted === 0 && a2 === 0 && !h2
        && w.posts.length === 1 && w.posts[0].client_order_id === "r316-XLU-20261007-S" && w.posts[0].qty === "12" && readLedger(ctx.paths.ledger).filter((r) => r.kind === "guard-violation").length === 1
        && w.notes.filter((n) => /HALTED/.test(n.t)).length === 1; }
    // m5 the audit grades the SEND (created_at), submitted_at only as a fallback: created 15:58:50 / submitted 15:59:20 is inside; a flow
    //    sending at 15:58:50 with a 30 s broker submit lag writes no HALT
    { const s = freshState(); s.days["2026-10-05"] = { closeMins: 960 };
      s.lots.push({ key: "a", entryCid: "a", entryDate: "2026-10-05", entryCreatedAt: iso(ET("2026-10-05", "15:58:50")), entrySubmittedAt: iso(ET("2026-10-05", "15:59:20")), entryHost: PAPER,
        exitOrders: [{ cid: "a-S", sentOn: "2026-10-05", createdAt: iso(ET("2026-10-05", "15:59:05")), submittedAt: iso(ET("2026-10-05", "15:59:06")), host: PAPER }] },
        { key: "b", entryCid: "b", entryDate: "2026-10-05", entrySubmittedAt: iso(ET("2026-10-05", "15:59:20")), entryHost: PAPER, exitOrders: [] });
      const v = guardAudit(s);
      const w = fakeWorld(ET("2026-10-05", "15:58:50")); w.sessions["2026-10-05"] = "16:00"; w.submitLagMs = 30000; for (const sym of UNIVERSE) w.quotes[sym] = () => qOf(sym === "SPY" ? 0.03 : 0.5, w);
      const ctx = testCtx(path.join(tmpRoot, "lag"), w); await runDecide(ctx); w.t = ET("2026-10-05", "15:59:30"); fillAll(w, { SPY: 100 }); w.t = ET("2026-10-05", "16:20:00"); const a = await runAfterClose(ctx);
      const lot = readJson(ctx.paths.state).lots[0];
      checks.m_auditGradesCreatedAt = v.length === 2 && v.some((x) => x.cid === "a-S" && x.field === "created_at") && v.some((x) => x.cid === "b" && x.field === "submitted_at") && !v.some((x) => x.cid === "a")
        && w.posts.length === 1 && a === 0 && !fs.existsSync(ctx.paths.halt) && lot.entryCreatedAt === iso(ET("2026-10-05", "15:58:50")) && lot.entrySubmittedAt === iso(ET("2026-10-05", "15:59:20")); }
    // m6 an after-close started in [close-30, close) on a session day defers (no lock, nothing written); 15:29 runs
    { const w = fakeWorld(ET("2026-10-05", "15:58:00")), ctx = testCtx(path.join(tmpRoot, "defer"), w); w.sessions["2026-10-05"] = "16:00";
      const s = freshState(); s.firstLiveDecision = "2026-10-02"; saveJson(ctx.paths.state, s); const before = fs.readFileSync(ctx.paths.state, "utf8");
      const a = await runAfterClose(ctx); w.t = ET("2026-10-05", "15:30:00"); const a30 = await runAfterClose(ctx);
      const untouched = fs.readFileSync(ctx.paths.state, "utf8") === before && !fs.existsSync(ctx.paths.lock) && !fs.existsSync(ctx.paths.status) && !fs.existsSync(ctx.paths.bars);
      w.t = ET("2026-10-05", "15:29:00"); const b = await runAfterClose(ctx), ran = readJson(ctx.paths.state).lastRun.afterClose === "2026-10-05";
      checks.m_afterCloseDefers = a === 0 && a30 === 0 && untouched && w.logs.filter((l) => /DEFERRED/.test(l)).length === 2 && b === 0 && ran; }
    // m7 the interim kill is ONE look: 40 winners at the look -> continues, and 40 later losers (nightly t far below -2) do not kill;
    //    40 losers at the look -> HALT interim-kill (exits continue), alerted once
    { const mkRts = (n, f, off = 0) => Array.from({ length: n }, (_, j) => { const i = j + off; return { kind: "round-trip", key: `rt:${i}`, entryDate: `2026-${String(10 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`, actualRet: f(i), shadowRet: 0, shortfallPct: 0 }; });
      const pos = (i) => 0.001 + (i % 2 ? 0.001 : -0.001), neg = (i) => -0.004 + (i % 2 ? 0.001 : -0.001);
      const mk = (dir, rts) => { const w = fakeWorld(ET("2026-12-01", "16:20:00")); for (const d of ["2026-12-01", "2026-12-02"]) w.sessions[d] = "16:00"; const ctx = testCtx(dir, w), s = freshState();
        s.firstLiveDecision = "2026-10-05"; s.evidenceStart = "2026-10-05"; saveJson(ctx.paths.state, s); fs.writeFileSync(ctx.paths.ledger, rts.map((r) => JSON.stringify(r)).join("\n") + "\n"); return { w, ctx }; };
      const A = mk(path.join(tmpRoot, "ik-a"), mkRts(40, pos)); await runAfterClose(A.ctx); const lookA = readJson(A.ctx.paths.status).nightly.interimKill.looked;
      fs.appendFileSync(A.ctx.paths.ledger, mkRts(40, neg, 40).map((r) => JSON.stringify(r)).join("\n") + "\n"); A.w.t = ET("2026-12-02", "16:20:00"); await runAfterClose(A.ctx);
      const ikA = readJson(A.ctx.paths.status).nightly.interimKill, LA = readLedger(A.ctx.paths.ledger);
      const B2 = mk(path.join(tmpRoot, "ik-b"), mkRts(40, neg)); const cB = await runAfterClose(B2.ctx), hB = readJson(B2.ctx.paths.halt, null); B2.w.t = ET("2026-12-02", "16:20:00"); await runAfterClose(B2.ctx);
      const LB = readLedger(B2.ctx.paths.ledger);
      detail.m7 = { lookA, ikA: { roundTrips: ikA.roundTrips, t: ikA.t, looked: ikA.looked }, haltA: fs.existsSync(A.ctx.paths.halt), notesA: A.w.notes.length, cB, hB, notesB: B2.w.notes.map((n) => n.t), kindsB: LB.map((r) => r.kind).filter((k) => k !== "round-trip") };
      checks.m_interimKillOneLook = !!lookA && lookA.triggered === false && lookA.roundTrips === 40 && ikA.roundTrips === 80 && ikA.t <= -2 && ikA.looked.date === "2026-12-01" && !fs.existsSync(A.ctx.paths.halt)
        && LA.filter((r) => r.kind === "interim-kill-look").length === 1 && !LA.some((r) => r.kind === "interim-kill") && !A.w.notes.some((n) => /INTERIM KILL/.test(n.t))
        && cB === 0 && !!hB && hB.kind === "interim-kill" && hB.stopsExits === false && LB.filter((r) => r.kind === "interim-kill").length === 1 && LB.filter((r) => r.kind === "interim-kill-look").length === 1
        && B2.w.notes.filter((n) => /INTERIM KILL/.test(n.t)).length === 1; }
    // m8 the ungated calendar-time NW diagnostic: lag 0 = the plain t with the population variance; the daily book P&L marks to the close
    //    and takes the exit fill on the exit day; open lots count
    { const v = [0.3, -0.1, 0.2, 0.05, -0.02], m = mean(v), vp = v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length;
      const pnl = bookDailyPnl([{ sym: "SPY", entryDate: "2026-10-05", entryFill: 100, qty: 10, status: "closed", exitFill: 103, exitCompleteDate: "2026-10-07" }, { sym: "IWM", entryDate: "2026-10-06", entryFill: 50, qty: 20, status: "open" }],
        { bySym: { SPY: { "2026-10-05": { c: 101 }, "2026-10-06": { c: 102 }, "2026-10-07": { c: 120 } }, IWM: { "2026-10-06": { c: 51 }, "2026-10-07": { c: 50.5 } } } }, ["2026-10-05", "2026-10-06", "2026-10-07"]);
      checks.m_nwDiagnostic = near(nwTLag(v, 0), m / Math.sqrt(vp / v.length), 1e-12) && fin(nwTLag(v)) && near(pnl[0], 0.01, 1e-12) && near(pnl[1], 0.03, 1e-12) && near(pnl[2], 0, 1e-12) && nwTLag([1, 1, 1]) === null; }
    // m9 a leg decided by the backup (day.late) flags the round trip; the on-time mean is reported beside the registered headline
    { const L = { key: "k", sym: "SPY", entryDate: "2026-10-05", exitDecisionDate: "2026-10-06", entryFill: 100, exitFill: 101, qty: 10, exitOrders: [] }, st = { bySym: { SPY: { "2026-10-05": { o: 100, h: 101, l: 99, c: 100 }, "2026-10-06": { o: 100, h: 102, l: 99, c: 101.5 } } } };
      const late = roundTripRow(L, st, "2026-10-06", { "2026-10-05": { late: false, decidedEt: "15:55:00" }, "2026-10-06": { late: true, decidedEt: "15:57:02" } }).row, onT = roundTripRow(L, st, "2026-10-06", { "2026-10-05": { late: false }, "2026-10-06": { late: false } }).row;
      const x = execStats([{ ...late, shortfallPct: 0.3 }, { ...onT, shortfallPct: 0.1 }]);
      checks.m_lateLegReporting = late.lateLeg === true && late.exitDecidedEt === "15:57:02" && onT.lateLeg === false && x.lateLegRoundTrips === 1 && near(x.meanShortfallOnTimePct, 0.1, 1e-12) && near(x.meanShortfallPct, 0.2, 1e-12); }
  } catch (e) { checks.threw = false; detail.threw = e.stack; }
  const after = Object.fromEntries(realFiles.map((f) => { try { const s = fs.statSync(path.join(realData, f)); return [f, `${s.size}:${s.mtimeMs}`]; } catch { return [f, null]; } }));
  checks.z_realFilesUntouched = JSON.stringify(before) === JSON.stringify(after) && path.resolve(tmpRoot).startsWith(path.resolve(os.tmpdir()));
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* left for inspection */ }
  const pass = Object.values(checks).every((v) => v === true);
  console.log(`R316 selftest ${pass ? "PASS" : "FAIL"} ${JSON.stringify(checks)}`);
  if (!pass || process.argv.includes("--verbose")) console.log(`  detail ${JSON.stringify(detail).slice(0, 6000)}`);
  return pass;
}

// ── entry ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2), has = (f) => argv.includes(f), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const mode = ["--selftest", "--dry", "--decide", "--after-close", "--status", "--read-execution"].find(has) || "--status";
  const by = String(arg("--by") || "manual").replace(/[^\w.-]/g, "").slice(0, 24) || "manual";
  const live = mode === "--decide" && has("--live");
  const ctx = { paths: pathsFor(path.join(__dirname, "data")), live, by, clock: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
    // W3 SERVER MIGRATION (2026-10, docs/server/wave3-sleeves): the VPS unit names its key file in TRAIDS_ENV_FILE (/etc/traids/w3-sleeves.env); unset at home
    broker: realBroker(process.env.TRAIDS_ENV_FILE || path.join(__dirname, ".env"), { readOnly: !live }), quotes: schwabQuotes, warmQuotes: () => require("./lib/schwab.js").token(), dailyBars: schwabDaily, pidAlive, bootMs: () => Date.now() - os.uptime() * 1000,
    notify: async (t, b) => require("./notify.js").notify(t, b, { priority: "high", tags: "warning", email: false }), log: (...a) => console.log(`[r316 ${new Date().toISOString()}]`, ...a) };
  const done = (c) => { process.exitCode = c; setTimeout(() => process.exit(c), 3000).unref(); };   // 2026-10-05: never a hard exit() with a fetch socket closing (libuv UV_HANDLE_CLOSING abort, exit 0xC0000409 failed the chain step)
  (async () => {
    if (mode === "--selftest") return done((await selftest()) ? 0 : 1);
    if (mode === "--dry") return done(await runDry(ctx));
    if (mode === "--decide") return done(live ? await runDecide(ctx) : await runDry(ctx, "--decide without --live = --dry"));
    if (mode === "--after-close") return done(await runAfterClose(ctx));
    if (mode === "--read-execution") return done(runReadExecution(ctx));
    return done(runStatus(ctx));
  })().catch(async (e) => {
    console.error(`[r316 ${new Date().toISOString()}] FAILED (${mode}): ${e.stack || e.message}`);
    if (mode === "--decide" && live || mode === "--after-close") { try { await alertOnce(ctx, etParts(Date.now()).date, `failed${mode}`, `${mode} FAILED`, String(e.message).slice(0, 600)); } catch { /* logged above */ } }
    process.exitCode = 1; setTimeout(() => process.exit(1), 3000).unref();
  });
}
module.exports = { ibsEstimate, decideAll, decideWindow, windowCheck, clockCheck, cidFor, qstr, clusterT, execStats, interimKill, placeboPrepU, runShadow, shadowReport, roundTripRow, dayRow, guardAudit, selftest, UNIVERSE, NOTIONAL, CEILING_PCT, MIN_RT };
