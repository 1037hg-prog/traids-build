#!/usr/bin/env node
"use strict";
/**
 * R231 SELL REPAIR (2026-10-12; operator: "repair") — THE ONE-TIME RESTATE of R231's thirteen counts, from GROSS to NET OF THE BUY FEE.
 *
 *   node docs/r231-sell-repair/2026-10-12/restate.cjs                    DRY (the default). Reads R231's state and ledger, the other
 *                                                                        sleeves' files, and the broker's fee rows (one kind of call: GET
 *                                                                        /v2/account/activities/CFEE on the PAPER endpoint). Prints every
 *                                                                        buy with the fee read for it, then each coin before and after, in
 *                                                                        coin and in dollars. WRITES NOTHING.
 *   node docs/r231-sell-repair/2026-10-12/restate.cjs --rows <file.json> the same with the fee rows taken from a file (a JSON list of CFEE
 *                                                                        rows): no call to the broker at all
 *   node docs/r231-sell-repair/2026-10-12/restate.cjs --apply            the write mode — the main session's command, never run by the
 *                                                                        build. It reads the fee rows from the BROKER itself. --apply with
 *                                                                        --rows is REFUSED on the real data folder: counts on file are
 *                                                                        never written from a file of rows (only on a --data copy)
 *   ... --data <folder>                                                  work on a COPY of the data folder; only a folder under the system
 *                                                                        temp dir is accepted (the selftest)
 *
 * WHAT IT DOES. Each buy in the state's order rows that carries no fee yet was counted at its filled quantity. For each one the fee the
 * broker charged is read from its CFEE rows (lib.cjs feeOfBuy: the rows of that coin created from 5 s before to 120 s after the fill; for a
 * buy that shares its two minutes with another sleeve's buy of the same coin, lib.cjs splitFee). Each coin's count comes down by the fees of
 * ITS OWN buys, its `notional` in the same proportion, and each restated order row gets `fee`, `net` and `feeBasis`. Nothing else moves a
 * count: not what the account holds today, not what another sleeve's sell took out of the shared balance (the runner's cap deals with that
 * at the sell). It never writes another sleeve's file.
 * ONLY THE BUYS STILL IN A COUNT (lib.cjs openBuys). A buy before its coin's LAST FLAT is settled and left as it is: when the coin was
 * closed — the repaired runner wrote off what the account never had, on the sell row — that buy's fee went with the close, and taking it off
 * again would put the count BELOW what the account holds. So this can be run before or after a coin has closed: a coin that counts 0 is not
 * touched, and a coin bought again after a close is restated only for the buys since.
 * IT REFUSES, and writes nothing, when: a fee cannot be read; a restated count is not the balance the broker itself stated for that coin
 * where that statement binds (BCH and DOGE, the two refusals of 2026-10-09 kept in R231's ledger — this is the check that the fee rows read
 * really explain the account); a count would go below zero; another sleeve's file cannot be read; the state changes while it runs; and, in
 * the write mode, under the same fences as deploy.cjs (trading weekday 05:30-16:00 MT, 13:50-15:50 MT any day, the close chain not on record
 * as finished for the last session, the runner running).
 * THE WRITE MODE writes, in this order, under backend/data/registry-write.lock: a byte-exact backup of the state file (backups/ here); the
 * state (backend/lib/atomic-write.js); one row in R231's own ledger (kind "counts-restated", no client id); ONE change-registry row with
 * breaksComparability true. A failure after the first write puts the state and the ledger back from the bytes read at the start.
 * WHERE EVERY FIGURE CAME FROM IS ON THE RECORD. Each restated order row keeps the broker's rows its fee was read from (`feeRows`: id, time or
 * date, quantity — for a buy split from another sleeve's, the rows picked). The state's note, the ledger row and the change-registry row carry
 * `feeSource`: the broker, with the time of the read, or a file, with its path — and the sha256 of the rows either way. The share of a fill
 * the fees came to is worked from the rows read (smallest and largest), never typed.
 * Run twice it does nothing the second time: a buy whose row already carries its fee is not restated again. It can be run again later for a
 * buy the runner booked "fee UNKNOWN".
 * Exit 0 dry / nothing to restate / written · 1 failed · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), os = require("os");
const L = require("./lib.cjs");
const { nano, s9 } = L;
const STATE = "r231-crypto-vote-sized.json", LEDGER = "r231-crypto-vote-sized.jsonl", START = "2026-09-25";
const usd = (x) => (x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The broker's CFEE rows back to the day before `sinceMs`: GETs only, the PAPER endpoint only, newest first (the paging of
 * backend/r309-surge-hold48.js). `fetchImpl`, `keyId` and `secret` are injectable (the selftest); by default the keys come from backend/.env
 * and are never printed.
 */
async function brokerRows({ sinceMs, fetchImpl = globalThis.fetch, keyId, secret, base = "https://paper-api.alpaca.markets" }) {
  if (!/^https:\/\/paper-api\./.test(base)) throw new Error("not the paper endpoint");
  if (!keyId || !secret) throw new Error("no paper keys");
  const out = [], stop = new Date(sinceMs - 864e5).toISOString().slice(0, 10); let token = null, done = false;
  for (let i = 0; i < 50 && !done; i++) {
    const r = await fetchImpl(`${base}/v2/account/activities/CFEE?direction=desc&page_size=100${token ? "&page_token=" + encodeURIComponent(token) : ""}`, { method: "GET", headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret } });
    const page = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`the broker answered ${r.status} to the CFEE read`);
    if (!Array.isArray(page)) throw new Error("the CFEE answer is not a list");
    out.push(...page); const last = page[page.length - 1];
    if (page.length < 100 || String((last && (last.date || last.created_at)) || "").slice(0, 10) < stop) done = true; else token = last.id;
  }
  if (!done) throw new Error("more than 50 pages of CFEE rows");
  return out;
}

/**
 * WHERE THE FEE ROWS CAME FROM, for the permanent records (pure). `fromBroker`: this run read them from the broker itself. Otherwise they were
 * GIVEN — a file (`file`: { path, sha256 } from the command line) or rows handed in by a caller — and the record says so in plain words: a
 * figure written from given rows is never recorded as "read from the broker". `rowsSha256` is of JSON.stringify(rows), the rows as used.
 */
function feeSource({ fromBroker, at, rows, file }) {
  const n = Array.isArray(rows) ? rows.length : 0, rowsSha256 = L.sha256(Buffer.from(JSON.stringify(rows || [])));
  if (fromBroker) return { kind: "broker", read: "GET /v2/account/activities/CFEE on the paper endpoint, read by this run", readAt: at, rows: n, rowsSha256 };
  return { kind: "file", notReadFromTheBroker: true, read: file && file.path ? `fee rows taken from a FILE (${file.path}), not read from the broker by this run` : "fee rows GIVEN to this run by its caller, not read from the broker by it", path: (file && file.path) || null, fileSha256: (file && file.sha256) || null, givenAt: at, rows: n, rowsSha256 };
}
const sourceWords = (src) => (src.kind === "broker" ? `the broker itself (${src.read}, at ${src.readAt}; ${src.rows} rows, sha256 ${src.rowsSha256.slice(0, 16)})` : `NOT THE BROKER — ${src.read} (${src.rows} rows, sha256 ${src.rowsSha256.slice(0, 16)}${src.fileSha256 ? `; the file's sha256 ${src.fileSha256.slice(0, 16)}` : ""})`);

/** the change-registry row of a restate (pure). `source` = feeSource(): where the fee rows were read from. */
function registryRow({ P, id, mtDate, at, stateSha, backupRel, source }) {
  const moved = P.rows.filter((r) => r.fee > 0), d = P.totals.usdAfter - P.totals.usdBefore, sh = L.feeShares(P), src = source || feeSource({ fromBroker: false, at, rows: [] });
  return { id, date: mtDate, recordedAt: Date.parse(at), area: "R231 forward paper sleeve (Alpaca paper): the counts in backend/data/r231-crypto-vote-sized.json", category: "restatement", breaksComparability: true, affectedFrom: mtDate,
    change: `One-time restatement of R231's counts from the filled quantity of each buy to what the account received for it (the filled quantity less the fee the broker took in the coin). ${P.totals.read} buys restated on ${moved.length} coins: ${moved.map((r) => `${r.coin} ${r.before} -> ${r.after} (fee ${s9(nano(r.fee))})`).join("; ")}. At each coin's last recorded close the book reads ${usd(P.totals.usdBefore)} before and ${usd(P.totals.usdAfter)} after (${usd(d)}). Each restated order row carries fee, net, feeBasis and feeRows (the broker's rows the fee was read from: id, time or date, quantity); qty stays the filled quantity. The fee rows came from ${sourceWords(src)}.${(P.settled || []).length ? ` ${P.settled.length} earlier buy(s) were NOT restated: their coin has since closed flat, and their fee went with that close (${P.settled.map((x) => x.cid).join(", ")}).` : ""} No order was sent, no other sleeve's file was written.`,
    why: "The broker takes the fee of a crypto buy in the coin, so the account holds less than the runner counted (BCH: counted 1.324516485, held 1.321205193). A full sell asked for the count and was refused (BCH and DOGE, 2026-10-09). Operator 2026-10-12: \"repair\" (docs/r231-sell-repair/2026-10-12).",
    comparabilityNote: `From ${mtDate} the counts, and every figure worked from them (each coin's 'current $' in the nightly log, the rebalance comparison against the $200 threshold, the dollars a screen shows for the book), are NET of the buy fee; before it they were the filled quantities, higher by the fee: ${sh.words}, as read from the fee rows. Rows already recorded stay as written. The daily mark rows hold no quantity (coin, day, close, eligible, w, k): none was changed. The runner's reader (--read) computes from those mark rows alone, so what it computes is the same before and after; the registered statistic's own sentence speaks of "realised forward fills", and whether that sentence and the reader differ is the registrar's to rule on (it is older than this repair).`,
    doesNotEstablish: "A read of R231 (365 days; no verdict is recorded). That the account holds every restated count: other sleeves' full sells took their own fees out of the shared balance (docs/r231-sell-repair/2026-10-12/evidence.cjs, part 3); the runner's sell cap deals with that when a coin is sold.",
    owed: "A dated note in R231's registry entry (the registrar; wording in docs/r231-sell-repair/2026-10-12/NOTES.md). backend/profit-program/pp-paper-legs.js still rebuilds R231's dollars from each order's qty (the filled quantity): it should read `net` where a row has it.",
    operator: `Josh 2026-10-12 ("repair")`, before: Object.fromEntries(P.rows.map((r) => [r.coin, r.before])), after: Object.fromEntries(P.rows.map((r) => [r.coin, r.after])), usdBefore: P.totals.usdBefore, usdAfter: P.totals.usdAfter,
    feeSource: src, feeSharePct: { min: sh.min, max: sh.max, buys: sh.n }, fees: Object.fromEntries(P.buys.filter((b) => b.feeNano != null).map((b) => [b.cid, { fee: b.fee, rows: (b.feeRows || []).map((r) => r.id) }])),
    stateShaBefore: stateSha, backup: backupRel, files: [`${L.PKG_REL}/restate.cjs`, "backend/data/r231-crypto-vote-sized.json", "backend/data/r231-crypto-vote-sized.jsonl"] };
}
/** is `dir` a folder under the system temp folder (a COPY the selftest made), not the real data folder? `tmpRoot` is injectable (the selftest) */
function isTempCopy(dir, tmpRoot = os.tmpdir()) {
  try { const r = path.relative(fs.realpathSync(tmpRoot), fs.realpathSync(path.resolve(dir))); return !!r && !r.startsWith("..") && !path.isAbsolute(r); } catch { return false; }
}

/**
 * The restate, start to finish. `dataDir` holds the files; `rows` = the CFEE rows when they are GIVEN (`rowsFile`: { path, sha256 } when they
 * came from a file), else `fetchRows(sinceMs)` is asked — the broker; `apply` = the write mode; the fence inputs, `backupDir`, `lockWaitMs`
 * and `tmpRoot` are injectable (the selftest runs all of it on a temp copy). So are the two points a write can fail at after the state is
 * on disk: `afterStateWrite()` (called before the ledger row is appended) and `writeRegistry(file, rows)` (the change-registry write itself,
 * which comes AFTER the ledger row: by default backend/lib/atomic-write.js) — a failure at either puts the state AND the ledger back.
 * GIVEN ROWS NEVER WRITE THE REAL DATA FOLDER: the write mode with `rows` given is refused unless `dataDir` is a copy under the system temp
 * folder. On the real folder the write mode reads the broker itself, and every record names its source (feeSource).
 * -> { code, result: "dry" | "nothing" | "refused" | "written" | "failed", why, plan, row, source }
 */
async function restateRun({ dataDir = path.join(L.REPO, "backend", "data"), rows, rowsFile, fetchRows, apply = false, ms, procList, holidays, chain, root = L.REPO, backupDir = L.BACKUP_DIR, out = console.log, lockWaitMs = 120000, afterStateWrite, writeRegistry = (file, list) => L.atomic().writeJsonAtomic(file, list), tmpRoot } = {}) {
  const D = (f) => path.join(dataDir, f), say = out, mt = L.mtNow(ms);
  say(`RESTATE ${apply ? "(WRITE MODE)" : "(DRY — nothing is written)"} — R231's counts, from the filled quantity of each buy to what the account received — ${mt.dow} ${mt.date} ${mt.hms} MT`);
  if (apply && rows !== undefined && !isTempCopy(dataDir, tmpRoot)) { say("REFUSED — nothing written: the fee rows were GIVEN (a file), not read from the broker by this run. The counts on file are never written from a file of rows: the write mode reads the broker itself. (Rows from a file are for the dry look, and for a COPY of the data folder under the system temp folder.)"); return { code: 2, result: "refused", why: ["given fee rows cannot write the real data folder"] }; }
  let buf, state, ledgerBuf, ledgerRows, others;
  try { buf = fs.readFileSync(D(STATE)); state = JSON.parse(buf.toString("utf8")); ledgerBuf = fs.readFileSync(D(LEDGER)); ledgerRows = ledgerBuf.toString("utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); }
  catch (e) { say(`REFUSED — nothing written: R231's state or ledger cannot be read (${String(e.message).slice(0, 120)})`); return { code: 2, result: "refused", why: ["state or ledger unreadable"] }; }
  others = L.readOthers(dataDir);
  if (others.notes.length) { say(`REFUSED — nothing written: ${others.notes.join("; ")} — the restate needs the other sleeves' buys to tell fee rows apart`); return { code: 2, result: "refused", why: others.notes }; }
  const OB = L.openBuys(state), todo = OB.todo.map((r) => r.o);   // the buys still in a count and not yet net; a buy before its coin's last flat is settled (lib.cjs openBuys)
  if (!todo.length && !OB.unknown.some((u) => u.open)) { say(`  nothing to restate: every buy still in a count already carries its fee${state.netOfFee ? ` (restated ${state.netOfFee.restatedAt})` : ""}${OB.settled.length ? `; ${OB.settled.length} buy(s) of a coin that has since closed flat are settled and left as they are (${OB.settled.map((x) => x.cid).join(", ")})` : ""}.`); return { code: 0, result: "nothing", why: [] }; }
  const at = new Date(ms === undefined ? Date.now() : ms).toISOString(), fromBroker = rows === undefined;
  let cfee = rows, src = rowsFile && rowsFile.path ? `the FILE given (${rowsFile.path}) — not the broker` : "rows GIVEN to this run — not the broker";
  if (fromBroker) { src = "the broker (GET /v2/account/activities/CFEE, paper)"; try { cfee = await fetchRows(Math.min(...todo.map((o) => Date.parse(o.at)).filter(Number.isFinite), Date.parse(START + "T00:00:00Z"))); } catch (e) { say(`REFUSED — nothing written: the broker's fee rows could not be read (${String(e.message).slice(0, 120)})`); return { code: 2, result: "refused", why: ["fee rows unreadable"] }; } }
  const P = L.restatePlan({ state, ledgerRows, cfee, others });
  if (!P.totals) { say(`REFUSED — nothing written: ${P.problems.join("; ")}`); return { code: 2, result: "refused", why: P.problems, plan: P }; }
  const source = feeSource({ fromBroker, at, rows: cfee, file: rowsFile }), keys = [...new Set((Array.isArray(cfee) ? cfee : []).flatMap((r) => Object.keys(r || {})))].sort();
  const timed = cfee.filter((r) => r && Number.isFinite(Date.parse(r.created_at))).length;
  say(`  fee rows read from ${src}: ${cfee.length} (fields: ${keys.join(", ") || "none"})`);
  say(`  of them ${timed} carry a time (created_at) and ${cfee.length - timed} do not: a coin whose rows carry a time is read by time (5 s before to 120 s after the fill); a coin whose rows carry only a date is read by date, and only for a buy that is the one buy of that coin on the account's files that day`);
  say(`  the ${P.buys.length} buys not yet counted net:`);
  for (const b of P.buys) say(`    ${b.cid.padEnd(24)} ${String(b.at).slice(0, 19)}Z  filled ${String(b.qty).padStart(16)}  ${b.feeNano == null ? `fee UNREAD — ${b.why}` : `fee ${s9(b.feeNano).padStart(14)} (${(100 * b.share).toFixed(4)}%)  ${b.basis}  [${b.feeRows.map((r) => r.id).join(", ")}]`}`);
  if (P.settled.length) { say(`  ${P.settled.length} earlier buy(s) are SETTLED and left as they are — no fee is taken off for them:`); for (const x of P.settled) say(`    ${x.cid.padEnd(24)} ${x.why}`); }
  say("  coin   count before         fee of its buys   count after          $ before     $ after   (at its last recorded close)");
  for (const r of P.rows) say(`  ${r.coin.padEnd(5)} ${s9(nano(r.before)).padStart(18)} ${s9(nano(r.fee)).padStart(16)} ${s9(nano(r.after)).padStart(18)} ${usd(r.usdBefore).padStart(12)} ${usd(r.usdAfter).padStart(11)}   ${r.markDay} @ ${r.close}${r.pending ? "   (an order of its own is pending: its fill is booked by the runner)" : ""}`);
  say(`  total ${"".padEnd(52)} ${usd(P.totals.usdBefore).padStart(12)} ${usd(P.totals.usdAfter).padStart(11)}   (${usd(P.totals.usdAfter - P.totals.usdBefore)})`);
  for (const c of P.checks) say(`  the broker's own words: ${c.coin} — "available ${c.said}" on ${String(c.on).slice(0, 10)}; restated ${c.restated}: ${c.binds ? (c.same ? "THE SAME, to the last digit" : "NOT THE SAME") : `not compared (${c.why})`}`);
  if (!P.checks.some((c) => c.binds)) say("  NOTE: no stated balance could be compared with a restated count this time, so nothing here checks that the fee rows explain the account.");
  if (P.problems.length) { say(`REFUSED — nothing written:\n  - ${P.problems.join("\n  - ")}`); return { code: 2, result: "refused", why: P.problems, plan: P }; }
  const id = `${L.RESTATE_ID}-${mt.date}`;
  say(`  the fees read come to ${L.feeShares(P).words}`);
  if (!apply) { say(`DRY: nothing was written. The write mode would restate ${P.totals.read} buys on ${P.totals.coins} coins and add change-registry row ${id} (breaksComparability true).${fromBroker ? "" : " It reads the broker's fee rows itself: rows from a file never write the real data folder."}`); return { code: 0, result: "dry", why: [], plan: P, source }; }

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
    if (!fs.readFileSync(D(STATE)).equals(buf) || !fs.readFileSync(D(LEDGER)).equals(ledgerBuf)) { say("REFUSED — nothing written: R231's state or ledger changed while this was running (run it again)"); return { code: 2, result: "refused", why: ["state changed"], plan: P }; }
    const sha = L.sha256(buf), bak = path.join(backupDir, `backend__data__${STATE}.pre-restate-${sha.slice(0, 12)}`);
    fs.mkdirSync(backupDir, { recursive: true }); if (!fs.existsSync(bak)) fs.copyFileSync(D(STATE), bak);
    if (L.sha256(fs.readFileSync(bak)) !== sha) { say("REFUSED — nothing written: the backup of the state does not verify"); return { code: 2, result: "refused", why: ["backup"], plan: P }; }
    const backupRel = path.relative(L.REPO, bak).replace(/\\/g, "/"), next = L.restateState(state, P, { at, id, date: mt.date, source }), row = registryRow({ P, id, mtDate: mt.date, at, stateSha: sha, backupRel: backupRel.startsWith("..") ? bak.replace(/\\/g, "/") : backupRel, source });
    try {
      wrote = true; L.atomic().writeJsonAtomic(D(STATE), next);
      if (afterStateWrite) afterStateWrite();
      fs.appendFileSync(D(LEDGER), (ledgerBuf.length && ledgerBuf[ledgerBuf.length - 1] !== 10 ? "\n" : "") + JSON.stringify({ ts: at, kind: "counts-restated", by: `${L.PKG_REL}/restate.cjs`, changeRegistry: id, feeSource: source, coins: Object.fromEntries(P.rows.filter((r) => r.fee > 0).map((r) => [r.coin, { before: r.before, fee: r.fee, after: r.after }])), buys: Object.fromEntries(P.buys.filter((b) => b.feeNano != null).map((b) => [b.cid.replace(/^r231-/, ""), { fee: b.fee, rows: (b.feeRows || []).map((r) => r.id) }])), usdBefore: P.totals.usdBefore, usdAfter: P.totals.usdAfter }) + "\n");
      cr.push(row); writeRegistry(D("change-registry.json"), cr);
      const back = JSON.parse(fs.readFileSync(D(STATE), "utf8")), cr2 = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
      if (!P.rows.every((r) => back.coins[r.coin].qty === r.after) || cr2[cr2.length - 1].id !== id || cr2.length !== cr.length) throw new Error("the files do not read back as written");
    } catch (e) {
      let restored = true; try { L.writeExact(D(STATE), buf); L.writeExact(D(LEDGER), ledgerBuf); restored = fs.readFileSync(D(STATE)).equals(buf) && fs.readFileSync(D(LEDGER)).equals(ledgerBuf); } catch { restored = false; }
      say(`RESTATE FAILED: ${e.message} — ${restored ? "R231's state and ledger were put back to their bytes" : "NOT RESTORED: put backend/data/" + STATE + " back from " + bak} (look at change-registry.json for a row ${id}: there should be none)`);
      return { code: 1, result: "failed", why: [e.message], restored, plan: P };
    }
    say(`RESTATED: ${P.totals.read} buys on ${P.totals.coins} coins; the book reads ${usd(P.totals.usdBefore)} -> ${usd(P.totals.usdAfter)} at the last recorded closes. Backup ${row.backup}. Change-registry row ${id} (breaksComparability true).`);
    say(`  The fee rows came from ${sourceWords(source)}; each restated order row names the rows its fee was read from.`);
    say("  To undo: copy the backup over backend/data/r231-crypto-vote-sized.json outside the same fences, and say so in a change-registry row (rows are never removed).");
    return { code: 0, result: "written", why: [], plan: P, row, source };
  } finally { if (held) { try { if (JSON.parse(fs.readFileSync(LOCK, "utf8")).token === token) fs.unlinkSync(LOCK); } catch { if (wrote || fs.existsSync(LOCK)) say(`could not remove ${LOCK} — look at it by hand`); } } }
}

const USAGE = "usage: node docs/r231-sell-repair/2026-10-12/restate.cjs [--rows <file.json>] [--apply] [--data <a copy under the temp folder>]\n  no flag = DRY: reads, prints before and after, writes nothing.\nNothing was done.";
/**
 * The command line, read and judged BEFORE anything is opened (pure) -> { opt } to go on, or { refuse: words } (exit 2, nothing done).
 * --apply with --rows and no --data is refused here: the write mode on the real data folder reads the broker itself, never a file of rows.
 */
function parseArgs(a) {
  const opt = { apply: false }; let bad = false;
  for (let i = 0; i < a.length; i++) { if (a[i] === "--apply") opt.apply = true; else if (a[i] === "--rows" && a[i + 1]) opt.rowsFile = a[++i]; else if (a[i] === "--data" && a[i + 1]) opt.data = a[++i]; else bad = true; }
  if (bad) return { refuse: USAGE };
  if (opt.apply && opt.rowsFile && !opt.data) return { refuse: "--apply with --rows is REFUSED on the real data folder: the counts on file are never written from a file of rows. The write mode reads the broker's fee rows itself (run it without --rows); --rows is for the dry look, and for a COPY under the system temp folder (--data).\nNothing was done." };
  return { opt };
}

if (require.main === module) {
  (async () => {
    const A = parseArgs(process.argv.slice(2));
    if (A.refuse) { console.log(A.refuse); process.exit(2); }
    const opt = A.opt, run = {};
    if (opt.data) { const d = fs.realpathSync(path.resolve(opt.data)); if (!isTempCopy(d)) { console.log("--data takes a COPY under the system temp folder only. Nothing was done."); process.exit(2); } run.dataDir = d; run.backupDir = path.join(d, "backups"); }
    if (opt.rowsFile) { try { const raw = fs.readFileSync(opt.rowsFile); run.rows = JSON.parse(raw.toString("utf8")); if (!Array.isArray(run.rows)) throw new Error("not a list"); run.rowsFile = { path: path.resolve(opt.rowsFile).replace(/\\/g, "/"), sha256: L.sha256(raw) }; } catch (e) { console.log(`--rows: ${opt.rowsFile} cannot be read as a JSON list (${e.message}). Nothing was done.`); process.exit(2); } }
    else run.fetchRows = async (sinceMs) => { require(path.join(L.REPO, "backend", "node_modules", "dotenv")).config({ path: path.join(L.REPO, "backend", ".env") }); return brokerRows({ sinceMs, keyId: process.env.ALPACA_KEY_ID, secret: process.env.ALPACA_SECRET_KEY }); };
    const r = await restateRun({ ...run, apply: opt.apply });
    if (opt.apply) L.logRow({ script: "restate", result: r.result, why: r.why, id: r.row && r.row.id });
    process.exit(r.code);
  })().catch((e) => { console.error(`restate FAILED: ${e && e.stack ? e.stack : e}`); process.exit(1); });
}
module.exports = { restateRun, brokerRows, registryRow, feeSource, sourceWords, isTempCopy, parseArgs, STATE, LEDGER };
