#!/usr/bin/env node
/**
 * CROSS-SECTIONAL SKEW OBSERVER — Phase 2 testing, step 2. (2026-08-20, operator: "build it")
 *
 * Per-name options skew from Schwab real-time chains, nightly, for the most liquid ~1,000
 * names of the expanded universe. This is the first signal family in the shop whose raw
 * material is NOT the daily price bar: options markets carry their own opinions (crash fear,
 * squeeze fear, event pricing), and whether those opinions predict the underlying is exactly
 * the kind of question the weighted board adjudicates.
 *
 * ═══ WHAT IS MEASURED, PER NAME ═══
 *   rr25   25-delta risk reversal: IV(25Δ put) − IV(25Δ call), in vol points. Positive = puts
 *          rich = downside fear priced; negative = calls rich = upside chase.
 *   atmIv  the at-the-money IV of the measured expiry (context, and the normalizer).
 *   skewN  rr25 / atmIv — normalized so a 60-vol biotech and a 15-vol staple are comparable.
 *   tenor  nearest expiry in the 20–45 DTE window (the standard skew tenor; 0DTE noise and
 *          LEAP staleness both excluded by construction).
 *
 * ═══ COVERAGE, DECLARED ═══
 *   Top 1,000 by median dollar volume from universe-expanded.json. Names without listed
 *   options, without a 20–45 DTE expiry, or without two-sided quotes at the needed deltas are
 *   SKIPPED AND COUNTED — never imputed. Schwab's 120/min cap paces the run (~10 min).
 *
 * ═══ HOW IT BECOMES A DIAL ═══
 *   The latest snapshot is served at /api/skew-xsec; the app stamps obs.skewRR (= skewN) on
 *   every equity ticket at entry. The weighted board AUTO-DISCOVERS numeric obs keys, so
 *   obs:skewRR enters the 38-dial table at weight ZERO and earns influence only by the same
 *   walk-forward bars as everything else. No opinion anywhere in the loop.
 *
 * Storage: data/skew-xsec.json — { days: { 'YYYY-MM-DD': { snapshotAt, n, skipped, bySym } } },
 * last 130 sessions kept. Idempotent per day (re-run overwrites today's snapshot only).
 * Run after the close: chains then carry the session's final quotes; snapshotAt is stamped.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const schwab = require("./lib/schwab.js");
const D = (f) => path.join(__dirname, "data", f);

const TOP_N = parseInt(process.env.SKEW_TOP || "1000", 10), DTE_LO = 20, DTE_HI = 45, DELTA = 0.25, DTOL = 0.12;
const OUT = D("skew-xsec.json");
const etDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => d.toISOString().slice(0, 10);

(async () => {
  const t0 = Date.now();
  const uni = JSON.parse(fs.readFileSync(D("universe-expanded.json"), "utf8"));
  const names = uni.names.slice(0, TOP_N).map((n) => n.sym);
  const today = etDay();
  const lo = iso(new Date(Date.now() + DTE_LO * 864e5)), hi = iso(new Date(Date.now() + DTE_HI * 864e5));

  const st = (() => { try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {
    return { spec: "skew-xsec-v1", registered: "2026-08-20", tenor: `${DTE_LO}-${DTE_HI} DTE`, delta: DELTA, days: {} };
  } })();

  const bySym = {}; let done = 0, skipped = 0;
  for (const sym of names) {
    try {
      const legs = await schwab.chain(sym, lo, hi, { strikeCount: 24 });
      const exps = [...new Set(legs.map((l) => l.exp))].sort();
      if (!exps.length) { skipped++; continue; }
      const exp = exps[0];
      const at = legs.filter((l) => l.exp === exp && l.delta != null && l.iv > 0);
      const pick = (right, want) => {
        let best = null, bd = Infinity;
        for (const l of at) { if (l.right !== right) continue; const d = Math.abs(l.delta - want); if (d < bd) { bd = d; best = l; } }
        return best && bd <= DTOL ? best : null;
      };
      const p25 = pick("P", -DELTA), c25 = pick("C", DELTA);
      const atm = at.length ? [...at].sort((a, b) => Math.abs(Math.abs(a.delta) - 0.5) - Math.abs(Math.abs(b.delta) - 0.5))[0] : null;
      if (!p25 || !c25 || !atm || !(atm.iv > 0)) { skipped++; continue; }
      const rr25 = +(100 * (p25.iv - c25.iv)).toFixed(2);
      bySym[sym] = { rr25, atmIv: +(100 * atm.iv).toFixed(1), skewN: +((p25.iv - c25.iv) / atm.iv).toFixed(4), exp };
      done++;
    } catch (e) {
      skipped++;
      if (String(e.message).includes("token")) { console.error("ABORT: " + e.message); break; }
    }
    await sleep(520);   // 120/min cap with headroom
    if ((done + skipped) % 200 === 0) console.log(`  …${done + skipped}/${names.length} (${done} measured)`);
  }

  st.days[today] = { snapshotAt: new Date().toISOString(), n: done, skipped, bySym };
  const keys = Object.keys(st.days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 130))) delete st.days[k];
  writeJsonAtomic(OUT, st);

  const vals = Object.values(bySym).map((v) => v.skewN).sort((a, b) => a - b);
  const q = (p) => vals[Math.floor(p * vals.length)] ?? null;
  console.log(`SKEW X-SEC — ${today}: ${done} names measured, ${skipped} skipped (no options / no tenor / thin quotes) in ${((Date.now() - t0) / 60000).toFixed(1)}m`);
  if (vals.length) console.log(`  skewN distribution: p10 ${q(0.1)} · median ${q(0.5)} · p90 ${q(0.9)} — fear is ${q(0.5) > 0 ? "put-side (normal)" : "call-side (unusual)"} at the median`);
  console.log(`written: skew-xsec.json · dial obs:skewRR self-registers on the weighted board once tickets carry it`);
})();
