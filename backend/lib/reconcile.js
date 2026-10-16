/**
 * RECONCILE — one canonical definition of the settled ledger, and a hard check that any new analysis
 * agrees with it before it is allowed to report a number.
 *
 * WHY THIS EXISTS. On 2026-08-24 the same quantity — our signal-minus-control edge — was reported
 * three times and was wrong twice:
 *
 *   +0.0736R   read the whole ledger, ignoring the 2026-07-20 clean epoch, so records the shop has
 *              formally demoted to context were counted as evidence.
 *   +0.0070R   applied the epoch but read trade_log.JSONL, which is an append-only SHADOW of the
 *              real ledger. It only gains rows when backend/ledger-journal.js runs, and it had not
 *              run since 2026-08-21. Six settled rows were missing — including AAPL at -4.06R and
 *              AMZN at -1.86R. Dropping two large losses made the number optimistic.
 *   -0.0003R   trade_log.JSON, the authoritative working view. This is the answer.
 *
 * Neither error was in the ledger. Both were in analysis code choosing its own source and its own
 * filters. The operator's question was the right one: if that can happen, what is any number worth?
 * The answer has to be structural, so this module makes the canonical read the ONLY read, and makes
 * disagreement an exception rather than a footnote.
 *
 * THE CONTRACT, matching src/App.jsx's `ledger` useMemo line for line so the board and the backend
 * cannot drift:
 *   source     data/trade_log.json          — the working view, rewritten whole on every settle
 *   epoch      2026-07-20T00:00:00 local    — registered epoch; earlier rows are context, not evidence
 *   settled    Number.isFinite(rMult) && Number.isFinite(pnl) && closedAt >= epoch && NOT validly retired
 *              the pnl requirement was added 2026-08-25: a row that moved no money is not in a P&L
 *              ledger. Same filter in src/App.jsx; ledger-journal.js already required it.
 *   signals    !t.ctrl                      — note: t.ctrl ONLY, matching the board
 *   edge       mean(signals) - mean(controls), POOLED
 *
 * data/trade_log.jsonl is NOT a substitute. It is the immutable journal; it lags by design, and its
 * lag is reported here rather than silently absorbed.
 *
 * ONE ROW PER TICKET — added 2026-10-16, the wings double count.
 *   The contract above says "source data/trade_log.json" and every line of it has always meant ROWS.
 *   Six R21 weekly wings broke that: closed by the loss cap on 2026-09-14, VOIDED, restored to the
 *   board under the SAME id, then settled at expiry by a PREPEND that left the voided close in place
 *   (backend/options-settle.js). Two rows, one ticket id, two different pnl — so every report reading
 *   from here counted each of those wings twice. The append-only journal did not: it is keyed on the
 *   ticket id, which is why the ledger and the journal key disagreed by exactly the revoided wings.
 *   cleanEraLedger() now reads ONE ROW PER TICKET (lib/ticket-rows.js collapseByTicket) before any
 *   filter runs, and reports what that collapsed in `tickets`, `duplicateTicketIds`,
 *   `supersededRowsDropped` and `unexplainedDuplicateTicketIds`. On a ledger where no ticket id
 *   appears twice the collapse is an exact no-op and every number here is the number it always was.
 *   BREAKS COMPARABILITY where a duplicate existed: a statistic computed on this population before
 *   2026-10-16 counted those tickets twice. See docs/wings-double-count/2026-10-16/NOTES.md.
 */
const fs = require("fs"), path = require("path");
const { collapseByTicket, collapseLine } = require("./ticket-rows.js");
const D = (f) => path.join(__dirname, "..", "data", f);
const CANON = D("trade_log.json");
const JOURNAL = D("trade_log.jsonl");

/** the registered clean epoch. Local midnight, exactly as src/App.jsx computes it. */
const CLEAN_EPOCH = new Date("2026-07-20T00:00:00").getTime();

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/** THE canonical read. Every analysis that touches settled outcomes must start here. */
function cleanEraLedger() {
  const rowsInFile = JSON.parse(fs.readFileSync(CANON, "utf8"));
  // ONE ROW PER TICKET, before any filter (2026-10-16, the wings double count). A ticket whose close was
  // voided and re-closed under the same id has two rows here; it is one ticket and counts once. What this
  // dropped is returned below, never absorbed. No-op when no ticket id appears twice.
  const collapse = collapseByTicket(rowsInFile);
  const log = collapse.rows;
  // A settled row must carry a finite pnl — resolved 2026-08-25, see knownAmbiguities() below and the
  // matching filter in src/App.jsx. Experiment sleeves that record an rMult but move no money keep
  // their own books; they do not settle into the board's P&L ledger.
  // RETIRED ROWS ARE EXCLUDED — operator decision 2026-08-26, recorded in the change registry under
  // accounting. A row whose inputs are found to be unreal cannot inform a P&L.
  //
  // THE GUARD MATTERS MORE THAN THE RULE. Excluding retired rows moves the signal book from -0.0193R
  // to -0.0172R — in the FLATTERING direction — so `retired` is the single most abusable field in
  // this ledger: anyone who can set it can delete a loss. It therefore only counts when BOTH hold:
  //   1. the row carries a retireNote naming the root cause, and
  //   2. the tag id appears in change-registry.json, which is append-only.
  // A bare `retired` flag excludes nothing and is reported as ignored. That makes quietly dropping a
  // bad day impossible without leaving a permanent, dated, public record of having done it.
  const validRetireTags = (() => {
    try {
      const cr = fs.readFileSync(D("change-registry.json"), "utf8");
      const tags = new Set();
      for (const t of log) if (t && t.retired && t.retireNote && cr.includes(t.retired)) tags.add(t.retired);
      return tags;
    } catch { return new Set(); }
  })();
  const isRetired = (t) => t.retired && validRetireTags.has(t.retired);
  const settledAll = log.filter((t) => t && Number.isFinite(t.rMult) && Number.isFinite(t.pnl) && t.closedAt >= CLEAN_EPOCH);
  const settled = settledAll.filter((t) => !isRetired(t));
  const ignoredTags = [...new Set(settledAll.filter((t) => t.retired && !validRetireTags.has(t.retired)).map((t) => t.retired))];
  const signals = settled.filter((t) => !t.ctrl);
  const controls = settled.filter((t) => t.ctrl);
  const sm = mean(signals.map((t) => t.rMult)), cm = mean(controls.map((t) => t.rMult));
  return {
    source: "data/trade_log.json", epoch: "2026-07-20T00:00:00 local (registered)",
    rowsInFile: rowsInFile.length, settled: settled.length,
    // the collapse, stated so no reader has to assume it (2026-10-16)
    tickets: collapse.tickets, duplicateTicketIds: collapse.duplicates.length, supersededRowsDropped: collapse.dropped.length,
    unexplainedDuplicateTicketIds: collapse.ambiguous, duplicateTickets: collapse.duplicates, ticketsLine: collapseLine(collapse),
    retiredExcluded: settledAll.length - settled.length, retireTagsHonoured: [...validRetireTags], retireTagsIGNORED: ignoredTags,
    signals, controls,
    n: signals.length, controlN: controls.length,
    meanR: sm == null ? null : +sm.toFixed(4),
    controlMeanR: cm == null ? null : +cm.toFixed(4),
    pooledEdgeR: sm == null || cm == null ? null : +(sm - cm).toFixed(4),
    winRatePct: signals.length ? +((signals.filter((t) => t.rMult > 0).length / signals.length) * 100).toFixed(1) : null,
  };
}

/**
 * EPISODES — the de-clustering guard (built 2026-08-25, third occurrence of the defect).
 *
 * Rows that open at the SAME instant and close at the SAME instant inside one asset class are not
 * independent draws. They are one decision, booked N times. This has now been found three times:
 * twelve alt-coins closing at exactly +2.00R in a single session; a congressional-trade result at
 * t=12 that collapsed when de-overlapped; and — the one that forced this function — sixteen crypto
 * names opened 2026-08-21T13:35:40.238Z and closed 2026-08-24T13:35:09.909Z, eleven of them at
 * exactly +2.000R, carrying the board's entire reported +0.0061R pooled edge.
 *
 * An episode is keyed on (asset class, openedAt, closedAt, direction). Each episode contributes ONE
 * observation whose R is the mean of its members.
 *
 * WHAT THIS DOES AND DOES NOT DO — stated precisely, because the obvious assumption is wrong.
 * It always REDUCES EFFECTIVE N (895 signals collapse to 295, a 3.03x inflation), which always
 * RAISES the bar a result must clear. It does NOT necessarily shrink the point estimate: collapsing
 * a basket to one observation re-weights the sample, and the controls cluster too (495 -> 162). On
 * the 2026-08-25 ledger the episode edge came out HIGHER than the ticket edge (+0.0351R vs
 * +0.0061R) because a 12-name crypto basket at -1.03R collapsed to one observation just as the
 * 20-name basket at +1.35R did. The point is not that the number gets smaller. The point is that
 * 895 was never the sample size, so no significance test computed on it was ever valid.
 *
 * This does NOT replace the canonical figure. cleanEraLedger() still reports the pooled number the
 * board has always reported, because changing a canonical definition quietly is how the ledger got
 * into trouble in the first place. Both are returned side by side, and the GAP between them is the
 * diagnostic: a large gap means the headline is being carried by a few simultaneous baskets.
 */
function episodes(rows) {
  const by = new Map();
  for (const t of rows) {
    const k = `${t.cls || "?"}|${t.openedAt}|${t.closedAt}|${t.dir > 0 ? "L" : "S"}`;
    (by.get(k) || by.set(k, []).get(k)).push(t);
  }
  return [...by.entries()].map(([key, members]) => ({
    key, n: members.length, cls: members[0].cls,
    syms: members.map((m) => m.sym),
    rMult: mean(members.map((m) => m.rMult)),
    openedAt: members[0].openedAt, closedAt: members[0].closedAt,
  }));
}

/**
 * The de-clustered read. Returns the same edge computed on EPISODES rather than tickets, plus the
 * largest clusters so the operator can see exactly what collapsed. Call this before quoting any
 * pooled figure in an analysis; quote the canonical number only alongside it.
 */
function deClusteredEdge() {
  const L = cleanEraLedger();
  const sEp = episodes(L.signals), cEp = episodes(L.controls);
  const sm = mean(sEp.map((e) => e.rMult)), cm = mean(cEp.map((e) => e.rMult));
  const worst = [...sEp].sort((a, b) => b.n - a.n).slice(0, 5)
    .filter((e) => e.n > 1)
    .map((e) => ({ n: e.n, cls: e.cls, meanR: +e.rMult.toFixed(4), syms: e.syms.slice(0, 20) }));
  const inflation = sEp.length ? +(L.n / sEp.length).toFixed(2) : null;
  // Episode-level t on the signal book, so the significance question is answerable on the honest
  // unit rather than only on the inflated one. Reported for both, precisely so the gap is visible.
  const tOf = (xs) => {
    const k = xs.length; if (k < 2) return null;
    const g = mean(xs), sd = Math.sqrt(xs.reduce((s, x) => s + (x - g) ** 2, 0) / (k - 1));
    return sd > 0 ? +(g / (sd / Math.sqrt(k))).toFixed(3) : null;
  };
  return {
    tTicketsSignals: tOf(L.signals.map((t) => t.rMult)),
    tEpisodesSignals: tOf(sEp.map((e) => e.rMult)),
    tickets: { signals: L.n, controls: L.controlN, pooledEdgeR: L.pooledEdgeR },
    episodes: {
      signals: sEp.length, controls: cEp.length,
      meanR: sm == null ? null : +sm.toFixed(4),
      controlMeanR: cm == null ? null : +cm.toFixed(4),
      pooledEdgeR: sm == null || cm == null ? null : +(sm - cm).toFixed(4),
    },
    effectiveNInflation: inflation,
    largestClusters: worst,
    note: "Effective N is EPISODES. A ticket count is not a sample size. The canonical pooled figure is unchanged and reported above it; where the two disagree, the episode read is the one that may be quoted as evidence.",
  };
}

/**
 * How far behind is the append-only journal? Returned, never hidden. A non-zero lag does not make
 * the journal wrong — it makes it INCOMPLETE, which is worse for analysis because the missing rows
 * are the most recent ones and are not missing at random.
 */
/**
 * TICKETS ON BOTH SIDES (2026-10-16). The journal is keyed on the ticket id — one entry per ticket, by
 * construction. The canonical side is counted the same way here, or the two can never agree: before this,
 * `settledInCanon` counted ROWS, so each revoided-and-re-settled wing made the journal look one entry
 * behind for ever, and `journalRows` vs `settledInCanon` was off by exactly the number of such wings.
 * Duplicate ticket ids in the canon are reported rather than absorbed into an apparent lag.
 */
function journalLag() {
  if (!fs.existsSync(JOURNAL)) return { exists: false };
  const file = JSON.parse(fs.readFileSync(CANON, "utf8"));
  const collapse = collapseByTicket(file);
  const have = new Map();   // ticket id -> the closedAt the journal sealed for it (the FIRST it saw; a sealed row never moves)
  for (const line of fs.readFileSync(JOURNAL, "utf8").split("\n")) { if (!line.trim()) continue; try { const r = JSON.parse(line); if (r && r.id && !have.has(r.id)) have.set(r.id, r.closedAt ?? null); } catch {} }
  const settled = collapse.rows.filter((t) => t && t.id && t.closedAt && Number.isFinite(t.pnl));
  const missing = settled.filter((t) => !have.has(t.id));
  const missingR = missing.filter((t) => Number.isFinite(t.rMult)).map((t) => t.rMult);
  // the journal seals the row it saw FIRST and never moves it, so a ticket whose close was voided AFTER it was
  // journaled sits in the journal under the superseded close. Said here; repairing the journal is not a reader's
  // to do (ledger-journal.js is append-only by design — NOTES.md, "What this package does not touch").
  const journaledUnderSuperseded = settled.filter((t) => have.has(t.id) && have.get(t.id) !== (t.closedAt ?? null)).map((t) => t.id);
  return { exists: true, journalRows: have.size, settledInCanon: settled.length, settledRowsInCanon: file.filter((t) => t && t.id && t.closedAt && Number.isFinite(t.pnl)).length,
    duplicateTicketIds: collapse.duplicates.length, journaledUnderSupersededClose: journaledUnderSuperseded.slice(0, 10), journaledUnderSupersededCount: journaledUnderSuperseded.length,
    missing: missing.length,
    missingIds: missing.slice(0, 10).map((t) => t.id),
    missingMeanR: missingR.length ? +mean(missingR).toFixed(4) : null,
    note: missing.length ? "Journal is behind. Run backend/ledger-journal.js. Do NOT analyse from the journal while it lags — the absent rows are the newest, not a random sample." : "journal current" };
}

/**
 * assertReconciled — compare a value an analysis computed against the canonical one.
 * Throws by default. An analysis that cannot reconcile has no business printing a number.
 */
/**
 * recomputeEdge(L): the pooled edge re-derived from L's own rows with a second, independent implementation of the mean — so an
 * analysis can pass something that is NOT the canonical number itself. 2026-09-04 (settle lens): ten scripts called
 * assertReconciled("...", L.pooledEdgeR, L.pooledEdgeR) — a value compared to itself, always RECONCILED — and two passed a single
 * argument (computed and expected both undefined -> always RECONCILED). This helper is the least a caller may pass; a script that
 * filters its own population should pass its OWN count or mean instead (ml-daily.js:176-179 is the model).
 */
/** A ticket has a REAL stop distance: options wings carry entry === stopDist by construction (stopPct identically 100). 2026-09-04 cost lens. */
function hasRealStop(t) { return t && t.cls !== "Options" && t.stopDist > 0 && t.entry > 0 && Math.abs(100 * t.stopDist / t.entry - 100) > 1e-9; }
function recomputeEdge(L) {
  if (!L || !Array.isArray(L.signals) || !Array.isArray(L.controls)) return undefined;
  let s = 0, c = 0; for (const t of L.signals) s += t.rMult; for (const t of L.controls) c += t.rMult;
  if (!L.signals.length || !L.controls.length) return null;
  return +((s / L.signals.length) - (c / L.controls.length)).toFixed(4);
}
function assertReconciled(quantity, computed, expected, opts = {}) {
  const tol = opts.tolerance ?? 1e-6;
  const ok = expected == null ? computed == null : Math.abs(computed - expected) <= tol;
  const line = `${ok ? "RECONCILED" : "MISMATCH"}  ${quantity}: computed ${computed}, canonical ${expected}${ok ? "" : `  (tolerance ${tol})`}`;
  if (!ok && !opts.warnOnly) {
    throw new Error(`${line}\n  The canonical read is lib/reconcile.js cleanEraLedger(), source data/trade_log.json, epoch 2026-07-20.\n  Fix the analysis, or state in the script WHY it legitimately differs.`);
  }
  if (opts.log !== false) console.log(`  ${line}`);
  return ok;
}

/**
 * KNOWN AMBIGUITIES — questions the canonical read does NOT settle, surfaced rather than absorbed.
 *
 * The canonical figure above matches src/App.jsx exactly, which means it INCLUDES six rows tagged
 * strategy "R24-13F-clone": settled equity tickets carrying a finite rMult but pnl null, averaging
 * -1.0515R. They are a separate registered experiment, not board setups, and they are the entire
 * reason the ledger mean reads -0.0248 rather than -0.0174. They are also why the append-only
 * journal never sees them: ledger-journal.js requires a finite pnl to append.
 *
 * Whether an experiment's shadow tickets belong in the board's own signal-vs-control ledger is an
 * accounting decision for the operator, not for an analysis script. Until it is decided, both
 * figures are reported and neither is presented as the answer.
 */
function knownAmbiguities() {
  const file = JSON.parse(fs.readFileSync(CANON, "utf8"));
  const collapse = collapseByTicket(file);   // one row per ticket, as cleanEraLedger() reads it (2026-10-16)
  const log = collapse.rows;
  const clean = log.filter((t) => t && Number.isFinite(t.rMult) && t.closedAt >= CLEAN_EPOCH && !t.ctrl);
  const noPnl = clean.filter((t) => !Number.isFinite(t.pnl));
  const withPnl = clean.filter((t) => Number.isFinite(t.pnl));
  const byStrategy = {};
  for (const t of noPnl) byStrategy[t.strategy || "(none)"] = (byStrategy[t.strategy || "(none)"] || 0) + 1;
  return [{
    id: "rmult-without-pnl",
    question: "Do experiment shadow tickets (finite rMult, pnl null) belong in the board's signal ledger?",
    affects: noPnl.length, strategies: byStrategy,
    meanRofAffected: noPnl.length ? +mean(noPnl.map((t) => t.rMult)).toFixed(4) : null,
    ledgerMeanIncluding: +mean(clean.map((t) => t.rMult)).toFixed(4),
    ledgerMeanExcluding: withPnl.length ? +mean(withPnl.map((t) => t.rMult)).toFixed(4) : null,
    canonicalChoice: "RESOLVED 2026-08-25: EXCLUDED. A settled row must carry a finite pnl to enter the board's P&L ledger. src/App.jsx applies the same filter, and backend/ledger-journal.js already required it — three readers, one definition.",
    resolvedBy: "operator, 2026-08-25; recorded in the change registry under accounting",
    forOperator: "Experiment sleeves keep their own books and their own registered bars. If a future sleeve is meant to settle into the board's P&L, give it a real pnl rather than relaxing this filter.",
  }, (() => {
    // RETIRED ROWS — raised 2026-08-26, deliberately NOT resolved by the author who raised it.
    //
    // A row can carry a `retired` tag when its inputs are found to be unreal: D48-model-ruler (6
    // rows priced under a hardcoded-IV Black-Scholes model with no real legs) and D49-jup-price-scale
    // (2 rows whose JUP/USD prices disagree with each other by ~15x on the same symbol the same
    // session, and neither of which is a JUP price — it trades near $0.30-0.60).
    //
    // cleanEraLedger() does NOT exclude them, and this entry exists because the author who tagged
    // the JUP rows noticed that excluding them moves the signal book from -0.0193R to -0.0172R —
    // i.e. IN THE FLATTERING DIRECTION. Dropping rows that hurt the number is the single most
    // self-serving edit available in a ledger, and it is not a call the person holding the tagging
    // pen should make quietly. Both figures are printed; the operator chooses.
    //
    // The argument FOR excluding: a price that was never real cannot inform a P&L, and leaving it in
    // means the book is partly measuring a data bug. The argument AGAINST: 'this row is unreal' is a
    // judgement, every such judgement so far has happened to help, and a ledger that drops its worst
    // rows on the tagger's say-so stops being evidence. Neither is obviously right.
    const settled = log.filter((t) => t && Number.isFinite(t.rMult) && Number.isFinite(t.pnl) && t.closedAt >= CLEAN_EPOCH && !t.ctrl);
    const ret = settled.filter((t) => t.retired);
    const kept = settled.filter((t) => !t.retired);
    const byTag = {};
    for (const t of ret) (byTag[t.retired] ||= { n: 0, sumR: 0, pnl: 0 }), byTag[t.retired].n++, byTag[t.retired].sumR += t.rMult, byTag[t.retired].pnl += t.pnl;
    for (const k of Object.keys(byTag)) { byTag[k].sumR = +byTag[k].sumR.toFixed(2); byTag[k].pnl = Math.round(byTag[k].pnl); }
    return {
      id: "retired-rows", strategies: byTag, meanRofAffected: ret.length ? +mean(ret.map((t) => t.rMult)).toFixed(4) : null,
      question: "Should rows tagged `retired` (inputs found to be unreal) be excluded from the canonical signal ledger?",
      affects: ret.length, byTag,
      ledgerMeanIncluding: +mean(settled.map((t) => t.rMult)).toFixed(4),
      ledgerMeanExcluding: kept.length ? +mean(kept.map((t) => t.rMult)).toFixed(4) : null,
      directionOfExclusion: "FLATTERING — excluding retired rows IMPROVES the reported book",
      canonicalChoice: "RESOLVED 2026-08-26 by the operator: EXCLUDED. cleanEraLedger() now drops validly-retired rows, and src/App.jsx matches. A tag counts ONLY if the row carries a retireNote naming a root cause AND the tag id appears in the append-only change-registry — a bare flag excludes nothing and is reported under retireTagsIGNORED. That guard is the point: excluding retired rows moves the book in the FLATTERING direction, so dropping a bad day must leave a permanent dated public record of having done it.",
      forOperator: "Decide once, record it in the change registry, and make every reader obey it. If the answer is EXCLUDE, the tag must require a named root cause and a change-registry entry before it counts — otherwise `retired` becomes a way to delete inconvenient losses.",
    };
  })(), (() => {
    /**
     * A VOID TAG CARRIED ONTO THE SURVIVING ROW — raised 2026-10-16 by the wings double-count fix, and
     * deliberately NOT resolved here.
     *
     * The collapse above makes a revoided-and-re-settled ticket count ONCE instead of twice. It cannot
     * decide whether that one row counts at all. backend/options-settle.js copies `retired`, `retireNote`
     * and `voidForEvidence` from the OPEN board position onto the settle row it writes. If the board row
     * of a voided-and-restored wing still carried the void tag, the EXPIRY settle — the real close, the
     * one that moved money — inherited it, and the retired-row rule above then excludes it. The ticket
     * would go from counting twice to counting ZERO times, and both are wrong.
     *
     * Which it is depends on bytes in data/, not on code: it is the rows listed here, or none. This is
     * reported, never guessed at. The repair, if the list is non-empty, is a data repair with the
     * operator's word on it — a settle row that is the surviving close of a restored ticket should not
     * carry the predecessor's void tag — and it is not a reader's to make.
     */
    const settled = log.filter((t) => t && Number.isFinite(t.rMult) && Number.isFinite(t.pnl) && t.closedAt >= CLEAN_EPOCH);
    const droppedById = new Map(); for (const r of collapse.dropped) if (r && r.id) droppedById.set(r.id, r);
    const affected = settled.filter((t) => t.retired && t.voidForEvidence === true && droppedById.has(t.id) && droppedById.get(t.id).retired === t.retired);
    const byStrategy = {}; for (const t of affected) byStrategy[t.strategy || "(none)"] = (byStrategy[t.strategy || "(none)"] || 0) + 1;
    return {
      id: "void-tag-on-surviving-close", strategies: byStrategy,
      question: "A ticket whose voided close was superseded: does its surviving settle row carry the predecessor's void tag, and so count zero times?",
      affects: affected.length, ids: affected.slice(0, 20).map((t) => t.id),
      meanRofAffected: affected.length ? +mean(affected.map((t) => t.rMult)).toFixed(4) : null,
      pnlOfAffected: affected.length ? Math.round(affected.reduce((s, t) => s + t.pnl, 0)) : 0,
      ledgerMeanIncluding: settled.length ? +mean(settled.map((t) => t.rMult)).toFixed(4) : null,
      ledgerMeanExcluding: null,
      directionOfExclusion: "UNKNOWN until the list is read — it is whatever those tickets did",
      canonicalChoice: "OPEN. The collapse makes such a ticket count at most once; whether it counts at all is the retired-row rule's answer, and that rule is the operator's. Nothing here edits a row.",
      forOperator: "If this list is non-empty, those settle rows inherited a void tag from the board row of a restored wing and are being excluded as retired. Clear the tag on the SURVIVING close only, with a change-registry entry naming this defect, or state that they stay excluded. Do not relax the retired-row rule to reach them.",
    };
  })()];
}

module.exports = { recomputeEdge, hasRealStop, CLEAN_EPOCH, cleanEraLedger, episodes, deClusteredEdge, journalLag, assertReconciled, knownAmbiguities };

// CLI: node backend/lib/reconcile.js — print the canonical figures and every known divergence
if (require.main === module) {
  const L = cleanEraLedger(), J = journalLag();
  console.log(`CANONICAL CLEAN-ERA LEDGER  (${L.source}, epoch ${L.epoch})`);
  console.log(`  rows in file ${L.rowsInFile} · ${L.ticketsLine}`);
  console.log(`  settled since epoch ${L.settled}`);
  console.log(`  signals n=${L.n}  meanR ${L.meanR}  win ${L.winRatePct}%`);
  console.log(`  controls n=${L.controlN}  meanR ${L.controlMeanR}`);
  console.log(`  POOLED EDGE  ${L.pooledEdgeR >= 0 ? "+" : ""}${L.pooledEdgeR}R`);
  console.log(`\nJOURNAL (data/trade_log.jsonl, append-only shadow)`);
  if (!J.exists) console.log(`  not present`);
  else {
    console.log(`  journal entries ${J.journalRows} · settled TICKETS in canon ${J.settledInCanon} (rows ${J.settledRowsInCanon}; ${J.duplicateTicketIds} ticket id(s) hold more than one row) · MISSING ${J.missing}`);
    if (J.missing) console.log(`  missing rows mean ${J.missingMeanR}R — ${J.missingIds.slice(0, 6).join(", ")}`);
    if (J.journaledUnderSupersededCount) console.log(`  ${J.journaledUnderSupersededCount} ticket(s) sealed in the journal under a SUPERSEDED close — the journal cannot be rewritten; read those tickets from the JSON: ${J.journaledUnderSupersededClose.join(", ")}`);
    console.log(`  ${J.note}`);
  }
  console.log(`
KNOWN AMBIGUITIES — surfaced, not absorbed`);
  for (const a of knownAmbiguities()) {
    console.log(`  [${a.id}] ${a.question}`);
    console.log(`     affects ${a.affects} row(s) ${JSON.stringify(a.strategies)} · mean ${a.meanRofAffected}R`);
    console.log(`     ledger mean INCLUDING ${a.ledgerMeanIncluding} · EXCLUDING ${a.ledgerMeanExcluding}`);
    console.log(`     canonical: ${a.canonicalChoice}`);
    console.log(`     for the operator: ${a.forOperator}`);
  }
}
