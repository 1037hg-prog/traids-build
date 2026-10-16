#!/usr/bin/env node
/** R231-A3 — THE DATED NOTE OWED WITH THE R231 SELL REPAIR (docs/r231-sell-repair/2026-10-12; work order 4.34).
 *
 *  OPERATOR, 2026-10-12: asked "OK to repair R231 so it sells what the account actually holds? It changes what the runner sends even
 *  when it isn't paused", he answered (verbatim) "repair". The repair was applied the same evening and the thirteen counts were
 *  restated net of the buy fee from the broker's own fee rows (change-registry r231-counts-net-of-buy-fees-2026-10-12).
 *
 *  THE WORDING IS NOT TYPED HERE. It is the block the build wrote and its two reviewers checked, in the package's NOTES.md under
 *  "For the registrar" (the quoted lines from "**date**" to the end of "the 365-day read must say"). This script reads that block,
 *  fills its one placeholder (<date> = the date of the restate's change-registry row), drops the one sentence written for the case
 *  that the restate had not been run, and stores the block's fields and the sha256 of the text it read.
 *
 *  WRITES, under backend/data/registry-write.lock (flag 'wx'; waits up to 120 s; never deletes another job's lock): one object
 *  appended to R231.amendments (nothing else in the entry or the registry changes — checked after the write), one change-registry
 *  record, one agent-ledger GOVERNANCE line.
 *  REFUSES (exit 2, nothing written): an argument other than --dry; R231 not in the registry exactly once, sealed, or already
 *  carrying R231-A3; the repair not applied (the live runner must carry the repair's sell cap) or the restate's row not in the
 *  change-registry; the NOTES block missing a field; or, for a real write, 13:50-15:50 MT on a trading day.
 *
 *    node backend/note-r231-a3-sell-repair.js --dry
 *    node backend/note-r231-a3-sell-repair.js */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), NOTES = path.join(__dirname, "..", "docs", "r231-sell-repair", "2026-10-12", "NOTES.md");
const TAG = "R231-A3", CR_ID = "r231-a3-sell-repair-note-2026-10-12", RESTATE_ROW = "r231-counts-net-of-buy-fees-2026-10-12";
const FIELDS = [["date", "date"], ["preEvidence", "preEvidence"], ["operator", "operator"], ["tag", "noteTag"], ["evidenceState", "evidenceState"], ["change", "change"], ["written under the defect", "writtenUnderTheDefect"], ["net counts from", "netCountsFrom"], ["the 365-day read must say", "the365DayReadMustSay"]];
class Refuse extends Error {}
const refuse = (m) => { throw new Refuse(m); };
function mtClock(now = new Date()) {
  let H = null; try { H = require("./lib/run-window.js").MARKET_HOLIDAYS || {}; } catch { H = null; }
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hourCycle: "h23", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  const hh = +p.hour % 24, hm = hh * 60 + +p.minute, mtDate = `${p.year}-${p.month}-${p.day}`, dow = new Date(mtDate + "T12:00:00Z").getUTCDay();
  const tradingDay = dow >= 1 && dow <= 5 && !(H && H[mtDate]);
  return { mtDate, hhmm: `${String(hh).padStart(2, "0")}:${p.minute}`, inWindow: tradingDay && hm >= 13 * 60 + 50 && hm < 15 * 60 + 50 };
}
/** the registrar's block out of NOTES.md, as fields */
function block() {
  const lines = fs.readFileSync(NOTES, "utf8").split(/\r?\n/), a = lines.findIndex((l) => /^> \*\*date\*\* /.test(l));
  if (a < 0) refuse("docs/r231-sell-repair/2026-10-12/NOTES.md holds no registrar block (a quoted line beginning **date**)");
  let b = a; while (b + 1 < lines.length && /^>/.test(lines[b + 1])) b++;
  const raw = lines.slice(a, b + 1).map((l) => l.replace(/^> ?/, "")).join("\n");
  let text = raw.split("<date>").join("2026-10-12").replace(/\s*\*\(If the restate has not been run[^)]*\)\*/, "");
  if (/<[a-z]+>/i.test(text)) refuse("the registrar block still holds a placeholder after filling <date>");
  const out = {}, marks = FIELDS.map(([label]) => ({ label, at: text.indexOf(`**${label}**`) }));
  for (const m of marks) if (m.at < 0) refuse(`the registrar block has no field "${m.label}"`);
  for (let i = 0; i < FIELDS.length; i++) {
    const start = marks[i].at + FIELDS[i][0].length + 4, end = Math.min(...marks.filter((m) => m.at > marks[i].at).map((m) => m.at), text.length);
    out[FIELDS[i][1]] = text.slice(start, end).replace(/[\s·]+$/, "").replace(/^[\s·]+/, "").replace(/\n+/g, " ");
  }
  return { fields: out, sha: crypto.createHash("sha256").update(raw).digest("hex") };
}
function build(today, cr) {
  const runner = fs.readFileSync(path.join(__dirname, "r231-crypto-vote-sized-forward.js"), "utf8");
  if (!/sellAsk\(/.test(runner)) refuse("the live backend/r231-crypto-vote-sized-forward.js does not carry the repair (no sellAsk): the note would be false");
  if (!cr.some((x) => x && x.id === RESTATE_ROW)) refuse(`the restate's change-registry row ${RESTATE_ROW} is not there: the note names it`);
  const b = block();
  const note = { tag: TAG, key: "R231-SELL-REPAIR-2026-10-12", date: b.fields.date, preEvidence: false, kind: "EXECUTION REPAIR (post-evidence; no rule change)", operator: b.fields.operator, evidenceState: b.fields.evidenceState,
    change: b.fields.change, writtenUnderTheDefect: b.fields.writtenUnderTheDefect, netCountsFrom: b.fields.netCountsFrom, the365DayReadMustSay: b.fields.the365DayReadMustSay,
    openRuling: "Which series the 365-day read stands on (the marks-based reader as coded, or a series built from realised fills as the registered sentence reads) is to be ruled and recorded BEFORE the read; this note changes neither.",
    source: "docs/r231-sell-repair/2026-10-12/NOTES.md, 'For the registrar'", sourceSha256: b.sha, recordedOn: today, breaksComparability: true };
  if (note.date !== "2026-10-12" || String(b.fields.preEvidence) !== "false") refuse(`the block's date / preEvidence read ${note.date} / ${b.fields.preEvidence}: not the note this script was written for`);
  const crRecord = { id: CR_ID, date: today, recordedAt: Date.now(), area: "R231 crypto vote sleeve (Alpaca paper) — execution repair of its sells and counts; the dated note R231-A3", category: "execution", breaksComparability: true, affectedFrom: "2026-10-12",
    change: `R231 carries the dated note ${TAG} (text from docs/r231-sell-repair/2026-10-12/NOTES.md, sha256 ${b.sha.slice(0, 16)}). The repair package was applied 2026-10-12 21:34 MT (one file, backend/r231-crypto-vote-sized-forward.js; build loop green, 181 selftest cases; verify-live 7 of 7 PASS): a reconciled buy is counted net of the fee the broker reports; a sell asks for no more than the account has for this book (its position less what R191 and the board's Alpaca mirror count); a cut close that fills leaves the coin flat. The thirteen counts were restated the same evening from the broker's own fee rows (81 rows read; each of the 27 buys 0.2500% of its filled quantity; BCH and DOGE land on the balances the broker itself stated on 2026-10-09 to the last digit; the book reads $13,744.02 -> $13,709.13 at the last recorded closes; row ${RESTATE_ROW}). No rule, size, universe, statistic, bar or read condition changed. The sleeve stays paused (r231-OFF: buys withheld, sells under the rule go).`,
    why: 'The broker takes the fee of a crypto buy in the coin, so the account held less than the runner counted and refused every FULL sell ("insufficient balance": BCH and DOGE, 2026-10-09); a coin could never be closed. Operator 2026-10-12: "repair".',
    doesNotEstablish: "Any result for R231 (it reads after 365 days). Which series its read stands on is an open ruling named in the note.",
    owed: "R191 has the same defect (report only; its repair needs the operator's word: \"repair R191\"). The board's Alpaca mirror sells crypto at the filled quantity too. The server keeps the OLD runner: the sleeve package's copy step (and its no-argument form) must NOT be run until R191's state and the mirror's two files reach both server data folders (docs/r231-sell-repair/2026-10-12/NOTES.md, 'On the server'). pp-paper-legs.js should read the order rows' net quantity. The Console's switch table and the sleeve compare's list still describe r231-OFF as stopping sells.",
    operator: 'Josh 2026-10-12 ("repair")', files: ["backend/note-r231-a3-sell-repair.js", "backend/r231-crypto-vote-sized-forward.js", "docs/r231-sell-repair/2026-10-12/NOTES.md"] };
  const ledgerLine = { ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "execution-repair-note", tests: ["R231"], noteTag: TAG, changeRegistry: CR_ID,
    detail: `${today}: R231 sell repair applied and counts restated net of the buy fee (27 buys, each 0.25%; $13,744.02 -> $13,709.13); dated note ${TAG} recorded; no rule, size, universe, statistic, bar or read condition changed; the read's series is an open ruling` };
  return { note, crRecord, ledgerLine };
}
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function main(argv) {
  const LOCK = D("registry-write.lock"), token = `${process.pid}-${Date.now()}`; let held = false, stage = "nothing written";
  const release = () => { if (!held) return; held = false; try { if (JSON.parse(fs.readFileSync(LOCK, "utf8")).token === token) fs.unlinkSync(LOCK); } catch { console.log(`could not remove ${LOCK} — look at it by hand`); } };
  process.on("exit", release);
  try {
    const bad = argv.filter((a) => a !== "--dry"); if (bad.length) refuse(`unknown argument(s) ${bad.join(" ")} (only --dry is accepted)`);
    const DRY = argv.includes("--dry"), c0 = mtClock();
    console.log(`clock: ${c0.mtDate} ${c0.hhmm} MT${c0.inWindow ? " (inside the 13:50-15:50 MT no-write window)" : ""}${DRY ? " — --dry: nothing will be written" : ""}`);
    if (c0.inWindow && !DRY) refuse("inside the 13:50-15:50 MT no-write window on a trading day");
    const readAll = () => {
      const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")), cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
      const where = []; for (const k of Object.keys(reg)) if (Array.isArray(reg[k])) reg[k].forEach((t, i) => { if (t && typeof t === "object" && t.id === "R231") where.push([k, i]); });
      if (where.length !== 1) refuse(`R231 is in the registry ${where.length} time(s): expected once`);
      const t = reg[where[0][0]][where[0][1]];
      if (seals && seals.tests && Object.prototype.hasOwnProperty.call(seals.tests, "R231")) refuse("R231 has a sealed read: a note is not added after a read");
      if (t.amendments !== undefined && !Array.isArray(t.amendments)) refuse("R231.amendments is not a list");
      if ((t.amendments || []).some((a) => a && (a.tag === TAG || a.key === "R231-SELL-REPAIR-2026-10-12" || a.id === TAG))) refuse(`R231 already carries ${TAG}`);
      if (!Array.isArray(cr)) refuse("change-registry.json is not an array"); if (cr.some((x) => x && x.id === CR_ID)) refuse(`change-registry already holds ${CR_ID}`);
      if (!fs.existsSync(D("agent-ledger.jsonl"))) refuse("agent-ledger.jsonl is missing");
      return { reg, cr, where: where[0], t };
    };
    const r0 = readAll(), b0 = build(c0.mtDate, r0.cr);
    console.log(`R231 has ${(r0.t.amendments || []).length} amendment(s) on file: ${(r0.t.amendments || []).map((a) => a && (a.tag || a.id || a.key || a.date)).join(", ") || "none"}`);
    console.log(`\nR231.amendments += \n${JSON.stringify(b0.note, null, 1)}\n\nchange-registry record:\n${JSON.stringify(b0.crRecord, null, 1)}\n\nagent-ledger GOVERNANCE line:\n${JSON.stringify(b0.ledgerLine)}`);
    if (DRY) { console.log("\n--dry: nothing written."); return 0; }
    for (const start = Date.now(); ;) { try { const fd = fs.openSync(LOCK, "wx"); held = true; fs.writeSync(fd, JSON.stringify({ token, pid: process.pid, by: "backend/note-r231-a3-sell-repair.js", id: TAG, at: new Date().toISOString() }) + "\n"); fs.closeSync(fd); break; } catch (e) { if (e.code !== "EEXIST") refuse(`cannot create the lock file (${e.code || e.message})`); if (Date.now() - start >= 120000) refuse("registry-write.lock was held by another writer for more than 120 s"); sleepMs(1000); } }
    const c = mtClock(); if (c.inWindow) refuse("the clock entered the 13:50-15:50 MT no-write window while waiting"); if (c.mtDate !== c0.mtDate) refuse("the MT date changed while this script ran");
    const cur = readAll(), b = build(c.mtDate, cur.cr);
    const before = {}; for (const k of Object.keys(cur.reg)) if (Array.isArray(cur.reg[k])) before[k] = cur.reg[k].map((x) => JSON.stringify(x));
    const [arr, idx] = cur.where, wasEntry = JSON.parse(before[arr][idx]);
    (cur.t.amendments ||= []).push(b.note); cur.reg.asOf = new Date().toISOString();
    const n0 = cur.cr.length, LEDGER = D("agent-ledger.jsonl");
    writeJsonAtomic(D("test-registry.json"), cur.reg); stage = "registry written";
    cur.cr.push(b.crRecord); writeJsonAtomic(D("change-registry.json"), cur.cr); stage = "registry and change-registry written";
    const buf = fs.readFileSync(LEDGER); fs.appendFileSync(LEDGER, (!buf.length || buf[buf.length - 1] === 10 ? "" : "\n") + JSON.stringify(b.ledgerLine) + "\n"); stage = "all three written";
    const reg2 = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), cr2 = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8")), tail = JSON.parse(fs.readFileSync(LEDGER, "utf8").trimEnd().split("\n").pop());
    const others = []; for (const k of Object.keys(before)) { if (!Array.isArray(reg2[k]) || reg2[k].length !== before[k].length) { others.push(`${k}[] length`); continue; } reg2[k].forEach((x, i) => { if (!(k === arr && i === idx) && JSON.stringify(x) !== before[k][i]) others.push(`${k}[${i}]`); }); }
    const t2 = reg2[arr][idx], rest = { ...t2 }; delete rest.amendments; const wasRest = { ...wasEntry }; delete wasRest.amendments;
    const ok = !others.length && JSON.stringify(rest) === JSON.stringify(wasRest) && (t2.amendments || []).length === (wasEntry.amendments || []).length + 1 && t2.amendments[t2.amendments.length - 1].tag === TAG && JSON.stringify((t2.amendments || []).slice(0, -1)) === JSON.stringify(wasEntry.amendments || []) && cr2.length === n0 + 1 && cr2[cr2.length - 1].id === CR_ID && tail.noteTag === TAG;
    if (!ok) throw new Error(`POST-WRITE CHECK FAILED (other entries changed: ${others.slice(0, 5).join(", ") || "none"}) — inspect by hand before anything else runs`);
    console.log(`\nRECORDED: R231 carries ${TAG} (its earlier amendments, every other field of the entry and every other entry byte-identical); change-registry ${CR_ID}; agent-ledger GOVERNANCE line.`);
    return 0;
  } catch (e) {
    if (e instanceof Refuse && stage === "nothing written") { console.log(`${e.message} — refusing; nothing written`); return 2; }
    console.log(`${stage}, then FAILED: ${e && e.message}. What is still owed is printed by --dry.`);
    return stage === "nothing written" ? 1 : 3;
  } finally { release(); }
}
if (require.main === module) process.exit(main(process.argv.slice(2)));
