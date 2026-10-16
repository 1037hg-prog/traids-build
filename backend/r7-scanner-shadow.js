#!/usr/bin/env node
/**
 * R7 SCANNER SHADOW — settle & grade the Alerts scanner's calls without trading them.
 *
 * THE OPERATOR'S ASK (2026-07-30): the Alerts panel's 7-model ensemble had real prices, an
 * uncalibrated "Confidence" percent, and ZERO graded calls — it fed only a screen and an inert
 * SMS path. The answer was not to wire it into trading (its indicators are the same family the
 * board already runs at +0.0040R vs random); it was to make it EARN a seat or die on the record.
 *
 * DESIGN — all of it registered in test-registry.json (R7) BEFORE any evidence existed:
 *   cohort A  unbiased daily snapshot: ALL rows of the day's first RTH scan, frozen by
 *             traids-alerts.js regardless of signal. No selection on interestingness.
 *   cohort B  flip events — what the alert gate would have texted. Graded separately, never
 *             pooled with A.
 *   settle    +1 / +3 / +5 TRADING days, close-to-close from the snapshot day's close.
 *   endpoint  PRIMARY: cohort A, +3d, MARKET-RELATIVE signed return  dir*(ret - SPY ret).
 *             Market-relative because 100 correlated large caps mostly bet the tape; the raw
 *             number would grade the market, not the scanner.
 *   stats     DAY-CLUSTERED. 100 same-morning calls are ONE observation of one tape. The t is
 *             computed across daily means; effective N is trading days, never calls.
 *   bars      primary t>=2.0 at >=20 days and >=200 directional calls. Secondary cells
 *             (3 horizons x 2 cohorts) at Šidák |t|>=2.71. Fixed in advance; re-tuning means
 *             abandoning R7 and registering R8.
 *   calibration  every directional call bucketed by the panel's claimed "Confidence"; actual
 *             hit rate with Wilson 95% intervals. If the buckets aren't monotone with n>=50
 *             each and the 100% bucket doesn't exclude 50%, the UI column is renamed
 *             "Model Agreement" — displaying an uncalibrated ratio as a percent is a defect
 *             independent of whether the scanner has edge.
 *
 * The trading-day calendar is SPY's bar dates — no invented calendar arithmetic. A symbol
 * missing a bar on either leg is skipped and counted; it never gets a substituted price.
 *
 * Usage: node backend/r7-scanner-shadow.js     (wired into daily-close.bat, before daily-health)
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const STATE = D("r7-scanner-shadow.json");
const BARS_URL = process.env.TRAIDS_BARS_URL || "http://localhost:3001/api/equities/bars";
const HORIZONS = [1, 3, 5];
const EVIDENCE_START = "2026-07-31";

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const tOf = a => a.length >= 3 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null;
const wilson = (k, n) => {          // 95% interval on a hit rate — never a bare percentage at small n
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return { p: +(p * 100).toFixed(1), lo: +((c - h) * 100).toFixed(1), hi: +((c + h) * 100).toFixed(1) };
};

async function fetchCloses(symbols, days) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50);
    const r = await fetch(BARS_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: batch, days }), signal: AbortSignal.timeout(90000),
    });
    if (!r.ok) throw new Error(`bars endpoint ${r.status}`);
    const d = (await r.json()).data || {};
    for (const s in d) {
      const m = {};
      for (const b of (d[s] || [])) if (Number.isFinite(b.c) && b.t) m[b.t] = b.c;
      if (Object.keys(m).length) out[s] = m;
    }
  }
  return out;
}

(async () => {
  console.log(`\n  R7 SCANNER SHADOW — settle & grade (nothing trades)\n`);
  let st;
  try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); }
  catch { console.log("  no snapshots yet — traids-alerts.js writes the first one on the first RTH scan after deploy."); return; }
  st.settled = st.settled || {};

  const snapDays = Object.keys(st.days || {}).filter(d => d >= EVIDENCE_START).sort();
  if (!snapDays.length) { console.log(`  no snapshot days on/after ${EVIDENCE_START} yet.`); return; }

  // ── SETTLE ────────────────────────────────────────────────────────────────
  // The SPY date axis IS the trading-day calendar.
  const need = snapDays.filter(d => !(st.settled[d] && st.settled[d].complete));
  if (need.length) {
    const allSyms = [...new Set(snapDays.flatMap(d => st.days[d].rows.map(r => r.sym)))];
    const span = 40 + HORIZONS[HORIZONS.length - 1];     // enough history to cover every open day
    const closes = await fetchCloses(["SPY", ...allSyms], span);
    const spyDates = Object.keys(closes.SPY || {}).sort();
    if (!spyDates.length) { console.error("  ABORT — no SPY bars; settling nothing rather than inventing a calendar."); process.exit(1); }

    for (const day of need) {
      const di = spyDates.indexOf(day);
      if (di < 0) { console.warn(`  ${day}: not on the SPY calendar (bars not landed yet?) — skipped`); continue; }
      const rec = st.settled[day] = st.settled[day] || {};
      for (const h of HORIZONS) {
        if (rec["h" + h]) continue;                       // idempotent — settled horizons are sealed
        const exitDate = spyDates[di + h];
        if (!exitDate) continue;                          // horizon not reachable yet
        const spyEntry = closes.SPY[day], spyExit = closes.SPY[exitDate];
        if (!(spyEntry > 0 && spyExit > 0)) continue;
        const spyRet = (spyExit / spyEntry - 1) * 100;
        const rows = []; let skipped = 0;
        for (const r of st.days[day].rows) {
          const m = closes[r.sym];
          const e = m && m[day], x = m && m[exitDate];
          if (!(e > 0 && x > 0)) { skipped++; continue; } // no bar => no row, never a substitute
          const ret = (x / e - 1) * 100;
          const dir = r.signal === "BUY" ? 1 : r.signal === "SELL" ? -1 : 0;
          rows.push({ sym: r.sym, dir, conf: r.confidence, vote: r.vote,
            ret: +ret.toFixed(3), alpha: dir === 0 ? null : +((dir * (ret - spyRet))).toFixed(3) });
        }
        rec["h" + h] = { exitDate, spyRet: +spyRet.toFixed(3), settledAt: new Date().toISOString(), skipped, rows };
        console.log(`  settled ${day} +${h}d → ${exitDate}: ${rows.length} rows (${skipped} skipped, SPY ${spyRet >= 0 ? "+" : ""}${spyRet.toFixed(2)}%)`);
      }
      rec.complete = !!rec.h5;
    }
  }

  // ── GRADE — day-clustered, exactly as registered ─────────────────────────
  const flipsByDay = {};
  for (const f of (st.flips || []).filter(f => f.date >= EVIDENCE_START)) (flipsByDay[f.date] ||= []).push(f.sym + "|" + f.signal);

  const grade = (cohortB) => {
    const out = {};
    for (const h of HORIZONS) {
      const dayMeans = [];
      let calls = 0;
      for (const day of Object.keys(st.settled)) {
        const cell = st.settled[day]["h" + h];
        if (!cell) continue;
        let rows = cell.rows.filter(r => r.dir !== 0);
        if (cohortB) { const keys = new Set(flipsByDay[day] || []); rows = rows.filter(r => keys.has(r.sym + "|" + (r.dir > 0 ? "BUY" : "SELL"))); }
        if (!rows.length) continue;
        dayMeans.push(mean(rows.map(r => r.alpha)));
        calls += rows.length;
      }
      const t = tOf(dayMeans);
      out["h" + h] = { days: dayMeans.length, calls, meanAlpha: dayMeans.length ? +mean(dayMeans).toFixed(4) : null, t: t == null ? null : +t.toFixed(2) };
    }
    return out;
  };

  const A = grade(false), B = grade(true);

  // calibration on the primary horizon, pooled rows (the CLAIM being tested is per-call)
  const buckets = {};
  let neutralRets = [];
  for (const day of Object.keys(st.settled)) {
    const cell = st.settled[day].h3; if (!cell) continue;
    for (const r of cell.rows) {
      if (r.dir === 0) { neutralRets.push(r.ret - cell.spyRet); continue; }
      const k = r.conf.toFixed(2);
      (buckets[k] ||= { n: 0, hits: 0 }); buckets[k].n++; if (r.alpha > 0) buckets[k].hits++;
    }
  }
  const calibration = Object.keys(buckets).sort((a, b) => a - b)
    .map(k => ({ claimed: +(k * 100).toFixed(0), n: buckets[k].n, ...wilson(buckets[k].hits, buckets[k].n) }));

  const primary = A.h3;
  const bar = { minDays: 20, minCalls: 200, primaryT: 2.0, sidakT: 2.71 };
  const verdict =
    primary.days < bar.minDays || primary.calls < bar.minCalls
      ? `PENDING — ${primary.days}/${bar.minDays} days, ${primary.calls}/${bar.minCalls} directional calls`
      : primary.t >= bar.primaryT ? `PRIMARY BAR MET (t ${primary.t}) — hold to the Šidák family before believing any cell`
      : primary.t <= -bar.primaryT ? `RELIABLY WRONG (t ${primary.t}) — a candidate for NEGATIVE weight, which is still information`
      : `NO EDGE (t ${primary.t}) — the prior held`;

  st.report = { spec: "r7-v1", gradedAt: new Date().toISOString(), bar, cohortA: A, cohortB: B,
    primary: { ...primary, endpoint: "cohort A · +3d · market-relative · day-clustered" },
    neutral: { n: neutralRets.length, meanMktRel: neutralRets.length ? +mean(neutralRets).toFixed(4) : null },
    calibration, verdict };
  fs.writeFileSync(STATE, JSON.stringify(st));

  console.log(`\n  COHORT A (daily snapshot) — day-clustered mean signed alpha vs SPY`);
  for (const h of HORIZONS) { const c = A["h" + h]; console.log(`    +${h}d  days ${String(c.days).padStart(3)} · calls ${String(c.calls).padStart(4)} · mean ${c.meanAlpha == null ? "—" : (c.meanAlpha >= 0 ? "+" : "") + c.meanAlpha + "%"} · t ${c.t ?? "—"}`); }
  console.log(`  COHORT B (flip events)`);
  for (const h of HORIZONS) { const c = B["h" + h]; console.log(`    +${h}d  days ${String(c.days).padStart(3)} · calls ${String(c.calls).padStart(4)} · mean ${c.meanAlpha == null ? "—" : (c.meanAlpha >= 0 ? "+" : "") + c.meanAlpha + "%"} · t ${c.t ?? "—"}`); }
  if (calibration.length) {
    console.log(`  CALIBRATION (+3d) — does "Confidence" predict anything?`);
    for (const c of calibration) console.log(`    claimed ${String(c.claimed).padStart(3)}% → actual ${c.p}%  [${c.lo}–${c.hi}]  n=${c.n}`);
  }
  console.log(`\n  VERDICT: ${verdict}`);
})().catch(e => { console.error("  R7 shadow failed:", e.message); process.exit(1); });
