#!/usr/bin/env node
/**
 * FABLE TRIAL — ONE measured scout run with --model fable, in an otherwise idle window. 2026-10-06 (research engine, stage 1).
 * Runbook: FABLE-TRIAL.md. Fable is never used for builds (claude-run.cjs refuses it for build/refuter roles).
 *
 *   node docs/server/research-stage01/fable-trial.cjs --before "<5h%>,<weekly all%>,<weekly fable%>" [--lane <lane>]
 *        Josh reads his Claude usage panel FIRST and types the three numbers. Refused unless: the scout stage is enabled (ramp), a
 *        smoke passed, no research run is active, it is NOT the weekday scout window (16:30-23:00 MT) nor 06:00-09:00 MT, and no
 *        trial is already recorded. Then ONE run as user scout through systemd with the scout service's exact properties:
 *        claude-run.cjs --role scout --model fable --lane <lane> --job-suffix fable   (job scout-<date>-<lane>-fable)
 *   node docs/server/research-stage01/fable-trial.cjs --after "<5h%>,<weekly all%>,<weekly fable%>"
 *        Josh reads the panel again (wait ~5 minutes for it to settle). Records, then prints the comparison and the design's rule:
 *        move scout + triage to Fable ONLY if "Weekly · all models" did not move — AND "Weekly · Fable" rose (a null on both meters
 *        is INCONCLUSIVE: one scout is below the panel's whole-percent resolution). The decision itself is Josh's.
 *        The trial's job (scout-<date>-<lane>-fable) writes its own out/scout/<date>-<lane>-fable.{md,json}, never the regular
 *        scout's files.
 *   node docs/server/research-stage01/fable-trial.cjs --status | --selftest
 * State: docs/server/research-stage01/fable-trial.json (home; numbers Josh typed + the run's budget row). No token is read here.
 */
"use strict";
const fs = require("fs"), path = require("path");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", "..");
const STATE = path.join(HERE, "fable-trial.json");
const LANES = ["equities", "futures-rates-fx", "crypto", "options-vol", "social-media-academic"];

/** Pure: "12,40,3" -> { session5h, weeklyAll, weeklyFable } (percent numbers), or throws */
function parseMeters(s) {
  const p = String(s || "").split(",").map((x) => x.trim().replace(/%$/, ""));
  if (p.length !== 3 || p.some((x) => !/^\d{1,3}(\.\d+)?$/.test(x) || +x > 100)) throw new Error(`meters must be three percentages "5h,weeklyAll,weeklyFable", e.g. "12,40,3" (got ${JSON.stringify(s)})`);
  return { session5h: +p[0], weeklyAll: +p[1], weeklyFable: +p[2] };
}
/** Pure: is now an idle window? (not the weekday scout window 16:30-23:00 MT, not Josh's morning 06:00-09:00 MT) */
function windowRefusal(ms) {
  const d = new Date(new Date(ms).toLocaleString("en-US", { timeZone: "America/Denver" })), m = d.getHours() * 60 + d.getMinutes(), wd = d.getDay();
  if (wd >= 1 && wd <= 5 && m >= 16 * 60 + 30 && m < 23 * 60) return "the weekday scout window (16:30-23:00 MT) — the trial must not overlap the regular scout";
  if (m >= 6 * 60 && m < 9 * 60) return "06:00-09:00 MT (the window Josh's morning inherits)";
  return null;
}
/** Pure: the one command the trial runs (the scout role, Fable, a distinct job id). */
const trialArgs = (factory, lane) => ["/usr/local/bin/node", `${factory}/bin/claude-run.cjs`, "--role", "scout", "--model", "fable", "--lane", lane, "--job-suffix", "fable"];
/**
 * Pure: the verdict from the two readings (2026-10-07 review fix). The design's rule is "move only if Weekly · all models does not
 * move" — but a null reading on BOTH weekly meters proves nothing: one scout is ~0.3-0.45% of the week, below the panel's whole-percent
 * resolution, so "all models did not move" is the expected reading whichever bucket Fable draws from. ELIGIBLE therefore needs the
 * positive evidence too: Weekly · Fable rose by >= 1 point while Weekly · all models did not. Nothing moved -> INCONCLUSIVE.
 */
function verdict(b, a) {
  const d = { session5h: +(a.session5h - b.session5h).toFixed(1), weeklyAll: +(a.weeklyAll - b.weeklyAll).toFixed(1), weeklyFable: +(a.weeklyFable - b.weeklyFable).toFixed(1) };
  const rule = "Move scout and triage to Fable only if 'Weekly · Fable' rises and 'Weekly · all models' does not move (design section 2; a null on both meters is no evidence).";
  if (d.weeklyAll > 0) return { delta: d, rule, verdict: "STAY-ON-OPUS", eligible: false, text: `Weekly · all models moved ${d.weeklyAll} pts (Fable ${d.weeklyFable}, 5-hour ${d.session5h}) -> STAY ON OPUS: Fable draws on the shared weekly pool (or other use moved it in the window — either way, no evidence it is free).` };
  if (d.weeklyFable >= 1) return { delta: d, rule, verdict: "ELIGIBLE", eligible: true, text: `Weekly · Fable rose ${d.weeklyFable} pts while Weekly · all models did not move (${d.weeklyAll}); 5-hour moved ${d.session5h} pts -> ELIGIBLE: Josh may move scout + triage to Fable. That is a re-staged package (traids-scout.service --model fable) — never a hand edit of the unit: install-server --step units and rollback --server refuse a unit this package did not write. Never builds.` };
  return { delta: d, rule, verdict: "INCONCLUSIVE", eligible: false, text: `Neither weekly meter moved a whole point (all models ${d.weeklyAll}, Fable ${d.weeklyFable}; 5-hour ${d.session5h}) -> INCONCLUSIVE: one scout is below the panel's resolution. This is NOT evidence that Fable is free. Stay on Opus; a larger trial (several Fable scouts in one idle window, enough to move the Fable meter by >= 2 points) is a separate decision for Josh — this script runs one.` };
}
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; } };
const writeState = (o) => require(path.join(REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic(STATE, o);

function before(meters, laneArg) {
  const S = require(path.join(HERE, "lib", "ssh.cjs")), I = require(path.join(HERE, "install-server.cjs"));
  if (readState()) throw new Error("a trial is already recorded in fable-trial.json — one trial only (delete the file deliberately to redo it)");
  const w = windowRefusal(Date.now()); if (w) throw new Error("not an idle window: " + w);
  const st = I.readState().steps || {}; if (!st.smoke || !st.smoke.ok) throw new Error("no passing smoke recorded — run deploy first");
  if (S.remoteYes("systemctl is-active --quiet traids-scout.service || systemctl list-units --no-legend 'traids-research-*' | grep -q running", "research unit active")) throw new Error("a research run is active right now — wait for it to finish");
  const lane = laneArg || LANES[(new Date().getDay() + 6) % 7] || "crypto";
  if (!LANES.includes(lane)) throw new Error("--lane must be one of " + LANES.join(", "));
  const m = parseMeters(meters), t0 = new Date().toISOString();
  writeState({ spec: "fable-trial-v1", before: { at: t0, ...m }, lane });
  console.log(`fable-trial: before recorded (${JSON.stringify(m)}); running ONE scout on Fable, lane ${lane} ...`);
  const stamp = t0.replace(/[-:.TZ]/g, "").slice(0, 14);
  const r = S.ssh(I.transientArgs(`traids-research-fable-${stamp}`, trialArgs(S.FACTORY, lane)), { timeout: 3600000 });
  const out = String(r.out) + String(r.err);
  for (const l of out.split("\n").filter((x) => /claude-run:/.test(x))) console.log("  " + l.trim());
  const row = (() => { try { const lines = S.must(S.ssh(`grep '"jobId":"scout-[0-9-]*-${lane}-fable"' ${S.FACTORY}/var/budget.jsonl | grep '"kind":"run"' | tail -n 1`), "budget row").trim(); return lines ? JSON.parse(lines) : null; } catch { return null; } })();
  const s = readState(); s.run = { at: new Date().toISOString(), exit: r.status, wallSec: Math.round((Date.now() - Date.parse(t0)) / 1000), budgetRow: row ? { class: row.class, errKind: row.errKind, total_cost_usd: row.total_cost_usd, modelsUsed: row.modelsUsed, modelUsage: row.modelUsage, num_turns: row.num_turns, duration_ms: row.duration_ms } : null }; writeState(s);
  console.log(`fable-trial: run exit ${r.status} · ${row ? `${row.class} · total_cost_usd ${row.total_cost_usd} · models ${JSON.stringify(row.modelsUsed)}` : "no budget row found"} · ${s.run.wallSec} s`);
  console.log("NEXT (Josh): wait ~5 minutes, read the usage panel again, then:  node docs/server/research-stage01/fable-trial.cjs --after \"<5h%>,<weekly all%>,<weekly fable%>\"");
}
function after(meters) {
  const s = readState(); if (!s || !s.before) throw new Error("no --before recorded"); if (s.after) throw new Error("--after already recorded");
  s.after = { at: new Date().toISOString(), ...parseMeters(meters) }; s.verdict = verdict(s.before, s.after); writeState(s);
  const opus = 2.87, c = s.run && s.run.budgetRow ? s.run.budgetRow.total_cost_usd : null;
  console.log(`fable-trial: ${s.verdict.text}`);
  console.log(`  cost: Fable run ${c == null ? "unknown" : "$" + c} vs the Opus scout reference $${opus} (design: 0.71M eff + Haiku)` + (c != null ? ` -> ${(c / opus).toFixed(2)}x` : ""));
  const mu = s.run && s.run.budgetRow && s.run.budgetRow.modelsUsed;
  console.log(`  total_cost_usd includes WebFetch's small-model calls? ${mu ? (mu.some((m) => /haiku/i.test(m)) ? "YES — a haiku model appears in modelUsage" : "no haiku model in modelUsage (" + mu.join(", ") + ")") : "unknown"}`);
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };
  ok("meters parse: '12,40,3' and '12%, 40%, 3%'", JSON.stringify(parseMeters("12,40,3")) === JSON.stringify(parseMeters("12%, 40%, 3%")));
  let e = null; try { parseMeters("12,40"); } catch (x) { e = x.message; } ok("two numbers or >100 refused", !!e && (() => { try { parseMeters("1,2,300"); return false; } catch { return true; } })());
  ok("idle window: weekday 17:30 MT refused, 07:00 MT refused, Tue 13:00 MT ok, Sat 18:00 MT ok", windowRefusal(Date.parse("2026-10-13T23:30:00Z")) && windowRefusal(Date.parse("2026-10-13T13:00:00Z")) && !windowRefusal(Date.parse("2026-10-13T19:00:00Z")) && !windowRefusal(Date.parse("2026-10-18T00:00:00Z")));
  const v1 = verdict({ session5h: 10, weeklyAll: 40, weeklyFable: 2 }, { session5h: 14, weeklyAll: 40, weeklyFable: 5 });
  const v2 = verdict({ session5h: 10, weeklyAll: 40, weeklyFable: 2 }, { session5h: 30, weeklyAll: 41, weeklyFable: 5 });
  const v3 = verdict({ session5h: 10, weeklyAll: 40, weeklyFable: 2 }, { session5h: 10, weeklyAll: 40, weeklyFable: 2 });
  ok("rule: Fable rose and weekly-all did not -> ELIGIBLE (Josh decides; re-stage, never a hand edit); weekly-all moved -> STAY ON OPUS", v1.eligible && v1.verdict === "ELIGIBLE" && /re-staged package/.test(v1.text) && !/edit traids-scout\.service/.test(v1.text) && !v2.eligible && /STAY ON OPUS/.test(v2.text));
  ok("rule: NOTHING moved (the review's case: 10,40,2 -> 10,40,2) -> INCONCLUSIVE, never ELIGIBLE", !v3.eligible && v3.verdict === "INCONCLUSIVE" && /NOT evidence/.test(v3.text), v3.text);
  const ta = trialArgs("/F", "crypto");
  ok("the trial runs the scout role with --model fable and a distinct job id (never a build role)", ta.join(" ") === "/usr/local/bin/node /F/bin/claude-run.cjs --role scout --model fable --lane crypto --job-suffix fable");
  console.log(`fable-trial selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2), val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  try {
    if (a[0] === "--selftest") process.exitCode = selftest() ? 0 : 1;
    else if (a[0] === "--status") { console.log(JSON.stringify(readState(), null, 1)); process.exitCode = 0; }
    else if (a[0] === "--before" && val("--before")) { before(val("--before"), val("--lane")); process.exitCode = 0; }
    else if (a[0] === "--after" && val("--after")) { after(val("--after")); process.exitCode = 0; }
    else { console.error('usage: --before "<5h%>,<weekly all%>,<weekly fable%>" [--lane L] | --after "..." | --status | --selftest — nothing was done'); process.exitCode = 2; }
  } catch (e) { console.error("fable-trial: " + e.message); process.exitCode = 1; }
}
module.exports = { parseMeters, windowRefusal, verdict, trialArgs };
