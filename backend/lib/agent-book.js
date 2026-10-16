/**
 * AGENT BOOK — a separate paper book the escrowed agents actually trade.
 *
 * OPERATOR DIRECTIVE 2026-08-28: "we have to let them loose; we have too much of a system to
 * sit on our hands now." He is right, and the escrow was never really about risk — this is a
 * paper book. On paper, ACTING IS GRADING: an executed paper ticket produces strictly more
 * evidence than a sealed WOULD-DO memo because it also tests sizing, timing and interaction.
 *
 * THE ONE THING THE ESCROW WAS ACTUALLY PROTECTING is the RECORD, and this file is how that
 * protection survives the agents being let loose. Fifty registered tests, the R49/R53 gate
 * reads, the Sep 23 unlock cluster and the FD1 funding decision all read data/trade_log.json.
 * If agents opened tickets into it, none of those reads could separate "the strategy worked"
 * from "an agent intervened" — the same defect that makes a vendor with moving entries
 * unauditable. So the agents get their own book, their own capital and their own ledger, and
 * this module physically cannot write into the measurement book:
 *
 *   ISOLATION INVARIANT — asserted on every write, not merely intended:
 *     · positions  -> data/agent-book.json          (never board_positions.json)
 *     · settles    -> data/agent-book-ledger.jsonl  (never trade_log.json)
 *     · assertIsolation() throws if either canonical path is ever the target.
 *
 * Same risk policy as the main book (0.25% base, the same class multipliers, the same 0.5R
 * cap) so the two are directly comparable, and the main book is the benchmark. Different
 * numbers under a different policy would prove nothing.
 *
 * ATTRIBUTION IS MANDATORY. Every ticket records which agent opened it and the reason. An
 * unattributed ticket is refused — without that the book grades "the agents" as a blob and
 * you learn nothing about which seat is worth keeping.
 *
 * PAPER ONLY. Nothing here touches a broker. There is no order path in this file and there is
 * not meant to be one.
 */
const fs = require("fs"), path = require("path");
const RP = require("./risk-policy.js");

const D = (f) => path.join(__dirname, "..", "data", f);
const BOOK = D("agent-book.json");
const LEDGER = D("agent-book-ledger.jsonl");
const CANON_POS = D("board_positions.json");
const CANON_LOG = D("trade_log.json");

const CAPITAL = Number(process.env.AGENT_BOOK_CAPITAL || 100000);
const AUTHORIZED = new Set(["head-trader", "trade-ranker", "portfolio-manager", "news-trader", "stop-manager"]);

const etDay = (ms = Date.now()) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** Throws if a write would land in the measurement book. Called before every write. */
function assertIsolation(target) {
  const t = path.resolve(target);
  if (t === path.resolve(CANON_POS) || t === path.resolve(CANON_LOG))
    throw new Error("ISOLATION VIOLATION: the agent book attempted to write the measurement book (" + target + "). Refused.");
  return t;
}

const readBook = () => { try { const j = JSON.parse(fs.readFileSync(BOOK, "utf8")); return Array.isArray(j.open) ? j : { open: [], capital: CAPITAL, opened: 0, closed: 0 }; } catch { return { open: [], capital: CAPITAL, opened: 0, closed: 0 }; } };
const writeBook = (b) => { fs.writeFileSync(assertIsolation(BOOK), JSON.stringify(b, null, 2)); };
const readLedger = () => { try { return fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

/** Risk dollars for one ticket, under the SAME policy the main book uses. */
function riskDollars(cls) {
  const pct = RP.policyStakePct(cls);                       // e.g. 0.15 for Futures = 0.15%
  return +(CAPITAL * (pct / 100)).toFixed(2);
}

/**
 * Open a ticket. Attribution is required; sizing comes from the shared risk policy so the
 * agent book is comparable to the main book rather than flattered by a different one.
 */
/**
 * sizeMult (2026-09-03, operator: "read r56 and apply it to sizing"): an optional multiplier on the
 * policy risk, clamped to [0.5, 1.5] — the board's own 0.5R convention — so a seat can size a ticket
 * inversely to its predicted cost WITHOUT changing the policy itself. The flat policy risk is stamped
 * beside the applied risk on every ticket, so cost-sized vs flat P&L is computable on the same rows.
 * Callers keep the day's total risk constant by renormalising their multipliers; this function does
 * not, because it sees one ticket at a time.
 */
function open({ agent, sym, cls, dir, entry, stop, reason, meta, sizeMult }) {
  if (!AUTHORIZED.has(agent)) throw new Error(`agent "${agent}" is not authorized on this book — authorized: ${[...AUTHORIZED].join(", ")}`);
  if (!sym || !cls || !Number.isFinite(entry) || !Number.isFinite(stop)) throw new Error("open() needs sym, cls, finite entry and finite stop");
  if (!reason || String(reason).trim().length < 12) throw new Error("every agent ticket must carry a REASON — an unattributed book teaches nothing about which seat is worth keeping");
  const d = Math.sign(dir) || 1;
  const stopDist = Math.abs(entry - stop);
  if (!(stopDist > 0)) throw new Error("stop must differ from entry");
  const flat = riskDollars(cls);
  const mult = Number.isFinite(sizeMult) ? Math.min(1.5, Math.max(0.5, sizeMult)) : 1;
  const rd = +(flat * mult).toFixed(2);
  const b = readBook();
  const t = {
    id: `${Date.now()}-${cls}-${sym}-${Math.random().toString(36).slice(2, 6)}`,
    agent, sym, cls, dir: d, entry: +entry, stop: +stop, stopDist: +stopDist.toFixed(6),
    target: +(entry + d * stopDist).toFixed(6),               // 1:1 unless an agent closes it sooner
    riskDollars: rd, qty: +(rd / stopDist).toFixed(6),
    flatRiskDollars: flat, sizeMult: mult,                     // the policy size and what was applied to it
    openedAt: Date.now(), openedDay: etDay(), reason: String(reason), meta: meta || null,
    book: "AGENT", paper: true,
  };
  b.open.push(t); b.opened = (b.opened || 0) + 1;
  writeBook(b);
  return t;
}

/** Close a ticket and append it to the agent ledger. `by` records who closed it. */
function close({ id, exit, reason, by }) {
  const b = readBook();
  const i = b.open.findIndex(t => t && t.id === id);
  if (i < 0) throw new Error("no open agent ticket with id " + id);
  const t = b.open[i];
  if (!Number.isFinite(exit)) throw new Error("close() needs a finite exit");
  const pnl = (exit - t.entry) * t.dir * t.qty;
  const row = { ...t, exit: +exit, closedAt: Date.now(), closedDay: etDay(), exitReason: reason || "close",
    closedBy: by || t.agent, pnl: +pnl.toFixed(2), rMult: +(((exit - t.entry) * t.dir) / t.stopDist).toFixed(4) };
  b.open.splice(i, 1); b.closed = (b.closed || 0) + 1;
  writeBook(b);
  fs.appendFileSync(assertIsolation(LEDGER), JSON.stringify(row) + "\n");
  return row;
}

/** Book state + performance, and the same statistic the main book is judged on. */
function state() {
  const b = readBook(), L = readLedger();
  const realized = L.reduce((s, r) => s + (r.pnl || 0), 0);
  const byDay = {};
  for (const r of L) (byDay[r.closedDay] ||= []).push(r.rMult);
  const dayMeans = Object.values(byDay).map(a => a.reduce((x, y) => x + y, 0) / a.length);
  const k = dayMeans.length;
  const mu = k ? dayMeans.reduce((x, y) => x + y, 0) / k : null;
  const sd = k > 1 ? Math.sqrt(dayMeans.reduce((s, x) => s + (x - mu) ** 2, 0) / (k - 1)) : 0;
  const byAgent = {};
  for (const r of L) {
    const a = (byAgent[r.agent] ||= { agent: r.agent, n: 0, pnl: 0, wins: 0 });
    a.n++; a.pnl += r.pnl || 0; if ((r.pnl || 0) > 0) a.wins++;
  }
  return {
    capital: CAPITAL, open: b.open.length, settled: L.length, sessions: k,
    realizedDollars: +realized.toFixed(2),
    meanR: L.length ? +(L.reduce((s, r) => s + (r.rMult || 0), 0) / L.length).toFixed(4) : null,
    winRatePct: L.length ? +(100 * L.filter(r => (r.pnl || 0) > 0).length / L.length).toFixed(1) : null,
    dayClusteredT: sd > 0 ? +(mu / (sd / Math.sqrt(k))).toFixed(3) : null,
    byAgent: Object.values(byAgent).map(a => ({ ...a, pnl: +a.pnl.toFixed(2), winPct: +(100 * a.wins / a.n).toFixed(1) })).sort((x, y) => y.pnl - x.pnl),
  };
}

module.exports = { open, close, state, readBook, readLedger, riskDollars, assertIsolation, AUTHORIZED, CAPITAL, BOOK, LEDGER };
