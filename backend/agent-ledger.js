#!/usr/bin/env node
/**
 * AGENT LEDGER — when did the AI agents get involved, and did anything actually improve?
 *
 * The operator's question, 2026-08-26: "we need a separate accounting of when the ai agents got
 * involved with the daily ML to improve the trading." Until now that was unanswerable. The change
 * registry has 160 entries and NO author field, so an agent's fix, the operator's decision and my
 * own edit are indistinguishable in the record.
 *
 * THE DISTINCTION THAT MAKES THIS HONEST — and without it the whole ledger is a vanity metric:
 *
 *   TRADING     changed what gets bought or sold, or at what size. Only these can move P&L.
 *   MEASUREMENT changed what a number MEANS. Cannot move P&L. Frequently moves the REPORTED
 *               number, which is exactly why it must never be counted as improvement.
 *   GOVERNANCE  changed what is allowed — a bar, a freeze, an exclusion rule.
 *
 * Nearly everything the agents produced on 2026-08-25/26 was MEASUREMENT. The reported pooled edge
 * moved from +0.0061R to +0.003R across that window, and not one basis point of that was trading:
 * it was de-clustering, a per-row cost model, retired-row exclusion and a corrected benchmark. A
 * naive before/after would credit the agents with a change they did not cause, in a direction that
 * happens to look bad — and the same arithmetic would credit them falsely if it had looked good.
 *
 * SO THE BASELINE IS FROZEN AND STATED, NOT INFERRED. First agent involvement is 2026-08-25. Any
 * claim that agents improved trading must show a TRADING-kind intervention, a date, and a
 * post-intervention sample large enough to read on its own honest bar. Today there are none, and
 * this file says so out loud rather than reporting a flattering delta.
 *
 * Usage:
 *   node backend/agent-ledger.js --record --agent <name> --kind TRADING|MEASUREMENT|GOVERNANCE \
 *        --target "<file/test>" --what "<one line>"
 *   node backend/agent-ledger.js --report
 * Output: data/agent-ledger.jsonl (append-only)
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const LEDGER = D("agent-ledger.jsonl");
const KINDS = ["TRADING", "MEASUREMENT", "GOVERNANCE"];
const arg = (k, d = null) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };

/** board state at the moment of an intervention, so before/after is computable later */
function snapshot() {
  try {
    const { cleanEraLedger, deClusteredEdge } = require("./lib/reconcile.js");
    const L = cleanEraLedger(), d = deClusteredEdge();
    return {
      signals: L.n, controls: L.controlN, meanR: L.meanR, pooledEdgeR: L.pooledEdgeR, winRatePct: L.winRatePct,
      episodesSignals: d.episodes.signals, episodeEdgeR: d.episodes.pooledEdgeR, tEpisodes: d.tEpisodesSignals,
    };
  } catch (e) { return { error: String(e.message).slice(0, 120) }; }
}

if (process.argv.includes("--record")) {
  const agent = arg("agent"), kind = String(arg("kind", "")).toUpperCase(), target = arg("target"), what = arg("what");
  if (!agent || !target || !what) { console.error('usage: --record --agent <name> --kind TRADING|MEASUREMENT|GOVERNANCE --target "<x>" --what "<y>"'); process.exit(2); }
  if (!KINDS.includes(kind)) { console.error("--kind must be one of " + KINDS.join(", ") + " — the distinction is the whole point of this file"); process.exit(2); }
  const row = { at: new Date().toISOString(), agent, kind, target, what, board: snapshot() };
  fs.appendFileSync(LEDGER, JSON.stringify(row) + "\n");
  console.log(`recorded [${kind}] ${agent} -> ${target}`);
  if (kind !== "TRADING") console.log("  NOTE: not a TRADING change. It cannot move P&L and must never be cited as trading improvement.");
  process.exit(0);
}

// ── report ────────────────────────────────────────────────────────────────────────────────────
const rows = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
if (!rows.length) { console.log("AGENT LEDGER — empty. No agent intervention has been recorded."); process.exit(0); }

const byKind = {}; for (const r of rows) (byKind[r.kind] ||= []).push(r);
const first = rows[0], last = rows[rows.length - 1];
console.log(`AGENT LEDGER — ${rows.length} intervention(s)`);
console.log(`  first: ${first.at.slice(0, 16).replace("T", " ")}  (${first.agent})`);
console.log(`  last:  ${last.at.slice(0, 16).replace("T", " ")}  (${last.agent})\n`);
for (const k of KINDS) {
  const a = byKind[k] || [];
  console.log(`  ${k.padEnd(12)} ${String(a.length).padStart(3)}${k === "TRADING" ? "   <- only these can move P&L" : ""}`);
}
const byAgent = {}; for (const r of rows) (byAgent[r.agent] ||= []).push(r);
console.log("\n  by agent:");
for (const [a, list] of Object.entries(byAgent).sort((x, y) => y[1].length - x[1].length)) {
  const t = list.filter((r) => r.kind === "TRADING").length;
  console.log(`    ${a.padEnd(24)} ${String(list.length).padStart(3)} total, ${t} trading`);
}

const trading = byKind.TRADING || [];
console.log("\n  DID AGENT INVOLVEMENT IMPROVE TRADING?");
if (!trading.length) {
  console.log("    NO TRADING-KIND INTERVENTION HAS BEEN RECORDED. The question is not yet answerable,");
  console.log("    and any before/after on the reported edge would be measuring measurement changes.");
  const b0 = first.board, b1 = snapshot();
  if (b0 && b1 && b0.pooledEdgeR != null && b1.pooledEdgeR != null) {
    console.log(`    (for reference only, NOT an agent result: pooled edge ${b0.pooledEdgeR} -> ${b1.pooledEdgeR},`);
    console.log(`     signals ${b0.signals} -> ${b1.signals}. Attribute none of this to agents.)`);
  }
} else {
  console.log(`    ${trading.length} trading change(s) recorded. Earliest ${trading[0].at.slice(0, 10)} by ${trading[0].agent}.`);
  console.log("    Read the post-intervention sample on its own honest bar; a raw before/after is not a result.");
  for (const r of trading) console.log(`      ${r.at.slice(0, 10)}  ${r.agent}  ${r.target}  — ${r.what}`);
}
console.log("\n  Log every future agent action here. An unrecorded intervention makes the whole");
console.log("  before/after unreadable, because the baseline silently stops being a baseline.");
