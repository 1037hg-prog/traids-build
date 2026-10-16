"use strict";
/**
 * BUDGET — the weekly research cap, pure. 2026-10-06 (research engine, stage 0). Used by claude-run.cjs inside its lock.
 *
 * factory/var/budget.jsonl is APPEND-ONLY. Two row kinds:
 *   {"kind":"reserve","rid","ts","planWeek","role","jobId","estimateUsd","maxBudgetUsd"}   written under the lock BEFORE a launch
 *   {"kind":"run","rid","ts","planWeek","role","jobId","model","class","errKind","total_cost_usd","modelUsageCostUsd","costKnown",
 *    "usage","modelUsage","num_turns","duration_ms","session_id","exitCode"}               written under the lock AFTER the run
 * HARD CAP (2026-10-07 review fix; it used to reserve only the estimate, so a $8-max scout could launch with $5 of room left and a
 * resume after a limit cut got a fresh --max-budget-usd): a launch goes only if this plan week's spend + the role's maxBudgetUsd
 * (the most one invocation can cost: the CLI stops at --max-budget-usd) <= the cap. Spend =
 *   every run row's cost — the LARGER of total_cost_usd and the sum of modelUsage[*].costUSD (so the cap never under-counts if
 *     total_cost_usd turns out to exclude WebFetch's small-model calls: NOTES "Not verified" 4); a run with no readable cost counts
 *     its reservation's maxBudgetUsd —
 *   + every reservation with no run row yet at its maxBudgetUsd (a launch in flight, or one that crashed: counted until the week
 *     resets — over-count, never under-count).
 * The plan week starts Thu 10:00Z (caps.planWeekReset). A row that does not parse, a row of an unknown kind, or a cost / estimate /
 * max that is not a non-negative number makes the ledger UNREADABLE: the caller refuses to launch (cap enforcement would be blind,
 * or something other than claude-run wrote the ledger) and alerts (exit 70).
 */
const DAY = 86400000;
const nonNeg = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
/** Pure: is this a row claude-run could have written? (null = yes, else why not) */
function rowProblem(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "not an object";
  if (r.kind !== "reserve" && r.kind !== "run") return `unknown kind ${JSON.stringify(r.kind)}`;
  for (const k of ["estimateUsd", "maxBudgetUsd", "total_cost_usd", "modelUsageCostUsd"]) if (r[k] != null && !nonNeg(r[k])) return `${k} is ${JSON.stringify(r[k])}, not a non-negative number`;
  return null;
}
/** The cost one run row adds to the week: the larger readable cost, else the reservation's worst case. */
function runCost(run, res) {
  const c = [run.total_cost_usd, run.modelUsageCostUsd].filter(nonNeg);
  if (c.length) return Math.max(...c);
  return res ? (nonNeg(res.maxBudgetUsd) ? res.maxBudgetUsd : Number(res.estimateUsd) || 0) : 0;
}
const holdOf = (res) => (nonNeg(res.maxBudgetUsd) ? res.maxBudgetUsd : Number(res.estimateUsd) || 0);
/** The most one launch of this role can cost (its --max-budget-usd), the estimate when no max is set. */
const worstCase = (rc) => (rc.maxBudgetUsd != null && nonNeg(Number(rc.maxBudgetUsd)) ? Number(rc.maxBudgetUsd) : Number(rc.estimateUsd) || 0);

/** Start (ms) of the plan week containing ms: the latest weekdayUtc hourUtc:00Z at or before ms. */
function planWeekStart(ms, { weekdayUtc = 4, hourUtc = 10 } = {}) {
  const d = new Date(ms);
  let s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() - weekdayUtc + 7) % 7), hourUtc);
  if (s > ms) s -= 7 * DAY;
  return s;
}
/** Parse ledger text -> { rows, bad: [line numbers] }. A trailing newline is normal; an empty line is ignored. */
function parseLedger(text) {
  const rows = [], bad = [];
  String(text || "").split("\n").forEach((l, i) => { if (!l.trim()) return; try { const r = JSON.parse(l); if (rowProblem(r) == null) rows.push(r); else bad.push(i + 1); } catch { bad.push(i + 1); } });
  return { rows, bad };
}
const capUsd = (caps) => +(Number(caps.weeklyCapPoints) * Number(caps.usdPerPoint)).toFixed(2);
/** This plan week's spend. */
function weekSpend(rows, weekStartIso) {
  const res = new Map(), runs = [];
  for (const r of rows) { if (r.planWeek !== weekStartIso) continue; if (r.kind === "reserve") res.set(r.rid, r); else if (r.kind === "run") runs.push(r); }
  let runUsd = 0, reservedUsd = 0, builds = 0;
  const closed = new Set();
  for (const r of runs) { closed.add(r.rid); runUsd += runCost(r, res.get(r.rid)); }
  for (const [rid, r] of res) { if (!closed.has(rid)) reservedUsd += holdOf(r); if (r.role === "build") builds++; }
  return { runUsd: +runUsd.toFixed(4), reservedUsd: +reservedUsd.toFixed(4), totalUsd: +(runUsd + reservedUsd).toFixed(4), runs: runs.length, open: [...res.keys()].filter((k) => !closed.has(k)).length, builds };
}
/** Should this launch go? Pure. -> { ok, reason, spentUsd, capUsd, weekStart } */
function decideLaunch({ rows, bad = [], nowMs, caps, role }) {
  const ws = new Date(planWeekStart(nowMs, caps.planWeekReset || {})).toISOString(), cap = capUsd(caps);
  if (bad.length) return { ok: false, alert: true, reason: `budget.jsonl has ${bad.length} unreadable row(s) (line ${bad.slice(0, 5).join(", ")}) — cap enforcement is blind; REFUSED until it is repaired`, weekStart: ws, capUsd: cap };
  const r = (caps.roles || {})[role]; if (!r) return { ok: false, reason: `role ${role} has no caps entry`, weekStart: ws, capUsd: cap };
  const s = weekSpend(rows, ws), est = Number(r.estimateUsd) || 0, worst = worstCase(r);
  if (!(cap > 0)) return { ok: false, reason: `weekly cap is ${cap} — nothing launches`, weekStart: ws, capUsd: cap, spentUsd: s.totalUsd };
  if (s.totalUsd + worst > cap) return { ok: false, parked: true, reason: `weekly cap: spent $${s.totalUsd.toFixed(2)} this plan week + this job's worst case $${worst.toFixed(2)} (--max-budget-usd) > cap $${cap.toFixed(2)} (${caps.weeklyCapPoints} points) — parked until the plan week resets ${new Date(Date.parse(ws) + 7 * DAY).toISOString()}`, weekStart: ws, capUsd: cap, spentUsd: s.totalUsd };
  if (role === "build") {
    const row = rampRow(caps, nowMs), lim = Math.min(Number(row ? row.buildsPerWeek : 0) || 0, Number(caps.buildsPerWeekCeiling) || 15);
    if (s.builds >= lim) return { ok: false, parked: true, reason: `builds this plan week ${s.builds} >= ${lim} (ramp) — parked`, weekStart: ws, capUsd: cap, spentUsd: s.totalUsd };
  }
  return { ok: true, weekStart: ws, capUsd: cap, spentUsd: s.totalUsd, estimateUsd: est, worstCaseUsd: worst };
}
/** The ramp row in force at nowMs (dates are America/Denver calendar days), or null before the first. */
function rampRow(caps, nowMs) {
  const day = new Date(nowMs).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  let row = null; for (const r of caps.ramp || []) if (String(r.from) <= day) row = r;
  return row;
}
function roleEnabled(caps, role, nowMs) {
  const row = rampRow(caps, nowMs);
  if (row && (row.roles || []).includes(role)) return { ok: true, stage: row.stage };
  const next = (caps.ramp || []).find((r) => (r.roles || []).includes(role) && (!row || String(r.from) > String(row.from)));
  return { ok: false, reason: `role ${role} is not enabled ${row ? "in stage " + row.stage : "yet"}${next ? " — the ramp enables it from " + next.from : ""} (factory/var/caps.json)` };
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (name, cond, d) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (d ? " — " + d : "")); } };
  const caps = { weeklyCapPoints: 15, usdPerPoint: 31.6, planWeekReset: { weekdayUtc: 4, hourUtc: 10 }, buildsPerWeekCeiling: 15,
    roles: { scout: { estimateUsd: 2.87, maxBudgetUsd: 8 }, build: { estimateUsd: 31.6, maxBudgetUsd: 65 } }, ramp: [{ from: "2026-10-12", stage: 1, roles: ["scout"], buildsPerWeek: 0 }, { from: "2026-10-26", stage: 3, roles: ["scout", "build"], buildsPerWeek: 3 }] };
  const iso = (s) => new Date(planWeekStart(Date.parse(s))).toISOString();
  ok("plan week: Thu 09:59Z belongs to the previous week; Thu 10:00Z starts a new one; a Tuesday maps to the last Thursday", iso("2026-10-08T09:59:00Z") === "2026-10-01T10:00:00.000Z" && iso("2026-10-08T10:00:00Z") === "2026-10-08T10:00:00.000Z" && iso("2026-10-13T12:00:00Z") === "2026-10-08T10:00:00.000Z");
  ok("cap = 15 points x $31.6 = $474", capUsd(caps) === 474);
  const now = Date.parse("2026-10-13T23:30:00Z"), ws = iso("2026-10-13T23:30:00Z"), prev = iso("2026-10-06T12:00:00Z");
  const run = (usd, w = ws, rid = Math.random().toString(36).slice(2)) => [{ kind: "reserve", rid, planWeek: w, role: "scout", estimateUsd: 2.87, maxBudgetUsd: 8 }, { kind: "run", rid, planWeek: w, role: "scout", total_cost_usd: usd }];
  let rows = [...run(466.0), ...run(500, prev)];
  ok("HARD cap: spent $466.00 + the scout's worst case $8 (--max-budget-usd) = $474 <= $474 -> launch; last week's $500 does not count", decideLaunch({ rows, nowMs: now, caps, role: "scout" }).ok);
  rows = [...run(471.0)];
  const d = decideLaunch({ rows, nowMs: now, caps, role: "scout" });
  ok("HARD cap: spent $471.00 + $8 > $474 -> parked until the reset (the old estimate rule let it launch with a $479 worst case)", !d.ok && d.parked && /worst case \$8\.00/.test(d.reason) && /parked until the plan week resets 2026-10-15T10:00:00.000Z/.test(d.reason), d.reason);
  rows = [{ kind: "reserve", rid: "a", planWeek: ws, role: "scout", estimateUsd: 2.87, maxBudgetUsd: 300 }, ...run(172)];
  ok("an open reservation (in flight or crashed) counts its worst case (maxBudgetUsd)", !decideLaunch({ rows, nowMs: now, caps, role: "scout" }).ok && weekSpend(rows, ws).reservedUsd === 300);
  rows = [{ kind: "reserve", rid: "b", planWeek: ws, role: "scout", estimateUsd: 2.87, maxBudgetUsd: 8 }, { kind: "run", rid: "b", planWeek: ws, role: "scout", total_cost_usd: null }];
  ok("a run without a readable cost counts its reservation's worst case ($8), never the estimate", weekSpend(rows, ws).totalUsd === 8);
  rows = [{ kind: "reserve", rid: "c", planWeek: ws, role: "scout", estimateUsd: 2.87, maxBudgetUsd: 8 }, { kind: "run", rid: "c", planWeek: ws, role: "scout", total_cost_usd: 2.2, modelUsageCostUsd: 2.41 }];
  ok("a run counts the LARGER of total_cost_usd and the modelUsage sum (2.20 vs 2.41 -> 2.41)", weekSpend(rows, ws).totalUsd === 2.41);
  const p = parseLedger('{"kind":"run"}\n{half\n\n');
  ok("an unparseable ledger row -> REFUSED with an alert (cap enforcement would be blind)", p.bad.join() === "2" && decideLaunch({ rows: p.rows, bad: p.bad, nowMs: now, caps, role: "scout" }).alert === true);
  const neg = parseLedger(['{"kind":"run","rid":"x","total_cost_usd":-400}', '{"kind":"reserve","rid":"y","estimateUsd":"2"}', '{"kind":"refund","usd":400}', '{"kind":"run","rid":"z","total_cost_usd":1.5}'].join("\n"));
  ok("a negative cost, a non-number estimate and an unknown row kind are UNREADABLE rows (exit 70), never a credit", neg.bad.join() === "1,2,3" && neg.rows.length === 1 && decideLaunch({ rows: neg.rows, bad: neg.bad, nowMs: now, caps, role: "scout" }).alert === true, neg.bad.join());
  ok("ramp: scout off before 2026-10-12, on from it (Denver day); build only from stage 3", !roleEnabled(caps, "scout", Date.parse("2026-10-12T05:59:00Z")).ok && roleEnabled(caps, "scout", Date.parse("2026-10-12T06:00:00Z")).ok && /from 2026-10-26/.test(roleEnabled(caps, "build", now).reason));
  const bw = Date.parse("2026-10-27T12:00:00Z"), bws = iso("2026-10-27T12:00:00Z"), b = (rid) => ({ kind: "reserve", rid, planWeek: bws, role: "build", estimateUsd: 31.6, maxBudgetUsd: 65 });
  ok("builds per week: the 4th build in a stage-3 week is parked", decideLaunch({ rows: [b("1"), b("2")], nowMs: bw, caps, role: "build" }).ok && !decideLaunch({ rows: [b("1"), b("2"), b("3")], nowMs: bw, caps, role: "build" }).ok);
  ok("a cap of 0 launches nothing", !decideLaunch({ rows: [], nowMs: now, caps: { ...caps, weeklyCapPoints: 0 }, role: "scout" }).ok);
  console.log(`budget selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}
if (require.main === module) { if (process.argv.includes("--selftest")) process.exitCode = selftest() ? 0 : 1; else { console.log("budget.cjs: used by claude-run.cjs; --selftest"); process.exitCode = 2; } }
module.exports = { planWeekStart, parseLedger, weekSpend, decideLaunch, rampRow, roleEnabled, capUsd, rowProblem, runCost, worstCase };
