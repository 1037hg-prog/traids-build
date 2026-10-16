#!/usr/bin/env node
/**
 * NEWS GATE SCAN — the motivating pass for a news-conditioned REFUSAL, and nothing more.
 * Built 2026-08-31 for the news-trader seat, which holds escrowed authority and has never had a
 * rule to be graded on.
 *
 * WHY A GATE RATHER THAN A DIRECTIONAL RULE. R13 says buying pre-market-news gappers loses at
 * t -4.20 over 290 independent days, and that survives day-weighting (287 of 290 days carry n>=20;
 * dropping the one thin day strengthens it). But the fade of it is untradeable for execution
 * reasons, not statistical ones: the whole margin sits inside a 10bps/side cost assumption, its
 * break-even is ~51bps round trip against our own 30.8bps measured on LIQUID names, and it is the
 * short leg of gapping news names — the hardest borrow there is. R20 separately found scheduled
 * macro nights indistinguishable from ordinary ones (t 0.08) — the exact NFP/CPI/FOMC list every
 * public "news trading" guide names as the tradeable one.
 *
 * A GATE ESCAPES ALL OF THAT. A refusal pays no spread, borrows no stock and crosses no market. It
 * is graded on whether the tickets it DECLINED lost — the veto-shadow convention R49 and R53
 * already use. That is why this is the news-trader's rule and the fade is not.
 *
 * THIS FILE IS A SEARCH AND SAYS SO. It scans every news observation on the canonical ledger for
 * association with realised net rMult. Everything it prints is IN-SAMPLE, weightless, and owes a
 * best-of-N bar to whatever is registered afterwards — N being the number of fields examined here,
 * printed at the end so the bar cannot be quietly under-counted later. It registers nothing,
 * refuses nothing, and changes no rule.
 */
const R = require("./lib/reconcile.js");
const path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);

const led = R.cleanEraLedger();
const rows = [...(led.signals || []), ...(led.controls || [])].filter((t) => Number.isFinite(t.rMult));
console.log(`\nNEWS GATE SCAN — canonical clean era via lib/reconcile.js · ${rows.length} settled rows\n`);

// ── which news fields exist, and on how many rows ──
const fields = {};
for (const t of rows) {
  const o = t.obs || {};
  for (const [k, v] of Object.entries(o)) {
    if (!/news/i.test(k)) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    (fields[k] ||= []).push({ v, r: t.rMult, day: t.openedDay || String(t.openedAt).slice(0, 10) });
  }
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
/** Day-clustered t: sessions are the unit, never tickets. */
function dayT(pairs) {
  const by = {};
  for (const p of pairs) (by[p.day] ||= []).push(p.r);
  const d = Object.values(by).map(mean).filter(Number.isFinite);
  if (d.length < 3) return { t: null, sessions: d.length };
  const m = mean(d);
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (d.length - 1));
  return { t: sd > 0 ? +(m / (sd / Math.sqrt(d.length))).toFixed(2) : null, sessions: d.length, mean: +m.toFixed(4) };
}

const out = [];
for (const [k, arr] of Object.entries(fields)) {
  if (arr.length < 100) continue;
  const vals = arr.map((x) => x.v).sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.2)], hi = vals[Math.floor(vals.length * 0.8)];
  if (!(hi > lo)) continue;                                   // no spread in the field, nothing to gate on
  const bottom = arr.filter((x) => x.v <= lo), top = arr.filter((x) => x.v >= hi);
  const b = dayT(bottom), t_ = dayT(top);
  out.push({ field: k, n: arr.length, coveragePct: +(100 * arr.length / rows.length).toFixed(1),
    p20: +lo.toFixed(4), p80: +hi.toFixed(4),
    bottomMeanR: b.mean, bottomT: b.t, bottomSessions: b.sessions,
    topMeanR: t_.mean, topT: t_.t, topSessions: t_.sessions,
    gapR: b.mean != null && t_.mean != null ? +(t_.mean - b.mean).toFixed(4) : null });
}
out.sort((a, b) => Math.abs(b.gapR ?? 0) - Math.abs(a.gapR ?? 0));

console.log("  field                 cov%      n   |  BOTTOM 20%          |  TOP 20%             |   gap");
console.log("  " + "-".repeat(94));
for (const r of out)
  console.log("  " + r.field.padEnd(20) + String(r.coveragePct).padStart(5) + String(r.n).padStart(7) +
    "   |  " + String(r.bottomMeanR).padStart(8) + "R t" + String(r.bottomT).padStart(7) +
    "  |  " + String(r.topMeanR).padStart(8) + "R t" + String(r.topT).padStart(7) +
    "  | " + String(r.gapR).padStart(8) + "R");

writeJsonAtomic(D("news-gate-scan.json"), {
  spec: "news-gate-scan-v1", asOf: new Date().toISOString(), rowsScanned: rows.length,
  fieldsExamined: out.length,
  standing: "MOTIVATING / IN-SAMPLE / WEIGHTLESS. This is a SEARCH over " + out.length + " fields. Anything registered from it owes a best-of-" + out.length + " bar from lib/null-bar.js. It registers nothing and refuses nothing.",
  clustering: "sessions, never tickets — every t above is day-clustered",
  fields: out,
});

console.log("\n  FIELDS EXAMINED: " + out.length + "  <- anything registered off this owes a best-of-" + out.length + " bar.");
console.log("  Everything above is IN-SAMPLE and carries ZERO weight. It exists to choose ONE rule to test forward.");
console.log("written: data/news-gate-scan.json\n");
