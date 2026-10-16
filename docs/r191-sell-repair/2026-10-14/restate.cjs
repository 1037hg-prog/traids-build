#!/usr/bin/env node
"use strict";
/**
 * R191 SELL REPAIR (2026-10-14; operator 2026-10-13: "repair R191") — THE ONE-TIME RESTATE of R191's count, from GROSS to NET OF THE BUY FEE.
 *
 *   node docs/r191-sell-repair/2026-10-14/restate.cjs --dry                   DRY. Reads R191's state and ledger, the other sleeves' files and the
 *                                                                              broker's fee rows (one kind of call: GET /v2/account/activities/CFEE
 *                                                                              on the PAPER endpoint, through the R231 package's own reader). Prints
 *                                                                              each buy with the fee read for it, then each coin's count before and
 *                                                                              after and the dollar difference. WRITES NOTHING.
 *   ... --dry --rows <file.json>                                               the same with the fee rows from a file (a JSON list): no broker call
 *   ... --dry --save-rows <file.json>                                          the same, and the rows the broker gave are kept as a FIXTURE — only
 *                                                                              under this package's harness/recorded/ (the selftest's known answer)
 *   node docs/r191-sell-repair/2026-10-14/restate.cjs --apply                 the write mode — the main session's command, never run by the build.
 *                                                                              It reads the fee rows from the BROKER itself (--apply with --rows is
 *                                                                              refused on the real data folder)
 *   ... --data <folder>                                                        work on a COPY of the data folder (only under the system temp dir)
 *   no mode, or both modes, or an unknown word: usage, exit 2, nothing done.
 *
 * WHAT IT DOES. Each buy of R191 that is still in a count and carries no fee yet was counted at its filled quantity (lib.cjs openBuys). For each
 * one the fee the broker charged is read from its CFEE rows (R231-SELL-REPAIR's feeOfBuy; for a buy that shares its two minutes with another
 * sleeve's buy of the same coin — R191's BTC of 2026-09-25 and R231's, 3 s apart — its splitFee: the rows told apart by filled quantity).
 * The coin's count comes down by that fee, and the buy's order row gets fee, net, feeBasis and feeRows (the broker's rows: id, time or date,
 * quantity). Nothing else moves a count, and no other sleeve's file is ever written.
 * A BUY BEFORE ITS COIN'S LAST FLAT IS SETTLED and its count is not touched: R191's ETH (bought 2026-09-25, sold whole 2026-10-09) counts 0
 * and stays 0. Its fee is read FOR THE RECORD: the full sell asked that much more than the account had received for the buy, and it came out of
 * the shared balance (R231's ETH). Said on the dry run and on the change-registry row; no row of the ETH history is changed.
 * IT REFUSES, and writes nothing, when: a fee of a buy still in a count cannot be read; a count would go below zero; another sleeve's file
 * cannot be read (it tells fee rows apart by the other sleeves' buys); the state or the ledger changes while it runs; and, in the write mode,
 * under the same fences as deploy.cjs (a trading weekday 05:30-16:00 MT, 13:50-15:50 MT any day, the close chain not on record as finished for
 * the last session, R191's runner running).
 * THE WRITE MODE writes, in this order, under backend/data/registry-write.lock (flag wx; waits up to 120 s; never removes another writer's lock):
 * a byte-exact backup of R191's state (backups/ here); the state (backend/lib/atomic-write.js); one row in R191's own ledger (kind
 * "counts-restated", no client id); ONE change-registry row with breaksComparability true. A failure after the first write puts the state and the
 * ledger back from the bytes read at the start. Run a second time it does nothing: a buy whose row carries its fee is not restated again.
 * Exit 0 dry / nothing to restate / written · 1 failed · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), os = require("os");
const L = require("./lib.cjs"), RL = L.RL;
const RS231 = require(path.join(L.REPO, "docs", "r231-sell-repair", "2026-10-12", "restate.cjs"));   // the broker reader (GETs only, paper only), feeSource, sourceWords, isTempCopy
const { nano, s9 } = L;
const STATE = "r191-crypto-trend.json", LEDGER = "r191-crypto-trend.jsonl", START = "2026-09-25";
const usd = (x) => (x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const noCid = (cid) => String(cid).replace(/^r191-/, "");   // ledger rows and record keys carry no client id (the sleeve compare reads an id as an order decided)

/** the change-registry row of the restate (pure) */
function registryRow({ P, id, mtDate, at, stateSha, backupRel, source }) {
  const moved = P.rows.filter((r) => r.fee > 0), sh = RL.feeShares(P), src = source || RS231.feeSource({ fromBroker: false, at, rows: [] });
  const hist = P.history.filter((h) => h.feeNano != null && h.beyondReceived != null);
  // WHICH broker rows make up a fee: read by the broker's own time (the rows of one order share one created_at: lib.cjs nameRows). A row named here
  // that another sleeve's record ALSO names is said here, never swapped for a row of that sleeve's moment (review 2026-10-15)
  const read = P.buys.filter((b) => b.feeNano != null), byTime = read.filter((b) => b.batch || (b.alsoNamed || []).length);
  const rowsNote = byTime.length ? `Which broker rows make up each fee is read by the broker's own time: the fee rows of one order are created together and share one created_at. ${byTime.map((b) => `${noCid(b.cid)}: ${b.batch ? `the ${b.feeRows.length} rows created together at ${b.batch}` : "the rows' times do not tell them apart; the rows named are the first set of that sum"}${(b.alsoNamed || []).map((a) => `; row ${a.id} is ALSO named by ${a.by}'s own restated record, written before this one, though the broker created it at ${a.at}${b.batch === a.at ? ", with this order's rows" : ""}${a.theirs.length ? ` — that record's own rows were created at ${a.theirs.join(", ")}` : ""}${a.twin ? `, where ${a.twin}, of the same quantity, is named by no record` : ""}`).join("")}`).join(". ")}. The amounts are the same either way, and no other sleeve's record was changed for it.` : null;
  return { id, date: mtDate, recordedAt: Date.parse(at), area: "R191 forward paper sleeve (Alpaca paper): the counts in backend/data/r191-crypto-trend.json", category: "restatement", breaksComparability: true, affectedFrom: mtDate,
    change: `One-time restatement of R191's count from the filled quantity of each buy still in a count to what the account received for it (the filled quantity less the fee the broker took in the coin). ${P.totals.read} buy(s) restated on ${moved.length} coin(s): ${moved.map((r) => `${r.coin} ${s9(nano(r.before))} -> ${s9(nano(r.after))} (fee ${s9(nano(r.fee))}; at its last recorded close, ${r.markDay} @ ${r.close}, ${usd(r.usdBefore)} -> ${usd(r.usdAfter)}, ${usd(r.usdDiff)})`).join("; ")}. Each restated order row carries fee, net, feeBasis and feeRows (the broker's rows the fee was read from: id, time or date, quantity); qty stays the filled quantity. The fee rows came from ${RS231.sourceWords(src)}.${P.settled.length ? ` ${P.settled.length} earlier buy(s) were NOT restated: their coin has since closed, and their fee went with that close (${P.settled.map((x) => x.cid).join(", ")}).` : ""}${hist.length ? ` For the record (no count moved): ${hist.map((h) => `the buy ${h.cid} was charged ${s9(h.feeNano)} ${h.coin} (${(100 * h.share).toFixed(4)}% of its filled ${h.qty}; rows ${h.feeRows.map((r) => r.id).join(", ")}); its full sell ${h.closedBy} asked ${h.sellAsked}, ${s9(nano(h.beyondReceived))} ${h.coin} (${h.beyondUsd == null ? "dollars unknown" : "$" + h.beyondUsd.toFixed(2)} at that sell's fill price) more than the account had received for the buy, taken from the shared balance (another sleeve's ${h.coin})`).join("; ")}.` : ""} No order was sent, no other sleeve's file was written.`,
    why: "The broker takes the fee of a crypto buy in the coin, so the account holds less than the runner counted; a full sell asked for the count (R191's ETH, 2026-10-09, filled only by taking R231's ETH). Operator 2026-10-13 08:39 MT: \"repair R191\" (docs/r191-sell-repair/2026-10-14).",
    comparabilityNote: `From ${mtDate} R191's counts, and every figure worked from them (the qty on each later mark row, any dollar figure rebuilt from the counts), are NET of the buy fee; before it they were the filled quantities, higher by the fee: ${sh.words}, as read from the fee rows. Rows already recorded stay as written: the mark rows written before this keep the filled quantity in their qty field. The runner's reader (--read) computes its daily return from the mark rows' close and held alone, so what it computes is the same before and after; whether the registered statistic's sentence ("Daily (UTC) return of the paper book (fills, then marks ...)") and that reader differ is the registrar's to rule on.`,
    doesNotEstablish: "A read of R191 (365 days; no verdict is recorded). That the account holds the restated count for R191: the board mirror's full crypto sells took their own fees out of the shared balance (docs/r231-sell-repair/2026-10-12/evidence.cjs, part 3); the repaired runner's sell cap deals with that when the coin is sold.",
    owed: "The dated note R191-A3 in R191's registry entry (note.cjs, its text in docs/r191-sell-repair/2026-10-14/NOTES.md). The board's Alpaca mirror still sells crypto at the filled quantity (report only, awaiting the operator).",
    operator: "Josh 2026-10-13 08:39 MT (\"repair R191\")", before: Object.fromEntries(P.rows.map((r) => [r.coin, r.before])), after: Object.fromEntries(P.rows.map((r) => [r.coin, r.after])), usdBefore: P.totals.usdBefore, usdAfter: P.totals.usdAfter, usdDiff: P.totals.usdDiff,
    feeSource: src, feeSharePct: { min: sh.min, max: sh.max, buys: sh.n }, fees: Object.fromEntries(read.map((b) => [noCid(b.cid), { fee: b.fee, rows: (b.feeRows || []).map((r) => r.id), ...(b.batch ? { createdTogetherAt: b.batch } : {}), ...((b.alsoNamed || []).length ? { alsoNamedBy: Object.fromEntries(b.alsoNamed.map((a) => [a.id, { by: a.by, createdAt: a.at, theirRowsCreatedAt: a.theirs, sameQuantityNamedByNoRecord: a.twin }])) } : {}) }])), ...(rowsNote ? { feeRowsNote: rowsNote } : {}),
    history: Object.fromEntries(hist.map((h) => [noCid(h.cid), { fee: h.fee, sharePct: +(100 * h.share).toFixed(4), rows: h.feeRows.map((r) => r.id), closedBy: noCid(h.closedBy), sellAsked: h.sellAsked, beyondReceived: h.beyondReceived, beyondUsd: h.beyondUsd }])),
    stateShaBefore: stateSha, backup: backupRel, files: [`${L.PKG_REL}/restate.cjs`, "backend/data/r191-crypto-trend.json", "backend/data/r191-crypto-trend.jsonl"] };
}

/**
 * The restate, start to finish. `dataDir` holds the files; `rows` = the CFEE rows when GIVEN (`rowsFile`: { path, sha256 }), else `fetchRows(sinceMs)`
 * is asked — the broker; `saveRows(rows)` keeps what the broker gave (the dry fixture); `apply` = the write mode; the fence inputs, `backupDir`,
 * `lockWaitMs`, `tmpRoot`, `afterStateWrite()` and `writeRegistry(file, list)` are injectable (the selftest runs all of it on temp copies).
 * GIVEN ROWS NEVER WRITE THE REAL DATA FOLDER. -> { code, result: "dry" | "nothing" | "refused" | "written" | "failed", why, plan, row, source }
 */
async function restateRun({ dataDir = path.join(L.REPO, "backend", "data"), rows, rowsFile, fetchRows, saveRows, apply = false, ms, procList, holidays, chain, root = L.REPO, backupDir = L.BACKUP_DIR, out = console.log, lockWaitMs = 120000, afterStateWrite, writeRegistry = (file, list) => L.atomic().writeJsonAtomic(file, list), tmpRoot } = {}) {
  const D = (f) => path.join(dataDir, f), say = out, mt = RL.mtNow(ms);
  say(`RESTATE ${apply ? "(WRITE MODE)" : "(DRY — nothing is written)"} — R191's count, from the filled quantity of each buy to what the account received — ${mt.dow} ${mt.date} ${mt.hms} MT`);
  if (apply && rows !== undefined && !RS231.isTempCopy(dataDir, tmpRoot)) { say("REFUSED — nothing written: the fee rows were GIVEN (a file), not read from the broker by this run. The count on file is never written from a file of rows: the write mode reads the broker itself."); return { code: 2, result: "refused", why: ["given fee rows cannot write the real data folder"] }; }
  let buf, state, ledgerBuf, ledgerRows;
  try { buf = fs.readFileSync(D(STATE)); state = JSON.parse(buf.toString("utf8")); ledgerBuf = fs.readFileSync(D(LEDGER)); ledgerRows = ledgerBuf.toString("utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); }
  catch (e) { say(`REFUSED — nothing written: R191's state or ledger cannot be read (${String(e.message).slice(0, 120)})`); return { code: 2, result: "refused", why: ["state or ledger unreadable"] }; }
  const others = L.readOthers(dataDir);
  if (others.notes.length) { say(`REFUSED — nothing written: ${others.notes.join("; ")} — the restate needs the other sleeves' buys to tell fee rows apart`); return { code: 2, result: "refused", why: others.notes }; }
  const OB = L.openBuys(state), todo = OB.todo.map((r) => r.o);
  if (!todo.length && !OB.unknown.some((u) => u.open)) { say(`  nothing to restate: every buy still in a count already carries its fee${state.netOfFee ? ` (restated ${state.netOfFee.restatedAt})` : ""}${OB.settled.length ? `; ${OB.settled.length} buy(s) of a coin that has since closed are settled and left as they are (${OB.settled.map((x) => x.cid).join(", ")})` : ""}.`); return { code: 0, result: "nothing", why: [] }; }
  const at = new Date(ms === undefined ? Date.now() : ms).toISOString(), fromBroker = rows === undefined;
  let cfee = rows, src = rowsFile && rowsFile.path ? `the FILE given (${rowsFile.path}) — not the broker` : "rows GIVEN to this run — not the broker";
  if (fromBroker) {
    src = "the broker (GET /v2/account/activities/CFEE, paper)";
    const since = Math.min(...[...todo, ...OB.settled.map((x) => x.o)].map((o) => Date.parse(o.at)).filter(Number.isFinite), Date.parse(START + "T00:00:00Z"));
    try { cfee = await fetchRows(since); } catch (e) { say(`REFUSED — nothing written: the broker's fee rows could not be read (${String(e.message).slice(0, 120)})`); return { code: 2, result: "refused", why: ["fee rows unreadable"] }; }
    if (saveRows && !apply) { try { say(`  ${saveRows(cfee)}`); } catch (e) { say(`  the fee rows could not be kept as a fixture (${String(e.message).slice(0, 120)}) — the dry run goes on`); } }
  }
  const P = L.restatePlan({ state, ledgerRows, cfee, others });
  if (!P.totals) { say(`REFUSED — nothing written: ${P.problems.join("; ")}`); return { code: 2, result: "refused", why: P.problems, plan: P }; }
  const source = RS231.feeSource({ fromBroker, at, rows: cfee, file: rowsFile }), keys = [...new Set((Array.isArray(cfee) ? cfee : []).flatMap((r) => Object.keys(r || {})))].sort();
  const timed = cfee.filter((r) => r && Number.isFinite(Date.parse(r.created_at))).length;
  say(`  fee rows read from ${src}: ${cfee.length} (fields: ${keys.join(", ") || "none"})`);
  say(`  of them ${timed} carry a time (created_at) and ${cfee.length - timed} do not`);
  say(`  the ${P.buys.length} buy(s) still in a count and not yet counted net:`);
  for (const b of P.buys) say(`    ${b.cid.padEnd(24)} ${String(b.at).slice(0, 19)}Z  filled ${String(b.qty).padStart(14)}  ${b.feeNano == null ? `fee UNREAD — ${b.why}` : `fee ${s9(b.feeNano)} (${(100 * b.share).toFixed(4)}%)  ${b.basis}  [${b.feeRows.map((r) => r.id).join(", ")}]`}`);
  if (P.history.length) { say(`  ${P.history.length} earlier buy(s) are SETTLED and left as they are — no count moves for them; their fee, FOR THE RECORD:`);
    for (const h of P.history) say(`    ${h.cid.padEnd(24)} ${h.settled}; ${h.feeNano == null ? `its fee could not be read (${h.why})` : `fee ${s9(h.feeNano)} (${(100 * h.share).toFixed(4)}%)  ${h.basis}  [${h.feeRows.map((r) => r.id).join(", ")}]${h.beyondReceived != null ? `; its full sell ${h.closedBy} asked ${h.sellAsked}, ${s9(nano(h.beyondReceived))} ${h.coin} (${h.beyondUsd == null ? "dollars unknown" : "$" + h.beyondUsd.toFixed(2)} at ${h.sellPx}) more than the account had received for it — taken from the shared balance` : ""}`}`); }
  say("  coin   count before       fee of its buys   count after          $ before     $ after   difference   (at its last recorded close)");
  for (const r of P.rows) say(`  ${r.coin.padEnd(5)} ${s9(nano(r.before)).padStart(16)} ${s9(nano(r.fee)).padStart(16)} ${s9(nano(r.after)).padStart(16)} ${(r.usdBefore == null ? "-" : usd(r.usdBefore)).padStart(12)} ${(r.usdAfter == null ? "-" : usd(r.usdAfter)).padStart(11)} ${(r.usdDiff == null ? "-" : usd(r.usdDiff)).padStart(11)}   ${r.markDay} @ ${r.close}${r.pending ? "   (an order of its own is pending: its fill is booked by the runner)" : ""}`);
  say(`  total ${"".padEnd(50)} ${usd(P.totals.usdBefore).padStart(12)} ${usd(P.totals.usdAfter).padStart(11)} ${usd(P.totals.usdDiff).padStart(11)}`);
  for (const c of P.checks) say(`  the broker's own words: ${c.coin} — "available ${c.said}" on ${String(c.on).slice(0, 10)}; restated ${c.restated}: ${c.binds ? (c.same ? "THE SAME, to the last digit" : "NOT THE SAME") : `not compared (${c.why})`}`);
  if (!P.checks.some((c) => c.binds)) say("  NOTE: R191's ledger holds no balance the broker stated for a coin no other sleeve has held, so nothing here compares a restated count with the account; the fees themselves are the broker's own rows.");
  if (P.problems.length) { say(`REFUSED — nothing written:\n  - ${P.problems.join("\n  - ")}`); return { code: 2, result: "refused", why: P.problems, plan: P }; }
  const id = `${L.RESTATE_ID}-${mt.date}`;
  say(`  the fees read come to ${RL.feeShares(P).words}`);
  if (!apply) { say(`DRY: nothing was written. The write mode would restate ${P.totals.read} buy(s) on ${P.totals.coins} coin(s) and add change-registry row ${id} (breaksComparability true).${fromBroker ? "" : " It reads the broker's fee rows itself: rows from a file never write the real data folder."}`); return { code: 0, result: "dry", why: [], plan: P, source }; }

  // ── the write mode ──
  const fz = L.fences({ ms, procList, holidays, chain, root }); if (fz.length) { say(`REFUSED — nothing written:\n  - ${fz.join("\n  - ")}`); return { code: 2, result: "refused", why: fz, plan: P }; }
  const LOCK = D("registry-write.lock"), token = `${process.pid}-${Date.now()}`; let held = false, wrote = false;
  const wait = (n) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
  try {
    for (const t0 = Date.now(); ;) { try { const fd = fs.openSync(LOCK, "wx"); held = true; fs.writeSync(fd, JSON.stringify({ token, pid: process.pid, by: `${L.PKG_REL}/restate.cjs`, id, at }) + "\n"); fs.closeSync(fd); break; } catch (e) { if (e.code !== "EEXIST") throw new Error(`cannot create the lock file (${e.code || e.message})`); if (Date.now() - t0 >= lockWaitMs) { say("REFUSED — nothing written: backend/data/registry-write.lock was held by another writer"); return { code: 2, result: "refused", why: ["registry lock held"], plan: P }; } wait(Math.min(1000, lockWaitMs)); } }
    const fz2 = L.fences({ ms, procList, holidays, chain, root }); if (fz2.length) { say(`REFUSED — nothing written:\n  - ${fz2.join("\n  - ")}`); return { code: 2, result: "refused", why: fz2, plan: P }; }
    let cr; try { cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8")); } catch (e) { say(`REFUSED — nothing written: change-registry.json cannot be read (${String(e.message).slice(0, 80)})`); return { code: 2, result: "refused", why: ["change-registry unreadable"], plan: P }; }
    if (!Array.isArray(cr)) { say("REFUSED — nothing written: change-registry.json is not a list"); return { code: 2, result: "refused", why: ["change-registry not a list"], plan: P }; }
    if (cr.some((x) => x && x.id === id)) { say(`REFUSED — nothing written: change-registry already holds ${id}`); return { code: 2, result: "refused", why: ["row already there"], plan: P }; }
    if (!fs.readFileSync(D(STATE)).equals(buf) || !fs.readFileSync(D(LEDGER)).equals(ledgerBuf)) { say("REFUSED — nothing written: R191's state or ledger changed while this was running (run it again)"); return { code: 2, result: "refused", why: ["state changed"], plan: P }; }
    const sha = L.sha256(buf), bak = path.join(backupDir, `backend__data__${STATE}.pre-restate-${sha.slice(0, 12)}`);
    fs.mkdirSync(backupDir, { recursive: true }); if (!fs.existsSync(bak)) fs.copyFileSync(D(STATE), bak);
    if (L.sha256(fs.readFileSync(bak)) !== sha) { say("REFUSED — nothing written: the backup of the state does not verify"); return { code: 2, result: "refused", why: ["backup"], plan: P }; }
    const rel = path.relative(L.REPO, bak).replace(/\\/g, "/"), backupRel = rel.startsWith("..") ? bak.replace(/\\/g, "/") : rel;
    const next = L.restateState(state, P, { at, id, date: mt.date, source }), row = registryRow({ P, id, mtDate: mt.date, at, stateSha: sha, backupRel, source });
    try {
      wrote = true; L.atomic().writeJsonAtomic(D(STATE), next);
      if (afterStateWrite) afterStateWrite();
      fs.appendFileSync(D(LEDGER), (ledgerBuf.length && ledgerBuf[ledgerBuf.length - 1] !== 10 ? "\n" : "") + JSON.stringify({ ts: at, kind: "counts-restated", by: `${L.PKG_REL}/restate.cjs`, changeRegistry: id, feeSource: source, coins: Object.fromEntries(P.rows.filter((r) => r.fee > 0).map((r) => [r.coin, { before: r.before, fee: r.fee, after: r.after }])), buys: Object.fromEntries(P.buys.filter((b) => b.feeNano != null).map((b) => [noCid(b.cid), { fee: b.fee, rows: (b.feeRows || []).map((r) => r.id) }])), history: row.history, usdBefore: P.totals.usdBefore, usdAfter: P.totals.usdAfter }) + "\n");
      cr.push(row); writeRegistry(D("change-registry.json"), cr);
      const back = JSON.parse(fs.readFileSync(D(STATE), "utf8")), cr2 = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
      if (!P.rows.every((r) => back.coins[r.coin].qty === r.after) || cr2[cr2.length - 1].id !== id || cr2.length !== cr.length) throw new Error("the files do not read back as written");
    } catch (e) {
      let restored = true; try { RL.writeExact(D(STATE), buf); RL.writeExact(D(LEDGER), ledgerBuf); restored = fs.readFileSync(D(STATE)).equals(buf) && fs.readFileSync(D(LEDGER)).equals(ledgerBuf); } catch { restored = false; }
      say(`RESTATE FAILED: ${e.message} — ${restored ? "R191's state and ledger were put back to their bytes" : "NOT RESTORED: put backend/data/" + STATE + " back from " + bak} (look at change-registry.json for a row ${id}: there should be none)`);
      return { code: 1, result: "failed", why: [e.message], restored, plan: P };
    }
    say(`RESTATED: ${P.totals.read} buy(s) on ${P.totals.coins} coin(s); ${P.rows.filter((r) => r.fee > 0).map((r) => `${r.coin} ${s9(nano(r.before))} -> ${s9(nano(r.after))} (${usd(r.usdDiff)})`).join(", ")}. Backup ${row.backup}. Change-registry row ${id} (breaksComparability true).`);
    say(`  The fee rows came from ${RS231.sourceWords(source)}; the restated order row names the rows its fee was read from.`);
    say("  To undo: copy the backup over backend/data/r191-crypto-trend.json outside the same fences, and say so in a change-registry row (rows are never removed).");
    return { code: 0, result: "written", why: [], plan: P, row, source };
  } finally { if (held) { try { if (JSON.parse(fs.readFileSync(LOCK, "utf8")).token === token) fs.unlinkSync(LOCK); } catch { if (wrote || fs.existsSync(LOCK)) say(`could not remove ${LOCK} — look at it by hand`); } } }
}

const USAGE = "usage: node docs/r191-sell-repair/2026-10-14/restate.cjs --dry [--rows <file.json> | --save-rows <file under harness/recorded/>] [--data <a copy under the temp folder>]\n       node docs/r191-sell-repair/2026-10-14/restate.cjs --apply [--data <a copy under the temp folder>]\n  --dry reads and prints before and after, writes nothing; --apply is the write mode (the main session's command).\nNothing was done.";
/** the command line, read and judged BEFORE anything is opened (pure) -> { opt } or { refuse: words } (exit 2, nothing done) */
function parseArgs(a) {
  const opt = { dry: false, apply: false }; let bad = false;
  for (let i = 0; i < a.length; i++) { if (a[i] === "--dry") opt.dry = true; else if (a[i] === "--apply") opt.apply = true; else if (a[i] === "--rows" && a[i + 1]) opt.rowsFile = a[++i]; else if (a[i] === "--save-rows" && a[i + 1]) opt.saveRows = a[++i]; else if (a[i] === "--data" && a[i + 1]) opt.data = a[++i]; else bad = true; }
  if (bad || opt.dry === opt.apply) return { refuse: USAGE };
  if (opt.apply && opt.rowsFile && !opt.data) return { refuse: "--apply with --rows is REFUSED on the real data folder: the count on file is never written from a file of rows. The write mode reads the broker's fee rows itself (run it without --rows); --rows is for the dry look, and for a COPY under the system temp folder (--data).\nNothing was done." };
  if (opt.saveRows && (opt.apply || opt.rowsFile)) return { refuse: "--save-rows keeps the rows the BROKER gave a DRY run: it takes neither --apply nor --rows.\nNothing was done." };
  if (opt.saveRows) { const p = path.resolve(opt.saveRows), dir = path.join(L.PKG, "harness", "recorded"), r = path.relative(dir, p); if (!r || r.startsWith("..") || path.isAbsolute(r) || !/\.json$/.test(p)) return { refuse: `--save-rows writes a fixture under ${path.relative(L.REPO, dir).replace(/\\/g, "/")}/ only, as a .json file.\nNothing was done.` }; }
  return { opt };
}

if (require.main === module) {
  (async () => {
    const A = parseArgs(process.argv.slice(2));
    if (A.refuse) { console.log(A.refuse); process.exit(2); }
    const opt = A.opt, run = {};
    if (opt.data) { const d = fs.realpathSync(path.resolve(opt.data)); if (!RS231.isTempCopy(d)) { console.log("--data takes a COPY under the system temp folder only. Nothing was done."); process.exit(2); } run.dataDir = d; run.backupDir = path.join(d, "backups"); }
    if (opt.rowsFile) { try { const raw = fs.readFileSync(opt.rowsFile); run.rows = JSON.parse(raw.toString("utf8")); if (!Array.isArray(run.rows)) throw new Error("not a list"); run.rowsFile = { path: path.resolve(opt.rowsFile).replace(/\\/g, "/"), sha256: L.sha256(raw) }; } catch (e) { console.log(`--rows: ${opt.rowsFile} cannot be read as a JSON list (${e.message}). Nothing was done.`); process.exit(2); } }
    else run.fetchRows = async (sinceMs) => { require(path.join(L.REPO, "backend", "node_modules", "dotenv")).config({ path: path.join(L.REPO, "backend", ".env") }); return RS231.brokerRows({ sinceMs, keyId: process.env.ALPACA_KEY_ID, secret: process.env.ALPACA_SECRET_KEY }); };
    if (opt.saveRows) run.saveRows = (rows) => { const f = path.resolve(opt.saveRows); fs.mkdirSync(path.dirname(f), { recursive: true }); L.atomic().writeJsonAtomic(f, { schema: "r191-sell-repair-cfee-rows-v1", readAt: new Date().toISOString(), read: "GET /v2/account/activities/CFEE on the paper endpoint, by restate.cjs --dry --save-rows", rowsSha256: L.sha256(Buffer.from(JSON.stringify(rows))), rows }); return `the ${rows.length} fee rows the broker gave are kept as a fixture: ${path.relative(L.REPO, f).replace(/\\/g, "/")}`; };
    const r = await restateRun({ ...run, apply: opt.apply });
    if (opt.apply) L.logRow({ script: "restate", result: r.result, why: r.why, id: r.row && r.row.id });
    process.exitCode = r.code;   // never process.exit() after a fetch: on Windows it can abort node while the TLS socket is still closing (seen 2026-10-14: a libuv assertion, exit 127); the idle socket does not hold the process
  })().catch((e) => { console.error(`restate FAILED: ${e && e.stack ? e.stack : e}`); process.exitCode = 1; });
}
module.exports = { restateRun, registryRow, parseArgs, STATE, LEDGER, noCid };
