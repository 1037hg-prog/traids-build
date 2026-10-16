#!/usr/bin/env node
/**
 * TRAIDS — LEARNING TRACKER: is the research getting smarter, or just busier?
 *
 * WHY THE OBVIOUS VERSION IS A TRAP. The intuitive metric is "is expectancy rising?" It is
 * useless here. Expectancy sits near zero with a per-trade standard deviation around 0.2R, so
 * a day of ~40 trades carries a standard error near 0.03R — every wiggle in a rolling mean is
 * noise. Worse, it would read HIGH in a rising market and LOW in a falling one, measuring beta
 * and calling it learning.
 *
 * So this tracks what actually separates a smarter process from a luckier one, and every
 * metric is market-neutral or process-level:
 *
 *   1. SIGNAL MINUS CONTROL — controls are deliberately sub-threshold candidates settled under
 *      identical rules in the same sessions. If both legs fall together the market moved; if
 *      the GAP widens, selection improved. Primary metric.
 *   2. CALIBRATION — does stated confidence predict outcomes? A system can have flat
 *      expectancy and still be getting smarter if its confidence becomes more honest.
 *   3. EVIDENCE RICHNESS — observers captured per trade, early sessions vs recent.
 *   4. DISTANCE TO ADJUDICATION — how far from the pre-registered thresholds.
 *   5. MEASUREMENT TRUST — flattering defects found per audit.
 *
 * IT MUST BE ABLE TO SAY "DUMBER". A tracker that can only report improvement is a marketing
 * instrument. Every verdict is gated on POWER: where the sample cannot detect the effect size
 * in question, it says so rather than reporting a direction.
 *
 * Usage:  node backend/learning-tracker.js          (console + writes TRAIDS_Daily_Learning.html)
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const HTML_OUT = path.join(__dirname, "..", "TRAIDS_Daily_Learning.html");

// Everything printed is also captured, so the written report and the console can never disagree.
const LINES = [];
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.join(" "); LINES.push(s); _log(s); };
const rd = (f, fb) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return fb; } };
const CLEAN = new Date("2026-07-20T00:00:00-06:00").getTime();
// SESSION KEY fixed 2026-09-04: was America/Denver; every test uses ET. Session list and early/late split key on OPEN session. See lib/session.js.
const day = require("./lib/session.js").sessionOf;
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const pc = (v, n = 4) => v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(n);

const log = rd("trade_log.json", []);
const priced = log.filter(t => t && t.closedAt >= CLEAN && Number.isFinite(t.rMult) && Math.abs(t.rMult) < 10);
const sig = priced.filter(t => !t.ctrl), ctrl = priced.filter(t => t.ctrl);
const days = [...new Set(priced.map(t => day(t.openedAt)))].sort();

console.log("\n  TRAIDS — LEARNING TRACKER");
console.log("  Is the process getting smarter? Every verdict is gated on whether the sample can tell.\n");

// ── 1 ────────────────────────────────────────────────────────────────────────
console.log("  -- 1. SELECTION SKILL (signal minus control, market-neutral) --");
const sM = mean(sig.map(t => t.rMult)), cM = mean(ctrl.map(t => t.rMult));
const sS = sd(sig.map(t => t.rMult)), cS = sd(ctrl.map(t => t.rMult));
const gap = (sM != null && cM != null) ? sM - cM : null;
const se = (sS && cS && sig.length && ctrl.length) ? Math.sqrt(sS * sS / sig.length + cS * cS / ctrl.length) : null;
console.log(`  signals  n=${String(sig.length).padStart(4)}  mean ${pc(sM)}`);
console.log(`  controls n=${String(ctrl.length).padStart(4)}  mean ${pc(cM)}`);
console.log(`  gap ${pc(gap)}  +/-${se ? (1.96 * se).toFixed(4) : "—"} (95%)  ->  ${se && Math.abs(gap) > 1.96 * se ? "DISTINGUISHABLE from zero" : "NOT distinguishable from zero"}`);
/**
 * D7 FIX (logged 2026-07-26, flattering; closed 2026-07-27). This line used to report only the
 * sample needed to detect a 0.05R gap — about 27 controls — printed directly beneath a control
 * count of 34. It read as "we already have enough." We do not. 0.05R was an arbitrary reference
 * effect; the gap actually observed is roughly 10x smaller, and required sample scales with the
 * SQUARE of the inverse effect, so the real requirement is ~100x larger. The binding number is
 * the one for the OBSERVED gap, so that is what leads now, with 0.05R kept only as a benchmark.
 */
if (se && cS) {
  const needFor = (g) => Math.ceil((cS * cS) / Math.pow(Math.abs(g) / 1.96, 2));
  const ref = needFor(0.05);
  console.log(`  POWER: at the gap actually observed (${pc(gap)}), confirming it would need about`);
  console.log(`  ${gap ? needFor(gap).toLocaleString() : "—"} controls. You have ${ctrl.length}. Required sample scales with the SQUARE of`);
  console.log(`  the inverse effect size, so a 10x smaller gap costs 100x the controls.`);
  console.log(`  (A 0.05R gap — 10x larger than observed — would need only ~${ref.toLocaleString()}. That benchmark is`);
  console.log(`  not the situation you are in, and reading it alone was defect D7.)`);
}

// ── 2 ────────────────────────────────────────────────────────────────────────
console.log("\n  -- 2. CALIBRATION (does stated confidence predict?) --");
const withConf = sig.filter(t => Number.isFinite(t.conf));
if (withConf.length < 30) console.log(`  only ${withConf.length} records carry confidence — not readable yet`);
else {
  const p = (t) => (t.conf > 1 ? t.conf / 100 : t.conf);
  const hit = (t) => (t.rMult > 0 ? 1 : 0);
  const brier = mean(withConf.map(t => Math.pow(p(t) - hit(t), 2)));
  const base = mean(withConf.map(hit));
  const brierBase = mean(withConf.map(t => Math.pow(base - hit(t), 2)));
  console.log(`  Brier ${brier.toFixed(4)} vs always-guess-the-base-rate ${brierBase.toFixed(4)}`);
  console.log(`  skill score ${((1 - brier / brierBase) * 100).toFixed(1)}%  (0% = no better than the base rate)`);
  console.log(`  -> confidence ${brier < brierBase ? "ADDS information" : "adds NOTHING, or hurts"}`);
}

// ── 3 ────────────────────────────────────────────────────────────────────────
console.log("\n  -- 3. EVIDENCE RICHNESS (observers captured per trade) --");
const covOf = (rows) => rows.length ? mean(rows.map(t => t.obs ? Object.values(t.obs).filter(v => Number.isFinite(v)).length : 0)) : null;
const half = Math.floor(days.length / 2);
const early = sig.filter(t => days.indexOf(day(t.openedAt)) < half);
const late = sig.filter(t => days.indexOf(day(t.openedAt)) >= half);
const eC = covOf(early), lC = covOf(late);
console.log(`  earlier sessions: ${eC == null ? "—" : eC.toFixed(1)} observers/trade  (n=${early.length})`);
console.log(`  recent sessions:  ${lC == null ? "—" : lC.toFixed(1)} observers/trade  (n=${late.length})`);
if (eC != null && lC != null) console.log(`  -> ${lC > eC + 0.5 ? "RICHER" : lC < eC - 0.5 ? "THINNER — coverage is degrading" : "flat"}`);

// ── 4 ────────────────────────────────────────────────────────────────────────
console.log("\n  -- 4. DISTANCE TO ADJUDICATION --");
const perDay = days.length ? sig.length / days.length : 0;
console.log(`  skip-filter clock: ${sig.length}/2000 signal settles - ${perDay.toFixed(0)}/day - ETA ${perDay > 0 ? Math.ceil((2000 - sig.length) / perDay) + " trading days" : "—"}`);

/**
 * INTERIM LOOK AT n=500 — free, because it decides nothing.
 *
 * An earlier version of this block imposed an O'Brien-Fleming boundary (z >= 3.92) on the
 * grounds that peeking inflates the false-positive rate. That was over-cautious and slightly
 * wrong: MULTIPLE COMPARISONS COME FROM MULTIPLE DECISIONS, NOT MULTIPLE LOOKS. Alpha spending
 * exists for trials with a STOPPING RULE — where an encouraging interim can end the study early.
 * Here the interim cannot promote, cannot stop, and cannot alter the n>=2000 adjudication or its
 * pre-registered bar. With exactly one decision point, the final test's error rate is unchanged
 * no matter how often the accumulating data is inspected.
 *
 * The real risk of looking is BEHAVIOURAL, not statistical: a human who sees an encouraging
 * interim is more likely to revise the specification. Tests #41 through #43 are the evidence —
 * the risk rule was re-specified three times, each after seeing the previous failure. The
 * defence against that is the FROZEN DECLARATION and the fact that only n>=2000 adjudicates,
 * not a taller bar at the interim.
 *
 * So the interim reports the reference bar for context and does not gate on it.
 */
const INTERIM_N = 500, FINAL_N = 2000, Z_FINAL = 1.96;
const infoFrac = Math.min(1, sig.length / FINAL_N);
const zInterim = Z_FINAL / Math.sqrt(Math.max(0.01, INTERIM_N / FINAL_N));
if (sig.length < INTERIM_N) {
  const need = Math.ceil((INTERIM_N - sig.length) / Math.max(perDay, 1));
  console.log(`  interim preview at n=${INTERIM_N}: ${INTERIM_N - sig.length} more settles (~${need} trading days)`);
  console.log(`    it DECIDES NOTHING — only n>=${FINAL_N} adjudicates, at its frozen bar of ${Z_FINAL}. Looking is free;`);
  console.log(`    revising after looking is not, which is what the frozen declaration prevents.`);
} else {
  const gapZ = (gap != null && se) ? gap / se : null;
  console.log(`  INTERIM PREVIEW (n=${sig.length}, ${(infoFrac * 100).toFixed(0)}% of the way to adjudication) — DECIDES NOTHING:`);
  console.log(`    signal-control gap ${pc(gap)} · z ${gapZ == null ? "—" : gapZ.toFixed(2)}`);
  console.log(`    direction: ${gap > 0 ? "POSITIVE — selection ahead of its control" : gap < 0 ? "NEGATIVE — selection behind its control" : "flat"}`);
  console.log(`    interval ${se ? "+/-" + (1.96 * se).toFixed(4) : "—"} — watch this CLOSE, not the gap move. It is what more controls buy.`);
  console.log(`    for reference only, the final bar is z ${Z_FINAL} at n=${FINAL_N}. Nothing here changes it.`);
}
const fwd = rd("forward-candidates.json", { candidates: [] });
const marks = (() => { try { return fs.readFileSync(D("forward-marks.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } })();
for (const c of (fwd.candidates || []).filter(x => x.status === "live")) {
  const n = marks.filter(m => m.id === c.id).length;
  console.log(`  ${c.id.padEnd(20)} ${String(n).padStart(4)}/${c.minObs} observations toward a t >= ${c.correctedBar} bar`);
}

// ── 5 ────────────────────────────────────────────────────────────────────────
console.log("\n  -- 5. MEASUREMENT TRUST (flattering defects found per audit) --");
const defects = rd("defect-log.json", null);
if (!defects) console.log("  no defect log yet — audit findings should be recorded so this trend becomes visible");
else {
  // This block used to read d.found and d.flattering off the AUDIT object. Neither field exists
  // there — the counts live in audit.defects[].direction — so it printed "undefined found -
  // undefined flattering" for every row. The one panel whose job is to detect bias in my own
  // error-finding was itself blank. Fixed 2026-08-05.
  const audits = defects.audits || [];
  const KNOWN = Object.keys(defects.directions || {});          // flattering / conservative / neutral
  const odd = new Set();
  for (const a of audits.slice(-8)) {
    const ds = a.defects || [];
    const flat = ds.filter(x => x.direction === "flattering").length;
    for (const x of ds) if (!KNOWN.includes(x.direction)) odd.add(String(x.direction));
    const open = ds.filter(x => !x.fixed).length;
    console.log(`  ${a.date}  ${String(ds.length).padStart(2)} found · ${String(flat).padStart(2)} flattering · ${String(open).padStart(2)} still open   ${a.title || ""}`);
  }
  const all = audits.flatMap(a => a.defects || []);
  const fl = all.filter(x => x.direction === "flattering").length;
  console.log(`  ALL TIME: ${all.length} defects · ${fl} flattering (${(100 * fl / (all.length || 1)).toFixed(0)}%) · ${all.filter(x => !x.fixed).length} open`);
  console.log(`  Flattering share is the number that matters: errors that made a result look BETTER`);
  console.log(`  are the ones that would have gotten money funded. A rising share means the`);
  console.log(`  measurement is drifting toward telling me what I want to hear.`);
  // Untagged or off-schema directions are silently excluded from that share, which would
  // understate it. Say so rather than letting the percentage look cleaner than its input.
  if (odd.size) console.log(`  CAUTION: ${odd.size} off-schema direction value(s) present (${[...odd].join(", ")}) — these are EXCLUDED from the flattering count, so the share above is a LOWER BOUND. Retag to: ${KNOWN.join(" / ")}.`);
}

// ── verdict ──────────────────────────────────────────────────────────────────
const canTell = se != null && gap != null && Math.abs(gap) > 1.96 * se;
console.log(`\n  VERDICT: ${canTell
  ? (gap > 0 ? "selection beats its control by a distinguishable margin" : "selection is LOSING to its own control — that is getting dumber")
  : "UNDETERMINED — the sample cannot yet separate skill from noise. That is the honest state, not a failure."}`);
console.log("  Nothing here improves by trading more. It improves by accumulating CONTROLS and closing defects.\n");

// ── DAILY DELTA ──────────────────────────────────────────────────────────────
// "Look at the trend every day" is right about the intent and dangerous about the statistics.
// Daily P&L carries roughly 0.03R of standard error, so a day-over-day move in expectancy or
// win rate is noise every single time — reading it daily is the mechanism by which people
// convince themselves a flat system is improving.
//
// The distinction that makes daily review honest: COUNTS are readable daily, RATES are not.
// Controls accumulated, observers captured, defects closed, observations banked toward a
// pre-registered bar — all of those move for real reasons and can be checked every morning.
// Expectancy, win rate and the signal-control gap need months. So they are shown as LEVELS
// with their confidence interval and explicitly refused as daily trend readings.
const hist = rd("learning-history.json", []);
const snap = {
  date: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
  nSig: sig.length, nCtrl: ctrl.length, sigMean: sM, ctrlMean: cM, gap, se, days: days.length,
  obsPerTrade: lC, defectsOpen: defects ? (defects.audits || []).flatMap(a => a.defects || []).filter(x => !x.fixed).length : null,
  fwdObs: marks.length,
};
/**
 * D15 (2026-07-27, conservative): prev was hist[last], so a SECOND run on the same day compared
 * today against today and every count printed +0 — the report announced "nothing improved" no
 * matter what had actually been banked. One snapshot per DAY, and the delta compares against the
 * most recent STRICTLY EARLIER day. Re-running is now idempotent, which a daily report requires.
 */
const prev = hist.filter(h => h.date < snap.date).pop() || null;

console.log("  == TODAY'S DELTA — what actually moved ==");
if (!prev) console.log("  first snapshot of a new day — nothing earlier to compare against yet. Tomorrow this section has content.");
else {
  console.log(`  since ${prev.date} (the last recorded day, not the last run):`);
  const d = (k) => (snap[k] == null || prev[k] == null) ? null : snap[k] - prev[k];
  const line = (label, key, good) => {
    const v = d(key);
    if (v == null) { console.log(`  ·  ${label.padEnd(34)} —`); return; }
    const dir = v > 0 ? "+" : "";
    const mark = v === 0 ? "·" : (good === "up" ? (v > 0 ? "^" : "v") : (v < 0 ? "^" : "v"));
    console.log(`  ${mark}  ${label.padEnd(34)} ${dir}${v}${v !== 0 ? "" : "  (no change)"}`);
  };
  console.log("  READABLE DAILY (counts — these move for real reasons):");
  line("signal settles banked", "nSig", "up");
  line("controls banked (the binding one)", "nCtrl", "up");
  line("forward observations banked", "fwdObs", "up");
  line("open defects", "defectsOpen", "down");
  line("sessions recorded", "days", "up");
  console.log("  NOT READABLE DAILY (rates — shown as levels, never as a daily trend):");
  console.log(`  ·  signal-control gap                ${pc(gap)} +/-${se ? (1.96 * se).toFixed(4) : "—"}  <- needs months, not days`);
  console.log(`  ·  observers per trade               ${lC == null ? "—" : lC.toFixed(1)}`);
}

// ── TRENDLINE — direction across snapshots, not a single reading ─────────────
// The delta above answers "what moved today". This answers "are we moving the right way",
// which is the actual question. Counts get a slope over the last N snapshots; rates get shown
// with their interval and an explicit statement of whether the interval is TIGHTENING — because
// a gap that stays flat while its error bar shrinks IS progress, and a gap that wanders while
// the bar stays wide is not.
const series = hist.concat([snap]);
const byDate = [...new Map(series.map(s => [s.date, s])).values()].sort((a, b) => a.date.localeCompare(b.date));
console.log("\n  == TRENDLINE — are we moving the right way? ==");
if (byDate.length < 2) {
  console.log(`  ${byDate.length} distinct day(s) recorded. The trendline needs several days of history;`);
  console.log(`  it fills in automatically now that the tracker runs on every close.`);
} else {
  const first = byDate[0], last = byDate[byDate.length - 1];
  const span = byDate.length;
  const row = (label, key, good) => {
    const a = first[key], b = last[key];
    if (a == null || b == null) { console.log(`  ·  ${label.padEnd(30)} —`); return; }
    const chg = b - a;
    const dir = chg === 0 ? "flat" : (good === "up" ? (chg > 0 ? "IMPROVING" : "DEGRADING") : (chg < 0 ? "IMPROVING" : "DEGRADING"));
    // Counts are integers; observers-per-trade is a ratio and was printing 16 decimal places
    // ("16.51048951048951 -> 23.893700787401574"). Format by value, not by key name.
    const f = (v) => Number.isInteger(v) ? String(v) : v.toFixed(1);
    console.log(`  ${dir === "IMPROVING" ? "^" : dir === "DEGRADING" ? "v" : "·"}  ${label.padEnd(30)} ${f(a).padStart(6)} -> ${f(b).padEnd(6)} (${chg >= 0 ? "+" : ""}${f(chg)})  ${dir}`);
  };
  console.log(`  over ${span} recorded day(s), ${first.date} -> ${last.date}:`);
  row("controls banked", "nCtrl", "up");
  row("signal settles banked", "nSig", "up");
  row("forward observations", "fwdObs", "up");
  row("open defects", "defectsOpen", "down");
  row("observers per trade", "obsPerTrade", "up");
  // the rate: is the ERROR BAR shrinking, which is what progress looks like before an answer
  const ciNow = last.se ? 1.96 * last.se : null, ciThen = first.se ? 1.96 * first.se : null;
  if (ciNow != null && ciThen != null) {
    const tighter = ciNow < ciThen;
    console.log(`  ${tighter ? "^" : "v"}  ${"signal-control interval".padEnd(30)} +/-${(ciThen).toFixed(4)} -> +/-${(ciNow).toFixed(4)}  ${tighter ? "TIGHTENING (progress)" : "not yet tightening"}`);
    console.log(`     the gap itself (${pc(last.gap)}) is NOT a trend reading — only the interval is, until it excludes zero.`);
  }
}

// UPSERT, not push — see D15. The last run of a day is the day's record.
const iSame = hist.findIndex(h => h.date === snap.date);
if (iSame >= 0) hist[iSame] = snap; else hist.push(snap);
const clean = [...new Map(hist.map(s => [s.date, s])).values()].sort((a, b) => a.date.localeCompare(b.date));
fs.writeFileSync(D("learning-history.json"), JSON.stringify(clean.slice(-500), null, 1));
console.log(`\n  GET SMARTER TODAY BY: banking controls (the gap's binding constraint), closing open`);
console.log(`  defects, and letting the forward candidates accrue. Not by trading more.`);
console.log(`  ${clean.length} day(s) in learning-history.json\n`);

/* ────────────────────────────────────────────────────────────────────────────
 * THE WRITTEN REPORT
 *
 * The console version vanishes into a log file nobody opens. This writes the same content — the
 * SAME captured lines, so the two cannot drift — to a page that can be opened every morning.
 *
 * The cards at the top are COUNTS ONLY, deliberately. Putting expectancy or win rate in a
 * headline card is how a flat system gets read as an improving one: at ~0.03R of daily standard
 * error those numbers move every day for no reason. Counts move because something was actually
 * banked. The rates appear further down, as levels with their interval, labelled as unreadable
 * on a daily timescale.
 * ──────────────────────────────────────────────────────────────────────────── */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dlt = (k) => (prev && snap[k] != null && prev[k] != null) ? snap[k] - prev[k] : null;
const card = (label, val, key, good) => {
  const d = key ? dlt(key) : null;
  const cls = d == null || d === 0 ? "" : (good === "up" ? (d > 0 ? "good" : "bad") : (d < 0 ? "good" : "bad"));
  const tag = d == null ? "" : ` <span class="${cls}">${d > 0 ? "+" : ""}${d}</span>`;
  return `<div><b>${val}</b><span>${label}${tag}</span></div>`;
};
const trendRow = (label, key, good) => {
  const a = clean[0]?.[key], b = clean[clean.length - 1]?.[key];
  if (a == null || b == null) return `<tr><td>${label}</td><td class="num">—</td><td class="num">—</td><td>—</td></tr>`;
  const chg = b - a, dir = chg === 0 ? "flat" : (good === "up" ? (chg > 0 ? "IMPROVING" : "DEGRADING") : (chg < 0 ? "IMPROVING" : "DEGRADING"));
  const f = (x) => typeof x === "number" && !Number.isInteger(x) ? x.toFixed(1) : x;
  return `<tr><td>${label}</td><td class="num">${f(a)}</td><td class="num">${f(b)}</td><td class="${dir === "IMPROVING" ? "good" : dir === "DEGRADING" ? "bad" : ""}">${dir}</td></tr>`;
};
const ciNow = snap.se ? 1.96 * snap.se : null, ciFirst = clean[0]?.se ? 1.96 * clean[0].se : null;
const verdictTxt = canTell
  ? (gap > 0 ? "Selection beats its control by a distinguishable margin." : "Selection is LOSING to its own control — that is getting dumber.")
  : "UNDETERMINED — the sample cannot yet separate skill from noise. That is the honest state, not a failure.";

fs.writeFileSync(HTML_OUT, `<!doctype html><meta charset="utf-8"><title>TRAIDS — Daily Learning Report ${snap.date}</title>
<style>
 :root{--ink:#16181d;--bg:#fff;--mut:#5b6270;--line:#dfe3ea;--accent:#1b4d8f;--soft:#f6f8fb;--good:#146c43;--bad:#a3242b}
 @media (prefers-color-scheme:dark){:root{--ink:#e7eaf0;--bg:#12141a;--mut:#9aa3b2;--line:#2a2f3a;--accent:#7fb0ee;--soft:#191d25;--good:#4ade80;--bad:#f08d8d}}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
 .wrap{max-width:880px;margin:0 auto;padding:52px 26px 80px}
 h1{font-size:30px;margin:0 0 6px;letter-spacing:-.02em}
 .sub{color:var(--mut);font-size:15px;margin:0 0 32px}
 h2{font-size:20px;margin:46px 0 12px;padding-bottom:7px;border-bottom:1px solid var(--line)}
 p{margin:0 0 13px}
 table{width:100%;border-collapse:collapse;margin:16px 0;font-size:13.5px}
 th,td{text-align:left;padding:8px 11px;border-bottom:1px solid var(--line);vertical-align:top}
 th{font-size:11.5px;text-transform:uppercase;letter-spacing:.055em;color:var(--mut);font-weight:600}
 .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
 .good{color:var(--good);font-weight:600}.bad{color:var(--bad);font-weight:600}
 .box{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:0 7px 7px 0;padding:14px 17px;margin:18px 0;background:var(--soft)}
 .box p:last-child{margin:0}
 .kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:11px;margin:18px 0}
 .kv div{border:1px solid var(--line);border-radius:7px;padding:11px 13px}
 .kv b{display:block;font-size:24px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
 .kv span{font-size:11.5px;color:var(--mut)}
 details{margin:18px 0;border:1px solid var(--line);border-radius:7px;padding:11px 15px;background:var(--soft)}
 summary{cursor:pointer;font-size:13px;color:var(--mut)}
 pre{overflow-x:auto;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;margin:12px 0 0;white-space:pre-wrap}
 .foot{margin-top:50px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--mut)}
</style><div class="wrap">
<h1>Did we trade smarter today?</h1>
<p class="sub">${snap.date} &middot; TRAIDS learning tracker &middot; ${prev ? `compared against ${prev.date}` : "first recorded day"}</p>

<div class="box"><p><b>Verdict:</b> ${esc(verdictTxt)}</p>
<p style="margin-top:8px">Smarter is not the same as greener. A green day in a rising market is beta. What this measures is whether
<b>selected</b> trades beat <b>deliberately sub-threshold controls</b> settled under identical rules in the same sessions — if both legs move together the market moved; only the gap is skill.</p></div>

<h2>What moved since ${prev ? prev.date : "the start"}</h2>
<p>Counts only. These move for real reasons and are honest to read daily.</p>
<div class="kv">
${card("controls banked &mdash; the binding one", snap.nCtrl, "nCtrl", "up")}
${card("signal settles banked", snap.nSig, "nSig", "up")}
${card("forward observations", snap.fwdObs, "fwdObs", "up")}
${card("open defects", snap.defectsOpen ?? "—", "defectsOpen", "down")}
${card("sessions recorded", snap.days, "days", "up")}
</div>

<h2>Not readable daily</h2>
<p>Per-trade standard deviation is about 0.2R, so a session of ~40 trades carries roughly 0.03R of standard error.
Every day-over-day move in these is noise. They are shown as <b>levels with an interval</b>, never as a daily trend.</p>
<table><tr><th>Measure</th><th class="num">Level</th><th>Reading</th></tr>
<tr><td>signal &minus; control gap</td><td class="num">${pc(gap)} &plusmn;${ciNow ? ciNow.toFixed(4) : "—"}</td><td>${canTell ? "distinguishable from zero" : "not distinguishable from zero"}</td></tr>
<tr><td>observers per trade (recent)</td><td class="num">${lC == null ? "—" : lC.toFixed(1)}</td><td>evidence richness</td></tr>
<tr><td>signals mean / controls mean</td><td class="num">${pc(sM)} / ${pc(cM)}</td><td>market-driven; only the gap matters</td></tr>
</table>

<h2>Trendline &mdash; are we moving the right way?</h2>
${clean.length < 2
  ? `<p>${clean.length} recorded day(s). This fills in automatically now that the tracker runs on every close.</p>`
  : `<p>Over ${clean.length} recorded days, ${clean[0].date} &rarr; ${clean[clean.length - 1].date}:</p>
<table><tr><th>Measure</th><th class="num">Then</th><th class="num">Now</th><th>Direction</th></tr>
${trendRow("controls banked", "nCtrl", "up")}
${trendRow("signal settles banked", "nSig", "up")}
${trendRow("forward observations", "fwdObs", "up")}
${trendRow("open defects", "defectsOpen", "down")}
${trendRow("observers per trade", "obsPerTrade", "up")}
${ciFirst != null && ciNow != null ? `<tr><td>signal&minus;control interval</td><td class="num">&plusmn;${ciFirst.toFixed(4)}</td><td class="num">&plusmn;${ciNow.toFixed(4)}</td><td class="${ciNow < ciFirst ? "good" : ""}">${ciNow < ciFirst ? "TIGHTENING (progress)" : "not yet tightening"}</td></tr>` : ""}
</table>
<p>The <b>interval</b> is the trend reading here, not the gap. A gap that holds still while its error bar shrinks is progress;
a gap that wanders while the bar stays wide is not.</p>`}

<h2>How to get smarter tomorrow</h2>
<p>Bank controls &mdash; the gap's binding constraint &mdash; close open defects, and let the forward candidates accrue.
<b>Not by trading more.</b> More signal settles without matching controls widens nothing.</p>

<details><summary>Full tracker output (all five sections, verbatim)</summary><pre>${esc(LINES.join("\n"))}</pre></details>

<p class="foot">Written by <code>backend/learning-tracker.js</code> on every market close &middot; ${clean.length} day(s) of history &middot;
paper-only research record, not investment advice.</p>
</div>`);
console.log(`  report: TRAIDS_Daily_Learning.html\n`);
