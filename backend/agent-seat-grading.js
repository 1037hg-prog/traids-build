#!/usr/bin/env node
/**
 * AGENT SEAT GRADING — a per-seat OUTCOME record, not an activity count. 2026-08-29.
 * Writes data/agent-seat-grading.json. Runs in the close chain.
 *
 * WHY THIS EXISTS.
 *
 * The operator asked whether the agents are trained. They are not: all 27 seats are markdown
 * briefs handed to an LLM each run, with no weights, no fitted parameters, and nothing that
 * updates from outcomes. Not one seat consumes a model we have trained, and none feeds one.
 *
 * Two things already track the seats and NEITHER grades them:
 *   agent-pnl-accountability.json  counts INTERVENTIONS by kind (98 measurement, 3 trading,
 *                                  23 governance) and asks "did this seat submit or decline?".
 *                                  That is participation, not correctness.
 *   head-trader-memo-grading.draft  a DRAFT (HT1), never registered, covering ONE seat's memos.
 *
 * So nothing anywhere answers "was this seat RIGHT". This file is that record, and it starts
 * accruing now rather than being discovered missing in October when someone asks which seat to
 * trust. A scoreboard built after the fact is a scoreboard built knowing the answer.
 *
 * ═══ THE HARD PART IS WHAT COUNTS AS GRADEABLE ═══
 *
 * Most seats do not trade. They audit, measure, and write. A MEASUREMENT is never reportable as
 * trading improvement — that is a standing rule here and this file does not soften it. So seats
 * are sorted into what they actually produced:
 *
 *   TRADED       opened agent-book tickets. Graded on settled outcomes: n, win rate, mean R,
 *                dollars, day-clustered t, and the HEDGE / STANDALONE split — because a hedging
 *                seat beats the main book whenever the main book loses, which proves nothing
 *                about selection.
 *   PROPOSED     put a candidate into the human-gated queue. Graded on the pipeline it reached:
 *                submitted -> approved -> promoted. A proposal nobody approved is not a failure;
 *                a proposal that was promoted and then lost money is.
 *   CLAIMED      logged a TRADING-kind intervention. Gradeable in principle, and counted, but a
 *                claim with no settled ticket behind it scores nothing.
 *   NOT GRADEABLE  produced only measurement or governance. Reported as exactly that. This is
 *                the majority and the file says so plainly instead of inventing a score.
 *
 * ═══ IT WILL READ MOSTLY EMPTY TODAY, AND THAT IS THE POINT ═══
 *
 * The agent book has 3 open tickets and 0 settled. Every seat therefore grades as ACCRUING or
 * NOTHING GRADEABLE right now. Printing that daily is the honest state of affairs and is what
 * makes the gap visible; a grader that manufactured a number from 0 settled rows would be worse
 * than no grader.
 *
 * IT CHANGES NOTHING. No seat gains or loses authority from this file. Authority moves only
 * through a registered read at a pre-committed bar.
 *
 * Usage:  node backend/agent-seat-grading.js
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const J = (f, d) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return d; } };
const L = (f) => { try { return fs.readFileSync(D(f), "utf8").trim().split(/\r?\n/).filter(Boolean).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean); } catch { return []; } };

let ATTR = null; try { ATTR = require("./lib/agent-book-attribution.js"); } catch { }
let CLAIMS = null; try { CLAIMS = require("./lib/seat-claims.js"); } catch { }
let SEAL = null; try { SEAL = require("./lib/seat-seal.js"); } catch { }

const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const dayT = (rows, val) => {
  const by = new Map();
  for (const r of rows) { const d = r.closedDay || etDay(r.closedAt); if (!by.has(d)) by.set(d, []); by.get(d).push(val(r)); }
  const dm = [...by.values()].map(mean).filter(Number.isFinite);
  if (dm.length < 2 || sd(dm) === 0) return null;
  return +(mean(dm) / (sd(dm) / Math.sqrt(dm.length))).toFixed(3);
};

// ---- the roster: every seat that exists, so a silent seat cannot hide by absence ---------------
const roster = (() => {
  try { return fs.readdirSync(path.join(__dirname, "..", ".claude", "agents")).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort(); }
  catch { return []; }
})();

// ---- inputs -------------------------------------------------------------------------------------
const settled = L("agent-book-ledger.jsonl");
const book = J("agent-book.json", { open: [] });
const open = book.open || [];
const interventions = L("agent-ledger.jsonl");
const queueDoc = J("candidate-queue.json", {});
const proposals = Array.isArray(queueDoc) ? queueDoc : (queueDoc.proposals || []);

const attributed = (ATTR && settled.length) ? ATTR.attribute(settled).tagged : [];
const armOf = new Map(attributed.map((t) => [t.id, t.attribution && t.attribution.arm]));

// ---- grade each seat ----------------------------------------------------------------------------
const seats = {};
const seatOf = (n) => (seats[n] = seats[n] || {
  seat: n, settledTickets: 0, openTickets: 0, wins: 0, pnl: 0, rs: [], rows: [],
  armSettled: { HEDGE: 0, STANDALONE: 0, UNKNOWN: 0 },
  interventions: 0, byKind: {}, proposals: 0, approved: 0, promoted: 0, lastActiveAt: null,
});

for (const n of roster) seatOf(n);

for (const t of settled) {
  const s = seatOf(t.agent || t.by || "(unattributed)");
  s.settledTickets++; s.pnl += Number(t.pnl) || 0;
  if ((t.pnl || 0) > 0) s.wins++;
  if (Number.isFinite(t.rMult)) s.rs.push(t.rMult);
  s.rows.push(t);
  const arm = armOf.get(t.id) || "UNKNOWN";
  s.armSettled[arm] = (s.armSettled[arm] || 0) + 1;
}
for (const t of open) seatOf(t.agent || "(unattributed)").openTickets++;

for (const iv of interventions) {
  const s = seatOf(iv.agent || "(unattributed)");
  s.interventions++;
  s.byKind[iv.kind || "?"] = (s.byKind[iv.kind || "?"] || 0) + 1;
  if (!s.lastActiveAt || iv.at > s.lastActiveAt) s.lastActiveAt = iv.at;
}
for (const p of proposals) {
  const s = seatOf(p.agent || p.author || p.source || "(unattributed)");
  s.proposals++;
  const st = String(p.status || "").toLowerCase();
  if (/approv/.test(st)) s.approved++;
  if (/promot/.test(st)) s.promoted++;
}

// ---- classify -----------------------------------------------------------------------------------
const CLASSES = {
  GRADED: "settled tickets exist — an outcome record is accruing",
  ACCRUING: "has open tickets or queued proposals, nothing settled yet",
  CLAIMED_ONLY: "logged TRADING-kind interventions but has opened no ticket",
  NOT_GRADEABLE: "produced only measurement or governance — never reportable as trading improvement",
  SILENT: "no interventions, no tickets, no proposals in the record at all",
};
const out = [];
for (const n of Object.keys(seats).sort()) {
  const s = seats[n];
  const trading = s.byKind.TRADING || 0;
  let cls;
  if (s.settledTickets > 0) cls = "GRADED";
  else if (s.openTickets > 0 || s.proposals > 0) cls = "ACCRUING";
  else if (trading > 0) cls = "CLAIMED_ONLY";
  else if (s.interventions > 0) cls = "NOT_GRADEABLE";
  else cls = "SILENT";
  out.push({
    seat: s.seat, classification: cls, why: CLASSES[cls],
    settledTickets: s.settledTickets, openTickets: s.openTickets,
    winPct: s.settledTickets ? +(100 * s.wins / s.settledTickets).toFixed(1) : null,
    pnl: +s.pnl.toFixed(2),
    meanR: s.rs.length ? +mean(s.rs).toFixed(4) : null,
    dayClusteredT: s.rows.length ? dayT(s.rows, (r) => r.rMult) : null,
    armSettled: s.armSettled,
    alphaClaimable: s.armSettled.STANDALONE > 0 ? s.armSettled.STANDALONE : 0,
    claim: CLAIMS ? CLAIMS.gradability(s.seat) : null,
    interventions: s.interventions, byKind: s.byKind,
    proposals: s.proposals, approved: s.approved, promoted: s.promoted,
    lastActiveAt: s.lastActiveAt,
  });
}
const tally = out.reduce((a, s) => { a[s.classification] = (a[s.classification] || 0) + 1; return a; }, {});

const doc = {
  spec: "agent-seat-grading-v1", asOf: new Date().toISOString(),
  question: "Was this seat RIGHT — not was it busy.",
  contract: "Grades outcomes only. A MEASUREMENT or GOVERNANCE intervention is never reportable as trading improvement, and this file does not relabel one as the other. No seat gains or loses authority from this record; authority moves only through a registered read at a pre-committed bar.",
  distinctFrom: {
    "agent-pnl-accountability.json": "counts interventions by kind and asks whether a seat submitted or declined — participation, not correctness",
    "head-trader-memo-grading.draft.json": "a DRAFT (HT1), never registered, covering one seat's memos only",
  },
  sealLedger: SEAL ? { chain: SEAL.verify() || "intact", sealed: SEAL.readAll().length, due: SEAL.due().length, perSeat: SEAL.tally() } : null,
  seatsOnRoster: roster.length,
  tally,
  honestState: settled.length === 0
    ? "NOTHING IS GRADED YET. The agent book holds " + open.length + " open ticket(s) and 0 settled, so every seat reads ACCRUING, NOT GRADEABLE or SILENT. That is the true state; a number manufactured from zero settled rows would be worse than none."
    : settled.length + " settled ticket(s) across the seats that trade.",
  armNote: "STANDALONE is the only arm that can carry an alpha claim. A hedging seat beats the main book whenever the main book loses, which proves nothing about selection.",
  seats: out,
};
writeJsonAtomic(D("agent-seat-grading.json"), doc);

// ---- report -------------------------------------------------------------------------------------
console.log("AGENT SEAT GRADING — was the seat right, not was it busy");
console.log("  roster " + roster.length + " seats · " + settled.length + " settled ticket(s) · " + open.length + " open");
console.log("  " + Object.entries(tally).map(([k, v]) => v + " " + k).join(" · "));
console.log("");
console.log("  seat                        class           settled  win%   $        meanR    day-t   standalone");
for (const s of out) {
  if (s.classification === "SILENT" || s.classification === "NOT_GRADEABLE") continue;
  console.log("  " + s.seat.padEnd(27) + s.classification.padEnd(16) +
    String(s.settledTickets).padStart(5) + String(s.winPct ?? "—").padStart(7) +
    String(s.pnl ? "$" + s.pnl : "—").padStart(9) + String(s.meanR ?? "—").padStart(10) +
    String(s.dayClusteredT ?? "—").padStart(8) + String(s.alphaClaimable || "—").padStart(11));
}
const quiet = out.filter((s) => s.classification === "NOT_GRADEABLE" || s.classification === "SILENT");
console.log("\n  " + quiet.length + " seat(s) produced nothing gradeable (measurement/governance only, or silent):");
console.log("    " + quiet.map((s) => s.seat).join(", "));
console.log("\n  " + doc.honestState);
console.log("written: data/agent-seat-grading.json");
