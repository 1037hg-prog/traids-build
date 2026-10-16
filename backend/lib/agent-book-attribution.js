/**
 * AGENT BOOK ATTRIBUTION — is a ticket a HEDGE of the main book, or a STANDALONE bet?
 *
 * WHY THIS EXISTS, and why it exists BEFORE the record accrues rather than after.
 *
 * The agent book is benchmarked against the main book on shared sessions. But the first three
 * tickets the agents ever opened were all SHORTS against the main book's own factor concentration
 * — XLV and XLK from portfolio-manager citing the R53 cap breach verbatim, XLRE from head-trader
 * as a directional-concentration hedge. That is a defensible first move and arguably the correct
 * one. It is also anti-correlated with the main book BY CONSTRUCTION.
 *
 * Which means: on any day the main book loses, a hedging agent book wins, and "the agents beat
 * the main book" becomes close to tautological. It would be evidence of nothing except that a
 * hedge hedges. A month from now that number will be read as a verdict on whether the seats have
 * skill, and by then it is too late to ask what it measured.
 *
 * So every agent ticket is classified at settle:
 *   HEDGE      — the main book carried OPPOSITE-direction exposure in the same symbol or the same
 *                sector group at the moment this ticket was opened. Its P&L is a mirror of the
 *                main book's and is NOT evidence of selection skill.
 *   STANDALONE — no offsetting main-book exposure. This is the only arm that can carry an alpha
 *                claim.
 *   UNKNOWN    — the main book's state at that instant could not be established. Counted, never
 *                guessed, and never silently folded into either arm.
 *
 * The three arms are reported separately and the combined figure is reported alongside, never
 * instead. A hedge that pays is a real dollar and belongs in the total; it just cannot be cited
 * as the agents picking better.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "..", "data", f);

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return d; } };
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** sector ETF <-> constituent mapping, so an XLV short is seen to offset a REGN long */
function sectorOf(sym, map) {
  if (!sym) return null;
  if (/^XL[A-Z]{1,2}$|^SMH$|^XBI$|^IBB$|^KRE$/.test(sym)) return sym;   // the ETF is its own group — 2026-09-04: XLRE/XLC are four letters; the head-trader's self-declared REIT hedge was the agent book's only "STANDALONE" alpha row because this regex missed it
  const m = map && map[sym];
  return (m && (m.etf || m.sector)) || null;
}

/**
 * Classify one agent ticket against the main book as it stood when the ticket opened.
 * `mainRows` = trade_log rows plus current board rows, so a position open at that instant counts
 * whether or not it has settled since.
 */
function classify(ticket, mainRows, sectorMap) {
  const t0 = ticket.openedAt;
  if (!Number.isFinite(t0)) return { arm: "UNKNOWN", why: "ticket has no openedAt" };
  const day = etDay(t0);

  // main-book exposure live at that moment: opened at or before, and not yet closed
  const live = mainRows.filter((r) => {
    if (!r || !r.sym || !Number.isFinite(r.openedAt || r.addedAt)) return false;
    if (r.vetoShadow || r.ctrl) return false;                          // shadows and controls are not exposure
    const o = r.openedAt || r.addedAt;
    return o <= t0 && (!r.closedAt || r.closedAt > t0);
  });
  if (!live.length) return { arm: "STANDALONE", why: `main book carried no live exposure at ${day}`, offsets: 0 };

  const aDir = Math.sign(ticket.dir) || 1;
  const aSector = sectorOf(ticket.sym, sectorMap);

  const sameSym = live.filter((r) => r.sym === ticket.sym && Math.sign(r.dir || 1) === -aDir);
  const sameSector = aSector ? live.filter((r) => sectorOf(r.sym, sectorMap) === aSector && Math.sign(r.dir || 1) === -aDir) : [];

  if (sameSym.length) return { arm: "HEDGE", why: `main book held ${sameSym.length} opposite-direction ticket(s) in ${ticket.sym}`, offsets: sameSym.length, basis: "symbol" };
  if (sameSector.length) return { arm: "HEDGE", why: `main book held ${sameSector.length} opposite-direction ticket(s) in ${aSector}`, offsets: sameSector.length, basis: "sector" };
  return { arm: "STANDALONE", why: `no opposite-direction main-book exposure in ${ticket.sym}${aSector ? " or " + aSector : ""}`, offsets: 0 };
}

/** Classify a whole ledger. Returns rows tagged with their arm plus per-arm summaries. */
function attribute(agentRows) {
  const sectorMap = readJson("sector-map.json", {});
  const log = readJson("trade_log.json", []);
  const board = readJson("board_positions.json", []);
  const mainRows = [...(Array.isArray(log) ? log : []), ...(Array.isArray(board) ? board : [])];

  const tagged = agentRows.map((t) => ({ ...t, attribution: classify(t, mainRows, sectorMap) }));
  const arm = (a) => tagged.filter((t) => t.attribution.arm === a);
  const sum = (rows) => rows.reduce((s, t) => s + (t.pnl || 0), 0);
  const stat = (rows) => ({
    n: rows.length, pnl: +sum(rows).toFixed(2),
    wins: rows.filter((t) => (t.pnl || 0) > 0).length,
    winPct: rows.length ? +(100 * rows.filter((t) => (t.pnl || 0) > 0).length / rows.length).toFixed(1) : null,
    meanR: rows.length ? +(rows.reduce((s, t) => s + (t.rMult || 0), 0) / rows.length).toFixed(4) : null,
  });

  return {
    tagged,
    hedge: stat(arm("HEDGE")),
    standalone: stat(arm("STANDALONE")),
    unknown: stat(arm("UNKNOWN")),
    combined: stat(tagged),
    reading: "STANDALONE is the only arm that can carry an alpha claim. HEDGE P&L mirrors the main book by construction — a hedge that pays is a real dollar and belongs in COMBINED, but it is never evidence that a seat picked better.",
  };
}

module.exports = { classify, attribute, sectorOf };
