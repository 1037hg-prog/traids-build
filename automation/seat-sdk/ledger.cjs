"use strict";
/**
 * SEAT-SDK TRIAL — THE SPEND LEDGER AND THE HARD LIMITS. backend/data/seat-sdk-ledger.jsonl, append-only: one JSON line per event,
 * never rewritten, never deleted. It is the runner's OWN record of what the SDK reported each run cost; the limits are computed from it
 * and from nothing else.
 *
 *   kind "start"        written BEFORE a run starts: it RESERVES the seat's full cap (reservedUsd). A run that never writes its "end"
 *                       (the process was killed, the PC lost power) therefore stays counted at the full cap.
 *   kind "end"          written when the run ends: costReportedUsd is what the SDK reported, countedUsd is what the limits count —
 *                       the reported cost, or, when the SDK reported none, cost "UNKNOWN" counted at the seat's FULL cap.
 *   kind "refused"      a limit refused the seat before it started (limit: "seat" | "night" | "trial" | "end-date" | "ledger" |
 *                       "switch"), with the reason and the figures; nothing was spent.
 *   kind "not-started"  the run could not start (no key, an unreadable key file, the SDK did not load, bad arguments ...): outcome
 *                       UNKNOWN with the reason; nothing was spent.
 *   every row: schema, at, session (the wave's ET day), seat, launcher "sdk".
 *
 * THE LIMITS, checked before each seat starts (check() below), in dollars counted from this ledger:
 *   the end date   from 00:00 UTC of limits.trialEnd (default 2026-11-14) the SDK path refuses — and a launch whose own minutes would
 *                  not be over by that instant is refused too (now + minutes >= the end), so no run is still spending past it.
 *   per seat       a seat's whole night — its first turn and its one follow-up turn — is budgeted at its cap (the wave's own
 *                  --max-budget-usd number). A launch gets what is left of the cap; nothing left = refused, and so is a remainder
 *                  under the floor (MIN_LAUNCH_USD, $0.25): see the next paragraph.
 *   per night      a launch starts only if its whole budget still fits under the night's cap (default $12).
 *   per trial      ... and under the trial's cap (default $180, under the $200 grant).
 * "Fits" means counted-so-far + this launch's budget <= the cap. THE CAPS ARE NOT CEILINGS TO THE CENT: the launcher looks at its
 * budget only BETWEEN two turns, so a launch that was allowed to start always runs at least one whole turn and can end past its budget
 * by what its last turn cost (the record has $2.05 against $2.00). What it reports is counted as reported, so the night's and the
 * trial's totals do see the overshoot and the next check is made against it; the trial's default cap leaves $20 under the grant for
 * it. A launch on a remainder of a fraction of a cent would be nothing but overshoot, so a launch is not started on less than the floor.
 * THE SECOND RECORD. A ledger that is not there is the first night's state — and also what a ledger that was deleted, moved or put back
 * from an older copy looks like. So the ledger is held against the seat wave's own history (backend/data/seat-wave-history.jsonl): every
 * seat row there that the SDK launched and that reported a cost above $0 must have its run in this ledger (witness(), lost()). When
 * one has none, every seat is refused ("the spend ledger is missing after the trial began"): the refusal's own row does not mend it.
 * WHAT COUNTS AS "TONIGHT". Two counts, and the LARGER one is used for the seat's cap and for the night's cap: the runs that carry
 * this session's label, and the runs the ledger's OWN clock (each row's `at`) puts in the last 20 hours, whatever label they carry. A
 * second label on the same evening therefore opens no second night and no second seat cap. A row whose `at` is not a time counts as
 * recent.
 * A ledger that cannot be read refuses every seat: limits that cannot be computed are not assumed to be fine. So does a ledger whose
 * rows give a run no usable amount (check() looks again, after read()), a limit that is not a value, a clock that is not one, and a
 * wave history that is there and cannot be read (the ledger cannot be held against it).
 *
 * Amounts are compared in whole micro-dollars, so $10.00 + $2.00 <= $12.00 is exact.
 * A module: nothing happens on load.
 */
const fs = require("fs"), path = require("path");
const SCHEMA = "seat-sdk-ledger-v1", REL = "backend/data/seat-sdk-ledger.jsonl", LAUNCHER = "sdk";
const KINDS = ["start", "end", "refused", "not-started"];
/** the floor: a launch is not started on less than this much of the seat's cap (a launch always runs at least one whole turn) */
const MIN_LAUNCH_USD = 0.25;
/** the second record the ledger is held against: the seat wave's own history, one line per wave */
const WITNESS_REL = "backend/data/seat-wave-history.jsonl";
const fileOf = (root) => path.join(root, ...REL.split("/"));
const micro = (usd) => Math.round(Number(usd) * 1e6);
const usd = (m) => m / 1e6;
const money = (m) => "$" + (m / 1e6).toFixed(2);
/** an amount that may be under a cent, said in full: whole cents as money(), anything finer to the millionth of a dollar */
const fine = (m) => (m % 10000 === 0 ? money(m) : "$" + (m / 1e6).toFixed(6));
const one = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const isAmount = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;
/** the ledger's own clock: how far back a run still counts as tonight's, whatever session label it carries */
const NIGHT_WINDOW_HOURS = 20, NIGHT_WINDOW_MS = NIGHT_WINDOW_HOURS * 3600 * 1000;
/** a row's own time in ms — NaN when the row carries none that can be read (such a row is counted as recent: fail closed) */
const atOf = (r) => (r && typeof r.at === "string" && /^\d{4}-\d{2}-\d{2}T/.test(r.at) ? Date.parse(r.at) : NaN);

/** -> { state: "absent", rows: [] } | { state: "ok", rows } | { state: "unreadable", why, rows: [] }. One bad line makes the whole ledger unreadable (fail closed). */
function read(root) {
  let text;
  try { text = fs.readFileSync(fileOf(root), "utf8"); }
  catch (e) { return e && e.code === "ENOENT" ? { state: "absent", rows: [] } : { state: "unreadable", why: `the ledger cannot be read (${(e && e.code) || "error"})`, rows: [] }; }
  const rows = [], lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let r; try { r = JSON.parse(lines[i]); } catch { return { state: "unreadable", why: `line ${i + 1} of the ledger is not JSON`, rows: [] }; }
    if (!r || typeof r !== "object" || r.schema !== SCHEMA || !KINDS.includes(r.kind) || typeof r.seat !== "string" || typeof r.session !== "string") return { state: "unreadable", why: `line ${i + 1} of the ledger is not a ${SCHEMA} row`, rows: [] };
    if (r.kind === "start" && (!r.runId || !isAmount(r.reservedUsd))) return { state: "unreadable", why: `line ${i + 1}: a start row without a run id or a reserved amount`, rows: [] };
    if (r.kind === "end" && (!r.runId || !isAmount(r.countedUsd))) return { state: "unreadable", why: `line ${i + 1}: an end row without a run id or a counted amount`, rows: [] };
    rows.push(r);
  }
  return { state: "ok", rows };
}
/**
 * what every run counts for: its end row's countedUsd, or — no end row — the amount its start row reserved.
 * -> [{ runId, seat, session, micro, settled, atMs }]   atMs: the latest time its rows carry (NaN when one of them carries none)
 */
function runs(rows) {
  const by = new Map();
  // an amount that is not a number (missing, null, a text) is NaN here, never 0: check() refuses a ledger with such a run
  const amount = (x) => (typeof x === "number" ? micro(x) : NaN);
  for (const r of rows) {
    if (r.kind === "start") { if (!by.has(r.runId)) by.set(r.runId, { runId: r.runId, seat: r.seat, session: r.session, micro: amount(r.reservedUsd), settled: false, atMs: atOf(r) }); }
    else if (r.kind === "end") {
      const had = by.get(r.runId), cur = had || { runId: r.runId, seat: r.seat, session: r.session, micro: 0, settled: false, atMs: atOf(r) };
      // a second end row for one run can only RAISE what it counts for (append-only: a later row never lowers a counted amount)
      cur.micro = cur.settled ? Math.max(cur.micro, amount(r.countedUsd)) : amount(r.countedUsd); cur.settled = true;
      if (had) cur.atMs = Math.max(cur.atMs, atOf(r));   // NaN (a row without a readable time) stays NaN
      by.set(r.runId, cur);
    }
  }
  return [...by.values()];
}
/**
 * Close every run of this seat tonight that has a start row and no end row (its runner ended without reporting): one end row each, cost
 * "UNKNOWN", counted at what the start row reserved (the seat's full cap), with the reason. -> the number of rows written. Never throws.
 */
function settleOpen(root, { session, seat, reason, by }, nowMs = Date.now()) {
  let n = 0;
  try {
    const led = read(root); if (led.state !== "ok") return 0;
    for (const r of runs(led.rows)) {
      if (r.settled || r.session !== session || r.seat !== seat) continue;
      append(root, { kind: "end", runId: r.runId, session, seat, outcome: "UNKNOWN", reason, cost: "UNKNOWN", costReportedUsd: null, countedUsd: usd(r.micro), by }, nowMs); n++;
    }
  } catch { /* the reservation stands either way */ }
  return n;
}
/** counted spend, in micro-dollars -> { seat, night, trial, launchesTonight } */
function spend(rows, { session, seat }) {
  let s = 0, n = 0, t = 0, k = 0;
  for (const r of runs(rows)) { t += r.micro; if (r.session === session) { n += r.micro; if (r.seat === seat) { s += r.micro; k++; } } }
  return { seat: s, night: n, trial: t, launchesTonight: k };
}
/**
 * counted spend BY THE LEDGER'S OWN CLOCK, in micro-dollars: the runs whose rows' `at` is inside the last windowMs before nowMs,
 * whatever session label they carry -> { seat, night }. A run whose time cannot be read, or lies after nowMs, counts (fail closed).
 */
function recent(rows, { seat, nowMs, windowMs = NIGHT_WINDOW_MS }) {
  let s = 0, n = 0;
  for (const r of runs(rows)) { if (r.atMs <= nowMs - windowMs) continue; n += r.micro; if (r.seat === seat) s += r.micro; }
  return { seat: s, night: n };
}
/**
 * THE SECOND RECORD: what the seat wave's own history says the SDK path spent. One entry per session and seat whose row there carries
 * launcher "sdk" and a reported cost above $0 (such a cost comes only from a launch that had its start row written first).
 * -> { state: "absent", launches: [] } | { state: "ok", launches: [{ session, seat, costUsd }] } | { state: "unreadable", why, launches: [] }
 * A line that is not JSON makes the history unreadable (fail closed); a line that is not a wave's row is no evidence either way.
 */
function witness(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, ...WITNESS_REL.split("/")), "utf8"); }
  catch (e) { return e && e.code === "ENOENT" ? { state: "absent", launches: [] } : { state: "unreadable", why: `${WITNESS_REL} cannot be read (${(e && e.code) || "error"})`, launches: [] }; }
  const by = new Map(), lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let w; try { w = JSON.parse(lines[i]); } catch { return { state: "unreadable", why: `line ${i + 1} of ${WITNESS_REL} is not JSON`, launches: [] }; }
    if (!w || typeof w !== "object" || typeof w.session !== "string" || !Array.isArray(w.seats)) continue;
    for (const r of w.seats) {
      if (!r || typeof r !== "object" || r.launcher !== LAUNCHER || typeof r.seat !== "string" || !(typeof r.cost === "number" && r.cost > 0)) continue;
      const k = w.session + "\u0000" + r.seat, had = by.get(k);
      if (!had || r.cost > had.costUsd) by.set(k, { session: w.session, seat: r.seat, costUsd: r.cost });
    }
  }
  return { state: "ok", launches: [...by.values()] };
}
/** the witnessed SDK launches this ledger holds NO run for (no start row and no end row for that session and seat) -> [{ session, seat, costUsd }] */
function lost(rows, launches) {
  const have = new Set();
  for (const r of rows || []) if (r && (r.kind === "start" || r.kind === "end")) have.add(r.session + "\u0000" + r.seat);
  return (launches || []).filter((w) => !have.has(w.session + "\u0000" + w.seat));
}
/**
 * May this seat start a launch now? -> { ok: true, budgetUsd, figures } | { ok: false, limit, reason, figures }
 * led: a read() result · seatCapUsd: the seat's cap · limits: { nightCapUsd, trialCapUsd, trialEnd } · nowMs: the clock ·
 * minutes: how long this launch may run (the runner always passes it; left out, only the start is held against the end date) ·
 * minLaunchUsd: the floor under what is left of the seat's cap (the runner always passes MIN_LAUNCH_USD; left out, there is none) ·
 * witness: a witness() result (the runner always passes it; left out, the ledger is held against nothing)
 */
function check({ led, session, seat, seatCapUsd, limits, nowMs, minutes, minLaunchUsd, witness: seen }) {
  const lim = limits || {}, usable = (m) => Number.isFinite(m) && m > 0, sum = (m) => Number.isFinite(m) && m >= 0;
  const refuse = (limit, reason, figures = {}) => ({ ok: false, limit, reason, figures });
  const endMs = Date.parse(lim.trialEnd + "T00:00:00Z"), cap = micro(seatCapUsd), nightCap = micro(lim.nightCapUsd), trialCap = micro(lim.trialCapUsd), floor = minLaunchUsd == null ? 0 : micro(minLaunchUsd);
  if (!Number.isFinite(endMs) || !usable(cap) || !usable(nightCap) || !usable(trialCap) || !sum(floor)) return refuse("ledger", "the limits themselves are not usable (a cap or the end date is not a value)");
  const runMs = minutes == null ? 0 : Number(minutes) * 60000;
  if (!Number.isFinite(nowMs) || !sum(runMs)) return refuse("ledger", "the clock or the launch's minutes are not a value, so the end date cannot be held: nothing is started");
  if (nowMs >= endMs) return refuse("end-date", `the trial ended: from ${lim.trialEnd} 00:00 UTC the SDK path refuses every seat (go back with: node automation/seat-sdk/set-provider.cjs cli)`, { trialEnd: lim.trialEnd, now: new Date(nowMs).toISOString() });
  if (nowMs + runMs >= endMs) return refuse("end-date", `the trial ends at ${lim.trialEnd} 00:00 UTC and this launch's ${Number(minutes)} minute(s) would not be over by then: it is not started, so no run is still spending when the credit may be gone`,
    { trialEnd: lim.trialEnd, now: new Date(nowMs).toISOString(), minutes: Number(minutes), wouldRunUntil: new Date(nowMs + runMs).toISOString() });
  if (!led || led.state === "unreadable") return refuse("ledger", `the spend ledger cannot be used, so the limits cannot be computed: ${(led && led.why) || "not read"}`);
  // the second line behind read(): a run without a usable amount (not a number, below zero) makes every sum meaningless
  if (!Array.isArray(led.rows) || runs(led.rows).some((r) => !sum(r.micro))) return refuse("ledger", "the spend ledger cannot be used, so the limits cannot be computed: its rows are missing, or a run in it has no usable amount (not a number, or below zero)");
  // the second record: SDK spend the seat wave's own history shows must have its run here — else the ledger was deleted, moved or put back from an older copy
  if (seen != null) {
    if (seen.state === "unreadable" || !Array.isArray(seen.launches)) return refuse("ledger", `the seat wave's own history cannot be used, so the spend ledger cannot be held against it: ${one(seen.why) || "it was not read"} — nothing is started`);
    const gone = lost(led.rows, seen.launches);
    if (gone.length) return refuse("ledger", `the spend ledger is missing after the trial began: the seat wave's history shows SDK spend on ${gone.length} seat-night(s) that ${led.state === "absent" ? "no ledger file is there to hold" : "the ledger holds no run for"} (the first: ${one(gone[0].seat)} on ${one(gone[0].session)}, ${money(micro(gone[0].costUsd))}) — what was spent cannot be counted, so nothing is started; put ${REL} back from its backup, or go back with: node automation/seat-sdk/set-provider.cjs cli`,
      { ledgerState: led.state, witnessedWithoutARun: gone.length, first: { session: gone[0].session, seat: gone[0].seat, costUsd: gone[0].costUsd } });
  }
  const sp = spend(led.rows, { session, seat }), rc = recent(led.rows, { seat, nowMs });
  if (![sp.seat, sp.night, sp.trial, rc.seat, rc.night].every(sum)) return refuse("ledger", "the spend ledger cannot be used, so the limits cannot be computed: a total is not a number of dollars at or above zero");
  // tonight = the LARGER of what this session's label carries and what the ledger's own clock puts in the last 20 hours
  const seatNow = Math.max(sp.seat, rc.seat), nightNow = Math.max(sp.night, rc.night);
  const seatWords = rc.seat > sp.seat ? `counted in the last ${NIGHT_WINDOW_HOURS} hours by the ledger's own clock (${money(sp.seat)} of it under session ${session})` : "counted tonight";
  const nightWords = rc.night > sp.night ? `counted in the last ${NIGHT_WINDOW_HOURS} hours by the ledger's own clock (${money(sp.night)} of it under session ${session})` : "counted tonight";
  const figures = { seatCountedUsd: usd(seatNow), seatCapUsd: usd(cap), nightCountedUsd: usd(nightNow), nightCapUsd: usd(nightCap), trialCountedUsd: usd(sp.trial), trialCapUsd: usd(trialCap),
    seatBySessionUsd: usd(sp.seat), seatByClockUsd: usd(rc.seat), nightBySessionUsd: usd(sp.night), nightByClockUsd: usd(rc.night), clockWindowHours: NIGHT_WINDOW_HOURS };
  const left = cap - seatNow;
  if (left <= 0) return refuse("seat", `per-seat cap reached: ${seat} has ${money(seatNow)} ${seatWords} against its cap of ${money(cap)}`, figures);
  if (floor > 0) figures.minLaunchUsd = usd(floor);
  // a launch always runs at least one whole turn: on a remainder under the floor it would be little but spend past the cap
  if (left < floor) return refuse("seat", `per-seat cap: ${seat} has ${fine(seatNow)} ${seatWords}, and the ${fine(left)} left of its cap of ${money(cap)} is under the ${fine(floor)} a launch is started on (a launch always runs at least one whole turn, which would pass the cap)`, figures);
  figures.budgetUsd = usd(left);
  if (nightNow >= nightCap) return refuse("night", `per-night cap reached: ${money(nightNow)} ${nightWords} against the night's cap of ${money(nightCap)}`, figures);
  if (nightNow + left > nightCap) return refuse("night", `per-night cap: ${money(nightNow)} ${nightWords} plus this seat's ${money(left)} would pass the night's cap of ${money(nightCap)}`, figures);
  if (sp.trial >= trialCap) return refuse("trial", `trial cap reached: ${money(sp.trial)} counted in the trial against its cap of ${money(trialCap)}`, figures);
  if (sp.trial + left > trialCap) return refuse("trial", `trial cap: ${money(sp.trial)} counted in the trial plus this seat's ${money(left)} would pass the trial's cap of ${money(trialCap)}`, figures);
  return { ok: true, budgetUsd: usd(left), figures };
}
/** append one row (schema, launcher and the time are added). Throws when the row cannot be written. */
function append(root, row, nowMs = Date.now()) {
  const full = { schema: SCHEMA, at: new Date(nowMs).toISOString(), launcher: LAUNCHER, ...row };
  if (!KINDS.includes(full.kind) || typeof full.seat !== "string" || typeof full.session !== "string") throw new Error("not a ledger row (kind, seat and session are required)");
  const line = JSON.stringify(full); JSON.parse(line);
  fs.appendFileSync(fileOf(root), line + "\n");
  return full;
}
/** what launcherOf() answers when the SDK launched the seat that session but did not make the claim asked about */
const MIXED = "mixed";
/**
 * FOR A READER SPLITTING THE RECORD: which launcher made this seat's sealed claim of this session? (a claim row in
 * backend/data/seat-claims.jsonl carries no launcher field: it is joined here by session and seat, and by its own time when given)
 *   "sdk"    an SDK launch of that session and seat COUNTED A SEALED CLAIM: an end row with sealedDelta >= 1. When the claim's own
 *            time is handed over (sealedAt: the claim row's field, an ISO time or milliseconds), that time must also lie inside
 *            such a launch — from its start row's time to its end row's.
 *   "mixed"  the SDK did launch that seat that session, but NOT the claim asked about: no launch of it counted a claim (a refused
 *            request, a failed check, a seat that sealed nothing, a runner that never reported back), or the claim's time lies
 *            outside every launch that did, or cannot be read. Such a claim was made by another launcher the same evening (the
 *            command line, after `set-provider.cjs cli`) or in a launch nobody vouches for: split that night by the wave's own rows.
 *   null     no SDK launch of that seat that session — no start row and no end row; a "refused" or "not-started" row is not a
 *            launch (nothing ran). The command line, as before the trial. Also the answer when there is no ledger to ask.
 */
function launcherOf(root, session, seat, sealedAt) {
  const led = read(root); if (led.state !== "ok") return null;
  const by = new Map();   // the launches of that session and seat, by run id: when each started and ended, and what its end row counted as sealed
  for (const r of led.rows) {
    if (r.session !== session || r.seat !== seat || (r.kind !== "start" && r.kind !== "end")) continue;
    const run = by.get(r.runId) || { startMs: NaN, endMs: NaN, sealed: 0 };
    if (r.kind === "start") run.startMs = atOf(r);
    else { run.endMs = atOf(r); if (typeof r.sealedDelta === "number" && Number.isFinite(r.sealedDelta)) run.sealed = Math.max(run.sealed, r.sealedDelta); }
    by.set(r.runId, run);
  }
  if (!by.size) return null;
  const sealedRuns = [...by.values()].filter((run) => run.sealed >= 1);
  if (!sealedRuns.length) return MIXED;
  if (sealedAt == null) return LAUNCHER;
  const t = typeof sealedAt === "number" ? sealedAt : typeof sealedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(sealedAt) ? Date.parse(sealedAt) : NaN;
  return Number.isFinite(t) && sealedRuns.some((run) => run.startMs <= t && t <= run.endMs) ? LAUNCHER : MIXED;
}
/** totals for a status line -> { state, why, nights: [{ session, countedUsd, launches }], trialCountedUsd, unknownCostRuns } */
function summary(root) {
  const led = read(root); if (led.state === "unreadable") return { state: led.state, why: led.why, nights: [], trialCountedUsd: null, unknownCostRuns: null };
  const by = new Map(); let t = 0;
  for (const r of runs(led.rows)) { t += r.micro; const n = by.get(r.session) || { session: r.session, micro: 0, launches: 0 }; n.micro += r.micro; n.launches++; by.set(r.session, n); }
  return { state: led.state, nights: [...by.values()].sort((a, b) => (a.session < b.session ? -1 : 1)).map((n) => ({ session: n.session, countedUsd: usd(n.micro), launches: n.launches })), trialCountedUsd: usd(t),
    unknownCostRuns: led.rows.filter((r) => r.kind === "end" && r.cost === "UNKNOWN").length + runs(led.rows).filter((r) => !r.settled).length };
}

module.exports = { SCHEMA, REL, LAUNCHER, MIXED, KINDS, NIGHT_WINDOW_HOURS, NIGHT_WINDOW_MS, MIN_LAUNCH_USD, WITNESS_REL, fileOf, micro, usd, money, read, runs, spend, recent, witness, lost, check, append, settleOpen, launcherOf, summary };
