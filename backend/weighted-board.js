#!/usr/bin/env node
/**
 * TRAIDS — THE WEIGHTED BOARD
 *
 * Every agent, observer, model and panel contributes a score to each ticket, and the board's
 * conviction is the weighted sum of those contributions.
 *
 * ── THE ONE DECISION THAT DECIDES WHETHER THIS WORKS ─────────────────────────────────────────
 *
 * How the weights are set. There are three ways, and two of them are how this project has
 * already failed 57 times:
 *
 *   WRONG 1 — assign weights by judgment. "Momentum feels important, give it 0.3." This encodes
 *             an opinion and then dresses it in arithmetic. Nothing is learned; the board's
 *             output is the author's prior with extra steps.
 *   WRONG 2 — fit weights to past outcomes. Regress historical R on the observers and use the
 *             coefficients. This is exactly how tests #41-#43 died: the fit is a description of
 *             what already happened, it will look excellent in-sample, and it will not survive
 *             contact with next week. Fitting 28 observers to 352 trades is fitting noise.
 *   RIGHT   — weights are EARNED, walk-forward, from each contributor's own measured record,
 *             using only sessions that closed BEFORE the ticket being scored.
 *
 * So: on any given morning, a contributor's weight is a function of how it performed on every
 * prior session and nothing else. A contributor that has never been measured has weight ZERO —
 * it is recorded, displayed, and ignored. It gains weight only by working, loses it by not, and
 * every weight in the book can be traced to a number rather than an opinion.
 *
 * That is what makes the board get smarter without anyone deciding it should.
 *
 * ── HOW A CONTRIBUTOR EARNS WEIGHT ──────────────────────────────────────────────────────────
 *
 * Weight comes from the PAIRED WITHIN-SESSION GAP: for each prior session, the mean R of the
 * trades this contributor scored highly minus the mean R of the ones it scored low. Testing the
 * gap across sessions rather than pooling trades is what stops a good market day from being
 * mistaken for a good signal — a day that is good for everything contributes a gap near zero.
 *
 *   t < T_MIN            -> weight 0.   Not distinguishable from noise. Recorded, not acted on.
 *   t >= T_MIN           -> weight rises with t, capped, and SHRUNK by sample size so a
 *                           contributor with 6 sessions cannot outrank one with 60.
 *   sign is respected    -> a contributor that reliably points the WRONG way earns NEGATIVE
 *                           weight. svrZ currently measures t -3.64 with 0/5 sessions positive;
 *                           that is information, and inverting it is free.
 *
 * ── FAIL CLOSED ─────────────────────────────────────────────────────────────────────────────
 *
 * If no contributor has earned weight, the composite is zero and the board reports NO CONVICTION
 * rather than manufacturing a ranking. A board that goes quiet when nothing has an edge is
 * correct. The 2026-07-20..28 record — 352 trades, -$5,298, market-neutral alpha +0.0016R at
 * t 0.04 — is what happens when a board ranks anyway.
 *
 * Usage:  node backend/weighted-board.js            # compute and print current weights
 *         node backend/weighted-board.js --json     # machine-readable
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);

// ── the bar a contributor must clear ─────────────────────────────────────
const T_MIN = 2.0;              // below this, weight is zero — W1's REGISTERED screen; see honestScreen below for what it should be
const { nullBar } = require("./lib/null-bar");
// 2026-09-04 (stats lens): K contributors screened at |t| >= 2.0 with no multiplicity — under pure noise ~7% of 60 cross. The honest
// bar for "one of K contributors, either sign" is nullBar({variants: 2K, n}).p95 (two-sided best-of-K = one-sided best-of-2K).
// Disclosed beside the registered screen, never substituted for it: W1 is the forward test of the whole procedure, leniency included.
const honestBarCache = {};
function honestBar(K, n) { const key = K + ":" + n; if (!(key in honestBarCache)) honestBarCache[key] = +nullBar({ variants: 2 * K, n: Math.max(2, n), trials: 4000 }).p95.toFixed(3); return honestBarCache[key]; }
const T_FULL = 4.0;             // t at which a contributor reaches full weight
const MIN_SESSIONS = 5;         // fewer than this and it cannot be measured at all
const SHRINK_N = 20;            // sessions at which shrinkage stops biting

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
// SESSION KEY fixed 2026-09-04: was closedAt in America/Denver; registered tests grade the OPEN session in ET. See lib/session.js.
/**
 * SESSION LOOKUP, MEMOISED — 2026-09-08. This step was timing out at 15 minutes and then running for 81, which is 2.6 hours of the
 * chain's 3.6 between this and the daily report. Nothing here was wrong, only quadratic: lib/session.js openSession formats a date
 * through Intl on every call, measured at 45 microseconds, and the observer screen below called it once per (key, day, trade) —
 * about 44 million times on 111 observer keys, 50 sessions and 3,970 tickets.
 *
 * Two fixes, neither of which changes a single number: the session for a ticket is computed once and cached on identity, and the
 * per-day grouping is built once as a Map instead of re-filtering the whole ledger inside every day of every key. Group order
 * follows ledger order exactly as the old filter did, so every mean, split and gap is bit-identical to before.
 */
const _openSession = require("./lib/session.js").openSession;
const _dayCache = new WeakMap();
const dayOf = (t) => { let d = _dayCache.get(t); if (d === undefined) { d = _openSession(t); _dayCache.set(t, d); } return d; };
/** trades grouped by session, built once per call site. Returns a Map(day -> trades[]) in ledger order. */
const groupByDay = (rows) => { const m = new Map(); for (const t of rows) { const d = dayOf(t); let a = m.get(d); if (!a) m.set(d, (a = [])); a.push(t); } return m; };
const EMPTY = [];

/**
 * The paired within-session gap for one contributor, measured on a given set of trades.
 * `pick` returns +1 (contributor liked this ticket), -1 (disliked), or 0 (no opinion).
 */
function pairedGap(trades, pick) {
  const byDay = groupByDay(trades);
  const days = [...byDay.keys()].sort(), diffs = [], perSession = [];
  for (const d of days) {
    const rows = byDay.get(d) || EMPTY;
    const hi = rows.filter(t => pick(t) > 0), lo = rows.filter(t => pick(t) < 0);
    if (hi.length < 2 || lo.length < 2) continue;
    const g = mean(hi.map(t => t.rMult)) - mean(lo.map(t => t.rMult));
    diffs.push(g); perSession.push({ d, nHi: hi.length, nLo: lo.length, gap: +g.toFixed(4) });
  }
  if (diffs.length < MIN_SESSIONS) return { sessions: diffs.length, gap: null, t: null, positive: 0, perSession };
  const m = mean(diffs), s = sd(diffs);
  return { sessions: diffs.length, gap: m, t: s ? m / (s / Math.sqrt(diffs.length)) : 0,
           positive: diffs.filter(x => x > 0).length, perSession };
}

/**
 * Weight from a measured t. Zero below the bar; ramps to 1 at T_FULL; shrunk by sample size.
 * Sign is preserved so a reliably-wrong contributor is inverted rather than discarded.
 */
function weightFrom(t, sessions) {
  if (t == null || sessions < MIN_SESSIONS) return 0;
  const mag = Math.abs(t);
  if (mag < T_MIN) return 0;
  const ramp = Math.min(1, (mag - T_MIN) / (T_FULL - T_MIN));
  const shrink = Math.min(1, sessions / SHRINK_N);           // 5 sessions -> 0.25, 20+ -> 1.0
  return +(Math.sign(t) * ramp * shrink).toFixed(4);
}

/**
 * CONTRIBUTOR REGISTRY.
 * Each entry turns a ticket into an opinion. Observers read the `obs` block that is already
 * recorded on every settle, so the measurement data for them exists TODAY — that is the half of
 * the flywheel that was already built. Panels and agents register here as they are wired to
 * real data; until they have a real feed they must not appear, because a contributor scoring
 * from invented numbers would earn weight from noise (defects D35/D36).
 */
function buildContributors(trades) {
  const list = [];
  const byDayAll = groupByDay(trades);                 // built once; the observer screen below reads it per key
  const days = [...byDayAll.keys()].sort();
  const obsKeys = [...new Set(trades.flatMap(t => t.obs ? Object.keys(t.obs) : []))];
  /**
   * VINTAGE QUARANTINE — wired 2026-08-30, flagged by the vintage audit the same morning.
   * data/vintage-quarantine.json had ZERO readers repo-wide while its quarantined news-stamp
   * keys sat on this board at sessions=2 against MIN_SESSIONS=5 — three sessions from earning
   * weight on look-ahead-corrupted data. The defect FAKES an edge (same mechanism class as the
   * R12 incident that flipped a registered verdict), so an earned weight here would have been
   * manufactured. Quarantined keys stay ON the board, blocked with the reason — the house rule
   * is that a contributor never vanishes silently — and earn nothing until the quarantine file
   * itself says requalified.
   */
  const VQ = (() => {
    try {
      const q = JSON.parse(fs.readFileSync(D("vintage-quarantine.json"), "utf8"));
      const fe = q.featureEligibility || {};
      return /QUARANTINED/i.test(String(fe.status)) ? new Set(fe.keys || []) : new Set();
    } catch { return new Set(); }
  })();
  for (const k of obsKeys) {
    if (VQ.has(k)) {
      list.push({ id: `obs:${k}`, family: "observer", name: k, source: "per-trade at entry",
        blocked: "VINTAGE QUARANTINE — news-stamp backfill priced at first-available bar (fakes an edge); ineligible for fitting until requalified per data/vintage-quarantine.json",
        pick: () => 0 });
      continue;
    }
    const vals = trades.map(t => t.obs?.[k]).filter(Number.isFinite);
    if (vals.length < 60) continue;
    /**
     * IS THIS OBSERVER CONSTANT WITHIN A SESSION?
     *
     * Macro readings — VIX, the 10-year, the curve, oil, political sentiment — take ONE value
     * per day and every trade that day sees it. A within-session median split therefore puts
     * the entire session on one side and the paired gap can never form: the board reported
     * these as "0 sessions", which is defect D16 showing up mechanically rather than as an
     * argument. They are not weightless because they are useless; they are weightless because
     * they were being asked the wrong question.
     *
     * The right question for a session-constant observer is a SESSION-LEVEL one: do days when
     * it reads high produce better days than days when it reads low? The unit of observation is
     * the session, so the honest sample size is the number of SESSIONS — currently 7. That is
     * far too few to earn weight, and the shrinkage term says so, but it is at least measurable
     * and it accumulates.
     */
    const perDayVals = days.map(d => { const r = (byDayAll.get(d) || EMPTY).map(t => t.obs?.[k]).filter(Number.isFinite); return r.length ? mean(r) : null; });
    const varyWithin = days.some(d => { const r = (byDayAll.get(d) || EMPTY).map(t => t.obs?.[k]).filter(Number.isFinite); return r.length > 2 && sd(r) > 1e-9; });
    const med = [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)];
    if (varyWithin) {
      list.push({ id: `obs:${k}`, family: "observer", name: k, source: "per-trade at entry", scope: "within-session",
        apply: { kind: "obs", key: k, split: +med.toFixed(4) },   // W1: the live gate replays THIS rule, not a re-derived one
        pick: t => { const v = t.obs?.[k]; return Number.isFinite(v) ? (v > med ? 1 : -1) : 0; } });
    } else {
      const dv = perDayVals.filter(Number.isFinite);
      /**
       * NEVER DROP A CONTRIBUTOR SILENTLY. An earlier version of this `continue`d when a macro
       * observer had too few sessions, and eleven of them simply disappeared from the board
       * between one run and the next. A contributor that vanishes looks like a contributor that
       * was never registered, which is precisely how a collection gap hides. It stays on the
       * board with the reason attached.
       *
       * The reason here is itself a finding: vix, y10, curve and oil20 carry ~180 readings each
       * but those land on only 3 of 7 sessions — the macro block is not being captured on most
       * days. That is a data-collection defect, not a weak signal, and it must be fixed upstream
       * before these can ever earn weight.
       */
      const dmed = dv.length ? [...dv].sort((a, b) => a - b)[Math.floor(dv.length / 2)] : 0;
      if (dv.length < MIN_SESSIONS) {
        list.push({ id: `obs:${k}`, family: "macro", name: k, source: "one value per session", scope: "session-level",
          blocked: `only ${dv.length}/${days.length} sessions carry this reading — collection gap upstream`,
          pick: () => 0 });
        continue;
      }
      list.push({ id: `obs:${k}`, family: "macro", name: k, source: "one value per session", scope: "session-level",
        sessionSplit: t => { const v = t.obs?.[k]; return Number.isFinite(v) ? (v > dmed ? 1 : -1) : 0; },
        pick: t => { const v = t.obs?.[k]; return Number.isFinite(v) ? (v > dmed ? 1 : -1) : 0; } });
    }
  }
  // ── structural: direction vs the regime it was taken in ────────────────
  list.push({ id: "struct:conf", family: "structural", name: "board confidence", source: "board score at entry",
    apply: { kind: "conf", hi: 0.9, lo: 0.7 },                    // W1 replay rule
    pick: t => Number.isFinite(t.conf) ? (t.conf >= 0.9 ? 1 : t.conf <= 0.7 ? -1 : 0) : 0 });
  list.push({ id: "struct:side", family: "structural", name: "long vs short", source: "ticket direction",
    pick: t => t.dir > 0 ? 1 : -1 });

  // ── PRESIGNAL: the categories a ticket belongs to BEFORE any signal fires ──────────────
  /**
   * Added 2026-08-29 (operator: "presignal categories"). Everything above weighs stamps
   * measured AT entry; nothing weighed the GENERATOR itself. These do: strategy family and
   * asset class — membership vs rest, within-session, under the same earned-weight bars and
   * the same session shrinkage as every other contributor. apply is null: presignal weights
   * observe and earn; nothing enforces until the bounded sizing channel consumes an EARNED
   * weight, exactly the discipline the rest of the board lives under.
   *
   * REGIME IS DELIBERATELY ABSENT. The regime model refits its centroids every run and
   * rewrites 28-45% of its own past labels — only TREND persists. A weight fitted on labels
   * that rewrite themselves is the defect, not a contributor. Revisit if the labels freeze.
   *
   * Class already carries the book's one decisive presignal number (futures day-t −2.46,
   * found three separate times). This puts that kind of finding on the same board as every
   * other weight instead of living in ad-hoc analyses that have to be rediscovered.
   */
  const presignal = (dim, get) => {
    for (const v of [...new Set(trades.map(get).filter(x => x != null && x !== ""))].sort()) {
      const members = trades.filter(t => get(t) === v).length;
      const id = `presignal:${dim}:${v}`;
      if (members < 10) {   // never drop silently — the house rule; it stays visible with the reason
        list.push({ id, family: "presignal", name: `${dim}=${v}`, source: "ticket category at generation",
          blocked: `only ${members} ticket(s) in this category — on the board, earning nothing yet`, pick: () => 0 });
        continue;
      }
      list.push({ id, family: "presignal", name: `${dim}=${v}`, source: "ticket category at generation",
        scope: "within-session", apply: null,
        pick: t => (get(t) === v ? 1 : -1) });
    }
  };
  presignal("strategy", t => t.strategy);
  presignal("cls", t => t.cls);
  return list;
}

function computeBoard() {
  // 2026-09-03 (ledger lens): was a raw re-parse admitting 28 rows canon excludes (20 non-finite-pnl shadows, 8 validly
  // retired), all net-negative. Contributors are now fitted on the canonical population, signals and controls alike.
  const L = require("./lib/reconcile.js").cleanEraLedger();
  const trades = L.signals.concat(L.controls).filter(t => t && Number.isFinite(t.rMult));
  const contributors = buildContributors(trades);

  /**
   * SESSION-LEVEL GAP, for observers that take one value per day. Compare the mean R of
   * HIGH-reading sessions against LOW-reading sessions. The unit is the session, so n is the
   * session count — which is honest and currently brutal (7). Reported alongside the
   * within-session results, not instead of them: the two tests answer different questions and
   * both stay on the board.
   */
  const sessionGap = (pick) => {
    const byDay = groupByDay(trades);
    const days = [...byDay.keys()].sort();
    const rows = days.map(d => {
      const r = byDay.get(d) || EMPTY;
      return { d, side: pick(r[0]), r: mean(r.map(x => x.rMult)), n: r.length };
    }).filter(x => x.side !== 0);
    const hi = rows.filter(x => x.side > 0).map(x => x.r), lo = rows.filter(x => x.side < 0).map(x => x.r);
    if (hi.length < 2 || lo.length < 2) return { sessions: rows.length, gap: null, t: null, positive: 0, perSession: [] };
    const g = mean(hi) - mean(lo);
    const se = Math.sqrt((sd(hi) ** 2) / hi.length + (sd(lo) ** 2) / lo.length);
    return { sessions: rows.length, gap: g, t: se ? g / se : 0, positive: hi.filter(x => x > 0).length,
             perSession: rows.map(x => ({ d: x.d, nHi: x.side > 0 ? x.n : 0, nLo: x.side < 0 ? x.n : 0, gap: +x.r.toFixed(4) })) };
  };

  const scored = contributors.map(c => {
    const g = c.scope === "session-level" ? sessionGap(c.pick) : pairedGap(trades, c.pick);
    const w = weightFrom(g.t, g.sessions);
    return { id: c.id, family: c.family, name: c.name, source: c.source, scope: c.scope || "within-session", apply: c.apply ?? null,
             sessions: g.sessions, gap: g.gap == null ? null : +g.gap.toFixed(4),
             t: g.t == null ? null : +g.t.toFixed(2), positiveSessions: g.positive, weight: w,
             status: c.blocked ? "BLOCKED — " + c.blocked : w === 0 ? (g.sessions < MIN_SESSIONS ? "UNMEASURABLE — too few sessions" : "NO WEIGHT — not distinguishable from noise")
                            : (w > 0 ? "EARNED (positive)" : "EARNED (inverted — reliably points the wrong way)") };
  }).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || Math.abs(b.t ?? 0) - Math.abs(a.t ?? 0));

  const earning = scored.filter(s => s.weight !== 0);
  const totalW = earning.reduce((s, x) => s + Math.abs(x.weight), 0);
  const K = contributors.length;
  const honest = scored.map(s => { if (s.t == null || s.sessions < MIN_SESSIONS) return { id: s.id, bar: null, clears: false }; const bar = honestBar(K, s.sessions); return { id: s.id, t: s.t, sessions: s.sessions, bar, clears: Math.abs(s.t) >= bar }; });
  const honestScreen = { contributorsScreened: K, rule: "two-sided best-of-K: nullBar({variants: 2K, n: contributor sessions}).p95, 4000 trials",
    expectedNoiseCrossingsAtRegisteredScreen: +(K * 0.046).toFixed(1), earningAtRegisteredScreen: earning.map(e => e.id),
    clearingHonestBar: honest.filter(h => h.clears).map(h => h.id), perContributor: honest.filter(h => h.bar != null),
    note: "W1's registered screen (|t| >= 2.0) is unchanged; this block says which earners would survive a multiplicity-honest screen. Read W1 at its own bar." };
  return { generated: new Date().toISOString(), cleanEpoch: "2026-07-20", trades: trades.length,
    sessions: new Set(trades.map(dayOf)).size, bar: { T_MIN, T_FULL, MIN_SESSIONS, SHRINK_N },
    contributors: scored, earningWeight: earning.length, totalAbsWeight: +totalW.toFixed(3), honestScreen,
    conviction: earning.length === 0 ? "NO CONVICTION — no contributor has earned weight" : `${earning.length} contributor(s) carrying weight`,
    caveats: [
      "Weights here are measured on the FULL clean epoch, which is in-sample. The live board must recompute them walk-forward, using only sessions closed before the ticket being scored — otherwise this becomes the curve-fit that killed tests #41-#43.",
      "Session count is still small. A contributor at 5 sessions is shrunk to 25% of its ramp weight for exactly that reason.",
      "Contributors reading synthetic data are deliberately absent. Six panels were found on invented numbers (D35/D36); they may only register once their feed is real.",
    ] };
}

if (require.main === module) {
  const out = computeBoard();
  if (process.argv.includes("--json")) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
  console.log(`\n  TRAIDS — WEIGHTED BOARD`);
  console.log(`  ${out.trades} trades · ${out.sessions} sessions · weight earned only at |t| >= ${T_MIN}, full at ${T_FULL}\n`);
  console.log(`  ${"contributor".padEnd(20)} ${"scope".padEnd(15)} ${"sess".padStart(5)} ${"gap".padStart(9)} ${"t".padStart(7)} ${"weight".padStart(8)}   status`);
  for (const c of out.contributors)
    console.log(`  ${c.name.slice(0, 20).padEnd(20)} ${String(c.scope).padEnd(15)} ${String(c.sessions).padStart(5)} ${(c.gap == null ? "—" : (c.gap >= 0 ? "+" : "") + c.gap.toFixed(4)).padStart(9)} ${(c.t == null ? "—" : c.t.toFixed(2)).padStart(7)} ${(c.weight === 0 ? "—" : (c.weight > 0 ? "+" : "") + c.weight.toFixed(3)).padStart(8)}   ${c.status}`);
  console.log(`\n  ${out.conviction} · total |weight| ${out.totalAbsWeight}`);
  console.log(`  HONEST SCREEN (disclosed, not applied): ${out.honestScreen.contributorsScreened} contributors two-sided -> ${out.honestScreen.clearingHonestBar.length ? out.honestScreen.clearingHonestBar.join(", ") : "NONE"} clear a best-of-${out.honestScreen.contributorsScreened} bar (noise alone would put ~${out.honestScreen.expectedNoiseCrossingsAtRegisteredScreen} over |t| 2.0)`);
  out.caveats.forEach(c => console.log(`  · ${c}`));
  require("./lib/atomic-write").writeJsonAtomic(D("weighted-board.json"), out);   // 2026-09-04: the chain step exited 1 after a clean 13-min compute — in-place writes on this machine fail intermittently; rename over the target
  console.log(`\n  written: backend/data/weighted-board.json\n`);
}
module.exports = { computeBoard, pairedGap, weightFrom };
