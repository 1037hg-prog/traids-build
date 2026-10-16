#!/usr/bin/env node
"use strict";
/**
 * SEAT-SDK TRIAL — WHAT THE SEATS HAVE COST. READ-ONLY: reads the seat wave's own history (backend/data/seat-wave-history.jsonl, written
 * by automation/seat-wave.cjs from the cost each launch reported) and, when it exists, the SDK path's ledger. Writes nothing.
 *
 *   node docs/seat-sdk-trial/2026-10-12/cost-history.cjs
 *
 * A "real night" is a session whose wave was not a dry run and reported a cost above zero (a night on which every launch failed at once —
 * the expired sign-in — cost nothing and is listed apart). One row per session: the last one written for it.
 */
const fs = require("fs"), path = require("path");
const REPO = path.resolve(__dirname, "..", "..", "..");
const lines = (rel) => { try { return fs.readFileSync(path.join(REPO, ...rel.split("/")), "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return null; } };
const usd = (x) => "$" + x.toFixed(2), mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

const hist = lines("backend/data/seat-wave-history.jsonl");
if (!hist) { console.log("backend/data/seat-wave-history.jsonl cannot be read: nothing to report."); process.exit(1); }
const bySession = new Map(); for (const r of hist) if (r && r.session && r.dry !== true) bySession.set(r.session, r);
const all = [...bySession.values()].sort((a, b) => (a.session < b.session ? -1 : 1));
const real = all.filter((r) => Number(r.totalCost) > 0), dead = all.filter((r) => !(Number(r.totalCost) > 0));
console.log(`SEAT WAVE COST HISTORY — from backend/data/seat-wave-history.jsonl (${hist.length} rows, ${all.length} sessions that were not dry runs)`);
if (!real.length) { console.log("no night with a reported cost above zero."); process.exit(0); }
const tot = real.map((r) => Number(r.totalCost));
console.log(`  real nights: ${real.length}, from ${real[0].session} to ${real[real.length - 1].session}`);
console.log(`  cost a night: lowest ${usd(Math.min(...tot))} · highest ${usd(Math.max(...tot))} · mean ${usd(mean(tot))} · sum ${usd(tot.reduce((s, x) => s + x, 0))}`);
console.log(`  nights that cost nothing (every launch failed at once): ${dead.length}${dead.length ? " — " + dead.map((r) => r.session).join(", ") : ""}`);
const seats = [...new Set(real.flatMap((r) => (r.seats || []).map((s) => s.seat)))];
console.log("  per seat, over the real nights (mean · highest · nights with a follow-up turn):");
for (const name of seats) {
  const rows = real.map((r) => (r.seats || []).find((s) => s.seat === name)).filter((s) => s && typeof s.cost === "number");
  if (!rows.length) continue;
  console.log(`    ${name.padEnd(22)} ${usd(mean(rows.map((s) => s.cost)))} · ${usd(Math.max(...rows.map((s) => s.cost)))} · ${rows.filter((s) => s.retried).length}`);
}
const last = seats[seats.length - 1];
const before = real.map((r) => (r.seats || []).filter((s) => s.seat !== last).reduce((t, s) => t + (Number(s.cost) || 0), 0));
console.log(`  the seats before ${last} (it runs last), summed per night: highest ${usd(Math.max(...before))} · mean ${usd(mean(before))}`);
console.log(`  minutes a night: lowest ${Math.min(...real.map((r) => Number(r.totalMinutes))).toFixed(1)} · highest ${Math.max(...real.map((r) => Number(r.totalMinutes))).toFixed(1)}`);
for (const n of [21, 23, 24]) console.log(`  ${n} nights at the mean: ${usd(mean(tot) * n)} · at the highest night: ${usd(Math.max(...tot) * n)}`);

// the trial's arithmetic: the nights that are left, and how far the caps reach at what the seats have cost
{
  const S = require(path.join(REPO, "automation", "seat-sdk", "seats.cjs")), L = S.DEFAULT_LIMITS;
  let holiday = () => null; try { holiday = require(path.join(REPO, "backend", "lib", "run-window.js")).marketHoliday; } catch { /* no table: weekdays only */ }
  const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" }), today = etDay(Date.now()), nights = [];
  for (let ms = Date.parse(today + "T12:00:00Z") + 86400000; etDay(ms) < L.trialEnd; ms += 86400000) { const d = etDay(ms), dow = new Date(d + "T12:00:00Z").getUTCDay(); if (dow !== 0 && dow !== 6 && !holiday(d)) nights.push(d); }
  const caps = S.SEATS.reduce((t, s) => t + s.budget, 0), m = mean(tot), hi = Math.max(...tot);
  console.log(`\nTHE TRIAL — today is ${today} (ET); the SDK path refuses from ${L.trialEnd} 00:00 UTC`);
  console.log(`  trading nights left after today, through ${nights[nights.length - 1] || "-"}: ${nights.length}`);
  console.log(`  the six seat caps add up to ${usd(caps)} a night; the night's cap is ${usd(L.nightCapUsd)}; the highest real night cost ${usd(hi)}`);
  console.log(`  the trial's cap of ${usd(L.trialCapUsd)} covers ${Math.floor(L.trialCapUsd / m)} nights at the mean (${usd(m)}) and ${Math.floor(L.trialCapUsd / hi)} nights at the highest night (${usd(hi)})`);
  console.log(`  ${nights.length} nights at the mean would be ${usd(nights.length * m)}; one seat on the first night and six after: about ${usd(mean(real.map((r) => ((r.seats || [])[0] || {}).cost || 0)) + (nights.length - 1) * m)}`);
}

// the last night: a launch must be OVER before the trial's end, so each seat has a last minute at which it may still start
{
  const S = require(path.join(REPO, "automation", "seat-sdk", "seats.cjs")), L = S.DEFAULT_LIMITS, endMs = Date.parse(L.trialEnd + "T00:00:00Z");
  const mt = (ms) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: "America/Denver", hour: "2-digit", minute: "2-digit" }), utc = (ms) => new Date(ms).toISOString().slice(11, 16);
  const mtOfDay = (iso) => { const [h, m] = new Date(iso).toLocaleTimeString("en-GB", { timeZone: "America/Denver", hour: "2-digit", minute: "2-digit" }).split(":").map(Number); return h * 60 + m; }, hm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(Math.round(min % 60)).padStart(2, "0")}`;
  console.log(`\nTHE LAST NIGHT — the trial ends ${L.trialEnd} 00:00 UTC = ${mt(endMs)} Mountain the evening before; a launch that would not be over by then is refused`);
  for (const s of S.SEATS) console.log(`  ${s.seat.padEnd(22)} ${String(s.minutes).padStart(2)} min · refused from ${mt(endMs - s.minutes * 60000)} MT (${utc(endMs - s.minutes * 60000)} UTC)`);
  console.log(`  a follow-up turn        ${String(S.FOLLOW_UP_MINUTES).padStart(2)} min · refused from ${mt(endMs - S.FOLLOW_UP_MINUTES * 60000)} MT (${utc(endMs - S.FOLLOW_UP_MINUTES * 60000)} UTC)`);
  const timed = real.filter((r) => r.startedAt && (r.seats || []).length && (r.seats || []).every((s) => Number.isFinite(Number(s.secs))));
  if (timed.length) {
    const starts = timed.map((r) => mtOfDay(r.startedAt)), wait = timed.map((r) => (r.seats || []).filter((s) => s.seat !== last).reduce((t, s) => t + Number(s.secs), 0) / 60);
    console.log(`  on the record (${timed.length} real nights): the wave started between ${hm(Math.min(...starts))} and ${hm(Math.max(...starts))} MT; ${last} started ${Math.min(...wait).toFixed(1)} to ${Math.max(...wait).toFixed(1)} minutes after it (mean ${mean(wait).toFixed(1)}; the earlier seats' seconds, summed)`);
    // had a recorded night been the last one: which seats would have started at or after their limit (by the local Mountain clock the task runs on)
    const lateNights = new Set();
    const late = S.SEATS.map((s) => { const limit = mtOfDay(new Date(endMs - s.minutes * 60000).toISOString()); let n = 0;
      for (const r of timed) { const i = (r.seats || []).findIndex((x) => x.seat === s.seat); if (i < 0) continue; if (mtOfDay(r.startedAt) + (r.seats || []).slice(0, i).reduce((t, x) => t + Number(x.secs), 0) / 60 >= limit) { n++; lateNights.add(`${r.session} (the wave started ${hm(mtOfDay(r.startedAt))} MT)`); } }
      return `${s.seat} ${n}`; });
    console.log(`  recorded nights on which a seat started at or after its limit (it would be refused, were that night the last): ${late.join(" · ")} — of ${timed.length}`);
    console.log(`  nights with at least one such seat: ${lateNights.size} of ${timed.length}${lateNights.size ? " — " + [...lateNights].join(", ") : ""}`);
  }
}

// the follow-up turns on the record: which seat-nights had one, how the first launch had ended, and what the seat's night cost against its cap
{
  const S = require(path.join(REPO, "automation", "seat-sdk", "seats.cjs"));
  const ran = real.flatMap((r) => (r.seats || []).filter((s) => s && s.seat && !s.skipped).map((s) => ({ session: r.session, ...s }))), fu = ran.filter((s) => s.retried === true);
  console.log(`\nFOLLOW-UP TURNS ON THE RECORD — ${fu.length} of ${ran.length} seat-nights over the ${real.length} real nights had one`);
  for (const s of fu) {
    const cap = (S.seatOf(s.seat) || {}).budget, cost = typeof s.cost === "number" ? s.cost : null;
    // the text of a launch that ended in an error is the launcher's own error line; a clean launch's text is the seat's and is not printed
    const text = String(s.note || "").replace(/\s+/g, " ").trim().slice(0, 80);
    console.log(`  ${s.session}  ${String(s.seat).padEnd(22)} first launch ${s.ok ? "ended cleanly" : `ENDED IN AN ERROR (exit ${s.exit}, ${s.turns == null ? "?" : s.turns} turns${text ? `: ${text}` : ", no text"})`} · sealed ${s.sealed} · ${cost == null ? "cost ?" : usd(cost)} in all against a cap of ${cap == null ? "?" : usd(cap)}${cost != null && cap != null && cost > cap ? "  <-- past the cap: on the SDK path the cap covers both turns" : ""}`);
  }
  console.log("  (the record keeps one cost per seat-night: the two turns summed)");
  console.log("  on the SDK path: a follow-up turn runs inside what is left of the seat's cap; a first launch that ended in an error after it had worked (a cost above $0, more than one turn, no refusal) still gets it, a refused request does not.");
}

// the executable the command-line path ran, night by night (the wave records the file its resolver picked)
{
  const home = require("os").homedir(), tilde = (p) => { const s = String(p == null ? "(not recorded)" : p); return (s.toLowerCase().startsWith(home.toLowerCase()) ? "~" + s.slice(home.length) : s).replace(/\\/g, "/"); };
  const by = new Map(); for (const r of real) { const k = tilde(r.exe); by.set(k, [...(by.get(k) || []), r.session]); }
  console.log(`\nTHE COMMAND LINE'S EXECUTABLE — what the wave's resolver picked on each of the ${real.length} real nights`);
  for (const [exe, list] of by) console.log(`  ${String(list.length).padStart(2)} night(s)  ${exe}  — ${list[0]}${list.length > 1 ? " to " + list[list.length - 1] : ""}`);
}

const led = lines("backend/data/seat-sdk-ledger.jsonl");
if (led === null) console.log("\nSDK PATH LEDGER — backend/data/seat-sdk-ledger.jsonl is not there: nothing has run on the SDK path.");
else {
  const L = require(path.join(REPO, "automation", "seat-sdk", "ledger.cjs")), sum = L.summary(REPO);
  console.log(`\nSDK PATH LEDGER — backend/data/seat-sdk-ledger.jsonl (${led.length} rows)${sum.state === "unreadable" ? " — UNREADABLE: " + sum.why : ""}`);
  if (sum.state === "ok") { for (const n of sum.nights) console.log(`  ${n.session}  counted ${usd(n.countedUsd)} over ${n.launches} launch(es)`); console.log(`  counted in the trial: ${usd(sum.trialCountedUsd)} · runs with an unknown cost (counted at the full cap): ${sum.unknownCostRuns}`); }
}
