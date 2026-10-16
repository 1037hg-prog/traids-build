#!/usr/bin/env node
/**
 * DIAGNOSTIC (2026-09-19, weightless): where does the paper book reliably LOSE, and does that hold out of sample?
 * The book's net expectancy is negative, so the only evidence-backed route to "more profitable" is subtraction: stop taking the
 * slices that lose for a reason, and stop paying cost that buys nothing. Picking losers in-sample is the mirror image of picking
 * winners in-sample, so every slice is judged SPLIT-HALF: it must lose in the first half of sessions AND in the second half, and the
 * decision is made on the first half only (the second half is the check). Session-clustered t throughout; controls shown beside
 * signals where the slice has them. Canonical ledger only (lib/reconcile.js). Writes data/diag-book-by-subtraction.json.
 */
const path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const L = require("./lib/reconcile.js").cleanEraLedger();
const dayOf = (t) => new Date(t.openedAt || t.closedAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sessT = (rows) => { const by = {}; for (const r of rows) (by[dayOf(r)] ||= []).push(r.rMult); const m = Object.values(by).map(mean); if (m.length < 3) return { t: null, k: m.length }; const g = mean(m), sd = Math.sqrt(m.reduce((s, x) => s + (x - g) ** 2, 0) / (m.length - 1)); return { t: sd > 0 ? +(g / (sd / Math.sqrt(m.length))).toFixed(2) : null, k: m.length }; };
const S = L.signals.filter((t) => Number.isFinite(t.rMult)), days = [...new Set(S.map(dayOf))].sort(), cut = days[Math.floor(days.length / 2)];
const stat = (rows) => { const s = sessT(rows); return { n: rows.length, sessions: s.k, meanR: rows.length ? +mean(rows.map((r) => r.rMult)).toFixed(4) : null, t: s.t, winPct: rows.length ? +(100 * rows.filter((r) => r.rMult > 0).length / rows.length).toFixed(1) : null, usd: Math.round(rows.reduce((a, r) => a + (r.pnl || 0), 0)), totalR: +rows.reduce((a, r) => a + r.rMult, 0).toFixed(1) }; };
const SLICES = { "class": (t) => t.cls, "strategy": (t) => t.strategy, "class x direction": (t) => `${t.cls} ${t.dir > 0 ? "long" : "short"}`, "class x strategy": (t) => `${t.cls} / ${t.strategy}`, "exit reason": (t) => t.reason,
  "spread at entry": (t) => { const b = t.obs && t.obs.spreadBps; return !Number.isFinite(b) ? "unknown" : b < 10 ? "< 10 bps" : b < 30 ? "10-30 bps" : b < 100 ? "30-100 bps" : ">= 100 bps"; },
  "signal age": (t) => { const a = t.obs && t.obs.sigAge; return !Number.isFinite(a) ? "unknown" : a <= 1 ? "fresh (day 1)" : a <= 3 ? "2-3 days" : "4+ days"; } };
const out = { spec: "diag-book-by-subtraction-v1", asOf: new Date().toISOString(), weight: "NONE — descriptive; split-half check; nothing here changes a gate", sessions: days.length, splitAt: cut, whole: stat(S), firstHalf: stat(S.filter((t) => dayOf(t) < cut)), secondHalf: stat(S.filter((t) => dayOf(t) >= cut)), slices: {} };
console.log(`book: ${JSON.stringify(out.whole)}\nsplit at ${cut}: first ${JSON.stringify(out.firstHalf)}\n            second ${JSON.stringify(out.secondHalf)}\n`);
const candidates = [];
for (const [name, fn] of Object.entries(SLICES)) { const groups = {}; for (const t of S) (groups[fn(t)] ||= []).push(t); out.slices[name] = {};
  console.log(`— ${name} —`);
  for (const [g, rows] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) { if (rows.length < 30) continue; const a = stat(rows.filter((t) => dayOf(t) < cut)), b = stat(rows.filter((t) => dayOf(t) >= cut)), w = stat(rows);
    const holds = a.meanR != null && b.meanR != null && a.meanR < 0 && b.meanR < 0 && a.t != null && a.t <= -1.5;   // chosen on the FIRST half; the second half is the check
    out.slices[name][g] = { whole: w, firstHalf: a, secondHalf: b, reliableLoser: holds };
    console.log(`  ${String(g).padEnd(28)} n ${String(w.n).padStart(4)}  meanR ${String(w.meanR).padStart(8)}  t ${String(w.t).padStart(6)}  $${String(w.usd).padStart(7)} | 1st ${String(a.meanR).padStart(8)} (t ${a.t})  2nd ${String(b.meanR).padStart(8)} (t ${b.t}) ${holds ? " <== loses in both halves" : ""}`);
    if (holds) candidates.push({ slice: name, group: g, ...w, secondHalfMeanR: b.meanR, secondHalfN: b.n }); } }
out.reliableLosers = candidates; writeJsonAtomic(path.join(__dirname, "data", "diag-book-by-subtraction.json"), out);
console.log(`\nreliable losers (first half t <= -1.5 AND negative again in the second half): ${candidates.length}`); for (const c of candidates) console.log(`  ${c.slice}: ${c.group} — n ${c.n}, meanR ${c.meanR}, second-half meanR ${c.secondHalfMeanR} on ${c.secondHalfN}`);
