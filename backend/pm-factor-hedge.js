#!/usr/bin/env node
/**
 * PORTFOLIO-MANAGER DAILY WRITER — mechanises the seat's own demonstrated rule so PM1 can accrue.
 * Built 2026-08-31.
 *
 * WHAT WAS BROKEN. PM1's bar-bearing claim is limb B: do the portfolio-manager seat's agent-book
 * tickets beat the main book, over 20 sessions of SETTLED tickets. The seat had opened two tickets
 * ever (XLV, XLK on 08-28) and portfolio-manager-plans.jsonl held ONE row, because a ticket only
 * appeared when a human ran the agent by hand. Limb A carries no bar at all — the registry says so —
 * so prose plans do not move PM1. Tickets do. This writes tickets, every session, from the rule the
 * seat already demonstrated twice.
 *
 * THE RULE, taken verbatim from the seat's own two tickets: find the factor group on the standing
 * board whose gross absolute-R most exceeds the R53 single-ticket cap, and short that group's sector
 * ETF as a partial hedge. Group tokens come from lib/enforcement-gates.js groupTokens(), where an
 * equity's token IS its sector ETF (`eq:XLV`), so the rule names its own instrument.
 *
 * THIS TESTS THE RULE, NOT THE SEAT — AND THAT IS A REAL DISTINCTION, NOT A CAVEAT.
 * PM1 asks whether the SEAT's judgment beats the board. A mechanical rule cannot answer that; it
 * answers whether the RULE does. Every ticket here is therefore stamped meta.arm = "mechanical-
 * factor-cap", and the seat's own discretionary tickets carry no such stamp, so PM1's read can
 * separate them and must. Pooling a mechanical arm into a discretionary seat's record would let a
 * rule earn a seat its authority — which is exactly the substitution this house exists to prevent.
 *
 * NOT A HEDGE CLAIM EITHER. A sector-ETF short hedges only the DIRECTIONAL part of a cluster and
 * does approximately nothing for a balanced long/short basket; the seat said so itself on 08-28.
 * No edge is asserted. This is exposure management, measured.
 *
 * Paper only. lib/agent-book.js throws on any write aimed at board_positions.json or trade_log.json.
 */
const fs = require("fs"), path = require("path");
const AB = require("./lib/agent-book.js");
const EG = require("./lib/enforcement-gates.js");
const { fetchBars } = require("./lib/alpaca-bars.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);

const SEAT = "portfolio-manager";
const ARM = "mechanical-factor-cap";
const DRY = process.argv.includes("--dry-run");
/**
 * 4.61% — the board's own measured equity stop width (R54's origin note), the same figure the seat
 * used on both its 08-28 tickets so the mechanical and discretionary arms size comparably.
 */
const STOP_PCT = 0.0461;
const etDay = (ms = Date.now()) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const today = etDay();

const board = (() => { try { return JSON.parse(fs.readFileSync(D("board_positions.json"), "utf8")); } catch { return []; } })();
const rows = Array.isArray(board) ? board : (board.open || board.positions || []);
/**
 * POPULATION EXCLUDES CONTROL-ARM TICKETS — corrected 2026-09-01, one session after this file
 * first ran, by the head-trader seat's own measurement rather than by review.
 *
 * I built this on 2026-08-28's precedent, which counted "15 correlated control-arm equity tickets"
 * and deliberately INCLUDED controls because R53 caps correlated exposure and a control ticket is
 * a real position. That reasoning was wrong, and the seat that set the precedent is the one that
 * disproved it. Closing its XLRE hedge on 2026-08-31 it wrote, of the cluster it had hedged:
 *
 *     "all three names in the hedged cluster were CONTROL-arm coin-flip tickets, so a 100%-
 *      one-sided control cluster is a coin-flip artifact that self-neutralises in about three
 *      sessions, and paying real spread to hedge it is paying to hedge randomness."
 *
 * The board is 81% control-arm (97 of 120 open). Measured 2026-09-01, the clusters this file was
 * choosing from are almost entirely coin flips: XLY 93% control (13 of 14), XLV 90%, XLK 90%,
 * XLF 75%. Both tickets it opened on its first run — XLY and XLF — are therefore hedges against
 * randomness, bought with real spread, exactly the error the seat had just recorded.
 *
 * CONSEQUENCE, STATED PLAINLY: with controls excluded, NO equity group breaches the R53 cap at
 * all, so this arm will usually open nothing. That is the correct outcome, not a broken one. A
 * hedge lane with nothing to hedge should sit still; the previous version manufactured work.
 */
const live = rows.filter((p) => p && !p.ctrl && !p.vetoShadow && !p.sleeve);

const CAP = AB.riskDollars("Equity");            // the R53 single-ticket ceiling, from shared policy

// ── group the standing book ──
const groups = {};
for (const p of live) {
  for (const g of EG.groupTokens(p)) {
    (groups[g] ||= { token: g, tickets: [], grossR: 0, netR: 0 });
    const r = Number.isFinite(p.riskDollars) ? p.riskDollars : CAP;
    groups[g].tickets.push({ sym: p.sym, dir: p.dir, r });
    groups[g].grossR += r;
    groups[g].netR += (Math.sign(p.dir) || 1) * r;
  }
}
const ranked = Object.values(groups)
  .filter((g) => g.token.startsWith("eq:"))       // only equity groups name a tradeable sector ETF
  .map((g) => ({ ...g, etf: g.token.slice(3), capMultiple: +(g.grossR / CAP).toFixed(2),
    oneSidedPct: g.grossR ? Math.round(100 * Math.abs(g.netR) / g.grossR) : 0 }))
  .filter((g) => g.capMultiple > 1)               // only breaches
  .sort((a, b) => b.capMultiple - a.capMultiple);

const bookNow = AB.readBook();
const heldSyms = new Set((bookNow.open || []).map((t) => t.sym));
const target = ranked.find((g) => !heldSyms.has(g.etf)) || null;

(async () => {
  let opened = null, why = null;
  if (!ranked.length) why = "no equity factor group on the standing board exceeds the R53 single-ticket cap — nothing to hedge";
  else if (!target) why = `the ${ranked.length} breaching group(s) are all already held in the agent book — one bet per name`;

  if (target) {
    let bar = null;
    try {
      const start = new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10);
      const b = (await fetchBars([target.etf], { start, end: today, timeframe: "1Day", requireAll: false, quiet: true })).bars || {};
      // The entry bar must be TODAY's. Entering at a stale close backdates a ticket that is then
      // graded as live — fail closed, exactly as the trade-ranker book does.
      bar = (b[target.etf] || []).filter((x) => etDay(Date.parse(x.t)) === today).pop() || null;
    } catch (e) { why = "bar fetch failed: " + e.message.slice(0, 90); }

    if (!bar || !Number.isFinite(bar.c) || bar.c <= 0) {
      why = why || `no ${today} close for ${target.etf} — skipped rather than entered at a stale price`;
    } else {
      // 2026-09-24 operator-approved fix (weekly audit A0923-027): hedge AGAINST the cluster's net direction — a net-long cluster is hedged
      // with a short of its sector ETF, a net-short cluster with a long; the old code always shorted and added to same-signed risk in 8 of 13.
      const hedgeDir = -Math.sign(+target.netR || 0);
      const entry = +bar.c, stop = +(entry * (1 + hedgeDir * -STOP_PCT)).toFixed(6);   // short: stop above; long: stop below
      const reason =
        `MECHANICAL ARM (${ARM}) — not the seat's discretionary judgment, and stamped so PM1 can separate them. ` +
        `Largest R53 factor-group breach on the standing board: ${target.token} carries ${target.tickets.length} correlated ` +
        `equity tickets, $${target.grossR} gross absolute-R = ${target.capMultiple}x the $${CAP} single-ticket cap ` +
        `(test-registry.json R53), ${target.oneSidedPct}% net-directional. ${hedgeDir < 0 ? "Short" : "Buy"} the group's own sector ETF (against its net ${hedgeDir < 0 ? "long" : "short"} direction) as a PARTIAL ` +
        `hedge of the directional component only — a sector hedge does approximately nothing for a balanced long/short ` +
        `basket and no edge is asserted here. Entry = ${today} completed close, fetched live. Stop = entry x ${(1 - hedgeDir * STOP_PCT).toFixed(4)}, ` +
        `the board's own measured equity stop width (R54 origin note), the same width the seat used on 2026-08-28.`;

      if (!hedgeDir) { why = "cluster is balanced (net R 0) — no directional component to hedge"; }
      else if (DRY) opened = { sym: target.etf, dir: hedgeDir, entry, stop, dryRun: true };
      else {
        try {
          const t = AB.open({ agent: SEAT, sym: target.etf, cls: "Equity", dir: hedgeDir, entry, stop, reason,
            meta: { arm: ARM, mechanical: true, clusterToken: target.token, clusterTickets: target.tickets.length,
              clusterGrossR_USD: target.grossR, clusterNetR_USD: target.netR, oneSidedPct: target.oneSidedPct,
              r53CapUSD: CAP, capMultiple: target.capMultiple, stopPct: STOP_PCT, entryBar: today } });
          opened = { sym: t.sym, dir: t.dir, entry: t.entry, stop: t.stop, qty: t.qty, id: t.id };
        } catch (e) { why = "open refused: " + e.message.slice(0, 120); }
      }
    }
  }

  // ── seal the decision, whether or not a ticket resulted ──
  const plan = {
    spec: "portfolio-manager-mechanical-arm-v1", arm: ARM, mechanical: true,
    planDay: today, sealedAt: new Date().toISOString(), dryRun: DRY,
    scope: "MEASUREMENT ONLY — executes nothing in board_positions.json or trade_log.json. Paper agent book.",
    armNote: "This is the MECHANICAL arm of the portfolio-manager seat. PM1 limb B asks whether the SEAT's judgment beats the board; this rule cannot answer that and does not claim to. Rows are stamped meta.arm so the read separates mechanical from discretionary. Pooling them would let a rule earn a seat its authority.",
    r53CapUSD: CAP, boardTicketsScanned: live.length,
    breaches: ranked.slice(0, 8).map((g) => ({ token: g.token, etf: g.etf, tickets: g.tickets.length,
      grossR_USD: g.grossR, netR_USD: g.netR, capMultiple: g.capMultiple, oneSidedPct: g.oneSidedPct })),
    action: opened || null, noAction: opened ? null : why,
  };
  /**
   * A DRY RUN MUST NOT APPEND. portfolio-manager-plans.jsonl is PM1's limb-A evidence file and is
   * append-only; a --dry-run that writes to it puts rehearsal rows in an evidentiary record, which
   * is not undone by a dryRun:true flag on the row. I did exactly that twice while building this
   * and had to strip them out. The status snapshot is safe either way — it is overwritten, not
   * accumulated — so a dry run still shows its full output.
   */
  if (!DRY) fs.appendFileSync(D("portfolio-manager-plans.jsonl"), JSON.stringify(plan) + "\n");
  writeJsonAtomic(D("pm-factor-hedge.json"), plan);

  console.log(`\nPM FACTOR-CAP HEDGE${DRY ? "  [DRY RUN]" : ""} — ${today} · ${live.length} board tickets · R53 cap $${CAP}`);
  if (!ranked.length) console.log("  no equity group over the cap.");
  for (const g of ranked.slice(0, 5))
    console.log(`  ${g.etf.padEnd(5)} ${String(g.tickets.length).padStart(3)} tickets · $${String(g.grossR).padStart(6)} gross · ${String(g.capMultiple).padStart(6)}x cap · ${String(g.oneSidedPct).padStart(3)}% one-sided${heldSyms.has(g.etf) ? "   [already held]" : ""}`);
  if (opened) console.log(`\n  OPEN  ${opened.sym} SHORT entry ${opened.entry} stop ${opened.stop}${opened.qty ? " qty " + opened.qty : ""}`);
  else console.log(`\n  no ticket: ${why}`);
  console.log(`  book now: ${AB.state().open} open · ${AB.state().settled} settled`);
  console.log("  sealed to portfolio-manager-plans.jsonl · MECHANICAL arm, stamped distinct from the seat's own judgment\n");
})();
