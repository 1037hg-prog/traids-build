#!/usr/bin/env node
/**
 * R277 — Natural-gas storage-report day (Prokopczuk, Wese Simen & Wichmann 2021). Registered 2026-09-28 in
 * backend/register-r276-r280.js (the registry wins).
 *   V1 UNG close(t-1)->close(t) on release days vs every other day (daily, adjustment=all)
 *   V2 UNG prior 16:00 ET -> 10:25 ET on release days vs the same clock on other days (1-minute RAW)
 *   Welch t of (release net - other); PASS needs t >= 1.966 (best-of-2) AND release-day net mean > 0 AND Tuesday placebo t < bar.
 *
 *   node backend/r277-ng-storage-day.js --selftest   calendar only: release-day count, holiday shifts, no returns
 *   node backend/r277-ng-storage-day.js --read       the one registered read (refuses if sealed)
 *
 * NOTES (fixed before any outcome): N1 trading calendar = UNG's own daily bars. N2 release day of a week (Mon-keyed) = the Thursday if
 * it is a trading day, else the last trading day before it in the same week (Mon..Wed). N3 placebo = the same with Tuesday (else the
 * last trading day before it in the week). N4 V2: prior close = close of the last 1-minute bar starting before 16:00 ET on the prior
 * trading day; release = close of the last bar starting before 10:25 ET; a session with no such bars is dropped (counted); an overnight
 * raw move beyond 20% (split) drops that session. N5 cost 10 bps round trip on release-day legs only. N6 window 2016-02-01..2026-08-31.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { fetchBars } = require("./lib/alpaca-bars.js");
const { loadBars } = require("./lib/equity-bars-1m.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), OUT = D("r277-ng-storage-day.json");
const START = "2016-02-01", END = "2026-08-31", BAR = 1.966, COST = 0.001;
const mode = ["--selftest", "--read"].find((m) => process.argv.includes(m)) || "--selftest";
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const vr = (a) => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); };
const welch = (a, b) => (mean(a) - mean(b)) / Math.sqrt(vr(a) / a.length + vr(b) / b.length);
const dow = (d) => new Date(d + "T12:00:00Z").getUTCDay();
const weekKey = (d) => { const t = new Date(d + "T12:00:00Z"), k = (t.getUTCDay() + 6) % 7; return new Date(t.getTime() - k * 864e5).toISOString().slice(0, 10); };

function pickDays(cal, targetDow) {
  const byWeek = new Map(); for (const d of cal) (byWeek.get(weekKey(d)) || byWeek.set(weekKey(d), []).get(weekKey(d))).push(d);
  const out = new Set(), shifted = [];
  for (const [wk, ds] of byWeek) {
    const target = new Date(Date.parse(wk + "T12:00:00Z") + (targetDow - 1) * 864e5).toISOString().slice(0, 10);
    if (target > cal.at(-1) || target < cal[0]) continue;                       // week cut by the window edge: no release day
    const exact = ds.find((d) => dow(d) === targetDow); if (exact) { out.add(exact); continue; }
    const before = ds.filter((d) => dow(d) < targetDow && dow(d) >= 1); if (before.length) { out.add(before.at(-1)); shifted.push(before.at(-1)); } }
  return { days: out, shifted };
}

async function daily() {
  const r = await fetchBars(["UNG"], { start: "2016-01-01", end: END + "T23:00:00Z", feed: "sip", adjustment: "all", quiet: true, requireAll: true });
  return r.bars.UNG.map((b) => ({ d: b.t.slice(0, 10), c: b.c }));
}

(async () => {
  const bars = await daily(), cal = bars.map((b) => b.d).filter((d) => d >= START && d <= END);
  const rel = pickDays(cal, 4), tue = pickDays(cal, 2);
  if (mode === "--selftest") {
    console.log(`calendar ${cal.length} sessions ${cal[0]}..${cal.at(-1)}; release days ${rel.days.size} (${rel.shifted.length} shifted: ${rel.shifted.join(", ")}); Tuesday placebo ${tue.days.size}`);
    process.exit(rel.days.size > 450 ? 0 : 1);
  }
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests.R277) throw new Error("R277 already sealed — read-once");
  // V1 daily
  const r1 = []; for (let i = 1; i < bars.length; i++) { const d = bars[i].d; if (d < START || d > END) continue; r1.push({ d, r: bars[i].c / bars[i - 1].c - 1 }); }
  const split = (set, rows) => ({ a: rows.filter((x) => set.has(x.d)).map((x) => x.r - COST), b: rows.filter((x) => !set.has(x.d)).map((x) => x.r), aRaw: rows.filter((x) => set.has(x.d)).map((x) => x.r) });
  const summ = (s) => ({ nRelease: s.a.length, nOther: s.b.length, releaseNetMeanPct: +(100 * mean(s.a)).toFixed(4), releaseRawMeanPct: +(100 * mean(s.aRaw)).toFixed(4), otherMeanPct: +(100 * mean(s.b)).toFixed(4),
    diffPct: +(100 * (mean(s.a) - mean(s.b))).toFixed(4), welchT: +welch(s.a, s.b).toFixed(3) });
  const V1 = summ(split(rel.days, r1)), P1 = summ(split(tue.days, r1));
  // V2 1-minute pre-leg
  const m = await loadBars({ symbol: "UNG", from: "2016-01-25", to: END, quiet: true });
  const byDay = new Map(); for (const b of m) (byDay.get(b.date) || byDay.set(b.date, []).get(b.date)).push(b);
  const lastBefore = (d, hhmm) => { const xs = (byDay.get(d) || []).filter((b) => b.time < hhmm && b.time >= "04:00"); return xs.length ? xs.at(-1).c : null; };
  const r2 = []; let dropped = 0, splitDrops = 0;
  const allCal = bars.map((b) => b.d);
  for (let i = 1; i < allCal.length; i++) { const d = allCal[i]; if (d < START || d > END) continue;
    const pc = lastBefore(allCal[i - 1], "16:00"), x = lastBefore(d, "10:25"); if (pc == null || x == null) { dropped++; continue; }
    if (Math.abs(x / pc - 1) > 0.2) { splitDrops++; continue; } r2.push({ d, r: x / pc - 1 }); }
  const V2 = summ(split(rel.days, r2));
  const passCell = (v) => v.welchT >= BAR && v.releaseNetMeanPct > 0;
  const placeboOk = P1.welchT < BAR;
  const pass = (passCell(V1) || passCell(V2)) && placeboOk;
  const verdict = `${pass ? "PASSED" : "DID NOT PASS"} — bar ${BAR}: V1 close->close release net ${V1.releaseNetMeanPct}% vs other ${V1.otherMeanPct}% (diff ${V1.diffPct}%, Welch t ${V1.welchT}, ${V1.nRelease} releases); V2 pre-leg release net ${V2.releaseNetMeanPct}% vs other ${V2.otherMeanPct}% (Welch t ${V2.welchT}, ${V2.nRelease}); Tuesday placebo t ${P1.welchT}`;
  const out = { test: "R277", readAt: new Date().toISOString(), verdict, bar: BAR, V1, V2, placeboTuesday: P1, calendar: { releaseDays: rel.days.size, shifted: rel.shifted }, v2Dropped: { noBars: dropped, split: splitDrops },
    byYearV1: Object.fromEntries([...new Set(r1.map((x) => x.d.slice(0, 4)))].map((y) => { const rows = r1.filter((x) => x.d.startsWith(y)); const s = summ(split(rel.days, rows)); return [y, { releaseNetMeanPct: s.releaseNetMeanPct, otherMeanPct: s.otherMeanPct, t: s.welchT }]; })) };
  writeJsonAtomic(OUT, out);
  seals.tests = seals.tests || {}; seals.tests.R277 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "release days, Welch t vs other days; best-of-2 bar", verdict, output: "data/r277-ng-storage-day.json" };
  writeJsonAtomic(D("read-seals.json"), seals);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", tests: ["R277"], detail: verdict }) + "\n");
  console.log(verdict); console.log(JSON.stringify(out.byYearV1));
})().catch((e) => { console.error("R277 FAILED:", e.message); process.exit(1); });
