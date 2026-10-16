#!/usr/bin/env node
/**
 * R24 — 13F BEST-IDEAS PAPER SLEEVE. Operator adoption 2026-08-19 ("put it on the board").
 *
 * WHAT THIS IS. The experiential layer of test #38: the current best-ideas forward cohort
 * (top-3 positions of 8 concentrated managers, formed after each 13F filing window) held as
 * real paper positions on the board. The MEASUREMENT stays in best-ideas-forward.json with its
 * own formation-day entries and the pre-registered bar (corrected t >= 2.58, min 8 quarters,
 * review 2027-01-15, tripwire: abandon if negative after 8). This sleeve exists so that by the
 * review date the operator has lived the asset — drawdowns, rebalance friction, sector tilts —
 * not just read its statistics. R21 precedent: assess with confidence, then paper trade it.
 *
 * MECHANICS (fixed here):
 *   - SYNC to the latest cohort in best-ideas-forward.json: names missing from the board are
 *     ADDED; board names that left the cohort are CLOSED (reason "rebalance"). Idempotent —
 *     between filing windows this is a no-op.
 *   - Entries at the CURRENT price when added (never the cohort's formation price — the board
 *     never backdates; the sleeve's entries therefore differ slightly from the measurement
 *     cohort's, and the measurement is the one with the bar).
 *   - NO STOPS, NO TARGETS. A quarterly clone that stops out is not a clone. Positions carry
 *     no stop/target fields at all, which exempts them from board-discipline BY CONSTRUCTION
 *     (it enforces only positions with a numeric stop). Exit is the next rebalance, full stop.
 *   - $1,250 paper per name (OP9 2026-10-02, operator "R24 to $250": $250 risk at the 20% R unit; was $3,000 = $600 risk),
 *     equal weight. Each position carries its own `notional`; a position without one is a pre-OP9 $3,000 lot.
 *   - R convention at close: 1R = a 20% move on the name (an allocation's risk unit, documented
 *     so the ledger's R stats aren't polluted by pretend day-trade sizing). Tagged strategy
 *     "R24-13F-clone" so every downstream reader can include or exclude the sleeve explicitly.
 *
 * FAIL-CLOSED: a name that cannot be priced fresh is skipped and reported, never guessed.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const API = process.env.TRAIDS_API || "http://localhost:3001";
const BOARD = D("board_positions.json"), TOMBS = D("board_tombstones.json"), TLOG = D("trade_log.json");
const PER_NAME = 1250, LEGACY_PER_NAME = 3000, R_UNIT = 0.20;   // 1R = 20% move; OP9 2026-10-02: $1,250 a name ($250 risk), was $3,000

(async () => {
  const fwd = JSON.parse(fs.readFileSync(D("best-ideas-forward.json"), "utf8"));
  const cohorts = (fwd.cohorts || []).filter(c => !c.closed);
  if (!cohorts.length) { console.log("R24 SLEEVE — no open forward cohort; nothing to hold."); return; }
  const cohort = cohorts[cohorts.length - 1];
  const want = new Set(cohort.legs.map(l => l.tk));

  const board = JSON.parse(fs.readFileSync(BOARD, "utf8"));
  // OP9 review 2026-10-02: a lot already closed (tombstoned, or with a closing row in the trade log) is dead even if a stale dashboard
  // re-post put it back; two open lots for one name means a resurrection — refuse rather than close both at rotation.
  const tombIds = new Set((() => { try { const t = JSON.parse(fs.readFileSync(TOMBS, "utf8")); return Array.isArray(t) ? t : []; } catch { return []; } })().map((t) => t.id ?? t));
  const closedIds = new Set((() => { try { const t = JSON.parse(fs.readFileSync(TLOG, "utf8")); return Array.isArray(t) ? t : []; } catch { return []; } })().filter((t) => t && t.strategy === "R24-13F-clone" && t.closedAt).map((t) => t.id));
  const mine = board.filter(p => p.strategy === "R24-13F-clone" && !tombIds.has(p.id) && !closedIds.has(p.id));
  const dupSyms = Object.entries(mine.reduce((a, p) => ((a[p.sym] = (a[p.sym] || 0) + 1), a), {})).filter(([, n]) => n > 1).map(([k]) => k);
  if (dupSyms.length) { console.error(`R24 SLEEVE — more than one open lot for ${dupSyms.join(", ")}; refusing (resurrected lot?)`); process.exit(2); }
  const have = new Set(mine.map(p => p.sym));
  const toAdd = [...want].filter(s => !have.has(s));
  const toClose = mine.filter(p => !want.has(p.sym));
  if (!toAdd.length && !toClose.length) { console.log(`R24 SLEEVE — in sync with cohort ${cohort.period}: ${mine.length} names held. No-op.`); return; }

  const need = [...new Set([...toAdd, ...toClose.map(p => p.sym)])];
  let px = {};
  try {
    const r = await fetch(`${API}/api/equities/snapshot?symbols=${need.join(",")}`, { signal: AbortSignal.timeout(60000) });
    px = await r.json();
  } catch (e) { console.error(`R24 SLEEVE — pricing failed (${e.message}); nothing changed.`); process.exit(2); }
  const priceOf = (s) => { const q = px[s]; const p = q && (q.price ?? q.p ?? q.last); return Number.isFinite(p) && p > 0 ? p : null; };

  const now = Date.now(), added = [], skipped = [], closedRows = [];
  for (const s of toAdd) {
    const p = priceOf(s);
    if (!p) { skipped.push(s); continue; }
    const shares = +(PER_NAME / p).toFixed(3);
    added.push({
      id: `${now}-Equity-${s}-r24`, cls: "Equity", sym: s, name: `${s} — 13F best-ideas clone`,
      dir: 1, addedAt: now, alerted: true,
      sizeLabel: `${shares} shares ($${PER_NAME.toLocaleString()})`, riskDollars: PER_NAME * R_UNIT,
      priceSym: null, conf: null, strategy: "R24-13F-clone", sleeve: "R24-v1",
      score: null, nBull: null, nBear: null, total: null,
      ctrl: false, vetoShadow: false, veto: null, ctrlRand: false, pairId: null,
      entry: p, shares, notional: PER_NAME,
      obs: { cohortPeriod: cohort.period, cohortFormed: cohort.formed, sleeve: "R24-v1", rUnit: R_UNIT },
    });
  }
  for (const p of toClose) {
    const live = priceOf(p.sym);
    if (!live) { skipped.push(p.sym + "(close)"); continue; }
    const pct = p.dir * (live / p.entry - 1);
    closedRows.push({
      id: p.id, sym: p.sym, cls: "Equity", dir: p.dir, sizeLabel: p.sizeLabel,
      entry: p.entry, exit: live, rMult: pct / R_UNIT, pnl: +((Number.isFinite(p.notional) ? p.notional : LEGACY_PER_NAME) * pct).toFixed(2),
      reason: "rebalance", openedAt: p.addedAt, closedAt: now,
      conf: null, strategy: "R24-13F-clone", rr: null, score: null, nBull: null, nBear: null, total: null,
      obs: { ...(p.obs || {}), rotatedOut: cohort.period },
    });
  }

  const ids = new Set(closedRows.map(c => c.id));
  const nextBoard = board.filter(p => !ids.has(p.id)).concat(added);
  writeJsonAtomic(BOARD, nextBoard);
  if (closedRows.length) {
    const tlog = (() => { try { const t = JSON.parse(fs.readFileSync(TLOG, "utf8")); return Array.isArray(t) ? t : []; } catch { return []; } })();
    writeJsonAtomic(TLOG, [...closedRows, ...tlog]);
    const tombs = (() => { try { const t = JSON.parse(fs.readFileSync(TOMBS, "utf8")); return Array.isArray(t) ? t : []; } catch { return []; } })();
    writeJsonAtomic(TOMBS, [...tombs, ...closedRows.map(c => ({ id: c.id, ts: now }))]);
  }

  console.log(`R24 SLEEVE — cohort ${cohort.period}: added ${added.length}, rotated out ${closedRows.length}${skipped.length ? `, SKIPPED (no fresh price): ${skipped.join(", ")}` : ""}`);
  for (const a of added) console.log(`    + ${a.sym.padEnd(5)} ${a.shares} sh @ ${a.entry}`);
  for (const c of closedRows) console.log(`    - ${c.sym.padEnd(5)} ${c.rMult >= 0 ? "+" : ""}${c.rMult.toFixed(2)}R $${c.pnl >= 0 ? "+" : ""}${c.pnl}`);
  console.log(`  sleeve target: ${want.size} names x $${PER_NAME.toLocaleString()} paper · no stops by design (exit = next filing-window rebalance)`);
})();
