#!/usr/bin/env node
/**
 * R8 EARNINGS SHADOW — freeze before the print, settle after it, trade nothing.
 *
 * ORIGIN (2026-07-30): "our system should have caught MSFT +16%, META -9%, NOW -5% before it
 * happened." Split into the two claims that are actually testable (registered as R8):
 *
 *   R8a DIRECTION — do newsScore / mom20 / svrZ predict the SIGN of a gap? Registered prior:
 *       all three fail. The point of running it anyway is that a clean NULL at n>=60 retires
 *       the "we should have caught it" conversation permanently, with data.
 *   R8b PEAD — after a |>=5%| gap, does price keep drifting in the gap's direction? The only
 *       version of "catching MSFT" that needs no precognition: the information exists first.
 *
 * DISCIPLINE:
 *   - Freezes happen ONLY before the print. A print discovered at settle time with no freeze
 *     row is logged MISSED and stays missed — backfilling would peek.
 *   - Gaps settle close-to-close spanning the print (amc vs bmo), market-relative vs SPY.
 *   - Everything clusters by PRINT DATE: twenty mega-caps on one earnings night share one
 *     macro tape and count as ONE observation.
 *
 * Wired into daily-close.bat. State: backend/data/r8-earnings-shadow.json.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const STATE = D("r8-earnings-shadow.json");
const BARS_URL = "http://localhost:3001/api/equities/bars";
const EARN_URL = "http://localhost:3001/api/finnhub/earnings?days=4";
const EVIDENCE_START = "2026-07-31";
const PEAD_TRIGGER = 5.0;                       // |raw gap| %, fixed in the registration
const PEAD_H = [1, 5, 20];

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const tOf = a => a.length >= 3 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null;

async function j(url, opts) { const r = await fetch(url, { signal: AbortSignal.timeout(90000), ...opts }); if (!r.ok) throw new Error(`${url.split("?")[0]} → ${r.status}`); return r.json(); }
async function fetchCloses(symbols, days) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 50) {
    const d = (await j(BARS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: symbols.slice(i, i + 50), days }) })).data || {};
    for (const s in d) { const m = {}; for (const b of (d[s] || [])) if (Number.isFinite(b.c) && b.t) m[b.t] = b.c; if (Object.keys(m).length) out[s] = m; }
  }
  return out;
}

(async () => {
  console.log(`\n  R8 EARNINGS SHADOW — freeze pre-print, settle post-print (nothing trades)\n`);
  let st = { spec: "r8-v1", freezes: {}, missed: [], settledGaps: {}, pead: {} };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE, "utf8")) }; } catch { }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  // CONTAMINATION SWEEP (one-time effect, idempotent): tag any existing freeze taken AFTER its
  // print had already landed. The first batch froze AMZN at 9 PM ET for its 4:30 PM same-day
  // report. Tagged rows stay in the file (deleting evidence of a mistake is how mistakes
  // recur) but are excluded from settling, PEAD enrolment, and every grade.
  for (const [k, f] of Object.entries(st.freezes)) {
    if (f.contaminated != null) continue;
    const frozen = new Date(new Date(f.frozenAt).toLocaleString("en-US", { timeZone: "America/New_York" }));
    const fDay = new Date(f.frozenAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const mins = frozen.getHours() * 60 + frozen.getMinutes();
    const amc = String(f.hour).toLowerCase().includes("amc");
    f.contaminated = fDay > f.printDate || (fDay === f.printDate && (amc ? mins >= 955 : mins >= 360));
    if (f.contaminated) console.log(`  ⚠ contaminated freeze quarantined: ${k} (frozen ${amc ? "after the amc release" : "after the bmo window"} on print day)`);
  }

  // ── 1. FREEZE — names printing in the next 2 calendar days ────────────────
  const lite = (() => { try { return JSON.parse(fs.readFileSync(D("market-lite-scan.json"), "utf8")); } catch { return null; } })();
  const liteBySym = {}; for (const r of (lite?.rows || [])) liteBySym[r.sym] = r;
  let calendar = {};
  try { calendar = (await j(EARN_URL)).data || {}; }
  catch (e) { console.warn(`  earnings calendar unavailable (${e.message}) — no new freezes tonight; settling continues`); }
  const horizon = new Date(Date.now() + 2 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  /**
   * HOUR-AWARE FREEZE GUARD (2026-07-31). The first freeze batch ran at ~9 PM ET and froze
   * AMZN "pre-print" for its 4:30 PM SAME-DAY amc report — a freeze taken hours AFTER the
   * news, whose newsScore already contained the +15% headlines. Found when the operator asked
   * why we didn't catch AMZN: the honest answer required checking the timestamp, and the
   * timestamp failed. A print is freezable only while its release is still in the future:
   *   amc → before 15:55 ET on print day;  bmo/unknown → before 06:00 ET on print day
   * (conservative: bmo releases run 6-8 AM; unknown hour is treated as the earliest case).
   */
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const stillFuture = (e) => {
    if (e.date > today) return true;
    if (e.date < today) return false;
    const mins = nowET.getHours() * 60 + nowET.getMinutes();
    return String(e.hour).toLowerCase().includes("amc") ? mins < 955 : mins < 360;
  };
  // COVERAGE FIX (2026-07-31): the net was calendar ∩ lite-universe, and RDDT — a $25B name
  // that dropped 22% on its print — was in the calendar but not in lite, so it was never
  // frozen at all. The CALENDAR is the universe now; lite is just an observer source (names
  // without a lite row freeze with null news/svrZ, and mom20 still comes from real bars).
  // This is a coverage widening, not a threshold change — R8's bars are untouched.
  const upcoming = Object.entries(calendar).filter(([s, e]) => e.date >= today && e.date <= horizon && stillFuture(e));
  // R9b inputs — computed once per run from already-settled CLEAN gaps: the cycle's recent
  // tone, and any mega-cap blowout in the last 3 print dates (MSFT Wednesday → AMZN Thursday).
  const MEGA = new Set(["SPY","QQQ","IWM","DIA","AAPL","MSFT","NVDA","TSLA","AMD","META","AMZN","GOOGL","NFLX","AVGO","JPM","BAC","XOM","COST","CRM","ORCL","INTC","PLTR","COIN","SMCI","MU"]);
  const cleanGaps = Object.values(st.settledGaps || {}).filter(g => !g.missed);
  const recentDates = [...new Set(cleanGaps.map(g => g.printDate))].sort().slice(-3);
  const recentGaps = cleanGaps.filter(g => recentDates.includes(g.printDate));
  const peerSignal = recentGaps.length ? +mean(recentGaps.map(g => g.relGap)).toFixed(2) : null;
  const megaHits = recentGaps.filter(g => MEGA.has(g.sym) && Math.abs(g.relGap) >= 5);
  const megaPeer = megaHits.length ? Math.sign(mean(megaHits.map(g => g.relGap))) : 0;

  // R9a input + SLEEVE LEGS — the ATM call and put from the chain-pick endpoint, which carries
  // real OCC symbols and live bid/ask. One source feeds both: implied move (mid straddle /
  // spot) and, when both legs quote <=4%/side, the paper-sleeve entry AT THE ASKS. Null on any
  // doubt; a noisy implied is stamped, a guessed one never is.
  async function atmStraddle(sym) {
    try {
      const spotJ = await j(`http://localhost:3001/api/equities/snapshot?symbols=${sym}`);
      const spot = (spotJ.quotes || spotJ)[sym]?.price;
      if (!(spot > 0)) return null;
      /*
        nearest=1 IS REQUIRED HERE AND WAS MISSING (fixed 2026-08-26).

        R9's registered rule says "impliedMovePct — NEAREST-EXPIRY ATM straddle". These two calls
        omitted the dte parameter, so option-chain-pick silently applied its own 35-day default and
        returned a ~35-DTE straddle. R9 was therefore measuring a five-week implied move against a
        ONE-SESSION realised gap (the |raw gap| at settle, below) and reporting realized-minus-implied
        of -8.99pp at a day-clustered t of -8.52 — the largest t in the registry, produced entirely by
        the units not matching. The adjudicator caught it and flagged "the negative sign is mechanical;
        do not route it to the VRP seller sleeve", which matters because R9's own rule says a negative
        result IS the seller's edge and routes there.

        This is a BUG FIX, not an amendment: the code is being brought into line with the rule as
        registered, not the rule changed to fit the code. Evidence collected before this fix measured
        a different quantity and is disclosed as such on the R9 entry.
      */
      const c = (await j(`http://localhost:3001/api/option-chain-pick?symbol=${encodeURIComponent(sym)}&dir=1&nearest=1`)).atm;
      const pt = (await j(`http://localhost:3001/api/option-chain-pick?symbol=${encodeURIComponent(sym)}&dir=-1&nearest=1`)).atm;
      if (!(c?.bid > 0 && c?.ask > 0 && pt?.bid > 0 && pt?.ask > 0)) return null;
      const pct = +((((c.bid + c.ask) / 2 + (pt.bid + pt.ask) / 2) / spot) * 100).toFixed(2);
      return { pct, call: c, put: pt, spot };
    } catch { return null; }
  }

  if (upcoming.length) {
    const closes = await fetchCloses(upcoming.map(([s]) => s), 30);
    let froze = 0, ivN = 0;
    for (const [sym, e] of upcoming) {
      const key = `${sym}@${e.date}`;
      if (st.freezes[key]) continue;                     // sealed — one freeze per print, first wins
      const m = closes[sym]; const ds = m ? Object.keys(m).sort() : [];
      const mom20 = ds.length >= 21 ? +((m[ds[ds.length - 1]] / m[ds[ds.length - 21]] - 1) * 100).toFixed(2) : null;
      const row = liteBySym[sym] || {};                  // no lite row → null observers, never a skip
      // implied move only where a usable chain plausibly exists (MEGA + lite names) — on
      // cluster nights the calendar can be 300+ names and pacing every chain would run hours
      let straddle = null;
      if (MEGA.has(sym) || liteBySym[sym]) {
        straddle = await atmStraddle(sym);               // R9a implied + sleeve legs
        if (straddle) ivN++;
        await new Promise(r => setTimeout(r, 1200));     // pace the chain endpoint
      }
      st.freezes[key] = {
        sym, printDate: e.date, hour: e.hour || "", frozenAt: new Date().toISOString(), contaminated: false,
        obs: { newsScore: row.news?.score ?? null, svrZ: row.svrZ ?? null, mom20,
               impliedMovePct: straddle ? straddle.pct : null, peerSignal, megaPeer },   // R9 freeze fields — sealed with the rest
      };
      froze++;
      // R9a PAPER SLEEVE — mechanical entry per the registered rules: both legs <=4%/side or
      // the event is SKIPPED AND COUNTED (a silent skip and a policy skip must never look alike)
      st.straddles = st.straddles || {};
      if (straddle && !st.straddles[key]) {
        const worst = Math.max(straddle.call.spreadPct ?? 99, straddle.put.spreadPct ?? 99);
        if (worst <= 4.0) {
          st.straddles[key] = {
            sym, printDate: e.date, enrolledAt: new Date().toISOString(),
            callOcc: straddle.call.occ, putOcc: straddle.put.occ,
            entryAsk: +(straddle.call.ask + straddle.put.ask).toFixed(2),   // bought at the ASKS — bankable
            impliedPct: straddle.pct, spot: straddle.spot, closed: false,
          };
          console.log(`  [sleeve] straddle bought (paper): ${sym} @ $${(straddle.call.ask + straddle.put.ask).toFixed(2)} (implied ${straddle.pct}%)`);
        } else {
          (st.sleeveSkipped = st.sleeveSkipped || []).push({ sym, printDate: e.date, worst: +worst.toFixed(1) });
          console.log(`  [sleeve] ${sym} skipped — leg spread ${worst.toFixed(1)}%/side over the 4% policy`);
        }
      }
    }
    console.log(`  froze ${froze} new pre-print rows (${upcoming.length} upcoming · implied move on ${ivN} · peerSignal ${peerSignal ?? "—"} · megaPeer ${megaPeer})`);
  } else console.log(`  no upcoming prints in the 2-day window intersect the lite universe`);

  // ── 2. SETTLE GAPS — prints whose spanning closes now exist ───────────────
  const pending = Object.values(st.freezes).filter(f => !f.contaminated && f.printDate >= EVIDENCE_START && !st.settledGaps[`${f.sym}@${f.printDate}`] && f.printDate <= today);
  const peadOpen = Object.values(st.pead).filter(p => !p.complete);
  const needSyms = [...new Set(["SPY", ...pending.map(f => f.sym), ...peadOpen.map(p => p.sym)])];
  if (pending.length || peadOpen.length) {
    const closes = await fetchCloses(needSyms, 70);
    const spyD = Object.keys(closes.SPY || {}).sort();
    if (!spyD.length) { console.error("  ABORT — no SPY calendar; settling nothing."); process.exit(1); }
    const span = (printDate, hour) => {
      // amc: report-day close → next trading close. bmo (or unknown): prior close → report-day close.
      const i = spyD.indexOf(printDate);
      if (String(hour).toLowerCase().includes("amc")) return i >= 0 && spyD[i + 1] ? [printDate, spyD[i + 1]] : null;
      if (i >= 0) return i > 0 ? [spyD[i - 1], printDate] : null;
      // print date wasn't a trading day (rare): bracket it
      const after = spyD.find(d => d > printDate), before = [...spyD].reverse().find(d => d < printDate);
      return after && before ? [before, after] : null;
    };
    for (const f of pending) {
      const sp = span(f.printDate, f.hour);
      if (!sp) continue;                                  // spanning close not landed yet
      const [d0, d1] = sp;
      const m = closes[f.sym];
      if (!(m && m[d0] > 0 && m[d1] > 0 && closes.SPY[d0] > 0 && closes.SPY[d1] > 0)) {
        if (d1 < today) { st.missed.push({ ...f, why: "no bars across the print" }); st.settledGaps[`${f.sym}@${f.printDate}`] = { missed: true }; }
        continue;
      }
      const raw = (m[d1] / m[d0] - 1) * 100;
      const rel = raw - (closes.SPY[d1] / closes.SPY[d0] - 1) * 100;
      st.settledGaps[`${f.sym}@${f.printDate}`] = { sym: f.sym, printDate: f.printDate, window: [d0, d1], rawGap: +raw.toFixed(2), relGap: +rel.toFixed(2), obs: f.obs, settledAt: new Date().toISOString() };
      console.log(`  gap settled ${f.sym}@${f.printDate}: raw ${raw >= 0 ? "+" : ""}${raw.toFixed(1)}% rel ${rel >= 0 ? "+" : ""}${rel.toFixed(1)}%`);
      if (Math.abs(raw) >= PEAD_TRIGGER) {
        st.pead[`${f.sym}@${f.printDate}`] = { sym: f.sym, printDate: f.printDate, gapSign: Math.sign(raw), baseDate: d1, drift: {}, complete: false };
        console.log(`    → PEAD cohort (|gap| >= ${PEAD_TRIGGER}%)`);
      }
    }
    // ── 3. SETTLE PEAD DRIFT ────────────────────────────────────────────────
    for (const p of Object.values(st.pead)) {
      if (p.complete) continue;
      const bi = spyD.indexOf(p.baseDate);
      if (bi < 0) continue;
      const m = closes[p.sym]; if (!m) continue;
      for (const h of PEAD_H) {
        if (p.drift["h" + h] != null) continue;
        const dx = spyD[bi + h]; if (!dx) continue;
        if (!(m[p.baseDate] > 0 && m[dx] > 0 && closes.SPY[p.baseDate] > 0 && closes.SPY[dx] > 0)) continue;
        const ret = (m[dx] / m[p.baseDate] - 1) * 100, spy = (closes.SPY[dx] / closes.SPY[p.baseDate] - 1) * 100;
        p.drift["h" + h] = +(p.gapSign * (ret - spy)).toFixed(3);     // gap-signed, market-relative
      }
      p.complete = p.drift.h20 != null;
    }
  } else console.log(`  nothing to settle yet`);

  // ── 3b. SETTLE THE STRADDLE SLEEVE — sell at the BIDS, first run after the print ──────────
  const openStraddles = Object.values(st.straddles || {}).filter(s => !s.closed && !s.unresolved && today > s.printDate);
  if (openStraddles.length) {
    const legs = openStraddles.flatMap(s => [s.callOcc, s.putOcc]);
    const qmap = {};
    for (let i = 0; i < legs.length; i += 40) {
      try {
        const q = await j(`http://localhost:3001/api/option-quotes?symbols=${legs.slice(i, i + 40).join(",")}`);
        Object.assign(qmap, q.data || q.quotes || {});
      } catch (e) { console.warn(`  [sleeve] quote batch failed: ${e.message}`); }
    }
    for (const s of openStraddles) {
      const c = qmap[s.callOcc], pt = qmap[s.putOcc];
      const cb = c ? (c.bid ?? c.bp) : null, pb = pt ? (pt.bid ?? pt.bp) : null;
      if (cb > 0 && pb > 0) {
        const exitBid = +(cb + pb).toFixed(2);
        s.closed = true; s.exitBid = exitBid; s.closedAt = new Date().toISOString();
        s.netUsd = +(((exitBid - s.entryAsk) * 100) - 2.60).toFixed(2);   // 2 legs in + 2 out at $0.65
        s.netPct = +((s.netUsd / (s.entryAsk * 100)) * 100).toFixed(1);
        console.log(`  [sleeve] straddle sold (paper): ${s.sym} $${s.entryAsk}→$${exitBid} · net ${s.netUsd >= 0 ? "+" : ""}$${s.netUsd} (${s.netPct}%)`);
      } else if (new Date(today) - new Date(s.printDate) > 7 * 86400000) {
        s.unresolved = true;                              // legs stopped quoting — counted, never guessed
        console.warn(`  [sleeve] ${s.sym}@${s.printDate} UNRESOLVED — no leg quotes within 7 days`);
      }
    }
  }

  // ── 4. GRADE — clustered by print date, exactly as registered ─────────────
  const gaps = Object.values(st.settledGaps).filter(g => !g.missed);
  const byDate = {}; for (const g of gaps) (byDate[g.printDate] ||= []).push(g);
  const dirGrade = {};
  for (const ob of ["newsScore", "mom20", "svrZ"]) {
    const dayHits = Object.values(byDate).map(rows => {
      const scored = rows.filter(g => Number.isFinite(g.obs[ob]) && g.obs[ob] !== 0 && g.relGap !== 0);
      return scored.length ? mean(scored.map(g => Math.sign(g.obs[ob]) === Math.sign(g.relGap) ? 1 : 0)) : null;
    }).filter(v => v != null);
    const t = dayHits.length >= 3 ? tOf(dayHits.map(v => v - 0.5)) : null;
    dirGrade[ob] = { printDates: dayHits.length, prints: gaps.filter(g => Number.isFinite(g.obs[ob])).length, hitRate: dayHits.length ? +(100 * mean(dayHits)).toFixed(1) : null, tVs50: t == null ? null : +t.toFixed(2) };
  }
  const peadGrade = {};
  for (const h of PEAD_H) {
    const byD = {}; for (const p of Object.values(st.pead)) if (p.drift["h" + h] != null) (byD[p.printDate] ||= []).push(p.drift["h" + h]);
    const dm = Object.values(byD).map(mean);
    peadGrade["h" + h] = { printDates: dm.length, gaps: Object.values(st.pead).filter(p => p.drift["h" + h] != null).length, meanDrift: dm.length ? +mean(dm).toFixed(3) : null, t: tOf(dm) == null ? null : +tOf(dm).toFixed(2) };
  }
  // ── R9 GRADES — the capture hypotheses, from the same settled gaps ────────
  // R9a: realized |move| minus the straddle-implied move, day-clustered.
  // EXCLUDES rows tagged voidForEvidence (2026-08-31 repair): 101 legacy prints frozen before
  // the 2026-08-26 nearest-expiry fix priced a ~35-DTE straddle, not the registered nearest-
  // expiry ATM straddle, and must never be pooled with post-fix freezes — a units error, not
  // evidence. See the dated explanation on each voided settledGaps row.
  const ivGaps = gaps.filter(g => Number.isFinite(g.obs?.impliedMovePct) && !g.voidForEvidence);
  const ivByDate = {}; for (const g of ivGaps) (ivByDate[g.printDate] ||= []).push(Math.abs(g.rawGap) - g.obs.impliedMovePct);
  const ivDm = Object.values(ivByDate).map(mean);
  const r9a = { prints: ivGaps.length, printDates: ivDm.length,
    meanExcess: ivDm.length ? +mean(ivDm).toFixed(2) : null,
    t: tOf(ivDm) == null ? null : +tOf(ivDm).toFixed(2) };
  // R9b: does the peer/cluster sign predict the gap sign? Only prints where a signal existed.
  const pGaps = gaps.filter(g => g.relGap !== 0 && (g.obs?.megaPeer === 1 || g.obs?.megaPeer === -1 || Math.abs(g.obs?.peerSignal ?? 0) > 0.5));
  const pByDate = {}; for (const g of pGaps) {
    const sig = (g.obs.megaPeer === 1 || g.obs.megaPeer === -1) ? g.obs.megaPeer : Math.sign(g.obs.peerSignal);
    (pByDate[g.printDate] ||= []).push(sig === Math.sign(g.relGap) ? 1 : 0);
  }
  const pDm = Object.values(pByDate).map(mean);
  const r9b = { predicted: pGaps.length, printDates: pDm.length,
    hitRate: pDm.length ? +(100 * mean(pDm)).toFixed(1) : null,
    tVs50: pDm.length >= 3 ? (tOf(pDm.map(v => v - 0.5)) == null ? null : +tOf(pDm.map(v => v - 0.5)).toFixed(2)) : null };

  st.report = {
    gradedAt: new Date().toISOString(),
    r8a: { grade: dirGrade, bar: "Šidák |t|>=2.39 at >=60 prints — registered prediction: all three FAIL", prints: gaps.length },
    r8b: { grade: peadGrade, bar: "+5d PRIMARY t>=2.0 at >=30 gaps across >=10 print dates", cohort: Object.keys(st.pead).length },
    r9a: { ...r9a, bar: "day-clustered t>=2.0 at >=40 prints; NEGATIVE excess routes to the gated VRP seller sleeve instead" },
    r9b: { ...r9b, bar: "hit rate vs 50%, day-clustered t>=2.0 at >=40 predicted prints" },
    missed: st.missed.length,
    quarantined: Object.values(st.freezes).filter(f => f.contaminated).length,
  };
  fs.writeFileSync(STATE, JSON.stringify(st));

  console.log(`\n  R8a DIRECTION (${gaps.length} settled prints, missed ${st.missed.length}):`);
  for (const [k, v] of Object.entries(dirGrade)) console.log(`    ${k.padEnd(10)} hit ${v.hitRate == null ? "—" : v.hitRate + "%"} vs 50 · t ${v.tVs50 ?? "—"} · ${v.printDates} print dates`);
  console.log(`  R8b PEAD (${Object.keys(st.pead).length} gaps in cohort):`);
  for (const h of PEAD_H) { const v = peadGrade["h" + h]; console.log(`    +${String(h).padEnd(2)}d drift ${v.meanDrift == null ? "—" : (v.meanDrift >= 0 ? "+" : "") + v.meanDrift + "%"} · t ${v.t ?? "—"} · ${v.gaps} gaps / ${v.printDates} dates`); }
  console.log(`  R9a EVENT-VOL: realized−implied ${r9a.meanExcess == null ? "—" : (r9a.meanExcess >= 0 ? "+" : "") + r9a.meanExcess + "pp"} · t ${r9a.t ?? "—"} · ${r9a.prints} prints with implied frozen`);
  console.log(`  R9b PEER READ-THROUGH: hit ${r9b.hitRate == null ? "—" : r9b.hitRate + "%"} vs 50 · t ${r9b.tVs50 ?? "—"} · ${r9b.predicted} predicted prints`);
  const slAll = Object.values(st.straddles || {});
  const slClosed = slAll.filter(s => s.closed);
  st.report.r9sleeve = { open: slAll.filter(s => !s.closed && !s.unresolved).length, closed: slClosed.length,
    netUsd: +slClosed.reduce((a, s) => a + s.netUsd, 0).toFixed(2),
    avgPct: slClosed.length ? +mean(slClosed.map(s => s.netPct)).toFixed(1) : null,
    unresolved: slAll.filter(s => s.unresolved).length, skipped: (st.sleeveSkipped || []).length };
  const sv = st.report.r9sleeve;
  console.log(`  R9a SLEEVE (paper, 1 contract/event): ${sv.open} open · ${sv.closed} closed · net ${sv.netUsd >= 0 ? "+" : ""}$${sv.netUsd}${sv.avgPct == null ? "" : " (avg " + sv.avgPct + "%)"} · ${sv.skipped} skipped on spread policy · ${sv.unresolved} unresolved`);
  fs.writeFileSync(STATE, JSON.stringify(st));
})().catch(e => { console.error("  R8 shadow failed:", e.message); process.exit(1); });
