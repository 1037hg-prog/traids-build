#!/usr/bin/env node
/**
 * R192 — MONTH-END INDEX-EXTENSION DEMAND BEYOND TREASURIES (registered 2026-09-24 before this file ran; rule frozen in the registry).
 * R180's exact rule on AGG, LQD, MUB (primary: equal-weight average per month), HYG as a contrast. 2016-01..2026-08, SIP daily adjustment=all.
 *   node backend/r192-bond-month-end.js    -> data/r192-bond-month-end.json; seals once if the placebo control is computed
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f);
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")), T = seals.tests || seals; if (T.R192) { console.error("R192 already sealed — refusing"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === "R192"), BAR = E.bar.tRequired;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); }, tOf = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const SYMS = ["AGG", "LQD", "MUB", "HYG"], PRIMARY = ["AGG", "LQD", "MUB"], COST = 0.0004;
(async () => {
  const { bars } = await fetchBars(SYMS, { start: "2015-12-01", end: "2026-09-01", feed: "sip", adjustment: "all", quiet: true });
  const byM = {};   // sym -> month -> [daily returns]
  for (const s of SYMS) { byM[s] = {}; const b = bars[s]; for (let i = 1; i < b.length; i++) { const d = b[i].t.slice(0, 10), m = d.slice(0, 7); if (m < "2016-01" || m > "2026-08") continue; (byM[s][m] = byM[s][m] || []).push(b[i].c / b[i - 1].c - 1); } }
  const excessAt = (a, start) => { const w = a.slice(start, start + 5), o = [...a.slice(0, start), ...a.slice(start + 5)]; return w.reduce((p, x) => p * (1 + x), 1) - 1 - 5 * mean(o) - COST; };
  const months = Object.keys(byM.AGG).filter((m) => PRIMARY.every((s) => (byM[s][m] || []).length >= 15)).sort();
  const series = (syms, pick) => months.map((m) => mean(syms.map((s) => excessAt(byM[s][m], pick(byM[s][m], m)))));
  const lastStart = (a) => a.length - 5;
  const primary = series(PRIMARY, lastStart);
  const each = Object.fromEntries(SYMS.map((s) => { const v = series([s], lastStart); return [s, { meanPct: +(100 * mean(v)).toFixed(3), t: +tOf(v).toFixed(3) }]; }));
  const draws = []; for (let k = 0; k < 200; k++) { const rng = mulberry(192000 + k); const v = series(PRIMARY, (a) => Math.floor(rng() * (a.length - 4))); draws.push(tOf(v)); } draws.sort((a, b) => a - b); const p95 = draws[Math.floor(0.95 * draws.length)];
  const half = Math.floor(months.length / 2), h1 = primary.slice(0, half), h2 = primary.slice(half);
  const t = tOf(primary), pass = t >= BAR && t > p95;
  const verdict = pass ? `PASS — AGG/LQD/MUB month-end window +${(100 * mean(primary)).toFixed(3)}%/mo, t ${t.toFixed(3)} >= ${BAR}, placebo p95 ${p95.toFixed(2)}` : `DID NOT PASS — pooled +${(100 * mean(primary)).toFixed(3)}%/mo, t ${t.toFixed(3)} vs ${BAR} (placebo p95 ${p95.toFixed(2)})`;
  const out = { spec: "r192-bond-month-end-v1", test: "R192", ranAt: new Date().toISOString(), months: months.length, window: [months[0], months[months.length - 1]], primary: { meanPct: +(100 * mean(primary)).toFixed(3), t: +t.toFixed(3), firstHalfT: +tOf(h1).toFixed(2), secondHalfT: +tOf(h2).toFixed(2), winPct: +(100 * primary.filter((x) => x > 0).length / primary.length).toFixed(0) }, each, placebo: { p95: +p95.toFixed(3), median: +draws[100].toFixed(3) }, bar: BAR, verdict };
  writeJsonAtomic(D("r192-bond-month-end.json"), out); console.log(JSON.stringify(out, null, 1));
  T.R192 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "months", verdict }; writeJsonAtomic(D("read-seals.json"), seals);
  E.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R192", verdict }) + "\n");
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
