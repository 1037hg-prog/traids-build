#!/usr/bin/env node
"use strict";
/**
 * R191-A3 — THE DATED NOTE OWED WITH THE R191 SELL REPAIR (docs/r191-sell-repair/2026-10-14; work order 4.39; after the main session's
 * backend/note-r231-a3-sell-repair.js for R231-A3).
 *
 *   node docs/r191-sell-repair/2026-10-14/note.cjs --dry      READ-ONLY: the three records it would write, and why the write mode would be
 *                                                            refused right now if it would (exit 0 when the records can be built)
 *   node docs/r191-sell-repair/2026-10-14/note.cjs --apply    the write mode — the main session's command, never run by the build
 *   ... --data <folder> --root <folder>                       work on COPIES under the system temp folder (the selftest)
 *
 * THE WORDING IS NOT TYPED HERE. It is the block between "<!-- R191-A3 NOTE BEGIN -->" and "<!-- R191-A3 NOTE END -->" in this package's
 * NOTES.md ("For the registrar"). This script reads it, fills its placeholders from the files — <restate-row> and <restate-date> from the
 * restate's own change-registry row, <evidence-state> from R191's state as it is at the moment of writing — and stores the block's fields with
 * the sha256 of the text it read.
 * WRITES, under backend/data/registry-write.lock (flag 'wx'; waits up to 120 s; never removes another writer's lock): ONE object appended to
 * R191.amendments (kind "execution-repair", ruleChange false, preEvidence false; nothing else in the entry or the registry changes — checked
 * after the write), ONE change-registry row, ONE agent-ledger GOVERNANCE line.
 * REFUSES (exit 2, nothing written): a word other than these; R191 not in the registry exactly once, sealed, or already carrying R191-A3; the
 * repair not applied (the live runner must be the staged copy, byte for byte); the restate's change-registry row not there; the NOTES block
 * missing, twice, or without a field; the change-registry already holding the row; and, for the write, 13:50-15:50 MT on a trading weekday.
 * Exit 0 dry (the records built) / written · 1 failed after a write began (what was written is named) · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const L = require("./lib.cjs"), RL = L.RL;
const TAG = "R191-A3", KEY = "R191-SELL-REPAIR-2026-10-14", CR_ID = "r191-a3-sell-repair-note-2026-10-14", NOTES = path.join(L.PKG, "NOTES.md");
const BEGIN = "<!-- R191-A3 NOTE BEGIN -->", END = "<!-- R191-A3 NOTE END -->";
const FIELDS = [["date", "date"], ["preEvidence", "preEvidence"], ["operator", "operator"], ["tag", "noteTag"], ["evidenceState", "evidenceState"], ["change", "change"], ["written under the defect", "writtenUnderTheDefect"], ["net counts from", "netCountsFrom"], ["the 365-day read must say", "the365DayReadMustSay"]];
class Refuse extends Error {}
const refuse = (m) => { throw new Refuse(m); };

/** the registrar's block out of NOTES.md -> { raw, sha } (the text between the two markers, the quote marks taken off) */
function blockText(notesText) {
  const a = notesText.split(BEGIN), b = notesText.split(END);
  if (a.length !== 2 || b.length !== 2) refuse(`NOTES.md must hold the markers ${BEGIN} and ${END} exactly once each`);
  const inner = a[1].split(END)[0], raw = inner.split(/\r?\n/).filter((l) => /^>/.test(l)).map((l) => l.replace(/^> ?/, "")).join("\n").trim();
  if (!raw) refuse("the registrar block in NOTES.md is empty");
  return { raw, sha: crypto.createHash("sha256").update(raw).digest("hex") };
}
/** the block's fields, with the placeholders filled (pure) */
function fieldsOf(raw, fill) {
  let text = raw; for (const [k, v] of Object.entries(fill)) text = text.split(`<${k}>`).join(v);
  const left = Object.keys(fill).filter((k) => text.includes(`<${k}>`)); if (left.length) refuse(`the registrar block still holds a placeholder (${left.join(", ")})`);
  const out = {}, marks = FIELDS.map(([label]) => ({ label, at: text.indexOf(`**${label}**`) }));
  for (const m of marks) if (m.at < 0) refuse(`the registrar block has no field "${m.label}"`);
  for (let i = 0; i < FIELDS.length; i++) { const start = marks[i].at + FIELDS[i][0].length + 4, end = Math.min(...marks.filter((m) => m.at > marks[i].at).map((m) => m.at), text.length); out[FIELDS[i][1]] = text.slice(start, end).replace(/[\s·]+$/, "").replace(/^[\s·]+/, "").replace(/\n+/g, " "); }
  return out;
}
/** R191's evidence state as its state file shows it now (pure) */
function evidenceOf(s, restateRow) {
  const marks = (s.marks || []).filter((m) => m && m.close != null), days = [...new Set(marks.map((m) => m.d))].sort(), orders = s.orders || [], buys = orders.filter((o) => o.side === "buy").length, sells = orders.filter((o) => o.side === "sell").length;
  return `accruing: ${days.length} marked days (${days[0] || "-"} to ${days[days.length - 1] || "-"}), ${buys} buy(s) and ${sells} sell(s) filled; held now: ${L.COINS.filter((c) => s.coins[c] && s.coins[c].qty > 0).map((c) => `${c} ${s.coins[c].qty}`).join(", ") || "none"}${restateRow ? ` (net of the buy fee since ${restateRow.date}, change-registry ${restateRow.id})` : ""}`;
}
/** read everything the note stands on; `problems` are what makes the WRITE refuse (the dry run lists them) */
function gather({ dataDir, root }) {
  const D = (f) => path.join(dataDir, f), problems = [];
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")), cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8")), state = JSON.parse(fs.readFileSync(D("r191-crypto-trend.json"), "utf8"));
  const where = []; for (const k of Object.keys(reg)) if (Array.isArray(reg[k])) reg[k].forEach((t, i) => { if (t && typeof t === "object" && t.id === "R191") where.push([k, i]); });
  if (where.length !== 1) refuse(`R191 is in the registry ${where.length} time(s): expected once`);
  const t = reg[where[0][0]][where[0][1]];
  if (seals && (seals.tests || seals) && Object.prototype.hasOwnProperty.call(seals.tests || seals, "R191")) problems.push("R191 has a sealed read: a note is not added after a read");
  if (t.amendments !== undefined && !Array.isArray(t.amendments)) refuse("R191.amendments is not a list");
  if ((t.amendments || []).some((a) => a && (a.tag === TAG || a.id === TAG || a.key === KEY))) problems.push(`R191 already carries ${TAG}`);
  if (!Array.isArray(cr)) refuse("change-registry.json is not a list");
  if (cr.some((x) => x && x.id === CR_ID)) problems.push(`change-registry already holds ${CR_ID}`);
  const restates = cr.filter((x) => x && typeof x.id === "string" && x.id.startsWith(L.RESTATE_ID + "-")), restateRow = restates[restates.length - 1] || null;
  if (!restateRow) problems.push(`the restate's change-registry row (${L.RESTATE_ID}-<date>) is not there: run   node ${L.PKG_REL}/restate.cjs --dry   then   --apply   first`);
  let P; try { P = L.plan({ root }); } catch (e) { P = { state: "unreadable", problem: e.message }; }
  if (P.state !== "applied") problems.push(`the repair is not applied: the live runner is ${P.state === "base" ? "the base copy" : `neither copy (${P.problem})`} — the note would be false (node ${L.PKG_REL}/deploy.cjs --plan)`);
  if (!fs.existsSync(D("agent-ledger.jsonl"))) refuse("agent-ledger.jsonl is missing");
  return { reg, cr, where: where[0], t, state, restateRow, P, problems };
}
/** the three records (pure but for NOTES.md, read once) */
function build(G, { today, notesText = fs.readFileSync(NOTES, "utf8"), appliedAt = null }) {
  const b = blockText(notesText), rr = G.restateRow;
  const f = fieldsOf(b.raw, { "restate-row": rr ? rr.id : `${L.RESTATE_ID}-<date>`.replace("<date>", "(not run yet)"), "restate-date": rr ? rr.date : "(not run yet)", "evidence-state": evidenceOf(G.state, rr) });
  if (String(f.preEvidence) !== "false") refuse(`the block's preEvidence reads ${f.preEvidence}: this note is written after evidence`);
  if (f.noteTag !== TAG) refuse(`the block's tag reads ${f.noteTag}, not ${TAG}`);
  const note = { id: TAG, tag: TAG, key: KEY, date: f.date, kind: "execution-repair", ruleChange: false, preEvidence: false, operator: f.operator, evidenceState: f.evidenceState, change: f.change, writtenUnderTheDefect: f.writtenUnderTheDefect, netCountsFrom: f.netCountsFrom, the365DayReadMustSay: f.the365DayReadMustSay,
    source: `${L.PKG_REL}/NOTES.md, 'For the registrar'`, sourceSha256: b.sha, recordedOn: today, breaksComparability: true };
  const moved = rr ? Object.keys(rr.after || {}).filter((c) => rr.before && rr.before[c] !== rr.after[c]).map((c) => `${c} ${rr.before[c]} -> ${rr.after[c]}`).join(", ") : "";
  const crRecord = { id: CR_ID, date: today, recordedAt: Date.now(), area: "R191 crypto trend sleeve (Alpaca paper) — execution repair of its sells and counts; the dated note R191-A3", category: "execution", breaksComparability: true, affectedFrom: appliedAt ? RL.mtNow(Date.parse(appliedAt)).date : today,
    change: `R191 carries the dated note ${TAG} (text from ${L.PKG_REL}/NOTES.md, sha256 ${b.sha.slice(0, 16)}). The repair package was applied${appliedAt ? ` ${appliedAt}` : ""} (one file, ${L.R191}, now ${G.P.sha ? G.P.sha.slice(0, 12) : "?"}): a reconciled buy is counted net of the fee the broker reports; a sell asks for no more than the account has for R191 (its position less what R231 and the board's Alpaca mirror count); a cut close that fills leaves the coin flat. ${rr ? `The count was restated from the broker's own fee rows (change-registry ${rr.id}: ${moved}; ${rr.usdBefore != null ? `$${rr.usdBefore} -> $${rr.usdAfter} at the last recorded close` : ""}).` : "The count has not been restated yet."} No rule, size, universe, statistic, bar or read condition changed.`,
    why: "The broker takes the fee of a crypto buy in the coin, so the account held less than the runner counted, and a FULL sell asked for the count: R191's ETH sell of 2026-10-09 filled only by taking R231's ETH, and its BTC count was above what the account received. Operator 2026-10-13 08:39 MT: \"repair R191\".",
    doesNotEstablish: "Any result for R191 (it reads after 365 days, about 2027-09-25). Which series its read stands on is an open ruling named in the note.",
    owed: "The board's Alpaca mirror still sells crypto at the filled quantity (report only; its repair needs the operator's word). The server keeps the OLD runner: w3-r191 stays at home and no copy step runs for any sleeve until R191's and R231's files reach both server data folders (the carry job, the next build; NOTES.md, 'On the server').",
    operator: "Josh 2026-10-13 08:39 MT (\"repair R191\")", files: [`${L.PKG_REL}/note.cjs`, L.R191, `${L.PKG_REL}/NOTES.md`] };
  const ledgerLine = { ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "execution-repair-note", tests: ["R191"], noteTag: TAG, changeRegistry: CR_ID,
    detail: `${today}: R191 sell repair applied${rr ? ` and its count restated net of the buy fee (${moved})` : ""}; dated note ${TAG} recorded (kind execution-repair, ruleChange false, preEvidence false); no rule, size, universe, statistic, bar or read condition changed; the read's series is an open ruling` };
  return { note, crRecord, ledgerLine, sha: b.sha };
}
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** the note, start to finish. Every input is injectable (the selftest runs it on temp copies). -> { code, result, why } */
function noteRun({ dataDir = path.join(L.REPO, "backend", "data"), root = L.REPO, apply = false, ms, holidays, lockWaitMs = 120000, out = console.log, notesText, appliedAt: givenAt } = {}) {
  const D = (f) => path.join(dataDir, f), LOCK = D("registry-write.lock"), token = `${process.pid}-${Date.now()}`; let held = false, stage = "nothing written";
  const release = () => { if (!held) return; held = false; try { if (JSON.parse(fs.readFileSync(LOCK, "utf8")).token === token) fs.unlinkSync(LOCK); } catch { out(`could not remove ${LOCK} — look at it by hand`); } };
  try {
    const mt = RL.mtNow(ms), today = mt.date, win = L.noteWindow({ ms, holidays });
    out(`NOTE ${apply ? "(WRITE MODE)" : "(DRY — nothing is written)"} — ${TAG} in R191's registry entry — ${mt.dow} ${today} ${mt.hms} MT`);
    let appliedAt = givenAt === undefined ? null : givenAt; if (givenAt === undefined) { try { appliedAt = (L.readState().applied || {}).at || null; } catch { appliedAt = null; } }
    const G = gather({ dataDir, root }), B = build(G, { today, notesText, appliedAt });
    out(`R191 has ${(G.t.amendments || []).length} amendment(s) on file: ${(G.t.amendments || []).map((a) => a && (a.id || a.tag || a.key || a.date)).join(", ") || "none"}`);
    out(`\nR191.amendments += \n${JSON.stringify(B.note, null, 1)}\n\nchange-registry record:\n${JSON.stringify(B.crRecord, null, 1)}\n\nagent-ledger GOVERNANCE line:\n${JSON.stringify(B.ledgerLine)}`);
    const would = [...G.problems, ...(win ? [win] : [])];
    if (!apply) { out(`\nDRY: nothing written.${would.length ? ` The write mode would be REFUSED now:\n  - ${would.join("\n  - ")}` : " The write mode would write these three records now."}`); return { code: 0, result: "dry", why: would, records: B }; }
    if (would.length) refuse(would.join("; "));
    for (const t0 = Date.now(); ;) { try { const fd = fs.openSync(LOCK, "wx"); held = true; fs.writeSync(fd, JSON.stringify({ token, pid: process.pid, by: `${L.PKG_REL}/note.cjs`, id: TAG, at: new Date().toISOString() }) + "\n"); fs.closeSync(fd); break; } catch (e) { if (e.code !== "EEXIST") refuse(`cannot create the lock file (${e.code || e.message})`); if (Date.now() - t0 >= lockWaitMs) refuse("registry-write.lock was held by another writer"); sleepMs(Math.min(1000, lockWaitMs)); } }
    const win2 = L.noteWindow({ ms: ms === undefined ? undefined : ms, holidays }); if (win2) refuse(win2);
    const cur = gather({ dataDir, root }); if (cur.problems.length) refuse(cur.problems.join("; "));
    const b = build(cur, { today, notesText, appliedAt });
    const before = {}; for (const k of Object.keys(cur.reg)) if (Array.isArray(cur.reg[k])) before[k] = cur.reg[k].map((x) => JSON.stringify(x));
    const [arr, idx] = cur.where, wasEntry = JSON.parse(before[arr][idx]);
    (cur.t.amendments ||= []).push(b.note); cur.reg.asOf = new Date().toISOString();
    const n0 = cur.cr.length, LEDGER = D("agent-ledger.jsonl");
    L.atomic().writeJsonAtomic(D("test-registry.json"), cur.reg); stage = "the registry written";
    cur.cr.push(b.crRecord); L.atomic().writeJsonAtomic(D("change-registry.json"), cur.cr); stage = "the registry and the change-registry written";
    const buf = fs.readFileSync(LEDGER); fs.appendFileSync(LEDGER, (!buf.length || buf[buf.length - 1] === 10 ? "" : "\n") + JSON.stringify(b.ledgerLine) + "\n"); stage = "all three written";
    const reg2 = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), cr2 = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8")), tail = JSON.parse(fs.readFileSync(LEDGER, "utf8").trimEnd().split("\n").pop());
    const changed = []; for (const k of Object.keys(before)) { if (!Array.isArray(reg2[k]) || reg2[k].length !== before[k].length) { changed.push(`${k}[] length`); continue; } reg2[k].forEach((x, i) => { if (!(k === arr && i === idx) && JSON.stringify(x) !== before[k][i]) changed.push(`${k}[${i}]`); }); }
    const t2 = reg2[arr][idx], rest = { ...t2 }, wasRest = { ...wasEntry }; delete rest.amendments; delete wasRest.amendments;
    const ok = !changed.length && JSON.stringify(rest) === JSON.stringify(wasRest) && t2.amendments.length === (wasEntry.amendments || []).length + 1 && t2.amendments[t2.amendments.length - 1].id === TAG && JSON.stringify(t2.amendments.slice(0, -1)) === JSON.stringify(wasEntry.amendments || []) && cr2.length === n0 + 1 && cr2[cr2.length - 1].id === CR_ID && tail.noteTag === TAG;
    if (!ok) throw new Error(`POST-WRITE CHECK FAILED (other entries changed: ${changed.slice(0, 5).join(", ") || "none"}) — inspect by hand before anything else runs`);
    out(`\nRECORDED: R191 carries ${TAG} (its earlier amendments, every other field of the entry and every other entry byte-identical); change-registry ${CR_ID}; one agent-ledger GOVERNANCE line.`);
    return { code: 0, result: "written", why: [] };
  } catch (e) {
    if (e instanceof Refuse && stage === "nothing written") { out(`REFUSED — nothing written: ${e.message}`); return { code: 2, result: "refused", why: [e.message] }; }
    out(`${stage}, then FAILED: ${e && e.message}. What is still owed is printed by --dry.`); return { code: 1, result: "failed", why: [String(e && e.message)], stage };
  } finally { release(); }
}
/** the command line, judged BEFORE anything is opened (pure) */
function parseArgs(a) {
  const opt = { dry: false, apply: false }; let bad = false;
  for (let i = 0; i < a.length; i++) { if (a[i] === "--dry") opt.dry = true; else if (a[i] === "--apply") opt.apply = true; else if (a[i] === "--data" && a[i + 1]) opt.data = a[++i]; else if (a[i] === "--root" && a[i + 1]) opt.root = a[++i]; else bad = true; }
  if (bad || opt.dry === opt.apply) return { refuse: "usage: node docs/r191-sell-repair/2026-10-14/note.cjs --dry | --apply   [--data <a copy of backend/data> --root <a copy of the repo's runner tree>, both under the system temp folder]\nNothing was done." };
  return { opt };
}
if (require.main === module) {
  const A = parseArgs(process.argv.slice(2));
  if (A.refuse) { console.log(A.refuse); process.exit(2); }
  const RS231 = require(path.join(L.REPO, "docs", "r231-sell-repair", "2026-10-12", "restate.cjs")), run = { apply: A.opt.apply };
  for (const [k, v] of [["dataDir", A.opt.data], ["root", A.opt.root]]) if (v) { const d = fs.realpathSync(path.resolve(v)); if (!RS231.isTempCopy(d)) { console.log(`--${k === "dataDir" ? "data" : "root"} takes a COPY under the system temp folder only. Nothing was done.`); process.exit(2); } run[k] = d; }
  process.exit(noteRun(run).code);
}
module.exports = { noteRun, gather, build, blockText, fieldsOf, evidenceOf, parseArgs, TAG, CR_ID, BEGIN, END };
