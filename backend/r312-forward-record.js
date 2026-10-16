#!/usr/bin/env node
/**
 * R312 FORWARD FUTURES RECORD — weightless measurement (R312 controls.forwardRecord, registered 2026-10-02). READ-ONLY: this file holds
 * no order code of any kind (checked by --selftest against its own source); the only network calls are FRED fredgraph.csv GETs and
 * Schwab /marketdata/v1/quotes GETs through lib/schwab.js's token.
 *
 * WHAT IT RECORDS (append-only rows in data/r312-forward.jsonl):
 *   settle    the CME daily settlement of every tracked contract for one session date. Source: Schwab's quote closePrice, which is the
 *             PREVIOUS trade date's settlement (verified 2026-10-02 17:14 ET: /6EZ26 closePrice 1.1268 = the 10-01 14:00 CT price, not
 *             10-02's; the quote's settleTime field names 10-02 and is NOT a usable label). The trade date of a quote = its ET date,
 *             or the next business day from 18:00 ET (Globex reopen) or on a non-business day; the settle belongs to the business day
 *             before it. Settles are exchange evidence; a conflicting value for an already-recorded date is written as a conflict
 *             row, never overwritten. A MISSED RUN LOSES THAT SESSION'S SETTLE for good (closePrice only ever carries the previous
 *             business day's settle): every business day after the first recorded settle that no run captured is written once as a
 *             settle-gap row; a gap on a month-end or roll date (from the first decision on) is CRITICAL — a month row / roll
 *             depends on it, it stays pending until a settle labelled reconstructed is supplied, and the run exits 1.
 *   settle-reconstructed  appended BY HAND only ({ kind, settleDate, contracts, source }, e.g. the 15:00 ET 1-minute bar of the held
 *             contract, verified equal to the 10-01 settle; the continuous-front bar is the OLD contract between our roll date and its
 *             expiry, so it does not price the held contract there). Used only
 *             where no delivered settle exists; a month row that uses one is recordType "reconstructed-undelivered", never evidence.
 *   quote     the live two-sided book of the front standard and micro contracts at run time (spread = the cost side), only when
 *             Schwab says quotedInSession and the quote is <= 15 min old; otherwise the row says why there is none.
 *   decision  at each month end from 2026-10: the R312 positions for EUR/GBP/CHF computed by r312-europe-carry.js's own
 *             buildPanel + decideMonth (shared code, same fill rule, the RETURN NUMERAIRE IN FORCE in the registry at decision time;
 *             positions under both numeraires are stamped beside it) on a fresh FRED pull, once the pull holds the month's last
 *             fixing (H.10 posts weekly, so decisions land 1-5 business days after the month end; the lag is recorded) and the daily
 *             fill rates reach the month's last business day. Rates for the decision month are always FILLED in real time (OECD lags
 *             1-2 months) — exactly the registered fill rule.
 *   month     for each held month H (first: 2026-11): per leg the futures return on the fixed roll path, settle(end of H-1) ->
 *             settle(end of H), against the synthetic CIP return of the same month from FRED (shared legReturns); micro-notional USD
 *             P&L (M6E 12,500 EUR, M6B 6,250 GBP, MSF 12,500 CHF; priced on the standard 6E/6B/6S settles, same price per unit).
 *             Both sides of futures-vs-CIP are USD per USD of notional: futuresDirRet = pos x futures long return, cipDirRet = pos x
 *             CIP long return (S1/F - 1) — a short future earns -1 x the long. The registered-formula short (F/S1 - 1, the long-USD
 *             return in FOREIGN currency) is reported as cipDirRegisteredFormula only; mixing it in would add -(1-x)^2/x per short leg.
 * ROLL      fixed schedule: quarterly H/M/U/Z only; last trade date = 2 business days before the 3rd Wednesday of the contract month;
 *           roll at the settlement 5 business days before it (the old contract carries that day's P&L, the new one from that settle).
 *           Business days = weekdays not in lib/run-window.js MARKET_HOLIDAYS (NYSE list; past its last year the run REFUSES).
 *           Each quote's reference.futureExpirationDate is compared with the computed last trade date; a mismatch is recorded loudly.
 *
 *   node backend/r312-forward-record.js --selftest      offline; no network, no writes
 *   node backend/r312-forward-record.js --quote-check   one read-only quote GET for /6E /6B /6S and the tracked contracts; prints, writes nothing
 *   node backend/r312-forward-record.js --daily [--dry-run]   the close-chain step (dry-run prints the rows it would append)
 *   node backend/r312-forward-record.js --status
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const C = require("./r312-europe-carry.js");
const ARGV = process.argv.slice(2);
const MODE = ["--selftest", "--quote-check", "--status", "--daily"].find((m) => ARGV.includes(m)) || "--status";
const DRY = ARGV.includes("--dry-run");
const LEDGER = path.join(__dirname, "data", "r312-forward.jsonl");
const FWD_DIR = path.join(__dirname, "data", "training", "r312", "forward");
const FIRST_DECISION = "2026-10";
const QUOTE_MAX_AGE_MS = 15 * 60 * 1000, ROLL_BDAYS = 5, TRACKED_QUARTERLIES = 3;
const LEGS = { EUR: { root: "6E", micro: "M6E", notional: 12500 }, GBP: { root: "6B", micro: "M6B", notional: 6250 }, CHF: { root: "6S", micro: "MSF", notional: 12500 } };
const TRIO = C.TRIO;
const FWD_SERIES = [C.US.rate, C.US.fill, ...TRIO.flatMap((c) => [C.CCY[c].spot, C.CCY[c].rate, C.CCY[c].fill].filter(Boolean))];
const QCODE = { 3: "H", 6: "M", 9: "U", 12: "Z" }, CODEQ = { H: 3, M: 6, U: 9, Z: 12 };
const fin = Number.isFinite;
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ── business-day calendar ────────────────────────────────────────────────────────────────────────────────────────────────
let HOL = null, HOL_LAST_YEAR = null;
function holidays() { if (!HOL) { HOL = require("./lib/run-window.js").MARKET_HOLIDAYS || {}; HOL_LAST_YEAR = Math.max(...Object.keys(HOL).map((d) => +d.slice(0, 4))); } return HOL; }
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
function isBiz(d, hol = holidays()) {
  const w = new Date(d + "T12:00:00Z").getUTCDay(); if (w === 0 || w === 6) return false;
  const last = hol === HOL ? HOL_LAST_YEAR : Math.max(...Object.keys(hol).map((x) => +x.slice(0, 4)));
  if (+d.slice(0, 4) > last) throw new Error(`calendar: ${d} is past lib/run-window.js MARKET_HOLIDAYS (last year ${last}) — extend the list before this record can roll`);
  return !hol[d];
}
function addBiz(d, n) { let x = d, k = 0; const step = n < 0 ? -1 : 1; while (k < Math.abs(n)) { x = addDays(x, step); if (isBiz(x)) k++; } return x; }
const prevBiz = (d) => addBiz(d, -1), nextBiz = (d) => addBiz(d, 1);
function lastBizOfMonth(ym) { let d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10); while (!isBiz(d)) d = addDays(d, -1); return d; }
function thirdWednesday(y, m) { const w1 = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(), day = 1 + ((3 - w1 + 7) % 7) + 14; return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`; }
const lastTradeDate = (y, m) => addBiz(thirdWednesday(y, m), -2);
const rollDate = (y, m) => addBiz(lastTradeDate(y, m), -ROLL_BDAYS);
const contractSym = (root, y, m) => `/${root}${QCODE[m]}${String(y).slice(2)}`;
function parseSym(sym) { const m = /^\/([A-Z0-9]+?)([HMUZ])(\d{2})$/.exec(sym); return m ? { root: m[1], y: 2000 + +m[3], m: CODEQ[m[2]] } : null; }
/** Quarterly contracts whose last trade date is on/after d, nearest first. */
function quarterliesFrom(d, count = TRACKED_QUARTERLIES) {
  let y = +d.slice(0, 4), m = +d.slice(5, 7); while (m % 3) m++;
  const out = [];
  while (out.length < count) { if (lastTradeDate(y, m) >= d) out.push({ y, m }); m += 3; if (m > 12) { m -= 12; y++; } }
  return out;
}
/** The contract whose settle-to-settle P&L belongs to session date d: the first quarterly whose roll date is on/after d
 *  (on the roll date itself the OLD contract carries the day; the new one starts from that day's settlement). */
function holdingFor(d) { for (const q of quarterliesFrom(d, 3)) if (rollDate(q.y, q.m) >= d) return q; throw new Error(`no holding contract for ${d}`); }

// ── quote clock: which session a Schwab futures quote belongs to ─────────────────────────────────────────────────────────
const _et = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
function etParts(ms) { const p = Object.fromEntries(_et.formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24, minute: +p.minute }; }
/** Trade date of an instant = the latest business day D whose Globex session has opened. The session for D opens 18:00 ET on the
 *  business day before D, or on the Sunday after it when that is a Friday (no weekend session). Fri 17:14 -> Fri; Fri 18:30 / Sat /
 *  Sun 17:00 -> Fri; Sun 19:00 -> Mon; Mon 18:30 -> Tue; Wed-before-Thanksgiving 18:30 and Thanksgiving itself -> the Friday. */
function tradeDateOf(ms) {
  const e = etParts(ms); let D = isBiz(e.date) ? e.date : prevBiz(e.date);
  const nx = nextBiz(D), openDay = new Date(D + "T12:00:00Z").getUTCDay() === 5 ? addDays(D, 2) : D;
  if (e.date > openDay || (e.date === openDay && e.hour >= 18)) D = nx;
  return D;
}
/** closePrice in a quote stamped `ms` = the settlement of this business day. */
const settleDateOf = (ms) => prevBiz(tradeDateOf(ms));

// ── rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function readRows(file = LEDGER) { if (!fs.existsSync(file)) return []; return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l, k) => { try { return JSON.parse(l); } catch { throw new Error(`${path.basename(file)} line ${k + 1} is not JSON — refusing to append to a corrupt record`); } }); }
/** settles[date][sym] = price, from settle rows (first value wins; conflicts are separate rows). */
function settleBook(rows) { const b = {}; for (const r of rows) if (r.kind === "settle") for (const [s, v] of Object.entries(r.contracts || {})) { (b[r.settleDate] = b[r.settleDate] || {}); if (b[r.settleDate][s] == null) b[r.settleDate][s] = v; } return b; }
/** Delivered settles plus "settle-reconstructed" rows (appended by hand with a source, e.g. the 15:00 ET 1-minute bar of the held
 *  contract) ONLY where no delivered settle exists. recon = Set of "date|sym" that came from a reconstruction. Gaps stay recorded. */
function settleBookMerged(rows) {
  const b = settleBook(rows), recon = new Set();
  for (const r of rows) if (r.kind === "settle-reconstructed" && r.source) for (const [s, v] of Object.entries(r.contracts || {})) { if (!(v > 0)) continue; (b[r.settleDate] = b[r.settleDate] || {}); if (b[r.settleDate][s] == null) { b[r.settleDate][s] = v; recon.add(`${r.settleDate}|${s}`); } }
  return { book: b, recon };
}
const reconstructedUsed = (path, recon) => path.flatMap((p) => [`${p.from}|${p.sym}`, `${p.to}|${p.sym}`]).filter((k) => recon.has(k));
function trackedSymbols(today) {
  const out = { std: [], micro: [], byLeg: {} };
  for (const c of TRIO) { const L = LEGS[c], qs = quarterliesFrom(today), front = holdingFor(today);
    out.byLeg[c] = { std: qs.map((q) => contractSym(L.root, q.y, q.m)), front: contractSym(L.root, front.y, front.m), microFront: contractSym(L.micro, front.y, front.m) };
    out.std.push(...out.byLeg[c].std); out.micro.push(out.byLeg[c].microFront); }
  return out;
}
/** Pure: the settle row (or conflict rows) a quote response yields. resp = Schwab /quotes JSON. */
function settleRowsFrom(resp, nowMs, rows, symbols) {
  const book = settleBook(rows), byDate = {}, conflicts = [], calendar = [], problems = [];
  for (const sym of symbols) {
    const v = resp[sym]; if (!v || !v.quote) { problems.push(`${sym}: not returned`); continue; }
    const q = v.quote, rf = v.reference || {}, px = Number(q.closePrice);
    if (v.assetMainType && v.assetMainType !== "FUTURE") { problems.push(`${sym}: assetMainType ${v.assetMainType}`); continue; }
    if (!(px > 0)) { problems.push(`${sym}: closePrice ${q.closePrice}`); continue; }
    const sd = settleDateOf(nowMs);                   // the session state at request time decides what closePrice holds (quoteTime can be stale on a deferred month)
    const ps = parseSym(sym); if (ps && rf.futureExpirationDate) { const exp = etParts(Number(rf.futureExpirationDate) + 6 * 3600e3).date, mine = lastTradeDate(ps.y, ps.m); if (exp !== mine) calendar.push({ sym, schwabLastTrade: exp, computed: mine }); }
    const have = book[sd] && book[sd][sym];
    if (have != null && have !== px) conflicts.push({ sym, settleDate: sd, recorded: have, now: px });
    else if (have == null) (byDate[sd] = byDate[sd] || {})[sym] = px;
  }
  const out = Object.entries(byDate).map(([sd, contracts]) => ({ kind: "settle", settleDate: sd, contracts, source: "Schwab quote closePrice (= previous trade date's settlement)", quotedAt: new Date(nowMs).toISOString() }));
  for (const c of conflicts) out.push({ kind: "settle-conflict", ...c, note: "first recorded value kept" });
  return { rows: out, calendar, problems };
}
/** Contracts whose settle on session date d a month row can need: each leg's holding contract, plus the next one on its roll date. */
function neededSymbols(d) {
  const h = holdingFor(d), roll = rollDate(h.y, h.m) === d, out = [];
  for (const c of TRIO) { out.push(contractSym(LEGS[c].root, h.y, h.m)); if (roll) { const nx = holdingFor(nextBiz(d)); out.push(contractSym(LEGS[c].root, nx.y, nx.m)); } }
  return out;
}
/** Pure: one settle-gap row per business day from the first recorded settle up to (not including) this run's settle date whose needed settles
 *  no run captured (closePrice only ever carries the previous business day's settle — a missed run loses that session for good).
 *  critical = a month-end or roll date from the first decision's month end on (a month row or a roll depends on it). Written once. */
function settleGapRows(rows, nowMs) {
  const book = settleBook(rows), dates = Object.keys(book).sort(), out = [];
  if (!dates.length) return out;
  const sdNow = settleDateOf(nowMs), done = new Set(rows.filter((r) => r.kind === "settle-gap").map((r) => r.settleDate)), firstNeeded = lastBizOfMonth(FIRST_DECISION);
  for (let d = dates[0]; d < sdNow; d = nextBiz(d)) {          // from the first recorded date itself (a partial first settle counts)
    if (done.has(d)) continue;
    const have = book[d] || {}, missing = neededSymbols(d).filter((s) => !(have[s] > 0));
    if (!missing.length) continue;
    const h = holdingFor(d), monthEnd = d === lastBizOfMonth(d.slice(0, 7)), roll = rollDate(h.y, h.m) === d, critical = (monthEnd || roll) && d >= firstNeeded;
    out.push({ kind: "settle-gap", settleDate: d, missing, critical, monthEnd, rollDate: roll,
      why: `no run captured the ${d} settlement of ${missing.join(" ")} (closePrice only carries the previous business day's settle)${critical ? `; a ${monthEnd ? "month row" : "roll"} depends on it — pending until a settle labelled reconstructed is supplied (never as delivered)` : ""}` });
  }
  return out;
}
/** Pure: the live-book row (front standard + micro), or why there is none. */
function quoteRowFrom(resp, nowMs, tracked) {
  const legs = {}, why = [];
  for (const c of TRIO) for (const sym of [tracked.byLeg[c].front, tracked.byLeg[c].microFront]) {
    const v = resp[sym], q = v && v.quote; if (!q) { why.push(`${sym} not returned`); continue; }
    const bid = Number(q.bidPrice), ask = Number(q.askPrice), age = nowMs - Number(q.quoteTime), tick = Number(q.tick) || null;
    if (q.quotedInSession !== true) { why.push(`${sym} quotedInSession ${q.quotedInSession} (${q.securityStatus || "?"})`); continue; }
    if (!(age <= QUOTE_MAX_AGE_MS)) { why.push(`${sym} quote ${Math.round(age / 1000)}s old`); continue; }
    if (!(bid > 0 && ask > bid)) { why.push(`${sym} one-sided or crossed (${bid}/${ask})`); continue; }
    legs[sym] = { leg: c, bid, ask, mid: (bid + ask) / 2, last: Number(q.lastPrice) || null, spreadTicks: tick ? Math.round((ask - bid) / tick) : null, spreadBps: +(1e4 * (ask - bid) / ((bid + ask) / 2)).toFixed(2), quoteTime: new Date(Number(q.quoteTime)).toISOString() };
  }
  return { kind: "quote", at: new Date(nowMs).toISOString(), tradeDate: tradeDateOf(nowMs), legs, missing: why };
}

// ── decisions and month rows (shared R312 code) ──────────────────────────────────────────────────────────────────────────
/** Is FRED complete enough to decide at the end of month M? spot: a fixing on/after M's last business day or any fixing in M+1;
 *  required daily fill rates (DTB3, ECBDFR): an observation on/after M's last business day; SONIA optional (registered: else flat). */
function fredCompleteFor(raw, M) {
  const lb = lastBizOfMonth(M), nx = C.addM(M, 1), why = [];
  for (const c of TRIO) { const rows = raw[C.CCY[c].spot] || [], last = rows.length ? rows[rows.length - 1].d : null; if (!last || last < lb) why.push(`${C.CCY[c].spot} last fixing ${last} < ${lb} (waiting for H.10; any ${nx} fixing also completes it)`); }
  for (const id of [C.US.fill, C.CCY.EUR.fill]) { const rows = raw[id] || [], last = rows.length ? rows[rows.length - 1].d : null; if (!last || last < lb) why.push(`${id} last ${last} < ${lb}`); }
  return { complete: !why.length, why };
}
/** numeraire = the return numeraire in force (registry decision at decision time). Positions under both numeraires are stamped. */
function decisionFrom(raw, M, meta = {}, { numeraire = "registered" } = {}) {
  const ok = fredCompleteFor(raw, M); if (!ok.complete) return { pending: true, why: ok.why };
  const byNum = {};
  for (const nm of C.NUMERAIRES) { const panel = C.buildPanel(raw, TRIO, { lastMonth: M, numeraire: nm }); byNum[nm] = C.decideMonth(panel, TRIO, M); }
  const dec = byNum[numeraire]; if (!dec) throw new Error(`decisionFrom: unknown numeraire ${numeraire}`);
  const bad = TRIO.filter((c) => !dec[c]); if (bad.length) return { pending: true, why: [`decision inputs missing for ${bad.join(",")}`] };
  const positions = Object.fromEntries(TRIO.map((c) => [c, dec[c].pos]));
  const positionsByNumeraire = Object.fromEntries(C.NUMERAIRES.map((nm) => [nm, Object.fromEntries(TRIO.map((c) => [c, byNum[nm][c] ? byNum[nm][c].pos : null]))]));
  const inputs = Object.fromEntries(TRIO.map((c) => { const d = dec[c]; return [c, { spotDate: d.spotDate, spot: +d.spot.toFixed(6), rUS: +d.rUS.toFixed(6), rF: +d.rF.toFixed(6), gap: +d.gap.toFixed(6), candidate: d.cand, cumLong12: +d.cumLong.toFixed(6), cumShort12: +d.cumShort.toFixed(6), filledUS: d.filledUS, filledF: d.filledF }]; }));
  return { pending: false, row: { kind: "decision", decisionMonth: M, holdMonth: C.addM(M, 1), returnNumeraire: numeraire, positions, positionsByNumeraire, inputs, ...meta } };
}
/** Futures long-foreign return over (s0, s1] on the fixed roll path, from settles only. null + why when a needed settle is missing. */
function futuresChain(book, root, s0, s1) {
  const segs = []; let d = nextBiz(s0);
  while (d <= s1) { const h = holdingFor(d), sym = contractSym(root, h.y, h.m); if (!segs.length || segs[segs.length - 1].sym !== sym) segs.push({ sym, from: prevBiz(d), to: d }); else segs[segs.length - 1].to = d; d = nextBiz(d); }
  let ratio = 1, diffSum = 0; const missing = [], path = [];
  for (const s of segs) { const a = book[s.from] && book[s.from][s.sym], b = book[s.to] && book[s.to][s.sym]; if (!(a > 0) || !(b > 0)) { missing.push(`${s.sym} settle ${!(a > 0) ? s.from : s.to}`); continue; } ratio *= b / a; diffSum += b - a; path.push({ sym: s.sym, from: s.from, to: s.to, settleFrom: a, settleTo: b }); }
  return missing.length ? { ok: false, missing } : { ok: true, longRet: ratio - 1, priceDiffSum: diffSum, path, entry: path[0].settleFrom };
}
function monthRowFrom(rows, raw, H) {
  const decRow = rows.find((r) => r.kind === "decision" && r.holdMonth === H); if (!decRow) return { pending: true, why: [`no decision for ${H}`] };
  const ok = fredCompleteFor(raw, H); if (!ok.complete) return { pending: true, why: ok.why };
  const { book, recon } = settleBookMerged(rows), s0 = lastBizOfMonth(C.addM(H, -1)), s1 = lastBizOfMonth(H);
  const panel = C.buildPanel(raw, TRIO, { lastMonth: H, numeraire: "registered" }), i = panel.months.indexOf(H), legs = {}, why = [];
  for (const c of TRIO) {
    const fc = futuresChain(book, LEGS[c].root, s0, s1); if (!fc.ok) { why.push(...fc.missing.map((m) => `${c} ${m}`)); continue; }
    const R = C.legReturns(panel, c), pos = decRow.positions[c], cipLong = R.long[i], cipShortRegistered = R.short[i];
    if (!fin(cipLong)) { why.push(`${c} CIP return for ${H} not computable`); continue; }
    // both sides in USD per USD of notional (a short future earns -1 x the long); the registered-formula short is reported only
    const futDir = pos * fc.longRet, cipDir = pos * cipLong, cipDirRegisteredFormula = pos === 1 ? cipLong : pos === -1 ? cipShortRegistered : 0, inp = decRow.inputs && decRow.inputs[c];
    // the same CIP formula on the DECISION-TIME rate vintage (OECD may publish the decision month later and replace the fill)
    const cipLongDecRates = inp && fin(inp.spot) && fin(inp.rUS) && fin(inp.rF) ? (panel.legs[c].S[i] / inp.spot) * (1 + inp.rF / 1200) / (1 + inp.rUS / 1200) - 1 : null;
    legs[c] = { pos, futuresLongRet: fc.longRet, cipLongRet: cipLong, cipLongRetAtDecisionRates: cipLongDecRates, rateVintageNote: "cipLongRet uses the rates in the month-row FRED pull (as the historical read does); the AtDecisionRates form uses the decision row's rates", futuresMinusCipLong: fc.longRet - cipLong, futuresDirRet: futDir, cipDirRet: cipDir, diffDir: futDir - cipDir,
      cipDirRegisteredFormula, cipDirNote: "cipDirRet = pos x (S1/F - 1), USD; cipDirRegisteredFormula = the registered short F/S1 - 1 on short legs (long-USD return in FOREIGN currency; reported only)",
      pnlUsdMicro: +(pos * fc.priceDiffSum * LEGS[c].notional).toFixed(2), microNotional: LEGS[c].notional, path: fc.path };
  }
  if (why.length) return { pending: true, why };
  const m = (k) => TRIO.reduce((s, c) => s + legs[c][k], 0) / TRIO.length, reconUsed = [...new Set(TRIO.flatMap((c) => reconstructedUsed(legs[c].path, recon)))];
  return { pending: false, row: { kind: "month", holdMonth: H, decidedAtMonthEnd: decRow.decisionMonth, settleFrom: s0, settleTo: s1, recordType: reconUsed.length ? "reconstructed-undelivered" : "evidence", reconstructedSettles: reconUsed, legs,
    portfolio: { futuresDirMean: m("futuresDirRet"), cipDirMean: m("cipDirRet"), diffDirMean: m("diffDir"), pnlUsdMicro: +TRIO.reduce((s, c) => s + legs[c].pnlUsdMicro, 0).toFixed(2) },
    note: "futures on settlement prices along the fixed roll path; CIP synthetic from FRED month-end fixings (noon NY) and the decision month's (filled) rates; no costs on either side — spreads are in the quote rows" } };
}

// ── I/O ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function getQuotes(symbols) {
  const tok = await require("./lib/schwab.js").token();
  const r = await fetch(`https://api.schwabapi.com/marketdata/v1/quotes?symbols=${encodeURIComponent(symbols.join(","))}&fields=quote,reference&indicative=false`, { headers: { Authorization: "Bearer " + tok, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`schwab quotes HTTP ${r.status}`);
  return r.json();
}
function appendRows(rows) { if (!rows.length) return; const txt = rows.map((r) => JSON.stringify({ ts: new Date().toISOString(), test: "R312", recordType: "forward-measurement (weightless, no orders)", ...r })).join("\n") + "\n"; fs.appendFileSync(LEDGER, txt); }
async function fredForToday(today) {
  const dir = path.join(FWD_DIR, `fred-${today}`);
  const { raw, sha, files } = await C.loadOrFetch(dir, { allowFetch: true, ids: FWD_SERIES });
  return { raw, sha, dir: path.relative(path.join(__dirname, ".."), dir).split(path.sep).join("/"), files };
}
const runnerShas = () => ({ carry: sha256(fs.readFileSync(path.join(__dirname, "r312-europe-carry.js"))), recorder: sha256(fs.readFileSync(__filename)) });

async function daily() {
  const nowMs = Date.now(), today = etParts(nowMs).date, rows = readRows(), add = [];
  const tracked = trackedSymbols(today), symbols = [...tracked.std, ...tracked.micro];
  // 1. quotes -> settles + live book
  let resp = null;
  try { resp = await getQuotes(symbols); } catch (e) { add.push({ kind: "error", stage: "quotes", why: e.message }); }
  if (resp) {
    const st = settleRowsFrom(resp, nowMs, rows, tracked.std), qr = quoteRowFrom(resp, nowMs, tracked);
    add.push(...st.rows);
    add.push(...settleGapRows(rows.concat(add), nowMs));
    if (st.calendar.length) add.push({ kind: "calendar-mismatch", items: st.calendar, note: "Schwab futureExpirationDate differs from the computed last trade date — the roll schedule may be wrong; fix before the next roll" });
    if (st.problems.length) add.push({ kind: "quote-problems", items: st.problems });
    if (!rows.some((r) => r.kind === "quote" && r.tradeDate === qr.tradeDate)) add.push(qr);
  }
  // 2. decisions (from the 2026-10 month end) and 3. month rows — FRED only when something is pending
  const lastDoneMonth = C.addM(tradeDateOf(nowMs).slice(0, 7), -1), want = [];
  for (let M = FIRST_DECISION; M <= lastDoneMonth; M = C.addM(M, 1)) {
    if (tradeDateOf(nowMs) <= lastBizOfMonth(M)) break;
    if (!rows.some((r) => r.kind === "decision" && r.decisionMonth === M)) want.push({ kind: "decision", M });
    const H = M; if (H > FIRST_DECISION && !rows.some((r) => r.kind === "month" && r.holdMonth === H)) want.push({ kind: "month", H });
  }
  const pending = [];
  // the return numeraire in force comes from the REGISTRY at decision time (the same preReadDecision the historical read uses)
  let gateDec = null;
  if (want.some((w) => w.kind === "decision")) { try { gateDec = C.preReadDecision(C.registryEntry()); } catch (e) { gateDec = { decided: false, why: e.message }; } if (!gateDec.decided) add.push({ kind: "error", stage: "decision", why: `R312 pre-read decision unreadable (${gateDec.why}) — no decision recorded` }); }
  if (want.length) {
    let fred = null;
    try { fred = await fredForToday(today); } catch (e) { add.push({ kind: "error", stage: "fred", why: e.message }); }
    if (fred) {
      const shas = runnerShas(), all = rows.concat(add);
      for (const w of want) {
        if (w.kind === "decision") { if (!gateDec || !gateDec.decided) { pending.push(`decision ${w.M}: registry decision unreadable`); continue; } const d = decisionFrom(fred.raw, w.M, { decidedAt: new Date(nowMs).toISOString(), lagBusinessDays: bizBetween(lastBizOfMonth(w.M), today), fred: { dir: fred.dir, sha256: fred.sha }, runners: shas, gateTokens: C.gateTokensOf(gateDec) }, { numeraire: gateDec.numeraire }); if (d.pending) pending.push(`decision ${w.M}: ${d.why.join("; ")}`); else { add.push(d.row); all.push(d.row); } }
        else { const m = monthRowFrom(all, fred.raw, w.H); if (m.pending) pending.push(`month ${w.H}: ${m.why.join("; ")}`); else { m.row.fred = { dir: fred.dir, sha256: fred.sha }; m.row.runners = shas; add.push(m.row); all.push(m.row); } }
      }
    }
  }
  if (DRY) { console.log(`R312 forward DRY RUN — would append ${add.length} rows:`); for (const r of add) console.log("  " + JSON.stringify(r).slice(0, 600)); }
  else appendRows(add);
  const errs = add.filter((r) => r.kind === "error" || r.kind === "calendar-mismatch" || r.kind === "settle-conflict" || (r.kind === "settle-gap" && r.critical));
  const gaps = add.filter((r) => r.kind === "settle-gap");
  console.log(`R312 forward ${today}: ${add.filter((r) => r.kind === "settle").map((r) => `settle ${r.settleDate} (${Object.keys(r.contracts).length})`).join(", ") || "no new settles"} · quote ${add.some((r) => r.kind === "quote") ? (Object.keys(add.find((r) => r.kind === "quote").legs).length + " books") : "—"} · decisions ${add.filter((r) => r.kind === "decision").map((r) => `${r.decisionMonth} ${JSON.stringify(r.positions)}`).join(" ") || "none due"} · months ${add.filter((r) => r.kind === "month").map((r) => r.holdMonth).join(",") || "none"}${gaps.length ? ` · SETTLE GAPS ${gaps.map((r) => `${r.settleDate}${r.critical ? " (CRITICAL)" : ""}`).join(", ")}` : ""}${pending.length ? ` · pending: ${pending.join(" | ")}` : ""}${errs.length ? ` · PROBLEMS ${errs.length}` : ""}`);
  // loud, never silent: an error or a NEW critical settle gap (a month row / roll that can no longer be built from delivered settles) exits 1
  if (errs.some((r) => r.kind === "error" || r.kind === "settle-gap")) process.exitCode = 1;
}
function bizBetween(a, b) { let n = 0, d = a; while (d < b) { d = nextBiz(d); if (d <= b) n++; } return n; }

async function quoteCheck() {
  const nowMs = Date.now(), today = etParts(nowMs).date, tracked = trackedSymbols(today);
  console.log(`R312 quote check ${new Date(nowMs).toISOString()} (ET ${today}; trade date ${tradeDateOf(nowMs)}; closePrice = settle of ${settleDateOf(nowMs)})`);
  const roots = await getQuotes(["/6E", "/6B", "/6S"]);
  console.log(`  roots /6E /6B /6S -> keys ${JSON.stringify(Object.keys(roots))}`);
  for (const [k, v] of Object.entries(roots)) { const q = v.quote || {}, rf = v.reference || {}; console.log(`    ${k}: bid ${q.bidPrice} ask ${q.askPrice} last ${q.lastPrice} closePrice ${q.closePrice} inSession ${q.quotedInSession} status ${q.securityStatus} quoteTime ${q.quoteTime ? new Date(q.quoteTime).toISOString() : null} expiry ${rf.futureExpirationDate ? etParts(rf.futureExpirationDate + 6 * 3600e3).date : null} mult ${rf.futureMultiplier} "${rf.description}"`); }
  const resp = await getQuotes([...tracked.std, ...tracked.micro]);
  console.log(`  tracked ${[...tracked.std, ...tracked.micro].join(" ")} -> returned ${Object.keys(resp).length}`);
  for (const c of TRIO) { const h = holdingFor(today), lt = lastTradeDate(h.y, h.m), rd = rollDate(h.y, h.m); console.log(`  ${c}: holding ${tracked.byLeg[c].front} (last trade ${lt}, roll at the ${rd} settle) micro ${tracked.byLeg[c].microFront}`); }
  const st = settleRowsFrom(resp, nowMs, readRows(), tracked.std), qr = quoteRowFrom(resp, nowMs, tracked);
  console.log(`  settles parsed: ${JSON.stringify(st.rows)}`); console.log(`  calendar check: ${st.calendar.length ? JSON.stringify(st.calendar) : "all computed last-trade dates match Schwab"} · problems ${JSON.stringify(st.problems)}`);
  console.log(`  live book: ${Object.keys(qr.legs).length} two-sided in-session · missing ${JSON.stringify(qr.missing)}`);
  console.log("  (nothing written)");
}
function status() {
  const rows = readRows(), dec = rows.filter((r) => r.kind === "decision"), mon = rows.filter((r) => r.kind === "month"), st = rows.filter((r) => r.kind === "settle"), gp = rows.filter((r) => r.kind === "settle-gap");
  console.log(`R312 forward record — ${rows.length} rows · settles ${st.length} (last ${st.length ? st[st.length - 1].settleDate : "—"}) · settle gaps ${gp.length}${gp.some((r) => r.critical) ? ` (CRITICAL ${gp.filter((r) => r.critical).map((r) => r.settleDate).join(",")})` : ""} · decisions ${dec.map((r) => `${r.decisionMonth}:${JSON.stringify(r.positions)}${r.returnNumeraire ? `[${r.returnNumeraire}]` : ""}`).join(" ") || "none (first at the 2026-10 month end)"} · months ${mon.length}`);
  for (const r of mon) console.log(`  ${r.holdMonth}: futures ${(100 * r.portfolio.futuresDirMean).toFixed(3)}% vs CIP ${(100 * r.portfolio.cipDirMean).toFixed(3)}% (diff ${(100 * r.portfolio.diffDirMean).toFixed(3)}%) · micro P&L $${r.portfolio.pnlUsdMicro}`);
}

// ── selftest (offline: no network, no writes) ────────────────────────────────────────────────────────────────────────────
function selftest() {
  const checks = {}, detail = {}, close = (a, b, e = 1e-12) => fin(a) && fin(b) && Math.abs(a - b) <= e;
  // calendar: CME FX last trade = 2 business days before the 3rd Wednesday; roll 5 business days earlier. Dec-2026 and Mar-2027 match Schwab's
  // futureExpirationDate seen 2026-10-02 (/6EZ26 2026-12-14, /6EH27 2027-03-15).
  checks.lastTradeDates = lastTradeDate(2026, 12) === "2026-12-14" && lastTradeDate(2027, 3) === "2027-03-15" && lastTradeDate(2027, 6) === "2027-06-14" && lastTradeDate(2026, 9) === "2026-09-14" && thirdWednesday(2026, 12) === "2026-12-16";
  checks.rollDates = rollDate(2026, 12) === "2026-12-07" && rollDate(2027, 3) === "2027-03-08";
  checks.holding = (() => { const h = (d) => { const q = holdingFor(d); return contractSym("6E", q.y, q.m); }; return h("2026-10-02") === "/6EZ26" && h("2026-10-30") === "/6EZ26" && h("2026-12-07") === "/6EZ26" && h("2026-12-08") === "/6EH27" && h("2027-03-08") === "/6EH27" && h("2027-03-09") === "/6EM27"; })();
  checks.symbols = contractSym("6E", 2026, 12) === "/6EZ26" && contractSym("MSF", 2027, 3) === "/MSFH27" && JSON.stringify(parseSym("/M6BZ26")) === JSON.stringify({ root: "M6B", y: 2026, m: 12 }) && trackedSymbols("2026-10-02").std.length === 9 && trackedSymbols("2026-10-02").byLeg.CHF.microFront === "/MSFZ26";
  checks.lastBiz = lastBizOfMonth("2026-10") === "2026-10-30" && lastBizOfMonth("2026-11") === "2026-11-30" && lastBizOfMonth("2027-07") === "2027-07-30" && prevBiz("2026-11-27") === "2026-11-25";
  // quote clock: the 2026-10-02 17:14 ET observation (closePrice = the 10-01 settle); evening = next trade date; Sunday evening = Monday
  const etMs = (d, hm) => { for (const off of [4, 5]) { const ms = Date.parse(`${d}T${hm}:00Z`) + off * 3600e3, e = etParts(ms); if (e.date === d && `${String(e.hour).padStart(2, "0")}:${String(e.minute).padStart(2, "0")}` === hm) return ms; } throw new Error("et"); };
  checks.quoteClock = settleDateOf(etMs("2026-10-02", "17:14")) === "2026-10-01" && tradeDateOf(etMs("2026-10-02", "18:30")) === "2026-10-02" && settleDateOf(etMs("2026-10-03", "12:00")) === "2026-10-01"
    && settleDateOf(etMs("2026-10-04", "17:00")) === "2026-10-01" && settleDateOf(etMs("2026-10-04", "19:00")) === "2026-10-02" && settleDateOf(etMs("2026-10-05", "16:19")) === "2026-10-02"
    && tradeDateOf(etMs("2026-10-05", "18:30")) === "2026-10-06" && settleDateOf(etMs("2026-10-05", "18:30")) === "2026-10-05" && settleDateOf(etMs("2026-11-27", "10:00")) === "2026-11-25" && tradeDateOf(etMs("2026-11-25", "18:30")) === "2026-11-27";
  // settle rows: first value kept, conflict recorded, idempotent on re-run, calendar mismatch caught
  { const nowMs = etMs("2026-10-05", "16:19"), mk = (px, exp) => ({ "/6EZ26": { assetMainType: "FUTURE", quote: { closePrice: px, quoteTime: nowMs }, reference: { futureExpirationDate: Date.parse(`${exp}T05:00:00Z`) } } });
    const a = settleRowsFrom(mk(1.1268, "2026-12-14"), nowMs, [], ["/6EZ26"]), rows = a.rows;
    const b = settleRowsFrom(mk(1.1268, "2026-12-14"), nowMs, rows, ["/6EZ26"]), c = settleRowsFrom(mk(1.13, "2026-12-14"), nowMs, rows, ["/6EZ26"]), d = settleRowsFrom(mk(1.1268, "2026-12-15"), nowMs, [], ["/6EZ26"]);
    checks.settleRows = rows.length === 1 && rows[0].settleDate === "2026-10-02" && rows[0].contracts["/6EZ26"] === 1.1268 && !a.calendar.length && b.rows.length === 0 && c.rows.length === 1 && c.rows[0].kind === "settle-conflict" && d.calendar.length === 1; }
  // live book: stale / out-of-session / crossed quotes are refused, never marked
  { const nowMs = etMs("2026-10-05", "16:19"), tr = trackedSymbols("2026-10-05"), resp = {};
    for (const c of TRIO) { resp[tr.byLeg[c].front] = { quote: { bidPrice: 1.1, askPrice: 1.1001, quotedInSession: true, quoteTime: nowMs - 1000, tick: 0.00005 } }; resp[tr.byLeg[c].microFront] = { quote: { bidPrice: 1.1, askPrice: 1.1001, quotedInSession: false, securityStatus: "Closed", quoteTime: nowMs } }; }
    resp[tr.byLeg.GBP.front].quote.quoteTime = nowMs - 3600e3;
    const q = quoteRowFrom(resp, nowMs, tr);
    checks.liveBookGuards = Object.keys(q.legs).length === 2 && q.missing.length === 4 && q.legs["/6EZ26"].spreadTicks === 2; }
  // futures chain across the Dec-2026 roll (settle 12-07 on both Z26 and H27) — known answer; a missing roll-day settle refuses
  { const book = { "2026-11-30": { "/6EZ26": 1.10 }, "2026-12-07": { "/6EZ26": 1.12, "/6EH27": 1.125 }, "2026-12-31": { "/6EH27": 1.15 } };
    const fc = futuresChain(book, "6E", "2026-11-30", "2026-12-31"), want = (1.12 / 1.10) * (1.15 / 1.125) - 1;
    const miss = futuresChain({ "2026-11-30": { "/6EZ26": 1.10 }, "2026-12-31": { "/6EH27": 1.15 } }, "6E", "2026-11-30", "2026-12-31");
    checks.rollChain = fc.ok && close(fc.longRet, want) && close(fc.priceDiffSum, 0.02 + 0.025) && fc.path.length === 2 && fc.path[0].to === "2026-12-07" && fc.path[1].from === "2026-12-07" && !miss.ok && miss.missing.length === 2;
    // micro P&L: short EUR (pos -1) over that path on 12,500 EUR = -1 x 0.045 x 12,500 = -562.50
    checks.microPnl = close(-1 * fc.priceDiffSum * LEGS.EUR.notional, -562.5, 1e-9); }
  // decision + month row through the SHARED code on a synthetic FRED set; positions equal r312-europe-carry.js decideAt on the same panel
  { const months = C.monthsBetween("2025-01", "2026-12"), raw = {};
    const bizIn = (ym) => { const out = []; for (let d = `${ym}-01`; d.slice(0, 7) === ym; d = addDays(d, 1)) { const w = new Date(d + "T12:00:00Z").getUTCDay(); if (w && w !== 6) out.push(d); } return out; };
    const sp = { EUR: (k) => 1.05 + 0.004 * k, GBP: (k) => 1.30 - 0.002 * k, CHF: (k) => 1.10 + 0.003 * Math.sin(k) };
    for (const c of TRIO) { const cfg = C.CCY[c]; raw[cfg.spot] = months.flatMap((m, k) => bizIn(m).map((d) => ({ d, v: cfg.invert ? 1 / sp[c](k) : sp[c](k) }))); raw[cfg.rate] = months.filter((m) => m <= "2026-08").map((m) => ({ d: `${m}-01`, v: { EUR: 2.0, GBP: 4.0, CHF: 0.0 }[c] })); if (cfg.fill) raw[cfg.fill] = months.flatMap((m) => bizIn(m).map((d) => ({ d, v: { EUR: 2.0, GBP: 3.9 }[c] }))); }
    raw[C.US.rate] = months.filter((m) => m <= "2026-08").map((m) => ({ d: `${m}-01`, v: 4.2 })); raw[C.US.fill] = months.flatMap((m) => bizIn(m).map((d) => ({ d, v: 4.0 })));
    const cut = (r, upto) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.filter((x) => x.d <= upto)]));
    const early = fredCompleteFor(cut(raw, "2026-10-23"), "2026-10"), dOk = decisionFrom(cut(raw, "2026-11-04"), "2026-10");
    const P = C.buildPanel(cut(raw, "2026-11-04"), TRIO, { lastMonth: "2026-11" }), i = P.months.indexOf("2026-11");
    const parity = TRIO.every((c) => { const h = C.decideAt(P, C.legReturns(P, c), c, i); return h && dOk.row && h.pos === dOk.row.positions[c]; });
    checks.decisionShared = early.complete === false && !dOk.pending && parity && dOk.row.holdMonth === "2026-11" && dOk.row.inputs.EUR.filledUS === true && dOk.row.inputs.EUR.filledF === true;
    detail.decision = dOk.row && { positions: dOk.row.positions, eur: dOk.row.inputs.EUR };
    // month row for 2026-11: settles at 10-30 and 11-30 on Z26; CIP from the same raw
    const rows = [dOk.row, { kind: "settle", settleDate: "2026-10-30", contracts: { "/6EZ26": 1.10, "/6BZ26": 1.25, "/6SZ26": 1.20 } }, { kind: "settle", settleDate: "2026-11-30", contracts: { "/6EZ26": 1.11, "/6BZ26": 1.24, "/6SZ26": 1.21 } }];
    const mr = monthRowFrom(rows, cut(raw, "2026-12-04"), "2026-11"), R = C.legReturns(C.buildPanel(cut(raw, "2026-12-04"), TRIO, { lastMonth: "2026-11" }), "EUR");
    const P2 = C.buildPanel(cut(raw, "2026-12-04"), TRIO, { lastMonth: "2026-11" }), j = P2.months.indexOf("2026-11");
    checks.monthRow = !mr.pending && close(mr.row.legs.EUR.futuresLongRet, 1.11 / 1.10 - 1) && close(mr.row.legs.EUR.cipLongRet, R.long[j]) && close(mr.row.legs.EUR.cipLongRetAtDecisionRates, R.long[j], 1e-12) && mr.row.legs.EUR.pos === dOk.row.positions.EUR
      && close(mr.row.legs.GBP.pnlUsdMicro, +(dOk.row.positions.GBP * (1.24 - 1.25) * 6250).toFixed(2), 1e-9) && monthRowFrom(rows.slice(0, 2), cut(raw, "2026-12-04"), "2026-11").pending === true;
    detail.month = mr.row && mr.row.portfolio;
    // futures-vs-CIP in ONE numeraire: on a short leg cipDirRet = -cipLongRet and diffDir = -(futures - CIP long); the registered short is reported only
    const rowsS = [{ ...dOk.row, positions: { EUR: -1, GBP: 1, CHF: 0 } }, ...rows.slice(1)], ms = monthRowFrom(rowsS, cut(raw, "2026-12-04"), "2026-11");
    const E = ms.row && ms.row.legs.EUR, G = ms.row && ms.row.legs.GBP, H0 = ms.row && ms.row.legs.CHF;
    checks.cipDirUsd = !ms.pending && close(E.cipDirRet, -E.cipLongRet, 1e-15) && close(E.diffDir, -E.futuresMinusCipLong, 1e-15) && close(E.cipDirRegisteredFormula, 1 / (1 + E.cipLongRet) - 1, 1e-12) && E.cipDirRegisteredFormula > E.cipDirRet
      && close(G.diffDir, G.futuresMinusCipLong, 1e-15) && G.cipDirRet === G.cipLongRet && H0.cipDirRet === 0 && H0.diffDir === 0 && close(E.pnlUsdMicro, +(-1 * (1.11 - 1.10) * 12500).toFixed(2), 1e-9);
    // decisions under the numeraire in force: usd positions equal decideAt on a usd panel; both numeraires stamped
    const dU = decisionFrom(cut(raw, "2026-11-04"), "2026-10", {}, { numeraire: "usd" }), PU = C.buildPanel(cut(raw, "2026-11-04"), TRIO, { lastMonth: "2026-11", numeraire: "usd" }), iu = PU.months.indexOf("2026-11");
    // a volatile EUR (months alternate +10% / -9.1%; short candidate, gap 2.2): the registered trend filter (1/prod(1+l) - 1 > 0) holds the
    // short, the USD one (prod(1-l) - 1 < 0) goes flat — the numeraire in force must decide
    const rawV = { ...raw, [C.CCY.EUR.spot]: months.flatMap((m, k) => bizIn(m).map((d) => ({ d, v: k % 2 ? 1.155 : 1.05 }))) };
    const vU = decisionFrom(cut(rawV, "2026-11-04"), "2026-10", {}, { numeraire: "usd" }), vR = decisionFrom(cut(rawV, "2026-11-04"), "2026-10", {}, { numeraire: "registered" });
    checks.decisionNumeraire = !dU.pending && dU.row.returnNumeraire === "usd" && dOk.row.returnNumeraire === "registered" && TRIO.every((c) => { const h = C.decideAt(PU, C.legReturns(PU, c), c, iu); return h && h.pos === dU.row.positions[c] && dU.row.positionsByNumeraire.usd[c] === h.pos && dU.row.positionsByNumeraire.registered[c] === dOk.row.positions[c]; })
      && !vU.pending && !vR.pending && vR.row.inputs.EUR.candidate === -1 && vR.row.positions.EUR === -1 && vU.row.positions.EUR === 0 && vU.row.positionsByNumeraire.registered.EUR === -1 && vR.row.positionsByNumeraire.usd.EUR === 0;
    detail.numeraireFlip = { registered: vR.row && vR.row.inputs.EUR.cumShort12, usd: vU.row && vU.row.inputs.EUR.cumShort12 }; }
  // settle gaps: runs 16:30 ET on 10-29, 10-30, 11-03, 11-04 with Monday 11-02 missed -> settles 10-28, 10-29, 11-02, 11-03; 10-30 (October's last
  // business day) is lost for good -> ONE critical settle-gap row, written once; the 2026-11 month row then cannot be built
  { const syms = trackedSymbols("2026-10-29").std, resp = (px) => Object.fromEntries(syms.map((s) => [s, { assetMainType: "FUTURE", quote: { closePrice: px }, reference: {} }]));
    let rows = []; const gapLog = [];
    for (const [d, px] of [["2026-10-29", 1.10], ["2026-10-30", 1.101], ["2026-11-03", 1.102], ["2026-11-04", 1.103]]) { const ms = etMs(d, "16:30"), st = settleRowsFrom(resp(px), ms, rows, syms); rows = rows.concat(st.rows); const gr = settleGapRows(rows, ms); gapLog.push(gr); rows = rows.concat(gr); }
    const recorded = rows.filter((r) => r.kind === "settle").map((r) => r.settleDate), gap = rows.filter((r) => r.kind === "settle-gap");
    const chain = futuresChain(settleBook(rows), "6E", "2026-10-30", "2026-11-30");
    const nonCrit = settleGapRows([{ kind: "settle", settleDate: "2026-10-20", contracts: Object.fromEntries(syms.map((s) => [s, 1])) }, { kind: "settle", settleDate: "2026-10-22", contracts: Object.fromEntries(syms.map((s) => [s, 1])) }], etMs("2026-10-23", "16:30"));
    const rollNeed = neededSymbols("2026-12-07"), partial = settleGapRows([{ kind: "settle", settleDate: "2026-12-04", contracts: { "/6EZ26": 1 } }, { kind: "settle", settleDate: "2026-12-07", contracts: { "/6EZ26": 1, "/6BZ26": 1, "/6SZ26": 1 } }], etMs("2026-12-09", "16:30"));
    checks.settleGaps = JSON.stringify(recorded) === JSON.stringify(["2026-10-28", "2026-10-29", "2026-11-02", "2026-11-03"]) && gap.length === 1 && gap[0].settleDate === "2026-10-30" && gap[0].critical && gap[0].monthEnd && gap[0].missing.length === 3
      && gapLog[2].length === 1 && gapLog[3].length === 0 && !chain.ok && chain.missing.some((m) => /2026-10-30/.test(m))
      && nonCrit.length === 1 && nonCrit[0].settleDate === "2026-10-21" && !nonCrit[0].critical
      && rollNeed.length === 6 && rollNeed.includes("/6EH27") && partial.some((r) => r.settleDate === "2026-12-07" && r.critical && r.rollDate && r.missing.length === 3 && r.missing.includes("/6SH27")) && partial.some((r) => r.settleDate === "2026-12-04" && !r.critical && r.missing.length === 2);
    const recRow = { kind: "settle-reconstructed", settleDate: "2026-10-30", contracts: { "/6EZ26": 1.1015 }, source: "15:00 ET 1-minute bar (test)" }, mg = settleBookMerged(rows.concat([recRow, { ...recRow, settleDate: "2026-10-29", contracts: { "/6EZ26": 9 } }]));
    const ch2 = futuresChain(mg.book, "6E", "2026-10-30", "2026-11-03"), used = ch2.ok ? reconstructedUsed(ch2.path, mg.recon) : null;
    checks.reconstructedSettle = ch2.ok && JSON.stringify(used) === JSON.stringify(["2026-10-30|/6EZ26"]) && mg.book["2026-10-29"]["/6EZ26"] === 1.101 && !mg.recon.has("2026-10-29|/6EZ26") && settleGapRows(rows.concat([recRow]), etMs("2026-11-05", "16:30")).length === 0
      && !settleBookMerged([{ ...recRow, source: undefined }]).book["2026-10-30"];
    detail.settleGaps = { recorded, gaps: gap.map((r) => [r.settleDate, r.critical]) }; }
  // source scan: no order or account code in this file (patterns assembled so they do not match themselves)
  { const src = fs.readFileSync(__filename, "utf8"), bad = [["/tr" + "ader/v", "trader endpoint"], ["/ord" + "ers", "orders path"], ["orderLeg" + "Collection", "order payload"], ["method: \"PO" + "ST\"", "POST"], ["method: 'PO" + "ST'", "POST"], ["place_" + "order", "order tool"], ["paper-" + "api.alpaca", "broker host"]].filter(([p]) => src.includes(p));
    checks.noOrderCode = !bad.length; detail.noOrderCode = bad.map((b) => b[1]); }
  // the historical runner's own selftest still passes (shared code)
  checks.sharedRunnerSelftest = C.selftest().pass;
  return { pass: Object.values(checks).every(Boolean), checks, detail };
}

async function main() {
  if (MODE === "--selftest") { const st = selftest(); console.log(`R312 forward selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`); if (!st.pass) { console.log(`  detail ${JSON.stringify(st.detail)}`); process.exit(1); } console.log(`  detail ${JSON.stringify(st.detail)}`); return; }
  const st = selftest(); if (!st.pass) { console.error(`R312 forward selftest FAIL ${JSON.stringify(st.checks)} — refusing to run`); process.exit(1); }
  if (MODE === "--quote-check") return quoteCheck();
  if (MODE === "--status") return status();
  return daily();
}
if (require.main === module) main().catch((e) => { console.error("R312 forward FAILED:", e.message); process.exit(1); });
else module.exports = { lastTradeDate, rollDate, holdingFor, tradeDateOf, settleDateOf, settleRowsFrom, quoteRowFrom, futuresChain, decisionFrom, monthRowFrom, fredCompleteFor, selftest, LEGS };
