#!/usr/bin/env node
/**
 * TRAIDS — svrZ FORWARD PERSISTENCE TRACKER (test #35 forward leg, started 2026-07-23)
 *
 * WHY: test #35 (daily short-volume z20 × 1d) is the cleanest statistical result in 38
 * tests (t 3.32, OOS t 3.09, survives Bonferroni) — and REAL-BUT-COST-LOCKED, with one
 * open caveat: a 17-month single-regime window. This tracker extends the sample forward,
 * one honest day at a time, using the IDENTICAL universe and signal as the test. If the
 * spread persists through new regimes it becomes durable knowledge; if it decays, the
 * decay is the finding. NOTHING HERE TRADES — costs already locked the strategy.
 *
 * PRE-REGISTERED (fixed at creation):
 *   • Signal: 20d z of FINRA daily short-volume ratio via /api/svr-z (as-of the last
 *     published file — no lookahead: the file publishes ~6pm ET the prior evening, so a
 *     portfolio formed after today's close legitimately entered at TODAY's open).
 *   • Portfolio: bottom-z quintile LONG, top-z quintile SHORT, equal weight, 1-day hold.
 *     CORRECTED 2026-07-29 (D34): returns are the entry session's OPEN-TO-CLOSE, spread ÷ 2 —
 *     the exact quantities the validating backtest measured. This file originally said
 *     "open-to-open" — that wording WAS the bug: the forward leg had drifted from the spec it
 *     claimed to extend, and printed 14× the backtest reference before it was caught.
 *   • Gross spread recorded; NET applies the stated cost model: 15 bps/day
 *     (10 bps round trip per leg × ~75% daily quintile turnover × 2 legs) — the same
 *     economics that locked the strategy; expected net ≈ negative, that is the point.
 *   • Persistence bar: the GROSS mean stays positive with t growing as days accrue —
 *     reviewed at each observer checkup (first: 2026-08-14). Sign-flip or fade to
 *     noise = the 17-month window was regime luck. Either answer is recorded.
 *
 * State: backend/data/svrz-forward.json · Usage: node backend/svrz-forward.js (weekdays post-close)
 */
const fs = require("fs"), path = require("path");
const STATE = path.join(__dirname, "data", "svrz-forward.json");
const ETFS = new Set(["SPY", "QQQ", "IWM", "DIA"]);
const UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","CRM","ADBE","AVGO","INTC","QCOM","MU","TXN","ORCL","CSCO","IBM","NOW","SNOW","PLTR","SHOP","UBER","ABNB","COIN","PYPL","ROKU","ZM","DOCU","DDOG","NET","CRWD","ZS","OKTA","MDB","TWLO","TEAM","WDAY","PANW","FTNT","MRVL","ON","SMCI","ARM","DELL","HPQ","WDC","STX","ANET","KLAC","LRCX","AMAT","ASML","TSM","SOFI","HOOD","AFRM","UPST","RIVN","LCID","NIO","XPEV","LI","F","GM","BA","CAT","DE","GE","HON","UNP","JPM","BAC","GS","MS","C","WFC","SCHW","V","MA","AXP","COF","BLK","LLY","UNH","JNJ","PFE","MRK","ABBV","BMY","MRNA","REGN","VRTX","GILD","AMGN","ISRG","DXCM","XOM","CVX","COP","OXY","SLB","HAL","MPC","WMT","COST","TGT","HD","LOW","NKE","SBUX","MCD","DIS","CMCSA","T","VZ","PG","KO","PEP","MARA","RIOT","MSTR","DKNG","CVNA","CHWY","RBLX","U","DASH","PINS","SNAP","SPOT","TTD","ENPH","FSLR","BABA","JD","PDD","MELI","SE","CMG","LULU","ORLY","ROST","TJX","MMM","LMT","RTX","NOC","GD","UPS","FDX","CSX","NSC","EMR","ITW","PH","ETN","APD","LIN","SHW","ECL","NEM","FCX","NUE","STLD","DOW","DD","PPG","KMB","CL","GIS","K","HSY","STZ","MO","PM","EL","SYY","ADM","BG","CF","MOS","DVN","FANG","EOG","PSX","VLO","KMI","WMB","OKE","D","DUK","SO","NEE","AEP","EXC","SRE","PCG","ED","XEL","WEC","AWK","AMT","PLD","EQIX","CCI","PSA","O","SPG","DLR","AVB","EQR","VICI","WELL","ARE","BXP","HST","KIM","REG"].filter(s => !ETFS.has(s));
const COST_DAILY = 0.0015;
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const tOf = a => a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0;
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

(async () => {
  console.log(`\n  TRAIDS — svrZ FORWARD PERSISTENCE (test #35 forward leg) · nothing trades\n`);
  let state = { pending: [], days: [] };
  try { state = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}

  /**
   * D34 MIGRATION (2026-07-29, one-time). The forward leg was NOT measuring the same quantity
   * as the backtest that validated the signal — two independent mismatches, found when three
   * forward days printed 14x the backtest reference and were nearly read as "persistence met":
   *
   *   SCALE   backtest: (mean(lo) − mean(hi)) / 2  — per dollar of GROSS across both legs.
   *           forward:   mean(L) − mean(S)         — raw spread. Factor of 2.
   *   WINDOW  backtest: close(entry) / open(entry) − 1 — the entry session's OPEN-TO-CLOSE.
   *           forward:   open(next) / open(entry) − 1  — 24h open-to-open incl. the overnight
   *           gap, which for US equities behaves nothing like the intraday segment.
   *
   * The backtest is the pre-registered spec, so the forward CONFORMS TO IT — this corrects an
   * implementation bug; the spec itself is untouched. Data cost, stated plainly: 2026-07-23 and
   * 2026-07-24 stored no leg constituents and can never be recomputed under any definition —
   * they are RETIRED (kept in state.retired, append-only, never silently deleted) and the
   * forward record restarts. Days with stored legs are re-queued and re-settled under v2.
   */
  if (!state.spec || state.spec !== "v2-openclose-half") {
    const retired = [], requeue = [];
    for (const d of (state.days || [])) {
      if (Array.isArray(d.longs) && Array.isArray(d.shorts))
        requeue.push({ entryDate: d.date, srcAsOf: d.srcAsOf || null, longs: d.longs, shorts: d.shorts, requeuedByD34: true });
      else retired.push({ ...d, retired: "D34 — no stored legs; measured under the wrong definition and unrecomputable" });
    }
    state.retired = [...(state.retired || []), ...retired];
    state.pending = [...(state.pending || []), ...requeue];
    state.days = [];
    state.spec = "v2-openclose-half";
    console.log(`  D34 migration: ${retired.length} day(s) RETIRED (no legs stored), ${requeue.push ? requeue.length : 0} re-queued for v2 settle. Forward record restarts at n=0.`);
  }

  // 1) settle any pending portfolios whose exit bar now exists (open-to-open)
  if (state.pending.length) {
    const names = [...new Set(state.pending.flatMap(p => [...p.longs, ...p.shorts]))];
    const bars = {};
    for (let i = 0; i < names.length; i += 300) {
      const r = await fetch("http://localhost:3001/api/equities/bars", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: names.slice(i, i + 300), days: 90 }) });
      if (r.ok) { const d = (await r.json()).data || {}; for (const s in d) if (d[s]) bars[s] = d[s]; }
    }
    const still = [];
    for (const p of state.pending) {
      const leg = (sym) => {
        // D34 fix: the entry session's OPEN-TO-CLOSE — the exact return the backtest measured
        // (short-volume-test.js:130, px[i0+1].c / e.o − 1). The old open-to-open spanned 24h
        // including the overnight gap, which is a different return, not a different convention.
        // Requiring i0+1 to exist keeps the completeness guarantee: a bar with a successor is a
        // finished session, never today's still-forming one.
        const b = bars[sym]; if (!b) return null;
        const i0 = b.findIndex(x => x.t >= p.entryDate);
        if (i0 < 0 || i0 + 1 >= b.length || !(b[i0].o > 0) || !(b[i0].c > 0)) return null;
        return b[i0].c / b[i0].o - 1;
      };
      const L = p.longs.map(leg).filter(Number.isFinite), S = p.shorts.map(leg).filter(Number.isFinite);
      if (L.length < 20 || S.length < 20) { still.push(p); continue; }   // exit bar not published yet
      // D34 fix: ÷2 matches the backtest's scale — return per dollar of GROSS capital across
      // both legs (short-volume-test.js:136). COST_DAILY already expresses cost on gross
      // capital, so it subtracts from this scale unchanged.
      const gross = (mean(L) - mean(S)) / 2;
      // Constituents are persisted so the placebo test (does the spread load on the FORMATION
      // session rather than the held window?) stays runnable retroactively. Days settled before
      // 2026-07-27 have no legs stored and can never be re-tested — that gap is permanent.
      state.days.push({ date: p.entryDate, srcAsOf: p.srcAsOf || null, gross: +gross.toFixed(5), net: +(gross - COST_DAILY).toFixed(5), nL: L.length, nS: S.length, longs: p.longs, shorts: p.shorts });
      console.log(`  settled ${p.entryDate}: gross ${(gross * 100).toFixed(3)}% · net ${((gross - COST_DAILY) * 100).toFixed(3)}% (${L.length}L/${S.length}S)`);
    }
    state.pending = still;
  }

  // 2) form today's portfolio from the latest published z (entered at today's open)
  //
  // DEDUPE ON THE SOURCE FILE, NOT THE CALENDAR. /api/svr-z walks back from d=1, so a run on a
  // non-session day resolves to the SAME published file as the previous session's run — identical
  // z, identical ranking, identical portfolio, and both settle over the identical open→open window.
  // That logs one observation twice, which drags SD down while pinning the mean and inflates t —
  // manufacturing the exact result the persistence bar looks for. Found live 2026-07-27: a Saturday
  // (07-25) and Monday (07-27) portfolio, both off Friday 07-24's file, 43/43 identical on both legs.
  // A weekday guard would NOT catch this: on a Monday market holiday the loop skips Sun/Sat and
  // lands on Friday's file again, and a weekday test passes it straight through. The file key is
  // the only correct dedupe key. Fails CLOSED — no asOf means no portfolio, since a duplicate that
  // reaches the record is far more expensive than a missed day.
  const today = todayET();
  if (!state.pending.some(p => p.entryDate === today) && !state.days.some(d => d.date === today)) {
    const zs = {};
    let srcAsOf = null;
    for (let i = 0; i < UNIVERSE.length; i += 110) {
      const r = await fetch(`http://localhost:3001/api/svr-z?symbols=${encodeURIComponent(UNIVERSE.slice(i, i + 110).join(","))}`);
      if (r.ok) { const j = await r.json(); if (j.asOf) srcAsOf = j.asOf; const d = j.data || {}; for (const s in d) if (Number.isFinite(d[s]?.z)) zs[s] = d[s].z; }
    }
    const ranked = Object.entries(zs).sort((a, b) => a[1] - b[1]);
    const dupe = srcAsOf && (state.pending.some(p => p.srcAsOf === srcAsOf) || state.days.some(d => d.srcAsOf === srcAsOf));
    if (!srcAsOf) {
      console.log(`  no asOf from /api/svr-z — refused to form (cannot verify the source file is new; restart the backend to pick up the asOf field)`);
    } else if (dupe) {
      console.log(`  source file ${srcAsOf} already used by an existing record — no portfolio formed (non-session repeat, working as intended)`);
    } else if (ranked.length >= 100) {
      const q = Math.floor(ranked.length / 5);
      state.pending.push({ formed: today, entryDate: today, srcAsOf, longs: ranked.slice(0, q).map(x => x[0]), shorts: ranked.slice(-q).map(x => x[0]) });
      console.log(`  formed ${today} from file ${srcAsOf}: ${ranked.length} names ranked · ${q} long (low z) / ${q} short (high z) · settles next session`);
    } else console.log(`  only ${ranked.length} names with z — skipped today (coverage too thin)`);
  }

  // 3) the running record
  const g = state.days.map(d => d.gross), n = state.days.map(d => d.net);
  if (g.length) {
    console.log(`\n  FORWARD RECORD: ${g.length} days · gross ${(mean(g) * 100).toFixed(3)}%/day (t ${tOf(g).toFixed(2)}, ann ${(mean(g) * 252 * 100).toFixed(1)}%) · net ${(mean(n) * 100).toFixed(3)}%/day (ann ${(mean(n) * 252 * 100).toFixed(1)}%)`);
    console.log(`  backtest reference: +0.0529%/day gross (ann +13.3%), t 3.32 · persistence bar: gross stays positive, t grows`);
  } else console.log(`\n  no settled days yet — first spread settles next session.`);
  console.log(`  cost model (locks the strategy, unchanged): ${(COST_DAILY * 100).toFixed(2)}%/day — the tracker exists to test PERSISTENCE, not to trade.\n`);
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
