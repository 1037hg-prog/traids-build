#!/usr/bin/env node
/**
 * R311 read — PAPER-AUCTION-FIX 2026-10-02. Deploy as backend/r311-read.js. The ONE registered read of R311, R151's successor: the same
 * RSI-2 rule and three arms traded with plain DAY orders (A day market in the close-arm window, B day market queued pre-open, C day limit
 * at the signal close with day-market exits), on the same runner (backend/r151-rsi2-forward.js), state file and ledger as R151. R151 was
 * frozen execution-void: Alpaca paper barely fills the market-on-open/close orders it was built on (1 completed trade in 7 sessions).
 *
 * WHAT IS READ. Only R311's own record: ledger rows with test "R311" whose entry client_order_id starts "r311-", entries filled in the
 * evidence window 2026-10-05 .. 2026-10-16 (the 10th session; read after that day's close, seals once). R151 lots the runner still
 * manages carry test "R151" and exit under r151- client_order_ids; they are excluded by test AND entry prefix.
 *   primary    arm A: mean per-trade return, t across ENTRY SESSIONS (session-clustered), against the bar in the registry entry
 *   secondary  A - B on signals both arms traded (same symbol, same signal date); C's fill rate and mean; B and C alone; partial entries
 * ONE TRADE = ONE ENTRY LOT. A lot exited in parts (partial fills, the remainder re-sent -S2/-S3) is one trade at the quantity-weighted
 * mean of its exit fills. Any quantity still open at the read — or exited after 2026-10-16, so a late read cannot see the future — is
 * MARKED at the 2026-10-16 official close (SIP daily bar, raw) and the trade counts with markedAtEnd: true (R151's mark-at-read amendment,
 * carried over: RSI-2 exits only on a recovery, so dropping open lots would select on outcome).
 *
 * UNKNOWN IS NOT FAIL (review 2026-10-02; the house fail-open rule). The read seals PASS or DID NOT PASS only when the record could test
 * the proposition. It is UNKNOWN — nothing written to r311-read.json, nothing sealed, exit 3 (the close chain shows the step FAILED with
 * the reason, every night, until the operator decides) — when
 *   - the runner's send gate never cleared (docs/paper-auction-fix/2026-10-02/r151-reconcile-once.cjs --apply not run), so it refused
 *     every order of the window;
 *   - an in-window R311 order is still unreconciled (an entry still "pending", or an exit still "exiting"): its fill is unknown and the
 *     read would otherwise drop the trade or price it at the close instead of its fill;
 *   - arm A has entries on fewer than 3 sessions (or no spread across them): the session t does not exist.
 *
 * THE CLOCK (test-clock contract). Every run — before any refusal, registry or not — writes data/r311-clock.json: dailyClock.sessions =
 * in-window sessions with an R311 entry fill (any arm), plus arm A's entry sessions, the send gate, the in-window orders not yet
 * reconciled and the read state. No interim estimate: closed parts alone drop the open dips (the outcome selection the read avoids).
 * A starved R311 (gate never cleared, OFF switch, outage) shows 0 sessions in test-triage from the first evening, not on the read day.
 *
 *   node backend/r311-read.js            the read (refuses before its condition; reports sealed afterwards)
 *   node backend/r311-read.js --seal     the read, then seal it once (read-seals.json, the registry status, one GOVERNANCE row)
 *   node backend/r311-read.js --clock    write data/r311-clock.json only and exit 0 (the writer's first row, before registration)
 */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const ID = "R311", PREFIX = "r311-", EVIDENCE_START = "2026-10-05", READ_DATE = "2026-10-16", SEAL = process.argv.includes("--seal"), CLOCK_ONLY = process.argv.includes("--clock");
const D = (f) => path.join(__dirname, "data", f), OUT = D("r311-read.json"), CLOCK = D("r311-clock.json");
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const tOf = (a) => { const n = a.length; if (n < 3) return null; const m = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)); return sd > 0 ? m / (sd / Math.sqrt(n)) : null; };
const inWindow = (d) => !!d && d >= EVIDENCE_START && d <= READ_DATE;
const cidDay = (cid) => { const m = /-(\d{8})-[BS]\d*$/.exec(cid || ""); return m ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}` : null; };
const mine = (r) => r.test === ID && String(r.entryCid || r.cid || "").startsWith(PREFIX);
const isPart = (r) => r.kind === "trade" || (r.kind === "reconcile-correction" && r.action === "add-trade");

// the R311 record as it stands — shared by the clock and the read
function census(rows, st) {
  const parts = rows.filter((r) => isPart(r) && mine(r) && inWindow(r.entryDate));
  const lots = (st.lots || []).filter((l) => l.test === ID && String(l.entryCid || "").startsWith(PREFIX));
  const openFilled = lots.filter((l) => l.entryFill > 0 && ["open", "exiting"].includes(l.status) && inWindow((l.entryFilledAt || "").slice(0, 10)));
  const dayArm = [...parts.map((r) => [r.entryDate, r.arm]), ...openFilled.map((l) => [(l.entryFilledAt || "").slice(0, 10), l.arm])];
  const unresolved = lots.filter((l) => (l.status === "pending" && inWindow(cidDay(l.entryCid))) || (l.status === "exiting" && inWindow(cidDay(l.exitCid))))
    .map((l) => (l.status === "pending" ? l.entryCid : l.exitCid));
  return { parts, sessions: new Set(dayArm.map(([d]) => d)).size, aSessions: new Set(dayArm.filter(([, a]) => a === "A").map(([d]) => d)).size,
    unresolved, gateCleared: !!(st.auctionFix && st.auctionFix.reconciledAt) };
}

function seal(r) {                                                     // once: read-seals, registry status, governance row
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests || {})[ID]) { console.error(`${ID} already sealed`); process.exit(2); }
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === ID); if (!t) { console.error(`${ID} not in the registry`); process.exit(2); }
  const verdict = `${r.verdict} — arm A (day market in the close-arm window): ${r.A.meanRetPct}% per trade, session t ${r.A.tSessions} against ${r.bar}, ${r.A.trades} trades over ${r.A.sessions} sessions (${r.A.markedAtEnd} marked at the ${READ_DATE} close), win ${r.A.winPct}%. Arm B (day market at the open): ${r.B.meanRetPct}% (t ${r.B.tSessions}). Arm C (day limit at the signal close): ${r.C.meanRetPct}%, fill rate ${r.C.fillRatePct}%. A minus B on ${r.closeMinusOpen.pairs} shared signals: ${r.closeMinusOpen.meanDiffPct}% (t ${r.closeMinusOpen.t}). Partial entries ${r.partialEntries}; broker rejects ${r.rejects}. All from Alpaca paper fills.`;
  const day = new Date().toISOString().slice(0, 10);
  seals.tests = seals.tests || {}; seals.tests[ID] = { sealedOn: day, sessions: r.A.sessions, unit: "sessions", verdict, output: "data/r311-read.json" }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  t.status = `READ ${day} — ${verdict}`; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict: r.verdict, t: r.A.tSessions }) + "\n");
  console.log("sealed: " + verdict);
}

(async () => {
  const rows = (() => { try { return fs.readFileSync(D("r151-ledger.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
  const st = (() => { try { return JSON.parse(fs.readFileSync(D("r151-state.json"), "utf8")); } catch { return { lots: [] }; } })();
  const c = census(rows, st);
  const et = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value])), etDate = `${et.year}-${et.month}-${et.day}`;
  const readable = !(etDate < READ_DATE || (etDate === READ_DATE && +et.hour % 24 < 17));
  const sealedNow = () => { try { return !!(JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")).tests || {})[ID]; } catch { return false; } };
  const putClock = (readState, extra) => writeJsonAtomic(CLOCK, { id: ID, spec: "r311-clock-v1", asOf: new Date().toISOString(), window: [EVIDENCE_START, READ_DATE],
    dailyClock: { sessions: c.sessions, estimate: null, unit: `sessions with an R311 entry fill (any arm) since evidenceStart ${EVIDENCE_START}; the window ends ${READ_DATE}` },
    armASessions: c.aSessions, gateCleared: c.gateCleared, unresolvedInWindow: c.unresolved,
    estimateNote: "no interim estimate: closed parts alone drop the open dips (selects on outcome); the read marks them at the 2026-10-16 close",
    readState, ...(extra || {}) });
  putClock(sealedNow() ? "SEALED" : readable ? "READABLE" : "ACCRUING");
  if (CLOCK_ONLY) { console.log(`${ID} clock — ${c.sessions} entry session(s), arm A ${c.aSessions}; send gate ${c.gateCleared ? "cleared" : "NOT cleared"}; ${c.unresolved.length} in-window order(s) unreconciled`); return; }

  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests || {})[ID]) { console.log(`${ID} already sealed — the arms continue as a weightless record`); process.exit(SEAL ? 0 : 2); }
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === ID);
  if (!t) { console.error(`${ID} is not in the registry — refusing (register it first)`); process.exit(2); }
  if (/^FROZEN/.test(String(t.status || "")) || t.freeze) { console.log(`${ID} ${String(t.status || "FROZEN").slice(0, 120)} — never read, nothing sealed`); process.exit(0); }
  const bar = t.bar && Number(t.bar.tRequired); if (!(bar > 0)) { console.error(`${ID}: no bar.tRequired in the registry entry — refusing`); process.exit(2); }
  const parts = c.parts;
  if (!readable) { console.log(`${ID} not readable yet — reads after the close of ${READ_DATE} (${c.sessions} entry session(s) so far, arm A ${c.aSessions}, ${parts.filter((r) => r.arm === "A").length} closed arm-A part(s); send gate ${c.gateCleared ? "cleared" : "NOT cleared"})`); process.exit(0); }
  if (fs.existsSync(OUT)) { const prev = JSON.parse(fs.readFileSync(OUT, "utf8")); if (prev.read) { putClock(`READ ${prev.verdict}`); if (SEAL) return seal(prev); console.error(`${ID} already read (${prev.asOf}) — seal it with --seal; it is never recomputed`); process.exit(2); } }

  // UNKNOWN, not FAIL: a record that could not test the proposition is never read or sealed (exit 3; the operator decides)
  const unknown = (reason) => { putClock("UNKNOWN", { unknownReason: reason }); console.error(`${ID} UNKNOWN — not read, not sealed: ${reason}. Operator decides.`); process.exit(3); };
  if (!c.gateCleared) unknown("the runner's send gate never cleared (docs/paper-auction-fix/2026-10-02/r151-reconcile-once.cjs --apply not run), so it refused every order of the window");
  if (c.unresolved.length) unknown(`${c.unresolved.length} in-window R311 order(s) not reconciled with the broker: ${c.unresolved.join(", ")}`);
  if (c.aSessions < 3) unknown(`arm A has entries on ${c.aSessions} session(s); the session t needs at least 3`);

  // one trade per entry lot: closed parts up to READ_DATE + whatever is still open (state) or exited later, marked at the READ_DATE close
  const lots = new Map(), lotOf = (src) => { if (!lots.has(src.entryCid)) lots.set(src.entryCid, { arm: src.arm, sym: src.sym, signalDate: src.signalDate, entryDate: src.entryDate, entryFill: src.entryFill, entryCid: src.entryCid, closedQty: 0, closedValue: 0, markQty: 0, parts: 0, lastExit: null }); return lots.get(src.entryCid); };
  for (const p of parts) { const L = lotOf(p); L.parts++; if (p.exitDate && p.exitDate <= READ_DATE) { L.closedQty += p.qty; L.closedValue += p.qty * p.exitFill; L.lastExit = !L.lastExit || p.exitDate > L.lastExit ? p.exitDate : L.lastExit; } else L.markQty += p.qty; }
  for (const l of st.lots || []) {
    if (l.test !== ID || !String(l.entryCid || "").startsWith(PREFIX) || !(l.entryFill > 0) || !["open", "exiting"].includes(l.status)) continue;
    const entryDate = (l.entryFilledAt || "").slice(0, 10); if (!inWindow(entryDate)) continue;
    lotOf({ ...l, entryDate }).markQty += l.qty;
  }
  const toMark = [...lots.values()].filter((L) => L.markQty > 0);
  let closeOf = {};
  if (toMark.length) {
    const { bars } = await fetchBars([...new Set(toMark.map((L) => L.sym))], { start: READ_DATE, end: `${READ_DATE}T23:59:59Z`, feed: "sip", adjustment: "raw", quiet: true, requireAll: true });
    for (const L of toMark) { const b = (bars[L.sym] || []).find((x) => x.t.slice(0, 10) === READ_DATE); if (!b) throw new Error(`no ${READ_DATE} close for open lot ${L.sym} — refusing to read without it`); closeOf[L.sym] = b.c; }
  }
  const tr = [...lots.values()].map((L) => { const q = L.closedQty + L.markQty, exitPx = (L.closedValue + L.markQty * (closeOf[L.sym] || 0)) / q;
    return { kind: "trade", arm: L.arm, sym: L.sym, qty: q, signalDate: L.signalDate, entryDate: L.entryDate, exitDate: L.markQty > 0 ? READ_DATE : L.lastExit, entryFill: L.entryFill, exitFill: +exitPx.toFixed(6), ret: +(exitPx / L.entryFill - 1).toFixed(6), entryCid: L.entryCid, parts: L.parts, ...(L.markQty > 0 ? { markedAtEnd: true, markedQty: L.markQty, markClose: closeOf[L.sym] } : {}) }; });

  const bySession = (list) => { const m = new Map(); for (const r of list) { if (!m.has(r.entryDate)) m.set(r.entryDate, []); m.get(r.entryDate).push(r.ret); } return [...m.values()].map(mean); };
  const arm = (a) => { const l = tr.filter((r) => r.arm === a), s = bySession(l), tt = tOf(s); return { trades: l.length, markedAtEnd: l.filter((r) => r.markedAtEnd).length, sessions: s.length, meanRet: l.length ? mean(l.map((r) => r.ret)) : null, meanRetPct: l.length ? +(100 * mean(l.map((r) => r.ret))).toFixed(4) : null, tSessionsRaw: tt, tSessions: tt == null ? null : +tt.toFixed(3), winPct: l.length ? +(100 * l.filter((r) => r.ret > 0).length / l.length).toFixed(1) : null }; };
  const A = arm("A"), key = (r) => r.sym + "|" + r.signalDate, bIdx = new Map(tr.filter((r) => r.arm === "B").map((r) => [key(r), r]));
  if (A.tSessionsRaw == null) unknown(`arm A has ${A.trades} trade(s) over ${A.sessions} entry session(s) with no spread across sessions; the session t does not exist`);
  const pairs = tr.filter((r) => r.arm === "A" && bIdx.has(key(r))).map((r) => r.ret - bIdx.get(key(r)).ret), pt = tOf(pairs);
  const cUnfilled = rows.filter((r) => r.kind === "unfilled-entry" && r.arm === "C" && mine(r) && inWindow(cidDay(r.cid))).length, cFilled = tr.filter((r) => r.arm === "C").length, cTried = cFilled + cUnfilled;
  const winRows = rows.filter((r) => mine(r) && inWindow(cidDay(r.cid || r.entryCid)));
  const out = { spec: "r311-read-v1 (one trade per entry lot; open or post-read quantity marked at the read close)", id: ID, read: true, asOf: new Date().toISOString(), window: [EVIDENCE_START, READ_DATE], bar,
    A, B: arm("B"), C: { ...arm("C"), fillRatePct: cTried ? +(100 * cFilled / cTried).toFixed(1) : null, unfilled: cUnfilled },
    closeMinusOpen: { pairs: pairs.length, meanDiffPct: pairs.length ? +(100 * mean(pairs)).toFixed(4) : null, t: pt == null ? null : +pt.toFixed(3) },
    partialEntries: winRows.filter((r) => r.kind === "partial-entry").length, rejects: winRows.filter((r) => r.kind === "order-rejected").length, exitsNotFilled: winRows.filter((r) => r.kind === "exit-not-filled").length, oversold: winRows.filter((r) => r.kind === "oversold-exit").length,
    trades: tr };
  out.verdict = A.meanRet > 0 && A.tSessionsRaw >= bar ? "PASS" : "DID NOT PASS";   // unrounded comparison; tSessionsRaw is never null here (UNKNOWN above)
  writeJsonAtomic(OUT, out); putClock(`READ ${out.verdict}`); console.log(JSON.stringify({ ...out, trades: tr.length }, null, 1));
  if (SEAL) seal(out);
})().catch((e) => { console.error(`${ID} read FAILED:`, e.message); process.exit(1); });
