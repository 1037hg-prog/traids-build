#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY SEALED FORECAST LEDGER (2026-10-16) — the package's shared pieces: where the files go, what state each one is in, the
 * fences, and the package's own record. deploy.cjs, rollback.cjs, record.cjs and selftest.cjs all read this and nothing else.
 *
 * THIS PACKAGE ADDS FILES AND CHANGES NONE. Every file in staged/ is NEW at its repo path, so each one's BASE state is `absent`, and
 * base/ holds no copies (base/README.md says so). That makes the three states simple and makes rollback exact:
 *     absent    the live path does not exist          -> deploy --apply writes the staged bytes
 *     applied   the live file IS the staged copy      -> nothing to do
 *     DRIFT     the live path exists and is something else -> refused whole; nothing is written
 * Rollback is the byte-exact inverse of an apply with an absent base: it REMOVES the files this package added, and only the ones its
 * own deploy-state.json records it as having added, and only while each is still byte for byte the staged copy.
 *
 * No file here starts, stops or schedules anything, sends an order, makes a network call, or loads automation/close-chain.cjs.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const PKG = __dirname;
const PKG_REL = "docs/worst-day-sealed/2026-10-16";
const REPO = path.resolve(PKG, "..", "..", "..");
const STAGED = path.join(PKG, "staged");
const STATE_FILE = path.join(PKG, "deploy-state.json");
const LOG_FILE = path.join(PKG, "deploy-log.jsonl");

/** every file this package ships, at its repo path, with why it is here */
const FILES = [
  ["backend/worst-day/sealed-ledger.js", "the append-only sealed ledger: the row's shape, the ET seal clock, the hash chain, the only writer"],
  ["backend/worst-day/sealed-check.js", "the checker: eleven checks, and the refusal of any row written at or after 09:30 ET of the day it forecasts"],
  ["backend/worst-day/nightly-model.js", "the forecast itself: the price-only subset of run.js's inputs, the point-in-time label, the two storm flags"],
  ["backend/worst-day/nightly-forecast.js", "the nightly job: --plan and --write, fail-closed at every step"],
  ["backend/worst-day/sealed-grade.js", "the grader: Brier, its decomposition, the calibration table and the storm table over matured rows"],
  ["backend/worst-day/sealed-fixtures.js", "the seeded synthetic bars the known answers run on; requires nothing, so a fixture can be made without loading the code under test"],
  ["backend/worst-day/sealed-selftest.js", "the known answers for all five, on those bars; ships with the code so home can run it"],
];
const REL_PATHS = FILES.map(([r]) => r);

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const readOrNull = (f) => { try { return fs.readFileSync(f); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const livePath = (rel) => path.join(REPO, ...rel.split("/"));
const stagedPath = (rel) => path.join(STAGED, ...rel.split("/"));

/** the package's own bytes: the staged copy of every file, and its sha */
function unit() {
  const out = {};
  for (const [rel, why] of FILES) {
    const b = readOrNull(stagedPath(rel));
    if (b === null) throw new Error(`the staged copy of ${rel} is missing from this package (${path.relative(REPO, stagedPath(rel))})`);
    out[rel] = { why, staged: b, stagedSha: sha(b) };
  }
  return out;
}
/** what each file reads as on disk NOW */
/** the three states, from the two sets of bytes alone: this is the whole of what deploy and rollback decide on */
function stateOf(live, staged) { return live === null ? "absent" : live.equals(staged) ? "applied" : "drift"; }
function plan({ U = unit() } = {}) {
  const files = REL_PATHS.map((rel) => {
    const live = readOrNull(livePath(rel)), u = U[rel];
    const state = stateOf(live, u.staged);
    return { rel, state, liveSha: live === null ? null : sha(live), stagedSha: u.stagedSha, bytes: u.staged.length, why: u.why,
      problem: state === "drift" ? `${rel} is already there and is not this package's copy (${sha(live).slice(0, 12)} on disk, ${u.stagedSha.slice(0, 12)} staged)` : null };
  });
  const drift = files.filter((f) => f.state === "drift");
  const todo = files.filter((f) => f.state === "absent");
  return { files, drift, todo, state: drift.length ? "drift" : todo.length ? "absent" : "applied" };
}

// ── fences ───────────────────────────────────────────────────────────────────────────────────────────────────────────
let HOLIDAYS = {};
try { HOLIDAYS = require(path.join(REPO, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS || {}; } catch { HOLIDAYS = {}; }
/** the operator's clock */
function mtNow(nowMs = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hourCycle: "h23", hour: "2-digit", minute: "2-digit", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  const hh = +p.hour % 24, date = `${p.year}-${p.month}-${p.day}`;
  return { date, dow: p.weekday, hms: `${String(hh).padStart(2, "0")}:${p.minute}`, minutes: hh * 60 + +p.minute };
}
const isTradingDay = (date, holidays = HOLIDAYS) => { const g = new Date(date + "T12:00:00Z").getUTCDay(); return g >= 1 && g <= 5 && !holidays[date]; };
/**
 * What would refuse a write right now. The list is short ON PURPOSE and the reason is stated: every file this package ships is NEW,
 * so no running process can be loading one, no live behaviour changes the moment they land, and nothing restarts. The one fence that
 * still applies is the house's no-write window on a trading afternoon, when the close chain owns backend/.
 */
function fences({ nowMs = Date.now(), holidays = HOLIDAYS, P = null } = {}) {
  const out = [], mt = mtNow(nowMs);
  if (isTradingDay(mt.date, holidays) && mt.minutes >= 13 * 60 + 50 && mt.minutes < 15 * 60 + 50) out.push(`it is ${mt.hms} MT on a trading day — inside the 13:50-15:50 MT window the close chain owns; run it after 15:50 MT`);
  const p = P || plan();
  for (const d of p.drift) out.push(`DRIFT: ${d.problem}`);
  return out;
}

// ── the package's own record ─────────────────────────────────────────────────────────────────────────────────────────
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } }
function writeState(s) { require(path.join(REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic(STATE_FILE, s); }
function logRow(row) { try { fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n"); } catch { /* the record is not the work */ } }

module.exports = { PKG, PKG_REL, REPO, STAGED, STATE_FILE, LOG_FILE, FILES, REL_PATHS, sha, readOrNull, livePath, stagedPath, unit, stateOf, plan, fences, mtNow, isTradingDay, HOLIDAYS, readState, writeState, logRow };
