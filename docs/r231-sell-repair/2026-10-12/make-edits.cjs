#!/usr/bin/env node
"use strict";
/**
 * R231 SELL REPAIR (2026-10-12) — MAKE the staged edits: edits.json, cut from TODAY's runner and the block in staged/helpers.txt.
 *   node docs/r231-sell-repair/2026-10-12/make-edits.cjs            write edits.json (this folder only; backend/lib/atomic-write.js)
 *   node docs/r231-sell-repair/2026-10-12/make-edits.cjs --check    READ-ONLY: build the same list in memory and compare it with edits.json
 *
 * Each edit replaces ONE whole line of backend/r231-crypto-vote-sized-forward.js (its anchor: a piece of text that must be in exactly one
 * line) by a block. THE ANCHOR IS COPIED FROM THE LIVE FILE, never typed here, and wherever the old line still has to run it is KEPT IN THE
 * NEW BLOCK AS IT IS, with a comment after it or one name in it changed by a replacement that must hit — so the code that is not meant to
 * change is not re-typed. A file that already carries this unit is read back to its base first, so the list is the same before and after an
 * apply. "Today's file" is the runner as docs/pause-switches/2026-10-12 left it (applied 2026-10-12 16:48 MT): its line is not touched.
 *
 * THE EIGHT EDITS, in the order of the file:
 *   helpers          after `const q9 = ...`: the helpers of the repair (staged/helpers.txt) — DUST, the other sleeves' files, the account's
 *                    positions, the fee of a buy, what a fill does to the count, what a sell may ask for, the end of a run
 *   reconcile-count  the line that moves a count on a fill: kept, then corrected — a buy by its reported fee, a cut close to flat; a close
 *                    that filled and left more than dust counted is noted on the coin (closeShort)
 *   reconcile-record the fill's two records (state order row, ledger row) carry the fee, or what a cut close wrote off
 *   guard-read       before the order loop: the account's positions, read once (a failed read sets a flag of its own); then the other
 *                    sleeves' files, read after them (an earlier reading of this run is dropped)
 *   sell-cap         the sell quantity: the rule's (the old line, its name changed), then cut to what the account has for this book
 *   sell-record      the pending order and the ledger row of a cut sell say so
 *   sell-line        the printed line of a cut sell says what it was cut to, and why
 *   run-end          after the state is saved: every sell that was due and did not go, and every coin that carries a closeShort note,
 *                    last on stderr
 */
const fs = require("fs"), path = require("path");
const L = require("./lib.cjs");
const TAG = "R231-SELL-REPAIR 2026-10-12";
const block = (name) => { const t = fs.readFileSync(path.join(L.PKG, "staged", name), "utf8"); if (t.includes("\r") || !t.endsWith("\n")) throw new Error(`staged/${name}: must be LF text ending with a newline`); return t; };
/** the one line of `text` that holds `needle` (with its newline); throws unless exactly one line does */
function anchorLine(text, needle, rel) {
  const hits = text.split("\n").filter((l) => l.includes(needle));
  if (hits.length !== 1) throw new Error(`${rel}: the anchor ${JSON.stringify(needle.slice(0, 70))} is in ${hits.length} lines of the base text (need exactly 1)`);
  return hits[0] + "\n";
}
/** the one line that IS `line` (a whole line); throws unless exactly one is */
function wholeLine(text, line, rel) {
  const n = text.split("\n").filter((l) => l === line).length;
  if (n !== 1) throw new Error(`${rel}: the whole line ${JSON.stringify(line)} is there ${n} times (need exactly 1)`);
  return line + "\n";
}
/** today's text of the runner, read back to its base when an existing edits.json reads applied on it */
function baseText(root = L.REPO) {
  let prev = null; try { prev = L.loadEdits(); } catch { prev = null; }
  const { text } = L.readText(path.join(root, ...L.R231.split("/"))), ed = prev ? L.editsFor(prev, L.R231) : [];
  if (!ed.length) return text;
  const st = L.fileState(text, ed);
  if (st.state === "drift") throw new Error(`${L.R231}: neither base nor applied under the existing edits.json (${st.states.filter((x) => x.state === "drift").map((x) => `${x.id}: ${x.why}`).join("; ")}) — read the change in the live file first`);
  return L.revertText(text, ed);
}
const WHY = {
  helpers: "the helpers of the repair: DUST (one definition), the other sleeves' own files, the account's positions, the fee of a buy from the broker's CFEE rows, what a fill does to the count, what a sell may ask for, the reasons at the end of a run",
  "reconcile-count": "the old line still moves the count as before; the next line corrects it: a BUY counts what the account received (filled_qty less its reported fee; UNKNOWN keeps filled_qty), a cut CLOSE that filled in full leaves the coin flat when the rest is dust; when the rest is more than dust the coin carries a note (closeShort) that every later run reports",
  "reconcile-record": "the fill's order row and ledger row carry the fee read (or that it is unknown), or what a cut close wrote off; a fill with neither adds nothing",
  "guard-read": "the account's positions are read ONCE, before any order is decided; unreadable = no sell this run, said here and last on stderr (a failed read is a flag of its own, whatever words the error carried); the other sleeves' files are read AFTER the positions (a reading a booked buy took earlier in the run, for its fee, is dropped here)",
  "sell-cap": "the rule's quantity is computed by the old line (renamed ruleQty); the sell asks for no more than the account has for this book (its position less what the other sleeves count); an order already at the broker under today's id is adopted with its own quantity, and is looked for once before the account's balance is given as the reason for no sell; when it may not ask at all the reason is printed, written to the ledger without a client id, and the run ends exit 1",
  "sell-record": "a cut sell says so on its ledger row; a cut CLOSE also on its pending order, so the fill can leave the coin flat; an uncut sell adds nothing",
  "sell-line": "the printed line of a cut sell says what it was cut to and why; an uncut sell prints as before",
  "run-end": "after the state is saved: every sell that was due and did not go, and a close that did not end flat (said again every run while the coin carries its note), LAST on stderr, exit 1",
};
/** replace `a` by `b` in `s`, exactly once, or throw */
const swap = (s, a, b, id) => { const i = s.indexOf(a); if (i < 0 || s.indexOf(a, i + 1) >= 0) throw new Error(`${id}: ${JSON.stringify(a.slice(0, 60))} is in its line ${i < 0 ? 0 : 2} times (need exactly 1)`); return s.slice(0, i) + b + s.slice(i + a.length); };
const tail = (old, words) => old.replace(/\n$/, "") + words + "\n";

function build(root = L.REPO) {
  const B = baseText(root), edits = [];
  const rep = (id, old, neu) => edits.push({ id, file: L.R231, why: WHY[id], oldSha: L.sha256(Buffer.from(old)).slice(0, 16), newSha: L.sha256(Buffer.from(neu)).slice(0, 16), old, new: neu });
  { const old = anchorLine(B, "const q9 = (x) => +(+x).toFixed(9);", L.R231);
    rep("helpers", old, tail(old, `   // (as it was) — the helpers of ${TAG} follow`) + block("helpers.txt")); }
  { const old = anchorLine(B, 's.coins[c].qty = p.side === "buy" ? q9(s.coins[c].qty + q) : Math.max(0, q9(s.coins[c].qty - q));', L.R231);
    rep("reconcile-count", old,
      `      const before231 = s.coins[c].qty;   // ${TAG}: the count before this fill\n`
      + tail(old, "   // (as it was: a buy adds filled_qty, a sell takes it off — corrected on the next line)")
      + `      const B231 = await booked(c, p, o, q, px, before231, s.coins[c].qty, s.orders); s.coins[c].qty = B231.qty;   // ${TAG}: (1) a buy counts what the account RECEIVED — filled_qty less the fee the broker reports for it (UNKNOWN: filled_qty is kept) · (3) a cut close that filled in full leaves the coin flat when the rest is dust\n`
      + `      if (B231.qty === 0) delete s.coins[c].closeShort; else if (B231.closeShort) s.coins[c].closeShort = B231.closeShort;   // ${TAG}: a close that filled and left MORE THAN DUST counted is noted on the coin — every later run says it and ends exit 1 (finishRun) until the count is put right; a coin that comes to 0 carries no such note\n`); }
  { const old = anchorLine(B, "s.orders.push({ cid: p.cid, side: p.side, qty: q, px, at: o.filled_at });", L.R231);
    let neu = swap(old, "at: o.filled_at });", "at: o.filled_at, ...B231.order });", "reconcile-record");
    neu = swap(neu, '...(o.status === "filled" ? {} : { status: o.status }) }); }', '...(o.status === "filled" ? {} : { status: o.status }), ...B231.row }); }', "reconcile-record");
    rep("reconcile-record", old, tail(neu, `   // ${TAG}: the fee read (or that it is unknown), or what a cut close wrote off, on both records; otherwise nothing is added`)); }
  { const old = wholeLine(B, "  for (const c of UNIVERSE) {", L.R231);
    rep("guard-read", old,
      `  // ${TAG} (2): the account's positions, read ONCE before any order is decided. A sell asks for no more than they hold for this book (sellGuard). Unreadable: no sell this run.\n`
      + "  try { RUN.hold = await accountHolds(); } catch (e) { RUN.holdFail = true; RUN.holdErr = String((e && e.message) || \"\").slice(0, 160) || \"unknown error\"; console.log(`  ACCOUNT · positions could not be read (${RUN.holdErr}) — NO SELL THIS RUN`); }\n"
      + `  RUN.others = null;   // ${TAG}: the other sleeves' files are read AFTER the positions, never before. A buy booked above read them for its fee (booked); that reading is dropped here and the files are read again on the next line — a ticket the board's mirror booked in between is in the positions just read, and must be in what the others count too\n`
      + "  if (RUN.hold) for (const n of others().notes) console.log(`  ACCOUNT · ${n}`);\n"
      + tail(old, "   // (as it was)")); }
  { const old = anchorLine(B, "const sellQty = Math.min(q9(st.qty), q9(Math.abs(delta) / last.c));", L.R231);
    rep("sell-cap", old,
      swap(old, "const sellQty = Math.min(", "const ruleQty = Math.min(", "sell-cap")
      + `      // ${TAG} (2): never more than the account has for THIS book — its position less what the other sleeves count in their own files. An order already at the broker under today's id is adopted, never re-sized: what it asked is its own quantity (sellAsk).\n`
      + "      const G = await sellAsk(c, st.qty, ruleQty, last.c, fc, cid, s.orders);\n"
      + '      if (G.no) { console.log(`  ${c} · NO SELL this run (the rule asks ${ruleQty.toFixed(6)}, target $${targetNotional.toFixed(0)}) — ${G.no}`); if (LIVE || SANDBOX) ledger({ kind: "sell-not-sent", coin: c, side: "sell", ruleQty, targetNotional, reason: G.no }); RUN.faults.push(RUN.holdFail ? `${c}: due, not asked` : `${c}: ${G.no}`); process.exitCode = 1; continue; }\n'
      + "      const sellQty = G.qty;\n"); }
  { const old = anchorLine(B, 'st.pending = { cid, side: "sell", signalClose: last.c };', L.R231);
    let neu = swap(old, 'st.pending = { cid, side: "sell", signalClose: last.c };', 'st.pending = { cid, side: "sell", signalClose: last.c, ...G.pend };', "sell-record");
    neu = swap(neu, "...(fc.adopt ? { adopted: true, brokerStatus: fc.adopt.status } : {}) }); save(s); }", "...(fc.adopt ? { adopted: true, brokerStatus: fc.adopt.status } : {}), ...G.row }); save(s); }", "sell-record");
    rep("sell-record", old, tail(neu, ` · ${TAG}: a cut sell says so on its ledger row, a cut close on its pending order too; an uncut sell adds nothing`)); }
  { const old = anchorLine(B, "SELL ${sellQty.toFixed(6)} (target $${targetNotional.toFixed(0)})`); }", L.R231);
    rep("sell-line", old, tail(swap(old, "SELL ${sellQty.toFixed(6)} (target $${targetNotional.toFixed(0)})`); }", "SELL ${sellQty.toFixed(6)} (target $${targetNotional.toFixed(0)})${G.words}`); }", "sell-line"), `   // ${TAG}: a cut sell says what it was cut to, and why`)); }
  { const old = anchorLine(B, 'if (LIVE || SANDBOX) save(s); else console.log("  (dry run — state not saved)");', L.R231);
    rep("run-end", old, tail(old, " · (as it was)") + `  finishRun(s);   // ${TAG}: every sell that was due and did not go, and a close that did not end flat (the evening it filled and every evening after, from the note on the coin) — LAST on stderr, exit 1\n`); }
  const E = { package: L.PKG_NAME, stagedAt: new Date().toISOString(),
    note: "ANCHORED whole-line replacements on backend/r231-crypto-vote-sized-forward.js. base = old once and new nowhere; applied = new once and old nowhere; anything else is DRIFT and nothing is written. Written by make-edits.cjs; do not edit by hand.",
    base: { [L.R231]: { sha256: L.sha256(Buffer.from(B, "utf8")), bytes: Buffer.byteLength(B) } },
    edits };
  L.validateEdits(E);
  const st = L.fileState(B, edits); if (st.state !== "base") throw new Error(`the staged edits do not read base on today's base text (${JSON.stringify(st.states)})`);
  const next = L.applyText(B, edits), err = L.nodeCheckText(next, L.R231); if (err) throw new Error(`the staged text fails node --check (${err})`);
  E.staged = { [L.R231]: { sha256: L.sha256(Buffer.from(next, "utf8")), bytes: Buffer.byteLength(next) } };
  return E;
}
const sameBut = (a, b) => JSON.stringify({ ...a, stagedAt: 0 }) === JSON.stringify({ ...b, stagedAt: 0 });

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) { console.log("usage: node docs/r231-sell-repair/2026-10-12/make-edits.cjs [--check]\nNothing was done."); process.exit(2); }
  let E; try { E = build(); } catch (e) { console.error(`NOT STAGED: ${e.message}`); process.exit(1); }
  if (args[0] === "--check") {
    let cur = null; try { cur = JSON.parse(fs.readFileSync(L.EDITS_FILE, "utf8")); } catch { cur = null; }
    const ok = !!cur && sameBut(cur, E);
    console.log(ok ? `edits.json is what make-edits.cjs builds from today's file: ${E.edits.length} edits; base ${E.base[L.R231].sha256.slice(0, 12)} -> staged ${E.staged[L.R231].sha256.slice(0, 12)}` : "edits.json is NOT what make-edits.cjs builds from today's file (the live file or a staged block changed since it was written): run make-edits.cjs, then selftest.cjs");
    process.exit(ok ? 0 : 1);
  }
  L.atomic().writeJsonAtomic(L.EDITS_FILE, E);
  for (const e of E.edits) console.log(`  ${e.id.padEnd(18)} ${e.old.split("\n").length - 1} line -> ${String(e.new.split("\n").length - 1).padStart(3)}   ${e.why.slice(0, 110)}`);
  console.log(`staged ${E.edits.length} edits on ${L.R231} -> ${path.relative(L.REPO, L.EDITS_FILE).replace(/\\/g, "/")}; base ${E.base[L.R231].sha256.slice(0, 12)} -> staged ${E.staged[L.R231].sha256.slice(0, 12)}`);
}
module.exports = { build, baseText, anchorLine, wholeLine, sameBut, swap };
