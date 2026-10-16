#!/usr/bin/env node
/**
 * TEST #72 — Momentum-flip early exit for SHORTS: cut at the first adverse close, save money?
 *
 * PRE-REGISTERED 2026-08-20, before any result was examined.
 *
 * HYPOTHESIS
 *   Exiting a short at the first CLOSE that is X% adverse (above entry) produces a better mean
 *   R than holding to the recorded settle (stop/target/close), because squeezes accelerate:
 *   an early adverse close predicts further adverse movement.
 *
 * WHY IT MIGHT BE TRUE
 *   Short squeezes are reflexive (covering begets covering), so adverse momentum against a
 *   short may continue more often than it mean-reverts. Why it might be FALSE: crypto/equity
 *   daily noise routinely prints +3-5% closes inside downtrends that resume; cutting every
 *   flip converts recoverable wiggles into locked losses and forfeits the winners entirely.
 *
 * MOTIVATING SAMPLE — NOT EVIDENCE
 *   Born from the 2026-08-18..20 crypto squeeze (15 shorts stopped, ~$16k at old stakes).
 *   Results are reported WITH and WITHOUT closes dated 2026-08-15..20; only the WITHOUT
 *   column can support the hypothesis. The motivating week is displayed for honesty and
 *   excluded from adjudication.
 *
 * VARIANT FAMILY (size: 3) — adverse-close thresholds X in {3%, 5%, 8%}. The significance
 *   bar is the null-bar best-of-3 at the realized day-count, not 2.0.
 *
 * DATA   settled SHORT trades (dir=-1) from trade_log.json, cls Crypto/Equity, clean epoch
 *        (2026-07-20 →), with entry, stopDist, openedAt/closedAt; daily bars via the local
 *        yahoo batch (crypto CCC-USD, equities as-is). Trades whose bars cannot be fetched
 *        are DROPPED AND COUNTED.
 *
 * RULE   walk daily closes from entry date; at the first close >= X% above the short entry,
 *        exit at THAT close (conservative: not at the threshold price — a close-based rule
 *        can only trade the close). Otherwise keep the recorded outcome. R = (entry-exit)/stopDist.
 *
 * DECISION RULE — PASS if, EXCLUDING the motivating week, the best variant's mean R improvement
 *   over recorded outcomes is positive with day-clustered t above the null-bar best-of-3 p95.
 *   FAIL if no variant clears. Either way the number is recorded and the forward answer, if
 *   pursued, is a fresh registration. KNOWN-ANSWER: a threshold of 9999% must reproduce the
 *   recorded outcomes exactly (improvement 0.000).
 */
const fs = require("fs"), path = require("path");
const { nullBar } = require("./lib/null-bar");
const D = (f) => path.join(__dirname, "data", f);
const YAHOO = process.env.TRAIDS_YAHOO || "http://localhost:3002";
const post = (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(180000) }).then(r => r.ok ? r.json() : Promise.reject(new Error(`${u} ${r.status}`)));
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => { const s = sd(a); return s ? mean(a) / (s / Math.sqrt(a.length)) : 0; };

(async () => {
  const log = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8"));
  const EPOCH = Date.parse("2026-07-20");
  const shorts = log.filter(t => t.dir === -1 && ["Crypto", "Equity"].includes(t.cls) && t.closedAt >= EPOCH
    && typeof t.entry === "number" && typeof t.rMult === "number" && t.stopDist > 0 && t.openedAt && !t.ctrl
    && !/r24$/.test(t.id || ""));
  const syms = [...new Set(shorts.map(t => t.cls === "Crypto" ? t.sym.replace("/", "-") : t.sym))];
  const bars = (await post(`${YAHOO}/api/yahoo/batch`, { symbols: syms, days: 120 })).data || {};
  const seriesOf = (t) => bars[t.cls === "Crypto" ? t.sym.replace("/", "-") : t.sym] || null;

  const THRESH = [3, 5, 8], MOTIV_LO = "2026-08-15", MOTIV_HI = "2026-08-20";
  let dropped = 0;
  const evalRule = (X, excludeMotiv) => {
    const perDay = {};
    for (const t of shorts) {
      const cd = day(t.closedAt);
      if (excludeMotiv && cd >= MOTIV_LO && cd <= MOTIV_HI) continue;
      const s = seriesOf(t);
      if (!s) { dropped++; continue; }
      const od = day(t.openedAt);
      const path_ = s.filter(b => b.t > od && b.t <= cd && Number.isFinite(b.c));
      let exit = null;
      for (const b of path_) if (b.c >= t.entry * (1 + X / 100)) { exit = b.c; break; }
      const ruleR = exit != null ? (t.entry - exit) / t.stopDist : t.rMult;
      const diff = ruleR - t.rMult;                       // improvement vs the recorded outcome
      (perDay[cd] = perDay[cd] || []).push(diff);
    }
    const daily = Object.values(perDay).map(mean);
    return { X, n: Object.values(perDay).flat().length, days: daily.length, meanDiff: mean(daily), t: tOf(daily) };
  };

  // known-answer: an unreachable threshold must reproduce recorded outcomes exactly
  const ka = evalRule(9999, false);
  if (Math.abs(ka.meanDiff) > 1e-9) { console.error(`KNOWN-ANSWER FAIL: 9999% threshold changed outcomes (${ka.meanDiff}) — harness broken, refusing to report.`); process.exit(2); }

  console.log(`TEST #72 — momentum-flip early exit for shorts · ${shorts.length} settled shorts, clean epoch`);
  for (const label of ["WITH motivating week (display only — NOT evidence)", "WITHOUT motivating week (the adjudicated column)"]) {
    const ex = label.startsWith("WITHOUT");
    console.log(`  ${label}:`);
    const rows = THRESH.map(X => evalRule(X, ex));
    for (const r of rows) console.log(`    exit at +${r.X}% adverse close: mean R improvement ${r.meanDiff >= 0 ? "+" : ""}${r.meanDiff.toFixed(4)} · day-clustered t ${r.t.toFixed(2)} (${r.days} days, ${r.n} trades)`);
    if (ex) {
      const best = rows.reduce((a, b) => (b.t > a.t ? b : a));
      const bar = nullBar({ variants: 3, n: Math.max(3, best.days) });
      const verdict = best.meanDiff > 0 && best.t >= bar.p95 ? "PASS (kill-tests next)" : "DOES NOT CLEAR";
      console.log(`    best-of-3: +${best.X}% at t ${best.t.toFixed(2)} vs null-bar p95 ${bar.p95.toFixed(2)} → ${verdict}`);
      fs.writeFileSync(D("test72-flip-exit.json"), JSON.stringify({ ranAt: new Date().toISOString(), shorts: shorts.length, dropped, rows, best, bar: { p95: +bar.p95.toFixed(3) }, verdict }, null, 1));
    }
  }
  if (dropped) console.log(`  (${dropped} trade-evaluations dropped for missing bars — counted, not hidden)`);
})();
