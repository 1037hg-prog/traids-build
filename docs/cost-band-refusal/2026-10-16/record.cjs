#!/usr/bin/env node
/**
 * COST BAND REFUSAL — the change-registry row. NOT a registered test: no test id is minted and test-registry.json is not touched.
 *
 *   node docs/cost-band-refusal/2026-10-16/record.cjs --dry                               prints the row; writes nothing
 *   node docs/cost-band-refusal/2026-10-16/record.cjs --restarted YYYY-MM-DD --dry        the row as it will be dated
 *   node docs/cost-band-refusal/2026-10-16/record.cjs --restarted YYYY-MM-DD --apply      appends it to backend/data/change-registry.json
 *
 * The row is dated at the board server restart that loaded the gate (--restarted), because that is when the population changes.
 * It is breaksComparability true: from that date board stock tickets at 30-100 bps become shadows, which removes them from the
 * signal rows every reader of the board's equity book counts (R49's KEPT arm among them — NOTES.md, "Registered tests").
 * --apply refuses: inside 13:50-15:50 MT on a trading weekday (the house no-registry-write window); without --restarted; when the
 * registry-write lock is held for two minutes; when change-registry.json is unreadable. A row with the same id is never added twice.
 * JSON is written only through backend/lib/atomic-write.js.
 */
"use strict";
const fs = require("fs"), path = require("path");
const REPO = path.resolve(__dirname, "..", "..", "..");
const { loadCjs } = require("./loadcjs.cjs");
const ID_PREFIX = "cost-band-refusal-";

function mtClock(nowMs, holidays) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`, hm = (+p.hour % 24) * 60 + +p.minute, dow = new Date(day + "T12:00:00Z").getUTCDay();
  const tradingDay = dow >= 1 && dow <= 5 && !(holidays && holidays[day]);
  return { day, hhmm: `${p.hour}:${p.minute}`, tradingDay, inWindow: tradingDay && hm >= 13 * 60 + 50 && hm < 15 * 60 + 50 };
}
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && new Date(s + "T12:00:00Z").toISOString().slice(0, 10) === s;

function rowFor(restarted, nowMs) {
  return {
    id: ID_PREFIX + (restarted || "YYYY-MM-DD"), date: restarted || null, affectedFrom: restarted || null, recordedAt: nowMs,
    area: "board entry POST — equity cost band (operator cost control 2026-10-15)", category: "risk-control", breaksComparability: true,
    change: "New board stock tickets (cls Equity; not a control, veto shadow or sleeve ticket) whose stamped round-trip spread obs.spreadBps is 30 to 100 bps inclusive are refused at the entry POST and kept as veto shadows (ctrl true, vetoShadow true, veto \"COSTBAND spread 30-100bps\", costBand {loBps 30, hiBps 100, spreadBps}). Asked only after R49, R53 and the STAMP gate pass the ticket, so R49 still owns every spread over 100 bps. Off switch backend/data/cost-band-OFF (absent means on). Gate: backend/lib/cost-band-gate.js.",
    why: "Operator decision 2026-10-15: a cost control on the equity book. Not a registered test; no test id. The shadows let the refused tail be measured.",
    registeredTestsAffected: "From this date fewer board equity tickets are signal rows: every reader that counts the board's non-control equity rows sees a population without the 30-100 bps tail (R49's KEPT arm reads 'non-ctrl equity, spreadBps <= 100'). No registered rule, bar or read date was edited.",
  };
}

function main(argv = process.argv.slice(2), { root = REPO, nowMs = Date.now(), log = console.log, lockWaitMs = 2000, lockTries = 60 } = {}) {
  let restarted = null, apply = false, dry = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true; else if (a === "--dry") dry = true;
    else if (a === "--restarted") restarted = argv[++i];
    else { log(`REFUSED: unknown argument ${a}`); return 2; }
  }
  if (apply && dry) { log("REFUSED: give --dry or --apply, not both"); return 2; }
  if (restarted !== null && !isDate(restarted)) { log(`REFUSED: --restarted needs a calendar date YYYY-MM-DD, got ${restarted}`); return 2; }
  const row = rowFor(restarted, nowMs);
  if (!apply) { log("change-registry row (dry; nothing written):\n" + JSON.stringify(row, null, 1)); return 0; }
  if (!restarted) { log("REFUSED: --apply needs --restarted YYYY-MM-DD (the date of the board restart that loaded the gate)"); return 2; }
  let holidays = null; try { holidays = loadCjs(path.join(root, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS; } catch { /* every weekday then counts as trading */ }
  const c = mtClock(nowMs, holidays);
  if (c.inWindow) { log(`REFUSED: ${c.day} ${c.hhmm} MT is inside the 13:50-15:50 MT no-registry-write window on a trading day — run it after 15:50 MT`); return 2; }
  if (restarted > c.day) { log(`REFUSED: --restarted ${restarted} is after today (${c.day} MT)`); return 2; }
  const D = (f) => path.join(root, "backend", "data", f), LOCK = D("registry-write.lock");
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let held = false;
  for (let i = 0; i < lockTries && !held; i++) { try { fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, by: "cost-band-refusal/record.cjs", at: new Date(nowMs).toISOString() }), { flag: "wx" }); held = true; } catch (e) { if (e.code !== "EEXIST") throw e; if (i < lockTries - 1) sleep(lockWaitMs); } }
  if (!held) { log("REFUSED: backend/data/registry-write.lock is held by another writer — left in place; run again later"); return 2; }
  try {
    const { writeJsonAtomic } = loadCjs(path.join(root, "backend", "lib", "atomic-write.js"));
    let cr; try { cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8")); } catch (e) { log(`REFUSED: backend/data/change-registry.json is unreadable (${e.message}) — nothing written`); return 2; }
    if (!Array.isArray(cr)) { log("REFUSED: change-registry.json is not an array — nothing written"); return 2; }
    if (cr.some((x) => x && typeof x.id === "string" && x.id.startsWith(ID_PREFIX))) { log(`already recorded: ${cr.find((x) => x && String(x.id).startsWith(ID_PREFIX)).id} — nothing written`); return 0; }
    const n0 = cr.length; cr.push(row); writeJsonAtomic(D("change-registry.json"), cr);
    const back = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
    if (back.length !== n0 + 1 || back[n0].id !== row.id) { log("FAILED: change-registry.json does not read back as written"); return 1; }
    log(`recorded ${row.id} (breaksComparability true, from ${restarted})`); return 0;
  } finally { try { fs.unlinkSync(LOCK); } catch { /* ours */ } }
}

if (require.main === module) process.exit(main());
module.exports = { main, rowFor, mtClock, isDate, ID_PREFIX };
