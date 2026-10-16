#!/usr/bin/env node
/**
 * OPTION SLEEVES — RED-FOLDER NEWS SHADOW (2026-09-28, operator: "yes add it"). WEIGHTLESS; a candidate filter test once enough
 * settled tickets exist. Reads only (trade_log.json, board_positions.json, data/ff-calendar/red-folders.json); changes no ticket.
 *   R25-0dte (the 0DTE sleeve): exposed = a USD red folder was released AFTER entry and before that day's 16:00 ET close.
 *   R21-premium (option wings, 5-12 DTE): exposure = the number of USD red folders between entry and the option's expiry close.
 * Only tickets opened on or after the red-folder record's first covered week count (the feed has no history).
 * Output: data/options-news-shadow.json — per sleeve, exposed vs not: settled count, mean R, sum $, plus every tagged ticket.
 *   node backend/options-news-shadow.js
 *
 * ONE ROW PER TICKET (2026-10-16). This file deduplicated by ticket id already, but by ARRIVAL ORDER — the first
 * row seen for an id won, and the closed rows were listed before the open ones. That was right only while
 * trade_log.json happened to hold the newest close of a ticket first (options-settle.js prepends). Six R21 wings
 * whose loss-cap close was voided and whose expiry settled under the same id made it a coin toss between the
 * voided close and the real one — and a wing's exposure row would have been the wrong one, in the wrong bucket.
 * The choice is now explicit and keyed on the ticket id (lib/ticket-rows.js collapseByTicket): the ledger's
 * surviving close is the ticket's row, and an open board row counts only for a ticket the ledger has not closed.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { collapseByTicket, collapseLine } = require("./lib/ticket-rows.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), RED = D("ff-calendar/red-folders.json"), OUT = D("options-news-shadow.json");
const rd = (f) => { try { const j = JSON.parse(fs.readFileSync(D(f), "utf8")); return Array.isArray(j) ? j : j.trades || j.rows || j.positions || Object.values(j).find(Array.isArray) || []; } catch { return []; } };
const etParts = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, time: `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}` }; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

const REC = fs.existsSync(RED) ? JSON.parse(fs.readFileSync(RED, "utf8")) : null;
const red = REC ? REC.events.filter((e) => e.country === "USD") : [];
const coveredFrom = REC ? REC.coveredFrom || null : null;
// the ledger's rows collapsed to one per ticket id FIRST (never by arrival order), then the open board rows of
// tickets the ledger has not closed. closedCollapse is reported on the last line so the collapse is never silent.
const closedCollapse = collapseByTicket(rd("trade_log.json"));
const closedIds = new Set(closedCollapse.rows.map((t) => t.id).filter(Boolean));
const tickets = [...closedCollapse.rows.map((t) => ({ ...t, _state: "closed" })),
  ...rd("board_positions.json").filter((t) => t && (!t.id || !closedIds.has(t.id))).map((t) => ({ ...t, _state: "open" }))]
  .map((t) => ({ ...t, openedAt: t.openedAt || t.addedAt }))   // open positions carry addedAt, settled tickets openedAt
  .filter((t) => t && (t.strategy === "R25-0dte" || t.strategy === "R21-premium") && t.openedAt);
const seen = new Set(), rows = [];
for (const t of tickets) {
  if (seen.has(t.id)) continue; seen.add(t.id);   // kept exactly as it was: the collapse above decides WHICH row, this still guards a repeat
  if (t.ctrl || t.ctrlRand) continue;   // control twins are not trades
  const e = etParts(+t.openedAt); if (!coveredFrom || e.date < coveredFrom) continue;
  const key = `${e.date} ${e.time}`;
  let exposure = [];
  if (t.strategy === "R25-0dte") exposure = red.filter((x) => x.dateEt === e.date && x.timeEt > e.time && x.timeEt < "16:00");
  else { const exp = (t.obs && t.obs.optExpiry) || t.optExpiry; if (exp) exposure = red.filter((x) => `${x.dateEt} ${x.timeEt}` > key && `${x.dateEt} ${x.timeEt}` <= `${exp} 16:00`); }
  const settled = t._state === "closed" && t.rMult != null;
  rows.push({ id: t.id, sleeve: t.strategy, sym: t.sym, openedEt: key, expiry: (t.obs && t.obs.optExpiry) || t.optExpiry || null, shadow: !!(t.vetoShadow || t.shadow), exposedCount: exposure.length, exposed: exposure.length > 0,
    releases: exposure.map((x) => `${x.dateEt} ${x.timeEt} ${x.title}`), state: t._state, r: settled ? +t.rMult : null, pnl: settled && t.pnl != null ? +t.pnl : null });
}
const summ = (sel) => { const s = rows.filter(sel), done = s.filter((r) => r.r != null); return { tickets: s.length, settled: done.length, meanR: done.length ? +mean(done.map((r) => r.r)).toFixed(4) : null, sumPnl: done.length ? +done.reduce((a, r) => a + (r.pnl || 0), 0).toFixed(2) : null }; };
const summary = { coveredFrom };
for (const sl of ["R25-0dte", "R21-premium"]) summary[sl] = { exposed: summ((r) => r.sleeve === sl && r.exposed), notExposed: summ((r) => r.sleeve === sl && !r.exposed) };
writeJsonAtomic(OUT, { spec: "options news shadow v1 — WEIGHTLESS; 0DTE: USD red folder between entry and the close; wings: count between entry and expiry", asOf: new Date().toISOString(),
  ledger: { tickets: closedCollapse.tickets, duplicateTicketIds: closedCollapse.duplicates.length, supersededRowsDropped: closedCollapse.dropped.length, unexplainedDuplicateTicketIds: closedCollapse.ambiguous },
  summary, rows });
const f = (s) => `${s.tickets} (${s.settled} settled${s.meanR != null ? `, ${s.meanR}R, $${s.sumPnl}` : ""})`;
console.log(`options news shadow since ${coveredFrom || "— (no red-folder record yet)"} · 0DTE exposed ${f(summary["R25-0dte"].exposed)} vs not ${f(summary["R25-0dte"].notExposed)} · wings exposed ${f(summary["R21-premium"].exposed)} vs not ${f(summary["R21-premium"].notExposed)}`);
console.log(`  ledger: ${collapseLine(closedCollapse)}`);
