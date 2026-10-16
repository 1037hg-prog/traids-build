#!/usr/bin/env node
"use strict";
/**
 * SLEEVE SILENT-DEATH ALERT — 2026-10-16. A sleeve that should have decided on a trading session and left no decision is an alert.
 *
 * WHY. R346's two scheduled tasks ("TRAIDS R346 1353" / "1356") reported success for five sessions while the batch they start never
 * ran: cmd exited 0, node never started, nothing was written, and no alert reached the operator — every alert a sleeve has (R316's
 * alertOnce, its after-close gap check) lives INSIDE the sleeve's own run, so a run that never starts can never say so. This script
 * is outside every sleeve. It reads what each sleeve leaves on disk, compares it with the trading-session calendar, and alerts
 * through backend/notify.js (the only operator alert path) for every session a sleeve should have decided and did not.
 *
 *   node backend/sleeve-silence-alert.js                 check, alert once per sleeve per missed session, write its own state
 *   node backend/sleeve-silence-alert.js --dry           check and print what it would send; sends nothing, writes nothing
 *   node backend/sleeve-silence-alert.js --now <ISO>     pretend the clock is <ISO> (with --dry for a rehearsal)
 *
 * WHAT COUNTS AS A DECISION, per sleeve shape (SLEEVES below; each read from the sleeve's own code):
 *   days     state.days[D].decision === true, or a ledger row {kind:"decision", date:D} without quoteError
 *            (r316-ibs-forward.js:585-592; R346 is built on the same runner — its file is not in the cloud copy, see NOTES)
 *   lastRun  state.lastRun[field] — the ET date of the last run of that step (r151 closeArm/afterClose/preOpen, r186/r218/r219
 *            closeArm). Only the latest date is kept, so every due session after it is missed.
 *   marks    state.marks[] — {d} the last completed UTC candle; a run on session S writes a row with d >= S-1 (no catchUp), or
 *            catch-up rows stamped markedOn >= S (r191 / r231, lib/forward-catchup.js)
 * A session S is DUE once the ET clock passes S at the sleeve's dueEt (its decision time plus a grace). The calendar is weekdays
 * minus lib/run-window.js MARKET_HOLIDAYS; early-close days are sessions (they decide earlier, so dueEt still holds).
 *
 * NOT EXPECTED (no alert): before the sleeve's start (firstLiveDecision, or SLEEVES[].expectFrom, or its first record) — but a
 * sleeve with NO record at all is owed its latest due session unless its expectFrom is still in the future; while
 * backend/data/TRAIDS_STOP exists; while the sleeve's OFF file exists IF that switch stops its decisions (offStops); while its HALT
 * file says guard-violation; on a non-session day. A missing or unreadable state file after the sleeve's start IS an alert.
 *
 * DEDUPE. data/sleeve-silence-alert.json keeps alerts[sleeve][session] = ISO of delivery. An entry is written ONLY after notify()
 * returned truthy, so an undelivered alert is tried again at the next run. Entries older than 30 days are pruned.
 * EXIT. 0 nothing missed · 3 missed and the alert was delivered (or already delivered earlier) · 4 missed and NOBODY was told
 * (notify failed or threw), or the check itself died and its failure alert was not delivered · 2 bad arguments. One sleeve whose
 * files make its check throw is an alert for that sleeve, never a crash of the run. OFF switch: data/sleeve-silence-OFF (exit 0, nothing checked).
 * No network of its own, no broker, no order. JSON is written only through lib/atomic-write.js.
 */
const fs = require("fs"), path = require("path");

const LOOKBACK_SESSIONS = 10;
const PRUNE_DAYS = 30;

/**
 * The sleeves. `unit` is the host-ownership key; `inferred: true` means the shape is the sibling runner's, not read from the
 * sleeve's own file (NOTES lists what to confirm at home).
 */
const SLEEVES = [
  { id: "R346", unit: "w3-r346", kind: "days", state: "r346-state.json", ledger: "r346-ledger.jsonl", off: "r346-OFF", offStops: false, halt: "r346-HALT.json", dueEt: "16:30", expectFrom: "2026-10-08", inferred: true, why: "decides once a session at close-5 (tasks 15:53 / 15:56 ET)" },
  { id: "R316", unit: "w3-r316", kind: "days", state: "r316-state.json", ledger: "r316-ledger.jsonl", off: "r316-OFF", offStops: false, halt: "r316-HALT.json", dueEt: "16:30", expectFrom: null, why: "decides once a session at close-5 (tasks 15:54 / 15:57 ET)" },
  { id: "R151", unit: "w3-r151", kind: "lastRun", state: "r151-state.json", off: "r151-OFF", offStops: true, steps: [{ field: "closeArm", dueEt: "16:30" }, { field: "afterClose", dueEt: "17:30" }, { field: "preOpen", dueEt: "10:00" }], expectFrom: null, why: "close-arm, after-close and pre-open steps every session" },
  { id: "R186", unit: "w3-r186", kind: "lastRun", state: "r186-month-end.json", off: "r186-OFF", offStops: false, steps: [{ field: "closeArm", dueEt: "16:30" }], expectFrom: null, why: "close-arm run every session (orders only on window days)" },
  { id: "R218", unit: "w3-r218", kind: "lastRun", state: "r218-dollar-reversal.json", off: "r218-OFF", offStops: false, steps: [{ field: "closeArm", dueEt: "16:30" }], expectFrom: null, why: "close-arm run every session (orders only on window days)" },
  { id: "R219", unit: "w3-r219", kind: "lastRun", state: "r219-zn-month-end.json", off: "r219-OFF", offStops: false, steps: [{ field: "closeArm", dueEt: "16:30" }], expectFrom: null, why: "close-arm run every session" },
  { id: "R191", unit: "w3-r191", kind: "marks", state: "r191-crypto-trend.json", off: "r191-OFF", offStops: false, dueEt: "21:00", expectFrom: null, why: "marks each coin in the weekday close chain" },
  { id: "R231", unit: "w3-r231", kind: "marks", state: "r231-crypto-vote-sized.json", off: "r231-OFF", offStops: false, dueEt: "21:00", expectFrom: null, why: "marks each coin in the weekday close chain" },
];

// ── calendar ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const isYmd = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + "T12:00:00Z").toISOString().slice(0, 10) === s;
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const ymdOf = (v) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || "")); return m && isYmd(m[1]) ? m[1] : null; };
function etNow(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, mins: (+p.hour % 24) * 60 + +p.minute, hhmm: `${p.hour}:${p.minute}` };
}
const minsOf = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const isSession = (d, holidays) => { const dow = new Date(d + "T12:00:00Z").getUTCDay(); return dow >= 1 && dow <= 5 && !holidays[d]; };

/** The last `n` sessions that are DUE at `nowMs` for a step due at `dueEt` ET, oldest first. */
function dueSessions(nowMs, dueEt, holidays, n = LOOKBACK_SESSIONS) {
  const now = etNow(nowMs), out = [];
  let d = now.mins >= minsOf(dueEt) ? now.date : addDays(now.date, -1);
  for (let guard = 0; out.length < n && guard < 60; guard++, d = addDays(d, -1)) if (isSession(d, holidays)) out.push(d);
  return out.reverse();
}

// ── reading a sleeve ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const readJsonOr = (f, missing) => { if (!fs.existsSync(f)) return missing; return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")); };
function readLedgerRows(f) {
  if (!fs.existsSync(f)) return [];
  const rows = []; for (const l of fs.readFileSync(f, "utf8").split(/\r?\n/)) { const t = l.trim(); if (!t) continue; try { rows.push(JSON.parse(t)); } catch { /* a torn last line is not a decision */ } }
  return rows;
}

const isObj = (o) => !!o && typeof o === "object" && !Array.isArray(o);

/**
 * checkSleeve(sleeve, { dataDir, nowMs, holidays }) -> { id, status: "ok"|"missed"|"paused"|"not-started", missed: [{session, step?}], note }
 * "not-started" (silent) only while the sleeve's expectFrom is still in the future. A sleeve in SLEEVES with no record at all, a
 * missing state file, or a state file that cannot be read or is not an object, is an alert for the latest due session: a sleeve
 * that never started looks exactly like R346's silent tasks. Dates later than today (ET) in a sleeve's records are ignored.
 */
function checkSleeve(sl, { dataDir, nowMs, holidays }) {
  const D = (f) => path.join(dataDir, f), res = { id: sl.id, status: "ok", missed: [], note: "" }, today = etNow(nowMs).date;
  if (fs.existsSync(D("TRAIDS_STOP"))) return { ...res, status: "paused", note: "TRAIDS_STOP is set" };
  if (sl.off && sl.offStops && fs.existsSync(D(sl.off))) return { ...res, status: "paused", note: `${sl.off} is set (it stops this sleeve's decisions)` };
  if (sl.halt) { let h = null; try { h = readJsonOr(D(sl.halt), null); } catch { h = { kind: "unreadable" }; } if (isObj(h) && h.kind === "guard-violation") return { ...res, status: "paused", note: `${sl.halt}: guard-violation (${String(h.why || "").slice(0, 80)})` }; }
  const offNote = sl.off && !sl.offStops && fs.existsSync(D(sl.off)) ? ` (${sl.off} is set; this sleeve still records its decision while it is)` : "";

  let st;
  try { st = readJsonOr(D(sl.state), undefined); } catch (e) { st = { __unreadable: String(e.message).slice(0, 100) }; }
  if (st !== undefined && !isObj(st)) st = { __unreadable: `not a JSON object (${st === null ? "null" : Array.isArray(st) ? "an array" : typeof st})` };
  const expectFrom = isYmd(sl.expectFrom) ? sl.expectFrom : null;
  const notYet = expectFrom && expectFrom > today;
  const past = (d) => (d && d <= today ? d : null);
  const steps = sl.kind === "lastRun" ? sl.steps : [{ field: null, dueEt: sl.dueEt }];
  if (notYet) return { ...res, status: "not-started", note: `expected from ${expectFrom}` };   // every due session is before it

  for (const step of steps) {
    const due = dueSessions(nowMs, step.dueEt, holidays);
    let start = expectFrom, decided = () => false, last = null;
    if (st === undefined || st.__unreadable) { /* nothing decided */ }
    else if (sl.kind === "days") {
      const days = isObj(st.days) ? st.days : {}, rows = sl.ledger ? readLedgerRows(D(sl.ledger)) : [];
      const dayOk = (k) => isObj(days[k]) && days[k].decision === true;
      const fromLedger = new Set(rows.filter((r) => isObj(r) && r.kind === "decision" && isYmd(r.date) && !r.quoteError).map((r) => r.date));
      decided = (s) => dayOk(s) || fromLedger.has(s);
      const firsts = [past(ymdOf(st.firstLiveDecision)), ...Object.keys(days).filter((k) => isYmd(k) && dayOk(k) && k <= today), ...[...fromLedger].filter((d) => d <= today)].filter(Boolean).sort();
      if (!start && firsts.length) start = firsts[0];
    } else if (sl.kind === "lastRun") {
      last = past(ymdOf(isObj(st.lastRun) ? st.lastRun[step.field] : null));
      decided = (s) => !!last && s <= last;
      if (!start && last) start = last;
    } else if (sl.kind === "marks") {
      // the run date from the marks (d + 1 for a normal mark, markedOn for a catch-up), capped by the ET date of the state's save time
      // (asOf, written by every live save)
      const asOf = Date.parse(st.asOf || ""), asOfEt = Number.isFinite(asOf) ? past(etNow(asOf).date) : null;
      const marks = Array.isArray(st.marks) ? st.marks.filter((m) => isObj(m) && isYmd(m.d)) : [];
      const fromMarks = marks.map((m) => (m.catchUp || m.carriedFrom ? ymdOf(m.markedOn) : addDays(m.d, 1))).map(past).filter(Boolean).sort().pop() || null;
      // a run counts only if it saved AND marked: the earlier of the two dates (a late run's candle date and a crashed run's save
      // date both over-state the run on their own); no marks at all is no run
      last = fromMarks ? (asOfEt && asOfEt < fromMarks ? asOfEt : fromMarks) : null;
      decided = (s) => !!last && last >= s;
      if (!start && (last || marks.length)) start = last || marks.map((m) => m.d).sort()[0];
    }
    if (!start) {
      if (due.length) start = due[due.length - 1];                // no record at all: the latest due session is owed
    }
    const owed = due.filter((s) => s >= start && !decided(s));
    for (const s of owed) res.missed.push({ session: s, ...(step.field ? { step: step.field } : {}) });
    if (owed.length) {
      const why = st === undefined ? `${sl.state} does not exist` : st.__unreadable ? `${sl.state} is unreadable (${st.__unreadable})` : sl.kind === "days" ? "no decision recorded for the session" : `last ${step.field || "run"} on ${last || "never"}`;
      res.note += `${res.note ? "; " : ""}${step.field ? step.field + ": " : ""}${why}`;
    }
  }
  if (res.missed.length) { res.status = "missed"; res.note += offNote; }
  return res;
}

/** checkSleeve, but a sleeve whose check throws is an alert for the latest due session — never a crash of the whole run. */
function checkSleeveSafe(sl, ctx) {
  try { return checkSleeve(sl, ctx); }
  catch (e) {
    const due = dueSessions(ctx.nowMs, sl.dueEt || (sl.steps && sl.steps[0] && sl.steps[0].dueEt) || "16:30", ctx.holidays);
    return { id: sl.id, status: "missed", missed: due.length ? [{ session: due[due.length - 1], step: "check-error" }] : [], note: `the check itself failed (${String(e && e.message).slice(0, 100)}) — read the sleeve's files by hand` };
  }
}

// ── alert state ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const freshAlerts = () => ({ spec: "sleeve-silence-alert-v1", alerts: {}, lastRun: null });

/**
 * run({ root, nowMs, dry, notify, log, sleeves }) -> { exit, results, sent }
 * notify(title, body, opts) is backend/notify.js's notify unless a fake is passed in.
 */
async function run({ root = path.resolve(__dirname, ".."), nowMs = Date.now(), dry = false, notify = null, log = console.log, sleeves = SLEEVES } = {}) {
  const dataDir = path.join(root, "backend", "data"), stateFile = path.join(dataDir, "sleeve-silence-alert.json");
  if (fs.existsSync(path.join(dataDir, "sleeve-silence-OFF"))) { log("sleeve-silence: OFF switch data/sleeve-silence-OFF is set — nothing checked"); return { exit: 0, results: [], sent: false }; }
  const holidays = require("./lib/run-window.js").MARKET_HOLIDAYS || {};
  const now = etNow(nowMs);
  const lastListed = Object.keys(holidays).sort().pop();
  if (lastListed && now.date.slice(0, 4) > lastListed.slice(0, 4)) log(`sleeve-silence: WARNING lib/run-window.js MARKET_HOLIDAYS ends ${lastListed}; holidays after it are treated as sessions`);
  let owner = {}; try { owner = (readJsonOr(path.join(dataDir, "host-ownership.json"), {}) || {}).units || {}; } catch { owner = {}; }

  const results = sleeves.map((sl) => checkSleeveSafe(sl, { dataDir, nowMs, holidays }));
  log(`sleeve-silence ${now.date} ${now.hhmm} ET${dry ? " (dry)" : ""}`);
  for (const r of results) log(`  ${r.status.padEnd(11)} ${r.id}${r.missed.length ? ` — missed ${r.missed.map((m) => m.session + (m.step ? "/" + m.step : "")).join(", ")}` : ""}${r.note ? ` — ${r.note}` : ""}`);

  let st; try { st = readJsonOr(stateFile, freshAlerts()); } catch { st = freshAlerts(); }
  if (!isObj(st) || !isObj(st.alerts)) st = { ...freshAlerts(), ...(isObj(st) ? { lastRun: st.lastRun || null } : {}), alerts: {} };
  for (const id of Object.keys(st.alerts)) if (!isObj(st.alerts[id])) delete st.alerts[id];
  const key = (m) => m.session + (m.step ? "/" + m.step : "");
  const fresh = results.filter((r) => r.status === "missed").map((r) => ({ r, items: r.missed.filter((m) => !(st.alerts[r.id] || {})[key(m)]) })).filter((x) => x.items.length);
  const anyMissed = results.some((r) => r.status === "missed");
  if (!anyMissed) { if (!dry) { st.lastRun = { at: new Date(nowMs).toISOString(), missed: 0 }; save(stateFile, st); } return { exit: 0, results, sent: false }; }
  if (!fresh.length) { log("sleeve-silence: every missed session was already alerted"); if (!dry) { st.lastRun = { at: new Date(nowMs).toISOString(), missed: results.reduce((a, r) => a + r.missed.length, 0) }; save(stateFile, st); } return { exit: 3, results, sent: false }; }

  const sl = (id) => sleeves.find((s) => s.id === id) || {};
  const title = `TRAIDS — sleeve silent: ${fresh.map((x) => `${x.r.id} (${x.items.length} session${x.items.length > 1 ? "s" : ""})`).join(", ")}`;
  const body = fresh.map(({ r, items }) => {
    const s = sl(r.id), own = owner[s.unit] ? ` · runs on ${owner[s.unit]}` : "";
    return `${r.id}: no decision for ${items.map(key).join(", ")} — ${r.note}. Expected: ${s.why || "a decision each session"}${own}${s.inferred ? " · record shape inferred from R316 (confirm)" : ""}.`;
  }).join("\n") + "\nCheck the sleeve's task log and its state file; a task that reports success but writes nothing is how R346 lost five sessions.";
  if (dry) { log(`would send:\n  ${title}\n  ${body.split("\n").join("\n  ")}`); return { exit: 3, results, sent: false }; }

  let delivered = false;
  try { const n = notify || require("./notify.js").notify; delivered = !!(await n(title, body.slice(0, 3500), { priority: "high", tags: "warning", email: false })); }
  catch (e) { log(`sleeve-silence: alert threw: ${String(e.message).slice(0, 120)}`); delivered = false; }
  if (delivered) {
    const at = new Date(nowMs).toISOString();
    for (const { r, items } of fresh) { const a = (st.alerts[r.id] = st.alerts[r.id] || {}); for (const m of items) a[key(m)] = at; }
    const cutoff = addDays(now.date, -PRUNE_DAYS);
    for (const id of Object.keys(st.alerts)) { for (const k of Object.keys(st.alerts[id])) if (k.slice(0, 10) < cutoff) delete st.alerts[id][k]; if (!Object.keys(st.alerts[id]).length) delete st.alerts[id]; }
    log(`sleeve-silence: alert delivered — ${title}`);
  } else log(`sleeve-silence: ALERT NOT DELIVERED — nobody was told; the next run tries again: ${title}`);
  st.lastRun = { at: new Date(nowMs).toISOString(), missed: results.reduce((a, r) => a + r.missed.length, 0), delivered };
  save(stateFile, st);
  return { exit: delivered ? 3 : 4, results, sent: delivered };
}

function save(file, obj) {   // JSON only through lib/atomic-write.js
  require("./lib/atomic-write.js").writeJsonAtomic(file, obj); }

function parseArgs(argv) {
  const o = { dry: false, nowMs: Date.now() };   // run() options
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") o.dry = true;
    else if (a === "--now") { const t = Date.parse(argv[++i] || ""); if (!Number.isFinite(t)) return { error: "--now needs an ISO time" }; o.nowMs = t; }
    else return { error: `unknown argument ${a}` };
  }
  return o;
}

/** main(argv, { runImpl, notify, log }) -> exit code. The command line; the selftest calls it with fakes. */
async function main(argv, { runImpl = run, notify = null, log = console.log, logErr = console.error } = {}) {
  const o = parseArgs(argv);
  if (o.error) { logErr(`${o.error}\nusage: sleeve-silence-alert.js [--dry] [--now ISO]`); return 2; }
  try { return (await runImpl({ ...o, notify, log })).exit; }
  catch (e) {
    // the check itself died: say so through notify.js (unless --dry); 3 if that was delivered, else 4 (nobody was told)
    logErr("sleeve-silence: failed: " + (e && e.stack || e));
    if (o.dry) return 4;
    let told = false;
    try { const n = notify || require("./notify.js").notify; told = !!(await n("TRAIDS — sleeve-silence check FAILED", `The sleeve silent-death check could not run: ${String(e && e.message).slice(0, 300)}. Sleeves are unwatched until it is fixed.`, { priority: "high", tags: "warning", email: false })); } catch { told = false; }
    return told ? 3 : 4;
  }
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c), () => process.exit(4));

module.exports = { SLEEVES, LOOKBACK_SESSIONS, dueSessions, checkSleeve, checkSleeveSafe, run, main, parseArgs, etNow, isSession };
