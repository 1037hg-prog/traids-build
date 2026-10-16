#!/usr/bin/env node
/**
 * R22 — "TICKERS WITH POTENTIAL TO BLOW UP" (operator's name, 2026-08-12).
 * Rising companies in rising sectors. Pre-registered, picks recorded before outcomes exist,
 * graded against THREE bars. Logged, never traded.
 *
 * A NOTE ON THE NAME, kept because it is accurate in both directions. In this business "blow up"
 * ordinarily means the opposite of what is intended here — and these picks are, by construction,
 * exactly the names that can do either. The screen selects the most extended relative strength
 * inside the most extended sectors; the first pick today carries +113pp of 60-day outperformance
 * against its own sector. That is the population with the fattest upside tail AND the fattest
 * downside one, because momentum names do not mean-revert gently. Whichever way they blow, this
 * file records the call first and grades it after.
 *
 * THE PRIOR, stated up front because it is unflattering: the strategy lab already tested plain
 * cross-sectional momentum and it came back OUT-OF-SAMPLE at Sharpe -0.69 / -22.0% — one of the
 * 22 candidates that died. This is not that test. That one ranked the whole market at once; this
 * one conditions on SECTOR first and then selects within the leaders, which is a genuinely
 * different question and gets its own bar rather than inheriting a verdict.
 *
 * ═══ THE DESIGN ═══
 *   stage 1   rank the 11 sector ETFs by 60-day return relative to SPY; take the top 3
 *   stage 2   inside those sectors, rank member names by 60-day return RELATIVE TO THEIR OWN
 *             SECTOR ETF (not to SPY — otherwise "rising company" just re-measures the sector)
 *   picks     top 3 names per leading sector = 9 per session
 *   horizons  +5 and +20 trading days, both fixed here, neither shopped later
 *
 * ═══ THE THREE BARS, and why one screener beats none ═══
 * "Rising companies in rising sectors go up" is nearly unfalsifiable in a rising market. So the
 * picks are graded against three references, and the interesting one is not SPY:
 *
 *   1. SPY              the market. Weakest bar; clearing it may be nothing but sector beta.
 *   2. THE SECTOR ETF   if you liked Technology you could simply buy XLK. Beating XLK is the
 *                       only way stage 2 earns its existence — otherwise the honest advice is
 *                       "buy the sector", which needs no screener at all.
 *   3. SAME-SECTOR RANDOM CONTROL   9 names drawn from the SAME leading sectors on the SAME day,
 *                       deterministically by date so any reviewer can reproduce the draw. This
 *                       is the sharpest bar: it holds sector exposure constant and asks whether
 *                       RANKING added anything over picking blind inside the right sectors.
 *
 * A strategy that beats SPY, ties the sector ETF and ties its own random control has discovered
 * that sectors trend — which is free — and nothing else.
 *
 * ═══ THE READ, registered now ═══
 * No verdict before 30 distinct signal dates with elapsed +20d windows. Statistics are clustered
 * by DATE, because nine picks drawn on one morning share that morning's tape and are not nine
 * independent observations. PASS requires beating the same-sector control with a day-clustered
 * t >= 2 at either horizon; beating only SPY is explicitly NOT a pass and will be labelled beta.
 *
 * Usage: node backend/sector-momentum.js              → record today's picks, grade what has elapsed
 *        node backend/sector-momentum.js --grade-only → grade only, record nothing
 *        node backend/sector-momentum.js --selftest   → the pure forward-return checks below; no network, nothing written
 *
 * ═══ 2026-10-05 (health sweep FT-1) — A PICK WHOSE BARS END IS CASHED OUT, NOT A HOLE ═══
 * CRNX (last bar 2026-08-31) and APGE (last bar 2026-09-02) were acquired; their closes are pinned near the deal prices and then
 * stop. The grader required EVERY pick to have a +h return, so each of the 17 sessions that picked CRNX (08-12..09-03) could never
 * grade at the PRIMARY +20d horizon (0 of 30 graded as of 10-02), and 8 of them (08-25..09-03) were blocked at +5d as well. The
 * standard treatment, staged here as a dated amendment for the registry: a pick whose bars END (no bar for >= 5 market sessions
 * while SPY trades on) is cashed out at its LAST AVAILABLE CLOSE from that date onward — return to the horizon = last close / entry
 * close - 1 — once the MARKET has completed the horizon, flagged per pick (`cashedOut` on the recorded pick; every horizon's grade of
 * an ended name is persisted on the pick in `endedGrades[h]`, so it survives the bars endpoint dropping the name without a normal-path
 * +5d grade being restated — review round 2). A name whose bars had ALREADY ended before the pick date was never a live member
 * of that day's population (the screen ranked a stale series — CRNX picked 09-01..09-03; HOLX and CMA drawn as CONTROLS on 08-13 and
 * 08-14, months after their last bar): it is EXCLUDED from that session's mean and flagged `staleAtPick` — which is exactly what the
 * old grader already did to such controls, so no already-graded number moves. Picks and controls get the same two rules.
 * Nothing that already graded changes: both paths run only where the old path returned no return at all.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");   // 2026-10-05: the state file is written atomically (house rule)
const D = (f) => path.join(__dirname, "data", f);
const OUT = D("sector-momentum.json");
const API = process.env.TRAIDS_URL || "http://localhost:3001";

const SECTOR_ETFS = ["XLK", "XLF", "XLY", "XLI", "XLV", "XLB", "XLC", "XLU", "XLE", "XLRE", "XLP"];
const LOOKBACK = 60, TOP_SECTORS = 3, PER_SECTOR = 3, HORIZONS = [5, 20];
const READ_GATE_DATES = 30, MIN_BARS = 140;
const etDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const etHM = () => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
const post = (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(180000) }).then(r => r.ok ? r.json() : Promise.reject(new Error(`${u} ${r.status}`)));
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
/** Deterministic pick from a list, seeded by date+salt — reproducible by any reviewer. */
function seeded(list, n, seed) {
  let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const pool = [...list], out = [];
  while (out.length < n && pool.length) { h = (h * 1103515245 + 12345) >>> 0; out.push(pool.splice(h % pool.length, 1)[0]); }
  return out;
}

/**
 * forwardReturn(series, mkt, from, n) — the +n-session % return of one name from the pick date `from` (2026-10-05, FT-1).
 *   series  the name's completed daily bars [{ t: "YYYY-MM-DD", c }], ascending, on its OWN dates (the 2026-09-08 indexing fix)
 *   mkt     the market's completed session dates (SPY's axis, today's forming bar excluded)
 * Path 1 (unchanged): the name traded on `from` and has n more bars of its own -> close[i+n] / close[i] - 1.
 * Path 2 (CASH-OUT): only where path 1 has no answer, and only when the name's bars have ENDED — its last bar is >= ENDED_MIN market
 *   sessions old — AFTER the pick date, AND the market has completed the horizon (from + n on the market axis) after that last bar.
 *   Return = last close / entry close - 1 (entry = the close on `from`). Flagged { cashedOut: { lastBar, lastClose, entryBar, entryClose } }.
 * Path 3 (STALE AT PICK): the bars had ENDED before `from` — the name was not live on the pick date. { excluded: true, staleAtPick }.
 * Otherwise null: the window has not elapsed (or the name is merely halted/gapped — it waits, as before).
 */
const ENDED_MIN = 5;
function forwardReturn(series, mkt, from, n) {
  const a = series || [];
  const i = a.findIndex((x) => x.t >= from);
  if (i >= 0 && a[i].t === from && i + n < a.length) return { r: 100 * (a[i + n].c / a[i].c - 1) };
  if (!a.length) return null;
  const last = a[a.length - 1];
  const sessionsSinceLast = mkt.filter((d) => d > last.t).length;
  if (sessionsSinceLast < ENDED_MIN) return null;                           // not ended — a halt or a data gap waits
  if (last.t < from) return { excluded: true, staleAtPick: { lastBar: last.t, lastClose: last.c } };
  const mi = mkt.indexOf(from);
  if (mi < 0 || mi + n >= mkt.length) return null;                        // the market has not completed the horizon
  if (last.t >= mkt[mi + n]) return null;                                   // bars reach the horizon end: not a cash-out case
  if (!(i >= 0 && a[i].t === from) || !(a[i].c > 0)) return null;           // no entry close on the pick date — waits, as before
  return { r: 100 * (last.c / a[i].c - 1), cashedOut: { lastBar: last.t, lastClose: last.c, entryBar: a[i].t, entryClose: a[i].c } };
}

/**
 * nameReturnOf(p, s, mkt, from, h, today) — a recorded pick's / control's +h return with the cash-out rule, PERSISTED PER HORIZON.
 *   p  the recorded pick or control (mutated: stamps), s its completed bars (forwardReturn's `series`), mkt / from / h as above.
 * Once a name's bars have ENDED (last bar >= ENDED_MIN market sessions old, on or after the pick date), every +h return computed for
 * it — the normal path (bars covered the horizon) or the cash-out — is stored on the pick in `endedGrades[h]` the first time it is
 * computed, so a grade survives the bars endpoint later dropping the name. Review round 2 (2026-10-05): the first version reused the
 * ONE `cashedOut` stamp for every horizon, so once the endpoint dropped a name, a +5d return that had graded on the normal path
 * (CRNX 08-12..08-24, APGE 08-24) would have been silently restated to last close / entry close. If no stored grade exists (a stamp
 * from before this field), the stamp is applied only when the bars ended INSIDE that horizon (stamp.lastBar < mkt[from + h]).
 */
function nameReturnOf(p, s, mkt, from, h, today) {
  const f = forwardReturn(s, mkt, from, h);
  if (f && f.excluded) { if (!p.staleAtPick) p.staleAtPick = { ...f.staleAtPick, rule: "bars had ended before the pick date — not a live name that day; excluded from the session mean (amendment proposed 2026-10-05)", flaggedOn: today }; return { excluded: true }; }
  if (f) {
    if (f.cashedOut) p.cashedOut = { ...f.cashedOut, rule: `bars ended >= ${ENDED_MIN} market sessions before grading; cashed out at the last available close (amendment proposed 2026-10-05)`, flaggedOn: (p.cashedOut && p.cashedOut.flaggedOn) || today };
    const last = s.length ? s[s.length - 1] : null;
    const ended = last && last.t >= from && mkt.filter((d) => d > last.t).length >= ENDED_MIN;
    if (ended && !(p.endedGrades && p.endedGrades[h])) p.endedGrades = { ...(p.endedGrades || {}), [h]: { r: f.r, cashedOut: !!f.cashedOut, lastBar: last.t, gradedOn: today } };
    return { r: f.r, cashedOut: !!f.cashedOut };
  }
  if (s.length) return null;                                                   // bars present, window not complete — waits
  // the bars endpoint no longer returns the name at all: reuse what was stored when it was first seen to have ended
  if (p.staleAtPick) return { excluded: true };
  const g = p.endedGrades && p.endedGrades[h];
  if (g && Number.isFinite(g.r)) return { r: g.r, cashedOut: !!g.cashedOut };
  const stamp = p.cashedOut, mi = mkt.indexOf(from);
  if (stamp && mi >= 0 && mi + h < mkt.length && stamp.lastBar < mkt[mi + h] && stamp.entryClose > 0) return { r: 100 * (stamp.lastClose / stamp.entryClose - 1), cashedOut: true };
  return null;
}

if (process.argv.includes("--selftest")) {
  // Known answers for the cash-out rule — pure, no network, nothing written.
  const mkt = Array.from({ length: 40 }, (_, k) => `2026-08-${String(k + 1).padStart(2, "0")}`.replace(/-08-(3[2-9]|4\d)$/, (m, d) => `-09-${String(+d - 31).padStart(2, "0")}`));
  const bars = (from, to, f) => mkt.filter((d) => d >= from && d <= to).map((t, k) => ({ t, c: f(k) }));
  const alive = bars(mkt[0], mkt[39], (k) => 100 + k);
  const acquired = bars(mkt[0], mkt[14], (k) => (k < 10 ? 50 + k : 70));    // deal pins the close at 70 from the 11th bar, last bar mkt[14]
  const halted = bars(mkt[0], mkt[36], (k) => 10 + k);                       // last bar 3 sessions ago: halted, not ended
  const fr = (s, from, n) => forwardReturn(s, mkt, from, n);
  const checks = {
    normalPathUnchanged: Math.abs(fr(alive, mkt[2], 5).r - 100 * (107 / 102 - 1)) < 1e-9 && !fr(alive, mkt[2], 5).cashedOut,
    endedNameCashedOutAtLastClose: (() => { const x = fr(acquired, mkt[3], 20); return x && x.cashedOut && Math.abs(x.r - 100 * (70 / 53 - 1)) < 1e-9 && x.cashedOut.lastBar === mkt[14]; })(),
    endedNameStillNormalInsideItsBars: (() => { const x = fr(acquired, mkt[3], 5); return x && !x.cashedOut && Math.abs(x.r - 100 * (58 / 53 - 1)) < 1e-9; })(),
    pickAfterBarsEndedIsExcluded: (() => { const x = fr(acquired, mkt[16], 5); return x && x.excluded === true && x.staleAtPick.lastBar === mkt[14] && x.r === undefined; })(),
    horizonNotElapsedWaits: fr(acquired, mkt[3], 38) === null,
    haltedNameWaits: fr(halted, mkt[20], 18) === null,
    // review round 2: grades persist PER HORIZON — when the endpoint drops an ended name, a normal-path +5d grade is not restated
    gradesPersistPerHorizonWhenBarsVanish: (() => {
      const p = { sym: "ACQ" };
      const a5 = nameReturnOf(p, acquired, mkt, mkt[3], 5, "T1"), a20 = nameReturnOf(p, acquired, mkt, mkt[3], 20, "T1");
      const b5 = nameReturnOf(p, [], mkt, mkt[3], 5, "T2"), b20 = nameReturnOf(p, [], mkt, mkt[3], 20, "T2");
      const r5 = 100 * (58 / 53 - 1), r20 = 100 * (70 / 53 - 1);
      return a5 && !a5.cashedOut && Math.abs(a5.r - r5) < 1e-9 && a20 && a20.cashedOut && Math.abs(a20.r - r20) < 1e-9
        && b5 && !b5.cashedOut && Math.abs(b5.r - r5) < 1e-9 && b20 && b20.cashedOut && Math.abs(b20.r - r20) < 1e-9
        && p.endedGrades && p.endedGrades[5].gradedOn === "T1" && p.endedGrades[20].gradedOn === "T1";
    })(),
    legacyStampOnlyAppliesInsideItsHorizon: (() => {
      const p = { sym: "ACQ", cashedOut: { lastBar: mkt[14], lastClose: 70, entryBar: mkt[3], entryClose: 53 } };
      const b5 = nameReturnOf(p, [], mkt, mkt[3], 5, "T"), b20 = nameReturnOf(p, [], mkt, mkt[3], 20, "T");
      return b5 === null && b20 && b20.cashedOut && Math.abs(b20.r - 100 * (70 / 53 - 1)) < 1e-9;
    })(),
    liveNameStoresNothing: (() => { const p = { sym: "ALIVE" }; const x = nameReturnOf(p, alive, mkt, mkt[2], 5, "T"); return x && !x.cashedOut && !p.endedGrades && !p.cashedOut; })(),
  };
  const pass = Object.values(checks).every(Boolean);
  console.log(`R22 forward-return selftest ${pass ? "PASS" : "FAIL"} ${JSON.stringify(checks)}`);
  process.exit(pass ? 0 : 1);
}

(async () => {
  const today = etDay();
  const st = (() => { try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {
    return { spec: "R22-v1", registered: "2026-08-12", status: "LOGGED-NEVER-TRADED",
      design: `top ${TOP_SECTORS} sectors by ${LOOKBACK}d RS vs SPY, then top ${PER_SECTOR} names per sector by ${LOOKBACK}d RS vs their own sector ETF`,
      bars: "SPY (weak), the sector ETF (earns stage 2), and a same-sector random control (earns the ranking)",
      readGate: `${READ_GATE_DATES} dates with elapsed +20d windows; PASS needs to beat the SAME-SECTOR CONTROL at day-clustered t>=2. Beating only SPY is beta, not a pass.`,
      priorNote: "plain cross-sectional momentum already died in the lab at OOS Sharpe -0.69 / -22.0%; this conditions on sector first and is judged separately",
      sessions: [] };
  } })();

  // ── data ───────────────────────────────────────────────────────────────────────────────────
  const map = JSON.parse(fs.readFileSync(D("sector-map.json"), "utf8"));
  /**
   * UNIVERSE CAP (2026-08-21). The sector map grew from ~800 to ~3,000 mapped names on 08-20; sending
   * all of them to /api/equities/bars (1,200-symbol cap) sliced SPY off the end and the screen threw
   * "SPY returned 0 bars". SPY and the sector ETFs now lead the request, and each sector keeps its
   * 80 most liquid names (universe-expanded medDollarVol) — ~880 names, near the original roster.
   * Registered as a population change; picks before/after 08-21 are not pooled without saying so.
   */
  const liq = (() => { try { return Object.fromEntries(JSON.parse(fs.readFileSync(D("universe-expanded.json"), "utf8")).names.map(n => [n.sym, n.medDollarVol || 0])); } catch { return {}; } })();
  /**
   * DEFECT, found 2026-09-08 and fixed the same day: this constant was declared PER_SECTOR and SHADOWED the registered PER_SECTOR = 3
   * above, so from 08-21 every session recorded ALL 80 names of each leading sector as "picks" (240 a session) and 80 "controls". The
   * screen's real picks (top 3 by RS vs sector) were recoverable from the recorded lists because rsVsSector was stored per name; the
   * 08-21..09-08 sessions were repaired that way (raw lists kept under raw80). The liquidity cap is now its own name.
   */
  const SECTOR_CAP = 80;
  const bySector = {};
  for (const [sym, v] of Object.entries(map)) if (v?.etf && SECTOR_ETFS.includes(v.etf)) (bySector[v.etf] ||= []).push(sym);
  for (const etf of Object.keys(bySector)) bySector[etf] = bySector[etf].sort((a, b) => (liq[b] || 0) - (liq[a] || 0)).slice(0, SECTOR_CAP);
  // 2026-09-08: the grader needs bars for EVERY past pick and control, not just today's universe — a pick that dropped out of the top-80
  // liquidity list had no bars in the request, returned null, and blocked its session forever (the second reason nothing ever graded)
  const histSyms = (st.sessions || []).filter(x => !x.void).flatMap(x => [...(x.picks || []), ...(x.controls || [])].map(p => p.sym));
  const universe = [...new Set(["SPY", ...SECTOR_ETFS, ...Object.values(bySector).flat(), ...histSyms])];
  const data = (await post(`${API}/api/equities/bars`, { symbols: universe, days: 400 })).data || {};
  const C = (s) => (data[s] || []).map(b => b.c).filter(Number.isFinite);
  const dates = (data.SPY || []).map(b => b.t);
  if (dates.length < MIN_BARS) throw new Error(`SPY returned ${dates.length} bars, need ${MIN_BARS} — refusing to rank on a short series`);

  // Completed sessions only: mid-session the last bar is today's forming bar, and ranking on it
  // would let an intraday wiggle decide which sectors "lead". (Same guard as the other surfaces.)
  const drop = etHM() < "16:10" ? 1 : 0;
  const asOf = dates[dates.length - 1 - drop];
  const ret = (s, n) => { const c = C(s); const e = c.length - drop; return (e - 1 - n >= 0) ? 100 * (c[e - 1] / c[e - 1 - n] - 1) : null; };

  // ── stage 1: which sectors are rising, relative to the market ──────────────────────────────
  const spyRet = ret("SPY", LOOKBACK);
  const sectorRS = SECTOR_ETFS.map(e => ({ etf: e, rs: ret(e, LOOKBACK) == null ? null : ret(e, LOOKBACK) - spyRet }))
    .filter(x => x.rs != null).sort((a, b) => b.rs - a.rs);
  const leaders = sectorRS.slice(0, TOP_SECTORS);

  // ── stage 2: which names are rising relative to their OWN sector ───────────────────────────
  const picks = [], controlPool = [];
  for (const L of leaders) {
    const etfRet = ret(L.etf, LOOKBACK);
    const members = (bySector[L.etf] || []).filter(s => C(s).length >= MIN_BARS);
    const ranked = members.map(s => ({ sym: s, rs: ret(s, LOOKBACK) == null ? null : ret(s, LOOKBACK) - etfRet }))
      .filter(x => x.rs != null).sort((a, b) => b.rs - a.rs);
    for (const r of ranked.slice(0, PER_SECTOR)) picks.push({ sym: r.sym, etf: L.etf, rsVsSector: +r.rs.toFixed(2), sectorRsVsSpy: +L.rs.toFixed(2) });
    controlPool.push({ etf: L.etf, members: ranked.map(r => r.sym) });
  }
  // same-sector control: the SAME count per sector, drawn deterministically from the same pool
  const controls = controlPool.flatMap(p => seeded(p.members, PER_SECTOR, `${today}|${p.etf}`).map(s => ({ sym: s, etf: p.etf })));

  const THEME = new Set(["BE", "VST", "CEG", "GEV", "TLN", "NVDA", "AVGO", "AMD", "TSM", "MU", "LRCX", "AMAT", "KLAC", "VRT", "ETN", "PWR", "DLR", "EQIX", "SMCI"]);   // #83 AI-infrastructure list (2026-09-08); a TAG, not a filter
  const px = (s) => { const c = C(s); return c[c.length - 1 - drop]; };
  const GRADE_ONLY = process.argv.includes("--grade-only");
  if (GRADE_ONLY) console.log(`R22 — grade-only pass (nothing recorded). Bars through ${asOf}.`);
  else if (!st.sessions.some(x => x.date === today)) {
    st.sessions.push({ date: today, asOf, recordedAt: new Date().toISOString(),
      leaders: leaders.map(l => ({ etf: l.etf, rsVsSpy: +l.rs.toFixed(2) })),
      picks: picks.map(p => ({ ...p, entry: px(p.sym), ...(THEME.has(p.sym) ? { theme: "ai-infra" } : {}) })),
      controls: controls.map(c => ({ ...c, entry: px(c.sym), ...(THEME.has(c.sym) ? { theme: "ai-infra" } : {}) })),
      bench: { SPY: px("SPY"), ...Object.fromEntries(leaders.map(l => [l.etf, px(l.etf)])) } });
    console.log(`R22 · TICKERS WITH POTENTIAL TO BLOW UP — ${today} (bars through ${asOf})`);
    console.log(`  leading sectors: ${leaders.map(l => `${l.etf} ${l.rs >= 0 ? "+" : ""}${l.rs.toFixed(1)}pp vs SPY`).join(", ")}`);
    for (const p of picks) console.log(`   pick ${p.sym.padEnd(6)} ${p.etf}  RS vs sector ${p.rsVsSector >= 0 ? "+" : ""}${p.rsVsSector}pp`);
  } else console.log(`R22 — ${today} already recorded (idempotent). Bars through ${asOf}.`);

  // ── grade every session whose horizon has elapsed ───────────────────────────────────────────
  /**
   * DEFECT, found 2026-09-08 and fixed the same day: fwd() looked the entry date up on SPY's date axis and then indexed the SYMBOL's
   * close array with that position. Any name with a shorter history than SPY (most of them: the bars endpoint returns 200 bars for many
   * names and 549 for SPY) pointed past the end of its own array, returned null, and blocked its whole session with "window not fully
   * elapsed" — forever. Twenty sessions, zero graded. Each symbol is now indexed on its OWN dates.
   */
  // 2026-10-05: completed bars only, here too — a mid-session run must not grade a horizon on today's forming bar (the chain runs
  // after the close, where this changes nothing).
  const formingDay = drop ? today : null;
  const series = (sym) => (data[sym] || []).filter(b => Number.isFinite(b.c)).map(b => ({ t: String(b.t).slice(0, 10), c: b.c })).filter(b => b.t !== formingDay);
  const fwd = (sym, from, n) => { const a = series(sym); const i = a.findIndex(x => x.t >= from); return (i >= 0 && a[i].t === from && i + n < a.length) ? 100 * (a[i + n].c / a[i].c - 1) : (i >= 0 && i + n < a.length && a[i].t <= from) ? null : null; };
  const mkt = series("SPY").map((b) => b.t);
  /**
   * A pick's or control's +h return with the cash-out rule (forwardReturn / nameReturnOf above). Grades of a name whose bars have
   * ended are stored per horizon on the recorded pick (`endedGrades`) and reused if the bars endpoint later stops returning the name.
   */
  const nameReturn = (p, from, h) => nameReturnOf(p, series(p.sym), mkt, from, h, today);
  const graded = { 5: [], 20: [] };
  for (const s of st.sessions) {
    if (s.void) continue;                                             // voided sessions (holiday duplicates) grade nothing
    for (const h of HORIZONS) {
      const prx = s.picks.map(p => nameReturn(p, s.asOf, h));
      if (prx.some(x => x == null)) continue;                         // window not fully elapsed
      const pr = prx.filter(x => !x.excluded).map(x => x.r);
      if (!pr.length) continue;                                       // every pick was dead at pick time — nothing to grade
      const crx = s.controls.map(c => nameReturn(c, s.asOf, h)).filter(x => x != null && !x.excluded);
      const cr = crx.map(x => x.r);
      const er = s.picks.map(p => fwd(p.etf, s.asOf, h)).filter(x => x != null);
      const spy = fwd("SPY", s.asOf, h);
      if (spy == null || !cr.length || !er.length) continue;
      const cashedPicks = prx.filter(x => x.cashedOut).length, cashedControls = crx.filter(x => x.cashedOut).length, stalePicks = prx.filter(x => x.excluded).length;
      graded[h].push({ date: s.date, picks: mean(pr), control: mean(cr), sectorEtf: mean(er), spy,
        ...(cashedPicks || cashedControls ? { cashedOutPicks: cashedPicks, cashedOutControls: cashedControls } : {}), ...(stalePicks ? { stalePicksExcluded: stalePicks } : {}) });
    }
  }

  console.log(`\n  ${st.sessions.length} session(s) recorded`);
  for (const h of HORIZONS) {
    const g = graded[h];
    if (!g.length) { console.log(`  +${h}d: nothing elapsed yet`); continue; }
    const dP = g.map(x => x.picks - x.control), dE = g.map(x => x.picks - x.sectorEtf), dS = g.map(x => x.picks - x.spy);
    const t = (a) => { if (a.length < 2) return null; const m = mean(a); const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); return sd ? m / (sd / Math.sqrt(a.length)) : null; };
    console.log(`  +${h}d on ${g.length} date(s):  picks ${mean(g.map(x => x.picks)).toFixed(2)}%  ·  vs same-sector control ${mean(dP) >= 0 ? "+" : ""}${mean(dP).toFixed(2)}pp (t ${t(dP)?.toFixed(2) ?? "—"})  ·  vs sector ETF ${mean(dE) >= 0 ? "+" : ""}${mean(dE).toFixed(2)}pp  ·  vs SPY ${mean(dS) >= 0 ? "+" : ""}${mean(dS).toFixed(2)}pp`);
  }
  const readable = graded[20].length;
  console.log(readable >= READ_GATE_DATES
    ? `  GATE MET (${readable}/${READ_GATE_DATES}) — the control column decides, not the SPY column.`
    : `  ACCRUING — ${readable}/${READ_GATE_DATES} dates with elapsed +20d windows. No verdict, and beating SPY alone will never be one.`);

  const g20 = graded[20]; const dP20 = g20.map(x => x.picks - x.control);
  const t20 = dP20.length > 1 ? (() => { const m = mean(dP20); const sd = Math.sqrt(dP20.reduce((q, x) => q + (x - m) ** 2, 0) / (dP20.length - 1)); return sd ? +(m / (sd / Math.sqrt(dP20.length))).toFixed(2) : null; })() : null;
  st.graded = { asOf, byHorizon: Object.fromEntries(HORIZONS.map(h => [h, graded[h].length])), vsControl20pp: dP20.length ? +mean(dP20).toFixed(2) : null, t20,
    // 2026-10-05: how many graded dates lean on a cashed-out (delisted / acquired) name, per horizon — disclosed, never hidden
    cashedOut: Object.fromEntries(HORIZONS.map(h => [h, { dates: graded[h].filter(x => x.cashedOutPicks || x.cashedOutControls).length, picks: graded[h].reduce((q, x) => q + (x.cashedOutPicks || 0), 0), controls: graded[h].reduce((q, x) => q + (x.cashedOutControls || 0), 0), stalePicksExcluded: graded[h].reduce((q, x) => q + (x.stalePicksExcluded || 0), 0) }])),
    cashedOutNames: [...new Set(st.sessions.flatMap(x => [...(x.picks || []), ...(x.controls || [])].filter(p => p.cashedOut).map(p => `${p.sym} (last bar ${p.cashedOut.lastBar})`)))],
    staleAtPickNames: [...new Set(st.sessions.flatMap(x => [...(x.picks || []).map(p => ["pick", p]), ...(x.controls || []).map(p => ["control", p])].filter(([, p]) => p.staleAtPick).map(([r, p]) => `${p.sym} ${r} ${x.date} (last bar ${p.staleAtPick.lastBar})`)))] };
  if (st.graded.cashedOutNames.length) console.log(`  cashed out at the last available close (bars ended): ${st.graded.cashedOutNames.join(", ")} — +20d dates leaning on one: ${st.graded.cashedOut[20].dates}, +5d: ${st.graded.cashedOut[5].dates}`);
  if (st.graded.staleAtPickNames.length) console.log(`  dead before the pick date (excluded, never a live name that day): ${st.graded.staleAtPickNames.join(", ")}`);
  st.verdict = readable >= READ_GATE_DATES ? ((dP20.length && mean(dP20) > 0 && t20 >= 2) ? `PASS — picks beat the same-sector control by ${mean(dP20).toFixed(2)}pp at +20d, t ${t20} on ${readable} dates` : `DID NOT PASS — picks vs same-sector control ${dP20.length ? mean(dP20).toFixed(2) : "n/a"}pp at +20d, t ${t20 ?? "n/a"} on ${readable} dates (bar t >= 2)`) : `ACCRUING — ${readable}/${READ_GATE_DATES} dates with elapsed +20d windows${dP20.length ? ` (so far ${mean(dP20) >= 0 ? "+" : ""}${mean(dP20).toFixed(2)}pp vs control, t ${t20 ?? "n/a"})` : ""}`;
  // 2026-09-11 (coverage-mechanic): dailyClock exposes the bar's own unit (minDates: distinct signal
  // dates with an elapsed +20d window, per the registered read gate) directly from `readable`, which
  // is ALREADY the count of graded[20] entries — every one of which comes from a session recorded on
  // or after this test's evidenceStart (2026-08-12, the file's own registration date; no session in
  // st.sessions predates it), so this is a since-evidenceStart count, not a whole-history one.
  st.dailyClock = { sessions: readable, estimate: t20, unit: "dates (day-clustered t of picks-minus-same-sector-control pp at +20d; bar minDates=" + READ_GATE_DATES + ")", sessionMeans: dP20.map((x) => +x.toFixed(4)) };
  writeJsonAtomic(OUT, st);   // same serialisation as before (JSON, indent 1); temp + fsync + rename instead of an in-place write
  console.log(`written: ${path.basename(OUT)}`);
})();
