#!/usr/bin/env node
/**
 * AGENT P&L ACCOUNTABILITY — does each agent earn its seat?
 * Writes data/agent-pnl-accountability.json. Runs in the close chain.
 *
 * OPERATOR DIRECTIVE 2026-08-28: "must move P&L and must cite trading improvement."
 *
 * The standing rule stays — a MEASUREMENT entry may never be reported as trading improvement,
 * because relabelling an audit as a profit is the exact self-deception this whole apparatus
 * exists to prevent. What changes is that measurement is no longer a place to hide. The ledger
 * showed 92 interventions and 3 that could move P&L: edge-hunter 4/0, alpha-hunt-weekly 4/0,
 * meta-analyst 5/0, strategy-skeptic 2/0. Every one of those agents was doing its job as
 * written, and not one of them was ever required to put forward something that could make money.
 *
 * THE REQUIREMENT. Every agent, on its cadence, must close with exactly one of:
 *   · a TRADING PROPOSAL — specific, sized, decidable, submitted to the human-gated queue in
 *     backend/pipeline.js, where it is tested and waits for the operator; or
 *   · an explicit DECLINATION recorded in the agent ledger: "no trading improvement available
 *     today", with the reason.
 * Silence is a failure. An agent that neither proposes nor declines is not earning its seat,
 * and this file names it.
 *
 * WHAT THIS FILE WILL NOT DO. It will not credit an agent with P&L it cannot trace to an
 * adopted proposal, and it will not convert MEASUREMENT rows into TRADING rows to make the
 * scoreboard look better. An agent whose honest answer is "nothing today" every day for a
 * month has told you something true and expensive: its seat is not paying for itself.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const OUT = D("agent-pnl-accountability.json");
const WINDOW_DAYS = Number(process.env.ACCT_WINDOW || 14);

const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const readJsonl = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

const DECLINE = /no trading improvement|nothing to propose|no p&l proposal|declines?: none/i;

(() => {
  const ledger = readJsonl(D("agent-ledger.jsonl"));
  const queue = readJson(D("candidate-queue.json"), []);
  const cands = Array.isArray(queue) ? queue : (queue.candidates || []);
  const cutoff = Date.now() - WINDOW_DAYS * 864e5;
  const recent = ledger.filter(r => r && r.at && Date.parse(r.at) >= cutoff);

  const agents = {};
  for (const r of ledger) {
    const a = r.agent || "?";
    const s = (agents[a] ||= { agent: a, total: 0, trading: 0, measurement: 0, governance: 0, declines: 0, recent: 0, recentTrading: 0, recentDeclines: 0, lastAt: null, proposals: 0, approved: 0, promoted: 0 });
    s.total++;
    if (r.kind === "TRADING") s.trading++;
    else if (r.kind === "GOVERNANCE") s.governance++;
    else s.measurement++;
    if (DECLINE.test(String(r.what || ""))) s.declines++;
    if (!s.lastAt || r.at > s.lastAt) s.lastAt = r.at;
  }
  for (const r of recent) {
    const s = agents[r.agent || "?"]; if (!s) continue;
    s.recent++;
    if (r.kind === "TRADING") s.recentTrading++;
    if (DECLINE.test(String(r.what || ""))) s.recentDeclines++;
  }
  // proposals this agent put into the human gate
  for (const c of cands) {
    const who = String(c.proposedBy || c.source || c.agent || "");
    const s = Object.values(agents).find(x => who && who.includes(x.agent));
    if (!s) continue;
    s.proposals++;
    if (/approved/i.test(String(c.status || ""))) s.approved++;
    if (/promoted/i.test(String(c.status || ""))) s.promoted++;
  }

  const rows = Object.values(agents).sort((a, b) => (b.recentTrading + b.proposals) - (a.recentTrading + a.proposals) || b.total - a.total);
  // An agent EARNS ITS SEAT in the window by doing one of the two required things.
  for (const s of rows) {
    s.accounted = s.recentTrading + s.proposals + s.recentDeclines;
    s.verdict = s.accounted > 0 ? "ACCOUNTED" : (s.recent > 0 ? "SILENT — worked, proposed nothing, declined nothing" : "IDLE — no interventions in the window");
  }
  const silent = rows.filter(r => r.verdict.startsWith("SILENT"));
  const idle = rows.filter(r => r.verdict.startsWith("IDLE"));

  const out = {
    spec: "agent-pnl-accountability-v1", asOf: new Date().toISOString(), windowDays: WINDOW_DAYS,
    directive: "Operator 2026-08-28: agents must move P&L and must cite trading improvement. Implemented as: every agent must either submit a TRADING PROPOSAL to the human-gated queue, or record an explicit declination with its reason. Silence is a failure.",
    standingRuleUnchanged: "A MEASUREMENT entry is still never reportable as trading improvement. This file adds accountability; it does not relabel audits as profit.",
    totals: {
      interventions: ledger.length,
      trading: ledger.filter(r => r.kind === "TRADING").length,
      queueCandidates: cands.length,
      awaitingOperator: cands.filter(c => /pending_approval/i.test(String(c.status || ""))).length,
      adopted: cands.filter(c => /promoted/i.test(String(c.status || ""))).length,
    },
    agents: rows, silent: silent.map(r => r.agent), idle: idle.map(r => r.agent),
    honestNote: "Zero adopted proposals means zero attributable P&L. That is the true number and it is not softened here.",
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  console.log(`AGENT P&L ACCOUNTABILITY — last ${WINDOW_DAYS} days`);
  console.log(`  ledger: ${out.totals.interventions} interventions · ${out.totals.trading} TRADING`);
  console.log(`  queue:  ${out.totals.queueCandidates} candidates · ${out.totals.awaitingOperator} awaiting you · ${out.totals.adopted} adopted`);
  console.log("");
  console.log("  agent                      recent  TRADING  proposals  declines  verdict");
  for (const s of rows.slice(0, 24))
    console.log("    " + s.agent.padEnd(26) + String(s.recent).padStart(4) + String(s.recentTrading).padStart(8) + String(s.proposals).padStart(10) + String(s.recentDeclines).padStart(10) + "  " + s.verdict.split(" —")[0]);
  console.log("");
  if (silent.length) console.log(`  NOT EARNING THEIR SEAT (worked, proposed nothing, declined nothing): ${silent.length}\n    ${silent.map(r => r.agent).join(", ")}`);
  if (idle.length) console.log(`  IDLE in the window: ${idle.length} — ${idle.map(r => r.agent).join(", ")}`);
  console.log("");
  console.log(`  ATTRIBUTABLE P&L: ${out.totals.adopted} adopted proposal(s). ${out.totals.adopted === 0 ? "Zero adopted means zero attributable P&L — that is the true number." : ""}`);
  console.log("written: data/agent-pnl-accountability.json");
})();
