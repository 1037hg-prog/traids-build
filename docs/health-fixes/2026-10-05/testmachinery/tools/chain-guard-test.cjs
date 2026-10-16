"use strict";
/**
 * chain-guard-test.cjs — known answers for tools/chain-guard.cjs on REAL inputs (package testmachinery, review round 2).
 *
 * Fixtures (tools/fixtures/), captured 2026-10-05 read-only:
 *   daily-run-2026-10-01_to_10-05.log  automation/daily-run.log from the 10-01 OPEN marker to the 10-05 OPEN block, byte-for-byte
 *   chain-status-2026-10-01.json       chain-status.json as it stood WHILE the 10-02 chain ran (git 23d0c0c0c, taken inside it)
 *   chain-status-2026-10-02.json       chain-status.json written by the 10-02 chain at its end
 * The log is cut at the real line where each moment happened (by content, not line number) and assessed at that moment's time.
 * Also proves the FIRST guard (chain-status.json "started and not finished") was blind: on the mid-chain inputs it says idle.
 *
 *   node tools/chain-guard-test.cjs     prints each case; exit 0 iff all pass
 */
const fs = require("fs"), path = require("path");
const { assess } = require(path.join(__dirname, "chain-guard.cjs"));
const FX = path.join(__dirname, "fixtures");
const LOG = fs.readFileSync(path.join(FX, "daily-run-2026-10-01_to_10-05.log"), "utf8").split("\n");
const CS1001 = JSON.parse(fs.readFileSync(path.join(FX, "chain-status-2026-10-01.json"), "utf8"));
const CS1002 = JSON.parse(fs.readFileSync(path.join(FX, "chain-status-2026-10-02.json"), "utf8"));
const at = (pred, from = 0) => { for (let i = from; i < LOG.length; i++) if (pred(LOG[i])) return i; throw new Error("fixture marker not found"); };
const iClose1002 = at((l) => l.startsWith("======== CLOSE Fri 10/02/2026"));
const iChain1002 = at((l) => l.startsWith("CLOSE CHAIN · 2026-10-02T20:15:47.738Z"));
const iWritten1002 = at((l) => /written: chain-status\.json/.test(l), iChain1002);
const upTo = (i) => LOG.slice(0, i + 1).join("\n");   // the log as it stood right after line i was written
const holidays = { "2026-11-26": "Thanksgiving Day" };
const isHoliday = (d) => holidays[d] || null;
/** The guard deploy.cjs v1 shipped: chain-status.json started and (no finished, or finished < started), younger than 4 h. */
const v1Blocks = (cs, now) => { const s = Date.parse(cs.started), f = Date.parse(cs.finished); return Number.isFinite(s) && (!Number.isFinite(f) || f < s) && now - s < 4 * 3600e3; };

const cases = [
  { name: "10-02 16:20 ET — close cycle started (daily-run.cjs settling), chain not yet printed", log: upTo(iClose1002 + 3), cs: CS1001, now: "2026-10-02T20:20:00Z", want: "RUNNING", hard: true },
  { name: "10-02 16:50 ET — mid-chain (log cut 100 lines after CLOSE CHAIN)", log: upTo(iChain1002 + 100), cs: CS1001, now: "2026-10-02T20:50:00Z", want: "RUNNING", hard: true, v1WasBlind: true },
  { name: "10-02 17:37 ET — last step done, chain-status not yet written", log: upTo(iWritten1002 - 1), cs: CS1001, now: "2026-10-02T21:37:30Z", want: "RUNNING", hard: true, v1WasBlind: true },
  { name: "10-02 17:45 ET — chain finished and wrote chain-status.json", log: upTo(iWritten1002 + 1), cs: CS1002, now: "2026-10-02T21:45:00Z", want: "IDLE" },
  { name: "10-05 13:00 ET — morning, last chain finished 10-02", log: LOG.join("\n"), cs: CS1002, now: "2026-10-05T17:00:00Z", want: "IDLE" },
  { name: "10-05 15:50 ET — inside the start window", log: LOG.join("\n"), cs: CS1002, now: "2026-10-05T19:50:00Z", want: "RUNNING", hard: true },
  { name: "10-05 16:30 ET — chain should be running but the log shows no start (task missed?)", log: LOG.join("\n"), cs: CS1002, now: "2026-10-05T20:30:00Z", want: "NOT_FINISHED", overridable: true },
  { name: "10-02 22:00 ET — chain started 16:15 and never wrote chain-status (died)", log: upTo(iChain1002 + 100), cs: CS1001, now: "2026-10-03T02:00:00Z", want: "UNKNOWN", overridable: true },
  { name: "10-05 13:00 ET — a close-chain.cjs process is visible", log: LOG.join("\n"), cs: CS1002, now: "2026-10-05T17:00:00Z", procs: { ok: true, lines: ["4242 node automation\\close-chain.cjs", "4243 node backend\\adjudicator.js"] }, want: "RUNNING", hard: true },
  { name: "10-05 13:00 ET — process list unreadable (positive-only check: not decisive)", log: LOG.join("\n"), cs: CS1002, now: "2026-10-05T17:00:00Z", procs: { ok: false, lines: [] }, want: "IDLE" },
  { name: "10-05 13:00 ET — daily-run.log unreadable", log: null, cs: CS1002, now: "2026-10-05T17:00:00Z", want: "UNKNOWN", overridable: true },
  { name: "10-05 17:00 ET — chain-status.json unreadable inside the chain window", log: LOG.join("\n"), cs: null, now: "2026-10-05T21:00:00Z", want: "UNKNOWN", overridable: true },
  { name: "2026-11-26 16:30 ET — Thanksgiving: no chain, nothing due", log: LOG.join("\n"), cs: CS1002, now: "2026-11-26T21:30:00Z", want: "IDLE" },
  { name: "10-03 17:00 ET — Saturday", log: upTo(iWritten1002 + 1), cs: CS1002, now: "2026-10-03T21:00:00Z", want: "IDLE" },
];

function run() {
  const results = [];
  for (const c of cases) {
    const now = new Date(c.now);
    const a = assess({ now, logText: c.log, chainStatus: c.cs, procs: c.procs || null, isHoliday });
    let ok = a.verdict === c.want;
    if (c.hard) ok = ok && a.overridable === false;
    if (c.overridable) ok = ok && a.overridable === true;
    let v1 = null;
    if (c.v1WasBlind) { v1 = v1Blocks(c.cs, now.getTime()); ok = ok && v1 === false; }   // the first guard would have let a deploy through
    results.push({ name: c.name, ok, want: c.want, got: a.verdict, overridable: a.overridable, v1Blocked: v1, reason: (a.reasons[0] || "").slice(0, 160) });
  }
  return results;
}

if (require.main === module) {
  const rs = run();
  for (const r of rs) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name} — ${r.got}${r.overridable ? " (overridable)" : ""}${r.v1Blocked === false ? " · first guard: let it through" : ""}${r.reason ? " · " + r.reason : ""}`);
  const bad = rs.filter((r) => !r.ok).length;
  console.log(`chain-guard known answers: ${rs.length - bad}/${rs.length} PASS`);
  process.exit(bad ? 1 : 0);
}
module.exports = { run };
